/**
 * 侧栏图标口径守卫（`nav-config.ts`）。
 *
 * 为什么值得锁：主界面侧栏的图标是逐条对照**微信官方客户端字形**画的
 * （聊天气泡 / 朋友圈光圈 / 通讯录人像+条目行 / 钱包 / 文件夹 / 听筒 / 齿轮 / 盾牌 /
 *  立方体），而不是任意几何描边。这条约束在源码里看不出来 —— 一个 `<circle>` 加两条线
 * 同样能渲染，图标「在」但形制不对，且不会有任何测试变红。重画前的实测就是这种状态：
 * 整排 Feather 描边图标与微信官方视觉完全对不上。
 *
 * 口径不是「一刀切全填充」：官方**本身就是线稿**的那条（收藏 = 等距立方轮廓）必须保持
 * 线稿，拿填充实心块去统一它就等于不一致。所以这里分两类锁：
 *   ① 填充类：必须走 `filled()` 分组、分组外不得再有绘制元素；
 *   ② 线稿类（目前只有收藏）：必须显式 `fill="none"` + 继承外层描边。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { NAV_GROUPS } from './nav-config.ts'

/** 侧栏真正会画出来的条目（hidden 不渲染；settings 渲染在侧栏底部）。 */
const VISIBLE = NAV_GROUPS.flatMap(g => g.items).filter(it => !it.hidden)

/** 配置里的全部条目（含 hidden）—— 「合法 SVG」这条对它们一视同仁。 */
const ALL = NAV_GROUPS.flatMap(g => g.items)

/**
 * 官方字形本身就是线稿的条目 —— 只有它们可以不吃 filled() 包裹。
 * 收藏 = 等距立方轮廓（官方截图核对过：内部是空的，不是实心块）。
 */
const OUTLINE_TABS = new Set(['favorites'])

const FILLED = VISIBLE.filter(it => !OUTLINE_TABS.has(it.tab))
const OUTLINE = VISIBLE.filter(it => OUTLINE_TABS.has(it.tab))

/**
 * 抽出 path 里的**绝对**坐标数字。
 *
 * 小写命令（`c`/`v`/`h`…）是相对位移，负数完全合法（例如 `v-1.5` 往上画一截尾巴），
 * 所以不能把整段 path 里的数字都当坐标扫 —— 首版就是这么误报的（-5.2 / -3.4 / -10）。
 * 这里只取大写命令后面的参数；大写命令的坐标是绝对的，越界就真的会被 svg 裁掉。
 */
function absoluteCoords(icon: string): number[] {
  const out: number[] = []
  const re = /([MLHVCSQTAZmlhvcsqtaz])([^MLHVCSQTAZmlhvcsqtaz]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(icon)) !== null) {
    const cmd = m[1]
    if (!cmd || !/^[MLHVCSQTAZ]$/.test(cmd)) continue
    const nums = (m[2].match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
    out.push(...nums)
  }
  return out
}

