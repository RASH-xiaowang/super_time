/**
 * Navigation configuration for the WeChat data panel shell: group order,
 * per-item label/icon, and the closed tab union. Keeping this in its own
 * module lets the panel import the config and lets tests assert the IA
 * without rendering the full shell.
 *
 * Hidden items stay routable (deep links / cross-panel navigation) but are not
 * shown in the sidebar; the visible parent item exposes them via in-panel
 * filters (e.g. 聊天会话 → 公众号/服务号/客服).
 */
export type WechatTab =
  | 'overview' | 'ask' | 'chats' | 'graph' | 'knowledge' | 'monitor' | 'contacts' | 'moments'
  | 'favorites' | 'emoticons' | 'files' | 'records' | 'ledger' | 'storage' | 'bizchats'
  | 'servicechats' | 'kefu' | 'annual' | 'period' | 'dailysummary' | 'hook' | 'privacy'
  | 'revoked' | 'backup' | 'settings' | 'oplog' | 'tasks' | 'groupinsights' | 'health' | 'momentsinsights' | 'privacytrust' | 'assetinsights' | 'officialassets' | 'mediaassets' | 'calls'

export interface NavItem {
  tab: WechatTab
  label: string
  icon: string
  /** Routable but not rendered in the sidebar; exposed by a parent item. */
  hidden?: boolean
}

