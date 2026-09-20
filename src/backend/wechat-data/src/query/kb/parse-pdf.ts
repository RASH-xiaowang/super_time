/**
 * B 档解析器之一：PDF（依赖 `pdfjs-dist`，**惰性加载**）。
 *
 * ── 为什么是 pdfjs-dist（而不是自己解 PDF）────────────────────────────
 *   PDF 不是一种容器格式而是一台虚拟机：文本要经过 content stream 的操作符、
 *   字体编码、ToUnicode CMap 三道映射才能还原成人读的字。自己写只能处理最简单的
 *   那一小撮文件，而真实世界里的 PDF 恰好不在这撮里。这是本域唯一一个「非自己写不可」
 *   的格式 —— docx / xlsx 是 ZIP+XML，结构自明，本仓选择自写（见对应文件头注）。
 *
 * ── 五个真机确认过的硬事实（写错就是「构建通过、运行时崩」）────────────
 *   ① **入口必须是 `pdfjs-dist/legacy/build/pdf.mjs`**：非 legacy 构建会去
 *      `new Worker(...)`，在 Electron 主进程里直接抛
 *      `Cannot transfer object of unsupported type`（实测）。
 *      ⚠ v6 里**没有 `disableWorker` 这个参数了**（把 legacy 入口 grep 一遍，一次都不出现）——
 *      传了只是一个被忽略的键。「要不要真 worker」这件事现在完全由模块顶部的 `isNodeJS`
 *      决定（见 ⑤），所以别再指望靠参数关掉它。
 *   ② **`destroy()` 在 loadingTask 上，不在 `PDFDocumentProxy` 上**（v6 起）：
 *      对 doc 调 `destroy()` 会得到 `doc.destroy is not a function`，而那时**页文本
 *      已经抽完了** —— 于是它表现为「每份 PDF 都解析失败」，极难归因（实测）。
 *   ③ **`standardFontDataUrl` 不传只会 warning，不影响抽文本**：本用途只取文字、
 *      不渲染字形，标准字体根本用不到。但那条 warning 每次开文档都刷一行，
 *      所以用 `verbosity: 0`（只留 error）压掉 —— 不是把错误一起关掉。
 *   ④ **`cMapUrl` 必须传，否则中文 PDF 一个字都抽不出来**（阶段 D 收尾实测，见下）：
 *      汉字 PDF 常用 CID 字体（`/Encoding /UniGB-UCS2-H`、CIDSystemInfo 的 `/Ordering (GB1)`），
 *      而它**不带 ToUnicode** —— 此时「字节 → 汉字」的唯一依据就是 pdfjs 自带的
 *      `cmaps/*.bcmap`。不传 `cMapUrl` 时 pdfjs 映射不出任何字符，整页抽成空串，
 *      于是这份**有完整文字层**的 PDF 被判成 `unsupported`，界面上说「多半是扫描件或纯图片」
 *      ——**与事实相反**（用户会去重新导出文件，而重做没有用）。这也正是打包时专门保留
 *      `cmaps/` 的那条理由：留着却不接上，等于没留。
 *      两个实现细节：
 *        · 目录由 `require.resolve('pdfjs-dist/package.json')` 推出，**不按 `import.meta.url`
 *          硬数层级** —— 本文件会被打进 `lib/index.js`，产物布局与源码布局不同层数；
 *        · 打包态经 `unpackedAware()`（见 `asar-path.ts`）：`cmaps/` 已列入 `asarUnpack`，
 *          拿到的是 `app.asar.unpacked` 下的**真实文件**路径，不依赖 Electron 对 fs 的 asar 补丁。
 *
 *   ⑤ **必须在「加载 pdfjs 的那一瞬间」把 `process.type` 伪装成 `'browser'`**（阶段 D 真机
 *      验收实测，见 `loadPdfjs()` / `fakeBrowserProcessType()`）：pdfjs 用它自己的一条判定式
 *      算「我在不在 Node 里」——
 *        isNodeJS = typeof process === 'object' && process + '' === '[object process]'
 *                   && !process.versions.nw
 *                   && !(process.versions.electron && process.type && process.type !== 'browser')
 *      它的本意是「Electron 主进程算 Node、渲染进程算浏览器」，**唯独漏了 utilityProcess**
 *      （`process.type === 'utility'` ⇒ 那一项为真 ⇒ `isNodeJS = false`）。而后端恰好就跑在
 *      Electron 的 utilityProcess 里（`main.js` 的 `utilityProcess.fork`），于是：
 *        · **第一层**：`isNodeJS` 为假 ⇒ pdfjs 既不禁用真 worker，也不给
 *          `GlobalWorkerOptions.workerSrc` 兜底 ⇒ `PDFWorker` 的 `workerSrc` getter 直接抛
 *          `No "GlobalWorkerOptions.workerSrc" specified.` ⇒ **每一份 PDF 都落 `failed`**
 *          （docx / xlsx 不受影响，所以现场看起来像「PDF 功能没做」）；
 *        · **第二层**（把第一层糊过去之后才露头）：CMap 的取数工厂也挂在同一个 `isNodeJS` 上
 *          —— 挑中的是 DOM 那一套（`fetch(url)`），而 `cMapUrl` 是本机路径，Node 的 fetch
 *          读不了 ⇒ 只有一行 warning（`Unable to load CMap data at: …bcmap`，**不抛**）；
 *          可 CID 字体少了它一个字都映射不出来 ⇒ 整份 PDF 抽成空串 ⇒ 被判成扫描件
 *          （`unsupported` +「多半是扫描件或纯图片」）——**与事实相反**，用户会拿着
 *          完好的文件反复重新导出。所以两层必须一起修，只修第一层等于换了个假故障。
 *      **vitest 永远咬不到这一条**：那里就是纯 Node，`isNodeJS` 为真，两层都不存在 ——
 *      「单测全绿」与「真机全废」可以同时成立。回归守卫在
 *      `tests/kb-parse-pdf-env.spec.ts`（单独一个文件，理由见那个文件的头注）。
 *
 * ── 页与段的关系 ────────────────────────────────────────────────────
 *   每个 `ParsedBlock` 带**非 0** 的 `page`（设计稿要求页码能被检索结果展示）。
 *   页内分段直接复用 `parsePlainText`（按空行分段），于是「解析」这件事在 PDF 与 TXT
 *   之间只差一个「页」维度，分块器完全不必知道 PDF 的存在。
 *
 * ── 扫描件怎么办 ────────────────────────────────────────────────────
 *   抽不出任何文字时返回 **`unsupported`**，而不是 `ready` + 0 块。
 *   为什么：`ready` 在界面上是「已就绪，可以被问答与关键词检索到」，而一份一个字都
 *   没有的文件用 `ready` 是**假成功** —— 用户会以为它进了检索，实际搜什么都不会命中。
 *   文案上也不许说「文件损坏」：它是图片型 PDF，没坏，只是本期不做 OCR
 *   （与本仓 C 档图片同一取舍：识别率不足以把结果当证据）。
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { unpackedAware } from '../../asar-path.ts'
import { yieldToLoop } from '../search.ts'
import { parsePlainText } from './parse-plain.ts'
import { CHUNK_MAX_CHARS, MAX_CHUNKS_PER_FILE } from './chunk.ts'
import type { ParseOutcome, ParsedBlock } from './types.ts'

/**
 * 抽出的正文上限（字符）。
 *
 * 不写成一个凭空的整数，而是由既有常量导出：超过 `MAX_CHUNKS_PER_FILE` 个「满块」
 * 的正文**无论如何都会被分块器截断**，多抽只会白占内存与时间。取这个上界，
 * 让「截断」这件事只在分块器里发生一次、只有一个口径（`chunkResult.truncated`）。
 */
