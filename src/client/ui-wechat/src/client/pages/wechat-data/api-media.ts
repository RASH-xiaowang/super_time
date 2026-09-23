/**
 * `api.ts` 的「媒体取用：朋友圈图/文件图/表情/原图/视频与封面、诊断日志、对话框、文章封面，含批量取图队列」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module api-media
 */

import type {
  AccountsSnapshot,
  AnnualReport,
  AnnualSnapshot,
  AssetInsightsSnapshot,
  AutoDbKeyResult,
  AutoImageKeyResult,
  AskHistoryClearResult,
  AskHistoryDeleteResult,
  AskHistoryQuery,
  AskHistorySnapshot,
  AskOptimizeResult,
  AskResult,
  ReplySuggestResult,
  AvatarResult,
  BackupMutationResult,
  BackupRestoreResult,
  BackupPreviewSnapshot,
  ExportHistoryDeleteResult,
  ExportHistoryPruneOptions,
  ExportHistoryQuery,
  ExportHistorySnapshot,
  BackupSnapshot,
  CalendarSnapshot,
  ChatHistoryResolveResult,
  ConfigSnapshot,
  Contact360Snapshot,
  ContactsSnapshot,
  DailySummaryResult,
  DbHealthSnapshot,
  DbStatusSnapshot,
  DecryptAllResult,
  DecryptImagesResult,
  DecryptStatus,
  DeleteFavoriteResult,
  DraftClearResult,
  DraftsClearResult,
  EditMutationResult,
  EditedListSnapshot,
  EmoticonsSnapshot,
  ExportResult,
  FavoritesSnapshot,
  FilesSnapshot,
  GenerateKeysResult,
  CallsSnapshot,
  GraphSnapshot,
  GroupInfoSnapshot,
  GroupInsightsSnapshot,
  HandoffRemindsSnapshot,
  ImageDataUrlResult,
  KeysInfoResult,
  LedgerSnapshot,
  MediaAssetsSnapshot,
  MemberSearchSnapshot,
  MessagesSnapshot,
  MomentsInsightsSnapshot,
  MomentsMonthlyRow,
  MomentsSnapshot,
  OfficialAssetsSnapshot,
  OverviewInsights,
  OverviewSnapshot,
  RegionMapSnapshot,
  OperationLogClearResult,
  OperationLogQuery,
  OperationLogSnapshot,
  PaymentStatus,
  PeriodSummaryResult,
  PrivacyAuditClearResult,
  PrivacyAuditRow,
  PrivacySnapshot,
  PrivacyStateSnapshot,
  RecordsSnapshot,
  RevokedSnapshot,
  SearchBuildResult,
  SearchIndexStatus,
  SearchSnapshot,
  SessionsSnapshot,
  SimpleResult,
  StorageSnapshot,
  SummaryRecordSnapshot,
  SummaryTask,
  SummaryTaskMutationResult,
  SummaryTaskRunResult,
  SummaryTaskSnapshot,
  TaskMutationResult,
  TasksSnapshot,
  UnifiedSearchSnapshot,
  VerifyImageKeyResult,
  VerifyKeyResult,
  VideoInfoResult,
  VoiceInfoResult,
  VoiceTranscriptResult,
  VoiceTranscribeOneResult,
  VoiceTranscribeResult,
  WechatConfigFull,
  WechatConfigPatch,
  WhisperDownloadResult,
  WhisperStatus,
} from '@deepseek-ai/dsh-wechat-data/types'
import {
  cachedFetch,
  cachedGet,
  invalidateSnapshotCache,
  invalidateWechatCache,
  readRenderCache,
  snapshotDelete,
  subscribeSnapshot,
  writeRenderCache,
} from './cache.ts'
import { createImageLoadQueue } from './image-batch.ts'
import { ImageDataUrlBatchItem, remote, unwrap } from './api-core.ts'
// 类型单独一行：`isolatedModules` 下 esbuild 不会替我们从混合行里删掉类型（M21 踩过，见 RELEASE-PLAN）
import type { RemoteImageItem } from './api-core.ts'

