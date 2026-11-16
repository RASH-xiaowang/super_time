/**
 * Original-only media export for WeChat Moments.
 *
 * The archive deliberately never falls back to WeChat's thumbnail tier. Images
 * are resolved through the local original stores or the decrypted CDN `/0`
 * path; videos use the same verified loader as inline playback. Every byte
 * written to the ZIP is sniffed first so a ciphertext payload or a thumbnail
 * can never be published under an image/video extension.
 */
import { createHash } from 'node:crypto'
import type { MomentItem } from '../types.ts'
import type { StreamControl, ZipFileWriter } from './zip.ts'
import { reportProgress, throwIfCancelled } from './zip.ts'
import { MAX_MOMENT_MEDIA, dataUrlToBuffer } from './export-io.ts'
import { fetchSnsCdnImage } from './sns-cdn-image.ts'
import { resolveSnsImageDataUrl } from './sns-image.ts'
import {
  lookupArchivedOriginal,
  lookupOriginal,
  saveArchivedOriginal,
  saveOriginal,
} from './sns-media-store.ts'
import { evaluateSnsOriginal, type SnsOriginalExpectation } from './image-dimensions.ts'
import { loadSnsVideoBytes } from './sns-video.ts'

export type ExportMediaSource = 'local' | 'cdn'
export type ExportMediaByteKind = 'image' | 'video'

export interface ExportMediaType {
  kind: ExportMediaByteKind
  format: 'jpg' | 'png' | 'webp' | 'avif' | 'heic' | 'heif' | 'gif' | 'bmp' | 'mp4' | 'mov' | 'm4v'
  ext: string
  mime: string
}

export interface SnsMediaInput {
  md5?: string
  timelineId?: string
  mediaId?: string
  url?: string
  token?: string
  seed?: string
  /** Public RPC alias used by the Moments UI; same value as `seed`. */
  key?: string
  /** XML `<size>`：原图期望尺寸/字节数。 */
  originalWidth?: number
  originalHeight?: number
  originalBytes?: number
  /** XML `<uhd>` 的独立 CDN 三件套；`/2000` 必须保留。 */
  uhdUrl?: string
  uhdToken?: string
  uhdSeed?: string
}

export interface SnsMediaContext {
  /** Raw WeChat account root (the parent of `msg/`). */
  base?: string
  /** `<data root>/decoded_images`. */
  decodedDir: string
  aesKey?: string
  xorKey: number
  weixinVersion?: string
}

export interface OriginalMediaBytes {
  bytes?: Buffer
  source?: ExportMediaSource
  format?: string
  thumb?: boolean
  error?: string
}

export interface MomentsMediaResolver {
  resolve(kind: ExportMediaByteKind, input: SnsMediaInput): Promise<OriginalMediaBytes>
}

export type MomentMediaResourceKind = 'image' | 'video' | 'live_photo_still' | 'live_photo_video'

export interface MomentMediaResource {
  id: string
  kind: MomentMediaResourceKind
  status: 'ok' | 'missing' | 'error'
  source?: ExportMediaSource
  local: boolean
  timelineId?: string
  mediaId?: string
  md5?: string
  archivePath?: string
  mime?: string
  size?: number
  pairId?: string
  duration?: number
  stillImageTimeMs?: number
  error?: string
}

export interface MomentsMediaManifest {
  version: 1
  total: number
  ok: number
  missing: number
  error: number
  truncated: boolean
  resources: MomentMediaResource[]
}

export interface MomentsMediaExportOptions {
  includeImages?: boolean
  includeVideos?: boolean
  includeLivePhotos?: boolean
}

export interface WriteMomentsMediaArchiveOptions {
  zip: ZipFileWriter
  items: readonly MomentItem[]
  ctx: SnsMediaContext
  options?: MomentsMediaExportOptions
  resolver?: MomentsMediaResolver
  ctrl?: StreamControl
  /** Test seam; production always uses {@link MAX_MOMENT_MEDIA}. */
  maxMedia?: number
}

interface MomentMediaTask {
  kind: MomentMediaResourceKind
  input: SnsMediaInput
  pairId?: string
  duration?: number
  stillImageTimeMs?: number
}

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  gif: 'image/gif',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[at + i] ?? 0)
  return out
}

