/**
 * R1 令牌层守卫：alpha 阶梯 + 中性色阶第四档 + 品牌身份色。
 *
 * 背景 A。R1 加了一批令牌，
 * 目的是把散落的裸色（`rgba(0, 240, 255, 0.1)` 裸写 22+ 处、`#94a3b8`、
 * `#64748b` 等）收敛到有名字的档位上，供 R2 的前置门改造使用。
 *
 * 本文件**不重复** `theme.spec.ts` 的双向登记守卫（那条已经保证「新增颜色令牌
 * 必须同步进 @property + transition-property」），只钉 R1 自己的契约：
 *   ① alpha 阶梯**完整且单调**（缺档会让 R2 找不到落点，退回去写裸色）；
 *   ② 每个 alpha 档的深色值就是 `rgba(0,240,255,α)`，与档位名一一对应
 *      （防止「加了令牌却填错值」——那种错 100% 静默）；
 *   ③ 浅色主题对每一档都有覆盖，且色相换成压暗后的 `rgba(8,145,178,·)`
 *      （沿用 light-theme.css 既有的「保色相、调明度」口径）；
 *   ④ `--nm-text-4` / `--nm-brand` 深浅两套都在。
 *
 * 哨兵：先断言解析到的令牌数下限，防「扫描路径配错 → 一条都没读到 → 恒绿」。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

function read(file: string): string {
  return readFileSync(join(HERE, file), 'utf8')
}
/** 去注释后压平空白（结论只管「值是什么」，与换行/缩进无关）。 */
function flatNoComment(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ')
}

const dark = flatNoComment(read('scifi-theme.css'))
const light = flatNoComment(read('light-theme.css'))

/** 取令牌在**深色** `:root` 里的声明值（第一个匹配；注释已剥）。
 *  令牌名后接 `\s*:`，靠 `:` 收口 —— 避免 `--nm-cyan-4` 命中 `--nm-cyan-40` 的前缀。 */
function darkValue(name: string): string | null {
  const re = new RegExp(`${name}\\s*:\\s*([^;{}]+);`)
  return re.exec(dark)?.[1]?.trim() ?? null
}
function lightValue(name: string): string | null {
  const re = new RegExp(`${name}\\s*:\\s*([^;{}]+);`)
  return re.exec(light)?.[1]?.trim() ?? null
}

describe('R1/R2 令牌层：alpha 阶梯', () => {
  /** 档位 → 深色 alpha（百分数）。顺序即阶梯顺序，必须单调递增。 */
  const LADDER: ReadonlyArray<readonly [string, number]> = [
    ['--nm-cyan-4', 0.04],
    ['--nm-cyan-6', 0.06],
    ['--nm-cyan-8', 0.08],
    ['--nm-cyan-10', 0.10],
    ['--nm-cyan-12', 0.12],
    ['--nm-cyan-14', 0.14],
    ['--nm-cyan-16', 0.16],
    ['--nm-cyan-18', 0.18],
    ['--nm-cyan-20', 0.20],
    ['--nm-cyan-25', 0.25],
    ['--nm-cyan-35', 0.35],
    ['--nm-cyan-40', 0.40],
    ['--nm-cyan-42', 0.42],
    ['--nm-cyan-45', 0.45],
    ['--nm-cyan-50', 0.50],
    ['--nm-cyan-60', 0.60],
    ['--nm-cyan-70', 0.70],
  ]

  it('哨兵：两套主题都读到了（否则下面几条会恒绿）', () => {
    expect(dark.length).toBeGreaterThan(3000)
    expect(light.length).toBeGreaterThan(1000)
    expect(darkValue('--nm-cyan')).toBe('#00f0ff')
  })

  it('阶梯完整（十七档一个不缺）', () => {
    const missing = LADDER.filter(([n]) => darkValue(n) === null).map(([n]) => n)
    expect(missing, '缺档 ⇒ R2 找不到落点，只能回退写裸色：' + missing.join(', ')).toEqual([])
  })

  it('每个档的深色值就是 rgba(0,240,255,α)，与档位名严格对应', () => {
    for (const [name, alpha] of LADDER) {
      const v = darkValue(name)
      expect(v, `${name} 未定义`).not.toBeNull()
      expect(v, `${name} 的值与档位不符`).toBe(`rgba(0, 240, 255, ${alpha.toFixed(2)})`)
    }
  })

  it('阶梯严格单调递增（档位名的大小顺序 = 不透明度顺序）', () => {
    const alphas = LADDER.map(([n]) => {
      const m = /rgba\(0, 240, 255, ([\d.]+)\)/.exec(darkValue(n) ?? '')
      return m ? Number(m[1]) : NaN
    })
    for (let i = 1; i < alphas.length; i++) {
      expect(alphas[i], `第 ${i} 档未严格大于前一档`).toBeGreaterThan(alphas[i - 1] as number)
    }
  })

  it('浅色主题对每一档都有覆盖，且色相压暗为 rgba(8,145,178,·)', () => {
    for (const [name] of LADDER) {
      const v = lightValue(name)
      expect(v, `浅色缺 ${name} 覆盖 ⇒ 浅色下会用深色值，过亮`).not.toBeNull()
      expect(v, `${name} 浅色值色相不对`).toMatch(/^rgba\(8, 145, 178, [\d.]+\)$/)
    }
  })
})

