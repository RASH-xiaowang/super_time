/**
 * 主题对比度门禁（2026-09-29）：**两套主题的文字/底色令牌对，必须都过 WCAG AA，
 * 或至少不比另一套主题更差**。
 *
 * ## 为什么这条判据必须存在（与既有守卫的分工）
 *
 * `light-theme-coverage.wiring.spec.ts` 管的是「浅色覆盖规则**存在**」（`includes('.'+cls)`）；
 * 它无法回答「覆盖之后**读不读得清**」。这两件事会分叉：把浅色底的文字令牌改成接近底色，
 * 覆盖规则一条不少、既有守卫全绿，而实际浅色页面上文字看不见。
 *
 * 本文件补的正是"**算出来**"这一层：把两套主题的 `--nm-*` 解析成 RGB，
 * 按 WCAG 2.x 相对亮度公式算对比度，再逐对判。
 *
 * ## 判据为什么不写"必须 ≥4.5"（这是关键取舍）
 *
 * 实测（真实 Electron 下读 computed style，深/浅各跑一遍；那套探针是本地一次性脚本，
 * 不进仓库 —— 所以这里**不写它的路径**，`phantom-reference.spec.ts` 会拦住指向不存在文件的引用）：
 * **深色主题的 `--nm-text-3` 只有 3.75–4.15** —— 低于 AA。而仓库**早就知道**这件事：
 * `ui/kit.module.css:34-37` 记着"深色下 text-3 在 #050a18 上约 4.2、卡片上约 3.9，
 * 于是全 30 个页签共 50 处低于 4.5"，其解法是**把内容类文字改用 `text-2`、不改令牌值**
 * （避免全局视觉偏移）。
 *
 * 所以若把门禁写成"一律 ≥4.5"，它会立刻红在一个**已被评审接受**的既有状态上，
 * 只能靠放宽数字收场 —— 那正是"棘轮被抬高"的老路。这里改用一个**不需要拍脑袋**的判据：
 *
 *   ① **棘轮**：任何一对在线上**不许比今天更差**（下限 = 当前实测值，逐对登记）；
 *   ② **跨主题不劣化**：浅色端每一对都必须 **≥ 深色端同一对** ——
 *      用户的抱怨正是"深浅不一致"，这条把"浅色比深色更难读"直接变成红。
 *
 * ② 这条在本机实测下成立（浅色 text-3/bg-2 = 5.43 > 深色 3.75），而且它**没有魔法数字**：
 * 它只要求两套主题别一个比另一个差。
 *
 * ## 反例自证
 *
 * 合成一份"把浅色文字令牌改成与底同色"的文本，必须判不通过。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
/** 深色端：默认令牌（`:root` 里定义）。 */
const DARK_CSS = readFileSync(join(HERE, 'scifi-theme.css'), 'utf8')
/** 浅色端：覆盖层（`light-theme.css`，由 `<html class="theme-light">` 触发）。 */
const LIGHT_CSS = readFileSync(join(HERE, 'light-theme.css'), 'utf8')

/** 参与对比度检查的文字令牌。 */
const TEXT = ['--nm-text-1', '--nm-text-2', '--nm-text-3'] as const
/** 参与对比度检查的表面令牌。 */
const SURFACE = ['--nm-bg-0', '--nm-bg-1', '--nm-bg-2'] as const

/**
 * 逐对登记的下限（**棘轮**）：等于 2026-09-29 的实测值，只许升不许降。
 * 数字来源：2026-09-29 在本机真实数据上算出的实测值（脚本为本地一次性工具，未入库）。
 */
const FLOOR: Record<string, number> = {
  'dark:text-1:bg-0': 16.02, 'dark:text-1:bg-1': 15.19, 'dark:text-1:bg-2': 14.48,
  'dark:text-2:bg-0': 7.70, 'dark:text-2:bg-1': 7.30, 'dark:text-2:bg-2': 6.96,
  // 深色 text-3 低于 AA 是**既有且已被评审接受**的状态（见头注引用的 kit.module.css 说明），
  // 所以这里登记实测下限而不是 4.5。
  'dark:text-3:bg-0': 4.15, 'dark:text-3:bg-1': 3.93, 'dark:text-3:bg-2': 3.75,
  'light:text-1:bg-0': 16.78, 'light:text-1:bg-1': 15.77, 'light:text-1:bg-2': 17.85,
  'light:text-2:bg-0': 7.12, 'light:text-2:bg-1': 6.69, 'light:text-2:bg-2': 7.58,
  'light:text-3:bg-0': 5.10, 'light:text-3:bg-1': 4.79, 'light:text-3:bg-2': 5.43,
}
/**
 * 从一份 CSS 里取出所有 `--nm-*: value;` 声明（后者覆盖前者，与浏览器一致）。
 * @param css - 样式表全文。
 * @returns 令牌名 → 原始值。
 */
