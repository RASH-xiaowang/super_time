/**
 * AI 回复生成期的取消器。
 *
 * 生成（付费调用）可能持续数秒；这期间若会话已经推进、租约易主或运行器停止，
 * 继续等模型说完只会白白烧 token。这里用一个轮询器把外部判据汇成一个
 * `AbortSignal`，由生成边界自行中断；本模块不读聊天正文、不记录日志。
 *
 * 判据失败按「未命中」处理：一次数据库抖动不能误杀正在进行的付费调用。
 */

/** 取消原因；只用于运行器内部收口，不落库。 */
export type ChatAiReplyCancelReason =
  | 'cancelled'
  | 'lease_lost'
  | 'superseded'
  | 'revision_changed'

/** 默认轮询间隔：平衡取消延迟与读库开销。 */
export const CHAT_AI_REPLY_CANCEL_POLL_MS = 1_000

export interface ChatAiReplyCancellationOptions {
  /** 运行器已停止（dispose）。 */
  isCancelled: () => boolean
  /** 心跳已确认租约丢失；旧 owner 不再有写入资格。 */
  isLeaseLost: () => boolean
  /** 会话是否出现更新的入站可视消息；读失败应返回 false。 */
  hasNewerMessage: () => boolean | Promise<boolean>
  /** 设置 revision 已变化；默认省略，由现有恢复/写状态闸门兜底。 */
  revisionChanged?: () => boolean
  pollMs?: number
}

export interface ChatAiReplyCancellation {
  signal: AbortSignal
  /** 已触发时的取消原因；未触发为 undefined。 */
  reason: () => ChatAiReplyCancelReason | undefined
  stop: () => void
  readonly aborted: boolean
}

export function createChatAiReplyCancellation(
  options: ChatAiReplyCancellationOptions,
): ChatAiReplyCancellation {
  const controller = new AbortController()
  let reason: ChatAiReplyCancelReason | undefined
  let stopped = false
  let checking = false

  const abort = (next: ChatAiReplyCancelReason): void => {
    if (stopped || reason !== undefined || controller.signal.aborted) return
    reason = next
    controller.abort()
  }

  const check = async (): Promise<void> => {
    if (stopped || checking || controller.signal.aborted) return
    checking = true
    try {
      if (options.isCancelled()) {
        abort('cancelled')
        return
      }
      if (options.isLeaseLost()) {
        abort('lease_lost')
        return
      }
      if (options.revisionChanged?.() === true) {
        abort('revision_changed')
        return
      }
      let newer = false
      try {
        newer = await options.hasNewerMessage()
      } catch {
        newer = false
      }
      if (newer) abort('superseded')
    } finally {
      checking = false
    }
  }

  const pollMs = Number.isFinite(options.pollMs) && (options.pollMs ?? 0) > 0
    ? Math.trunc(options.pollMs as number)
    : CHAT_AI_REPLY_CANCEL_POLL_MS
  // 不在创建时立刻读库：刚建立的预约必然没有更新消息，首拍读库只会和
  // 连发合并/生成抢同一个数据库。
  const timer = setInterval(() => {
    void check()
  }, pollMs)
  timer.unref?.()

  return {
    signal: controller.signal,
    reason: () => reason,
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
    get aborted() {
      return controller.signal.aborted
    },
  }
}