function typeOf(kind: ExportMediaByteKind, format: ExportMediaType['format']): ExportMediaType {
  return { kind, format, ext: format, mime: MIME[format] ?? 'application/octet-stream' }
}

/**
 * Sniff the bytes as an image or video. The optional kind hint prevents a
 * generic ISO-BMFF container from being accepted in the wrong slot.
 */
export function sniffExportMediaBytes(
  bytes: Uint8Array,
  kindHint?: ExportMediaByteKind,
): ExportMediaType | null {
  if (bytes.length < 12) return null
  const image = sniffImage(bytes)
  if (kindHint === 'image') return image
  if (kindHint === 'video') return sniffVideo(bytes)
  return image ?? sniffVideo(bytes)
}

function sniffImage(bytes: Uint8Array): ExportMediaType | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return typeOf('image', 'jpg')
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return typeOf('image', 'png')
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return typeOf('image', 'webp')
  if (ascii(bytes, 0, 3) === 'GIF') return typeOf('image', 'gif')
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return typeOf('image', 'bmp')
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = ascii(bytes, 8, 4)
    if (brand === 'avif' || brand === 'avis') return typeOf('image', 'avif')
    if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'hevx') {
      return typeOf('image', 'heic')
    }
    if (brand === 'heif' || brand === 'mif1' || brand === 'msf1') return typeOf('image', 'heif')
  }
  return null
}

function sniffVideo(bytes: Uint8Array): ExportMediaType | null {
  if (bytes[4] !== 0x66 || bytes[5] !== 0x74 || bytes[6] !== 0x79 || bytes[7] !== 0x70) return null
  const brand = ascii(bytes, 8, 4)
  if (brand === 'qt  ') return typeOf('video', 'mov')
  if (brand === 'M4V ' || brand === 'M4VH' || brand === 'M4VP') return typeOf('video', 'm4v')
  return typeOf('video', 'mp4')
}

function normalizedSource(value: string | undefined): ExportMediaSource | undefined {
  if (value === 'local') return 'local'
  if (value === 'cdn' || value === 'remote') return 'cdn'
  return undefined
}

function snsOriginalExpectationOf(input: SnsMediaInput): SnsOriginalExpectation {
  const positive = (value: number | undefined): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined
  const width = positive(input.originalWidth)
  const height = positive(input.originalHeight)
  const bytes = positive(input.originalBytes)
  return {
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(bytes !== undefined ? { bytes } : {}),
  }
}

function originalFromDataUrl(
  decodedDir: string,
  md5: string | undefined,
  dataUrl: string,
  source: ExportMediaSource,
  expectation: SnsOriginalExpectation,
): OriginalMediaBytes {
  const bytes = dataUrlToBuffer(dataUrl)
  if (!bytes) return { error: '原图返回的不是 base64 data URL' }
  const media = sniffExportMediaBytes(bytes, 'image')
  if (!media) return { error: '拒绝写入：字节不是可识别的图片（可能是缩略图密文或损坏文件）' }
  const evaluation = evaluateSnsOriginal(bytes, expectation)
  if (!evaluation.accepted) {
    return { error: '拒绝写入：' + String(evaluation.reason ?? '不是原图尺寸') }
  }
  const key = String(md5 ?? '').trim().toLowerCase()
  if (key) {
    const saveOptions = { expectation, requireQuality: true, replaceIfLarger: true }
    saveOriginal(decodedDir, key, bytes, saveOptions)
    saveArchivedOriginal(decodedDir, key, bytes, saveOptions)
  }
  return { bytes, source, format: media.format }
}

/**
 * Resolve a Moments still image using only original tiers:
 * long-term archive → decoded original cache → local non-thumb decode → CDN.
 */
