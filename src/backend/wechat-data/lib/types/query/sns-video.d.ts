/**
 * Resolve one SNS video cover to an offline base64 data URL.
 * @param wechatBaseDir - raw WeChat install dir (current account root).
 * @param md5 - optional media md5 from the moments XML (fallback to msg/video).
 * @param timelineId - optional timeline id (cache-key input).
 * @param mediaId - optional media id (cache-key input).
 * @returns data URL or an error description.
 */
export declare function resolveSnsVideoCoverDataUrl(wechatBaseDir: string | undefined, md5?: string, timelineId?: string, mediaId?: string): {
    url?: string;
    error?: string;
};
/**
 * Resolve one SNS (朋友圈) video body to an offline base64 data URL so it can be
 * played inline. The cached container sits beside its cover under
 * cache/<month>/Sns/Video/<sha>/<hash>.mp4; fall back to msg/video/<md5>.mp4.
 * @param wechatBaseDir - raw WeChat install dir (current account root).
 * @param md5 - optional media md5 from the moments XML.
 * @param timelineId - optional timeline id (cache-key input).
 * @param mediaId - optional media id (cache-key input).
 * @returns data URL or an error description.
 */
export declare function resolveSnsVideoDataUrl(wechatBaseDir: string | undefined, md5?: string, timelineId?: string, mediaId?: string): {
    url?: string;
    error?: string;
};
//# sourceMappingURL=sns-video.d.ts.map