/** One per-message failure record. */
export interface TranscribeError {
    svrId: string;
    username: string;
    error: string;
}
/** Batch transcription result. */
export interface VoiceBatchResult {
    ok: boolean;
    total: number;
    done: number;
    failed: number;
    skipped: number;
    errors: TranscribeError[];
    engine: string;
    model?: string;
    error?: string;
}
/** Cached transcript path for one voice message. */
export declare function transcriptPath(decodedDir: string, svrId: string): string;
/** Cached transcript text (empty when none). */
export declare function cachedTranscript(decodedDir: string, svrId: string): string;
/** Real parent dir → created ASCII junction path (per batch). */
/**
 * W3-5.4：批量转写的并发上界。
 *
 * 为什么小心把它写大：这里的“并发”是指一次最多几条 whisper 子进程
 * 在跑（spawn 出去同时等）。whisper 是 CPU 密集型，超过本机core 数
 * 之后互相抢，总时间反而变长；而 1 则与串行无异（那这条改动就白做）。
 * 2 是本机体感最好的值（双核以上的机器都能分到活）。
 */
export declare const TRANSCRIBE_CONCURRENCY = 2;
/**
 * Map a file path to an ASCII equivalent (junction alias for non-ASCII parent
 * dirs) so whisper-cli can open it; ASCII paths pass through untouched.
 * @param filePath - model/wav/output path to hand to whisper.
 * @param aliasBase - ASCII dir that holds the junction links.
 * @returns an ASCII-safe path to the same file.
 */
export declare function asciiPathForWhisper(filePath: string, aliasBase: string): string;
/**
 * 与 {@link whisperOne} 同语义，但 whisper 走**异步 spawn**（2026-10-13）。
 *
 * 为什么需要：内联分析（`laya/analysis.ts` 的 analyzeVisibleMessages）会给每条语音消息
 * 做转写，而 `spawnSync` 让整个 worker 在 whisper 的 2–4 秒里**完全独占**——用户实测
 * `getSessions` 排队 2.2s、消息查询被顶成秒级（「消息同步慢、会话列表更慢」的正主）。
 * 异步 spawn 期间事件循环照常服务别的请求；语义（输出解析/错误）与同步版逐条一致。
 */
export declare function whisperOneAsync(bin: string, modelPath: string, wavPath: string, outBase: string): Promise<string>;
/**
 * Transcribe one voice message by (username, local_id) — used by the chat
 * bubble's 语音转文字 button.
 * @returns { ok:true, text } or { ok:false, error }.
 */
export declare function transcribeOneVoice(decryptedDir: string, decodedDir: string, modelsDir: string, modelId: string, engineBin: string, username: string, localId: number): {
    ok: boolean;
    text?: string;
    error?: string;
};
/**
 * 与 {@link transcribeOneVoice} 同语义，但 whisper 走**异步 spawn**——
 * 内联分析路径专用（`laya/analysis.ts` 会 `await` 它）：转写期间 worker
 * 不再被独占，消息查询/会话列表照常服务（2026-10-13 用户报「新消息同步慢」的根因修复）。
 */
export declare function transcribeOneVoiceAsync(decryptedDir: string, decodedDir: string, modelsDir: string, modelId: string, engineBin: string, username: string, localId: number): Promise<{
    ok: boolean;
    text?: string;
    error?: string;
}>;
/**
 * Batch-transcribe the most recent voice messages.
 * @param decryptedDir - decrypted data root (VoiceInfo source).
 * @param decodedDir - decoded-images cache root (wav/txt caches).
 * @param modelsDir - model cache dir.
 * @param modelId - selected model id ('tiny' | ... | 'turbo').
 * @param engineBin - whisper-cli binary path.
 * @param limit - max voice messages to process (newest first).
 * @param onProgress - per-message progress callback.
 * @returns VoiceBatchResult with ok/done/failed/skipped counts.
 */
export declare function transcribeVoiceBatch(decryptedDir: string, decodedDir: string, modelsDir: string, modelId: string, engineBin: string, limit: number, onProgress: (done: number, total: number, failed: number, current: string) => void): Promise<VoiceBatchResult>;
