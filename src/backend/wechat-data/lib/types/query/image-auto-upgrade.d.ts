/**
 * 自动取原图：`getImageDataUrl` 返回缩略图时，**后端自己**再试一次升级，不需要用户点按钮。
 *
 * ## 为什么放在后端而不是前端
 *
 * 前端 `MessageImage` 每次渲染都会调 `getImageDataUrl`（虚拟列表一屏几十张）。如果让前端
 * 在拿到 `thumb: true` 后再发一次 `getImageOriginal`，那是**每张图两个 RPC**，而且前端
 * 还要管「这张试过了别再试」的状态。放在后端就只有一个 RPC，且升级结果直接落进缓存槽，
 * 下一次渲染自然命中。
 *
 * ## 三条升级路径（按代价从低到高）
 *
 * | 路径 | 代价 | 命中条件 |
 * |---|---|---|
 * | ① 本机重解 | 纯本地，几十毫秒 | 用户已在微信里点开过（attach 里有 `_h.dat`） |
 * | ② CDN 直链 | 一次网络往返 | XML 带 `tphdurl`/`tpurl` 且主机不是企业微信端点 |
 * | ③ 放弃 | 0 | 只有 `cdnbigimgurl`（需登录态，本应用不做） |
 *
 * 2026-10-17 实测：本机 20,431 条 `tpurl` 全部指向企业微信 `wwfile` 端点（匿名 GET 一律 403），
 * 所以路径 ② 在本机数据上产出为 0；真正有效的是路径 ①。
 *
 * ## 为什么要有「试过就别再试」的记忆
 *
 * 一张图如果三条路都不通（本机只有缩略图 + 无直链），每次渲染都重试就是**每次几十毫秒的
 * 白烧**（虚拟列表滚动时同一张图会被反复挂载）。所以进程内记一份「已试过且失败」的 md5 集合，
 * 带 TTL（默认 10 分钟）—— 用户中途在微信里点开了原图，10 分钟后会自动再试一次。
 */
import { existsSync } from 'node:fs';
/** 自动升级的结果（给调用方决定要不要替换返回值）。 */
export interface AutoUpgradeResult {
    /** 升级成功时的格式。 */
    format?: string;
    /** 升级成功时的字节数（CDN 路径才有）。 */
    bytes?: number;
    /** 走的是哪条路（`local` / `cdn` / `wxcdn`）；失败时为空。 */
    via?: 'local' | 'cdn' | 'wxcdn';
    /** 失败原因（只用于日志，不显示给用户 —— 用户看到的是缩略图，不是错误）。 */
    error?: string;
}
/**
 * 清掉「已试过」记忆（用户显式点「取原图」时调用，让那次一定真的重试）。
 * @param username - 会话 username。
 * @param localId - 消息 local_id。
 */
export declare function forgetAutoUpgradeAttempt(username: string, localId: number): void;
/**
 * 尝试把一张缩略图升级成原图（**不联网优先**）。
 *
 * 调用方是 `getImageDataUrl`：它已经解出缩略图了，这里只负责「再试一次更好的」。
 * 失败是常态（本机 97% 的图微信从没下载过原图），所以**不抛异常、不写操作记录**。
 * @param decryptedDir - 解密数据根。
 * @param decodedDir - 解码缓存根。
 * @param username - 会话 username。
 * @param localId - 消息 local_id。
 * @param wechatBaseDir - 微信原始目录（本机 `.dat` 回退用）。
 * @param aesKey - V2 AES 密钥。
 * @param xorKey - XOR key 字节。
 * @param allowNetwork - 是否允许走 CDN 直链（默认 true；批量路径可关掉以免拖慢）。
 * @returns 升级结果；`format` 为空表示没升级成功。
 */
export declare function tryUpgradeToOriginal(decryptedDir: string, decodedDir: string, username: string, localId: number, wechatBaseDir: string | undefined, aesKey: string | Uint8Array | undefined, xorKey: number, allowNetwork?: boolean): Promise<AutoUpgradeResult>;
/**
 * 清空全部「已试过」记忆（切换账号 / 用户手动触发全量重试时用）。
 */
export declare function clearAutoUpgradeMemory(): void;
/**
 * 读「已试过」记忆的条目数（诊断用）。
 * @returns 当前记住的失败条目数。
 */
export declare function autoUpgradeMemorySize(): number;
/** 供测试注入时间（避免等 10 分钟）。 */
export declare const __testing: {
    RETRY_TTL_MS: number;
    triedAt: Map<string, number>;
    existsSync: typeof existsSync;
    join: (...paths: string[]) => string;
};
