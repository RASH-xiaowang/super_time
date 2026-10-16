// @vitest-environment node
/**
 * W3-10.1：切页签时释放「看不见的」图片槽（从 WechatDataPanel 里抽出）。
 *
 * ## 为什么单独一个文件
 *
 * `WechatDataPanel` 受函数体棘轮管着（只许变小），而这段 effect 本身有 16 行注释 + 逻辑。
 * 抽成 hook 之后面板只剩一次调用；更重要的是，这段逻辑从此可以单独测 ——
 * 它判的是「切到什么页签该留哪个会话」，翻译成表格之后错一处就能看见。
 *
 * ## 语义表（`chatKeepUsername`）
 *
 * | 页签 | 保留 |
 * |---|---|
 * | 聊天类（chats/bizchats/servicechats/kefu/revoked） | 当前选中会话（没有选中就是空串 = 全释放） |
 * | 其余任何页签 | 空串 = 全部释放 |
 *
 * 为什么聊天类才保留：其余页签（圈子、文件、设置…）根本不显示图片，留着只是占地。
 * 而聊天类里「当前会话」是唯一确定的那一个 —— 由知道选中项的那一层传进来。
 */
import { useEffect } from 'react'

import type { WechatTab } from './nav-config.ts'
import { keepOnlyImages } from './image-cache.ts'

/** 聊天类页签：只有它们显示图片，切走时才需要考虑「留哪个会话」。 */
function isChatTab(tab: WechatTab): boolean {
  return (
    tab === 'chats' ||
    tab === 'bizchats' ||
    tab === 'servicechats' ||
    tab === 'kefu' ||
    tab === 'revoked'
  )
}

/**
 * 切到这个页签时该保留哪个会话（空串 = 全部释放）。
 *
 * 纯函数，便于单测：翻译「页签 + 当前选中」→「保留谁」这一件事。
 * @param tab - 目标页签。
 * @param username - 当前选中会话的 username（没有选中就是空串）。
 * @returns 要保留的 username；空串表示全部释放。
 */
export function chatKeepUsername(tab: WechatTab, username: string | undefined): string {
  if (!isChatTab(tab)) return ''
  return username ?? ''
}

/**
 * 切页签时按上表的规则释放图片槽。
 *
 * 放在 useEffect 里而不是 `setActive` 内：渲染期不该 mutate 缓存（React 严格模式下会报）。
 * @param tab - 当前页签。
 * @param username - 当前选中会话的 username。
 */
export function useReleaseImagesOnTab(tab: WechatTab, username: string | undefined): void {
  useEffect(() => {
    keepOnlyImages(chatKeepUsername(tab, username))
  }, [tab, username])
}