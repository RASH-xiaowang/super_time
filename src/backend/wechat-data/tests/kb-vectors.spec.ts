/**
 * 知识库 chunk 向量库（`query/kb-vectors.ts`）的回归用例。
 *
 * 真夹具、真 sqlite：每个用例在自己的临时数据根里 `registerKbFile` 登记真文件，
 * 走与线上**完全相同**的写入路径（读字节 → 解析 → 分块 → 落 chunk + FTS），
 * 所以这里断言的「某块进了向量库 / 没进」是真事实，不是 mock 的调用记录。
 *
 * ── 桩 embedding 为什么用「字符直方图」而不是随机哈希 ────────────────────
 *   随机哈希只能证明「同一条文本得到同一个向量」（余弦 1），证明不了**检索有用**：
 *   任何两条不同文本的余弦都是噪声。字符直方图（每维 = 某个码点的出现次数）
 *   让「字面有重叠」⟺「余弦更高」，于是「用改写过的短查询去命中长正文」这种
 *   **稠密通道唯一的价值**可以被断言 —— 而它在随机哈希下根本测不出来。
 *   代价是它一点也不「语义」（同义不同字不相似），所以 H5 的语义质量仍然待
 *   真端点就绪后验（见 docs/KB-EVAL-BASELINE.md），这里只钉管线正确性。
 *
 * ── 覆盖率口径 ─────────────────────────────────────────────────────────
 *   A 建库与检索闭环；B 计划点名的四项验收（`include_in_rag=0` 不进表 ·
 *   按 `kb_id` 不串库 · 维度不符拒答 · 指纹缓存命中不重算）；C 换模型重建。
 *   「跨库级联真删 / 关 RAG 清向量」在 C4 落地后补在本文件末尾；E 段是 C2 的
 *   「稀疏 + 稠密混合」——含**降级说明的如实性**（稠密跑过就不许再说「仅关键词」；
 *   稠密没跑时也不许照抄那句「未建向量索引」—— 索引建好了、只是没让它跑时那是假话）。
 *   C5 追加：开关与配置**真能关掉**（关掉 = 一次 embedding 都不发起）+ 断网仍可用（H7）。
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  KB_VECTORS_TABLE,
  KB_VECTOR_SCHEMA_VERSION,
  __internals,
  buildKbVectorIndex,
  kbVectorIndexStatus,
  kbVectorsDbPath,
  searchKbDense,
} from '../src/query/kb-vectors.ts'
import { deleteKbFile, kbFilesOnKbDelete, registerKbFile, setKbFileRagFlag } from '../src/query/kb-files.ts'
import { fuseKbHits, kbChannel } from '../src/query/retrieval/kb-channel.ts'
import { defaultRetrievalConfig } from '../src/query/retrieval/config.ts'
import { runRetrievalPipeline } from '../src/query/retrieval/pipeline.ts'
import { at } from '../../tests/helpers/strict-index.ts'
import type { KbHit } from '../src/types.ts'

/**
 * 只数「粗筛表加载」这一条 SQL 的执行次数。
 *
 * 说「缓存命中」有很多种测不准的写法：数连接数（`searchKbDense` 每次都要开连接读向量、
 * 读块正文，必然 > 0）、比耗时（机器负载一变就抖）。这里直接数那条**只属于冷路径**的
 * SQL —— 它每次执行都必然是「重新加载了一遍粗筛表」，语义上无歧义。
 */
const probe = vi.hoisted(() => ({
  hashLoads: 0,
}))

vi.mock('node:sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:sqlite')>()
  type RealDb = InstanceType<typeof actual.DatabaseSync>
  class CountingDatabaseSync extends actual.DatabaseSync {
    // `node:sqlite` 的 `prepare(sql)` 只有一个入参（绑定值发生在拿到的语句对象上）。
    // 原来这里签名写成 `(sql, ...rest: unknown[])` 再用 `as any` 转调 —— 那个 `rest` 从来不存在，
    // 而构造函数只是原样转发，所以一并删掉（少一处 `any`，也少一处「prepare 能带绑定值」的误解）。
    override prepare(sql: string): ReturnType<RealDb['prepare']> {
      if (/select\s+chunk_id,\s*hash_lo,\s*hash_hi/i.test(sql)) probe.hashLoads += 1
      return super.prepare(sql)
    }
  }
  return { ...actual, DatabaseSync: CountingDatabaseSync }
})

let root = ''
let decrypted = ''
let srcDir = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kb-vectors-'))
  decrypted = join(root, 'data', 'decrypted')
  srcDir = join(root, 'src')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(srcDir, { recursive: true })
  probe.hashLoads = 0
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 造一个真文件，返回路径。 */
function fixture(name: string, content: string): string {
  const p = join(srcDir, name)
  writeFileSync(p, content, 'utf8')
  return p
}

/** 登记并断言成功（失败就把原因抛出来，免得用例在「少了一个夹具」的状态下继续跑）。 */
function register(name: string, content: string, kbId = 1, includeInRag = true): number {
  const r = registerKbFile(decrypted, { kbId, srcPath: fixture(name, content), includeInRag })
  if (!r.ok || r.file === undefined) throw new Error(`夹具登记失败：${name} → ${r.code}: ${r.error}`)
  return r.file.id
}

/**
 * 桩 embedding：字符直方图（见文件头注）。
 * @param dim - 向量维度（用来构造「维度不符」的场面）。
 * @returns `{ fn, calls }`，`calls` 记录**所有**被送去出网的文本。
 */
