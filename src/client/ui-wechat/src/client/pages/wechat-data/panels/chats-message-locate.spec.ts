// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageRenderItem } from '../utils/message-items.ts'
import { useChatsMessageLocate } from './chats-message-locate.ts'

let host: HTMLDivElement
let root: Root
let locate: ((localId: number, scopeKey?: string) => void) | null

function Harness(props: {
  items: MessageRenderItem[]
  scopeKey: string
  virtualizer: Virtualizer<HTMLDivElement, Element>
}): null {
  locate = useChatsMessageLocate({
    items: props.items,
    scopeKey: props.scopeKey,
    virtualizer: props.virtualizer,
  })
  return null
}

const messageItem = (localId: number): MessageRenderItem => ({
  kind: 'msg',
  m: {
    localId,
    sortSeq: localId,
    type: 1,
    isSender: 0,
    createTime: 1700000000 + localId,
  } as WechatMessage,
})

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  locate = null
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  vi.unstubAllGlobals()
})

describe('deferred message locate', () => {
  it('waits for the newly loaded items instead of using the caller old closure', () => {
    const scrollToIndex = vi.fn()
    const virtualizer = { scrollToIndex } as unknown as Virtualizer<HTMLDivElement, Element>
    const target = document.createElement('div')
    target.id = 'msg-42'
    const scrollIntoView = vi.fn()
    target.scrollIntoView = scrollIntoView
    document.body.append(target)

    act(() => {
      root.render(createElement(Harness, { items: [], scopeKey: 'chat\u00001', virtualizer }))
    })
    act(() => { locate?.(42, 'chat\u00001') })
    act(() => {
      root.render(createElement(Harness, {
        items: [messageItem(7), messageItem(42)],
        scopeKey: 'chat\u00001',
        virtualizer,
      }))
    })

    expect(scrollToIndex).toHaveBeenCalledWith(1, { align: 'center' })
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
  })

  it('does not consume a target queued for another session scope', () => {
    const scrollToIndex = vi.fn()
    const virtualizer = { scrollToIndex } as unknown as Virtualizer<HTMLDivElement, Element>

    act(() => {
      root.render(createElement(Harness, {
        items: [messageItem(42)],
        scopeKey: 'chat\u00002',
        virtualizer,
      }))
    })
    act(() => { locate?.(42, 'chat\u00001') })

    expect(scrollToIndex).not.toHaveBeenCalled()
  })
})
