/**
 * 接线守卫（`*.wiring.spec.ts`）的**公共 helper**。
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────────────────
 * 仓库没有组件渲染测试环境（只有 `jsdom` + 一份 `ledger-loading.dom.spec.ts` 模板），
 * 所以「界面接对了没有」这类不变量**只能靠读源码断言**。到这个文件出现时，这类断言已经有
 * 44 份 spec、几百条断言，而它们各自抄了一份同样的样板：
 *
 *   · `strip()` 剥注释 —— 有两个版本，**CRLF 归一的时机还不一样**；
 *   · `classBlock()` 取 CSS 声明块 —— `chats-quote` 与 `analysis-blocks` 各有一份逐字相同的实现；
 *   · `sliceBetween()` 锚点切片 —— 只有 `image-upgrade` 一份，别的 spec 还在用
 *     「锚点往后 N 字符」的窗口写法（那正是本项目吃过假阳性的写法）；
 *   · `findRoot()` 找仓库根 —— 只有 `files-loading` 一份。
 *
 * 这些样板每抄一份就多一个走样点：CRLF 处理不一致会让「本地绿、CI 红」；
 * 窗口写法会让变异测试不咬。所以在此统一。
 *
 * ── 三条纪律（抽公共时**一条都不许放宽**）────────────────────────────────
 *  1. **只抽样板，不抽断言强度**：本文件不提供「差不多就行」的宽松匹配，
 *     每个 helper 的失败方式都必须与被替换掉的原实现完全一致。
 *  2. **锚点找不到必须变红**：`sliceBetween` / `classBlock` 在锚点缺失时直接 `expect` 失败，
 *     而不是返回空串 —— 返回空串会让后面的 `not.toContain` 全部假绿。
 *  3. **先归一 CRLF→LF 再去注释**：CI 的 windows runner 是 CRLF，本地常是 LF；
 *     不归一会出现「同一份源码两种断言结果」。注：行注释正则用 `(^|[^:])` 前置，
 *     是为了不把 `https://` 这类协议里的 `//` 当注释起点（历史 bug）。
 *
 * @module
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect } from 'vitest'

/**
 * 归一换行并剥掉块注释与行注释。
 *
 * 顺序有讲究：**先 CRLF→LF**。行注释正则用 `[^\n]*` 收尾，若源码还是 CRLF，
 * 匹配到的行尾会带一个 `\r`，跨行锚点就再也对不上。
 *
 * @param src - 原始源码文本。
 * @returns 归一后的无注释文本（行号结构不变，便于用行号定位）。
 */
