import type { ChatAiReplyTraceReadResult } from '../query/ai-reply/trace-store.ts';
import type { ChatAiReplyRegenerateResult } from '../query/ai-reply/runner-regenerate.ts';
import type { ChatAiReplyGenerateFn } from '../query/ai-reply/generator.ts';
import type { ChatAiReplyDefaultWebhookMutationResult, ChatAiReplyDefaultWebhookState, ChatAiReplyDispatchResult, ChatAiReplyEnabledChatsResult, ChatAiReplyMutationResult, ChatAiReplyScanResult, ChatAiReplyScanDeps, ChatAiReplyState } from '../query/ai-reply/types.ts';
import type { AiReplyReservationCleanupResult } from '../query/message-list-store.ts';
import type { OperationCategory, OperationStatus } from '../types.ts';
export interface CreateChatAiReplyRemotesInputs {
    dirs: () => {
        decrypted: string;
        decoded: string;
    };
    selfUsername: () => string;
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
    gate: (feature: string, stats: {
        sessions: number;
        messages: number;
    }, texts: string[]) => string[];
    generate: ChatAiReplyGenerateFn;
    decodeImages?: NonNullable<ChatAiReplyScanDeps['decodeImages']>;
    /** 语音转写；由网关接到本地 whisper（设置里选的模型）。 */
    transcribeVoices?: NonNullable<ChatAiReplyScanDeps['transcribeVoices']>;
    /** 知识库片段检索；由网关接到与问答相同的混合检索通道。 */
    collectKbSnippets?: NonNullable<ChatAiReplyScanDeps['collectKbSnippets']>;
    dispatch: (recordId: number) => Promise<ChatAiReplyDispatchResult>;
    onRecordSaved?: ChatAiReplyScanDeps['onRecordSaved'];
    onRecordUpdated?: ChatAiReplyScanDeps['onRecordUpdated'];
    onDispatchFinished?: ChatAiReplyScanDeps['onDispatchFinished'];
    changed: () => void;
}
export declare function createChatAiReplyRemotes(rc: CreateChatAiReplyRemotesInputs): {
    getState(options: {
        chatUsername: string;
        chatName?: string;
    }): ChatAiReplyState;
    getDefaultWebhook(options: {
        chatUsername: string;
        chatName?: string;
    }): ChatAiReplyDefaultWebhookState;
    saveDefaultWebhook(options: {
        chatUsername: string;
        chatName?: string;
        webhookUrl: string;
        appInstanceId?: string;
    }): ChatAiReplyDefaultWebhookMutationResult;
    /**
     * 读取当前账号已开启 AI 回复的会话摘要（单聊与群聊）。
     *
     * 任务库可能同时保存多个微信账号，因此必须在服务端按当前 selfWxid 过滤；
     * 读取失败原样返回，不能把未知状态当成“没有开启”。
     */
    listEnabled(): ChatAiReplyEnabledChatsResult;
    setEnabled(options: {
        chatUsername: string;
        chatName?: string;
        enabled: boolean;
        provider?: "dsh-wechat-bridge" | "custom-webhook";
        expectedRevision?: number;
    }): ChatAiReplyMutationResult;
    setPersona(options: {
        chatUsername: string;
        chatName?: string;
        personaName: string;
        personaPrompt: string;
        splitReply?: boolean;
        kbEnabled?: boolean;
        kbId?: number;
        contextWindowHours?: number;
        safetyHandoff?: string;
        safetyBlocked?: string;
        expectedRevision?: number;
    }): ChatAiReplyMutationResult;
    scanOnce(): Promise<ChatAiReplyScanResult>;
    /** 进程启动时只恢复遗留任务，不扫描/生成新的入站消息。 */
    recoverOnce(): Promise<ChatAiReplyScanResult>;
    recordResult(id: number): {
        found: boolean;
        status?: string;
        error?: string;
    };
    /**
     * 桌面端专用：重新生成一条空白失败的 AI 回复。
     * 会再调用一次模型，记录会被原地复用（sourceRef 不变），不新建消息列表行。
     */
    regenerateRecord(options: {
        recordId: number;
        expectedSourceRef: string;
    }): Promise<ChatAiReplyRegenerateResult>;
    /**
     * 桌面端专用：按 id 整组删除 AI 回复记录。
     * 默认只删空白且从未投递的预约/失败记录；`includeTerminal` 放开已收口的终态
     * 记录（成功 / 已发出未确认 / 失败），在途状态仍拒绝。记录不存在算 skipped，
     * 重复调用幂等；逐条原因放在 items 里。
     */
    deleteReservations(ids: readonly number[], includeTerminal?: boolean): AiReplyReservationCleanupResult;
    /**
     * 读取一条 AI 回复记录的过程留痕（上下文 / 知识库 / 提示词 / 输出 / 阶段耗时）。
     * 只读本机自建表，不含 Webhook 或模型凭据；旧记录没有留痕时返回 `ok:false`。
     */
    getTrace(recordId: number): ChatAiReplyTraceReadResult;
    dispose(): void;
};
