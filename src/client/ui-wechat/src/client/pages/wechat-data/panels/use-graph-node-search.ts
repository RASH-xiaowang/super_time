/**
 * 图谱节点搜索状态（只覆盖当前这张图）。
 *
 * 从 `GraphPanel` 抽出，避免“搜索词 / 命中 / 定位”三个小逻辑继续占面板行数。
 * 搜索命中上限 8 条；定位只负责选中与居中，不参与图结构重建。
 */
import { useMemo } from 'react'
import type { BuiltGraph, GNode } from './graph-model.ts'

export interface GraphNodeSearch {
  search: string
  setSearch: (value: string) => void
  terms: string
  hits: GNode[]
  /** 清空搜索词；引用稳定，可安全用于切库 effect 依赖。 */
  clear: () => void
}

/**
 * 管理节点搜索词与命中列表。返回对象会随输入变化；
 * 搜索词由调用方持有，因此 `clear` 可在切库 effect 中安全依赖。
 * @param graph - 当前完整图（不是深度过滤后的 displayGraph）。
 * @param search - 当前搜索词。
 * @param setSearch - 写入搜索词。
 * @param clear - 清空搜索词（引用须稳定）。
 * @returns 搜索词、命中与最多 8 条候选。
 */
export function useGraphNodeSearch(
  graph: BuiltGraph,
  search: string,
  setSearch: (value: string) => void,
  clear: () => void,
): GraphNodeSearch {
  const terms = search.trim().toLowerCase()
  const hits = useMemo(() => {
    if (!terms) return []
    return graph.nodes
      .filter(n => n.label.toLowerCase().includes(terms) || n.id.toLowerCase().includes(terms))
      .slice(0, 8)
  }, [graph, terms])
  return { search, setSearch, terms, hits, clear }
}
