/**
 * 原图自动收割：监控微信 `msg/attach`，一旦微信把原图落盘成 `_h.dat` 就立刻解进解码缓存。
 *
 * ## 为什么需要它（这是「拿到高清原图」唯一不越界的通路）
 *
 * 2026-10-17 实测（`working/probe-*.mjs`，脚本不入库）确认了三件事：
 *
 * | 通路 | 实测结果 |
 * |---|---|
 * | 消息 XML 的 `tphdurl`/`tpurl` | 本机 20,431 条**全部**指向企业微信 `wwfile` 端点，匿名 GET 一律 403 |
 * | 进程内存里的 `tpauthkey`（806 处） | 拼进 URL 的 5 种变体**全部 403** —— 它是给 mmtls 私有协议用的，不是 HTTP 凭据 |
 * | 进程内存里的 JPEG（225 个） | 与数据库 48,882 个图片 md5 **交集为 0** —— 那是界面渲染缓存，不是聊天原图 |
 *
 * 也就是说：**聊天图片走的是 mmtls 私有 RPC，不是 HTTP 直链**。微信拿到字节后直接解密渲染，
 * 内存里留下的是像素而不是可复用的 URL。要自己取，必须重写 mmtls + 私有 RPC 调用。
 *
 * 但微信**自己**会下载原图：用户在微信里点「查看原图」时，它把原图落盘成
 * `<md5>_h.dat`（实测本机 1,459 个，今天仍在持续新增）。本模块就盯住这个落盘动作 ——
 * 微信负责下载，我们负责收割。**不联网、不碰凭据、不注入进程**。
 *
 * ## 与「升级为原图」的分工
 *
 * `image-upgrade.ts` 是**一次性全量重解**（用户点一次，扫全部缓存）。本模块是**增量监听**：
 * 用户一边在微信里看图，这边一边自动收，不需要再回来点按钮。两者共用
 * `decodeDatBytesAsync` 与同一个缓存槽位，所以不会互相打架（升级只认「严格更大」）。
 *
 * ## 边界（写清楚，别让人以为它万能）
 *
 *   · **只收割用户已经在微信里点开过的图**。没点开过的，微信磁盘上根本没有 `_h.dat`，
 *     本模块也变不出来 —— 这是微信的下载策略，不是我们的实现缺陷。
 *   · 监控是**进程内**的：应用关掉期间微信落盘的原图，下次启动时由「升级为原图」补上
 *     （本模块启动时也会先做一次全量扫描，见 `startOriginalHarvester`）。
 *   · 只认 `_h.dat`（原图档）。`_t.dat`（缩略图）与聊天版 `.dat` 不触发收割 ——
 *     它们本来就会被逐条读图路径解出来，重复处理只是白烧 CPU。
 */
/** 一次收割的结果（给界面/日志用）。 */
export interface HarvestResult {
    /** 成功解进缓存的张数。 */
    harvested: number;
    /** 解不开的张数（密钥不对 / wxgf 转码不可用 / 文件还在写）。 */
    failed: number;
    /** 逐条失败原因（只留前 20 条，避免日志爆炸）。 */
    errors: Array<{
        file: string;
        error: string;
    }>;
}
/** 收割器的运行状态（`getOriginalHarvestStatus` 读它）。 */
export interface HarvestStatus {
    /** 是否正在监控。 */
    watching: boolean;
    /** 监控的根目录（未启动时为空串）。 */
    root: string;
    /** 本次进程生命周期内累计收割的张数。 */
    harvested: number;
    /** 累计失败张数。 */
    failed: number;
    /** 最近一次收割的时间戳（毫秒）；从未收割过为 0。 */
    lastAt: number;
    /** 最近一次收割的文件名（给界面显示「刚刚收到 xxx」）。 */
    lastFile: string;
    /**
     * 手动收割的实时进度（`harvestOriginalsNow` 在跑时非 null）。
     *
     * 为什么要它：本机 1,459 个 `_h.dat` 实测要 **69 秒**，没有进度的话界面只能显示
     * 「收割中…」干等一分钟，用户会以为卡死了。监控路径（单文件）不写这个字段。
     */
    progress: {
        done: number;
        total: number;
        harvested: number;
        failed: number;
    } | null;
}
/**
 * 收割一批 `_h.dat`（同步扫描 + 逐个解）。
 *
 * 供两处用：① 监控回调（单个文件）；② 用户点「立即收割」时的全量扫描。
 * @param files - `_h.dat` 绝对路径列表。
 * @param decodedDir - 解码缓存根。
 * @param aesKey - V2 AES 密钥。
 * @param xorKey - XOR key 字节。
 * @param onProgress - 每处理完一个文件回调一次（已处理 / 总数 / 已成功 / 已失败）。
 *   本机 1,459 个 `_h.dat` 实测要 69 秒，没有进度的话界面只能干等。
 * @returns 收割结果。
 */
export declare function harvestHdDats(files: readonly string[], decodedDir: string, aesKey: string | undefined, xorKey: number, onProgress?: (done: number, total: number, harvested: number, failed: number) => void): Promise<HarvestResult>;
/**
 * 启动原图收割器：**只挂文件监控**，不做全量补扫。
 *
 * ## 为什么启动时不补扫（2026-10-17 实测教训）
 *
 * 第一版在启动时先全量扫一遍 `msg/attach` 再挂监控。本机 1,459 个 `_h.dat` 逐个解密
 * 实测耗时 **69 秒** —— 而重任务队列只有 1 个槽位，这 69 秒里任何 `status` 查询都会被
 * 「重任务队列已满」拒掉，界面上的「正在监控」永远等不到。
 *
 * 所以拆成两件事：
 *   · **启动**（本函数）：只挂监控，毫秒级返回。用户点「开启自动收割」立刻看到「正在监控」。
 *   · **补扫**（`harvestOriginalsNow`）：用户显式点「立即收割」时才跑，进度可见。
 *
 * 幂等：重复调用只更新密钥（监控不重建）。`stopOriginalHarvester` 之后可再次启动。
 * @param rawRoot - 微信账号原始根目录（`msg/attach` 的父目录）。
 * @param decodedDir - 解码缓存根。
 * @param aesKey - V2 AES 密钥（16 字符 ASCII），或 undefined。
 * @param xorKey - XOR key 字节。
 * @param onHarvest - 每收割成功一张时回调（界面据此刷新）。
 * @returns 恒为 `{harvested:0, failed:0, errors:[]}`（启动本身不收割）。
 */
export declare function startOriginalHarvester(rawRoot: string, decodedDir: string, aesKey: string | undefined, xorKey: number, onHarvest?: (md5: string, format: string) => void): Promise<HarvestResult>;
/** 停止监控（应用退出或切换账号时调用）。 */
export declare function stopOriginalHarvester(): void;
/**
 * 读收割器状态（界面显示「已自动收割 N 张」）。
 * @returns 当前状态快照。
 */
export declare function getOriginalHarvestStatus(): HarvestStatus;
/**
 * 设置/清除手动收割进度（供 `harvestOriginalsNow` 用）。
 * @param p - 进度快照；null 表示收割结束。
 */
export declare function setHarvestProgress(p: {
    done: number;
    total: number;
    harvested: number;
    failed: number;
} | null): void;
