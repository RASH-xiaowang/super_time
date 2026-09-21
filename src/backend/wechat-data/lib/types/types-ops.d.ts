/**
 * `types.ts` 的 ops 部分（M21 拆分；纯类型，无运行期值）。
 *
 * 从 `types.ts` 原样搬出，`types.ts` 继续以 `export *` 转发 ⇒ 所有
 * `from './types.ts'` / `from '../types.ts'` 的导入路径一行都不用改。
 *
 * @module types-ops
 */
/** One native WeChat reminder (handoff_remind_v0) row. */
export interface HandoffRemindItem {
    id: number;
    title: string;
    time: number | null;
}
/** Native reminder snapshot. */
export interface HandoffRemindsSnapshot {
    items: HandoffRemindItem[];
    total: number;
}
/** One privacy audit feature aggregate. */
export interface PrivacyAuditFeature {
    feature: string;
    count: number;
    chars: number;
}
/** One raw privacy audit row. */
export interface PrivacyAuditRow {
    id: number;
    feature: string;
    ts: number;
    chars: number;
    sessions: number;
    messages: number;
}
/** Privacy audit clear result. */
export interface PrivacyAuditClearResult {
    ok: boolean;
    removed: number;
}
/** Privacy settings + audit snapshot. */
export interface PrivacyStateSnapshot {
    redactSensitive: boolean;
    blockOutbound: boolean;
    audit: {
        total: number;
        byFeature: PrivacyAuditFeature[];
        last: number | null;
        updatedAt: number;
    };
}
/** Operation-log category families recorded by the app (metadata only). */
export type OperationCategory = 'settings' | 'keys' | 'sync' | 'export' | 'delete' | 'backup' | 'edit' | 'task' | 'error';
/** Outcome of one logged operation. */
export type OperationStatus = 'ok' | 'fail' | 'skip';
/** One operation-log entry (metadata only; never carries message bodies). */
export interface OperationLogEntry {
    id: number;
    ts: number;
    category: OperationCategory;
    action: string;
    target: string;
    status: OperationStatus;
    detail: string;
}
/**
 * Filter for reading the operation log. Categories arrive at the wire
 * boundary, so unknown values are tolerated and dropped by the host.
 */
export interface OperationLogQuery {
    from?: number;
    to?: number;
    categories?: string[];
    status?: OperationStatus;
    /**
     * 关键词：在 `action` / `target` / `detail` 上做包含匹配。
     *
     * 为什么必须在服务端做：日志只能按「最新 N 条」取一页，客户端过滤等于
     * **只搜最新那一页**（实测 2144 条里只能搜到最新 500 条，覆盖率 23%），
     * 而按时间往回翻是审计场景最常见的动作。
     */
    q?: string;
    limit?: number;
    offset?: number;
}
/** Operation-log page: matching entries (newest first) + full match count. */
export interface OperationLogSnapshot {
    items: OperationLogEntry[];
    total: number;
}
/** Operation-log clear result. */
export interface OperationLogClearResult {
    ok: boolean;
    removed: number;
}
