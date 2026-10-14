import { type StreamControl } from './zip.ts';
/**
 * 年报（带**签名缓存**）。
 *
 * ## 为什么必须缓存（2026-09-29 第 79/80 轮实测）
 *
 * 这个接口**每次调用都真扫 ~200 万行**：实测冷跑 **2501ms**、紧接着再跑一次 **2496ms** ——
 * **冷热几乎一样，说明此前完全没有结果缓存**。
 * 它是"用户点开年报要等 2.5 秒"的直接原因（`exportAnnualReport` 走同一条路，所以约 3s）。
 *
 * 缓存键 = `年份 + message 目录的分片目录签名`：分片文件变了（实时同步落地新数据、
 * 或整库重解密）签名就变，缓存自然失效 —— 与 `asset-insights` / `moments-monthly`
 * 用的是同一套 `cachedBySigAsync` 机制，不引入新概念。
 *
 * @param decryptedDir - 解密数据根。
 * @param year - 自然年。
 * @returns 年报快照。
 */
export declare function queryAnnualReport(decryptedDir: string, year: number, ctrl?: StreamControl): Promise<Record<string, unknown>>;
