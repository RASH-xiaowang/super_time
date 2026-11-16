import type { Context } from '@deepseek-ai/cordis';
import type { ChatAiReplyDefaultWebhookMutationResult, ChatAiReplyDefaultWebhookState, ChatAiReplyEnabledChatsResult, ChatAiReplyMutationResult, ChatAiReplyScanResult, ChatAiReplyState } from './query/ai-reply/types.ts';
import { createChatAiReplyRemotes, type CreateChatAiReplyRemotesInputs } from './remotes/chat-ai-reply.ts';
import { GatewayMessageList } from './gateway-message-list.ts';
export declare abstract class GatewayChatAiReply extends GatewayMessageList {
    constructor(ctx: Context);
    /**
     * 读取某个单聊的会话级 AI 回复状态。
     * 默认关闭；状态只包含开关、执行阶段、游标和最近一次记录，不含凭据。
     */
    getChatAiReplyState(options: {
        chatUsername: string;
        chatName?: string;
    }): ChatAiReplyState;
    /** 读取当前账号、当前会话的默认大肥鱼 Webhook；只返回脱敏端点。 */
    getChatAiReplyDefaultWebhook(options: {
        chatUsername: string;
        chatName?: string;
    }): ChatAiReplyDefaultWebhookState;
    /** 保存默认 Webhook，并立即绑定缺失的精确规则、回填 AI pending 记录。 */
    saveChatAiReplyDefaultWebhook(options: {
        chatUsername: string;
        chatName?: string;
        webhookUrl: string;
    }): ChatAiReplyDefaultWebhookMutationResult;
    /**
     * 批量读取当前账号已开启 AI 回复的单聊。
     * 只返回列表筛选所需的轻量摘要，不含游标、Webhook 或模型凭据。
     */
    listEnabledChatAiReplyStates(): ChatAiReplyEnabledChatsResult;
    /**
     * 开启或关闭某个单聊的 AI 回复。
     * 仅桌面端可写；群聊、缺少账号或旧 revision 写入都会被拒绝。开启时尽量预置当前水位，
     * 避免回放历史消息；关闭后不再生成或投递该会话的新回复。
     */
    setChatAiReplyEnabled(options: {
        chatUsername: string;
        chatName?: string;
        enabled: boolean;
        provider?: 'dsh-wechat-bridge' | 'custom-webhook';
        expectedRevision?: number;
    }): ChatAiReplyMutationResult;
    /**
     * 保存某个单聊的 AI 回复人格与知识库参与设置。
     * 人格只影响模型语气与措辞，不能覆盖后端固定的防注入和安全规则；勾选知识库后，
     * 每轮生成会先按最近上下文检索该库并把命中的片段作为**不可信材料**交给模型。
     * 写入会推进 revision，并取消该会话尚未完成的旧回复任务。
     */
    setChatAiReplyPersona(options: {
        chatUsername: string;
        chatName?: string;
        personaName: string;
        personaPrompt: string;
        splitReply?: boolean;
        kbEnabled?: boolean;
        kbId?: number;
        expectedRevision?: number;
    }): ChatAiReplyMutationResult;
    /**
     * 立即扫描一次已开启的会话。
     * 正常由实时同步事件和 10 秒兜底触发；此方法主要供桌面端诊断使用。
     */
    scanChatAiReplyNow(): Promise<ChatAiReplyScanResult>;
    protected _chatAiReplyRemotes?: ReturnType<typeof createChatAiReplyRemotes>;
    protected chatAiReplyRemotes(): ReturnType<typeof createChatAiReplyRemotes>;
    protected chatAiReplyDeps(): CreateChatAiReplyRemotesInputs;
    /** 后台扫描：由同步事件与 10s 兜底调用；失败不影响微信同步主流程。 */
    protected scanChatAiRepliesBackground(): void;
    protected _chatAiReplyScan: Promise<ChatAiReplyScanResult> | null;
    protected _chatAiReplyScanQueued: boolean;
    protected scheduleChatAiReplyScan(): Promise<ChatAiReplyScanResult>;
}
