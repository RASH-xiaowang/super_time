/**
 * 启动页的静态内容表（2026-09-30 按「首次上手」主线重写）。
 *
 * 主线：**你能拿它做什么 → 怎么开始 → 每个功能回答什么问题 → 边界与数据在哪**。
 * 四张表分别喂四个内容页：首页（三步开始 + 高频问法）/ 功能引导（真实侧栏分组）/
 * 使用说明（可执行步骤 + 常见问题）/ 关于（边界与反馈）。
 *
 * 两条纪律：
 *   ① 功能分组的**名字与条目**以 `nav-config.ts` 为真源 —— 那里是 9 组 / 17 个侧栏入口 /
 *      37 个可路由页签，且多项在面板内以分段切换进入（公众号、周期、年度、社交图谱、
 *      文件、知识图谱、转账红包…）。凭印象写会写出「已合并掉」的旧条目；
 *   ② 首页 rail 上的两个计数（`MODULES` / `REMOTE API`）是**用户可见的契约声明**，
 *      由 `docs-consistency.wiring.spec.ts` 与 `api-docs.spec.ts` 从真源现算比对，
 *      所以它们留在 `OnboardingShell.tsx` 里、不放进本文件。
 */
import type { ReactNode } from 'react'

/** 首页「三步开始」：每一步的**动作**与**做完应看到什么**。 */
export const FIRST_RUN_STEPS = [
  {
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
    ),
    title: '告诉它数据在哪',
    desc: '「设置 → 数据配置」选定微信账号目录并保存；密钥点「自动获取」（需微信正在运行）或手动填。',
  },
  {
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <ellipse cx="12" cy="6" rx="8" ry="3" />
        <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
        <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
      </svg>
    ),
    title: '等它解密并建索引',
    desc: '保存后自动开始，跑在独立后端进程里、界面不卡；首次按消息量可能要几分钟。',
  },
  {
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
    title: '开始提问或翻数据',
    desc: '「微信问答」用一句话提问，「数据总览」看账号概况；AI 需先在「AI 大模型」里配好模型与 Key。',
  },
] as const

/**
 * 首页「高频问法」：用一个真实问句说明这个应用**能回答什么**，右侧写出该去哪儿看。
 *
 * 用问句而不是功能名当标题，是因为首次上手的人还不知道「资金往来」「群聊分析」
 * 这些面板名对应自己的什么需求；反过来更容易对上号。
 */
export const QUESTION_CARDS: Array<{
  id: string
  name: string
  desc: string
  icon: ReactNode
}> = [
  {
    id: 'q-search',
    name: '「上周三群里谁提过发货？」',
    desc: '聊天会话 / 群聊分析 · 按关键词、人、时间段检索',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
    ),
  },
  {
    id: 'q-money',
    name: '「这个月和谁转账最多？」',
    desc: '资金往来 · 转账红包按月汇总，可对账',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="2" y="6" width="20" height="14" rx="2" />
        <path d="M2 10h20" />
      </svg>
    ),
  },
  {
    id: 'q-summary',
    name: '「把昨天的群聊总结一下」',
    desc: '总结 · 每日 / 周期 / 年度报告，还能给单个群建定时任务',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <path d="M8 13h8M8 17h5" />
      </svg>
    ),
  },
  {
    id: 'q-assets',
    name: '「我收藏过哪些表情和文件？」',
    desc: '收藏与表情 / 文件与存储 · 资产盘点与空间占用',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M12 2.8 20.6 8.2v7.6L12 21.2 3.4 15.8V8.2z" />
        <path d="M12 12 3.4 8.2M12 12l8.6-3.8M12 12v9.2" />
      </svg>
    ),
  },
]

/**
 * 功能引导：**按侧栏真实分组逐组对齐**（`nav-config.ts` 的 9 组）。
 *
 * `items` 里带「（分段）」的是同一个入口内用顶部分段条切换的视图 —— 侧栏只占一个条目，
 * 所以写成「主条目标题（分段名）」，而不是各列一条（那会让人在侧栏里找不到）。
 */