function makeEmbed(dim = 32): { fn: (texts: string[]) => Promise<number[][]>; calls: string[] } {
  const calls: string[] = []
  const fn = async (texts: string[]): Promise<number[][]> => {
    calls.push(...texts)
    return texts.map((t) => {
      const v = new Array<number>(dim).fill(0)
      for (const ch of t) { const k = (ch.codePointAt(0) ?? 0) % dim; v[k] = (v[k] ?? 0) + 1 }
      return v
    })
  }
  return { fn, calls }
}

const BUILD = { model: 'stub', batchSize: 8, maxCharsPerDoc: 400, maxDocsPerBuild: 500 }

/** 建库用的模型名：状态查询要带上同一个名字，否则判出来的是「调用方没给模型名」。 */
const MODEL = 'stub'

/** 甲库/乙库各自的正文（互不相似，字符集也几乎不重叠）。 */
const WECHAT_DOC = '微信转账限额说明：单笔最高二十万元，单日累计最高二十万元，超过需短信验证。'
const XUANWU_DOC = '玄武纪要第九附录：本季度采购计划与预算调整，涉及三家供应商的比价结论。'

/** 直接读向量库（用来断言「某块到底进没进表」）。 */
function vectorRows(kbId?: number): Array<{ chunk_id: number; kb_id: number; file_id: number; dim: number; model: string }> {
  const db = new DatabaseSync(kbVectorsDbPath(decrypted), { readOnly: true })
  try {
    const sql = 'SELECT chunk_id, kb_id, file_id, dim, model FROM ' + KB_VECTORS_TABLE + (kbId === undefined ? '' : ' WHERE kb_id = ?')
    const stmt = db.prepare(sql)
    return (kbId === undefined ? stmt.all() : stmt.all(kbId)) as Array<{ chunk_id: number; kb_id: number; file_id: number; dim: number; model: string }>
  } finally {
    db.close()
  }
}

/** 读某个文件在 `kb_chunks` 里的 (id, 正文)，用来当「必然命中」的查询文本。 */
function chunksOf(fileId: number): Array<{ id: number; text: string }> {
  const p = join(root, 'data', 'wechat_kb_files.db')
  const db = new DatabaseSync(p, { readOnly: true })
  try {
    return db.prepare('SELECT id, text FROM kb_chunks WHERE file_id = ? ORDER BY ordinal').all(fileId) as Array<{ id: number; text: string }>
  } finally {
    db.close()
  }
}

describe('A 建库与检索闭环', () => {
  it('登记 → 建库 → 状态就绪 → 检索命中该文件', async () => {
    const fileA = register('微信说明.md', WECHAT_DOC)
    const fileB = register('玄武纪要.md', XUANWU_DOC)
    const { fn, calls } = makeEmbed()

    expect(kbVectorIndexStatus(decrypted, 1, MODEL).ready, '还没建库就不该是就绪').toBe(false)
    const built = await buildKbVectorIndex(decrypted, 1, fn, BUILD)
    expect(built.status).toBe('ok')
    expect(built.rows).toBe(2)
    expect(built.embed_calls).toBe(1)
    // 只有两个文件、各一块，且两块正文不同 ⇒ 两次 embedding 输入
    expect(calls.sort()).toEqual([WECHAT_DOC, XUANWU_DOC].sort())

    const st = kbVectorIndexStatus(decrypted, 1, MODEL)
    expect(st.ready).toBe(true)
    expect(st.rows).toBe(2)
    expect(st.dim).toBe(32)
    expect(st.model).toBe('stub')

    // 用「改写过的短查询」而不是整段正文：这正是稠密通道要解决的问题
    const r = await searchKbDense(decrypted, 1, '转账限额', fn, { topK: 5, minSimilarity: 0, candidatePool: 50, model: MODEL })
    expect(r.note).toBeUndefined()
    expect(r.hits.length).toBe(2)
    expect(r.hits[0]?.fileId, '短查询没命中字符重叠最高的那份文件').toBe(fileA)
    expect(r.hits[0]?.fileName).toBe('微信说明.md')
    expect(r.hits[0]?.ranks).toEqual({ dense: 1 })
    // 命中的块 id 必须真的属于那个文件（回读阶段是对着 kb_files.db 取的行）
    expect(chunksOf(fileA).some((c) => c.id === r.hits[0]?.chunkId)).toBe(true)
    expect(r.hits[0]?.fileId).not.toBe(fileB)
  })

  it('minSimilarity 能过滤掉「不相关但非零」的候选', async () => {
    register('微信说明.md', WECHAT_DOC)
    register('玄武纪要.md', XUANWU_DOC)
    const { fn } = makeEmbed()
    await buildKbVectorIndex(decrypted, 1, fn, BUILD)

    // 阈值取 0.9：只有字面高度重叠的才留下（字符直方图的余弦对无关文本远低于此）
    const r = await searchKbDense(decrypted, 1, WECHAT_DOC, fn, { topK: 5, minSimilarity: 0.9, candidatePool: 50, model: MODEL })
    expect(r.hits.length).toBe(1)
    expect(r.hits[0]?.fileName).toBe('微信说明.md')
  })

  it('空库/未建库：状态未就绪、检索给说明而不是抛错', async () => {
    register('微信说明.md', WECHAT_DOC)
    const { fn } = makeEmbed()
    const r = await searchKbDense(decrypted, 1, '转账', fn, { topK: 5, minSimilarity: 0, candidatePool: 50, model: MODEL })
    expect(r.hits).toEqual([])
    expect(r.note).toBe('向量索引不可用：本库还没有向量索引')
  })

  it('库标识非法：直接拒答，不碰库', async () => {
    const { fn } = makeEmbed()
    const r = await searchKbDense(decrypted, 0, '转账', fn, { topK: 5, minSimilarity: 0, candidatePool: 50, model: MODEL })
    expect(r.hits).toEqual([])
    expect(r.note).toBe('没有指定知识库')
  })
})

