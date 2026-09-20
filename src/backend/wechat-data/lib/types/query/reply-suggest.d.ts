/** `collectReplyContext` 的结果。 */
export interface ReplyContext {
    /** 按时间正序的对话行（`我：…` / `对方：…`）；空行已剔除。 */
    lines: string[];
    /** 对方最近的一条非空消息 —— 就是「要回的那句」；没有则为空串。 */
    latestPeer: string;
    /** 参与拼装的条数（供隐私审计的 `messages` 计数用）。 */
    count: number;
}
/**
 * 取当前会话最近的对话上下文。
 * @param decryptedDir - 解密数据根。
 * @param talker - 会话 username（**范围就是它**，绝不跨会话取）。
 * @param selfUsername - 登录账号 wxid（用于标注「我」，未知时传空）。
 * @param limit - 取最近多少条（默认 20）。
 * @returns 上下文；该会话没有可用文本时 `count` 为 0。
 */
export declare function collectReplyContext(decryptedDir: string, talker: string, selfUsername?: string, limit?: number): ReplyContext;
/**
 * 取当前选中知识库里与 `query` 相关的片段（用于让推荐回复「有据可依」）。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 知识库 id（用户当前选中的那个）。
 * @param query - 检索词（一般传对方最近那句话）。
 * @param topK - 最多取几段。
 * @returns 形如 `《文件名》片段` 的字符串数组；库为空/未命中时返回空数组。
 */
export declare function collectReplyKbSnippets(decryptedDir: string, kbId: number, query: string, topK?: number): string[];
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
 * @param snippets - `collectReplyKbSnippets` 产出的片段。
 * @param want - 要几条候选。
 * @returns 提示词全文。
 */
export declare function buildReplyPrompt(lines: readonly string[], snippets: readonly string[], want: number): string;
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
