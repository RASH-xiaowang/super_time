/**
 * 浅色主题覆盖门禁：**整份用裸色的皮肤必须自带浅色覆盖，且浅色选择器必须真的能命中**。
 *
 * ## 为什么这条判据必须存在
 *
 * `light-theme.css` 的覆盖层选择器是 `:root.theme-light`，权重 (0,1,1) —— 它是一个
 * **元素+类**选择器，只打得过元素选择器。而皮肤文件里的规则是 `.root.root` / `.hero`
 * / `.card.card` 这类**类选择器**（(0,1,0)~(0,2,0)），`:root.theme-light` 里改令牌
 * 根本碰不到它们写死的 `linear-gradient(...#05070f...)`。
 *
 * 后果不是"颜色略有偏差"，而是**对比度失效**：深底留下，而其中的文字色跟着
 * `--nm-*` 换成了浅色主题的值。构建、类型检查、SSR 冒烟全绿，只有肉眼看得到。
 *
 * ## 2026-09-29 补的那一刀：**"写了"不等于"命中"**
 *
 * 上一版的判据只查"浅色块里有没有出现这个类名" —— 于是**漏掉了真事故**：
 * `overview-neon.module.css` 的 13 条浅色规则写的是裸 `:root.theme-light`，
 * 而本文件是 CSS Modules，`theme-light` 被当成**本地类名**一并哈希成
 * `:root._theme-light_18lio_395 …` ⇒ 与 `<html class="theme-light">` **永不匹配**，
 * 整段覆盖是死规则。症状就是用户报的那条：「浅色模式下数据总览界面的背景颜色不对」。
 * 文本检查对此完全无感（类名都在），所以现在加了**第 6 条**：
 * **所有 `*.module.css` 里出现的 `theme-light` 必须包在 `:global(…)` 里**。
 *
 * ## 反例自证
 *
 * 每条判据都用合成输入演一遍"破坏后会红"，避免写成恒真。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
const NEON = readFileSync(join(HERE, 'overview-neon.module.css'), 'utf8')
/** 面板目录（第 6 条要递归扫这里的全部 CSS Modules）。 */
const PAGES_DIR = join(HERE, '..')

/** 浅色覆盖块的起点（见文件里那段带 ═ 分隔线的说明）。 */
const LIGHT_START = ":root[class~='theme-light'] .root.root {"
/** 浅色块里每条规则的公共前缀。 */
const LIGHT_PREFIX = ":root[class~='theme-light']"

/**
 * 浅色覆盖块的**终点**：紧跟其后的降级段（`@media (prefers-reduced-motion: reduce)`）。
 * 不切到这里的后果实测过：下面的"不许出现裸类规则"会把媒体查询里的
 * `.plateValue { font-size }` 之类读成违规 —— 那些是动效/断点降级，与主题无关。
 */
const LIGHT_END = '@media (prefers-reduced-motion: reduce) {'

/**
 * 取出浅色覆盖块（限定在起点与降级段之间）。
 * @param text - 文件全文。
 * @returns 浅色块的文本；起点缺失时返回空串（调用方负责断言它在不在）。
 */
function lightBlock (text: string): string {
  const at = text.indexOf(LIGHT_START)
  if (at === -1) return ''
  const end = text.indexOf(LIGHT_END, at)
  return end === -1 ? text.slice(at) : text.slice(at, end)
}

/**
 * 需要"深底 + 浅底成对"的类：承载背景 / 玻璃 / 框线的那几个。
 * 纯装饰（极光光斑 `aurora*`、粒子 `particles`、内容排版 `*Label`/`*Sub`）不在口径内 ——
 * 它们的颜色本来就由令牌或透明度承担，不需要按主题换底。
 */
const PAIRED = [
  'root',        // 面板底：深空黑渐变 → 浅石板渐变
  'isoGrid',     // 等距网格刻线
  'hero',        // 指标条外壳（深玻璃）
  'plateFace',   // 牌面
  'plateDepth',  // 牌的高光层
  'plateValue',  // 渐变数字（浅青浅紫在浅底不可读）
  'card',        // 玻璃卡片
  'barTrack',    // 条形槽
  'gridCells',   // 指标格子（`> div` 选择器）
  'hourFill',    // 热力柱
] as const

/**
 * 抽出一段 CSS 里**裸写的 `theme-light`**（不在 `:global(…)` 里的那些）。
 *
 * 纯函数：给合成文本也能跑，所以反例不必改仓库文件。判据是"这一处 `theme-light`
 * 是否被 `:global(` 与匹配的 `)` 包住" —— 只看**选择器**文本，不管声明块内容。
 * @param css - CSS 文本。
 * @returns 违规的选择器片段（去重、按出现顺序）。
 */
