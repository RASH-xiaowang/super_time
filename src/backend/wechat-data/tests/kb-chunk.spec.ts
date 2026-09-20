/**
 * 知识库分块器（`query/kb/chunk.ts`）的回归用例。
 *
 * 这一支是零依赖纯函数（不碰 fs / sqlite / 网络 / 时间），所以能在这里把它的**契约**
 * 逐条钉死 —— 而分块的契约质量直接决定「检索命中的东西有多像一段人话」。
 *
 * 钉的四件事：
 *   ① 三级切点优先级（段落 > 句末 > 硬切）与「只在窗口后段找切点」；
 *   ② 相邻块重叠**恰好** 80 字符，且去掉重叠能逐字符还原原文（分块无损）；
 *   ③ 表格按行组切、每块重复表头（绝不把一行劈成两半）；
 *   ④ 终止性与总量上限（参数越界不抛错、不死循环、超限置 `truncated`）。
 *
 * 断言里凡涉及具体数字的地方都从导出的常量取，不写字面量：调常量时用例应当
 * 自动跟着走，只有在**语义**变了的时候才该转红。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  CHUNK_MAX_CHARS,
  CHUNK_OVERLAP_CHARS,
  MAX_CHUNKS_PER_FILE,
  TABLE_ROWS_PER_CHUNK,
  chunkBlocks,
  splitProse,
  splitTableRows,
} from '../src/query/kb/chunk.ts'
import type { ParsedBlock } from '../src/query/kb/types.ts'

/** 造一段正文。 */
const prose = (text: string, heading = ''): ParsedBlock => ({ text, page: 0, heading, kind: 'prose' })

/** 造一段表格正文。 */
const table = (text: string, heading = ''): ParsedBlock => ({ text, page: 0, heading, kind: 'table' })

/** 一句 14 字的中文句子，用来造「句末切点」密集的文本。 */
const SENTENCE = '这是一个用于测试分块的句子。'

describe('分块器 · 三级切点优先级', () => {
  it('段落断点优先于句末 —— 即便句末离窗口尾更近', () => {
    // 同一套骨架造两份文本：A 有段落断点（靠前），B 把断点换成普通字符。
    // A 里那个「。」在索引 34，比段落断点（索引 12）更靠近窗口尾；若实现是
    // 「取离窗口尾最近的切点」，A 会和 B 切在同一处 —— 那就没有优先级可言了。
    const head = 'a'.repeat(12)
    const tail = 'b'.repeat(20) + '。' + 'c'.repeat(20)
    const opts = { maxChars: 50, overlapChars: 0, minChars: 10 }

    const withPara = splitProse(head + '\n\n' + tail, opts)
    expect(withPara[0]!.length).toBe(14) // 12 + '\n\n'（切点在断点之后一位，含那两行空行）
    expect(withPara[0]!.endsWith('\n\n')).toBe(true)

    const withoutPara = splitProse(head + 'xy' + tail, opts)
    expect(withoutPara[0]!.length).toBe(35) // 12 + 2 + 20 + '。'
    expect(withoutPara[0]!.endsWith('。')).toBe(true)
  })

  it('没有段落断点时退到句末', () => {
    const text = '甲'.repeat(20) + '。' + '乙'.repeat(30)
    const pieces = splitProse(text, { maxChars: 40, overlapChars: 0, minChars: 10 })
    expect(pieces[0]).toBe('甲'.repeat(20) + '。')
    expect(pieces[0]!.length).toBe(21)
  })

  it('都没有时硬切在窗口尾', () => {
    const pieces = splitProse('丙'.repeat(55), { maxChars: 40, overlapChars: 0, minChars: 10 })
    expect(pieces.map(p => p.length)).toEqual([40, 15])
  })

  it('只在窗口后段找切点：靠前的句末不会被选中（不切出碎块）', () => {
    // 「甲。」在索引 1，早于 minChars；若允许在任意位置切，会切出一个 2 字的块。
    const pieces = splitProse('甲。' + '乙'.repeat(60), { maxChars: 40, overlapChars: 0, minChars: 10 })
    expect(pieces[0]!.length).toBe(40)
    expect(pieces[0]!.startsWith('甲。')).toBe(true)
  })
})

