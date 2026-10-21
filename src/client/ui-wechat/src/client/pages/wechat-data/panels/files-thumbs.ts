/**
 * 文件面板取图（2026-10-21，借鉴 Alpha 的批量 token + thumb/full 两档）。
 *
 * 抽成模块的原因：`FilesPanel` 受「单函数 ≤250 行」棘轮管着（已登记且只许变小），
 * 而「攒批 → 分块 → 协议 URL 加工」是纯逻辑，放这里既能单测，也不会让组件继续长。
 *
 * 与 Alpha 的对应关系：
 *  - 一屏的 thumb 引用**一次批量解析**（Alpha 也是整组 token 一次下发，而不是每格一次 RPC）；
 *  - 解析结果 → `wechat-media://decoded/<rel>?w=<格宽档位>`（thumb 档，由主进程缩放并缓存）；
 *  - 灯箱单独要 full 档（不带 `w`），与 Alpha 的 `full` role 同义。
 */
import type { FileItem } from '@deepseek-ai/dsh-wechat-data/types'
import { apiGetFileImageDataUrl, apiGetFileImageDataUrls } from '../api.ts'
import { THUMB_CACHE_LIMIT } from '../utils/thumb-cache.ts'
import { fileKey } from './files-naming.ts'
import { preferMediaUrl, withThumbWidth } from '../wechat-media.ts'

/** 网格缩略图**兜底**宽度（px，实测格宽拿不到时用；正常走 {@link thumbWidthFor}）。 */
export const FILE_THUMB_WIDTH = 320

/** 单批 key 数：后端上限 48，这里取 24 —— 相邻两批之间能给其它面板查询让路。 */
export const FILE_THUMB_BATCH = 24

/**
 * 取一屏缩略图的协议 URL（批量、去重、分块）。
 *
 * 入参可以是任意来源的 key（挂载格/预取窗口）；非法 key 直接丢弃。
 * 失败只影响那一片的图标兜底，不抛给调用方。
 * @param keys - 待取缩略图的 key（`fileKey()` 结果）。
 * @param width - 缩略图宽度（默认 {@link FILE_THUMB_WIDTH}）。
 * @returns key → 协议 URL（`?w=<width>`）；没解出来的 key 不在结果里。
 */
export async function fetchFileThumbUrls(
  keys: readonly string[],
  width = FILE_THUMB_WIDTH,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const uniq = [...new Set(
    (keys ?? [])
      .map((k) => String(k ?? '').trim().toLowerCase())
      .filter((k) => /^[0-9a-f]{32}$/.test(k)),
  )]
  for (let i = 0; i < uniq.length; i += FILE_THUMB_BATCH) {
    const slice = uniq.slice(i, i + FILE_THUMB_BATCH)
    try {
      const res = await apiGetFileImageDataUrls({ keys: slice, thumbFirst: true })
      for (const item of res.items ?? []) {
        const media = preferMediaUrl(item as { file?: string; url?: string })
        const url = (media as { url?: string }).url
        if (url) out[item.key] = withThumbWidth(url, width)
      }
    } catch { /* 该批失败：保留图标兜底，下次挂载会重试 */ }
  }
  return out
}

/**
 * 取灯箱用的**原图档** URL（不带 `w`；后端 `thumbFirst=false` 优先 `_h`/主体）。
 * @param key - 图片 key。
 * @returns 协议 URL；非法 key 或失败返回空串（灯箱回退到网格缩略图）。
 */
export async function fetchFileFullUrl(key: string): Promise<string> {
  const m = String(key ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(m)) return ''
  try {
    const r = await apiGetFileImageDataUrl({ md5: m })
    const media = preferMediaUrl(r as { file?: string; url?: string })
    return (media as { url?: string }).url ?? ''
  } catch {
    return ''
  }
}

/**
 * 缩略图宽度档位（px）。
 *
 * 按「格子实际 CSS 宽 × 设备像素比」向上取档：既保证放大到 2x 屏也不糊，又**不会**因为
 * 每拖一次窗口就多生成一份 `.wNNN.jpg` 缓存（档位只有 5 个，主进程缓存可控）。
 * 与主进程 `?w=` 的 64–1024 允许区间一致。
 */
export const THUMB_WIDTH_STEPS = [160, 240, 320, 480, 640] as const

/**
 * 计算网格缩略图的目标宽度。
 * @param cellWidthCss - 格子实测 CSS 宽度（px）。
 * @param dpr - 设备像素比（渲染进程 `window.devicePixelRatio`）。
 * @returns 档位宽度；非法输入回退 {@link FILE_THUMB_WIDTH}。
 */
export function thumbWidthFor(cellWidthCss: number, dpr = 1): number {
  const css = Number(cellWidthCss)
  if (!Number.isFinite(css) || css <= 0) return FILE_THUMB_WIDTH
  const ratio = Number.isFinite(dpr) && dpr > 0 ? Math.min(3, Math.max(1, dpr)) : 1
  const px = Math.ceil(css * ratio)
  const last = THUMB_WIDTH_STEPS[THUMB_WIDTH_STEPS.length - 1] ?? FILE_THUMB_WIDTH
  return THUMB_WIDTH_STEPS.find((s) => s >= px) ?? last
}

/** 视区外预取行数：上下各 3 行（约再多一屏），滚动时图已在缓存里。 */
export const PREFETCH_ROWS = 3

/**
 * 缩略图 LRU 上界：可视 + 上下预取窗口 × 2 余量。
 *
 * 预取会往同一个 LRU 里写；上界不跟着涨就会把**还在屏上**的图挤掉（值没了但请求标记
 * 还在 ⇒ 那一格永远占位）。按列数放宽到 16 列/张余量，上限 240 防内存失控。
 * @param cols - 当前列数。
 * @returns LRU 上限（>= {@link THUMB_CACHE_LIMIT}）。
 */
export function thumbCacheLimitFor(cols: number): number {
  const c = Math.max(1, Math.ceil(Number(cols) || 1))
  return Math.min(240, Math.max(THUMB_CACHE_LIMIT, c * 16))
}

/** 虚拟器的行窗口形状（只取本函数需要的两个字段）。 */
export interface RowRangeLike {
  startIndex: number
  endIndex: number
}

/**
 * 把虚拟行窗口向上下各扩 `rows` 行，返回需要预取的 key（只取图片；已渲染格的 key
 * 也叫人跟可视队列去重，hook 内用 fetched/queued 集合判断）。
 * @param visible - 当前页已加载的文件。
 * @param cols - 当前列数。
 * @param range - 虚拟器 range（行下标）。
 * @param rows - 上下各扩多少行。
 * @returns 预取 key（行序、行内列序；可能为空）。
 */
export function prefetchKeys(
  visible: readonly FileItem[],
  cols: number,
  range: RowRangeLike | null | undefined,
  rows = PREFETCH_ROWS,
): string[] {
  if (!range) return []
  const c = Math.max(1, Math.ceil(Number(cols) || 1))
  const totalRows = Math.ceil(visible.length / c)
  if (totalRows === 0) return []
  const first = Math.max(0, Math.floor(range.startIndex) - rows)
  const last = Math.min(totalRows - 1, Math.floor(range.endIndex) + rows)
  const out: string[] = []
  for (let row = first; row <= last; row += 1) {
    const start = row * c
    const end = Math.min(visible.length, start + c)
    for (let i = start; i < end; i += 1) {
      const f = visible[i]
      if (!f || f.category !== 'image') continue
      const key = fileKey(f)
      if (key) out.push(key)
    }
  }
  return out
}
