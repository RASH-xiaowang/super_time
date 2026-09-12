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
export declare function queryFavorites(decryptedDir: string, limit?: number, offset?: number): {
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
//# sourceMappingURL=favorites.d.ts.map