/**
 * `types.ts` 的 moments 部分（M21 拆分；纯类型，无运行期值）。
 *
 * 从 `types.ts` 原样搬出，`types.ts` 继续以 `export *` 转发 ⇒ 所有
 * `from './types.ts'` / `from '../types.ts'` 的导入路径一行都不用改。
 *
 * @module types-moments
 */
/** One moments comment entry. */
export interface MomentCommentItem {
  username: string
  nickname: string
  to_username: string
  to_nickname: string
  content: string
  ts: number
  /**
   * Comment-attached image.
   *
   * ⚠️ `token` 与 `seed` 是**取到图的前提**（2026-10-09 加）。实测评论图的裸 `<url>`
   * （不带 `token`/`idx=1`）5/5 全部 HTTP 400、0 字节；经 `snsCdnUrl` 补上后 5/5 HTTP 200。
   * 渲染层要把这两个字段转发给后端才拿得到图，只给 `url` 必然落空。
   */
  image?: { thumb?: string; url?: string; md5?: string; mediaId?: string; token?: string; seed?: string }
}

/** One moments (朋友圈) entry (content XML parsed; CDN media URLs unresolved). */
export interface MomentItem {
  tid: string
  username: string
  author: string
  text: string
  ts: number
  time: string
  media_count: number
  media_desc: string
  images: Array<{ thumb: string; url: string; key: string; md5: string; token?: string; id?: string; timelineId?: string }>
  videos: Array<{ url: string; thumb: string; key: string; md5: string; token?: string; duration: number; id?: string; timelineId?: string }>
  location: string
  /** 位置的城市名（`<location city="南宁市">`）。 */
  city?: string
  /** 国家名（`<location country="中国">`）。 */
  country?: string
  /** 真实纬度（已修正 moments XML 里 latitude/longitude **写反**的问题）。 */
  lat?: number
  /** 真实经度（同上）。 */
  lng?: number
  link_title: string
  link_url?: string
  contentType?: number
  sourceNickName?: string
  publicUserName?: string
  is_self: boolean
  likes: Array<{ username: string; nickname: string }>
  comments: Array<MomentCommentItem>
}

/**
 * One parsed resource part of a favorite.
 *
 * 收藏的 `datatype` 不是消息 `local_type` 的同一套编号：除了文本/图片/语音/视频/
 * 链接/文件，还会出现位置、小程序、音乐、商品、笔记、视频号与更新版本的未知卡片。
 * 这里刻意做成**开放字段**而不是按类型拆成若干互斥接口：前端只有一个资源渲染器，
 * 未知类型也必须能带着标题/描述/URL 走到界面，不能被后端静默丢掉。
 */
export interface FavItemPart {
  /** 资源种类；`unknown` 仍保留原始 `dataType` 与可读元信息。 */
  kind: 'text' | 'image' | 'voice' | 'video' | 'link' | 'file'
    | 'location' | 'miniapp' | 'product' | 'music' | 'note' | 'channels' | 'unknown'
  text?: string
  title?: string
  desc?: string
  md5?: string
  /** 原图/视频/文件的完整内容 md5（`md5` 对图片/视频优先放缩略 md5）。 */
  fullMd5?: string
  /** 图片/视频单独的缩略图 md5。 */
  thumbMd5?: string
  /** 微信资源/消息 ID；收藏 XML 与 fav_db_item 里的 uint64 一律保留为字符串。 */
  sourceId?: string
  /** `<dataitem datasourceid>` 原值（聊天记录里通常是 `sourceId$序号`）。 */
  dataSourceId?: string
  /** 图片/视频/文件 XML 声明的完整大小（用于本地候选收敛与诊断）。 */
  fullSize?: number
  /** 图片/视频 XML 声明的缩略图大小。 */
  thumbSize?: number
  /** 收藏 XML 的 CDN 协议字段；不是普通 HTTP 地址，保留给后续下载协议兜底。 */
  cdnDataUrl?: string
  cdnDataKey?: string
  cdnThumbUrl?: string
  cdnThumbKey?: string
  cdnEncryVer?: number
  url?: string
  /** 资源卡片可能同时带封面与跳转地址。 */
  coverUrl?: string
  /** 语音/视频时长；语音统一为毫秒，视频统一为秒。 */
  duration?: number
  durationMs?: number
  /** 后端原样收到的 `datatype`，用于未知类型如实显示。 */
  dataType?: number
  name?: string
  ext?: string
  size?: number
  /** 小程序/公众号等来源标识。 */
  appId?: string
  appUsername?: string
  pagePath?: string
  iconUrl?: string
  /** 位置字段。 */
  poiName?: string
  address?: string
  lat?: number
  lng?: number
  category?: string
  businessHours?: string
  phone?: string
  /** 语音指纹：收藏 XML 的 `fromnewmsgid` / sourceid 可对应 VoiceInfo.svr_id。 */
  svrId?: string
  format?: string
  sourceName?: string
  sourceTime?: string
  sourceHead?: string
  /** 未知资源保留的原始可读标签（不会把 XML 整段倒给界面）。 */
  meta?: Array<{ label: string; value: string }>
}

