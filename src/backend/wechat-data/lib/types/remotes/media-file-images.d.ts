/**
 * 文件库图片的两个 Remote 实现（2026-10-21 从 `remotes/media.ts` 拆出）。
 *
 * 为什么拆：`remotes/media.ts` 已 1020 行（>1000 棘轮）、`createMediaRemotes` 355 行
 * （登记 317）。这里只搬实现、不动签名：工厂返回同名方法，media.ts 里用
 * `...createFileImageRemotes(rc)` 展开，行为与逐字搬运前一致。
 */
import type { FileImageDataUrlsResult, ImageDataUrlResult } from '../types.ts';
/** 这些方法只需要数据根与原目录解析（与其它 media Remote 一致）。 */
export interface FileImageRemoteCtx {
    dirs: () => {
        decrypted: string;
        decoded: string;
    };
    rawWechatBase: (decrypted: string) => string;
}
/**
 * 构造文件库图片的两个 Remote 方法。
 * @param rc - 运行上下文（`dirs()` / `rawWechatBase()`）。
 * @returns 单张与批量两个方法（签名与拆分前完全一致）。
 */
export declare function createFileImageRemotes(rc: FileImageRemoteCtx): {
    getFileImageDataUrl: (options: {
        md5: string;
        thumbFirst?: boolean;
    }) => Promise<ImageDataUrlResult>;
    getFileImageDataUrls: (options: {
        keys: string[];
        thumbFirst?: boolean;
    }) => Promise<FileImageDataUrlsResult>;
};
