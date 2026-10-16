/**
 * 微信复刻皮肤（`--wx-*`）的对比度门禁。
 *
 * ## 为什么单独一份（`theme-contrast.guard.spec.ts` 管不到这一层）
 *
 * 那份守卫算的是 `--nm-*`（本项目自己的令牌体系：9 对正文×底 + 语义色 + 徽标）。
 * 但聊天区还有**另一套配色** `--wx-*`，取的是**微信官方客户端的精确色值**
 * （`chats-rows.module.css:126-129` 注释原文："自方 #3EB575 / 对方 #2E2E2E 落在 #191919 底上。
 * 浅色端的精确值在下面的 `:global(.theme-light)` 块里覆盖"）。
 *
 * ⇒ **这一层完全不参与令牌判据**：它写错时 `--nm-*` 那 10 个用例照样全绿。
 * 2026-09-29 第 75 轮就是靠**人工扫描**才发现的（53 个面板 CSS、228 处硬编码颜色），
 * 本文件把那次的结论固化成常驻判据。
 *
 * ## 判据口径（重要：这里**不是**"全部过 AA"）
 *
 * 深色端「自方气泡白字压官方绿」实测 **2.60，低于 AA** —— 这是**有意的保真取舍**
 * （`#3eb575` 是微信官方色，加深就背离"复刻原生外观"这个模块目标）。
 * 所以对它的口径是**棘轮**：**只许不变差**（登记下限 2.60），不是"必须达标"。
 * 其余各对必须过 AA。
 *
 * ## 2026-09-29 扩展：未读徽标（白字 on 官方红 `#fa5151`）
 *
 * 真机多采样（`scripts/theme-live-audit.mjs -- --all-tabs`）在「聊天会话」量到
 * **白字 on `rgb(250,81,81)` = 3.30**。查证：`--wx-unread: #fa5151` 是**微信官方未读徽标红**，
 * 白字也是官方口径（`chats.module.css:56` 逐字记着"微信口径 —— #FA5151 纯色、无发光、
 * 18px 高、圆角 9px、12px 字"）。⇒ 与自方气泡绿**同一类**取舍：走棘轮，不走 AA。
 * 它**两套主题同值**（官方红不随主题变），所以两条下限都登记。
 * 这一条此前**不在**任何判据里：`--wx-*` 那 3 对里没有它，真机单点采样也从没采到过它。
 *
 * @module pages/wechat-data/wx-skin-contrast.guard
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
/** 皮肤所在的 CSS Modules 文件（相对本 spec）。 */
const CSS_REL = 'panels/chats-rows.module.css'

/** 读出 CSS 全文。 */
function cssText (name = CSS_REL): string {
  return readFileSync(join(HERE, name), 'utf8')
}

/**
 * 从一段 CSS 里抽自定义属性，**同名只取第一次出现的值**。
 *
 * ⚠️ 为什么不能"后者覆盖前者"（第一版就是这么错的）：`--wx-*` 在两套主题里
 * **声明了两遍**（深色端一次、`:global(.theme-light)` 里再覆盖一次）。
 * 若用 `Map.set` 让后者胜出，那么按"深色段"切出来的文本里只要**混进**了浅色端的声明，
 * 拿到的就是浅色的值 —— 实测症状是「对方气泡文字 on 会话底」算出 **1.07**
 * （浅色字 `#f5f5f5` 配浅色底 `#ededed`），看起来像"深色端严重不达标"，其实是取值取错了。
 * 所以这里取**首次**声明：切出哪一段，就只看那一段里最先写下的值。
 * @param text - CSS 片段。
 * @returns 变量名 → 值（已 trim）。
 */
