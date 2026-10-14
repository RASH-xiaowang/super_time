/**
 * 单次调用**最多解密多少个缓存文件**（2026-09-29 实测后加的硬上限）。
 *
 * ## 为什么必须有它
 *
 * 实测：进入朋友圈后 `getSnsImageDataUrl` **单次 130 秒**（主进程日志：
 * `慢调用 getSnsImageDataUrl 耗时 134879ms / 131051ms / 130499ms / 132016ms`）。原因不是解密慢
 * （纯 AES+md5 实测 0.12 ms/个），而是**整月重扫**：一个月 3,100 张图、两个月 6,300 张，
 * 其中绝大多数是 wxgf 容器，要**逐个调微信原生转码库**才能算明文 md5（约 20 ms/个）
 * ⇒ 6,300 × 20 ms ≈ 126 s。而 worker 是**串行**的，这一下把后面所有请求都堵到 60s 超时
 * —— 用户看到的就是"点开朋友圈之后整个应用卡死好几分钟"。
 *
 * 现在：目录**每轮只做增量**（只解密新增/变化的文件，按 mtime 新→旧），并且**单次调用有上限**；
 * 没扫完的部分留在 `pending` 里，下次调用接着扫。于是
 *   · 一次调用最多约 40 × 20 ms ≈ 0.8 s（绝大多数月是几十毫秒，因为增量后通常没有新文件）；
 *   · 冷启动那次也不会再把几百秒的活压在一次调用里 —— 进度分散到多次调用，界面全程可用。
 */
export declare const SNS_INDEX_BUDGET_FILES = 40;
/** 单次调用最多解密多少个 attach 文件。 */
export declare const ATTACH_BUDGET_FILES = 200;
/**
 * 单次调用在这段 attach 兜底上最多花多少毫秒（2026-09-29 加；与文件数预算**同时生效**）。
 *
 * 为什么还要时间预算：文件数预算管不住"单文件有多贵" —— 实测 200 个文件 ≈ **139–169 ms**，
 * 而**每一次未命中**都要付这笔钱（`[sns-trace] attach-drain=169ms / 139ms`）。
 * 面板一屏 8 张图里若有多张取不到，就是 8 × 200ms 的白等。改成"最多 25ms / 每次"：
 * 总工作量不变、进度照样跨调用累积，但单次未命中的成本从 ~230ms 降到 ~40ms。
 */
export declare const ATTACH_BUDGET_MS = 25;
/**
 * 测试用读数：`msg/attach` 兜底的进度（"单次有界 + 跨调用累积"这两条契约靠它钉住）。
 *
 * 为什么不靠"第几趟能命中"来断言：目录枚举顺序由文件系统决定，测试里控制不了，
 * 那样的断言会变成"碰巧过/碰巧红"。直接读进度最稳。
 * @param wechatBaseDir - 账号根目录。
 * @returns 已记住明文 md5 的文件数、还排队的文件数、已知文件数；没建过索引时 `undefined`。
 */
/**
 * **预热解码缓存**：主动推进 attach 索引的解密，不等用户点图（2026-09-29）。
 *
 * ── 为什么需要 ────────────────────────────────────────────────
 * 真机自检：**解码缓存 154 张 / 43.5MB**，而媒体资源 **175,963 项 / 16.8GB**。
 * 原因是 `drainAttach()` 此前**只在 `resolveSnsImageDataUrl()` 里被驱动** ——
 * 用户点到哪张才解哪张，于是空闲时缓存完全不涨；而缓存未命中的那张要走
 * 「读文件 + 解密 + 哈希」的重路径（实测 12–21s），超时/失败就成了前端那块空白。
 *
 * ── 做法 ─────────────────────────────────────────────────────
 * 复用**完全相同**的索引与节流：同一份 `attachIndex`、同一个 `ATTACH_WALK_INTERVAL_MS`
 * 列目录闸门、同一个 `ATTACH_DRAIN_MIN_INTERVAL_MS` 突发闸门、同一组文件数/毫秒预算。
 * 唯一区别是**驱动权交给后台节拍**（同步 tick），所以缓存会自己长起来。
 * 幂等且自带节流 ⇒ 调用方可以放心地每隔几秒调一次。
 *
 * @param wechatBaseDir - 微信原始目录（未配置时直接跳过）。
 * @param aesKey - 图片 AES 密钥。
 * @param xorKey - XOR 密钥。
 * @returns 本次是否真的推进了一步（未推进 = 闸门内/没目录，供调用方决定是否记日志）。
 */
