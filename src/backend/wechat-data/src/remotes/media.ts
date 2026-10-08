
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
import { wechatCdnHostAllowed } from '../query/cdn-hosts.ts'
import { queryEmoticons } from '../query/emoticons.ts'
import { queryFiles } from '../query/files.ts'
import { resolveImageKeyPair } from '../query/image-key.ts'
import { fetchImageOriginalToCache, resolveImageOriginalLink } from '../query/image-original.ts'
import { emptyOriginalBatchResult, fetchOriginalImagesBatch as runOriginalImagesBatch, recordFetchedOriginal, scanImageOriginalPlan, scanImageOriginalPlanAsync } from '../query/image-original-batch.ts'
import { resolveMessageFileDataUrl } from '../query/media-file.ts'
import { fetchRemoteImages } from '../query/remote-image.ts'
import { yieldToLoop } from '../query/search-build.ts'
import type { RemoteImageResult } from '../query/remote-image.ts'
import { clearDecodedImageCache, decodeEmoticonDataUrl, decodeFileImageDataUrl, decodeImageDataUrl, fetchEmoticonRemote, resolveImageResourceHint } from '../query/media-image.ts'
import { fetchEmoticonDataUrlsBatch } from '../query/emoticon-batch.ts'
import { resolveVideoInfo } from '../query/media-video.ts'
import { resolveVoiceInfo } from '../query/media-voice.ts'
import { resolveSnsImageDataUrl } from '../query/sns-image.ts'
import { fetchSnsCdnImage } from '../query/sns-cdn-image.ts'
import { fetchSnsCoverDataUrl, fetchSnsVideoDataUrl, loadSnsVideoBytes, resolveSnsVideoCoverDataUrl, resolveSnsVideoDataUrl } from '../query/sns-video.ts'
import { resolveVoiceDataUrl } from '../query/voice.ts'
import { AvatarResult, DecryptStatus, EmoticonsSnapshot, EmoticonDataUrlsResult, FilesSnapshot, ImageDataUrlResult, OperationCategory, OperationStatus, OriginalBatchResult, OriginalFetchPlan, VideoInfoResult, VoiceDataUrlResult, VoiceInfoResult } from '../types.ts'
import { writeFileSync } from 'node:fs'

/** 处理器需要的宿主能力（由 `WechatDataGateway` 组装；getter 形式保证读到最新目录）。 */
export interface MediaRemoteCtx {
  dirs: () => { decrypted: string; decoded: string }
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  /** 微信原始目录（`rawWechatBase(decrypted)`；本文件与它同属宿主层，按函数传进来）。 */
  rawWechatBase: (decrypted: string) => string
  /**
   * 解密状态机（`getDecryptStatus` 读的那一份 `DecryptStatus`）。
   *
   * 为什么媒体域也要它：批量取原图是**长任务**，进展要能让设置页轮询到（`op` = `image-original-batch`），
   * 而且它与批量解密/升级**共用 `active` 这同一道忙闲闸门** —— 三个动作都会写同一批解码缓存，
   * 同时跑只会互相踩槽位。
   */
  decryptState: DecryptStatus
  warmDecodedImages: (decryptedDir: string, decodedDir: string, baseDir: string,
    items: ReadonlyArray<{ username: string; localId: number }>, aesKey: string | undefined, xorKey: number) => void
}

/** 一次批量取图最多几张（IPC 载荷与单次解码耗时的折中；超出的条目按单张语义回错误）。 */
const IMAGE_BATCH_MAX = 200

/**
 * 批量取表情时的**出网并发上限**（E1，2026-09-28）。
 *
 * 为什么是 8：与封面的 `COVER_CONCURRENCY`（`article-cover.ts`）取同一个数 ——
 * 两条链的出网特性一样（都是向 CDN 取一张小图、失败可忽略），同一个数便于统一调参。
 * 表情图比封面小得多，理论上可以更高，但**不为了跑分调高**：并发上去了对端更容易限流，
 * 而这条链失败一次的代价是用户看到占位芯片。
 */
/**
 * 远程图片代理一次最多收多少个地址。
 *
 * 真正的取回上限（40 张）在 `query/remote-image.ts` 里；这一道只是**RPC 载荷护栏** ——
 * 传进来一万个地址时，宁可在这里截断，也不要把几 MB 的字符串数组搬过进程边界。
 */
const REMOTE_URLS_RPC_MAX = 200

