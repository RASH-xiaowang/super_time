/**
 * WechatDataGateway 方法面 · 媒体与图片/视频读取链路的 @Remote 壳（媒体域）。
 *
 * 与其它 gateway-* 壳共同构成继承链；装饰器标记会落到最派生原型上，
 * 因此协议层枚举到的方法面与拆分前逐名相同（守卫：gateway-remote-surface.spec.ts）。
 */
import type { AvatarResult, EmoticonsSnapshot, EmoticonDataUrlsResult, FilesSnapshot, ImageDataUrlResult, MapGeoJsonResult, OriginalBatchResult, OriginalFetchPlan, VideoInfoResult, VoiceDataUrlResult, VoiceInfoResult } from './types.ts';
import { type ImageBatchItem, type SnsVideoCoverBatchOptions, type SnsVideoCoverBatchResult } from './remotes/media.ts';
import type { HarvestResult, HarvestStatus } from './query/original-harvester.ts';
import type { WxcdnQuota } from './query/wxcdn-original.ts';
import { type WechatImageAutoDownloadAction, type WechatImageAutoDownloadStatus } from './query/wechat-image-autodownload.ts';
import { GatewayAskOps } from './gateway-ask-ops.ts';
export declare abstract class GatewayMediaOps extends GatewayAskOps {
    /**
     * Custom emoticons.
     * @param options - Optional limit/offset for incremental loading.
     * @returns EmoticonsSnapshot: emoticon items.
     */
    getEmoticons(options?: {
        limit?: number;
        offset?: number;
    }): EmoticonsSnapshot;
    /**
     * Resource files.
     * @param options - Optional limit/offset and category filter for incremental loading.
     * @returns FilesSnapshot: resource file items.
     */
    getFiles(options?: {
        limit?: number;
        offset?: number;
        category?: string;
        q?: string;
    }): FilesSnapshot;
    /**
     * Look up one voice message (silk decode degrades in Node).
     * @param options - username and localId of the voice message.
     * @returns VoiceInfoResult: voice metadata / decoded file info.
     */
    getVoiceInfo(options: {
        username: string;
        localId: number;
    }): VoiceInfoResult;
    /**
     * Resolve one voice message to an inline-playable wav data URL.
     * 语音实体是 silk，需要解码成 wav 才能播；产物落在转写链路同一份缓存里。
     * @param options - username and localId of the voice message.
     * @returns VoiceDataUrlResult: base64 wav data URL (+ duration) or error.
    */
    getVoiceDataUrl(options: {
        username: string;
        localId: number;
    }): Promise<VoiceDataUrlResult>;
    /**
     * Look up one video message: cover thumbnail + the on-disk video path.
     * 封面与实体都在真实微信目录 `msg/video` 下，所以要带上数据根目录。
     * @param options - username and localId of the video message.
     * @returns VideoInfoResult: video cover/thumbnail info.
     */
    getVideoInfo(options: {
        username: string;
        localId: number;
    }): VideoInfoResult;
    /**
     * Resolve a user avatar (head_image.db data or contact URL).
     * @param options - username to resolve the avatar for.
     * @returns AvatarResult: avatar data URL or fallback info.
     */
    getAvatar(options: {
        username: string;
        nickname?: string;
    }): AvatarResult;
    /**
     * 批量读取头像(head_image.db 优先,未命中再用 contact 表 URL 兜底;一次 RPC)。
     * @param options - usernames 列表。
     * @returns username → data URL(本地)或 https URL(远端兜底)映射;未命中的不在其中。
     */
    getAvatarsLocal(options: {
        usernames: string[];
    }): Record<string, string>;
    /**
     * Decode one message image to a base64 data URL.
     * @param options - username and localId of the message image.
     * @returns ImageDataUrlResult: base64 data URL or error.
    */
    getImageDataUrl(options: {
        username: string;
        localId: number;
        fileOnly?: boolean;
    }): Promise<ImageDataUrlResult>;
    /**
     * Decode a whole batch of message images to base64 data URLs (N16)。
     *
     * 理由与实测数字（20 万行 17.27ms/次、30 张 ≈518ms、以及「预热之后每张仍走一次单张入口」
     * 那条诚实边界）**写在 `query/media-image.ts` 的 `resolveImageFilePathsByMd5`** 上 ——
     * 这一层只是协议壳，不重复一份（重复的那份一定会漂）。
     * @param options - `items`: 一批 (username, localId)；超过 {@link IMAGE_BATCH_MAX} 的截断。
     * @returns 与传入顺序一一对应的条目（`url` 或 `error`，语义同单张入口）。
    */
    getImageDataUrlsBatch(options: {
        items: Array<{
            username: string;
            localId: number;
        }>;
        fileOnly?: boolean;
    }): Promise<{
        items: ImageBatchItem[];
    }>;
    /**
     * Resolve one SNS (朋友圈) media to a base64 data URL —— **本地优先、CDN 兜底**。
     *
     * 顺序：`<数据根>/moments-media` 长期归档 → `decoded_images/sns-media` →
     * 微信原始目录原图 → 仅在线且都没有时向 CDN 要 `/0` → 最后才是缩略图。
     * 长期归档跨重启/换密钥保留；本地命中时不再出网（用户 2026-10-19 口径）。
     *
     * 顺序与理由见 `remotes/media.ts` 的 `snsImageWithCdnFirst`。
     *
     * @param options - `md5` 来自朋友圈 XML；`url`/`token`/`seed` 是 CDN 三件套；
     *   `offline` 由界面按 `navigator.onLine` 判定，缺省按有网处理（仅影响「本地都没有时能否出网」）。
     * @returns ImageDataUrlResult: base64 data URL（`thumb: true` = 只能给缩略图）或 error。
     */
    getSnsImageDataUrl(options: {
        md5: string;
        timelineId?: string;
        mediaId?: string;
        /** 库里存的 CDN 地址（`http://…/0`）：给了就走 CDN 通路（见 `sns-cdn-image.ts`）。 */
        url?: string;
        /** 媒体标签上的 `token`：CDN 必需（实测 `token+idx=1` 才 200）。 */
        token?: string;
        /** `<enc key>` 解密种子（即 `im.key`）：CDN 必需，否则解不出图。 */
        seed?: string;
        /**
         * 界面侧判定「当前无网」（`navigator.onLine === false`）。
         *
         * 为什么由界面传而不在后端自己探网：后端探网要额外发一次请求，
         * 而那一次请求本身就可能因为「网络不通」而挂住 —— 于是判据与被测对象互相依赖。
         * 界面已经有 `navigator.onLine`（`remote-img.tsx` 的离线短路也用它），复用同一个信号。
         * 缺省按「有网」处理：宁可多走一趟网络，也不要在有网时拿旧缓存糊弄。
         */
        offline?: boolean;
    }): Promise<ImageDataUrlResult>;
    /**
     * Resolve a file-library image to decoded-cache path / data URL.
     *
     * 2026-10-21：按需解密（`msg/attach` 索引 → `.dat` → decoded 缓存），
     * 桌面端返回 `file`（相对路径）供 `wechat-media://` 流式显示；
     * `thumbFirst`：网格取 `_t` 缩略档，灯箱取原图档。
     * @param options - file image key (attachment filename md5 prefix) + optional thumbFirst.
     * @returns ImageDataUrlResult: `file`（优先）/ `url` / error.
    */
    getFileImageDataUrl(options: {
        md5: string;
        thumbFirst?: boolean;
    }): Promise<ImageDataUrlResult>;
    /**
     * Resolve a custom emoticon (sticker) md5 to an offline base64 data URL.
     * 先读 decoded 缓存 → 扫 msg/attach 与微信的表情缓存目录里解密；
     * 本地解不开时（微信 4.x 的表情缓存是加密文件，项目里没有对应解码器）
     * 用消息 XML 带来的 `cdnurl` 下载一次并落进 decoded 缓存。
     * @param options - emoticon md5 (+ optional CDN url from the message).
     * @returns ImageDataUrlResult: base64 data URL or error.
     */
    getEmoticonDataUrl(options: {
        md5: string;
        emojiUrl?: string;
    }): Promise<ImageDataUrlResult>;
    /**
     * 批量取表情（E1，2026-09-28 性能修复）。
     *
     * 现场日志里 `getEmoticonDataUrl` 均 27.2s、峰值 71.9s。这个批量壳把一屏的表情收成
     * 一个 RPC；后端先做一趟纯本地解码，再对剩下的按 {@link EMOTICON_FETCH_CONCURRENCY}
     * 并发出网 —— 于是「N 条表情 = N 次网络往返」变成「1 次 RPC + ceil(N/8) 批」。
     * @param options - `items` 为一屏待取的表情（自动去重、忽略空 md5）。
     * @returns 逐条结果（键 = md5），顺序与去重后的入参一致。
     */
    getEmoticonDataUrls(options: {
        items: Array<{
            md5: string;
            emojiUrl?: string;
        }>;
    }): Promise<EmoticonDataUrlsResult>;
    /**
     * 取一条图片消息的**原图**，但只走消息里自带的免登录预签名直链（`<img tpurl=…/tphdurl=…>`）。
     *
     * 为什么只做这一类：本机 39,923 张图片消息里 93% 磁盘上只有缩略图，而指向原图的指针有两种，
     * `cdnbigimgurl` 那一种需要**微信登录态凭据**去发私有媒体请求 —— 那已经不是「读本机已有的密钥」，
     * 而是「以你的身份向服务器发请求」，与本应用「不登录、不连微信服务器同步」的边界冲突
     * （口径写在 `query/image-original.ts` 的模块注释）。所以拿不到直链时要把话说清：
     * 让用户回微信里打开那张图点「查看原图」，本机存下来之后这里自然就是原图。
     *
     * 取回的原图写进 `<decoded>/<md5>.<ext>`，也就是 `getImageDataUrl` 第 1a 步优先读的缓存槽，
     * 于是**下一次渲染直接是原图**、之后离线可用（网络只花一次）。字节不经 RPC 回传。
     * @param options - `username` 会话 username；`localId` 消息 local_id。
     * @returns `{ok:true, format, bytes?, note?}`；失败时 `{ok:false, error}`，error 可直接显示。
     *   `note` 是成功时要一并告诉用户的话（例如「这次是重解本机那一份，没联网」）。
     */
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
     * 三类答案分开报：本机已有 `_h`（离线就有）/ 有免登录直链可联网补 / 只有 `cdnbig*`
     * （需微信登录态，本应用不取）。没有这个数，界面上只能给一句「取不到」。
     * 与批量执行共用同一次扫描（`scanImageOriginalPlan`），所以两份数字对得上。
     * @returns OriginalFetchPlan：条数、可补条数、需登录条数、XML 声明的预计字节数。
     */
    planOriginalFetch(): Promise<OriginalFetchPlan>;
    /**
     * 批量取回原图（免登录直链）：全库那 16.6% 一次取完，**可续跑**（`<decoded>/.originals-index.json`）。
     *
     * 边界：已有解密类任务在跑时一条请求都不发（回 `blocked`）；逐条失败不中断整批。
     * **明确不碰**只有 `cdnbigimgurl`/`cdnmidimgurl` 的那 83.4% ——
     * 那要微信登录态凭据（边界见 `query/image-original.ts`），只能在微信里点开后用
     * 「升级为原图」收进来。实时进度通过 getDecryptStatus 读取（`op` = `image-original-batch`）。
     * @param options - `limit`（0/不传 = 本次不限）、`concurrency`（默认 4，封顶 8）。
     * @returns OriginalBatchResult：候选/尝试/成功/失败/字节/耗时/逐条失败原因。
     */
    fetchOriginalImagesBatch(options?: {
        limit?: number;
        concurrency?: number;
    }): Promise<OriginalBatchResult>;
    /**
     * 原图自动收割：监控微信 `msg/attach`，微信一落盘 `_h.dat` 就解进解码缓存。
     *
     * 这是**拿到高清原图唯一不越界的通路**。2026-10-17 实测确认了三条死路：
     * ① 消息 XML 的 `tphdurl`/`tpurl` 本机 20,431 条全部指向企业微信 `wwfile` 端点，匿名 GET 一律 403；
     * ② 进程内存里确实有 `tpauthkey`（806 处），但拼进 URL 的 5 种变体**全部 403** ——
     *    它是给 mmtls 私有协议用的，不是 HTTP 凭据；
     * ③ 进程内存里有 225 个完整 JPEG，但与数据库 48,882 个图片 md5 **交集为 0** ——
     *    那是界面渲染缓存，不是聊天原图。
     *
     * 结论：聊天图片走 mmtls 私有 RPC，不是 HTTP 直链。但微信**自己**会下载原图
     * （用户点「查看原图」时落盘 `<md5>_h.dat`，实测本机 1,459 个且仍在新增）。
     * 本接口就盯住这个落盘动作：**微信负责下载，我们负责收割**，不联网、不碰凭据、不注入进程。
     * @param options - `action`：`start` 启动监控 / `stop` 停止监控 / `now` 手动收割一次。
     * @returns `start`/`now` 回 `HarvestResult`，`stop` 回 `HarvestStatus`。
     */
    originalHarvest(options: {
        action: 'start' | 'stop' | 'now';
    }): Promise<HarvestResult | HarvestStatus>;
    /**
     * 读原图自动收割的状态（纯内存，毫秒级）。
     *
     * **单独一个 Remote 而不是 `originalHarvest('status')`**：后者会被归成重任务，
     * 而收割本身占着唯一的重任务槽 —— 收割期间读进度会被「重任务队列已满」拒掉，
     * 界面只能干等（2026-10-17 实测：1,459 个文件要 69 秒）。
     * @returns 是否在监控、累计收割/失败张数、手动收割的实时进度。
     */
    getOriginalHarvestStatus(): Promise<HarvestStatus>;
    /**
     * 读「第三方原图服务」的额度（`wxcdn.c3o.re`）。
     *
     * 这是本机数据上**唯一能覆盖那 81.6%** 的通路：用 `cdnbigimgurl` 的 fileid 换原图
     * （实测 6/6 成功，拿到 2,751 KB 的真原图）。按流量计费，Free 套餐 50 MB/天。
     * 开关是 `wxcdn_enabled`（默认 **false**）—— 该服务不是腾讯官方，且需要把本机的
     * `all_users/config/global_config` 发给它，所以必须由用户显式打开。
     * @returns 套餐名、总量、已用、剩余、重置时间；失败时 `{ error }`。
     */
    getWxcdnQuota(): Promise<{
        quota?: WxcdnQuota;
        error?: string;
    }>;
    /**
     * 远程图片代理（M23）：一批 https 图片地址 → 后端取回并缓存 → data URL。
     *
     * 存在的原因：卡片缩略图 / 朋友圈远程图 / 视频号封面此前由**渲染层直接向消息里的地址发请求**，
     * 那条路径不进操作记录、没有缓存、也不受主机白名单约束。
     * 收到后端之后这三件事才成立，而 CSP `img-src` 的 `https:` 通配也才可能拿掉。
     * 只代取腾讯系主机（判据见 `query/cdn-hosts.ts`）；站外图床会被拒。
     * @param options - `urls`: 图片地址列表（去重后最多取 40 张，超出的条目回错误）。
     * @returns `{items}`：每条 `{url, dataUrl?, fromCache?, error?}`，`url` 原样带回当键。
     */
    getRemoteImages(options: {
        urls?: string[];
    }): Promise<{
        items: Array<{
            url: string;
            dataUrl?: string;
            fromCache?: boolean;
            error?: string;
        }>;
    }>;
    /**
     * 公共地图 GeoJSON 的后端代理。
     * 渲染层只给候选地址，真正出网由后端按 `query/map-geo.ts` 的固定白名单执行。
     * @param options - `urls`: 候选 GeoJSON 地址。
     * @returns 第一份可用的 GeoJSON，或失败原因。
     */
    getMapGeoJson(options: {
        urls?: string[];
    }): Promise<MapGeoJsonResult>;
    /**
     * Resolve a received message file (msg/file) to a base64 data URL.
     * @param options - original file name from the message card.
     * @returns ImageDataUrlResult: data URL or error.
     */
    getMessageFile(options: {
        fileName: string;
        size?: number;
        createTime?: number;
    }): ImageDataUrlResult;
    /**
     * 一条朋友圈视频封面 → data URL（W2-5.6 的单条入口保留；列表请走 `getSnsVideoCoversBatch`）。
     * @param options - md5 / timelineId / mediaId / thumb / key / offline。
     * @returns ImageDataUrlResult。
     */
    getSnsVideoCoverDataUrl(options: {
        md5?: string;
        timelineId?: string;
        mediaId?: string;
        thumb?: string;
        key?: string;
        offline?: boolean;
    }): Promise<ImageDataUrlResult>;
    getSnsVideoCoversBatch(options: SnsVideoCoverBatchOptions): Promise<SnsVideoCoverBatchResult>;
    /**
     * Resolve one SNS (朋友圈) video body so it can be played inline.
     *
     * 两级来源：**先本机缓存**（明文，离线、最快），没有缓存再按朋友圈 XML 里的
     * `<url>` 从微信 CDN 按需取回。取回要过隐私闸门（与 AI 调用同一套：脱敏与审计，
     * 见 `gateway-privacy.ts` —— 2026-09-30 起它只做这两件事，不再有拦截），
     * CDN 返回的是客户端加密流，按 `<enc key>` 解密后再**校验容器头与 md5**，
     * 免得把一个放不出来的二进制塞给 <video>。
     *
     * @param options - media md5 from the moments XML（+ 本地缓存键、`<url>` 与 `<enc key>`）。
     * @returns ImageDataUrlResult: base64 data URL or an error explaining which source failed.
     */
    getSnsVideoDataUrl(options: {
        md5?: string;
        timelineId?: string;
        mediaId?: string;
        url?: string;
        key?: string;
    }): Promise<ImageDataUrlResult>;
    /**
     * 把一条朋友圈视频（本机缓存优先，否则 CDN 取回+解密）写到用户选定路径。
     *
     * 为什么放在后端写：视频本体几十 MB，走渲染端 `<a download>` 既落不了盘
     * （实测点了没反应），把 base64 经 IPC 传回主进程也白白多一次几十 MB 的拷贝。
     * 这里直接取字节写文件 —— 路径由主进程的保存对话框给出。
     *
     * @param options - 缓存键 / 远端地址与种子 / 目标路径。
     * @returns ok + 字节数，或错误说明。
     */
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
    /**
     * 微信原图自动下载（实验）：`start` 打开开关并让微信开始下载新图片的原图 /
     * `stop` 关闭并还原微信进程 / `status` 只读状态（界面轮询用）。
     *
     * 这是仓库里唯一会**修改微信进程内存**的入口：复用上游 WeFlow-X（MIT）的
     * `img_helper.dll`，把注入/还原/落 marker 的生命周期放在
     * `query/wechat-image-autodownload.ts`；本方法只做转发。
     * 仅桌面端可调（`http-remote-policy.js` 的 A 族）——手机/浏览器态没有本机微信进程。
     * @param options - 动作（默认 `status`）。
     * @returns 最新状态快照（含错误码与清理提示）。
     */
    wechatImageAutoDownload(options?: {
        action?: WechatImageAutoDownloadAction;
    }): Promise<WechatImageAutoDownloadStatus>;
}
