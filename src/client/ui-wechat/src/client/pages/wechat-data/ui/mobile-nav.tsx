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
import React, { useCallback, useEffect, useState } from 'react'
import { NAV_GROUPS, type NavItem, type WechatTab } from '../nav-config.ts'
import { PHONE_QUERY, useMediaQuery } from './use-media-query.ts'
import css from './mobile-nav.module.css'

/** 底部栏的 4 个高频位（第 5 格固定是「更多」）。 */
const PRIMARY: readonly WechatTab[] = ['chats', 'overview', 'ask', 'contacts']

/** 把 NAV_GROUPS 压平成 tab → 条目 的查找表（图标与标签都从这里取，不另写一份）。 */
const ITEM_BY_TAB: ReadonlyMap<WechatTab, NavItem> = new Map(
  NAV_GROUPS.flatMap((g) => [...g.items]).map((it) => [it.tab, it] as const),
)

/** 「更多」sheet 里要列的分组与条目（沿用桌面侧栏的过滤口径：跳过 hidden 与 settings）。 */
function sheetGroups(): ReadonlyArray<{ label: string, items: ReadonlyArray<NavItem> }> {
  const out: Array<{ label: string, items: ReadonlyArray<NavItem> }> = []
  for (const g of NAV_GROUPS) {
    const items = g.items.filter((it) => !it.hidden && it.tab !== 'settings')
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

/** 设置那一格的图标（桌面端它在侧栏页脚，不在 NAV_GROUPS 里）。 */
function SettingsIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.7 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.7a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.1 4.7a1.7 1.7 0 0 1 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.3 9v.09A1.7 1.7 0 0 0 20.9 10H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" />
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
  const groups = sheetGroups()

  // 从「更多」里选完就关掉 sheet； Esc 也能关（手机上更常见的是点遮罩，两个都给）。
  const pick = useCallback((tab: WechatTab) => {
    setMoreOpen(false)
    onSelect(tab)
  }, [onSelect])

  useEffect(() => {
    if (!moreOpen) return undefined
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setMoreOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [moreOpen])

  // 当前 tab 不在 4 个高频位里时，「更多」那一格高亮 —— 否则用户看不出自己在哪。
  const inPrimary = PRIMARY.includes(active)

  return (
    <>
      {moreOpen && (
        <div className={css.sheet} role="dialog" aria-modal="true" aria-label="全部功能">
          <div className={css.sheetScrim} onClick={() => setMoreOpen(false)} aria-hidden="true" />
          <div className={css.sheetPanel}>
            <header className={css.sheetHd}>
              <span className={css.sheetTitle}>全部功能</span>
              <button type="button" className={css.sheetClose} onClick={() => setMoreOpen(false)} aria-label="关闭">
                ✕
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
                        <NavIcon fragment={it.icon} size={20} />
                        <span className={css.sheetItemLabel}>{it.label}</span>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
              {onOpenSettings && (
                <section className={css.sheetGroup}>
                  <h3 className={css.sheetGroupLabel}>配置</h3>
                  <div className={css.sheetGrid}>
                    <button type="button" className={css.sheetItem} onClick={() => { setMoreOpen(false); onOpenSettings() }}>
                      <SettingsIcon />
                      <span className={css.sheetItemLabel}>设置</span>
                    </button>
                  </div>
                </section>
              )}
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
              <NavIcon fragment={it.icon} />
              <span className={css.barLabel}>{it.label}</span>
            </button>
          )
        })}
        <button
          type="button"
          className={css.barItem}
          data-active={(!inPrimary || moreOpen) || undefined}
          onClick={() => setMoreOpen((v) => !v)}
          aria-expanded={moreOpen}
          aria-label="更多功能"
        >
          <MoreIcon />
          <span className={css.barLabel}>更多</span>
        </button>
      </nav>
    </>
  )
}

/** 底部栏的高频位（导出给接线判据用：它必须与 sheet 一起覆盖桌面侧栏的全部条目）。 */
export const MOBILE_PRIMARY_TABS = PRIMARY

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
