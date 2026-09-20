/**
 * A / A' 档解析器：把**字节**变成「段」（`ParsedBlock[]`）。纯函数，零依赖。
 *
 * 覆盖范围（不超出 `types.ts` 的 `PLAIN_TEXT_EXTS` / `HTML_EXTS` 两个注册表）：
 *   · A  档 —— txt / md / log / json / yaml / xml / srt / ini …：解码 + 归一化；
 *   · A' 档 —— html / htm / xhtml：去标签取可见文本；
 *   · 表格 —— csv / tsv：RFC4180 式的带引号字段解析，产出 `kind: 'table'` 的段。
 *
 * B 档（pdf / docx / xlsx）与 C 档（图片）**在这里一律返回 `unsupported` 并带上原因**，
 * 由存储层写进 `kb_files.parse_state` / `parse_error`。它们不是错误，只是没做 ——
 * 文案上必须区分开（「本机还没有 PDF 解析器」≠「文件损坏」，两者的排查方向完全不同）。
 *
 * ── 三处刻意的取舍 ──────────────────────────────────────────────────────
 *
 * 1) **解码优先 UTF-8 严格模式，失败才回退 GB18030。**
 *    「看起来像文本」不能靠 `fatal: false` 解码后数替换字符 —— 那样一段合法 GBK
 *    会被静默解成一串 U+FFFD 而没人报错。用严格模式让它**抛**，就能干净地判断。
 *    GB18030 是 GBK 的超集，优先用它；Node 未带对应 ICU 时退回 latin1 并在 note 里说明。
 *
 * 2) **表格字段内的换行被替换成空格。**
 *    「一行 = 一条记录」是分块器能按行组切的前提（见 `chunk.ts` 的 `splitTableRows`）；
 *    一个字段里藏着换行会让之后的每一行都错位。这是**有损**的，所以写在函数头上。
 *
 * 3) **超长输入在字节层截断**（`MAX_PARSE_BYTES`），而不是先解码再判。
 *    解码 500MB 文本会先把内存吃光，那时再判「太长」已经晚了。
 */

import type { DecodedText, ParseOutcome, ParsedBlock } from './types.ts'
import { HTML_EXTS, PENDING_PARSER_EXTS, PLAIN_TEXT_EXTS, REGISTER_ONLY_EXTS } from './types.ts'

/**
 * 单次解析允许读入的字节上限（32 MB）。
 *
 * UTF-8 中文约 3 字节/字，32MB ≈ 1000 万字 ≈ 2 万块，正好压在
 * `MAX_CHUNKS_PER_FILE` 附近 —— 这个上限不是凭空取的，它对应
 * 「一个文件最多能产生多少块」。
 */
export const MAX_PARSE_BYTES = 32 * 1024 * 1024

/** 标题层级数（`h1`..`h6`，Markdown 侧同样是 1~6 级）。 */
const HEADING_LEVELS = 6

/** 表格类的分隔符。 */
const DELIMITER_BY_EXT: Record<string, string> = { csv: ',', tsv: '\t' }

/** 这些扩展名走 HTML 取文本。 */
const HTML_SET = new Set<string>(HTML_EXTS)

/** A 档纯文本集合（查表用）。 */
const PLAIN_SET = new Set<string>(PLAIN_TEXT_EXTS)

/** `jsonl` / `ndjson`：逐行一个 JSON，不当成整份 JSON 解析。 */
const JSON_LINES_SET = new Set<string>(['jsonl', 'ndjson'])

/** Markdown 扩展名。 */
const MARKDOWN_SET = new Set<string>(['md', 'markdown', 'markdn'])

// ────────────────────────────────────────────────────────────────────────────
// 解码
// ────────────────────────────────────────────────────────────────────────────

/**
 * 尝试用某个标签解码；失败返回 null（而不是抛出去）。
 * @param bytes - 原始字节。
 * @param label - `TextDecoder` 的编码标签。
 * @param fatal - 遇到非法序列是否抛错。
 * @returns 解码结果，或 null。
 */
