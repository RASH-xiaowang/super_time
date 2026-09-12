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
/**
 * Map a file path to an ASCII equivalent (junction alias for non-ASCII parent
 * dirs) so whisper-cli can open it; ASCII paths pass through untouched.
 * @param filePath - model/wav/output path to hand to whisper.
 * @param aliasBase - ASCII dir that holds the junction links.
 * @returns an ASCII-safe path to the same file.
 */
export declare function asciiPathForWhisper(filePath: string, aliasBase: string): string;
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
//# sourceMappingURL=voice-transcribe.d.ts.map