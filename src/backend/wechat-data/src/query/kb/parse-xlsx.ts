/**
 * B 档解析器之三：Excel（`.xlsx` / `.xls`，依赖 `xlsx`(SheetJS)，**惰性加载**）。
 *
 * ── 一个 sheet 一段，而不是「一张表一段」──────────────────────────────
 *   多 sheet 必须**都进**（设计稿要求），且每个 sheet 自成一个 `ParsedBlock`：
 *   分块器随后按行组切、**每块重复表头**（`splitTableRows`），于是表名进 `heading`
 *   就成了「这是哪张表」的定位 —— 比页码对本用途有用得多。
 *
 * ── 为什么用 `header: 1` + `raw: false` ──────────────────────────────
 *   · `header: 1` 返回**二维数组**；默认（不带它）会把首行当列名吃掉，
 *     而我们要的恰恰是「首行就是表头」，不能被 SheetJS 私有化；
 *   · `raw: false` 取**显示文本**（`w`）而不是原始值：日期单元格原始值是序列号
 *     （`44197`），数字列可能带格式（`15,000` / `15%`）。喂给检索与模型的应当是
 *     用户在 Excel 里**看到的那串字** —— 序列号既搜不到也读不懂。
 *
 * ── 真实样本上确认过的一条边界 ────────────────────────────────────────
 *   样本 `员工名单.xlsx` **没有 `xl/sharedStrings.xml`**，字符串全部是
 *   `t="inlineStr"` 的**内联**写法。这不是异常（两种写法都合法），但它说明
 *   「自己解 xlsx」要比想象的多考虑一层；这也正是本档选择 SheetJS 的理由
 *   （本仓的 A/A' 档自己写，是因为那些格式的歧义面小得多）。
 *
 * ── 空表怎么办 ──────────────────────────────────────────────────────
 *   全空的 sheet **不产生段**（否则会出现只有表头的空块）。若整本工作簿一行数据
 *   都没有，则返回 `unsupported`（与 PDF / docx 同一口径：没有可提取的内容
 *   不该被显示成「已就绪」）。
 */

import { assertExcelContainer } from './container-guard.ts'
import { structuredTableText } from './parse-plain.ts'
import type { ParseOutcome, ParsedBlock } from './types.ts'

/** SheetJS 读出的工作簿（只声明本文件用到的那两个键）。 */
interface XlsxWorkbook {
  SheetNames?: unknown
  Sheets?: Record<string, unknown>
}

/** SheetJS 的最小形状（只声明用到的那几个入口）。 */
interface XlsxLike {
  read: (data: Uint8Array, opts: { type: string }) => XlsxWorkbook
  utils: {
    sheet_to_json: (ws: unknown, opts: Record<string, unknown>) => unknown
  }
}

/** 单元格值 → 文本。 */
function cellToText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v)
}

/**
 * 二维数组 → 规整的行 × 单元格。
 *
 * 两件清理：
 *   · 用 `Array.from` 而不是 `map` —— 稀疏行（前导空单元格）在 `map` 下会**跳过空洞**，
 *     于是整行左移、列与表头错位（`raw:false` 时不该发生，但错位的后果极难查，
 *     这里不省这一行）；
 *   · 丢掉尾部全空的行与列：Excel 的已用区域常比真实数据大，多出来的空行会在
 *     分块时变成一堆只有表头的块。
 * @param aoa - `sheet_to_json(header:1)` 的结果。
 * @returns 规整后的行 × 单元格。
 */
function tidy(aoa: unknown): string[][] {
  if (!Array.isArray(aoa)) return []
  const rows: string[][] = []
  for (const r of aoa) {
    if (!Array.isArray(r)) continue
    rows.push(Array.from(r, (v) => cellToText(v)))
  }
  // 尾部空行
  while (rows.length > 0 && (rows[rows.length - 1] as string[]).every(c => c.trim() === '')) rows.pop()
  // 空行（中间的空行会让表头与数据之间出现断层，一并丢掉）
  const kept = rows.filter(r => r.some(c => c.trim() !== ''))
  return kept
}

