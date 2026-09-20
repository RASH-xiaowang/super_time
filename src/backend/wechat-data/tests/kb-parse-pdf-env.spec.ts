/**
 * 真机故障回归：pdfjs 把 Electron 的 **utilityProcess** 误判成「浏览器」，于是每一份 PDF 都废。
 *
 * ── 现场（阶段 D 真机验收实测）─────────────────────────────────────────────
 * 后端跑在 Electron 的 utilityProcess 里（`main.js` → `utilityProcess.fork`），
 * 此时 `process.type === 'utility'`；而 pdfjs 用它自己的一条判定式算「我在不在 Node 里」：
 *
 *     isNodeJS = typeof process === 'object' && process + '' === '[object process]'
 *                && !process.versions.nw
 *                && !(process.versions.electron && process.type && process.type !== 'browser')
 *
 * 那条排除项的**本意**是「Electron 主进程算 Node、渲染进程算浏览器」，却漏了 utilityProcess
 * ⇒ `isNodeJS === false`，接着两件事一起坏：
 *   ① pdfjs 不禁用真 worker、也不给 `GlobalWorkerOptions.workerSrc` 兜底
 *      ⇒ `PDFWorker.workerSrc` 的 getter 抛 `No "GlobalWorkerOptions.workerSrc" specified.`
 *      ⇒ 每份 PDF 都落 `failed`；
 *   ② CMap 的取数工厂也挂在同一个 `isNodeJS` 上 ⇒ 走 DOM 那套 `fetch(本机路径)`
 *      ⇒ `Unable to load CMap data at: …bcmap`（**只是 warning，不抛**）
 *      ⇒ CID 字体一个字都映射不出来 ⇒ 整份抽成空串 ⇒ 被当成扫描件。
 *
 * ── 为什么必须是**单独一个文件**，而且这里要点名 ⚠ ──────────────────────────
 * `isNodeJS` 在 pdfjs 模块**求值那一刻**算一次，之后再也不变。只要本进程里已经有别的用例
 * 先解析过 PDF（`kb-parse-b.spec.ts` 就会），pdfjs 模块已经以「纯 Node」的姿态进了模块表，
 * 再改 `process.type` 也影响不到它 —— 断言照样绿，而它守的那件事已经没人守了。
 * vitest 默认**按文件**隔离模块表，所以这条守卫独占一个文件：本文件里除了这一条，
 * 不许再加别的解析用例。
 *
 * ── 这条守卫咬什么 ────────────────────────────────────────────────────────
 * 它在**测试进程里伪装出真机环境**（`process.type = 'utility'` + `process.versions.electron`），
 * 然后要求 `parsePdf` 仍然把中文 CID PDF 解析出汉字来。把 `parse-pdf.ts` 里那段伪装窗口
 * 拿掉，本文件立刻转红（真机上是「每份 PDF 都解析失败」，见 `working/cdp-kb-files-b.json`）。
 * @vitest-environment node
 */
import { afterAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parsePdf } from '../src/query/kb/parse-pdf.ts'

/** 无 `/ToUnicode` 的 CID 中文 PDF（汉字只能靠 pdfjs 自带的 `cmaps/*.bcmap` 映射出来）。 */
const CID_PDF = fileURLToPath(new URL('./fixtures/kb-b/中文地层报告.pdf', import.meta.url))

/**
 * 伪装成 Electron utilityProcess —— **必须在任何 pdfjs 模块被求值之前**装好。
 * 这是安全的：`parse-pdf.ts` 是**惰性**加载 pdfjs 的（`loadPdfjs()` 里才 `import`），
 * 上面那条静态 import 只引入了我们自己的模块图，进不了 pdfjs。
 */
const hadType = Object.prototype.hasOwnProperty.call(process, 'type')
const hadElectron = Object.prototype.hasOwnProperty.call(process.versions, 'electron')
process.type = 'utility'
;(process.versions as Record<string, string>).electron = '39.0.0'

afterAll(() => {
  // 别把测试进程搞脏：本文件是独一份的，但「用完还原」这件事仍然要成立。
  if (!hadType) delete (process as NodeJS.Process & { type?: string }).type
  if (!hadElectron) delete (process.versions as Record<string, string>).electron
})

describe('pdfjs 在 Electron utilityProcess 下也必须能解析（真机故障回归）', () => {
  it('★ 伪装出的 utilityProcess 环境成立（否则这条守卫什么也没守）', () => {
    expect(process.type, '本文件的前提就是 process.type === "utility"').toBe('utility')
    expect((process.versions as Record<string, string>).electron).toBe('39.0.0')
  })

  it('★ 中文 CID PDF 仍解出汉字 —— 伪装窗口没生效的话，这里会抛 workerSrc 或抽出空串', async () => {
    const out = await parsePdf(new Uint8Array(readFileSync(CID_PDF)))
    expect(out.state, '真机故障的第一层：pdfjs 抛 No "GlobalWorkerOptions.workerSrc" specified.').toBe('ready')
    expect(out.parser).toBe('pdfjs')
    const all = out.blocks.map((b) => b.text).join('\n')
    // 第二层的症状：CMap 读不到 ⇒ 一个字都没有 ⇒ 界面上被说成「扫描件」。
    expect(all, '第二层故障：CMap 没接上，整份 PDF 抽成空串').toContain('玄武岩层理')
    expect(all, '同页的 ASCII 也一起没了 ⇒ 不是「只有汉字坏」而是整页空').toContain('CidFixtureMarker')
    expect(out.blocks.map((b) => b.page), '页码不能全是 0').toEqual([1, 2])
  })

  it('★ 伪装窗口用完就还原（不许把进程的全局状态改脏）', async () => {
    // `parsePdf` 内部只在「加载 pdfjs」那一段把 process.type 写成 'browser'，import 完立刻还原。
    expect(process.type, '窗口泄漏了：解析结束后 process.type 还是 browser').toBe('utility')
  })
})