describe('分块器 · 重叠与无损', () => {
  it('相邻块重叠恰好为 CHUNK_OVERLAP_CHARS（默认参数）', () => {
    const text = SENTENCE.repeat(100) // 1400 字，远长于窗口
    const pieces = splitProse(text)
    expect(pieces.length).toBeGreaterThan(1)

    for (let i = 1; i < pieces.length; i += 1) {
      const prev = pieces[i - 1] as string
      const cur = pieces[i] as string
      // 逐字符相等，不是「包含」：重叠量一旦漂移，就无法向使用者解释到底带了多少上下文。
      expect(cur.slice(0, CHUNK_OVERLAP_CHARS)).toBe(prev.slice(-CHUNK_OVERLAP_CHARS))
      expect(cur.slice(0, CHUNK_OVERLAP_CHARS).trim()).not.toBe('')
    }
  })

  it('去掉重叠后可逐字符还原原文（分块无损）', () => {
    const text = SENTENCE.repeat(100)
    const pieces = splitProse(text)
    let rebuilt = pieces[0] as string
    for (let i = 1; i < pieces.length; i += 1) rebuilt += (pieces[i] as string).slice(CHUNK_OVERLAP_CHARS)
    expect(rebuilt).toBe(text)
  })

  it('有句子边界时绝不切在句中', () => {
    const pieces = splitProse(SENTENCE.repeat(100))
    expect(pieces.every(p => p.endsWith('。'))).toBe(true)
    expect(pieces.every(p => p.length <= CHUNK_MAX_CHARS)).toBe(true)
  })

  it('短于窗口的文本整段返回，且不做 trim', () => {
    const text = '  前面有空白，后面也有  '
    expect(splitProse(text)).toEqual([text])
    expect(splitProse('')).toEqual([])
  })
})

describe('分块器 · 段与块的装配', () => {
  it('同段被切开时 heading 带「续 N」，首块不带', () => {
    const res = chunkBlocks([prose('A'.repeat(600), '第一章')])
    expect(res.chunkCount).toBe(2)
    expect(res.chunks[0]).toMatchObject({ ordinal: 0, charCount: 500, page: 0, heading: '第一章' })
    expect(res.chunks[1]!.heading).toBe('第一章（续 2）')
    expect(res.chunks[1]!.text).toBe('A'.repeat(600 - (CHUNK_MAX_CHARS - CHUNK_OVERLAP_CHARS)))
    expect(res.charCount).toBe(res.chunks.reduce((s, c) => s + c.charCount, 0))
  })

  it('跨段不重叠，且「续 N」按段重新起算', () => {
    // 两段各 600 字：若跨段还带重叠，第 3 块的开头会混进上一段的尾巴。
    const res = chunkBlocks([prose('A'.repeat(600), '第一章'), prose('B'.repeat(600), '第二章')])
    expect(res.chunks.map(c => c.heading)).toEqual(['第一章', '第一章（续 2）', '第二章', '第二章（续 2）'])
    expect(res.chunks[2]!.text).toBe('B'.repeat(500))
    expect(res.chunks.map(c => c.ordinal)).toEqual([0, 1, 2, 3])
  })

  it('纯空白段被跳过（不产出空块）', () => {
    const res = chunkBlocks([prose('   \n\n  '), prose('正文')])
    expect(res.chunkCount).toBe(1)
    expect(res.chunks[0]!.text).toBe('正文')
  })

  it('空输入产出 0 块，且不计为截断', () => {
    expect(chunkBlocks([])).toEqual({ chunks: [], truncated: false, chunkCount: 0, charCount: 0 })
  })

  it('页码透传到块上（非分页形态恒为 0）', () => {
    const res = chunkBlocks([{ text: '第 3 页的正文。', page: 3, heading: '', kind: 'prose' }])
    expect(res.chunks[0]!.page).toBe(3)
  })
})

describe('分块器 · 表格按行组', () => {
  const header = 'name,age,city'
  const rows = Array.from({ length: 100 }, (_, i) => `user${i},${i},city${i}`)

  it('每块首行都是表头，数据行每组不超过 TABLE_ROWS_PER_CHUNK', () => {
    const res = chunkBlocks([table([header, ...rows].join('\n'), '员工表')])
    expect(res.chunkCount).toBe(Math.ceil(100 / TABLE_ROWS_PER_CHUNK))
    for (const c of res.chunks) {
      expect(c.text.split('\n')[0]).toBe(header)
      expect(c.text.split('\n').length).toBeLessThanOrEqual(TABLE_ROWS_PER_CHUNK + 1)
    }
    expect(res.chunks[0]!.text.split('\n').length).toBe(TABLE_ROWS_PER_CHUNK + 1)
    expect(res.chunks[res.chunkCount - 1]!.text.split('\n').length)
      .toBe(100 - TABLE_ROWS_PER_CHUNK * (res.chunkCount - 1) + 1)
  })

  it('表格 heading 带列名摘要，并同样有「续 N」', () => {
    const res = chunkBlocks([table([header, ...rows].join('\n'), '员工表')])
    expect(res.chunks[0]!.heading).toBe('员工表 › 列名 name,age,city')
    expect(res.chunks[1]!.heading).toBe('员工表 › 列名 name,age,city（续 2）')
  })

  it('表头过长时 heading 摘要被截断（heading 是给人一眼看的）', () => {
    const long = 'c'.repeat(80)
    const res = chunkBlocks([table([long, 'r1', 'r2'].join('\n'))])
    expect(res.chunks[0]!.heading).toBe(`列名 ${'c'.repeat(60)}…`)
  })

  it('只有表头时产出单块，且 heading 只有列名（父级为空不产生分隔符）', () => {
    const res = chunkBlocks([table(header)])
    expect(res.chunkCount).toBe(1)
    expect(res.chunks[0]!.text).toBe(header)
    expect(res.chunks[0]!.heading).toBe('列名 name,age,city')
  })

  it('超长单行不被劈开（宁可块大，也不切行）', () => {
    // 一行 800 字，远超 CHUNK_MAX_CHARS：块会超长，但行必须完整。
    const fat = 'x'.repeat(800)
    const res = chunkBlocks([table([header, fat].join('\n'))])
    expect(res.chunkCount).toBe(1)
    expect(res.chunks[0]!.text).toBe(`${header}\n${fat}`)
    expect(splitTableRows('')).toEqual([])
  })
})