export function stripComments(src: string): string {
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * 原样读文件（不剥注释）。用于「注释里提到旧写法不算数」这类需要保留原文的场景，
 * 以及读 CSS / 文档这种没有 JS 注释语义的文件。
 *
 * @param absolutePath - 绝对路径（调用方用自己文件的 `HERE` 拼）。
 * @returns 文件内容，已归一 CRLF→LF。
 * @throws 文件不存在时直接抛 —— 守卫读不到被守护的文件必须炸，不能静默当空串。
 */
export function readText(absolutePath: string): string {
  return readFileSync(absolutePath, 'utf8').replace(/\r\n/g, '\n')
}

/**
 * 读文件并剥注释。绝大多数接线守卫要的就是这个。
 *
 * @param absolutePath - 绝对路径。
 * @returns 归一 + 剥注释后的源码。
 * @throws 文件不存在时直接抛。
 */
export function readStripped(absolutePath: string): string {
  return stripComments(readText(absolutePath))
}

/**
 * 读「一个面板 + 它的全部拆分模块」的联合源码。
 *
 * 做法与 `chats-source.ts` / `settings-source.ts` 相同：按**前缀正则**扫描同目录，
 * 因此下次再拆一刀不必回来补文件名。断言问的是「这一块功能」，不该关心那段代码住在哪份文件里。
 *
 * @param dir - 目录绝对路径。
 * @param modulePattern - 拆分模块的文件名正则（如 `/^settings-[a-z-]+\.tsx?$/`）。
 * @param entryFiles - 入口文件（按给定顺序排在最前）。
 * @param strip - 是否剥注释，默认 true。
 * @returns 各文件内容以 `\n` 连接。
 */
export function readUnion(dir: string, modulePattern: RegExp, entryFiles: readonly string[], strip = true): string {
  const mods = readdirSync(dir).filter((f) => modulePattern.test(f)).sort()
  return [...entryFiles, ...mods]
    .map((f) => (strip ? readStripped(join(dir, f)) : readText(join(dir, f))))
    .join('\n')
}

/**
 * 从 `from` 锚点切到 `to` 锚点之间的片段（两端锚点都必须存在，且 `to` 在 `from` 之后）。
 *
 * **为什么不给「锚点往后 N 字符」的窗口版**：那种写法会把邻近的无关代码圈进来，
 * 断言于是变成假阳性。本仓库有过实录 —— 600 字符窗口圈进了另一处的 `setNavOpen(true)`，
 * 把目标那处删掉、变异测试照样绿。
 *
 * @param text - 待切文本（应已剥注释）。
 * @param from - 起点锚点（应为**唯一**的一段字面量）。
 * @param to - 终点锚点（从起点之后开始找）。
 * @param label - 出错时的用例说明，便于改名后定位。
 * @returns 起点到终点之间的片段（不含终点）。
 */
export function sliceBetween(text: string, from: string, to: string, label: string): string {
  const a = text.indexOf(from)
  expect(a, `${label}：找不到起点锚点「${from}」（改名时请同步本用例）`).toBeGreaterThan(-1)
  const b = text.indexOf(to, a + from.length)
  expect(b, `${label}：找不到终点锚点「${to}」`).toBeGreaterThan(a)
  return text.slice(a, b)
}

/**
 * 取某个 class 的**第一条**声明块（`.name {` 到第一个 `}`）。
 *
 * 只适用于**扁平**规则（本项目 module.css 里绝大多数是）。用 `.name {` 带空格匹配，
 * 因此 `.msgQuote` 不会误命中 `.msgQuoteStrip`。锚点缺失时直接变红 ——
 * 返回空串会让调用方的 `not.toContain` 全绿。
 *
 * ⚠️ **同一个类在多处被声明时，第一条未必是"基准"那条**（2026-09-26 实录：
 * `overview.module.css` 里 `.ovCard` 出现 3 次，前两条在媒体查询里只写 `flex: none`，
 * 真正带 `border-radius` 的基准块在第三条）。需要"任一条满足"或要按层读时，
 * 用 {@link allClassBlocks}，别对 `classBlock` 的结果下"没有这个属性"的结论。
 *
 * @param css - CSS 文本。
 * @param name - 类名（不含前导点）。
 * @returns 第一条声明块文本（含选择器行，不含右花括号）。
 */
export function classBlock(css: string, name: string): string {
  const start = css.indexOf(`.${name} {`)
  expect(start, `CSS 里找不到 .${name}（改名时请同步本用例）`).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('}', start))
}

/**
 * 取某个 class 的**全部**声明块（按出现顺序）。
 *
 * 用于「这一类在多个层/多个媒体查询里被声明过」的场景：既要做"任一条满足"的存在性断言，
 * 也要做"分层各写各的"的差异断言（典型是基准档与紧档）。
 *
 * @param css - CSS 文本。
 * @param name - 类名（不含前导点）。
 * @returns 每条声明块（含选择器行，不含右花括号）；一条都没有时返回空数组（调用方自行断言长度）。
 */
export function allClassBlocks(css: string, name: string): string[] {
  const token = `.${name} {`
  const out: string[] = []
  let at = css.indexOf(token)
  while (at >= 0) {
    const end = css.indexOf('}', at)
    out.push(css.slice(at, end))
    at = css.indexOf(token, end)
  }
  return out
}

/**
 * 自 `startDir` 向上找仓库根（同时存在 `main.js` 与 `package.json` 的那一层）。
 *
 * 守卫里要读 `scripts/**` 这类仓库级文件时需要它，而 spec 的所在深度各不相同。
 *
 * @param startDir - 起始目录（通常是 spec 自己的 `HERE`）。
 * @returns 仓库根绝对路径。
 * @throws 向上 12 层仍未找到时抛错（而不是返回一个猜的路径）。
 */
