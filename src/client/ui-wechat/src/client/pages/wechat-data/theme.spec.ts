/**
 * 主题切换「颜色令牌级过渡」的回归用例。
 *
 * 这次改动的产物是一条**过渡**，而动画没法在 node 环境里跑起来（仓库没有 DOM 环境，
 * 见 M13/M14 的既定结论）。所以这里分三层守：
 *
 *  ① **能算的算清楚** —— 时长 / 缓动 / 状态机 / 降级路径都是纯逻辑，用真用例锁住。
 *     其中最重要的是**触发条件**：目标模式 === 当前模式时必须原地返回，
 *     否则一次点击会把过渡类的挂/摘跑两遍。
 *
 *  ② **接线与「不许回退」用源码断言锁**（本仓库对「只有运行期才有结论」的通用手法）：
 *       · **CSS 里的时长/缓动必须与 TS 常量一致** —— 不一致时不会报错，只会表现为
 *         「类挂 400ms 才摘，而颜色 0.15s 就变完了」这种半截过渡；
 *       · **过渡类要先挂、再改令牌** —— 顺序反了这次变化就没有过渡（判据看变更后样式）；
 *       · **不许再把 View Transitions 加回来** —— 它在窗口不可见时会被整段跳过、
 *         在「减少动效」下直接不播，两种都是**静默**退化成「没有过渡」。
 *
 *  ③ **令牌登记清单的守卫（本文件最重的一段）** —— 令牌级过渡的前提是「每个会随主题
 *     变化的颜色令牌都被注册成可插值颜色」。这里**静态重算**一遍清单并**双向**比对：
 *       · 主题文件里是颜色、清单里漏了 → 漏登记，该令牌切换时不渐变（静默降级）；
 *       · 清单里有、主题文件里不是颜色 → **误登记**，该令牌会变成 guaranteed-invalid，
 *         字体 / 阴影直接消失（这是真踩过的坑：`--dsw-font-family` 曾被误判成颜色）。
 *     两边都要守，因为两种错都不会报错、只在界面上表现为「某个东西不见了」。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getThemeMode,
  setThemeMode,
  subscribeThemeMode,
  THEME_TRANSITION_CLASS,
  THEME_TRANSITION_DURATION,
  THEME_TRANSITION_EASING,
  THEME_TRANSITION_REDUCED_DURATION,
  toggleThemeMode,
} from './theme.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 读源码并去掉注释 —— 注释里为「记录历史」提到旧写法会让断言误判。 */
function codeOf(file: string): string {
  const src = readFileSync(join(HERE, file), 'utf8')
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n')
}

const themeSrc = codeOf('theme.ts')