describe('B 验收四项', () => {
  it('① include_in_rag=0 的文件：正文**从未**被送去出网，也不进向量表', async () => {
    const forbidden = register('保密合同.md', WECHAT_DOC, 1, false)
    const ok = register('玄武纪要.md', XUANWU_DOC)
    const { fn, calls } = makeEmbed()

    const built = await buildKbVectorIndex(decrypted, 1, fn, BUILD)
    expect(built.status).toBe('ok')
    // 只有允许参与的那个文件被送去 embedding —— 这是用户「这份不许出网」的显式表态
    expect(calls).toEqual([XUANWU_DOC])
    expect(calls.some((t) => t.includes('转账限额'))).toBe(false)

    const rows = vectorRows(1)
    expect(rows.length).toBe(1)
    const forbiddenChunks = chunksOf(forbidden).map((c) => c.id)
    expect(forbiddenChunks.length, '夹具本身该有块，否则这条断言是空集').toBeGreaterThan(0)
    expect(rows.some((r) => forbiddenChunks.includes(r.chunk_id))).toBe(false)
    expect(rows[0]?.file_id).toBe(ok)

    // 就算**派生数据被写脏**（例如开关是后来才关的、清向量那一步失败），
    // 读路径也必须挡住它：回读时又判了一遍 include_in_rag。
    const db = new DatabaseSync(kbVectorsDbPath(decrypted))
    try {
      db.prepare('INSERT OR REPLACE INTO ' + KB_VECTORS_TABLE + '(chunk_id, kb_id, file_id, dim, vec, hash_lo, hash_hi) VALUES(?,?,?,?,?,?,?)')
        .run(forbiddenChunks[0]!, 1, forbidden, 32, new Uint8Array(32 * 4), 0, 0)
    } finally {
      db.close()
    }
    __internals.hashCache.clear()
    const r = await searchKbDense(decrypted, 1, '转账限额验证码', fn, { topK: 5, minSimilarity: -1, candidatePool: 50, model: MODEL })
    expect(r.hits.some((h) => h.fileId === forbidden), '读路径信任了脏向量行，把不许出网的块返回了').toBe(false)
  })

  it('② 关掉 RAG 开关之后，该文件的向量被清掉（否则开关只挡得住建库、挡不住存量）', async () => {
    const id = register('微信说明.md', WECHAT_DOC)
    const { fn } = makeEmbed()
    await buildKbVectorIndex(decrypted, 1, fn, BUILD)
    expect(vectorRows(1).length).toBe(1)

    const r = setKbFileRagFlag(decrypted, 1, id, false)
    expect(r.ok).toBe(true)
    expect(vectorRows(1).length, '关掉开关后向量还在 ⇒ 它仍会被粗筛选中').toBe(0)
  })

  it('③ 按 kb_id 不串库：两个库都建，甲库检索看不到乙库的块', async () => {
    const a = register('微信说明.md', WECHAT_DOC, 1)
    const b = register('玄武纪要.md', XUANWU_DOC, 2)
    const { fn } = makeEmbed()
    await buildKbVectorIndex(decrypted, 1, fn, BUILD)
    await buildKbVectorIndex(decrypted, 2, fn, BUILD)

    const query = '采购预算比价'
    // 先证明这句查询在**乙库**里确实搜得到 —— 否则「甲库搜不到」只是空集，测不出隔离
    const inB = await searchKbDense(decrypted, 2, query, fn, { topK: 5, minSimilarity: -1, candidatePool: 50, model: MODEL })
    expect(inB.hits.map((h) => h.fileId)).toEqual([b])
    const inA = await searchKbDense(decrypted, 1, query, fn, { topK: 5, minSimilarity: -1, candidatePool: 50, model: MODEL })
    expect(inA.hits.some((h) => h.fileId === b), '甲库检索拿到了乙库的块').toBe(false)
    expect(inA.hits.map((h) => h.fileId)).toEqual([a])

    // 状态也是按库的：两个库各自 rows=1（拿全局 rows 判就绪会让没建过的库显示成就绪）
    expect(kbVectorIndexStatus(decrypted, 1, MODEL).rows).toBe(1)
    expect(kbVectorIndexStatus(decrypted, 2, MODEL).rows).toBe(1)
    expect(kbVectorIndexStatus(decrypted, 3, MODEL).rows).toBe(0)
    expect(kbVectorIndexStatus(decrypted, 3, MODEL).ready).toBe(false)
  })

  it('④ 维度不符：元数据缺维度 ⇒ 未就绪；查询维度不同 ⇒ 空结果 + 说明（不算出无意义的余弦）', async () => {
    register('微信说明.md', WECHAT_DOC)
    const { fn } = makeEmbed(32)
    await buildKbVectorIndex(decrypted, 1, fn, BUILD)

    // (a) 查询向量维度与库不一致（换过模型但没重建）
    const wrong = makeEmbed(8)
    const r = await searchKbDense(decrypted, 1, '转账限额', wrong.fn, { topK: 5, minSimilarity: 0, candidatePool: 50, model: MODEL })
    expect(r.hits).toEqual([])
    expect(r.note).toContain('维度不符')
    expect(r.note).toContain('32')
    expect(r.note).toContain('8')

    // (b) meta 里的 dim 被抹掉（手改/半个事务）⇒ 未就绪，而不是「按 0 维硬算」
    const db = new DatabaseSync(kbVectorsDbPath(decrypted))
    try {
      db.prepare("DELETE FROM meta WHERE key = 'dim'").run()
    } finally {
      db.close()
    }
    __internals.statusCache.clear()
    expect(kbVectorIndexStatus(decrypted, 1, MODEL).ready).toBe(false)
  })

  it('⑤ schema_version 不符 ⇒ 未就绪（结构变更后必须重建，不能拿旧表硬用）', async () => {
    register('微信说明.md', WECHAT_DOC)
    const { fn } = makeEmbed()
    await buildKbVectorIndex(decrypted, 1, fn, BUILD)
    const db = new DatabaseSync(kbVectorsDbPath(decrypted))
    try {
      db.prepare("UPDATE meta SET value = '0' WHERE key = 'schema_version'").run()
    } finally {
      db.close()
    }
    __internals.statusCache.clear()
    expect(kbVectorIndexStatus(decrypted, 1, MODEL).ready).toBe(false)
  })

  it('⑥ 指纹缓存命中不重算：第二次检索不再加载粗筛表；重建之后缓存必须失效', async () => {
    register('微信说明.md', WECHAT_DOC)
    const { fn } = makeEmbed()
    await buildKbVectorIndex(decrypted, 1, fn, BUILD)
    __internals.hashCache.clear()

    const first = __internals.loadKbHashRows(decrypted, 1)
    expect(first.length).toBe(1)
    expect(probe.hashLoads, '第一次必须真的查一次库').toBe(1)

    const second = __internals.loadKbHashRows(decrypted, 1)
    expect(second, '第二次返回的不是同一份数组 ⇒ 又被重新加载了').toBe(first)
    expect(probe.hashLoads, '缓存命中却又查了一次库').toBe(1)
    // 检索路径同样走缓存
    await searchKbDense(decrypted, 1, '转账', fn, { topK: 5, minSimilarity: -1, candidatePool: 50, model: MODEL })
    expect(probe.hashLoads).toBe(1)

    // 重建之后：文件指纹变了 ⇒ 必须重新加载（否则永远拿旧粗筛表的行号去取新向量）
    await buildKbVectorIndex(decrypted, 1, fn, { ...BUILD, force: true })
    const third = __internals.loadKbHashRows(decrypted, 1)
    expect(third, '重建后仍在用旧粗筛表').not.toBe(first)
    expect(probe.hashLoads).toBe(2)
  })
})

