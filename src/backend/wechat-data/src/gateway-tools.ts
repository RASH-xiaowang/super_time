/**
 * 「本地工具」的 Remote 面（2026-11-24）。
 *
 * 四个方法：`getLocalTools`（清单）+ 三个写操作（保存 / 删除 / 启停）。
 *
 * ## 为什么清单是现算的
 *
 * 清单来自各工具注册表（问答检索 / AI 回复 / RPA 厂商）+ 本机**可写注册表**
 * （`tool_custom` / `tool_override`，见 `query/tool-config-store.ts`）。每次读都现算，
 * 所以「前端改完立即生效」不需要任何失效协议 —— 问答链路装配工具集时读的是同一份数据。
 *
 * ## 三类工具的可写性（界面照这个来画按钮）
 *
 *   · 内置（代码定义）：**不可删除**，只能启停与改说明 —— 执行体在注册表里，界面改不了。
 *   · 自定义（数据定义）：可增可删可改；只有两种执行模板（`alias` / `answer`）。
 *   · 出网通道 / 本机能力：不给启停 —— 前者要地址与凭据（在任务信息里配），
 *     后者是界面按钮背后的一次调用，没有「工具集」这个概念。
 *
 * 这个边界是有意的：如果允许从界面新建「任意 HTTP 工具」，模型就能把聊天内容发到
 * 用户随手填的地址上 —— 而本应用的所有出网都有独立的主机白名单与隐私闸门。
 *
 * @module gateway-tools
 */
import { Remote } from '@deepseek-ai/dsh-typert-protocol'
import type {
  LocalToolInput,
  LocalToolMutationResult,
  LocalToolSaveResult,
  LocalToolsSnapshot,
} from './types.ts'
import { queryLocalTools } from './query/local-tools.ts'
import { allTools } from './query/tools/registry.ts'
import { REPLY_TOOL_SCHEMAS } from './query/reply-tools/registry.ts'
import { validateCustomTool } from './query/custom-tools.ts'
import { readLocalToolConfig, saveLocalToolConfig, type LocalToolConfigSaveResult } from './query/reply-tool-config.ts'
import type { LocalToolConfig, LocalToolConfigInput } from './types.ts'
import {
  deleteCustomTool,
  readToolConfig,
  toolConfigErrorText,
  upsertCustomTool,
  upsertToolOverride,
} from './query/tool-config-store.ts'
import { GatewayTaskCenter } from './gateway-taskcenter.ts'

/** 可启停的内置工具名（检索 + 回复；出网通道与本机能力不在其中）。 */
const TOGGLEABLE_BUILTINS: ReadonlySet<string> = new Set([
  ...allTools.map((tool) => tool.name),
  ...REPLY_TOOL_SCHEMAS.map((schema) => schema.name),
])

/** 至少保留几个启用的「问答题工具」（全部停用等于把问答的工具面关掉）。 */
const MIN_ENABLED_ASK_TOOLS = 1

export abstract class GatewayTools extends GatewayTaskCenter {
  /**
   * 本机全部可用工具的清单（问答检索 / AI 回复 / 出网触发 / 本机能力 + 自定义）。
   *
   * 清单从各注册表**现算**：新增/停用/删除工具后界面自动反映，不需要改前端，
   * 也不会与「文档里写了、界面没有」漂移。结果不含凭据，也不触发任何数据读取。
   * @returns 四组工具 + 自定义工具 + 分组元信息。
   */
  @Remote('getLocalTools')
  getLocalTools(): LocalToolsSnapshot {
    return queryLocalTools(this._dirs.decrypted)
  }

  /**
   * AI 回复工具的配置快照（天气数据源 / 使用方式 / 搜索服务 + 密钥是否已保存）。
   *
   * 卡片上写着「待配置」的工具，靠这里判定的四个配置项解锁。**密钥永不回读**：
   * 只回 `apiKeySaved`，与任务中心的凭据同一口径。
   * @returns 配置快照 + 可选项（下拉不硬编码在前端）。
   */
  @Remote('getLocalToolConfig')
  getLocalToolConfig(): LocalToolConfig {
    return readLocalToolConfig(this._dirs.decrypted)
  }

  /**
   * 保存 AI 回复工具的配置。
   *
   * 只写「出现的字段」；密钥写进 `secrets.json`（`saveConfig` 的密钥族），
   * `config.json` 里永远不留它们。保存后工具卡片的「待配置」当场变成「可用」，
   * 因为清单每次都是现读配置算出来的。
   * @param input - 要写入的字段（不可信）。
   * @returns 保存结果（成功时带新快照）。
   */
  @Remote('saveLocalToolConfig')
  saveLocalToolConfig(input: LocalToolConfigInput): LocalToolConfigSaveResult {
    return saveLocalToolConfig(this._dirs.decrypted, input)
  }

