/**
 * Original-file exports for individual media items.
 *
 * ZIP export already has stronger media planning, but the chat/file panels
 * also need a one-click save path. These handlers copy exact local bytes and
 * reject thumbnails, damaged media and hash mismatches before writing.
 */
import { createHash } from 'node:crypto'
import { closeSync, createReadStream, openSync, readSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { ensureFileImageOriginalDecoded } from '../query/file-image-on-demand.ts'
import { resolveImageKeyPair } from '../query/image-key.ts'
import { sniffExportMediaBytes } from '../query/export-sns-media.ts'
import { copyFileVerifiedAtomic } from '../query/export-io.ts'
import { reportProgress, throwIfCancelled, type StreamControl } from '../query/zip.ts'
import { resolveMessageFilePath } from '../query/media-file.ts'
import { resolveVideoInfo } from '../query/media-video.ts'
import { canonicalChatReference } from '../query/message-identity.ts'
import { queryMessageByLocalId } from '../query/messages.ts'
import type { MediaOriginalExportResult } from '../types.ts'
import type { MediaRemoteCtx } from './media.ts'

const MEDIA_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff',
  'avif', 'heic', 'heif', 'mp4', 'mov', 'm4v',
])
const PLACEHOLDER_EXTENSIONS = new Set(['bin', 'dat', 'tmp', 'unknown'])

/** Correct a media destination extension to the sniffed real container format. */
export function originalExportDestination(dest: string, format: string): string {
  const normalized = format === 'jpeg' ? 'jpg' : format.toLowerCase()
  const current = extname(dest)
  const currentFormat = current.slice(1).toLowerCase()
  if (currentFormat === normalized || (currentFormat === 'jpeg' && normalized === 'jpg')
    || (currentFormat === 'jpg' && normalized === 'jpeg')) {
    return dest
  }
  if (current !== '' && (MEDIA_EXTENSIONS.has(currentFormat) || PLACEHOLDER_EXTENSIONS.has(currentFormat))) {
    return dest.slice(0, -current.length) + '.' + normalized
  }
  return dest + '.' + normalized
}

