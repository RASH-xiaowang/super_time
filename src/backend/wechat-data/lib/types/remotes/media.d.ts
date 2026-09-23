import type { RemoteImageResult } from '../query/remote-image.ts';
import { AvatarResult, EmoticonsSnapshot, FilesSnapshot, ImageDataUrlResult, OperationCategory, OperationStatus, VideoInfoResult, VoiceDataUrlResult, VoiceInfoResult } from '../types.ts';
/** 处理器需要的宿主能力（由 `WechatDataGateway` 组装；getter 形式保证读到最新目录）。 */
export interface MediaRemoteCtx {
    dirs: () => {
        decrypted: string;
        decoded: string;
    };
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
    privacyBlocked: (feature: string, detail?: string) => string | null;
    cdnSwitches: () => {
        cdnEnabled: boolean;
        localDecrypt: boolean;
    };
    outboundBlocked: () => boolean;
    /** 微信原始目录（`rawWechatBase(decrypted)`；本文件与它同属宿主层，按函数传进来）。 */
    rawWechatBase: (decrypted: string) => string;
    warmDecodedImages: (decryptedDir: string, decodedDir: string, baseDir: string, items: ReadonlyArray<{
        username: string;
        localId: number;
    }>, aesKey: string | undefined, xorKey: number) => void;
}
/** 批量取图的返回条目（`url`/`error` 与单张入口同义）。 */
export interface ImageBatchItem {
    username: string;
    localId: number;
    url?: string;
    format?: string;
    error?: string;
}
export declare function createMediaRemotes(rc: MediaRemoteCtx): {
    getEmoticons(options?: {
        limit?: number;
        offset?: number;
    }): EmoticonsSnapshot;
    getFiles(options?: {
        limit?: number;
        offset?: number;
        category?: string;
        q?: string;
    }): FilesSnapshot;
    getVoiceInfo(options: {
        username: string;
        localId: number;
    }): VoiceInfoResult;
    getVoiceDataUrl(options: {
        username: string;
        localId: number;
    }): VoiceDataUrlResult;
    getVideoInfo(options: {
        username: string;
        localId: number;
    }): VideoInfoResult;
    getAvatar(options: {
        username: string;
        nickname?: string;
    }): AvatarResult;
    getAvatarsLocal(options: {
        usernames: string[];
    }): Record<string, string>;
    getImageDataUrl(options: {
        username: string;
        localId: number;
    }): ImageDataUrlResult;
    getImageDataUrlsBatch(options: {
        items: Array<{
            username: string;
            localId: number;
        }>;
    }): {
        items: ImageBatchItem[];
    };
    getSnsImageDataUrl(options: {
        md5: string;
        timelineId?: string;
        mediaId?: string;
    }): ImageDataUrlResult;
    getFileImageDataUrl(options: {
        md5: string;
    }): ImageDataUrlResult;
    getEmoticonDataUrl(options: {
        md5: string;
        emojiUrl?: string;
    }): Promise<ImageDataUrlResult>;
    getImageOriginal(options: {
        username?: string;
        localId?: number;
    }): Promise<{
        ok: boolean;
        format?: string;
        bytes?: number;
        note?: string;
        error?: string;
    }>;
    /**
     * 远程图片代理（M23）：渲染层要看一张只存在于微信 CDN 上的图时，改由后端取回 + 落盘缓存。
     *
     * 为什么这一条值得单独存在：卡片缩略图 / 朋友圈远程图 / 视频号封面这些地址今天**由渲染层
     * 直接向消息 XML 里的 https 地址发请求** —— 既不受「自动获取原图（CDN）」开关管、也不受
     * 「禁止出网」管、不进操作记录、没有缓存（同一次滚动反复要同一张）。把它收到后端之后，
     * 那三件事才成立，而 CSP `img-src` 里的 `https:` 通配也才可能拿掉。
     *
     * 只代取**腾讯系主机**（判据与原因见 `query/cdn-hosts.ts`）：站外图床会被拒，界面上表现为
     * 没有封面而不是破图。这条口径同时写进隐私声明，别让它成为只在代码里的隐藏规则。
     * @param options - `urls`: 一批图片地址（去重后最多 40 张，超出的条目回错误让调用方分批）。
     * @returns `{items}`：每条带原请求的 `url`、可画的 `dataUrl`（或 `error`）、以及这次是否
     *   来自本机缓存。关闭出网开关时**一次请求都不发**，但本机缓存照常返回。
     */
    getRemoteImages(options: {
        urls?: string[];
    }): Promise<{
        items: RemoteImageResult[];
    }>;
    getMessageFile(options: {
        fileName: string;
        size?: number;
        createTime?: number;
    }): ImageDataUrlResult;
    getSnsVideoCoverDataUrl(options: {
        md5?: string;
        timelineId?: string;
        mediaId?: string;
        thumb?: string;
        key?: string;
    }): Promise<ImageDataUrlResult>;
    getSnsVideoDataUrl(options: {
        md5?: string;
        timelineId?: string;
        mediaId?: string;
        url?: string;
        key?: string;
    }): Promise<ImageDataUrlResult>;
    exportSnsVideo(options: {
        md5?: string;
        timelineId?: string;
        mediaId?: string;
        url?: string;
        key?: string;
        dest: string;
    }): Promise<{
        ok: boolean;
        bytes?: number;
        source?: string;
        error?: string;
    }>;
};