  /**
   * 新建或更新一条自定义工具。
   *
   * 校验全在 `validateCustomTool`（名字形状、目标必须存在、固定参数必须在目标 schema 里…）：
   * 一条执行不了的 alias 比拒绝保存更糟，它会在模型调用时才失败。
   * @param input - 工具配置（不可信输入）。
   * @returns 保存后的卡片；失败带可读原因。
   */
  @Remote('saveLocalTool')
  saveLocalTool(input: LocalToolInput): LocalToolSaveResult {
    const dir = this._dirs.decrypted
    try {
      const name = (input?.name ?? '').trim()
      // 「新建」时在表里按名字找一次：找到就说明会覆盖，交给校验层明确拒绝。
      const existing = name === '' ? undefined : readToolConfig(dir).custom.find((item) => item.name === name)
      const checked = validateCustomTool(input, existing)
      if (!checked.ok || checked.record === undefined) return { ok: false, error: checked.error ?? '工具配置无效' }
      upsertCustomTool(dir, checked.record)
      return { ok: true, item: queryLocalTools(dir).items.find((item) => item.callName === checked.record?.name) ?? checked.item }
    } catch (e) {
      return { ok: false, error: '保存工具失败：' + toolConfigErrorText(e) }
    }
  }

  /**
   * 删除一条自定义工具。**内置工具不可删除**（只能停用）。
   * @param options - `name` 为工具调用名。
   * @returns 是否删除成功。
   */
  @Remote('deleteLocalTool')
  deleteLocalTool(options: { name: string }): LocalToolMutationResult {
    const dir = this._dirs.decrypted
    const name = (typeof options?.name === 'string' ? options.name : '').trim()
    if (name === '') return { ok: false, error: '缺少工具名' }
    if (TOGGLEABLE_BUILTINS.has(name)) {
      return { ok: false, error: `「${name}」是默认工具，不能删除；如果不想让它出现，请停用` }
    }
    try {
      const removed = deleteCustomTool(dir, name)
      return removed ? { ok: true } : { ok: false, error: '这条自定义工具不存在（可能已被删除）' }
    } catch (e) {
      return { ok: false, error: '删除工具失败：' + toolConfigErrorText(e) }
    }
  }

  /**
   * 启用/停用一个工具（内置或自定义）。
   *
   * 停用内置 = 写一条覆盖行；停用自定义 = 改它自己那一行的 `enabled`。
   * 安全阀：不允许把「问答题工具」全部停用 —— 那样问答会拿到零工具，
   * 模型只能说「没有能力」，而这种状态用户很难自己看出来。
   * @param options - `name` 为工具调用名，`enabled` 为目标状态。
   * @returns 是否生效。
   */
  @Remote('setLocalToolEnabled')
  setLocalToolEnabled(options: { name: string; enabled: boolean }): LocalToolMutationResult {
    const dir = this._dirs.decrypted
    const name = (typeof options?.name === 'string' ? options.name : '').trim()
    const enabled = options?.enabled === true
    if (name === '') return { ok: false, error: '缺少工具名' }
    if (!enabled && this.wouldLeaveNoAskTool(name)) {
      return { ok: false, error: '至少要保留一个启用的问答工具（全部停用会让问答拿不到任何工具）' }
    }
    try {
      const config = readToolConfig(dir)
      const custom = config.custom.find((item) => item.name === name)
      if (custom !== undefined) {
        upsertCustomTool(dir, { ...custom, enabled })
        return { ok: true }
      }
      if (!TOGGLEABLE_BUILTINS.has(name)) {
        return { ok: false, error: `「${name}」不是可启停的工具（出网通道请到任务信息里配置，本机能力不支持停用）` }
      }
      const existing = config.overrides.get(name)
      upsertToolOverride(dir, name, {
        title: existing?.title ?? '',
        description: existing?.description ?? '',
        enabled,
      })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: '更新工具状态失败：' + toolConfigErrorText(e) }
    }
  }

  /** 停用后是否一个问答工具都不剩了（只算检索 + 自定义）。 */
  private wouldLeaveNoAskTool(name: string): boolean {
    const config = readToolConfig(this._dirs.decrypted)
    const enabledCustom = config.custom.filter((item) => item.enabled && item.name !== name)
    if (enabledCustom.length > 0) return false
    const enabledBuiltin = allTools.filter((tool) => tool.name !== name && config.overrides.get(tool.name)?.enabled !== false)
    return enabledBuiltin.length < MIN_ENABLED_ASK_TOOLS
  }
}
