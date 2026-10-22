import type { DatabaseSync } from '../db-open.ts';
/** 连续入站消息的默认合并窗口。 */
export declare const DEFAULT_REPLY_DEBOUNCE_MS = 1000;
/** 生成阶段租约：进程崩溃后超过该时间仍停在 generating，恢复器可重新处理。 */
export declare const REPLY_GENERATING_LEASE_MS = 60000;
/** 发送阶段租约：给发送请求留出足够时间，避免另一个 worker 立刻重复发送。 */
export declare const REPLY_SENDING_LEASE_MS = 30000;
/** `listRecoverableReplyRuns` 默认单次上限。 */
export declare const DEFAULT_REPLY_RECOVERABLE_LIMIT = 100;
/** `listRecoverableReplyRuns` 单次硬上限。 */
export declare const MAX_REPLY_RECOVERABLE_LIMIT = 1000;
export type ClawbotReplyRunStatus = 'debouncing' | 'queued' | 'generating' | 'ready' | 'sending' | 'done' | 'failed' | 'skipped';
export type ClawbotReplyPartStatus = 'pending' | 'sending' | 'sent' | 'failed';
export interface ClawbotReplyRun {
    id: number;
    slot: number;
    targetMessageId: number;
    question: string;
    status: ClawbotReplyRunStatus;
    attempts: number;
    lastError: string | null;
    /** 白名单运行详情 JSON；null = 旧行或尚未生成摘要。 */
    resultJson: string | null;
    nextAttemptAt: number;
    createdAt: number;
    updatedAt: number;
}
export interface ClawbotReplyPart {
    id: number;
    runId: number;
    partIndex: number;
    slot: number;
    text: string;
    clientId: string;
    status: ClawbotReplyPartStatus;
    attempts: number;
    sentMessageId: number | null;
    lastError: string | null;
    createdAt: number;
    updatedAt: number;
}
export interface ClawbotReplyRunSnapshot {
    run: ClawbotReplyRun;
    parts: ClawbotReplyPart[];
}
/**
 * 一条带 owner 与单调 fence 的租约。
 *
 * `until` 只用于判断接管窗口；真正防止旧 worker 晚到覆盖的是
 * `(owner, fence)` 成对比较。接管时两者一起变化，旧回填即使晚于租约也不会命中。
 */
export interface ClawbotReplyLease {
    owner: string;
    fence: number;
    until: number;
}
export interface ClawbotReplyGenerationClaim {
    run: ClawbotReplyRun;
    lease: ClawbotReplyLease;
}
export interface ClawbotReplySendClaim {
    part: ClawbotReplyPart;
    /** outbox 行上的租约。 */
    lease: ClawbotReplyLease;
    /** run 行上的串行化租约，保证同一 run 的多段不被多个 worker 并行发送。 */
    runLease: ClawbotReplyLease;
}
export interface ClawbotReplyFailedClaimResult {
    part: ClawbotReplyPart;
    run: ClawbotReplyRun;
}
/** 一页消息对应的 run 关联：target = 入站目标，sent = 出站分段。 */
export interface ClawbotReplyRunAttachments {
    target: Map<number, ClawbotReplyRun>;
    sent: Map<number, ClawbotReplyRun>;
}
export interface ClaimReplyRunGenerationInput {
    runId: number;
    owner: string;
    now?: number;
    leaseMs?: number;
}
export interface ClaimReplyPartSendingInput {
    partId: number;
    owner: string;
    now?: number;
    leaseMs?: number;
}
export interface EnqueueReplyRunInput {
    slot: number;
    targetMessageId: number;
    question: string;
    debounceMs?: number;
    /** 该 slot 允许的非终态 run 上限；缺省/非正数 = 不额外限制。 */
    maxPending?: number;
    now?: number;
}
/** 分段输入：允许直接传字符串，也允许传带 text 的对象，便于上层保留自己的结构。 */
export type ClawbotReplyPartInput = string | {
    text: string;
};
export interface ClearClawbotReplyStateResult {
    removedRuns: number;
    removedParts: number;
}
/**
 * 入队或在 debounce 窗口内合并。
 *
 * 同一 `(slot, targetMessageId)` 永远返回已有 run（包括已终态的 run）；否则若本实例
 * 存在尚未到期的 `debouncing` run，就把 target/question/nextAttemptAt 更新为最新触发。
 * 更早消息仍可从 `clawbot_message` 的历史上下文读取。
 */
export declare function enqueueOrMergeReplyRun(dir: string, input: EnqueueReplyRunInput): ClawbotReplyRun;
/**
 * 在调用方已打开的写事务里入队/合并。
 *
 * 接收通道用它在「消息批量落库」的同一事务里创建 run，消除「消息已提交、回复任务
 * 尚未创建」的窗口。调用方负责事先执行 `ensureClawbotSchema` 并提交/回滚事务。
 */