export function bareThemeLight (css: string): string[] {
  const out = new Set<string>()
  // 只看选择器：带 `theme-light` 的整行，逐行判断（选择器在本仓都是一行一条）。
  for (const line of css.split(/\r?\n/)) {
    if (!line.includes('theme-light')) continue
    const trimmed = line.trim()
    // 注释行不算：本仓的注释里大量提到这个选择器（说明由来），把它当违规会全是假阳性。
    if (trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('//')) continue
    // 没有声明块的行不是规则（例如跨行的选择器续行），跳过。
    const braceAt = line.indexOf('{')
    if (braceAt === -1) continue
    const sel = line.slice(0, braceAt)
    if (!sel.includes('theme-light')) continue // 声明体里的提及不算
    // 逐个出现点判断：合规的只有两种 —— ① 包在 `:global(…)` 里；
    // ② 作为**属性选择器的字符串值**（`[class~='theme-light']`，属性值不参与哈希）。
    for (const m of sel.matchAll(/theme-light/g)) {
      const idx = m.index ?? 0
      const before = sel.slice(0, idx)
      const inGlobal = (() => {
        const lastGlobal = before.lastIndexOf(':global(')
        return lastGlobal !== -1 && before.lastIndexOf(')') < lastGlobal
      })()
      const inAttr = /\[class[~*^$|]?=\s*['"]?$/.test(before)
      if (!inGlobal && !inAttr) { out.add(sel.trim()); break }
    }
  }
  return [...out]
}

/**
 * 从一段选择器文本取它的声明体（到第一个 `}` 为止）。
 * @param css - CSS 全文。
 * @param selector - 选择器字面量（含 `{` 之前的部分）。
 * @returns 声明体文本；找不到返回空串。
 */
export function bodyOf (css: string, selector: string): string {
  const at = css.indexOf(selector)
  if (at === -1) return ''
  const open = css.indexOf('{', at)
  const close = css.indexOf('}', open)
  return open === -1 || close === -1 ? '' : css.slice(open + 1, close)
}

/** 相对亮度（只处理不透明或半透明的 rgba；半透明按"叠在纯白/纯黑之间"没法算 ⇒ 只收 alpha ≥ 0.5）。 */
function luminance (color: string): number | null {
  let r: number, g: number, b: number
  if (/^#/.test(color)) {
    let s = color.slice(1)
    if (s.length === 3) s = s.split('').map((c) => c + c).join('')
    if (s.length !== 6) return null
    r = parseInt(s.slice(0, 2), 16); g = parseInt(s.slice(2, 4), 16); b = parseInt(s.slice(4, 6), 16)
  } else {
    const m = /rgba?\(([^)]+)\)/.exec(color)
    if (!m) return null
    const p = (m[1] ?? '').split(/[,\s/]+/).filter(Boolean).map(Number)
    if (p.length < 3 || p.slice(0, 3).some((x) => Number.isNaN(x))) return null
    if (p.length >= 4 && (p[3] as number) < 0.5) return null // 半透明：不做合成，跳过（它的可见色取决于底）
    r = p[0] as number; g = p[1] as number; b = p[2] as number
  }
  const f = (v: number): number => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4) }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/** 声明体里所有"实色"颜色（含渐变停靠点）。 */
export function solidColors (body: string): string[] {
  return [...body.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)].map((m) => m[0])
}

/**
 * **浅色块里有没有"深色实色"**（= 浅色下仍画深底）。
 *
 * 这是本次报障（浅色下总览仍是深海军蓝）在**字符串层面**的可判形式：
 * 上一版判据只查"类名出现没出现"，而类名都在、规则却是死的；这一条查的是
 * **浅色块的声明体里到底写了什么颜色**。
 * @param css - 全文。
 * @param lightStart - 浅色块起点。
 * @param lightEnd - 浅色块终点。
 * @param selectors - 要检查的选择器（浅色块内的写法，如 `:global(.theme-light) .card.card`）。
 * @returns 违规项描述（空数组 = 通过）。
 */
export function darkStopsInLightBlock (css: string, lightStart: string, lightEnd: string, selectors: readonly string[]): string[] {
  const at = css.indexOf(lightStart)
  if (at === -1) return ['找不到浅色块起点']
  const end = css.indexOf(lightEnd, at)
  const block = end === -1 ? css.slice(at) : css.slice(at, end)
  const bad: string[] = []
  for (const sel of selectors) {
    const body = bodyOf(block, sel)
    if (body === '') { bad.push(`${sel} :: 浅色块里没有这条规则`); continue }
    for (const c of solidColors(body)) {
      const l = luminance(c)
      if (l !== null && l < 0.7) bad.push(`${sel} :: ${c}（亮度 ${l.toFixed(3)}）`)
    }
  }
  return bad
}

