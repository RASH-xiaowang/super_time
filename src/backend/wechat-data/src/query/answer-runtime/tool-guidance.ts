/**
 * 工具选择提示：只生成“优先检查/兜底尝试”的文本，不执行工具。
 *
 * @module query/answer-runtime/tool-guidance
 */
import type { RetrievalTool } from '../tools/types.ts'
import type { AnswerProfile } from '../tools/profiles.ts'

/** 只保留 profile 工具集里真实存在的建议，避免提示一个本轮不可用的工具。 */
export function profileToolHints(
  profile: AnswerProfile,
  hints: readonly string[],
  tools: readonly RetrievalTool[],
): string[] {
  const available = new Set(tools.map(tool => String(tool.name)))
  const allowed = new Set<string>(profile.allowedTools)
  const out: string[] = []
  for (const raw of hints) {
    const name = String(raw ?? '').trim()
    if (name === '' || !available.has(name) || !allowed.has(name) || out.includes(name)) continue
    out.push(name)
  }
  return out
}

/** 把可用工具写成简短排序建议，仍要求模型按问题自行选择。 */
export function buildToolHintBlock(
  tools: readonly string[],
  profile?: AnswerProfile,
): string {
  const guidance = profile?.id === 'session-ask'
    ? '本入口只查当前会话内的消息、转账/红包、通话、群资料、媒体与撤回记录；这些工具会强制锁定当前会话。没有证据就如实说明，不要改查联系人、文件、收藏、朋友圈、知识库或其他会话。'
    : '若问题明确是文件/收藏/朋友圈/联系人/统计，不要用泛化检索替代对应工具。'
  return `\n\n本轮建议优先检查的工具（只是排序建议，仍按问题选择）：${tools.join('、')}。`
    + guidance
    + '拿到足够证据后停止调用。'
}
