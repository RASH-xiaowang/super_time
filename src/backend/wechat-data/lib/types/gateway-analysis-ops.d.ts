import type { MessageAnalysisInput, MessageAnalysisResult } from './types.ts';
import { createAnalysisRemotes } from './remotes/analysis.ts';
import { GatewayConfigOps } from './gateway-config-ops.ts';
export declare abstract class GatewayAnalysisOps extends GatewayConfigOps {
    protected _analysisRemotes?: ReturnType<typeof createAnalysisRemotes>;
    /**
     * 分析一条消息（单聊与群聊用两套问题域）。
     *
     * 单聊回答「他想要什么、情绪如何、我该怎么回」；群聊回答「这条消息是否针对我、
     * 他在群里做什么动作、我该不该接话、公开回还是私聊」。
     *
     * 走 `analyze_message` 隐私闸后调用**设置里的当前对话模型**，输出严格 JSON；
     * 结果按（会话, 消息, 模型+提示词版本）缓存在 `<数据根>/message_analysis.db`。
     * 只读当前会话、只取目标消息及之前的上下文，不写微信库、不投递、不生成回复正文。
     * @param options - 会话 username、消息定位键（localId/sortSeq）与是否强制重算。
     * @returns 结构化分析；会话级问题返回 `ok:false` + 可展示原因。
     */
    analyzeMessage(options: MessageAnalysisInput): Promise<MessageAnalysisResult>;
    /**
     * 「消息分析」处理器（体在 `remotes/analysis.ts`）；这里只组装依赖与转发。
     * 组装放在本层而不是 core，是为了不让 core 越过 1000 行上限。
     */
    protected analysisRemotes(): ReturnType<typeof createAnalysisRemotes>;
}
