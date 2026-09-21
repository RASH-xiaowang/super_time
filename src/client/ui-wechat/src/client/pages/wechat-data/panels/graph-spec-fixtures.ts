/**
 * `graph-canvas*.spec.ts` 两个 spec 共用的夹具（M21 拆分时抽出）。
 *
 * 原先这两个函数与两个常量长在 `graph-canvas.spec.ts` 里；拆成两个 spec 之后
 * 放在这里各取所需，免得同一份夹具抄两遍。
 * @module graph-spec-fixtures
 */
import { DEFAULT_GRAPH_SETTINGS, type GEdge, type GNode, type GraphSettings } from './graph-model.ts'

export const S: GraphSettings = { ...DEFAULT_GRAPH_SETTINGS }

/** 造一个节点，只给关心的字段赋值。 */
export function node(id: string, extra: Partial<GNode> = {}): GNode {
  return {
    id,
    label: id,
    kind: 'person',
    weight: 100,
    radius: 20,
    community: -1,
    x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null,
    ...extra,
  }
}

/** 造一条边。 */
export function edge(source: string, target: string, kind: GEdge['kind'], weight = 1): GEdge {
  return { source, target, weight, dist: 100, kind }
}

export const VIEW = { w: 800, h: 600 }
