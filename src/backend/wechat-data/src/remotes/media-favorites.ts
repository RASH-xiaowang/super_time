/**
 * 收藏资源 Remote（2026-10-21 从 `remotes/media.ts` 拆出，主区在途功能）。
 *
 * 拆分原因：加完收藏入口后 `media.ts` 到 1005 行，越过 M21 单文件 1000 行上限；
 * 这里只搬实现、不动签名，`media.ts` 用 `...createFavoriteMediaRemotes(rc)` 展开。
 * 与 `remotes/media-file-images.ts` 同一套做法（拆大文件而不是放宽阈值）。
 */
import { resolveFavoriteMediaDataUrl } from '../query/favorite-media.ts'
import { resolveImageKeyPair } from '../query/image-key.ts'
import type { ImageDataUrlResult } from '../types.ts'

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
  }
}