function tryDecode(bytes: Uint8Array, label: string, fatal: boolean): string | null {
  try {
    return new TextDecoder(label, { fatal }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * 解码一段字节，返回文本与**实际采用的编码**。
 *
 * BOM 优先（它比任何猜测都可靠）；无 BOM 时先按 UTF-8 严格模式试，抛错才回退 GB18030。
 * @param raw - 原始字节。
 * @returns 文本 + 编码 + 是否剥了 BOM。
 */
export function decodeText(raw: Uint8Array): DecodedText {
  // 字节层截断：见文件头第 3 条。被截断的尾部若正好切在多字节字符中间，
  // 非严格解码会产生一个替换字符 —— 可接受（它在最末尾，且已记入 note）。
  const bytes = raw.length > MAX_PARSE_BYTES ? raw.subarray(0, MAX_PARSE_BYTES) : raw

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const text = tryDecode(bytes.subarray(3), 'utf-8', false)
    if (text !== null) return { text, encoding: 'utf-8', bom: true }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    const text = tryDecode(bytes.subarray(2), 'utf-16le', false)
    if (text !== null) return { text, encoding: 'utf-16le', bom: true }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const text = tryDecode(bytes.subarray(2), 'utf-16be', false)
    if (text !== null) return { text, encoding: 'utf-16be', bom: true }
  }

  const utf8 = tryDecode(bytes, 'utf-8', true)
  if (utf8 !== null) return { text: utf8, encoding: 'utf-8', bom: false }

  const gb = tryDecode(bytes, 'gb18030', false)
  if (gb !== null) return { text: gb, encoding: 'gb18030', bom: false }

  // Node 未带 GB18030 时的最后兜底：latin1 永不抛错，至少保住 ASCII 部分。
  return { text: tryDecode(bytes, 'latin1', false) ?? '', encoding: 'latin1', bom: false }
}

// ────────────────────────────────────────────────────────────────────────────
// 归一化
// ────────────────────────────────────────────────────────────────────────────

/**
 * 换行统一成 `\n`（CRLF / 孤立 CR 都收掉）。
 * @param text - 原始文本。
 * @returns 换行已统一的文本。
 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/**
 * 去掉不可见字符：控制字符、零宽字符、行分隔符、BOM、软连字符。
 *
 * 为什么要清零宽字符：它们不显示，但会让「同一句话」在 BM25 里变成两个不同的词项，
 * 于是用户看着一模一样的词搜不到 —— 这种问题排查起来极其费时。
 * 换行（`\n`）与制表（`\t`）**保留**：它们是有意义的边界。
 * @param text - 原始文本。
 * @returns 清理后的文本。
 */
export function stripInvisibles(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff\u00ad]/g, '')
}

/**
 * 正文归一化：统一换行 + 去不可见 + 把不间断/全角空格收成半角 +
 * 行内连续空白折成一个空格 + 连续空行折成一个空行 + 去首尾空白。
 * @param text - 原始文本。
 * @returns 归一化文本。
 */
