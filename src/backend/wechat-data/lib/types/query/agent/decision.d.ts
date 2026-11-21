/**
 * 调研报告里可以在本机算完的决策。
 *
 * 这里没有数据库、也没有出网。AI 回复发送前、记忆写入、主动提案和工具审批
 * 都先问这些纯函数，避免每一层各写一套门槛。
 *
 * @module query/agent/decision
 */
export type OutboundAction = 'send' | 'hold' | 'defer' | 'drop';
export interface OutboundFacts {
    killed: boolean;
    /** `HH:MM`，空串表示没有静默时段。 */
    quietStart: string;
    quietEnd: string;
    hour: number;
    minute: number;
    cooldownMs: number;
    lastSentAt: number;
    nowMs: number;
    hourCount: number;
    hourCap: number;
    dayCount: number;
    dayCap: number;
    group: boolean;
    kbEnabled: boolean;
    /** 主动外发，而不是对方刚发来的消息。 */
    proactive: boolean;
    /** 影子模式：只记录决策，不把主动消息送出本机。 */
    shadow: boolean;
    /** 收件人就是使用者本人（例如文件传输助手）。 */
    recipientIsSelf: boolean;
    /** 触发来自本机可信日程，而不是聊天正文。 */
    triggerTrusted: boolean;
    channel: 'feather-webhook' | 'feather-text' | 'generic';
    hasAttachment: boolean;
    /** 用户点了转人工，自动回复先停。 */
    handoff: boolean;
}
export interface OutboundDecision {
    action: OutboundAction;
    reasonCode: string;
    reason: string;
}
/** `HH:MM` → 当天分钟；非法返回 null。 */
export declare function parseClock(value: string): number | null;
/** 静默时段可跨午夜。起止相同或有一端非法时视为未设置。 */
export declare function inQuietHours(start: string, end: string, hour: number, minute: number): boolean;
/**
 * 发送前的资格闸。
 *
 * 顺序固定：紧急停止、静默、冷却、配额，然后才是「能不能自动发出去」。
 * 群聊同时使用知识库，或主动消息不是「可信触发 + 只发给本人」，都改成草稿。
 */
export declare function evaluateOutbound(facts: OutboundFacts): OutboundDecision;
export interface ChannelCapability {
    id: string;
    text: boolean;
    image: boolean;
    buttons: boolean;
    editSent: boolean;
    readReceipt: boolean;
    groupMention: boolean;
    stream: boolean;
    /** 发送不走公众号客服窗口，走 Webhook 的 target/message。 */
    serviceWindow: 'none';
    maxUtf16: number;
}
export declare const CHANNELS: Readonly<Record<OutboundFacts['channel'], ChannelCapability>>;
/** Webhook 发送不看客服会话窗口。文本、附件和群 @ 都按这套地址发。 */
export declare function serviceWindowOpen(channel: OutboundFacts['channel']): {
    open: boolean;
    reason: string;
};
/** 渠道做不到卡片时，降成纯文本。 */
export declare function degradeToText(text: string): string;
export type MemoryOp = 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';
export interface MemoryFact {
    id: number;
    scope: 'user' | 'conversation';
    scopeKey: string;
    kind: 'semantic' | 'episode' | 'profile' | 'relation' | 'promise';
    text: string;
    status: 'active' | 'disputed' | 'deleted';
}
export interface MemoryPlan {
    op: MemoryOp;
    status: MemoryFact['status'];
    text: string;
    /** 冲突时不覆盖旧事实，调用方要把它标成 disputed。 */
    disputeId?: number;
}
export declare function normalizeMemoryText(value: string): string;
/**
 * 记忆写入准入。相同正文不重复记；新旧事实打架时两份都留，并标 disputed。
 */
export declare function planMemoryWrite(existing: readonly MemoryFact[], incoming: {
    scope: MemoryFact['scope'];
    scopeKey: string;
    kind: MemoryFact['kind'];
    text: string;
    replaceId?: number;
}): MemoryPlan;
export type ProposalDecision = 'send' | 'digest' | 'hold' | 'drop';
export interface ProposalInput {
    duplicate: boolean;
    killed: boolean;
    quiet: boolean;
    nothingHappened: boolean;
    needProb: number;
    value: number;
    acceptProb: number;
    interruptCost: number;
    ignoreCost: number;
    computeCost: number;
    ageHours: number;
    decay: number;
    threshold: number;
    confidence: number;
    hourCount: number;
    hourCap: number;
    shadow: boolean;
    triggerTrusted: boolean;
    recipientIsSelf: boolean;
}
export interface ProposalResult {
    decision: ProposalDecision;
    reasonCode: string;
    score: number;
}
/** 报告里的期望效用。低于门槛就不要推进聊天主线程。 */
export declare function expectedUtility(input: Pick<ProposalInput, 'needProb' | 'value' | 'acceptProb' | 'interruptCost' | 'ignoreCost' | 'computeCost' | 'ageHours' | 'decay'>): number;
/**
 * 主动消息的三道闸：资格、价值、预算。
 * 影子模式和「不是发给本人的可信日程」把 send 降成 hold，调用方不得据此出网。
 */
export declare function decideProposal(input: ProposalInput): ProposalResult;
export type MisfirePolicy = 'skip' | 'run_once';
/** 日报错过就跳过；提醒错过只补跑一次。 */
export declare function applyMisfire(policy: MisfirePolicy, lateMs: number, kind: 'digest' | 'reminder'): 'skip' | 'run';
export declare function reconcileCounts(expected: number, executed: number, skipped: number): {
    ok: boolean;
    delta: number;
};
export type ToolErrorClass = 'E_TRANSIENT' | 'E_RATE_LIMIT' | 'E_VALIDATION' | 'E_AUTH' | 'E_NOT_FOUND' | 'E_CONFLICT' | 'E_TIMEOUT' | 'E_PERMANENT';
export declare function classifyToolError(status: number): ToolErrorClass;
/** 只有暂时失败和限流可以退避重试。校验错误重试没有意义。 */
export declare function shouldRetryTool(kind: ToolErrorClass): boolean;
export interface ToolResultView {
    preview: string;
    truncated: boolean;
    artifactId: string;
}
/** 超预算的工具结果只留预览和指针，不把全文塞进上下文。 */
export declare function governToolResult(text: string, maxChars: number, artifactId: string): ToolResultView;
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'consumed';
export declare function consumeApproval(status: ApprovalStatus, argsHash: string, snapshotHash: string): ApprovalStatus | 'reject';
export interface DeliveryParts {
    channel: string;
    account: string;
    outboundId: string;
}
/** 四层幂等键。eventId 只标识传输，不能拿来当「这条回复只发一次」。 */
export declare function deliveryKey(parts: DeliveryParts): string;
export declare function messageKey(channel: string, account: string, platformMessageId: string): string;
export declare function toolIdempotencyKey(runId: string, callId: string): string;
export declare function eventKey(source: string, entity: string, version: string): string;
