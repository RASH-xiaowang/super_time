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
 * 会话是否已经越过指定锚点。
 *
 * 恢复不能只看 pending 自身：如果对方又发了新消息，或用户/其它链路已经手工
 * 回复，再补发旧问题的答案就会造成“总是回复上一次的问题”。任一方出现新的
 * 可视消息都视为本轮已经过时；系统事件不计入。
 */
export declare function conversationProgressedAfter(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, anchor: ChatAiReplyAnchor, messages?: readonly ChatAiReplyScanMessage[]): Promise<boolean>;
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
