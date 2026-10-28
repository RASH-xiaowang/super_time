/** 消息列表新增/投递结果变化事件（与任务中心事件分开）。 */
export const MESSAGE_LIST_UPDATED_EVENT = 'dsh-wechat-message-list-updated'

/** 广播消息列表已变；订阅方自行回源，不把快照塞进事件里。 */
export function notifyMessageListUpdated(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(MESSAGE_LIST_UPDATED_EVENT))
}
