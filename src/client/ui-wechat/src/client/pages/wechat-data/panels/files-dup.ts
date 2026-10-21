/**
 * 文件面板的「重名归并视图」（2026-10-21 从 `FilesPanel` 抽出）。
 *
 * 为什么抽：`FilesPanel` 受单函数 ≤250 行棘轮管着（登记 359），继续往组件里塞
 * `useMemo` 会把它顶红。这两个纯函数只依赖已加载的文件数组，放模块里可单测。
 */
import type { FileItem } from '@deepseek-ai/dsh-wechat-data/types'
import { fileDisplayName, fileKey } from './files-naming.ts'

/** 一组同内容文件（按 `fileKey` 归并）。 */
export interface DupGroup {
  key: string
  items: FileItem[]
  total: number
}

/**
 * md5 → 可读名（取已加载文件里的第一个；没加载到的由调用方回退 md5 前缀）。
 * @param visible - 已加载的文件。
 * @returns Map<md5, 显示名>。
 */
export function namesByMd5(visible: readonly FileItem[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const f of visible) if (f.md5 && !m.has(f.md5)) m.set(f.md5, fileDisplayName(f))
  return m
}

/**
 * 把已加载文件按 key 归并出重复组（>1 份），按「条数 × 总字节」降序。
 * @param visible - 已加载的文件。
 * @returns 重复组列表。
 */
export function duplicateGroups(visible: readonly FileItem[]): DupGroup[] {
  const byKey = new Map<string, FileItem[]>()
  for (const f of visible) {
    const k = fileKey(f)
    const arr = byKey.get(k) ?? []
    arr.push(f)
    byKey.set(k, arr)
  }
  return [...byKey.values()]
    .filter(g => g.length > 1)
    .map(g => ({ key: g[0]?.md5 ?? '', items: g, total: g.reduce((a, f) => a + (f.fileSize || 0), 0) }))
    .sort((a, b) => b.items.length * b.total - a.items.length * a.total)
}
