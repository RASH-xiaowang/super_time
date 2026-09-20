/**
 * WeChat data types, mirrored from the st_control wechat module. The gateway
 * reads st_control's decrypted SQLite and projects these shapes to the
 * browser Remote client.
 */

export type { ContactsPageOptions } from './query/contacts.ts'
/** One WeChat session (conversation). */
export interface WechatSession {
  username: string
  displayName: string
  type: 'group' | 'private'
  lastTimestamp: number
  summary: string
  unreadCount: number
  draft: string
  pinned: boolean
  hidden: boolean
  /** Last message preview metadata (SessionTable). */
  lastMsgType?: number
  lastMsgSubType?: number
  lastMsgSender?: string
  lastMsgSenderName?: string
  /** biz_info.type（公众号/服务号区分，gh_ 账号有效）。 */
  bizType?: number
  /** 账号类型：official=公众号(订阅号)，service=服务号（gh_ 账号生效）。 */
  accountKind?: 'official' | 'service' | 'kefu' | 'unknown'
  /**
   * 最早一条未读消息的时间（epoch 秒）。
   * 由 `SessionTable.unread_first_msg_srv_id` 反查该会话的 `Msg_*` 得到；
   * 仅当 unreadCount > 0 且能解析出来时存在（实测 41 个未读会话里 39 个可解析）。
   * 用途：界面显示「未读 N 条 · 最早 X 前」，便于判断先处理哪个会话。
   */
  unreadSince?: number
}

/** One inner record of a merged chat log (聊天记录卡片). */
export interface ChatlogRecord {
  name: string
  head?: string
  time: string
  text: string
  isImage?: boolean
  /** Raw datatype attr (1 text / 2-3 image / 3 voice / 4 video / 5 link / 17 nested / 47-37 emoji). */
  datatype?: string
  /** Rendered kind decided by datatype + datafmt + urls. */
  renderType?: 'text' | 'link' | 'video' | 'voice' | 'emoji' | 'image' | 'chatHistory'
  datatitle?: string
  datafmt?: string
  duration?: string
  datasize?: string
  url?: string
  link?: string
  externurl?: string
  cdnurlstring?: string
  encrypturlstring?: string
  fullmd5?: string
  thumbfullmd5?: string
  md5?: string
  /** Server id pointer (nested chatHistory items may only carry this; may exceed 2^53). */
  fromnewmsgid?: string
  srcMsgLocalid?: number
  srcMsgCreateTime?: number
  /** Parsed nested chatHistory records (recordxml / recorditem recursion). */
  nested?: ChatlogRecord[]
  recordIndex?: number
}

/** One 群接龙 participant (parsed from `<solitaire_info>`). */
export interface SolitaireMember {
  /** List index (`<s>`), 1-based. */
  idx: number
  username: string
  content: string
  ts: number
}

/** Rich media descriptor for a message (parsed from XML). */
export interface MessageRich {
  type: string
  title?: string
  desc?: string
  url?: string
  username?: string
  nickname?: string
  md5?: string
  paysubtype?: string
  /** Source account display name (appmsg cards, e.g. 公众号名). */
  source?: string
  /** Thumbnail CDN url (appmsg link cards). */
  thumb?: string
  /** File attachment extension (file cards). */
  fileExt?: string
  /** File attachment size in bytes (text, file cards). */
  fileSize?: string
  /** File attachment md5 (file cards) — the join key into hardlink.db. */
  fileMd5?: string
  /** Source account username (`<sourceusername>`, e.g. `gh_xxx`). */
  sourceUsername?: string
  /** 链接语义：`official_article`（公众号文章）/ `web_link`（普通网页）。 */
  linkType?: string
  /** 链接卡片视觉：`cover`＝封面大图式，`default`＝标题+摘要式。 */
  linkStyle?: string
  /** 视频号 / 直播作品的 objectId（可跳转视频号）。 */
  objectId?: string
  objectNonceId?: string
  /** 通话结局原文（`<msg>` 文本，唯一有信息量的字段）。 */
  status?: string
  /** 通话是否接通（有本机时长，或在其它设备接听）。 */
  connected?: boolean
  /** 通话结局语义分类：connected/cancelled/rejected/no-answer/busy/interrupted/missed/unknown。 */
  callStatus?: string
  /** 通话原始 `<room_type>` 值（诊断用，界面不据此单独下结论）。 */
  roomType?: number
  /** 语音/视频通话类型（`<room_type>`：0=video、1=audio；无法判定时缺省）。 */
  voipType?: 'audio' | 'video' | ''
  /** 通话/视频时长（秒）。 */
  durationSec?: number
  /** 语音时长（毫秒，来自 `<voicemsg voicelength>`）。 */
  durationMs?: number
  /** 位置纬度（`<location x>`）。 */
  lat?: number
  /** 位置经度（`<location y>`）。 */
  lng?: number
  /** 位置 POI id（`<location poiid>`）。 */
  poiId?: string
  /** 名片备注/别名（`<msg alias>`）。 */
  alias?: string
  /** 名片头像 CDN 地址。 */
  avatar?: string
  /** 转账领取状态（`<receivestatus>`）。 */
  receiveStatus?: string
  /** 红包金额（已去掉货币符号）。 */
  amount?: string
  /** 图片组 id（`<groupinfo><id>`，标准 UUID）——连拍图片共享同一个 id。 */
  groupId?: string
  /** 图片组声明的张数（`<groupinfo><count>`，≥2）。 */
  groupCount?: number
  /** Merged chat record inner messages (chatlog card). */
  records?: ChatlogRecord[]
  /** 群接龙参与者名单（type-53 的 `<solitaire_info>`）。 */
  members?: SolitaireMember[]
  /** 群接龙发起人 wxid。 */
  by?: string
  /** 群接龙 id（`<sid>`，形如 1788156783179_8524）。 */
  sid?: string
  /** 接龙声明的名单总人数（`<content>` 里唯一的数字型 `<s>`）；可能大于 members.length（有人退出后名单未同步）。 */
  declared?: number
  /** 引用消息里**被引用方**的昵称（`<refermsg><displayname>`）。 */
  referName?: string
  /** 公众号多图文推送的**次条**（第 2 篇起；头条在 title/url/thumb 上）。 */
  mpArticles?: MpArticle[]
  /** 是否公众号推送（原始 XML 含 `<mmreader>`）：界面据此用大图卡而非普通链接卡。 */
  mpNews?: boolean
  /** 自定义表情的 CDN 地址（`<emoji cdnurl>`）：本地表情缓存是加密的，取图靠它兜底。 */
  emojiUrl?: string
  /** 被引用消息的 local_type（用于媒体占位，如 3=图片）。 */
  referType?: number
  /** 被引用内容是 appmsg 时的**子类型**（2000=转账、2001/2003=红包、5=链接…）；非 appmsg 不写。 */
  referAppType?: number
  /** 被引用消息的时间（秒）。 */
  referTime?: number
  /** 被引用消息的 server_id（可据此精确取回原消息）。 */
  referSvrId?: string
  /** 被引用消息的发送者 wxid（`<refermsg><fromusr>`）。 */
  referUsername?: string
  [key: string]: string | number | boolean | ChatlogRecord[] | SolitaireMember[] | MpArticle[] | undefined
}

/** 公众号多图文推送里的一篇（`<mmreader><category><item>`）。 */
export interface MpArticle {
  /** 文章标题（`<title_v2>` 优先，回退 `<title>`）。 */
  title: string
  /** 文章链接（`mp.weixin.qq.com/s?...&idx=N`，N 是这篇在推送里的序号）。 */
  url: string
  /** 封面（`<cover>`，形如 `https://mmbiz.qpic.cn/sz_mmbiz_jpg/…/640`）。 */
  cover?: string
  /** 摘要（`<summary>`）。 */
  summary?: string
}

/** One row's canonical render kind — the UI switches on this and nothing else. */
export type MessageRenderKind =
  | 'text' | 'image' | 'voice' | 'video' | 'emoji' | 'location' | 'contactCard'
  | 'file' | 'link' | 'quote' | 'miniapp' | 'channels' | 'live' | 'music'
  | 'product' | 'card' | 'note' | 'sticker' | 'announcement' | 'solitaire'
  | 'chatlog' | 'transfer' | 'redpacket' | 'voip' | 'pat'
  | 'system' | 'revoke' | 'empty' | 'unknown'
  // 与 parse.ts 的 RenderKind 是同一套取值，两处必须同步。
  // 'unsupported' 缺了很久：后端 RICH_TO_RENDER 会产出它，渲染端也已有对应分支。
  | 'unsupported'

/** One 群消息 @ 提及对象（用户名 + 可展示的昵称）。 */
export interface MessageAtUser {
  username: string
  displayName: string
}

/** One message row. */
export interface WechatMessage {
  localId: number
  type: number
  /** WeChat server id (text; may exceed 2^53). */
  serverId?: string
  subType?: number
  /** Millisecond stable order key (same value the keyset cursor uses). */
  sortSeq?: number
  isSender: number
  createTime: number
  msgContent?: string
  strContent?: string
  typeLabel?: string
  displayText?: string
  rich?: MessageRich
  sender?: string
  senderName?: string
  /**
   * 归一化后的**呈现种类**（界面唯一 switch 依据，见 `parse.ts` 的
   * `classifyRender`）。与 `type`/`rich.type` 的区别：它是「该用哪个渲染器」
   * 的单一答案，界面不再需要自己维护白名单 —— 漏一个子类型就退化成
   * 通用链接卡，是此前聊天界面最主要的不一致来源。
   */
  renderType?: MessageRenderKind
  /** renderType 的中文短标签（类型芯片/导出/复制用）。 */
  renderLabel?: string
  /** 群消息里被 @ 的用户（来自 `source` 列的 `<atuserlist>`）。 */
  atUsers?: MessageAtUser[]
  /** 系统消息子类型（revoke / top / sysmsgtemplate / plain）。 */
  sysKind?: string
}