export function normalizeProse(text: string): string {
  return stripInvisibles(normalizeLineEndings(text))
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 结构化文本（表格）归一化：**只**统一换行、去不可见、去每行首尾空白。
 *
 * 不比 `normalizeProse` 折空白，是因为 `,` / `\t` 是数据分隔符 ——
 * 把它们折掉就不是归一化了，是把文件改坏。
 * @param text - 原始文本。
 * @returns 归一化文本（空行已丢弃）。
 */
export function normalizeTable(text: string): string {
  return stripInvisibles(normalizeLineEndings(text))
    .split('\n')
    .map(l => l.replace(/[\u00a0\u3000]/g, ' ').trim())
    .filter(l => l !== '')
    .join('\n')
}

// ────────────────────────────────────────────────────────────────────────────
// 表格
// ────────────────────────────────────────────────────────────────────────────

/**
 * 解析分隔符文本（RFC4180 式：双引号包裹的字段内允许分隔符与换行，`""` 表示一个引号）。
 *
 * 没有用 `split(delimiter)` —— 带引号的 CSV（字段里含逗号或换行）在真实文件里很常见，
 * 用 split 会把一条记录切成两条，之后所有行的列都对不上。
 * @param text - 已归一化换行的文本。
 * @param delimiter - 单字符分隔符。
 * @returns 行 × 单元格（每格已去首尾空白）。
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  const n = text.length

  const endField = (): void => { row.push(field.trim()); field = '' }
  const endRow = (): void => {
    endField()
    // 丢掉完全空白的行（尾随换行会产生一行 `['']`），但保留「有字段、字段都为空」的行
    // —— 后者在真实表格里表示一条记录的空值，丢掉它会让行号对不上。
    if (!(row.length === 1 && row[0] === '')) rows.push(row)
    row = []
  }

  while (i < n) {
    const ch = text[i] as string
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        quoted = false; i += 1; continue
      }
      // 字段内的换行：替换成空格（见文件头第 2 条），否则「一行一记录」不成立。
      field += ch === '\n' ? ' ' : ch
      i += 1
      continue
    }
    // `field.trim() === ''` 而不是 `field === ''`：`a, "b"`（逗号后带空格）是手写
    // CSV 里的常见写法，严格判等会把那个引号当成普通字符，字段值变成 `"b"`。
    if (ch === '"' && field.trim() === '') { quoted = true; field = ''; i += 1; continue }
    if (ch === delimiter) { endField(); i += 1; continue }
    if (ch === '\n') { endRow(); i += 1; continue }
    field += ch
    i += 1
  }
  if (field !== '' || row.length > 0) endRow()
  return rows
}

/**
 * 序列化一个单元格：含分隔符 / 引号 / 换行时用双引号包起来（`"` 自身翻倍）。
 *
 * 不这么做的话，`a,"x,y"` 会被重排成 `a,x,y` —— 那不是「少了个引号」，
 * 而是把两列合成一列，产出的文本不再是合法的分隔符文件。
 * @param value - 单元格文本。
 * @param delimiter - 单字符分隔符。
 * @returns 可安全拼回一行的字段。
 */
function serializeField(value: string, delimiter: string): string {
  if (value.includes(delimiter) || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

/**
 * 把分隔符文件变成一段表格文本（首行是表头）。
 *
 * 重新序列化而不是直接返回原文：字段内的换行被折成空格、每格去首尾空白之后，
 * 「一行 = 一条记录」这条不变量才成立，`splitTableRows` 才能按行组切。
 * 重新序列化是**可逆**的（`parseDelimited(tableText(t))` ≡ `parseDelimited(t)`），
 * 因为需要引号的字段会被重新加上引号。
 * 不补齐列数（不把短行填成与表头等长）：表里本来缺的列就该看得出来。
 * @param text - 已归一化换行的文本。
 * @param delimiter - 单字符分隔符。
 * @returns 表格文本；无内容时返回 `''`。
 */
export function tableText(text: string, delimiter: string): string {
  const rows = parseDelimited(text, delimiter)
  if (rows.length === 0) return ''
  return rows.map(r => r.map(v => serializeField(v, delimiter)).join(delimiter)).join('\n')
}

/**
 * 把「行 × 单元格」拼成表格文本，**单元格先净化、因此永远不需要引号**。
 *
 * 与 `tableText` 的分工（两者的差别不是风格，而是「数据从哪来」）：
 *   · `tableText` 重排**用户写的分隔符文件**。那种文件里字段内的分隔符是**有意义的**
 *     （`a,"x,y"` 里的逗号属于 `x,y` 这个值），所以必须靠引号转义才能保持可逆；
 *   · 本函数拼接**从结构化来源生成**的表格（docx 的 `<w:tbl>`、xlsx 的单元格）。
 *     这里没有「原文」要保真 —— 分隔符与换行只可能来自版式噪声，收成空格是**修正**
 *     而不是破坏；净化之后分隔符不可能出现在字段里，引号于是成了纯粹的多余字符
 *     （它还会让喂给模型的证据变难读）。所以这一支**故意不复用** `serializeField`。
 *
 * 与 `splitTableRows` 的契约：产出的首行必须是表头、其余每行一条记录
 * —— 所以单元格里的换行必须在这里就收掉，否则「一行一记录」不成立。
 * @param rows - 行 × 单元格（单元格可含换行 / 制表 / 多余空白）。
 * @param delimiter - 单字符分隔符（B 档一律用 `\t`）。
 * @returns 表格文本；无行时返回 `''`。
 */
export function structuredTableText(rows: readonly (readonly string[])[], delimiter = '\t'): string {
  if (rows.length === 0) return ''
  const clean = (v: string): string => String(v ?? '')
    .replace(/\r\n?/g, ' ')
    .replace(/[\t\n]/g, ' ')
  const esc = delimiter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return rows
    .map(r => r
      .map(v => clean(v).replace(new RegExp(esc, 'g'), ' ').replace(/ {2,}/g, ' ').trim())
      .join(delimiter))
    // 全空行丢弃：Excel 里大量尾部空行会在分块时变成一堆只有表头的块。
    .filter(line => line.replace(new RegExp(esc, 'g'), '').trim() !== '')
    .join('\n')
}

// ────────────────────────────────────────────────────────────────────────────
// HTML
// ────────────────────────────────────────────────────────────────────────────

/**
 * 码点转字符（越界或非法时返回空串，不抛）。
 * @param code - 码点。
 * @returns 单字符或空串。
 */
function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try { return String.fromCodePoint(code) } catch { return '' }
}

/**
 * 常见 HTML 实体 → 字符。
 *
 * 只处理「不处理会让人读错」的那几个：`&amp;` 之类留着会让检索词项对不上，
 * `&nbsp;` 留着会在正文里出现字面的 `nbsp`。`&amp;` **必须最后**解，
 * 否则 `&amp;lt;` 会被先解成 `<` 再被误当成标签起始。
 * @param s - 含实体的文本。
 * @returns 解码后的文本。
 */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
}

/** 这些标签的内容**不是正文**：整个子树跳过。`head` 顺带把 `<title>` 一起去掉。 */
const SKIP_TAGS = new Set(['script', 'style', 'head', 'noscript', 'template', 'svg'])

/** 这些标签的**闭合**意味着「一段结束」。 */
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav',
  'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'tr', 'td', 'th', 'table', 'thead', 'tbody',
  'pre', 'blockquote', 'figure', 'figcaption', 'form', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
])

