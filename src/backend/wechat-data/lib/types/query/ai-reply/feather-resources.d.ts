import type { RetryFetch } from '../../net/fetch-retry.ts';
import type { MessageListImage } from '../../types.ts';
import { type PublicHttpLookup } from '../message-list-attachments.ts';
export interface FeatherResource {
    id: string;
    name: string;
    size: number;
    sha256: string;
}
export interface FeatherResourceDeps {
    fetchImpl?: RetryFetch;
    /** Test seam for the SSRF DNS boundary; production uses node:dns lookup. */
    lookup?: PublicHttpLookup;
    /** Super Time 解密数据根；读取桌面端暂存附件时必需。 */
    decryptedDir?: string;
    /** Resolve WeChat-local image references to bytes (a data URL is sufficient). */
    decodeImage?: (username: string, localId: number) => Promise<{
        url?: string;
    }>;
    /** Test seam; production uses the shared 20 MB / 9 item message-list budget. */
    limits?: Partial<FeatherResourceLimits>;
}
export interface FeatherResourceLimits {
    maxBytes: number;
    totalMaxBytes: number;
    maxCount: number;
}
interface ResourceBytes {
    bytes: Uint8Array;
    name: string;
    mime: string;
}
/** 上传一张图片或一个文件到 Feather 本机 spool；失败即整条记录失败，不静默丢图。 */
export declare function uploadFeatherResource(webhookUrl: string, input: ResourceBytes, deps?: FeatherResourceDeps): Promise<FeatherResource>;
/**
 * 把消息记录里的图片解析为可上传字节。URL 由本机先取回（仍走 sendRequest），
 * 微信本地引用由调用方通过 decodeImage 转成 data URL 后注入。
 */
export declare function uploadMessageListImages(webhookUrl: string, images: MessageListImage[], chatUsername: string, deps?: FeatherResourceDeps): Promise<string[]>;
/** 为调用方提供稳定的错误文案，避免把 fetch 的底层对象直接落库。 */
export declare function featherResourceError(e: unknown): string;
export {};
