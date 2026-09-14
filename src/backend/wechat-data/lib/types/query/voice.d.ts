/** One VoiceInfo row with its chat username. */
export interface VoiceSource {
    chatId: string;
    localId: string;
    svrId: string;
    username: string;
}
/** Map a chat_name_id (Name2Id rowid) to its user_name. */
export declare function usernameByChatId(decryptedDir: string, chatId: string): string;
/** Most recent voice messages (newest first). */
export declare function recentVoiceMessages(decryptedDir: string, limit: number): VoiceSource[];
/** The raw silk voice_data bytes for a svr_id. */
export declare function voiceDataBySvr(decryptedDir: string, svrId: string): Buffer | null;
/** VoiceInfo svr_id for (username, local_id) — direct Name2Id mapping. */
export declare function svrIdByChatLocal(decryptedDir: string, username: string, localId: number): string;
/** Resolve the wx_silk decoder binary: env pin, bundled resources, '' when none. */
export declare function silkDecoderBin(): string;
/**
 * Decode silk bytes to a WAV file via wx_silk (16 kHz mono, whisper-ready).
 * @param silk - raw voice_data bytes (leading 0x02 tolerated).
 * @param wavPath - output WAV path (parent dir created).
 * @returns ok, or an error description.
 */
export declare function silkToWav(silk: Buffer, wavPath: string): {
    ok: boolean;
    error?: string;
};
/**
 * 一条语音消息 → 可就地播放的 wav data URL。
 *
 * 复用**转写链路的缓存目录** `<decoded>/voices/<svr_id>.wav`（`voice-transcribe.ts` 也写这里），
 * 两边共用同一份产物：命中缓存 0ms；未命中才调打包的 wx_silk 解码（本机实测 **13ms**，
 * 16kHz 单声道下发 3.5 秒 ≈ 145KB / 51 秒 ≈ 2.1MB 的 base64，语音上限 60 秒，量级可接受）。
 *
 * 为什么用 data URL 而不是 `file://`：渲染进程 CSP 是 `media-src 'self' data: blob:`，
 * **不含 `file:`**，站内 `<audio src="file://…">` 会被直接拦掉。
 *
 * @param decryptedDir - decrypted data root.
 * @param decodedDir - decoded cache root (wav 落在其 voices/ 下).
 * @param username - conversation username.
 * @param localId - message local id.
 * @returns url (base64 wav) + durationSec, or an error description.
 */
export declare function resolveVoiceDataUrl(decryptedDir: string, decodedDir: string, username: string, localId: number): {
    url?: string;
    durationSec?: number;
    error?: string;
};