describe('侧栏图标：逐条对齐微信官方字形', () => {
  it('可见条目不是空集，且两类各有对象（防空转：下面的断言得有对象）', () => {
    expect(VISIBLE.length).toBeGreaterThanOrEqual(15)
    expect(VISIBLE.map(it => it.tab)).toContain('settings')
    expect(FILLED.length).toBeGreaterThanOrEqual(14)
    expect(OUTLINE.length).toBeGreaterThanOrEqual(1)
    expect(OUTLINE.map(it => it.tab)).toEqual(['favorites'])
  })

  it('填充类必须走填充口径：自带 fill=currentColor / stroke=none 覆盖外层描边继承', () => {
    for (const it of FILLED) {
      expect(it.icon, `${it.tab} 没有填充分组`).toContain('<g fill="currentColor" stroke="none">')
      expect(it.icon, `${it.tab} 没有填充分组闭合`).toContain('</g>')
    }
  })

  it('填充类不得在分组之外再有绘制元素（有就说明有人把描边图标塞回来了）', () => {
    for (const it of FILLED) {
      const outside = it.icon.replace(/<g fill="currentColor" stroke="none">[\s\S]*?<\/g>/g, '')
      expect(outside, `${it.tab} 在填充分组之外还有绘制元素`).not.toMatch(/<(circle|line|polyline|rect|path|polygon)\b/)
    }
  })

  it('图标内容必须是合法 SVG 元素：标签之外不得残留裸路径数据', () => {
    /*
     * 这条来自一个**真发生过、而上面所有断言全部漏过**的缺陷：
     * `kb`（知识库）的 icon 曾写成 `filled('M4.3 17.7H19.7…')` —— 直接把裸 path 数据
     * 当 inner 传了进去，漏掉 `<path d="…"/>` 外壳。产出就是
     * `<g fill="currentColor" stroke="none">M4.3 17.7H19.7…</g>`：
     * SVG 的 `<g>` **不渲染文本子节点**，于是侧栏那一格图标是**空白**的。
     *
     * 为什么上面 7 条全绿：填充分组壳在、`</g>` 在、「分组之外没有绘制元素」也成立
     * （裸文本不是元素）、绝对坐标同样扫得出来（裸数据里照样是 M/L/A 大写命令）。
     * 所以判据只能落在「标签之外有没有残留文本」上。
     *
     * 对 **ALL（含 hidden）** 而不是只对 VISIBLE 生效：hidden 条目不渲染、坏了看不出来，
     * 但它的图标是逐条对照官方字形画的，将来挪去别处复用就立刻暴露。
     */
    for (const it of ALL) {
      const bare = it.icon.replace(/<[^>]*>/g, '').trim()
      expect(
        bare,
        `${it.tab} 的图标在标签之外还有裸文本（多半是漏了 <path d="…"/> 外壳）—— SVG 不会渲染它，图标会是空白`,
      ).toBe('')
      expect(it.icon, `${it.tab} 的图标里没有任何绘制元素`).toMatch(/<(path|circle|ellipse|rect|line|polyline|polygon)\b/)
    }
  })

  it('线稿类（收藏）必须显式 fill=none 并吃外层描边 —— 不能被改成实心块', () => {
    for (const it of OUTLINE) {
      expect(it.icon, `${it.tab} 应当显式 fill="none"`).toContain('fill="none"')
      expect(it.icon, `${it.tab} 被塞进了填充分组`).not.toContain('<g fill="currentColor" stroke="none">')
      expect(it.icon, `${it.tab} 不应自带 stroke-width（吃外层统一描边）`).not.toContain('stroke-width')
    }
  })

  it('绝对坐标不越出 24×24 视框（越界会被 svg 裁掉，图标缺一块）', () => {
    for (const it of VISIBLE) {
      const coords = absoluteCoords(it.icon)
      expect(coords.length, `${it.tab} 没有可检查的绝对坐标`).toBeGreaterThan(0)
      const out = coords.filter(v => v < -2 || v > 26)
      expect(out, `${it.tab} 出现越界绝对坐标 ${out.join(',')}`).toEqual([])
    }
  })

  it('官方字形那几条必须仍在侧栏（换名/改 hidden 会直接丢失形制一致性）', () => {
    const official = ['chats', 'contacts', 'moments', 'favorites', 'ledger', 'files', 'calls', 'settings', 'privacy']
    const tabs = VISIBLE.map(it => it.tab)
    for (const t of official) expect(tabs, `${t} 不再是可见条目`).toContain(t)
  })

  it('三条对照过官方截图的形状特征（防止被换成「差不多」的几何形）', () => {
    // 聊天气泡：官方是横向胶囊（短边半圆）+ 左下尾巴，不是圆角矩形。
    // 判据：气泡轮廓里出现「半圆弧」语义的 a6.4 6.4（rx = 短边一半）。
    expect(VISIBLE.find(it => it.tab === 'chats')?.icon ?? '').toContain('a6.4 6.4')
    // 朋友圈：官方是中心圆 + 八段带缺口花瓣，不是「外环 + 偏心内圆」。
    // 判据：八段花瓣路径（每段 A9.8 9.8 … A5.4 5.4 …）。花瓣角度由几何生成，改半径需重新生成。
    const moments = VISIBLE.find(it => it.tab === 'moments')?.icon ?? ''
    expect((moments.match(/A9\.8 9\.8/g) ?? []).length).toBe(8)
    // 通讯录：官方是人像 + 右侧条目行，不是单独一个人像。
    // 判据：同一枚图标里既有头像圆（a3.4 3.4）又有条目行（h6.4 / h4.8）。
    const contacts = VISIBLE.find(it => it.tab === 'contacts')?.icon ?? ''
    expect(contacts).toContain('a3.4 3.4')
    expect(contacts).toMatch(/h6\.4/)
  })
})
