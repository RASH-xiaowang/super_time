/**
 * WechatDataGateway 方法面 ·「消息分析」的 @Remote 壳及装配器。
 *
 * 取代原先的 `gateway-laya-ops.ts`：本地 ONNX 决策模型已移除，改为一次带隐私闸的
 * 对话模型调用，产出结构化 JSON（见 `query/analysis/`）。
 *
 * 方法面从 8 个收敛到 1 个：模型状态/下载/接管/卸载随本地模型一起消失。
 * 与其它 gateway-* 壳共同构成继承链；装饰器标记会落到最派生原型上
 * （守卫：`gateway-remote-surface.spec.ts`）。
 *
 * @module gateway-analysis-ops
 */
import { Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { MessageAnalysisInput, MessageAnalysisResult } from './types.ts'
import { createAnalysisRemotes } from './remotes/analysis.ts'
import { GatewayConfigOps } from './gateway-config-ops.ts'

export abstract class GatewayAnalysisOps extends GatewayConfigOps {
  protected _analysisRemotes?: ReturnType<typeof createAnalysisRemotes>

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
  @Remote('analyzeMessage')
  analyzeMessage(options: MessageAnalysisInput): Promise<MessageAnalysisResult> {
    return this.analysisRemotes().analyzeMessage(options)
  }

  /**
   * 「消息分析」处理器（体在 `remotes/analysis.ts`）；这里只组装依赖与转发。
   * 组装放在本层而不是 core，是为了不让 core 越过 1000 行上限。
   */
  protected analysisRemotes(): ReturnType<typeof createAnalysisRemotes> {
    return (this._analysisRemotes ??= createAnalysisRemotes({
      dirs: () => this._dirs,
      selfUsername: () => this.selfUsername(),
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      gate: (feature, stats, texts) => this.privacyGate(feature, stats, texts),
      // 默认生成器要读「设置里的当前对话模型」，`ctx` 是它唯一的入口。
      // 漏注入会让 `agentDefaultModel` 变成 undefined（现场表现为
      // 「Cannot read properties of undefined」），所以这里是必需项。
      ctx: () => this._ctx,
    }))
  }
}
