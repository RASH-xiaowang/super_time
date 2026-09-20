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
import type { ParseOutcome } from './types.ts';
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
export declare function parsePdf(bytes: Uint8Array): Promise<ParseOutcome>;
