/**
 * 分析上下文里的发言者标签。
 *
 * 单聊只有「我 / 对方」两方；群聊如果把所有人都写成「对方」，模型会把多个人的话
 * 当成同一个人的连续表达，进而把「张三提问」和「李四接话」串成一个人自言自语。
 * 因此群聊优先用成员昵称，其次 wxid，仍取不到时退到中性称谓「群成员」。
 *
 * @module query/analysis/speaker
 */
/**
 * 取一条消息在分析上下文里的发言者标签。
 * @param talker - 会话 `WechatSession.username`（群聊以 `@chatroom` 结尾）。
 * @param message - 至少需要发送方向与发送者字段。
 * @returns 可直接拼进对话行的发言者标签。
 */
export declare function analyzeSpeakerLabel(talker: string, message: {
    isSender: number;
    sender?: string;
    senderName?: string;
}): string;
