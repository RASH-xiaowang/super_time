/**
 * 手机端的**底部标签栏 + 「更多」全屏 sheet**。
 *
 * ## 为什么是底部栏而不是把侧栏做成抽屉
 *
 * 侧栏（58px 折叠 / 176px 展开的推挤式）在 375px 上要么吃掉近一半宽度、
 * 要么变成「每次都要先划开一层」的抽屉。底部栏是微信自己的心智模型，拇指可达，
 * 而且**常驻** —— 用户随时知道自己在哪、能去哪。
 *
 * 36 个 tab 塞不进 5 个格子，所以是「4 个高频 + 更多」：更多里按 `NAV_GROUPS` 的原分组
 * 列全部条目（含「设置」），分组名沿用桌面侧栏那套，两边找东西的路径一致。
 *
 * ## 与桌面侧栏的关系
 *
 * **同一份数据源**（`nav-config.ts` 的 `NAV_GROUPS`），不另列一张表。这条很要紧：
 * 另列一份的话，新增 tab 时必然只加到一边，症状是「桌面上有这个页、手机上找不到」。
 * `mobile-nav.wiring.spec.ts` 就是钉这件事的 —— 桌面侧栏渲染的每个条目都必须在
 * 手机侧可达，反之亦然。
 *
 * hidden 条目（如 `annual` / `period` / `kefu`）两边都**不**渲染：它们在桌面端也只能
 * 由父面板内的分段切换到达（见 `nav-config.ts` 的头注），手机端沿用同一口径。
 *
 * @module ui/mobile-nav
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { NAV_GROUPS, type NavItem, type WechatTab } from '../nav-config.ts'
import { BugReportDialog } from '../panels/BugReportDialog.tsx'
import { PHONE_QUERY, useMediaQuery } from './use-media-query.ts'
import css from './mobile-nav.module.css'

/** 底部栏的 4 个高频位（第 5 格固定是「更多」）。 */
const PRIMARY: readonly WechatTab[] = ['chats', 'overview', 'ask', 'contacts']

/**
 * 手机端「更多」sheet 里**保留**的条目（2026-10-16 手机端重设计）。
 *
 * ## 为什么要有白名单，而不是「列全部可见条目」
 *
 * 桌面侧栏有 16 个可见条目（含设置），那是**桌面**的信息架构：屏幕宽、鼠标精确、可以并排看。
 * 手机上照搬会得到一张 15 格的 sheet，其中一半是**在手机上读不动或没意义**的：
 *
 *   · `oplog`（操作日志）—— 审计长表，手机上横向溢出 104 处（实测 640px 表格塞进 556px 视口），
 *     而且「翻查审计记录」本来就是坐在电脑前做的事；
 *   · `annual` / `period`（年度 / 周期报告）—— 长报告，手机上读不动（它们本来就是 hidden，
 *     由「总结」页内的分段条到达，手机沿用同一口径）。
 *
 * 保留的 9 条都是**手机上真的会看**的：朋友圈、收藏与表情、文件与存储、资金往来、
 * 群聊分析、知识库、总结、待办日程、客户画像与标签。
 *
 * ⚠️ 2026-10-17：`momentsinsights`（并入朋友圈）、`privacy`（并入设置）、`calls`（并入聊天会话）
 * 三块已转 hidden —— 它们不再占任何导航条目，由父项的分段条到达，所以从白名单里去掉。
 * 手机端沿用同一口径（hidden 项不进 sheet）。
 *
 * ## 与桌面侧栏的关系
 *
 * 白名单是**手机端专属的收窄**，不是另立一份导航表：条目本身仍从 `NAV_GROUPS` 取
 * （图标、标签、分组名都不重写），只是**过滤**掉手机上不显示的那几条。
 * `mobile-nav.wiring.spec.ts` 钉住「白名单里的每一条都必须在 NAV_GROUPS 里存在」——
 * 写错 tab 名会静默少一格，那条判据就是防这个的。
 */
const PHONE_KEEP: readonly WechatTab[] = [
  'moments', 'portraits', 'favorites', 'files', 'ledger', 'groupinsights',
  'kb', 'dailysummary', 'tasks',
]

/**
 * 手机端**刻意移除**的桌面可见条目，以及每一条的理由。
 *
 * 写成「tab → 理由」而不是一个裸数组：守卫要能断言「移除的每一条都写了理由」，
 * 而理由本身是给下一个人看的 —— 没有理由的移除看起来就像漏了。
 */
