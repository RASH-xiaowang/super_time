/**
 * 知识库关键词检索（`query/kb-search.ts`）的回归用例。
 *
 * 真夹具、真 sqlite：每个用例在自己的临时数据根里 `registerKbFile` 登记真文件，
 * 走的是与线上**完全相同**的那条写入路径（读字节 → 解析 → 分块 → 落 chunk + FTS），
 * 所以这里断言的是「真索引能被搜到」，不是「mock 被调用了」。
 *
 * 钉的五件事（对齐计划 §2.1 的 T3 验收）：
 *   ① **不串库**：跨库查不到对方的块 —— 且这个断言是**有力度**的，见下；
 *   ② 独有短语 → 结果第一条就是那个文件（探针第 6 步的单测等价物）；
 *   ③ 摘要与高亮：`marks` 的偏移落在 `snippet` 内、且切出来**就是**检索词；
 *   ④ 边界：空查询 / 纯标点 / 非法库标识 / 未解析文件 —— 都不许抛，且要说清原因；
 *   ⑤ 降级可见：T3 恒带 `degraded`，不许假装有稠密通道。
 *
 * ⚠️ **不串库这条断言最容易写成假绿**：如果乙库里根本没有能匹配的内容，
 * 「在甲库检索看不到乙库结果」是**必然**成立的 —— 它测的不是隔离，是空集。
 * 所以本文件的做法是：先用**同一句查询**在乙库里搜、断言**确实搜得到**，
 * 再用它在甲库里搜、断言**看不到乙库那一行**。两半都过，才是真的隔离。
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_KB_TOP_K, searchKb } from '../src/query/kb-search.ts'
import { deleteKbFile, registerKbFile, setKbFileRagFlag } from '../src/query/kb-files.ts'

let root = ''
let decrypted = ''
let srcDir = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kb-search-'))
  decrypted = join(root, 'data', 'decrypted')
  srcDir = join(root, 'src')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(srcDir, { recursive: true })
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
function register(name: string, content: string, kbId = 1): number {
  const r = registerKbFile(decrypted, { kbId, srcPath: fixture(name, content) })
  if (!r.ok || r.file === undefined) throw new Error(`夹具登记失败：${name} → ${r.code}: ${r.error}`)
  return r.file.id
}

/** 一句只可能出现在我们夹具里的短语。 */
const UNIQUE = '蓝鲸协议第七附则'

/** 另一句，用来构造第二个库的可搜索内容。 */
const OTHER = '玄武纪要第九附录'

/** 长正文：末尾才出现独有短语，用来验证**最后一块**也进了索引。 */
function longText(uniquePhrase: string, filler = '这是一段用于把正文撑长的填充文字，它本身没有检索价值，只是为了让分块器真的切出多块。'): string {
  const paras = Array.from({ length: 24 }, (_, i) => `第 ${i + 1} 段：${filler}`)
  return paras.join('\n\n') + '\n\n' + uniquePhrase
}

/**
 * `longText` 的同内容副本，但**多一节仅供区分的尾部段落**。
 *
 * 为什么需要：同库内 `(kb_id, sha256)` 唯一 —— 两份逐字节相同的文件，
 * 第二份会被判 `duplicate` 而登记失败。造「多个文件都命中同一短语」的夹具
 * （topK 夹取、名次递增）时，必须让它们真的不同。
 * 尾部那段不含独有短语，也不改变「命中块只有一条」这个前提。
 */
function withTag(text: string, tag: string): string {
  return text + '\n\n' + tag
}

