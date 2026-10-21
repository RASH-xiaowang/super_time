/**
 * 文件面板取图（2026-10-21，借鉴 Alpha 的批量 token + thumb/full 两档）。
 *
 * 抽成模块的原因：`FilesPanel` 受「单函数 ≤250 行」棘轮管着（已登记且只许变小），
 * 而「攒批 → 分块 → 协议 URL 加工」是纯逻辑，放这里既能单测，也不会让组件继续长。
 *
 * 与 Alpha 的对应关系：
 *  - 一屏的 thumb 引用**一次批量解析**（Alpha 也是整组 token 一次下发，而不是每格一次 RPC）；
 *  - 解析结果 → `wechat-media://decoded/<rel>?w=320`（thumb 档，由主进程缩放并缓存）；
 *  - 灯箱单独要 full 档（不带 `w`），与 Alpha 的 `full` role 同义。
 */
import { apiGetFileImageDataUrl, apiGetFileImageDataUrls } from '../api.ts'
import { preferMediaUrl, withThumbWidth } from '../wechat-media.ts'

/** 网格缩略图目标宽度（px），与主进程 `?w=` 的 64–1024 允许区间一致。 */
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
