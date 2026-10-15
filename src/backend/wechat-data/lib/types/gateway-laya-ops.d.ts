/**
 * WechatDataGateway 方法面 · 本地 Laya 决策模型链路的 @Remote 壳及装配器。
 *
 * 与其它 gateway-* 壳共同构成继承链；装饰器标记会落到最派生原型上，
 * 因此协议层枚举到的方法面与拆分前逐名相同（守卫：gateway-remote-surface.spec.ts）。
 */
import type { LayaAnalysisView, LayaDownloadOutcome, LayaStatus, LayaVisibleAnalysisResult } from './types.ts';
import { createLayaRemotes } from './remotes/laya.ts';
import { GatewayConfigOps } from './gateway-config-ops.ts';
export declare abstract class GatewayLayaOps extends GatewayConfigOps {
    protected _layaRemotes?: ReturnType<typeof createLayaRemotes>;
    /**
     * Analyze one conversation with the **local** decision model
     * (laya · onnxruntime-node + JS tokenizer; no network, no LLM, not gated by the
     * outbound privacy gate). Answers are per-question probability distributions.
     * @param options - talker (conversation username) + optional context limit (default 20, max 60).
     * @returns LayaAnalysisView: per-question answers, or `ok:false` with the reason the
     *   model is not ready (missing files / load failure) — an expected path, not an exception.
     */
    analyzeMessages(options: {
        talker: string;
        contextLimit?: number;
    }): Promise<LayaAnalysisView>;
    /**
     * Per-message analysis for the message stream's visible window (local model · no network).
     * Each message is analyzed against the conversation **up to that point**; voice messages are
     * transcribed first (whisper, disk-cached) and the transcript is what gets analyzed.
     * Results are cached in `<data root>/laya_analysis.db` keyed by (session, message, model fingerprint).
     * @param options - talker + targets (localId + sortSeq of each visible message).
     * @returns LayaVisibleAnalysisResult: per-message answers; one bad message only fails its own item.
     */
    analyzeVisibleMessages(options: {
        /** 会话微信 ID —— 同一个概念的正名见 `WechatSession.username`（P3-6：问答链沿用库里更早的列名）。 */
        talker: string;
        targets: Array<{
            localId: number;
            sortSeq: number;
        }>;
        /** W3-11.5：进度标识；带上它才会推送 `laya-analysis/progress`（渲染层按它认领本批）。 */
        jobId?: string;
    }): Promise<LayaVisibleAnalysisResult>;
    /**
     * 停止一批正在跑的逐条本地分析（W3-11.5）。
     *
     * 取消只在每条之间生效（一次 ONNX forward 没法从中间打断），所以最坏延迟是最后一条的
     * 推理时长；已经算完的那些会**连同缓存一起保留**（`canceled:true` + 部分 `items`）。
     * @param options - jobId（必填，即 `analyzeVisibleMessages` 那批的同一标识）。
     * @returns ok + 停不上的原因（该批已经算完 / 标识不认识）。
     */
    cancelLayaAnalysis(options: {
        jobId: string;
    }): Promise<{
        ok: boolean;
        message?: string;
    }>;
    /**
     * Local decision model status: required files (model graph + tokenizer), size, source,
     * active download progress and runtime state (loaded / last inference ms / last error).
     * @returns LayaStatus.
     */
    getLayaStatus(): LayaStatus;
    /**
     * Download the decision model assets (~1.26 GB: graph + tokenizer) into the data dir.
     * Streamed with resume + atomic publish, mirror fallback; idempotent.
     * @returns LayaDownloadOutcome.
     */
    downloadLayaModel(options?: {
        jobId?: string;
    }): Promise<LayaDownloadOutcome>;
    /**
     * 取消正在进行的 laya 模型下载（W2-11.5）。
     * @param options - jobId（与 `downloadLayaModel` 传的是同一个）。
     * @returns ok，或没有该任务时的说明。
     */
    cancelLayaDownload(options: {
        jobId: string;
    }): {
        ok: boolean;
        message?: string;
    };
    /**
     * Adopt an already-downloaded model directory (move it into the data dir) so the
     * same 1.26 GB does not have to be fetched twice.
     * @param options - sourceDir containing the model + tokenizer layout.
     * @returns LayaStatus after the move.
     */
    adoptLayaModel(options: {
        sourceDir: string;
    }): LayaStatus;
    /**
     * Unload the model, releasing roughly 1.2 GB of resident memory. The next analysis
     * call loads it again.
     * @returns SimpleResult.
     */
    unloadLaya(): {
        ok: boolean;
    };
    /**
     * 本地决策模型（分析会话消息、模型状态/下载/接管/卸载） 的处理器（体在 remotes/laya.ts）；
     * 这里只组装 ctx 与转发。组装放在本层而不是 core，是为了不让 core 越过 1000 行上限。
     */
    protected layaRemotes(): ReturnType<typeof createLayaRemotes>;
}
