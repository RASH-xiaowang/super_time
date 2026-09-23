/**
 * 启动页的五张静态内容表：首页价值主张 / 快速入口 / 功能分组 / 使用步骤 / 注意事项。
 *
 * 从 `OnboardingShell.tsx` 拆出来（M21 棘轮：单文件 1000 行上限，白名单只许减不许加）。
 * 拆的理由不只是行数：这里全是**死的文案与 SVG**，改文案不该碰到闸门状态机 ——
 * 启动页里真正决定「能不能进系统」的只有同意与授权那两站（H14）。
 */
import type { ReactNode } from 'react'

/** 首页价值主张（贴合本地解密 + AI 分析定位）。 */
export const VALUE_PROPS = [
  {
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
    title: '本地优先 · 数据不出机',
    desc: '解密库与分析均在本机完成，不上传聊天内容',
  },
  {
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
    title: '全量会话与社交图谱',
    desc: '消息、群聊、联系人、朋友圈一体检索',
  },
  {
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19" />
      </svg>
    ),
    title: 'AI 问答与智能总结',
    desc: '按账号语料提问，生成每日 / 周期 / 年度报告',
  },
  {
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
    ),
    title: '隐私体检与资产盘点',
    desc: '扫描敏感信息、资金往来与文件存储占用',
  },
] as const

/** 首页功能模块入口 → 对应侧栏主入口。 */
export const MODULE_ENTRIES: Array<{
  id: string
  name: string
  desc: string
  icon: ReactNode
}> = [
  {
    id: 'overview',
    name: '数据总览',
    desc: '账号概况、消息量与关键指标一览',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="3" y="3" width="7" height="9" rx="1" />
        <rect x="14" y="3" width="7" height="5" rx="1" />
        <rect x="14" y="12" width="7" height="9" rx="1" />
        <rect x="3" y="16" width="7" height="5" rx="1" />
      </svg>
    ),
  },
  {
    id: 'ask',
    name: '微信问答',
    desc: '基于本机语料的 AI 对话助手',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v2M12 20v2M2 12h2M20 12h2" />
      </svg>
    ),
  },
  {
    id: 'chats',
    name: '聊天会话',
    desc: '按会话检索消息、图片、文件与撤回内容',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    id: 'contacts',
    name: '通讯录',
    desc: '好友与群成员画像、社交关系',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
      </svg>
    ),
  },
  {
    id: 'moments',
    name: '朋友圈',
    desc: '动态时间线与作者筛选',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
    ),
  },
  {
    id: 'files',
    name: '文件与存储',
    desc: '文件资产、媒体盘点与空间分析',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
    ),
  },
  {
    id: 'settings',
    name: '数据配置',
    desc: '数据库目录、密钥与路径设置',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
      </svg>
    ),
  },
]

/** 功能引导页分类（对齐侧栏 nav-config 分组）。 */
export const FEATURE_GROUPS = [
  {
    name: '概览与问答',
    desc: '先看全局，再用自然语言向本机语料提问。适合第一次打开时快速摸清账号规模。',
    items: ['数据总览', '微信问答'],
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="7" height="9" rx="1" />
        <rect x="14" y="3" width="7" height="5" rx="1" />
      </svg>
    ),
  },
  {
    name: '报告与总结',
    desc: '把一段时间内的聊天沉淀成可读报告：每日摘要、周期总结与年度回顾。',
    items: ['总结', '周期报告', '年度报告'],
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="4" width="18" height="17" rx="2" />
        <path d="M8 2v4M16 2v4M3 9h18" />
      </svg>
    ),
  },
  {
    name: '会话与消息',
    desc: '按会话/群检索消息，支持公众号过滤、群聊活跃分析、通话记录与撤回消息回看。',
    items: ['聊天会话', '群聊分析', '通话记录', '撤回消息'],
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    name: '联系人与社交',
    desc: '通讯录画像、朋友圈时间线，以及跨会话的社交关系图谱。',
    items: ['通讯录', '朋友圈', '社交图谱'],
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="9" cy="7" r="4" />
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      </svg>
    ),
  },
  {
    name: '内容资产',
    desc: '收藏、表情包、文件与媒体附件、公众号文章统一盘点，支持空间占用分析。',
    items: ['收藏与表情', '文件与存储', '媒体资产', '公众号文章'],
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    ),
  },
  {
    name: '资金往来',
    desc: '转账与红包明细，按月汇总资金流向，方便对账与回顾。',
    items: ['资金往来', '转账红包'],
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="2" y="6" width="20" height="14" rx="2" />
        <path d="M2 10h20" />
      </svg>
    ),
  },
  {
    name: '洞察与行动',
    desc: '朋友圈互动洞察，以及从聊天中沉淀的待办日程。',
    items: ['朋友圈洞察', '待办日程'],
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    ),
  },
  {
    name: '隐私与安全',
    desc: '隐私体检、数据边界审计，以及本地备份恢复。',
    items: ['隐私与信任', '隐私体检', '备份恢复'],
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
  },
  {
    name: '维护与设置',
    desc: '配置数据目录与密钥，查看库健康度与操作日志。',
    items: ['数据配置', '数据健康', '操作日志'],
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82" />
      </svg>
    ),
  },
] as const

export const HELP_STEPS = [
  {
    title: '配置数据来源',
    body: '打开侧栏「数据配置」，设置微信账号数据库目录、密钥与图片密钥。路径会写入 wechat/config.json，下次启动自动应用。',
  },
  {
    title: '导入并解密',
    body: '保存配置后，后端会在独立进程内解密消息库并建立索引。首次导入耗时取决于消息量，期间窗口仍可操作；完成后顶栏连接状态变为在线。',
  },
  {
    title: '浏览与检索',
    body: '从「数据总览」进入全局指标，或直接在「聊天会话」按人/群检索消息。顶部统一搜索支持会话、联系人、朋友圈、收藏、文件与资金记录。',
  },
  {
    title: '使用 AI 能力',
    body: '在「微信问答」用自然语言提问；在「总结」生成每日/周期报告。需先在数据配置中接入 OpenAI 兼容模型（供应商、模型名、API Key、Base URL）。',
  },
  {
    title: '隐私与维护',
    body: '定期用「隐私体检」扫描敏感信息，用「数据健康」检查库完整性，用「备份恢复」导出快照。敏感操作均有确认提示。',
  },
] as const

export const NOTICES = [
  {
    title: '全程本地运行',
    body: '解密与查询在本机 SQLite 完成。只有在你主动配置并调用 AI 时，相关上下文才会发往所填模型接口。',
  },
  {
    title: '妥善保管密钥',
    body: '微信数据库密钥与图片密钥仅保存在本机配置中，请勿截图或分享配置文件。',
  },
  {
    title: '建议先导出备份',
    body: '进行批量导出、删除或覆盖式操作前，先用「备份恢复」做一份完整快照。',
  },
  {
    title: '大库首次加载较慢',
    body: '消息量很大时，首次解密/建索引可能持续数分钟；后端跑在独立进程，界面尽量保持可响应。',
  },
] as const
