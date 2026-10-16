/**
 * R3 聊天域边界 / dsw 别名层收编 的守卫。
 *
 * ## 背景
 *
 * `scifi-theme.css` 里并行着两套令牌：
 *   · `--nm-*`  —— NEON MATRIX，本项目自己的真源（700+ 引用）
 *   · `--dsw-*` —— 外部 UI 库（deepseek 系）的别名层，72 个
 *
 * 实测（`tools/r3-matrix.py`）发现：dsw 里 **25 个颜色令牌的深色值与本仓 `--nm-*`
 * 逐字相同** —— 但这是**巧合造成的重复定义**，不是转发：两处各自写了一遍字面量。
 * 浅色侧更明显 —— 19 个是独立调过的值。
 *
 * 重复定义的危害是**静默漂移**：改 `--nm-cyan-8` 时 dsw 侧不跟随，两套值慢慢分叉，
 * 而没人会收到报错。2026-09-28 定案：**dsw 颜色令牌一律转发到 nm**
 * （浅色外观随之对齐到 NEON MATRIX 浅色规范，属「视觉换新」的既定范围）。
 *
 * ## 守卫的三层
 *
 *  ① **硬编码色值必须清零** —— dsw 的**颜色**令牌里不许出现字面量色值，只能是
 *     `var(--nm-…)`。这是棘轮：`BARE_ALLOW` 只登记「非主题语义」的例外（见下）。
 *  ② **转发目标必须是语义对口的那一个** —— `--dsw-alias-brand-primary` 指向 `--nm-brand`
 *     而不是碰巧同值的 `--nm-cyan`；错指不会报错，只会在改调色板时错位。
 *  ③ **浅色侧不得重复定义** —— 既然转发到 nm，nm 的浅色值就是唯一真源；
 *     `light-theme.css` 里再写一遍 dsw 覆盖 = 又把重复定义请回来。
 *
 * ## 例外（`BARE_ALLOW`）的判据
 *
 * 只放「换主题时**本来就该**不动」的值进去，且逐条写明理由；放过一个就得说清为什么。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

function readNoComment(file: string): string {
  return readFileSync(join(HERE, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}

const dark = readNoComment('scifi-theme.css')
const light = readNoComment('light-theme.css')

/** 收一份 CSS 里的 `--xxx: value;` 声明（只认独立声明行，不含 `@property` 体内那行）。 */
function decls(css: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /^[ \t]*(--[a-z0-9-]+)[ \t]*:[ \t]*([^;{}]+);/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) out.set(m[1] as string, (m[2] as string).trim())
  return out
}

const D = decls(dark)
const L = decls(light)

const dswNames = [...D.keys()].filter(n => n.startsWith('--dsw-')).sort()
const lightDswNames = [...L.keys()].filter(n => n.startsWith('--dsw-')).sort()

/** 判「这个值是不是颜色」—— 用于把 dsw 里的字号 / 时长 / 阴影挑出去。 */
const NAMED = new Set([
  'white', 'black', 'transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'none',
])