export async function loadSnsImageOriginalBytes(
  ctx: SnsMediaContext,
  input: SnsMediaInput,
): Promise<OriginalMediaBytes> {
  const md5 = String(input.md5 ?? '').trim().toLowerCase()
  const expectation = snsOriginalExpectationOf(input)
  const errors: string[] = []
  if (/^[a-f0-9]{32}$/.test(md5)) {
    // 朋友圈 XML 的 md5 是媒体身份/缓存键，不等于解密并裁掉 CDN 尾块后文件的
    // 字节 MD5（真机数据大量如此）。来源路由已确定是这一条媒体，这里只校验
    // 字节确实是可识别的原图，不能再按字节重算 MD5 把有效原图全部拒绝。
    const archived = lookupArchivedOriginal(ctx.decodedDir, md5)
    if (archived) {
      const media = sniffExportMediaBytes(archived.bytes, 'image')
      const evaluation = evaluateSnsOriginal(archived.bytes, expectation)
      if (media && evaluation.accepted) {
        return { bytes: archived.bytes, source: 'local', format: media.format }
      }
      errors.push('长期归档不是原图：' + String(evaluation.reason ?? '不是有效图片'))
    }
    const stored = lookupOriginal(ctx.decodedDir, md5)
    if (stored) {
      const media = sniffExportMediaBytes(stored.bytes, 'image')
      const evaluation = evaluateSnsOriginal(stored.bytes, expectation)
      if (media && evaluation.accepted) {
        saveArchivedOriginal(ctx.decodedDir, md5, stored.bytes, {
          expectation,
          requireQuality: true,
          replaceIfLarger: true,
        })
        return { bytes: stored.bytes, source: 'local', format: media.format }
      }
      errors.push('本地原图缓存不是原图：' + String(evaluation.reason ?? '不是有效图片'))
    }
  }

  const local = await resolveSnsImageDataUrl(
    ctx.base,
    ctx.aesKey,
    ctx.xorKey,
    md5,
    input.timelineId,
    input.mediaId,
    false,
  )
  if (local.url) {
    const resolved = originalFromDataUrl(ctx.decodedDir, md5, local.url, 'local', expectation)
    if (resolved.bytes) return resolved
    errors.push(resolved.error ?? '本地解码结果不是原图')
  } else if (local.error) {
    errors.push(local.error)
  }

  const uhdUrl = String(input.uhdUrl ?? '').trim()
  const uhdToken = String(input.uhdToken ?? '').trim()
  const uhdSeed = String(input.uhdSeed ?? '').trim()
  if (uhdUrl && uhdToken && uhdSeed) {
    const uhd = await fetchSnsCdnImage(uhdUrl, uhdToken, uhdSeed)
    if (uhd.dataUrl) {
      const resolved = originalFromDataUrl(ctx.decodedDir, md5, uhd.dataUrl, 'cdn', expectation)
      if (resolved.bytes) return resolved
      errors.push('UHD：' + String(resolved.error ?? '返回的图片不是原图'))
    } else if (uhd.error) {
      errors.push('UHD：' + uhd.error)
    }
  }

  const url = String(input.url ?? '').trim()
  const token = String(input.token ?? '').trim()
  const seed = String(input.seed ?? input.key ?? '').trim()
  if (url && seed) {
    const cdn = await fetchSnsCdnImage(url, token, seed)
    if (cdn.dataUrl) {
      const resolved = originalFromDataUrl(ctx.decodedDir, md5, cdn.dataUrl, 'cdn', expectation)
      if (resolved.bytes) return resolved
      errors.push(resolved.error ?? 'CDN 返回的图片不是原图')
    } else if (cdn.error) {
      errors.push('CDN：' + cdn.error)
    }
  } else if (!uhdUrl && !uhdSeed) {
    errors.push('缺少 CDN 原图地址或解密种子，未尝试在线取回')
  }

  return { error: errors.filter(Boolean).join('；') || '未找到可导出的朋友圈原图' }
}

/** Resolve a normal or Live Photo motion video from the verified byte loader. */
export async function loadSnsVideoOriginalBytes(
  ctx: SnsMediaContext,
  input: SnsMediaInput,
): Promise<OriginalMediaBytes> {
  const loaded = await loadSnsVideoBytes({
    base: ctx.base,
    md5: input.md5,
    timelineId: input.timelineId,
    mediaId: input.mediaId,
    url: input.url,
    seed: input.seed ?? input.key,
    version: ctx.weixinVersion,
  })
  if (!loaded.bytes) return { error: loaded.error ?? '取不到视频原始字节' }
  const media = sniffExportMediaBytes(loaded.bytes, 'video')
  if (!media) return { error: '拒绝写入：字节不是 MP4/MOV/M4V 容器' }
  return {
    bytes: loaded.bytes,
    source: normalizedSource(loaded.source),
    format: media.format,
  }
}

