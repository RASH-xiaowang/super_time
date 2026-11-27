import type { MessageListAttachmentStageInput, MessageListAttachmentStageResult, MessageListBatchDeleteResult, MessageListBatchResendResult, MessageListDispatchBatchResult, MessageListMutationResult, MessageListQuery, MessageListRecordInput, MessageListRecordResult, MessageListRuleInput, MessageListRuleSnapshot, MessageListSnapshot, MessageListWebhookInfo, MessageListWebhookJob, MessageListWebhookPayload, MessageListWebhookProbe } from './types.ts';
import { GatewayAnalysisOps } from './gateway-analysis-ops.ts';
import { createMessageListRemotes } from './remotes/message-list.ts';
export declare abstract class GatewayMessageList extends GatewayAnalysisOps {
    listMessageListRecords(options?: MessageListQuery): MessageListSnapshot;
    listMessageListRules(): MessageListRuleSnapshot;
    /**
     * 保存消息列表规则。
     *
     * Feather Webhook 只能是基础发送地址 `/webhook/<token>`；
     * `/webhook/<token>/resources` 只是附件上传端点，会被拒绝保存。
     * 旧记录若已有资源端点快照，dispatch 会在任何出网前失败并记录 `failed`。
     *
     * 保存会顺带把地址回填到同类 pending 记录；回填后立刻调度一次投递批次，
     * 兑现界面上「配置发送地址后自动投递」的承诺，不再等下一次任务触发。
     */
    saveMessageListRule(options: MessageListRuleInput): MessageListMutationResult;
    deleteMessageListRule(options: {
        id: number;
    }): MessageListMutationResult;
    insertMessageListRecord(options: MessageListRecordInput): Promise<MessageListRecordResult>;
    /**
     * 桌面端选择附件后，把它复制到本机受控 spool。
     * 只允许桌面端调用，避免远程会话借任意路径读取本机文件。
     */
    stageMessageListAttachment(options: MessageListAttachmentStageInput): Promise<MessageListAttachmentStageResult>;
    resendMessageListRecord(options: {
        id: number;
    }): Promise<MessageListRecordResult>;
    /** 按消息列表记录 id 顺序批量重发；只允许桌面端本机调用。 */
    batchResendMessageListRecords(options: {
        ids: number[];
    }): Promise<MessageListBatchResendResult>;
    /** 批量删除消息记录；投递中的记录会跳过，只允许桌面端本机调用。 */
    batchDeleteMessageListRecords(options: {
        ids: number[];
    }): Promise<MessageListBatchDeleteResult>;
    ingestMessageListWebhook(payload: MessageListWebhookPayload): Promise<MessageListRecordResult>;
    getMessageListWebhookInfo(): MessageListWebhookInfo;
    /**
     * 对某条记录或规则里已保存的下游地址做 GET 健康检查。
     * 输入不是任意 URL；返回值不含路径令牌，仅桌面端可调用。
     */
    probeMessageListWebhook(options: {
        recordId?: number;
        ruleId?: number;
    }): Promise<MessageListWebhookProbe>;
    /**
     * 查询某条记录对应的下游异步发送任务。
     * 默认使用落库的 job id；只允许保守字符集，状态字段原样返回，不做送达推断。
     */
    queryMessageListWebhookJob(options: {
        recordId: number;
        jobId?: string;
    }): Promise<MessageListWebhookJob>;
    protected _messageListRemotes?: ReturnType<typeof createMessageListRemotes>;
    protected _messageListDispatch: Promise<MessageListDispatchBatchResult> | null;
    protected _messageListDispatchQueued: boolean;
    /** 单飞投递一批消息列表记录；同一时刻只开一个任务库写连接。 */
    protected scheduleMessageListDispatch(): Promise<MessageListDispatchBatchResult>;
    protected emitMessageListUpdated(created: number, dispatched: number): void;
    protected messageWebhookInfo(): MessageListWebhookInfo;
    protected messageListRemotes(): ReturnType<typeof createMessageListRemotes>;
}
