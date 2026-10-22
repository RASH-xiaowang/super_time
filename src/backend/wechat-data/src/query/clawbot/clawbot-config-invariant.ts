/**
 * ClawBot 实例配置的**纯校验与归一**。
 *
 * 自动回复固定走 `clawbot-auto`（kb-only + requireKb），因此「自动回复开启」必须同时满足：
 * `kbEnabled === true` 且 `kbId > 0`。把这条不变量放在独立的纯模块里，保存路径、运行决策和
 * 测试共用同一份判断，避免 UI 已禁用、下次启动却又从旧库读到矛盾配置。
 *
 * @module query/clawbot/clawbot-config-invariant
 */
import type { ClawbotInstanceConfig } from '../../types.ts'

/** 实例配置的部分更新（slot 不参与 patch）。 */
export type ClawbotInstanceConfigPatch = Partial<Omit<ClawbotInstanceConfig, 'slot'>>

/** 自动回复缺少知识库时对用户展示的统一原因。 */
export const AUTO_REPLY_KB_REQUIRED_MESSAGE = '自动回复需要选择知识库：尚未选择知识库或知识库增强未开启，请先开启增强并选择一个有效知识库'

/** 自动回复所需的最小配置字段。 */
export interface AutoReplyKbConfig {
  kbEnabled: boolean
  kbId: number | null
}

/**
 * 自动回复是否有可用的知识库作用域。
 * @param cfg - 实例配置中的知识库开关与库 id。
 * @returns 仅当增强已开启且 kbId 为正安全整数时为 true。
 */
export function hasValidAutoReplyKnowledgeBase(
  cfg: AutoReplyKbConfig,
): cfg is AutoReplyKbConfig & { kbEnabled: true, kbId: number } {
  return cfg.kbEnabled === true
    && cfg.kbId !== null
    && Number.isSafeInteger(cfg.kbId)
    && cfg.kbId > 0
}

/** 保存配置时用于归一化的输入。 */
export interface InstanceConfigSaveInput {
  slot: number
  current: ClawbotInstanceConfig
  patch: ClawbotInstanceConfigPatch
}

/**
 * 归一部分更新并落实自动回复不变量。
 *
 * 规则：
 * - 本次 patch **明确要求开启** autoReply，但最终没有有效知识库 ⇒ 抛可读中文，拒绝落库。
 * - 只是关闭 kbEnabled / 清空 kbId，导致已有 autoReply 失去运行条件 ⇒ 自动把 autoReply 置 false，
 *   不保留「界面开着但永远不会发送」的矛盾状态。
 * - 旧库已有的矛盾配置在任意一次保存时也会被收敛为 autoReply=false。
 *
 * @param input - 当前配置、部分更新与实例号。
 * @returns 已归一、可直接落库的完整配置。
 * @throws patch 明确开启自动回复但缺少有效知识库时抛错。
 */
export function resolveInstanceConfigForSave(input: InstanceConfigSaveInput): ClawbotInstanceConfig {
  const slot = Math.max(Math.floor(input.slot), 1)
  const { current, patch } = input
  const rawKb = patch.kbId === undefined ? current.kbId : patch.kbId
  const flooredKb = rawKb === null || !Number.isFinite(rawKb) || rawKb <= 0 ? null : Math.floor(rawKb)
  const kbId = flooredKb !== null && Number.isSafeInteger(flooredKb) ? flooredKb : null
  const kbEnabled = patch.kbEnabled ?? current.kbEnabled
  const requestedAutoReply = patch.autoReply ?? current.autoReply
  const validKb = hasValidAutoReplyKnowledgeBase({ kbEnabled, kbId })

  if (requestedAutoReply && !validKb && patch.autoReply === true) {
    throw new Error(AUTO_REPLY_KB_REQUIRED_MESSAGE)
  }

  return {
    slot,
    autoReply: requestedAutoReply && validKb,
    kbEnabled,
    kbId,
    systemPrompt: (patch.systemPrompt ?? current.systemPrompt).trim().slice(0, 4000),
    splitReply: patch.splitReply ?? current.splitReply,
  }
}