describe('独有短语 → 命中该文件（T3 验收 / 探针第 6 步的等价物）', () => {
  it('检索结果第一条就是含该短语的那个文件', () => {
    const id = register('甲.md', longText(UNIQUE))
    const r = searchKb(decrypted, 1, { query: UNIQUE })
    expect(r.readError).toBeUndefined()
    expect(r.error).toBeUndefined()
    expect(r.hits.length).toBeGreaterThan(0)
    expect(r.hits[0]?.fileId).toBe(id)
    expect(r.hits[0]?.fileName).toBe('甲.md')
    expect(r.hits[0]?.fileExt).toBe('md')
  })

  it('末尾那块也进了索引（长正文里只有最后一块含该短语）', () => {
    const id = register('长文.txt', longText(UNIQUE))
    const r = searchKb(decrypted, 1, { query: UNIQUE })
    expect(r.hits.length).toBeGreaterThan(0)
    expect(r.hits.every(h => h.fileId === id)).toBe(true)
    // 「最后一块」的直接证据：命中块的 ordinal 不等于 0，且摘要里真的含该短语。
    expect(r.hits.some(h => h.ordinal > 0)).toBe(true)
    expect(r.hits.some(h => h.snippet.includes(UNIQUE))).toBe(true)
  })

  it('CSV 的每一块都带着表头 → 任何一块都能按列名命中', () => {
    const head = '姓名,金额,备注'
    const rows = Array.from({ length: 90 }, (_, i) => `客户${i + 1},${1000 + i},第${i + 1}笔`)
    const csv = [head, ...rows].join('\n')
    const id = register('台账.csv', csv)
    // 表头列名只在每个块的首行出现（块内行不带列名），能命中说明「表头被重复写进了每一块」。
    const r = searchKb(decrypted, 1, { query: '金额' })
    expect(r.hits.length).toBeGreaterThan(1)
    expect(r.hits.every(h => h.fileId === id)).toBe(true)
    expect(r.hits.every(h => h.snippet.startsWith(head) || h.snippet.includes(head))).toBe(true)
  })
})

describe('作用域：不串库', () => {
  it('两库各有可搜内容时，甲库检索看不到乙库的块（反向也看不到）', () => {
    const idA = register('甲库文件.md', longText(UNIQUE), 1)
    const idB = register('乙库文件.md', longText(OTHER), 2)

    // 前置：证明两库**各自都真的搜得到**。少了这一步，下面的「看不到对方」
    // 可能只是因为乙库压根没内容 —— 那就是假绿（本文件头注 ⚠️）。
    const inA = searchKb(decrypted, 1, { query: UNIQUE })
    const inB = searchKb(decrypted, 2, { query: OTHER })
    expect(inA.hits.length).toBeGreaterThan(0)
    expect(inB.hits.length).toBeGreaterThan(0)
    expect(inA.hits[0]?.fileId).toBe(idA)
    expect(inB.hits[0]?.fileId).toBe(idB)

    // 隔离：甲库的结果里一个乙库的 fileId 都不许有；乙库同理。
    expect(inA.hits.every(h => h.fileId !== idB)).toBe(true)
    expect(inB.hits.every(h => h.fileId !== idA)).toBe(true)

    // 更狠的一条：**用对方的短语**去搜本库，必须一条都搜不到。
    const crossA = searchKb(decrypted, 1, { query: OTHER })
    const crossB = searchKb(decrypted, 2, { query: UNIQUE })
    expect(crossA.hits).toEqual([])
    expect(crossB.hits).toEqual([])
    expect(crossA.stats.terms).toBeGreaterThan(0) // 查询有效，只是本库没有
  })

  it('两库放**同一份内容**（跨库允许同 sha256）时，各搜各的、互不越界', () => {
    // 登记到两个库：内容相同 → sha256 相同。唯一索引是 (kb_id, sha256)，所以两边都能进。
    const idA = register('同内容.md', longText(UNIQUE), 1)
    const idB = register('同内容.md', longText(UNIQUE), 2)
    expect(idA).not.toBe(idB)

    const inA = searchKb(decrypted, 1, { query: UNIQUE })
    const inB = searchKb(decrypted, 2, { query: UNIQUE })
    expect(inA.hits.length).toBeGreaterThan(0)
    expect(inB.hits.length).toBeGreaterThan(0)
    // 这正是「只按 MATCH 不按库过滤」会露馅的地方：两边内容一样，
    // 漏了过滤就会互相看到对方的 chunkId。
    expect(new Set(inA.hits.map(h => h.fileId))).toEqual(new Set([idA]))
    expect(new Set(inB.hits.map(h => h.fileId))).toEqual(new Set([idB]))
    const idsA = new Set(inA.hits.map(h => h.chunkId))
    const idsB = new Set(inB.hits.map(h => h.chunkId))
    expect([...idsA].some(c => idsB.has(c))).toBe(false)
  })

  it('删掉一个库的文件后，本库搜不到、另一库照旧', () => {
    const idA = register('甲库.md', longText(UNIQUE), 1)
    const idB = register('乙库.md', longText(UNIQUE), 2)
    expect(searchKb(decrypted, 1, { query: UNIQUE }).hits.length).toBeGreaterThan(0)

    const del = deleteKbFile(decrypted, 1, idA)
    expect(del.ok).toBe(true)

    // 级联把 chunk 与 FTS 行一起清了 ⇒ 搜不到；而乙库那份**一模一样的内容**仍在。
    expect(searchKb(decrypted, 1, { query: UNIQUE }).hits).toEqual([])
    const stillB = searchKb(decrypted, 2, { query: UNIQUE })
    expect(stillB.hits.length).toBeGreaterThan(0)
    expect(stillB.hits.every(h => h.fileId === idB)).toBe(true)
  })
})