/** One favorites entry. */
export interface FavorItem {
  localId: number
  /** 微信收藏 server_id；超过 JS 安全整数范围，必须保留为字符串。 */
  serverId?: string
  /** 收藏来源消息/资源 ID；超过 JS 安全整数范围，必须保留为字符串。 */
  sourceId?: string
  type: number
  /** 类型中文名（微信 fav type）。 */
  typeLabel: string
  /** 收藏标题（从 content XML 解析）。 */
  title: string
  /** 收藏正文/描述（保留换行）。 */
  desc: string
  /** 链接类收藏的 URL。 */
  url: string
  updateTime: number
  /** 收藏时间（YYYY-MM-DD HH:mm）。 */
  time: string
  content: string
  fromUsr: string
  chatName: string
  /** 来源显示名（群名优先，其次发送者，经通讯录解析）。 */
  source: string
  /**
   * 来源用户头像。
   *
   * 可能是本机 data URL、contact 表的头像地址，或 32 位头像 MD5。远程地址必须交给
   * `RemoteImg`（走后端图片代理），不能直接挂到 `<img src>`；MD5 由客户端用
   * `apiGetSnsImageDataUrl` 解成本机 data URL。
   * 解析不到时为空串。
   */
  avatar?: string
  /** 拆分后的资源数据（文本/图片/语音/视频/链接/文件）。 */
  items?: FavItemPart[]
}

/** One resource file entry. */
export interface FileItem {
  /** 媒体标签上的 `token`：CDN 取图必需（实测 `token+idx=1` 才 200）。 */
  token?: string
  md5: string
  fileName: string
  fileSize: number
  modifyTime: number
  category: string
  /** Source chat display name resolved from message resource when available. */
  sessionName?: string
  /** Source message create time when available. */
  sourceTime?: number
  /** 来源月份（第 84 轮）：`dir1`/`dir2` → `dir2id` 的 `YYYY-MM`，三个表 100% 有值。 */
  sourceMonth?: string
  /** 来源会话显示名（第 84 轮）：`dir2id` 的值实测是 `md5(username)`，反查得到会话名。 */
  sourceTalker?: string
}

/** Moments snapshot. */
export interface MomentsSnapshot {
  moments: MomentItem[]
  total: number
}

/** One month bucket in the full moments monthly distribution. */
export interface MomentsMonthlyRow {
  month: string
  count: number
}

/**
 * 全量月度分布的返回值（P1-1/#9 后端读失败契约）。
 *
 * 原先这里直接回 `MomentsMonthlyRow[]`：sns.db 打不开 / 表读不动 与「一条朋友圈都没有」
 * 压成同一个空数组，界面上就是「没有月度分布」，而真实原因是快照损坏（查都查不到）。
 * 现在只有**确认读到过**才回空 `months`；读失败时 `months` 为空 **且** `readError` 非空。
 */
export interface MomentsMonthlySnapshot {
  months: MomentsMonthlyRow[]
  /** 非空 = 这次没读到（`months` 因此是空的），不是「没有动态」。 */
  readError?: string
}

/** Favorites snapshot. */
export interface FavoritesSnapshot {
  favorites: FavorItem[]
  total: number
}

/** Files snapshot. */
export interface FilesSnapshot {
  files: FileItem[]
  total: number
  /**
   * 分类计数（第 83 轮新增）：image / file / video 各自的**全库**行数，
   * 与本次 `category` 过滤无关 —— 界面用它渲染「全部 / 图片 / 视频 / 文件」四个入口的真实条数。
   */
  counts: Record<string, number>
}