/** CSS 同样先去注释：说明文字里会提到 `transform`、`background-image` 这些「不在范围内」的名字。 */
function cssNoComment(file: string): string {
  return readFileSync(join(HERE, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}

const rawCss = cssNoComment('scifi-theme.css')
const lightCss = cssNoComment('light-theme.css')
/** 压平空白，免得断言被换行/缩进写法绑死。 */
const cssFlat = rawCss.replace(/\s+/g, ' ')

/** 取出 `.theme-transition` 那条规则本身的文本（到配对的 `}` 为止）。 */
function ruleText(css: string, selector: string): string {
  const start = css.indexOf(selector)
  if (start < 0) return ''
  const open = css.indexOf('{', start)
  let depth = 1
  let i = open + 1
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') depth--
    i++
  }
  return css.slice(open + 1, i - 1)
}

const rule = ruleText(rawCss, `:root.${THEME_TRANSITION_CLASS} {`)

/** 模块级主题状态是全局的，用例之间要复位（node 下不碰 localStorage，无磁盘副作用）。 */
beforeEach(() => {
  if (getThemeMode() !== 'dark') setThemeMode('dark')
})

describe('时长 / 缓动 / 触发条件：观感契约', () => {
  it('时长落在「看得出来在过渡、又不像卡住」的区间', () => {
    // < 250ms 只像闪一下；> 700ms 整页都在慢慢褪色，会让人以为界面没反应过来
    expect(THEME_TRANSITION_DURATION).toBeGreaterThanOrEqual(250)
    expect(THEME_TRANSITION_DURATION).toBeLessThanOrEqual(700)
  })

  it('「减少动效」仍然是过渡，只是更短 —— 不是 0', () => {
    // 0 会把降级路径变回「硬跳」，而硬跳正是这次要修的现象
    expect(THEME_TRANSITION_REDUCED_DURATION).toBeGreaterThan(0)
    expect(THEME_TRANSITION_REDUCED_DURATION).toBeLessThan(THEME_TRANSITION_DURATION)
  })

  it('缓动是先快后慢的 ease-out 系', () => {
    expect(THEME_TRANSITION_EASING).toMatch(/^cubic-bezier\(/)
    const nums = THEME_TRANSITION_EASING.match(/-?\d*\.?\d+/g)?.map(Number) ?? []
    expect(nums).toHaveLength(4)
    const [, y1, , y2] = nums
    // 两个控制点的 y 都落在终点一侧 → 曲线先冲出去再收尾
    expect(y1).toBeGreaterThan(0.5)
    expect(y2).toBeGreaterThanOrEqual(1)
  })
})

describe('无 DOM 环境（node / SSR）下的切换：同步生效、不留异步尾巴', () => {
  it('默认深色', () => {
    expect(getThemeMode()).toBe('dark')
  })

  it('切换会同步生效并通知订阅者', () => {
    const seen: string[] = []
    const off = subscribeThemeMode(() => { seen.push(getThemeMode()) })
    toggleThemeMode()
    // 同步：调用返回时订阅者已经收到新值（没有等动画的地方）
    expect(getThemeMode()).toBe('light')
    expect(seen).toEqual(['light'])
    off()
  })

  it('退订后不再收到通知', () => {
    const fn = vi.fn()
    const off = subscribeThemeMode(fn)
    off()
    toggleThemeMode()
    expect(fn).not.toHaveBeenCalled()
  })

  it('同一个模式重复设置不会重复通知（一次点击只触发一次过渡）', () => {
    const fn = vi.fn()
    const off = subscribeThemeMode(fn)
    setThemeMode('dark')
    expect(fn).not.toHaveBeenCalled()
    off()
  })

  it('非法模式被忽略', () => {
    setThemeMode('sepia' as unknown as 'dark')
    expect(getThemeMode()).toBe('dark')
  })

  it('没有 document 时不会残留「稍后再提交」的异步副作用', async () => {
    toggleThemeMode()
    const after = getThemeMode()
    await Promise.resolve()
    await new Promise((r) => { setTimeout(r, 0) })
    expect(getThemeMode()).toBe(after)
  })
})

describe('CSS 与 TS 的常量必须一致（不一致只会表现为「半截过渡」，不报错）', () => {
  it('规则的时长与缓动都来自 TS 常量', () => {
    expect(rule).toContain(`transition-duration: ${THEME_TRANSITION_DURATION}ms`)
    expect(rule).toContain(`transition-timing-function: ${THEME_TRANSITION_EASING}`)
  })

  it('减少动效分支存在，且把时长缩短到 THEME_TRANSITION_REDUCED_DURATION', () => {
    expect(cssFlat).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
    expect(cssFlat).toContain(`transition-duration: ${THEME_TRANSITION_REDUCED_DURATION}ms`)
  })

  it('过渡对象是「令牌名」，不是 CSS 属性名', () => {
    // 这是与上一版的根本差别：上一版列 background-color / color 这类属性名，
    // 于是文档里每个元素都要各建一条过渡（color 是继承属性 → 880 个），实测卡顿 265ms。
    // 取法必须与下面「transition-property 列的就是这批令牌」用例一致：
    // 规则体内文以 `transition-property:` 开头，直接 split(';')[0] 会把声明名本身当成第一个 token。
    const declared = (ruleText(rawCss, `:root.${THEME_TRANSITION_CLASS} {`)
      .match(/transition-property:\s*([^;]+);/)?.[1] ?? '')
      .split(',').map(s => s.trim()).filter(Boolean)
    expect(declared.length).toBeGreaterThan(0)
    for (const prop of declared) {
      expect(prop.startsWith('--')).toBe(true)
    }
    // 反例防守：如果哪天写回 CSS 属性名（background-color / color），这条会转红。
    for (const notToken of ['background-color', 'color', 'border-color', 'fill', 'stroke']) {
      expect(declared).not.toContain(notToken)
    }
  })

  it('范围边界：不许回到「元素级选择器」那条老路', () => {
    // `:root.theme-transition *` 这种写法会命中 880 个元素各建一条 color 过渡，
    // 实测累计卡顿 265ms、400ms 内只渲染出 7 个色阶 —— 正是这次改掉的东西。
    expect(rawCss).not.toContain(`:root.${THEME_TRANSITION_CLASS} *`)
    expect(rawCss).not.toContain(`:root.${THEME_TRANSITION_CLASS} ::before`)
    // 也不许出现 CSS 属性名的元素级过渡
    expect(rule).not.toMatch(/\b(background-color|border-color|outline-color|box-shadow|caret-color)\s+\d/)
  })

  it('范围边界：不顺手动画位移/透明/渐变', () => {
    // transform 与 opacity 进过渡会让整页在换主题时整体位移/闪烁；
    // background-image 根本插值不了（CSS 无法在两个渐变之间插值），写了也只会在终点突变。
    expect(rule).not.toMatch(/\btransform\b/)
    expect(rule).not.toMatch(/\bopacity\b/)
    expect(rule).not.toContain('background-image')
    expect(rule).not.toMatch(/\ball\b/)
  })
})

/* ── 令牌清单：静态重算 + 双向比对 ─────────────────────────────────────────── */

/** 抽出 `--token: value;` 声明（后出现的覆盖先出现的，与同层同级联一致）。 */
function tokenMap(css: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+);/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) out.set(m[1], m[2].replace(/\s+/g, ' ').trim())
  return out
}