const MAX_PDF_TEXT_CHARS = MAX_CHUNKS_PER_FILE * CHUNK_MAX_CHARS

/** pdfjs 的加载入口（见文件头 ①）。 */
const PDFJS_ENTRY = 'pdfjs-dist/legacy/build/pdf.mjs'

/**
 * pdfjs 的 worker 模块。主线程（fake worker）模式下 pdfjs 会自己去 import 它
 * （`_setupFakeWorkerGlobal` → `import(this.workerSrc)`），所以它与入口是**同生共死**的一对，
 * 打包白名单必须两个都留（`tests/kb-package-deps.spec.ts` 咬着这一点）。
 * 本文件在伪装窗口里**顺手先加载它**（见 `loadPdfjs()`）：一来那段窗口覆盖得完整，
 * 二来 pdfjs 内部那次 import 直接在模块缓存里命中，不再多读一次盘。
 */
const PDFJS_WORKER_ENTRY = 'pdfjs-dist/legacy/build/pdf.worker.mjs'

/**
 * pdfjs 的 CID 字符表目录（**必须传给 `getDocument`，见文件头 ④**）。
 *
 * 为什么要缓存：`require.resolve` 每次都要走一遍模块解析，而 `parsePdf` 是每份文件调一次
 * —— 缓存一次即可，且它在本进程内恒定。
 * 结尾必须是**正斜杠 `/`，不能用 `path.sep`**：pdfjs 的 `getFactoryUrlProp` 对传进来的
 * 串做的是字面量 `endsWith('/')` 检查 —— Windows 上给反斜杠一样抛
 * `Invalid factory url: … must include trailing slash.`（实测）。
 * 拼出来的路径最终交给 `fs.readFile`，而 Node 在 Windows 上把正斜杠按分隔符一并接受，
 * 所以这里混用分隔符没有副作用。
 * @returns `cmaps` 目录的绝对路径（打包态为 `app.asar.unpacked` 下的真实目录）。
 */
