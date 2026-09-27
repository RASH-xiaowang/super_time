/**
 * 收藏面板虚拟化的接线守卫（#22 推广的第二处长列表；消息流那份是 `longlist-virtualization.wiring.spec.ts`）。
 *
 * 为什么源码级守卫与真窗口验收都要有：源码只能证明"接上了"，证明不了"渲染对了"；
 * 但它能钉住**拆掉虚拟化之后一定会变的那几处形状** —— 有人把 `useVirtualizer` 换回渐进窗口
 * （DOM 随历史长度无界增长）、或把 `overscan` 调成一个巨大值（等于不虚拟化，但代码看起来还在虚拟化）、
 * 或把「加载更多」那颗哨兵顺手删了（分页永远不再往下翻）。
 * 首尾可达与节点上界由 `scripts/longlist-virtualization-e2e.mjs` 在真实窗口里量。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const panel = readFileSync(join(HERE, 'Favorites.tsx'), 'utf8')
const card = readFileSync(join(HERE, 'favorites-card.tsx'), 'utf8')

/** 剥掉注释（注释里出现 `useProgressiveList` 是解释"为什么不用它"，不算调用）。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 有没有真的"调用"渐进窗口（而不是在注释里提到它）。 */
function callsProgressive(src: string): boolean {
  return /useProgressiveList\(/.test(stripComments(src))
}

describe('收藏面板的虚拟化接线', () => {
  it('面板用 useVirtualizer 渲染收藏列表（滚动容器就是它自己那个 .scroll）', () => {
    expect(panel).toContain("from '@tanstack/react-virtual'")
    expect(panel).toContain('useVirtualizer({')
    expect(panel).toContain('getScrollElement: () => scrollRef.current')
    expect(panel).toContain('getVirtualItems()')
    expect(panel).toContain('favVirtualizer.getTotalSize()')
    expect(panel, '没有 measureElement 就不会动态测高，变高卡片会叠在一起').toContain('ref={favVirtualizer.measureElement}')
    expect(panel).toContain('<FavCard')
  })

  it('overscan 保持小值（调大就等于不虚拟化，但代码看着还在虚拟化）', () => {
    const m = /overscan:\s*(\d+)/.exec(panel)
    expect(m, '找不到 overscan ⇒ 上面的判据前提不成立').not.toBeNull()
    expect(Number(m?.[1] ?? '0'), 'overscan 过大 ⇒ 首屏就挂载大量行').toBeLessThanOrEqual(50)
  })

  it('不再对收藏列表使用渐进窗口（那正是无界增长的来源）', () => {
    expect(callsProgressive(panel), 'Favorites.tsx 里又出现了 useProgressiveList(...)').toBe(false)
    expect(panel).not.toContain('favCount')
  })

  it('缩略图改成"行挂载即解码"：整段列表的观察器不许长回来', () => {
    expect(card).toContain('onMounted(md5)')
    expect(panel, '又给整段列表挂 IntersectionObserver 观察 data-media-key 了').not.toContain("querySelectorAll<HTMLElement>('[data-media-key]')")
    expect(panel).toContain('rememberThumb(')
    // 卡片上留一个稳定的 id，真窗口验收靠它量「首尾可达」
    expect(card).toContain('data-fav-id=')
  })

  it('分页哨兵还在（虚拟化只接管卡片那一段，「加载更多」不能被顺手删掉）', () => {
    expect(panel).toContain('refFn={loadMoreRef}')
    expect(panel).toContain('pager.hasMore')
  })

  it('反例自证：三种坏形状都能被上面的判据分出来', () => {
    // ① 退回渐进窗口
    expect(callsProgressive("const { count } = useProgressiveList(items.length, 120)\n")).toBe(true)
    // ② 只在注释里提它 —— 不许被算成调用（本文件那条注释就是活例子）
    expect(callsProgressive('/* 为什么不用 useProgressiveList( 因为它只增不减 */\n')).toBe(false)
    // ③ overscan 巨大
    const huge = Number(/overscan:\s*(\d+)/.exec('overscan: 20000')?.[1] ?? '0')
    expect(huge).toBeGreaterThan(50)
    // ④ 没有 measureElement 的形状必须被抓到（正判据里那条 toContain 不是摆设）
    expect("useVirtualizer({ count: 1 })".includes('measureElement'), '前提：这个反例确实没有 measureElement').toBe(false)
  })
})
