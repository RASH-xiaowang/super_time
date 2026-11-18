import type { ChatAiReplyEnabledStatesReadResult, ChatAiReplyMutationResult, ChatAiReplyProvider, ChatAiReplyStage, ChatAiReplyState } from './types.ts';
import type { ChatAiReplyLease } from './lease-store.ts';
export { ensureChatAiReplySchema } from './config-schema.ts';
/** 上下文时间窗上限：30 天。设更长没有意义（上下文本来只取最近 60 条）。 */
export declare const CHAT_AI_REPLY_CONTEXT_WINDOW_MAX_HOURS = 720;
/**
 * 归一化上下文时间窗。
 * @param value - 任意输入（数据库列或调用方参数）。
 * @returns 0（不限）或 1..720 的整数小时。
 */
export declare function normalizeContextWindowHours(value: unknown): number;
/** 读取单个会话设置；库不存在/读失败时返回 disabled，不让面板崩掉。 */
export declare function readChatAiReplyState(decryptedDir: string, accountKey: string, chatUsername: string, chatName?: string): ChatAiReplyState;
export type ChatAiReplyStateReadResult = {
    ok: true;
    state: ChatAiReplyState;
} | {
    ok: false;
    error: string;
};
/**
 * 严格读取单个会话设置。
 *
 * runner 不能把临时读失败当成“开关已关闭”：后者会取消已付费生成的结果，
 * 或在恢复时错误收口 pending。展示层仍使用宽容的 readChatAiReplyState。
 */
export declare function readChatAiReplyStateStrict(decryptedDir: string, accountKey: string, chatUsername: string, chatName?: string): ChatAiReplyStateReadResult;
/**
 * 严格读取所有已开启会话。
 *
 * 没有任务库与读取失败必须可区分：前者可以安全返回空列表，后者若也伪装成
 * 空列表，恢复扫描会把所有 pending AI 预约误判成孤儿。该接口只给后台扫描
 * 使用，不跨会话暴露正文。
 */
export declare function readEnabledChatAiReplyStates(decryptedDir: string): ChatAiReplyEnabledStatesReadResult;
/** 兼容只读调用方；恢复流程必须使用 readEnabledChatAiReplyStates 区分失败。 */
export declare function listEnabledChatAiReplyStates(decryptedDir: string): ChatAiReplyState[];
/** 保存设置；关闭时立即 stage=disabled，避免界面仍显示生成中。 */
export declare function saveChatAiReplySetting(decryptedDir: string, input: {
    accountKey: string;
    chatUsername: string;
    chatName: string;
    enabled: boolean;
    provider: ChatAiReplyProvider;
    /** 省略时保留当前分段设置，避免旧调用方切换开关时改回默认。 */
    splitReply?: boolean;
    /** 省略时保留当前人格，避免旧调用方切换开关时清空配置。 */
    personaName?: string;
    /** 省略时保留当前人格，避免旧调用方切换开关时清空配置。 */
    personaPrompt?: string;
    /** 省略时保留当前知识库设置，避免旧调用方切换开关时改回默认。 */
    kbEnabled?: boolean;
    /** 省略时保留当前知识库选择；`kbEnabled` 为 true 时必须大于 0。 */
    kbId?: number;
    /** 上下文时间窗（小时）；省略时保留当前值，0/非法值表示不限。 */
    contextWindowHours?: number;
    expectedRevision?: number;
    cursor?: string;
}): ChatAiReplyMutationResult;
/**
 * 只更新人格配置，保留开关、provider 与水位。
 *
 * 人格变更同样推进 revision，并复用开关保存的预约失效逻辑；这样旧任务不会
 * 继续用上一版提示词生成或投递。
 */
