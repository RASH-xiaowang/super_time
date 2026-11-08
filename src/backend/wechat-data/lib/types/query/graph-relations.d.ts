import type { GraphEdge, GraphEdgeType } from '../types.ts';
/** Hard cap on the explicit edge payload returned to the renderer. */
export declare const GRAPH_MAX_OBSERVED_EDGES = 20000;
/** Deterministic CPU budget for pair derivation across all groups/members. */
export declare const GRAPH_PAIR_WORK_BUDGET = 250000;
/** Keep per-edge proofs small even when a relation repeats thousands of times. */
export declare const GRAPH_EDGE_EVIDENCE_CAP = 8;
export type GraphMembershipEvidence = 'chatroom_member' | 'chatroom_snapshot';
/** One locally observed membership; unknown actors are filtered by the extractor. */
export interface GraphMembershipRecord {
    username: string;
    sources: readonly GraphMembershipEvidence[];
}
/** A structured inviter -> invitee observation from the group member snapshot. */
export interface GraphInviteRecord {
    group: string;
    inviter: string;
    invitee: string;
}
/** A reply or group @ mention extracted from the bounded message window. */
export interface GraphMessageRelationRecord {
    group: string;
    sender: string;
    target: string;
    /** Reply targets are ordered by confidence: chatusr first, fromusr fallback. */
    targets?: readonly string[];
    type: 'reply' | 'mention_user';
    count: number;
}
/** Directed call activity between the logged-in account and one private peer. */
export interface GraphCallRelationRecord {
    /** 会话微信 ID —— 正名见 `WechatSession.username`。 */
    talker: string;
    outgoing: number;
    incoming: number;
}
/** Audit data returned alongside the bounded observed-edge build. */
export interface GraphRelationCoverage {
    derived_pairs: {
        budget: number;
        used: number;
        truncated: boolean;
        common_group: {
            candidates: number;
            emitted: number;
        };
        common_member: {
            candidates: number;
            emitted: number;
        };
    };
    dropped_edges: number;
    dropped_by_type: Partial<Record<GraphEdgeType, number>>;
    unresolved_actors: {
        membership: number;
        owner: number;
        invite: number;
        message_relation: number;
        total: number;
    };
}
/** Inputs prepared by `queryGraph`; all identities are authoritative local ids. */
export interface GraphRelationInput {
    decryptedDir: string;
    selfUsername?: string;
    personIds: ReadonlySet<string>;
    groupIds: ReadonlySet<string>;
    friendIds: ReadonlySet<string>;
    privateTalkers: ReadonlySet<string>;
    /** Talkers still present in a live session row (evidence-only distinction). */
    sessionTalkers: ReadonlySet<string>;
    /** Private or group conversations proven by a current session or message table. */
    sessionGroups: ReadonlySet<string>;
    messageCounts: ReadonlyMap<string, number>;
    groupSenderCounts: ReadonlyMap<string, ReadonlyMap<string, number>>;
    membershipByGroup: ReadonlyMap<string, readonly GraphMembershipRecord[]>;
    groupOwners: ReadonlyMap<string, string>;
    invites: readonly GraphInviteRecord[];
    messageRelations: readonly GraphMessageRelationRecord[];
    callRelations: readonly GraphCallRelationRecord[];
}
/**
 * Build all explicit edges from locally verified evidence.
 *
 * @param input - stable node ids plus authoritative membership/session data.
 * @returns deduplicated, deterministically ordered edges.
 */
export declare function buildObservedEdges(input: GraphRelationInput, coverage?: GraphRelationCoverage): Promise<GraphEdge[]>;
