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
    username: string;
    nickname: string;
    to_username: string;
    to_nickname: string;
    content: string;
    ts: number;
    /** Comment-attached image. */
    image?: {
        thumb?: string;
        url?: string;
        md5?: string;
        mediaId?: string;
    };
}
/** One moments (朋友圈) entry (content XML parsed; CDN media URLs unresolved). */
export interface MomentItem {
    tid: string;
    username: string;
    author: string;
    text: string;
    ts: number;
    time: string;
    media_count: number;
    media_desc: string;
    images: Array<{
        thumb: string;
        url: string;
        key: string;
        md5: string;
        id?: string;
        timelineId?: string;
    }>;
    videos: Array<{
        url: string;
        thumb: string;
        key: string;
        md5: string;
        duration: number;
        id?: string;
        timelineId?: string;
    }>;
    location: string;
    /** 位置的城市名（`<location city="南宁市">`）。 */
    city?: string;
    /** 国家名（`<location country="中国">`）。 */
    country?: string;
    /** 真实纬度（已修正 moments XML 里 latitude/longitude **写反**的问题）。 */
    lat?: number;
    /** 真实经度（同上）。 */
    lng?: number;
    link_title: string;
    link_url?: string;
    contentType?: number;
    sourceNickName?: string;
    publicUserName?: string;
    is_self: boolean;
    likes: Array<{
        username: string;
        nickname: string;
    }>;
    comments: Array<MomentCommentItem>;
}
/** One parsed dataitem part of a favorite. */
export interface FavItemPart {
    kind: 'text' | 'image' | 'voice' | 'video' | 'link' | 'file';
    text?: string;
    md5?: string;
    url?: string;
    duration?: number;
    name?: string;
    ext?: string;
    size?: number;
    sourceName?: string;
    sourceTime?: string;
    sourceHead?: string;
}
/** One favorites entry. */
export interface FavorItem {
    localId: number;
    type: number;
    /** 类型中文名（微信 fav type）。 */
    typeLabel: string;
    /** 收藏标题（从 content XML 解析）。 */
    title: string;
    /** 收藏正文/描述（保留换行）。 */
    desc: string;
    /** 链接类收藏的 URL。 */
    url: string;
    updateTime: number;
    /** 收藏时间（YYYY-MM-DD HH:mm）。 */
    time: string;
    content: string;
    fromUsr: string;
    chatName: string;
    /** 来源显示名（群名优先，其次发送者，经通讯录解析）。 */
    source: string;
    /** 拆分后的资源数据（文本/图片/语音/视频/链接/文件）。 */
    items?: FavItemPart[];
}
/** One resource file entry. */
export interface FileItem {
    md5: string;
    fileName: string;
    fileSize: number;
    modifyTime: number;
    category: string;
    /** Source chat display name resolved from message resource when available. */
    sessionName?: string;
    /** Source message create time when available. */
    sourceTime?: number;
    /** 来源月份（第 84 轮）：`dir1`/`dir2` → `dir2id` 的 `YYYY-MM`，三个表 100% 有值。 */
    sourceMonth?: string;
    /** 来源会话显示名（第 84 轮）：`dir2id` 的值实测是 `md5(username)`，反查得到会话名。 */
    sourceTalker?: string;
}
/** Moments snapshot. */
export interface MomentsSnapshot {
    moments: MomentItem[];
    total: number;
}
/** One month bucket in the full moments monthly distribution. */
export interface MomentsMonthlyRow {
    month: string;
    count: number;
}
/** Favorites snapshot. */
export interface FavoritesSnapshot {
    favorites: FavorItem[];
    total: number;
}
/** Files snapshot. */
export interface FilesSnapshot {
    files: FileItem[];
    total: number;
    /**
     * 分类计数（第 83 轮新增）：image / file / video 各自的**全库**行数，
     * 与本次 `category` 过滤无关 —— 界面用它渲染「全部 / 图片 / 视频 / 文件」四个入口的真实条数。
     */
    counts: Record<string, number>;
}