/**
 * W3-2.4：**预热预算的上限**（每拍最多这么多毫秒）。
 */
export declare const PREWARM_MAX_MS = 500;
/**
 * W3-2.4：**探测预算**——— 先花这么多毫秒把水位读出来。
 * 不能为 0：那样等于不探测，水位永远是上一拍的陈年数据。
 */
export declare const PREWARM_PROBE_MS = 100;
/**
 * W3-2.4：按**积压水位**选预热预算（纯函数，便于单测）。
 *
 * 三档（阅读重点是**为什么是这三个数**，不是否分档）：
 *  · backlog = 0 ⇒ 不加时间。空闲时仍然会推一步（探测那一步），但不会无意义地拉满。
 *  · backlog > 0 ⇒ 给满 500ms。积压存在就说明有人在等（新消息、刚打开的面板），
 *    而解密一张要 12–21s —— 这里多花 200ms 能少等一佊。
 *  · 500 上限而不是更大：每拍 10s，500ms = 5%。再大就开始挑战“占用
 *    共享事件循环」这条约束了（gateway 里还托管着全部查询）。
 * @param backlog - 当前积压条数（还没解完的）。
 * @returns 本拍应该花的毫秒数。
 */
export declare function prewarmBudgetMs(backlog: number): number;
export declare function pumpSnsDecodeCache(wechatBaseDir: string | undefined, aesKey: string | undefined, xorKey: number, opts?: {
    maxMs?: number;
}): {
    advanced: boolean;
    steps: number;
    backlog?: number;
};
export declare function snsAttachProgressForTest(wechatBaseDir: string): {
    decoded: number;
    pending: number;
    paths: number;
} | undefined;
/**
 * 只要「本机**确实**有这张图」的那个判断，不要解码结果（A4，2026-09-28 性能修复）。
 *
 * `resolveSnsImageDataUrl` 会把命中的文件解成 data URL —— 那对本机已有的封面是双重开销
 * （文中封面走 `article-cover.ts` 的缓存，朋友圈那条走 `resolveSnsImageDataUrl`）。
 * 这里只回答「索引里有没有它」，供 {@link file://./article-cover.ts} 决定要不要出网。
 *
 * ⚠ 口径与 `resolveSnsImageDataUrl` 的**索引分支**逐字一致：`complete === false` 且
 * `file !== undefined` 才算命中，`indexDead`（索引指向的文件解不开）**不算** ——
 * 否则「本机有一份坏文件」会被当成「本机有图」，把封面永久钉在坏数据上。
 * @returns 命中的文件路径；没命中 / 索引不完整 / 无法判定时 `undefined`（调用方一律照旧出网）。
 */
/**
 * 版本二：*内容*取回 —— 只要「本机确实有这张图」那份 data URL（A4，2026-09-28 性能修复）。
 *
 * 为什么不在这里 import `meta.ts` 的 `boundedSet`：`decodeCachedFile` 已经做了密钥解析，
 * 这里再原地解一次就够；从 `md5UrlCache` 拿一份已经解过的可以省一次解密。
 * ⚠ 口径与 `resolveSnsImageDataUrl` 的**索引分支**逐字一致：`indexDead`（索引指向的文件
 * 解不开）**不算命中** —— 否则「本机有一份坏文件」会被当成「本机有图」，把封面永久钉在坏数据上。
 * @returns 命中且能解开的 data URL；否则 `undefined`（调用方一律照旧出网）。
 */
export declare function findSnsMediaDataUrlByIndex(wechatBaseDir: string, aesKey: string | undefined, xorKey: number, md5: string): string | undefined;
/**
 * 本进程里是否已经建过**任何**朋友圈媒体索引（A4 的成本闸门）。
 *
 * 为什么需要它：A4 的收益是「省两次网络往返」，成本是「查一次索引（第一次要把某个月的
 * 图片全解一遍算出 md5）」。索引一条都没建时，用户没进过朋友圈 ⇒ 这趟扫描是**纯新增成本**，
 * 而封面省下的网络往返他不一定在意。所以口径定为：**只有索引已在（说明这次会话真的在用朋友圈）
 * 才允许用索引截流**；否则与 A4 之前逐字节同行为。
 * @returns 任一账号下已建过索引时为真。
 */
export declare function hasSnsMediaIndexEntries(): boolean;
export declare function resolveSnsImageDataUrl(wechatBaseDir: string | undefined, aesKey: string | undefined, xorKey: number, md5: string, timelineId?: string, mediaId?: string, allowThumb?: boolean): {
    url?: string;
    error?: string;
};
