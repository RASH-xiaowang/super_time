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

  return { msgItems, msgScrollMargin, msgVirtualizer }
}
