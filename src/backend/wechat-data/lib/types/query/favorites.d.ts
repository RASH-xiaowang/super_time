import type { FavItemPart } from '../types.ts';
/** 收藏类型标签（微信 fav type）。 */
export declare function favTypeLabel(t: number): string;
/**
 * Parse favourites content XML into (title, desc, url).
 *
 * 第 44 轮修正了四处**取错元素**（都以真实 XML 为据，实测 71 条收藏里约 58 条因此显示不出标题）：
 *
 * | favType | 原始 XML 里的实际位置 | 旧实现读的位置 | 后果 |
 * | --- | --- | --- | --- |
 * | 1 文本 | `<desc>`（含 `&#x0A;` 等实体） | 读了 `<title>`（不存在）且**没解码** | 标题退化成「文本」，正文直接显示 `&#x0A;` |
 * | 8 文件（42 条） | `<desc>` = 文件名 | 读了 `<title>`（不存在） | 标题退化成「文件」 |
 * | 5 链接 | 顶层 `<title>` 可为空，`<dataitem><datatitle>` 有值 | 只读顶层 | 6 条里 5 条标题退化成「链接」 |
 * | 6 位置 | `<locitem><poiname>` / `<locitem><label>`（**元素**） | 读 `<location poiname="…">`（**属性**） | 标题退化成「位置」 |
 *
 * 客户端的 `parseFavItem` 是 `f.title || info.title || typeLabel`，所以后端给空就会一路掉到
 * 类型标签 —— 修复点放在后端，所有消费方一致受益。
 */
export declare function parseFavContent(favType: number, xml: string): {
    title: string;
    desc: string;
    url: string;
};
/** One parsed resource part of a favorite (kept open for unknown datatypes). */
export type FavRawPart = FavItemPart;
/**
 * Parse `<datalist><dataitem>` entries into typed parts (mirror parse_fav_detail).
 *
 * 导出给统一搜索复用：资源定位必须与收藏详情面板使用同一份 XML 解释，
 * 否则同一收藏在两处会得到不同的文件名/MD5/类型。
 */
export declare function parseFavParts(xml: string): FavRawPart[];
interface FavorItem {
    localId: number;
    /** uint64 字符串，避免 JSON/JS number 丢精度。 */
    serverId?: string;
    /** 收藏来源消息/资源 uint64 字符串。 */
    sourceId?: string;
    type: number;
    typeLabel: string;
    title: string;
    desc: string;
    url: string;
    updateTime: number;
    time: string;
    content: string;
    fromUsr: string;
    chatName: string;
    source: string;
    /**
     * 来源头像：本机 data URL、contact 表头像地址，或 32 位头像 MD5。
     * MD5 由客户端交给 `apiGetSnsImageDataUrl` 解出本机图（与收藏图片同一条缓存链）。
     */
    avatar?: string;
    items: FavRawPart[];
}
/**
 * Read the favorites list with parsed title/desc/url/source.
 * @param decryptedDir - decrypted data root.
 * @param limit - max rows.
 * @param q - 关键词：匹配收藏 XML / 来源账号 / 实际发送者。
 * @param wechatBaseDir - 微信原始账号根目录（仅用于 `temp/head_image` 缓存）。
 * @returns the favorites snapshot.
 */
export declare function queryFavorites(decryptedDir: string, limit?: number, offset?: number, q?: string, wechatBaseDir?: string): {
    favorites: FavorItem[];
    total: number;
};
/**
 * Delete favorite items by local_id (writes to favorite.db copy).
 * @param decryptedDir - decrypted data root.
 * @param ids - local_ids to delete.
 * @returns deleted count.
 */
export declare function deleteFavoriteItems(decryptedDir: string, ids: number[]): {
    ok: boolean;
    deleted: number;
    error?: string;
};
export {};
