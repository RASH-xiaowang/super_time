/**
 * 按需从朋友圈 XML 里给出的地址取回视频，并按需解密。
 *
 * 朋友圈的 `<url>` 就是视频地址（`…/snsvideodownload?encfilekey=…&token=…`），
 * 本机没缓存时这是唯一来源。微信 CDN 返回的是**客户端加密流**：前 128KB 需要与
 * `WxIsaac64` 密钥流 XOR（种子 = XML 里 `<enc key="NNNN">`），之后才是明文。
 * 解密后**必须校验**容器头与 md5（md5 来自 XML 的 `<url md5>`），校验不过就如实报错。
 *
 * @param remoteUrl - XML 里的 `<url>`。
 * @param expectMd5 - XML 里 `<url md5>`，取回后用来验证。
 * @param opts - `version` 本机微信版本（UA 必须带 `WeChat/<版本>`，否则 CDN 直接 400）；
 *   `seed` 即 `<enc key>`，用于解密加密头；`timeoutMs` 超时。
 * @returns data URL，或带具体原因的 error。
 */
export declare function fetchSnsVideoDataUrl(remoteUrl: string, expectMd5?: string, opts?: {
    version?: string;
    timeoutMs?: number;
    seed?: string;
}): Promise<{
    url?: string;
    error?: string;
}>;
/**
 * 取回并解密视频本体字节（不做 base64，供「保存到文件」这类需要原始字节的调用方用）。
 * @param remoteUrl - CDN 地址。
 * @param expectMd5 - XML 里的 `<url md5>`，用于校验。
 * @param opts - UA 版本 / 超时 / `<enc key>` 种子。
 * @returns 字节，或错误说明。
 */
export declare function fetchAndDecodeVideo(remoteUrl: string, expectMd5?: string, opts?: {
    version?: string;
    timeoutMs?: number;
    seed?: string;
}): Promise<{
    bytes?: Buffer;
    error?: string;
}>;
/**
 * 取到视频本体字节：**本机缓存优先**（明文、离线），没有缓存再 CDN 取回并解密。
 * 供播放（转 data URL）与「保存到文件」共用，避免两条路各自实现一遍。
 *
 * **主机白名单**：远端那一级只允许腾讯系主机（`query/cdn-hosts.ts`，唯一出处），
 * 判在**本机缓存之后、发请求之前** —— 本机已有的照常导出，站外地址一个字节都不发。
 * @param args - 缓存键（base+trace ids）与远端信息（url/seed/version）。
 * @returns 字节 + 来源，或错误说明。
 */
export declare function loadSnsVideoBytes(args: {
    base?: string;
    md5?: string;
    timelineId?: string;
    mediaId?: string;
    url?: string;
    seed?: string;
    version?: string;
}): Promise<{
    bytes?: Buffer;
    source?: 'local' | 'remote';
    error?: string;
}>;
/**
 * 取回朋友圈视频封面，同样按需解密。
 *
 * ## 为什么不是「一律整份解」（2026-10-09 实测后定的）
 *
 * 现场探针 `sns-video-cover-probe.manual.spec.ts` 在真库真网上量了 12 个封面：
 * **0 个超过 128 KB**，全部密文（头 `4f 44 5a d8`），只解头就拿到 `eoiFromEnd=0` 的完整 JPEG。
 * 也就是说「只解头」对封面**当下是完全正确的**，改成一律整份解等于让每张封面白付约 3 倍 CPU
 * 而收益为零。所以这里改成**按大小分流 + 结尾校验兜底**：
 *
 *   · 实收 > 128 KB ⇒ 只解头**必然**留下密文尾部 ⇒ 直接整份解；
 *   · 实收 ≤ 128 KB ⇒ 只解头就是整份解（省 CPU），再用 `coverEndsComplete` 校验结尾，
 *     万一不完整（历史数据换了加密策略、或将来出现大封面）再回落整份解一次。
 *
 * @param remoteUrl - XML 里的 `<thumb>`（地址自带 `token` 与 `idx=1`，不需要再拼）。
 * @param opts - 同 {@link fetchSnsVideoDataUrl}。
 * @returns data URL，或错误说明。
 */
export declare function fetchSnsCoverDataUrl(remoteUrl: string, opts?: {
    version?: string;
    timeoutMs?: number;
    seed?: string;
}): Promise<{
    url?: string;
    error?: string;
}>;
/**
 * 测试接缝：清掉按月索引与结果缓存。
 *
 * 导出只为基准脚本（`sns-cover-batch.measure.spec.ts`）能在两次测量之间把进程内缓存清干净 ——
 * 否则第二次测的是「第一次已经把月索引建好了」的路径，数字会假绿。
 */
export declare function snsVideoIndexForTest(): {
    clear: () => void;
};
/**
 * 解析一条朋友圈视频的封面。
 * @param wechatBaseDir - 微信账号根目录（rawWechatBase）。
 * @param md5 - 朋友圈 XML 里 `<url md5>`，即媒体内容 md5。
 * @returns data URL，或带说明的 error。
 */
export declare function resolveSnsVideoCoverDataUrl(wechatBaseDir: string | undefined, md5?: string, _timelineId?: string, _mediaId?: string): {
    url?: string;
    error?: string;
};
/**
 * 批量解析朋友圈视频封面（W2-5.6）。
 *
 * 语义与逐条版**逐条一致**，包括「本机没有」那套注记（哪些月份没扫全）。
 * 唯一的差别在列举：`snsMonthRoots` 与每个月的内容 md5 索引在一批里只走一遍，
 * 逐条则每条都要重来一次 —— 那正是本条要省的那一段（数字见 `sns-cover-batch.measure.spec.ts`）。
 *
 * 三级兜底（内容 md5 索引 → 聊天缓存里的同名图片/视频 → 聊天缓存的 `_thumb`）
 * 与逐条版同序；`_thumb` 那一级不能省：只转发过、没在朋友圈播放过的视频，
 * 朋友圈缓存里没有它，但聊天缓存会留下 `<md5>_thumb.jpg`。
 * @param wechatBaseDir - 微信账号根目录（rawWechatBase）。
 * @param md5s - 内容 md5 列表（内部去重、忽略空串）。
 * @returns 每个请求的 md5 → 结果（命中与未命中都在里面，调用方按条取）。
 */
export declare function resolveSnsVideoCoverDataUrls(wechatBaseDir: string | undefined, md5s: readonly string[]): Map<string, {
    url?: string;
    error?: string;
}>;
/**
 * 解析一条朋友圈视频本体（base64 data URL，供 <video> 内联播放）。
 * @param wechatBaseDir - 微信账号根目录（rawWechatBase）。
 * @param md5 - 朋友圈 XML 里 `<url md5>`，即媒体内容 md5。
 * @returns data URL，或带说明的 error。
 */
export declare function resolveSnsVideoDataUrl(wechatBaseDir: string | undefined, md5?: string, _timelineId?: string, _mediaId?: string): {
    url?: string;
    error?: string;
};
/**
 * 在本机缓存里定位某条视频的本体路径（不解码、不 base64）。
 * @param wechatBaseDir - 微信账号根目录。
 * @param md5 - XML 的 `<url md5>`（即明文内容 md5）。
 * @returns 命中的路径，或错误说明。
 */
export declare function findLocalVideoPath(wechatBaseDir: string | undefined, md5?: string, _timelineId?: string, _mediaId?: string): {
    path?: string;
    error?: string;
};
