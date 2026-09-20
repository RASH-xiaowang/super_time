/**
 * B 档解析器之二：Word（`.docx`，依赖 `mammoth`，**惰性加载**）。
 *
 * ── 为什么要过一道 HTML ─────────────────────────────────────────────
 *   `.docx` 的正文在 `word/document.xml` 里，但「标题」不是靠 `<w:p>` 本身表达的，
 *   而是 `w:pStyle → 样式表 → 大纲级别` 的一条间接链，列表编号又是另一套
 *   （`numbering.xml` + `numPr`，要自己推算每级的序号）。`mammoth` 把这条链解完，
 *   输出**语义化 HTML**（`<h1>` / `<ul><li>`），正好是本仓 A' 档已有的输入形态。
 *
 *   于是本文件的核心不是「怎么读 XML」，而是**怎么把表格从 HTML 里安全地摘出来**：
 *   `parseHtml` 把 `<tr>` / `<td>` 当块级标签，直接喂给它会让每个单元格各成一段、
 *   各成一个检索块（表里「张三」独立成块后，模型不知道那是谁的名字）。
 *   做法见 `extractTables`：整个 `<table>` 换成一个**标记段落**，跑完 `parseHtml`
 *   再按标记换回 `kind: 'table'` 的段 —— 这样表头（列名）留在同一块里，
 *   而面包屑（`<h1>` 决定的 heading）由 `parseHtml` 按文档顺序算好，一行都不用自己维护。
 *
 * ── 标题为什么必须进面包屑 ────────────────────────────────────────────
 *   命中一个块时，块正文常常是「张三 / 项目经理」这种脱离上下文读不懂的碎片。
 *   `heading` 里带着「三、成员」，检索结果与送给模型的证据才有落点（设计稿 §5.1）。
 *   真实样本 `项目计划书.docx` 用的是 `Heading1` 样式，mammoth 输出 `<h1>` ⇒ 直接成立。
 *
 * ── 一个真实样本上观察到的边界（写在这里，免得后人当成我们的 bug）──────
 *   mammoth 对**未识别的段落样式**会退回普通段落并在 `messages` 里报一句
 *   （该样本的 `Title` 样式就是这种）。这是格式转换的正常降级，不是失败：
 *   正文一字不少，只是少了那一级的层级信息。我们把 messages 汇总进 `note`，
 *   让「为什么这一节没有标题」能被看见。
 */

import { assertWordContainer } from './container-guard.ts'
import { decodeEntities, normalizeProse, parseHtml, structuredTableText } from './parse-plain.ts'
import type { ParseOutcome, ParsedBlock } from './types.ts'

/**
 * 表格占位标记。
 *
 * 只用 ASCII 且**不含空白**：`normalizeProse` 会把连续空白折成一个空格、
 * 把 `\n{3,}` 折成 `\n\n`，任何带空白或控制字符的标记都会被改写掉
 *（`\u0000` 之类还会被 `stripInvisibles` 直接删掉，那样标记就永远匹配不上了）。
 */
const TABLE_MARK_PREFIX = '@@KB_TABLE_'
const TABLE_MARK_SUFFIX = '@@'

/** 整段就是一个标记时，取出它的序号；否则 null。 */
function markIndexOf(text: string): number | null {
  if (!text.startsWith(TABLE_MARK_PREFIX) || !text.endsWith(TABLE_MARK_SUFFIX)) return null
  const mid = text.slice(TABLE_MARK_PREFIX.length, text.length - TABLE_MARK_SUFFIX.length)
  return /^\d+$/.test(mid) ? Number(mid) : null
}

/**
 * 单元格 HTML → 单行文本。
 *
 * 不复用 `parseHtml`：它会给单元格算面包屑、判标题、产出多个段，
 * 而单元格需要的恰恰是**反过来**的事 —— 拍平成一行。标签换成空格而不是删掉，
 * 是为了让 `<p>a</p><p>b</p>` 不会粘成 `ab`。
 * @param inner - `<td>` / `<th>` 的内部 HTML。
 * @returns 单元格文本。
 */
function cellText(inner: string): string {
  return normalizeProse(decodeEntities(inner.replace(/<[^>]*>/g, ' ')))
}

/**
 * 抽取一个 `<table>` 的行与单元格。
 *
 * 用正则而不是 DOM 解析器：输入是刚由 `mammoth` 生成、结构完全规整的 HTML
 *（不是任意网页），而项目里为这件事引一个 DOM 解析器并不划算。
 * 已知边界：**单元格里再嵌表格**时内外 `<tr>` 会配对错乱（真实文档里罕见），
 * 这里不处理 —— 与其写一段没人验证过的嵌套逻辑，不如让这一层的假设摆在明面上。
 * @param tableHtml - 含 `<table>…</table>` 的片段。
 * @returns 行 × 单元格；无有效行时为空数组。
 */
