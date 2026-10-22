import type { DatabaseSync } from '../db-open.ts';
import type { ClawbotMessage } from '../../types.ts';
import type { ClawbotReplyPart, ClawbotReplyPartStatus, ClawbotReplyRun, ClawbotReplyRunAttachments, ClawbotReplyRunStatus } from './clawbot-reply-store.ts';
export { mergeReplyRunDetail, parseReplyRunDetail, replyRunDetailJson, serializeReplyRunDetail, } from './clawbot-run-detail.ts';
/** `clawbot.db` 在数据根里的位置（与 `wechat_privacy.db` 同级）。 */
export declare function clawbotDbPath(decryptedDir: string): string;
/** 库文件是否已存在（读路径的第一道短路：不存在 = 还没绑定过，不是读失败）。 */
export declare function clawbotDbExists(decryptedDir: string): boolean;
/**
 * 默认实例编号。**多实例**（2026-10-13）之后 `clawbot_binding` 一 slot 一行，
 * 且 **slot 就是这一行的自增主键 `id`**：
 *
 *   · `AUTOINCREMENT` 保证 id **只增不复用** —— 复用是这里唯一不能接受的语义
 *     （配置与会话都按 slot 存，复用等于把上一个实例的偏好送给新实例，用户全看不出来）；
 *   · id 唯一 ⇒ slot 天然唯一，省掉一个「唯一性靠自觉」的索引；
 *   · 老库补齐时把已有行回填成 `slot = id`（见 {@link ensureClawbotSchema}），
 *     于是「原来那唯一一行」= slot 1，旧客户端不传 slot 时也落在它上面。
 */
export declare const DEFAULT_CLAWBOT_SLOT = 1;
/**
 * 在一条**已打开的可写连接**上建表 / 补列 / 首次建库时补默认绑定行。
 *
 * 拆成「接收 db」而不是「自己开库」，是为了让写路径把「建表 + 本次写」放进同一条连接
 * （一次 `withWritableDb` 里干完），不出现同一操作两次开库。
 */
export declare function ensureClawbotSchema(db: DatabaseSync): void;
/** 打开一次可写连接完成建表/补列（读路径不需要它）。 */
export declare function ensureClawbotStore(decryptedDir: string): void;
/** 回复 run/outbox 的公共列、行映射与老库缺列兼容（store 与消息列表共用）。 */
export declare const REPLY_RUN_COLS = "id, slot, target_message_id, question, status, attempts, last_error, result_json, next_attempt_at, created_at, updated_at";
export declare const REPLY_PART_COLS = "id, run_id, slot, part_index, text, client_id, status, attempts, sent_message_id, last_error, created_at, updated_at";
export declare const REPLY_RUN_STATUSES: Set<ClawbotReplyRunStatus>;
export declare const REPLY_PART_STATUSES: Set<ClawbotReplyPartStatus>;
export declare function replyPositiveInt(value: number, label: string): number;
export declare function replyTimestamp(value: number | undefined): number;
export declare function replyTextOrNull(value: unknown): string | null;
export declare function toReplyRun(row: Record<string, unknown>): ClawbotReplyRun;
export declare function toReplyPart(row: Record<string, unknown>): ClawbotReplyPart;
export declare function replyResultJsonOrNull(value: string | null | undefined): string | null;
/** 旧调用不传摘要时保留已落库详情；显式新摘要则覆盖上一轮。 */
export declare function setReplyRunResultOn(db: DatabaseSync, runId: number, resultJson: string | null | undefined): void;
export declare function readReplyRunOn(db: DatabaseSync, runId: number): ClawbotReplyRun | null;
export declare function readReplyPartsOn(db: DatabaseSync, runId: number): ClawbotReplyPart[];
export declare function readReplyPartOn(db: DatabaseSync, partId: number): ClawbotReplyPart | null;
export declare function hasClawbotTable(db: DatabaseSync, name: string): boolean;
/** 老库还没补 result_json 时，读取仍按旧列集合工作。 */
export declare function replyRunColsOn(db: DatabaseSync): string;
export declare function uniqueReplyIds(values: readonly number[]): number[];
export declare function replySqlPlaceholders(count: number): string;
export declare function replyIdChunks(ids: readonly number[], size?: number): Generator<readonly number[]>;
/** 一页消息对应的 run 摘要；按 target/sent 两条路径各一次批量查询，避免 N+1。 */
export declare function listReplyRunAttachments(dir: string, slot: number, targetMessageIds: readonly number[], sentMessageIds: readonly number[]): ClawbotReplyRunAttachments;
/**
 * 给消息页批量附上自动回复运行详情。
 *
 * 入站目标消息与对应出站分段共用同一份摘要；run 表状态覆盖 JSON 里的生成状态。
 * 附件查询失败或旧库缺列时退回原消息，列表本身不能因诊断信息不可读取而失败。
 */
export declare function attachReplyRunDetails(dir: string, slot: number, messages: readonly ClawbotMessage[]): ClawbotMessage[];