/** 批量取图的返回条目（`url`/`error` 与单张入口同义）。 */
export interface ImageBatchItem {
  username: string
  localId: number
  url?: string
  format?: string
  /**
   * true = 这一份是缩略/中图（本机还没有更大的）——与单张入口的 `ImageDataUrlResult.thumb` 同义。
   * 声明它是因为**运行期一直就有**：下面 `items.map` 里展开的正是 `decodeImageDataUrl(...)`
   * 的返回值。前端预取要把结果写进内存缓存，缓存里少了这个标记，「本机只有缩略图」那句
   * 提示就会在命中缓存时凭空消失。
   */
  thumb?: boolean
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

    /** 密钥只在 `resolveImageKeyPair` 一处判定；CDN/本机两条路见 `snsImageWithCdnFirst`。 */
    getSnsImageDataUrl(options: SnsImageOptions): Promise<ImageDataUrlResult> {
      const pair = resolveImageKeyPair(rc.dirs().decrypted)
      return snsImageWithCdnFirst(rc, options, pair)
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
      const remote = await fetchEmoticonRemote(options.emojiUrl, rc.dirs().decoded, options.md5.toLowerCase(),
        base ? { wechatBaseDir: base } : {})
      // 远端也失败时把两条原因都带上，便于区分「没走远端」与「远端失败」
      return remote.url ? remote : { error: (local.error ?? '本地解码失败') + '；' + (remote.error ?? '远端取图失败') }
    },

    /**
     * 批量取表情（E1，2026-09-28 性能修复）。
     *
     * 现场日志里 `getEmoticonDataUrl` 13 次、**均 27,253ms、峰值 71,909ms** ——
     * 两个原因叠在一起：① 前端逐张发 RPC（与封面的 A1 同病）；② 后端每次未命中都
     * 递归扫整棵 `msg/attach`（E2 已改成查索引）。这里解决 ①。
     *
     * ## 为什么顺序是「先本地全过一遍，再对剩下的并发取远端」
     *
     * 不能「逐条走完整链」—— 那样每条都要等一次网络往返，N 条就是 N 个往返的时间。
     * 拆成两趟之后：第一趟纯本地（查索引 + 解码，无网络，很快），把命中的直接定下来；
     * 第二趟只对剩下的并发出网，并按 `emoticon-batch.ts` 里的并发上限限流。
     * 算法整体搬在 `query/emoticon-batch.ts`（本函数只留签名 + 一行转发）。
     *
     * @param options - `items` 为屏上待取的表情（自动去重、忽略空 md5）。
     * @returns 逐条结果，`md5` 回信；顺序 = 去重后的入参顺序。
     */
    async getEmoticonDataUrls(options: { items: Array<{ md5: string; emojiUrl?: string }> }): Promise<EmoticonDataUrlsResult> {
      return fetchEmoticonDataUrlsBatch(
        rc.dirs().decrypted,
        rc.dirs().decoded,
        rawWechatBase(rc.dirs().decrypted) || undefined,
        options?.items,
      )
    },

