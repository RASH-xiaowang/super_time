import type { Context } from '@deepseek-ai/cordis';
import type { ChatAiReplyDefaultWebhookMutationResult, ChatAiReplyDefaultWebhookState, ChatAiReplyEnabledChatsResult, ChatAiReplyMutationResult, ChatAiReplyScanResult, ChatAiReplyState } from './query/ai-reply/types.ts';
import { createChatAiReplyRemotes, type CreateChatAiReplyRemotesInputs } from './remotes/chat-ai-reply.ts';
import type { ChatAiReplyRegenerateResult } from './query/ai-reply/runner-regenerate.ts';
import type { ChatAiReplyTraceReadResult } from './query/ai-reply/trace-store.ts';
import type { AiReplyReservationCleanupResult } from './query/message-list-store.ts';
import type { MemoryFact } from './query/agent/decision.ts';
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
     * 开启或关闭某个会话的 AI 回复。
     * 仅桌面端可写；单聊与群聊都支持（群聊只有 @我 的消息会触发），缺少账号或
     * 旧 revision 写入会被拒绝。开启时尽量预置当前水位，
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
        /** 上下文时间窗（小时）；0 = 不限。上限 720（30 天），超出按上限夹紧。 */
        contextWindowHours?: number;
        expectedRevision?: number;
    }): ChatAiReplyMutationResult;
    /**
     * 立即扫描一次已开启的会话。
     * 正常由实时同步事件和 10 秒兜底触发；此方法主要供桌面端诊断使用。
     */
    scanChatAiReplyNow(): Promise<ChatAiReplyScanResult>;
    /**
     * 桌面端专用：重新生成一条空白失败的 AI 回复记录。
     *
     * 只允许 24 小时内、整组无正文/图片/投递事实，且失败分类为 superseded、
     * generation_failed 或 config_changed 的记录。**会再调用一次付费模型并可能出网，
     * 成功后不可撤销**；expectedSourceRef 用于防止点击后目标记录被替换。
     */
    regenerateChatAiReplyRecord(options: {
        recordId: number;
        expectedSourceRef: string;
    }): Promise<ChatAiReplyRegenerateResult>;
    /**
     * 桌面端专用：删除 AI 回复记录。
     *
     * 按 sourceRef/segment_group_ref 整组删除，**不可撤销**。默认只删空白且从未投递的
     * 预约/失败记录；传 `includeTerminal: true` 时允许删除已收口的记录（成功 / 已发出
     * 未确认 / 失败），用于清理台账里已经结束的行。在途状态（生成中 / 投递中 / 下游
     * 排队或执行）一律拒绝 —— 删除行不等于取消在途模型调用或投递。记录不存在算
     * skipped，重复调用幂等。
     */
    deleteAiReplyReservations(options: {
        ids: number[];
        /** 是否允许删除已收口的终态记录（默认 false，只删空白预约）。 */
        includeTerminal?: boolean;
    }): AiReplyReservationCleanupResult;
    /**
     * 读取一条 AI 回复记录的过程留痕（只读）。
     *
     * 返回本轮实际送进模型的上下文、知识库命中、system/user 提示词、模型输出与
     * 各阶段时间戳，供消息列表详情「回复过程」展示。只有本机自建表，不含 Webhook
     * 地址或模型凭据；旧记录没有留痕时 `ok:false`，界面据此显示「无留痕」。
     */
    getChatAiReplyTrace(options: {
        recordId: number;
    }): ChatAiReplyTraceReadResult;
    protected _chatAiReplyRemotes?: ReturnType<typeof createChatAiReplyRemotes>;
    protected chatAiReplyRemotes(): ReturnType<typeof createChatAiReplyRemotes>;
    protected chatAiReplyDeps(): CreateChatAiReplyRemotesInputs;
    /** AI 队友总览：控制、记忆、提案和审计都在本机，不把主动提案送进微信。 */
    getAgentDesk(): {
        drafts: import("./query/message-list-store-ai.ts").HeldAiReplyDraft[];
        control: import("./query/agent/store.ts").AgentControl;
        memories: import("./query/agent/store.ts").AgentMemory[];
        proposals: import("./query/agent/store.ts").AgentProposal[];
        promises: import("./query/agent/store.ts").AgentPromise[];
        audit: import("./query/agent/store.ts").AgentAuditEntry[];
        reconcile: {
            expected: number;
            executed: number;
            skipped: number;
            delta: number;
        };
        channels: Readonly<Record<"feather-webhook" | "feather-text" | "generic", import("./query/agent/decision.ts").ChannelCapability>>;
    };
    saveAgentControl(options: {
        killed?: boolean;
        shadow?: boolean;
        quietStart?: string;
        quietEnd?: string;
        cooldownMs?: number;
        hourCap?: number;
        dayCap?: number;
        proactiveHourCap?: number;
        handoff?: boolean;
    }): import("./query/agent/store.ts").AgentControl;
    writeAgentMemory(options: {
        scope: MemoryFact['scope'];
        scopeKey: string;
        kind: MemoryFact['kind'];
        text: string;
    }): {
        ok: boolean;
        op: string;
        error?: string;
    };
    deleteAgentMemory(options: {
        id: number;
    }): {
        ok: boolean;
    };
    addAgentPromise(options: {
        text: string;
        dueAt: number;
    }): {
        ok: boolean;
    };
    setAgentProposalStatus(options: {
        id: number;
        status: 'accepted' | 'dismissed';
    }): {
        ok: boolean;
    };
    /** 把已确认的草稿按原 Webhook 地址重发。自动投递不会走这条。 */
    sendAgentDraft(options: {
        id: number;
    }): Promise<import("./types-message-list.ts").MessageListRecordResult>;
    /**
     * 把一条提案正文按图中的 Webhook 发出。
     * target 就是请求体里的 target，例如「文件传输助手」；要先有匹配的消息列表规则。
     */
    sendAgentProposal(options: {
        id: number;
        target: string;
    }): Promise<import("./types-message-list.ts").MessageListRecordResult>;
    /** 后台扫描：由同步事件与 10s 兜底调用；失败不影响微信同步主流程。 */
    protected scanChatAiRepliesBackground(): void;
    protected _chatAiReplyScan: Promise<ChatAiReplyScanResult> | null;
    protected _chatAiReplyScanQueued: boolean;
    protected scheduleChatAiReplyScan(): Promise<ChatAiReplyScanResult>;
}
