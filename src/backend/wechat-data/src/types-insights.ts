/**
 * `types.ts` 的 insights 部分（M21 拆分；纯类型，无运行期值）。
 *
 * 从 `types.ts` 原样搬出，`types.ts` 继续以 `export *` 转发 ⇒ 所有
 * `from './types.ts'` / `from '../types.ts'` 的导入路径一行都不用改。
 *
 * @module types-insights
 */
import type { SearchHit } from './types-panels.ts'

/** Storage category in the overview. */
export interface OverviewStorageCategory {
  label: string
  count: number
  size: number
}

/** Moments author stat in the overview. */
export interface OverviewMomentsAuthor {
  username: string
  name: string
  posts: number
}

/** One records item (opaque rows, concrete scalar values only). */
export type RecordItem = Record<string, string | number | boolean | null>

/** Records snapshot. */
export interface RecordsSnapshot {
  items: RecordItem[]
  total: number
}

/** One aggregated contact row in the funds ledger. */
export interface LedgerContactRow {
  username: string
  name: string
  count: number
  amount: number
  direction: 'in' | 'out' | 'unknown'
}

/** One fund anomaly row (timeout transfer, returned red packet, ...). */
export interface LedgerWarning {
  kind: 'transfer-timeout' | 'redpacket-returned'
  label: string
  username?: string
  name?: string
  time?: number
  amount?: number
}

/** One shared group in a contact 360 profile. */
export interface Contact360Group {
  username: string
  name: string
  memberCount: number
}

/** Contact 360° profile snapshot: cross-domain stats for one username. */
export interface Contact360Snapshot {
  username: string
  displayName: string
  messages: { count: number; firstTime: number | null; lastTime: number | null }
  moments: { count: number }
  funds: { transfers: number; redpackets: number }
  commonGroups: Contact360Group[]
  updatedAt: number
}

/** One contact hit in unified search. */
export interface UnifiedSearchContact {
  username: string
  name: string
  category: string
}

/** One moments hit in unified search. */
export interface UnifiedSearchMoment {
  username: string
  name: string
  snippet: string
}

/** One favorite hit in unified search. */
export interface UnifiedSearchFavorite {
  id: number
  snippet: string
}

/** One file hit in unified search. */
export interface UnifiedSearchFile {
  fileName: string
  md5: string
  size: number
}

/** One records hit (transfers / red packets) in unified search. */
export interface UnifiedSearchRecord {
  kind: string
  name: string
  session: string
}

/** Unified search snapshot over several local data domains. */
export interface UnifiedSearchSnapshot {
  query: string
  messages: SearchHit[]
  contacts: UnifiedSearchContact[]
  moments: UnifiedSearchMoment[]
  favorites: UnifiedSearchFavorite[]
  files: UnifiedSearchFile[]
  records: UnifiedSearchRecord[]
}

/** Funds ledger snapshot: monthly transfer/red-packet aggregates. */
export interface LedgerSnapshot {
  month: string | null
  summary: {
    transfers: number
    transferIn: number
    transferOut: number
    transferAmountIn: number
    transferAmountOut: number
    redpacketsSent: number
    redpacketsReceived: number
    redpacketAmountSent: number
    redpacketAmountReceived: number
    totalAmountIn: number
    totalAmountOut: number
  }
  byContact: LedgerContactRow[]
  redpacket: {
    sentCount: number
    receivedCount: number
    sentAmount: number
    receivedAmount: number
    bestAmount: number
    avgAmount: number
  }
  warnings: LedgerWarning[]
  updatedAt: number
}

/** One revoked message row (source shape: sender / type_label / content / create_time). */
export interface RevokedItem {
  sender: string
  type_label: string
  content: string
  create_time: number
}

/** Revoked snapshot. */
export interface RevokedSnapshot {
  items: RevokedItem[]
  total: number
}

/** One custom/static emoticon row. */
export interface EmoticonItem {
  md5: string
  item_type?: number
  caption?: string
  /**
   * 取图的 CDN 地址（`kNonStoreEmoticonTable.cdn_url`，回退 `thumb_url`/`tp_url`）。
   *
   * 面板要显示表情真图：本地表情缓存（`business/emoticon/*`、`cache/<月>/Emoticon/*`）
   * 是**加密**文件，项目里没有对应解码器（见 `media-image.ts` 的 `fetchEmoticonRemote`），
   * 所以只能按这个地址下载一次再落进 decoded 缓存。
   */
  cdnUrl?: string
}

/** Emoticons snapshot: custom + static emoticons + store packages. */
export interface EmoticonsSnapshot {
  custom: EmoticonItem[]
  static: EmoticonItem[]
  packages: Array<{ name: string; count: number; thumb?: string }>
  total: number
  /**
   * `custom` 的排序依据（第 36 轮）：
   *  · `'wechat'`  = 按 `kFavEmoticonOrderTable` 的行序，即用户在微信里排定的顺序；
   *  · `'builtin'` = 该表缺失或查询失败，退化为 `kNonStoreEmoticonTable` 的内置行序。
   * 前端据此说明「顺序与微信一致」只在确有其事时才显示，避免无依据的文案。
   */
  orderedBy?: 'wechat' | 'builtin'
}

/** Storage snapshot. */
export interface StorageRank {
  username: string
  name: string
  count: number
  size: number
}

/** One large file entry (name + owning session + size). */
export interface LargeFile {
  name: string
  username: string
  /** 所属会话显示名（通讯录解析，空时回退 username）。 */
  sessionName: string
  create_time: number
  size: number
}

/** Storage snapshot: totals, categories, and optional rankings/large files. */
export interface StorageSnapshot {
  total_size: number
  total_count: number
  categories: OverviewStorageCategory[]
  chats?: StorageRank[]
  senders?: StorageRank[]
  large_files?: LargeFile[]
}