describe('摘要与高亮', () => {
  it('marks 的偏移落在 snippet 内，且切出来就是检索词', () => {
    register('摘要.md', longText(UNIQUE))
    const r = searchKb(decrypted, 1, { query: UNIQUE })
    const hit = r.hits[0]
    expect(hit).toBeDefined()
    if (hit === undefined) return
    expect(hit.marks.length).toBeGreaterThan(0)
    for (const m of hit.marks) {
      // 区间必须落在摘要内（越界会让前端 slice 出空串，看起来「搜到了但没高亮」）。
      expect(m.start).toBeGreaterThanOrEqual(0)
      expect(m.end).toBeLessThanOrEqual(hit.snippet.length)
      expect(m.end).toBeGreaterThan(m.start)
      expect(hit.snippet.slice(m.start, m.end)).toBe(UNIQUE)
    }
  })

  it('摘要有截断标记时，偏移仍然对得上（前缀 … 的 1 个字符不能算漏）', () => {
    // 让独有短语落在**块的中后段**，窗口左边界因此必然被截断（snippet 以 … 开头）。
    // 造法刻意不含空行与句末标点 ⇒ 分块器找不到段落/句子切点，只能硬切，
    // 切点位置是确定的：第 1 块 = [0, 500)，独有短语起于块内第 336 个字符，
    // 距块首 336 > radius(60) ⇒ `winStart > 0` ⇒ 一定带前缀 …。
    //（上一版把独有短语放在正文末尾，结果被段落边界切到了下一块的开头，
    //  块内偏移为 0、窗口根本没被截断 —— 那条断言其实在测「没有截断」。）
    const pad = '这是一段没有句末标点的填充文字它本身并不承载任何检索价值'
    register('长摘要.md', pad.repeat(12) + UNIQUE + pad.repeat(12))
    const r = searchKb(decrypted, 1, { query: UNIQUE })
    const hit = r.hits[0]
    expect(hit).toBeDefined()
    if (hit === undefined) return
    expect(hit.snippet.startsWith('…')).toBe(true)
    expect(hit.marks.length).toBeGreaterThan(0)
    const m = hit.marks[0]
    expect(m).toBeDefined()
    if (m === undefined) return
    // 若忘了把 '…' 的偏移算进去，这里会切出「蓝鲸协议第七附」少一个字。
    expect(hit.snippet.slice(m.start, m.end)).toBe(UNIQUE)
  })

  it('只命中标题（正文里没有该词）也能召回，摘要退回块首一段且 marks 为空', () => {
    // Markdown 的 `# 标题` 会进 heading；正文里刻意不出现「松果」二字。
    const body = ['# 松果年度规划', '', '这一段正文刻意不写那个词，只让它出现在标题里。'].join('\n')
    const id = register('标题命中.md', body)
    const r = searchKb(decrypted, 1, { query: '松果' })
    expect(r.hits.length).toBeGreaterThan(0)
    expect(r.hits[0]?.fileId).toBe(id)
    expect(r.hits[0]?.heading.includes('松果')).toBe(true)
    // 正文里没有这个词 ⇒ 字面定位找不到 ⇒ marks 为空，但摘要**不能是空串**
    // （空摘要在界面上和「这条没有内容」长得一样）。
    const hit = r.hits[0]
    expect(hit?.marks).toEqual([])
    expect((hit?.snippet ?? '').length).toBeGreaterThan(0)
  })
})