/** Message type counts for one talker. */
export interface MessageTypeStat {
  type: number
  label: string
  count: number
}

/** Messages + type stats snapshot. */
export interface MessagesSnapshot {
  messages: WechatMessage[]
  total: number
  hasMore?: boolean
  cursor?: number
  /**
   * 复合游标的第二段：上一页最后一行的 local_id。
   * 仅靠 cursor（sort_seq）分页会在 sort_seq 重复处丢消息，故与 cursor 成对传入/回传。
   */
  cursorLocalId?: number
  typeStats?: MessageTypeStat[]
  /** Logged-in account wxid, for rendering the sender's own avatar. */
  selfWxid?: string
}

/** One contact. */
export interface WechatContact {
  username: string
  nickName: string
  remark: string
  displayName: string
  alias?: string
  category?: string
  description?: string
  localType?: number
  localTypeLabel?: string
  inChatRoom?: boolean
  /** Pinyin initial (A-Z / #), source-computed from remark/nick initial. */
  initial?: string
  quanPin?: string
  /**
   * 备注（界面上显示的那个名字）的拼音，来自 contact.remark_quan_pin（第 85 轮）。
   * 与 `quanPin`（昵称拼音）不同：实测 280 个有备注的联系人里，270 人只能靠这个字段搜到。
   */
  remarkQuanPin?: string
  avatarUrl?: string
  /** Group member count (groups only). */
  memberCount?: number
  /** Group owner username (groups only). */
  owner?: string
  /** Member's owning group username (members only). */
  groupUsername?: string
  groupName?: string
}

/** Contacts grouped by kind. */
export interface ContactBook {
  friends: WechatContact[]
  chatrooms: WechatContact[]
  ghs: WechatContact[]
}

/** Sessions snapshot returned by the gateway. */
export interface SessionsSnapshot {
  sessions: WechatSession[]
  total: number
}

/** Messages snapshot returned by the gateway. */
export interface MessagesSnapshot {
  messages: WechatMessage[]
  total: number
  hasMore?: boolean
  cursor?: number
}

/** Authoritative transfer/redpacket status by message server_id. */
export interface PaymentStatus {
  found: boolean
  kind?: 'transfer' | 'redpacket'
  serverId?: string
  transfer?: {
    transferId: string
    paySubType: number
    receiver: string
    payer: string
    beginTime: number
    lastModifiedTime: number
    invalidTime: number
    delayConfirm: boolean
  }
  redpacket?: {
    sender: string
    hbStatus: number
    hbType: number
    receiveStatus: number
    sendId: string
  }
}

/** Result of resolving a nested merged chat-log pointer by server_id. */
export interface ChatHistoryResolveResult {
  found: boolean
  message?: WechatMessage
}

/** Contacts snapshot returned by the gateway. */
export interface ContactsSnapshot {
  contacts: WechatContact[]
  total: number
  /** Per-category counts (friend/group/official/service/enterprise/member/system/deleted). */
  stats?: Record<string, number>
}

/** One contact in a city region (for the friend-region map). */
export interface RegionFriend {
  username: string
  /** 展示名（备注 > 昵称 > 用户名）。 */
  displayName: string
  remark: string
  nickName: string
  /** CDN avatar url (small first), when resolvable. */
  avatarUrl?: string
}

/** A node in the friend region tree: country → province → city → friends. */
export interface RegionNode {
  /** 稳定键（国家 / 省 / 市的原始中文名）。 */
  key: string
  /** 中文显示名。 */
  name: string
  /** 该板块下的好友总数（含子板块）。 */
  count: number
  /** 子板块（国家下有省，省下有市）；城市节点为空数组。 */
  children: RegionNode[]
  /** 城市节点直接挂的好友列表。 */
  friends: RegionFriend[]
}

/** Friend-region map snapshot (世界 → 国家 → 省 → 市 → 好友). */
export interface RegionMapSnapshot {
  /** 有地区好友总数。 */
  total: number
  /** 无任何地区的好友数。 */
  unknown: number
  /** 世界节点：children = 国家板块。 */
  world: RegionNode
}

/** One group chat member (for the group info panel). */
export interface GroupMember {
  username: string
  name: string
  /** CDN avatar url (small first). */
  head?: string
  isSelf?: boolean
  /** 地区 (province + city, resolved via region resource). */
  region?: string
  /** 个性签名 (extra_buffer field 4). */
  signature?: string
  /** 性别: 1=男 2=女 0=未知 (extra_buffer field 2). */
  gender?: number
}

/** Group chat info (群聊信息) opened from the chat header. */
export interface GroupInfo {
  username: string
  name: string
  owner?: string
  /** User remark (群聊备注; empty when not set). */
  remark: string
  announcement: string
  announcementEditor?: string
  announcementTime?: number
  /** 我在本群的昵称 (own alias inside this chatroom). */
  myAlias?: string
  totalMembers: number
  members: GroupMember[]
  settings: {
    /** 消息免打扰 (local mirror; WeChat value when readable). */
    muted: boolean
    /** 置顶聊天 (WeChat contact flag bit 11). */
    pinned: boolean
    /** 保存到通讯录 (DSH-local preference, no WeChat write). */
    savedToContacts: boolean
    /** 显示群成员昵称 (DSH-local preference, no WeChat write). */
    showMemberNickname: boolean
  }
}

/** Group info snapshot returned by the gateway (null when unknown). */
export interface GroupInfoSnapshot {
  group: GroupInfo | null
}

/** One member-search hit (global or room-scoped). */
export interface MemberSearchHit {
  username: string
  name: string
  /** CDN avatar url (small first). */
  head?: string
  /** Owning chatroom username when hit is a group member. */
  roomUsername?: string
  /** Owning chatroom display name when hit is a group member. */
  roomName?: string
  /** 个性签名 (extra_buffer field 4). */
  signature?: string
  /** 地区 (province + city, resolved via region resource). */
  region?: string
}

/** Member search snapshot returned by the gateway. */
export interface MemberSearchSnapshot {
  items: MemberSearchHit[]
  total: number
  /** Where hits came from: fts=contact_fts index, like=LIKE fallback. */
  source: 'fts' | 'like'
}

