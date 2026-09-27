/** 预热与单张入口共用的缓存扩展名（命中其中任意一个就不重写）。 */
export declare const CACHED_IMAGE_EXTS: string[];
/**
 * 批量预热「按用户」解码缓存（N16 的接线点，见 `getImageDataUrlsBatch`）。
 *
 * 为什么是「预热」而不是「在这里返回结果」：解码产物与单张入口共用同一份缓存目录/命名
 * （`<decoded>/<username>/<md5>.<ext>`），写进去之后单张入口命中缓存、不再查路径表 ——
 * 于是错误语义、`data_index` 兜底、hevc 判定这些**全部沿用单张入口**，不必在调用方复制一份解码逻辑。
 * 2026-09-27 #20 第五刀：这一族原先住在 `GatewayCore` 里 —— 那是全类**唯一**直接读写文件的地方，
 * 报告 §P2-2 第 2 条要求「含 fs 写的能力下沉回 query 层，core 只做编排」，于是搬到这里。
 *
 * 全程 best-effort：任何一处失败都只是「那张图回退到原来的逐张路径」，不影响其余张；
 * 命中已有缓存的文件不重写。
 * @param decryptedDir - 解密库目录（hardlink.db 所在）。
 * @param decodedDir - 解码缓存根。
 * @param baseDir - 微信原始目录（候选路径的根）。
 * @param items - 待预热的 (username, localId) 列表。
 * @param aesKey - V2 AES key。
 * @param xorKey - XOR key 字节。
 */
export declare function warmDecodedImages(decryptedDir: string, decodedDir: string, baseDir: string, items: ReadonlyArray<{
    username: string;
    localId: number;
}>, aesKey: string | undefined, xorKey: number): void;
