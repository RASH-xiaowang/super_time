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
    }): ChatAiReplyDefaultWebhookMutationResult;
    /**
     * 读取当前账号已开启 AI 回复的单聊摘要。
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
     * 桌面端专用：按 id 整组清理从未生成正文、从未投递的 AI 预约/失败记录。
     * 记录不存在算 skipped，重复调用幂等；逐条原因放在 items 里。
     * 运行窗口仍在生成/投递的记录会被拒绝（删除行不等于取消在途模型调用）。
     */
    deleteReservations(ids: readonly number[]): AiReplyReservationCleanupResult;
    dispose(): void;
};
