/**
 * 多路召回结果融合与去重（目标 4）。
 *
 * 用 **RRF（Reciprocal Rank Fusion）** 而不是「分数加权求和」，原因：
 * 稀疏的 BM25 分与稠密的余弦分**量纲完全不同**（BM25 无上界、余弦在 [-1,1]），
 * 直接加权必须做归一化，而归一化对异常值极敏感（一条超长文档能把 BM25 归一化尺度带偏）。
 * RRF 只用**名次**，天然免标定，且被多个通道同时召回的文档会自动获得累加优势 ——
 * 这正是「一致性」信号，也是去重的天然入口（按 docKey 合并）。
 *
 * 融合后按压缩预算 keep 截断，再做去重兜底（docKey 相同 + 文本高度相似）。
 */
import type { ChannelName, ChannelResult, FusedDoc } from './types.ts';
/**
 * RRF 融合多路召回结果。
 * @param channels - 各通道结果（未启用的通道 active=false，被忽略）。
 * @param k - RRF 平滑常数（经验值 60；越小越强调头部名次）。
 * @param keep - 融合后保留候选数（进入重排）。
 * @returns 按 RRF 降序的融合候选。
 */
export declare function fuseResults(channels: ChannelResult[], k: number, keep: number): FusedDoc[];
/**
 * 兜底去重：RRF 已按 docKey 合并，这里再合并**文本近似重复**的不同消息
 * （微信里同一句被转发/复述会产生多条不同 local_id 的近似文本）。
 *
 * **必须叠加时间邻近条件**：微信的系统通知是模板化的 —— 「微信转账 收到转账3500.00元」
 * 这类消息在同一会话里逐月出现，文本几乎完全一致却是**不同的事件**。旧实现只看文本相似度，
 * 会把「一共转了多少笔账」里的多笔转账合并成一条（实测把 9 月那笔吞掉）。
 * 因此只有「同会话 + 文本近似 + 时间相近（默认 5 分钟内）」才判定为重复。
 * @param docs - 融合后候选（已按 RRF 降序）。
 * @param threshold - 文本相似度阈值（≥阈值视为重复）。
 * @param maxGapSec - 判定为同一次发言的最大时间间隔（秒）。
 * @returns 去重后的候选。
 */
export declare function dedupeFused(docs: FusedDoc[], threshold: number, maxGapSec?: number): FusedDoc[];
/** 通道结果简表（写进统计）。 */
export declare function channelSummary(channels: ChannelResult[]): Array<{
    channel: ChannelName;
    count: number;
    active: boolean;
    note?: string;
}>;