describe('边界：不许抛，且要说清原因', () => {
  it('空查询 → 返回空命中，且 note 说明是查询为空（不是「没有匹配」）', () => {
    register('有内容.md', longText(UNIQUE))
    const r = searchKb(decrypted, 1, { query: '   ' })
    expect(r.hits).toEqual([])
    expect(r.error).toBeUndefined()
    expect(r.readError).toBeUndefined()
    expect(r.stats.terms).toBe(0)
    expect(r.stats.channels[0]?.note).toBe('查询为空')
  })

  it('纯标点 → 不抛（bigram 化之后没有 token），原因文案区分于「查询为空」', () => {
    register('有内容.md', longText(UNIQUE))
    const r = searchKb(decrypted, 1, { query: '，。！？——' })
    expect(r.hits).toEqual([])
    expect(r.error).toBeUndefined()
    expect(r.stats.channels[0]?.note).toBe('查询里没有可检索的字词')
  })

  it('库标识非法 → 明确报错，而不是静默给空结果', () => {
    register('有内容.md', longText(UNIQUE))
    for (const bad of [0, -1, Number.NaN]) {
      const r = searchKb(decrypted, bad, { query: UNIQUE })
      expect(r.hits).toEqual([])
      expect(r.error).toBeDefined()
    }
  })

  it('库里没有匹配内容时是空命中、不是报错', () => {
    register('有内容.md', longText(UNIQUE))
    const r = searchKb(decrypted, 1, { query: '完全不存在的词组组合' })
    expect(r.hits).toEqual([])
    expect(r.error).toBeUndefined()
    expect(r.readError).toBeUndefined()
    // 查询本身有效（有 token），只是没命中 —— 与「查询为空」必须分得开。
    expect(r.stats.terms).toBeGreaterThan(0)
    expect(r.stats.channels[0]?.active).toBe(true)
  })

  it('未解析（unsupported）的文件不产生块 ⇒ 搜不到，但也不整库报错', () => {
    // png 在 C 档：只登记元数据、不解析正文（chunk_count = 0）。
    const png = join(srcDir, '图.png')
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))
    const reg = registerKbFile(decrypted, { kbId: 1, srcPath: png })
    expect(reg.ok).toBe(true)
    expect(reg.file?.chunkCount).toBe(0)

    const id = register('有内容.md', longText(UNIQUE))
    const r = searchKb(decrypted, 1, { query: UNIQUE })
    expect(r.hits.every(h => h.fileId === id)).toBe(true)
    expect(r.hits.some(h => h.fileId === reg.file?.id)).toBe(false)
  })

  it('include_in_rag=0 的文件**仍能被关键词搜到**（设计稿 §9.2）', () => {
    const id = register('不出网.md', longText(UNIQUE))
    const flag = setKbFileRagFlag(decrypted, 1, id, false)
    expect(flag.ok).toBe(true)
    // 关掉的是「出网做向量」，不是「进关键词索引」—— 这正是
    // 「库里有合同，但我还想搜到它」能成立的原因。
    const r = searchKb(decrypted, 1, { query: UNIQUE })
    expect(r.hits.length).toBeGreaterThan(0)
    expect(r.hits[0]?.fileId).toBe(id)
  })

  it('topK 被夹在上限内；非法 topK 回落到默认', () => {
    // 造 3 个都含同一短语的文件，再限制 topK=2。
    for (let i = 1; i <= 3; i += 1) register(`多${i}.md`, withTag(longText(UNIQUE), `第 ${i} 份`))
    expect(searchKb(decrypted, 1, { query: UNIQUE, topK: 2 }).hits.length).toBe(2)
    // 非法值不抛、回落到默认（默认 20 > 3，所以三条都能出来）。
    expect(searchKb(decrypted, 1, { query: UNIQUE, topK: 0 }).hits.length).toBe(3)
    expect(searchKb(decrypted, 1, { query: UNIQUE, topK: -5 }).hits.length).toBe(3)
    expect(searchKb(decrypted, 1, { query: UNIQUE, topK: Number.NaN }).hits.length).toBe(3)
    // 超过上限不抛（夹住即可）。
    expect(MAX_KB_TOP_K).toBeGreaterThan(0)
    expect(searchKb(decrypted, 1, { query: UNIQUE, topK: 99999 }).hits.length).toBe(3)
  })
})