    async getImageOriginal(options: { username?: string; localId?: number }): Promise<{ ok: boolean; format?: string; bytes?: number; note?: string; error?: string }> {
      const talker = String(options.username ?? '').trim()
      const localId = Math.trunc(Number(options.localId))
      if (talker === '' || !Number.isFinite(localId)) return { ok: false, error: '缺少会话或消息 id' }
      /**
       * 本机兜底：丢掉这张图的缓存条目、按本机现存最好的一档重解一次。
       *
       * 「取不到原图」有三条互不相同的原因，其中**两条都能靠这一步救回来**：
       *   ① 没有免登录直链（XML 里只有 CDN 文件标识）—— 但用户可能已经在微信里点开过，
       *      attach 里就有更大的那份 `.dat`；原先那种情况下槽位被先解出来的缩略图占住，
       *      后到的原图永远读不到（实测 106 条缓存里 35 条如此）。
       *   ② 直链**过期**（回 403/404）—— 同理，本机那份可能反而是有的。
       * 只有「本机确实只有缩略图」这一种才需要用户回微信里点一次。所以两条路径都先试它，
       * 否则用户会看到「取不到原图」而实际本机就有。
       * @returns 重解到非缩略图时的 format；否则 null（此时缓存条目会在下次读图时自动重建）。
       */
      const localFallback = (): { format?: string } | null => {
        const hint = resolveImageResourceHint(rc.dirs().decrypted, talker, localId)
        if (!hint.md5) return null
        clearDecodedImageCache(rc.dirs().decoded, talker, hint.md5)
        const { aesKey, xorKey } = resolveImageKeyPair(rc.dirs().decrypted)
        const redone = decodeImageDataUrl(rc.dirs().decrypted, rc.dirs().decoded, talker, localId,
          rawWechatBase(rc.dirs().decrypted) || undefined, aesKey, xorKey)
        if (redone.url && !redone.thumb) return { format: redone.format }
        return null
      }
      const link = resolveImageOriginalLink(rc.dirs().decrypted, talker, localId)
      if (link === null) {
        const local = localFallback()
        if (local !== null) {
          rc.op('task', 'image_original_fetch', 'ok', talker, '本机重解到更大的那一份（' + (local.format ?? '?') + '）')
          return { ok: true, format: local.format, note: '本机已重解到更大的那一份，这次没有联网' }
        }
        return { ok: false, error: '这条消息没有免登录的原图直链（XML 里只有 CDN 文件标识），本机也只有缩略图。请在微信里打开这张图并点「查看原图」，然后回来再点一次。' }
      }
      const r = await fetchImageOriginalToCache(link, rc.dirs().decoded)
      if (r.bytes === undefined) {
        // 取回失败里最常见的一种是**直链过期**（预签名 URL 有有效期）—— 那时本机很可能
        // 已经有了更大的那一份（用户点开过），所以先试本机，再如实回报两条原因。
        const local = localFallback()
        if (local !== null) {
          rc.op('task', 'image_original_fetch', 'ok', talker, '直链失效，改用本机那份（' + (local.format ?? '?') + '）')
          return { ok: true, format: local.format, note: '直链已失效（' + (r.error ?? '取回失败') + '），已改用本机那份，这次没有联网' }
        }
        rc.op('task', 'image_original_fetch', 'fail', talker, r.error ?? '取回失败')
        return { ok: false, error: r.error ?? '原图取回失败' }
      }
      // 记进续跑索引：批量入口据此跳过「已经取回过」的图，不会为了同一张反复联网。
      recordFetchedOriginal(rc.dirs().decoded, link.md5)
      rc.op('task', 'image_original_fetch', 'ok', talker, String(r.bytes) + ' 字节 · ' + (r.format ?? '?'))
      return { ok: true, format: r.format, bytes: r.bytes }
    },

    /**
     * 盘点「每条图片消息的原图能不能拿到」——**纯本机扫描，不联网**。
     *
     * 存在的原因：用户问得出「为什么这张没有原图」，而答案分三类（本机已有 / 可联网取 /
     * 只有登录态才拿得到）。不给这个数，界面上只能给一句「取不到」。
     * 计划与执行的计数同源（都是 `scanImageOriginalPlan`），不会出现「报 8000 张、实际取 7000 张」。
     * @returns 覆盖率盘点（见 `OriginalFetchPlan`）；未配置原始目录时全 0。
     */
    async planOriginalFetch(): Promise<OriginalFetchPlan> {
      const decrypted = rc.dirs().decrypted
      const empty: OriginalFetchPlan = {
        messages: 0, uniqueMd5: 0, alreadyHd: 0, alreadyFetched: 0,
        candidates: 0, declaredBytes: 0, loginRequired: 0, wecomDirectLink: 0, noPointer: 0,
      }
      const rawRoot = rawWechatBase(decrypted)
      if (!rawRoot) return empty
      return (await scanImageOriginalPlanAsync(decrypted, rawRoot, rc.dirs().decoded, yieldToLoop)).plan
    },

