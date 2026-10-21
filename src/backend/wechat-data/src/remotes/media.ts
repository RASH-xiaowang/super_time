
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
import { tryUpgradeToOriginal, forgetAutoUpgradeAttempt } from '../query/image-auto-upgrade.ts'
import { fetchQuota, type WxcdnQuota } from '../query/wxcdn-original.ts'
import { emptyOriginalBatchResult, fetchOriginalImagesBatch as runOriginalImagesBatch, recordFetchedOriginal, scanImageOriginalPlan, scanImageOriginalPlanAsync } from '../query/image-original-batch.ts'
import { getOriginalHarvestStatus, harvestHdDats, setHarvestProgress, startOriginalHarvester, stopOriginalHarvester, type HarvestResult, type HarvestStatus } from '../query/original-harvester.ts'
import { resolveMessageFileDataUrl } from '../query/media-file.ts'
import { lookupOriginal, lookupArchivedOriginal, originalAsDataUrl, saveArchivedOriginal, saveOriginal } from '../query/sns-media-store.ts'
import { readArchivedAvatar, readArchivedAvatars, saveArchivedAvatar, saveArchivedAvatars } from '../query/moments-archive.ts'
import { fetchRemoteImages } from '../query/remote-image.ts'
import { yieldToLoop } from '../query/search-build.ts'
import type { RemoteImageResult } from '../query/remote-image.ts'
import { clearDecodedImageCache, fetchEmoticonRemote, resolveImageResourceHint, resolveImageResourceHintsBatch, type ImageResourceHint } from '../query/media-image.ts'
import { decodeEmoticonDataUrlAsync, decodeImageDataUrlAsync, type DecodeImageOptions } from '../query/media-image-async.ts'
import { createFavoriteMediaRemotes } from './media-favorites.ts'
import { createVoiceVideoRemotes } from './media-voice.ts'
import { createFileImageRemotes } from './media-file-images.ts'
import { fetchEmoticonDataUrlsBatch } from '../query/emoticon-batch.ts'
import { fetchMapGeoJson } from '../query/map-geo.ts'
import { resolveSnsImageDataUrl } from '../query/sns-image.ts'
import { fetchSnsCdnImage } from '../query/sns-cdn-image.ts'
import { fetchSnsCoverDataUrl, fetchSnsVideoDataUrl, loadSnsVideoBytes, resolveSnsVideoCoverDataUrlsAsync, resolveSnsVideoCoverDataUrlAsync, resolveSnsVideoDataUrlAsync } from '../query/sns-video.ts'
import { AvatarResult, DecryptStatus, EmoticonsSnapshot, EmoticonDataUrlsResult, FilesSnapshot, ImageDataUrlResult, MapGeoJsonResult, OperationCategory, OperationStatus, OriginalBatchResult, OriginalFetchPlan, VoiceInfoResult } from '../types.ts'
import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
    items: ReadonlyArray<{ username: string; localId: number }>, aesKey: string | undefined, xorKey: number,
    knownMd5s?: readonly string[]) => Promise<void>
}

/** 一次批量取图最多几张（IPC 载荷与单次解码耗时的折中；超出的条目按单张语义回错误）。 */
const IMAGE_BATCH_MAX = 200

import { IMAGE_BATCH_CONCURRENCY, mapWithConcurrency } from '../query/concurrency.ts'
export { IMAGE_BATCH_CONCURRENCY, mapWithConcurrency }

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
  /** 相对 decoded_images 的落盘路径（与单张入口同义）；前端据此拼 wechat-media:// 省 base64。 */
  file?: string
  error?: string
}

/**
 * 取头像并顺手归档（2026-10-19）：好友被删/清缓存后，朋友圈仍能靠归档头像对上号。
 * 抽成独立函数是因为 `createMediaRemotes` 那一大对象已顶到函数行数棘轮，不能再长。
 * @param rc - 媒体域上下文。
 * @param options - username + 可选昵称。
 * @returns AvatarResult；本机没有时先查归档，再回原结果。
 */