export const FEATURE_GROUPS = [
  {
    name: '概览 · 问答 · 总结',
    desc: '先看清账号规模，再用自然语言提问；年度/周期报告与知识库都在这一组。问答只检索本机语料，回答带 [n] 来源。',
    items: ['数据总览', '微信问答', '总结', '年度报告（分段）', '周期报告（分段）', '知识库'],
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="7" height="9" rx="1" />
        <rect x="14" y="3" width="7" height="5" rx="1" />
      </svg>
    ),
  },
  {
    name: '会话与消息',
    desc: '按人 / 群 / 时间段检索消息；群聊看活跃与成员，通话与撤回各有视图。消息里的图片、语音、文件都能就地打开。',
    items: ['聊天会话', '群聊分析', '通话记录', '撤回消息（分段）', '公众号 / 服务号 / 客服（分段）'],
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="4" width="18" height="17" rx="2" />
        <path d="M8 2v4M16 2v4M3 9h18" />
      </svg>
    ),
  },
  {
    name: '关系与社交',
    desc: '通讯录、社交图谱、朋友圈与朋友圈洞察：同一批关系数据的四种看法。',
    items: ['通讯录', '社交图谱（分段）', '朋友圈', '朋友圈洞察'],
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    name: '资产与资金',
    desc: '收藏、表情、文件与媒体资产的盘点，以及资金往来与逐笔转账红包。',
    items: ['收藏与表情', '表情包 / 收藏统计（分段）', '文件与存储', '媒体资产 / 存储分析（分段）', '公众号文章（分段）', '资金往来', '转账红包（分段）'],
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="9" cy="7" r="4" />
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      </svg>
    ),
  },
  {
    name: '行动与维护',
    desc: '待办日程、只读审计（操作日志）、隐私体检，以及设置弹窗（含数据库健康与原图链路自检）。',
    items: ['待办日程', '操作日志', '隐私体检', '数据边界与出网 / 备份恢复（分段）', '设置'],
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    ),
  },
] as const

/** 使用说明：四步，每步都写明**做完应看到什么**（否则用户不知道自己做对没有）。 */
export const HELP_STEPS = [
  {
    title: '配置数据来源',
    body: '「设置 → 数据配置」选定微信账号目录并保存；数据库密钥可点「自动获取」（微信需正在运行，只读扫描进程内存，不修改不注入），也可手动填写。要看图片与视频，再填一次图片密钥。',
    done: '做完应看到：账号已检测到、密钥条数大于 0。',
  },
  {
    title: '等它解密并建索引',
    body: '保存后自动开始：把消息库解密到数据根，并建立检索索引。整个过程跑在独立后端进程里，界面可以继续操作；消息量大的库首次可能要几分钟。',
    done: '做完应看到：顶栏连接状态变成「在线」，数据总览里出现消息量。',
  },
  {
    title: '开始检索与问答',
    body: '在「聊天会话」按人或群搜消息，顶部统一搜索可跨会话 / 联系人 / 朋友圈 / 收藏 / 文件 / 资金。要用 AI 问答与总结，先在「AI 大模型」里填好供应商、模型名与 API Key。',
    done: '做完应看到：提问能给出带 [n] 来源的回答，总结能出报告。',
  },
  {
    title: '隐私与维护',
    body: '用「隐私体检」查敏感信息与高风险会话；用「设置 → 备份恢复」做快照；用「操作日志」回看每一次动作。批量导出、删除、覆盖式操作之前先备份。',
    done: '做完应看到：体检出报告，备份列表里有快照。',
  },
] as const

/** 常见问题：首启最容易卡住的五件事，答案都指向界面里真实存在的出口。 */
export const FAQ = [
  {
    title: '图片 / 视频显示不出来？',
    body: '本机有缓存的直接显示；没有的要看两件事：图片密钥是否配好，以及本机能不能联网取回。完全断网时只有本机已有的那部分可用。',
  },
  {
    title: '它会偷偷上传我的数据吗？',
    body: '不会。应用内已经没有任何出网开关，每一个出网点都逐条写在「隐私同意」页与 docs/PRIVACY.md 里；要彻底断网，请断网或在系统防火墙里禁止本应用出站。',
  },
  {
    title: '密钥从哪里来？',
    body: '微信运行时可「自动获取」：只读扫描 Weixin.exe 进程内存按特征匹配，不写入、不注入、不挂钩，命中后只存在本机。微信没开就手动填写，效果一样。',
  },
  {
    title: '数据存在哪、怎么彻底删？',
    body: '配置与库在 %APPDATA%\\Super Time 下的 wechat 与 wechat-data（若在设置里换过数据根，则以那个目录为准）。删掉对应目录即彻底删除；卸载程序不会自动删。',
  },
  {
    title: '第一次打开很慢？',
    body: '首次要解密全库并建索引，按消息量可能持续几分钟；后端在独立进程，界面保持可响应。之后启动会明显变快。',
  },
] as const

/** 注意事项：常见问题里没覆盖到的两条底线。 */
export const NOTICES = [
  {
    title: '妥善保管密钥',
    body: '数据库密钥与图片密钥只保存在本机配置里，请勿截图或把配置文件发给别人。',
  },
  {
    title: '先备份，再动数据',
    body: '批量导出、删除或覆盖式操作之前，先用「备份恢复」做一份完整快照。',
  },
] as const