function extractRows(tableHtml: string): string[][] {
  const rows: string[][] = []
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let tr: RegExpExecArray | null
  while ((tr = trRe.exec(tableHtml)) !== null) {
    const cells: string[] = []
    const tdRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi
    let td: RegExpExecArray | null
    while ((td = tdRe.exec(tr[1] ?? '')) !== null) cells.push(cellText(td[1] ?? ''))
    if (cells.length > 0) rows.push(cells)
  }
  return rows
}

/**
 * 把 HTML 里的每个 `<table>` 换成标记段落，并交出摘下来的表格。
 *
 * 标记段落用 `<p>` 包起来：`parseHtml` 的 `BLOCK_TAGS` 里有 `p`，
 * 于是标记会被**单独冲成一段**（不会与前后正文粘在一起），
 * 而它所在位置的 heading 正是我们想要的那个。
 * @param html - mammoth 产出的 HTML。
 * @returns 替换后的 HTML 与按出现顺序排列的表格。
 */
function extractTables(html: string): { html: string, tables: string[][][] } {
  const tables: string[][][] = []
  // 非贪婪匹配到最近的 `</table>`：嵌套表格会因此被截断，见 `extractRows` 的说明。
  const out = html.replace(/<table[\s\S]*?<\/table>/gi, (whole) => {
    const rows = extractRows(whole)
    if (rows.length === 0) return '' // 空表格：不占位置，也不产生空标记
    tables.push(rows)
    return `<p>${TABLE_MARK_PREFIX}${tables.length - 1}${TABLE_MARK_SUFFIX}</p>`
  })
  return { html: out, tables }
}

/** mammoth 模块的最小形状（只声明用到的那一个入口）。 */
interface MammothLike {
  convertToHtml: (input: { buffer: Buffer }) => Promise<{ value?: unknown, messages?: Array<{ message?: unknown }> }>
}

/**
 * 解析一份 `.docx`。
 *
 * 与 `parse-pdf.ts` 同一套失败语义：抽不出文字 ⇒ 返回 `unsupported`；
 * 读不动（不是 zip、不是 docx、加密）⇒ 抛出，由执行器记 `failed`。
 * 其中「不是 docx / 拷了一半」由 `container-guard.ts` 的**容器预检**负责，
 * 判据是 OOXML 规范强制要求的 `word/document.xml` 是否存在 —— 这比把字节交给
 * mammoth、再读回一句英文的 zip 报错更早、也更准。
 * @param bytes - 文件字节。
 * @returns 解析产物。
 */
export async function parseDocx(bytes: Uint8Array): Promise<ParseOutcome> {
  // 见 container-guard.ts 头注：这一步不依赖第三方库，先挡掉「不是 docx」与「拷了一半」，
  // 免得把一份改了扩展名的 xlsx 交给 mammoth 去啃。
  assertWordContainer(bytes)

  const mod = await import(/* @vite-ignore */ 'mammoth') as Record<string, unknown>
  const mammoth = ((mod['default'] ?? mod) as MammothLike)
  if (typeof mammoth?.convertToHtml !== 'function') {
    throw new Error('mammoth 没有提供 convertToHtml（依赖装错或不完整）')
  }

  const res = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) })
  const html = typeof res?.value === 'string' ? res.value : ''
  const { html: marked, tables } = extractTables(html)

  const blocks: ParsedBlock[] = []
  for (const b of parseHtml(marked)) {
    const idx = markIndexOf(b.text)
    const rows = idx === null ? undefined : tables[idx]
    if (rows === undefined) {
      blocks.push(b)
      continue
    }
    // 表格段：heading 沿用解析器按文档顺序算好的面包屑（这正是绕标记这一圈的目的）。
    const text = structuredTableText(rows, '\t')
    if (text !== '') blocks.push({ text, page: 0, heading: b.heading, kind: 'table' })
  }

  if (blocks.length === 0) {
    return {
      state: 'unsupported',
      parser: '',
      blocks: [],
      note: '这份 Word 文档里没有可提取的文字（可能整篇都是图片或文本框）',
    }
  }

  const warnCount = Array.isArray(res?.messages) ? res.messages.length : 0
  const suffixes: string[] = []
  if (warnCount > 0) suffixes.push('有 ' + warnCount + ' 处样式未识别，已按普通段落处理（正文不受影响）')
  return { state: 'ready', parser: 'mammoth', blocks, note: suffixes.join('；') }
}
