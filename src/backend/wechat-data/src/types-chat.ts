/**
 * `types.ts` 的 chat 部分（M21 拆分；纯类型，无运行期值）。
 *
 * 从 `types.ts` 原样搬出，`types.ts` 继续以 `export *` 转发 ⇒ 所有
 * `from './types.ts'` / `from '../types.ts'` 的导入路径一行都不用改。
 *
 * @module types-chat
 */
/**
 * WeChat data types, mirrored from the st_control wechat module. The gateway
 * reads st_control's decrypted SQLite and projects these shapes to the
 * browser Remote client.
 */

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
