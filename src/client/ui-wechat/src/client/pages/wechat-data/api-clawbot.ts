/**
 * `api.ts` 的「微信 ClawBot 集成」部分（2026-10-12；iLink 接入后可发可收，媒体按需可见）。
 *
 * 十二个包装函数对应后端十二个 `@Remote`（`gateway-clawbot.ts`）：**实例管理四个**
 * （列表 / 新建 / 删除 / 改配置，只读写下本机库）+ 绑定与会话八个。接口镜像在
 * `api-core.ts` 的 `WechatRemote`，两边由 `remote-contract.spec.ts` 双向核对。
 *
 * 链路里**会出网**的只有四条，且都经后端中继（渲染层永远不直接出网，媒体也不走
 * `<img>` 直连）：`apiCreateClawbotBindQr`（一次取码）、`apiGetClawbotBindState`
 * （一次状态长轮询）、`apiSendClawbotMessage`（你逐条主动发送）、
 * `apiGetClawbotMedia`（你点开某条消息时才取那份附件）。
 * 其余都只读本机 `clawbot.db` 与主进程状态。
 *
 * @module api-clawbot
 */

import type { ClawbotBindQr, ClawbotBindStateSnapshot, ClawbotBindingSnapshot, ClawbotEnvSnapshot, ClawbotInstanceConfig, ClawbotInstanceCreated, ClawbotInstanceDeleted, ClawbotInstancesSnapshot, ClawbotMediaResult, ClawbotMessageQuery, ClawbotMessageSnapshot, ClawbotSendResult } from '@deepseek-ai/dsh-wechat-data/types'
import { remote, unwrap } from './api-core.ts'

/**
 * 实例列表（多实例：一个微信号 = 一个实例，各带自己的自动回复与知识库开关）。
 * @returns 实例列表快照（读失败时带 readError —— 与「一个实例都没有」分开显示）。
 */
export async function apiListClawbotInstances(): Promise<ClawbotInstancesSnapshot> {
  return unwrap(await remote().listClawbotInstances())
}

/**
 * 新建一个实例（初始未绑定，随后对它取码绑定）。
 * @returns 新实例编号 + 最新实例列表。
 */
export async function apiCreateClawbotInstance(): Promise<ClawbotInstanceCreated> {
  return unwrap(await remote().createClawbotInstance())
}

/**
 * 删除一个实例（绑定行 + 配置 + 该实例的接入会话一起删）。
 * @param options.slot - 实例编号。
 * @returns 连带删掉的会话条数 + 最新实例列表（确认框据此如实告知）。
 */
export async function apiDeleteClawbotInstance(options: { slot: number }): Promise<ClawbotInstanceDeleted> {
  return unwrap(await remote().deleteClawbotInstance(options))
}

/**
 * 改某实例的行为配置（AI 自动回复 / 知识库增强；部分更新，缺省字段保持原值）。
 * @param options - 实例编号 + 要改的字段。
 * @returns 落库后的完整配置。
 */
export async function apiSetClawbotInstanceConfig(options: { slot: number, autoReply?: boolean, kbEnabled?: boolean, kbId?: number | null, systemPrompt?: string, splitReply?: boolean }): Promise<ClawbotInstanceConfig> {
  return unwrap(await remote().setClawbotInstanceConfig(options))
}

/**
 * 给实例起别名（「工作号」「客服号」；2026-10-16）。
 *
 * 与绑定状态机无关（后端只动 `label` 一列）⇒ 别名活过重新绑定与解绑。
 * 空串 = 清除别名（界面回落到昵称，再回落到「实例 N」）。
 * @param options.slot - 实例编号。
 * @param options.label - 新别名（空串 = 清除）。
 * @returns 落库后的绑定卡片快照。
 */
export async function apiRenameClawbotInstance(options: { slot: number, label: string }): Promise<ClawbotBindingSnapshot> {
  return unwrap(await remote().renameClawbotInstance(options))
}

/**
 * 当前绑定行（设置卡片首屏）。
 * @param options.slot - 实例编号（缺省 = 第一个实例）。
 * @returns 绑定卡片快照（含会话计数与通道状态）。
 */