/**
 * 极简规则扫描：把一段**扁平 CSS**（本仓的规则体都不嵌套；媒体查询不在这两段里）
 * 拆成 `{ selector, body }`。
 * @param css - CSS 片段。
 * @returns 规则数组。
 */
export function rulesIn (css: string): Array<{ selector: string, body: string }> {
  const out: Array<{ selector: string, body: string }> = []
  const lines = css.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const open = line.indexOf('{')
    if (open === -1) continue
    const selector = line.slice(0, open).trim()
    if (selector === '' || selector.startsWith('*') || selector.startsWith('/*') || selector.startsWith('@')) continue
    const rest = line.slice(open + 1)
    // ⚠️ 本文件里两种写法都有：单行 `{ … }` 与多行块。第一版只认"闭合大括号独占一行"，
    // 于是单行规则会**吞掉后面所有规则**（`::after` 的浅色覆盖因此看不见，
    // 判据误报成"没有覆盖"）。这里两种都处理。
    const inlineClose = rest.indexOf('}')
    if (inlineClose !== -1) {
      out.push({ selector, body: rest.slice(0, inlineClose) })
      continue
    }
    const body: string[] = [rest]
    let j = i + 1
    for (; j < lines.length; j++) {
      const l = lines[j] ?? ''
      const close = l.indexOf('}')
      if (close !== -1) { body.push(l.slice(0, close)); break }
      body.push(l)
    }
    out.push({ selector, body: body.join('\n') })
    i = j
  }
  return out
}

/**
 * **渐变文字陷阱**：深色端用 `background-clip: text` 把渐变裁进字形的规则，
 * 它的浅色覆盖**必须重新声明** `background-clip: text` —— 否则浅色那条的
 * `background` 简写会把 `background-clip` 重置回 `border-box`
 * （而 `-webkit-text-fill-color: transparent` 从深色规则继续生效）⇒ 渐变铺满盒子、数字隐身。
 * @param dark - 深色段文本。
 * @param light - 浅色块文本。
 * @returns 丢了 clip 的选择器。
 */
export function missingTextClip (dark: string, light: string): string[] {
  const lightRules = rulesIn(light)
  const bad: string[] = []
  for (const dr of rulesIn(dark)) {
    if (!/(?:-webkit-)?background-clip:\s*text/.test(dr.body)) continue
    const lr = lightRules.find((r) => r.selector.endsWith(dr.selector))
    if (lr !== undefined && !/(?:-webkit-)?background-clip:\s*text/.test(lr.body)) bad.push(dr.selector)
  }
  return bad
}

/**
 * **伪元素陷阱**：深色端给 `::after`/`::before` 画了深底（实色亮度 < 0.5）的，
 * 浅色块里必须有一条**同一个伪元素**的覆盖 —— 否则那层深色会盖在已经换成浅色的父元素上，
 * 看起来"父元素跟了主题、整块还是深的"。
 * @param dark - 深色段文本。
 * @param light - 浅色块文本。
 * @returns 没有被浅色覆盖的伪元素选择器。
 */
export function unoverriddenDarkPseudo (dark: string, light: string): string[] {
  const lightSelectors = rulesIn(light).map((r) => r.selector)
  const bad: string[] = []
  for (const dr of rulesIn(dark)) {
    if (!/::(after|before)/.test(dr.selector)) continue
    const darkStops = solidColors(dr.body).map(luminance).filter((l): l is number => l !== null && l < 0.5)
    if (darkStops.length === 0) continue
    if (!lightSelectors.some((s) => s.endsWith(dr.selector))) bad.push(dr.selector)
  }
  return bad
}

/**
 * 递归列出目录下全部 `*.module.css`。
 * @param dir - 起始目录。
 * @returns 绝对路径数组。
 */
function moduleCssFiles (dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...moduleCssFiles(p))
    else if (e.name.endsWith('.module.css')) out.push(p)
  }
  return out
}

