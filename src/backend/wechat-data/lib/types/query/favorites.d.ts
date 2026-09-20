/** 收藏类型标签（微信 fav type）。 */
export declare function favTypeLabel(t: number): string;
/** One parsed dataitem part of a favorite (text/image/voice/video/link/file). */
interface FavRawPart {
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
interface FavorItem {
    localId: number;
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
    items: FavRawPart[];
}
/**
 * Read the favorites list with parsed title/desc/url/source.
 * @param decryptedDir - decrypted data root.
 * @param limit - max rows.
 * @returns the favorites snapshot.
 */
export declare function queryFavorites(decryptedDir: string, limit?: number, offset?: number, 
/**
 * 关键词：匹配 `content`（收藏条目 XML，标题与描述就在里面）/ `fromusr` / `realchatname`。
 * 放在服务端是因为收藏分页只有 120 条一页，客户端过滤永远只搜得到已加载的那一页。
 */
q?: string): {
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
