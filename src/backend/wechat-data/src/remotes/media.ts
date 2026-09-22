
/**
 * 媒体域的 @Remote 处理器（M21 第三十九刀自 `gateway.ts` 搬出）。
 *
 * 域范围：表情/文件/头像、图片与表情的离线解码取回、朋友圈图片与视频（含导出）、
 * 语音与视频的信息与数据 URL。**语音转写（transcribeVoice*）不在这里** —— 它要写
 * `whisperTranscribing` 这类可变字段，等「语音」那一刀一起搬（ctx 要 get/set 一对）。
 * 机制同 KB 那一刀：类里保留 Remote 装饰器与签名，方法体改成一行转发。
 */
import { resolveAvatar, resolveAvatarsLocal } from '../query/avatar.ts'
import { weixinVersion } from '../query/config.ts'
import { queryEmoticons } from '../query/emoticons.ts'
import { queryFiles } from '../query/files.ts'
import { resolveImageKeyPair } from '../query/image-key.ts'
import { fetchImageOriginalToCache, resolveImageOriginalLink } from '../query/image-original.ts'
import { resolveMessageFileDataUrl } from '../query/media-file.ts'
import { clearDecodedImageCache, decodeEmoticonDataUrl, decodeFileImageDataUrl, decodeImageDataUrl, fetchEmoticonRemote, resolveImageResourceHint } from '../query/media-image.ts'
import { resolveVideoInfo } from '../query/media-video.ts'
import { resolveVoiceInfo } from '../query/media-voice.ts'
import { resolveSnsImageDataUrl } from '../query/sns-image.ts'
import { fetchSnsCoverDataUrl, fetchSnsVideoDataUrl, loadSnsVideoBytes, resolveSnsVideoCoverDataUrl, resolveSnsVideoDataUrl } from '../query/sns-video.ts'
import { resolveVoiceDataUrl } from '../query/voice.ts'
import { AvatarResult, EmoticonsSnapshot, FilesSnapshot, ImageDataUrlResult, OperationCategory, OperationStatus, VideoInfoResult, VoiceDataUrlResult, VoiceInfoResult } from '../types.ts'
import { writeFileSync } from 'node:fs'

/** 处理器需要的宿主能力（由 `WechatDataGateway` 组装；getter 形式保证读到最新目录）。 */
export interface MediaRemoteCtx {
  dirs: () => { decrypted: string; decoded: string }
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  privacyBlocked: (feature: string, detail?: string) => string | null
  cdnSwitches: () => { cdnEnabled: boolean; localDecrypt: boolean }
  outboundBlocked: () => boolean
  /** 微信原始目录（`rawWechatBase(decrypted)`；本文件与它同属宿主层，按函数传进来）。 */
  rawWechatBase: (decrypted: string) => string
  warmDecodedImages: (decryptedDir: string, decodedDir: string, baseDir: string,
    items: ReadonlyArray<{ username: string; localId: number }>, aesKey: string | undefined, xorKey: number) => void
}

/** 一次批量取图最多几张（IPC 载荷与单次解码耗时的折中；超出的条目按单张语义回错误）。 */
const IMAGE_BATCH_MAX = 200

/** 批量取图的返回条目（`url`/`error` 与单张入口同义）。 */
export interface ImageBatchItem {
  username: string
  localId: number
  url?: string
  format?: string
  error?: string
}