describe('浅色主题必须覆盖整份裸色皮肤（overview-neon）', () => {
  it('存在浅色覆盖块，且它排在深色声明之后（同权重时后者胜）', () => {
    const at = NEON.indexOf(LIGHT_START)
    expect(at, '找不到浅色覆盖块 —— 切浅色主题时这一页仍是深色皮肤').toBeGreaterThan(-1)
    // 必须排在被覆盖的深色声明之后：`.hero`(109) / `.plateFace`(181) 都在前 200 行内。
    expect(at, '浅色块排得太靠前 ⇒ 同权重下会被后面的深色声明盖掉').toBeGreaterThan(NEON.indexOf('.plateFace {'))
  })

  it('每个承载底/框的类都有浅色对应（漏一个就是一个"深底配浅字"的区块）', () => {
    const lightPart = lightBlock(NEON)
    const missing = PAIRED.filter((cls) => !lightPart.includes('.' + cls))
    expect(missing, '这些类没有浅色覆盖 ⇒ 浅色主题下仍是深底 / 不可读的渐变字：' + missing.join(', ')).toEqual([])
  })

  it('浅色覆盖必须用 `:root[class~=\'theme-light\']` 前缀（写裸 `.hero` 会连深色一起改掉）', () => {
    const lightPart = lightBlock(NEON)
    const rules = lightPart.split('\n').filter((l) => l.includes('{') && l.trim().startsWith(LIGHT_PREFIX))
    expect(rules.length, `浅色块的规则没有一条带 \`${LIGHT_PREFIX}\``).toBeGreaterThanOrEqual(8)
    // 反例：浅色块里不许出现**不带前缀**的类规则（那等于把深色主题也改了）。
    const bare = lightPart.split('\n')
      .filter((l) => /^\.\w/.test(l.trim()) && l.includes('{'))
    expect(bare, '浅色块里出现了不带主题前缀的裸类规则：' + bare.join(' | ')).toEqual([])
  })

  it('深色声明里确实有裸色（否则这条判据扫的是一个不需要覆盖的文件）', () => {
    const cut = NEON.indexOf(LIGHT_START)
    const darkPart = cut === -1 ? NEON : NEON.slice(0, cut)
    const literals = darkPart.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/g) ?? []
    expect(literals.length, '深色段一个裸色都没有 ⇒ 本判据对该文件已无意义，应删掉条目').toBeGreaterThan(10)
  })

  it('反例自证：把浅色块删掉必须判不通过', () => {
    // 合成"删掉浅色块"的文本：砍掉起点之后的一切，再按同一口径求缺失集合。
    const cut = NEON.indexOf(LIGHT_START)
    const withoutLight = cut === -1 ? NEON : NEON.slice(0, cut)
    expect(lightBlock(withoutLight), '删掉浅色块后仍能取到它 ⇒ 上面的断言是恒真的').toBe('')
    const missing = PAIRED.filter((cls) => !lightBlock(withoutLight).includes('.' + cls))
    expect(missing, '删掉浅色块后却认为没有缺失 ⇒ 判据没咬住').toEqual([...PAIRED])
  })

  it('所有 CSS Modules 里的 `theme-light` 都必须包在 `:global(…)` 里（否则被哈希 ⇒ 死规则）', () => {
    const offenders: string[] = []
    let scanned = 0
    for (const file of moduleCssFiles(PAGES_DIR)) {
      scanned++
      const bad = bareThemeLight(readFileSync(file, 'utf8'))
      for (const sel of bad) offenders.push(`${file.slice(PAGES_DIR.length + 1)} :: ${sel}`)
    }
    // 哨兵：扫描面必须非空，否则这条是空转。
    expect(scanned, '一个 CSS Module 都没扫到 ⇒ 路径变了，判据空转').toBeGreaterThan(20)
    expect(offenders, '这些 module CSS 用了裸 `theme-light` —— CSS Modules 会把它哈希掉（选择器永不匹配，整段覆盖变死规则）：\n  ' + offenders.join('\n  ')).toEqual([])
  })

  it('反例自证：裸 `:root.theme-light` 必须被咬住，`:global(…)` 与属性选择器必须放行', () => {
    expect(bareThemeLight(':root.theme-light .card.card { background: #fff; }'), '裸写法没被咬住 ⇒ 判据空转')
      .toEqual([':root.theme-light .card.card'])
    expect(bareThemeLight(':global(.theme-light) .card.card { background: #fff; }'), '合规写法被误报').toEqual([])
    // 本目录改用属性选择器（见 overview-neon 的注释）：属性值不哈希，同样必须放行。
    expect(bareThemeLight(":root[class~='theme-light'] .card.card { background: #fff; }"), '属性选择器写法被误报').toEqual([])
    expect(bareThemeLight(':root[class*="theme-light"] .card { color: red; }'), '双引号写法被误报').toEqual([])
    // 同一条规则里混写：只要有一处裸的就要报。
    expect(bareThemeLight(":root[class~='theme-light'] .a, :root.theme-light .b { color: red; }").length).toBe(1)
    // 注释/声明体里的提及不算违规（否则注释里写一句说明就会红）。
    expect(bareThemeLight('/* 说明：这里是 :root.theme-light 的由来 */\n.card { color: red; }')).toEqual([])
  })

  it('浅色块里的实色必须是"浅色"（写死深底 = 浅色下仍画深色）', () => {
    const CHECK = [
      `${LIGHT_PREFIX} .root.root`,
      `${LIGHT_PREFIX} .hero`,
      `${LIGHT_PREFIX} .card.card`,
      `${LIGHT_PREFIX} .gridCells > div`,
      `${LIGHT_PREFIX} .plateFace`,
    ] as const
    const bad = darkStopsInLightBlock(NEON, LIGHT_START, LIGHT_END, CHECK)
    expect(bad, '浅色块里这些实色仍然偏暗 ⇒ 浅色主题下会画出深底：\n  ' + bad.join('\n  ')).toEqual([])
  })

  it('反例自证：把深色渐变搬进浅色块，必须被上面那条咬住', () => {
    // 合成一份"浅色块里写了深海军蓝"的文本（正是 2026-09-29 报障的形状）。
    // ⚠️ 用正则整条替换，不要按 `\n` 拼串：本文件的换行在不同工具下可能是 CRLF，拼串会静默不匹配
    // （第一版就因此"反例前提不成立"，等于这条自证是假的）。
    const broken = NEON.replace(
      /:root\[class~='theme-light'\] \.card\.card \{[^}]*\}/,
      ":root[class~='theme-light'] .card.card { background: linear-gradient(158deg, rgba(30, 47, 88, 0.6), rgba(13, 20, 42, 0.55)); }",
    )
    expect(broken, '反例前提不成立：替换没生效').not.toBe(NEON)
    const bad = darkStopsInLightBlock(broken, LIGHT_START, LIGHT_END, [`${LIGHT_PREFIX} .card.card`])
    expect(bad.length, '深底进了浅色块却没被咬住 ⇒ 判据空转').toBeGreaterThan(0)
  })

  it('渐变文字：深色端用 `background-clip: text` 的，浅色覆盖必须重新声明它', () => {
    const dark = NEON.slice(0, NEON.indexOf(LIGHT_START))
    const bad = missingTextClip(dark, lightBlock(NEON))
    expect(bad, '这些选择器的浅色覆盖把 `background-clip` 丢掉了 ⇒ 渐变会铺满盒子、文字隐身（2026-09-29 报障的第一层原因）：\n  ' + bad.join('\n  ')).toEqual([])
  })

  it('反例自证：浅色覆盖里删掉 `background-clip: text` 必须被咬住', () => {
    const broken = NEON.replace(
      /:root\[class~='theme-light'\] \.plateValue \{[^}]*\}/,
      ":root[class~='theme-light'] .plateValue { color: #0f2a44; background: linear-gradient(96deg, #075985, #6d28d9); }",
    )
    expect(broken, '反例前提不成立：替换没生效').not.toBe(NEON)
    const dark = broken.slice(0, broken.indexOf(LIGHT_START))
    expect(missingTextClip(dark, lightBlock(broken))).toContain('.plateValue')
  })

  it('伪元素：深色端画了深底的 `::after`/`::before`，浅色块必须有同名的覆盖', () => {
    const dark = NEON.slice(0, NEON.indexOf(LIGHT_START))
    const bad = unoverriddenDarkPseudo(dark, lightBlock(NEON))
    expect(bad, '这些深色伪元素没有浅色覆盖 ⇒ 它们会把已经换浅的父元素重新盖成深色（2026-09-29 报障的第二层原因）：\n  ' + bad.join('\n  ')).toEqual([])
  })

  it('反例自证：删掉 `.plateFace::after` 的浅色覆盖，必须被咬住', () => {
    // 正则**不要**依赖 `}\n`：本文件的换行是 CRLF，`\n` 前面还有 `\r`，会静默匹配不上
    // （第一版就因此"反例前提不成立"）。
    const broken = NEON.replace(/:root\[class~='theme-light'\] \.plateFace::after \{[^}]*\}/, '')
    expect(broken, '反例前提不成立：`.plateFace::after` 的浅色覆盖没被删掉').not.toBe(NEON)
    const dark = broken.slice(0, broken.indexOf(LIGHT_START))
    expect(unoverriddenDarkPseudo(dark, lightBlock(broken))).toContain('.plateFace::after')
  })
})