/**
 * 从一段 CSS 里抽十六进制自定义属性。
 *
 * ⚠️ 三个坑都是第一版踩过的，注释留在这里免得再犯：
 *
 * ① **不能把"使用处"当"声明处"**：`background: var(--wx-chat-bg);`（`:125`）也会被
 *    朴素正则命中，把值抓成 `)` —— 症状是「对方气泡文字 on 会话底」算出 **1.20**，
 *    看着像严重不达标，其实是取值取错 ⇒ 要求值**以 `#` 开头**。
 * ② **块里最后一条声明可能没有分号** ⇒ 分号必须**可选**。
 * ③ **同一声明在文件里出现多次**（`--wx-*` 在两套主题、甚至多个浅色块里各写一遍）。
 *    第一版想靠"锚点 + 切片"分出两套主题，结果切点选在了**第二个**浅色块上，
 *    把 `--wx-chat-bg: #ededed` 切到了深色段里 ⇒ 浅色端解析成 undefined。
 *    ⇒ 改用 CSS 真正的层叠语义：**同名的取最后一条**（后写的覆盖先写的）。
 *    于是"文件全文"就是浅色端，"只看第一处声明"就是深色端的基值。
 * @param text - CSS 片段。
 * @param firstOnly - true 时取每名的**首次**声明（用于深色端基值）。
 * @returns 变量名 → 十六进制值（已 trim）。
 */
function varsOf (text: string, firstOnly = false): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of text.matchAll(/(--wx-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;?/g)) {
    const name = m[1]
    const value = m[2]
    // 正则里两个组都是必选，所以这里理论上拿得到；显式判空是为了让 TS 收窄类型
    // （`noUncheckedIndexedAccess` 下 `m[1]` 的类型是 `string | undefined`）。
    if (name === undefined || value === undefined) continue
    if (firstOnly && out.has(name)) continue
    out.set(name, value.trim())
  }
  return out
}

/**
 * 按 CSS 层叠语义解析出两套主题的取值。
 *
 * **不用"锚点 + 切片"**（第一版那样做错了三次，见 `varsOf` 的注释③）：
 * `--wx-*` 在文件里被声明多遍（深色端一次、浅色端若干次），
 * 而**后写的覆盖先写的**就是 CSS 的真正语义。所以：
 *   · **深色端** = 每个变量**第一次**出现的值（浅色覆盖还没生效）；
 *   · **浅色端** = 每个变量**最后一次**出现的值（覆盖已生效）。
 * 这样不需要猜"哪个块属于哪个主题"，也不会因为多一个浅色块就把切点算错。
 *
 * 解析失败要**显式抛**，不能返回空表让下游断言"因为没数据而通过"。
 * @param text - CSS 全文。
 * @returns 深色端与浅色端的变量表。
 */
function themesOf (text: string): { dark: Map<string, string>, light: Map<string, string> } {
  const dark = varsOf(text, true)
  const light = varsOf(text, false)
  for (const name of ['--wx-chat-bg', '--wx-bubble-self', '--wx-bubble-other', '--wx-on-self', '--wx-on-other', '--wx-unread']) {
    if (!dark.has(name) || !light.has(name)) {
      throw new Error(`皮肤变量 ${name} 解析不到（深色=${String(dark.get(name))} 浅色=${String(light.get(name))}）—— 皮肤结构调整了，请同步本守卫`)
    }
  }
  return { dark, light }
}

/** `#rgb` / `#rrggbb` → [r,g,b]。 */
function hexToRgb (v: string): [number, number, number] | null {
  let s = v.trim()
  if (/^#[0-9a-f]{3}$/i.test(s)) s = '#' + s.slice(1).split('').map((c) => c + c).join('')
  if (!/^#[0-9a-f]{6}$/i.test(s)) return null
  return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)]
}

