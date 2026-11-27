import type { ToolSchema } from '@deepseek-ai/dsh-llm';
import type { ReplyToolContext, ReplyToolResult } from './types.ts';
export declare const REPLY_TOOL_SCHEMAS: ToolSchema[];
/** Runtime validation mirrors the small schema vocabulary above; model output is untrusted. */
export declare function validateReplyToolArgs(name: string, value: unknown): value is Record<string, unknown>;
export declare function executeReplyTool(name: string, args: unknown, ctx: ReplyToolContext): Promise<ReplyToolResult>;
