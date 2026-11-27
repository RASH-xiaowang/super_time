/** Independent group-KB confirmation barrier; ordinary reply generation remains unchanged. */
import type { ChatAiReplyScanDeps, ChatAiReplyState } from './types.ts';
import type { ChatAiReplyRunRef } from './runner-state.ts';
export declare function holdReplyIfRequired(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef): Promise<'send' | 'held' | 'blocked'>;
export declare function deliverChatAiReply(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef, isCancelled: () => boolean, dispatch: (deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef, isCancelled: () => boolean) => Promise<boolean>): Promise<boolean>;
