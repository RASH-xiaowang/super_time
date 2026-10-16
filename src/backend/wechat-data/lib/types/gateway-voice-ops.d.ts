/**
 * WechatDataGateway 方法面 · 语音 LLM / Whisper 链路的 @Remote 壳（voiceLlm 域）。
 *
 * 与其它 gateway-* 壳共同构成继承链；装饰器标记会落到最派生原型上，
 * 因此协议层枚举到的方法面与拆分前逐名相同（守卫：gateway-remote-surface.spec.ts）。
 */
import type { VoiceTranscribeResult, WhisperDownloadResult, WhisperStatus } from './types.ts';
import { GatewayExportOps } from './gateway-export-ops.ts';
export declare abstract class GatewayVoiceOps extends GatewayExportOps {
    /**
     * Export a data category (contacts/favorites/records/moments) to CSV.
     * @param options - data category kind and optional records sub-kind.
     * @returns ExportResult: exported file path/count info.
     */
    /**
     * Export the annual report as markdown / html / json.
     * @param options - year, format, optional dir/filename.
     * @returns ExportResult: written file path + filename + count.
     */
    /**
     * List the daily-summary model provider(s): the default model's provider
     * (the one the user actually configured), clean and unambiguous.
     */
    listLlmProviders(): {
        providers: Array<{
            id: string;
            name: string;
        }>;
    };
    /** List the provider's configured models (from the "设置 → 模型" settings section), falling back to the provider catalog. */
    listLlmModels(options: {
        provider: string;
    }): Promise<{
        models: Array<{
            id: string;
            name: string;
        }>;
    }>;
    /**
     * Whisper transcription configuration status: engine detection, CUDA
     * presence, models dir + installed ggml binaries, active download progress
     * (inference itself stays bridge-side).
     * @returns WhisperStatus: engine/hasCuda/models inventory.
     */
    getWhisperStatus(): WhisperStatus;
    /**
     * Download one official whisper.cpp ggml model into the models dir
     * (streamed, atomic publish; huggingface.co with hf-mirror fallback).
     * @param options - model id to download.
     * @returns WhisperDownloadResult: ok + file/bytes, or an error.
     */
    downloadWhisperModel(options: {
        model: string;
        jobId?: string;
    }): Promise<WhisperDownloadResult>;
    /**
     * 停止一次正在跑的模型/引擎下载（W3-5.5）。
     *
     * 取消只在下**一个 chunk** 生效；已下载的部分保留为 `.part`，下次可续传。
     * @param options - jobId（即 `downloadWhisperModel` 那次的同一标识）。
     * @returns ok + 停不上的原因。
     */
    cancelWhisperDownload(options: {
        jobId: string;
    }): Promise<{
        ok: boolean;
        message?: string;
    }>;
    /**
     * Download + install the whisper.cpp CLI engine into the models dir
     * (`<modelsDir>/bin/whisper-cli.exe`), persisting the path as whisper_bin.
     * @returns WhisperDownloadResult: ok + path, or an error.
     */
    installWhisperEngine(options?: {
        jobId?: string;
    }): Promise<WhisperDownloadResult>;
    /**
     * Batch-transcribe the most recent voice messages: silk → WAV (bundled
     * wx_silk) → whisper-cli with the selected model → text cached per message.
     * @param options - optional message count (default 50, clamped 1..200).
     * @returns VoiceTranscribeResult: done/failed/skipped counts.
     */
    transcribeVoiceBatch(options?: {
        limit?: number;
    }): Promise<VoiceTranscribeResult>;
}