/** One moments comment entry. */
export interface MomentCommentItem {
  username: string
  nickname: string
  to_username: string
  to_nickname: string
  content: string
  ts: number
  /** Comment-attached image. */
  image?: { thumb?: string; url?: string; md5?: string; mediaId?: string }
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
  images: Array<{ thumb: string; url: string; key: string; md5: string; id?: string; timelineId?: string }>
  videos: Array<{ url: string; thumb: string; key: string; md5: string; duration: number; id?: string; timelineId?: string }>
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

/** One parsed dataitem part of a favorite. */
export interface FavItemPart {
  kind: 'text' | 'image' | 'voice' | 'video' | 'link' | 'file'
  text?: string
  md5?: string
  url?: string
  duration?: number
  name?: string
  ext?: string
  size?: number
  sourceName?: string
  sourceTime?: string
  sourceHead?: string
}

/** One favorites entry. */
export interface FavorItem {
  localId: number
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
  /** 拆分后的资源数据（文本/图片/语音/视频/链接/文件）。 */
  items?: FavItemPart[]
}

/** One resource file entry. */
export interface FileItem {
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

/** Annual snapshot. */
export interface AnnualSnapshot {
  years: number[]
  total_messages?: number
}

/** Config snapshot. */
export interface ConfigSnapshot {
  db_dir?: string
  wechat_process?: string
  key_format?: string
  api_enabled?: boolean
  api_port?: number
}

/** One privacy risk sample. */
export interface PrivacySample {
  username: string
  name: string
  local_id: number
  ts: number
  time: string
  snippet: string
}

/** Privacy scan snapshot: per-category counts/samples + rankings. */
export interface PrivacySnapshot {
  categories: Array<{ key: string; label: string; count: number; icon: string; samples: PrivacySample[] }>
  total_hits: number
  involved_sessions: number
  top_contacts: Array<{ username: string; name: string; count: number }>
  top_groups: Array<{ username: string; name: string; count: number }>
}

/** Graph snapshot (edges are derived client-side from group_codes). */
export interface GraphSnapshot {
  /** Current account username (self node is the literal 'self'). */
  self?: string
  /** chatroom username -> display name (common-group tooltips). */
  group_names?: Record<string, string>
  /**
   * 备注「班级/批次」名册（键 → 全库成员，**不受 nodeLimit / 仅显示好友影响**）。
   * 画布据此把同班级的人连成一片，并在详情里说明「全库 N 人 / 本视图 M 人」——
   * 那正是「同前缀却没有连线」最常见的原因：人被上限或好友过滤挡在图外。
   */
  remark_groups?: Array<{
    key: string
    total: number
    members: Array<{ username: string; name: string; is_friend: boolean; msg_count: number }>
  }>
  nodes: Array<{
    id: string
    label: string
    kind: string
    is_friend?: boolean
    msg_count?: number
    group_count?: number
    member_count?: number
    shared_count?: number
    group_codes?: string[]
    avatar_url?: string
    /** 备注里的「班级/批次」键（`宜州一中404陈泳达` → `宜州一中404`），用户自建的组织维度。 */
    remark_group?: string
    shared_members?: Array<{ username: string; name: string; is_friend: boolean; msg_count: number }>
  }>
  edges: Array<{ source: string; target: string; weight: number }>
  summary?: {
    total_contacts?: number
    total_groups?: number
    total_messages?: number
    contact_book_total?: number
    contact_book_friends?: number
    contact_book_members?: number
    selected_contacts?: number
    selected_groups?: number
    top_relations?: Array<{ username: string; name: string; msg_count: number }>
  }
}

/** The one-screen data overview snapshot. */
export interface OverviewSnapshot {
  sessions: number
  groups: number
  contacts: number
  official: number
  moments: number
  favorites: number
  emoticons: number
  revoked: number
  storage: { total_size: number; total_count: number; categories: OverviewStorageCategory[] }
  moments_authors: OverviewMomentsAuthor[]
}

/** 微信数据总览「战术分析」洞察快照（交互画像/作息/关系/内容资产/健康）。 */
export interface OverviewInsights {
  messages: {
    total: number
    sent: number
    received: number
    text: number
    image: number
    voice: number
    video: number
    rich: number
    system: number
    revoked: number
  }
  time: {
    activeDays: number
    spanDays: number
    busyHour: number
    busyCount: number
    hourDist: number[]
    deepNightPct: number
    weekendPct: number
    lastActive: string
  }
  relations: {
    total: number
    active: number
    silent: number
    groupsWithMsg: number
    top: Array<{ username: string; name: string; count: number }>
  }
  moments: { total: number; images: number; videos: number; likes: number; comments: number }
  assets: { favorites: number; emoticons: number; files: number; fileBytes: number; mediaItems: number; mediaBytes: number }
  health: { dbFiles: number; dbBytes: number; ok: boolean }
  /** 近端趋势 / 90 天热度 / 新鲜度。 */
  extras?: OverviewExtras
}

/** 微信数据总览「趋势/热度/新鲜度」扩展洞察快照。 */
export interface OverviewExtras {
  /** 近端窗口的新增与环比。 */
  trends: {
    messages7: number
    messages30: number
    messages60: number
    messages7Delta: number
    messages30Delta: number
    activeContacts7: number
    activeContacts30: number
    activeGroups7: number
    activeGroups30: number
    storageBytes30: number
  }
  /** 最近 90 天每日消息量（升序）。 */
  heatmap: Array<{ d: string; count: number }>
  freshness: { dbFiles: number; dbBytes: number; walPending: boolean; ok: boolean; lastSync: string }
}

/** One full-text search hit. */
export interface SearchHit {
  text: string
  username: string
  create_time: number
  local_id: number
  name: string
  time: string
  snippet: string
  /** 群聊里这条消息的发送者显示名（单聊为空）。 */
  sender?: string
  /** BM25 相关度（越大越相关；仅自建索引路径提供）。 */
  score?: number
}

/** Search index status. */
export interface SearchIndexStatus {
  exists: boolean
  rows: number
  built_at: string | null
  /** 索引结构是否为当前版本（false 时提问会自动重建）。 */
  ready: boolean
}

/** Search snapshot (hits + index flag). */
export interface SearchSnapshot {
  hits: SearchHit[]
  total: number
  indexed: boolean
}

/** Search index build result. */
export interface SearchBuildResult {
  status: string
  rows?: number
  built_at?: string
  elapsed_ms?: number
  message?: string
}

/** Daily message counts for one month (day -> count). */
export interface CalendarSnapshot {
  counts: Record<string, number>
  year: number
  month: number
}

/** Image decode result (base64 data URL) for one message image. */
export interface ImageDataUrlResult {
  url?: string
  format?: string
  error?: string
}

/** Decrypted DB status summary lines. */
export interface DbStatusSnapshot {
  lines: string[]
  path: string
}

/** Voice message lookup result (silk decode degrades in Node). */
export interface VoiceInfoResult {
  available: boolean
  /** svr_id as text: the value may exceed Number.MAX_SAFE_INTEGER. */
  svrId?: string
  length?: number
  decodable: boolean
  error?: string
}

/** Video message lookup result (cover thumbnail + on-disk path + degradation). */
export interface VideoInfoResult {
  available: boolean
  md5?: string
  coverUrl?: string
  /**
   * 视频实体在本机的绝对路径（`<微信数据根>/msg/video/<YYYY-MM>/<md5>.mp4`）。
   * 只有本机播放/下载过才有；有它时界面可以把文件交给系统播放器打开。
   */
  videoPath?: string
  error?: string
}

/** 语音消息的可播放音频（16kHz 单声道 wav 的 data URL）。 */
export interface VoiceDataUrlResult {
  url?: string
  /** 由 wav 头算出的时长（秒），供界面显示与校验。 */
  durationSec?: number
  error?: string
}

/** Export result (written file path + count). */
export interface ExportResult {
  path: string
  filename: string
  count: number
}

/**
 * 一次导出在**历史记录**里的形态。
 *
 * 与 `operation_log` 的区别：操作日志是「审计」口径（谁在何时做了什么，只留元数据），
 * 而这里是「可操作」口径 —— 用户要能据此**定位文件、重新导出、删除文件**，所以必须
 * 记住 `path`（绝对路径）、`params`（重跑导出所需的全部参数）与 `sizeBytes`。
 */
export interface ExportHistoryEntry {
  id: number
  ts: number
  /** 导出种类：contacts / favorites / records / moments / privacy / session / annual / all_sessions / backup。 */
  kind: string
  /** 人类可读的说明（如「联系人 · 好友」「会话 · 某某」）。 */
  label: string
  /** 落盘格式：csv / txt / html / xlsx / md / json / zip / wcb / dir。 */
  format: string
  /** 绝对路径。 */
  path: string
  /** 文件名（便于列表显示与搜索，避免每次都从 path 切）。 */
  filename: string
  /** 文件字节数；目录型导出（备份目录）为 null。 */
  sizeBytes: number | null
  /** 导出的行数/条数。 */
  rows: number
  status: ExportStatus
  /** 失败原因或补充说明。 */
  error: string
  /** 重新导出所需的原始入参（JSON 文本；不存任何消息正文）。 */
  params: string
  /**
   * 记录生成时的磁盘核对结果：文件是否仍存在。
   * 落库时是快照，展示前会由 `reconcileExportHistory` 刷新 —— 用户可能在资源管理器里
   * 把它移走或删掉，历史列表必须如实反映，而不是一直显示「存在」。
   */
  existsNow: boolean
}

/** 导出结果状态。 */
export type ExportStatus = 'ok' | 'fail' | 'canceled'

/** 读取导出历史的筛选/排序/分页条件。 */
export interface ExportHistoryQuery {
  /** 文本搜索：匹配文件名、说明、路径与种类。 */
  q?: string
  /** 只保留这些种类（空/缺省表示全部）。 */
  kinds?: string[]
  status?: ExportStatus
  /** 起始时间（毫秒，含）。 */
  from?: number
  /** 结束时间（毫秒，含）。 */
  to?: number
  /** 排序字段。 */
  sort?: 'ts' | 'size' | 'rows' | 'name'
  /** 排序方向。 */
  order?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

/** 导出历史一页：条目 + 命中总数 + 各聚合数（用于页签上的计数）。 */
export interface ExportHistorySnapshot {
  items: ExportHistoryEntry[]
  total: number
  /** 各状态的条数（ok/fail/canceled），用于「仅看失败」这类筛选的计数。 */
  statusCounts: Record<string, number>
  /** 各导出种类的条数，用于种类页签计数。 */
  kindCounts: Record<string, number>
  /** 命中条目的文件总字节数（文件已被外部删除的不计）。 */
  totalBytes: number
  /** 命中条目里文件已不在磁盘上的条数（供「清理失效记录」提示）。 */
  missingCount: number
}

/** 删除导出历史的结果。 */
export interface ExportHistoryDeleteResult {
  /** 实际删除的记录数。 */
  removed: number
  /** 连带删除的文件数。 */
  filesDeleted: number
  /** 删除文件失败的文件名（记录仍会被删除，这里如实回报）。 */
  fileErrors: string[]
}

/**
 * 清理导出历史的策略（两个条件都满足才删；都为 0/缺省则不删任何东西 ——
 * 避免「传空对象把历史清光」这种误调用）。
 */
export interface ExportHistoryPruneOptions {
  /** 只清理早于「现在 - olderThanDays 天」的记录。 */
  olderThanDays?: number
  /** 只保留最近 keepLatest 条，其余作为清理候选。 */
  keepLatest?: number
  /** 是否连带删除磁盘上的文件。 */
  deleteFiles?: boolean
  /** 只清理文件已不存在的失效记录（忽略上面两个条件）。 */
  onlyMissing?: boolean
}

/**
 * One citation (source message) for an Ask answer.
 *
 * ⚠ 这个结构是**消息中心**的：`username` / `local_id` / `time` 三个字段构成了
 * 「引用 → 原文」的可定位性，而知识库的文件块**一个都没有**。因此 KB 来源必须靠
 * `source` 判别，不能只把字段填成空值混进来 —— 那样会静默污染三处：
 *   · `gateway.askBasisLine` 的「N 个会话」（空 username 会被算成一个假会话）；
 *   · trace 落盘的反馈归因键（`username + ':' + local_id` 会变成 `:`，
 *     同一次提问里多个 KB 引用还会**互相覆盖**，反馈归因指向不存在的消息）；
 *   · `formatAskContext` 的渲染（模型会看到「未知会话 1970-01-01:」）。
 * 缺省 `source` 为 `'msg'` ⇒ 既有写入方与旧数据不用改。
 */
export interface AskCitation {
  name: string
  time: string
  snippet: string
  username: string
  local_id: number
  /** 群聊里这条消息的发送者显示名（单聊为空）。 */
  sender?: string
  /**
   * 来源域：`'msg'` = 聊天消息（缺省，向后兼容）；`'kb'` = 知识库文件块。
   *
   * 判别字段的取舍：不用「`local_id === 0` 判 KB」这种隐式约定 ——
   * 消息域里 `local_id` 为 0 是否有含义取决于上游，靠它判来源会在上游变化时
   * 悄悄失效，而且失效时**不报错**（只是统计与归因开始说谎）。
   */
  source?: 'msg' | 'kb'
  /**
   * 知识库来源专有信息（`source === 'kb'` 时存在）。
   *
   * 用途：引用卡片要显示「文件名 + 面包屑 + 页码」（`name` 只有一个字符串装不下），
   * 反馈归因键要能复算出 `kb:<kbId>:<chunkId>`（与检索侧 docKey 对齐）。
   */
  kb?: {
    kbId: number
    fileId: number
    fileName: string
    /** 小写扩展名（不含点），界面据此选图标。 */
    fileExt: string
    chunkId: number
    /** 块在文件内的序号（0 基）。 */
    ordinal: number
    /** 页码（1 基）；非分页形态为 0。 */
    page: number
    /** 面包屑（`H1 › H2`）；无标题时为空串。 */
    heading: string
  }
}

/** Ask optimization result: rewritten question + improvement suggestions. */
export interface AskOptimizeResult {
  optimized: string
  suggestions: string[]
}

/** Ask retrieval plan: intent + decomposed sub-queries + resolved scope hints. */
export interface AskPlan {
  intent: string
  subQueries: string[]
  /** 规划器从问题里换算出的绝对日期范围（YYYY-MM-DD；未识别为空）。 */
  from?: string
  to?: string
  /** 问题里点名的人（用于命中加分）。 */
  person?: string
  /** 实际参与检索的词项（去停用词后的 bigram/关键词）。 */
  terms?: string[]
}

/** Ask result: LLM answer + source citations (+ the retrieval plan used). */
export interface AskResult {
  answer: string
  citations: AskCitation[]
  /** Retrieval plan used for this answer (multi-turn pipeline). */
  plan?: AskPlan
  /** 回答正文里真正引用到的来源序号（1 基，对应 citations 的下标 +1）。 */
  citedIndexes?: number[]
  /**
   * 数据来源说明（条数/会话数/时间跨度 + 回答引用了哪几条），**由检索结果算出**，
   * 不是模型写的 —— 用户可据此逐条对照原文。
   */
  basis?: string
  /** 本轮没有检索到任何原文：未调用模型，直接说明无法回答。 */
  insufficient?: boolean
  /** 模型给出的内容无法对应到任何一条原文：已不予采用，改为明确告知无证据。 */
  withheld?: boolean
  /**
   * 接地核对结果（生成之后用**回答自己引用的原文**做的确定性复核）：
   *   · checked —— 校验过的「必须逐字来自原文」的值个数（金额/日期/长数字串）；
   *   · unsupported —— 原文里找不到出处的值（界面据此提示「可能是编造或推算」）；
   *   · cited —— 回答真正引用到的来源条数；
   *   · repaired —— 是否因核对未通过而触发过一次重写。
   * 注意：金额不硬拦截（合计是模型可以算出来的），因此 unsupported 非空**不代表**
   * 回答被弃用 —— 只有「一条 [n] 都没有」才会走 withheld。
   */
  grounding?: {
    checked: number
    unsupported: string[]
    cited: number
    repaired: boolean
  }
  /** 本轮检索的追踪 id：反馈时回传它，才能把「哪条引用有用」归因到检索特征。 */
  retrievalId?: string
  /** 检索统计（命中候选数 / 保留数 / 范围），用于解释「为什么只有这些来源」。 */
  retrieval?: {
    candidates: number
    kept: number
    scope: string
    recency: boolean
    /** 规划器推断出的时间线索（软偏好，非硬过滤）。 */
    timeHint?: string
    /** 保留的引用里落在时间线索范围内的条数。 */
    hintHits?: number
    /** 命中消息聚类后的对话窗口数（chunk 级检索）。 */
    chunks?: number
    /** 窗口展开实际取回的消息条数。 */
    windowMessages?: number
    /** 多阶段流水线：分类出的查询意图。 */
    intent?: string
    /** 多阶段流水线：稠密通道是否真正生效（false 说明已降级为纯稀疏）。 */
    denseActive?: boolean
    /** 多阶段流水线：各召回通道命中数。 */
    channels?: Array<{ channel: string; count: number; active: boolean; note?: string }>
    /** 多阶段流水线：端到端检索耗时（毫秒）。 */
    elapsedMs?: number
    /** 多阶段流水线：召回 → 融合 → 重排 → 压缩 各阶段数量，用于解释「为什么只剩这些」。 */
    funnel?: { recalled: number; fused: number; ranked: number }
  }
}

/**
 * 一次问答在**历史记录**里的结局。
 *
 * 与「操作日志」的区别：日志只记「发生了一次任务」，这里要区分「回答成不成立」——
 * 用户回看历史时最需要知道的是「这条当时是不是真的答上了」。
 *   · ok           —— 正常回答（至少引用了一条原文）；
 *   · insufficient —— 没有检索到任何原文，未调用模型；
 *   · withheld     —— 模型内容无法对应到任何原文，已不予采用；
 *   · fail         —— 调用过程出错（未配置模型 / 出站被拦截等）。
 */
export type AskHistoryStatus = 'ok' | 'insufficient' | 'withheld' | 'fail'

/**
 * 一次问答的完整记录（问题 + 回答 + 引用 + 检索元信息）。
 *
 * 这是应用里**唯一**存问答正文的表，因此比审计表敏感：只落本机、按数据根隔离、
 * 不参与任何导出，且用户可逐条删除或整体清空。
 */
export interface AskHistoryEntry {
  id: number
  /** 问答发生时间（毫秒）。 */
  ts: number
  question: string
  answer: string
  /** 入口来源：ask（微信问答页签）/ session（会话内问答）。 */
  source: string
  /** 会话范围（空 = 全部会话）。 */
  username: string
  /** 会话显示名（列表直接显示，不必再查会话表）。 */
  usernameName: string
  /** 时间范围（YYYY-MM-DD，空 = 全部时间）。 */
  from: string
  to: string
  /** 回答模型（provider · model）。 */
  model: string
  /** 检索规划器识别的意图。 */
  intent: string
  /** 实际参与检索的词项。 */
  terms: string[]
  /** 引用来源（原样还原为对象，点击可跳转原文）。 */
  citations: AskCitation[]
  /** 回答正文里真正引用到的序号（1 基）。 */
  citedIndexes: number[]
  /** 数据来源说明（由检索结果算出，非模型生成）。 */
  basis: string
  status: AskHistoryStatus
  /** 失败原因（status='fail' 时有值）。 */
  error: string
  /** 多阶段检索统计（结构化；老记录可能为 null）。 */
  retrieval: Record<string, unknown> | null
  /** 端到端耗时（毫秒）；0 表示未记录。 */
  elapsedMs: number
}

/** 读取问答历史的筛选/排序/分页条件。 */
export interface AskHistoryQuery {
  /** 文本搜索：匹配问题、回答、会话名、检索词与意图。 */
  q?: string
  /** 只保留这些来源（空/缺省表示全部）。 */
  sources?: string[]
  status?: AskHistoryStatus
  /** 起始时间（毫秒，含）。 */
  from?: number
  /** 结束时间（毫秒，含）。 */
  to?: number
  /** 排序字段。 */
  sort?: 'ts' | 'question'
  /** 排序方向（默认 desc = 最新优先）。 */
  order?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

/** 问答历史一页：条目 + 命中总数 + 各聚合数（用于筛选页签上的计数）。 */
export interface AskHistorySnapshot {
  items: AskHistoryEntry[]
  total: number
  /** 各状态的条数（ok/insufficient/withheld/fail）。 */
  statusCounts: Record<string, number>
  /** 各来源的条数（ask/session）。 */
  sourceCounts: Record<string, number>
}

/** 删除问答历史的结果。 */
export interface AskHistoryDeleteResult {
  /** 实际删除的记录数。 */
  removed: number
}

/** 清空问答历史的结果。 */
export interface AskHistoryClearResult {
  /** 实际删除的记录数。 */
  removed: number
}

/** One backup entry. */
export interface BackupEntry {
  name: string
  path: string
  size: number
  modified: number
  kind: 'dir' | 'enc'
  /** Short content summary (dir: item count + db count; enc: format note). */
  summary?: string
  /** Integrity: dir backup has at least one DB; enc backup has a valid header. */
  ok?: boolean
}

/** One file/dir inside a backup (for the restore preview). */
export interface BackupPreviewItem {
  name: string
  size: number
  isDir: boolean
}

/** Backup list snapshot. */
export interface BackupSnapshot {
  items: BackupEntry[]
  total: number
}

/** Backup restore-preview snapshot (bounded file list). */
export interface BackupPreviewSnapshot {
  items: BackupPreviewItem[]
  total: number
}

/** Backup mutation result. */
export interface BackupMutationResult {
  ok: boolean
  error?: string
  name?: string
}

/** Backup restore result. */
export interface BackupRestoreResult {
  ok: boolean
  path?: string
  error?: string
}

/** Daily summary result: LLM summary + collected message stats. */
export interface DailySummaryResult {
  summary: string
  date: string
  sessions: number
  messages: number
  /** Total messages in the day (all types). */
  total: number
  /** Message type -> count. */
  types: Record<string, number>
  /** 24h message distribution. */
  hourly: number[]
  /** Top chatrooms by message count. */
  topSessions: Array<{ username: string; count: number }>
}

/** Period summary result (weekly/monthly/custom range): LLM summary + stats. */
export interface PeriodSummaryResult {
  summary: string
  from: string
  to: string
  sessions: number
  messages: number
  total: number
  types: Record<string, number>
  hourly: number[]
  topSessions: Array<{ username: string; count: number }>
}

/** One extracted/imported WeChat task. */
export interface WechatTask {
  id: number
  title: string
  status: 'open' | 'done'
  dueAt?: number
  sourceUsername?: string
  sourceLocalId?: number
  messageTime?: number
  createdAt: number
  updatedAt: number
}

/** Task list snapshot. */
export interface TasksSnapshot {
  items: WechatTask[]
  total: number
}

/** Task mutation result (add/status/delete/extract). */
export interface TaskMutationResult {
  ok: boolean
  id?: number
  added?: number
  error?: string
}

/**
 * One knowledge base: a partition of the note store.
 *
 * 一个库 = 一批笔记 + 一个 `[[链接]]` 解析域 + 一张由这批笔记构成的图谱。
 * 库只存**名字**，笔记只存 `kb_id` —— 改名不动任何笔记（见 `renameKb`）。
 */
export interface KbMeta {
  id: number
  name: string
  /** 该库的笔记条数（列表里直接显示，一眼看出哪个库是空的）。 */
  noteCount: number
  /**
   * 该库登记的**文件**条数。
   *
   * 与 `noteCount` 并列的「这个库里有什么」。**只数笔记会让删库弹层说谎**：
   * 一个「0 条笔记 / 5 个文件」的库会被写成「这个库是空的」，用户点下「一并删除」
   * 就丢掉了 5 份登记（blob、分块、FTS、向量一并清）。真机探针实测到过这一句。
   *
   * ⚠ 真值只有文件库知道，而 `listKbs()` 在 `notes.ts` 里、看不到那个独立 db 文件，
   * 所以那里出 `0`、由 `gateway.getKbs` 覆盖（见该处注释）。别直接拿 `listKbs()`
   * 的返回值去渲染删库文案。
   */
  fileCount: number
  /**
   * 该库自定义了几个模型角色（0 = 全部跟随全局）。
   *
   * 第三个合流源：设置住在 `wechat_kb_models.db`，而 `listKbs()` 在 `notes.ts` 里看不到它。
   * 只带计数不带引用串 —— rail 的芯片只需要知道「继承 / N 项自定义」，
   * 具体是哪几个模型由 `getKbModelConfig` 按需读（打开弹层时才读）。
   */
  modelOverrides: number
  createdAt: number
  updatedAt: number
}

/** Knowledge base list snapshot. */
export interface KbListSnapshot {
  items: KbMeta[]
  total: number
}

/**
 * 删除知识库时对**库内笔记**的处理方式。必须显式给出，后端不猜：
 *   · `reassign` —— 先把笔记移到 `targetKbId`，再删库行；
 *   · `purge`    —— 连同笔记一起删。
 * 不给缺省值，是为了让「删掉一个非空库」永远是一个被看见的决定。
 */
export type KbDeleteAction =
  | { kind: 'reassign'; targetKbId: number }
  | { kind: 'purge' }

/** Knowledge base mutation result (create/rename/delete). */
export interface KbMutationResult {
  ok: boolean
  id?: number
  /** `reassign`：真正迁移到目标库的笔记条数（供界面回执「已移动 N 条」）。 */
  movedNotes?: number
  /** `purge`：随库一起删掉的笔记条数（与上一条分开，否则界面说不清是移了还是删了）。 */
  removedNotes?: number
  /**
   * 连带处理的知识库文件条数。
   *
   * ⚠ `undefined` 与 `0` **不是一回事**：`0` = 清点过、这个库确实没有文件；
   * `undefined` = 文件清点没做成。两个库文件（笔记 / 文件）之间没有跨库事务，
   * 所以文件侧是 best-effort —— 界面必须能分开说「这个库没有文件」与
   * 「文件清点未完成」，否则一次失败会显示成「一个文件都没有」。
   */
  movedFiles?: number
  removedFiles?: number
  error?: string
}

/** One knowledge note: manual entry or distilled from an AI answer. */
export interface KnowledgeNote {
  id: number
  /** 所属知识库。老库升级后全部为 `DEFAULT_KB_ID`（=1）。 */
  kbId: number
  title: string
  /** Markdown-ish body; `[[target]]` / `[[target|display]]` are wiki links. */
  body: string
  tags: string[]
  /** 'manual' = user-authored; 'ask' = distilled from a WeChat Q&A answer. */
  sourceKind: 'manual' | 'ask'
  /** Chat the note was distilled from (used by the「跳回来源聊天」entry; not a graph node). */
  sourceUsername?: string
  /** Question that produced the note (details panel). */
  sourceQuestion?: string
  /** Unique `[[target]]` values found in the body, unresolved ones included. */
  links: string[]
  createdAt: number
  updatedAt: number
}

/** Knowledge note list snapshot. */
export interface NotesSnapshot {
  items: KnowledgeNote[]
  total: number
}

/** Note mutation result (save/delete). */
export interface NoteMutationResult {
  ok: boolean
  id?: number
  error?: string
}

/**
 * 知识库文件的解析状态。
 *
 * 取值域刻意包含**三个物理上不可续跑的中间态**（`parsing` / `chunking` / `embedding`）：
 * 进程被杀之后没有任何机制能从一半继续，所以启动时必须把它们全部重置为 `queued`
 * （见 `kb-files.ts` 的 `recoverInterrupted`）—— 不重置就会永久停在「正在解析」转圈。
 *
 * `unsupported` 与 `failed` 必须分开：
 *   · `unsupported` = 这台机器**没有**对应的解析器（等版本升级就能解，不是错误）；
 *   · `failed`      = 解析器存在但**真的抛了**（要用户换文件）。
 * 两者的排查方向完全不同，合并成一档就等于让用户去猜。
 * `sparse_only` = 正文已解析、但没有向量（无 Key / 断网 / 被出网闸门拦），
 * 此时**仍然可被关键词搜到** —— 不能因为嵌入不可用就把已解析好的正文一起废掉。
 */
export type KbFileParseState =
  | 'queued' | 'parsing' | 'chunking' | 'embedding'
  | 'ready' | 'unsupported' | 'failed' | 'sparse_only'

/** 知识库文件：`kb_files` 里的一行（不含块正文）。 */
export interface KbFileMeta {
  id: number
  /** 所属知识库。文件、分块、检索一律按它划作用域。 */
  kbId: number
  /** 文件名（不含路径），如 `2026Q1 合同.pdf`。 */
  name: string
  /** 小写扩展名（不含点）；无扩展名为 `''`。 */
  ext: string
  /**
   * 用户电脑上的原始路径。**只登记**：永不写、永不删、永不移。
   *
   * 解析的输入是 blob 副本而不是它，所以用户改名 / 移动 / 删除原文件都不影响
   * 已经入库的内容（设计稿 §10 边界 3）。
   */
  srcPath: string
  /** 内容指纹（sha256 hex）。同库内唯一 —— 去重按**内容**而不是文件名。 */
  sha256: string
  /** blob 副本的相对文件名（`<sha256>.<ext>`）；副本写失败时为空串。 */
  blobName: string
  sizeBytes: number
  parseState: KbFileParseState
  /** 实际使用的解析器名（`plain-text` / `markdown` / `html` / `csv`…）；未解析时为空。 */
  parser: string
  /** 不可用原因或降级说明。`unsupported` 时非空，且**不得**写成「文件损坏」。 */
  parseError: string
  chunkCount: number
  charCount: number
  /**
   * 是否参与向量化（出网）。默认 `true`，但它**不是**出网闸门本身：
   * 全局「禁止 AI 出网」仍然一起拦下。给文件级开关是为了让含敏感内容的文件
   * 完全不出网、却仍能被关键词搜到（设计稿 §9.2）。
   */
  includeInRag: boolean
  /**
   * 模型生成的摘要（`''` = 还没生成过）。
   *
   * ⚠ 它只覆盖**送进 prompt 的那一段**正文，不是全文的摘要 —— 一份几百万字的日志
   * 塞不进一次请求。所以界面上必须连 `summaryCoveredChars` 一起显示，
   * 只写「摘要」会让人以为看到的是整份文件的概括。
   */
  summary: string
  /** 生成这条摘要时用的模型标识；换模型后用来判断这条是不是旧的。 */
  summaryModel: string
  /** 生成时间（毫秒）；0 = 没有摘要。 */
  summaryAt: number
  /**
   * 本次摘要实际喂给模型的字符数。
   *
   * 必须**落库**而不是当场算：一份几百万字的日志只能喂前若干字，隔一周再看这条摘要时
   * 若不记得当时覆盖了多长，就没法诚实地标出「这只是前 8,000 字的摘要」。
   * 与 `charCount`（全文字数）不等就说明摘要没有覆盖全文。
   */
  summaryCoveredChars: number
  createdAt: number
  updatedAt: number
}

/** 文件列表快照。`readError` 只在读失败时出现（与 `KbListSnapshotRead` 同一纪律）。 */
export interface KbFileListSnapshot {
  kbId: number
  items: KbFileMeta[]
  total: number
  /** 读不到库时非空（此时 `items` 恒为 `[]`）；确无文件时为 undefined。 */
  readError?: string
}

/**
 * 一个正文块。**是解析出来的文本，不是原文件的排版** —— PDF/DOCX 的表格、图片、
 * 页眉页脚在解析阶段就丢了。界面必须把这件事说出来：看「检索与问答实际读到的正文」
 * 和看原稿可能得出不同结论。
 */
export interface KbFileChunk {
  /** 块在文档内的序号（原有顺序）。 */
  ordinal: number
  /** 页码，0 = 无页概念（txt / md / csv 等）。 */
  page: number
  /** 所属章节标题（`父 › 本段`，可为空串）。 */
  heading: string
  text: string
  charCount: number
}

/** 某个文件的正文分页。 */
export interface KbFileChunkPage {
  kbId: number
  fileId: number
  items: KbFileChunk[]
  /** 这个文件的总块数（用于「已读 N / M」与是否还有下一页）。 */
  total: number
  /** 总字数。 */
  totalChars: number
  /** 读不到、或该文件不存在 / 不属于当前库时非空（此时 `items` 恒为 `[]`）。 */
  readError?: string
}

/** 登记一个文件的入参。 */
export interface KbFileRegisterInput {
  /** 目标知识库（必填，没有「默认落哪个库」这种猜测）。 */
  kbId: number
  /** 用户电脑上的原始路径（对话框返回的那个）。 */
  srcPath: string
  /** 是否参与向量化；不给按 `true`。 */
  includeInRag?: boolean
}

/**
 * 登记结果。失败时 `code` 是**可被判定的**原因，`error` 是给人看的一句话。
 *
 * 为什么要 `code` 而不是只给文案：前端要按原因分支（重复 → 高亮已存在的那一行；
 * 类型不支持 → 提示白名单），而中文文案随时可能改。
 */
export interface KbFileRegisterResult {
  ok: boolean
  code?: 'bad-kb' | 'bad-path' | 'not-accepted' | 'too-large' | 'too-many'
    | 'duplicate' | 'read-failed' | 'store-failed'
  error?: string
  /** 成功时给出落地的那一行。 */
  file?: KbFileMeta
  /** `code:'duplicate'` 时指出撞上的是哪一行。 */
  duplicateOf?: { id: number; name: string }
}

/** 单文件变更结果（删除 / 开关）。 */
export interface KbFileMutationResult {
  ok: boolean
  error?: string
  /** 删除时回执：连带清掉的分块数 / 副本是否被删。 */
  removedChunks?: number
  removedBlob?: boolean
}

/**
 * 生成文件摘要的结果。
 *
 * `coveredChars` 与 `totalChars` **必须一起返回**：界面靠它俩决定要不要写
 * 「这只是前 N 字的摘要」。只回一句摘要文本，就等于把「摘要覆盖了多少」这件事
 * 藏进了界面上没人会去点开的地方。
 */
export interface KbSummaryResult {
  ok: boolean
  error?: string
  summary?: string
  /** 生成它的模型（`provider/model`）。 */
  model?: string
  at?: number
  coveredChars?: number
  totalChars?: number
}

/**
 * 删库时对**库内文件**的处理回执。
 *
 * `movedFiles` 与 `removedFiles` 必须分开：`reassign` 时目标库若已有同内容文件，
 * 唯一索引不允许两行同 sha256，该文件**不迁移**并计入 `removedFiles` ——
 * 静默合并会让用户以为文件丢了（设计稿 §10 边界 7）。
 */
export interface KbFilesDeleteReport {
  ok: boolean
  movedFiles: number
  removedFiles: number
  error?: string
}

/**
 * 一次「添加文件」（对话框多选的结果）的回执。
 *
 * 逐项结果都带回去，因为**部分成功是常态**：一次选了 10 个，其中 3 个重复、
 * 1 个类型不支持，不该把整次操作报成失败 —— 用户要看的是「这 6 个进来了，
 * 那 4 个分别因为什么没进来」。
 */
export interface KbFileAddResult {
  /** **至少有一个**登记成功才为 true；一个都没进来才是失败。 */
  ok: boolean
  added: number
  failed: number
  results: KbFileRegisterResult[]
  error?: string
}

/** 崩溃恢复回执。 */
export interface KbFileRecoveryReport {
  /** 本次真正重置的行数（`skipped` 为 true 时恒为 0）。 */
  reset: number
  /** 本进程是否已经对同一个数据根做过恢复。 */
  skipped: boolean
  readError?: string
}

/**
 * 知识库检索的通道名。
 *
 * T3 只开 `sparse`（关键词）；`dense` 在 T4 接上向量库；`structured` 留给
 * 「按文件名 / 类型 / 页码这类元数据」的检索。把三个名字一次定下来，
 * 是为了让 `ranks` / `stats.channels` 这两个形状在 T4 加通道时**不用改**——
 * 改形状会让前端的解释面板跟着改一遍，而那正是最容易漏测的地方。
 */
export type KbChannelName = 'sparse' | 'dense' | 'structured'

/**
 * 知识库检索的一条命中。
 *
 * 粒度是**块**（一个 chunk），不是文件：同一份文件命中三处就是三条。
 * 这与设计稿的 `docKey = 'chunk:' + chunkId` 一致 —— 融合阶段靠它把同一块
 * 在多通道的命中合并成一条，所以粒度必须统一在块上。
 */
export interface KbHit {
  /** 命中的文件行 id（探针第 6 步断言「结果第一条的 fileId = 该文件」用的就是它）。 */
  fileId: number
  /** 文件名（含扩展名），来自 `kb_files.name`。 */
  fileName: string
  /** 小写扩展名（不含点）。 */
  fileExt: string
  /** 命中的块 id。 */
  chunkId: number
  /** 块在文件内的序号（0 基）。 */
  ordinal: number
  /** 页码（1 基）；非分页形态为 0。 */
  page: number
  /** 面包屑（`H1 › H2`）；无标题时为空串。 */
  heading: string
  /** 摘要：命中词前后各 60 字符。 */
  snippet: string
  /**
   * 块**完整正文**（与 `snippet` 是两件事）。
   *
   * 为什么必须一并返回：`snippet` 只是命中词附近的窗口（`KB_SNIPPET_RADIUS` 两侧各 60 字），
   * 拿它当问答的引用证据会丢掉块里其余内容 —— 模型看到半句话就只能猜后半句，
   * 而重排的「词覆盖率」特征也会把只落在窗口外的检索词误判成未命中。
   * 面板检索只读 `snippet`（界面显示的就是那一段），不受影响。
   */
  text: string
  /**
   * 高亮区间，**偏移相对 `snippet`**（不是相对块原文）。
   *
   * 由后端算好给前端用，前端只做渲染、不做二次匹配 ——
   * 让前端自己再找一遍词，就会出现「后端按 bigram 命中、前端按字面找」的错位，
   * 表现为「搜到了但一个词都没高亮」。
   */
  marks: Array<{ start: number; end: number }>
  /** 相关度，**越大越相关**（`bm25` 取负）。跨查询之间不可比。 */
  score: number
  /** 各通道内的名次（1 基）；未命中该通道则缺省。 */
  ranks: Partial<Record<KbChannelName, number>>
}

/**
 * 知识库检索的统计。
 *
 * 刻意**不复用**消息域的 `RetrievalStats`：那 13 个字段里有一半是
 * 「消息 + 时间轴 + 意图分类」特有的（`intent` / `timeHint` / `hintHits` /
 * `recency` / `windowMessages` / `compressed` / `entity` / `fused`），
 * 知识库检索一个都产生不了。硬套的结果是往这些字段里填假值 ——
 * 而它们会直接显示在「为什么这条被召回」的解释里，等于给用户假信息。
 * 字段名与 `RetrievalStats` 的重合部分是刻意对齐的，T4 加稠密通道时形状不用动。
 */
export interface KbSearchStats {
  /** 各通道的参与情况。`active:false` 表示该通道没跑（附 `note` 说明原因）。 */
  channels: Array<{ channel: KbChannelName; count: number; active: boolean; note?: string }>
  /** 召回条数（= 命中块数）。 */
  recalled: number
  /** 最终保留条数；T3 无重排、无截断，与 `recalled` 相同。 */
  kept: number
  /** 实际生效的检索词数（标点被 bigram 化丢弃后可能少于用户输入）。 */
  terms: number
  /** 端到端耗时（毫秒）。 */
  elapsedMs: number
}

/**
 * 一次知识库检索的结果。
 *
 * 三个可选字段分别对应三种「没搜成」，**不能合并**：
 *   · `degraded` —— 搜成了，但只走了部分通道（界面上是「仅关键词（未建向量索引）」）；
 *   · `error`    —— 这次请求本身无效（如库标识缺失），重试无用；
 *   · `readError` —— 库打不开，可能是临时占用，重试可能成功。
 */
export interface KbSearchResult {
  kbId: number
  /** 回显用户输入（界面在结果区标题上原样显示，避免「看到的是上一次的结果」）。 */
  query: string
  hits: KbHit[]
  stats: KbSearchStats
  /**
   * 降级说明：`reason` 给代码判分支，`label` 给界面直接显示。
   *
   * 四种「只有关键词」的出路完全不同，混成一句就是假话：
   *   · `no-embed-model` 没配向量模型 ⇒ 去模型配置；
   *   · `no-vector-index` 本库还没建过索引 ⇒ 点「语义索引」；
   *   · `index-stale` 建过但换了嵌入模型 ⇒ 必须重建（且会再次出网）；
   *   · `embed-failed` 这次出网失败 ⇒ 重试或看网络，索引本身没问题。
   */
  degraded?: {
    reason: 'no-vector-index' | 'no-network' | 'no-key' | 'no-embed-model' | 'index-stale' | 'embed-failed'
    label: string
  }
  /** 请求无效的原因（如知识库标识缺失）。 */
  error?: string
  /** 库读不到（与「确实没有匹配」必须分开）。 */
  readError?: string
}

/**
 * Knowledge graph: note nodes plus `[[target]]` edges, **plus the document
 * entity layer** (registered files and the section headings inside them).
 *
 * The doc fields are required on purpose: an optional shape would let a caller
 * render a notes-only graph and silently keep files out of it, which is exactly
 * the gap this layer exists to close.
 */
export interface KnowledgeSnapshot {
  notes: Array<{
    id: number
    title: string
    excerpt: string
    tags: string[]
    sourceKind: 'manual' | 'ask'
    sourceUsername?: string
    sourceQuestion?: string
    createdAt: number
    updatedAt: number
    /** Distinct outgoing wiki links (stubs included). */
    outLinks: number
    /** Incoming wiki links. */
    backLinks: number
  }>
  /** Unresolved `[[target]]` values. */
  stubs: Array<{ key: string; label: string; refCount: number; referencedBy: number[] }>
  /** Registered files, one node each (`file:<id>`). Never per chunk — see `query/kb/entities.ts`. */
  docFiles: Array<{
    id: number
    label: string
    ext: string
    chunkCount: number
    charCount: number
    parseState: string
  }>
  /**
   * Section entities (`doc:<key>`), normalized and **merged across files**: the
   * same section title in three documents is one node, which is what makes
   * cross-document structure visible at all.
   */
  docSections: Array<{
    key: string
    label: string
    /** 出现过这一节的文件与**各自**的次数：containment 边的权重按它来定。 */
    files: Array<{ id: number; count: number }>
    occurrences: number
  }>
  /**
   * Model-extracted entities (`ent:<key>`) —— **推断层**，与上面两个观测层字段不同源。
   *
   * 它们来自 `query/kb/extract.ts`（让模型读一遍文件后说出的实体），
   * 可信度低于「文档里确实存在的章节」，所以：
   *   · 单独一个命名空间（`ent:`），不与 `doc:`（章节）混用；
   *   · 连到文件的边 kind 是 `suggest`，画布上画**虚线**；
   *   · 带着是哪个模型、什么时候抽的 —— 换模型后用户要能看出这批不是当前模型给的。
   * 同一 label 在多个文件里被抽出 ⇒ 合成一个节点，`files` 记各自的权重。
   */
  docEntities: Array<{
    key: string
    label: string
    kind: string
    files: Array<{ id: number; weight: number }>
    occurrences: number
    model: string
    at: number
  }>
  /**
   * `note:<id>` → `note:<id>` (wiki) · `note:<id>` → `kb:<key>` (stub) ·
   * `file:<id>` → `doc:<key>` (contain: the section really is in that file) ·
   * `note:<id>` → `file:<id>` (mention: the note's title occurs in the file text) ·
   * `file:<id>` → `ent:<key>` (suggest: **模型推断**的实体，不是文档里观测到的).
   */
  edges: Array<{
    source: string
    target: string
    weight: number
    kind: 'wiki' | 'stub' | 'contain' | 'mention' | 'suggest'
  }>
  /** Source chat usernames → display names (labels for the note's source-chat entry). */
  sessionNames: Record<string, string>
  summary: {
    noteCount: number
    linkCount: number
    stubCount: number
    orphanCount: number
    askCount: number
    manualCount: number
    fileCount: number
    sectionCount: number
    /** 模型抽出的实体节点数（推断层）。0 = 这个库还没抽过。 */
    entityCount: number
  }
}

/** One native WeChat reminder (handoff_remind_v0) row. */
export interface HandoffRemindItem {
  id: number
  title: string
  time: number | null
}

/** Native reminder snapshot. */
export interface HandoffRemindsSnapshot {
  items: HandoffRemindItem[]
  total: number
}

/** One privacy audit feature aggregate. */
export interface PrivacyAuditFeature {
  feature: string
  count: number
  chars: number
}

/** One raw privacy audit row. */
export interface PrivacyAuditRow {
  id: number
  feature: string
  ts: number
  chars: number
  sessions: number
  messages: number
}

/** Privacy audit clear result. */
export interface PrivacyAuditClearResult {
  ok: boolean
  removed: number
}

/** Privacy settings + audit snapshot. */
export interface PrivacyStateSnapshot {
  redactSensitive: boolean
  blockOutbound: boolean
  audit: {
    total: number
    byFeature: PrivacyAuditFeature[]
    last: number | null
    updatedAt: number
  }
}

/** Operation-log category families recorded by the app (metadata only). */
export type OperationCategory =
  | 'settings'   // 设置更改
  | 'keys'       // 密钥检测/校验/生成
  | 'sync'       // 解密与同步
  | 'export'     // 导出
  | 'delete'     // 删除
  | 'backup'     // 备份与恢复
  | 'edit'       // 消息编辑
  | 'task'       // 任务与摘要
  | 'error'      // 异常事件

/** Outcome of one logged operation. */
export type OperationStatus = 'ok' | 'fail' | 'skip'

/** One operation-log entry (metadata only; never carries message bodies). */
export interface OperationLogEntry {
  id: number
  ts: number
  category: OperationCategory
  action: string
  target: string
  status: OperationStatus
  detail: string
}

/**
 * Filter for reading the operation log. Categories arrive at the wire
 * boundary, so unknown values are tolerated and dropped by the host.
 */
export interface OperationLogQuery {
  from?: number
  to?: number
  categories?: string[]
  status?: OperationStatus
  /**
   * 关键词：在 `action` / `target` / `detail` 上做包含匹配。
   *
   * 为什么必须在服务端做：日志只能按「最新 N 条」取一页，客户端过滤等于
   * **只搜最新那一页**（实测 2144 条里只能搜到最新 500 条，覆盖率 23%），
   * 而按时间往回翻是审计场景最常见的动作。
   */
  q?: string
  limit?: number
  offset?: number
}

/** Operation-log page: matching entries (newest first) + full match count. */
export interface OperationLogSnapshot {
  items: OperationLogEntry[]
  total: number
}

/** Operation-log clear result. */
export interface OperationLogClearResult {
  ok: boolean
  removed: number
}

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

/**
 * One call (type 50) peer aggregate.
 *
 * 语音/视频刻意不分类：`room_type` 的语义在本机数据里判不了（见 query/calls.ts）。
 */
export interface CallPeer {
  username: string
  name: string
  calls: number
  connected: number
  durationSec: number
  lastTime: number
}

/** One month of call activity (`YYYY-MM`). */
export interface CallMonthRow {
  month: string
  calls: number
  connected: number
  durationSec: number
}

/** One call record (newest first in the snapshot). */
export interface CallRecord {
  username: string
  name: string
  localId: number
  createTime: number
  status: string
  connected: boolean
  outgoing: boolean
  durationSec?: number
}

/**
 * Call inventory snapshot, derived from the zstd `voipmsg` XML of type-50 rows.
 *
 * `missed` counts every non-connected outcome (取消/拒绝/未应答/忙线). `ackElsewhere`
 * counts calls answered on another device: connected but with no local duration.
 */
export interface CallsSnapshot {
  total: number
  connected: number
  missed: number
  durationSec: number
  avgSec: number
  longestSec: number
  longestPeer: string
  outgoing: number
  incoming: number
  ackElsewhere: number
  peers: CallPeer[]
  peerCount: number
  months: CallMonthRow[]
  byHour: number[]
  unanswered: Array<{ status: string; count: number }>
  recent: CallRecord[]
  from: number | null
  to: number | null
  updatedAt: number
}

/** One edited-message record. */
export interface EditedMessageRecord {
  sessionId: string
  db: string
  tableName: string
  localId: number
  lastEditedAt: number
  editCount: number
  originalMsgJson: string
}

/** Edited-message list snapshot. */
export interface EditedListSnapshot {
  items: EditedMessageRecord[]
  total: number
}

/** Edit mutation result. */
export interface EditMutationResult {
  ok: boolean
  error?: string
  localId?: number
}

/** Draft clear result (one session). */
export interface DraftClearResult {
  ok: boolean
  updated: number
  error?: string
}

/** Clear-all-drafts result with the cleared list. */
export interface DraftsClearResult {
  ok: boolean
  cleared: Array<{ username: string; draft: string }>
  count: number
  error?: string
}

/** One summary task. */
export interface SummaryTask {
  id: number
  groupUsername: string
  groupName: string
  targetUsers: string[]
  format: string
  customPrompt: string
  scheduleTime: string
  enabled: boolean
  lastRunAt?: number
  lastStatus: string
  lastError: string
  createdAt: number
  updatedAt: number
}

/** Task list snapshot. */
export interface SummaryTaskSnapshot {
  items: SummaryTask[]
  total: number
}

/** Task mutation result. */
export interface SummaryTaskMutationResult {
  ok: boolean
  id?: number
  error?: string
}

/** One summary record. */
export interface SummaryRecord {
  id: number
  taskId: number
  groupUsername: string
  groupName?: string
  summaryDate: string
  summary: string
  messageCount: number
  status: string
  error: string
  createdAt: number
}

/** Record list snapshot. */
export interface SummaryRecordSnapshot {
  items: SummaryRecord[]
  total: number
}

/** Run-task result. */
export interface SummaryTaskRunResult {
  ok: boolean
  summary?: string
  messageCount?: number
  error?: string
}

/** Avatar resolution result. */
export interface AvatarResult {
  kind: string
  data?: string
  url?: string
}

/** Full WeChat config + resolved fixed paths. */
export interface WechatConfigFull {
  db_dir: string
  wechat_process: string
  key_format: string
  db_enc_key: string
  image_aes_key: string
  image_xor_key: number
  api_enabled: boolean
  api_port: number
  api_token: string
  cdn_enabled: boolean
  cdn_local_decrypt: boolean
  whisper_device: 'cpu' | 'gpu'
  whisper_model: string
  whisper_threads: number
  whisper_models_dir: string
  /** Persisted whisper-cli engine path (file or its bin dir). */
  whisper_bin: string
  resolved?: Record<string, string>
}

/** Detected WeChat account. */
export interface WechatAccount {
  wxid: string
  db_dir: string
  last_active?: number
  /** 解密库文件数（db_storage 下 .db 计数，不含 -wal/-shm）。 */
  db_files?: number
}

/** Account detection snapshot. */
export interface AccountsSnapshot {
  accounts: WechatAccount[]
  total: number
  /** 微信版本（安装目录下的版本文件夹，如 4.1.12.26）。 */
  version?: string
  /** 微信安装目录（注册表 InstallPath，供密钥扫描定位 Weixin.dll）。 */
  install_dir?: string
}

/** Database key verification result. */
export interface VerifyKeyResult {
  valid: boolean
  aesOk?: boolean
  hmacOk?: boolean
  error?: string
}

/** Keys-file generation result. */
export interface GenerateKeysResult {
  ok: boolean
  verified: number
  total: number
  error?: string
}

/** Keys-file info. */
export interface KeysInfoResult {
  keyFormat?: string
  keyCount: number
  loaded: boolean
}

/** Auto-recovered V4 database key result (key_v4 memory scan). */
export interface AutoDbKeyResult {
  ok: boolean
  key?: string
  source?: string
  error?: string
}

/** Auto-recovered image key result (V2-verified memory scan). */
export interface AutoImageKeyResult {
  ok: boolean
  xorKey?: number
  aesKey?: string
  verified?: boolean
  wxid?: string
  code?: number
  templatePath?: string
  error?: string
}

/** One per-database decryption failure. */
export interface DecryptFailure {
  /** Database rel path inside db_storage. */
  db: string
  error: string
}

/** Full decryption result (立即解密). */
export interface DecryptAllResult {
  ok: boolean
  /** Databases found in db_storage. */
  total: number
  okCount: number
  failed: DecryptFailure[]
  error?: string
}

/** Saved image-key verification result. */
export interface VerifyImageKeyResult {
  verified: boolean
  aesKey?: string
  xorKey?: number
  templatePath?: string
  error?: string
}

/** Batch image decryption result (立即解密图片). */
export interface DecryptImagesResult {
  ok: boolean
  /** md5-prefixed .dat files found under msg/attach. */
  total: number
  okCount: number
  failed: number
  /** Already-cached / non-renderable (hevc) files. */
  skipped: number
  errors: Array<{ file: string; error: string }>
  /** 被跳过的文件与原因（详情弹窗用）。 */
  skippedDetails?: Array<{ file: string; reason: string }>
  error?: string
}

/** Live decryption progress snapshot (getDecryptStatus). */
export interface DecryptStatus {
  /** Which decryption op is (or was last) running. */
  op: 'databases' | 'images' | null
  active: boolean
  done: number
  total: number
  failed: number
  skipped: number
  /** Current file/database short label. */
  message: string
}

/** One Whisper model catalog entry (installed flag from the models dir). */
export interface WhisperModelInfo {
  id: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3' | 'turbo'
  name: string
  sizeLabel: string
  installed: boolean
}

/** Live Whisper model download progress. */
export interface WhisperDownloadProgress {
  model: string
  file: string
  received: number
  total: number
}

/** Live voice batch transcription progress. */
export interface WhisperTranscribing {
  active: boolean
  done: number
  total: number
  failed: number
  skipped: number
  current: string
}

/** Voice batch transcription result. */
export interface VoiceTranscribeResult {
  ok: boolean
  total: number
  done: number
  failed: number
  skipped: number
  errors: Array<{ svrId: string; username: string; error: string }>
  engine: string
  model?: string
  error?: string
}

/** Per-message transcript result. */
export interface VoiceTranscriptResult {
  text?: string
  error?: string
}

/** One-shot voice-message transcription result (chat bubble 语音转文字). */
export interface VoiceTranscribeOneResult {
  ok: boolean
  text?: string
  error?: string
}

/** Whisper model download result. */
export interface WhisperDownloadResult {
  ok: boolean
  file?: string
  bytes?: number
  error?: string
}

/** Whisper transcription configuration status (getWhisperStatus). */
export interface WhisperStatus {
  /** Detected whisper engine ('whisper-cli' | 'whisper' | '' when none). */
  engine: string
  enginePath?: string
  hasCuda: boolean
  /** Effective models dir (configured or the default under the data root). */
  modelsDir: string
  models: WhisperModelInfo[]
  /** Active model download progress (null when idle). */
  downloading: WhisperDownloadProgress | null
  /** Active voice transcription progress. */
  transcribing: WhisperTranscribing
}

/** Generic ok/error result. */
export interface SimpleResult {
  ok: boolean
  error?: string
}

/** Fields the config form can save. */
export interface WechatConfigPatch {
  db_dir?: string
  db_enc_key?: string
  image_aes_key?: string
  image_xor_key?: number
  api_enabled?: boolean
  api_token?: string
  api_port?: number
  cdn_enabled?: boolean
  cdn_local_decrypt?: boolean
  whisper_device?: 'cpu' | 'gpu'
  whisper_model?: string
  whisper_threads?: number
  whisper_models_dir?: string
  whisper_bin?: string
}

/** Delete result. */
export interface DeleteFavoriteResult {
  ok: boolean
  deleted: number
  error?: string
}

/** Annual report (local-only yearly stats). */
export interface AnnualReport {
  year: number
  total: number
  active_days: number
  text_chars: number
  daily_avg: number
  text_share: number
  night_share: number
  morning_share: number
  weekend_share: number
  group_share: number
  heat: number[]
  monthly: number[]
  kind_counts: Record<string, number>
  top_phrases: Array<{ phrase: string; count: number }>
  top_emoji: Array<{ emoji: string; count: number }>
  top_contacts: Array<{ username: string; name: string; count: number; share: number }>
  top_groups: Array<{ username: string; name: string; count: number; share: number }>
  first_message?: string
  last_message?: string
  persona_tags: string[]
}

/** Host event vocabulary for the wechat-data surface. */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * New WeChat messages were synced from the raw encrypted DBs into the
     * decrypted snapshot (a WAL increment or a full re-decrypt). Panels
     * refresh on it instead of waiting for the next polling tick.
     * @mode emit
     * @param shards - message shard file names that were updated.
     */
    'wechat-data/updated'(shards: string[]): void
    /**
     * 微信问答的流式回答增量：payload 是 `{ id, text }`，`id` 为本次流式请求的标识
     * （由客户端在调用 askWechat 时生成），渲染端按 id 把增量拼起来。
     * 由 `gateway.ts` 的流式回调发出、`src/client/ui-app/ui-entry.tsx` 消费。
     * @mode emit
     * @param payload - 流式标识与本次新增的文本片段。
     */
    'wechat-ask/delta'(payload: { id: string; text: string }): void
    /**
     * 导出/加密备份的进度（M3）：payload 是 `{ jobId, phase, done, total }`。
     *
     * `jobId` 由渲染层在调用 `exportAllSessions` / `exportMoments` / `createEncryptedBackup`
     * 时自己生成并回传 —— 函数与 AbortSignal 都过不了 IPC，所以进度与取消都靠这个标识
     * （取消走 `cancelExportJob({ jobId })`，兜底读进度走 `getExportProgress({ jobId })`）。
     * `total = 0` 表示总量未知（流式压缩阶段算不出来），渲染端据此显示不定量进度。
     * @mode emit
     * @param payload - 任务标识与本次进度。
     */
    'wechat-export/progress'(payload: { jobId: string; phase: string; done: number; total: number }): void
  }
}