export function productionMomentsMediaResolver(ctx: SnsMediaContext): MomentsMediaResolver {
  return {
    resolve(kind, input) {
      return kind === 'image'
        ? loadSnsImageOriginalBytes(ctx, input)
        : loadSnsVideoOriginalBytes(ctx, input)
    },
  }
}

function safeKey(value: string | undefined, fallback: string): string {
  const key = String(value ?? '').trim().toLowerCase()
  if (/^[a-f0-9]{32}$/.test(key)) return key
  return createHash('md5').update(String(value ?? fallback)).digest('hex').slice(0, 12)
}

function* momentMediaTasks(
  items: readonly MomentItem[],
  options: MomentsMediaExportOptions,
): Generator<MomentMediaTask> {
  const includeImages = options.includeImages !== false
  const includeVideos = options.includeVideos !== false
  const includeLivePhotos = options.includeLivePhotos !== false
  for (const moment of items) {
    for (const image of moment.images) {
      const timelineId = image.timelineId || moment.tid
      const live = image.livePhoto
      if (live && includeLivePhotos) {
        const pairId = 'live:' + timelineId + ':' + (image.md5 || image.id || '')
        yield {
          kind: 'live_photo_still',
          pairId,
          stillImageTimeMs: live.stillImageTimeMs,
          input: {
            md5: image.md5,
            timelineId,
            mediaId: image.id,
            url: image.url,
            token: image.token,
            seed: image.key,
            ...(image.originalWidth !== undefined ? { originalWidth: image.originalWidth } : {}),
            ...(image.originalHeight !== undefined ? { originalHeight: image.originalHeight } : {}),
            ...(image.originalBytes !== undefined ? { originalBytes: image.originalBytes } : {}),
            ...(image.uhdUrl !== undefined ? { uhdUrl: image.uhdUrl } : {}),
            ...(image.uhdToken !== undefined ? { uhdToken: image.uhdToken } : {}),
            ...(image.uhdSeed !== undefined ? { uhdSeed: image.uhdSeed } : {}),
          },
        }
        yield {
          kind: 'live_photo_video',
          pairId,
          duration: live.duration,
          stillImageTimeMs: live.stillImageTimeMs,
          input: {
            md5: live.md5,
            timelineId: live.timelineId || timelineId,
            mediaId: live.id,
            url: live.url,
            seed: live.key,
          },
        }
      } else if (includeImages) {
        yield {
          kind: 'image',
          input: {
            md5: image.md5,
            timelineId,
            mediaId: image.id,
            url: image.url,
            token: image.token,
            seed: image.key,
            ...(image.originalWidth !== undefined ? { originalWidth: image.originalWidth } : {}),
            ...(image.originalHeight !== undefined ? { originalHeight: image.originalHeight } : {}),
            ...(image.originalBytes !== undefined ? { originalBytes: image.originalBytes } : {}),
            ...(image.uhdUrl !== undefined ? { uhdUrl: image.uhdUrl } : {}),
            ...(image.uhdToken !== undefined ? { uhdToken: image.uhdToken } : {}),
            ...(image.uhdSeed !== undefined ? { uhdSeed: image.uhdSeed } : {}),
          },
        }
      }
    }
    if (includeVideos) {
      for (const video of moment.videos) {
        yield {
          kind: 'video',
          duration: video.duration,
          input: {
            md5: video.md5,
            timelineId: video.timelineId || moment.tid,
            mediaId: video.id,
            url: video.url,
            token: video.token,
            seed: video.key,
          },
        }
      }
    }
  }
}

function resourceId(task: MomentMediaTask, sequence: number): string {
  const prefix = task.kind === 'image' ? 'img'
    : task.kind === 'video' ? 'vid'
      : task.kind === 'live_photo_still' ? 'still' : 'motion'
  return prefix + '_' + String(sequence).padStart(4, '0')
}

function archivePath(task: MomentMediaTask, id: string, media: ExportMediaType, key: string): string {
  const folder = task.kind === 'image' ? 'media/images'
    : task.kind === 'video' ? 'media/videos'
      : 'media/live'
  return folder + '/' + id + '_' + key + '.' + media.ext
}

