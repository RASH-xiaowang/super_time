import type { ChatAiReplyRunRef } from './runner-state.ts';
import type { ChatAiReplyScanDeps, ChatAiReplyState } from './types.ts';
/** 一次生成的结果；`canceled` 时 `text` 只含已经流出的部分正文。 */
export interface ChatAiReplyGeneration {
    text: string;
    canceled: boolean;
}
export declare function generateChatAiReply(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef): Promise<ChatAiReplyGeneration>;
