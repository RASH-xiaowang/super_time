import { type DecodeDatPayload } from './media-image.ts';
import { type WxgfTranscoderAsync } from './wxam-image.ts';
export type AsyncImageResult = {
    url?: string;
    format?: string;
    thumb?: boolean;
    /** 相对 decoded_images 的落盘路径（如 `wxid_x/ab12.jpg`）：桌面端拼 wechat-media://，手机端忽略。 */
    file?: string;
    error?: string;
};
/**
 * 异步版 `decodeDatBytes`。解密本身仍是 CPU 内的纯计算；wxgf 转码时才会真正 await。
 */
export declare function decodeDatBytesAsync(data: Uint8Array, aesKey: Uint8Array | string | null, xorKey: number, opts?: {
    wxgf?: WxgfTranscoderAsync;
}): Promise<{
    bytes: Uint8Array;
    format: string;
} | {
    error: string;
}>;
/** `decodeImageDataUrl` 的异步版；生产 `getImageDataUrl` / 批量取图走这里。 */
export declare function decodeImageDataUrlAsync(decryptedDir: string, decodedDir: string, username: string, localId: number, wechatBaseDir?: string, aesKey?: string | Uint8Array, xorKey?: number): Promise<AsyncImageResult>;
/** `decodeEmoticonDataUrl` 的异步版：缓存命中不 await，只有 .dat 解码可能起 ffmpeg。 */
export declare function decodeEmoticonDataUrlAsync(decryptedDir: string, decodedDir: string, wechatBaseDir: string | undefined, md5: string | undefined, aesKey?: string | Uint8Array, xorKey?: number): Promise<{
    url?: string;
    format?: string;
    error?: string;
}>;
/** 文件库只读已解码缓存，无子进程路径；提供 async 面是为了与其它媒体 RPC 同形。 */
export declare function decodeFileImageDataUrlAsync(decryptedDir: string, decodedDir: string, wechatBaseDir: string | undefined, md5: string | undefined, aesKey?: string | Uint8Array, xorKey?: number): Promise<{
    url?: string;
    error?: string;
}>;
export type { DecodeDatPayload };
