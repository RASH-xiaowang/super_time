import type { MessageListRecord, MessageListStatus } from '../types.ts';
/** 投递结果回写（状态、错误、尝试次数、下游返回的任务 id）。 */
export declare function saveMessageListDispatchResult(decryptedDir: string, id: number, outcome: {
    status: MessageListStatus;
    error: string;
    responseSummary: string;
    /** 下游返回的回复 id；与 Feather 的异步任务 id 分开保存。 */
    replyId?: string;
    jobId?: string;
    jobState?: string;
    webhookUrl?: string;
    /** 只有真正发出 HTTP 请求时才累加尝试次数。 */
    countAttempt?: boolean;
}): MessageListRecord | undefined;
/**
 * 投递归属意图。
 *
 * - automatic：后台批次、新建后立即投递、AI 即时投递，只允许 pending；
 * - manual_single：用户明确重发单条，可重试 success/failed/sent_unconfirmed；
 * - manual_batch：用户批量勾选，只允许 pending/failed，避免批量误发已成功或待核对记录。
 */
export type MessageListDispatchIntent = 'automatic' | 'manual_single' | 'manual_batch';
/** 某条记录当前状态是否允许由该意图认领；用于认领前的快速、只读判定。 */
export declare function messageListRecordCanBeClaimed(status: MessageListStatus, intent: MessageListDispatchIntent): boolean;
/**
 * 出网前的数据库原子认领。
 *
 * 自动/AI 路径只接受 pending；只有用户明确单条重发时才接受 success、failed 与
 * sent_unconfirmed。批量入口在 SQL 层收紧为 pending/failed，不能借人工路径绕过。
 * 成功后立刻写成 dispatching，既阻止第二个进程重复选中，也不会在「HTTP 已经发出、
 * 回写却失败」时退回 pending。dispatching 不自动回收；sent_unconfirmed 只允许人工
 * 核对后单条重发，绝不进入自动批量，避免重复发微信。
 */
export declare function claimMessageListRecordForDispatch(decryptedDir: string, id: number, webhookUrl?: string, intent?: MessageListDispatchIntent): MessageListRecord | undefined;
/**
 * 把上一进程遗留的 dispatching 记录收口为 sent_unconfirmed。
 *
 * 认领发生在 HTTP 请求之前，因此无法从库中判断请求是否真正发出。依据“宁可不自动
 * 重发，也不重复发微信”的边界，这里只允许人工核对后单条重发或删除，绝不放回 pending。
 * 新进程启动不代表旧进程已经死亡：只回收超过投递超时窗口的认领，避免把其他进程
 * 正在进行的 HTTP 请求误判为崩溃。
 */
export declare function recoverInterruptedMessageListDispatches(decryptedDir: string, staleAfterMs?: number, now?: number): number;
/**
 * 保存下游异步任务查询结果。
 *
 * queued/running/succeeded/failed 是下游任务的明确状态，必须同步到本地
 * 投递台账；否则 202 排队记录会永远停在“已成功”，或失败后仍可被误认为成功。
 * 未知状态只更新 job_state，不猜测投递结果。终态不回退，running 也不会回退到 queued。
 */
export declare function saveMessageListJobResult(decryptedDir: string, id: number, input: {
    jobId: string;
    jobState: string;
    error?: string;
}): MessageListRecord | undefined;
