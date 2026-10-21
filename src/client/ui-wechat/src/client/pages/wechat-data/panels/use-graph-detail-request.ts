/**
 * 图谱详情抽屉的“请求切到详情页”序号。
 *
 * 目标节点已经选中、右侧栏却停在参数页时，单靠 `selected.id` 不会触发
 * `GraphRail` 的 effect；用递增序号表达“用户明确要求看详情”。
 */
import { useCallback, useState } from 'react'

export interface GraphDetailRequest {
  request: number
  show: () => void
}

/**
 * 创建详情页切换请求。
 * @returns 当前序号与递增函数。
 */
export function useGraphDetailRequest(): GraphDetailRequest {
  const [request, setRequest] = useState(0)
  const show = useCallback((): void => { setRequest(v => v + 1) }, [])
  return { request, show }
}
