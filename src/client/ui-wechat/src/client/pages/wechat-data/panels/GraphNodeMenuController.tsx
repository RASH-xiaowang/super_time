/**
 * 图谱节点右键菜单控制器。
 *
 * 把动作分发从 `Graph.tsx#GraphPanel` 抽出来，避免面板函数继续撞函数体棘轮。
 * 菜单的打开状态仍由面板持有（画布回调就在那里），本组件只负责把菜单动作
 * 映射到面板已有的选中 / 聚焦 / 固定 / 笔记 / 聊天能力。
 */
import { useCallback } from 'react'
import { GraphNodeContextMenu } from './GraphNodeContextMenu.tsx'
import { noteIdOf, type GraphNodeMenuAction } from './graph-context-menu-model.ts'
import type { GNode } from './graph-model.ts'
import { copyTextToClipboard } from '../utils/misc.ts'

export interface GraphNodeMenuControllerProps {
  /** 当前菜单目标（null = 关闭）。 */
  target: { node: GNode, x: number, y: number } | null
  /** 当前知识模式（知识节点不出现聊天项）。 */
  knowledge: boolean
  /** 当前已固定节点。 */
  pinned: ReadonlySet<string>
  /** 社交聊天入口。 */
  onOpenChat?: ((username: string) => void) | undefined
  /** 关闭菜单。 */
  onClose: () => void
  /** 选中并打开详情抽屉。 */
  onDetails: (node: GNode) => void
  /** 聚焦 1 跳并居中。 */
  onFocus: (id: string) => void
  /** 固定 / 取消固定。 */
  onTogglePin: (id: string) => void
  /** 打开笔记编辑器。 */
  onEditNote: (id: number) => void
  /** 新建笔记（待补目标）。 */
  onCreateNote: () => void
  /** 删除笔记（调用方负责二次确认）。 */
  onDeleteNote: (node: GNode) => void
}

/**
 * 渲染并分发节点菜单动作。
 * @param p - 菜单目标与动作回调。
 * @returns 菜单或 null。
 */
export function GraphNodeMenuController(p: GraphNodeMenuControllerProps): React.JSX.Element | null {
  const run = useCallback((action: GraphNodeMenuAction, node: GNode): void => {
    p.onClose()
    switch (action) {
      case 'details':
        p.onDetails(node)
        break
      case 'focus':
        p.onFocus(node.id)
        break
      case 'pin':
        p.onTogglePin(node.id)
        break
      case 'copy-label':
        void copyTextToClipboard(node.label)
        break
      case 'copy-id':
        void copyTextToClipboard(node.id)
        break
      case 'open-chat':
        p.onOpenChat?.(node.id)
        break
      case 'edit-note': {
        const id = noteIdOf(node)
        if (id !== null) p.onEditNote(id)
        break
      }
      case 'create-note':
        p.onCreateNote()
        break
      case 'delete-note': {
        const id = noteIdOf(node)
        if (id !== null) p.onDeleteNote(node)
        break
      }
    }
  }, [p.onClose, p.onDetails, p.onFocus, p.onTogglePin, p.onOpenChat, p.onEditNote, p.onCreateNote, p.onDeleteNote])

  if (!p.target) return null
  return (
    <GraphNodeContextMenu
      target={p.target}
      pinned={p.pinned.has(p.target.node.id)}
      knowledge={p.knowledge}
      canOpenChat={p.onOpenChat !== undefined}
      onClose={p.onClose}
      onAction={run}
    />
  )
}