/**
 * Resolve an image message to a data URL.
 * @param options - Query options: username and message localId.
 * @returns ImageDataUrlResult.
 */
export async function apiGetSnsImageDataUrl(options: { md5: string; timelineId?: string; mediaId?: string }): Promise<ImageDataUrlResult> {
  return unwrap(await remote().getSnsImageDataUrl(options))
}
/**
 * Resolve a file-library image (hardlink md5) to a data URL.
 * 优先读已解密缓存，否则定位 .dat 原图解密。
 * @param options - file md5.
 * @returns ImageDataUrlResult.
 */
export async function apiGetFileImageDataUrl(options: { md5: string }): Promise<ImageDataUrlResult> {
  return unwrap(await remote().getFileImageDataUrl(options))
}
/**
 * Resolve a custom emoticon (sticker) md5 to a data URL.
 * @param options - emoticon md5 from message XML.
 * @returns ImageDataUrlResult.
 */
export async function apiGetEmoticonDataUrl(options: { md5: string; emojiUrl?: string }): Promise<ImageDataUrlResult> {
  return cachedGet('emoticon:' + options.md5, async () => unwrap(await remote().getEmoticonDataUrl(options)))
}

/**
 * 取一条图片消息的**原图**（只覆盖消息里带免登录预签名直链 `tpurl` 的那部分，约 16%）。
 *
 * 故意**不走 `cachedGet`**：这是一次会改变本机状态的动作（原图落进 decoded 缓存），
 * 缓存结果会让第二次点击什么都不做。成功后界面重新调 `apiGetImageDataUrl` 即可拿到原图 ——
 * 那条路是攒批队列、不缓存返回值，而后端第一站读的就是刚落盘的那个缓存槽。
 * @param options - 会话 username 与消息 localId。
 * @returns `{ok:true, format, bytes}` 或 `{ok:false, error}`；`error` 是可以直接显示给用户的话。
 */
export async function apiGetImageOriginal(options: { username: string; localId: number }): Promise<{ ok: boolean; format?: string; bytes?: number; note?: string; error?: string }> {
  return unwrap(await remote().getImageOriginal(options))
}

/**
 * 远程图片代理（M23）：一次问一批「只在微信 CDN 上」的图片地址，拿回按 url 建键的 Map。
 *
 * 为什么要走后端而不是让 `<img>` 直接吃那个 https 地址：那等于把「渲染层可以向任意主机发请求」
 * 写进产品里 —— 界面上的「自动获取原图（CDN）」与「禁止出网」两个开关管不到它，操作记录里也
 * 查不到它，同一次滚动还会反复要同一张图。
 *
 * 故意**不走 `cachedGet`**：缓存已经有两处（后端 `<decoded>/remote-images/` 与渲染层的 IndexedDB
 * 媒体缓存），这里再叠一层内存 Map 只会让「关掉开关之后到底还发不发请求」说不清。
 * @param urls - 图片地址列表；去重与单次上限由后端负责，超出的条目带着 `error` 回来。
 * @returns `url → 结果` 的 Map，调用方按自己那批地址逐个查。
 */
export async function apiGetRemoteImages(urls: string[]): Promise<Map<string, RemoteImageItem>> {
  const r = unwrap(await remote().getRemoteImages({ urls }))
  const byUrl = new Map<string, RemoteImageItem>()
  for (const item of r.items ?? []) byUrl.set(item.url, item)
  return byUrl
}

/** 一次代理请求最多带几张（与后端 `remote-image.ts` 的 `MAX_IMAGES_PER_CALL` 对齐；超了后端会整条回错误）。 */
const REMOTE_IMAGE_CHUNK = 40
/** 进程内 `源地址 → data URL` 的上限：来回滚动不该反复 RPC + 重新 base64。 */
const REMOTE_IMAGE_MEM_MAX = 600
/**
 * 「后端整个没答上」的地址在这么久内不再重试。
 *
 * 只兜住这一种：那种时候再问也不会有别的结果，而列表组件每次重渲染都会把同一批地址再送一遍。
 * 后端明确回了失败原因（开关关掉 / 主机不在清单 / CDN 失败）的情况**不在这里冷却** ——
 * 后端自己有 60 秒冷却，而开关随时可能被用户打开，客户端再拦一道就变成「重新开启开关后
 * 一分钟图片还是不出来」。
 */
