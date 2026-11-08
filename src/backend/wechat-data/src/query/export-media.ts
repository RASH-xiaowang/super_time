/**
 * Chat export media planner/writer.
 *
 * The historical ZIP contained only the rendered transcript and
 * `record_media.json` metadata. This module resolves the actual local media
 * files, assigns stable relative archive paths, and streams them into the ZIP.
 * One unreadable attachment becomes a manifest entry with `missing`/`error`;
 * it never aborts the whole transcript export.
 */
import { createHash } from 'node:crypto'
import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative } from 'node:path'
import type { ChatlogRecord, WechatMessage } from '../types.ts'
import type { StreamControl } from './zip.ts'
import { reportProgress, throwIfCancelled } from './zip.ts'
import { decodeDatBytesAsync, decodeEmoticonDataUrlAsync, decodeImageDataUrlAsync } from './media-image-async.ts'
import { fetchEmoticonRemote, findDatFiles, isThumbTier, msgTableName, RENDERABLE_EXTS, resolveImageFilePathsByMd5 } from './media-image.ts'
import { resolveVideoInfo } from './media-video.ts'
import { resolveVoiceDataUrl } from './voice.ts'
import { resolveMessageFilePath } from './media-file.ts'
import { exportMediaCtx } from './export-io.ts'
import type { ZipFileWriter } from './zip.ts'
import { tryUpgradeToOriginal } from './image-auto-upgrade.ts'

export type ExportMediaKind = 'image' | 'sticker' | 'video' | 'voice' | 'file'
export type ExportMediaStatus = 'ok' | 'missing' | 'error'
export type ExportMediaRole = 'content' | 'cover'
/**
 * How faithful an archived resource is to the source stored by WeChat.
 *
 * `original` means the bytes came from a non-thumbnail source file and were
 * copied without transcoding. `thumbnail` is deliberately separate: callers
 * must never present a `.t.` cache entry as an original image.
 */
export type ExportMediaQuality = 'original' | 'thumbnail' | 'preview' | 'unknown'

/** A resource reference used by formatters and the ZIP manifest. */
export interface ExportMediaEntry {
  id: string
  kind: ExportMediaKind
  role: ExportMediaRole
  status: ExportMediaStatus
  label: string
  messageLocalId: number
  messageLocalIds: number[]
  messageTime: number
  sender: string
  archivePath?: string
  posterArchivePath?: string
  sourcePath?: string
  sourceName?: string
  mime?: string
  size?: number
  quality?: ExportMediaQuality
  /** The only local candidate was WeChat's thumbnail tier; it was not written. */
  thumbnailOnly?: boolean
  error?: string
  recordIndex?: number
}

export type ExportMediaLinks = Map<number, ExportMediaEntry[]>

export interface SessionMediaArchive {
  entries: ExportMediaEntry[]
  links: ExportMediaLinks
  mediaCount: number
  mediaMissingCount: number
}

export interface PrepareSessionMediaOptions {
  decryptedDir: string
  decodedDir: string
  username: string
  msgs: readonly WechatMessage[]
  /** Raw WeChat account root (the parent of `msg/`). */
  wechatBaseDir?: string
  aesKey?: string
  xorKey?: number
  ctrl?: StreamControl
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v',
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', silk: 'audio/silk',
  pdf: 'application/pdf', zip: 'application/zip', rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
}

function mimeOfPath(path: string): string {
  return MIME_BY_EXT[extname(path).replace(/^\./, '').toLowerCase()] ?? 'application/octet-stream'
}

function extOfPath(path: string): string {
  const raw = extname(path).toLowerCase()
  return /^\.[a-z0-9]{1,8}$/.test(raw) ? raw : ''
}

function qualityOfDecodedPath(path: string): ExportMediaQuality {
  return /\.t\.[a-z0-9]+$/i.test(basename(path)) ? 'thumbnail' : 'original'
}