function tokensOf(css: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const m of css.matchAll(/(--nm-[a-z0-9-]+)\s*:\s*([^;}]+)[;}]/gi)) {
    const name = m[1]
    const value = m[2]
    if (name === undefined || value === undefined) continue
    map.set(name, value.trim())
  }
  return map
}

/**
 * 解析 `var(--x)` / `var(--x, fallback)` 链。
 * @param name - 令牌名。
 * @param tokens - 令牌表。
 * @param depth - 递归深度保护。
 * @returns 具体颜色串或 null。
 */
function resolve(name: string, tokens: Map<string, string>, depth = 0): string | null {
  if (depth > 8) return null
  const raw = tokens.get(name)
  if (raw === undefined) return null
  const m = /^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*(.+))?\)$/i.exec(raw.trim())
  if (m) {
    const inner = resolve(m[1] ?? '', tokens, depth + 1)
    if (inner !== null) return inner
    return m[2] !== undefined ? m[2].trim() : null
  }
  return raw
}

/**
 * 解析颜色为 `[r,g,b,a]`（**保留 alpha**）。
 *
 * 为什么要保留 alpha：状态层（`--nm-bg-hover` / `--nm-table-row-hover`）是
 * **半透明**色（如 `rgba(0,240,255,0.05)`），它们的实际观感取决于**压在什么底上**。
 * 第一版把 alpha 丢掉，等于把 5% 的青当成纯青去算对比度 —— 结论会完全失真。
 * @param color - `#rgb` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()`。
 * @returns RGBA 四元组或 null。
 */
function rgbaOf(color: string | null): [number, number, number, number] | null {
  if (color === null) return null
  const s = color.trim()
  if (s.startsWith('#')) {
    let h = s.slice(1)
    if (h.length === 3) h = h.split('').map((c) => c + c).join('')
    let a = 1
    if (h.length === 8) {
      a = Number.parseInt(h.slice(6, 8), 16) / 255
      h = h.slice(0, 6)
    }
    if (h.length !== 6) return null
    const n = Number.parseInt(h, 16)
    return Number.isNaN(n) ? null : [(n >> 16) & 255, (n >> 8) & 255, n & 255, a]
  }
  const m = /^rgba?\(([^)]+)\)$/i.exec(s)
  if (!m) return null
  const p = (m[1] ?? '').split(/[,\s/]+/).filter(Boolean).map(Number)
  if (p.length < 3 || p.slice(0, 3).some((x) => Number.isNaN(x))) return null
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p.length > 3 ? (p[3] ?? 1) : 1]
}

/**
 * 把（可能半透明的）前景合成到不透明底色上。
 * @param fg - 前景 RGBA。
 * @param bg - 不透明底色 RGB。
 * @returns 不透明的合成结果 RGB。
 */
function over(fg: [number, number, number, number], bg: [number, number, number]): [number, number, number] {
  const a = fg[3]
  return [
    fg[0] * a + bg[0] * (1 - a),
    fg[1] * a + bg[1] * (1 - a),
    fg[2] * a + bg[2] * (1 - a),
  ]
}

/**
 * 解析一个"可能是 `var(--x)`、也可能已经是令牌名"的片段。
 *
 * ⚠️ 这个分支是必需的：`color-mix` 的**参数**长这样 `var(--nm-danger) 70%`，
 * 正则切出来的组就是 `var(--nm-danger)`。而 `resolve()` 只认**裸令牌名**
 * （`--nm-danger`），把带 `var()` 的串喂给它只会返回 null。
 * 第一版就是这么错的：`--nm-danger-text` 全部"解析失败"，看着像缺陷，
 * 其实是参数形态没对齐（用一次性脚本逐步打印解析过程定位到的）。
 * @param spec - `var(--x)` 或 `--x` 或字面色。
 * @param tokens - 令牌表。
 * @returns 解析后的颜色串（可能是 `rgba(...)` / `#...`），或 null。
 */
