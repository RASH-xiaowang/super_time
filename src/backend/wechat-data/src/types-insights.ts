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
  /**
   * **只在读失败时出现**（W3-11.4，与 `NotesSnapshotRead` 同一纪律）。
   *
   * 为什么 records 也需要它：`general.db` 不存在时旧实现直接返回空列表 —— 而「本机没有
   * 资金往来」与「数据还没解密/解密不完整」在界面上长得一模一样（都是「暂无记录」）。
   * 首启阶段前者是常态、后者是配置问题，用户需要知道自己该去哪儿。
   */
  readError?: string
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
  /**
   * 某个域**读失败**（库打不开 / 损坏 / 缺表）时的说明。
   *
   * P1-1：这条链此前把「读失败」和「确实没有结果」压成同一个形状（catch 里 return []），
   * 用户看到的是「未找到相关结果」，而真实原因是数据根损坏。本仓已有 `readError` 这个
   * 约定（知识库/媒体那几条快照都在用，且 `read-error-visibility.spec.ts` 会从类型反查
   * 「面板有没有真的读它」），所以这里跟着同一个约定，不再发明第二种形状。
   */
  readError?: string
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
  /**
   * **只在读失败时出现**（W3-11.4）。归档库不存在/打不开时返回空列表是不够的 ——
   * 「没有撤回消息」与「归档库还没建」得分开说（后者随同步 tick 自动补上，前者不会）。
   */
  readError?: string
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
  /**
   * **其他表情包**（2026-10-17 新增）：从消息库里扫出的、**不在 `custom` 里**的表情。
   *
   * 口径：扫全部 `message_*.db` 的 `Msg_*` 表，取 `local_type & 0xFFFFFFFF === 47`（表情）
   * 的行，从 `message_content` 的 XML 里抽 `md5`，按出现次数降序。
   * 再**减去** `custom` 里已有的 md5 —— 用户自己收藏过的表情不该出现在「其他」里。
   *
   * 为什么需要：用户要求「其他表情包请收集其他群聊或个人发送的任何表情包」。
   * 这些表情只存在于消息记录里，`emoticon.db` 的 `kNonStoreEmoticonTable` 里没有。
   */
  others?: EmoticonItem[]
  /** `others` 的总数（去重后的 md5 个数，可能大于 `others.length` 的返回条数）。 */
  othersTotal?: number
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
