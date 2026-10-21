import type { ImageDataUrlResult } from '../types.ts';
/** 收藏入口只需要数据根与原目录解析（与其它 media Remote 一致）。 */
export interface FavoriteMediaRemoteCtx {
    dirs: () => {
        decrypted: string;
        decoded: string;
    };
    rawWechatBase: (decrypted: string) => string;
}
/** 收藏资源入参（与 `resolveFavoriteMediaDataUrl` 的选项一致）。 */
export interface FavoriteMediaOptions {
    md5?: string;
    thumbMd5?: string;
    fullMd5?: string;
    kind?: 'image' | 'video' | 'audio' | 'file' | 'unknown';
    ext?: string;
    fileName?: string;
    size?: number;
}
/**
 * 构造收藏资源 Remote。
 * @param rc - 运行上下文（`dirs()` / `rawWechatBase()`）。
 * @returns `{ getFavoriteMediaDataUrl }`（签名与拆分前一致）。
 */
export declare function createFavoriteMediaRemotes(rc: FavoriteMediaRemoteCtx): {
    getFavoriteMediaDataUrl: (options: FavoriteMediaOptions) => ImageDataUrlResult;
};