let cMapDirCache: string | null = null
function cmapDir(): string {
  if (cMapDirCache === null) {
    const require = createRequire(import.meta.url)
    const pkgJson = require.resolve('pdfjs-dist/package.json')
    cMapDirCache = unpackedAware(join(dirname(pkgJson), 'cmaps')) + '/'
  }
  return cMapDirCache
}

/** `getDocument` 的参数类型（只声明本文件用到的那几个键，避免依赖 pdfjs 的完整类型面）。 */
interface PdfGetDocumentParams {
  data: Uint8Array
  isEvalSupported: boolean
  verbosity: number
  /** CID 字符表目录（见文件头 ④）。`cMapPacked` 指目录里是 `.bcmap` 而非散装 `.txt`。 */
  cMapUrl: string
  cMapPacked: boolean
}

/** pdfjs 入口里本文件用到的那一小块（同样避开它完整的类型面）。 */
interface PdfLib {
  getDocument: (p: PdfGetDocumentParams) => {
    promise: Promise<{
      numPages: number
      getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: PdfTextItem[] }> }>
    }>
    destroy: () => Promise<void>
  }
}

/** pdfjs 文本片段的最小形状。 */
interface PdfTextItem {
  str?: unknown
  hasEOL?: unknown
}

/**
 * 把一页的文本片段拼成一段文字。
 *
 * pdfjs 给的是**排版片段**而不是行：同一行常被拆成若干片段（换字体、换字距都会拆），
 * 靠 `hasEOL` 才知道哪里是一行的结尾。漏掉它就会把整页挤成一行，
 * 于是「句末」切点全部失效、分块只能在窗口末尾硬切。
 * @param items - `getTextContent().items`。
 * @returns 该页文本（换行已还原）。
 */
function itemsToText(items: readonly PdfTextItem[]): string {
  const parts: string[] = []
  for (const it of items) {
    if (typeof it?.str !== 'string') continue
    parts.push(it.hasEOL === true ? it.str + '\n' : it.str)
  }
  return parts.join('')
}

/**
 * 临时把 `process.type` 写成 `'browser'`（= 让 pdfjs 的判定式算出 `isNodeJS === true`，见文件头 ⑤）。
 *
 * 为什么要用 `defineProperty` 而不是直接赋值：Electron 的 `process.type` 未必是可写属性，
 * 只读 getter 上赋值在 ESM（严格模式）里会直接抛。
 * @returns `applied === false` 表示这个字段改不动 —— 此时**绝不能默默往下跑**：
 *   pdfjs 会退回浏览器那套，PDF 要么每份 `failed`、要么每份静默抽成空串（见 ⑤）。
 */
function fakeBrowserProcessType(): { applied: boolean; restore: () => void } {
  const proc = process as NodeJS.Process & { type?: string }
  const desc = Object.getOwnPropertyDescriptor(proc, 'type')
  let applied = false
  try {
    Object.defineProperty(proc, 'type', { value: 'browser', configurable: true, writable: true, enumerable: true })
    applied = proc.type === 'browser'
  } catch {
    try { proc.type = 'browser'; applied = proc.type === 'browser' } catch { applied = false }
  }
  if (!applied) return { applied: false, restore: () => { /* 没改成功，无需还原 */ } }
  return {
    applied: true,
    restore: () => {
      try {
        if (desc) Object.defineProperty(proc, 'type', desc)
        else delete proc.type
      } catch {
        // 还原不了不该让解析失败：这个字段本进程内没人读（见文件头 ⑤）
      }
    },
  }
}

/**
 * 惰性加载 pdfjs —— **并把加载这一刻包进伪装窗口里**（见文件头 ⑤）。
 *
 * 为什么必须是「加载的那一刻」：`isNodeJS` 在模块**求值**时算一次，之后再也不变；
 * 而它决定了「要不要真 worker」与「CMap 走 fs 还是走 fetch」两件事 —— 错一个 PDF 就废。
 * 伪装只在**首次**加载时发生，模块进缓存后后续调用直接命中（这份 Promise 就是缓存）。
 * 失败要清掉缓存，否则一次加载失败会把后续每一份 PDF 都钉死在同一个异常上。
 */
