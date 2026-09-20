/**
 * B 档三个解析依赖的**打包白名单**守卫 —— 阶段 D · D6（对齐 C4 / R1）。
 *
 * 为什么值得一条用例：`package.json` 的 `build.files` 是**白名单**，而开发机跑用例
 * 走的是 `node_modules` 实时解析 —— 三个库在不在白名单里，`vitest` 与 `typecheck`
 * **都看不出区别**。漏了的唯一表现是「装完的软件里 PDF / Word / Excel 解析报
 * 找不到模块」（`parse-async.ts` 会把它收敛成 `unsupported` + 「本机缺少…解析组件」），
 * 而开发机上永远复现不了。这条用例把「开发机能跑」与「打包后能跑」之间的那道缝钉死。
 *
 * 与 `packaging-content.spec.ts` 的分工：那一支管 `src/` 的允许清单与 asar 体积；
 * 本支管 `node_modules` 白名单 —— 而且两支都遵守同一条纪律：
 * **产物层的断言只在真有产物时跑**（没有 `dist/` 时跳过，真正的把关在 `npm run package:smoke`）。
 *
 * 本支刻意**不**把传递依赖逐个钉进 `files`：实测 electron-builder 会自动带上已列出的
 * 生产依赖的整棵传递树（`unzipper` 的 `bluebird`/`duplexer2`/`graceful-fs` 都没列却在包内，
 * 见 `working/d-asar-probe.txt`）。所以这里钉的是**直接依赖**显式列出 + 传递依赖在产物里
 * 真的存在；把 37 个包逐个写进白名单只会制造一份迟早会漂的清单。
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const requireCjs = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  build?: { files?: string[] }
}
const files: string[] = pkg.build?.files ?? []

/** 三个 B 档解析器各自的 npm 包（与 `parse-async.ts` 的 `ASYNC_PARSERS` 一一对应）。 */
const B_DEPS = ['pdfjs-dist', 'mammoth', 'xlsx'] as const

/**
 * 把 electron-builder 的 glob 翻成正则。
 *
 * 与 `packaging-content.spec.ts` 的同名助手**刻意不完全相同**：那个版本先把双星号
 * 换成通配组、再单独把剩下的单星号换成 `[^/]*`，而夹在两个星号之间的那个斜杠被保留，
 * 于是译出来的正则**要求至少一层目录**：`node_modules/x/` 这一层之下的顶层文件
 * （`package.json` 这种）匹配不上。electron-builder 用的 globstar 语义里，
 * 双星号后跟斜杠是「**零个**或多个目录层级」。那个版本在它自己的用例里够用
 * （被检的路径都有两层），在这里会直接把「顶层目录在、只有一层文件」误判成没覆盖。
 * 所以这里按真正的 globstar 语义译：双星号后跟斜杠 → 可有可无的目录前缀；裸双星号 → 任意。
 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const body = escaped
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*')
  return new RegExp('^' + body + '$')
}

/** 某个相对路径是否会被白名单**收进来**（`!` 开头的排除规则不参与）。 */
function coveredBy(patterns: readonly string[], relPath: string): boolean {
  if (patterns.length === 0) return true
  return patterns.filter((p) => !p.startsWith('!')).some((p) => globToRegExp(p).test(relPath))
}

/** 某个相对路径是否会被某条排除规则**踢出去**。 */
function excludedBy(patterns: readonly string[], relPath: string): boolean {
  return patterns.filter((p) => p.startsWith('!')).some((p) => globToRegExp(p.slice(1)).test(relPath))
}

const ASAR = join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar')

/** 打包产物里的条目清单；没有产物时返回 null（调用方据此跳过）。 */
function asarEntries(): string[] | null {
  if (!existsSync(ASAR)) return null
  const { listPackage } = requireCjs('@electron/asar') as { listPackage: (p: string) => string[] }
  return listPackage(ASAR).map((p) => p.replace(/\\/g, '/'))
}