/** 按顶层逗号切分（忽略括号内的逗号）。 */
function splitTopCommas(inner: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of inner) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) { parts.push(cur); cur = '' } else { cur += ch }
  }
  parts.push(cur)
  return parts.map(s => s.trim())
}

/**
 * 把值里的 `var()` 用深色定义递归替换掉，直到只剩字面量。
 * 解不动（循环 / 目标不存在且无兜底）就原样留着 —— 后面会因「含 var()」被判为非颜色。
 */
function subst(value: string, dark: Map<string, string>, seen: Set<string>): string {
  let out = ''
  let i = 0
  while (i < value.length) {
    const rel = value.slice(i).search(/var\s*\(/)
    if (rel < 0) { out += value.slice(i); break }
    const start = i + rel
    out += value.slice(i, start)
    const open = value.indexOf('(', start)
    let j = open + 1
    let depth = 1
    while (j < value.length && depth > 0) {
      if (value[j] === '(') depth++
      else if (value[j] === ')') depth--
      j++
    }
    const inner = value.slice(open + 1, j - 1)
    const parts = splitTopCommas(inner)
    const ref = parts[0]
    const fallback = parts.length > 1 ? parts.slice(1).join(',').trim() : null
    let got: string | null = null
    if (ref.startsWith('--') && !seen.has(ref) && dark.has(ref)) {
      got = subst(dark.get(ref) as string, dark, new Set([...seen, ref]))
    }
    if (got === null && fallback) got = subst(fallback, dark, seen)
    out += got === null ? value.slice(start, j) : got
    i = j
  }
  return out.replace(/\s+/g, ' ').trim()
}

const NAMED_COLORS = new Set([
  'transparent', 'currentcolor', 'black', 'white', 'red', 'green', 'blue',
  'cyan', 'magenta', 'yellow', 'gray', 'grey', 'silver', 'maroon', 'navy',
  'teal', 'olive', 'lime', 'aqua', 'fuchsia', 'purple', 'orange',
])

/**
 * 值解析到底之后是不是「一个颜色」。
 *
 * ⚠ 这个判定必须保守：误判为颜色的代价是**界面直接坏掉**（注册 <color> 后值非法 →
 * guaranteed-invalid → 字体/阴影消失），漏判的代价只是「这个令牌切换时不渐变」。
 * 所以只要还含未解析的 `var()`、或颜色函数前面还挂着别的值（`0 0 8px rgba(…)` 是阴影），
 * 一律判非颜色。
 */
function isColorValue(v: string): boolean {
  if (!v) return false
  if (v.includes('var(')) return false
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return true
  if (/^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\(/.test(v)) return true
  return NAMED_COLORS.has(v.toLowerCase())
}

const darkTokens = tokenMap(rawCss)
const lightTokens = tokenMap(lightCss)
const registered = (() => {
  const out = new Set<string>()
  const re = /^@property\s+(--[A-Za-z0-9_-]+)\s*\{[^}]*syntax:\s*'<color>'/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(rawCss)) !== null) out.add(m[1])
  return out
})()