export async function apiGetClawbotBinding(options?: { slot?: number }): Promise<ClawbotBindingSnapshot> {
  return unwrap(await remote().getClawbotBinding(options))
}

/**
 * 申请绑定二维码（后端向腾讯 iLink 服务取码；失败时抛可读中文，弹窗按 message 展示）。
 * @param options.slot - 为哪个实例取码（缺省 = 第一个实例）。
 * @returns 一次性凭证 / 二维码内容 / 过期时间 / 初始四态。
 */
export async function apiCreateClawbotBindQr(options?: { slot?: number }): Promise<ClawbotBindQr> {
  return unwrap(await remote().createClawbotBindQr(options))
}

/**
 * 中继一次绑定状态轮询（弹窗打开期间反复调用；单次最长约 40 秒）。
 * @param options.slot - 哪个实例的这场扫码会话（缺省 = 第一个实例）。
 * @returns 状态与绑定卡片快照。
 */
export async function apiGetClawbotBindState(options?: { slot?: number }): Promise<ClawbotBindStateSnapshot> {
  return unwrap(await remote().getClawbotBindState(options))
}

/**
 * 解绑（断开该实例的通道；接入会话保留）。
 * @param options.slot - 实例编号（缺省 = 第一个实例）。
 * @returns 解绑后的绑定卡片快照。
 */
export async function apiUnbindClawbot(options?: { slot?: number }): Promise<ClawbotBindingSnapshot> {
  return unwrap(await remote().unbindClawbot(options))
}

/**
 * 接入会话检索（时间 / 关键词 / 方向 / 分页 / 续传）。
 * @param options - 检索条件（关键词在服务端过滤）。
 * @returns 会话页快照。
 */
export async function apiListClawbotMessages(options?: ClawbotMessageQuery): Promise<ClawbotMessageSnapshot> {
  return unwrap(await remote().listClawbotMessages(options))
}

/**
 * 清空某实例的**接入会话**（2026-10-17）：只删消息，不动绑定与配置。
 * @param options.slot - 实例编号（缺省 = 第一个实例）。
 * @returns 删掉的条数 + 最新会话页快照。
 */
export async function apiClearClawbotMessages(options?: { slot?: number }): Promise<{ removed: number, messages: ClawbotMessageSnapshot }> {
  return unwrap(await remote().clearClawbotMessages(options))
}

/**
 * 取内置的拟人化默认系统提示词（2026-10-17）。
 *
 * 设置视图的输入框用它**预填** —— 用户能看到默认值长什么样，直接在它上面改，
 * 而不是面对一个空框从零写。
 * @returns 默认提示词全文。
 */
export async function apiGetClawbotDefaultPrompt(): Promise<string> {
  return unwrap(await remote().getClawbotDefaultPrompt()).prompt
}

/**
 * 环境自检（精简 3 项；第 ② 项读该实例的通道）。
 * @param options.slot - 实例编号（缺省 = 第一个实例）。
 * @returns 自检快照。
 */
export async function apiCheckClawbotEnv(options?: { slot?: number }): Promise<ClawbotEnvSnapshot> {
  return unwrap(await remote().checkClawbotEnv(options))
}

/**
 * 发送一条消息到微信（你逐条主动触发；正文经腾讯服务中转，失败返回可读原因、不落库）。
 * @param options.text - 正文原文。
 * @param options.slot - 从哪个实例发（缺省 = 第一个实例）。
 * @returns 发送结果（成功才带 id）。
 */
export async function apiSendClawbotMessage(options: { text: string, slot?: number }): Promise<ClawbotSendResult> {
  return unwrap(await remote().sendClawbotMessage(options))
}

/**
 * 取某条消息的附件（**点开才取**：下载 + 解密 + 落本机缓存）。
 * @param options.id - 会话行 id。
 * @returns 图片给内联小图 dataUrl；其余给本机路径（配合 `apiOpenPath` 打开）。
 */
export async function apiGetClawbotMedia(options: { id: number }): Promise<ClawbotMediaResult> {
  return unwrap(await remote().getClawbotMedia(options))
}
