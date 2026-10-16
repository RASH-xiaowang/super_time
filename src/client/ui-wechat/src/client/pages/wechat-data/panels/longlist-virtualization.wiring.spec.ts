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
import { readChatsSource } from '../../../test-helpers/chats-source.ts'
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

  it('那三张长列表各自的接线守卫不许被删（收藏 / 文件网格 / 朋友圈时间线）', () => {
    // 这份只钉消息流。剩下三张各自的判据是独立文件 —— 删掉任何一个都不会有任何东西变红，
    // 而「拆掉虚拟化」正是那种不报错的坏法。
    for (const f of ['favorites-virtual.wiring.spec.ts', 'files-virtual.wiring.spec.ts', 'moments-virtual.wiring.spec.ts']) {
      expect(existsSync(join(HERE, f)), f + ' 不在册了 ⇒ 那张列表的虚拟化没人管').toBe(true)
    }
  })

  it('真窗口验收台**有人跑**（没人跑的话，它红着也没人知道）', () => {
    // W2-10.3 的由来：这个脚本此前**不在任何 workflow 里**。于是它自己那条
    // 「滚到底时悬浮日期头补上当前那一天」长期红着也没人发现 —— 夹具每天 10 条，
    // 每块 11 行 ≈ 一屏 11 行，底部窗口起点必然落在日期标签行上，那条判据结构上不可能成立。
    // 接进 CI 的第一次运行就抓到了。这条判据就是防它再退回去。
    const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
    expect(ci, 'ci.yml 里没有 ui:longlist-e2e ⇒ 这份 e2e 的结论保护不了任何东西').toContain('npm run ui:longlist-e2e')
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    expect(pkg.scripts?.['ui:longlist-e2e'], 'npm script 名对不上，workflow 会直接失败').toContain('longlist-virtualization-e2e.mjs')
  })

  it('底部悬浮日期头那条判据带了「前提当场断言」（夹具一改就可能又空转）', () => {
    const src = readFileSync(harnessPath, 'utf8')
    expect(src, '少了前提断言 ⇒ 哪天夹具又凑巧对齐，那条判据会静默变成永假').toContain('底部窗口的第一行不是日期标签行')
  })
})