const REMOTE_IMAGE_FAIL_COOLDOWN_MS = 60_000
const remoteImageUrlCache = new Map<string, string>()
const remoteImageFailedAt = new Map<string, number>()

/**
 * 攒批队列：同一 tick 里挂出来的 N 张远程图合成**一次** `getRemoteImages`。
 *
 * 复用 N16 那套 {@link createImageLoadQueue}（合并/分块/失败传播都已单测）。差别只有两处：
 * 键是 URL 而不是 (会话, 消息)，且 **flush 回填按 URL 查表**而不是按下标 —— 后端会去重，
 * 返回条数可能少于入参条数，按下标回填会把后面的条目错接到前面那张图上。
 */
const remoteImageQueue = createImageLoadQueue<string, RemoteImageItem>({
  chunkSize: REMOTE_IMAGE_CHUNK,
  onMissing: (url) => ({ url, error: '批量代理未返回该条目' }),
  flush: async (keys) => {
    const byUrl = await apiGetRemoteImages([...keys])
    return keys.map((k) => byUrl.get(k) ?? { url: k, error: '批量代理未返回该条目' })
  },
})

/**
 * 把一张「只有远程地址」的图换成能画进 `<img>` 的地址（M23）。
 *
 * 为什么不让 `<img src=https://…>` 继续存在：那等于把「渲染层可以向任意 https 主机发请求」
 * 写进产品，界面上那两个出网开关都管不到它。走后端之后：开关生效、可审计、有缓存。
 *
 * 失败（开关关掉、主机不在白名单、取回出错）一律回**空串**，由调用方按「这张没有封面」处理 ——
 * 回一个破图地址比回空串更糟：用户看不到「为什么没有」，只会看到一堆坏图标。
 * @param source - 消息里的图片地址；空串原样回空串（调用方已判过 `cspSafeSrc`）。
 * @returns 可直接给 `<img src>` 的 data URL，或空串。
 */
export async function apiGetRemoteImageUrl(source: string): Promise<string> {
  const url = String(source ?? '').trim()
  if (url === '') return ''
  const hit = remoteImageUrlCache.get(url)
  if (hit !== undefined) return hit
  const failedAt = remoteImageFailedAt.get(url)
  if (failedAt !== undefined && Date.now() - failedAt < REMOTE_IMAGE_FAIL_COOLDOWN_MS) return ''
  let item: RemoteImageItem
  try {
    item = await remoteImageQueue.enqueue(url)
  } catch {
    // 只对「后端整个没答上」做客户端冷却：那种情况再问也不会有别的结果，而列表每次重渲染
    // 都会把同一批地址再送一遍。**后端明确回了失败原因**（开关关掉 / 主机不在清单 / CDN 失败）
    // 时不在这里冷却 —— 后端自己有 60 秒冷却，而开关随时可能被用户打开，这里再拦一道
    // 就会变成「重新开启开关后有一分钟图片还是不出来」那种莫名延迟。
    remoteImageFailedAt.set(url, Date.now())
    return ''
  }
  const dataUrl = item.dataUrl ?? ''
  if (dataUrl === '') return ''
  if (remoteImageUrlCache.size >= REMOTE_IMAGE_MEM_MAX) {
    const oldest = remoteImageUrlCache.keys().next().value
    if (oldest !== undefined) remoteImageUrlCache.delete(oldest)
  }
  remoteImageUrlCache.set(url, dataUrl)
  return dataUrl
}
/**
 * Resolve a moments video cover to a data URL (offline Sns/Video jpg).
 * @param options - media md5 / timeline id / media id.
 * @returns ImageDataUrlResult.
 */
