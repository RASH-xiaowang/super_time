/**
 * Super Time 多页面启动页
 *
 * 四页：首页 / 功能引导 / 使用说明 / 关于。
 * 首次启动必须浏览全部页面；再次启动可跳过直接进入主界面。
 * 视觉令牌复用主面板 scifi-theme.css（--nm-*）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
// 启动页可能先于 WechatDataPanel 挂载，主题令牌需在此加载
import '../../ui-wechat/src/client/pages/wechat-data/scifi-theme.css'
import '../../ui-wechat/src/client/pages/wechat-data/light-theme.css'
import { getThemeMode, toggleThemeMode } from '../../ui-wechat/src/client/pages/wechat-data/theme.ts'
import {
  ONBOARDING_PAGES,
  allPagesVisited,
  completeOnboarding,
  loadOnboardingState,
  markPageVisited,
  saveOnboardingState,
  type OnboardingPageId,
  type OnboardingState,
} from './store.ts'
import { ParticleField } from './particles.tsx'
import { Reveal, pickAnim } from './Reveal.tsx'
import { LicenseAuthPanel, isLicenseUsable } from '../license/LicenseAuthPanel.tsx'
import type { LicenseStatus } from '../license/LicenseGate.tsx'
// 启动页（含最后一站「授权验证」）也要能看到「有新版本可装 / 许可证即将到期」——
// 更新与到期是主进程的事，与「有没有进主界面」无关。这一屏没有设置弹窗，故不传 onOpenLicense。
import { NoticeBanner } from '../../ui-wechat/src/client/pages/wechat-data/panels/NoticeBanner.tsx'
import css from './onboarding.module.css'

const APP_VERSION = '1.0.4'

/** 首页价值主张（贴合本地解密 + AI 分析定位）。 */
const VALUE_PROPS = [
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
const MODULE_ENTRIES: Array<{
  id: string
  name: string
  desc: string
  icon: React.ReactNode
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
const FEATURE_GROUPS = [
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

const HELP_STEPS = [
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

const NOTICES = [
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

/** 启动页四张阶段背景图（public/onboarding → 构建后 ui-dist/onboarding）。 */
const STAGE_BGS = [
  'onboarding/bg-stage-0.png',
  'onboarding/bg-stage-1.png',
  'onboarding/bg-stage-2.png',
  'onboarding/bg-stage-3.png',
] as const

/**
 * 启动页阶段 = 4 个介绍页 + 最后的「授权验证」。
 *
 * 授权阶段不是 `OnboardingPageId`：它不记录「已浏览」（visited 只统计内容页），
 * 但它是流程里的最后一站，并且是进入系统的唯一闸门。
 */
const LICENSE_STAGE = 'license' as const
type OnboardingStage = OnboardingPageId | typeof LICENSE_STAGE

function BrandMark({ size = 22 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9.5 3.5C4.8 3.5 1 6.8 1 10.9c0 2.3 1.2 4.4 3.2 5.8L3 20l3.7-1.6c.9.3 1.8.4 2.8.4 4.7 0 8.5-3.3 8.5-7.9S14.2 3.5 9.5 3.5Z" fill="currentColor" opacity=".18" />
      <path d="M9.5 3.5C4.8 3.5 1 6.8 1 10.9c0 2.3 1.2 4.4 3.2 5.8L3 20l3.7-1.6c.9.3 1.8.4 2.8.4 4.7 0 8.5-3.3 8.5-7.9S14.2 3.5 9.5 3.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="6.2" cy="10.8" r="1" fill="currentColor" />
      <circle cx="9.7" cy="10.8" r="1" fill="currentColor" />
      <circle cx="13.2" cy="10.8" r="1" fill="currentColor" />
    </svg>
  )
}

/** HUD 角落装饰框（左上形态，其余用 CSS 镜像）。 */
function HudCorner(): React.JSX.Element {
  return (
    <svg viewBox="0 0 56 56" fill="none" aria-hidden="true">
      <path d="M4 20V8a4 4 0 0 1 4-4h12" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4 28h8M20 4v8" stroke="currentColor" strokeWidth="1" opacity=".55" />
      <circle cx="4" cy="20" r="1.6" fill="currentColor" />
      <circle cx="20" cy="4" r="1.6" fill="currentColor" />
    </svg>
  )
}

/** 底栏环形进度：已浏览页数 / 总页数。 */
function ProgressRing({ value, total }: { value: number; total: number }): React.JSX.Element {
  const r = 16
  const c = 2 * Math.PI * r
  const pct = total <= 0 ? 0 : Math.min(1, value / total)
  const offset = c * (1 - pct)
  return (
    <div className={css.progressRing} aria-hidden="true">
      <svg viewBox="0 0 40 40">
        <defs>
          <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#00f0ff" />
            <stop offset="100%" stopColor="#a855f7" />
          </linearGradient>
        </defs>
        <circle className={css.ringTrack} cx="20" cy="20" r={r} />
        <circle
          className={css.ringValue}
          cx="20"
          cy="20"
          r={r}
          strokeDasharray={c}
          strokeDashoffset={offset}
        />
      </svg>
      <span className={css.ringLabel}>{value}/{total}</span>
    </div>
  )
}

/** 统一舞台页头：阶段序号 + 标题 + 导语，建立阅读层次。 */
function StageHead({
  index,
  title,
  lead,
  align = 'left',
}: {
  index: string
  title: string
  lead: string
  align?: 'left' | 'center'
}): React.JSX.Element {
  return (
    <header className={`${css.stageHead}${align === 'center' ? ` ${css.stageHeadCenter}` : ''}`}>
      <Reveal anim="slide-l" delayMs={20}>
        <div className={css.stageMeta}>
          <span className={css.stageIndex}>{index}</span>
          <span className={css.stageRule} aria-hidden="true" />
          <span className={css.stageTag}>SUPER TIME BOOT</span>
        </div>
        <h2 className={css.stageTitle}>{title}</h2>
      </Reveal>
      <Reveal anim="fade" delayMs={90}>
        <p className={css.stageLead}>{lead}</p>
      </Reveal>
    </header>
  )
}

function HomePage({ onExplore }: { onExplore: () => void }): React.JSX.Element {
  return (
    <div className={css.page}>
      <div className={css.homeLayout}>
        <section className={css.homePrimary}>
          <Reveal anim="slide-l" delayMs={30}>
            <div className={css.heroKicker}>
              <span className={css.kickerDot} aria-hidden="true" />
              LOCAL · WECHAT · INTELLIGENCE
            </div>
            <h1 className={css.heroTitle}>
              把微信数据<br />
              <span className={css.heroTitleAccent}>变成可检索的知识库</span>
            </h1>
          </Reveal>
          <Reveal anim="fade" delayMs={120}>
            <p className={css.heroLead}>
              Super Time 在本机解密并分析你的消息库：会话、社交、资产、资金与隐私一体覆盖，
              并提供 AI 问答与周期总结。数据默认不出机。
            </p>
          </Reveal>

          <div className={css.valueList}>
            {VALUE_PROPS.map((v, i) => (
              <Reveal key={v.title} anim={pickAnim(i, ['slide-l', 'slide-u', 'fade', 'slide-r'])} delayMs={180 + i * 70}>
                <div className={css.valueItem}>
                  <span className={css.valueIndex}>{String(i + 1).padStart(2, '0')}</span>
                  <span className={css.valueIcon}>{v.icon}</span>
                  <div className={css.valueCopy}>
                    <div className={css.valueTitle}>{v.title}</div>
                    <div className={css.valueDesc}>{v.desc}</div>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        <aside className={css.homeRail} aria-label="系统概览">
          <div className={css.railLabel}>TELEMETRY</div>
          {[
            { k: 'MODULES', v: '16', h: '侧栏入口 · 30+ 视图' },
            // 这个数字是用户可见的契约声明，必须与 gateway.ts 的 @Remote 数量一致。
            // 它曾长期停在 114 而无人发现 —— 现在由
            // src/backend/tests/api-docs.spec.ts 守着，改了方法面就会在这里转红。
            { k: 'REMOTE API', v: '158', h: '查询 / 导出 / 审计 / 总结' },
            { k: 'RUNTIME', v: 'LOCAL', h: 'utilityProcess 独立后端' },
          ].map((s, i) => (
            <Reveal key={s.k} anim="slide-r" delayMs={140 + i * 90}>
              <div className={css.railStat}>
                <div className={css.railKey}>{s.k}</div>
                <div className={css.railVal}>{s.v}</div>
                <div className={css.railHint}>{s.h}</div>
              </div>
            </Reveal>
          ))}
        </aside>
      </div>

      <section className={css.moduleSection}>
        <Reveal anim="slide-l" delayMs={60}>
          <div className={css.sectionTitle}>
            <span>快速入口</span>
            <span className={css.sectionSub}>进入系统后可从侧栏打开</span>
          </div>
        </Reveal>
        <div className={css.moduleStrip}>
          {MODULE_ENTRIES.map((m, i) => (
            <Reveal key={m.id} anim={pickAnim(i, ['slide-u', 'fade', 'slide-l', 'scale'])} delayMs={i * 50} className={css.moduleCell}>
              <button type="button" className={css.moduleCard} onClick={onExplore}>
                <span className={css.moduleIdx}>{String(i + 1).padStart(2, '0')}</span>
                <span className={css.moduleIcon}>{m.icon}</span>
                <span className={css.moduleName}>{m.name}</span>
                <span className={css.moduleDesc}>{m.desc}</span>
              </button>
            </Reveal>
          ))}
        </div>
      </section>
    </div>
  )
}

function FeaturesPage(): React.JSX.Element {
  return (
    <div className={css.page}>
      <StageHead
        index="02"
        title="功能引导"
        lead="按主界面侧栏分组了解能力边界。部分视图在面板内以分段切换进入（如总结中的周期 / 年度）。"
      />
      <div className={css.featureList}>
        {FEATURE_GROUPS.map((g, i) => (
          <Reveal key={g.name} anim={pickAnim(i, ['slide-l', 'slide-r', 'fade', 'slide-u'])} delayMs={i * 55}>
            <article className={css.featureRow}>
              <div className={css.featureNo}>{String(i + 1).padStart(2, '0')}</div>
              <div className={css.featureBody}>
                <div className={css.featureHead}>
                  <span className={css.featureBadge}>{g.icon}</span>
                  <h3 className={css.featureName}>{g.name}</h3>
                </div>
                <p className={css.featureDesc}>{g.desc}</p>
                <div className={css.chipRow}>
                  {g.items.map((it) => (
                    <span key={it} className={css.chip}>{it}</span>
                  ))}
                </div>
              </div>
            </article>
          </Reveal>
        ))}
      </div>
    </div>
  )
}

function HelpPage(): React.JSX.Element {
  return (
    <div className={css.page}>
      <StageHead
        index="03"
        title="使用说明"
        lead="建议按顺序完成首次配置。出错时可到「数据健康 / 操作日志」查看诊断信息。"
      />
      <div className={css.helpLayout}>
        <ol className={css.stepList}>
          {HELP_STEPS.map((s, i) => (
            <Reveal key={s.title} anim="slide-l" delayMs={i * 80}>
              <li className={css.step}>
                <div className={css.stepNum} aria-hidden="true">{String(i + 1).padStart(2, '0')}</div>
                <div>
                  <div className={css.stepTitle}>{s.title}</div>
                  <div className={css.stepBody}>{s.body}</div>
                </div>
              </li>
            </Reveal>
          ))}
        </ol>
        <div className={css.noticeCol}>
          <Reveal anim="slide-r" delayMs={40}>
            <div className={css.sectionTitle}><span>注意事项</span></div>
          </Reveal>
          {NOTICES.map((n, i) => (
            <Reveal key={n.title} anim="fade" delayMs={100 + i * 70}>
              <div className={css.notice}>
                <div className={css.noticeTitle}>{n.title}</div>
                <div className={css.noticeBody}>{n.body}</div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </div>
  )
}

function AboutPage({ versions }: {
  versions: { electron?: string; chrome?: string; node?: string } | null
}): React.JSX.Element {
  return (
    <div className={css.page}>
      <StageHead
        index="04"
        title="关于 Super Time"
        lead="项目定位、运行时版本与反馈渠道。"
      />
      <div className={css.aboutLayout}>
        <Reveal anim="slide-l" delayMs={100}>
          <section className={css.aboutBlock}>
            <h3 className={css.aboutTitle}>项目简介</h3>
            <p className={css.aboutText}>
              Super Time 是面向个人用户的本地微信数据分析桌面应用。
              Electron 桌面壳 + React/Vite 前端（NEON MATRIX）+ 独立 utilityProcess 后端，
              提供会话检索、社交图谱、资产盘点、隐私审计与 AI 总结。核心分析默认离线。
            </p>
            <dl className={css.metaList}>
              <div className={css.metaRow}><dt>应用版本</dt><dd>{APP_VERSION}</dd></div>
              <div className={css.metaRow}><dt>Electron</dt><dd>{versions?.electron ?? '—'}</dd></div>
              <div className={css.metaRow}><dt>Chromium</dt><dd>{versions?.chrome ?? '—'}</dd></div>
              <div className={css.metaRow}><dt>Node</dt><dd>{versions?.node ?? '—'}</dd></div>
              <div className={css.metaRow}><dt>产品名</dt><dd>Super Time</dd></div>
            </dl>
          </section>
        </Reveal>
        <Reveal anim="slide-r" delayMs={180}>
          <section className={css.aboutBlock}>
            <h3 className={css.aboutTitle}>联系方式与反馈</h3>
            <p className={css.aboutText}>
              提交问题或建议时请勿附带密钥或完整聊天内容。
            </p>
            <ul className={css.contactList}>
              <li className={css.contactItem}>
                <span className={css.contactTitle}>项目内反馈</span>
                <span className={css.contactDesc}>导出「操作日志」诊断，连同复现步骤一并提交</span>
              </li>
              <li className={css.contactItem}>
                <span className={css.contactTitle}>在线文档</span>
                <span className={css.contactDesc}>仓库 README 与 docs/compose/spec</span>
              </li>
              <li className={css.contactItem}>
                <span className={css.contactTitle}>隐私承诺</span>
                <span className={css.contactDesc}>默认不上传聊天数据；AI 仅在你配置的接口处理</span>
              </li>
            </ul>
          </section>
        </Reveal>
      </div>
    </div>
  )
}

export interface OnboardingShellProps {
  /** 完成或跳过后进入主界面。 */
  onComplete: () => void
}

export function OnboardingShell({ onComplete }: OnboardingShellProps): React.JSX.Element {
  const [state, setState] = useState<OnboardingState>(() => loadOnboardingState())
  /**
   * 当前阶段。首启一律从「首页」开始 —— 先介绍是什么、有什么，最后才要许可证；
   * 只有「启动页已完成、再次被拉回来纯粹是因为授权失效」才直接落到授权页。
   */
  const [page, setPage] = useState<OnboardingStage>(() => (state.completed ? LICENSE_STAGE : 'home'))
  const [versions, setVersions] = useState<{ electron?: string; chrome?: string; node?: string } | null>(null)
  const [theme, setTheme] = useState(() => getThemeMode())
  const [lic, setLic] = useState<LicenseStatus | null>(null)
  const [licLoading, setLicLoading] = useState(true)
  const bodyRef = useRef<HTMLElement | null>(null)
  /** 滚轮翻页冷却：一次手势只切一页，避免触控板惯性连翻。 */
  const wheelLockRef = useRef(false)
  const wheelAccRef = useRef(0)

  const licenseOk = isLicenseUsable(lic)
  const onLicenseStage = page === LICENSE_STAGE

  const isFirstLaunch = !state.completed
  const ready = (state.completed || allPagesVisited(state)) && licenseOk
  const pageOrder = useMemo<OnboardingStage[]>(
    () => [...ONBOARDING_PAGES.map((p) => p.id), LICENSE_STAGE],
    [],
  )
  const pageIndex = pageOrder.indexOf(page)
  /** 背景图只有 4 张：第 5 阶段（授权）沿用最后一张，否则背景会整块暗下去。 */
  const bgIndex = Math.min(pageIndex, STAGE_BGS.length - 1)
  const visitedCount = ONBOARDING_PAGES.filter((p) => state.visited.includes(p.id)).length

  // 每次进入启动页都检测 License（含过期/无效强制授权）
  useEffect(() => {
    let cancelled = false
    const api = (window as any).electronAPI?.license
    if (!api?.status) {
      setLic({ state: 'error', licensed: false, reason: 'license_api_missing' })
      setLicLoading(false)
      return
    }
    void api.status().then((s: LicenseStatus) => {
      if (!cancelled) {
        setLic(s)
        setLicLoading(false)
      }
    }).catch((err: Error) => {
      if (!cancelled) {
        setLic({ state: 'error', licensed: false, reason: err.message })
        setLicLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const api = (window as any).electronAPI
    if (!api?.getVersions) return
    void api.getVersions().then((v: { electron?: string; chrome?: string; node?: string }) => {
      if (v) setVersions(v)
    }).catch(() => { /* 版本信息非关键 */ })
  }, [])

  // 进入某页即记为已浏览（首启强制覆盖全部页）；授权阶段不是内容页，不记录
  useEffect(() => {
    if (onLicenseStage) return
    setState((prev) => {
      const next = markPageVisited(prev, page)
      if (next === prev) return prev
      saveOnboardingState(next)
      return next
    })
  }, [page, onLicenseStage])

  // 切页后回到内容区顶部
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
  }, [page])

  /**
   * 滚轮翻页：内容区能滚且未到顶/底时优先滚内容；
   * 已到边或内容不可滚时，累计足够 deltaY 后切上/下一页。
   */
  useEffect(() => {
    const shell = bodyRef.current?.parentElement
    if (!shell) return

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return
      const body = bodyRef.current
      if (!body) return

      const maxScroll = body.scrollHeight - body.clientHeight
      const atTop = body.scrollTop <= 1
      const atBottom = body.scrollTop >= maxScroll - 1
      const scrollingDown = e.deltaY > 0
      const scrollingUp = e.deltaY < 0

      // 内容还可滚：交给浏览器，不切页
      if (maxScroll > 2 && !((scrollingDown && atBottom) || (scrollingUp && atTop))) {
        return
      }

      e.preventDefault()
      if (wheelLockRef.current) return

      wheelAccRef.current += e.deltaY
      const THRESHOLD = 40
      if (Math.abs(wheelAccRef.current) < THRESHOLD) return

      const dir = wheelAccRef.current > 0 ? 1 : -1
      wheelAccRef.current = 0
      wheelLockRef.current = true
      window.setTimeout(() => { wheelLockRef.current = false }, 420)

      if (dir > 0) {
        setPage((cur) => {
          const i = pageOrder.indexOf(cur)
          return pageOrder[Math.min(pageOrder.length - 1, i + 1)]
        })
      } else {
        setPage((cur) => {
          const i = pageOrder.indexOf(cur)
          return pageOrder[Math.max(0, i - 1)]
        })
      }
    }

    shell.addEventListener('wheel', onWheel, { passive: false })
    return () => { shell.removeEventListener('wheel', onWheel) }
  }, [pageOrder])

  const goPage = useCallback((id: OnboardingStage) => {
    setPage(id)
  }, [])

  const goPrev = useCallback(() => {
    setPage((cur) => {
      const i = pageOrder.indexOf(cur)
      return pageOrder[Math.max(0, i - 1)]
    })
  }, [pageOrder])

  const goNext = useCallback(() => {
    setPage((cur) => {
      const i = pageOrder.indexOf(cur)
      return pageOrder[Math.min(pageOrder.length - 1, i + 1)]
    })
  }, [pageOrder])

  // 键盘：← → 翻页，Enter 在最后一页进入系统
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault()
        goNext()
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        goPrev()
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        if (licenseOk && (state.completed || allPagesVisited(state))) {
          const next = completeOnboarding(state)
          setState(next)
          onComplete()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goNext, goPrev, state, onComplete, licenseOk])

  const handleEnter = useCallback(() => {
    if (!licenseOk) return
    if (isFirstLaunch && !allPagesVisited(state)) return
    const next = completeOnboarding(state)
    setState(next)
    onComplete()
  }, [isFirstLaunch, state, onComplete, licenseOk])

  const handleSkip = useCallback(() => {
    if (!licenseOk) return
    const next = completeOnboarding(state)
    setState(next)
    onComplete()
  }, [state, onComplete, licenseOk])

  const toggleTheme = useCallback(() => {
    toggleThemeMode()
    setTheme(getThemeMode())
  }, [])

  return (
    <div
      className={css.shell}
      data-theme={theme}
      data-stage={pageIndex}
      style={{ ['--stage-p' as string]: String(pageIndex / Math.max(1, pageOrder.length - 1)) }}
    >
      {/* 主动提醒（右下角悬浮）：启动页上也要能看到「有新版本可装 / 许可证即将到期」。
          位置由卡片自己 fixed 决定，放在 DOM 哪儿都不影响呈现。 */}
      <NoticeBanner />

      {/* 多张背景图：随滚轮切页交叉淡入 */}
      <div className={css.bgStack} aria-hidden="true">
        {STAGE_BGS.map((src, i) => (
          <div
            key={src}
            className={`${css.bgImage}${bgIndex === i ? ` ${css.bgImageOn}` : ''}`}
            style={{ backgroundImage: `url(${src})` }}
          />
        ))}
      </div>
      <div className={css.bgVeil} aria-hidden="true" />
      {/* 阶段光晕：随滚轮切页改变位置与色相 */}
      <div className={css.stageWash} aria-hidden="true" />
      {/* 背景光效层：网格 / 粒子 / 光带 / 扫描 / 几何 / HUD 角 */}
      <div className={css.bgGrid} aria-hidden="true" />
      <ParticleField className={css.particles} stage={bgIndex} />
      <div className={`${css.lightBand} ${css.lightBandA}`} aria-hidden="true" />
      <div className={`${css.lightBand} ${css.lightBandB}`} aria-hidden="true" />
      <div className={`${css.lightBand} ${css.lightBandC}`} aria-hidden="true" />
      <div className={css.scanlines} aria-hidden="true" />
      <div className={css.scanBeam} aria-hidden="true" />
      <div className={`${css.geoRing} ${css.geoRingA}`} aria-hidden="true" />
      <div className={`${css.geoRing} ${css.geoRingB}`} aria-hidden="true" />
      <div className={`${css.geoDot} ${css.geoDotA}`} aria-hidden="true" />
      <div className={`${css.geoDot} ${css.geoDotB}`} aria-hidden="true" />
      <div className={`${css.geoDot} ${css.geoDotC}`} aria-hidden="true" />
      <div className={`${css.hudFrame} ${css.hudTl}`} aria-hidden="true"><HudCorner /></div>
      <div className={`${css.hudFrame} ${css.hudTr}`} aria-hidden="true"><HudCorner /></div>
      <div className={`${css.hudFrame} ${css.hudBl}`} aria-hidden="true"><HudCorner /></div>
      <div className={`${css.hudFrame} ${css.hudBr}`} aria-hidden="true"><HudCorner /></div>

      <header className={css.top}>
        <div className={css.brand}>
          <span className={css.brandIcon}><BrandMark size={20} /></span>
          <div className={css.brandText}>
            <span className={css.brandName}>Super Time</span>
            <span className={css.brandSub}>Onboarding · System Boot</span>
          </div>
        </div>
        <nav className={css.tabs} aria-label="启动页导航">
          {ONBOARDING_PAGES.map((p) => {
            const done = state.visited.includes(p.id)
            return (
              <button
                key={p.id}
                type="button"
                className={`${css.tab}${page === p.id ? ` ${css.tabActive}` : ''}`}
                onClick={() => goPage(p.id)}
                aria-current={page === p.id ? 'page' : undefined}
              >
                {done && page !== p.id ? <span className={css.tabDot} aria-hidden="true" /> : null}
                {p.label}
              </button>
            )
          })}
          {/* 授权是启动页的最后一站。已授权的老用户点它可直接跳过去，不必重看介绍页。 */}
          <button
            type="button"
            className={`${css.tab}${onLicenseStage ? ` ${css.tabActive}` : ''}`}
            onClick={() => goPage(LICENSE_STAGE)}
            aria-current={onLicenseStage ? 'page' : undefined}
          >
            {licenseOk && !onLicenseStage ? <span className={css.tabDot} aria-hidden="true" /> : null}
            授权验证
          </button>
          <button
            type="button"
            className={`${css.tab}`}
            onClick={toggleTheme}
            title={theme === 'light' ? '切换到深色' : '切换到浅色'}
            aria-label="切换主题"
          >
            {theme === 'light' ? '🌙 深色' : '☀️ 浅色'}
          </button>
        </nav>
      </header>
      <div className={css.neonRule} aria-hidden="true" />

      <main className={css.body} ref={bodyRef}>
        {onLicenseStage ? (
          <div className={css.page}>
            <StageHead
              index="05"
              title="License 授权验证"
              lead="启动页的最后一步：导入厂商签发的许可证即可进入系统主界面。已授权可跳过本页。"
            />
            <LicenseAuthPanel
              status={lic}
              compact
              onStatusChange={(next) => {
                setLic(next)
              }}
            />
          </div>
        ) : (
          <>
            {page === 'home' && <HomePage onExplore={() => goPage('features')} />}
            {page === 'features' && <FeaturesPage />}
            {page === 'help' && <HelpPage />}
            {page === 'about' && <AboutPage versions={versions} />}
          </>
        )}
      </main>

      <div className={css.neonRule} aria-hidden="true" />
      <footer className={css.footer}>
        <div className={css.progress}>
          <ProgressRing
            value={onLicenseStage ? (licenseOk ? 1 : 0) : (isFirstLaunch ? visitedCount : pageIndex + 1)}
            total={onLicenseStage ? 1 : ONBOARDING_PAGES.length}
          />
          <div className={css.dots} aria-hidden="true">
            {ONBOARDING_PAGES.map((p) => (
              <span
                key={p.id}
                className={`${css.dot}${state.visited.includes(p.id) ? ` ${css.dotDone}` : ''}${page === p.id ? ` ${css.dotCurrent}` : ''}`}
              />
            ))}
            <span className={`${css.dot}${licenseOk ? ` ${css.dotDone}` : ''}${onLicenseStage ? ` ${css.dotCurrent}` : ''}`} />
          </div>
          <span className={css.progressText}>
            {onLicenseStage
              ? `STAGE ${String(pageIndex + 1).padStart(2, '0')}/0${pageOrder.length} · ${licLoading ? 'CHECKING LICENSE…' : licenseOk ? 'LICENSE OK' : 'LICENSE REQUIRED'}`
              : `STAGE ${String(pageIndex + 1).padStart(2, '0')}/0${pageOrder.length}${isFirstLaunch ? ` · 已浏览 ${visitedCount}` : ''}`}
          </span>
        </div>
        <div className={css.actions}>
          {!licenseOk ? (
            <span className={css.hint}>
              {onLicenseStage ? '完成授权后方可进入系统' : '最后一页完成授权后方可进入系统'}
            </span>
          ) : !ready && isFirstLaunch ? (
            <span className={css.hint}>浏览完四页后可进入 · ← → 翻页</span>
          ) : (
            <span className={css.hint}>← → 翻页</span>
          )}
          {state.completed ? (
            <button type="button" className={`${css.btn} ${css.btnGhost}`} onClick={handleSkip} disabled={!licenseOk}>
              跳过
            </button>
          ) : null}
          <button type="button" className={css.btn} onClick={goPrev} disabled={pageIndex <= 0}>
            上一页
          </button>
          {pageIndex < pageOrder.length - 1 ? (
            <button type="button" className={`${css.btn} ${css.btnPrimary}`} onClick={goNext}>
              下一页
            </button>
          ) : (
            <button
              type="button"
              className={`${css.btn} ${css.btnPrimary}`}
              onClick={handleEnter}
              disabled={!ready}
            >
              进入系统
            </button>
          )}
          {pageIndex < pageOrder.length - 1 && ready ? (
            <button type="button" className={css.btn} onClick={handleEnter}>
              进入系统
            </button>
          ) : null}
        </div>
      </footer>
    </div>
  )
}
