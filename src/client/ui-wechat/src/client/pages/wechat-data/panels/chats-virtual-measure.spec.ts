// @vitest-environment node
/**
 * 「滚动停稳后补量已挂载行」的接线守卫。
 *
 * 为什么要单独钉这条接线：TanStack 在滚动期间会跳掉一部分测量（把预算让给滚动），
 * 媒体行又是在解码完成后才长高 —— 快速上滚时新挂载的行可能停在旧高度上，相邻行
 * 重叠（用户看到的就是「消息分布不对」）。修法是滚动停稳后对所有 `[data-index]`
 * 行补一次同步测量；这条 effect 一旦被删掉，界面**不会报错**，只会在快速滚动时
 * 重新出现重叠，所以这里直接读源码钉住它的三个要素（监听、延时、真调用 measureElement）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(join(import.meta.dirname, 'chats-message-virtualizer.ts'), 'utf8')

describe('滚动停稳后的补量', () => {
  it('滚动容器上有监听，且用延时把「停稳」与连续滚动分开', () => {
    expect(SOURCE, '滚动监听不见了 ⇒ 补量永远不会触发').toContain("box.addEventListener('scroll'")
    expect(SOURCE, '没有停稳延时 ⇒ 每一帧都重量，滚动会卡').toContain('SETTLE_MEASURE_MS')
  })

  it('停稳后对每个已挂载的虚拟行真正调用 measureElement（不是只遍历）', () => {
    expect(SOURCE, '没有按 data-index 找已挂载行').toContain("querySelectorAll<HTMLElement>('[data-index]')")
    expect(SOURCE, '遍历了却没有回填高度 ⇒ 重叠照样存在').toContain('msgVirtualizer.measureElement(el)')
  })
})
