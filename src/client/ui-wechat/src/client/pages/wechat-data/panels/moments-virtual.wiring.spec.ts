/**
 * 朋友圈时间线虚拟化的接线守卫（#22 最后一处长列表）。
 *
 * 这一处的失败方式与前三处不同：媒体层（懒解密 / 封面兜底 / IDB 恢复）原先靠
 * "渐进窗口渲染到第几组"来重挂 IntersectionObserver。虚拟化之后渲染的是一个**区间**，
 * 如果没人把"窗口动了"这件事告诉媒体层，症状是**滚到下面图片永远是占位图标**
 * —— 界面上没有报错、后端也没收到请求，只有真滚一遍才看得见。
 * 所以这里除了钉虚拟器本身，还要钉那条 `renderKey` 的线真的接上了。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const panel = readFileSync(join(HERE, 'moments-panel.tsx'), 'utf8')
const timeline = readFileSync(join(HERE, 'moments-timeline.tsx'), 'utf8')
const media = readFileSync(join(HERE, 'moments-media.ts'), 'utf8')

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}
function callsProgressive(src: string): boolean {
  return /useProgressiveList\(/.test(stripComments(src))
}

describe('朋友圈时间线的虚拟化接线', () => {
  it('面板建虚拟器、时间线负责渲染（行 = 日期标签或一条动态）', () => {
    expect(panel).toContain("from '@tanstack/react-virtual'")
    expect(panel).toContain('useVirtualizer({')
    expect(panel).toContain('getScrollElement: () => scrollRef.current')
    expect(panel).toContain('buildMomentRows(groups)')
    expect(panel).toContain('<MomentsTimeline')
    expect(timeline).toContain('p.virtualizer.getTotalSize()')
    expect(timeline).toContain('items.map((vi)')
    expect(timeline, '没有 measureElement ⇒ 变高卡片会叠在一起').toContain('p.virtualizer.measureElement')
    expect(timeline).toContain("row.kind === 'day'")
    expect(timeline).toContain('p.renderCard(row.m)')
  })

  it('overscan 保持小值，且不再对时间线使用渐进窗口', () => {
    const m = /overscan:\s*(\d+)/.exec(panel)
    expect(m, '找不到 overscan ⇒ 前提不成立').not.toBeNull()
    expect(Number(m?.[1] ?? '0')).toBeLessThanOrEqual(50)
    expect(callsProgressive(panel), 'moments-panel.tsx 里又出现了 useProgressiveList(...)').toBe(false)
    expect(panel).not.toContain('grpCount')
  })

  it('媒体层拿到的是「渲染窗口指纹」，并且换窗口时会重挂观察器', () => {
    expect(panel).toContain('renderKey: momentRenderKey')
    expect(panel).toContain('momentVirtualizer.getVirtualItems()')
    expect(media).toContain('renderKey: string')
    expect(media).toContain('[groups, renderKey]')
    // 观察器要先 disconnect 再整批 observe：留着已卸载元素等于白占一份观察
    expect(media).toContain('ob.disconnect()')
    expect(media, '重挂观察器时不再整批 observe ⇒ 新挂载的行永远不解码').toContain('for (const el of cells) ob.observe(el)')
  })

  it('滚动容器由面板持有并注入媒体层（虚拟器要在建媒体层之前就拿到它）', () => {
    expect(panel).toContain('const scrollRef = useRef<HTMLDivElement | null>(null)')
    expect(panel).toContain('scrollRef={scrollRef}')
    expect(media).toContain('scrollRef: React.MutableRefObject<HTMLDivElement | null>')
  })

  it('既有交互没丢：加载全部、灯箱、回到顶部都还在这条链上', () => {
    expect(timeline).toContain('p.onLoadAll')
    expect(timeline).toContain('css.backTop')
    expect(timeline).toContain('css.searchBanner')
    expect(panel).toContain('renderCard={(m) => (')
    expect(panel).toContain('mediaKeySpec={mediaKeySpec}')
  })

  it('日期标签的"粘住"换了实现（虚拟化让原来的分组内 sticky 失效，不补就等于丢了这格信息）', () => {
    expect(timeline, '没有悬浮日期头 ⇒ 滚出那一天后看不到当前日期').toContain('data-moment-float-day=')
    expect(timeline).toContain("if (row?.kind === 'day') return row.day")
    // 顶端那一行的标签本来就在 ⇒ 不许重复出第二个（同一行日期上下各一份）
    expect(timeline).toContain("firstRow?.kind !== 'day'")
  })

  it('反例自证：三种坏形状都分得出来', () => {
    expect(callsProgressive("const { count } = useProgressiveList(groups.length, 25)\n")).toBe(true)
    expect(callsProgressive('/* 原先是 useProgressiveList( 只增不减 */\n')).toBe(false)
    expect(Number(/overscan:\s*(\d+)/.exec('overscan: 9000')?.[1] ?? '0')).toBeGreaterThan(50)
    // 「只 observe 不 disconnect」的退化形状：正判据那条 toContain('ob.disconnect()') 会抓不到
    expect('root.querySelectorAll(el => ob.observe(el))'.includes('ob.disconnect()'), '前提：这个反例确实没有 disconnect').toBe(false)
  })
})