function isColorish(v: string): boolean {
  const s = v.trim().toLowerCase()
  if (s.startsWith('#')) return true
  if (/^(rgb|hsl|oklch|lab|lch|color)\(/.test(s)) return true
  // 纯具名色（white / black / …），但排除 `13px/1.7 var(...)` 这类复合值
  if (NAMED.has(s)) return true
  // var() 链：交给下面单独判（`--dsw-*` 转发就是这种形态）
  return false
}

/** dsw 声明里，值是「颜色」的那些（不含 var() 转发；转发的单列出来）。 */
const dswColorLiterals = dswNames
  .map(n => [n, D.get(n) as string] as const)
  .filter(([, v]) => isColorish(v))

const dswVarForward = dswNames
  .map(n => [n, D.get(n) as string] as const)
  .filter(([, v]) => /^var\(\s*--nm-/.test(v))

/**
 * 例外清单：判据是「**非主题语义**」—— 换深浅色时本来就该保持原样的值。
 * 每多一条都要写清理由，否则守卫就成了摆设。
 */
const BARE_ALLOW = new Map<string, string>([
  // 蒙层 / 阴影：深浅两套都是「黑压一层」，不是品牌色，不该跟调色板走。
  ['--dsw-alias-bg-mask-1', '遮罩：深浅两套都压黑，非主题语义'],
  ['--dsw-shadow-lv3', '投影：深色是黑投影、浅色是低透明蓝灰，属阴影不是色板'],
  ['--dsw-elevation-prominent', '浮层投影，同上'],
  // 字号 / 时长：根本不是颜色，被 isColorish 挑出来是因为 `13px` 之类误伤；
  // 这条守卫只对「颜色」负责，所以它们既不算违规也不该进颜色集合。
  ['--dsw-font-xs-13', '字号，非颜色'],
  ['--dsw-mask-blur', '滤镜，非颜色'],
  // ── 外部 UI 库专属语义：本仓 nm 侧**没有对口令牌**，转发无处可去 ──
  // 判据：值在 nm 里找不到同义项（不是「找不到同值」——同值可以新增对口，
  // 但这些是 markdown 代码块 / tooltip / 静态色阶，nm 压根没有这类语义）。
  ['--dsw-alias-markdown-code-block-banner', 'markdown 代码块标题栏底色，nm 无对口'],
  ['--dsw-alias-markdown-code-block', 'markdown 代码块底色（与 --nm-bg-1 同值但语义独立）'],
  ['--dsw-alias-markdown-inline-code', '行内代码底色，nm 无对口'],
  ['--dsw-alias-tooltip-bg', 'tooltip 底色，nm 无对口'],
  ['--dsw-hovercard-bg', 'hovercard 底色，nm 无对口'],
  ['--dsw-specific-menu', '菜单浮层底色，nm 无对口'],
  ['--dsw-alias-bg-overlay', '玻璃层底色（桥接层 --nm-bg-glass 反过来优先取它）'],
  ['--dsw-alias-interactive-bg-hover-danger', '危险态 hover，nm 无对口（nm-danger 是对应色但非此 alpha）'],
  ['--dsw-static-deepseek-450', '外部库静态色阶，字面携带库身份，不该被主题改写'],
  ['--dsw-static-neutral-bluish-00', '外部库静态色阶，同上'],
  ['--dsw-alias-button-primary-fill', '外部库主按钮填充（#00c2d4），与 nm-brand 的 #00f0ff 是刻意区分的两档'],
])

/** 真正的违规：dsw 里还是**颜色字面量**，且不在例外清单里。 */
const bareViolations = dswColorLiterals
  .filter(([n]) => !BARE_ALLOW.has(n))
  .map(([n, v]) => `${n}: ${v}`)

/**
 * 语义映射表：dsw 令牌 → 它**该**转发到的 nm 令牌。
 *
 * 为什么不能「值相同就随便挑一个 nm」：`--dsw-alias-brand-primary` 与 `--nm-cyan`、
 * `--nm-brand` 三者同值，但只有 `--nm-brand` 是它的语义对口项。挑错的后果是
 * 「以后把品牌色从青改成别的，dsw 侧不跟随」—— 同样静默。
 */
const EXPECTED_FORWARD = new Map<string, string>([
  ['--dsw-alias-brand-primary', '--nm-brand'],
  ['--dsw-alias-link', '--nm-sky'],
  ['--dsw-alias-button-primary-hover', '--nm-sky'],
  ['--dsw-alias-border-l1', '--nm-cyan-8'],
  ['--dsw-alias-border-l2', '--nm-cyan-12'],
  ['--dsw-alias-border-l3', '--nm-cyan-25'],
  ['--dsw-alias-border-l4', '--nm-cyan-40'],
  ['--dsw-alias-button-ghost-active-border', '--nm-cyan-45'],
  ['--dsw-alias-button-ghost-active-fill', '--nm-cyan-12'],
  ['--dsw-alias-button-tool-bar-fill', '--nm-cyan-8'],
  ['--dsw-alias-button-tool-bar-hover', '--nm-cyan-14'],
  ['--dsw-alias-interactive-bg-active', '--nm-cyan-10'],
  ['--dsw-alias-interactive-bg-hover', '--nm-cyan-6'],
  ['--dsw-alias-scrollbar-hover-l2', '--nm-cyan-25'],
  ['--dsw-alias-bg-base', '--nm-bg-0'],
  ['--dsw-alias-bg-layer-0', '--nm-bg-0'],
  ['--dsw-alias-button-contrast-fill', '--nm-on-accent'],
  ['--dsw-alias-label-primary-foreground', '--nm-on-accent'],
  ['--dsw-alias-state-business-primary', '--nm-blue'],
  ['--dsw-alias-state-error-primary', '--nm-red'],
  ['--dsw-alias-state-success-primary', '--nm-green'],
  ['--dsw-alias-state-success-tertiary', '--nm-success-15'],
  ['--dsw-alias-state-warn-label', '--nm-amber'],
  ['--dsw-alias-state-warn-primary', '--nm-amber'],
  ['--dsw-alias-state-warn-tertiary', '--nm-warning-15'],
  // R3c：面层级 + 文字层级，深/浅值与本仓 nm 逐字一致，只是被桥接层掩盖过
  ['--dsw-alias-bg-layer-1', '--nm-bg-1'],
  ['--dsw-alias-bg-layer-2', '--nm-bg-2'],
  ['--dsw-alias-label-primary', '--nm-text-1'],
  ['--dsw-alias-label-primary-inverted', '--nm-text-1'],
  ['--dsw-alias-label-secondary', '--nm-text-2'],
  ['--dsw-alias-label-tertiary', '--nm-text-3'],
  ['--dsw-alias-label-caption', '--nm-text-2'],
  ['--dsw-alias-label-dimmed', '--nm-text-3'],
])

describe('R3 守卫：dsw 别名层不得自带色值（必须转发到 nm）', () => {
  it('哨兵：两套令牌都读到了（否则下面几条会恒绿）', () => {
    expect(dswNames.length).toBeGreaterThan(50)
    expect(D.get('--nm-cyan-8')).toBe('rgba(0, 240, 255, 0.08)')
    expect(L.size).toBeGreaterThan(80)
  })

  it('dsw 里没有裸颜色字面量（除登记例外）', () => {
    expect(
      bareViolations,
      '这些 dsw 令牌还在自带色值 ⇒ 与 nm 重复定义，改一边另一侧不跟随：\n' +
        bareViolations.join('\n'),
    ).toEqual([])
  })

  it('该转发的 25 个都在转发，且目标语义对口', () => {
    const wrong: string[] = []
    for (const [dsw, nm] of EXPECTED_FORWARD) {
      const v = D.get(dsw)
      if (v === undefined) {
        wrong.push(`${dsw} 不存在`)
        continue
      }
      const m = /^var\(\s*(--[a-z0-9-]+)/.exec(v)
      if (!m) {
        wrong.push(`${dsw} 没有转发（现值 ${v}）`)
        continue
      }
      if (m[1] !== nm) wrong.push(`${dsw} 转发到了 ${m[1]}，应为 ${nm}`)
    }
    expect(wrong, wrong.join('\n')).toEqual([])
  })

  it('转发目标必须真实存在（写了不存在的 nm 会整条降级成无效值）', () => {
    const missing = [...EXPECTED_FORWARD.values()].filter(nm => !D.has(nm))
    expect(missing, `转发到了不存在的令牌：${missing.join(', ')}`).toEqual([])
  })

  it('浅色侧不再重复定义这些 dsw（nm 的浅色值才是唯一真源）', () => {
    const dup = lightDswNames.filter(n => EXPECTED_FORWARD.has(n))
    expect(
      dup,
      '既然转发到了 nm，浅色侧就该由 nm 的浅色值说话；这里再写一遍 = 重复定义又回来了：\n' +
        dup.join('\n'),
    ).toEqual([])
  })

  it('例外清单不许空转（每条都还在文件里，否则是过期豁免）', () => {
    const stale = [...BARE_ALLOW.keys()].filter(n => !D.has(n))
    expect(stale, `已不存在的豁免项该删：${stale.join(', ')}`).toEqual([])
  })
})

describe('R3 守卫：桥接层不得反向依赖（否则两跳链把语义搅乱）', () => {
  /**
   * 这一条是 R3 踩出来的坑：`--dsw-alias-bg-base` 一度被转发到 `--nm-on-accent`
   * （「品牌色上的文字色」），而它的语义是「页面底色」。深色下两者**巧合同值**
   * `#050a18`，看不出问题；浅色下暴露 —— 底色该是 `#f6f8fb`，却成了 `#ffffff`。
   *
   * 根因是 nm 侧还保留着 `--nm-bg-0: var(--dsw-alias-bg-base, …)` 这条**反向桥接**，
   * 于是「底色」这个语义在两个方向上都有人定义，改哪一侧都可能错位。
   * 定案：**底色类真源放 nm 侧持字面量，dsw 单向下行转发**。这条守卫钉住这个方向。
   */
  const BRIDGE_FORBIDDEN = ['--nm-bg-0', '--nm-black']

  it('底色真源（nm-bg-0 / nm-black）直接持字面量，不再反向取 dsw', () => {
    const bad = BRIDGE_FORBIDDEN.filter(n => (D.get(n) ?? '').includes('var(--dsw-'))
    expect(
      bad,
      '底色真源又变回「优先取 dsw」了 —— 会与 dsw 的下行转发形成两跳链，语义偏移且难排查：\n' +
        bad.map(n => `${n}: ${D.get(n)}`).join('\n'),
    ).toEqual([])
  })

  it('底色类 dsw 的单向下行转发成立（没有闭环）', () => {
    for (const dsw of ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-0']) {
      const m = /^var\(\s*(--[a-z0-9-]+)/.exec(D.get(dsw) ?? '')
      expect(m, `${dsw} 应转发到 nm`).not.toBeNull()
      const target = m?.[1] as string
      expect(target, `${dsw} 转发目标不该是 nm-on-accent（那是「强调色上的文字」，语义不同）`)
        .not.toBe('--nm-on-accent')
      // 目标不得反向引用 dsw
      expect(D.get(target) ?? '', `${target} 不该反向引用 dsw（会成环）`).not.toContain('--dsw-')
    }
  })

  it('没有 `var(--x, var(--x))` 自引用 fallback（一旦主引用失效即 guaranteed-invalid）', () => {
    const SELF = /var\(\s*(--[a-z0-9-]+)\s*,\s*var\(\s*\1\s*[,)]/
    const bad = [...D.entries()].filter(([, v]) => SELF.test(v)).map(([n, v]) => `${n}: ${v}`)
    expect(bad, `自引用 fallback：\n${bad.join('\n')}`).toEqual([])
  })
})
