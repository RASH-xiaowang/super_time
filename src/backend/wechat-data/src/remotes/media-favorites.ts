/**
 * 收藏资源 Remote（2026-10-21 从 `remotes/media.ts` 拆出，主区在途功能）。
 *
 * 拆分原因：加完收藏入口后 `media.ts` 到 1005 行，越过 M21 单文件 1000 行上限；
 * 这里只搬实现、不动签名，`media.ts` 用 `...createFavoriteMediaRemotes(rc)` 展开。
 * 与 `remotes/media-file-images.ts` 同一套做法（拆大文件而不是放宽阈值）。
 */
import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { resolveFavoriteMediaBytes, resolveFavoriteMediaDataUrl } from '../query/favorite-media.ts'
import { resolveImageKeyPair } from '../query/image-key.ts'
import { sniffExportMediaBytes } from '../query/export-sns-media.ts'
import { dataUrlToBuffer, writeFileAtomicWithProgress } from '../query/export-io.ts'
import { reportProgress, throwIfCancelled, type StreamControl } from '../query/zip.ts'
import type { ImageDataUrlResult, MediaOriginalExportResult } from '../types.ts'
import { originalExportDestination } from './media-original-exports.ts'

/** 收藏入口只需要数据根与原目录解析（与其它 media Remote 一致）。 */
export interface FavoriteMediaRemoteCtx {
  dirs: () => { decrypted: string; decoded: string }
  rawWechatBase: (decrypted: string) => string
}

/** 收藏资源入参（与 `resolveFavoriteMediaDataUrl` 的选项一致）。 */
export interface FavoriteMediaOptions {
  md5?: string
  thumbMd5?: string
  fullMd5?: string
  kind?: 'image' | 'video' | 'audio' | 'file' | 'unknown'
  ext?: string
  fileName?: string
  size?: number
}

/**
 * 构造收藏资源 Remote。
 * @param rc - 运行上下文（`dirs()` / `rawWechatBase()`）。
 * @returns `{ getFavoriteMediaDataUrl }`（签名与拆分前一致）。
 */
