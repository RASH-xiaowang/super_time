import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import { buildMessageItems } from '../utils/message-items.ts'
import { estimateMsgItemHeight, scopedMsgItemKey } from './chats-support.tsx'

interface ChatsMessageVirtualizerOptions {
  messages: readonly WechatMessage[]
  scopeKey: string
  scrollRef: React.MutableRefObject<HTMLDivElement | null>
  listRef: React.MutableRefObject<HTMLDivElement | null>
  layoutVersion: {
    messagesMatchSession: boolean
    hasMore: boolean
    msgError: string | null
    msgLoading: boolean
  }
}

/**
 * 滚动停下后补量已挂载行的等待时间。
 *
 * 为什么需要这一拍：TanStack 在滚动期间会**跳过**一部分测量（`isScrolling` 闸）把
 * 预算让给滚动本身，媒体行（表情/图片）又是在解码完成后才长高。快速上滚时新挂载的
 * 行可能在下一次重绘前就停在旧高度上 —— 相邻行重叠，画面看起来「消息分布不对」。
 * 滚动停稳后对所有 `[data-index]` 行做一次同步测量，保证最终几何一定收敛；
 * 尺寸没变时 `measureElement` 是空操作（delta=0），不会带来额外布局抖动。
 */
const SETTLE_MEASURE_MS = 180

/** Own the message virtualizer, dynamic row measuring, and scroll-margin synchronization. */
export function useChatsMessageVirtualizer({
  messages,
  scopeKey,
  scrollRef,
  listRef,
  layoutVersion,
}: ChatsMessageVirtualizerOptions) {
  const msgItems = useMemo(() => buildMessageItems(messages, 0), [messages])
  const getMsgItemKey = useCallback(
    (index: number): string => scopedMsgItemKey(scopeKey, msgItems[index]),
    [scopeKey, msgItems],
  )
  const [msgScrollMargin, setMsgScrollMargin] = useState(0)
  const msgVirtualizer = useVirtualizer({
    count: msgItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimateMsgItemHeight(msgItems[index]),
    overscan: 6,
    getItemKey: getMsgItemKey,
    scrollMargin: msgScrollMargin,
  })

  useLayoutEffect(() => {
    msgVirtualizer.measure()
  }, [scopeKey, msgVirtualizer])

  const syncMsgScrollMargin = useCallback((): void => {
    const box = scrollRef.current
    const list = listRef.current
    if (!box || !list) {
      setMsgScrollMargin(0)
      return
    }
    const next = Math.max(0, Math.round(
      list.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop,
    ))
    setMsgScrollMargin((previous) => (previous === next ? previous : next))
  }, [listRef, scrollRef])

  useLayoutEffect(() => {
    syncMsgScrollMargin()
  }, [
    syncMsgScrollMargin,
    scopeKey,
    layoutVersion.messagesMatchSession,
    msgItems.length,
    layoutVersion.hasMore,
    layoutVersion.msgError,
    layoutVersion.msgLoading,
  ])

  useEffect(() => {
    const box = scrollRef.current
    const list = listRef.current
    if (!box || !list || typeof ResizeObserver === 'undefined') return
    let frame: number | null = null
    const scheduleSync = (): void => {
      if (frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        syncMsgScrollMargin()
      })
    }
    const observer = new ResizeObserver(scheduleSync)
    observer.observe(box)
    observer.observe(list)
    return () => {
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [
    syncMsgScrollMargin,
    scrollRef,
    listRef,
    scopeKey,
    layoutVersion.messagesMatchSession,
    layoutVersion.hasMore,
    layoutVersion.msgError,
    layoutVersion.msgLoading,
  ])

  useEffect(() => {
    const box = scrollRef.current
    if (!box) return
    let timer: number | undefined
    const onScroll = (): void => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = undefined
        const list = listRef.current
        if (!list) return
        for (const el of list.querySelectorAll<HTMLElement>('[data-index]')) {
          msgVirtualizer.measureElement(el)
        }
      }, SETTLE_MEASURE_MS)
    }
    box.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      box.removeEventListener('scroll', onScroll)
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [listRef, msgVirtualizer, scopeKey, scrollRef])

  return { msgItems, msgScrollMargin, msgVirtualizer }
}
