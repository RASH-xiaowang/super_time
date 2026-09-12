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
//# sourceMappingURL=voice.d.ts.map