function avatarWithArchive(rc: MediaRemoteCtx, options: { username: string; nickname?: string }): AvatarResult {
  const decrypted = rc.dirs().decrypted
  const live = resolveAvatar(decrypted, options.username, rc.rawWechatBase(decrypted) || undefined, options.nickname)
  if (live.kind === 'data' && typeof live.data === 'string' && live.data !== '') {
    saveArchivedAvatar(decrypted, options.username, options.nickname ?? '', live.data)
    return live
  }
  const archived = readArchivedAvatar(decrypted, options.username)
  if (archived === null) return live
  // 归档里既可能是 data URL（head_image/temp 缓存解出来的），也可能是 https 地址
  // （contact 表只有地址、当时没本地缓存）。后者必须按 `kind:'url'` 返回，交给前端
  // 的后端图片代理去取 —— 标成 `data` 会让渲染层把 `https://…` 塞进 `<img src>`，
  // CSP 的 `img-src` 只放行本机来源，于是头像静默退成首字。
  if (archived.startsWith('data:image/')) return { kind: 'data', data: archived }
  if (/^https:\/\//i.test(archived)) return { kind: 'url', url: archived }
  return live
}

/**
 * 批量取本地头像并归档；本机没有的用归档补（好友删除后的兜底）。
 * @param rc - 媒体域上下文。
 * @param options - username 列表。
 * @returns username → data URL。
 */
function avatarsLocalWithArchive(rc: MediaRemoteCtx, options: { usernames: string[] }): Record<string, string> {
  const decrypted = rc.dirs().decrypted
  const usernames = Array.isArray(options.usernames) ? options.usernames : []
  const local = resolveAvatarsLocal(decrypted, usernames, {
    wechatBaseDir: rc.rawWechatBase(decrypted) || undefined,
  })
  saveArchivedAvatars(decrypted, Object.entries(local).map(([username, avatar]) => ({ username, name: '', avatar })))
  const missing = usernames.filter((u) => (local[u] ?? '') === '')
  const archived = readArchivedAvatars(decrypted, missing)
  return Object.keys(archived).length > 0 ? { ...local, ...archived } : local
}

export function createMediaRemotes(rc: MediaRemoteCtx) {
  // 网关本地的类型（delegation 签名也用它）—— 纯类型导入，无运行期环
  const rawWechatBase = rc.rawWechatBase
  return {
    getEmoticons(options?: { limit?: number; offset?: number }): EmoticonsSnapshot {
      return queryEmoticons(rc.dirs().decrypted, options?.limit, options?.offset, rawWechatBase(rc.dirs().decrypted) || undefined)
    },

    getFiles(options?: { limit?: number; offset?: number; category?: string; q?: string }): FilesSnapshot {
      return queryFiles(rc.dirs().decrypted, options?.limit, options?.offset, options?.category, options?.q)
    },

    ...createVoiceVideoRemotes(rc),

    getAvatar(options: { username: string; nickname?: string }): AvatarResult {
      return avatarWithArchive(rc, options)
    },

    getAvatarsLocal(options: { usernames: string[] }): Record<string, string> {
      return avatarsLocalWithArchive(rc, options)
    },

    /**
     * 取一条消息的图片（data URL），**自动取原图**：解出来是缩略图时会自己再试一次升级
     * （本机重解 → CDN 直链），不需要用户点按钮。算法体在 `imageWithAutoUpgrade`。
     * @param options - `username` 会话；`localId` 消息 id。
     * @returns data URL + 格式；`thumb: true` 表示这次仍是缩略图（升级没成功）。
     */
    async getImageDataUrl(options: { username: string; localId: number }): Promise<ImageDataUrlResult> {
      const base = rawWechatBase(rc.dirs().decrypted) || undefined
      const { aesKey, xorKey } = resolveImageKeyPair(rc.dirs().decrypted)
      return imageWithAutoUpgrade(rc, options.username, options.localId, base, aesKey, xorKey, true)
    },

    /** 批量取图：同样自动取原图，但**只走本机重解**（不联网，否则首屏拖到分钟级）。 */
    async getImageDataUrlsBatch(options: { items: Array<{ username: string; localId: number }>; fileOnly?: boolean }): Promise<{ items: ImageBatchItem[] }> {
      const base = rawWechatBase(rc.dirs().decrypted) || undefined
      const { aesKey, xorKey } = resolveImageKeyPair(rc.dirs().decrypted)
      return imagesBatchWithAutoUpgrade(rc, options?.items, base, aesKey, xorKey, options?.fileOnly === true)
    },
    /** 密钥只在 `resolveImageKeyPair` 一处判定；CDN/本机两条路见 `snsImageWithCdnFirst`。 */
    getSnsImageDataUrl(options: SnsImageOptions): Promise<ImageDataUrlResult> {
      const pair = resolveImageKeyPair(rc.dirs().decrypted)
      return snsImageWithCdnFirst(rc, options, pair)
    },

    ...createFileImageRemotes(rc),

    ...createFavoriteMediaRemotes(rc),

    async getEmoticonDataUrl(options: { md5: string; emojiUrl?: string }): Promise<ImageDataUrlResult> {
      const base = rawWechatBase(rc.dirs().decrypted) || undefined
      const { aesKey, xorKey } = resolveImageKeyPair(rc.dirs().decrypted)
      const local = await decodeEmoticonDataUrlAsync(rc.dirs().decrypted, rc.dirs().decoded, base, options.md5, aesKey, xorKey)
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
      // 用户显式点了「取原图」⇒ 清掉自动升级的「已试过」记忆，让这次一定真的重试
      // （否则 10 分钟 TTL 内会直接跳过，用户会觉得按钮没反应）。
      forgetAutoUpgradeAttempt(talker, localId)
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
      const localFallback = async (): Promise<{ format?: string } | null> => {
        const hint = resolveImageResourceHint(rc.dirs().decrypted, talker, localId)
        if (!hint.md5) return null
        clearDecodedImageCache(rc.dirs().decoded, talker, hint.md5)
        const { aesKey, xorKey } = resolveImageKeyPair(rc.dirs().decrypted)
        const redone = await decodeImageDataUrlAsync(rc.dirs().decrypted, rc.dirs().decoded, talker, localId,
          rawWechatBase(rc.dirs().decrypted) || undefined, aesKey, xorKey)
        if (redone.url && !redone.thumb) return { format: redone.format }
        return null
      }
      const link = resolveImageOriginalLink(rc.dirs().decrypted, talker, localId)
      if (link === null) {
        const local = await localFallback()
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
        const local = await localFallback()
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
    async fetchOriginalImagesBatch(options?: { limit?: number; concurrency?: number }): Promise<OriginalBatchResult> {
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
          ...(options?.limit !== undefined ? { limit: options.limit } : {}),
          ...(options?.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
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
     * 原图自动收割：`start` 挂监控 / `stop` 停止 / `now` 手动扫一遍。
     * 这是拿到高清原图唯一不越界的通路（`tpurl` 全 403、内存 JPEG 与 md5 交集为 0）：
     * 微信负责下载，我们负责收割 —— 不联网、不碰凭据、不注入进程。
     */
    async originalHarvest(action: 'start' | 'stop' | 'now'): Promise<HarvestResult | HarvestStatus> {
      if (action === 'stop') {
        stopOriginalHarvester()
        return getOriginalHarvestStatus()
      }
      return harvestWithOp(rc, action)
    },

    // 纯内存读取，单独一个 Remote 才不会被归成重任务（混进 originalHarvest 会被队列拒）。
    getOriginalHarvestStatus: async (): Promise<HarvestStatus> => getOriginalHarvestStatus(),
    // 第三方原图服务额度（本机唯一能覆盖那 81.6% 的通路；按流量计费）。
    getWxcdnQuota: async (): Promise<{ quota?: WxcdnQuota; error?: string }> => wxcdnQuotaWithOp(rc),
    // 算法体在模块级 `remoteImagesWithOp`；这里只保留签名 + 一行转发。
    async getRemoteImages(options: { urls?: string[] }): Promise<{ items: RemoteImageResult[] }> {
      return remoteImagesWithOp(rc, Array.isArray(options?.urls) ? options.urls : [])
    },

    // 算法体在模块级 `mapGeoJsonWithOp`；这里只保留签名 + 一行转发。
    getMapGeoJson: (options: { urls?: string[] } = {}) =>
      mapGeoJsonWithOp(rc, Array.isArray(options?.urls) ? options.urls : []),

    getMessageFile(options: { fileName: string; size?: number; createTime?: number }): ImageDataUrlResult {
      // size/createTime 来自消息本体（appmsg `<totallen>` 与 create_time），
      // 用于在「同名文件」里挑出属于这条消息的那一份，见 resolveMessageFileDataUrl。
      return resolveMessageFileDataUrl(rawWechatBase(rc.dirs().decrypted) || undefined, options.fileName, {
        ...(options.size !== undefined ? { size: options.size } : {}),
        ...(options.createTime !== undefined ? { createTime: options.createTime } : {}),
      })
    },

    async getSnsVideoCoverDataUrl(options: { md5?: string; timelineId?: string; mediaId?: string; thumb?: string; key?: string; offline?: boolean }): Promise<ImageDataUrlResult> {
      return snsVideoCoverWithCdnFirst(rc, options)
    },

    /** W2-5.6：一批封面。解析走一次列举，CDN 取回走有界并发。 */
    async getSnsVideoCoversBatch(options: SnsVideoCoverBatchOptions): Promise<SnsVideoCoverBatchResult> {
      return snsVideoCoversBatchIn(rc, options)
    },

    async getSnsVideoDataUrl(options: { md5?: string; timelineId?: string; mediaId?: string; url?: string; key?: string }): Promise<ImageDataUrlResult> {
      const base = rawWechatBase(rc.dirs().decrypted) || undefined
      const local = await resolveSnsVideoDataUrlAsync(base, options.md5, options.timelineId, options.mediaId)
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


/**
 * 远程图片代理（M23）：渲染层要看一张只存在于微信 CDN 上的图时，改由后端取回 + 落盘缓存。
 *
 * 为什么这一条值得单独存在：卡片缩略图 / 朋友圈远程图 / 视频号封面这些地址今天**由渲染层
 * 直接向消息 XML 里的 https 地址发请求** —— 不进操作记录、没有缓存（同一次滚动反复要同一张）。
 * 把它收到后端之后那两件事才成立，而 CSP `img-src` 里的 `https:` 通配也才可能拿掉。
 *
 * 只代取**腾讯系主机**（判据与原因见 `query/cdn-hosts.ts`）：站外图床会被拒，界面上表现为
 * 没有封面而不是破图。这条口径同时写进隐私声明，别让它成为只在代码里的隐藏规则。
 * @param rc - 媒体域上下文。
 * @param urls - 一批图片地址（去重后最多 40 张，超出的条目回错误让调用方分批）。
 * @returns `{items}`：每条带原请求的 `url`、可画的 `dataUrl`（或 `error`）、以及这次是否
 *   来自本机缓存。
 */
async function remoteImagesWithOp(
  rc: MediaRemoteCtx,
  urls: string[],
): Promise<{ items: RemoteImageResult[] }> {
  const capped = urls.slice(0, REMOTE_URLS_RPC_MAX)
  if (capped.length === 0) return { items: [] }
  const items = await fetchRemoteImages(capped, rc.dirs().decoded)
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
}

/**
 * 公共地图 GeoJSON 代理：渲染层不再直接出网，改由这里固定白名单取回。
 *
 * `urls` 只是候选顺序；真正能发出请求的地址由 `query/map-geo.ts` 再次校验。
 * 只含公开行政区划数据，不含任何用户消息、联系人或账号信息。
 * @param rc - 媒体域上下文（用于把取回结果写进操作记录）。
 * @param urls - 候选 GeoJSON 地址。
 * @returns 第一份可用的 GeoJSON，或首条可展示的失败原因。
 */
async function mapGeoJsonWithOp(rc: MediaRemoteCtx, urls: string[]): Promise<MapGeoJsonResult> {
  const result = await fetchMapGeoJson(urls)
  rc.op(
    'task',
    'map_geo_fetch',
    result.ok ? 'ok' : 'fail',
    result.ok ? '公开行政区划 GeoJSON' : '',
    result.ok ? '' : result.error,
  )
  return result
}


/**
 * 原图自动收割的算法体（`start` 挂监控 / `now` 手动扫一遍）。
 *
 * 两个动作合成一个函数是为了守住 `createMediaRemotes` 的行数棘轮（250 行上限）。
 *
 * 这是**拿到高清原图唯一不越界的通路**（2026-10-17 实测：`tpurl` 全 403、
 * 内存里的 `tpauthkey` 拼进 URL 也全 403、内存里的 JPEG 与数据库 md5 交集为 0）。
 * 微信负责下载，我们负责收割：不联网、不碰凭据、不注入进程。
 * @param rc - 媒体域上下文。
 * @param action - `start` 只挂监控（毫秒级返回）/ `now` 扫一遍 `msg/attach` 下所有 `_h.dat`。
 * @returns 收割结果（`start` 恒为空结果）。
 */
async function harvestWithOp(rc: MediaRemoteCtx, action: 'start' | 'now'): Promise<HarvestResult> {
  const decrypted = rc.dirs().decrypted
  const rawRoot = rc.rawWechatBase(decrypted)
  if (!rawRoot) return { harvested: 0, failed: 0, errors: [] }
  const { aesKey, xorKey } = resolveImageKeyPair(decrypted)
  if (action === 'start') {
    const r = await startOriginalHarvester(rawRoot, rc.dirs().decoded, aesKey, xorKey)
    rc.op('task', 'image_original_harvest', 'ok', '自动收割', '已挂上监控')
    return r
  }
  const files: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 10) return
    let entries: Array<{ name: string; isDir: boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }))
    } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDir) { walk(p, depth + 1); continue }
      if (/_h\.dat$/i.test(e.name)) files.push(p)
    }
  }
  walk(join(rawRoot, 'msg', 'attach'), 0)
  setHarvestProgress({ done: 0, total: files.length, harvested: 0, failed: 0 })
  let r: HarvestResult
  try {
    r = await harvestHdDats(files, rc.dirs().decoded, aesKey, xorKey, (done, total, harvested, failed) => {
      setHarvestProgress({ done, total, harvested, failed })
    })
  } finally {
    setHarvestProgress(null)
  }
  rc.op('task', 'image_original_harvest', r.failed === 0 ? 'ok' : 'fail', '手动收割',
    `收割 ${r.harvested} 张，失败 ${r.failed}`)
  return r
}

/**
 * 取一张图并**自动尝试升级为原图**（模块级算法体）。
 *
 * 解出来是缩略图时再试一次升级：本机重解（几十毫秒）→ CDN 直链（一次网络往返）。
 * 升级成功就重新解一次（缓存槽已被原图占住，这次一定命中原图）；失败原样返回缩略图。
 *
 * 为什么放在后端而不是前端：前端虚拟列表一屏几十张，让前端在拿到 `thumb: true` 后再发
 * 一次 RPC 就是每张图两个请求，还要管「这张试过了别再试」的状态。放这里只有一个 RPC。
 * @param rc - 媒体域上下文。
 * @param username - 会话 username。
 * @param localId - 消息 local_id。
 * @param allowNetwork - 是否允许走 CDN 直链（批量路径传 false，避免拖慢首屏）。
 * @returns data URL + 格式；`thumb: true` 表示这次仍是缩略图。
 */
async function imageWithAutoUpgrade(
  rc: MediaRemoteCtx,
  username: string,
  localId: number,
  base: string | undefined,
  aesKey: string | undefined,
  xorKey: number | undefined,
  allowNetwork: boolean,
  decodeOptions?: DecodeImageOptions,
): Promise<ImageDataUrlResult> {
  const decrypted = rc.dirs().decrypted
  const decoded = rc.dirs().decoded
  const r = await decodeImageDataUrlAsync(decrypted, decoded, username, localId, base, aesKey, xorKey, decodeOptions)
  // 只有「解出来是缩略图」才值得再试一次；已经是原图 / 出错都不动。
  if (r.thumb !== true || (r.url === undefined && r.file === undefined)) return r
  const up = await tryUpgradeToOriginal(
    decrypted, decoded, username, localId, base, aesKey, xorKey ?? 0xff, allowNetwork,
    { hint: decodeOptions?.hint, fileOnly: decodeOptions?.fileOnly },
  )
  if (up.format === undefined) return r
  const again = await decodeImageDataUrlAsync(decrypted, decoded, username, localId, base, aesKey, xorKey, decodeOptions)
  return again.url !== undefined || again.file !== undefined ? again : r
}

/**
 * 批量取图并自动升级（模块级算法体）。
 *
 * **只走本机重解**（`allowNetwork=false`）：一屏几十张，每张都发一次 CDN 请求会把首屏拖到分钟级。
 * @param rc - 媒体域上下文。
 * @param rawItems - 屏上待取的图片（会被截断到 `IMAGE_BATCH_MAX`）。
 * @returns 逐条结果，顺序与入参一致。
 */
async function imagesBatchWithAutoUpgrade(
  rc: MediaRemoteCtx,
  rawItems: Array<{ username: string; localId: number }> | undefined,
  base: string | undefined,
  aesKey: string | undefined,
  xorKey: number | undefined,
  fileOnly: boolean,
): Promise<{ items: ImageBatchItem[] }> {
  const decrypted = rc.dirs().decrypted
  const decoded = rc.dirs().decoded
  const items = (Array.isArray(rawItems) ? rawItems : []).slice(0, IMAGE_BATCH_MAX)
  const hints: ImageResourceHint[] = resolveImageResourceHintsBatch(decrypted, items)
  const md5s = hints.map(hint => hint.md5 ?? '')
  if (base) await rc.warmDecodedImages(decrypted, decoded, base, items, aesKey, xorKey ?? 0xff, md5s)
  return {
    items: await mapWithConcurrency(items, IMAGE_BATCH_CONCURRENCY, async (it, index) => {
      const r = await imageWithAutoUpgrade(rc, it.username, it.localId, base, aesKey, xorKey, false, {
        hint: hints[index],
        fileOnly,
      })
      return { username: it.username, localId: it.localId, ...r }
    }),
  }
}

/**
 * `fileOnly` 模式的返回整形：有落盘文件就不再回传 base64（桌面端用 wechat-media:// 流式显示）。
 *
 * 没有 `file` 的情况（远端 CDN 取回、解码失败、老快照没写缓存）原样保留 `url`，
 * 调用方不需要再发一次请求；所以这是「能省则省」，不是另一个错误分支。
 * @param result - 单张/批量条目；不修改入参。
 * @returns 同形状结果；file 存在时删掉 url。
 */
export function withoutDataUrlWhenFile<T extends { file?: string; url?: string }>(result: T): T {
  if (result.file === undefined || result.file === '') return result
  const copy: T = { ...result }
  delete copy.url
  return copy
}

/**
 * 读第三方原图服务的额度（模块级算法体）。
 * @param rc - 媒体域上下文。
 * @returns 套餐名、总量、已用、剩余、重置时间；失败时 `{ error }`。
 */
async function wxcdnQuotaWithOp(rc: MediaRemoteCtx): Promise<{ quota?: WxcdnQuota; error?: string }> {
  const rawRoot = rc.rawWechatBase(rc.dirs().decrypted)
  return rawRoot ? fetchQuota(rawRoot) : { error: '未配置数据库目录，无法定位微信原始数据' }
}

/**
 * 把一份 data URL 写进落盘原图缓存（best-effort）。
 *
 * 为什么单独一个小助手而不是让调用方传字节：两条产出路（本机解密、CDN 解密）给的都是
 * `data:` URL，拆 base64 的逻辑只该有一份 —— 拆错了会**静默存进一份坏原图**，
 * 而坏原图比没有原图更坏：它会被永久缓存，此后每次进入都返回它且永不重抓。
 * 所以 `saveOriginal` 会再嗅一次魔数，认不出就拒绝落盘。
 *
 * 2026-10-19 起同时写**长期归档**（`<数据根>/moments-media/`）：解码缓存会被密钥变更
 * 清空，长期归档不会；用户要求「CDN 原图落盘后请保留在本地」。
 *
 * @param decodedDir - `decoded_images` 目录。
 * @param md5 - 32 位媒体 md5。
 * @param dataUrl - `data:image/...;base64,...`；形态不对就静默跳过。
 */
function saveOriginalFromDataUrl(decodedDir: string, md5: string, dataUrl: string | undefined): void {
  if (!dataUrl || !dataUrl.startsWith('data:image/')) return
  const comma = dataUrl.indexOf(',')
  if (comma < 0 || !dataUrl.slice(0, comma).includes(';base64')) return
  try {
    const bytes = Buffer.from(dataUrl.slice(comma + 1), 'base64')
    saveOriginal(decodedDir, md5, bytes)
    saveArchivedOriginal(decodedDir, md5, bytes)
  } catch {
    // 落盘失败不影响本次展示（磁盘满 / 只读目录 / 权限不足）
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
  /**
   * 界面侧判定「当前无网」（`navigator.onLine === false`）。缺省按**有网**处理。
   *
   * 为什么缺省是有网而不是无网：判错的方向不一样 —— 误判成有网只是多走一趟网络；
   * 误判成无网会让用户永远看不到刚上传的新图，而且**没有任何报错**。
   */
  offline?: boolean
}

/**
 * 朋友圈取图：**本地优先、CDN 兜底**（2026-10-19 用户口径变更）。
 *
 * ## 顺序（改前先读，别退回 CDN 优先）
 *
 *  ⓪ **长期归档** `<数据根>/moments-media/<md5 前两位>/<md5>.<ext>`：跨重启、跨密钥
 *    保留；只要拿到过原图就直接显示，不再联网（这就是「下次进入先用本地」）。
 *  ① `decoded_images/sns-media` 的落盘原图（本机快路径）→ 显示，并补写长期归档；
 *  ② 微信原始目录里的原图（`cache/<月>/Sns/Img`）→ 显示，写入两处缓存；
 *  ③ **只有以上都没有**且在线 → 向 CDN 要 `/0` 原图；取回写两处；
 *  ④ 本机缩略图兜底 —— 刻意放在最后，且 `thumb: true` 永不覆盖原图。
 *
 * 为什么不再「有网先 CDN」：用户明确要求「先用本地显示，然后再使用 CDN」。而 md5 是
 * 内容寻址，本地那份一旦是原图就与 CDN 同一张，先看本地不会看到「旧的、缩略的图」；
 * 只有本地没有原图时才需要出网。无网时跳过 ③，行为与之前一致。
 *
 * ## 缩略图为什么仍放最后
 *
 * `msg/attach` 里的 `_t/_h/_b` 缩略图一旦排在原图/ CDN 之前，就会永久遮住高清图；
 * 这里只有 ①②③ 都失败才拿它，且前端按 `thumb` 标记，下一轮仍会来要原图。
 *
 * @param rc - 运行上下文（只用 `dirs()` 与 `rawWechatBase()`）。
 * @param options - 见 {@link SnsImageOptions}。
 * @returns 图片 data URL；各路都失败时把原因合并，便于区分「本地没有」与「CDN 失败」。
 */
async function snsImageWithCdnFirst(
  rc: { dirs: () => { decrypted: string; decoded: string }; rawWechatBase: (decrypted: string) => string },
  options: SnsImageOptions,
  keys: { aesKey: string | undefined; xorKey: number },
): Promise<ImageDataUrlResult> {
  const dirs = rc.dirs()
  const base = rc.rawWechatBase(dirs.decrypted) || undefined
  const { aesKey, xorKey } = keys
  const url = String(options.url ?? '')
  const token = String(options.token ?? '')
  const seed = String(options.seed ?? '')
  const decoded = dirs.decoded
  const offline = options.offline === true
  // 追踪：卡片只显示默认文案时，唯一能取证的地方就是这里（应用日志 app.log）
  const tag = '[sns-image] md5=' + options.md5.slice(0, 8) + (offline ? ' [无网]' : '')
  const hasCdn = url !== '' && token !== '' && seed !== ''

  /** 本机那条：`allowThumb=false` 只要原图，`true` 连缩略图一起收。 */
  const local = async (allowThumb: boolean) =>
    resolveSnsImageDataUrl(base, aesKey, xorKey, options.md5, options.timelineId, options.mediaId, allowThumb)

  // ⓪ 长期归档：跨密钥/重启保留的那份。命中即最终结果（同一 md5 = 同一张原图）。
  const archived = lookupArchivedOriginal(decoded, options.md5)
  if (archived !== null) {
    console.error(tag + ' 长期归档原图（长度 ' + String(archived.bytes.length) + '）')
    return { url: originalAsDataUrl(archived) }
  }

  // ① 解码缓存里的原图（同一台机器的快路径），顺手补写长期归档。
  const stored = lookupOriginal(decoded, options.md5)
  if (stored !== null) {
    saveArchivedOriginal(decoded, options.md5, stored.bytes)
    console.error(tag + ' 已下载的原图（长度 ' + String(stored.bytes.length) + '，已补写长期归档）')
    return { url: originalAsDataUrl(stored) }
  }

  // ② 微信原始目录里的原图：落地即写穿两处缓存。
  const localOriginal = await local(false)
  if (localOriginal.url) {
    console.error(tag + ' 本机原图（长度 ' + String(localOriginal.url.length) + '）')
    saveOriginalFromDataUrl(decoded, options.md5, localOriginal.url)
    return localOriginal
  }

  // ③ 本地确实没有原图，才出网。离线时跳过（避免白等一个超时窗口）。
  if (!offline && hasCdn) {
    // ⚠️ 这里原先跟着一句「整份 XOR 用我们这份 WxIsaac64 构建做不到」的断言，那是错的：
    // 2026-10-08 真库/真网/真 WASM 测过两份 WASM 同一份、分块与一次性生成逐字节相同、
    // 9/9 张都解出合法 JPEG。真正病因曾是 `sns-cdn-image.ts` 的结尾判据过严（CDN 在
    // EOI 后挂 24 字节签名块），已修。别再照那句旧断言去换二进制。
    const cdn = await fetchSnsCdnImage(url, token, seed)
    if (cdn.dataUrl) {
      saveOriginalFromDataUrl(decoded, options.md5, cdn.dataUrl)
      console.error(tag + ' CDN 原图（长度 ' + String(cdn.dataUrl.length) + '，已落盘）')
      return { url: cdn.dataUrl }
    }
    console.error(tag + ' CDN 失败：' + String(cdn.error))
  } else if (!offline) {
    console.error(tag + ' 缺 CDN 三件套（url/token/seed），只能走本机')
  }

  // ④ 本机缩略图兜底 —— 顺序上刻意放在最后。
  const localThumb = await local(true)
  if (localThumb.url) {
    console.error(tag + ' 本机缩略图兜底（长度 ' + String(localThumb.url.length) + '）')
    // ⚠️ 刻意**不**写穿：缩略图进了落盘缓存就会变成永久的「高清」，正好毁掉这次的目的。
    // `thumb: true` 让前端**不把它当高清缓存**，于是原图下次取到时能覆盖它。
    return { url: localThumb.url, thumb: true }
  }

  console.error(tag + ' 各路都失败：本机原图=' + String(localOriginal.error)
    + ' / CDN=' + (hasCdn ? '见上' : '未配置')
    + ' / 本机缩略图=' + String(localThumb.error))
  return { error: (localOriginal.error ?? '本地解码失败')
    + '；CDN：' + (hasCdn ? '取图失败' : '缺少 CDN 三件套') }
}

/**
 * 取一条朋友圈视频的封面。
 *
 * ⚠️ 图片那路已在 2026-10-19 改为**本地优先**（见 `snsImageWithCdnFirst`）；封面这条仍
 * 保留原来的「先网后本」：本机封面命中时先本机也能省一次出网，但封面不是原图归档的
 * 对象，先不改它的判据，避免把视频封面的缓存语义与图片原图混在一起。
 *
 * ⚠️ 封面地址（XML 里的 `<thumb>`）**自带 `token` 与 `idx=1`**，不像图片那样要再拼一次，
 * 所以这里不做 `snsCdnUrl` 归一，只过白名单（M23：只判协议等于「谁给后端一个地址，后端
 * 就去取谁」）。
 */
/** 一条封面请求（W2-5.6）。`md5` 是批内与返回对齐用的标识。 */
export interface SnsVideoCoverBatchItem {
  md5?: string
  timelineId?: string
  mediaId?: string
  thumb?: string
  key?: string
}

/** 批量封面请求。`offline` 整批共用（一条列表里的网络状况是同一个）。 */
export interface SnsVideoCoverBatchOptions {
  items: SnsVideoCoverBatchItem[]
  offline?: boolean
}

/** 批量封面结果：与 `items` **同序**、同长（少一条就对不上号，宁可补一条带 error 的）。 */
export interface SnsVideoCoverBatchResult {
  items: Array<{ md5: string; url?: string; error?: string }>
}

/**
 * CDN 取回的并发上限。
 *
 * 取 4 的理由与 KB 抽取那条同源：这些是**网络**往返（200ms+）不是 CPU 活，
 * 串行会把一屏 20 条封面拉成 4 秒以上；再往上就逼近厂商速率限制，得不偿失。
 */
const SNS_COVER_FETCH_CONCURRENCY = 4

/**
 * 取长期归档里的视频封面（2026-10-19：封面也按本地优先保留）。
 * @param decoded - 解码缓存根。
 * @param md5 - 视频 md5（封面与视频共键）。
 * @returns data URL；没有归档时为 null。
 */
function archivedCoverDataUrl(decoded: string, md5: string | undefined): string | null {
  const key = String(md5 ?? '').trim().toLowerCase()
  if (key === '') return null
  const hit = lookupArchivedOriginal(decoded, key)
  return hit === null ? null : originalAsDataUrl(hit)
}

/**
 * 把封面写进长期归档（本地/ CDN 取到的都写），下次先读它。
 * @param decoded - 解码缓存根。
 * @param md5 - 视频 md5。
 * @param url - data URL。
 */
function rememberCover(decoded: string, md5: string | undefined, url: string): void {
  const key = String(md5 ?? '').trim().toLowerCase()
  if (key !== '' && url.startsWith('data:image/')) saveOriginalFromDataUrl(decoded, key, url)
}

/**
 * 一批朋友圈视频封面（W2-5.6）。
 *
 * 实测（合成数据，`sns-cover-batch.measure.spec.ts`）：**批量化不改变单条解析的成本**，
 * 瓶颈在整月扫 md5，而那本来就由按月索引摊掉了。真正的差别是两条：
 *   ① `snsMonthRoots` 的列举 —— 逐条每条重列一遍 `cache/` 并 stat 每个月份，
 *      实测 240 个月时逐条 1978ms vs 批量 77ms（**25.7×**）；12 个月时只有 1.1×
 *      （月少、文件多时瓶颈换成了扫描，列举本来就便宜）。
 *   ② CDN 取回的并发 —— 逐条是串行的，一批里只发一条。
 * @param rc - 媒体域上下文。
 * @param options - 一批请求 + 是否离线。
 * @returns 与 `items` 同序同长的结果。
 */
async function snsVideoCoversBatchIn(rc: MediaRemoteCtx, options: SnsVideoCoverBatchOptions): Promise<SnsVideoCoverBatchResult> {
  const items = Array.isArray(options?.items) ? options.items.slice(0, 200) : []
  if (items.length === 0) return { items: [] }
  const base = rc.rawWechatBase(rc.dirs().decrypted) || undefined
  const decoded = rc.dirs().decoded
  // 解析一次：一整批只列举一次月份根（这正是 25.7× 的来源）。
  const md5s = items.map((it) => String(it?.md5 ?? '').trim().toLowerCase())
  const local = await resolveSnsVideoCoverDataUrlsAsync(base, md5s)
  const offline = options.offline === true

  // 2) 本机没有的才去 CDN；白名单判在**发请求之前**（M23），离线一律不去。
  const needCdn: number[] = []
  const out = items.map((it, i) => {
    const md5 = md5s[i] ?? ''
    const archived = archivedCoverDataUrl(decoded, md5)
    if (archived !== null) return { md5, url: archived }
    const hit = local.get(md5)
    const remote = String(it?.thumb ?? '').trim()
    if (hit?.url) {
      rememberCover(decoded, md5, hit.url)
      return { md5, url: hit.url }
    }
    if (offline || remote === '' || !/^https?:\/\//i.test(remote)) {
      const why = offline ? '无网：只用本机' : (hit?.error ?? '缺封面远端地址，只能走本机')
      if (!offline && remote !== '' && !wechatCdnHostAllowed(remote)) {
        return { md5, error: `${hit?.error ?? '本机没有该封面'}；封面地址的主机不在微信 CDN 清单内，已拒绝请求` }
      }
      return { md5, error: typeof hit?.error === 'string' ? hit.error : why }
    }
    if (!wechatCdnHostAllowed(remote)) {
      return { md5, error: `${hit?.error ?? '本机没有该封面'}；封面地址的主机不在微信 CDN 清单内，已拒绝请求` }
    }
    needCdn.push(i)
    return { md5, error: hit?.error ?? '' }
  })

  // 3) 有界并发取回：worker 原子认领下一条。
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next
      next += 1
      if (i >= needCdn.length) return
      const it = items[i]
      const fetched = await fetchSnsCoverDataUrl(String(it?.thumb ?? '').trim(), { version: weixinVersion(), seed: it?.key })
      if (fetched.url) {
        rememberCover(decoded, md5s[i] ?? '', fetched.url)
        out[i] = { md5: md5s[i] ?? '', url: fetched.url }
        continue
      }
      // CDN 没取到：退回本机那条的说明（哪怕它本来就是空串也不要凭空报错）。
      const keep = out[i]
      out[i] = { md5: keep?.md5 ?? '', error: fetched.error ?? keep?.error ?? '封面取回失败' }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SNS_COVER_FETCH_CONCURRENCY, Math.max(needCdn.length, 1)) }, () => worker()))
  return { items: out }
}

