import type { UnifiedSearchSnapshot } from '../types.ts';
import { type SearchControl } from './search.ts';
/**
 * Run the unified local search synchronously for existing query/tool callers.
 * @param decryptedDir - decrypted data root.
 * @param query - search term.
 * @param limit - max hits per domain (default 6).
 * @param options - optional hard scope (`from` / `to` / `username`).
 * @returns the unified snapshot.
 */
export declare function searchUnified(decryptedDir: string, query: string, limit?: number, options?: {
    from?: string;
    to?: string;
    username?: string;
}): UnifiedSearchSnapshot;
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
export declare function searchUnifiedCancellable(decryptedDir: string, query: string, limit?: number, options?: {
    from?: string;
    to?: string;
    username?: string;
}, ctrl?: SearchControl): Promise<UnifiedSearchSnapshot>;
