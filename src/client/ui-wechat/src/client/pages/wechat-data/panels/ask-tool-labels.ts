/**
 * 问答运行过程共用的工具名映射。
 *
 * 微信问答（Ask）与会话内 AI 问答（SessionAsk）共用同一套展示层；工具名到
 * 中文动作的映射只在这里维护，避免新增工具时两处漏改、把英文工具名暴露给
 * 用户。未知工具仍原样返回，由调用方决定是否兜底成「未知工具」。
 *
 * @module panels/ask-tool-labels
 */

/** 工具名 → 中文动作；未知工具由解析函数原样返回。 */
export const ASK_TOOL_LABELS: Readonly<Record<string, string>> = {
  search_messages: '消息检索',
  search_semantic: '语义检索',
  search_hybrid: '混合检索',
  aggregate_messages: '统计消息',
  list_sessions: '会话列表',
  get_session_messages: '读取会话消息',
  get_message_context: '展开消息上下文',
  search_contacts: '联系人检索',
  get_contact_detail: '联系人详情',
  search_moments: '朋友圈检索',
  search_favorites: '收藏检索',
  search_files: '文件检索',
  search_records: '转账/红包检索',
  search_kb: '知识库检索',
  get_funds_summary: '转账/红包汇总',
  get_call_history: '通话记录',
  get_group_detail: '群资料',
  search_revoked: '撤回检索',
  aggregate_media: '媒体盘点',
  get_moments_stats: '朋友圈统计',
}

/**
 * 解析工具名的中文展示名。
 * @param name - 后端工具名（可能为空或来自新版本后端）。
 * @returns 已知工具返回中文名；未知工具原样返回；空值返回 undefined。
 */
export function askToolNameLabel(name: string | undefined): string | undefined {
  if (!name) return undefined
  return ASK_TOOL_LABELS[name] ?? name
}