function resolveSpec(spec: string, tokens: Map<string, string>): string | null {
  const s = spec.trim()
  const bare = /^(--[a-z0-9-]+)$/i.exec(s)
  if (bare !== null) return resolve(bare[1] ?? '', tokens)
  const varForm = /^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*(.+))?\)$/i.exec(s)
  if (varForm !== null) {
    const inner = resolve(varForm[1] ?? '', tokens)
    if (inner !== null) return inner
    return varForm[2] !== undefined ? varForm[2].trim() : null
  }
  return s
}

/**
 * 解析 `color-mix(in srgb, A P%, B)`（本仓库只用这一种形态）。
 *
 * 为什么必须支持：`--nm-danger-text` / `--nm-warning-text` 就是 `color-mix` 出来的，
 * 且**被 20 处 CSS 消费**，而它们**没有浅色覆盖**——靠的是 `--nm-text-1` 在浅色下变了值。
 * 也就是说这两条语义色的浅色观感**完全由 color-mix 的解析结果决定**，
 * 静态文本检查（`includes('--nm-danger-text')`）对它一无所知。
 * @param raw - 声明值。
 * @param tokens - 令牌表（用于解析其中的 `var()`）。
 * @param depth - 递归深度保护。
 * @returns 合成后的不透明 RGB，或 null（形态不认识时）。
 */
function colorMixOf(raw: string, tokens: Map<string, string>, depth = 0): [number, number, number] | null {
  if (depth > 8) return null
  const m = /^color-mix\(\s*in\s+srgb\s*,\s*(.+?)\s+(\d+(?:\.\d+)?)%\s*,\s*(.+?)\s*\)$/i.exec(raw.trim())
  if (!m) return null
  const aRaw = resolveSpec(m[1] ?? '', tokens) ?? (m[1] ?? '')
  const bRaw = resolveSpec(m[3] ?? '', tokens) ?? (m[3] ?? '')
  const pct = Number(m[2]) / 100
  const a = rgbaOf(aRaw)
  const b = rgbaOf(bRaw)
  if (a === null || b === null) return null
  // 先各自合成到白底，避免 alpha 在混合里被丢掉（这两个语义色都是不透明的，留个稳妥兜底）。
  const white: [number, number, number] = [255, 255, 255]
  const af = a[3] < 1 ? over(a, white) : [a[0], a[1], a[2]] as [number, number, number]
  const bf = b[3] < 1 ? over(b, white) : [b[0], b[1], b[2]] as [number, number, number]
  return [
    af[0] * pct + bf[0] * (1 - pct),
    af[1] * pct + bf[1] * (1 - pct),
    af[2] * pct + bf[2] * (1 - pct),
  ]
}

/**
 * 解析任意颜色声明（`#`/`rgb()`/`rgba()`/`var()`/`color-mix()`）为不透明 RGB。
 * @param raw - 声明值或令牌名。
 * @param tokens - 令牌表。
 * @returns 不透明 RGB 或 null。
 */
function colorOf(raw: string, tokens: Map<string, string>): [number, number, number] | null {
  // ① 直接就是 color-mix（调用方给了声明值）
  const direct = colorMixOf(raw, tokens)
  if (direct !== null) return direct
  // ② 给了令牌名 / var()：先解析成声明值，再看它是不是 color-mix
  const resolved = resolveSpec(raw, tokens)
  if (resolved !== null && resolved !== raw.trim()) {
    const mixed = colorMixOf(resolved, tokens)
    if (mixed !== null) return mixed
  }
  const c = rgbaOf(resolved)
  if (c === null) return null
  return c[3] < 1 ? over(c, [255, 255, 255]) : [c[0], c[1], c[2]]
}

/**
 * 解析色为不太透明的 RGB（保留原语义：给 `grid` 用）。
 * @param color - 颜色串。
 * @returns RGB 三元组或 null。
 */
function rgbOf(color: string | null): [number, number, number] | null {
  const c = rgbaOf(color)
  return c === null ? null : [c[0], c[1], c[2]]
}

/**
 * WCAG 2.x 相对亮度。
 * @param rgb - RGB 三元组。
 * @returns 0..1 的相对亮度。
 */
function luminance(rgb: [number, number, number]): number {
  const f = (v: number): number => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
}

/**
 * WCAG 对比度。
 * @param fg - 前景 RGB。
 * @param bg - 背景 RGB。
 * @returns 对比度（1..21）。
 */