/**
 * 空元素（没有闭合标签）：它们**自身**就是一次分段。
 *
 * 单列出来是因为 `<br>`（HTML 里合法、没有斜杠）若只靠「自闭合」判据就不会触发分段，
 * 于是一整篇用 `<br>` 分行的文本会被拼成一大段 —— 那正是最需要分段的一种输入。
 */
const VOID_TAGS = new Set(['br', 'hr', 'img', 'wbr', 'input', 'meta', 'link', 'source', 'col', 'area', 'base', 'embed', 'param', 'track'])

/** 标题标签名 → 级别；不是标题返回 0。 */
function headingLevelOf(name: string): number {
  const m = /^h([1-6])$/.exec(name)
  return m ? Number(m[1]) : 0
}

/** 标题栈（定长 6 槽，空槽即该级不存在）。 */
type HeadingStack = string[]

/** 新建空标题栈。 */
function newStack(): HeadingStack {
  return new Array<string>(HEADING_LEVELS).fill('')
}

/**
 * 改标题栈：设第 `level` 级、并清掉比它更深的所有级。
 *
 * 用**定长 6 槽**而不是 `slice(0, level-1)`：文档第一行就是 `<h2>` 时，
 * 切片式写法会把标题塞进 `stack[1]`，数组出现空洞，`join(' › ')` 于是产出
 * 一个以 ` › ` 开头的面包屑（`' › 二级标题'`）—— 看着像排版问题，其实是数据结构问题。
 * @param stack - 现有栈（原地改）。
 * @param level - 1..6。
 * @param title - 标题文本。
 * @returns 同一个数组（便于链式）。
 */
function setHeading(stack: HeadingStack, level: number, title: string): HeadingStack {
  for (let i = level - 1; i < HEADING_LEVELS; i += 1) stack[i] = i === level - 1 ? title : ''
  return stack
}

/** 标题栈 → 面包屑（跳过空槽）。 */
function headingText(stack: HeadingStack): string {
  return stack.filter(s => s !== '').join(' › ')
}

/**
 * 把 HTML 转成段。
 *
 * 单遍扫描标签、维护一个标题栈：标题标签把当前累积的文本**先冲出去**
 * （否则标题会挂到上一段上去），再改栈。`script` / `style` / `head` 的子树整体跳过
 * —— 把 CSS 或 JS 当正文索引，用户搜任何词都会命中一堆代码，是最糟的一种「有结果」。
 *
 * 与设计稿的差异（**超集**，写在这里免得被当成写错）：设计稿说「`h1..h3` 写入面包屑」，
 * 这里支持 `h1..h6`（Markdown 侧同样是 1~6 级），层级更深的文档同样能定位到节。
 * @param html - HTML 文本。
 * @returns 段数组。
 */