export declare function saveChatAiReplyPersona(decryptedDir: string, input: {
    accountKey: string;
    chatUsername: string;
    chatName?: string;
    personaName: string;
    personaPrompt: string;
    /** 省略时保留当前设置。 */
    splitReply?: boolean;
    /** 省略时保留当前知识库设置。 */
    kbEnabled?: boolean;
    /** 省略时保留当前知识库选择；`kbEnabled` 为 true 时必须大于 0。 */
    kbId?: number;
    /** 上下文时间窗（小时）；省略时保留当前值，0 表示不限。 */
    contextWindowHours?: number;
    expectedRevision?: number;
}): ChatAiReplyMutationResult;
export type ChatAiReplyRunStateUpdateResult = 'updated' | 'guard-mismatch' | 'transient';
/**
 * 更新运行状态；仅改执行面，不碰开关与 revision。
 *
 * `transient` 只表示 SQLite 忙/锁，调用方应让出事件循环后重试；不能把它当成
 * owner/fence 失配，否则一次短暂争用就会丢弃已经付费生成的模型结果。
 */
export declare function updateChatAiReplyRunStateResult(decryptedDir: string, accountKey: string, chatUsername: string, patch: {
    stage: ChatAiReplyStage;
    cursor?: string;
    pendingCursor?: string | null;
    pendingSourceRef?: string | null;
    pendingRevision?: number | null;
    generationState?: '' | 'intent' | 'result';
    generationSourceRef?: string | null;
    generationText?: string | null;
    generationRevision?: number | null;
    lastRunAt?: number;
    recordId?: number | null;
    error?: string;
}, guard?: {
    /** 本次执行开始时捕获的 revision；开关变更后旧任务不得覆盖新状态。 */
    revision: number;
    /** 带租约的执行面写入；旧 owner/fence 在接管后永远不会命中。 */
    lease?: ChatAiReplyLease;
    /** 终态/延后收口时在同一条 UPDATE 中释放租约。 */
    releaseLease?: boolean;
}): ChatAiReplyRunStateUpdateResult;
/** 兼容旧调用：状态写入失败统一降级为 false。 */
export declare function updateChatAiReplyRunState(decryptedDir: string, accountKey: string, chatUsername: string, patch: Parameters<typeof updateChatAiReplyRunStateResult>[3], guard?: Parameters<typeof updateChatAiReplyRunStateResult>[4]): boolean;
/**
 * 首次建立水位必须与 claim 竞争同一行。
 *
 * 若 claim 先拿到活动租约，本 UPDATE 不命中；若水位先写入，延迟 scan 随后
 * 的 claim 会因 expected.cursor 变化而失败。两种顺序都不会越过新消息。
 */
export declare function initializeChatAiReplyCursor(decryptedDir: string, accountKey: string, chatUsername: string, cursor: string, expectedRevision?: number): boolean;
/** 模型生成的持久化快照；只返回当前会话当前 pending 对应的生成记录。 */
export interface ChatAiReplyGenerationSnapshot {
    state: string;
    text: string;
    sourceRef: string;
    revision: number;
}
/**
 * 读取模型生成意图/结果。
 *
 * 生成意图在调用模型之前写入，结果在模型返回后、补全消息列表之前写入。
 * 这样进程在任意位置重启时都能区分“尚未调用模型”“已经调用但没有结果”和
 * “结果已落盘，只需补全消息列表”。
 */
export declare function readChatAiReplyGeneration(decryptedDir: string, accountKey: string, chatUsername: string): ChatAiReplyGenerationSnapshot | undefined;
export type ChatAiReplyGenerationReadResult = {
    ok: true;
    generation: ChatAiReplyGenerationSnapshot | undefined;
} | {
    ok: false;
    error: string;
};
/**
 * 严格读取生成意图/结果。读取失败与“没有快照”必须可区分，否则恢复器
 * 会把已持久化的模型结果误判为 legacy blank pending 并永久标记失败。
 */
export declare function readChatAiReplyGenerationStrict(decryptedDir: string, accountKey: string, chatUsername: string): ChatAiReplyGenerationReadResult;
