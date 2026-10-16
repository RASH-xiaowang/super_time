import type { GroupInsightsSnapshot } from '../types.ts';
/**
 * 离线群聊洞察：群总消息数 / 活跃天数 / 成员活跃榜 / 群公告。
 *
 * W2-4.4：这层只做「按签名取缓存」，算法体在 {@link computeGroupInsights}。
 * 实测（合成 8 分片 × 20000 行 = 16 万条群消息，`group-insights-cost.measure.spec.ts`）：
 * 冷算 **161.5ms**、签名命中 **0.003ms**。成本随分片数线性增长（真实账号 200+ 分片），
 * 而面板是「打开即查一次」（`useFreshData` 不轮询），所以省下的正是**重复打开**那一档。
 * @param decryptedDir - 已解密数据根。
 * @param username - 群 username。
 * @returns 洞察快照。
 */
export declare function queryGroupInsights(decryptedDir: string, username: string): GroupInsightsSnapshot;
/**
 * 群洞察的算法体（无缓存，供 {@link queryGroupInsights} 的 loader 调用，也可单测直接打）。
 * @param decryptedDir - 已解密数据根。
 * @param username - 群 username。
 * @returns 洞察快照。
 */
export declare function computeGroupInsights(decryptedDir: string, username: string): GroupInsightsSnapshot;