function qualityOfDatPath(path: string): ExportMediaQuality {
  const name = basename(path).toLowerCase()
  if (name.endsWith('_t.dat') || /_[a-z]\.dat$/.test(name)) return 'thumbnail'
  // `_h.dat` is WeChat's high-resolution copy; the unsuffixed `.dat` is the
  // best non-thumbnail source the chat itself retained. Neither is transcoded.
  return 'original'
}

/** Whether a thumbnail cache entry has a better local `.dat` tier worth re-decoding. */
function hasBetterLocalImageSource(
  decryptedDir: string,
  wechatBaseDir: string | undefined,
  username: string,
  md5: string | undefined,
): boolean {
  const key = String(md5 ?? '').trim().toLowerCase()
  if (!wechatBaseDir || !/^[a-f0-9]{32}$/.test(key)) return false
  const attach = join(wechatBaseDir, 'msg', 'attach', msgTableName(username).replace(/^Msg_/, ''))
  if (findDatFiles(attach, key).some((path) => !isThumbTier(path))) return true
  const indexed = resolveImageFilePathsByMd5(decryptedDir, wechatBaseDir, [key]).get(key)
  return indexed !== undefined && !isThumbTier(indexed)
}

function asciiStem(value: string): string {
  const stem = value.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return stem.slice(0, 42)
}

function senderOf(message: WechatMessage): string {
  if (message.isSender === 1) return '我'
  return message.senderName || message.sender || ''
}

function existingFile(path: string): { path: string; size: number; mime: string } | null {
  try {
    const st = statSync(path)
    if (!st.isFile() || st.size <= 0) return null
    return { path, size: st.size, mime: mimeOfPath(path) }
  } catch {
    return null
  }
}

