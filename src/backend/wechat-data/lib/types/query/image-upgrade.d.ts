/**
 * 「升级解码缓存」：把老缓存里由**低档** `.dat`（聊天版 / 缩略图）解出来的图，
 * 用本机现存更好的那一档重解一遍。
 *
 * ## 为什么需要一次显式重解
 *
 * `<decoded>/<md5>.<ext>` 是「谁先解出来谁占坑」的：`decodeImageDataUrl` 第 1 步只要命中
 * 缓存就直接返回，**不会**回头看一眼 `msg/attach` 里是不是多了一份更大的 `.dat`。
 * 于是那批「先解了 `_t` / 聊天版」的缓存，在用户后来于微信里点开原图、或本机装上 wxgf
 * 解码库之后，**仍然是糊的那一份** —— 症状正是「我明明看过原图，这里还是糊的」。
 *
 * 逐条读图时没法顺手修：「本机有没有更好的一份」要扫 `msg/attach`，那是每张图一次目录遍历
 * （`decodeImageDataUrl` 只在缓存**未命中**时才付这个代价），放进每次渲染的路径上不划算，
 * 而且虚拟列表一屏几十张。所以做成一次性动作：用户点一次，之后所有渲染都命中升级后的缓存。
 *
 * ## 判据：只认「严格更大」
 *
 * 缓存条目**没有**记录自己是从哪一档解出来的（老缓存更没有），所以这里不比档位、比**字节数**：
 * 用本机最好的一档重解，只有当结果**严格大于**缓存里现存最大的一份时才覆盖。三条性质靠它：
 *   · **幂等** —— 第二次跑，重解结果与缓存逐字节相同 ⇒ 不满足「更大」⇒ 什么都不动；
 *   · **不降级** —— 缓存里若是 `getImageOriginal` 取回的 CDN 原图（可能比本机 `_h` 还大），
 *     重解本机那份只会更小 ⇒ 跳过；
 *   · **不需要元数据** —— 老缓存没有档位记录也修得动。
 *
 * 代价如实写在下面 §未覆盖：**字节数相同但质量更好的编码不会被换掉**（例如 100KB 的放大图
 * 与 100KB 的真原图）。这是刻意选的保守方向 —— 宁可漏升，不可降级。
 *
 * ## 未覆盖（写清楚，别让人以为它无敌）
 *
 *   · 只在本机 CDN 上有原图（XML 带 `tpurl`/`tphdurl`）的图，本模块**不联网**，
 *     仍要逐条点「取原图」；批量走 CDN 是另一件事（要扫消息表 + 出网开关，不做在这里）。
 *   · 同字节数不同质量的那一类，见上。
 *   · `.t.` 兜底槽里那份**不会被删**：升级后主槽优先，它退化成纯兜底，留着无害。
 */
/** 升级结果（类型在 `types-config.ts` 里再导出给 Remote 客户端）。 */ export interface ImageUpgradeResult {
    /** 检查过的缓存条目数（按 md5 去重）。 */
    total: number;
    /** 真的被换成更大一份的 md5 数。 */
    upgraded: number;
    /** 本机最好的一份不比缓存大 —— 已经是最好了。 */
    unchanged: number;
    /** `msg/attach` 里没有这个 md5 的 `.dat`（只在微信里、本机没落盘）。 */
    noSource: number;
    /** 有源但一档都解不开（读失败 / 密钥不对 / wxgf 转码不可用）。 */
    failed: number;
    errors: Array<{
        file: string;
        error: string;
    }>;
    /** 升级明细：每张的 md5、升级前后字节数与格式（界面用来说明「大了多少」）。 */
    details?: Array<{
        md5: string;
        from: number;
        to: number;
        format: string;
    }>;
    /** 跳过与失败的原因（沿用批量解密的 `skippedDetails` 口径，界面「详情」弹窗直接复用）。 */
    skippedDetails?: Array<{
        file: string;
        reason: string;
    }>;
    /** 整体失败（如「已有解密任务进行中」）时的说明；此时计数全为 0。 */
    error?: string;
}
/**
 * 把解码缓存里能用更好的一档重解的图，全部重解一遍。
 *
 * 顺序执行、不开并发：解码是 CPU 绑定且可能调原生转码（`VoipEngine.dll`），并发只会让
 * 「哪一张崩了」更难定位；这个动作是一次性的，慢一点换可读的错误面划算。
 * @param rawRoot - 微信账号原始根目录（`msg/attach` 的父目录），与批量解密同一个参数。
 * @param decodedDir - 解码缓存根。
 * @param aesKey - V2 AES 密钥（16 字符 ASCII），或 undefined。
 * @param xorKey - XOR key 字节。
 * @param onProgress - 进度回调（已处理 / 总数 / 已失败 / 当前条目说明）。
 * @returns 计数与明细，见 {@link ImageUpgradeResult}。
 */
export declare function upgradeDecodedImageCache(rawRoot: string, decodedDir: string, aesKey: string | undefined, xorKey: number, onProgress?: (processed: number, total: number, failed: number, message: string) => void): Promise<ImageUpgradeResult>;
