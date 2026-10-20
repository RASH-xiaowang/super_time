/**
 * 启动页的静态内容表（2026-10-19 微信化改版：精简、去重复叙事）。
 *
 * 主线：**你能拿它做什么 → 怎么开始 → 边界与数据在哪**。
 * 四张表分别喂四个内容页：
 *   · 首页（三步开始 + 两条高频问法）；
 *   · 功能引导（按侧栏 5 组逐组对齐）；
 *   · 使用说明（四步「首次配置」+ 3 条常见问题）；
 *   · 关于（它是什么 / 数据在哪 / 出问题时）。
 *
 * 两条纪律：
 *   ① 功能分组的**名字与顺序**以 `nav-config.ts` 的 `NAV_GROUPS` 为真源 ——
 *      `nav-onboarding-drift.wiring.spec.ts` 与 `scripts/onboarding-ssr.tsx` 逐组同序比对，
 *      改一边不改另一边会红；`items` 只保留**侧栏真实入口**（≤5 个），已合并成
 *      分段视图的写成「X（分段）」，不要再列成独立条目（那会造成 9→5 之外的二次漂移）；
 *   ② 首页「本机规模」两个计数（`MODULES` / `REMOTE API`）是**用户可见的契约声明**，
 *      由 `docs-consistency.wiring.spec.ts` / `src/backend/tests/api-docs.spec.ts`
 *      与真源现算比对，所以它们留在 `HomePage.tsx` 里、不放进本文件。
 */
import type { ReactNode } from 'react'

/** 首页「三步开始」：每一步的**动作**与「做完应看到什么」。 */
export const FIRST_RUN_STEPS = [
  {
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
    ),
    title: '选数据目录',
    desc: '「设置 → 数据配置」选定微信账号目录并保存，数据库密钥点「自动获取」或手动填。',
  },
  {
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <ellipse cx="12" cy="6" rx="8" ry="3" />
        <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
        <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
      </svg>
    ),
    title: '等解密建索引',
    desc: '保存后自动开始，跑在独立后端进程里，界面不卡；首次可能要几分钟。',
  },
  {
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
    title: '开始提问',
    desc: '「微信问答」用一句话提问，「数据总览」看账号概况；AI 需先配好模型与 Key。',
  },
] as const

/**
 * 首页「高频问法」：用两个真实问句说明这个应用**能回答什么**，右侧写出该去哪儿看。
 *
 * 微信化改版从 4 张压到 2 张：首屏只承担「这几类问题它答得了」，其余同类示例
 * 放「使用说明」的常见问题里，不再重复占一屏。
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
]

/**
 * 功能引导：**按侧栏真实分组逐组对齐**（`nav-config.ts` 的 5 组）。
 *
 * `name` 必须与 `NAV_GROUPS` 的 label 逐组同序（防漂移守卫盯着）；`items` 只保留
 * 侧栏真实入口（可见项 + 已合并的 hidden 分段），每组 ≤5 个，避免一屏堆三十多个胶囊。
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
    desc: '按人 / 群 / 时间段检索消息；通话、撤回、公众号都收进了「聊天会话」的顶部分段，不必另找入口。',
    items: ['聊天会话', '群聊分析', '通话记录（分段）', '撤回消息（分段）', '公众号 / 服务号 / 客服（分段）'],
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="4" width="18" height="17" rx="2" />
        <path d="M8 2v4M16 2v4M3 9h18" />
      </svg>
    ),
  },
  {
    name: '关系与社交',
    desc: '通讯录、社交图谱、朋友圈与朋友圈洞察：同一批关系数据的几种看法，分段切换即可。',
    items: ['通讯录', '社交图谱（分段）', '朋友圈', '朋友圈洞察（分段）'],
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    name: '资产与资金',
    desc: '收藏、表情、文件与媒体资产的盘点，以及资金往来与逐笔转账红包。',
    items: ['收藏与表情', '文件与存储', '媒体资产 / 存储分析（分段）', '公众号文章（分段）', '资金往来', '转账红包（分段）'],
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="9" cy="7" r="4" />
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      </svg>
    ),
  },
  {
    name: '行动与维护',
    desc: '待办与任务、操作日志、ClawBot 集群，以及设置弹窗（含隐私体检、备份恢复与数据库健康）。',
    items: ['ClawBot集群', '待办日程', '任务信息', '操作日志', '设置'],
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

/** 常见问题：首启最容易卡住的三件事，答案都指向界面里真实存在的出口。 */
export const FAQ = [
  {
    title: '图片 / 视频显示不出来？',
    body: '本机有缓存的直接显示；没有的要看两件事：图片密钥是否配好，以及本机能不能联网取回。完全断网时只有本机已有的那部分可用。',
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
