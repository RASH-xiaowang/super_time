import type { DatabaseSync } from '../db-open.ts';
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
 * 在一条**已打开的可写连接**上建表 / 补列 / 保证绑定行存在。
 *
 * 拆成「接收 db」而不是「自己开库」，是为了让写路径把「建表 + 本次写」放进同一条连接
 * （一次 `withWritableDb` 里干完），不出现同一操作两次开库。
 */
export declare function ensureClawbotSchema(db: DatabaseSync): void;
/** 打开一次可写连接完成建表/补列（读路径不需要它）。 */
export declare function ensureClawbotStore(decryptedDir: string): void;
