import type { ImageDataUrlResult } from '../types.ts';
type FavoriteKind = 'image' | 'video' | 'audio' | 'file' | 'unknown';
/**
 * 按内容 MD5 读取一个收藏资源。
 * @param wechatBaseDir - 微信账号根目录。
 * @param options - XML 里的 md5 / 类型提示。
 * @param aesKey - 当前账号的图片 AES 密钥。
 * @param xorKey - 当前账号的 XOR 字节。
 * @returns data URL 或可读错误；本地收藏缓存没有时返回 error。
 */
export declare function resolveFavoriteMediaDataUrl(wechatBaseDir: string | undefined, options: {
    md5?: string;
    thumbMd5?: string;
    fullMd5?: string;
    kind?: FavoriteKind;
    ext?: string;
    fileName?: string;
    size?: number;
}, aesKey: string | undefined, xorKey: number): ImageDataUrlResult;
/** 只供测试/账号切换时清空内存索引。 */
export declare function clearFavoriteMediaIndex(): void;
export {};
