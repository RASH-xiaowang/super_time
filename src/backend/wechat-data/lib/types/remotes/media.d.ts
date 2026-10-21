import { type WxcdnQuota } from '../query/wxcdn-original.ts';
import { type HarvestResult, type HarvestStatus } from '../query/original-harvester.ts';
import type { RemoteImageResult } from '../query/remote-image.ts';
import { AvatarResult, DecryptStatus, EmoticonsSnapshot, EmoticonDataUrlsResult, FilesSnapshot, ImageDataUrlResult, MapGeoJsonResult, OperationCategory, OperationStatus, OriginalBatchResult, OriginalFetchPlan, VideoInfoResult, VoiceDataUrlResult, VoiceInfoResult } from '../types.ts';
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
    }>, aesKey: string | undefined, xorKey: number, knownMd5s?: readonly string[]) => Promise<void>;
}
import { IMAGE_BATCH_CONCURRENCY, mapWithConcurrency } from '../query/concurrency.ts';
export { IMAGE_BATCH_CONCURRENCY, mapWithConcurrency };
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
    /** 相对 decoded_images 的落盘路径（与单张入口同义）；前端据此拼 wechat-media:// 省 base64。 */
    file?: string;
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
    }): Promise<VoiceDataUrlResult>;
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
    /**
     * 取一条消息的图片（data URL），**自动取原图**：解出来是缩略图时会自己再试一次升级
     * （本机重解 → CDN 直链），不需要用户点按钮。算法体在 `imageWithAutoUpgrade`。
     * @param options - `username` 会话；`localId` 消息 id。
     * @returns data URL + 格式；`thumb: true` 表示这次仍是缩略图（升级没成功）。
     */
    getImageDataUrl(options: {
        username: string;
        localId: number;
    }): Promise<ImageDataUrlResult>;
    /** 批量取图：同样自动取原图，但**只走本机重解**（不联网，否则首屏拖到分钟级）。 */
    getImageDataUrlsBatch(options: {
        items: Array<{
            username: string;
            localId: number;
        }>;
        fileOnly?: boolean;
    }): Promise<{
        items: ImageBatchItem[];
    }>;
    /** 密钥只在 `resolveImageKeyPair` 一处判定；CDN/本机两条路见 `snsImageWithCdnFirst`。 */
    getSnsImageDataUrl(options: SnsImageOptions): Promise<ImageDataUrlResult>;
    /**
     * 文件库图片（hardlink 文件名前缀）→ decoded 缓存相对路径（供 `wechat-media://` 流式显示）。
     *
     * 2026-10-21：此前这里只读已解密缓存（文件库图片从未解密过 ⇒ 13,071 张命中 0，界面全占位）。
     * 现在按需定位 `msg/attach/<md5>_*.dat` 解密并落盘；返回 `file`（相对路径）而不是 base64，
     * 渲染层拼 `wechat-media://decoded/<rel>`，字节不再经 IPC、也不进渲染堆。
     * @param options - `md5` 为附件文件名去掉 `.dat`/档位后缀后的 32 位前缀；
     *   `thumbFirst=true`（网格）时优先解 `_t` 缩略档，false（灯箱）时原图档优先。
     * @returns `{file, format, thumb?}` 或 `{error}`。
     */
    getFileImageDataUrl(options: {
        md5: string;
        thumbFirst?: boolean;
    }): Promise<ImageDataUrlResult>;
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
    fetchOriginalImagesBatch(options?: {
        limit?: number;
        concurrency?: number;
    }): Promise<OriginalBatchResult>;
    /**
     * 原图自动收割：`start` 挂监控 / `stop` 停止 / `now` 手动扫一遍。
     * 这是拿到高清原图唯一不越界的通路（`tpurl` 全 403、内存 JPEG 与 md5 交集为 0）：
     * 微信负责下载，我们负责收割 —— 不联网、不碰凭据、不注入进程。
     */
    originalHarvest(action: "start" | "stop" | "now"): Promise<HarvestResult | HarvestStatus>;
    getOriginalHarvestStatus: () => Promise<HarvestStatus>;
    getWxcdnQuota: () => Promise<{
        quota?: WxcdnQuota;
        error?: string;
    }>;
    getRemoteImages(options: {
        urls?: string[];
    }): Promise<{
        items: RemoteImageResult[];
    }>;
    getMapGeoJson: (options?: {
        urls?: string[];
    }) => Promise<MapGeoJsonResult>;
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
        offline?: boolean;
    }): Promise<ImageDataUrlResult>;
    /** W2-5.6：一批封面。解析走一次列举，CDN 取回走有界并发。 */
    getSnsVideoCoversBatch(options: SnsVideoCoverBatchOptions): Promise<SnsVideoCoverBatchResult>;
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
/**
 * `fileOnly` 模式的返回整形：有落盘文件就不再回传 base64（桌面端用 wechat-media:// 流式显示）。
 *
 * 没有 `file` 的情况（远端 CDN 取回、解码失败、老快照没写缓存）原样保留 `url`，
 * 调用方不需要再发一次请求；所以这是「能省则省」，不是另一个错误分支。
 * @param result - 单张/批量条目；不修改入参。
 * @returns 同形状结果；file 存在时删掉 url。
 */
export declare function withoutDataUrlWhenFile<T extends {
    file?: string;
    url?: string;
}>(result: T): T;
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
    /**
     * 界面侧判定「当前无网」（`navigator.onLine === false`）。缺省按**有网**处理。
     *
     * 为什么缺省是有网而不是无网：判错的方向不一样 —— 误判成有网只是多走一趟网络；
     * 误判成无网会让用户永远看不到刚上传的新图，而且**没有任何报错**。
     */
    offline?: boolean;
}
/**
 * 取一条朋友圈视频的封面。
 *
 * ⚠️ 图片那路已在 2026-10-19 改为**本地优先**（见 `snsImageWithCdnFirst`）；封面这条仍
 * 保留原来的「先网后本」：本机封面命中时先本机也能省一次出网，但封面不是原图归档的
 * 对象，先不改它的判据，避免把视频封面的缓存语义与图片原图混在一起。
 *
 * ⚠️ 封面地址（XML 里的 `<thumb>`）**自带 `token` 与 `idx=1`**，不像图片那样要再拼一次，
 * 所以这里不做 `snsCdnUrl` 归一，只过白名单（M23：只判协议等于「谁给后端一个地址，后端
 * 就去取谁」）。
 */
/** 一条封面请求（W2-5.6）。`md5` 是批内与返回对齐用的标识。 */
export interface SnsVideoCoverBatchItem {
    md5?: string;
    timelineId?: string;
    mediaId?: string;
    thumb?: string;
    key?: string;
}
/** 批量封面请求。`offline` 整批共用（一条列表里的网络状况是同一个）。 */
export interface SnsVideoCoverBatchOptions {
    items: SnsVideoCoverBatchItem[];
    offline?: boolean;
}
/** 批量封面结果：与 `items` **同序**、同长（少一条就对不上号，宁可补一条带 error 的）。 */
export interface SnsVideoCoverBatchResult {
    items: Array<{
        md5: string;
        url?: string;
        error?: string;
    }>;
}
