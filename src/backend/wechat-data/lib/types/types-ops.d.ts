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
    /**
     * 这条操作花了多少毫秒（H2，2026-09-28 性能修复）。
     *
     * 为什么要有它：`docs/PERF-AUDIT-172` 那张「哪个接口最慢」的分布表**是拿临时探针
     * 从宿主日志里数出来的** —— 每查一次性能就得重写一个 probe 脚本，而探针只能测
     * 「本机能跑的那些接口」。把耗时落进审计表之后，用户现场的那台机器就是唯一的数据源：
     * 直接按 `duration_ms DESC` 查，不必再让用户跑脚本。
     *
     * 口径：**超过 {@link SLOW_OPERATION_MS} 才记**（默认 1000ms，与宿主 `wechat-host.js`
     * 那条 `if (cost > 1000)` 同阈值）。理由有二：① 绝大多数操作是 1~5ms 的配置读写，
     * 全记会让这张审计表在几天内涨到几十万行；② 审计表是给人看的，混进几万条 0ms
     * 反而让「哪条慢」看不出来。**未记录 ≠ 没耗时** —— 它意味着「这次不到 1 秒」。
     */
    durationMs?: number;
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
    /**
     * 只看「至少这么慢」的记录（毫秒，H2）。
     *
     * 审计表里绝大多数行不带 `durationMs`（那次不到 1 秒）—— 想找瓶颈时先过一层
     * `minDurationMs`，比在几万行里翻要直接得多。带这个过滤时**同时排除没有耗时字段的行**：
     * 「不知道多快」不能算「够慢」。
     */
    minDurationMs?: number;
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