export function parseHtml(html: string): ParsedBlock[] {
  const src = stripInvisibles(normalizeLineEndings(html))
  const blocks: ParsedBlock[] = []
  let stack = newStack()
  let buf = ''
  let skipDepth = 0
  /** 正在收集的标题级别；0 表示不在标题里。 */
  let headingLevel = 0
  let headingBuf = ''

  /**
   * 冲掉累积的正文，挂上当前面包屑。
   *
   * 先 `decodeEntities` 再 `normalizeProse`：实体必须先解，否则 `&nbsp;` 解出来的
   * 空格不会再被折掉。正文与标题走同一条解码纪律，不留特例。
   */
  const flush = (): void => {
    const text = normalizeProse(decodeEntities(buf))
    buf = ''
    if (text !== '') blocks.push({ text, page: 0, heading: headingText(stack), kind: 'prose' })
  }

  /** 收尾一个标题：先冲正文，再改栈。 */
  const endHeading = (): void => {
    const level = headingLevel
    const title = normalizeProse(decodeEntities(headingBuf))
    headingBuf = ''
    headingLevel = 0
    flush()
    setHeading(stack, level, title)
  }

  const re = /<!--[\s\S]*?-->|<[^>]*>/g
  let cursor = 0
  let match: RegExpExecArray | null = re.exec(src)
  while (match !== null) {
    const rawText = src.slice(cursor, match.index)
    if (rawText !== '' && skipDepth === 0) {
      if (headingLevel > 0) headingBuf += rawText
      else buf += rawText
    }
    cursor = match.index + match[0].length

    const tag = match[0]
    if (!tag.startsWith('<!--')) {
      const close = tag.startsWith('</')
      const nameMatch = /^<\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(tag)
      const name = (nameMatch?.[1] ?? '').toLowerCase()
      if (name !== '') {
        if (close) {
          if (SKIP_TAGS.has(name)) { if (skipDepth > 0) skipDepth -= 1 }
          else if (headingLevel > 0 && headingLevelOf(name) > 0) endHeading()
          else if (BLOCK_TAGS.has(name) && headingLevel === 0) flush()
        } else if (SKIP_TAGS.has(name)) {
          skipDepth += 1
        } else {
          const level = headingLevelOf(name)
          if (level > 0) { flush(); headingLevel = level }
          else if (headingLevel === 0 && BLOCK_TAGS.has(name) && (/\/\s*>$/.test(tag) || VOID_TAGS.has(name))) flush()
        }
      }
    }
    match = re.exec(src)
  }
  if (cursor < src.length && skipDepth === 0) {
    const tail = src.slice(cursor)
    if (headingLevel > 0) headingBuf += tail
    else buf += tail
  }

  if (headingLevel > 0) endHeading()
  flush()
  return blocks
}

// ────────────────────────────────────────────────────────────────────────────
// Markdown / 纯文本
// ────────────────────────────────────────────────────────────────────────────

/**
 * Markdown → 段：`#{1,6}` 开头的行改标题栈，空行分段。
 *
 * 非 Markdown 的纯文本走同一条路径不会有副作用（`#` 开头的行在日志里本来就少见），
 * 所以不去分派两套实现。
 * @param text - markdown 文本。
 * @returns 段数组。
 */
export function parseMarkdown(text: string): ParsedBlock[] {
  const lines = stripInvisibles(normalizeLineEndings(text)).split('\n')
  const blocks: ParsedBlock[] = []
  const stack = newStack()
  let buf: string[] = []

  const flush = (): void => {
    const body = normalizeProse(buf.join('\n'))
    buf = []
    if (body !== '') blocks.push({ text: body, page: 0, heading: headingText(stack), kind: 'prose' })
  }

  for (const line of lines) {
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (h) {
      const level = (h[1] as string).length
      const title = normalizeProse(h[2] as string)
      flush()
      setHeading(stack, level, title)
      continue
    }
    if (line.trim() === '') { flush(); continue }
    buf.push(line)
  }
  flush()
  return blocks
}

/**
 * 纯文本 → 段：**空行分段**（不按行分段）。
 *
 * 为什么不按行：日志、字幕这类文本一行一句，按行分段会让每一段都短到不值得单独成块，
 * 之后 `splitProse` 会把它们合并，等于绕一圈回到这里。而空行是作者真的写下过的边界。
 * @param text - 文本。
 * @returns 段数组。
 */
export function parsePlainText(text: string): ParsedBlock[] {
  return stripInvisibles(normalizeLineEndings(text))
    .split(/\n{2,}/)
    .map(part => normalizeProse(part))
    .filter(part => part !== '')
    .map(part => ({ text: part, page: 0, heading: '', kind: 'prose' as const }))
}

