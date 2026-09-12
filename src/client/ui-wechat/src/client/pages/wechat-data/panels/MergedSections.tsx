/**
 * 合并面板外壳：把「同一主题、不同视图」的多个面板收进一个导航项，
 * 用 Segmented 切换。
 *
 * 为什么这样合并而不是重写面板：被合并的面板**保持原样**（各自仍带自己的
 * PanelHeader 与滚动容器），因此不需要改动任何现有面板的内部实现，风险最小。
 * 被吸收的 tab 仍然可路由（nav-config 里标 `hidden`），只是不再出现在侧栏 ——
 * 深链、跨面板跳转、既有脚本都不会失效。
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Segmented } from '../ui/kit.tsx'
import css from './merged.module.css'

export interface MergedSection {
  key: string
  label: string
  render: () => ReactNode
}

/**
 * 渲染一组可切换的合并面板。
 * @param sections - 各分段（key/label/渲染函数）。
 * @param initial - 初始分段（由路由进来的 tab 决定，保证深链落到正确分段）。
 * @param ariaLabel - Segmented 的无障碍标签。
 * @returns 合并后的面板元素。
 */
export function MergedSections({ sections, initial, ariaLabel }: {
  sections: ReadonlyArray<MergedSection>
  initial: string
  ariaLabel: string
}): React.JSX.Element {
  const [active, setActive] = useState(initial)
  // 同一组合并面板被多个 tab 复用（同一个组件实例）：从侧栏/深链切到另一个被合并的
  // tab 时 `initial` 变了，但 useState 只在首次生效 —— 不同步就会出现「点了撤回消息
  // 却还停在会话列表」。这与 ChatsPanel 内部 view 同步的做法一致。
  useEffect(() => { setActive(initial) }, [initial])
  const current = sections.find(s => s.key === active) ?? sections[0]
  return (
    <div className={css.root}>
      <div className={css.bar}>
        <Segmented
          options={sections.map(s => ({ value: s.key, label: s.label }))}
          value={current.key}
          onChange={setActive}
          ariaLabel={ariaLabel}
        />
      </div>
      <div className={css.body}>{current.render()}</div>
    </div>
  )
}