const PHONE_HIDDEN: Readonly<Record<string, string>> = Object.freeze({
  oplog: '审计长表：手机上横向溢出 104 处（640px 表格塞进 556px 视口），且翻查审计本就是坐在电脑前做的事',
  // 2026-10-19：任务信息的价值在「配置 + 触发回调」，而写侧（建/改/删/扫描/回调投递）
  // 与旧「聊天素材收集任务」同为仅桌面端方法（见 `backend/http-remote-policy.js` 的 B/D 族）。
  // 放进手机端只会得到一个「能看列表却点不动编辑/检查」的半死界面，故整项留在桌面。
  taskinfo: '任务信息的写侧（新建/编辑/扫描/回调投递）只允许桌面端（本机任务库 + 用户配置的回调出网）；手机端只能看不能改，故整项不进手机导航',
  // 2026-10-27：消息列表的规则写入、手动插入、重发与带令牌 Webhook 地址同样只开桌面端。
  // 手机端虽然能只读记录，但没有可执行动作的台账不值得占「更多」里的固定一格。
  messagelist: '消息列表的写规则、手动插入、重发与 Webhook 地址只允许桌面端；手机端即使能读记录也无法处理，故整项不进手机导航',
  // 2026-11-24：本地工具是只读清单，但它是给「排查某个能力为什么没生效」用的 ——
  // 要对照调用名、参数与源文件，而手机档没有源码可对照，也没有日志入口。
  // 卡片网格在 360px 视口里会被压成一列很长的清单，读起来还不如桌面侧栏方便。
  localtools: '本地工具是排查用清单（调用名/参数/源文件），手机档没有源码与日志入口可对照，且单列长清单在窄视口难以扫读，故留在桌面端',
  // 2026-11-24：应用托管的写侧（部署/启动/停止/能力）全部是主进程本机能力，
  // 手机端连不到被托管实例的目录，也拿不到实例令牌，只能看一张点不动的卡片。
  apps: '应用托管的部署/启停/能力都依赖本机主进程与实例目录，手机端无法执行，故整项留在桌面端',
})

/** 把 NAV_GROUPS 压平成 tab → 条目 的查找表（图标与标签都从这里取，不另写一份）。 */
const ITEM_BY_TAB: ReadonlyMap<WechatTab, NavItem> = new Map(
  NAV_GROUPS.flatMap((g) => [...g.items]).map((it) => [it.tab, it] as const),
)

/**
 * 「更多」sheet 里要列的分组与条目。
 *
 * 过滤口径：跳过 hidden、跳过 settings（它单独一组）、**只留 {@link PHONE_KEEP} 里的**。
 * 分组名沿用桌面侧栏那套（`NAV_GROUPS` 的 label），两边找东西的路径一致。
 */
function sheetGroups(): ReadonlyArray<{ label: string, items: ReadonlyArray<NavItem> }> {
  const keep = new Set<WechatTab>(PHONE_KEEP)
  const out: Array<{ label: string, items: ReadonlyArray<NavItem> }> = []
  for (const g of NAV_GROUPS) {
    const items = g.items.filter((it) => !it.hidden && it.tab !== 'settings' && keep.has(it.tab))
    if (items.length > 0) out.push({ label: g.label, items })
  }
  return out
}

/**
 * nav-config 里的图标是 path 片段，需要包一层 svg（与桌面侧栏同一套画法与光学尺寸）。
 *
 * 关于 `dangerouslySetInnerHTML`：插入的是 `nav-config.ts` 里**硬编码的 SVG path 常量**
 * （仓内静态源码，不来自微信数据、不来自用户输入、也不来自网络），与桌面侧栏
 * `WechatDataPanel.tsx` 用的是同一份数据、同一种画法。这里不接受任何外部字符串。
 */
function NavIcon({ fragment, size = 22 }: { fragment: string, size?: number }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <g dangerouslySetInnerHTML={{ __html: fragment }} />
    </svg>
  )
}

/** 「更多」那一格的图标：三个点（不属于任何 tab，所以不在 nav-config 里）。 */
function MoreIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" stroke="none" aria-hidden="true">
      <circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" />
    </svg>
  )
}

/**
 * 「Bug 反馈」的图标：24×24 线稿 bug。
 *
 * 不复用 nav-config 里的 settings 图标 —— 它是个齿轮，两个入口并排却同图，
 * 用户分不清哪个是配置、哪个是报障。
 */
function BugIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m8 2 1.88 1.88" />
      <path d="M14.12 3.88 16 2" />
      <path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" />
      <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" />
      <path d="M12 20v-9" />
      <path d="M6.53 9C4.6 8.8 3 7.1 3 5" />
      <path d="M6 13H2" />
      <path d="M3 21c0-2.1 1.7-3.9 3.8-4" />
      <path d="M20.97 5c0 2.1-1.6 3.8-3.5 4" />
      <path d="M22 13h-4" />
      <path d="M17.2 17c2.1.1 3.8 1.9 3.8 4" />
    </svg>
  )
}

/**
 * 底部标签栏。
 *
 * @param props.active - 当前 tab（高亮用）。
 * @param props.onSelect - 选中某个 tab。
 * @param props.onOpenSettings - 打开设置弹窗（手机端的设置入口在「更多」里）。
 */
export function MobileNav({
  active,
  onSelect,
  onOpenSettings,
}: {
  active: WechatTab
  onSelect: (tab: WechatTab) => void
  onOpenSettings?: () => void
}): React.JSX.Element {
  const [moreOpen, setMoreOpen] = useState(false)
  // Bug 反馈弹窗的状态不能挂在 `MobileNavHost` 的对外 props 上：宿主（WechatDataPanel）
  // 只关心导航选中与设置入口，报障入口完全属于手机端自己的「更多」sheet。
  const [bugOpen, setBugOpen] = useState(false)
  // 打开 Bug 弹窗前会先卸载 sheet（触发按钮随之消失），关闭后焦点必须手动还给「更多」。
  const moreButtonRef = useRef<HTMLButtonElement | null>(null)
  /** sheet 根节点：初始焦点、Tab 焦点陷阱、body 滚动锁都以它为界。 */
  const sheetRef = useRef<HTMLDivElement | null>(null)
  /** 记录 sheet 是否真的打开过，避免首次挂载时把页面焦点抢到「更多」。 */
  const wasMoreOpenRef = useRef(false)
  const groups = sheetGroups()
  const settingsItem = ITEM_BY_TAB.get('settings')

  // 从「更多」里选完就关掉 sheet； Esc 也能关（手机上更常见的是点遮罩，两个都给）。
  const pick = useCallback((tab: WechatTab) => {
    setMoreOpen(false)
    onSelect(tab)
  }, [onSelect])

  useEffect(() => {
    if (!moreOpen) return undefined
    const panel = sheetRef.current
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    wasMoreOpenRef.current = true
    // 打开即把焦点送进 sheet（第一个可聚焦元素是右上角关闭按钮）。
    panel?.querySelector<HTMLElement>('button')?.focus()
    const focusables = (): HTMLElement[] => panel === null
      ? []
      : [...panel.querySelectorAll<HTMLElement>('button:not([disabled]),[href],input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])')]
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); setMoreOpen(false); return }
      if (e.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) { e.preventDefault(); return }
      const first = items[0] as HTMLElement
      const last = items[items.length - 1] as HTMLElement
      const current = document.activeElement
      const inside = current !== null && panel?.contains(current) === true
      if (e.shiftKey) {
        if (!inside || current === first) { e.preventDefault(); last.focus() }
      } else if (!inside || current === last) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKey)
    }
  }, [moreOpen])

  // 关闭后焦点还给「更多」；但转去 Bug 弹窗时交给它的 onClose 处理（它自己会还）。
  useEffect(() => {
    if (moreOpen) { wasMoreOpenRef.current = true; return }
    if (!wasMoreOpenRef.current) return
    wasMoreOpenRef.current = false
    if (!bugOpen) moreButtonRef.current?.focus()
  }, [moreOpen, bugOpen])

  // 当前 tab 不在 4 个高频位里时，「更多」那一格高亮 —— 否则用户看不出自己在哪。
  const inPrimary = PRIMARY.includes(active)

  return (
    <>
      {moreOpen && (
        <div ref={sheetRef} className={css.sheet} role="dialog" aria-modal="true" aria-label="全部功能">
          <div className={css.sheetScrim} onClick={() => setMoreOpen(false)} aria-hidden="true" />
          <div className={css.sheetPanel}>
            <span className={css.sheetGrip} aria-hidden="true" />
            <header className={css.sheetHd}>
              <span className={css.sheetTitle}>全部功能</span>
              <button type="button" className={css.sheetClose} onClick={() => setMoreOpen(false)} aria-label="关闭">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </header>
            <div className={css.sheetBody}>
              {groups.map((g) => (
                <section key={g.label} className={css.sheetGroup}>
                  <h3 className={css.sheetGroupLabel}>{g.label}</h3>
                  <div className={css.sheetGrid}>
                    {g.items.map((it) => (
                      <button
                        key={it.tab}
                        type="button"
                        className={css.sheetItem}
                        data-active={active === it.tab || undefined}
                        onClick={() => pick(it.tab)}
                      >
                        <NavIcon fragment={it.icon} size={22} />
                        <span className={css.sheetItemLabel}>{it.label}</span>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
              {/* 配置组无条件渲染：Bug 反馈不依赖设置入口，不能因 settings 缺失整组消失。 */}
              <section className={css.sheetGroup}>
                <h3 className={css.sheetGroupLabel}>配置</h3>
                <div className={css.sheetGrid}>
                  {/* 设置入口保持原行为：宿主没接 onOpenSettings（也没有图标数据）时整格不渲染。 */}
                  {onOpenSettings && settingsItem && (
                    <button type="button" className={css.sheetItem} onClick={() => { setMoreOpen(false); onOpenSettings() }}>
                      <NavIcon fragment={settingsItem.icon} size={22} />
                      <span className={css.sheetItemLabel}>设置</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className={css.sheetItem}
                    onClick={() => { setMoreOpen(false); setBugOpen(true) }}
                    aria-label="Bug 反馈：提交问题或功能建议"
                    title="提交 Bug 或功能建议"
                  >
                    <BugIcon />
                    <span className={css.sheetItemLabel}>Bug 反馈</span>
                  </button>
                </div>
              </section>
            </div>
          </div>
        </div>
      )}

      <nav className={css.bar} aria-label="主导航">
        {PRIMARY.map((tab) => {
          const it = ITEM_BY_TAB.get(tab)
          if (!it) return null
          return (
            <button
              key={tab}
              type="button"
              className={css.barItem}
              data-active={active === tab || undefined}
              onClick={() => onSelect(tab)}
              aria-current={active === tab ? 'page' : undefined}
            >
              <span className={css.barIcon}><NavIcon fragment={it.icon} /></span>
              <span className={css.barLabel}>{it.label}</span>
            </button>
          )
        })}
        <button
          ref={moreButtonRef}
          type="button"
          className={css.barItem}
          data-active={(!inPrimary || moreOpen) || undefined}
          onClick={() => setMoreOpen((v) => !v)}
          aria-expanded={moreOpen}
          aria-label="更多功能"
        >
          <span className={css.barIcon}><MoreIcon /></span>
          <span className={css.barLabel}>更多</span>
        </button>
      </nav>

      {/*
        Bug 弹窗挂在 Fragment 根上，而不是 sheet 里：点「Bug 反馈」会先关 sheet，
        弹窗若跟着 sheet 卸载，用户看到的是「点了没反应」。Radix portal 到 body，
        位置与底部栏无关。
      */}
      <BugReportDialog
        open={bugOpen}
        onClose={() => {
          setBugOpen(false)
          // Radix 关闭时会把焦点还给「打开时的 activeElement」，而那个元素（sheet 里的
          // Bug 按钮）已经随 sheet 卸载了。等它自己的焦点恢复跑完，再把焦点交还「更多」。
          window.setTimeout(() => { moreButtonRef.current?.focus() }, 0)
        }}
      />
    </>
  )
}

/** 底部栏的高频位（导出给接线判据用：它必须与 sheet 一起覆盖手机端保留的全部条目）。 */
export const MOBILE_PRIMARY_TABS = PRIMARY

/** 手机端「更多」sheet 保留的条目（导出给判据：白名单里的每一条都必须在 NAV_GROUPS 里存在）。 */
export const MOBILE_KEEP_TABS = PHONE_KEEP

/** 手机端刻意移除的条目 → 理由（导出给判据：移除的每一条都必须写了理由）。 */
export const MOBILE_HIDDEN_TABS = PHONE_HIDDEN

/**
 * 自带断点判定的挂载点：窄视口渲染底部栏，其余情况**什么都不渲染**。
 *
 * 为什么把 `useMediaQuery` 收在这里、而不是让 `WechatDataPanel` 自己判：
 * 那个组件已经在函数行数棘轮上（登记 464 行，只许变小），多一行判定就红。
 * 把判定与渲染一起封进来，宿主只需要一行 JSX —— 而且「手机上有没有底部栏」
 * 这件事只由这一个组件负责，不会出现「JS 判 560、CSS 判 720」这种两口径打架。
 *
 * @param props - 与 {@link MobileNav} 相同。
 */
export function MobileNavHost(props: {
  active: WechatTab
  onSelect: (tab: WechatTab) => void
  onOpenSettings?: () => void
}): React.JSX.Element {
  const isPhone = useMediaQuery(PHONE_QUERY)
  if (!isPhone) return <React.Fragment />
  return <MobileNav {...props} />
}