describe('C 换 embedding 模型 ⇒ 必须能重建（WeKnora 06-models 的硬要求）', () => {
  it('换模型：只作废**本库**由别的模型算出的行，别的库一行不动', async () => {
    // 两个库都用 stub（32 维）建过
    register('微信说明.md', WECHAT_DOC, 1)
    register('玄武纪要.md', XUANWU_DOC, 2)
    const first = makeEmbed(32)
    await buildKbVectorIndex(decrypted, 1, first.fn, BUILD)
    await buildKbVectorIndex(decrypted, 2, first.fn, BUILD)
    expect(kbVectorIndexStatus(decrypted, 1, MODEL).dim).toBe(32)
    expect(kbVectorIndexStatus(decrypted, 1, MODEL).models).toEqual(['stub'])
    const kb2Before = vectorRows(2)

    // 甲库换模型（维度也变了）：增量游标不能兜住这种情况 —— 旧向量的语义与维度都不兼容
    const second = makeEmbed(16)
    const rebuilt = await buildKbVectorIndex(decrypted, 1, second.fn, { ...BUILD, model: 'stub-v2' })
    expect(rebuilt.status).toBe('ok')
    // 旧行被清掉、新行重新算过（不是「增量跳过」）
    expect(rebuilt.embedded).toBe(1)
    const st = kbVectorIndexStatus(decrypted, 1, 'stub-v2')
    expect(st.rows).toBe(1)
    expect(st.dim).toBe(16)
    expect(st.model).toBe('stub-v2')
    expect(st.models).toEqual(['stub-v2'])
    expect(st.ready).toBe(true)
    expect(vectorRows(1).every((r) => r.dim === 16 && r.model === 'stub-v2')).toBe(true)

    // **乙库一行都不该动**：它绑的还是 stub，甲库换模型与它无关。
    // （旧实现是 `DELETE FROM kb_vectors` 清全表，理由是「全库共用一个模型」；
    //  按库绑定之后那个前提没了 —— 见 docs/KB-MODEL-CONFIG.md C5。）
    expect(vectorRows(2)).toEqual(kb2Before)
    expect(kbVectorIndexStatus(decrypted, 2, MODEL).ready).toBe(true)
    // 拿旧模型名去问甲库 ⇒ 判的是「模型不符」，而不是「就绪」（F1 的复发判据）
    expect(kbVectorIndexStatus(decrypted, 1, MODEL).staleReason).toBe('model-mismatch')
    expect(kbVectorIndexStatus(decrypted, 1, MODEL).ready).toBe(false)
  })

  it('老库（没有 model 列）：判「模型不符」而不是崩或谎报就绪，建一次后列补上', async () => {
    // 已发出去的版本里没有 `model` 这一列。手工造出那份**旧形状**，连同一行带着
    // 旧记账口径的 meta（`model = 'default'` —— 那正是 F1 里恒不变的假值）。
    const fileId = register('微信说明.md', WECHAT_DOC)
    const chunkId = chunksOf(fileId)[0]!.id
    const file = kbVectorsDbPath(decrypted)
    const legacy = new DatabaseSync(file)
    legacy.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    legacy.exec('CREATE TABLE ' + KB_VECTORS_TABLE + ' ('
      + 'chunk_id INTEGER PRIMARY KEY, kb_id INTEGER NOT NULL, file_id INTEGER NOT NULL, '
      + 'dim INTEGER NOT NULL, vec BLOB NOT NULL, hash_lo INTEGER NOT NULL, hash_hi INTEGER NOT NULL)')
    legacy.prepare('INSERT INTO ' + KB_VECTORS_TABLE + '(chunk_id, kb_id, file_id, dim, vec, hash_lo, hash_hi) VALUES(?,?,?,?,?,?,?)')
      .run(chunkId, 1, fileId, 32, new Uint8Array(128), 0, 0)
    // 元组标注：不加的话 `k`/`v` 在 noUncheckedIndexedAccess 下是 string|undefined，
    // 而 `.run(k, v)` 会挑不到重载 —— 这里要的就是「四对键值，逐对写进去」。
    const metaPairs: Array<[string, string]> = [['dim', '32'], ['model', 'default'], ['rows', '1'], ['schema_version', KB_VECTOR_SCHEMA_VERSION]]
    for (const [k, v] of metaPairs) {
      legacy.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run(k, v)
    }
    legacy.close()

    // 判据：列不存在 ⇒ 拿不到行级溯源 ⇒ **不可用**。既不崩，也不因为
    // meta 里那句 `model='default'` 与 dim 都对就谎报就绪（谎报就是 F1 的现场）。
    const st = kbVectorIndexStatus(decrypted, 1, MODEL)
    expect(st.rows).toBe(1)
    expect(st.models).toEqual([])
    expect(st.ready).toBe(false)
    expect(st.staleReason).toBe('model-mismatch')

    // 建一次：迁移补列 + 那行无溯源的旧行被清掉、按当前模型重算
    const first = makeEmbed(32)
    const built = await buildKbVectorIndex(decrypted, 1, first.fn, BUILD)
    expect(built.status).toBe('ok')
    const after = kbVectorIndexStatus(decrypted, 1, MODEL)
    expect(after.ready).toBe(true)
    expect(after.models).toEqual(['stub'])
    expect(vectorRows(1).map(r => r.model)).toEqual(['stub'])
  })

  it('调用方漏传模型名 ⇒ 判不可用（不背书），而不是看 rows>0 就说就绪', async () => {
    // 这条守的是**接线**：模型名一旦在某个调用点漏掉，稠密召回就会拿一批无法溯源的向量算余弦，
    // 而界面上看不出任何异常。让它显式不可用，比让它静默错要便宜得多。
    register('微信说明.md', WECHAT_DOC)
    const first = makeEmbed(32)
    await buildKbVectorIndex(decrypted, 1, first.fn, BUILD)
    expect(kbVectorIndexStatus(decrypted, 1, MODEL).ready).toBe(true)

    const blind = kbVectorIndexStatus(decrypted, 1)
    expect(blind.ready).toBe(false)
    expect(blind.staleReason).toBe('no-model')
    // 稠密召回同样不吃这条：拿不到模型名就不查
    const r = await searchKbDense(decrypted, 1, '转账限额', first.fn, { topK: 5, minSimilarity: 0, candidatePool: 50, model: '' })
    expect(r.hits).toEqual([])
    expect(r.note ?? '').toContain('未提供当前向量模型名')
  })

  it('同模型二次建库走增量：up-to-date，不重复出网', async () => {    register('微信说明.md', WECHAT_DOC)
    const first = makeEmbed()
    await buildKbVectorIndex(decrypted, 1, first.fn, BUILD)
    const second = makeEmbed()
    const again = await buildKbVectorIndex(decrypted, 1, second.fn, BUILD)
    expect(again.status).toBe('up-to-date')
    expect(again.embedded).toBe(0)
    expect(second.calls, '增量构建不该再出网').toEqual([])
  })
})