export function createMediaRemotes(rc: MediaRemoteCtx) {
  // 网关本地的类型（delegation 签名也用它）—— 纯类型导入，无运行期环
  const rawWechatBase = rc.rawWechatBase
  return {
    getEmoticons(options?: { limit?: number; offset?: number }): EmoticonsSnapshot {
      return queryEmoticons(rc.dirs().decrypted, options?.limit, options?.offset)
    },

    getFiles(options?: { limit?: number; offset?: number; category?: string; q?: string }): FilesSnapshot {
      return queryFiles(rc.dirs().decrypted, options?.limit, options?.offset, options?.category, options?.q)
    },

    getVoiceInfo(options: { username: string; localId: number }): VoiceInfoResult {
      return resolveVoiceInfo(rc.dirs().decrypted, options.username, options.localId)
    },

    getVoiceDataUrl(options: { username: string; localId: number }): VoiceDataUrlResult {
      return resolveVoiceDataUrl(rc.dirs().decrypted, rc.dirs().decoded, options.username, options.localId)
    },

    getVideoInfo(options: { username: string; localId: number }): VideoInfoResult {
      return resolveVideoInfo(
        rc.dirs().decrypted, rc.dirs().decoded, options.username, options.localId,
        rawWechatBase(rc.dirs().decrypted) || undefined,
      )
    },

    getAvatar(options: { username: string; nickname?: string }): AvatarResult {
      return resolveAvatar(rc.dirs().decrypted, options.username, rawWechatBase(rc.dirs().decrypted) || undefined, options.nickname)
    },

    getAvatarsLocal(options: { usernames: string[] }): Record<string, string> {
      return resolveAvatarsLocal(rc.dirs().decrypted, options.usernames, {
        wechatBaseDir: rawWechatBase(rc.dirs().decrypted) || undefined,
        allowRemote: !rc.outboundBlocked(),
      })
    },

    getImageDataUrl(options: { username: string; localId: number }): ImageDataUrlResult {
      const base = rawWechatBase(rc.dirs().decrypted) || undefined
      const { aesKey, xorKey } = resolveImageKeyPair(rc.dirs().decrypted)
      return decodeImageDataUrl(rc.dirs().decrypted, rc.dirs().decoded, options.username, options.localId, base, aesKey, xorKey)
    },

    getImageDataUrlsBatch(options: { items: Array<{ username: string; localId: number }> }): { items: ImageBatchItem[] } {
      const decrypted = rc.dirs().decrypted
      const decoded = rc.dirs().decoded
      const base = rawWechatBase(decrypted) || undefined
      const { aesKey, xorKey } = resolveImageKeyPair(decrypted)
      const items = (Array.isArray(options?.items) ? options.items : []).slice(0, IMAGE_BATCH_MAX)
      if (base) rc.warmDecodedImages(decrypted, decoded, base, items, aesKey, xorKey)
      return {
        items: items.map((it) => ({
          username: it.username,
          localId: it.localId,
          ...decodeImageDataUrl(decrypted, decoded, it.username, it.localId, base, aesKey, xorKey),
        })),
      }
    },

    getSnsImageDataUrl(options: { md5: string; timelineId?: string; mediaId?: string }): ImageDataUrlResult {
      const base = rawWechatBase(rc.dirs().decrypted) || undefined
      const { aesKey, xorKey } = resolveImageKeyPair(rc.dirs().decrypted)
      return resolveSnsImageDataUrl(base, aesKey, xorKey, options.md5, options.timelineId, options.mediaId)
    },

    getFileImageDataUrl(options: { md5: string }): ImageDataUrlResult {
      const base = rawWechatBase(rc.dirs().decrypted) || undefined
      const { aesKey, xorKey } = resolveImageKeyPair(rc.dirs().decrypted)
      return decodeFileImageDataUrl(rc.dirs().decrypted, rc.dirs().decoded, base, options.md5, aesKey, xorKey)
    },

    async getEmoticonDataUrl(options: { md5: string; emojiUrl?: string }): Promise<ImageDataUrlResult> {
      const base = rawWechatBase(rc.dirs().decrypted) || undefined
      const { aesKey, xorKey } = resolveImageKeyPair(rc.dirs().decrypted)
      const local = decodeEmoticonDataUrl(rc.dirs().decrypted, rc.dirs().decoded, base, options.md5, aesKey, xorKey)
      if (local.url) return local
      if (!options.emojiUrl) return local
      const remote = await fetchEmoticonRemote(options.emojiUrl, rc.dirs().decoded, options.md5.toLowerCase(), rc.cdnSwitches())
      // 远端也失败时把两条原因都带上，便于区分「没走远端」与「远端失败」
      return remote.url ? remote : { error: (local.error ?? '本地解码失败') + '；' + (remote.error ?? '远端取图失败') }
    },

    async getImageOriginal(options: { username?: string; localId?: number }): Promise<{ ok: boolean; format?: string; bytes?: number; note?: string; error?: string }> {
      const talker = String(options.username ?? '').trim()
      const localId = Math.trunc(Number(options.localId))
      if (talker === '' || !Number.isFinite(localId)) return { ok: false, error: '缺少会话或消息 id' }
      // 「禁止出网」也拦这一条 —— 与朋友圈封面/视频同一口径（PRIVACY 第四节 B/C 段），
      // 否则用户关掉总闸后这里仍然会向微信 CDN 发请求，那句承诺就成了假的。
      const blocked = rc.privacyBlocked('image_original_fetch', '从微信 CDN 取回原图')
      if (blocked !== null) {
        rc.op('task', 'image_original_fetch', 'fail', talker, blocked)
        return { ok: false, error: blocked }
      }
      const link = resolveImageOriginalLink(rc.dirs().decrypted, talker, localId)
      if (link === null) {
        // 「没有免登录直链」不等于「本机没有原图」：用户可能已经在微信里点开过，attach 里就有
        // 更大的那份 .dat。原先这里只回一句「去微信里点一下」，但那句话当时是假的 —— 解码缓存的
        // 槽位被先解出来的缩略图占住后，后到的原图永远读不到（实测 106 条缓存里 35 条如此）。
        // 所以这里主动丢掉这张图的缓存条目再重解一次，让「我在微信里点过了」真的能反映到界面上。
        const hint = resolveImageResourceHint(rc.dirs().decrypted, talker, localId)
        if (hint.md5) {
          clearDecodedImageCache(rc.dirs().decoded, talker, hint.md5)
          const { aesKey, xorKey } = resolveImageKeyPair(rc.dirs().decrypted)
          const redone = decodeImageDataUrl(rc.dirs().decrypted, rc.dirs().decoded, talker, localId,
            rawWechatBase(rc.dirs().decrypted) || undefined, aesKey, xorKey)
          if (redone.url && !redone.thumb) {
            rc.op('task', 'image_original_fetch', 'ok', talker, '本机重解到更大的那一份（' + (redone.format ?? '?') + '）')
            return { ok: true, format: redone.format, note: '本机已重解到更大的那一份，这次没有联网' }
          }
        }
        return { ok: false, error: '这条消息没有免登录的原图直链（XML 里只有 CDN 文件标识），本机也只有缩略图。请在微信里打开这张图并点「查看原图」，然后回来再点一次。' }
      }
      const r = await fetchImageOriginalToCache(link, rc.dirs().decoded, rc.cdnSwitches())
      if (r.bytes === undefined) {
        rc.op('task', 'image_original_fetch', 'fail', talker, r.error ?? '取回失败')
        return { ok: false, error: r.error ?? '原图取回失败' }
      }
      rc.op('task', 'image_original_fetch', 'ok', talker, String(r.bytes) + ' 字节 · ' + (r.format ?? '?'))
      return { ok: true, format: r.format, bytes: r.bytes }
    },

    getMessageFile(options: { fileName: string; size?: number; createTime?: number }): ImageDataUrlResult {
      // size/createTime 来自消息本体（appmsg `<totallen>` 与 create_time），
      // 用于在「同名文件」里挑出属于这条消息的那一份，见 resolveMessageFileDataUrl。
      return resolveMessageFileDataUrl(rawWechatBase(rc.dirs().decrypted) || undefined, options.fileName, {
        ...(options.size !== undefined ? { size: options.size } : {}),
        ...(options.createTime !== undefined ? { createTime: options.createTime } : {}),
      })
    },

    async getSnsVideoCoverDataUrl(options: { md5?: string; timelineId?: string; mediaId?: string; thumb?: string; key?: string }): Promise<ImageDataUrlResult> {
      const base = rawWechatBase(rc.dirs().decrypted) || undefined
      const local = resolveSnsVideoCoverDataUrl(base, options.md5, options.timelineId, options.mediaId)
      if (local.url) return local
      const remote = typeof options.thumb === 'string' ? options.thumb.trim() : ''
      if (!remote || !/^https?:\/\//i.test(remote)) return local
      const blocked = rc.privacyBlocked('sns_cover_fetch', '从微信 CDN 取回封面')
      if (blocked) return { error: `${local.error}；${blocked}` }
      const fetched = await fetchSnsCoverDataUrl(remote, { version: weixinVersion(), seed: options.key, ...rc.cdnSwitches() })
      if (fetched.url) return fetched
      rc.op('task', 'sns_cover_fetch', 'fail', '', fetched.error ?? '')
      return { error: fetched.error }
    },

    async getSnsVideoDataUrl(options: { md5?: string; timelineId?: string; mediaId?: string; url?: string; key?: string }): Promise<ImageDataUrlResult> {
      const base = rawWechatBase(rc.dirs().decrypted) || undefined
      const local = resolveSnsVideoDataUrl(base, options.md5, options.timelineId, options.mediaId)
      if (local.url) return local
      const remote = typeof options.url === 'string' ? options.url.trim() : ''
      if (!remote || !/^https?:\/\//i.test(remote)) return local
      const blocked = rc.privacyBlocked('sns_video_fetch', '从微信 CDN 取回视频')
      if (blocked) return { error: `${local.error}；${blocked}` }
      const fetched = await fetchSnsVideoDataUrl(remote, options.md5, { version: weixinVersion(), seed: options.key, ...rc.cdnSwitches() })
      if (fetched.url) {
        rc.op('task', 'sns_video_fetch', 'ok', '', `从 CDN 取回并解密朋友圈视频（${options.md5?.slice(0, 8) ?? '?'}…）`)
        return fetched
      }
      rc.op('task', 'sns_video_fetch', 'fail', '', fetched.error ?? '')
      return { error: fetched.error }
    },

    async exportSnsVideo(options: {
      md5?: string; timelineId?: string; mediaId?: string; url?: string; key?: string; dest: string
    }): Promise<{ ok: boolean; bytes?: number; source?: string; error?: string }> {
      const dest = typeof options.dest === 'string' ? options.dest.trim() : ''
      if (!dest) return { ok: false, error: '未指定保存路径' }
      const loaded = await loadSnsVideoBytes({
        base: rawWechatBase(rc.dirs().decrypted) || undefined,
        md5: options.md5,
        timelineId: options.timelineId,
        mediaId: options.mediaId,
        url: options.url,
        seed: options.key,
        version: weixinVersion(),
        ...rc.cdnSwitches(),
      })
      if (loaded.error || !loaded.bytes) {
        rc.op('task', 'export_sns_video', 'fail', options.md5?.slice(0, 8) ?? '', loaded.error ?? '')
        return { ok: false, error: loaded.error ?? '取不到视频字节' }
      }
      try {
        writeFileSync(dest, loaded.bytes)
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e)
        rc.op('task', 'export_sns_video', 'fail', options.md5?.slice(0, 8) ?? '', msg)
        return { ok: false, error: `写入失败：${msg}` }
      }
      rc.op('task', 'export_sns_video', 'ok', options.md5?.slice(0, 8) ?? '', `${loaded.bytes.length} 字节 · ${loaded.source}`)
      return { ok: true, bytes: loaded.bytes.length, source: loaded.source }
    },

  }
}
