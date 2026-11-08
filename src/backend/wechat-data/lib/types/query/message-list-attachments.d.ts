import type { RetryFetch } from '../net/fetch-retry.ts';
import type { MessageListAttachmentStageInput, MessageListAttachmentStageResult, MessageListImage } from '../types.ts';
export declare const MESSAGE_LIST_ATTACHMENT_MAX_BYTES: number;
export declare const MESSAGE_LIST_ATTACHMENT_TOTAL_MAX_BYTES: number;
export declare const MESSAGE_LIST_ATTACHMENT_MAX_COUNT = 9;
export declare const MESSAGE_LIST_ATTACHMENT_URL_MAX = 4096;
export interface MessageListAttachmentLimits {
    maxBytes: number;
    totalMaxBytes: number;
    maxCount: number;
}
export interface MessageListAttachmentValidationOptions {
    /**
     * local: 本机手动插入，可带 localId / stagedId；
     * webhook: 不可信入站，只允许受控 http(s) URL 或图片 data URL；
     * stored: 读取历史库，保留旧数据兼容性，但拒绝路径和超预算结构。
     */
    mode?: 'local' | 'webhook' | 'stored';
    /** 兼容旧调用；false 等价于 webhook 模式。 */
    allowStaged?: boolean;
    limits?: Partial<MessageListAttachmentLimits>;
}
export type MessageListAttachmentValidationResult = {
    ok: true;
    images: MessageListImage[];
} | {
    ok: false;
    error: string;
};
export interface DecodedImageDataUrl {
    bytes: Buffer;
    mime: string;
}
/** 严格解码图片 data URL：只接受白名单 MIME、规范 base64，并校验文件头。 */
export declare function decodeMessageListImageDataUrl(value: unknown, maxBytes?: number): DecodedImageDataUrl | undefined;
/** 图片文件头是否与声明 MIME 一致；仅供附件校验与资源上传复用。 */
export declare function imageBytesMatchMime(bytes: Uint8Array, mime: string): boolean;
/** 入站 URL 的字面地址/本地主机名是否落在 SSRF 禁止范围。 */
export declare function isBlockedAttachmentHost(value: string): boolean;
export type PublicHttpLookup = (hostname: string) => Promise<ReadonlyArray<{
    address: string;
    family: number;
}>>;
export interface PublicHttpFetchOptions {
    fetchImpl?: RetryFetch;
    lookup?: PublicHttpLookup;
    maxRedirects?: number;
}
/**
 * 仅供入站远程附件下载使用：逐跳手动重定向，并在每次 fetch 前校验 DNS。
 * 测试可同时注入 lookup 与 fetch，生产不暴露“跳过校验”的旁路。
 */
export declare function createPublicHttpFetch(options?: PublicHttpFetchOptions): RetryFetch;
/** 只接受无凭据、无歧义的绝对 http(s) URL。 */
export declare function controlledAttachmentUrl(value: unknown): string | undefined;
/**
 * 统一校验消息列表附件。任何一项非法都会失败整组，绝不截断或静默丢件。
 *
 * 单文件与整组预算都按解码后的二进制字节计算；data URL 的 MIME 头和 base64
 * 膨胀不计入预算，但其内容必须通过严格 base64 与文件头校验。远程 URL 和微信
 * localId 在入站时无法得知字节数，投递阶段还会用同一预算再次校验。
 */
export declare function validateMessageListImages(raw: unknown, options?: MessageListAttachmentValidationOptions): MessageListAttachmentValidationResult;
/** 去掉目录、控制字符和 Windows 保留符号；仅用于展示名，不参与路径。 */
export declare function safeAttachmentName(value: unknown, fallback?: string): string;
export declare function attachmentMime(name: string): string;
/**
 * 把桌面端选中的本机文件复制到受控暂存目录。
 *
 * 只接受普通文件；资源名由服务端随机生成，原文件名只作为展示元数据。
 */
export declare function stageMessageListAttachment(decryptedDir: string, input: MessageListAttachmentStageInput): Promise<MessageListAttachmentStageResult>;
/** 读取已暂存字节；调用方只能传消息记录里的 stagedId，不接受路径。 */
export declare function readStagedAttachment(decryptedDir: string, attachment: Pick<MessageListImage, 'stagedId' | 'name' | 'size' | 'mime'>, maxBytes?: number): Promise<{
    bytes: Uint8Array;
    name: string;
    mime: string;
}>;
/**
 * 清理超过 7 天且没有被任何消息记录引用的本机暂存附件。
 *
 * 引用判断在调用方完成（那里能访问任务库）；这里只接受一组仍被引用的 id。
 */
export declare function cleanupStagedAttachments(decryptedDir: string, referencedIds: ReadonlySet<string>, now?: number): Promise<{
    removed: number;
    failed: number;
}>;
