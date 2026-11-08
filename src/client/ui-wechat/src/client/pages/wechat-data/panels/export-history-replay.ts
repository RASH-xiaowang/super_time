/** 把导出历史里记录的朋友圈参数还原成一次新的 `apiExportMoments` 调用。 */

export interface MomentsReplaySource {
  format: string
  params: string
}

export interface MomentsReplayOptions {
  format?: string
  username?: string
  authorName?: string
  q?: string
  images?: boolean
  media?: string
  month?: string
  mine?: string
  zip?: boolean
  includeImages?: boolean
  includeVideos?: boolean
  includeLivePhotos?: boolean
  from?: number
  to?: number
  dir: string
  filename: string
  jobId?: string
}

function asRecord(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function copyString(out: Record<string, unknown>, source: Record<string, unknown>, key: string): void {
  if (typeof source[key] === 'string') out[key] = source[key]
}

function copyBoolean(out: Record<string, unknown>, source: Record<string, unknown>, key: string): void {
  if (typeof source[key] === 'boolean') out[key] = source[key]
}

function copyFiniteNumber(out: Record<string, unknown>, source: Record<string, unknown>, key: string): void {
  const value = source[key]
  if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
}

/** 把保存对话框返回的完整文件路径拆成导出接口需要的目录与文件名。 */
export function splitReplayPath(path: string): { dir: string; filename: string } {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (slash < 0) return { dir: '', filename: path }
  return { dir: path.slice(0, slash + 1), filename: path.slice(slash + 1) }
}

/**
 * 保留朋友圈导出的可重放字段（含 ZIP 媒体开关），只替换目标路径。
 * `format=zip` 的旧记录即使参数里漏了 `zip`，也强制按 ZIP 重放。
 * @param entry - 历史记录的文件格式与 params JSON。
 * @param savePath - 用户这次选择的新路径。
 * @param jobId - 本次重放任务的进度标识。
 * @returns 可直接交给 `apiExportMoments` 的参数。
 */
export function buildMomentsReplayOptions(entry: MomentsReplaySource, savePath: string, jobId?: string): MomentsReplayOptions {
  const params = asRecord(entry.params)
  const out: Record<string, unknown> = {}
  for (const key of ['username', 'authorName', 'q', 'media', 'month', 'mine']) copyString(out, params, key)
  for (const key of ['images', 'zip', 'includeImages', 'includeVideos', 'includeLivePhotos']) copyBoolean(out, params, key)
  for (const key of ['from', 'to']) copyFiniteNumber(out, params, key)

  const recordedFormat = entry.format.trim()
  const paramFormat = typeof params.format === 'string' ? params.format.trim() : ''
  if (paramFormat) out.format = paramFormat
  else if (recordedFormat && recordedFormat !== 'zip') out.format = recordedFormat

  if (recordedFormat === 'zip') out.zip = true
  Object.assign(out, splitReplayPath(savePath))
  if (jobId) out.jobId = jobId
  return out as unknown as MomentsReplayOptions
}
