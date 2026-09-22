/**
 * N18 接线守卫：消息流**必须**是虚拟化的，且既有交互（深链 `#msg-<localId>`、跳转、回到底部）都在。
 *
 * 为什么需要：这条改造的失败方式全是「界面照样能开、只是坏了」——
 *   ① 有人把虚拟化拆了、改回「渐进窗口」（DOM 随历史长度无界增长，滚一遍一万条就挂一万个节点）；
 *   ② 或者把 `overscan` 调成一个大得离谱的值（等于不虚拟化，实测 20000 时 DOM 2100 个节点）；
 *   ③ 或者顺手删掉 `id="msg-<localId>"` / 末尾哨兵 —— 深链与「回到底部」会静默失效。
 * 行为侧由 `scripts/longlist-virtualization-e2e.mjs` 在真实窗口里量（DOM 上界 / 首尾可达 / 不跳位），
 * 这里钉接线，两边的边界都写清楚。
 *
 * @vitest-environment node
 */
import { readFileSync, existsSync } from 'node:fs'
import { readChatsSource } from './chats-source.ts'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根：panels → wechat-data → pages → client → src → ui-wechat → client → src（8 层）。 */
const ROOT = join(HERE, '..', '..', '..', '..', '..', '..', '..', '..')
// M21 拆了 Chats.tsx ⇒ 读面板 + chats-*.tsx 的联合（断言未改）
const chatsSrc = readChatsSource()
const harnessPath = join(ROOT, 'scripts', 'longlist-virtualization-e2e.mjs')

describe('N18：消息流虚拟化的接线', () => {
  it('用 @tanstack/react-virtual 的 useVirtualizer 渲染消息流', () => {
    expect(chatsSrc).toContain("from '@tanstack/react-virtual'")
    expect(chatsSrc).toContain('useVirtualizer({')
    expect(chatsSrc).toContain('getScrollElement: () => msgScrollRef.current')
    expect(chatsSrc).toContain('measureElement')          // 动态测高（变高消息）
    expect(chatsSrc).toContain('getVirtualItems()')        // 只挂载视口附近
    expect(chatsSrc).toContain('msgVirtualizer.getTotalSize()')
  })

  it('overscan 保持小值（调大就等于不虚拟化）', () => {
    const m = /overscan:\s*(\d+)/.exec(chatsSrc)
    expect(m, '找不到 overscan（用例前提不成立）').not.toBeNull()
    expect(Number(m![1]), 'overscan 过大 ⇒ 首屏就会挂载大量行').toBeLessThanOrEqual(50)
  })

  it('不再对消息流使用「渐进窗口」（那正是无界增长的来源）', () => {
    expect(chatsSrc).not.toContain('useProgressiveList(messages.length')
    expect(chatsSrc).not.toContain('msgWinCount')
    // 会话列表仍用它（不在本条目范围），别误删
    expect(chatsSrc).toContain('useProgressiveList(normalList.length')
  })

  it('既有交互仍在：深链 id、跳到某条消息、回到底部、加载更多的锚定', () => {
    expect(chatsSrc, '深链锚点没了').toContain('id={`msg-${head.localId}`}')
    expect(chatsSrc, '跳转能力没了').toContain('scrollToIndex')
    expect(chatsSrc, '末尾哨兵没了（回到底部会失效）').toContain('ref={msgEndRef}')
    expect(chatsSrc, '加载更多的锚定逻辑没了（会跳位）').toContain('prependAnchorRef')
    expect(chatsSrc, '滚动容器没有 ref（虚拟化拿不到滚动元素）').toContain('ref={msgScrollRef}')
  })

  it('行为侧的验收台在册，且量的是「硬上界」', () => {
    expect(existsSync(harnessPath), '找不到 scripts/longlist-virtualization-e2e.mjs').toBe(true)
    const src = readFileSync(harnessPath, 'utf8')
    expect(src).toContain('MAX_DOM_NODES')
    expect(src).toContain('DOM 节点数有硬上界')
    expect(src).toContain('加载更多不跳位')
  })
})
