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
