import type { DatabaseSync } from '../db-open.ts';
import { decideProposal, type MemoryFact, type ProposalDecision } from './decision.ts';
export interface AgentControl {
    killed: boolean;
    shadow: boolean;
    quietStart: string;
    quietEnd: string;
    cooldownMs: number;
    hourCap: number;
    dayCap: number;
    proactiveHourCap: number;
    /** 转人工后，自动回复先停，草稿仍可手动用 Webhook 发出。 */
    handoff: boolean;
    updatedAt: number;
}
export interface AgentMemory extends MemoryFact {
    accountKey: string;
    updatedAt: number;
}
export interface AgentProposal {
    id: number;
    accountKey: string;
    eventKey: string;
    decision: ProposalDecision;
    reasonCode: string;
    score: number;
    body: string;
    status: 'open' | 'accepted' | 'dismissed';
    createdAt: number;
}
export interface AgentAuditEntry {
    id: number;
    hash: string;
    actor: string;
    action: string;
    target: string;
    summary: string;
    createdAt: number;
}
export interface AgentPromise {
    id: number;
    accountKey: string;
    text: string;
    dueAt: number;
    status: 'open' | 'done';
}
export declare function readAgentControl(decryptedDir: string): AgentControl;
export declare function saveAgentControl(decryptedDir: string, patch: Partial<Omit<AgentControl, 'updatedAt'>>): AgentControl;
export declare function readReplyBudget(decryptedDir: string, accountKey: string, chatUsername: string, now?: number): {
    hourCount: number;
    dayCount: number;
    lastSentAt: number;
};
export declare function noteReplySent(decryptedDir: string, accountKey: string, chatUsername: string, now?: number): void;
export declare function listAgentMemories(decryptedDir: string, accountKey: string): AgentMemory[];
export declare function writeAgentMemory(decryptedDir: string, input: {
    accountKey: string;
    scope: MemoryFact['scope'];
    scopeKey: string;
    kind: MemoryFact['kind'];
    text: string;
}): {
    ok: boolean;
    op: string;
    error?: string;
};
export declare function deleteAgentMemory(decryptedDir: string, accountKey: string, id: number): boolean;
/** 给模型的记忆块。失败或没有记忆时返回空串，不能挡住回复。 */
export declare function memoryPromptBlock(decryptedDir: string, accountKey: string, chatUsername: string): string;
export declare function listAgentProposals(decryptedDir: string, accountKey: string): AgentProposal[];
export declare function rememberEvent(db: DatabaseSync, source: string, entity: string, version: string, now: number): boolean;
export declare function insertProposal(db: DatabaseSync, accountKey: string, source: string, entity: string, version: string, body: string, decision: ReturnType<typeof decideProposal>, now: number): void;
export declare function setProposalStatus(decryptedDir: string, accountKey: string, id: number, status: 'accepted' | 'dismissed'): boolean;
export declare function listAgentPromises(decryptedDir: string, accountKey: string): AgentPromise[];
export declare function addAgentPromise(decryptedDir: string, accountKey: string, text: string, dueAt: number): boolean;
export declare function listAgentAudit(decryptedDir: string): AgentAuditEntry[];
export interface AgentTickResult {
    created: number;
    skipped: number;
    executed: number;
    delta: number;
}
/**
 * 主动调度的一拍。到期承诺写成提案，日报类错过就跳过。
 * 这一拍不调用发送程序。
 */
export declare function runAgentTick(decryptedDir: string, accountKey: string, now?: number): AgentTickResult;
/**
 * 用户点了发送才记一笔审批。失败的发送保持已批准，可以再试；成功后消费，不能重放。
 */
export declare function beginSendApproval(decryptedDir: string, callId: string, argsHash: string): boolean;
export declare function finishSendApproval(decryptedDir: string, callId: string, argsHash: string): boolean;
export declare function readAgentDesk(decryptedDir: string, accountKey: string): {
    control: AgentControl;
    memories: AgentMemory[];
    proposals: AgentProposal[];
    promises: AgentPromise[];
    audit: AgentAuditEntry[];
    reconcile: {
        expected: number;
        executed: number;
        skipped: number;
        delta: number;
    };
    channels: Readonly<Record<"feather-webhook" | "feather-text" | "generic", import("./decision.ts").ChannelCapability>>;
};
export declare function readAgentReconcile(decryptedDir: string): {
    expected: number;
    executed: number;
    skipped: number;
    delta: number;
};
