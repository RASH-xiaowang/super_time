/**
 * Member / contact search (成员搜索). Uses the local contact_fts index in
 * wechat_search.db when available (built lazily on first use) and falls back to
 * a LIKE scan over contact.db; room-scoped searches join chatroom_member.
 *
 * 这里是 `wechat_search.db` 的**第二个写者**（第一个是 `search.ts` 的 `buildSearchIndex`），
 * 所以它的写必须走 `search.ts` 导出的那把索引库写闸（`withIndexWrite`）——
 * 否则构建在飞时写事务会被拒、然后被吞掉、静默退化成 LIKE。
 */
import { DatabaseSync } from 'node:sqlite';
import type { MemberSearchSnapshot } from '../types.ts';
/**
 * contact_fts 的可用状态。
 * - `ready`：已有索引可读（本次调用**没有**写索引库）。
 * - `busy`：索引库写闸拿不到（建索引在飞），本次**没有**尝试写。
 * - `unavailable`：没有可用的 contact.db 或构建失败（已打日志，不静默）。
 */
type ContactFtsState = 'ready' | 'busy' | 'unavailable';
/**
 * 确保 contact_fts 可用。
 *
 * 为什么先只读判断：`contact_fts` 已经建好时，改前那两句 `CREATE ... IF NOT EXISTS` 其实是纯读
 * （实测：另一连接持写锁时它们不报错）；**只有真要建表时**才需要写锁，那时构建在飞就会被拒
 * （`database is locked`）—— 条目里 155/155 次退化正是「索引还没建出来的那个窗口」。所以：
 * 已经建好就只读照用（构建期间成员搜索也不必降级），要建/重建才进写闸。
 *
 * 真要写时也不能去撞锁：`searchMembers` 是同步契约，排不了队。拿不到闸就返回 `busy`，
 * 由调用方显式降级并留痕（见 searchGlobalMembers）。
 * @param db - 以读写方式打开的索引库连接。
 * @param decryptedDir - 已解密数据根（用于定位 contact.db）。
 * @returns contact_fts 的可用状态。
 */
export declare function ensureContactFts(db: DatabaseSync, decryptedDir: string): ContactFtsState;
/**
 * Search contacts / group members.
 * @param decryptedDir - decrypted data root.
 * @param q - search term (name/remark/username/alias/pinyin).
 * @param opts - optional limit and room scope (roomUsername).
 * @returns matching members + total + source.
 */
export declare function searchMembers(decryptedDir: string, q: string, opts?: {
    limit?: number;
    roomUsername?: string;
}): MemberSearchSnapshot;
export {};