describe('R1 令牌层：中性色阶第四档 + 品牌身份色', () => {
  it('--nm-text-4 深浅两套都在，且是「比 text-3 更淡/更弱」的第四档', () => {
    const d = darkValue('--nm-text-4')
    const l = lightValue('--nm-text-4')
    expect(d).toBe('#4a5575')
    expect(l).toBe('#94a3b8')
    /**
     * 2026-09-28（R3）反转了这条断言。
     *
     * 原断言是 `darkValue('--nm-text-3')` **包含** `#4a5575` —— 即「text-3 与 text-4 同值，
     * 同属最暗一档」。R3 把 text-3 对齐到 dsw 的 `label-tertiary`（`#64748b`）后，
     * 两档分开了，原断言不再成立。
     *
     * 但这不是退化 —— 恰恰相反：原状态下 text-3 与 text-4 **同值**意味着色阶只有三档半，
     * 而现在的四档是真正递进的（每档亮度严格递减）。所以断言按**真实意图**重写：
     * 钉「四档递进」，而不是钉「两档撞值」。
     */
    const order = ['--nm-text-1', '--nm-text-2', '--nm-text-3', '--nm-text-4']
    const lum = (hex: string): number => {
      const h = hex.trim().replace('#', '')
      const r = parseInt(h.slice(0, 2), 16)
      const g = parseInt(h.slice(2, 4), 16)
      const b = parseInt(h.slice(4, 6), 16)
      return 0.2126 * r + 0.7152 * g + 0.0722 * b // 相对亮度，够用来判「哪个更暗」
    }
    const vals = order.map(n => darkValue(n) as string)
    for (const v of vals) expect(v, `色阶里出现非 hex：${v}`).toMatch(/^#[0-9a-f]{6}$/i)
    for (let i = 1; i < vals.length; i++) {
      expect(
        lum(vals[i] as string),
        `text-${i + 1} 应比 text-${i} 更暗（色阶必须严格递减），实际 ` +
          `${vals[i - 1]} vs ${vals[i]}`,
      ).toBeLessThan(lum(vals[i - 1] as string))
    }
  })

  it('--nm-brand 深浅两套都在，浅色压暗（沿用 light-theme 的保色相口径）', () => {
    expect(darkValue('--nm-brand')).toBe('#00f0ff')
    expect(lightValue('--nm-brand')).toBe('#0369a1')
  })
})

describe('R2 令牌层：purple alpha 阶梯 + 面 / 罩 / 中性 hover', () => {
  /** 与 cyan 阶梯同构：purple 家族也必须完整且单调（R2 引导页大量用它）。 */
  const PURPLE: ReadonlyArray<readonly [string, number]> = [
    ['--nm-purple-8', 0.08],
    ['--nm-purple-10', 0.10],
    ['--nm-purple-14', 0.14],
    ['--nm-purple-18', 0.18],
    ['--nm-purple-20', 0.20],
    ['--nm-purple-50', 0.50],
  ]

  it('purple 阶梯完整，且每个档的深色值就是 rgba(168,85,247,α)', () => {
    for (const [name, alpha] of PURPLE) {
      const v = darkValue(name)
      expect(v, `${name} 未定义（缺档 ⇒ 引导页只能回退写裸色）`).not.toBeNull()
      expect(v, `${name} 的值与档位不符`).toBe(`rgba(168, 85, 247, ${alpha.toFixed(2)})`)
    }
  })

  it('purple 阶梯严格单调递增', () => {
    const alphas = PURPLE.map(([n]) => {
      const m = /rgba\(168, 85, 247, ([\d.]+)\)/.exec(darkValue(n) ?? '')
      return m ? Number(m[1]) : NaN
    })
    for (let i = 1; i < alphas.length; i++) {
      expect(alphas[i], `第 ${i} 档未严格大于前一档`).toBeGreaterThan(alphas[i - 1] as number)
    }
  })

  it('purple 每一档在浅色下都有覆盖，且色相压暗为 rgba(124,58,237,·)', () => {
    for (const [name] of PURPLE) {
      const v = lightValue(name)
      expect(v, `浅色缺 ${name} 覆盖`).not.toBeNull()
      expect(v, `${name} 浅色值色相不对`).toMatch(/^rgba\(124, 58, 237, [\d.]+\)$/)
    }
  })

  /** 面 / 罩 / 中性 hover：三档都是「深浅各自不同语义」的令牌，必须两套都在。 */
  const SURFACES: ReadonlyArray<readonly [string, string, string]> = [
    // [令牌名, 深色值, 浅色值]
    ['--nm-panel-solid', 'rgba(13, 21, 40, 0.72)', 'rgba(255, 255, 255, 0.85)'],
    ['--nm-veil-55', 'rgba(5, 10, 24, 0.55)', 'rgba(255, 255, 255, 0.80)'],
    ['--nm-hover-neutral', 'rgba(127, 127, 127, 0.16)', 'rgba(15, 23, 42, 0.05)'],
  ]

  it.each(SURFACES)('%s 深浅两套都在且取值正确', (name, darkExpect, lightExpect) => {
    expect(darkValue(name), `${name} 深色未定义`).toBe(darkExpect)
    expect(lightValue(name), `${name} 浅色未定义`).toBe(lightExpect)
  })

  /** 第二批：罩 / 天空 / 琥珀。 */
  const EXTRA: ReadonlyArray<readonly [string, string, string]> = [
    ['--nm-scrim-50', 'rgba(5, 10, 24, 0.50)', 'rgba(15, 23, 42, 0.40)'],
    ['--nm-sky', '#38bdf8', '#0284c7'],
    ['--nm-amber-45', 'rgba(245, 158, 11, 0.45)', 'rgba(180, 83, 9, 0.40)'],
  ]

  it.each(EXTRA)('%s 深浅两套都在且取值正确', (name, darkExpect, lightExpect) => {
    expect(darkValue(name), `${name} 深色未定义`).toBe(darkExpect)
    expect(lightValue(name), `${name} 浅色未定义`).toBe(lightExpect)
  })

  it('面 / 罩令牌在浅色下必须「翻面」（浅色底不能用深色罩，否则是黑块）', () => {
    // 这是一个语义护栏：--nm-panel-solid / --nm-veil-55 深色是深蓝底，浅色必须是白底。
    // 若有人把浅色值抄成深色值，上面 it.each 会红；这里额外钉住「不许两边相同」。
    for (const [name, darkExpect, lightExpect] of SURFACES.slice(0, 2)) {
      expect(lightValue(name), `${name} 浅色值不应等于深色值`).not.toBe(darkExpect)
      expect(lightValue(name), `${name} 浅色值应为白色系`).toContain('255, 255, 255')
      void lightExpect
    }
  })
})