function resourceFailure(
  task: MomentMediaTask,
  id: string,
  error: string,
  status: 'missing' | 'error' = 'missing',
): MomentMediaResource {
  return {
    id,
    kind: task.kind,
    status,
    local: false,
    ...(task.input.timelineId ? { timelineId: task.input.timelineId } : {}),
    ...(task.input.mediaId ? { mediaId: task.input.mediaId } : {}),
    ...(task.input.md5 ? { md5: task.input.md5 } : {}),
    ...(task.pairId ? { pairId: task.pairId } : {}),
    ...(task.duration !== undefined ? { duration: task.duration } : {}),
    ...(task.stillImageTimeMs !== undefined ? { stillImageTimeMs: task.stillImageTimeMs } : {}),
    error,
  }
}

/**
 * Stream original media entries into an already-open ZIP and return the
 * manifest. A failed resource is recorded and does not abort the archive.
 */
export async function writeMomentsMediaArchive(
  args: WriteMomentsMediaArchiveOptions,
): Promise<MomentsMediaManifest> {
  const { zip, items, ctx, ctrl } = args
  const resolver = args.resolver ?? productionMomentsMediaResolver(ctx)
  const limit = Math.max(0, Math.floor(args.maxMedia ?? MAX_MOMENT_MEDIA))
  const resources: MomentMediaResource[] = []
  const sequences: Record<MomentMediaResourceKind, number> = {
    image: 0,
    video: 0,
    live_photo_still: 0,
    live_photo_video: 0,
  }
  let truncated = false

  for (const task of momentMediaTasks(items, args.options ?? {})) {
    throwIfCancelled(ctrl?.signal)
    if (resources.length >= limit) {
      truncated = true
      break
    }
    const kind: ExportMediaByteKind = task.kind === 'image' || task.kind === 'live_photo_still'
      ? 'image'
      : 'video'
    const sequence = sequences[task.kind] + 1
    sequences[task.kind] = sequence
    const id = resourceId(task, sequence)
    try {
      const resolved = await resolver.resolve(kind, task.input)
      if (resolved.thumb === true) {
        resources.push(resourceFailure(task, id, '拒绝导出缩略图；请先在微信中打开原图后重试', 'error'))
      } else if (!resolved.bytes) {
        resources.push(resourceFailure(task, id, resolved.error ?? '未找到原始资源'))
      } else {
        const media = sniffExportMediaBytes(resolved.bytes, kind)
        if (!media) {
          resources.push(resourceFailure(
            task,
            id,
            kind === 'image' ? '字节不是可识别的图片格式' : '字节不是 MP4/MOV/M4V 容器',
            'error',
          ))
        } else {
          const path = archivePath(task, id, media, safeKey(task.input.md5, task.pairId ?? id))
          await zip.addFile(path, resolved.bytes)
          resources.push({
            id,
            kind: task.kind,
            status: 'ok',
            ...(resolved.source ? { source: resolved.source } : {}),
            local: resolved.source === 'local',
            ...(task.input.timelineId ? { timelineId: task.input.timelineId } : {}),
            ...(task.input.mediaId ? { mediaId: task.input.mediaId } : {}),
            ...(task.input.md5 ? { md5: task.input.md5 } : {}),
            archivePath: path,
            mime: media.mime,
            size: resolved.bytes.length,
            ...(task.pairId ? { pairId: task.pairId } : {}),
            ...(task.duration !== undefined ? { duration: task.duration } : {}),
            ...(task.stillImageTimeMs !== undefined ? { stillImageTimeMs: task.stillImageTimeMs } : {}),
          })
        }
      }
    } catch (error) {
      if (ctrl?.signal?.aborted || (error as Error).name === 'AbortError') throw error
      resources.push(resourceFailure(task, id, (error as Error)?.message ?? String(error), 'error'))
    }
    reportProgress(ctrl, 'media', resources.length, limit || resources.length)
  }

  return {
    version: 1,
    total: resources.length,
    ok: resources.filter((resource) => resource.status === 'ok').length,
    missing: resources.filter((resource) => resource.status === 'missing').length,
    error: resources.filter((resource) => resource.status === 'error').length,
    truncated,
    resources,
  }
}
