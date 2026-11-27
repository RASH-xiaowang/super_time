import type { PortraitVolume } from '../types.ts';
/**
 * 统计这些 username 的聊天条数、图片条数和朋友圈条数。
 * @param decryptedDir - 解密数据根。
 * @param usernames - 要统计的联系人。空串和群 id 会被跳过。
 * @returns 与请求对应的内容量；没有记录的人三项都是 0。
 */
export declare function queryPortraitVolumes(decryptedDir: string, usernames: readonly string[]): PortraitVolume[];
/** 先读缓存。没有缓存时按分片统计，每片让出一次事件循环，避免堵住性格存档的读取。 */
export declare function queryPortraitVolumesCached(decryptedDir: string, usernames: readonly string[]): Promise<PortraitVolume[]>;
/**
 * 信息量排序的缓存读取。分片签名没变、请求的人都在缓存里时不再扫消息库。
 * 签名变了或缓存损坏时返回 undefined，调用方再全量统计。
 */
export declare function readPortraitVolumeCache(decryptedDir: string, usernames: readonly string[]): PortraitVolume[] | undefined;
/** 把刚统计完的信息量写到内存和硬盘。写失败不影响本次返回。 */
export declare function writePortraitVolumeCache(decryptedDir: string, rows: readonly PortraitVolume[]): void;