async function snsVideoCoverWithCdnFirst(
  rc: MediaRemoteCtx,
  options: { md5?: string; timelineId?: string; mediaId?: string; thumb?: string; key?: string; offline?: boolean },
): Promise<ImageDataUrlResult> {
  const base = rc.rawWechatBase(rc.dirs().decrypted) || undefined
  const decoded = rc.dirs().decoded
  const archived = archivedCoverDataUrl(decoded, options.md5)
  if (archived !== null) return { url: archived }
  const local = await resolveSnsVideoCoverDataUrlAsync(base, options.md5, options.timelineId, options.mediaId)
  const offline = options.offline === true
  const remote = typeof options.thumb === 'string' ? options.thumb.trim() : ''
  const tag = '[sns-cover] md5=' + String(options.md5 ?? '').slice(0, 8) + (offline ? ' [无网]' : '')

  if (!offline && remote !== '' && /^https?:\/\//i.test(remote)) {
    if (!wechatCdnHostAllowed(remote)) return { error: `${local.error ?? '本机没有该封面'}；封面地址的主机不在微信 CDN 清单内，已拒绝请求` }
    const fetched = await fetchSnsCoverDataUrl(remote, { version: weixinVersion(), seed: options.key })
    if (fetched.url) {
      console.error(tag + ' CDN 封面（长度 ' + String(fetched.url.length) + '）')
      rememberCover(decoded, options.md5, fetched.url)
      return fetched
    }
    console.error(tag + ' CDN 封面失败：' + String(fetched.error ?? ''))
    rc.op('task', 'sns_cover_fetch', 'fail', '', fetched.error ?? '')
  } else if (offline) {
    console.error(tag + ' 无网：只用本机')
  } else {
    console.error(tag + ' 缺封面远端地址，只能走本机')
  }
  if (local.url) rememberCover(decoded, options.md5, local.url)
  return local
}
