/**
 * 首轮未调用工具时的确定性兜底选择。
 *
 * 意图分类已经会给出 `toolHints`，但资源型问题（朋友圈 / 收藏 / 文件 / 转账红包）
 * 的关键词边界比意图更具体，单独在这里做一层窄匹配，避免为了补四个工具再把
 * 已经过大的 `intent.ts` 继续撑大。
 *
 * 本模块只产出「建议工具名」，不执行、不读库；调用方仍需按 profile 白名单与
 * 工具真实可用性过滤。
 *
 * @module query/answer-runtime/fallbacks
 */

/** 资源词 → 更合适的专用工具（按问题中出现的顺序稳定去重）。 */
const RESOURCE_RULES: ReadonlyArray<{ re: RegExp; tool: string }> = [
  { re: /朋友圈|动态|说说/, tool: 'search_moments' },
  { re: /收藏|书签/, tool: 'search_favorites' },
  { re: /文件|文档|附件|表格|pdf|excel|word|ppt|压缩包|安装包/i, tool: 'search_files' },
  { re: /转账|红包|收款|付款|账单|交易记录/, tool: 'search_records' },
  { re: /联系人|好友|微信号|电话号码|手机号|是谁/, tool: 'search_contacts' },
]

/**
 * 根据问题补充资源型兜底工具。
 * @param question - 用户问题。
 * @param available - 当前 profile 在本次实际装配的工具名。
 * @returns 命中的、且当前可用的工具名（最多 3 个）。
 */
export function resourceFallbackTools(
  question: string,
  available: ReadonlySet<string>,
): string[] {
  const text = String(question ?? '').trim()
  if (text === '') return []
  const out: string[] = []
  for (const rule of RESOURCE_RULES) {
    if (!rule.re.test(text) || !available.has(rule.tool) || out.includes(rule.tool)) continue
    out.push(rule.tool)
    if (out.length >= 3) break
  }
  return out
}