export async function apiGetSnsVideoCoverDataUrl(options: {
  md5?: string
  timelineId?: string
  mediaId?: string
  /** XML 里的 `<thumb>`：本机没缓存时按需从 CDN 取回（后端会解密）。 */
  thumb?: string
  /** XML 里的 `<enc key>`：CDN 加密流的解密种子。 */
  key?: string
}): Promise<ImageDataUrlResult> {
  return unwrap(await remote().getSnsVideoCoverDataUrl(options))
}
/**
 * Resolve a moments video body to an offline data URL for inline playback.
 * @param options - media md5 / timeline id / media id.
 * @returns ImageDataUrlResult.
 */
export async function apiGetSnsVideoDataUrl(options: { md5?: string; timelineId?: string; mediaId?: string; url?: string; key?: string }): Promise<ImageDataUrlResult> {
  return unwrap(await remote().getSnsVideoDataUrl(options))
}

/**
 * 把一条朋友圈视频写到用户选定路径（本机缓存优先，否则 CDN 取回+解密，都在后端完成）。
 * @param options - 缓存键 / 远端地址与 `<enc key>` / 目标路径。
 * @returns ok + 字节数，或错误说明。
 */
export async function apiExportSnsVideo(options: {
  md5?: string; timelineId?: string; mediaId?: string; url?: string; key?: string; dest: string
}): Promise<{ ok: boolean; bytes?: number; source?: string; error?: string }> {
  return unwrap(await remote().exportSnsVideo(options))
}

/** 弹出保存对话框并返回选定路径（写盘由后端做）。 */
/**
 * 诊断日志信息（M6）：日志目录与各份轮转文件大小。
 * @returns 目录、当前文件与各份大小。
 */
export async function apiDiagLogInfo(): Promise<{
  ok: boolean; dir?: string; current?: string; files?: Array<{ name: string; size: number }>; error?: string
}> {
  const api = (window as unknown as { electronAPI?: { diag?: { logInfo?: () => Promise<{ ok: boolean; dir?: string; current?: string; files?: Array<{ name: string; size: number }>; error?: string }> } } }).electronAPI
  if (!api?.diag?.logInfo) return { ok: false, error: '当前环境不支持诊断日志' }
  return api.diag.logInfo()
}

/**
 * 导出诊断日志（主进程弹出保存对话框，并把所有轮转文件 + 环境信息拼成一个文件）。
 * @returns ok/path/bytes，或 canceled，或 error。
 */
export async function apiExportDiagLog(): Promise<{ ok: boolean; path?: string; bytes?: number; canceled?: boolean; error?: string }> {
  const api = (window as unknown as { electronAPI?: { diag?: { exportLog?: () => Promise<{ ok: boolean; path?: string; bytes?: number; canceled?: boolean; error?: string }> } } }).electronAPI
  if (!api?.diag?.exportLog) return { ok: false, error: '当前环境不支持导出诊断日志' }
  return api.diag.exportLog()
}

/**
 * 在文件管理器中定位日志文件。
 * @returns ok，或错误说明。
 */
export async function apiRevealDiagLog(): Promise<{ ok: boolean; path?: string; error?: string }> {
  const api = (window as unknown as { electronAPI?: { diag?: { revealLog?: () => Promise<{ ok: boolean; path?: string; error?: string }> } } }).electronAPI
  if (!api?.diag?.revealLog) return { ok: false, error: '当前环境不支持定位日志文件' }
  return api.diag.revealLog()
}

/** 弹出保存对话框并返回选定路径（写盘由后端做）。 */
export async function apiSaveFileDialog(opts: {
  defaultName?: string; title?: string; filters?: Array<{ name: string; extensions: string[] }>
}): Promise<{ canceled: boolean; path: string | null }> {
  const api = (window as unknown as { electronAPI?: { saveFileDialog?: (o: unknown) => Promise<{ canceled: boolean; path: string | null }> } }).electronAPI
  if (!api?.saveFileDialog) return { canceled: true, path: null }
  return api.saveFileDialog(opts)
}
/**
 * Resolve a 公众号 article cover (og:image) to a data URL.
 * @param options - mp.weixin.qq.com article URL.
 * @returns ImageDataUrlResult.
 */
