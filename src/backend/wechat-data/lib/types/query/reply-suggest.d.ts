/** 推荐回复固定携带的最近消息窗口；超过这个量只会稀释最后一句的回复意图。 */
export declare const REPLY_SUGGEST_CONTEXT_LIMIT = 60;
/** `collectReplyContext` 的结果。 */
export interface ReplyContext {
    /** 按时间正序的对话行（`我：…` / `对方：…`）；空行已剔除。 */
    lines: string[];
    /** 当前窗口内可交给多模态模型的图片/表情消息定位信息。 */
    imageCandidates?: ReplyImageCandidate[];
    /** 对方最近的一条非空消息 —— 就是「要回的那句」；没有则为空串。 */
    latestPeer: string;
    /** 参与拼装的条数（供隐私审计的 `messages` 计数用）。 */
    count: number;
    /** 指定了目标消息时，该消息是否仍存在于当前解密快照（缺省 = 未按目标截取）。 */
    targetFound?: boolean;
    /** 目标消息的发送者标签（单聊为「对方」，群聊为成员名）。 */
    targetSpeaker?: string;
    /**
     * 本轮唯一需要回复的那一行。
     *
     * 会话级推荐取上下文最后一行；分析面板指定历史消息时取该消息，
     * 这样提示词不必再让模型自己猜“最后一条”是哪条。
     */
    targetLine: string;
}
/** 视觉消息只暴露会话内定位键；真实图片/表情字节由上层按需解码。 */
export interface ReplyImageCandidate {
    localId: number;
    /** 缺省按普通图片处理；自定义表情/表情包显式标记为 sticker。 */
    kind?: 'image' | 'sticker';
    md5?: string;
    emojiUrl?: string;
}
/**
 * 取当前会话最近的对话上下文。
 * @param decryptedDir - 解密数据根。
 * @param talker - 会话 username（**范围就是它**，绝不跨会话取）。
 * @param selfUsername - 登录账号 wxid（用于标注「我」，未知时传空）。
 * @param limit - 取最近多少条（默认 60）。
 * @param targetLocalId - 只分析/回复截至这条消息的上下文；缺省时仍取会话最新一页。
 * @returns 上下文；该会话没有可用文本时 `count` 为 0。
 */
export declare function collectReplyContext(decryptedDir: string, 
/** 会话微信 ID —— 同一个概念的正名见 `WechatSession.username`（P3-6：问答链沿用库里更早的列名）。 */
talker: string, selfUsername?: string, limit?: number, targetLocalId?: number): ReplyContext;
/**
 * 拼「推荐回复」的提示词。
 *
 * 几个刻意的取舍：
 *   · **明确告诉模型几条**（`want`），并要求 JSON 数组 —— 但 `parseReplyCandidates` 仍然宽容，
 *     因为小模型未必听话；
 *   · 上下文标注「我 / 对方」，否则模型分不清是谁在问，会生成「替对方回我」的话；
 *   · 知识库片段**标注文件名**：让模型知道依据来自哪份文件，也让用户能核对（配合界面上的
 *     「知识库 N 段」说明）；
 *   · 没选库/没命中时不编造「参考资料」，直接说只有对话上下文。
 * @param lines - `collectReplyContext` 产出的对话行（时间正序）。
 * @param snippets - 知识库混合检索产出的片段。
 * @param want - 要几条候选。
 * @param targetLine - 唯一要回复的目标行；缺省时取上下文最后一行。
 * @returns 提示词全文。
 */
export declare function buildReplyPrompt(lines: readonly string[], snippets: readonly string[], want: number, targetLine?: string): string;
/** 一条消息用于拼提示词的文本：优先展示文本，其次落回原始字段；过长截断。 */
export declare function messageText(m: {
    displayText?: string;
    strContent?: string;
    msgContent?: string;
}): string;
/**
 * 把模型输出解析成候选回复列表。
 *
 * 模型（尤其小模型）不会永远规规矩矩给 JSON：常见形态有 ```json 围栏、编号列表、
 * 每行一句、或在前言后附一段 JSON。解析必须**宽容**，但也不能把解释性文字当回复 ——
 * 所以策略是「先试 JSON 数组，再退化为逐行」，并且逐条清洗：剥编号/项目符号/引号，
 * 丢掉过短或明显是说明文字的行（以「好的」「以下是」这类开场）。
 * @param raw - 模型返回的原始文本。
 * @param want - 最多要几条。
 * @returns 清洗后的候选（可能少于 `want`，也可能为空 —— 空即「这次没产出」）。
 */
export declare function parseReplyCandidates(raw: string, want?: number): string[];
