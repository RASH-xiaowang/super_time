/**
 * 设置弹窗的导航与当前页面上下文。
 *
 * 这两块只负责布局，不持有配置状态：
 * - 宽屏是左侧目录，窄屏自动变成可横向滑动的顶部标签；
 * - 当前项变化时，导航只滚动自身，不把整个设置弹窗带跑；
 * - 上下文条把「分组 / 当前项 / 状态 / 序号」留在内容区顶端，长页面滚动时仍有方位感。
 */
import { useEffect, useRef } from 'react'
import clsx from 'clsx'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsNavItem } from './settings-common.tsx'
import { css } from './settings-css.ts'

interface NavGroup {
  label: string
  items: SettingsNavItem[]
}

interface SettingsNavRailProps {
  groups: readonly NavGroup[]
  activeKey: string
  onSelect: (key: string) => void
}

/**
 * 将当前导航项滚进可视区。
 *
 * `scrollIntoView()` 可能连带滚动外层弹窗，所以这里只按导航容器和按钮的
 * 边界差调整导航自身。宽屏调纵向，窄屏调横向，同一份逻辑兼容两种形态。
 */
function revealActiveItem(rail: HTMLElement, item: HTMLElement): void {
  const railRect = rail.getBoundingClientRect()
  const itemRect = item.getBoundingClientRect()
  const edge = 8
  let left = 0
  let top = 0
  if (itemRect.left < railRect.left + edge) left = itemRect.left - railRect.left - edge
  else if (itemRect.right > railRect.right - edge) left = itemRect.right - railRect.right + edge
  if (itemRect.top < railRect.top + edge) top = itemRect.top - railRect.top - edge
  else if (itemRect.bottom > railRect.bottom - edge) top = itemRect.bottom - railRect.bottom + edge
  if (left !== 0 || top !== 0) rail.scrollBy({ left, top, behavior: 'smooth' })
}

/** 设置导航：桌面竖排目录，窄屏横向标签。 */
export function SettingsNavRail({ groups, activeKey, onSelect }: SettingsNavRailProps): React.JSX.Element {
  const railRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const rail = railRef.current
    const active = rail?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!rail || !active) return
    revealActiveItem(rail, active)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => { revealActiveItem(rail, active) })
    observer.observe(rail)
    return () => { observer.disconnect() }
  }, [activeKey])

  return (
    <div className={css.navPanel}>
      <nav ref={railRef} className={css.navRail} aria-label="设置导航" tabIndex={0}>
        {groups.map((group) => (
          <div key={group.label} className={css.navGroup} role="group" aria-label={group.label}>
            <div className={css.navGroupLabel}>{group.label}</div>
            {group.items.map((it) => {
              const active = activeKey === it.key
              return (
                <button
                  key={it.key}
                  type="button"
                  className={clsx(css.navItem, active && css.navItemActive)}
                  onClick={() => { onSelect(it.key) }}
                  aria-current={active ? 'page' : undefined}
                  title={`${it.label} · ${it.value}`}
                >
                  <span className={css.navIcon} aria-hidden="true">{it.icon}</span>
                  <span className={css.navLabel}>{it.label}</span>
                  {it.dot ? <StateDot state={it.dot} /> : null}
                </button>
              )
            })}
          </div>
        ))}
      </nav>
      <span className={css.navFade} aria-hidden="true" />
    </div>
  )
}

const STATUS_TEXT: Record<NonNullable<SettingsNavItem['dot']>, string> = {
  done: '已就绪',
  warning: '需关注',
  ongoing: '可配置',
}

interface SettingsWorkspaceHeaderProps {
  groups: readonly NavGroup[]
  activeKey: string
}

/** 当前设置页的上下文条：分组、标题、状态、所在序号。 */
export function SettingsWorkspaceHeader({ groups, activeKey }: SettingsWorkspaceHeaderProps): React.JSX.Element {
  const allItems = groups.flatMap((group) => group.items.map((item) => ({ group, item })))
  const index = allItems.findIndex(({ item }) => item.key === activeKey)
  const resolvedIndex = index < 0 ? 0 : index
  const current = allItems[resolvedIndex]

  if (!current) {
    return <header className={css.viewHeader} aria-label="当前设置页" />
  }

  return (
    <header className={css.viewHeader} aria-label="当前设置页">
      <div className={css.viewIdentity}>
        <span className={css.viewIcon} aria-hidden="true">{current.item.icon}</span>
        <div className={css.viewTitleBlock}>
          <span className={css.viewEyebrow}>{current.group.label}</span>
          <span className={css.viewTitleLine}>
            <h2 className={css.viewTitle}>{current.item.label}</h2>
            {current.item.dot ? (
              <span className={css.viewStatus}>
                <StateDot state={current.item.dot} />
                {STATUS_TEXT[current.item.dot]}
              </span>
            ) : null}
          </span>
        </div>
      </div>
      <div className={css.viewMeta}>
        <span className={css.viewValue} title={current.item.value}>{current.item.value}</span>
        <span className={css.viewIndex} aria-label={`第 ${resolvedIndex + 1} 项，共 ${allItems.length} 项`}>
          {String(resolvedIndex + 1).padStart(2, '0')}
          <span aria-hidden="true"> / </span>
          {String(allItems.length).padStart(2, '0')}
        </span>
      </div>
    </header>
  )
}
