/**
 * 表情文件的**扫描索引**（E2，2026-09-28 性能修复）。
 *
 * ## 为什么需要它
 *
 * 原实现对每次「本地缓存未命中」都从 `msg/attach` 做一次**四层递归 readdir**，
 * 只为找 `<md5>.dat` / `<md5>_t.dat` 两份文件。现场日志里 `getEmoticonDataUrl`
 * 13 次、**均 27,253ms、峰值 71,909ms** —— 这不可能是「解码慢」，
 * 而是**每次都在整棵 attach 树上重走一遍**（大账号下 attach 有几十万文件）。
 *
 * ## 索引形状与失效判据
 *
 * 与 `sns-image.ts` 的按月索引同一范式：记「目录 → (mtimeMs, size) 签名 + 文件名集合」，
 * 签名没变就直接查表，不重扫。**不缓存解码结果**（那由 `decoded_images/` 落盘负责），
 * 只缓存「哪个文件名在哪」这一层。
 *
 * ⚠ 只索引**文件名形如 32 位 hex + `.dat` 后缀**的条目：attach 下绝大多数文件是
 * 消息附件（图片、视频、文件），全收进来会让索引本身比扫描还贵。判据是
 * {@link EMOTICON_DAT_RE}，也就是「能当表情用的那些」。
 */
export interface EmoticonDirEntry {
    mtimeMs: number;
    size: number;
    /** 小写文件名 → 绝对路径（只收 `.dat` 且名字是 32 位 hex 或 `<hex>_t`）。 */
    byName: Map<string, string>;
}
export interface EmoticonIndex {
    dirs: Map<string, EmoticonDirEntry>;
}
/**
 * 取（必要时重建）某个 attach 根的表情索引。
 *
 * 命中判据：每个目录的 `(mtimeMs, size)` 与上次一致就复用它的 `byName`。
 * **单签名变化只重扫那一个目录** —— 微信会不断往 `<月>/Img` 里加新表情，
 * 整树重扫正是要避免的开销。
 * @param attachRoot - `msg/attach` 绝对路径。
 * @returns 目录路径 → 索引条目（调用方按需查 `byName`）。
 */
export declare function emoticonIndexFor(attachRoot: string): Map<string, EmoticonDirEntry>;
/**
 * 在索引里找一个 md5 的两份候选 `.dat`（`<md5>_t.dat` 优先）。
 *
 * 与旧实现的等价性：旧实现扫出**所有**候选再按 {@link DatTier} 排序取最好的那份；
 * 这里只回 `_t` 与主体两份 —— 因为 `EMOTICON_DAT_RE` 只认这两个形状，
 * 排序结果必然就是「缩略图在前、主体在后」，多余的排序步骤可以省掉。
 * @param dirs - {@link emoticonIndexFor} 的结果。
 * @param m - 小写 md5。
 * @returns 候选路径（缩略图优先）；找不到时为空数组。
 */
export declare function findEmoticonDats(dirs: Map<string, EmoticonDirEntry>, m: string): string[];
/**
 * 是否「本机确实没有这个表情文件」且这个结论还新鲜。
 * @param attachRoot - `msg/attach` 根。
 * @param m - 小写 md5。
 */
export declare function emoticonMissFresh(attachRoot: string, m: string): boolean;
/** 记下「本机没有」。超过上限时按插入顺序淘汰最旧的键。 */
export declare function noteEmoticonMiss(attachRoot: string, m: string): void;
/**
 * 批量接口一次查完之后的「补一次时间戳」。
 *
 * 批量那条路（E1）一个 RPC 里就把屏上所有缺失表情定完了，逐条记负缓存没有意义 ——
 * 记了也只影响「下次单独问这一张」，而那份收益远小于维护代价。所以这里只做一件事：
 * **把每个 `attachRoot|*` 的判定时刻整体推一次**，让调用方不必逐条知道 md5。
 *
 * 判据刻意只看 `attachRoot+` 前缀：一个根下反复出现缺失时，覆盖式刷新它的时刻戳，
 * 于是负缓存不会因为「这批查的是别的 md5」而整片过期。
 * @param attachRoot - `msg/attach` 根。
 * @param count - 这一批里判定为「本机没有」的条数（仅用于日志与断言可读性）。
 */
export declare function noteEmoticonMissBatch(attachRoot: string, count: number): void;
/**
 * 清空表情扫描索引与负缓存（测试用；也供「用户手动刷新」这类场景调用）。
 *
 * 与 `image-cache` 的 `forgetAllImages()` 同一考虑：索引是**跨调用共享的模块级状态**，
 * 一份测试污染会影响下一份，所以必须给测试一个明确的重置入口，
 * 而不是让它们各自「反正键不一样」地绕过去。
 */
export declare function forgetEmoticonIndex(): void;
