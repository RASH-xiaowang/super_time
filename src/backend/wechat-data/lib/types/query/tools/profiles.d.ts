import { type RetrievalTool, type ToolContext, type ToolName, type ToolResult } from './types.ts';
import type { HybridSearchMode } from './search-hybrid-tool.ts';
/** profile 标识（调用方用稳定字符串选择边界）。 */
export type AnswerProfileId = 'wechat-ask' | 'session-ask' | 'clawbot-auto';
/** 一个问答入口的工具与数据边界。 */
export interface AnswerProfile {
    id: AnswerProfileId;
    /** 面向人与日志的名称。 */
    label: string;
    /** 允许模型看到的工具白名单。 */
    allowedTools: readonly ToolName[];
    /** 是否允许访问本机微信数据（消息/联系人/朋友圈/收藏/文件/账单）。 */
    allowWechatData: boolean;
    /** 是否允许访问知识库。 */
    allowKnowledgeBase: boolean;
    /** `true` = 整个入口就是 kb-only（ClawBot）。 */
    kbOnly: boolean;
    /** 是否要求执行上下文里必须有 kbId。 */
    requireKb: boolean;
    /** 是否强制使用 `ctx.scope.username`（会话内问答）。 */
    forceUsername: boolean;
    /** `search_hybrid` 允许的模式；缺省 = 不限制。 */
    hybridModes?: readonly HybridSearchMode[];
    /** 工具是否只读；未来若加入有副作用工具，重试器据此禁止自动重放。 */
    sideEffectTools?: readonly ToolName[];
}
/** 三个入口的边界定义。 */
export declare const ANSWER_PROFILES: Readonly<Record<AnswerProfileId, AnswerProfile>>;
/** 全部 profile（按固定顺序，便于界面与测试）。 */
export declare const ALL_ANSWER_PROFILES: readonly AnswerProfile[];
/** 取 profile（不存在时回退到权限最小的 clawbot-auto，而不是全量权限）。 */
export declare function getAnswerProfile(id: string): AnswerProfile;
/** 工具是否在该 profile 的白名单内（纯判断，不执行）。 */
export declare function isToolAllowed(profile: AnswerProfile | AnswerProfileId, name: string): boolean;
/** 只保留 profile 白名单内的工具（保持传入顺序）。 */
export declare function filterToolsForProfile(profile: AnswerProfile | AnswerProfileId, tools: readonly RetrievalTool[]): RetrievalTool[];
/**
 * 按本轮执行上下文过滤工具。
 *
 * `list_sessions` 是“先确定范围”的发现类工具，无法应用固定会话/日期范围。
 * 在范围已锁定的轮次继续把它暴露给模型，只会得到一个 `unsupported_scope`，
 * 既浪费一次调用预算，也会诱导模型反复换排序参数重试。
 *
 * @param profileRef - profile 或 id。
 * @param tools - 已按 profile 过滤的工具集。
 * @param ctx - 本轮执行上下文（范围是硬过滤）。
 * @returns 可在本轮安全调用的工具集。
 */
export declare function filterToolsForScope(profileRef: AnswerProfile | AnswerProfileId, tools: readonly RetrievalTool[], ctx: ToolContext): RetrievalTool[];
/** 范围校验结果。 */
export interface ProfileScopeAdjustment {
    field: 'from' | 'to';
    locked: string;
    requested: string;
    message: string;
}
export type ProfileScopeDecision = {
    ok: true;
    args: Record<string, unknown>;
    ctx: ToolContext;
    /** 执行前对可收敛参数的修复记录；真实越权不会出现在这里。 */
    adjustments: ProfileScopeAdjustment[];
} | {
    ok: false;
    error: ToolResult;
};
/**
 * 校验并归一执行范围。
 *
 * 这是**纯函数**：不读库、不执行工具，便于运行时与单测复用。
 *
 * 规则：
 *   · 工具不在白名单 → `tool_not_allowed`；
 *   · profile 要求 kbId 而上下文没有 → `not_configured`；
 *   · `forceUsername` 而上下文没有当前会话 → `scope_required`；
 *   · 模型参数里的 username 与锁定值冲突 → `scope_violation`（不静默改写）；
 *   · 工具接受 username 但模型没填 → 注入锁定值；
 *   · `get_message_context` 的 key 必须属于锁定会话；
 *   · 声明了 `from` / `to` 的工具：模型日期参数收敛到固定范围并记录修复；
 *   · 日期格式非法或 `from > to` → `invalid_arguments`；
 *   · `search_hybrid` 的 mode 必须落在 profile 允许的模式内。
 *
 * @param profileRef - profile 或 id。
 * @param toolName - 模型请求的工具名（不可信）。
 * @param args - 模型参数（不可信；只读，不修改原对象）。
 * @param ctx - 执行上下文（只读，不修改原对象）。
 * @returns 归一后的参数与上下文，或结构化错误。
 */
export declare function enforceProfileScope(profileRef: AnswerProfile | AnswerProfileId, toolName: string, args: Record<string, unknown>, ctx: ToolContext): ProfileScopeDecision;
/**
 * 按 profile 构建**可执行**工具集。
 *
 * 返回的工具 `.run` 已带范围守卫；同时白名单外的工具根本不会出现。
 * 工具集由调用方传入（通常是 `buildTools` 组装的那份）—— 刻意不让本模块
 * import `registry.allTools`，避免 `registry -> profiles -> registry` 的静态环。
 *
 * @param profileRef - profile 或 id。
 * @param tools - 完整工具集（调用方用 `buildTools` 组装的那份；必填）。
 * @returns 过滤并守卫后的工具集。
 */
export declare function buildProfileTools(profileRef: AnswerProfile | AnswerProfileId, tools: readonly RetrievalTool[]): RetrievalTool[];
/**
 * 按名字执行 profile 工具。
 *
 * 与 `buildProfileTools` 的分工：调用方若只持有「完整工具集 + profile id」，
 * 用这个入口即可；它先判白名单，再走注册表的统一异常兜底。
 *
 * @param profileRef - profile 或 id。
 * @param tools - 完整工具集。
 * @param name - 模型请求的工具名（不可信）。
 * @param args - 模型参数（不可信）。
 * @param ctx - 执行上下文。
 * @returns 结构化结果；越界/未知/异常都不会抛。
 */
export declare function runProfileTool(profileRef: AnswerProfile | AnswerProfileId, tools: readonly RetrievalTool[], name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
/** profile 的数据面描述（写进日志/依据行，避免把 kb-only 说成全库）。 */
export declare function profileDataScope(profileRef: AnswerProfile | AnswerProfileId): {
    wechatDataEnabled: boolean;
    kbOnly: boolean;
    allowKnowledgeBase: boolean;
};