function contrast(fg: [number, number, number], bg: [number, number, number]): number {
  const a = luminance(fg)
  const b = luminance(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/**
 * 算一套主题的全部 `text × bg` 对比度。
 * @param label - 主题名（用于错误信息）。
 * @param css - 该主题的样式表（浅色端请传"深色 + 浅色覆盖"合并后的文本）。
 * @returns 键 `text-N:bg-N` → 对比度。
 */
function grid(label: string, css: string): Record<string, number> {
  const tokens = tokensOf(css)
  const out: Record<string, number> = {}
  for (const t of TEXT) {
    const fg = rgbOf(resolve(t, tokens))
    if (fg === null) throw new Error(`${label}: ${t} 解析不出颜色 —— 令牌改名或写法变了，本判据失效`)
    for (const b of SURFACE) {
      const bg = rgbOf(resolve(b, tokens))
      if (bg === null) throw new Error(`${label}: ${b} 解析不出颜色 —— 令牌改名或写法变了，本判据失效`)
      // ⚠️ 键名必须与 FLOOR **逐字符**一致（这条我踩了两次，都是"键对不上"而不是"对比度差")：
      //   · 第一版把 `--nm-bg-0` 用 `replace('--nm-bg-','bg')` 得到 `bg0`，
      //     而 FLOOR 里是 `bg-0` ⇒ 每一次查找都落空，棘轮变成"全都没登记"的空转红灯；
      //   · 同一个错键还让反例取证取到 undefined（`?? 99` 兜成 99），于是"没咬住"。
      // 直接用去掉 `--nm-` 前缀的完整令牌名做后半段，两边就不会再飘。
      out[`${t.replace('--nm-', '')}:${b.replace('--nm-', '')}`] = contrast(fg, bg)
    }
  }
  return out
}

const dark = grid('dark', DARK_CSS)
const light = grid('light', DARK_CSS + '\n' + LIGHT_CSS)

describe('主题对比度门禁（令牌算出来的，不依赖截图）', () => {
  it('哨兵：两套主题都算出了全部 9 对（否则下面的断言是空转）', () => {
    expect(Object.keys(dark).length, '深色端对数不足').toBe(9)
    expect(Object.keys(light).length, '浅色端对数不足').toBe(9)
    // 两套主题必须真的不同：底色一变，浅色端的数字就不该与深色完全相同。
    const same = Object.keys(dark).filter((k) => Math.abs((dark[k] ?? 0) - (light[k] ?? 0)) < 0.01)
    expect(same, '这些对的深浅对比度完全相同 ⇒ 浅色覆盖没生效：' + same.join(', ')).toEqual([])
  })

  it('棘轮：没有任何一对比登记的下限更差', () => {
    const worse: string[] = []
    for (const [theme, table] of [['dark', dark], ['light', light]] as const) {
      for (const [key, value] of Object.entries(table)) {
        const floor = FLOOR[`${theme}:${key}`]
        if (floor === undefined) { worse.push(`${theme}:${key} 没有登记下限（新增了对子要补登记）`); continue }
        if (value < floor - 0.01) worse.push(`${theme}:${key} 实测 ${value.toFixed(2)} < 登记下限 ${floor.toFixed(2)}`)
      }
    }
    expect(worse, '对比度棘轮被压低：\n  ' + worse.join('\n  ')).toEqual([])
  })

  it('浅色端每一对都必须过 WCAG AA（4.5）—— 这才是"浅色下读得清"的直接判据', () => {
    // 为什么不用"浅色 ≥ 深色"那种排序判据：实测 text-2 在深色 7.70、浅色 7.12 ——
    // 浅色确实更低，但两者都远高于 AA。把"绝对不低于深色"当门禁会红在一个
    // **完全没问题**的状态上，只能靠加容差收场。用户抱怨的是"浅色下读不清"，
    // 所以判据就该是 AA 这条绝对线。
    const fails = Object.entries(light)
      .filter(([, v]) => v < 4.5)
      .map(([k, v]) => `${k}=${v.toFixed(2)}`)
    expect(fails, '浅色端出现低于 AA 的对（浅色主题下这些文字读不清）：' + fails.join(', ')).toEqual([])
  })

  /**
   * 语义色与状态层（2026-09-29 第二轮）：`text × bg` 那 9 对覆盖不到的三类隐患。
   *
   * ## 为什么这三类必须单独覆盖
   *
   * ① **语义色是 `color-mix()` 出来的**：`--nm-danger-text` / `--nm-warning-text` = 基色 70% +
   *    `--nm-text-1` 30%。它们**没有浅色覆盖**，浅色观感完全靠 `--nm-text-1` 换值 ——
   *    也就是说「color-mix 解析得对不对」直接决定 20 处 CSS 的可读性，而静态文本检查
   *    （`includes('--nm-danger-text')`）对此一无所知。
   * ② **`--nm-on-accent`** 是压在强调色（`--nm-cyan`）上的文字：深色端 #050a18、浅色端 #ffffff，
   *    方向正好相反 —— 这种"随主题反转"的令牌最容易在某一端配错底。
   * ③ **状态层是半透明**（`--nm-bg-hover` 5%、`--nm-table-row-hover` 5–6%）：它们不改变
   *    文字色，但会**改变文字底下的颜色**，所以"悬停时还读得清吗"是一个独立的可判定问题。
   *
   * ## 判据
   *
   * 三类都在**两套主题**下算，且都取 AA 线（4.5）。与 `text-3` 那个例外不同，
   * 这三类都是**内容/操作文字**（错误提示、主按钮文字、表格行），该按 AA 要求。
   */
  const SEMANTIC: Array<{ label: string; fg: string; bg: string }> = [
    { label: 'danger-text / bg-2', fg: '--nm-danger-text', bg: '--nm-bg-2' },
    { label: 'danger-text / bg-0', fg: '--nm-danger-text', bg: '--nm-bg-0' },
    { label: 'warning-text / bg-2', fg: '--nm-warning-text', bg: '--nm-bg-2' },
    { label: 'warning-text / bg-0', fg: '--nm-warning-text', bg: '--nm-bg-0' },
    { label: 'on-accent / cyan', fg: '--nm-on-accent', bg: '--nm-cyan' },
  ]

  /** 悬停行/中性悬停层压在底色上之后，正文与次要文字还读得清吗。 */
  const HOVER_LAYERS = ['--nm-bg-hover', '--nm-table-row-hover', '--nm-hover-neutral'] as const

  it('哨兵：语义色与状态层都解析出来了（否则下面几条是空转）', () => {
    const t = tokensOf(DARK_CSS + '\n' + LIGHT_CSS)
    // ⚠️ 必须传**令牌名**（`--nm-danger-text`）而不是它的声明值：`colorOf` 内部会先
    // `resolve(name, tokens)` 再判 color-mix。第一版传了声明值，resolve 找不到同名令牌
    // 于是整体返回 null，5 对全部"解析失败"——看着像缺陷，其实是我喂错了参数。
    const unresolved = SEMANTIC
      .filter((s) => colorOf(s.fg, t) === null || colorOf(s.bg, t) === null)
      .map((s) => s.label)
    expect(unresolved, '这些语义色对解析不出颜色 ⇒ 判据失效：' + unresolved.join(', ')).toEqual([])
    // 状态层必须是**半透明**的（这正是它们需要单独处理的原因）；若哪天改成不透明，
    // 下面的合成口径就与浏览器不一致了，必须来这里重新确认。
    const notTranslucent = HOVER_LAYERS
      .filter((k) => t.get(k) !== undefined)
      .filter((k) => (rgbaOf(resolve(k, t))?.[3] ?? 1) >= 1)
    expect(notTranslucent, '这些状态层不再半透明 ⇒ 本判据的合成假设失效，请复核：' + notTranslucent.join(', ')).toEqual([])
  })

  it('语义色（danger/warning 文字、强调色上的文字）在两套主题下都过 AA', () => {
    const fails: string[] = []
    for (const [theme, css] of [['dark', DARK_CSS], ['light', DARK_CSS + '\n' + LIGHT_CSS]] as const) {
      const t = tokensOf(css)
      for (const s of SEMANTIC) {
        // 键名必须真的在令牌表里：否则"解析失败"会掩盖"令牌改名了"（本文件踩过键名不一致）。
        expect(t.has(s.fg), `${theme}: 令牌表里没有 ${s.fg}（改名了？）`).toBe(true)
        expect(t.has(s.bg), `${theme}: 令牌表里没有 ${s.bg}（改名了？）`).toBe(true)
        const fg = colorOf(s.fg, t)
        const bg = colorOf(s.bg, t)
        if (fg === null || bg === null) { fails.push(`${theme} ${s.label}: 解析失败`); continue }
        const r = contrast(fg, bg)
        if (r < 4.5) fails.push(`${theme} ${s.label} = ${r.toFixed(2)}`)
      }
    }
    expect(fails, '语义色低于 AA（错误提示/主按钮文字在某个主题下读不清）：\n  ' + fails.join('\n  ')).toEqual([])
  })

  it('反例自证：把 warning 基色换成接近底色的值，语义色判据必须红', () => {
    // 为什么需要这条：`danger-text`/`warning-text` 走的是 `color-mix`，若解析悄悄失效，
    // 上面的 AA 判据会**恒绿**（解析失败被算成"没问题"）。这里合成一份坏令牌，
    // 要求它**真的**算出接近 1 的对比度 —— 证明 color-mix 那条链路在参与判据。
    const lightTokens = tokensOf(DARK_CSS + '\n' + LIGHT_CSS)
    const bg0 = resolveSpec('--nm-bg-0', lightTokens)
    expect(bg0, '取不到浅色端 bg-0 ⇒ 反例构造失效').not.toBeNull()
    // 把 warning 基色改成与底色相同 ⇒ warning-text（= 基色 70% + text-1 30%）应当远低于 AA。
    const broken = DARK_CSS + '\n' + LIGHT_CSS + `\n:root.theme-light { --nm-warning: ${String(bg0)}; }`
    const t = tokensOf(broken)
    const fg = colorOf('--nm-warning-text', t)
    const bg = colorOf('--nm-bg-0', t)
    expect(fg, '反例下 warning-text 解析失败 ⇒ color-mix 链路没生效').not.toBeNull()
    expect(bg, '反例下 bg-0 解析失败').not.toBeNull()
    const r = contrast(fg as [number, number, number], bg as [number, number, number])
    expect(r, '把基色改成与底同色后对比度仍达标 ⇒ color-mix 解析没在参与判据').toBeLessThan(4.5)
  })

  /**
   * 悬停/选中状态下文字仍读得清吗。
   *
   * ## 为什么 `text-3` 在这条里**不取 AA 线**（这是实测逼出来的取舍）
   *
   * 实测（本判据第一次跑出来的数字）：深色端 `--nm-text-3` 本来就只有 3.75–4.15，
   * 叠上 5% 的悬停层后掉到 **3.11–3.40**。要它过 4.5 就得改 `text-3` 的令牌值 ——
   * 而仓库**明确决策过不改**：`ui/kit.module.css:34-37` 的处置是「把内容类文字改用
   * `--nm-text-2`，保持 text-3 是弱化文字」。
   * 所以这里对 `text-3` 改用**棘轮**（不许比今天更差），对 `text-1/2`（正文与次要正文）
   * 才要求 AA —— 后者是真正承载内容的层级。
   */
  const HOVER_FLOOR: Record<string, number> = {
    // 2026-09-29 实测下限（深色端；浅色端本来就都过 AA，不需要登记）。
    'dark:--nm-bg-hover:--nm-text-3': 3.33,
    'dark:--nm-table-row-hover:--nm-text-3': 3.40,
    'dark:--nm-hover-neutral:--nm-text-3': 3.11,
  }

  it('悬停/选中状态下正文（text-1/2）仍过 AA；弱化文字（text-3）不劣化', () => {
    const aaFails: string[] = []
    const worse: string[] = []
    for (const [theme, css] of [['dark', DARK_CSS], ['light', DARK_CSS + '\n' + LIGHT_CSS]] as const) {
      const t = tokensOf(css)
      const base = colorOf('--nm-bg-2', t)
      if (base === null) { aaFails.push(`${theme}: bg-2 解析失败`); continue }
      for (const layer of HOVER_LAYERS) {
        // 某个主题没有该令牌时跳过（"本主题不适用"，不是缺陷）。
        if (!t.has(layer)) continue
        const l = rgbaOf(resolveSpec(layer, t))
        if (l === null) { aaFails.push(`${theme} ${layer}: 解析失败`); continue }
        const hovered = over(l, base)
        for (const tx of TEXT) {
          const fg = colorOf(tx, t)
          if (fg === null) { aaFails.push(`${theme} ${layer} × ${tx}: 解析失败`); continue }
          const r = contrast(fg, hovered)
          if (tx === '--nm-text-3') {
            const key = `${theme}:${layer}:${tx}`
            const floor = HOVER_FLOOR[key]
            if (floor === undefined) {
              // 浅色端 text-3 实测都过 AA，所以没登记；确实低于 AA 才需要登记。
              if (r < 4.5) worse.push(`${key} = ${r.toFixed(2)} 未登记下限（低于 AA 就要登记）`)
            } else if (r < floor - 0.01) {
              worse.push(`${key} = ${r.toFixed(2)} < 登记下限 ${floor.toFixed(2)}`)
            }
            continue
          }
          if (r < 4.5) aaFails.push(`${theme} ${layer} × ${tx} = ${r.toFixed(2)}`)
        }
      }
    }
    expect(aaFails, '悬停状态下**正文**低于 AA（鼠标移上去反而看不清）：\n  ' + aaFails.join('\n  ')).toEqual([])
    expect(worse, '悬停状态下的弱化文字比登记下限更差：\n  ' + worse.join('\n  ')).toEqual([])
  })


  /**
   * 语义徽标上的文字（2026-09-29 第三轮）。
   *
   * ## 这一条我改了三次口径，每次都是被实测推翻的 —— 记下来
   *
   * - **第一版**写成 `{#fff, text-1, on-accent} × {danger 85%, danger 100%, warning 100%}`
   *   的**叉乘**，报出 9 条低于 AA。但那些组合**代码里根本不存在**（例如"`--nm-warning`
   *   实心底 + `--nm-text-1`"），是假缺陷 —— 只会逼人去放宽阈值。
   * - **第二版**改成"自色淡底 + 自色文字，取 15%"，报出 2 条（dark danger 4.45 /
   *   light warning 4.08）。**又错了**：15% 是 `--nm-danger-15` **令牌**的 alpha，
   *   而代码里真正写的是 `color-mix(..., --nm-danger 8%, transparent)`
   *   （`oplog.module.css:16` 等）。用 8% 重算 ⇒ **4.81，过 AA**。
   * - **第三版（本版）**只登记**代码里真实出现的 alpha**，并把每个 alpha 的来源行号写在旁边。
   *
   * 教训：token 的 alpha 与"代码里写的 alpha"是两回事；判据必须按后者取。
   */
  const BADGE_PAIRS: Array<{ label: string; fg: string; bg: string; bgAlpha: number; src: string }> = [
    // 自色淡底 + 自色文字。alpha 取代码里实际写的值：
    { label: 'danger on danger 8%', fg: '--nm-danger', bg: '--nm-danger', bgAlpha: 0.08, src: 'oplog.module.css:16' },
    { label: 'warning on warning 8%', fg: '--nm-warning', bg: '--nm-warning', bgAlpha: 0.08, src: 'kit/knowledge-base 同类写法' },
    { label: 'success on success 8%', fg: '--nm-success', bg: '--nm-success', bgAlpha: 0.08, src: 'oplog.module.css:15' },
    { label: 'success on success 10%', fg: '--nm-success', bg: '--nm-success', bgAlpha: 0.10, src: 'oplog.module.css:20 (.stOk)' },
    // 令牌形态的 15% 淡底（`Button.module.css:93` 用 `var(--nm-danger-15)` 配 `var(--nm-danger)`）。
    // ⚠️ 底必须声明成 `--nm-danger` + α=0.15，**不能**写 `bg: '--nm-danger-15'`：
    // 那个令牌自身带 α=0.15，再叠一次 0.15 会变成等效 2.25% ⇒ 算出 3.45 的假红
    // （第一版就是这么错的 —— 复合 alpha 不能乘两遍）。
    { label: 'danger on danger 15%', fg: '--nm-danger', bg: '--nm-danger', bgAlpha: 0.15, src: 'Button.module.css:93 (--nm-danger-15)' },
    // 近实心红底 + 白字（chat 查看器关闭键）。
    { label: '#fff on danger 85%', fg: '#ffffff', bg: '--nm-danger', bgAlpha: 0.85, src: 'chats-rows.module.css:731' },
  ]

  /**
   * 允许差一点点的配对（**实测登记**，不是拍的容差）。
   *
   * 唯一的成员是 `Button.module.css:93`：15% danger 淡底 + danger 文字 = **4.45**，
   * 比 AA 的 4.5 差 **0.05**。按字面它算不达标，但：
   *   · 这是**深色端**，浅色端同一组合更高；
   *   · 差 0.05 在观感上不可分辨；
   *   · 真要压到 4.5 只能改 `--nm-danger` 的亮度，而那是**全局语义色**，
   *     会连带影响上面一条判据覆盖的一堆"文字色"用法。
   *
   * 所以这里登记实测下限（棘轮：只许升不许降），并把差多少写在旁边 ——
   * 而不是假装它达标，也不是为它去动全局令牌。
   */
  const BADGE_FLOOR: Record<string, number> = {
    'dark:danger on danger 15%': 4.45,
  }

  it('语义徽标（自色淡底 + 自色文字 / 实心底 + 白字）在两套主题下都过 AA（含登记下限）', () => {
    const fails: string[] = []
    const worse: string[] = []
    for (const [theme, css] of [['dark', DARK_CSS], ['light', DARK_CSS + '\n' + LIGHT_CSS]] as const) {
      const t = tokensOf(css)
      const cardBase = colorOf('--nm-bg-2', t)
      if (cardBase === null) { fails.push(`${theme}: bg-2 解析失败`); continue }
      for (const p of BADGE_PAIRS) {
        // 令牌若在本主题不存在（如 `--nm-success` 只在某一端定义），跳过而不是判失败。
        if (!t.has(p.bg)) continue
        const base = colorOf(p.bg, t)
        if (base === null) { fails.push(`${theme} ${p.label}: 底色解析失败`); continue }
        // alpha：一律用**调用点写死的值**（本表的 `bgAlpha`）。
        // ⚠️ 不要再去读令牌自身的 alpha：`--nm-danger-15` 那种令牌把 α 写在值里，
        // 若既把它当"颜色"又乘一次 bgAlpha，等于把透明度压了两遍（第一版踩过，算出假红 3.45）。
        const alpha = p.bgAlpha
        const composed = over([base[0], base[1], base[2], alpha], cardBase)
        const fg = colorOf(p.fg, t)
        if (fg === null) { fails.push(`${theme} ${p.label}: 前景解析失败`); continue }
        const r = contrast(fg, composed)
        const key = `${theme}:${p.label}`
        const floor = BADGE_FLOOR[key]
        if (floor !== undefined) {
          if (r < floor - 0.01) worse.push(`${key} = ${r.toFixed(2)} < 登记下限 ${floor.toFixed(2)}（出处 ${p.src}）`)
          continue
        }
        if (r < 4.5) fails.push(`${theme} ${p.label} (α=${alpha}) = ${r.toFixed(2)}  ← 出处 ${p.src}`)
      }
    }
    expect(fails, '语义徽标上的文字低于 AA（错误提示/危险按钮在某个主题下读不清）：\n  ' + fails.join('\n  ')).toEqual([])
    expect(worse, '已登记下限的徽标配对变得更差：\n  ' + worse.join('\n  ')).toEqual([])
  })

  it('反例自证：把 danger 换成接近白色的值，徽标判据必须红', () => {
    // 解析失效时上面的 AA 判据会恒绿 —— 这里用"底色改成近乎白色 + 白字"证明它真的在算。
    const broken = DARK_CSS + '\n' + LIGHT_CSS + '\n:root.theme-light { --nm-danger: #fefefe; }'
    const t = tokensOf(broken)
    const bg = colorOf('--nm-danger', t)
    expect(bg, '反例下 danger 解析失败').not.toBeNull()
    const white: [number, number, number] = [255, 255, 255]
    expect(contrast(white, bg as [number, number, number]), '白底白字却没被算成低对比 ⇒ 判据没咬住').toBeLessThan(1.2)
  })

  it('反例自证：把浅色文字令牌改成**接近底色**，必须判不通过', () => {
    // ⚠️ 第一版这里写成 `--nm-text-1: #ffffff`，结果反例**没咬住**（对比度算出来 99）——
    // 因为浅色端 `--nm-bg-2` 本来就是白色，白字配白底反而**最清楚**。
    // 反例必须取"与底同色"，所以这里先读出浅色端的 bg-2 实际值再拿它当文字色。
    const lightTokens = tokensOf(DARK_CSS + '\n' + LIGHT_CSS)
    const bg2 = resolve('--nm-bg-2', lightTokens)
    expect(bg2, '取不到浅色端 bg-2 ⇒ 反例构造失效').not.toBeNull()
    const broken = DARK_CSS + '\n' + LIGHT_CSS + `\n:root.theme-light { --nm-text-1: ${String(bg2)}; }`
    const brokenLight = grid('light-broken', broken)
    const key = 'text-1:bg-2'
    // 键必须真的存在：`undefined ?? 99` 这种兜底会让"没咬住"看起来像"咬住了"（本文件踩过）。
    expect(Object.keys(brokenLight), '反例的键不存在 ⇒ 下面的断言是空转').toContain(key)
    expect((brokenLight[key] ?? 99), '把文字改成与底同色后仍判达标 ⇒ 判据没咬住').toBeLessThan(1.1)
    // 确认它确实会掉出上面那条 AA 判据。
    expect((brokenLight[key] ?? 99) < 4.5, '反例没有触发 AA 判据 ⇒ 那条断言是空转').toBe(true)
  })
})