function readHead(path: string, length = 64): Buffer {
  const fd = openSync(path, 'r')
  try {
    const out = Buffer.alloc(length)
    const read = readSync(fd, out, 0, length, 0)
    return out.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

async function fileMd5(path: string, ctrl?: StreamControl): Promise<string> {
  const hash = createHash('md5')
  const total = statSync(path).size
  let done = 0
  reportProgress(ctrl, 'verify', 0, total)
  for await (const chunk of createReadStream(path)) {
    throwIfCancelled(ctrl?.signal)
    const buf = chunk as Buffer
    hash.update(buf)
    done += buf.length
    reportProgress(ctrl, 'verify', done, total)
  }
  return hash.digest('hex')
}

async function copyVerified(
  sourcePath: string,
  requestedDest: string,
  kind: 'image' | 'video',
  expectedMd5: string,
  ctrl?: StreamControl,
): Promise<MediaOriginalExportResult> {
  let copiedBytes = 0
  let copiedFormat = ''
  try {
    const dest = await copyFileVerifiedAtomic(sourcePath, requestedDest, async (temporaryPath) => {
      const copied = statSync(temporaryPath)
      if (!copied.isFile()) throw new Error('来源不是本机文件')
      const media = sniffExportMediaBytes(readHead(temporaryPath), kind)
      if (!media) throw new Error('来源内容不是可识别的原媒体，已拒绝导出')
      if (await fileMd5(temporaryPath, ctrl) !== expectedMd5) {
        throw new Error('原文件内容 MD5 校验失败，已拒绝导出')
      }
      copiedBytes = copied.size
      copiedFormat = media.format
      return originalExportDestination(requestedDest, media.format)
    }, ctrl)
    return { ok: true, path: dest, bytes: copiedBytes, format: copiedFormat, source: 'local' }
  } catch (e) {
    const message = (e as Error).message
    return {
      ok: false,
      error: message.includes('拒绝导出') || message.includes('不是本机文件')
        ? message
        : `写入失败：${message}`,
    }
  }
}

export interface OriginalMediaExportRemote {
  exportChatVideo: (options: { username: string; localId: number; dest: string; jobId?: string }, ctrl?: StreamControl) => Promise<MediaOriginalExportResult>
  exportChatFile: (options: { username: string; localId: number; dest: string; jobId?: string }, ctrl?: StreamControl) => Promise<MediaOriginalExportResult>
  exportFileImage: (options: { md5: string; dest: string; jobId?: string }, ctrl?: StreamControl) => Promise<MediaOriginalExportResult>
  exportFileVideo: (options: { md5: string; dest: string; jobId?: string }, ctrl?: StreamControl) => Promise<MediaOriginalExportResult>
  exportFileAttachment: (options: {
    fileName: string
    size?: number
    createTime?: number
    md5?: string
    dest: string
    jobId?: string
  }, ctrl?: StreamControl) => Promise<MediaOriginalExportResult>
}

/** Build single-item original export handlers for chat and file-library media. */
export function createOriginalMediaExportRemotes(rc: MediaRemoteCtx): OriginalMediaExportRemote {
  return {
    async exportChatVideo(options, ctrl): Promise<MediaOriginalExportResult> {
      const dest = String(options.dest ?? '').trim()
      if (!dest) return { ok: false, error: '未指定保存路径' }
      throwIfCancelled(ctrl?.signal)
      reportProgress(ctrl, 'locate', 0, 1)
      const chat = canonicalChatReference(rc.dirs().decrypted, String(options.username ?? ''), '视频会话')
      if (chat.error !== undefined) return { ok: false, error: chat.error }
      const localId = Math.trunc(Number(options.localId))
      if (chat.username === '' || !Number.isFinite(localId)) return { ok: false, error: '缺少会话或消息 id' }
      const info = resolveVideoInfo(
        rc.dirs().decrypted,
        rc.dirs().decoded,
        chat.username,
        localId,
        rc.rawWechatBase(rc.dirs().decrypted) || undefined,
      )
      if (!info.videoPath || !info.md5) {
        rc.op('task', 'export_chat_video', 'fail', chat.username, info.error ?? '')
        return { ok: false, error: info.error ?? '本机没有该视频原文件，请先在微信中打开或下载' }
      }
      reportProgress(ctrl, 'locate', 1, 1)
      const result = await copyVerified(info.videoPath, dest, 'video', info.md5, ctrl)
      rc.op('task', 'export_chat_video', result.ok ? 'ok' : 'fail', chat.username,
        result.ok ? `${result.bytes} 字节 · ${result.format}` : result.error ?? '')
      return result
    },

    async exportChatFile(options, ctrl): Promise<MediaOriginalExportResult> {
      const dest = String(options.dest ?? '').trim()
      const localId = Number(options.localId)
      if (!dest) return { ok: false, error: '未指定保存路径' }
      throwIfCancelled(ctrl?.signal)
      reportProgress(ctrl, 'locate', 0, 1)
      if (!Number.isSafeInteger(localId) || localId <= 0) {
        return { ok: false, error: '消息 id 无效，无法确认文件归属' }
      }
      const chat = canonicalChatReference(rc.dirs().decrypted, String(options.username ?? ''), '文件会话')
      if (chat.error !== undefined || chat.username === '') {
        const error = chat.error ?? '缺少会话，无法确认文件归属'
        rc.op('task', 'export_chat_file', 'fail', chat.username, error)
        return { ok: false, error }
      }
      const lookup = queryMessageByLocalId(rc.dirs().decrypted, chat.username, localId)
      const message = lookup.message
      if (!lookup.found || message === undefined) {
        const error = lookup.error ?? '消息库中找不到这条消息，无法确认文件归属'
        rc.op('task', 'export_chat_file', 'fail', chat.username, error)
        return { ok: false, error }
      }
      const rich = message.rich
      if (rich?.type !== 'file') {
        const error = '这条消息不是文件消息，已拒绝按文件名猜测原文件'
        rc.op('task', 'export_chat_file', 'fail', chat.username, error)
        return { ok: false, error }
      }
      const fileName = String(rich.title ?? '').trim()
      if (fileName === '') {
        const error = '文件消息缺少文件名，无法确认原文件'
        rc.op('task', 'export_chat_file', 'fail', chat.username, error)
        return { ok: false, error }
      }
      const rawSize = String(rich.fileSize ?? '').trim()
      const expectedSize = rawSize === '' ? 0 : Number(rawSize)
      if (rawSize !== '' && (!Number.isSafeInteger(expectedSize) || expectedSize <= 0)) {
        const error = '文件消息里的文件大小无效，已停止猜测原文件'
        rc.op('task', 'export_chat_file', 'fail', chat.username, error)
        return { ok: false, error }
      }
      const expectedMd5 = String(rich.fileMd5 ?? '').trim().toLowerCase()
      const found = resolveMessageFilePath(
        rc.rawWechatBase(rc.dirs().decrypted) || undefined,
        fileName,
        {
          ...(expectedSize > 0 ? { size: expectedSize } : {}),
          ...(message.createTime > 0 ? { createTime: message.createTime } : {}),
          ...(expectedMd5 !== '' ? { fileMd5: expectedMd5 } : {}),
          requireUnique: true,
        },
      )
      if (!found.path) {
        const error = found.error ?? '本机没有该文件原文件'
        rc.op('task', 'export_chat_file', 'fail', chat.username, error)
        return { ok: false, error }
      }
      reportProgress(ctrl, 'locate', 1, 1)
      try {
        let copiedBytes = 0
        await copyFileVerifiedAtomic(found.path, dest, async (temporaryPath) => {
          const copied = statSync(temporaryPath)
          if (!copied.isFile()) throw new Error('来源不是本机文件')
          if (expectedSize > 0 && copied.size !== expectedSize) {
            throw new Error('文件大小与消息记录不一致，已拒绝导出')
          }
          if (expectedMd5 !== '' && await fileMd5(temporaryPath, ctrl) !== expectedMd5) {
            throw new Error('附件内容 MD5 校验失败，已拒绝导出')
          }
          copiedBytes = copied.size
          return dest
        }, ctrl)
        const format = extname(dest).slice(1).toLowerCase() || 'bin'
        rc.op('task', 'export_chat_file', 'ok', chat.username, `${fileName} · ${copiedBytes} 字节`)
        return { ok: true, path: dest, bytes: copiedBytes, format, source: 'local' }
      } catch (e) {
        const messageText = (e as Error).message
        rc.op('task', 'export_chat_file', 'fail', chat.username, messageText)
        return {
          ok: false,
          error: messageText.includes('拒绝导出') || messageText.includes('不是本机文件')
            ? messageText
            : `写入失败：${messageText}`,
        }
      }
    },

    async exportFileImage(options, ctrl): Promise<MediaOriginalExportResult> {
      const dest = String(options.dest ?? '').trim()
      const key = String(options.md5 ?? '').trim().toLowerCase()
      if (!dest) return { ok: false, error: '未指定保存路径' }
      throwIfCancelled(ctrl?.signal)
      reportProgress(ctrl, 'locate', 0, 1)
      const decrypted = rc.dirs().decrypted
      const decoded = rc.dirs().decoded
      const { aesKey, xorKey } = resolveImageKeyPair(decrypted)
      const original = await ensureFileImageOriginalDecoded({
        decryptedDir: decrypted,
        decodedDir: decoded,
        rawBase: rc.rawWechatBase(decrypted) || '',
        key,
        ...(aesKey ? { aesKey } : {}),
        xorKey,
      })
      if (!original.file) {
        rc.op('task', 'export_file_image', 'fail', key, original.error ?? '')
        return { ok: false, error: original.error ?? '本机没有该图片原图' }
      }
      reportProgress(ctrl, 'locate', 1, 1)
      const result = await copyVerified(join(decoded, original.file), dest, 'image', key, ctrl)
      rc.op('task', 'export_file_image', result.ok ? 'ok' : 'fail', key,
        result.ok ? `${result.bytes} 字节 · ${result.format}` : result.error ?? '')
      return result
    },

    async exportFileVideo(options, ctrl): Promise<MediaOriginalExportResult> {
      const dest = String(options.dest ?? '').trim()
      const md5 = String(options.md5 ?? '').trim().toLowerCase()
      if (!dest) return { ok: false, error: '未指定保存路径' }
      throwIfCancelled(ctrl?.signal)
      reportProgress(ctrl, 'locate', 0, 1)
      const info = resolveVideoInfo(
        rc.dirs().decrypted,
        rc.dirs().decoded,
        '',
        0,
        rc.rawWechatBase(rc.dirs().decrypted) || undefined,
        md5,
      )
      if (!info.videoPath || !info.md5) {
        rc.op('task', 'export_file_video', 'fail', md5, info.error ?? '')
        return { ok: false, error: info.error ?? '本机没有该视频原文件' }
      }
      reportProgress(ctrl, 'locate', 1, 1)
      const result = await copyVerified(info.videoPath, dest, 'video', info.md5, ctrl)
      rc.op('task', 'export_file_video', result.ok ? 'ok' : 'fail', md5,
        result.ok ? `${result.bytes} 字节 · ${result.format}` : result.error ?? '')
      return result
    },

    async exportFileAttachment(options, ctrl): Promise<MediaOriginalExportResult> {
      const dest = String(options.dest ?? '').trim()
      if (!dest) return { ok: false, error: '未指定保存路径' }
      throwIfCancelled(ctrl?.signal)
      reportProgress(ctrl, 'locate', 0, 1)
      const expectedMd5 = String(options.md5 ?? '').trim().toLowerCase()
      const found = resolveMessageFilePath(
        rc.rawWechatBase(rc.dirs().decrypted) || undefined,
        options.fileName,
        {
          ...(options.size !== undefined ? { size: options.size } : {}),
          ...(options.createTime !== undefined ? { createTime: options.createTime } : {}),
          ...(expectedMd5 ? { fileMd5: expectedMd5 } : {}),
          requireUnique: expectedMd5 === '',
        },
      )
      if (!found.path) {
        rc.op('task', 'export_file_attachment', 'fail', options.fileName, found.error ?? '')
        return { ok: false, error: found.error ?? '本机没有该文件原文件' }
      }
      reportProgress(ctrl, 'locate', 1, 1)
      try {
        let size = 0
        await copyFileVerifiedAtomic(found.path, dest, async (temporaryPath) => {
          if (expectedMd5 && await fileMd5(temporaryPath, ctrl) !== expectedMd5) {
            throw new Error('附件内容 MD5 校验失败，已拒绝导出')
          }
          size = statSync(temporaryPath).size
          return dest
        }, ctrl)
        const format = extname(dest).slice(1).toLowerCase() || 'bin'
        rc.op('task', 'export_file_attachment', 'ok', options.fileName, `${size} 字节`)
        return { ok: true, path: dest, bytes: size, format, source: 'local' }
      } catch (e) {
        const message = (e as Error).message
        rc.op('task', 'export_file_attachment', 'fail', options.fileName, message)
        return {
          ok: false,
          error: message.includes('拒绝导出') ? message : `写入失败：${message}`,
        }
      }
    },
  }
}