/** 主题文件里「解析到底是颜色」的令牌 —— 这才是应该被登记的那一批。 */
const expectedColorTokens = (() => {
  const out = new Set<string>()
  for (const name of new Set([...darkTokens.keys(), ...lightTokens.keys()])) {
    const dv = darkTokens.get(name)
    const lv = lightTokens.get(name)
    const rd = dv === undefined ? '' : subst(dv, darkTokens, new Set([name]))
    const rl = lv === undefined ? '' : subst(lv, darkTokens, new Set([name]))
    if (isColorValue(rd) || isColorValue(rl)) out.add(name)
  }
  return out
})()

describe('令牌登记清单：静态重算 + 双向比对', () => {
  it('解析本身没坏（否则上面两条「双向为空」会假绿）', () => {
    expect(darkTokens.size).toBeGreaterThan(100)
    expect(lightTokens.size).toBeGreaterThan(50)
    expect(expectedColorTokens.size).toBeGreaterThan(60)
    // 已知的三个代表：一个直接颜色、一个 var() 链、一个 color-mix
    expect(expectedColorTokens.has('--nm-cyan')).toBe(true)
    expect(expectedColorTokens.has('--nm-bg-0')).toBe(true)
    expect(expectedColorTokens.has('--nm-cyan-text')).toBe(true)
    // 已知的**不该**被判成颜色的：字体令牌（真踩过：误注册会让字体失效）
    expect(expectedColorTokens.has('--dsw-font-family')).toBe(false)
    expect(expectedColorTokens.has('--nm-glow-sm')).toBe(false)
  })

  it('漏登记 = 该令牌切换时不渐变（静默降级）', () => {
    const missing = [...expectedColorTokens].filter(n => !registered.has(n)).sort()
    expect(missing).toEqual([])
  })

  it('误登记 = 该令牌变成 guaranteed-invalid，字体/阴影会整块消失', () => {
    const extra = [...registered].filter(n => !expectedColorTokens.has(n)).sort()
    expect(extra).toEqual([])
  })

  it('每条 @property 的 initial-value 都是计算无关的字面量（含 var() 会让整条规则失效）', () => {
    const re = /^@property\s+(--[A-Za-z0-9_-]+)\s*\{([^}]*)\}/gm
    let m: RegExpExecArray | null
    let n = 0
    while ((m = re.exec(rawCss)) !== null) {
      n++
      const body = m[2]
      expect(body).toContain("syntax: '<color>'")
      expect(body).toContain('inherits: true')
      const ini = /initial-value:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? ''
      expect(ini).not.toBe('')
      expect(ini).not.toContain('var(')
      expect(isColorValue(ini)).toBe(true)
    }
    expect(n).toBe(registered.size)
  })

  it('transition-property 列的就是这批令牌，不多不少也不重复', () => {
    const list = (ruleText(rawCss, `:root.${THEME_TRANSITION_CLASS} {`)
      .match(/transition-property:\s*([^;]+);/)?.[1] ?? '')
      .split(',').map(s => s.trim()).filter(Boolean)
    expect(list.length).toBe(new Set(list).size)
    expect([...list].sort()).toEqual([...registered].sort())
  })

  it('深浅两套的令牌是「浅色覆盖深色」的关系（浅色里冒出新令牌时，登记清单要跟着重算）', () => {
    const onlyLight = [...lightTokens.keys()].filter(n => !darkTokens.has(n)).sort()
    // 允许为空；一旦不为空，说明浅色主题引入了深色里没有的令牌 —— 必须确认它是否该被登记。
    expect(Array.isArray(onlyLight)).toBe(true)
    // 反过来：浅色的每一项都要能在深色里找到同名覆盖，否则 initial-value（取深色值）会失真
    expect([...lightTokens.keys()].filter(n => !darkTokens.has(n))).toEqual([])
  })
})