export declare function enqueueOrMergeReplyRunOn(db: DatabaseSync, input: EnqueueReplyRunInput): ClawbotReplyRun;
/** 读一条 run 及其全部分段；库/表不存在或 run 不存在时返回 null。 */
export declare function readReplyRun(dir: string, runId: number): ClawbotReplyRunSnapshot | null;
/**
 * 列出所有非终态 run。
 *
 * 未来才到期的 run 也会返回：调用方按 `nextAttemptAt` 调度，而不是在 debounce
 * 窗口内重启后把 pending 行漏掉。已到期的行优先，其次按 nextAttemptAt / id 排序。
 */
export declare function listRecoverableReplyRuns(dir: string, now?: number, limit?: number): ClawbotReplyRun[];
/**
 * 按单调 id 游标分页读取全部非终态 run。
 *
 * 恢复器需要吸收超过单页上限的积压，不能按 next_attempt_at 做游标：同一时间窗口内
 * run 可能被更新或新增，非单调排序会造成漏行。此函数只按自增 id 前进，并保留旧版
 * `listRecoverableReplyRuns` 的默认行为不变。
 */
export declare function listRecoverableReplyRunsAfterId(dir: string, afterId?: number, limit?: number): ClawbotReplyRun[];
/**
 * 原子 claim 一次生成权。
 *
 * 候选必须满足：状态可生成、已到 nextAttemptAt、当前租约已过期、尚无 outbox。
 * 所有判断与 `attempts + 1 / owner / until / fence` 更新都在同一个
 * `BEGIN IMMEDIATE` 事务里完成；未抢到或 lease 仍有效时返回 null。
 */
export declare function claimReplyRunGeneration(dir: string, input: ClaimReplyRunGenerationInput): ClawbotReplyGenerationClaim | null;
/**
 * 原子 claim 一条 outbox 发送权。
 *
 * 同时占用 part 与 run 两层租约：part 防同一段重复发送，run 防同一回复的多段被
 * 多个 worker 并行乱序发送。两层都过期后才能被另一个 owner 接管。
 */
export declare function claimReplyPartSending(dir: string, input: ClaimReplyPartSendingInput): ClawbotReplySendClaim | null;
/**
 * 续租生成 claim。
 *
 * 续租只在 owner/fence 仍匹配时成功；进程崩溃或已被接管后返回 null。
 * 续租不改变 fence，避免把同一 owner 的正常长任务误判为竞争者。
 */
export declare function renewReplyRunGenerationClaim(dir: string, claim: ClawbotReplyGenerationClaim, leaseMs?: number, now?: number): ClawbotReplyGenerationClaim | null;
/**
 * 续租发送 claim（part + run 两层）。
 *
 * 只有当前 owner/fence 仍持有两层租约时才续租；任一层被接管都返回 null。
 */
export declare function renewReplyPartSendingClaim(dir: string, claim: ClawbotReplySendClaim, leaseMs?: number, now?: number): ClawbotReplySendClaim | null;
/**
 * 在生成 claim 的 fencing 保护下写入分段。
 *
 * 旧 owner 在租约过期、另一 worker 接管后调用会返回 null 且不写任何行。
 * 同一 claim 重复提交是幂等的：run 已 ready 时直接返回现有分段。
 */
export declare function saveReplyPartsClaimed(dir: string, claim: ClawbotReplyGenerationClaim, parts: readonly ClawbotReplyPartInput[], now?: number, resultJson?: string | null): ClawbotReplyPart[] | null;
/** fenced 生成失败回退；旧 owner 返回 null，不覆盖接管者。 */
export declare function markReplyRunRetryClaimed(dir: string, claim: ClawbotReplyGenerationClaim, error?: string | null, nextAttemptAt?: number, now?: number, resultJson?: string | null): ClawbotReplyRun | null;
/** fenced 生成永久失败；旧 owner 返回 null。 */
export declare function markReplyRunFailedClaimed(dir: string, claim: ClawbotReplyGenerationClaim, error?: string | null, now?: number, resultJson?: string | null): ClawbotReplyRun | null;
/** fenced 策略跳过；旧 owner 返回 null，不覆盖接管者。 */
export declare function markReplyRunSkippedClaimed(dir: string, claim: ClawbotReplyGenerationClaim, reason?: string | null, now?: number, resultJson?: string | null): ClawbotReplyRun | null;
/**
 * 在发送 claim 的 fencing 保护下标记 success。
 *
 * 旧 owner 在 lease 过期并被接管后调用会返回 null；新 owner 的 sent 状态不会被覆盖。
 * 成功后只释放 `lease_until`，保留 owner/fence 供随后的 run done/failed 做二次校验。
 */
