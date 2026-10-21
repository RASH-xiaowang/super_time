import type { FavItemPart } from '../types.ts';
/** 收藏类型标签（微信 fav type）。 */
export declare function favTypeLabel(t: number): string;
/** One parsed resource part of a favorite (kept open for unknown datatypes). */
type FavRawPart = FavItemPart;
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
