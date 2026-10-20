import { type RetrievalTool } from './types.ts';
/** 把 `YYYY-MM-DD` 转成当天 00:00 的 epoch 秒（本地时区）。 */
declare function dayStartSec(d: string): number;
/** 把 `YYYY-MM-DD` 转成当天 23:59:59 的 epoch 秒（本地时区）。 */
declare function dayEndSec(d: string): number;
/** 会话显示名（从索引库的 `contact_fts` 取；取不到就用 username）。 */
declare function displayNames(decryptedDir: string): Map<string, string>;
/** 关键词检索聊天消息。 */
export declare const searchMessagesTool: RetrievalTool;
/** 取某个会话在某时段的消息（按时间升序）。 */
export declare const getSessionMessagesTool: RetrievalTool;
/** 取某条消息前后的上下文窗口。 */
export declare const getMessageContextTool: RetrievalTool;
/** 会话列表（按活跃度或时间排序）。 */
export declare const listSessionsTool: RetrievalTool;
/** 消息类工具集。 */
export declare const MESSAGE_TOOLS: readonly RetrievalTool[];
/** 供其它模块复用的时间工具（避免各工具各写一份）。 */
export { dayStartSec, dayEndSec, displayNames };