/** WCAG 相对亮度。 */
function luminance ([r, g, b]: [number, number, number]): number {
  const f = (c: number): number => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/** WCAG 对比度（1..21）。 */
function contrast (a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = luminance(a) >= luminance(b) ? [luminance(a), luminance(b)] : [luminance(b), luminance(a)]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * 从变量表里取一个颜色；取不到就抛（避免"缺值 = 通过"）。
 * @param vars - 变量表。
 * @param name - 变量名。
 * @returns RGB 三元组。
 */
function colorOf (vars: Map<string, string>, name: string): [number, number, number] {
  const raw = vars.get(name)
  const rgb = raw === undefined ? null : hexToRgb(raw)
  if (rgb === null) throw new Error(`${name} 不是可解析的十六进制颜色（实际 ${String(raw)}）`)
  return rgb
}

/**
 * 算一套主题里若干"文字 on 底"组合的对比度。
 * @param v - 该主题的变量表。
 * @returns 组合名 → 对比度。
 */
function pairsOf (v: Map<string, string>): Record<string, number> {
  const out: Record<string, number> = {}
  out['对方气泡文字 on 对方气泡'] = contrast(colorOf(v, '--wx-on-other'), colorOf(v, '--wx-bubble-other'))
  out['对方气泡文字 on 会话底'] = contrast(colorOf(v, '--wx-on-other'), colorOf(v, '--wx-chat-bg'))
  out['自方气泡文字 on 自方气泡'] = contrast(colorOf(v, '--wx-on-self'), colorOf(v, '--wx-bubble-self'))
  // 未读徽标：底是 `--wx-unread`，文字在 CSS 里是硬编码 `#fff`（官方口径，不是变量）
  // ⇒ 这里显式取白，避免"解析不到变量就悄悄少一对"。
  out['未读徽标白字 on 徽标红'] = contrast(hexToRgb('#ffffff') as [number, number, number], colorOf(v, '--wx-unread'))
  return out
}

const CSS_ALL = cssText()
const THEMES = themesOf(CSS_ALL)

/**
 * 登记下限（棘轮）：**只许不变差**。
 *
 * · `自方气泡文字 on 自方气泡` 深色端 **2.60** —— 微信官方绿 `#3eb575` + 白字，有意的保真取舍。
 *   浅色端 14.48 达标，所以浅色表里没有它。
 * · `未读徽标白字 on 徽标红` **两套主题都是 3.30** —— 微信官方未读红 `#fa5151` + 白字。
 *   颜色不随主题变（官方皮肤就是这样），所以两条都登记。
 *
 * ⚠️ 这个表**只许变短**：一旦某条 ≥4.5，下面"例外必须仍然是例外"那条会红。
 */
const FLOORS: Record<'dark' | 'light', Record<string, number>> = {
  dark: {
    '自方气泡文字 on 自方气泡': 2.6,
    '未读徽标白字 on 徽标红': 3.3,
  },
  light: {
    '未读徽标白字 on 徽标红': 3.3,
  },
}

describe('微信复刻皮肤（--wx-*）的对比度门禁', () => {
  it('哨兵：两套主题都解析出了 4 对（否则下面的断言是空转）', () => {
    const d = pairsOf(THEMES.dark)
    const l = pairsOf(THEMES.light)
    expect(Object.keys(d)).toHaveLength(4)
    expect(Object.keys(l)).toHaveLength(4)
    for (const v of [...Object.values(d), ...Object.values(l)]) {
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThan(1)
      expect(v).toBeLessThanOrEqual(21)
    }
  })

  it('两套主题解析出的取值**确实不同**（若相同说明层叠解析失效、下面的断言会变成同一条）', () => {
    // ⚠️ `--wx-unread` **刻意不在**这张表里：官方未读红本身就不随主题变，
    // 把它写进来会让这条断言永远红（"必须是差异"是给随主题变的变量用的）。
    const same = ['--wx-chat-bg', '--wx-bubble-self', '--wx-bubble-other', '--wx-on-self', '--wx-on-other']
      .filter((n) => THEMES.dark.get(n) === THEMES.light.get(n))
    expect(same, `这些变量在两套主题里解析成了同一个值：${same.join(', ')}`).toEqual([])
  })

  it('浅色端除登记例外外全部过 WCAG AA（4.5）', () => {
    const l = pairsOf(THEMES.light)
    for (const [name, cr] of Object.entries(l)) {
      const floor = FLOORS.light[name]
      if (floor === undefined) {
        expect(cr, `浅色端「${name}」对比度 ${cr.toFixed(2)} 低于 AA`).toBeGreaterThanOrEqual(4.5)
      } else {
        expect(cr, `浅色端「${name}」跌破了登记下限 ${String(floor)}`).toBeGreaterThanOrEqual(floor)
      }
    }
  })

  it('深色端除登记例外外全部过 AA；例外按棘轮只许不变差', () => {
    const d = pairsOf(THEMES.dark)
    for (const [name, cr] of Object.entries(d)) {
      const floor = FLOORS.dark[name]
      if (floor === undefined) {
        expect(cr, `深色端「${name}」对比度 ${cr.toFixed(2)} 低于 AA`).toBeGreaterThanOrEqual(4.5)
      } else {
        expect(cr, `深色端「${name}」跌破了登记下限 ${String(floor)}`).toBeGreaterThanOrEqual(floor)
      }
    }
  })

  it('登记例外必须**仍然**是例外（否则说明它已达标，该从 FLOORS 里删掉）', () => {
    const d = pairsOf(THEMES.dark)
    const l = pairsOf(THEMES.light)
    for (const name of Object.keys(FLOORS.dark)) {
      // 若哪天它 >= 4.5 了，说明有人改好了 —— 那就删下限、改走"必须过 AA"那条
      expect(d[name], `深色端「${name}」已达标，请把 FLOORS.dark 里的这一项删掉`).toBeLessThan(4.5)
    }
    for (const name of Object.keys(FLOORS.light)) {
      expect(l[name], `浅色端「${name}」已达标，请把 FLOORS.light 里的这一项删掉`).toBeLessThan(4.5)
    }
  })

  it('反例自证：深色底换成浅色，判据必须红', () => {
    // 用**构造的变量表**而不是"字符串替换真文件"：替换法依赖"文件里恰好只出现一次该声明"，
    // 一旦有多处（`--wx-*` 正是如此）就会替换错地方，反例本身变成假绿。
    const broken = new Map(THEMES.dark)
    broken.set('--wx-chat-bg', '#f2f2f2')
    const d = pairsOf(broken)
    expect(d['对方气泡文字 on 会话底']).toBeLessThan(4.5)
  })

  it('反例自证：把自方气泡绿调亮，白字对比度必须跌破登记下限', () => {
    // 深色端文字是 #ffffff；把气泡绿提亮 ⇒ 白字压亮绿，对比度跌破 2.6
    // （第一版往**暗**调，反而把对比度提到了 6.32 —— 方向搞反了）
    const broken = new Map(THEMES.dark)
    broken.set('--wx-bubble-self', '#a8e6b0')
    const d = pairsOf(broken)
    expect(d['自方气泡文字 on 自方气泡']).toBeLessThan(FLOORS.dark['自方气泡文字 on 自方气泡'] as number)
  })

  it('反例自证：把未读徽标红调亮，白字对比度必须跌破登记下限', () => {
    // 白字压红底：红越亮 ⇒ 对比度越低。`#ff9a9a` 实测约 2.0 < 3.3。
    const broken = new Map(THEMES.light)
    broken.set('--wx-unread', '#ff9a9a')
    const l = pairsOf(broken)
    expect(l['未读徽标白字 on 徽标红']).toBeLessThan(FLOORS.light['未读徽标白字 on 徽标红'] as number)
  })

  it('反例自证：解析器必须拒绝"只有使用处、没有声明处"的字段（否则会把 `)` 当颜色）', () => {
    // `background: var(--wx-chat-bg);` 这种"使用处"必须**不被**当成声明
    const v = varsOf('background: var(--wx-chat-bg);\n--wx-chat-bg: #123456;')
    expect(v.get('--wx-chat-bg')).toBe('#123456')
    const only = varsOf('background: var(--wx-chat-bg);')
    expect(only.has('--wx-chat-bg')).toBe(false)
  })
})
