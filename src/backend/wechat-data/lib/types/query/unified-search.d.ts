import type { UnifiedSearchResourceDomain, UnifiedSearchSnapshot } from '../types.ts';
import { type SearchControl } from './search.ts';
/**
 * 内容域工具的过滤/排序选项（全局搜索面板不传 ⇒ 行为与旧版一致）。
 *
 * `domains` 是工具路径的开关：只有显式指定时，空查询才会去列「最近的资源」；
 * 不指定时保持旧语义（空查询直接返回空快照，不把 LIKE '%%' 扫全库）。
 */
export interface UnifiedSearchOptions {
    from?: string;
    to?: string;
    username?: string;
    /** 只运行这些资源域；提供后允许空查询 = 最近条目。 */
    domains?: ReadonlyArray<UnifiedSearchResourceDomain>;
    /** 缺库/缺表时写入 domainErrors（工具路径要区分「缺库」与「确实没有」）。 */
    reportMissing?: boolean;
    /** 时间排序：recent = 最新在前（默认），oldest = 最早在前。 */
    order?: 'recent' | 'oldest';
    /** 记录类型过滤（`revokes` 走 `queryRecords` 的撤回域）。 */
    recordKind?: 'all' | 'transfers' | 'redpackets' | 'revokes';
    /** 收支方向；只有转账/红包能判定。 */
    direction?: 'all' | 'in' | 'out';
    /** 金额区间（分，含边界）；仅转账/红包，未知金额的行不满足区间。 */
    minAmountCents?: number;
    maxAmountCents?: number;
    /** 收藏类型过滤（未知类型归 other）。 */
    favoriteType?: 'all' | 'text' | 'image' | 'video' | 'file' | 'link' | 'other';
    /** 文件大类过滤。 */
    fileCategory?: 'all' | 'file' | 'image' | 'video';
    /** 文件排序：recent = 修改时间倒序，size = 体积倒序。 */
    fileOrder?: 'recent' | 'size';
    /** 文件体积区间（字节，含边界）。 */
    minSize?: number;
    maxSize?: number;
    /** 从消息分片解析支付卡片金额（仅工具路径开启）。 */
    resolveRecordMoney?: boolean;
}
/**
 * Run the unified local search synchronously for existing query/tool callers.
 * @param decryptedDir - decrypted data root.
 * @param query - search term.
 * @param limit - max hits per domain (default 6).
 * @param options - optional hard scope (`from` / `to` / `username`).
 * @returns the unified snapshot.
 */
export declare function searchUnified(decryptedDir: string, query: string, limit?: number, options?: UnifiedSearchOptions): UnifiedSearchSnapshot;
/**
 * 可取消的全局搜索（界面链路专用）。
 *
 * 取消后返回**已扫描域的部分结果**并带 `cancelled: true`，不会把未扫描域伪装成
 * 「确实没有命中」。不带令牌时结果与 {@link searchUnified} 相同，只是异步执行。
 * @param decryptedDir - decrypted data root.
 * @param query - search term.
 * @param limit - max hits per domain (default 6).
 * @param options - optional hard scope (`from` / `to` / `username`).
 * @param ctrl - optional AbortSignal-backed search control.
 * @returns unified snapshot, with `cancelled: true` when interrupted.
 */
export declare function searchUnifiedCancellable(decryptedDir: string, query: string, limit?: number, options?: UnifiedSearchOptions, ctrl?: SearchControl): Promise<UnifiedSearchSnapshot>;