describe('D 跨库级联：向量在另一个文件里，删/迁都必须跟到位', () => {
  it('删文件：向量行真被删掉（不是「表不存在所以跳过」的空步骤）', async () => {
    const id = register('微信说明.md', WECHAT_DOC)
    const { fn } = makeEmbed()
    await buildKbVectorIndex(decrypted, 1, fn, BUILD)
    expect(vectorRows(1).length).toBe(1)

    const r = deleteKbFile(decrypted, 1, id)
    expect(r.ok).toBe(true)
    expect(r.removedChunks).toBeGreaterThan(0)
    expect(vectorRows(1).length, '级联漏掉了向量库 —— 残留行仍会被粗筛选中').toBe(0)
  })

  it('删库（purge）：该库的向量一并清掉', async () => {
    register('微信说明.md', WECHAT_DOC, 1)
    register('玄武纪要.md', XUANWU_DOC, 2)
    const { fn } = makeEmbed()
    await buildKbVectorIndex(decrypted, 1, fn, BUILD)
    await buildKbVectorIndex(decrypted, 2, fn, BUILD)
    expect(vectorRows().length).toBe(2)

    const rep = kbFilesOnKbDelete(decrypted, 1)
    expect(rep.ok).toBe(true)
    expect(rep.removedFiles).toBe(1)
    expect(vectorRows(1), '甲库的向量行还在').toEqual([])
    expect(vectorRows(2).length, '乙库被误伤').toBe(1)
  })

  it('删库（reassign）：向量归属跟着改 —— 否则「关键词搜得到、换个说法就搜不到」', async () => {
    register('微信说明.md', WECHAT_DOC, 1)
    const { fn } = makeEmbed()
    await buildKbVectorIndex(decrypted, 1, fn, BUILD)

    const rep = kbFilesOnKbDelete(decrypted, 1, 2)
    expect(rep.ok).toBe(true)
    expect(rep.movedFiles).toBe(1)

    const rows = vectorRows()
    expect(rows.length).toBe(1)
    expect(rows[0]?.kb_id, '向量行的 kb_id 没跟着改 —— 目标库检索不到它').toBe(2)
    // 真后果而不只是列值：迁过去之后，乙库的**稠密**检索确实能搜到它
    const inB = await searchKbDense(decrypted, 2, '转账限额', fn, { topK: 5, minSimilarity: 0, candidatePool: 50, model: MODEL })
    expect(inB.hits.length).toBe(1)
    expect(inB.hits[0]?.fileName).toBe('微信说明.md')
  })

  it('向量库不存在时：删文件照常成功，且不会**凭空建出**一个空向量库', async () => {
    const id = register('微信说明.md', WECHAT_DOC)
    expect(existsSync(kbVectorsDbPath(decrypted))).toBe(false)
    const r = deleteKbFile(decrypted, 1, id)
    expect(r.ok).toBe(true)
    expect(existsSync(kbVectorsDbPath(decrypted)), '删文件把向量库建出来了').toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// E. kb 通道：稀疏 + 稠密混合（C2），以及降级说明的如实性
// ─────────────────────────────────────────────────────────────────────────────

/** 手搓一条 KbHit：纯融合用例里只有 `chunkId` / `ranks` / `marks` 是有效字段。 */
function kbHitStub(chunkId: number, over: Partial<KbHit> = {}): KbHit {
  return {
    fileId: 1, fileName: 'f.md', fileExt: 'md', chunkId, ordinal: 0, page: 0,
    heading: '', snippet: '片段' + chunkId, text: '正文' + chunkId, marks: [], score: 0, ranks: {},
    ...over,
  }
}

describe('E kb 通道：稀疏 + 稠密混合', () => {
  it('纯融合：同一块两路都命中 ⇒ 分数累加、ranks 两条都记、排到最前', () => {
    const fused = fuseKbHits(
      [kbHitStub(11), kbHitStub(12)],           // 稀疏：11 第 1 名、12 第 2 名
      [kbHitStub(12, { ranks: { dense: 1 } })], // 稠密：12 第 1 名
      { k: 60 },
    )
    // 「两路都命中」是一致性信号，必须把 12 顶到 11 前面
    expect(fused.map((f) => f.hit.chunkId), '两路命中的一致性信号没起作用').toEqual([12, 11])
    expect(fused[0]!.hit.ranks).toEqual({ sparse: 2, dense: 1 })
    expect(fused[1]!.hit.ranks).toEqual({ sparse: 1 })
    // 分数就是 RRF 累加值（不是 bm25、也不是余弦）
    expect(fused[0]!.score).toBeCloseTo(1 / 62 + 1 / 61, 12)
    expect(fused[1]!.score).toBeCloseTo(1 / 61, 12)
  })

  it('纯融合：两路都命中时保留**稀疏**那一份（稠密的 marks 恒为空 ⇒ 会「搜到了没高亮」）', () => {
    const fused = fuseKbHits(
      [kbHitStub(7, { marks: [{ start: 0, end: 2 }], snippet: '命中词在开头…' })],
      [kbHitStub(7, { ranks: { dense: 1 }, marks: [], snippet: '块首一段…' })],
      { k: 60 },
    )
    expect(fused[0]!.hit.marks).toEqual([{ start: 0, end: 2 }])
    expect(fused[0]!.hit.snippet).toBe('命中词在开头…')
  })

  it('混合检索：关键词逐字搜不到、换个说法能搜到 —— 这正是稠密通道的价值', async () => {
    register('微信说明.md', WECHAT_DOC)
    const { fn, calls } = makeEmbed()
    await buildKbVectorIndex(decrypted, 1, fn, BUILD)

    // 「限额多少」不是正文的子串：FTS5 侧被编成 "限额 额多 多少" 连续短语 ⇒ 必然 0 命中。
    // 先钉住这一步，稠密那条路才是**唯一**的召回来源（而不是「稀疏也中了，看不出稠密有用」）。
    const rewrite = '限额多少'
    const denseOff = await kbChannel(decrypted, 1, rewrite, 10, { denseEnabled: false })
    expect(denseOff.hits, '夹具设计失败：这句本该关键词搜不到').toEqual([])

    const r = await kbChannel(decrypted, 1, rewrite, 10, {
      embedFn: fn, denseEnabled: true, embedModel: MODEL, minSimilarity: 0, candidatePool: 50,
    })
    expect(r.active).toBe(true)
    expect(r.hits[0]!.doc.kb?.fileName).toBe('微信说明.md')
    expect(r.hits[0]!.doc.source).toBe('kb')
    // 查询文本确实被送出去算了一次向量（建库那次之外）
    expect(calls).toContain(rewrite)
    // 稠密跑过 ⇒ **不许**再说「仅关键词（未建向量索引）」
    expect(r.note ?? '').not.toContain('仅关键词')
  })

  it('稠密配了但没建库 ⇒ 如实说「向量索引未就绪」，不假装走了稠密', async () => {
    register('微信说明.md', WECHAT_DOC)
    const { fn } = makeEmbed()
    const r = await kbChannel(decrypted, 1, '转账', 10, {
      embedFn: fn, denseEnabled: true, embedModel: MODEL, minSimilarity: 0, candidatePool: 50,
    })
    // 关键词一路照常命中（'转账' 是正文子串），但降级说明不该被「有命中」吃掉
    expect(r.active).toBe(true)
    expect(r.note).toBe('向量索引不可用：本库还没有向量索引')
  })

  it('denseEnabled 但没注入 embedding ⇒ 稠密一次不出网，降级说明如实透传', async () => {
    register('微信说明.md', WECHAT_DOC)
    const r = await kbChannel(decrypted, 1, '转账限额', 10, { denseEnabled: true })
    expect(r.active).toBe(true)
    expect(r.note).toContain('仅关键词')
  })

  it('库标识非法 / 无检索词 / 配额 0 ⇒ 通道不参与（与纯关键词路径同一套闸）', async () => {
    expect((await kbChannel(decrypted, 0, '转账', 10, { denseEnabled: true })).active).toBe(false)
    expect((await kbChannel(decrypted, 1, '  ', 10)).active).toBe(false)
    expect((await kbChannel(decrypted, 1, '转账', 0)).active).toBe(false)
  })

  // ── C5：开关与配置**真能关掉**（「关掉」的全部意义就是不出网），以及断网仍可用 ──
  it('关掉稠密开关：一次 embedding 都不发起，且说明不谎报「未建向量索引」', async () => {
    register('微信说明.md', WECHAT_DOC)
    const { fn, calls } = makeEmbed()
    await buildKbVectorIndex(decrypted, 1, fn, BUILD)
    const afterBuild = calls.length

    const r = await kbChannel(decrypted, 1, '转账限额', 10, {
      embedFn: fn, denseEnabled: false, minSimilarity: 0, candidatePool: 50,
    })
    // 关键词那一路照常命中（'转账' 是正文子串）—— 关掉稠密 ≠ 关掉通道
    expect(r.active, '夹具设计失败：关键词本该命中').toBe(true)
    // ① 关掉 = **真关掉**：embedFn 就在手边也不许发（这是这个开关存在的唯一意义）
    expect(calls.length, 'denseEnabled=false 时仍然发起了 embedding').toBe(afterBuild)
    // ② 索引是**建好的** ⇒ 说明不许再说「未建向量索引」（那是一句与事实相反的话）
    expect(r.note ?? '').toContain('仅关键词')
    expect(r.note ?? '').toContain('本次未启用向量通道')
    expect(r.note ?? '', '索引其实已建好，说明却在说「未建向量索引」').not.toContain('未建向量索引')
  })

  it('稠密没跑（没注入向量模型）：说「未配置向量模型」，而不是照抄「未建向量索引」', async () => {
    register('微信说明.md', WECHAT_DOC)
    const r = await kbChannel(decrypted, 1, '转账限额', 10, { denseEnabled: true })
    expect(r.active, '夹具设计失败：关键词本该命中').toBe(true)
    expect(r.note).toBe('仅关键词（未配置向量模型）')
  })

  it('配置层关掉稠密：kb 通道退回纯关键词，一次 embedding 都不发起', async () => {
    register('微信说明.md', WECHAT_DOC)
    const { fn, calls } = makeEmbed()
    await buildKbVectorIndex(decrypted, 1, fn, BUILD)
    const afterBuild = calls.length

    // 走**真的流水线**（而不是直接调 kbChannel）：这条钉的是 pipeline 那道**配置闸**
    // （`kbDenseEnabled` 里的 `config.channels.dense.enabled`）—— 变异实测：把它漏掉时
    // **只有这一条**红；反过来「通道层那道开关失效」会同时让这条和上一条红
    // （两道闸的覆盖面有重叠，但**配置闸只有这里测得着**，通道级用例测不到它）。
    const cfg = defaultRetrievalConfig()
    cfg.channels.dense.enabled = false
    const out = await runRetrievalPipeline({
      decryptedDir: decrypted,
      question: '微信转账的限额是多少',
      subQueries: ['转账限额'],
      limit: 10,
      config: cfg,
      embedFn: fn,
      kbId: 1,
    })
    const kb = out.stats.channels.find((c) => c.channel === 'kb')
    expect(kb, 'kb 通道整个没参与 ⇒ 这条断言没在测「降级」').toBeDefined()
    expect(kb?.note ?? '').toContain('仅关键词')
    expect(kb?.note ?? '', '配置关的是通道，不是索引').not.toContain('未建向量索引')
    // 关掉 = 一次都不出网（否则这个配置项就是个装饰）
    expect(calls.length, '配置已关掉稠密，却仍发起了 embedding').toBe(afterBuild)
  })

  it('断网 / 无 Key：embedding 抛错时关键词那一路照常可用，说明如实（H7）', async () => {
    register('微信说明.md', WECHAT_DOC)
    const { fn } = makeEmbed()
    await buildKbVectorIndex(decrypted, 1, fn, BUILD)

    // 断网的真实样子：DNS 挂掉 / 出站被拦 / 没配 Key 时**调用本身**抛错。
    const offline = async (): Promise<number[][]> => {
      throw new Error('getaddrinfo ENOTFOUND api.example.com')
    }
    const r = await kbChannel(decrypted, 1, '转账限额', 10, {
      embedFn: offline, denseEnabled: true, embedModel: MODEL, minSimilarity: 0, candidatePool: 50,
    })
    // 硬约束：降级而不是失败 —— 稠密全挂，知识库问答也必须照常给出关键词结果
    expect(r.active, '断网时关键词那一路也拿不到 ⇒ 知识库问答整体不可用').toBe(true)
    // 说明必须是**这次真发生的事**，而不是索引状态
    expect(r.note ?? '').toContain('embedding 失败')
    expect(r.note ?? '', '断网场景下说「未建向量索引」是答非所问').not.toContain('未建向量索引')
  })
})

/**
 * 模型精排（`pipeline.ts` 的「3.5」段）。
 *
 * 为什么值得测到管道这一层：这一段最容易写成「调了、记了，但顺序没变」——
 * 界面照样显示「精排：r-test（候选 8 → 取 8）」，而用户拿到的顺序和没精排时一模一样。
 */
describe('F 模型精排（pipeline 的 3.5 段）', () => {
  /** rerank 桩：记录每次收到的查询与候选，分数由用例给。 */
  function stubRerank(scores: number[] | ((q: string, docs: string[]) => number[])) {
    const calls: Array<{ q: string; docs: string[] }> = []
    const fn = async (q: string, docs: string[]): Promise<number[]> => {
      calls.push({ q, docs })
      return typeof scores === 'function' ? scores(q, docs) : scores
    }
    return { fn, calls }
  }

  /** 走一次真管道（只关心 rerankInfo / citations）。 */
  async function run(extra: Record<string, unknown> = {}) {
    return runRetrievalPipeline({
      decryptedDir: decrypted,
      question: '微信转账的限额是多少',
      subQueries: ['转账限额'],
      limit: 10,
      config: defaultRetrievalConfig(),
      kbId: 1,
      ...extra,
    })
  }

  it('没注入 rerank ⇒ used:false 且写明用的是本地加权（这是默认路径，不是降级）', async () => {
    register('微信说明.md', WECHAT_DOC)
    const out = await run()
    expect(out.rerankInfo.used).toBe(false)
    if (!out.rerankInfo.used) expect(out.rerankInfo.note).toContain('本地线性加权')
  })

  /**
   * 造两条**都会被同一个词命中**的候选。
   *
   * 为什么不用夹具里那两篇：精排这一段的前提是「融合后候选多于一条」，
   * 而 `WECHAT_DOC` / `XUANWU_DOC` 是刻意做成字符集几乎不重叠的（为了测跨库不串味）。
   * 拿它们问「转账」只会召回一条，`fused.length > 1` 那道闸直接不放行 ——
   * 于是这三条用例全在测「没精排」那一支，看着绿其实什么都没测。
   */
  function twoCandidates(): void {
    register('转账甲.md', '微信转账限额说明：单笔最高二十万元，超过需要短信验证码。')
    register('转账乙.md', '转账限额补充口径：单日累计最高二十万元，超限走人工审核。')
  }

  it('注入后：查询词与全部候选都送出去，分数条数与候选数一致', async () => {
    twoCandidates()
    const stub = stubRerank([])
    const out = await run({ rerank: stub.fn, rerankModel: 'r-test' })
    expect(out.rerankInfo.used, `候选只有 ${(out.rerankInfo.used ? out.rerankInfo.candidates : 0)} 条，这段根本没跑`).toBe(true)
    if (out.rerankInfo.used) {
      expect(out.rerankInfo.model).toBe('r-test')
      expect(out.rerankInfo.candidates).toBeGreaterThan(1)
    }
    expect(stub.calls).toHaveLength(1)
    expect(at(stub.calls, 0, '精排请求').q).toContain('转账')
    const n = out.rerankInfo.used ? out.rerankInfo.candidates : 0
    // 长度必须等于候选数：不等就说明按下标取值会错位（把分数贴到别的文档上）
    expect(at(stub.calls, 0, '精排请求').docs).toHaveLength(n)
  })

  it('精排真的参与了排序：把第一名压到最低分，引用顺序就变了', async () => {
    twoCandidates()
    const plain = await run()
    expect(plain.citations.length).toBeGreaterThan(1)
    const key = (c: { name: string; local_id: number } | undefined): string => (c ? `${c.name}:${c.local_id}` : '')
    const firstKey = key(plain.citations[0])
    const flip = stubRerank((_q, docs) => docs.map((_, i) => (i === 0 ? -1 : 1)))
    const out = await run({ rerank: flip.fn })
    expect(out.rerankInfo.used).toBe(true)
    expect(out.citations.length).toBe(plain.citations.length)
    expect(key(out.citations[0]), '精排被调用了却没改变任何顺序').not.toBe(firstKey)
  })

  it('rerank 抛错 ⇒ 问答照常可用，note 说清这次没精排（H7 同一口径）', async () => {
    twoCandidates()
    const failing = async (): Promise<number[]> => { throw new Error('rerank HTTP 503') }
    const out = await run({ rerank: failing })
    expect(out.rerankInfo.used).toBe(false)
    if (!out.rerankInfo.used) {
      expect(out.rerankInfo.note).toContain('503')
      expect(out.rerankInfo.note).toContain('退回本地加权')
    }
    const plain = await run()
    expect(out.citations.length).toBe(plain.citations.length)
  })
})