export declare function markReplyPartSentClaimed(dir: string, claim: ClawbotReplySendClaim, sentMessageId?: number | null, now?: number): ClawbotReplyPart | null;
/** fenced 发送可重试失败；旧 owner 返回 null，不覆盖接管者。 */
export declare function markReplyPartRetryClaimed(dir: string, claim: ClawbotReplySendClaim, error?: string | null, nextAttemptAt?: number, now?: number): ClawbotReplyPart | null;
/** fenced 发送永久失败；旧 owner 返回 null。 */
export declare function markReplyPartFailedClaimed(dir: string, claim: ClawbotReplySendClaim, error?: string | null, now?: number): ClawbotReplyPart | null;
/**
 * 同一事务内终结失败分段与其 run，消除“part 已 failed、run 仍 sending”的崩溃窗口。
 *
 * 任一层 owner/fence 不匹配都会整体返回 null；不会出现只写一半的状态。
 */
export declare function failReplyPartAndRunClaimed(dir: string, claim: ClawbotReplySendClaim, error?: string | null, now?: number, resultJson?: string | null): ClawbotReplyFailedClaimResult | null;
/**
 * 全部 outbox 已 sent 后结束 run。
 *
 * 这里不要求 lease 尚未过期：sent/failed 回填会保留 owner/fence 并把 until 归零，
 * 后续收尾仍由同一 claim 完成；一旦别的 worker 接管，owner/fence 已变，本函数返回 null。
 */
export declare function markReplyRunDoneClaimed(dir: string, claim: ClawbotReplySendClaim, now?: number, resultJson?: string | null): ClawbotReplyRun | null;
/** 发送阶段整条 run 永久失败；同样受最后一次 send claim 的 owner/fence 保护。 */
export declare function markReplyRunFailedAfterSendClaimed(dir: string, claim: ClawbotReplySendClaim, error?: string | null, now?: number, resultJson?: string | null): ClawbotReplyRun | null;
/** 开始一次生成尝试；attempts 加一，并设置生成租约。 */
export declare function markReplyRunGenerating(dir: string, runId: number, now?: number): ClawbotReplyRun;
/** 生成失败后回到 queued，并记录下一次尝试时间。 */
export declare function markReplyRunRetry(dir: string, runId: number, error?: string | null, nextAttemptAt?: number, now?: number): ClawbotReplyRun;
/** run 完成。 */
export declare function markReplyRunDone(dir: string, runId: number, now?: number): ClawbotReplyRun;
/** run 永久失败。 */
export declare function markReplyRunFailed(dir: string, runId: number, error?: string | null, now?: number): ClawbotReplyRun;
/** run 被策略跳过。 */
export declare function markReplyRunSkipped(dir: string, runId: number, reason?: string | null, now?: number): ClawbotReplyRun;
/** 全部 outbox 已 sent 且无人持租约时完成 run。 */
export declare function markReplyRunDoneIfIdle(dir: string, runId: number, now?: number, resultJson?: string | null): ClawbotReplyRun | null;
/** 无活动 claim 时把 run 标记为永久失败。 */
export declare function markReplyRunFailedIfIdle(dir: string, runId: number, error?: string | null, now?: number, resultJson?: string | null): ClawbotReplyRun | null;
/** 无活动 claim 时按策略跳过 run。 */
export declare function markReplyRunSkippedIfIdle(dir: string, runId: number, reason?: string | null, now?: number, resultJson?: string | null): ClawbotReplyRun | null;
export declare function saveReplyParts(dir: string, runId: number, parts: readonly ClawbotReplyPartInput[], now?: number): ClawbotReplyPart[];
/**
 * 标记一次实际发送尝试。
 *
 * `attempts` 在每次 claim 时递增（包括恢复后重新 claim 仍停在 sending 的行），
 * 这样连续崩溃/超时不能绕过发送上限。已 sent 或已永久 failed 的分段不会被重新打开。
 * 发送租约只写 `lease_until`；`next_attempt_at` 仅由 debounce/retry 更新。
 */
export declare function markReplyPartSending(dir: string, partId: number, now?: number): ClawbotReplyPart;
/**
 * 标记分段发送成功。
 *
 * 幂等：重复调用不增加 attempts，`sent_message_id` 只保留第一次非空值。
 * 成功回填在同一事务内释放 part/run 租约，但不改写 `next_attempt_at`。
 */
export declare function markReplyPartSent(dir: string, partId: number, sentMessageId?: number | null, now?: number): ClawbotReplyPart;
/** 分段发送失败但可重试：回到 pending，并让 run 重新进入可调度状态。 */
export declare function markReplyPartRetry(dir: string, partId: number, error?: string | null, nextAttemptAt?: number, now?: number): ClawbotReplyPart;
/** 分段永久失败。run 的终态由调用方按整批结果决定。 */
export declare function markReplyPartFailed(dir: string, partId: number, error?: string | null, now?: number): ClawbotReplyPart;
/** 清理某实例的 run 与 outbox（同一事务，先删子表再删 run）。 */
export declare function clearClawbotReplyState(dir: string, slot: number): ClearClawbotReplyStateResult;
