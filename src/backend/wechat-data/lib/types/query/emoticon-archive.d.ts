import type { EmoticonItem } from '../types.ts';
/** 一次扫目录，给已有文件的表情带上相对路径。网格用这个路径直接显示。 */
export declare function withSavedEmoticonFiles(decodedDir: string, items: readonly EmoticonItem[]): EmoticonItem[];
/** 档案库路径：`<数据根>/emoticon-archive.db`，数据根是 `decoded_images` 的上一级。 */
export declare function emoticonArchivePath(decodedDir: string): string;
/** 读出已归档的其他表情，按出现次数从高到低。库不存在或读失败时返回空数组。 */
export declare function readArchivedOthers(decodedDir: string): EmoticonItem[];
/** 按 md5 合并进档案。已有的行保留较大的次数，并补上原来缺失的 CDN 地址。 */
export declare function upsertArchivedOthers(decodedDir: string, items: readonly EmoticonItem[]): void;
export interface MessageShardSig {
    name: string;
    sig: string;
}
/** 当前消息分片的文件签名（mtime + size）。 */
export declare function listMessageShardSigs(decryptedDir: string): MessageShardSig[];
/** 还没记过、或签名变了的分片。这些才需要再扫一遍找新表情。 */
export declare function staleMessageShards(decodedDir: string, decryptedDir: string): string[];
/** 把扫过的分片签名写上，下次签名没变就不再打开这些库。 */
export declare function rememberMessageShards(decodedDir: string, decryptedDir: string, names: readonly string[]): void;
/** 已落盘表情的相对路径（`md5.ext`）。没有文件时返回空串。 */
export declare function savedEmoticonRelPath(decodedDir: string, md5: string): string;
/** 这张表情图是否已经在 decoded_images 里。同 md5 不重复下载。 */
export declare function emoticonImageSaved(decodedDir: string, md5: string): boolean;
/**
 * 把还没有落盘的表情图排队下载。已有文件的 md5 直接跳过。
 * 下载在后台进行，不挡住列表返回。
 */
export declare function scheduleEmoticonImageSave(decodedDir: string, items: readonly EmoticonItem[]): void;