export const NAV_GROUPS: ReadonlyArray<{ label: string; items: ReadonlyArray<NavItem> }> = [
  {
    label: '概览与问答',
    items: [
      { tab: 'overview', label: '数据总览', icon: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>' },
      { tab: 'ask', label: '微信问答', icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19"/>' },
    ],
  },
  {
    label: '报告与总结',
    items: [
      { tab: 'annual', label: '年度报告', icon: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>', hidden: true },
      { tab: 'dailysummary', label: '总结', icon: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4M16 2v4M3 9h18"/><path d="M8 14h3M13 14h3M8 17h3M13 17h3"/>' },
      // 周期总结与每日总结是同一条链路的两种视图（README/实现均复用），合并为「总结」的第二个分段
      { tab: 'period', label: '周期报告', icon: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4M16 2v4M3 9h18"/><path d="M7 14h4M13 14h4M7 17h4"/>', hidden: true },
    ],
  },
  {
    label: '会话与消息',
    items: [
      { tab: 'chats', label: '聊天会话', icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' },
      { tab: 'bizchats', label: '会话·公众号', icon: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>', hidden: true },
      { tab: 'servicechats', label: '会话·服务号', icon: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>', hidden: true },
      { tab: 'kefu', label: '会话·客服', icon: '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>', hidden: true },
      { tab: 'groupinsights', label: '群聊分析', icon: '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><line x1="8.5" y1="7.5" x2="10.5" y2="15.5"/><line x1="15.5" y1="7.5" x2="13.5" y2="15.5"/>' },
      // 活跃监控与离线洞察都是「按群看消息量/成员」的视图，合并进「群聊分析」
      { tab: 'monitor', label: '群聊监控', icon: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>', hidden: true },
      { tab: 'calls', label: '通话记录', icon: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>' },
      { tab: 'revoked', label: '撤回消息', icon: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/><path d="M21 3v6h-6"/>', hidden: true },
    ],
  },
  {
    label: '联系人与社交',
    items: [
      { tab: 'contacts', label: '通讯录', icon: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>' },
      { tab: 'moments', label: '朋友圈', icon: '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>' },
      // 社交图谱与知识图谱是两个并列入口，不共用一个面板的模式切换：
      // 前者是「我的人脉」（好友/群组），后者是「我的笔记」（知识网络/融合视图）。
      // 两者的数据源、指标口径（消息量 vs 连接度）与默认筛选都不同，合成一个面板
      // 会让默认视图变得含糊 —— 打开图谱的人多数是想看好友。
      { tab: 'graph', label: '社交图谱', icon: '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><line x1="8.5" y1="7.5" x2="10.5" y2="15.5"/><line x1="15.5" y1="7.5" x2="13.5" y2="15.5"/><line x1="6" y1="9" x2="6" y2="13"/><line x1="18" y1="9" x2="18" y2="13"/>' },
      { tab: 'knowledge', label: '知识图谱', icon: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><circle cx="9" cy="8" r="1.2"/><circle cx="14" cy="6.5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><line x1="9.8" y1="8.6" x2="11.3" y2="11.2"/><line x1="13.2" y1="7.5" x2="12.5" y2="10.9"/>' },
    ],
  },
  {
    label: '内容资产',
    items: [
      { tab: 'favorites', label: '收藏与表情', icon: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>' },
      // 表情包与「收藏/表情统计」都是同一批数据的视图（统计面板本身就统计收藏+表情）
      { tab: 'emoticons', label: '表情包', icon: '<circle cx="12" cy="12" r="10"/><circle cx="8" cy="10" r="1"/><circle cx="16" cy="10" r="1"/><path d="M8 15a4 4 0 0 0 8 0"/>', hidden: true },
      { tab: 'assetinsights', label: '收藏表情统计', icon: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>', hidden: true },
      { tab: 'files', label: '文件与存储', icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>' },
      // 媒体资产与存储分析都在盘点同一批附件体积（存储分析取 apiGetStorageStats，媒体资产取 apiGetMediaAssets，文件资产两者都用）
      { tab: 'mediaassets', label: '媒体资产', icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>', hidden: true },
      { tab: 'storage', label: '存储分析', icon: '<path d="M22 12H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/>', hidden: true },
      { tab: 'officialassets', label: '公众号文章', icon: '<path d="M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/>', hidden: true },
    ],
  },
  {
    label: '资金',
    items: [
      { tab: 'ledger', label: '资金往来', icon: '<rect x="2" y="6" width="20" height="14" rx="2"/><path d="M2 10h20M2 14h20"/><path d="M7 18h10"/>' },
      // 资金账本是「按月汇总」、转账红包是「逐条明细」，同一批转账/红包消息的两种视图
      { tab: 'records', label: '转账红包', icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="7" y1="8" x2="17" y2="8"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="7" y1="16" x2="13" y2="16"/>', hidden: true },
    ],
  },
  {
    label: '洞察与行动',
    items: [
      { tab: 'momentsinsights', label: '朋友圈洞察', icon: '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>' },
      { tab: 'tasks', label: '待办日程', icon: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>' },
    ],
  },
  {
    label: '隐私与安全',
    items: [
      // 「数据边界与出网 / 备份恢复」2026-09 迁进「设置」弹窗（它们是配置与维护动作，
      // 见 Settings.tsx 的分组）。保留 tab id（深链 #privacytrust / #backup 与其它面板的
      // 跳转仍走它），但不占侧栏条目：命中这些 tab 时由 WechatDataPanel 的 DIALOG_SECTION_OF
      // 改道去开弹窗并落到对应节。
      { tab: 'privacytrust', label: '数据边界与出网', icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4M12 16h.01"/>', hidden: true },
      // 隐私体检 2026-09 一度也进过弹窗，现按「只读数据视图回主界面」迁回来：
      // 它是分类扫描结果 + 风险联系人/群 TOP10，命中样本还要能跳回会话 —— 那属于看数据。
      { tab: 'privacy', label: '隐私体检', icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>' },
      { tab: 'backup', label: '备份恢复', icon: '<path d="M21 12a9 9 0 1 1-9-9"/><polyline points="21 3 21 9 15 9"/>', hidden: true },
    ],
  },
  {
    label: '维护与设置',
    items: [
      // settings 固定在侧栏底部（这是它的图标来源）；health/hook 是「设置」弹窗里的两节（自检与维护动作）。
      // 操作日志 2026-09 一度也进过弹窗，现按「只读数据视图回主界面」迁回来：它是审计长表，
      // 弹窗右区只有 660px 宽、浏览与翻查都别扭。
      { tab: 'settings', label: '设置', icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>' },
      { tab: 'oplog', label: '操作日志', icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>' },
      { tab: 'health', label: '数据库健康', icon: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>', hidden: true },
      { tab: 'hook', label: '原图链路自检', icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h3M12 17H8M16 13h1M17 17h1"/>', hidden: true },
    ],
  },
]

export const TAB_LABELS: Record<WechatTab, string> = (() => {
  const map = {} as Record<WechatTab, string>
  for (const g of NAV_GROUPS) for (const it of g.items) map[it.tab] = it.label
  return map
})()
