import type { Context } from '@deepseek-ai/cordis';
import type { ChatAiReplyContextImage } from './context.ts';
import type { ChatAiReplyGenerationResult } from './types.ts';
export type ChatAiReplyGenerateFn = (input: {
    system: string;
    prompt: string;
    /** 已解码的图片；默认生成器会把它作为 OpenAI 兼容的 image_url 发送。 */
    images?: ChatAiReplyContextImage[];
    accountKey: string;
    chatUsername: string;
}) => Promise<ChatAiReplyGenerationResult>;
export interface ChatAiReplyGeneratorDeps {
    ctx: () => Context;
}
/** 默认生成器：使用 DSH 设置中的对话模型，并限制单次输出长度。 */
export declare function createDefaultChatAiReplyGenerator(deps: ChatAiReplyGeneratorDeps): ChatAiReplyGenerateFn;