export async function apiGetArticleCover(options: { contentUrl: string }): Promise<ImageDataUrlResult> {
  return unwrap(await remote().getArticleCover(options))
}
/**
 * Resolve a received message file (msg/file) to a data URL.
 *
 * `size` / `createTime` 来自消息本体（appmsg `<totallen>` 与 create_time）：
 * `msg/file` 只按月份分目录、同名文件可能属于别的会话，带上这两条线索
 * 才能在候选里挑出属于这条消息的那一份。
 * @param options - original file name plus attribution hints from the message.
 * @returns ImageDataUrlResult.
 */
export async function apiGetMessageFile(options: { fileName: string; size?: number; createTime?: number }): Promise<ImageDataUrlResult> {
  return unwrap(await remote().getMessageFile(options))
}

/** 一批取图里的分块上限（与后端 `IMAGE_BATCH_MAX` 对齐：超出的分多次发）。 */
export const IMAGE_BATCH_CHUNK = 200

/** 把一个批量条目收敛成单张入口的形状（字段有则带、无则不带）。 */
export function toImageResult(item: ImageDataUrlBatchItem | undefined): ImageDataUrlResult {
  if (!item) return { error: '批量取图未返回该条目' }
  return {
    ...(item.url ? { url: item.url } : {}),
    ...(item.format ? { format: item.format } : {}),
    ...(item.error ? { error: item.error } : {}),
  }
}

/**
 * 取图合并队列（N16）：合并语义在 `./image-batch.ts`，这里只把 `flush` 接到批量 RPC 上。
 *
 * 为什么合并发生在 api 层而不是各面板：列表型取图的面板（聊天的 `MessageThumb`、图片组
 * 网格）是「一屏挂 N 个组件、每个组件各自取图」，逐处改要动好几处调用点；它们全部经过
 * {@link apiGetImageDataUrl}，在这里攒批能让它们**一行都不用改**吃到批量入口。
 */
export const imageLoadQueue = createImageLoadQueue<{ username: string; localId: number }, ImageDataUrlResult>({
  chunkSize: IMAGE_BATCH_CHUNK,
  onMissing: () => ({ error: '批量取图未返回该条目' }),
  flush: async (keys) => {
    const r = unwrap(await remote().getImageDataUrlsBatch({ items: keys.map(k => ({ username: k.username, localId: k.localId })) }))
    const got = Array.isArray(r?.items) ? r.items : []
    return got.map(toImageResult)
  },
})

/**
 * Decode one message image to a data URL.
 *
 * 语义与改前一致（一个请求拿一个 data URL），但**不再是单张 RPC**：同一次渲染提交内的
 * 多个请求会在一个微任务窗口里合并成一次 `getImageDataUrlsBatch`（见 {@link imageLoadQueue}）。
 * 单个请求（大图查看器那类）只多一个微任务延迟。
 * @param options - username and localId of the message image.
 * @returns ImageDataUrlResult.
 */
export function apiGetImageDataUrl(options: { username: string; localId: number }): Promise<ImageDataUrlResult> {
  return imageLoadQueue.enqueue({ username: options.username, localId: options.localId })
}

/**
 * 一次 RPC 解码一批消息图片（N16 的显式入口）。
 *
 * 面板需要「明确按批取图」时用它（例如已知要展示的一屏图片列表）；逐项取图的调用点走
 * {@link apiGetImageDataUrl} 即可 —— 那条路径同样会被合并成批量调用。
 * @param items - 一批 (username, localId)。
 * @returns 与传入顺序一一对应的条目。
 */
export async function apiGetImageDataUrlsBatch(items: Array<{ username: string; localId: number }>): Promise<ImageDataUrlBatchItem[]> {
  const r = unwrap(await remote().getImageDataUrlsBatch({ items }))
  return Array.isArray(r?.items) ? r.items : []
}
