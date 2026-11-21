import { type OutboundAction } from './decision.ts';
export interface ReplyGateInput {
    accountKey: string;
    chatUsername: string;
    group: boolean;
    kbEnabled: boolean;
    phase: 'preflight' | 'postflight';
    hasAttachment?: boolean;
    channel?: 'feather-webhook' | 'feather-text' | 'generic';
}
export interface ReplyGateDecision {
    action: 'proceed' | 'defer' | 'send' | 'hold';
    reason: string;
    reasonCode: string;
}
export declare function assessReplyOutbound(decryptedDir: string, input: ReplyGateInput, now?: Date): ReplyGateDecision;
export declare function rememberReplySent(decryptedDir: string, accountKey: string, chatUsername: string): void;
/**
 * 自动投递路径上的最后一道闸。只拦「必须先草稿」；静默和额度返回 defer，
 * 记录保持 pending，时间到了还能发。人工单条重发不走这里。
 */
export declare function automaticReplyBlock(decryptedDir: string, sourceRef: string | undefined, chatUsername: string): ReplyGateDecision | undefined;
export type { OutboundAction };
