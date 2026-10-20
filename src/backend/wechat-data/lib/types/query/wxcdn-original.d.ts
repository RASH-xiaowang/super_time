/**
 * WxCDN 原图下载：用本机微信配置换 token，按 `cdnbigimgurl` 的 fileid 取回**真原图**。
 *
 * ## 为什么需要它（2026-10-17 实测）
 *
 * 本项目的原图链路此前只有两条，都不够用：
 *
 * | 通路 | 实测结果 |
 * |---|---|
 * | 消息 XML 的 `tphdurl`/`tpurl` | 本机 20,431 条**全部**指向企业微信 `wwfile` 端点，匿名 GET 一律 403 |
 * | 本机 `_h.dat` | 只有 1,459 个（用户点开过才有），覆盖率约 3% |
 *
 * 而 `cdnbigimgurl`（占 81.6%）此前被判定为「需要微信登录态凭据，本应用不做」。
 * 实测发现：**存在一个第三方服务 `wxcdn.c3o.re`，它接受本机微信的 `global_config`
 * 换 token，然后按 fileid 返回原图字节**。这条路不需要登录、不需要读进程内存、
 * 不需要 hook —— 只读本机已有的两个配置文件。
 *
 * ## 协议（实测确认）
 *
 * 1. `POST /token`（multipart：`weixinIDFolder` / `fileBytes` / `crcBytes` / `tokenDuration`）
 *    → `{ token, expiresAt, account: { plan }, quota: { limitBytes, usedBytes, remainingBytes } }`
 * 2. `GET /download?fileid=<cdnbigimgurl>&type=orig&key=<aeskey>`（`Authorization: Bearer`）
 *    → 图片字节（**带 `key=` 时服务端解密**，返回可直接渲染的 JPEG/PNG）
 *
 * ⚠️ **必须带 `key=`**：不带时返回的是 AES 密文（实测 3,502,640 字节，头 `c502e100…`），
 * 本地用 `aeskey` 按 hex 解码后 AES-128-ECB 解**也解不出**（实测头 `04693b23…`）。
 * 服务端解密是唯一可行路径。
 *
 * ## 边界（写清楚，别让人以为它免费无限）
 *
 *   · **按流量计费**：Free 套餐 50 MB/天，实测下载 2.7 MB 一张就扣 2.7 MB。
 *     所以本模块**只在用户显式开启**时才被调用（`autoFetchOriginal` 开关），
 *     且每次调用前检查剩余额度。
 *   · **fileid 会过期**：实测同一条消息的 fileid 隔一段时间后返回 404。
 *     所以失败要如实回报「fileid 已过期，请在微信里重新打开这张图」。
 *   · **第三方服务**：`wxcdn.c3o.re` 不是腾讯官方服务。用户数据（`global_config`）
 *     会发给它 —— 这一点必须在隐私声明里写明，且默认关闭。
 */
/** 一次下载的结果。 */
export interface WxcdnDownloadResult {
    /** 图片字节（服务端已解密）。 */
    bytes?: Uint8Array;
    /** 嗅出来的格式（jpg/png/gif/webp）。 */
    format?: string;
    /** 失败原因（可直接显示给用户）。 */
    error?: string;
    /** 本次消耗的字节数（用于额度提示）。 */
    costBytes?: number;
}
/** 额度快照（界面显示「剩余 N MB」）。 */
export interface WxcdnQuota {
    plan: string;
    limitBytes: number;
    usedBytes: number;
    remainingBytes: number;
    /** 额度重置时间（Unix 秒）。 */
    resetsAt: number;
}
/**
 * 按 fileid 下载原图（服务端解密）。
 *
 * ⚠️ **必须带 `key=`**：不带时返回 AES 密文，本地解不出（实测确认）。
 * @param rawRoot - 微信账号原始根。
 * @param fileid - 消息 XML 的 `cdnbigimgurl`（或 `cdnmidimgurl`）。
 * @param aesKey - 消息 XML 的 `aeskey`（32 位 hex）。
 * @returns 图片字节与格式；失败时 `{ error }`。
 */
export declare function downloadOriginalByFileid(rawRoot: string, fileid: string, aesKey: string): Promise<WxcdnDownloadResult>;
/**
 * 读当前额度（界面显示「剩余 N MB」）。
 * @param rawRoot - 微信账号原始根。
 * @returns 额度快照；失败时 `{ error }`。
 */
export declare function fetchQuota(rawRoot: string): Promise<{
    quota?: WxcdnQuota;
    error?: string;
}>;
/**
 * 清掉进程内缓存的 token（切换账号 / 用户手动刷新时用）。
 * @param rawRoot - 微信账号原始根；省略则清全部。
 */
export declare function clearWxcdnToken(rawRoot?: string): void;