describe('分块器 · 参数与终止性', () => {
  it('越界参数被夹住而不是抛错', () => {
    // minChars > maxChars：夹到 maxChars，仍然切得动。
    const a = splitProse('甲'.repeat(100), { maxChars: 10, overlapChars: 0, minChars: 999 })
    expect(a.length).toBeGreaterThan(1)
    expect(a.every(p => p.length <= 10)).toBe(true)

    // 负 overlap：夹到 0 —— 相邻块之间不重叠。
    const b = splitProse('0123456789'.repeat(5), { maxChars: 10, overlapChars: -5, minChars: 1 })
    expect(b).toEqual(['0123456789', '0123456789', '0123456789', '0123456789', '0123456789'])
  })

  it('overlap >= maxChars 时仍能终止（单调推进兜底）', () => {
    // 这是「参数被调坏」的极端形态：若没有 `next >= start + 1` 兜底就是死循环。
    const pieces = splitProse('x'.repeat(200), { maxChars: 10, overlapChars: 50, minChars: 10 })
    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces.length).toBeLessThan(1000)
    expect(pieces.every(p => p.length <= 10)).toBe(true)
  })

  it('超过 maxChunks 时截断并置 truncated（供上层写进 parse_error）', () => {
    const blocks = [prose('A'.repeat(600), 'A'), prose('B'.repeat(600), 'B')]
    expect(chunkBlocks(blocks).chunkCount).toBe(4)
    expect(chunkBlocks(blocks).truncated).toBe(false)

    const capped = chunkBlocks(blocks, { maxChunks: 3 })
    expect(capped.chunkCount).toBe(3)
    expect(capped.truncated).toBe(true)
    expect(capped.chunks.map(c => c.ordinal)).toEqual([0, 1, 2])
  })

  it('MAX_CHUNKS_PER_FILE 是个大但有限的数', () => {
    // 上界保护的是「一次上传把出网闸门变成批量外泄」，不能退化成 Infinity。
    expect(Number.isFinite(MAX_CHUNKS_PER_FILE)).toBe(true)
    expect(MAX_CHUNKS_PER_FILE).toBeGreaterThan(1000)
    expect(MAX_CHUNKS_PER_FILE).toBeLessThanOrEqual(100000)
  })
})

describe('分块器 · 超长单行（50 万字）', () => {
  it('无断点的 50 万字被硬切，每块都带「续 N」且块序连续', () => {
    const N = 500_000
    const res = chunkBlocks([prose('a'.repeat(N))])

    expect(res.truncated).toBe(false) // 未触及 MAX_CHUNKS_PER_FILE
    expect(res.chunkCount).toBeGreaterThan(1000)
    expect(res.chunkCount).toBeLessThan(2000)

    expect(res.chunks[0]!.heading).toBe('') // 首块不带后缀
    expect(res.chunks[1]!.heading).toBe('（续 2）')
    expect(res.chunks[res.chunkCount - 1]!.heading).toBe(`（续 ${res.chunkCount}）`)

    expect(res.chunks[0]!.ordinal).toBe(0)
    expect(res.chunks[res.chunkCount - 1]!.ordinal).toBe(res.chunkCount - 1)
    expect(res.chunks.every(c => c.charCount === c.text.length)).toBe(true)
    expect(res.chunks.every(c => c.text.length <= CHUNK_MAX_CHARS)).toBe(true)
    // 每个块的内容都来自原文，没有凭空生成的字符。
    expect(res.chunks.every(c => /^a+$/.test(c.text))).toBe(true)
  })
})