// ────────────────────────────────────────────────────────────────────────────
// 分派
// ────────────────────────────────────────────────────────────────────────────

/** B 档的说明文案。**不许**说成「文件损坏」。 */
const PENDING_NOTE: Record<string, string> = {
  pdf: '本机还没有 PDF 解析器（需要 pdfjs，属后续步骤）',
  docx: '本机还没有 Word 解析器（需要 mammoth，属后续步骤）',
  xlsx: '本机还没有 Excel 解析器（需要 SheetJS，属后续步骤）',
  xls: '本机还没有 Excel 解析器（需要 SheetJS，属后续步骤）',
}

/** 给一个扩展名写一句「为什么解不了」的人话。 */
function unsupportedNote(ext: string): string {
  const known = PENDING_NOTE[ext]
  if (known !== undefined) return known
  if ((REGISTER_ONLY_EXTS as readonly string[]).includes(ext)) {
    return '已登记，未识别内容 —— 当前只能按文件名搜到它'
  }
  if ((PENDING_PARSER_EXTS as readonly string[]).includes(ext)) return `本机还没有 .${ext} 解析器`
  return ext === '' ? '没有扩展名，无法判断类型' : `不支持的类型 .${ext}`
}

/**
 * 按扩展名分派解析。B / C 档与白名单外的类型一律返回 `unsupported` + 原因。
 *
 * 空文件与「只有空白」的文件返回 `ready` + 空的段数组（调用方据此写
 * `chunk_count = 0`）：**读得出内容、只是内容为空**，与「读不出来」是两回事，
 * 后者是 `unsupported` / `failed`。用户看到的文案也因此不同。
 * @param ext - 小写扩展名。
 * @param bytes - 文件字节。
 * @returns 解析产物（`state` 为 `ready` 或 `unsupported`）。
 */
export function parseFileByExt(ext: string, bytes: Uint8Array): ParseOutcome {
  if (ext === '' || (!PLAIN_SET.has(ext) && !HTML_SET.has(ext))) {
    return { state: 'unsupported', parser: '', blocks: [], note: unsupportedNote(ext) }
  }

  const truncated = bytes.length > MAX_PARSE_BYTES
  const decoded = decodeText(bytes)
  const suffixes: string[] = []
  if (decoded.encoding !== 'utf-8') suffixes.push(`按 ${decoded.encoding} 解码`)
  if (truncated) suffixes.push('超出大小上限，只解析了前一部分')
  const note = suffixes.join('；')

  if (HTML_SET.has(ext)) {
    return { state: 'ready', parser: 'html', blocks: parseHtml(decoded.text), note }
  }

  const delimiter = DELIMITER_BY_EXT[ext]
  if (delimiter !== undefined) {
    // 必须走 normalizeTable：它统一换行（否则行尾的 `\r` 会粘在最后一个字段上）、
    // 去掉零宽字符、丢掉空行。改之前这条路径漏了归一化，`normalizeTable` 写了没人用。
    const body = tableText(normalizeTable(decoded.text), delimiter)
    const blocks: ParsedBlock[] = body === ''
      ? []
      : [{ text: body, page: 0, heading: '', kind: 'table' }]
    return { state: 'ready', parser: delimiter === '\t' ? 'tsv' : 'csv', blocks, note }
  }

  // 逐行一个 JSON：不整份 parse，否则一行坏掉整份文件都读不出来。
  if (JSON_LINES_SET.has(ext)) {
    return { state: 'ready', parser: 'plain', blocks: parsePlainText(decoded.text), note }
  }

  if (ext === 'json') {
    // 单行 JSON 会被 `splitProse` 硬切成无意义的碎片；能 parse 就重排成缩进形态，
    // 让它按层级换行、自带走三级切点。parse 不了就按原文本处理（**不能**因此判 failed）。
    try {
      const pretty = JSON.stringify(JSON.parse(decoded.text), null, 2)
      if (typeof pretty === 'string' && pretty !== '') {
        return { state: 'ready', parser: 'json', blocks: parsePlainText(pretty), note }
      }
    } catch { /* 非法 JSON：按纯文本处理 */ }
  }

  if (MARKDOWN_SET.has(ext)) {
    return { state: 'ready', parser: 'markdown', blocks: parseMarkdown(decoded.text), note }
  }

  return { state: 'ready', parser: 'plain', blocks: parsePlainText(decoded.text), note }
}
