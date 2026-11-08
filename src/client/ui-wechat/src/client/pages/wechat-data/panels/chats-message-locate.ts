import { useCallback, useEffect, useRef, useState } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { MessageRenderItem } from '../utils/message-items.ts'
import { itemLocalId } from './chats-support.tsx'

interface PendingLocate {
  localId: number
  scopeKey: string
  nonce: number
}

interface UseChatsMessageLocateOptions {
  items: MessageRenderItem[]
  scopeKey: string
  virtualizer: Virtualizer<HTMLDivElement, Element>
}

/**
 * Queue message locates until the virtualizer has rendered the loaded target.
 *
 * Async session loaders call `locate` before React commits their new message
 * window. Resolving against the caller's old `items` closure is why old quote
 * and citation jumps silently stayed at the bottom.
 */
export function useChatsMessageLocate({
  items,
  scopeKey,
  virtualizer,
}: UseChatsMessageLocateOptions): (localId: number, targetScopeKey?: string) => void {
  const nonceRef = useRef(0)
  const [pending, setPending] = useState<PendingLocate | null>(null)

  const locate = useCallback((localId: number, targetScopeKey = ''): void => {
    nonceRef.current += 1
    setPending({ localId, scopeKey: targetScopeKey, nonce: nonceRef.current })
  }, [])

  useEffect(() => {
    if (!pending) return
    if (pending.scopeKey && pending.scopeKey !== scopeKey) return
    const index = items.findIndex((item) => itemLocalId(item) === pending.localId)
    if (index < 0) return
    setPending(null)
    virtualizer.scrollToIndex(index, { align: 'center' })
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.getElementById('msg-' + String(pending.localId))?.scrollIntoView({ block: 'center' })
      })
    })
  }, [items, pending, scopeKey, virtualizer])

  return locate
}
