/**
 * `types.ts` 的 analytics 部分（M21 拆分；纯类型，无运行期值）。
 *
 * 从 `types.ts` 原样搬出，`types.ts` 继续以 `export *` 转发 ⇒ 所有
 * `from './types.ts'` / `from '../types.ts'` 的导入路径一行都不用改。
 *
 * @module types-analytics
 */
import type { SearchIndexStatus } from './types-panels.ts'

/** One group member activity row in offline group insights. */
export interface GroupInsightsMember {
  username: string
  name: string
  count: number
}

/** Offline group insights snapshot for one chatroom. */
export interface GroupInsightsSnapshot {
  username: string
  name: string
  memberCount: number
  total: number
  activeDays: number
  from: number | null
  to: number | null
  avgPerDay: number
  announcement: string
  announcementTime: number | null
  topMembers: GroupInsightsMember[]
}

/** One plugin store file in the data-health view. */
export interface DbHealthStore {
  name: string
  size: number
}

/** Data health snapshot: decrypted DB walk + plugin stores + index status. */
export interface DbHealthSnapshot {
  dbFiles: number
  dbBytes: number
  walFiles: number
  shmFiles: number
  searchIndex: SearchIndexStatus
  stores: DbHealthStore[]
  decodedImagesCount: number
  decodedImagesBytes: number
  updatedAt: number
}

/** One interactor (liker/commenter) aggregation row in moments insights. */
export interface MomentsInteractorRow {
  username: string
  nickname: string
  count: number
}

/** "On this day" moment row for the moments insights view. */
export interface MomentsTodayRow {
  tid: string
  text: string
  ts: number
  author: string
}

/** One row of the moments "new activity" reminder list (`SnsTopItem_1`). */
export interface MomentsTopItemRow {
  username: string
  /** Display name (remark > nickname > username), resolved via contactMeta. */
  name: string
  /** How many of this friend's posts entered the reminder list. */
  count: number
  /** Rows with `is_read = 0`. */
  unread: number
  /** Rows whose tid is no longer in SnsTimeLine (post deleted / made private). */
  vanished: number
  lastRead: number
}

/**
 * Moments reminder-list aggregates (`SnsTopItem_1`).
 *
 * 口径（本机实测）：`summary` 恒为空、`last_read_time` 全量只有一个取值（一次批量已读），
 * 所以只暴露三个站得住的数字 + 每人明细。`vanished` = 「提醒过、现在时间线上已经看不到」。
 */
export interface MomentsTopItems {
  rows: number
  users: number
  unread: number
  vanished: number
  top: MomentsTopItemRow[]
}

/** One 朋友圈 posted from a place (`<location poiName>`), with corrected coordinates. */
export interface MomentsPlaceRow {
  name: string
  city: string
  count: number
  /** 真实纬度（moments XML 里 latitude/longitude 属性是**反的**，这里已换回）。 */
  lat: number
  lng: number
}

/** 朋友圈足迹：城市/国家分布与打卡地点排行。 */
export interface MomentsGeo {
  /** 带坐标的条数（等于 `pointList.length`）。 */
  points: number
  cities: Array<{ city: string; count: number }>
  countries: Array<{ country: string; count: number }>
  places: MomentsPlaceRow[]
  /**
   * 每条带坐标朋友圈的定位点，**已修正**微信写反的 latitude/longitude
   * （`lat` 为真实纬度、`lng` 为真实经度），可直接投影到地图。
   * 不去重：同一点打卡多次就是多个点，聚合与否交给展示层决定。
   */
  pointList: MomentsGeoPoint[]
}

/** 一条带坐标朋友圈的定位点（lat/lng 已修正，非原始属性值）。 */
export interface MomentsGeoPoint {
  lat: number
  lng: number
  city: string
  poi: string
}

/** Moments insights snapshot for an author (usually self). */
export interface MomentsInsightsSnapshot {
  author: string
  posts: number
  likes: number
  comments: number
  likedBy: MomentsInteractorRow[]
  commenters: MomentsInteractorRow[]
  monthly: Array<{ month: string; count: number }>
  today: MomentsTodayRow[]
  /** 朋友圈「新动态提醒」统计（与 author 过滤无关，永远是本机的提醒清单）。 */
  topItems?: MomentsTopItems
  /** 朋友圈足迹（城市/国家/打卡地点；坐标已修正属性反置）。 */
  geo?: MomentsGeo
  updatedAt: number
}

/** One favorite-type count row in asset insights. */
export interface AssetTypeRow {
  type: number
  label: string
  count: number
}

/** One favorite-year count row in asset insights. */
export interface AssetYearRow {
  year: number
  count: number
}

/** One emoticon usage row in asset insights. */
export interface AssetEmoticonUsage {
  md5: string
  count: number
}

/** Combined favorites/emoticon asset insights snapshot. */
export interface AssetInsightsSnapshot {
  favorites: {
    total: number
    byType: AssetTypeRow[]
    byYear: AssetYearRow[]
  }
  emoticons: {
    customCount: number
    storePackages: number
    captions: number
    topUsed: AssetEmoticonUsage[]
  }
  updatedAt: number
}

/** One official account asset row. */
export interface OfficialAssetRow {
  username: string
  name: string
  messages: number
  articles: number
  lastArticleTime: number | null
}

/** Official account content asset snapshot. */
export interface OfficialAssetsSnapshot {
  rows: OfficialAssetRow[]
  total: number
  updatedAt: number
}

/** One media category count/size row in media assets. */
export interface MediaAssetCategory {
  category: string
  count: number
  size: number
}

/** One duplicate md5 row in media assets. */
export interface MediaAssetDuplicate {
  md5: string
  count: number
  size: number
  reclaimBytes: number
}

/** Media assets snapshot: hardlink categories, sizes and duplicates. */
export interface MediaAssetsSnapshot {
  categories: MediaAssetCategory[]
  duplicates: MediaAssetDuplicate[]
  totalFiles: number
  totalBytes: number
  duplicateFiles: number
  duplicateBytes: number
  reclaimBytes: number
  updatedAt: number
}
