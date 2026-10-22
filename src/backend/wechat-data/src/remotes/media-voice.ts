/**
 * 语音/视频 Remote（2026-10-21 从 `remotes/media.ts` 拆出）。
 *
 * 拆分原因：合并收藏功能后 `createMediaRemotes` 长到 321 行，越过单函数棘轮登记 313
 * （只许变小）。这里搬语音/视频三个入口，签名与实现逐字不变。
 */
import { resolveVideoInfo } from '../query/media-video.ts'
import { resolveVoiceInfo } from '../query/media-voice.ts'
import { resolveVoiceDataUrl } from '../query/voice.ts'
import type { VideoInfoResult, VoiceDataUrlResult, VoiceInfoResult } from '../types.ts'

/** 语音/视频入口只需要数据根与原目录解析。 */
export interface VoiceVideoRemoteCtx {
  dirs: () => { decrypted: string; decoded: string }
  rawWechatBase: (decrypted: string) => string
}

/**
 * 构造语音/视频 Remote。
 * @param rc - 运行上下文（`dirs()` / `rawWechatBase()`）。
 * @returns 三个方法与拆分前完全一致。
 */
export function createVoiceVideoRemotes(rc: VoiceVideoRemoteCtx): {
  getVoiceInfo: (options: { username: string; localId: number }) => VoiceInfoResult
  getVoiceDataUrl: (options: { username?: string; localId?: number; svrId?: string }) => Promise<VoiceDataUrlResult>
  getVideoInfo: (options: { username?: string; localId?: number; md5?: string }) => VideoInfoResult
} {
  const rawWechatBase = rc.rawWechatBase
  return {
    getVoiceInfo(options: { username: string; localId: number }): VoiceInfoResult {
      return resolveVoiceInfo(rc.dirs().decrypted, options.username, options.localId)
    },

    async getVoiceDataUrl(options: { username?: string; localId?: number; svrId?: string }): Promise<VoiceDataUrlResult> {
      return await resolveVoiceDataUrl(
        rc.dirs().decrypted,
        rc.dirs().decoded,
        options.username ?? '',
        options.localId,
        options.svrId ?? '',
      )
    },

    getVideoInfo(options: { username?: string; localId?: number; md5?: string }): VideoInfoResult {
      return resolveVideoInfo(
        rc.dirs().decrypted, rc.dirs().decoded, options.username ?? '', options.localId ?? 0,
        rawWechatBase(rc.dirs().decrypted) || undefined,
        options.md5,
      )
    },
  }
}
