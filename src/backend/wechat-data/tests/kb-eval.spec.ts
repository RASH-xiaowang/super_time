// @vitest-environment node
/**
 * 知识库检索基线评估（G-08 · Phase B）。
 *
 * 这一层要钉住的**不是**「检索函数被调用了」，而是几件**错了也不报错**的事：
 *
 *   ① **夹具完整性**：用例里写的每个标记词，在整个夹具集里**只能出现在一个文件**里。
 *      否则块级 ground truth 就有歧义 —— 检索返回谁都算对，指标永远好看。
 *   ② **每个夹具真的进了索引**：`chunkCount > 0`。GB18030 那个文件尤其关键：
 *      解码失败时它只是「没内容」，不报错，指标静默变好（分母少了一个）。
 *   ③ **末块真的被索引**：末块独有短语的用例，命中块的 `ordinal` 必须 > 0。
 *      若分块器只索引了第一块，这一条立刻红。
 *   ④ **0 命中必须是「真缺口」**：缺口用例的 0 不许是「查询为空」「库打不开」这类
 *      harness 自己造成的原因 —— 查询有效（terms > 0）却搜不到，才叫缺口。
 *   ⑤ **query 构造复现流水线**：必须是 `plan.terms.slice(0,12).join(' ')`，不是原问题。
 *      传原问题会让 `ftsPhrase` 要求文件逐字出现整句 ⇒ 全库 0 命中，而**没有任何断言会红**
 *      （指标掉到 0 看起来只是「库里没内容」）。
 *   ⑥ **可重复**：同一份夹具跑两次，结果逐字节一致（能进 CI 才有意义）。
 *
 * 全部用例走真 sqlite + 真写入路径（`registerKbFile` 读字节 → 解析 → 分块 → FTS）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerKbFile } from '../src/query/kb-files.ts'
import { MAX_KB_TOP_K, searchKb } from '../src/query/kb-search.ts'
import {
  KB_EVAL_CASES, KB_EVAL_FIXTURES, formatKbEvalReport, kbEvalRetrieve, runKbEval, type KbEvalCase,
} from '../src/query/retrieval/kb-eval.ts'
import { buildQueryPlan } from '../src/query/retrieval/rewrite.ts'

/** 夹具目录（真文件，随仓库提交）。 */
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/kb-eval/', import.meta.url))

/**
 * 非 UTF-8 夹具的解码口径（与 kb-parse 的探测结果一致）。
 *
 * 类型写 `string` 而不是 `BufferEncoding`：这张表喂的是 `TextDecoder`（见下面的 decode夹具），
 * 而 `BufferEncoding` 是 Node **字符串编码**那一个小集合，`gb18030` 不在里头 ——
 * 用 `BufferEncoding` 标注等于一边说「走 TextDecoder」、一边用 TextDecoder 不接受的类型域，
 * 编译器会直接把 gb18030 判成类型错误（这正是 N32 接上类型检查以后报出来的）。
 */
const ENCODINGS: Record<string, string> = { '押金说明-棠樾.txt': 'gb18030' }

/** 另一个知识库（隔离断言的反向一半用）。 */
const KB_B = 2

/** 甲库夹具（乙库那个单独登记）。 */
const KB_A_FILES = KB_EVAL_FIXTURES.filter(n => n !== '玄武纪要.md')