    /**
     * 批量取回原图（免登录直链）：把全库那 16.6% 的一次取完，**可续跑**。
     *
     * 与单张路径一致：已有解密类任务在跑时不并发（回 `blocked`）、逐条失败不中断整批。
     * 成功的写进 `<decoded>/.originals-index.json` ⇒ 下次点一下接着走，不会重下。
     *
     * **明确不做的**：XML 里只有 `cdnbigimgurl`/`cdnmidimgurl` 的那 83.4% 需要微信登录态凭据
     * （见 `query/image-original.ts` 的边界说明），本接口不碰它们；那部分只能在微信里点开后
     * 用「升级为原图」收进来。
     * @param options - `limit`（0/不传 = 本次不限）、`concurrency`（默认 4）。
     * @returns 计数/字节/耗时/逐条失败原因；`blocked` 非空表示一张都没发请求。
     */
    async fetchOriginalImagesBatch(options: { limit?: number; concurrency?: number }): Promise<OriginalBatchResult> {
      const decrypted = rc.dirs().decrypted
      const decoded = rc.dirs().decoded
      if (rc.decryptState.active) return emptyOriginalBatchResult('已有解密任务进行中')
      const rawRoot = rawWechatBase(decrypted)
      if (!rawRoot) return emptyOriginalBatchResult('未配置数据库目录，无法定位微信原始数据')
      rc.decryptState.op = 'image-original-batch'
      rc.decryptState.active = true
      rc.decryptState.done = 0
      rc.decryptState.total = 0
      rc.decryptState.failed = 0
      rc.decryptState.skipped = 0
      rc.decryptState.message = ''
      try {
        const r = await runOriginalImagesBatch(decrypted, rawRoot, decoded, {
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
          ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
          onProgress: (done, total, fetched, failed, message) => {
            rc.decryptState.done = done
            rc.decryptState.total = total
            rc.decryptState.failed = failed
            rc.decryptState.message = message
          },
        })
        rc.decryptState.skipped = Math.max(0, r.candidates - r.attempted)
        const mb = (r.bytes / 1024 / 1024).toFixed(1)
        rc.op('task', 'image_original_fetch', r.failed === 0 ? 'ok' : 'fail', '批量',
          `取回 ${r.fetched}/${r.attempted} 张（${mb} MB），失败 ${r.failed}，剩余候选 ${r.remaining}`)
        return r
      } finally {
        rc.decryptState.active = false
        rc.decryptState.message = ''
      }
    },

