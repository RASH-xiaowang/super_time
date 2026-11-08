/**
 * AI 回复的锚点、游标与恢复窗口。
 *
 * 这里只处理消息身份和扫描窗口，不读设置、不拿租约、不出网。把 sourceRef
 * 解析、pending 锚点校验和最早未处理消息选择放在同一层，便于恢复路径共享
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
/**
 * 选择本轮扫描窗口。
 *
 * - 有 pending/未完成记录：按 localId 精确取回锚点，不受“最新 80 条”限制；
 * - 正常增量：从持久化 cursor 之后取最早一批，积压超过一页也不会跳过；
 * - 旧 cursor 或依赖未注入：保留原最新窗口降级路径。
 */
export declare function loadMessagesForState(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, recoverOnly: boolean): Promise<ChatAiReplyScanMessage[]>;
export declare function isUnfinishedStage(stage: ChatAiReplyStage): boolean;
export declare function inspectReply(deps: ChatAiReplyScanDeps, recordId: number): Promise<ChatAiReplyRecordSnapshot>;