export function findRoot(startDir: string): string {
  let d = startDir
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, 'main.js')) && existsSync(join(d, 'package.json'))) return d
    d = dirname(d)
  }
  throw new Error(`向上找不到仓库根（起点 ${startDir}）`)
}

/**
 * 取某个 JSX 元素的**调用点文本**（从 `<Name` 到它自己的 `/>`）。
 *
 * 为什么不直接用 `src.indexOf('<Name')`：类型里常常同时出现 `Omit<NameProps, …>`
 * 这类字样，`<Name` 会先撞上**那一行**（实录：把 state 袋按消费方分组之后，
 * 三条读调用点的守卫全部读到类型块里去了）。这里要求标签名后面紧跟空白或 `/`，
 * 于是 `<ChatsGroupInfoView …>` 命中、`<ChatsGroupInfoViewProps` 不命中。
 *
 * 与 {@link sliceBetween} 同一条纪律：**找不到就变红**，不返回空串（空串会让
 * 后续的 `toContain`/`not.toContain` 全部假绿）。
 *
 * @param text - 待切文本（应已剥注释）。
 * @param name - 组件名（不含尖括号）。
 * @param label - 出错时的用例说明。
 * @returns 从 `<Name` 起、含收尾 `/>` 的那一段。
 */
export function jsxCall(text: string, name: string, label = name): string {
  const re = new RegExp(`<(?:${name})[\\s/]`)
  const m = re.exec(text)
  expect(m, `${label}：源码里找不到 <${name} …> 这个调用点（改名时请同步本用例）`).not.toBeNull()
  const start = m!.index
  const end = text.indexOf('/>', start)
  expect(end, `${label}：<${name} 没有收尾的 />（那一屏是不是没写完就交了？）`).toBeGreaterThan(start)
  return text.slice(start, end + 2)
}

/**
 * 防空转哨兵：断言「样本量足够」，避免因为扫描目标为空而**一条断言都没真的跑**。
 *
 * 例：读不到任何 `*.spec.ts` 时，`for (const f of files) expect(...)` 会循环 0 次、
 * 整条用例绿 —— 这正是「守卫看着在守、其实什么都没守」的经典假绿。
 *
 * @param actual - 实际数量。
 * @param min - 允许的最小数量。
 * @param label - 说明（写清"扫的什么、为什么这个下限"）。
 */
export function atLeast(actual: number, min: number, label: string): void {
  expect(actual, `${label}：实际 ${actual}，下限 ${min}（低于下限说明样本没扫到，这条守卫是空的）`).toBeGreaterThanOrEqual(min)
}

/**
 * 面板审计脚本的**落定口径**契约。
 *
 * 由来：审计脚本第一版把「首屏空面板」当成了落定 —— 它只看文字长度稳不稳、有没有"加载中"字样，
 * 而「共 0 项」既稳定又没加载措辞，于是量出「空白带 651px / 占比 88%」，
 * 把一个**加载态**记成了布局缺陷。量错的工具比不量更危险，所以这五条一起锁住。
 *
 * @param auditSource - `scripts/panel-audit.mjs` 的源码（不剥注释，正则里已含足够特征）。
 */
export function assertSettledContract(auditSource: string): void {
  expect(auditSource, '审计缺少骨架元素检测').toMatch(/skel\s*[:=]/)
  expect(auditSource, '骨架没有参与落定判定（骨架在 → 视为仍在加载）').toMatch(/loading = st\.loading \|\| st\.skel > 0/)
  expect(auditSource, '落定判定没有看加载态').toMatch(/settled = st\.len === prevLen && !loading/)
  expect(auditSource, '缺少最短等待（首屏空面板会骗过纯稳定性判定）').toMatch(/Date\.now\(\) - t0 > minMs/)
  expect(auditSource, '文字稳定性要求至少 3 次').toMatch(/stable >= 3/)
}
