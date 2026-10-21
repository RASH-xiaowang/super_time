/**
 * 图谱节点右键菜单状态。
 *
 * `GraphPanel` 只需要调用 `open`，菜单控制器通过 props 消费同一份 target。
 * 这样“右键坐标 + 当前节点”不会散成两个 state；知识库切换时也能一处清空。
 * 消费方只能把 `open/close/clear` 放进 effect 依赖，不能依赖返回对象本身：
 * `target` 是状态，对象会随每次打开变化，否则菜单刚打开就会被切库清理 effect 关掉。
 */
import { useCallback, useMemo, useState } from 'react'
import type { GNode } from './graph-model.ts'

export type GraphNodeMenuTarget = { node: GNode, x: number, y: number }

export interface GraphNodeMenuState {
  target: GraphNodeMenuTarget | null
  open: (node: GNode, position: { x: number, y: number }) => void
  close: () => void
  clear: () => void
}

/**
 * 管理节点菜单目标。
 * @returns 当前目标与打开/关闭/清空函数。
 */
export function useGraphNodeMenu(): GraphNodeMenuState {
  const [target, setTarget] = useState<GraphNodeMenuTarget | null>(null)
  const open = useCallback((node: GNode, position: { x: number, y: number }): void => {
    setTarget({ node, x: position.x, y: position.y })
  }, [])
  const close = useCallback((): void => { setTarget(null) }, [])
  // 引用必须稳定：GraphPanel 的清库 effect 依赖它，每次渲染新对象会让切库 effect
  // 变成每帧执行，进而把选中/固定状态反复清空。
  return useMemo(() => ({ target, open, close, clear: close }), [target, open, close])
}