    /**
     * 远程图片代理（M23）：渲染层要看一张只存在于微信 CDN 上的图时，改由后端取回 + 落盘缓存。
     *
     * 为什么这一条值得单独存在：卡片缩略图 / 朋友圈远程图 / 视频号封面这些地址今天**由渲染层
     * 直接向消息 XML 里的 https 地址发请求** —— 不进操作记录、没有缓存（同一次滚动反复要同一张）。
     * 把它收到后端之后那两件事才成立，而 CSP `img-src` 里的 `https:` 通配也才可能拿掉。
     *
     * 只代取**腾讯系主机**（判据与原因见 `query/cdn-hosts.ts`）：站外图床会被拒，界面上表现为
     * 没有封面而不是破图。这条口径同时写进隐私声明，别让它成为只在代码里的隐藏规则。
     * @param options - `urls`: 一批图片地址（去重后最多 40 张，超出的条目回错误让调用方分批）。
     * @returns `{items}`：每条带原请求的 `url`、可画的 `dataUrl`（或 `error`）、以及这次是否
     *   来自本机缓存。
     */
    async getRemoteImages(options: { urls?: string[] }): Promise<{ items: RemoteImageResult[] }> {
      const urls = Array.isArray(options?.urls) ? options.urls.slice(0, REMOTE_URLS_RPC_MAX) : []
      if (urls.length === 0) return { items: [] }
      const items = await fetchRemoteImages(urls, rc.dirs().decoded)
      const net = items.filter((it) => !it.fromCache)
      const failed = net.filter((it) => !it.dataUrl)
      // 只在这次真的发过请求时记一条（缓存命中不该刷满操作记录）
      if (net.length > 0) {
        rc.op(
          'task', 'remote_image_fetch', failed.length === 0 ? 'ok' : 'fail',
          `${String(net.length)} 张`,
          failed.length === 0
            ? `从微信 CDN 取回并缓存 ${String(net.length)} 张（其余为本机缓存命中）`
            : `取回 ${String(net.length - failed.length)} 张，失败 ${String(failed.length)} 张：${String(failed[0]?.error ?? failed[0]?.url ?? '')}`,
        )
      }
      return { items }
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
      // 地址是渲染层/消息 XML 送上来的，发请求前必须过白名单（M23）：
      // 只判协议等于「谁给后端一个 https 地址，后端就去取谁」。
      if (!wechatCdnHostAllowed(remote)) return { error: `${local.error ?? '本机没有该封面'}；封面地址的主机不在微信 CDN 清单内，已拒绝请求` }
      const fetched = await fetchSnsCoverDataUrl(remote, { version: weixinVersion(), seed: options.key })
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
      // 同封面：白名单判在发请求之前（M23）
      if (!wechatCdnHostAllowed(remote)) return { error: `${local.error ?? '本机没有该视频'}；视频地址的主机不在微信 CDN 清单内，已拒绝请求` }
      const fetched = await fetchSnsVideoDataUrl(remote, options.md5, { version: weixinVersion(), seed: options.key })
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


/** `getSnsImageDataUrl` 的入参：`md5` 等为旧口径，`url`/`token`/`seed` 为 CDN 通路（可选）。 */
interface SnsImageOptions {
  md5: string
  timelineId?: string
  mediaId?: string
  /** 库里存的 CDN 地址（`http://…/0`）：给了就走 CDN 通路。 */
  url?: string
  /** 媒体标签上的 `token`：CDN 必需（实测 `token+idx=1` 才 200）。 */
  token?: string
  /** `<enc key>` 解密种子（即 `im.key`）：CDN 必需，否则解不出图。 */
  seed?: string
}

/**
 * 朋友圈取图：**CDN 优先**（实测 ~200ms），失败回落本机解密。
 *
 * 为什么先 CDN：本机那条在缓存未命中时会走「读文件 + 解密 + 哈希」全量兜底
 * （实测 12–21s，最坏 130s，见 `sns-image.ts` 顶部日志）；而 CDN 通路实测 200、
 * 响应经 `WxIsaac64` 解密后就是 JPEG（见 `sns-cdn-image.ts`）。
 * 三样（url/token/seed）缺一就保持旧行为（纯本机）—— 向后兼容，既有调用点不受影响。
 *
 * @param rc - 运行上下文（只用到 `dirs()`）。
 * @param options - 见 `SnsImageOptions`。
 * @returns 图片 data URL；两条路都失败时把原因合并，便于区分「本地没有」与「CDN 失败」。
 */
async function snsImageWithCdnFirst(
  rc: { dirs: () => { decrypted: string }; rawWechatBase: (decrypted: string) => string },
  options: SnsImageOptions,
  keys: { aesKey: string | undefined; xorKey: number },
): Promise<ImageDataUrlResult> {
  const dirs = rc.dirs()
  const base = rc.rawWechatBase(dirs.decrypted) || undefined
  const { aesKey, xorKey } = keys
  const url = String(options.url ?? '')
  const token = String(options.token ?? '')
  const seed = String(options.seed ?? '')
  // 追踪：卡片只显示默认文案时，唯一能取证的地方就是这里（应用日志 app.log）
  const tag = '[sns-image] md5=' + options.md5.slice(0, 8)
  const local = resolveSnsImageDataUrl(base, aesKey, xorKey, options.md5, options.timelineId, options.mediaId)
  if (local.url) {
    console.error(tag + ' 本机路命中（长度 ' + String(local.url.length) + '）')
    return local
  }
  // 本机没有才试 CDN。
  //
  // ⚠️ 这段注释原本断言「整份 XOR 用我们这份 WxIsaac64 构建做不到，参考项目另有一份 WASM
  // 才能一次生成全量密钥流」。**那句话是错的**，别再照它去换二进制 ——
  // 2026-10-08 用 `tests/sns-image-tail-probe.manual.spec.ts`（真库/真网/真 WASM）测过：
  //   1. 两份 WASM **完全同一份**（SHA-1 均为 DCA796BACEC37D8522C7，同为 3696.8 KB）；
  //   2. 参考项目自己的 keystream CLI 生成 131072/262144/400000 三档都返回**全量**；
  //   3. 分块生成与一次性生成**逐字节相同**（所以 `sns-keystream.ts` 里那句「分块等价」是对的）；
  //   4. 整份解密后 **9/9 张**都得到合法 JPEG（头 `ff d8 ff e0`）。
  // 真正的病因是 `sns-cdn-image.ts` 的**结尾判据过严**：微信 CDN 在 EOI 之后恒定挂一段
  // 24 字节签名块，旧判据要求「最后两字节必须是 ff d9」，于是把好图全判成失败。
  // 那批图现在能取回来了（同一探针的生产通路用例断言 9/9 成图）。
  if (url === '' || token === '' || seed === '') {
    return local
  }
  const cdn = await fetchSnsCdnImage(url, token, seed)
  if (cdn.dataUrl) {
    console.error(tag + ' CDN 命中（长度 ' + String(cdn.dataUrl.length) + '）')
    return { url: cdn.dataUrl }
  }
  console.error(tag + ' 两条都失败：本机=' + String(local.error) + ' / CDN=' + String(cdn.error))
  return { error: (local.error ?? '本地解码失败') + '；CDN：' + (cdn.error ?? '取图失败') }
}