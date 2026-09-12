/**
 * 主题令牌 → 具体颜色（供 ECharts / canvas 使用）。
 *
 * 为什么需要这个模块：
 * ECharts 把图画在 `<canvas>` 上，颜色由 ECharts 自己解析，**不能**写
 * `var(--nm-*)` —— CSS 自定义属性只在 CSS 里由浏览器解析。因此图表若写死
 * `rgba(0,240,255,0.4)` 这类深色主题专用值，浅色主题下就会配色错乱（例如地图
 * 板块叠成刺眼的亮青、日历热力图整片泛蓝）。
 *
 * 这里在 JS 侧把令牌解析成实际颜色：借助一个隐藏探针元素设 `color: var(令牌)`，
 * 再读 `getComputedStyle` —— 这样连 `var()` 套 `var()` 的链式定义也能正确展开
 * （直接读 `getPropertyValue('--x')` 只会拿到未展开的字面量）。
 */

/** 解析结果缓存：键为 `令牌|alpha`。主题切换时需要清空。 */
const cache = new Map<string, string>()

/** 清空缓存（主题切换后调用，或由调用方在依赖变化时触发）。 */
export function clearTokenColorCache(): void {
  cache.clear()
}

/** 用探针元素把令牌解析成浏览器计算后的颜色，例如 `rgb(0, 240, 255)`。 */
function resolveToken(name: string): string | null {
  if (typeof document === 'undefined' || !document.body) return null
  const probe = document.createElement('span')
  probe.style.color = `var(${name})`
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const computed = getComputedStyle(probe).color
  probe.remove()
  if (!computed) return null
  // 令牌未定义时 color 会退化成继承值；用 currentColor 无法区分，这里靠调用方给 fallback。
  return computed
}

/** 把 `rgb(r, g, b)` / `rgba(r, g, b, a)` / `#rgb` / `#rrggbb` 解析成通道数组。 */
function parseChannels(color: string): [number, number, number] | null {
  const s = color.trim()
  const m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i)
  if (m) return [Math.round(Number(m[1])), Math.round(Number(m[2])), Math.round(Number(m[3]))]
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex) {
    const h = hex[1]
    if (h.length === 3) {
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)]
    }
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  }
  return null
}

/**
 * 在**任意**背景色上挑一个可读的文字色（白或近黑）。
 *
 * 为什么需要：图谱的社区色是数据派生的任意颜色，同一枚徽标会被涂上其中任意一种，
 * 写死文字色必然在部分底色上失效。实测（第 23 轮对比度审计）：社区成员数徽标
 * 用 `--nm-cyan` 当文字色压在饱和社区色上，**浅色与深色主题下都只有 1.8~2.3**，
 * 在两个主题里各占 4 处违规 —— 是全部残余违规的唯一来源。
 *
 * 实现：按 WCAG 相对亮度比较「白」与「近黑 #0b1220」哪一个对比度更高。
 * @param background - 背景色（`#rgb` / `#rrggbb` / `rgb()` / `rgba()`）。
 * @returns `#ffffff` 或 `#0b1220`。
 */
export function readableOn(background: string): string {
  const channels = parseChannels(background)
  if (!channels) return '#ffffff'
  const rel = (c: number): number => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  const luminance = (rgb: readonly number[]): number => 0.2126 * rel(rgb[0]) + 0.7152 * rel(rgb[1]) + 0.0722 * rel(rgb[2])
  const bg = luminance(channels)
  const contrast = (other: number): number => (Math.max(bg, other) + 0.05) / (Math.min(bg, other) + 0.05)
  const white = contrast(1)
  const ink = contrast(luminance([11, 18, 32])) // #0b1220
  return white >= ink ? '#ffffff' : '#0b1220'
}

/**
 * 读取当前主题下某个 CSS 令牌的颜色。
 * @param name - 令牌名，例如 `'--nm-cyan'`。
 * @param alpha - 透明度 0..1，默认 1（不透明）。
 * @param fallback - 令牌读不到或无法解析时使用的颜色。
 * @returns `rgba(...)` 或 `rgb(...)` 字符串，可直接交给 ECharts。
 */
export function tokenColor(name: string, alpha = 1, fallback = '#00f0ff'): string {
  const key = `${name}|${alpha}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const resolved = resolveToken(name)
  const channels = resolved ? parseChannels(resolved) : null
  let out: string
  if (!channels) {
    out = fallback
  } else if (alpha >= 1) {
    out = `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`
  } else {
    out = `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha})`
  }
  cache.set(key, out)
  return out
}