let root = ''
let decrypted = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kb-eval-'))
  // 与线上同一布局：`<root>/data/decrypted` 是解密根，`wechat_kb_files.db` 在它的**父目录**。
  decrypted = join(root, 'data', 'decrypted')
  mkdirSync(decrypted, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 读一个夹具的文本（按该文件的实际编码）。 */
function fixtureText(name: string): string {
  const buf = readFileSync(join(FIXTURES_DIR, name))
  const enc = ENCODINGS[name]
  // ⚠ 不能用 `buf.toString('gb18030')`：`Buffer.toString` 只认 utf8/utf16le/latin1 这几个，
  // 传 gb18030 会抛 `ERR_UNKNOWN_ENCODING`；完整编码表在 `TextDecoder` 上（与 kb-parse 同源）。
  return enc ? new TextDecoder(enc).decode(buf) : buf.toString('utf8')
}

/** 登记一个夹具，返回 id 与分块数。 */
function registerFixture(name: string, kbId = 1): { id: number; chunkCount: number } {
  const r = registerKbFile(decrypted, { kbId, srcPath: join(FIXTURES_DIR, name) })
  if (!r.ok || r.file === undefined) throw new Error(`夹具登记失败：${name} → ${r.code}: ${r.error}`)
  return { id: r.file.id, chunkCount: r.file.chunkCount }
}

/** 把 7 个甲库夹具 + 1 个乙库夹具全部登记好。 */
function seedFixtures(): Map<string, number> {
  const chunkCounts = new Map<string, number>()
  for (const name of KB_A_FILES) chunkCounts.set(name, registerFixture(name, 1).chunkCount)
  registerFixture('玄武纪要.md', KB_B)
  return chunkCounts
}

/** 取一条用例（找不到就是夹具/用例定义漂了，直接抛出比 `undefined` 好定位）。 */
function caseOf(id: string): KbEvalCase {
  const c = KB_EVAL_CASES.find(x => x.id === id)
  if (!c) throw new Error(`用例不存在：${id}`)
  return c
}

// ─────────────────────────────────────────────────────────────────────────────
// A. 夹具完整性闸门（先于任何指标断言）
// ─────────────────────────────────────────────────────────────────────────────

describe('夹具完整性：标记词唯一、清单与实际一致', () => {
  it('磁盘上的夹具文件集合与 KB_EVAL_FIXTURES 完全一致', () => {
    expect(readdirSync(FIXTURES_DIR).sort()).toEqual([...KB_EVAL_FIXTURES].sort())
  })

  it('每个标记词只出现在一个夹具文件里（否则块级 ground truth 有歧义）', () => {
    const texts = new Map(KB_EVAL_FIXTURES.map(n => [n, fixtureText(n)]))
    for (const c of KB_EVAL_CASES) {
      expect(c.markers.length).toBeGreaterThan(0)
      for (const m of c.markers) {
        const owners = [...texts].filter(([, t]) => t.includes(m)).map(([n]) => n)
        expect(owners, `标记词「${m}」（用例 ${c.id}）应只出现在一个文件里`).toHaveLength(1)
        // 而且要出现在用例声明的那个文件里 —— 声明与实际不符同样是「测试在测别的东西」。
        expect(c.expectFiles).toContain(owners[0])
      }
    }
  })

  it('用例声明的每个文件都在夹具清单里，且用例 id 不重复', () => {
    for (const c of KB_EVAL_CASES) {
      for (const f of c.expectFiles) expect(KB_EVAL_FIXTURES).toContain(f)
    }
    // id 重复会让 memo 互相覆盖、指标少算一条。
    expect(new Set(KB_EVAL_CASES.map(c => c.id)).size).toBe(KB_EVAL_CASES.length)
  })

  it('每个夹具都真的解析出块（GB18030 那个也是）', () => {
    const counts = seedFixtures()
    for (const [name, n] of counts) {
      expect(n, `夹具 ${name} 没解析出任何块`).toBeGreaterThan(0)
    }
    // 「末块独有短语」的两条用例，夹具必须真的多块 —— 只有一块的话 ordinal>0 恒不成立，
    // 那两条用例就变成了「在测一个不存在的东西」。
    expect(counts.get('蓝鲸合同.md')).toBeGreaterThan(1)
    expect(counts.get('合作台账.csv')).toBeGreaterThan(1)
    expect(counts.get('会议纪要-九月.txt')).toBeGreaterThan(1)
    // 「答案横跨两块」那条用例的前提：押金与保证金必须真的分处两块。
    expect(counts.get('押金说明-棠樾.txt')).toBeGreaterThan(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B. 基线指标
// ─────────────────────────────────────────────────────────────────────────────

describe('基线：跑通全部用例并给出两层指标', () => {
  it('8 条用例找到文件、1 条（字面不通的缺口）为 0 —— 并打印完整报告', () => {
    seedFixtures()
    const r = runKbEval(decrypted, { kbId: 1 })
    // 基线报告要能被人看到：第一次跑出来的数字就是 docs/KB-EVAL-BASELINE.md 的内容。
    console.log('\n===KB-EVAL-START===\n' + formatKbEvalReport('KB 评估集', r) + '\n===KB-EVAL-END===')

    expect(r.chunk.cases).toBe(KB_EVAL_CASES.length)
    expect(r.file.cases).toBe(KB_EVAL_CASES.length)
    // 文件级：除缺口用例外的 9 条都必须找到文件。写成精确值而不是阈值 ——
    // 「10 分之 9」这个数字变化时，必须有人来看一眼是哪一条掉的。
    expect(r.file.hits).toBe(9)
    expect(r.chunk.hits).toBe(9)
    for (const d of r.details) {
      if (d.noHitExpected) continue
      expect(d.firstRelevantRank, `用例 ${d.id} 一块相关块都没召回`).not.toBeNull()
      expect(d.topFiles[0], `用例 ${d.id} 一条命中都没有`).toBeTruthy()
    }
  })

  it('末块真的进了索引：末块独有短语的用例，命中块 ordinal > 0', () => {
    seedFixtures()
    const byId = new Map(runKbEval(decrypted, { kbId: 1 }).details.map(d => [d.id, d]))
    // 这三条用例的标记词都**只**出现在各自夹具的最后一块里。
    for (const id of ['md-late-chunk', 'csv-late-group', 'txt-late-chunk']) {
      const d = byId.get(id)
      expect(d, id).toBeDefined()
      expect(d?.firstRelevantRank, id).not.toBeNull()
      expect(d?.firstRelevantOrdinal, `${id} 命中的是第 0 块（末块没进索引？）`).toBeGreaterThan(0)
    }
  })

  it('CSV 表头被重复写进每一块：列名查询能命中的块数 > 1', () => {
    seedFixtures()
    const d = runKbEval(decrypted, { kbId: 1 }).details.find(x => x.id === 'csv-header-only')
    expect(d).toBeDefined()
    const ordinals = new Set((d?.ordered ?? []).filter(o => o.file === '合作台账.csv').map(o => o.ordinal))
    expect(ordinals.size).toBeGreaterThan(1)
  })

  it('答案横跨两块时两块都要召回（缺一块 = 答案不完整）', () => {
    seedFixtures()
    const d = runKbEval(decrypted, { kbId: 1 }).details.find(x => x.id === 'multi-block-same-file')
    expect(d).toBeDefined()
    const mh = d?.markerHits ?? []
    expect(mh.map(m => m.marker).sort()).toEqual(['押金留存', '棠樾牌坊群'])
    // 两块**都要**进 top-k：`rank > 0` 而不是「至少一块」——
    // 押金在第一块、保证金在第二块，少一块答案就是残缺的。
    for (const m of mh) {
      expect(m.rank, `标记「${m.marker}」那一块没被召回`).toBeGreaterThan(0)
      expect(m.file).toBe('押金说明-棠樾.txt')
    }
    // 而且它们必须真的在**不同的块**里（同块的话这条用例就没在测跨块召回）。
    expect(new Set(mh.map(m => m.ordinal)).size).toBe(mh.length)
  })

  it('干扰项不许抢走首位：同库放着「旧版草稿」「行业规范」也压不掉真答案块', () => {
    seedFixtures()
    const d = runKbEval(decrypted, { kbId: 1 }).details.find(x => x.id === 'md-late-chunk')
    expect(d?.topFiles[0]).toBe('蓝鲸合同.md')
    // 干扰项**确实被召回了**（否则上面那条断言只是「库里没有干扰项」）。
    expect(d?.files).toContain('旧版合同草稿.md')
  })

  it('缺口用例的 0 命中是真缺口：查询有效、库能打开，只是词对不上', () => {
    seedFixtures()
    const d = runKbEval(decrypted, { kbId: 1 }).details.find(x => x.id === 'sparse-gap')
    expect(d?.noHitExpected).toBe(true)
    expect(d?.rawHits).toBe(0)
    expect(d?.firstRelevantRank).toBeNull()
    // ⛔ 上面两条在「查询为空」「库打不开」时同样成立 —— 必须排掉这两种假设造成的假绿。
    const gap = caseOf('sparse-gap')
    const q = buildQueryPlan({ question: gap.question, subQueries: gap.subQueries }).terms.slice(0, 12).join(' ')
    expect(q.trim()).not.toBe('')
    const raw = searchKb(decrypted, 1, { query: q, onlyRag: true })
    expect(raw.error).toBeUndefined()
    expect(raw.readError).toBeUndefined()
    expect(raw.stats.terms).toBeGreaterThan(0)
    // ground truth 那个文件**确实在库里**（换个词就搜得到）—— 排掉「文件压根没进去」。
    expect(searchKb(decrypted, 1, { query: '押金留存', onlyRag: true }).hits.length).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C. 可重复 + 参数可见
// ─────────────────────────────────────────────────────────────────────────────

describe('可回归：同输入同输出、配额真的生效', () => {
  it('跑两次逐字节一致（能进 CI 的前提）', () => {
    seedFixtures()
    const a = runKbEval(decrypted, { kbId: 1 })
    const b = runKbEval(decrypted, { kbId: 1 })
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
  })

  it('配额生效：topK 收小后召回数必然下降（否则这个旋钮是坏的）', () => {
    seedFixtures()
    const wide = runKbEval(decrypted, { kbId: 1 })
    const narrow = runKbEval(decrypted, { kbId: 1, topK: 2 })
    const sum = (r: ReturnType<typeof runKbEval>): number => r.details.reduce((a, d) => a + d.rawHits, 0)
    expect(sum(narrow)).toBeLessThan(sum(wide))
    // 默认配额取自意图策略（12~30），且不得超过 searchKb 的硬上限。
    for (const d of wide.details) {
      expect(d.topK).toBeGreaterThanOrEqual(12)
      expect(d.topK).toBeLessThanOrEqual(MAX_KB_TOP_K)
    }
  })

  it('query 构造 = plan.terms 前 12 个（不是原问题）', () => {
    seedFixtures()
    const c = caseOf('md-late-chunk')
    const r = kbEvalRetrieve(decrypted, 1, c)
    const plan = buildQueryPlan({ question: c.question, subQueries: c.subQueries })
    expect(r.query.split(' ')).toEqual(plan.terms.slice(0, 12))
    // 关键区别：整句问题当一个词传进去，`ftsPhrase` 会要求文件逐字出现这一整句 ⇒ 0 命中。
    expect(r.query).not.toBe(c.question)
    expect(r.query).not.toContain(c.question)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D. 作用域：评测器本身不许串库
// ─────────────────────────────────────────────────────────────────────────────

describe('作用域：同一问题换库必须换命中', () => {
  it('甲库的问题在乙库一块都搜不到，而乙库自己的问题搜得到', () => {
    seedFixtures()
    const c = caseOf('md-late-chunk')
    const inA = kbEvalRetrieve(decrypted, 1, c)
    expect(inA.hits.some(h => h.fileName === '蓝鲸合同.md')).toBe(true)
    const inB = kbEvalRetrieve(decrypted, KB_B, c)
    expect(inB.hits).toEqual([])
    // 反向一半：乙库**确实有可搜内容**（换它自己的词就搜得到），排掉「乙库是空的」这种假绿。
    const own = searchKb(decrypted, KB_B, { query: '玄铁令牌符', onlyRag: true })
    expect(own.hits.length).toBeGreaterThan(0)
    expect(own.hits.every(h => h.fileName === '玄武纪要.md')).toBe(true)
  })

  it('整库评估可以只评另一个库（kbId 是入口参数）', () => {
    seedFixtures()
    const one = [caseOf('gb18030-file')]
    expect(runKbEval(decrypted, { kbId: 1, cases: one }).file.hits).toBe(1)
    expect(runKbEval(decrypted, { kbId: KB_B, cases: one }).file.hits).toBe(0)
  })
})