describe('B 档三个解析依赖必须在打包白名单里（D6 / R1：漏了就是打包后崩溃）', () => {
  it('三个库都是**生产**依赖（devDependencies 永远不会进包）', () => {
    for (const dep of B_DEPS) {
      expect(typeof pkg.dependencies?.[dep], `${dep} 必须是生产依赖`).toBe('string')
      expect(pkg.devDependencies?.[dep], `${dep} 不能只写在 devDependencies 里`).toBeUndefined()
    }
  })

  it('files 里**显式**列出了三个库，不依赖隐式包含', () => {
    for (const dep of B_DEPS) {
      // 显式列出而不是靠默认行为：与 `update.spec.ts` 对 electron-updater 的口径一致。
      expect(files, `白名单里没有 node_modules/${dep}/**/*`).toContain(`node_modules/${dep}/**/*`)
      expect(coveredBy(files, `node_modules/${dep}/package.json`), `${dep} 没被白名单覆盖`).toBe(true)
    }
  })

  it('★ @napi-rs 被排除，且没有任何正向规则会把它捞回来', () => {
    // pdfjs 的 optionalDependency。本用途只 `getTextContent()`、从不 `render()` ——
    // 实测把它移走后 23/23 解析用例仍全绿（`working/d-napi-report.txt`），
    // 而它带进来的是 36.5MB 的 win32 原生 canvas。
    const canvasEntry = 'node_modules/@napi-rs/canvas-win32-x64-msvc/index.js'
    expect(coveredBy(files, canvasEntry), '有正向规则覆盖了 @napi-rs —— 排除形同虚设').toBe(false)
    expect(excludedBy(files, canvasEntry), '白名单里没有 !node_modules/@napi-rs/**（36.5MB 会进包）').toBe(true)
  })

  it('pdfjs 的入口与它的 worker 都在白名单内（裁剪不许裁到运行期真正要 load 的那两个）', () => {
    // 入口名从**源码**里取，而不是在这里再写一遍常量：写死的话，哪天源码换成
    // 非 legacy 的入口，这条用例仍会对着旧路径报绿 —— 那正是它要防的事。
    const src = readFileSync(join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'query', 'kb', 'parse-pdf.ts'), 'utf8')
    const m = /const PDFJS_ENTRY = '([^']+)'/.exec(src)
    expect(m, 'parse-pdf.ts 里找不到 PDFJS_ENTRY —— 用例的锚点漂了，请同步').not.toBeNull()
    const entry = `node_modules/${m![1]}`
    expect(coveredBy(files, entry), `pdfjs 入口 ${entry} 没被白名单覆盖`).toBe(true)
    expect(excludedBy(files, entry), `pdfjs 入口 ${entry} 被自己的排除规则踢掉了`).toBe(false)
    // worker 同样从源码取 —— 解析器**显式 import 了它**（`loadPdfjs()` 里那一行），
    // 所以这里要验的是「真正被 import 的那个路径」，而不是「按命名规矩推出来的路径」：
    // 推的话，哪天 worker 换成 `build/pdf.worker.min.mjs`，`entry.replace(...)` 仍会
    // 拼出旧名字并报绿，而包漏掉的是**真正要 load 的那份**。
    const mw = /const PDFJS_WORKER_ENTRY = '([^']+)'/.exec(src)
    expect(mw, 'parse-pdf.ts 里找不到 PDFJS_WORKER_ENTRY —— 用例的锚点漂了，请同步').not.toBeNull()
    const worker = `node_modules/${mw![1]}`
    expect(coveredBy(files, worker), `pdfjs worker ${worker} 没被白名单覆盖`).toBe(true)
    expect(excludedBy(files, worker), `pdfjs worker ${worker} 被自己的排除规则踢掉了`).toBe(false)
    // 交叉核对：两份常量必须仍是「入口同目录的 pdf.worker.mjs」这一对 —— pdfjs 的
    // fake worker 就是按这条规矩解析的，源码若违反它，说明加载方式已经变了。
    expect(worker).toBe(entry.replace(/pdf\.mjs$/, 'pdf.worker.mjs'))
  })

  it('裁剪只裁死重：.map / 非 legacy 的 build / web / types 都被排除，而 cmaps 留着', () => {
    const ship = (p: string) => `node_modules/pdfjs-dist/${p}`
    // 裁掉的四类：源码映射（只有调试器会取）、另一份用不到的构建、viewer、类型声明。
    for (const dead of [
      'legacy/build/pdf.worker.mjs.map',
      'legacy/build/pdf.mjs.map',
      'build/pdf.mjs',
      'web/pdf_viewer.mjs',
      'legacy/web/pdf_viewer.mjs',
      'types/src/display/api.d.ts',
    ]) {
      expect(excludedBy(files, ship(dead)), `${dead} 没被排除（白装了）`).toBe(true)
    }
    // ★ 留下的这一条最要紧：中文 PDF 里字体没有 ToUnicode 时要靠 cmaps 才能把
    // 字节映射成字符。裁掉它 = 中文 PDF 抽出来是乱码（或干脆抽不出），
    // 而那正是本功能的主要使用场景。「省 1.1MB」换这个风险不划算。
    for (const keep of ['cmaps/Adobe-GB1-UCS2.bcmap', 'standard_fonts/LiberationSans-Regular.ttf']) {
      expect(excludedBy(files, ship(keep)), `${keep} 被裁掉了 —— 中文 PDF 会抽不出字`).toBe(false)
      expect(coveredBy(files, ship(keep)), `${keep} 没被覆盖`).toBe(true)
    }
  })

  it('本机打包产物（若存在）里三个库真在包内、@napi-rs 真不在', () => {
    const entries = asarEntries()
    if (entries === null) return // 没打包过就跳过；产物层的把关在 packaged-smoke 里
    for (const dep of B_DEPS) {
      expect(entries.some((p) => p.startsWith(`/node_modules/${dep}/`)), `${dep} 不在包内`).toBe(true)
    }
    // 入口文件本体也要在 —— 「顶层目录在」不等于「要 load 的那个文件在」。
    const entry = 'node_modules/pdfjs-dist/legacy/build/pdf.mjs'
    expect(entries.some((p) => p === `/${entry}`), `${entry} 不在包内`).toBe(true)
    expect(entries.some((p) => p.includes('@napi-rs')), '@napi-rs 出现在包里（36.5MB）').toBe(false)
    // 传递依赖：它们**没有**列进 files，靠 electron-builder 自动带。产物层是唯一能验的地方。
    for (const transitive of ['codepage', 'jszip', 'underscore']) {
      expect(entries.some((p) => p.startsWith(`/node_modules/${transitive}/`)),
        `${transitive} 不在包内 —— 说明「自动带传递依赖」这条前提不成立了`).toBe(true)
    }
  })
})