function fileMd5(path: string): string {
  const hash = createHash('md5')
  const fd = openSync(path, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let bytesRead = 0
    do {
      bytesRead = readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

/** A claimed original must match the MD5 recorded by WeChat when one is available. */
function matchesClaimedMd5(path: string, expected: string | undefined): boolean {
  const want = String(expected ?? '').trim().toLowerCase()
  if (!/^[a-f0-9]{32}$/.test(want)) return true
  try {
    return fileMd5(path) === want
  } catch {
    return false
  }
}

function decodedPath(decodedDir: string, file: string | undefined): string {
  if (!file) return ''
  const abs = isAbsolute(file) ? file : join(decodedDir, file)
  const rel = relative(decodedDir, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return ''
  return abs
}

function cachedImage(
  decodedDir: string,
  username: string,
  rawMd5: string | undefined,
  allowThumbnail = false,
): string {
  const md5 = String(rawMd5 ?? '').trim().toLowerCase()
  if (!/^[a-f0-9]{32}$/.test(md5)) return ''
  for (const dir of [decodedDir, username ? join(decodedDir, username) : '']) {
    if (!dir) continue
    for (const ext of RENDERABLE_EXTS) {
      for (const suffix of allowThumbnail ? ['.', '.t.'] : ['.']) {
        const hit = existingFile(join(dir, md5 + suffix + ext))
        if (hit) return hit.path
      }
    }
  }
  return ''
}

async function decodeImageByMd5(
  decryptedDir: string,
  decodedDir: string,
  username: string,
  wechatBaseDir: string | undefined,
  md5: string | undefined,
  aesKey: string | undefined,
  xorKey: number,
): Promise<{ path: string; quality: ExportMediaQuality } | null> {
  const cached = cachedImage(decodedDir, username, md5)
  if (cached) return { path: cached, quality: qualityOfDecodedPath(cached) }
  const key = String(md5 ?? '').trim().toLowerCase()
  if (!wechatBaseDir || !/^[a-f0-9]{32}$/.test(key)) return null
  const dat = resolveImageFilePathsByMd5(decryptedDir, wechatBaseDir, [key]).get(key)
  if (!dat || isThumbTier(dat)) return null
  const decoded = await decodeDatBytesAsync(new Uint8Array(readFileSync(dat)), aesKey ?? null, xorKey)
  if ('error' in decoded || decoded.format === 'hevc') return null
  const dir = join(decodedDir, username || '_export')
  const out = join(dir, key + (decoded.format === 'jpeg' ? '.jpg' : '.' + decoded.format))
  await mkdir(dir, { recursive: true })
  await writeFile(out, Buffer.from(decoded.bytes))
  return { path: out, quality: qualityOfDatPath(dat) }
}

class MediaPlanner {
  readonly entries: ExportMediaEntry[] = []
  readonly links: ExportMediaLinks = new Map()
  private readonly bySource = new Map<string, ExportMediaEntry>()
  private readonly archivePaths = new Set<string>()
  private seq = 0

  constructor(
    private readonly decryptedDir: string,
    private readonly decodedDir: string,
    private readonly username: string,
    private readonly wechatBaseDir: string | undefined,
    private readonly aesKey: string | undefined,
    private readonly xorKey: number,
  ) {}

  private nextId(): string {
    this.seq += 1
    return 'media_' + String(this.seq).padStart(4, '0')
  }

  private archivePath(kind: ExportMediaKind, role: ExportMediaRole, messageId: number, source: string, label: string): string {
    const folder = role === 'cover' ? 'videos/covers'
      : kind === 'image' ? 'images'
        : kind === 'sticker' ? 'stickers'
          : kind === 'video' ? 'videos'
          : kind === 'voice' ? 'voices' : 'files'
    const ext = extOfPath(source) || (kind === 'voice' ? '.wav' : kind === 'video' ? '.mp4' : '')
    const stem = asciiStem(label || basename(source)) || kind
    const base = `media/${folder}/${String(messageId || 0)}_${stem}${ext}`
    let out = base
    let n = 2
    while (this.archivePaths.has(out)) {
      out = base.slice(0, base.length - ext.length) + '_' + String(n) + ext
      n += 1
    }
    this.archivePaths.add(out)
    return out
  }

  private attachLink(message: WechatMessage, entry: ExportMediaEntry, recordIndex?: number): void {
    if (!entry.messageLocalIds.includes(message.localId)) entry.messageLocalIds.push(message.localId)
    if (recordIndex !== undefined && entry.recordIndex === undefined) entry.recordIndex = recordIndex
    const list = this.links.get(message.localId)
    if (list) {
      if (!list.includes(entry)) list.push(entry)
    } else {
      this.links.set(message.localId, [entry])
    }
  }

  addFile(
    kind: ExportMediaKind,
    role: ExportMediaRole,
    message: WechatMessage,
    sourcePath: string,
    label: string,
    recordIndex?: number,
    mimeHint?: string,
    quality?: ExportMediaQuality,
  ): ExportMediaEntry | null {
    // Original-only export: a thumbnail is never a valid archive member. Keep
    // this guard in the central add path as defence in depth for future callers.
    if (quality === 'thumbnail') return null
    const file = existingFile(sourcePath)
    if (!file) return null
    const key = role + '|' + file.path.toLowerCase()
    const prior = this.bySource.get(key)
    if (prior) {
      this.attachLink(message, prior, recordIndex)
      return prior
    }
    const entry: ExportMediaEntry = {
      id: this.nextId(),
      kind,
      role,
      status: 'ok',
      label,
      messageLocalId: message.localId,
      messageLocalIds: [],
      messageTime: message.createTime,
      sender: senderOf(message),
      archivePath: this.archivePath(kind, role, message.localId, file.path, label),
      sourcePath: file.path,
      sourceName: basename(file.path),
      mime: mimeHint || file.mime,
      size: file.size,
      ...(quality !== undefined ? { quality } : {}),
      ...(recordIndex !== undefined ? { recordIndex } : {}),
    }
    this.entries.push(entry)
    this.bySource.set(key, entry)
    this.attachLink(message, entry, recordIndex)
    return entry
  }

  addMissing(
    kind: ExportMediaKind,
    message: WechatMessage,
    label: string,
    error: string,
    recordIndex?: number,
  ): ExportMediaEntry {
    const entry: ExportMediaEntry = {
      id: this.nextId(),
      kind,
      role: 'content',
      status: 'missing',
      label,
      messageLocalId: message.localId,
      messageLocalIds: [message.localId],
      messageTime: message.createTime,
      sender: senderOf(message),
      error,
      ...(recordIndex !== undefined ? { recordIndex } : {}),
    }
    this.entries.push(entry)
    this.attachLink(message, entry, recordIndex)
    return entry
  }

  private addThumbnailOnly(
    kind: ExportMediaKind,
    message: WechatMessage,
    label: string,
    recordIndex?: number,
  ): ExportMediaEntry {
    const entry = this.addMissing(
      kind,
      message,
      label,
      'thumbnail_only: 本机只有缩略图，未写入 ZIP；请先在微信中打开原图后重试',
      recordIndex,
    )
    entry.thumbnailOnly = true
    entry.quality = 'thumbnail'
    return entry
  }

  async image(message: WechatMessage, localId: number, md5: string | undefined, label: string, recordIndex?: number): Promise<void> {
    let direct = localId > 0
      ? await decodeImageDataUrlAsync(
        this.decryptedDir, this.decodedDir, this.username, localId,
        this.wechatBaseDir, this.aesKey, this.xorKey, { fileOnly: true },
      )
      : { error: '缺少图片消息定位信息' }
    // A ZIP is an explicit export request: before accepting a thumbnail, try
    // the larger local `.dat` tier. This never goes to the network.
    if (
      direct.file && direct.thumb === true
      && hasBetterLocalImageSource(this.decryptedDir, this.wechatBaseDir, this.username, md5)
    ) {
      const upgraded = await tryUpgradeToOriginal(
        this.decryptedDir, this.decodedDir, this.username, localId,
        this.wechatBaseDir, this.aesKey, this.xorKey ?? 0xff, false, { fileOnly: true },
      )
      if (upgraded.format !== undefined) {
        direct = await decodeImageDataUrlAsync(
          this.decryptedDir, this.decodedDir, this.username, localId,
          this.wechatBaseDir, this.aesKey, this.xorKey, { fileOnly: true },
        )
      }
    }
    const directPath = decodedPath(this.decodedDir, direct.file)
    if (directPath && direct.thumb !== true && matchesClaimedMd5(directPath, md5)) {
      const added = this.addFile(
        'image', 'content', message, directPath, label, recordIndex, undefined,
        'original',
      )
      if (added) return
    }
    const fallback = await decodeImageByMd5(
      this.decryptedDir, this.decodedDir, this.username, this.wechatBaseDir, md5, this.aesKey, this.xorKey,
    )
    if (fallback && matchesClaimedMd5(fallback.path, md5)) {
      const added = this.addFile('image', 'content', message, fallback.path, label, recordIndex, undefined, fallback.quality)
      if (added) return
    }
    const thumbnailOnly = direct.thumb === true
      || cachedImage(this.decodedDir, this.username, md5, true) !== ''
    if (thumbnailOnly) {
      this.addThumbnailOnly('image', message, label, recordIndex)
      return
    }
    this.addMissing('image', message, label, direct.error || '本地未找到可导出的图片', recordIndex)
  }

  async sticker(message: WechatMessage, md5: string | undefined, emojiUrl: string | undefined, recordIndex?: number): Promise<void> {
    const key = String(md5 ?? '').trim().toLowerCase()
    const local = key
      ? await decodeEmoticonDataUrlAsync(
        this.decryptedDir, this.decodedDir, this.wechatBaseDir, key, this.aesKey, this.xorKey,
      )
      : { error: '缺少表情 MD5' }
    if (local.url) {
      const path = cachedImage(this.decodedDir, this.username, key)
      if (path) {
        const added = this.addFile('sticker', 'content', message, path, '表情', recordIndex, undefined, qualityOfDecodedPath(path))
        if (added) return
      }
    }
    if (emojiUrl && /^[a-f0-9]{32}$/.test(key)) {
      const remote = await fetchEmoticonRemote(emojiUrl, this.decodedDir, key, {
        ...(this.wechatBaseDir ? { wechatBaseDir: this.wechatBaseDir } : {}),
      })
      const path = remote.url ? cachedImage(this.decodedDir, this.username, key) : ''
      if (path) {
        const added = this.addFile('sticker', 'content', message, path, '表情', recordIndex, undefined, qualityOfDecodedPath(path))
        if (added) return
      }
    }
    if (cachedImage(this.decodedDir, this.username, key, true) !== '') {
      this.addThumbnailOnly('sticker', message, '表情', recordIndex)
      return
    }
    this.addMissing('sticker', message, '表情', local.error || '本地未找到可导出的表情', recordIndex)
  }

  video(message: WechatMessage, localId: number, md5: string | undefined, recordIndex?: number): void {
    const info = resolveVideoInfo(
      this.decryptedDir, this.decodedDir, this.username, localId, this.wechatBaseDir, md5,
    )
    const cover = info.coverPath
      ? this.addFile('image', 'cover', message, info.coverPath, '视频封面', recordIndex, undefined, 'preview')
      : null
    const videoMatches = info.videoPath !== undefined && matchesClaimedMd5(info.videoPath, info.md5)
    const video = info.videoPath && videoMatches
      ? this.addFile('video', 'content', message, info.videoPath, '视频', recordIndex, undefined, 'original')
      : null
    if (video && cover?.archivePath) video.posterArchivePath = cover.archivePath
    if (!video) {
      const missing = this.addMissing(
        'video',
        message,
        '视频',
        info.videoPath && !videoMatches
          ? '视频内容 MD5 与消息记录不一致，已拒绝写入'
          : (info.error || '本地未找到视频文件'),
        recordIndex,
      )
      if (cover?.archivePath) missing.posterArchivePath = cover.archivePath
    }
  }

  async voice(message: WechatMessage, localId: number, explicitSvrId: string, recordIndex?: number): Promise<void> {
    const info = await resolveVoiceDataUrl(
      this.decryptedDir, this.decodedDir, this.username,
      localId > 0 ? localId : undefined, explicitSvrId, { fileOnly: true },
    )
    if (info.file && existingFile(info.file)) {
      this.addFile('voice', 'content', message, info.file, '语音', recordIndex, undefined, 'original')
      return
    }
    this.addMissing('voice', message, '语音', info.error || '本地未找到语音文件', recordIndex)
  }

  file(message: WechatMessage, fileName: string, size: number | undefined, fileMd5: string | undefined, recordIndex?: number): void {
    const found = resolveMessageFilePath(this.wechatBaseDir, fileName, {
      ...(Number.isFinite(size) && (size ?? 0) > 0 ? { size } : {}),
      createTime: message.createTime,
      ...(fileMd5 ? { fileMd5 } : {}),
    })
    if (found.path) {
      this.addFile(
        'file', 'content', message, found.path, fileName || found.name || '文件',
        recordIndex, found.mime, 'original',
      )
      return
    }
    this.addMissing('file', message, fileName || '文件', found.error || '本地未找到文件', recordIndex)
  }

  async scanRecord(message: WechatMessage, rec: ChatlogRecord, recordIndex: number): Promise<void> {
    throwIfCancelled(this.ctrl?.signal)
    const label = rec.datatitle || rec.text || rec.name || '聊天记录资源'
    const kind: string = rec.renderType
      || (rec.isImage || rec.datatype === '2' ? 'image'
        : rec.datatype === '4' ? 'video'
          : rec.datatype === '3' ? 'voice'
            : rec.datatype === '47' || rec.datatype === '37' ? 'emoji'
              : rec.datatype === '6' ? 'file' : '')
    if (kind === 'image') {
      await this.image(message, rec.srcMsgLocalid ?? 0, rec.fullmd5 || rec.md5 || rec.thumbfullmd5, label, recordIndex)
    } else if (kind === 'emoji' || kind === 'sticker') {
      await this.sticker(message, rec.md5 || rec.fullmd5, rec.cdnurlstring || rec.url, recordIndex)
    } else if (kind === 'video') {
      this.video(message, rec.srcMsgLocalid ?? 0, rec.fullmd5 || rec.md5 || rec.thumbfullmd5, recordIndex)
    } else if (kind === 'voice') {
      await this.voice(message, rec.srcMsgLocalid ?? 0, rec.fromnewmsgid || '', recordIndex)
    } else if (kind === 'file') {
      this.file(message, label, Number(rec.datasize), rec.md5 || rec.fullmd5, recordIndex)
    }
    if (Array.isArray(rec.nested) && rec.nested.length > 0) {
      for (const nested of rec.nested) await this.scanRecord(message, nested, recordIndex)
    }
  }

  ctrl?: StreamControl
}

function classifyMain(message: WechatMessage): ExportMediaKind | 'chatlog' | '' {
  const richType = message.rich?.type
  const kind = message.renderType || richType
  if (kind === 'image' || message.type === 3) return 'image'
  if (kind === 'sticker' || kind === 'emoji' || message.type === 47) return 'sticker'
  if (kind === 'video' || message.type === 43) return 'video'
  if (kind === 'voice' || message.type === 34) return 'voice'
  if (kind === 'file' || richType === 'file' || message.type === 244 || message.type === 246) return 'file'
  if (kind === 'chatlog' || richType === 'chatlog') return 'chatlog'
  return ''
}

/** Resolve all actual media files referenced by the selected transcript. */
export async function prepareSessionMediaArchive(
  options: PrepareSessionMediaOptions,
): Promise<SessionMediaArchive> {
  const { decryptedDir, decodedDir, username, msgs, ctrl } = options
  const mediaCtx = exportMediaCtx(decryptedDir)
  const wechatBaseDir = options.wechatBaseDir || mediaCtx.base
  const aesKey = options.aesKey ?? mediaCtx.aesKey
  const xorKey = options.xorKey ?? mediaCtx.xorKey
  const planner = new MediaPlanner(decryptedDir, decodedDir, username, wechatBaseDir, aesKey, xorKey)
  planner.ctrl = ctrl
  for (let i = 0; i < msgs.length; i += 1) {
    throwIfCancelled(ctrl?.signal)
    const message = msgs[i]!
    const kind = classifyMain(message)
    if (kind === 'image') {
      await planner.image(message, message.localId, message.rich?.md5, '图片')
    } else if (kind === 'sticker') {
      await planner.sticker(message, message.rich?.md5, message.rich?.emojiUrl)
    } else if (kind === 'video') {
      planner.video(message, message.localId, message.rich?.md5)
    } else if (kind === 'voice') {
      await planner.voice(message, message.localId, '')
    } else if (kind === 'file') {
      const fileTitle = message.rich?.title || (message.displayText ?? '').replace(/^\[文件\]\s*/, '')
      planner.file(message, fileTitle, Number(message.rich?.fileSize), message.rich?.fileMd5)
    } else if (kind === 'chatlog') {
      const records = Array.isArray(message.rich?.records) ? message.rich.records : []
      for (const rec of records) await planner.scanRecord(message, rec, rec.recordIndex ?? 0)
    }
    reportProgress(ctrl, 'media', i + 1, msgs.length)
  }
  const mediaCount = planner.entries.filter((entry) => entry.status === 'ok' && entry.quality === 'original').length
  return {
    entries: planner.entries,
    links: planner.links,
    mediaCount,
    mediaMissingCount: planner.entries.filter((entry) => entry.status !== 'ok').length,
  }
}

/**
 * Stream every resolved resource into the ZIP. A file that disappears between
 * planning and writing is downgraded to an `error` entry; only cancellation is
 * allowed to abort the complete archive.
 */
export async function writeSessionMediaArchive(
  zip: ZipFileWriter,
  archive: SessionMediaArchive,
  ctrl?: StreamControl,
): Promise<void> {
  const total = archive.entries.length
  reportProgress(ctrl, 'media', 0, total)
  for (let i = 0; i < total; i += 1) {
    const entry = archive.entries[i]!
    throwIfCancelled(ctrl?.signal)
    if (entry.status === 'ok' && entry.quality === 'thumbnail') {
      entry.status = 'missing'
      entry.thumbnailOnly = true
      entry.error = 'thumbnail_only: 缩略图不写入导出包'
      delete entry.archivePath
    } else if (entry.status === 'ok' && entry.archivePath && entry.sourcePath) {
      try {
        await zip.addStream(entry.archivePath, createReadStream(entry.sourcePath), ctrl)
      } catch (e) {
        if (ctrl?.signal?.aborted || (e as Error).name === 'AbortError') throw e
        entry.status = 'error'
        entry.error = (e as Error).message
        // There is no such ZIP entry after a failed stream; do not publish a
        // path that readers would try to open.
        delete entry.archivePath
      }
    }
    reportProgress(ctrl, 'media', i + 1, total)
  }
  archive.mediaCount = archive.entries.filter((entry) => entry.status === 'ok' && entry.quality === 'original').length
  archive.mediaMissingCount = archive.entries.filter((entry) => entry.status !== 'ok').length
}

function manifestEntry(entry: ExportMediaEntry): Record<string, unknown> {
  return {
    id: entry.id,
    kind: entry.kind,
    role: entry.role,
    status: entry.status,
    label: entry.label,
    messageLocalId: entry.messageLocalId,
    messageLocalIds: entry.messageLocalIds,
    messageTime: entry.messageTime,
    sender: entry.sender,
    ...(entry.recordIndex !== undefined ? { recordIndex: entry.recordIndex } : {}),
    ...(entry.archivePath ? { archivePath: entry.archivePath } : {}),
    ...(entry.posterArchivePath ? { posterArchivePath: entry.posterArchivePath } : {}),
    ...(entry.sourceName ? { sourceName: entry.sourceName } : {}),
    ...(entry.mime ? { mime: entry.mime } : {}),
    ...(entry.size !== undefined ? { size: entry.size } : {}),
    ...(entry.quality ? { quality: entry.quality } : {}),
    ...(entry.thumbnailOnly ? { thumbnailOnly: true } : {}),
    ...(entry.error ? { error: entry.error } : {}),
  }
}

/** Serialize the resource manifest while retaining the legacy `media` field. */
export function buildSessionMediaManifest(
  username: string,
  exportedAt: string,
  total: number,
  archive: SessionMediaArchive,
  chatlogMedia: Array<Record<string, unknown>>,
): string {
  return JSON.stringify({
    version: 3,
    username,
    exportedAt,
    total,
    archive: {
      mediaRoot: 'media',
      resourceCount: archive.entries.filter((entry) => entry.status === 'ok' && entry.archivePath).length,
      missingCount: archive.mediaMissingCount,
      originalCount: archive.entries.filter((entry) => entry.status === 'ok' && entry.quality === 'original').length,
      thumbnailCount: archive.entries.filter((entry) => entry.status === 'ok' && entry.quality === 'thumbnail').length,
      previewCount: archive.entries.filter((entry) => entry.status === 'ok' && entry.quality === 'preview').length,
      thumbnailOnlyCount: archive.entries.filter((entry) => entry.thumbnailOnly === true).length,
    },
    resources: archive.entries.map(manifestEntry),
    media: chatlogMedia,
  }, null, 2)
}

/** Empty plan used for non-ZIP exports and for handlers compiled before media support. */
export function emptySessionMediaArchive(): SessionMediaArchive {
  return { entries: [], links: new Map(), mediaCount: 0, mediaMissingCount: 0 }
}