describe('不许把 View Transitions 那套再加回来（静默退化成「没有过渡」）', () => {
  it('theme.ts 里没有 startViewTransition / clipPath', () => {
    // 窗口不可见（hidden）时 Chromium 会整段跳过 View Transition，ready 被拒；
    // 「减少动效」时旧实现直接切换不做动画 —— 两种都是没过渡，且都不报错。
    expect(themeSrc).not.toContain('startViewTransition')
    expect(themeSrc).not.toContain('clipPath')
    expect(themeSrc).not.toContain('view-transition')
  })

  it('CSS 里没有 ::view-transition-* 残留', () => {
    expect(cssFlat).not.toContain('::view-transition')
    expect(cssFlat).not.toContain('mix-blend-mode')
  })

  it('先挂过渡类、后改令牌 —— 顺序反了这次变化就不会起过渡', () => {
    const add = themeSrc.indexOf('classList.add(THEME_TRANSITION_CLASS)')
    const commit = themeSrc.indexOf('apply(mode)')
    expect(add).toBeGreaterThan(-1)
    expect(commit).toBeGreaterThan(add)
  })

  it('摘类的定时器按过渡时长算，且带一帧余量', () => {
    // 按更短的一档去摘（例如减少动效那 120ms）会在过渡中途把类摘掉、把尾巴砍断
    expect(themeSrc).toContain('THEME_TRANSITION_DURATION + THEME_TRANSITION_LINGER')
  })

  it('类名带 theme- 前缀（与 theme-light 并排时一眼看出是同一套机制）', () => {
    expect(THEME_TRANSITION_CLASS.startsWith('theme-')).toBe(true)
    expect(cssFlat).toContain(`.${THEME_TRANSITION_CLASS}`)
  })
})

describe('三处主题按钮的接线', () => {
  const onboarding = readFileSync(
    join(HERE, '..', '..', '..', '..', '..', 'ui-app', 'onboarding', 'OnboardingShell.tsx'),
    'utf8',
  )

  it('侧栏那枚', () => {
    const src = codeOf('WechatDataPanel.tsx')
    expect(src).toContain('toggleThemeMode')
    expect(src).not.toContain('revealOriginFromEvent')
  })

  it('图谱控制栏那枚', () => {
    const src = codeOf('panels/Graph.tsx')
    expect(src).toContain('toggleThemeMode')
    expect(src).not.toContain('revealOriginFromEvent')
  })

  it('启动引导页那枚', () => {
    expect(onboarding).toContain('toggleThemeMode')
    expect(onboarding).not.toContain('revealOriginFromEvent')
  })
})