/**
 * 把 SheetJS 抛出的英文错误翻成人话。
 *
 * 为什么不能直接透出：`failed` 那一档的文案会写进 `kb_files.parse_error` 并显示给用户，
 * 而 `Bad compressed size: 0 != 265` 对用户没有任何指导意义（它既没说是什么问题、
 * 也没说该做什么）。三条映射各对应一个**用户动作**：重新拷贝 / 换文件 / 解密。
 *
 * 认不出来的错误**原样透出** —— 与 `parse-pdf.ts` 同一条纪律：不要用兜底文案把
 * 未知问题盖成已知问题，那会让排查方向整个跑偏。
 * @param e - 捕获到的异常。
 * @returns 可以直接展示的错误。
 */
function describeWorkbookReadError(e: unknown): Error {
  const msg = typeof (e as { message?: unknown } | null)?.message === 'string'
    ? ((e as { message: string }).message)
    : ''
  if (/could not find workbook|not a workbook|workbook file/i.test(msg)) {
    return new Error('这个文件里没有工作簿数据（容器合法，但里面没有 Excel 的内容）')
  }
  if (/bad compressed size|corrupted zip|central directory|unexpected end/i.test(msg)) {
    return new Error('这个 Excel 文件的内容不完整（常见于拷贝或下载只完成了一部分）')
  }
  if (/password|encrypt/i.test(msg)) {
    return new Error('这份 Excel 加了密码或做过加密，本机打不开它')
  }
  return e instanceof Error ? e : new Error(msg === '' ? '读这个 Excel 文件时出错' : msg)
}

/**
 * 解析一份工作簿。
 *
 * 与 `parse-pdf.ts` 同一套失败语义：没有可提取内容 ⇒ `unsupported`；
 * 读不动（不是 ZIP、不是工作簿、加密）⇒ 抛出，由执行器记 `failed`。
 * 其中「不是工作簿 / 拷了一半」由 `container-guard.ts` 的**容器预检**负责，
 * 不指望 SheetJS —— 它对畸形输入不抛异常、甚至永久挂起（实测，见该文件头注）。
 * @param bytes - 文件字节。
 * @returns 解析产物。
 */
export async function parseXlsx(bytes: Uint8Array): Promise<ParseOutcome> {
  // 先看容器、再看依赖：预检不依赖任何第三方库，而它挡下的文件**即使库装齐了也读不了**。
  // 放在动态 import 之前还省掉一次「为一份垃圾文件去加载 9MB 的 xlsx」。
  assertExcelContainer(bytes)

  const mod = await import(/* @vite-ignore */ 'xlsx') as Record<string, unknown>
  const XLSX = ((mod['default'] ?? mod) as XlsxLike)
  if (typeof XLSX?.read !== 'function' || typeof XLSX?.utils?.sheet_to_json !== 'function') {
    throw new Error('xlsx 没有提供 read / sheet_to_json（依赖装错或不完整）')
  }

  // `type: 'array'`：直接喂字节，不落盘、不猜编码。
  // 预检之后仍然可能抛（容器与工作簿部件都在，但内部 XML 坏了），所以这里还要兜一层。
  let wb: XlsxWorkbook
  try {
    wb = XLSX.read(bytes, { type: 'array' })
  } catch (e) {
    throw describeWorkbookReadError(e)
  }
  const names = Array.isArray(wb?.SheetNames) ? (wb.SheetNames as string[]) : []

  const blocks: ParsedBlock[] = []
  let emptySheets = 0

  for (let i = 0; i < names.length; i += 1) {
    const name = names[i] ?? ''
    const ws = wb?.Sheets?.[name]
    if (ws === undefined || ws === null) { emptySheets += 1; continue }
    const rows = tidy(XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false }))
    if (rows.length === 0) { emptySheets += 1; continue }
    const text = structuredTableText(rows, '\t')
    if (text === '') { emptySheets += 1; continue }
    // 表名进 heading：分块器再追加「列名 …」，于是块自带「哪张表 + 哪几列」。
    blocks.push({ text, page: 0, heading: name !== '' ? name : `工作表 ${i + 1}`, kind: 'table' })
  }

  if (blocks.length === 0) {
    return {
      state: 'unsupported',
      parser: '',
      blocks: [],
      note: names.length === 0
        ? '这个 Excel 文件里没有工作表'
        : '这份 Excel 的工作表都是空的（没有任何单元格有内容）',
    }
  }

  const suffixes: string[] = []
  if (emptySheets > 0) suffixes.push('有 ' + emptySheets + ' 个工作表是空的，已跳过')
  return { state: 'ready', parser: 'xlsx', blocks, note: suffixes.join('；') }
}
