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
  // 金额/笔数/收支优先走账本；只有问「某一笔」或单号时才轮到 records。
  // 两条规则都会命中「转账」类问题，兜底上限 3 个，顺序决定优先级。
  { re: /(收到|转出|支出|收入|一共|多少|总额).*(转账|红包|钱)|转账.*(多少|金额)|红包.*(多少|金额)|账单|收支/, tool: 'get_funds_summary' },
  { re: /转账|红包|收款|付款|账单|交易记录/, tool: 'search_records' },
  { re: /通话|电话|未接|拨打|接听/, tool: 'get_call_history' },
  { re: /群公告|群主|群成员|群资料|这个群有多少人|群里有多少人/, tool: 'get_group_detail' },
  { re: /撤回/, tool: 'search_revoked' },
  { re: /(多少|几张|几条|哪些|最近).*(图片|照片|视频|语音|表情|位置)/, tool: 'aggregate_media' },
  { re: /(多少|几条|点赞|评论|获赞).*朋友圈|朋友圈.*(多少|几条|点赞|评论|获赞)/, tool: 'get_moments_stats' },
  { re: /朋友圈|动态|说说/, tool: 'search_moments' },
  { re: /收藏|书签/, tool: 'search_favorites' },
  { re: /文件|文档|附件|表格|pdf|excel|word|ppt|压缩包|安装包/i, tool: 'search_files' },
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
