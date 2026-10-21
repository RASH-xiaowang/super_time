/**
 * 图谱节点右键菜单。
 *
 * 画布是 Canvas，浏览器不知道该点中了哪个节点，因此由画布命中测试后把
 * “节点 id + 视口坐标”交给本组件。菜单挂在 portal 上，避开画布的
 * `overflow: hidden`，并用固定定位保证不会被右侧参数抽屉裁切。
 *
 * 交互约束：
 *   · 右键空白处不打开菜单（保留浏览器默认菜单）；
 *   · 点击外部 / Escape / 滚动 / 窗口尺寸变化关闭；
 *   · 键盘方向键、Home/End 在菜单项间移动，Enter 执行；
 *   · 靠近视口边缘时自动翻转并夹紧位置。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { buildNodeMenuItems, groupNodeMenuItems, placeContextMenu, type GraphNodeMenuAction } from './graph-context-menu-model.ts'
import type { GNode } from './graph-model.ts'
import css from './graph.module.css'

export interface GraphNodeContextMenuProps {
  /** 节点与右键时的视口坐标。 */
  target: { node: GNode, x: number, y: number }
  pinned: boolean
  knowledge: boolean
  canOpenChat: boolean
  onClose: () => void
  /** 菜单关闭时是否把焦点还给画布（Escape / 外部点击 / 动作执行共用）。 */
  restoreFocus?: boolean
  onAction: (action: GraphNodeMenuAction, node: GNode) => void
}

/**
 * 渲染节点右键菜单。
 * @param props - 节点、位置与动作回调。
 * @returns portal 菜单；未挂载时返回 null。
 */
export function GraphNodeContextMenu({
  target, pinned, knowledge, canOpenChat, onClose, restoreFocus = true, onAction,
}: GraphNodeContextMenuProps): React.JSX.Element | null {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const [pos, setPos] = useState<{ x: number, y: number }>({ x: target.x, y: target.y })
  const firstItemRef = useRef<HTMLButtonElement | null>(null)
  const items = buildNodeMenuItems({ node: target.node, pinned, knowledge, canOpenChat })
  const groups = groupNodeMenuItems(items)

  // 先渲染到右键点，再按实际尺寸夹到视口内。用 layout effect 是为了避免首帧闪到屏幕外。
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    // 进入 effect 时焦点还在菜单外，此时记下打开者；随后才把焦点移到第一项。
    if (document.activeElement instanceof HTMLElement) returnFocusRef.current = document.activeElement
    const rect = el.getBoundingClientRect()
    setPos(placeContextMenu(
      { x: target.x, y: target.y },
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    ))
    firstItemRef.current?.focus()
  }, [target.x, target.y, target.node.id])

  // 关闭时把键盘焦点还给打开前的控件。画布是 Canvas、通常不是焦点目标，
  // 但搜索框/工具栏按钮等 DOM 控件触发右键时，焦点不能留在已卸载的菜单里。
  useEffect(() => () => {
    if (restoreFocus) returnFocusRef.current?.focus()
  }, [restoreFocus])

  // 点外部 / Escape / 滚动 / 尺寸变化都收起。滚动可能是画布滚轮缩放，菜单坐标会失效。
  useEffect(() => {
    const onDown = (ev: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(ev.target as Node)) onClose()
    }
    const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') onClose() }
    const onViewport = (): void => { onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onViewport, true)
    window.addEventListener('resize', onViewport)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onViewport, true)
      window.removeEventListener('resize', onViewport)
    }
  }, [onClose])

  /** 上下方向键 / Home / End 在一个菜单内循环焦点。 */
  const onMenuKeyDown = (ev: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!menuRef.current) return
    const buttons = [...menuRef.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    if (buttons.length === 0) return
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    let next = current
    if (ev.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % buttons.length
    else if (ev.key === 'ArrowUp') next = current <= 0 ? buttons.length - 1 : current - 1
    else if (ev.key === 'Home') next = 0
    else if (ev.key === 'End') next = buttons.length - 1
    else return
    ev.preventDefault()
    buttons[next]?.focus()
  }

  const run = (action: GraphNodeMenuAction): void => {
    onClose()
    onAction(action, target.node)
  }

  return createPortal(
    <div
      ref={menuRef}
      className={css.nodeContextMenu}
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      aria-label={`${target.node.label} 的节点操作`}
      onKeyDown={onMenuKeyDown}
      onContextMenu={(ev) => { ev.preventDefault() }}
    >
      <div className={css.nodeContextHead}>
        <span className={css.nodeContextTitle} title={target.node.label}>{target.node.label}</span>
        <span className={css.nodeContextKind}>{kindLabel(target.node)}</span>
      </div>
      {groups.map((group, gi) => (
        <div key={group.group} className={css.nodeContextGroup} data-first={gi === 0 || undefined}>
          {group.items.map((item, ii) => (
            <button
              key={item.id}
              ref={gi === 0 && ii === 0 ? firstItemRef : undefined}
              type="button"
              role="menuitem"
              className={css.nodeContextItem}
              data-danger={item.danger || undefined}
              disabled={item.disabled || undefined}
              onClick={() => { run(item.id) }}
            >
              <span>{item.label}</span>
              {item.hint && <span className={css.nodeContextHint}>{item.hint}</span>}
            </button>
          ))}
        </div>
      ))}
    </div>,
    document.body,
  )
}

/** 菜单头右侧的类型标签。 */
function kindLabel(node: GNode): string {
  if (node.kind === 'note') return '笔记'
  if (node.kind === 'stub') return '待补笔记'
  if (node.kind === 'file') return '文件'
  if (node.kind === 'section') return '章节'
  if (node.kind === 'entity') return '模型实体'
  if (node.kind === 'group') return '群聊'
  if (node.kind === 'self') return '我'
  return node.isOfficial ? '公众号' : node.isFriend ? '好友' : '群友'
}