describe('排序、统计与降级标注', () => {
  it('ranks.sparse 从 1 递增，score 随名次不升', () => {
    for (let i = 1; i <= 4; i += 1) register(`排${i}.md`, withTag(longText(UNIQUE), `第 ${i} 份`))
    const r = searchKb(decrypted, 1, { query: UNIQUE })
    expect(r.hits.length).toBeGreaterThan(1)
    r.hits.forEach((h, i) => {
      expect(h.ranks.sparse).toBe(i + 1)
      if (i > 0) {
        const prev = r.hits[i - 1]
        expect(prev).toBeDefined()
        // score 已按「越大越相关」取过负号；BM25 排序下这个序列必须非升。
        expect(h.score).toBeLessThanOrEqual(prev?.score ?? Number.POSITIVE_INFINITY)
      }
    })
  })

  it('相关度高的排在最前（把「按插入顺序排」这种退化钉死）', () => {
    // ⚠ 这条用例的存在理由是**让排序可被变异测试咬到**。
    // 上面那条「首条命中」用例只有一个文件命中，`hits.length === 1`，
    // 任何排序实现都能过 —— 它证明不了排序没坏。
    //
    // 造法：让「相关度」与「插入顺序」**刻意相反**。
    //   · 先登记词频低的（id 小）；
    //   · 再登记词频高的（id 大）。
    // 若把 `ORDER BY rank` 换成按插入顺序（`ORDER BY c.id`），第一条会是词频低的那份。
    const idLow = register('少.md', '正文里只出现一次' + UNIQUE + '，其余都是普通内容。')
    const idHigh = register('多.md', Array.from({ length: 12 }, () => UNIQUE).join('，') + '。')
    const r = searchKb(decrypted, 1, { query: UNIQUE })
    expect(r.hits.length).toBeGreaterThan(1)
    expect(r.hits[0]?.fileId).toBe(idHigh)
    // 少的那份**依然被召回**（排序不是过滤）—— 只钉顺序，不钉召回。
    expect(r.hits.some(h => h.fileId === idLow)).toBe(true)
    expect(r.hits[0]?.ranks.sparse).toBe(1)
  })

  it('多词查询是 OR：两个词分别命中不同块时都能召回', () => {
    const id = register('两词.md', ['# 甲段', '', '前一半里写着' + UNIQUE + '。', '', '# 乙段', '', '后一半里写着' + OTHER + '。'].join('\n'))
    const r = searchKb(decrypted, 1, { query: UNIQUE + ' ' + OTHER })
    expect(r.stats.terms).toBe(2)
    expect(r.hits.length).toBeGreaterThanOrEqual(2)
    expect(r.hits.every(h => h.fileId === id)).toBe(true)
  })

  it('T3 恒为降级态：带 degraded，且不假装有稠密通道', () => {
    register('内容.md', longText(UNIQUE))
    const r = searchKb(decrypted, 1, { query: UNIQUE })
    expect(r.degraded?.reason).toBe('no-vector-index')
    // 文案纪律：只说明现状，**不劝用户去打开什么**（设计稿 §6.3 的第二档）。
    expect(r.degraded?.label).toBe('仅关键词（未建向量索引）')
    expect(r.degraded?.label).not.toContain('请')
    // 通道清单里只有 sparse；出现 dense 就说明有人在 T3 阶段写了不存在的通道。
    expect(r.stats.channels.map(c => c.channel)).toEqual(['sparse'])
    expect(r.stats.channels[0]?.active).toBe(true)
  })

  it('统计里的 recalled / kept 与实际命中数一致，耗时非负', () => {
    register('统计.md', longText(UNIQUE))
    const r = searchKb(decrypted, 1, { query: UNIQUE })
    expect(r.stats.recalled).toBe(r.hits.length)
    expect(r.stats.kept).toBe(r.hits.length)
    expect(r.stats.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(r.stats.channels[0]?.count).toBe(r.hits.length)
    // 回显了查询词，界面才能确认「看到的是这一次的结果」。
    expect(r.query).toBe(UNIQUE)
    expect(r.kbId).toBe(1)
  })
})