let pdfjsLib: Promise<PdfLib> | null = null
function loadPdfjs(): Promise<PdfLib> {
  if (pdfjsLib === null) {
    pdfjsLib = (async () => {
      const fake = fakeBrowserProcessType()
      if (!fake.applied) {
        throw new Error(
          'PDF 解析器在本机初始化不了：运行环境标记（process.type）改不动，pdfjs 会把本进程当成浏览器',
        )
      }
      try {
        const mod = await import(/* @vite-ignore */ PDFJS_ENTRY) as Record<string, unknown>
        // 顺手把 worker 模块也在这段窗口里加载好（见 PDFJS_WORKER_ENTRY 的注释）。
        await import(/* @vite-ignore */ PDFJS_WORKER_ENTRY)
        return (mod['default'] ?? mod) as unknown as PdfLib
      } finally {
        fake.restore()
      }
    })().catch((e: unknown) => {
      pdfjsLib = null
      throw e
    })
  }
  return pdfjsLib
}

/**
 * 解析一份 PDF。
 *
 * 失败语义（与 `ParseOutcome` 的两档刻意不同）：
 *   · 抽不出文字 ⇒ **返回** `unsupported` + 人话原因（扫描件 / 空文件）；
 *   · 读不动（有密码、不是 PDF、结构损坏）⇒ **抛出**，由执行器写进 `kb_files.parse_state`
 *     的 `failed` 档。「本机没做」与「这份文件真的读不了」在界面上必须是两句话
 *     （见 `types.ts` 对 `unsupported` / `failed` 的分档说明）。
 * @param bytes - 文件字节。
 * @returns 解析产物。
 */
export async function parsePdf(bytes: Uint8Array): Promise<ParseOutcome> {
  // 加载 + 伪装窗口都在这里面（见文件头 ⑤）：pdfjs 的 `isNodeJS` 一旦算错，
  // 下面这几行参数写得再对也没用。
  const lib = await loadPdfjs()

  const task = lib.getDocument({
    data: bytes,
    // 见文件头 ③：只留 error，压掉 standardFontDataUrl 那行每次开文档都刷的 warning。
    isEvalSupported: false,
    verbosity: 0,
    // 见文件头 ④：少了这两行，中文 PDF（CID 字体且无 ToUnicode）会一个字都抽不出来。
    cMapUrl: cmapDir(),
    cMapPacked: true,
  })

  let doc: Awaited<typeof task.promise>
  try {
    doc = await task.promise
  } catch (e) {
    // 让 `failed` 的那句话能下手：把 pdfjs 的异常名翻成人话，其余原样透出。
    const name = (e as { name?: unknown } | null)?.name
    if (name === 'PasswordException') throw new Error('这份 PDF 有密码，本机打不开它')
    if (name === 'InvalidPDFException') throw new Error('这个文件不是有效的 PDF（可能已损坏，或只是改成了 .pdf 扩展名）')
    throw e
  }

  try {
    const blocks: ParsedBlock[] = []
    let charCount = 0
    let truncated = false

    for (let page = 1; page <= doc.numPages; page += 1) {
      if (charCount >= MAX_PDF_TEXT_CHARS) { truncated = true; break }
      const p = await doc.getPage(page)
      const content = await p.getTextContent()
      const text = itemsToText(content.items)
      // 页内分段复用纯文本那条路径：PDF 的「一段」与 TXT 的「一段」是同一件事。
      for (const b of parsePlainText(text)) {
        blocks.push({ text: b.text, page, heading: b.heading, kind: b.kind })
        charCount += b.text.length
      }
      // 每页让出事件循环：一份几百页的 PDF 若不让出，整个 `@Remote` 层会一起卡住
      //（计划 R3 点名的就是这件事，G-05 的存在理由）。
      await yieldToLoop()
    }

    if (blocks.length === 0) {
      return {
        state: 'unsupported',
        parser: '',
        blocks: [],
        note: '这份 PDF 里没有可提取的文字（多半是扫描件或纯图片），本期不做 OCR',
      }
    }

    const suffixes: string[] = []
    if (truncated) suffixes.push('正文超出上限，只解析了前 ' + MAX_PDF_TEXT_CHARS + ' 个字符')
    return { state: 'ready', parser: 'pdfjs', blocks, note: suffixes.join('；') }
  } finally {
    // 见文件头 ②：销毁在 task 上。失败也不能吞（否则 worker 句柄泄漏）。
    await task.destroy()
  }
}
