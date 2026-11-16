/**
 * 外部“打开某个会话”的导航意图消费器。
 *
 * `openSessionAndLocate` 会随会话/消息数据刷新而换身份。如果消费 effect 同时依赖它，
 * 同一个 target 会在数据落地后被反复打开，每次又把消息清空并重新请求，
 * 界面便一直停在骨架屏。
 */
import { useLayoutEffect, useRef } from 'react'

export interface ChatNavigationTarget {
  username: string
  localId?: number
  /** 单调递增，保证同一会话连续跳转两次也能重新消费。 */
  nonce: number
}

interface ChatTargetNavigationInputs {
  target?: ChatNavigationTarget | null
  open: (username: string, localId?: number) => Promise<void>
  /** target 已消费：宿主据此清掉导航意图，避免分段切换重挂面板时再次打开。 */
  onHandled?: (nonce: number) => void
}

/**
 * 每个非空 target 只消费一次。
 *
 * 回调用 ref 保存最新值：effect 只认 target 本身，不因会话/消息变化而重跑。
 *
 * 为什么是 `useLayoutEffect` 而不是 `useEffect`：宿主把聊天视图切到前台与下发 target
 * 是同一拍发生的。`useEffect` 在**绘制之后**才跑 —— 中间那一帧里面板已经可见，显示
 * 的却还是上一个会话的消息（用户报障的「原界面的消息被带到第二个界面」）。
 * `open` 的同步前缀（切会话 + 作废旧令牌 + 清空消息）放进 layout effect，正好发生在
 * 绘制之前，旧消息一帧都不会被画出来。
 */
export function useChatTargetNavigation({ target, open, onHandled }: ChatTargetNavigationInputs): void {
  const openRef = useRef(open)
  const onHandledRef = useRef(onHandled)
  const handledRef = useRef<ChatNavigationTarget | null>(null)
  openRef.current = open
  onHandledRef.current = onHandled

  useLayoutEffect(() => {
    if (!target) return
    const handled = handledRef.current
    if (
      handled?.nonce === target.nonce
      && handled.username === target.username
      && handled.localId === target.localId
    ) return

    handledRef.current = { username: target.username, localId: target.localId, nonce: target.nonce }
    onHandledRef.current?.(target.nonce)
    const username = target.username.trim()
    if (!username) return
    void openRef.current(username, target.localId)
  }, [target])
}
