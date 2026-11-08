import type { MessageListDispatchDeps } from '../query/message-list-dispatch.ts';
import type { RetryFetch } from '../net/fetch-retry.ts';
export interface MessageListDispatchDirs {
    decrypted: string;
    decoded: string;
}
export interface MessageListImageContext {
    wechatBaseDir?: string;
    aesKey?: string;
    xorKey: number;
}
export interface MessageListDispatchDepsInput {
    dirs: () => MessageListDispatchDirs;
    imageContext: () => MessageListImageContext;
    privacyGate: (feature: string, stats: {
        sessions: number;
        messages: number;
    }, texts: string[]) => string[];
    fetchImpl?: RetryFetch;
}
export declare function createMessageListDispatchDeps(input: MessageListDispatchDepsInput): MessageListDispatchDeps;
