/**
 * ClawBot 实例的 **token 消耗统计**（2026-10-19）。
 *
 * 自动回复每次模型调用都会拿到供应商返回的 usage；这里按「实例 slot + 本地日期」聚合落库，
 * 实例轨显示「今日 / 累计」。表住在 `clawbot.db`（与实例、会话同一库，删实例时一并清）。
 *
 * 口径：
 *   · `total_tokens` 优先用供应商的 `total_tokens`（含缓存输入）；没有时按 dsh-llm 的
 *     `inputTokens + outputTokens + cacheRead + cacheWrite` 求和；
 *   · 没有 usage 的调用**不记 0 行**（供应商不报用量 ≠ 用量为 0），统计显示为 0 是「确实没记到」。
 */
import type { TokenUsage } from '@deepseek-ai/dsh-llm';
/** 某实例的 token 统计（今日 / 累计）。 */
export interface ClawbotTokenStats {
    todayTokens: number;
    totalTokens: number;
}
/** 本地日期键（`YYYY-MM-DD`，按运行机器的时区）。 */
export declare function clawbotDayKey(ts?: number): string;
/**
 * 记一次模型调用的 token 用量（best-effort：写失败只告警，不影响自动回复）。
 * @param decryptedDir - 解密数据根。
 * @param slot - 实例编号。
 * @param usage - 模型返回的用量。
 */
export declare function addClawbotTokenUsage(decryptedDir: string, slot: number, usage: TokenUsage | undefined): void;
/**
 * 读全部实例的 token 统计（按 slot 索引）。
 * @param decryptedDir - 解密数据根。
 * @param day - 本地日期键（`clawbotDayKey()`）。
 * @returns slot → { todayTokens, totalTokens }；读失败返回空 Map（与「没有消耗」区分不了，
 *   但统计是增强信息，不该让实例列表整体报错）。
 */
export declare function clawbotTokenStats(decryptedDir: string, day: string): Map<number, ClawbotTokenStats>;
