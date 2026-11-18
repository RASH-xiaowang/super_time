import type { MessageListRecordResult } from '../types.ts';
export declare const AI_REPLY_REOPEN_NOTE = "AI \u56DE\u590D \u00B7 \u91CD\u65B0\u751F\u6210";
/**
 * 把一条**空白失败**的 AI 回复记录 CAS 重置为 pending，供桌面端重新生成。
 *
 * 守卫与 `dropAiReplyMessageListRecord` 同等严格：整组只允许 pending/failed、
 * 正文全空、无图片、无 job、无发送尝试。整组多余的空白分段会先删除，再对基础
 * 记录做一次 UPDATE；任一步不满足都回滚，记录保持失败原状。
 */
export declare function reopenAiReplyMessageListRecord(decryptedDir: string, id: number, sourceRef: string): MessageListRecordResult;
/** 桌面端专用清理的返回：`removed` 是**实际删除的行数**（整组），`skipped` 按调用方的 id 计。 */
export interface AiReplyReservationCleanupResult {
    ok: boolean;
    removed: number;
    skipped: number;
    items: Array<{
        id: number;
        status: 'removed' | 'skipped';
        error?: string;
    }>;
    error?: string;
}
/**
 * 桌面端专用：删除一组 AI 回复记录。
 *
 * 默认只删**从未生成正文、从未投递**的预约/失败记录（与 `dropAiReplyMessageListRecord`
 * 的区别只有「允许 failed 状态」）。传 `includeTerminal` 时放开「历史事实」——允许删掉
 * 已成功 / 已发出未确认 / 已失败的记录，但**在途状态与未结束的下游任务仍然拒绝**：
 * 删除行不会取消在途模型调用，也不会让正在出网的投递停下来。
 *
 * 删除按 sourceRef/segment_group_ref 整组进行，避免只删掉基础记录却留下分段。
 * 记录不存在算 skipped，因此重复清理幂等。
 * @param decryptedDir - 解密数据根。
 * @param rawIds - 调用方选中的记录 id。
 * @param options.includeTerminal - 是否允许删除已收口的终态记录。
 */
export declare function deleteAiReplyMessageListRecordsForCleanup(decryptedDir: string, rawIds: readonly number[], options?: {
    includeTerminal?: boolean;
}): AiReplyReservationCleanupResult;
