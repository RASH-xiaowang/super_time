/** 会话级 AI 回复异步请求的身份快照。 */
export interface ChatAiReplyIdentity {
  selfWxid: string
  chatUsername: string
  chatName: string
  sessionEpoch: number
}

export function sameChatAiReplyIdentity(
  left: ChatAiReplyIdentity,
  right: ChatAiReplyIdentity,
): boolean {
  return left.selfWxid !== ''
    && left.selfWxid === right.selfWxid
    && left.chatUsername !== ''
    && left.chatUsername === right.chatUsername
    && left.chatName === right.chatName
    && left.sessionEpoch === right.sessionEpoch
}
