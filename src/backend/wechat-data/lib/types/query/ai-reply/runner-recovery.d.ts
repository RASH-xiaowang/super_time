/**
 * AI 回复的锚点、游标与恢复窗口。
 *
 * 这里只处理消息身份和扫描窗口，不读设置、不拿租约、不出网。把 sourceRef
 * 解析、pending 锚点校验和最新未处理消息选择放在同一层，便于恢复路径共享
 * 同一套 fail-closed 规则。
 */
import type { ChatAiReplyAnchor, ChatAiReplyRecordSnapshot, ChatAiReplyScanDeps, ChatAiReplyScanMessage, ChatAiReplyStage, ChatAiReplyState } from './types.ts';
import { type ChatAiReplySourceRefParts } from './segments.ts';
export declare function errorText(e: unknown): string;
export declare function delay(ms: number): Promise<void>;
export declare function isBusyError(e: unknown): boolean;
export declare function anchorOf(message: ChatAiReplyScanMessage): ChatAiReplyAnchor | null;
/**
 * 新 cursor 采用 v2:sortSeq:localId，与消息查询的排序键一致。
 *
 * 旧版 createTime:localId 仍可读取，用于平滑迁移；下一次成功处理后会写成 v2。
 */
export declare function cursorOf(anchor: ChatAiReplyAnchor): string;
export declare function sourceRefOf(state: ChatAiReplyState, anchor: ChatAiReplyAnchor): string;
export declare function parseSourceRef(value: string | undefined): ChatAiReplySourceRefParts | null;
export declare function pendingAnchorOf(state: ChatAiReplyState, messages: ChatAiReplyScanMessage[]): ChatAiReplyAnchor | null;
export declare function anchorOfRecord(state: ChatAiReplyState, record: ChatAiReplyRecordSnapshot, messages: ChatAiReplyScanMessage[]): ChatAiReplyAnchor | null;
export declare function afterCursor(anchor: ChatAiReplyAnchor, cursor: string): boolean;
export declare function messageAfterAnchor(message: ChatAiReplyScanMessage, anchor: ChatAiReplyAnchor): boolean;
/** 自己发出的可读消息表示这一轮已经有人回答，系统事件不算。 */
export declare function isVisibleConversationMessage(message: ChatAiReplyScanMessage): boolean;
/** 会话中最后一条可视消息；用于判断当前是否轮到对方、需要自动回复。 */
export declare function latestVisibleMessage(messages: readonly ChatAiReplyScanMessage[]): ChatAiReplyScanMessage | undefined;
/** 只选择游标之后最新的一条对方消息，把同一轮连续消息合并成一次回复。 */
export declare function latestInboundAfterCursor(messages: readonly ChatAiReplyScanMessage[], cursor: string): ChatAiReplyAnchor | undefined;
/** 供初始化水位使用；自己或对方的消息都可以作为“已看到这里”的位置。 */
export declare function cursorOfMessage(message: ChatAiReplyScanMessage): string | undefined;
/**
 * 会话最新一条具有稳定排序键的消息位置。
 *
 * 初始化水位不能只找“最新入站消息”：如果最新 80 条里恰好没有对方消息，
 * cursor 会退成 0:0，之后窗口滚动到历史入站消息时就可能把旧问题再答一遍。
 * 系统事件也是会话已推进的事实，同样可以作为水位，只是不触发回复。
 */
export declare function latestMessageCursor(messages: readonly ChatAiReplyScanMessage[]): string | undefined;
/**
 * 我们自己已经投递出去的分段正文（归一化后）。
 *
 * 为什么需要它：一次回复被拆成多段时，第 1 段发出去后会**以本机身份出现在
 * 微信库里**（发送端还会在前面拼上 `@提及`）。恢复扫描若把它当成「会话已推进」，
 * 就会把剩下的 2..N 段全判成过期取消 —— 群里根本没有别人说话，
 * 症状是「只发了第一段，后面的都没发」。
 */
export type OwnSentSegments = ReadonlySet<string>;
/**
 * 这条消息是不是我们自己刚发出去的分段。
 *
 * 判据刻意用正文包含关系而不是时间窗：发送端可能在前方拼 `@成员 `、
 * 也可能对正文做换行处理，只有「库里的文本包含台账里的这一段」才是可验证的
 * 事实。反过来，人工从手机上回复的内容不会命中任何一段，仍会被判成推进。
 * @param message - 待判定的消息。
 * @param own - 已投递分段的归一化正文；空集表示没有可忽略项。
 * @returns 命中表示「这是我们自己发的，不算会话推进」。
 */
export declare function isOwnSentSegment(message: ChatAiReplyScanMessage, own: OwnSentSegments | undefined): boolean;
/**
 * 读取本批次里**已经发出去**的分段正文。
 *
 * 只在恢复路径调用；读不到（未注入/库忙/格式坏）时返回空集，
 * 即退回改版前的严格口径 —— 宁可保守取消，也不要把过期答案发出去。
 * @param deps - 扫描依赖。
 * @param sourceRef - 当前记录的 sourceRef（分段键会归一到基础键）。
 * @returns 归一化后的已发送正文集合。
 */
export declare function ownSentSegmentsOf(deps: ChatAiReplyScanDeps, sourceRef: string | undefined): Promise<OwnSentSegments>;
/**
 * 会话是否已经越过指定锚点。
 *
 * 恢复不能只看 pending 自身：如果对方又发了新消息，或用户/其它链路已经手工
 * 回复，再补发旧问题的答案就会造成“总是回复上一次的问题”。任一方出现新的
 * 可视消息都视为本轮已经过时；系统事件不计入。
 *
 * 唯一的例外是 `own`：本批次自己刚发出去的分段会以本机身份出现在会话里，
 * 那不是「会话推进」，必须排除，否则多段回复只会发出第 1 段。
 * @param deps - 扫描依赖。
 * @param state - 会话运行状态。
 * @param anchor - 本轮回复的触发锚点。
 * @param messages - 已读到的消息窗口。
 * @param own - 已投递的分段正文（见 {@link ownSentSegmentsOf}）。
 * @returns true 表示会话已推进，本轮答案已过期。
 */
export declare function conversationProgressedAfter(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, anchor: ChatAiReplyAnchor, messages?: readonly ChatAiReplyScanMessage[], own?: OwnSentSegments | undefined): Promise<boolean>;
/** 合并“游标之后”和“最新一页”两个窗口，确保真正最新的消息不会被分页遮住。 */
export declare function mergeMessageWindows(...windows: ReadonlyArray<readonly ChatAiReplyScanMessage[]>): ChatAiReplyScanMessage[];
/**
 * 选择本轮扫描窗口。
 *
 * - 有 pending/未完成记录：按 localId 精确取回锚点，不受“最新 80 条”限制；
 * - 正常增量：游标之后的消息与最新一页合并，合并后只选最新一条对方消息；
 *   积压不会被分页遮住，也不会逐条补答旧消息；
 * - 旧 cursor 或依赖未注入：保留原最新窗口降级路径。
 */
export declare function loadMessagesForState(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, recoverOnly: boolean): Promise<ChatAiReplyScanMessage[]>;
export declare function isUnfinishedStage(stage: ChatAiReplyStage): boolean;
export declare function inspectReply(deps: ChatAiReplyScanDeps, recordId: number): Promise<ChatAiReplyRecordSnapshot>;
