/**
 * `types.ts` 的 config 部分（M21 拆分；纯类型，无运行期值）。
 *
 * 从 `types.ts` 原样搬出，`types.ts` 继续以 `export *` 转发 ⇒ 所有
 * `from './types.ts'` / `from '../types.ts'` 的导入路径一行都不用改。
 *
 * @module types-config
 */
/** Detected WeChat account. */
export interface WechatAccount {
    wxid: string;
    db_dir: string;
    last_active?: number;
    /** 解密库文件数（db_storage 下 .db 计数，不含 -wal/-shm）。 */
    db_files?: number;
}
/** Account detection snapshot. */
export interface AccountsSnapshot {
    accounts: WechatAccount[];
    total: number;
    /** 微信版本（安装目录下的版本文件夹，如 4.1.12.26）。 */
    version?: string;
    /** 微信安装目录（注册表 InstallPath，供密钥扫描定位 Weixin.dll）。 */
    install_dir?: string;
}
/** Database key verification result. */
export interface VerifyKeyResult {
    valid: boolean;
    aesOk?: boolean;
    hmacOk?: boolean;
    error?: string;
}
/** Keys-file generation result. */
export interface GenerateKeysResult {
    ok: boolean;
    verified: number;
    total: number;
    error?: string;
}
/** Keys-file info. */
export interface KeysInfoResult {
    keyFormat?: string;
    keyCount: number;
    loaded: boolean;
}
/** Auto-recovered V4 database key result (key_v4 memory scan). */
export interface AutoDbKeyResult {
    ok: boolean;
    key?: string;
    source?: string;
    error?: string;
}
/** Auto-recovered image key result (V2-verified memory scan). */
export interface AutoImageKeyResult {
    ok: boolean;
    xorKey?: number;
    aesKey?: string;
    verified?: boolean;
    wxid?: string;
    code?: number;
    templatePath?: string;
    error?: string;
}
/** One per-database decryption failure. */
export interface DecryptFailure {
    /** Database rel path inside db_storage. */
    db: string;
    error: string;
}
/** Full decryption result (立即解密). */
export interface DecryptAllResult {
    ok: boolean;
    /** Databases found in db_storage. */
    total: number;
    okCount: number;
    failed: DecryptFailure[];
    error?: string;
}
/** Saved image-key verification result. */
export interface VerifyImageKeyResult {
    verified: boolean;
    aesKey?: string;
    xorKey?: number;
    templatePath?: string;
    error?: string;
}
/** Batch image decryption result (立即解密图片). */
export interface DecryptImagesResult {
    ok: boolean;
    /** md5-prefixed .dat files found under msg/attach. */
    total: number;
    okCount: number;
    failed: number;
    /** Already-cached / non-renderable (hevc) files. */
    skipped: number;
    errors: Array<{
        file: string;
        error: string;
    }>;
    /** 被跳过的文件与原因（详情弹窗用）。 */
    skippedDetails?: Array<{
        file: string;
        reason: string;
    }>;
    error?: string;
}
/** Live decryption progress snapshot (getDecryptStatus). */
export interface DecryptStatus {
    /** Which decryption op is (or was last) running. */
    op: 'databases' | 'images' | null;
    active: boolean;
    done: number;
    total: number;
    failed: number;
    skipped: number;
    /** Current file/database short label. */
    message: string;
}
/** One Whisper model catalog entry (installed flag from the models dir). */
export interface WhisperModelInfo {
    id: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3' | 'turbo';
    name: string;
    sizeLabel: string;
    installed: boolean;
}
/** Live Whisper model download progress. */
export interface WhisperDownloadProgress {
    model: string;
    file: string;
    received: number;
    total: number;
}
/** Live voice batch transcription progress. */
export interface WhisperTranscribing {
    active: boolean;
    done: number;
    total: number;
    failed: number;
    skipped: number;
    current: string;
}
/** Voice batch transcription result. */
export interface VoiceTranscribeResult {
    ok: boolean;
    total: number;
    done: number;
    failed: number;
    skipped: number;
    errors: Array<{
        svrId: string;
        username: string;
        error: string;
    }>;
    engine: string;
    model?: string;
    error?: string;
}
/** Per-message transcript result. */
export interface VoiceTranscriptResult {
    text?: string;
    error?: string;
}
/** One-shot voice-message transcription result (chat bubble 语音转文字). */
export interface VoiceTranscribeOneResult {
    ok: boolean;
    text?: string;
    error?: string;
}
/** Whisper model download result. */
export interface WhisperDownloadResult {
    ok: boolean;
    file?: string;
    bytes?: number;
    error?: string;
}
/** Whisper transcription configuration status (getWhisperStatus). */
export interface WhisperStatus {
    /** Detected whisper engine ('whisper-cli' | 'whisper' | '' when none). */
    engine: string;
    enginePath?: string;
    hasCuda: boolean;
    /** Effective models dir (configured or the default under the data root). */
    modelsDir: string;
    models: WhisperModelInfo[];
    /** Active model download progress (null when idle). */
    downloading: WhisperDownloadProgress | null;
    /** Active voice transcription progress. */
    transcribing: WhisperTranscribing;
}
/** Generic ok/error result. */
export interface SimpleResult {
    ok: boolean;
    error?: string;
}
/** Fields the config form can save. */
export interface WechatConfigPatch {
    db_dir?: string;
    db_enc_key?: string;
    image_aes_key?: string;
    image_xor_key?: number;
    api_enabled?: boolean;
    api_token?: string;
    api_port?: number;
    cdn_enabled?: boolean;
    cdn_local_decrypt?: boolean;
    whisper_device?: 'cpu' | 'gpu';
    whisper_model?: string;
    whisper_threads?: number;
    whisper_models_dir?: string;
    whisper_bin?: string;
}
/** Delete result. */
export interface DeleteFavoriteResult {
    ok: boolean;
    deleted: number;
    error?: string;
}
/** Annual report (local-only yearly stats). */
export interface AnnualReport {
    year: number;
    total: number;
    active_days: number;
    text_chars: number;
    daily_avg: number;
    text_share: number;
    night_share: number;
    morning_share: number;
    weekend_share: number;
    group_share: number;
    heat: number[];
    monthly: number[];
    kind_counts: Record<string, number>;
    top_phrases: Array<{
        phrase: string;
        count: number;
    }>;
    top_emoji: Array<{
        emoji: string;
        count: number;
    }>;
    top_contacts: Array<{
        username: string;
        name: string;
        count: number;
        share: number;
    }>;
    top_groups: Array<{
        username: string;
        name: string;
        count: number;
        share: number;
    }>;
    first_message?: string;
    last_message?: string;
    persona_tags: string[];
}
/** Host event vocabulary for the wechat-data surface. */
declare module '@deepseek-ai/cordis' {
    interface Events {
        /**
         * New WeChat messages were synced from the raw encrypted DBs into the
         * decrypted snapshot (a WAL increment or a full re-decrypt). Panels
         * refresh on it instead of waiting for the next polling tick.
         * @mode emit
         * @param shards - message shard file names that were updated.
         */
        'wechat-data/updated'(shards: string[]): void;
        /**
         * 微信问答的流式回答增量：payload 是 `{ id, text }`，`id` 为本次流式请求的标识
         * （由客户端在调用 askWechat 时生成），渲染端按 id 把增量拼起来。
         * 由 `gateway.ts` 的流式回调发出、`src/client/ui-app/ui-entry.tsx` 消费。
         * @mode emit
         * @param payload - 流式标识与本次新增的文本片段。
         */
        'wechat-ask/delta'(payload: {
            id: string;
            text: string;
        }): void;
        /**
         * 导出/加密备份的进度（M3）：payload 是 `{ jobId, phase, done, total }`。
         *
         * `jobId` 由渲染层在调用 `exportAllSessions` / `exportMoments` / `createEncryptedBackup`
         * 时自己生成并回传 —— 函数与 AbortSignal 都过不了 IPC，所以进度与取消都靠这个标识
         * （取消走 `cancelExportJob({ jobId })`，兜底读进度走 `getExportProgress({ jobId })`）。
         * `total = 0` 表示总量未知（流式压缩阶段算不出来），渲染端据此显示不定量进度。
         * @mode emit
         * @param payload - 任务标识与本次进度。
         */
        'wechat-export/progress'(payload: {
            jobId: string;
            phase: string;
            done: number;
            total: number;
        }): void;
    }
}