export function createFavoriteMediaRemotes(rc: FavoriteMediaRemoteCtx): {
  getFavoriteMediaDataUrl: (options: FavoriteMediaOptions) => ImageDataUrlResult
  exportFavoriteImage: (options: FavoriteMediaOptions & { dest: string; jobId?: string }, ctrl?: StreamControl) => Promise<MediaOriginalExportResult>
  exportFavoriteVideo: (options: FavoriteMediaOptions & { dest: string; jobId?: string }, ctrl?: StreamControl) => Promise<MediaOriginalExportResult>
  exportFavoriteFile: (options: FavoriteMediaOptions & { dest: string; jobId?: string }, ctrl?: StreamControl) => Promise<MediaOriginalExportResult>
} {
  return {
    /**
     * 收藏资源本地缓存：图片、视频、文件、语音和未知资源共用同一条
     * “按明文内容 MD5 匹配 business/favorite 下不透明文件”的解析链。
     * @param options - XML 中的 md5/thumbMd5/fullMd5 与资源类型提示。
     * @returns data URL（含正确 MIME）或本地缓存未命中的说明。
     */
    getFavoriteMediaDataUrl(options: FavoriteMediaOptions): ImageDataUrlResult {
      const decrypted = rc.dirs().decrypted
      const base = rc.rawWechatBase(decrypted) || undefined
      const { aesKey, xorKey } = resolveImageKeyPair(decrypted)
      return resolveFavoriteMediaDataUrl(base, options ?? {}, aesKey, xorKey)
    },

    /**
     * Save a favorite image from the full-content MD5 tier.
     *
     * The visible tile may be backed by `thumbMd5`; accepting that value here
     * would silently save a thumbnail as the original. When the XML has no
     * full MD5, this endpoint refuses rather than guessing.
     */
    async exportFavoriteImage(options: FavoriteMediaOptions & { dest: string; jobId?: string }, ctrl?: StreamControl): Promise<MediaOriginalExportResult> {
      throwIfCancelled(ctrl?.signal)
      reportProgress(ctrl, 'locate', 0, 1)
      const dest = String(options.dest ?? '').trim()
      const fullMd5 = String(options.fullMd5 ?? '').trim().toLowerCase()
      if (!dest) return { ok: false, error: '未指定保存路径' }
      if (!/^[a-f0-9]{32}$/.test(fullMd5)) {
        return { ok: false, error: '收藏项缺少原图 MD5，无法确认原图；已拒绝保存缩略图' }
      }
      const decrypted = rc.dirs().decrypted
      const { aesKey, xorKey } = resolveImageKeyPair(decrypted)
      reportProgress(ctrl, 'read', 0, 0)
      const resolved = resolveFavoriteMediaDataUrl(
        rc.rawWechatBase(decrypted) || undefined,
        { fullMd5, kind: 'image' },
        aesKey,
        xorKey,
      )
      const bytes = resolved.url ? dataUrlToBuffer(resolved.url) : null
      throwIfCancelled(ctrl?.signal)
      reportProgress(ctrl, 'read', 1, 1)
      if (!bytes) return { ok: false, error: resolved.error ?? '微信收藏缓存中未找到原图' }
      const media = sniffExportMediaBytes(bytes, 'image')
      if (!media) return { ok: false, error: '收藏缓存内容不是可识别的图片，已拒绝写入' }
      const finalDest = originalExportDestination(dest, media.format)
      try {
        await writeFileAtomicWithProgress(finalDest, bytes, ctrl)
      } catch (e) {
        return { ok: false, error: `写入失败：${(e as Error).message}` }
      }
      return { ok: true, path: finalDest, bytes: bytes.length, format: media.format, source: 'local' }
    },

    /**
     * Save a favorite video from the XML's full-content MD5 only.
     *
     * `md5`/`thumbMd5` may identify the cover image rather than the video body.
     * Requiring `fullMd5` keeps a thumbnail-cache hit from being published as
     * the original video, and the sniffed container chooses the real extension.
     */
    async exportFavoriteVideo(options: FavoriteMediaOptions & { dest: string; jobId?: string }, ctrl?: StreamControl): Promise<MediaOriginalExportResult> {
      throwIfCancelled(ctrl?.signal)
      reportProgress(ctrl, 'locate', 0, 1)
      const dest = String(options.dest ?? '').trim()
      const fullMd5 = String(options.fullMd5 ?? '').trim().toLowerCase()
      if (!dest) return { ok: false, error: '未指定保存路径' }
      if (!/^[a-f0-9]{32}$/.test(fullMd5)) {
        return { ok: false, error: '收藏项缺少原视频 MD5，无法确认原视频；已拒绝保存封面或缩略图' }
      }
      const decrypted = rc.dirs().decrypted
      const { aesKey, xorKey } = resolveImageKeyPair(decrypted)
      reportProgress(ctrl, 'read', 0, 0)
      const resolved = resolveFavoriteMediaDataUrl(
        rc.rawWechatBase(decrypted) || undefined,
        { fullMd5, kind: 'video' },
        aesKey,
        xorKey,
      )
      const bytes = resolved.url ? dataUrlToBuffer(resolved.url) : null
      throwIfCancelled(ctrl?.signal)
      reportProgress(ctrl, 'read', 1, 1)
      if (!bytes) return { ok: false, error: resolved.error ?? '微信收藏缓存中未找到原视频' }
      const media = sniffExportMediaBytes(bytes, 'video')
      if (!media) return { ok: false, error: '收藏缓存内容不是 MP4/MOV/M4V 原视频，已拒绝写入' }
      const finalDest = originalExportDestination(dest, media.format)
      try {
        await writeFileAtomicWithProgress(finalDest, bytes, ctrl)
      } catch (e) {
        return { ok: false, error: `写入失败：${(e as Error).message}` }
      }
      return { ok: true, path: finalDest, bytes: bytes.length, format: media.format, source: 'local' }
    },

    /**
     * Save a favorite attachment from its declared full-content MD5.
     *
     * Favorite files live below `business/favorite`, not `msg/file`. Reusing
     * the chat attachment resolver would either miss them or save a different
     * same-name file, so this endpoint uses the favorite cache index and
     * verifies the plaintext hash again before writing.
     */
    async exportFavoriteFile(options: FavoriteMediaOptions & { dest: string; jobId?: string }, ctrl?: StreamControl): Promise<MediaOriginalExportResult> {
      throwIfCancelled(ctrl?.signal)
      reportProgress(ctrl, 'locate', 0, 1)
      const dest = String(options.dest ?? '').trim()
      const fullMd5 = String(options.fullMd5 ?? '').trim().toLowerCase()
      if (!dest) return { ok: false, error: '未指定保存路径' }
      if (!/^[a-f0-9]{32}$/.test(fullMd5)) {
        return { ok: false, error: '收藏项缺少原文件 MD5，无法确认原文件' }
      }
      const decrypted = rc.dirs().decrypted
      const { aesKey, xorKey } = resolveImageKeyPair(decrypted)
      reportProgress(ctrl, 'read', 0, 0)
      const resolved = resolveFavoriteMediaBytes(
        rc.rawWechatBase(decrypted) || undefined,
        { fullMd5, kind: 'file' },
        aesKey,
        xorKey,
      )
      throwIfCancelled(ctrl?.signal)
      reportProgress(ctrl, 'read', 1, 1)
      if (!resolved.bytes) return { ok: false, error: resolved.error ?? '微信收藏缓存中未找到原文件' }
      const actualMd5 = createHash('md5').update(resolved.bytes).digest('hex')
      if (actualMd5 !== fullMd5) {
        return { ok: false, error: '收藏原文件内容 MD5 校验失败，已拒绝写入' }
      }
      try {
        await writeFileAtomicWithProgress(dest, resolved.bytes, ctrl)
      } catch (e) {
        return { ok: false, error: `写入失败：${(e as Error).message}` }
      }
      const format = resolved.format || extname(dest).slice(1).toLowerCase() || 'bin'
      return { ok: true, path: dest, bytes: resolved.bytes.length, format, source: 'local' }
    },
  }
}
