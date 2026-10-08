import type { RemoteImageResult } from '../query/remote-image.ts';
import { AvatarResult, DecryptStatus, EmoticonsSnapshot, EmoticonDataUrlsResult, FilesSnapshot, ImageDataUrlResult, OperationCategory, OperationStatus, OriginalBatchResult, OriginalFetchPlan, VideoInfoResult, VoiceDataUrlResult, VoiceInfoResult } from '../types.ts';
/** 处理器需要的宿主能力（由 `WechatDataGateway` 组装；getter 形式保证读到最新目录）。 */
export interface MediaRemoteCtx {
    dirs: () => {
        decrypted: string;
        decoded: string;
    };
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
    /** 微信原始目录（`rawWechatBase(decrypted)`；本文件与它同属宿主层，按函数传进来）。 */
    rawWechatBase: (decrypted: string) => string;
    /**
     * 解密状态机（`getDecryptStatus` 读的那一份 `DecryptStatus`）。
     *
     * 为什么媒体域也要它：批量取原图是**长任务**，进展要能让设置页轮询到（`op` = `image-original-batch`），
     * 而且它与批量解密/升级**共用 `active` 这同一道忙闲闸门** —— 三个动作都会写同一批解码缓存，
     * 同时跑只会互相踩槽位。
     */
    decryptState: DecryptStatus;
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
    /**
     * true = 这一份是缩略/中图（本机还没有更大的）——与单张入口的 `ImageDataUrlResult.thumb` 同义。
     * 声明它是因为**运行期一直就有**：下面 `items.map` 里展开的正是 `decodeImageDataUrl(...)`
     * 的返回值。前端预取要把结果写进内存缓存，缓存里少了这个标记，「本机只有缩略图」那句
     * 提示就会在命中缓存时凭空消失。
     */
    thumb?: boolean;
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
    /** 密钥只在 `resolveImageKeyPair` 一处判定；CDN/本机两条路见 `snsImageWithCdnFirst`。 */
    getSnsImageDataUrl(options: SnsImageOptions): Promise<ImageDataUrlResult>;
    getFileImageDataUrl(options: {
        md5: string;
    }): ImageDataUrlResult;
    getEmoticonDataUrl(options: {
        md5: string;
        emojiUrl?: string;
    }): Promise<ImageDataUrlResult>;
    /**
     * 批量取表情（E1，2026-09-28 性能修复）。
     *
     * 现场日志里 `getEmoticonDataUrl` 13 次、**均 27,253ms、峰值 71,909ms** ——
     * 两个原因叠在一起：① 前端逐张发 RPC（与封面的 A1 同病）；② 后端每次未命中都
     * 递归扫整棵 `msg/attach`（E2 已改成查索引）。这里解决 ①。
     *
     * ## 为什么顺序是「先本地全过一遍，再对剩下的并发取远端」
     *
     * 不能「逐条走完整链」—— 那样每条都要等一次网络往返，N 条就是 N 个往返的时间。
     * 拆成两趟之后：第一趟纯本地（查索引 + 解码，无网络，很快），把命中的直接定下来；
     * 第二趟只对剩下的并发出网，并按 `emoticon-batch.ts` 里的并发上限限流。
     * 算法整体搬在 `query/emoticon-batch.ts`（本函数只留签名 + 一行转发）。
     *
     * @param options - `items` 为屏上待取的表情（自动去重、忽略空 md5）。
     * @returns 逐条结果，`md5` 回信；顺序 = 去重后的入参顺序。
     */
    getEmoticonDataUrls(options: {
        items: Array<{
            md5: string;
            emojiUrl?: string;
        }>;
    }): Promise<EmoticonDataUrlsResult>;
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
     * 盘点「每条图片消息的原图能不能拿到」——**纯本机扫描，不联网**。
     *
     * 存在的原因：用户问得出「为什么这张没有原图」，而答案分三类（本机已有 / 可联网取 /
     * 只有登录态才拿得到）。不给这个数，界面上只能给一句「取不到」。
     * 计划与执行的计数同源（都是 `scanImageOriginalPlan`），不会出现「报 8000 张、实际取 7000 张」。
     * @returns 覆盖率盘点（见 `OriginalFetchPlan`）；未配置原始目录时全 0。
     */
    planOriginalFetch(): Promise<OriginalFetchPlan>;
    /**
     * 批量取回原图（免登录直链）：把全库那 16.6% 的一次取完，**可续跑**。
     *
     * 与单张路径一致：已有解密类任务在跑时不并发（回 `blocked`）、逐条失败不中断整批。
     * 成功的写进 `<decoded>/.originals-index.json` ⇒ 下次点一下接着走，不会重下。
     *
     * **明确不做的**：XML 里只有 `cdnbigimgurl`/`cdnmidimgurl` 的那 83.4% 需要微信登录态凭据
     * （见 `query/image-original.ts` 的边界说明），本接口不碰它们；那部分只能在微信里点开后
     * 用「升级为原图」收进来。
     * @param options - `limit`（0/不传 = 本次不限）、`concurrency`（默认 4）。
     * @returns 计数/字节/耗时/逐条失败原因；`blocked` 非空表示一张都没发请求。
     */
    fetchOriginalImagesBatch(options: {
        limit?: number;
        concurrency?: number;
    }): Promise<OriginalBatchResult>;
    /**
     * 远程图片代理（M23）：渲染层要看一张只存在于微信 CDN 上的图时，改由后端取回 + 落盘缓存。
     *
     * 为什么这一条值得单独存在：卡片缩略图 / 朋友圈远程图 / 视频号封面这些地址今天**由渲染层
     * 直接向消息 XML 里的 https 地址发请求** —— 不进操作记录、没有缓存（同一次滚动反复要同一张）。
     * 把它收到后端之后那两件事才成立，而 CSP `img-src` 里的 `https:` 通配也才可能拿掉。
     *
     * 只代取**腾讯系主机**（判据与原因见 `query/cdn-hosts.ts`）：站外图床会被拒，界面上表现为
     * 没有封面而不是破图。这条口径同时写进隐私声明，别让它成为只在代码里的隐藏规则。
     * @param options - `urls`: 一批图片地址（去重后最多 40 张，超出的条目回错误让调用方分批）。
     * @returns `{items}`：每条带原请求的 `url`、可画的 `dataUrl`（或 `error`）、以及这次是否
     *   来自本机缓存。
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
/** `getSnsImageDataUrl` 的入参：`md5` 等为旧口径，`url`/`token`/`seed` 为 CDN 通路（可选）。 */
interface SnsImageOptions {
    md5: string;
    timelineId?: string;
    mediaId?: string;
    /** 库里存的 CDN 地址（`http://…/0`）：给了就走 CDN 通路。 */
    url?: string;
    /** 媒体标签上的 `token`：CDN 必需（实测 `token+idx=1` 才 200）。 */
    token?: string;
    /** `<enc key>` 解密种子（即 `im.key`）：CDN 必需，否则解不出图。 */
    seed?: string;
}
export {};
