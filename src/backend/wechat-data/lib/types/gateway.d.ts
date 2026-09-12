/**
 * WeChatDataGateway — Host Remote service exposing st_control's decrypted
 * WeChat SQLite through the DSH Typert RPC. The browser client calls
 * ctx.remote.wechatData.* instead of an HTTP API.
 */
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { Context } from '@deepseek-ai/cordis';
import type { AccountsSnapshot, AnnualReport, AnnualSnapshot, AskResult, AutoDbKeyResult, AutoImageKeyResult, AvatarResult, BackupMutationResult, BackupPreviewSnapshot, BackupSnapshot, CalendarSnapshot, ChatHistoryResolveResult, ConfigSnapshot, ContactsSnapshot, DailySummaryResult, DbStatusSnapshot, DecryptAllResult, DecryptImagesResult, DecryptStatus, DeleteFavoriteResult, DraftClearResult, DraftsClearResult, EditMutationResult, EditedListSnapshot, EmoticonsSnapshot, ExportResult, FavoritesSnapshot, FilesSnapshot, GenerateKeysResult, GraphSnapshot, GroupInfoSnapshot, ImageDataUrlResult, KeysInfoResult, MemberSearchSnapshot, MessagesSnapshot, MomentsSnapshot, OverviewInsights, OverviewSnapshot, PaymentStatus, PrivacySnapshot, RecordsSnapshot, RevokedSnapshot, SearchBuildResult, SearchIndexStatus, SearchSnapshot, SessionsSnapshot, SimpleResult, StorageSnapshot, SummaryRecordSnapshot, SummaryTask, SummaryTaskMutationResult, SummaryTaskRunResult, SummaryTaskSnapshot, VerifyImageKeyResult, VerifyKeyResult, VideoInfoResult, VoiceInfoResult, VoiceTranscriptResult, VoiceTranscribeOneResult, VoiceTranscribeResult, WechatConfigFull, WechatConfigPatch, WhisperDownloadResult, WhisperStatus, AssetInsightsSnapshot, BackupRestoreResult, Contact360Snapshot, DbHealthSnapshot, GroupInsightsSnapshot, HandoffRemindsSnapshot, LedgerSnapshot, MediaAssetsSnapshot, MomentsInsightsSnapshot, MomentsMonthlyRow, OfficialAssetsSnapshot, OperationLogClearResult, OperationLogQuery, OperationLogSnapshot, PeriodSummaryResult, PrivacyAuditClearResult, PrivacyAuditRow, PrivacyStateSnapshot, RegionMapSnapshot, TaskMutationResult, TasksSnapshot, UnifiedSearchSnapshot } from './types.ts';
/** Remote-only service exposing WeChat data queries. */
export declare class WechatDataGateway extends TypertRemoteService {
    /** Services this gateway depends on at runtime (LLM + default model). */
    static inject: string[];
    private readonly _ctx;
    private readonly _dirs;
    private readonly _selfUsername;
    private _schedBusy;
    /** Live decrypt progress (polled by the settings panel). */
    private readonly decryptState;
    /** Active whisper model download (polled by the settings panel). */
    private whisperDownload;
    /** Active voice batch transcription (polled by the settings panel). */
    private whisperTranscribing;
    constructor(ctx: Context);
    /**
     * Append one operation-log row. Metadata only — never message bodies or
     * image/file contents — so an export stays safe to share. Best-effort: a
     * logging failure never affects the operation it records.
     */
    private op;
    /**
     * Session list (search/filter/limit).
     * @param options - Filter options: keyword fuzzy search, limit max rows.
     * @returns SessionsSnapshot: sessions list (items + total).
     */
    getSessions(options?: {
        keyword?: string;
        limit?: number;
        offset?: number;
    }): SessionsSnapshot;
    /**
     * Contact book.
     * @param options - Optional page size + offset for incremental loading.
     * @returns ContactsSnapshot: contacts list (items + total) + per-category stats.
     */
    getContacts(options?: {
        limit?: number;
        offset?: number;
    }): ContactsSnapshot;
    /**
     * One-screen data overview.
     * @returns OverviewSnapshot: aggregate counts for the overview screen.
     */
    getOverviewInsights(): OverviewInsights;
    getOverview(): OverviewSnapshot;
    /**
     * Friend-region map (世界板块地图): world → country → province → city → friends.
     * @returns RegionMapSnapshot.
     */
    getRegionMap(): RegionMapSnapshot;
    /**
     * Records (revokes/transfers/redpackets/finder/miniprograms/friendverifications).
     * @param options - Record kind to query plus pagination/filter options.
     * @returns RecordsSnapshot: record items (items + total).
     */
    getRecords(options: {
        kind: string;
        limit?: number;
        offset?: number;
        q?: string;
        from?: number;
        to?: number;
        direction?: 'asc' | 'desc';
    }): RecordsSnapshot;
    /**
     * Contact / group-member search.
     * @param options - search term, optional limit and room scope.
     * @returns MemberSearchSnapshot: matching members (items + total + source).
     */
    searchMembers(options: {
        q: string;
        limit?: number;
        roomUsername?: string;
    }): MemberSearchSnapshot;
    /**
     * Revoked messages.
     * @param options - Optional limit for the number of rows returned.
     * @returns RevokedSnapshot: revoked message items.
     */
    getRevoked(options?: {
        limit?: number;
        offset?: number;
    }): RevokedSnapshot;
    /**
     * Custom emoticons.
     * @param options - Optional limit/offset for incremental loading.
     * @returns EmoticonsSnapshot: emoticon items.
     */
    getEmoticons(options?: {
        limit?: number;
        offset?: number;
    }): EmoticonsSnapshot;
    /**
     * Storage stats.
     * @returns StorageSnapshot: per-category storage usage stats.
     */
    getStorageStats(): StorageSnapshot;
    /**
     * Annual years.
     * @returns AnnualSnapshot: available yearly overview data.
     */
    getAnnual(): AnnualSnapshot;
    /**
     * WeChat config summary.
     * @returns ConfigSnapshot: current WeChat config summary.
     */
    getWechatConfig(): ConfigSnapshot;
    /**
     * Privacy scan.
     * @returns PrivacySnapshot: privacy scan result.
     */
    getPrivacyScan(): PrivacySnapshot;
    /**
     * Relationship graph.
     * @returns GraphSnapshot: chat relationship graph data.
     */
    getGraph(): GraphSnapshot;
    /**
     * Moments page.
     * @param options - Pagination (offset/limit) and optional author filter.
     * @returns MomentsSnapshot: moments items (items + total).
     */
    getMoments(options?: {
        offset?: number;
        limit?: number;
        author?: string;
    }): MomentsSnapshot;
    /**
     * Return the current account's own WeChat username (user_name).
     * @returns { username } - used by the panel to filter "我" authored comments.
     */
    getSelfUsername(): {
        username: string;
    };
    /**
     * Full-history author activity counts (ranked desc).
     * @returns Array of { name, count } for every moments author.
     */
    getMomentsAuthors(): Array<{
        name: string;
        count: number;
    }>;
    /**
     * Favorites list.
     * @param options - Optional limit for the number of rows returned.
     * @returns FavoritesSnapshot: favorite items (items + total).
     */
    getFavorites(options?: {
        limit?: number;
        offset?: number;
    }): FavoritesSnapshot;
    /**
     * Resource files.
     * @param options - Optional limit/offset for incremental loading.
     * @returns FilesSnapshot: resource file items.
     */
    getFiles(options?: {
        limit?: number;
        offset?: number;
    }): FilesSnapshot;
    /**
     * Messages of one talker.
     * @param options - Talker username, optional limit and pagination cursor.
     * @returns MessagesSnapshot: message items for the talker.
     */
    getMessages(options: {
        talker: string;
        limit?: number;
        cursor?: number;
    }): MessagesSnapshot;
    /**
     * Incremental messages newer than a sort_seq watermark (real-time polling).
     * @param options - talker, after watermark, optional limit.
     * @returns MessagesSnapshot with only the newer messages.
     */
    getNewMessages(options: {
        talker: string;
        after: number;
        limit?: number;
    }): MessagesSnapshot;
    /**
     * Search index status.
     * @returns SearchIndexStatus: whether the FTS5 index exists and its row count.
     */
    getSearchIndexStatus(): SearchIndexStatus;
    /**
     * Build (or rebuild) the FTS5 message search index.
     * @param options - force: rebuild even when the index already exists.
     * @returns SearchBuildResult: build outcome with row counts.
     */
    buildSearchIndex(options?: {
        force?: boolean;
    }): SearchBuildResult;
    /**
     * Full-text search over text messages (index first, scan fallback).
     * @param options - query string, optional result limit and optional talker scope.
     * @returns SearchSnapshot: matched message items.
     */
    searchMessages(options: {
        query: string;
        limit?: number;
        username?: string;
    }): SearchSnapshot;
    /**
     * Group chat info (群聊信息): name/remark, announcement, own alias, member
     * grid and local settings mirror.
     * @param options - chatroom username.
     * @returns GroupInfoSnapshot: the group (null when unknown).
     */
    getGroupInfo(options: {
        username: string;
    }): GroupInfoSnapshot;
    /**
     * Resolve a nested merged chat-log pointer by server_id.
     * @param options - the record's fromnewmsgid (server_id) value.
     * @returns ChatHistoryResolveResult: found flag plus the parsed message.
     */
    /**
     * Authoritative transfer/redpacket status by message server_id.
     * @param options - the message server_id (string, may exceed 2^53).
     * @returns PaymentStatus: found flag plus authoritative fields.
     */
    getPaymentStatus(options: {
        serverId: string;
    }): PaymentStatus;
    resolveChatHistory(options: {
        serverId: string;
    }): ChatHistoryResolveResult;
    /**
     * Per-day message counts for one month (chat calendar heatmap).
     * @param options - username, year and month to aggregate.
     * @returns CalendarSnapshot: per-day message counts.
     */
    getDailyCounts(options: {
        username: string;
        year: number;
        month: number;
    }): CalendarSnapshot;
    /**
     * Look up one voice message (silk decode degrades in Node).
     * @param options - username and localId of the voice message.
     * @returns VoiceInfoResult: voice metadata / decoded file info.
     */
    getVoiceInfo(options: {
        username: string;
        localId: number;
    }): VoiceInfoResult;
    /**
     * Look up one video message (cover thumbnail + degradation).
     * @param options - username and localId of the video message.
     * @returns VideoInfoResult: video cover/thumbnail info.
     */
    getVideoInfo(options: {
        username: string;
        localId: number;
    }): VideoInfoResult;
    /**
     * Export a conversation messages to txt/csv/excel/html.
     * @param options - username, export format and optional message count.
     * @returns ExportResult: exported file path/count info.
     */
    exportSessionMessages(options: {
        username: string;
        format: string;
        count?: number;
        dir?: string;
        types?: number[];
        richTypes?: string[];
        from?: number;
        to?: number;
        filename?: string;
        zip?: boolean;
    }): ExportResult;
    /**
     * AI Q&A over WeChat data: retrieve context + DSH LLM answer with citations.
     * @param options - question to ask over the WeChat data.
     * @returns AskResult: LLM answer with citations.
     */
    askWechat(options: {
        question: string;
        username?: string;
        from?: string;
        to?: string;
        history?: Array<{
            role: 'user' | 'assistant';
            content: string;
        }>;
    }): Promise<AskResult>;
    /**
     * 提问优化：改写问题并给出改进建议。
     * @returns AskOptimizeResult: optimized + suggestions.
     */
    optimizeAskQuestion(options: {
        question: string;
        username?: string;
        from?: string;
        to?: string;
        history?: Array<{
            role: 'user' | 'assistant';
            content: string;
        }>;
    }): Promise<AskOptimizeResult>;
    /**
     * List local WeChat backups.
     * @returns BackupSnapshot: backup entries (items + total).
     */
    listBackups(): BackupSnapshot;
    /**
     * Preview a backup's contents (bounded file list) before restore.
     * @param options - backup name.
     * @returns BackupPreviewSnapshot: items + total.
     */
    previewBackup(options: {
        name: string;
    }): BackupPreviewSnapshot;
    /**
     * Create a local backup snapshot.
     * @returns BackupMutationResult: ok + backup name, or error.
     */
    createBackup(): BackupMutationResult;
    /**
     * Delete one backup by name.
     * @param options - name of the backup to delete.
     * @returns BackupMutationResult: ok, or error on failure.
     */
    deleteBackup(options: {
        name: string;
    }): BackupMutationResult;
    /**
     * Generate a daily chat summary for one date via DSH LLM.
     * @param options - date (YYYY-MM-DD) to summarize.
     * @returns DailySummaryResult: summary text with session/message counts.
     */
    generateDailySummary(options: {
        date: string;
        provider?: string;
        model?: string;
    }): Promise<DailySummaryResult>;
    /**
     * List edited messages (optionally for one session).
     * @param options - optional sessionId filter.
     * @returns EditedListSnapshot: edited message records (items + total).
     */
    listEditedMessages(options?: {
        sessionId?: string;
    }): EditedListSnapshot;
    /**
     * Edit one message content (records the original in the edit store).
     * @param options - username, localId and new content.
     * @returns EditMutationResult: ok, or error on failure.
     */
    editChatMessage(options: {
        username: string;
        localId: number;
        content: string;
    }): EditMutationResult;
    /**
     * Restore a message to its original content.
     * @param options - username and localId of the edited message.
     * @returns EditMutationResult: ok, or error on failure.
     */
    resetEditedMessage(options: {
        username: string;
        localId: number;
    }): EditMutationResult;
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
    exportAnnualReport(options: {
        year: number;
        format: string;
        dir?: string;
        filename?: string;
    }): ExportResult;
    /**
     * Export ALL sessions as a single txt ZIP archive (账号归档).
     * @param options - optional dir/filename.
     * @returns ExportResult: written zip path + total messages.
     */
    exportAllSessions(options?: {
        dir?: string;
        filename?: string;
    }): ExportResult;
    /**
     * Export moments (朋友圈) with author + keyword + time filters.
     * @param options - format/username/authorName/q/from/to/dir/filename.
     * @returns ExportResult: written file path + count.
     */
    exportMoments(options?: {
        format?: string;
        username?: string;
        authorName?: string;
        q?: string;
        images?: boolean;
        media?: string;
        month?: string;
        mine?: string;
        zip?: boolean;
        from?: number;
        to?: number;
        dir?: string;
        filename?: string;
    }): ExportResult;
    exportCsv(options: {
        kind: string;
        recordsKind?: string;
    }): ExportResult;
    /**
     * Clear one session draft (decrypted copy only).
     * @param options - username of the session to clear.
     * @returns DraftClearResult: ok, or error on failure.
     */
    clearSessionDraft(options: {
        username: string;
    }): DraftClearResult;
    /**
     * Clear all session drafts, returning the cleared list.
     * @returns DraftsClearResult: cleared session list (items + total).
     */
    clearAllSessionDrafts(): DraftsClearResult;
    /**
     * List daily-summary tasks.
     * @returns SummaryTaskSnapshot: summary tasks (items + total).
     */
    listSummaryTasks(): SummaryTaskSnapshot;
    /**
     * Save (insert/update) a daily-summary task.
     * @param options - task payload (id present = update, absent = insert).
     * @returns SummaryTaskMutationResult: ok + id, or error.
     */
    saveSummaryTask(options: {
        task: Omit<SummaryTask, 'id' | 'createdAt' | 'updatedAt'> & {
            id?: number;
        };
    }): SummaryTaskMutationResult;
    /**
     * Delete a daily-summary task.
     * @param options - id of the task to delete.
     * @returns SummaryTaskMutationResult: ok, or error on failure.
     */
    deleteSummaryTask(options: {
        id: number;
    }): SummaryTaskMutationResult;
    /**
     * Toggle a daily-summary task enabled state.
     * @param options - task id and the new enabled flag.
     * @returns SummaryTaskMutationResult: ok, or error on failure.
     */
    toggleSummaryTask(options: {
        id: number;
        enabled: boolean;
    }): SummaryTaskMutationResult;
    /**
     * List generated summary records.
     * @param options - optional taskId filter.
     * @returns SummaryRecordSnapshot: summary records (items + total).
     */
    listSummaryRecords(options?: {
        taskId?: number;
    }): SummaryRecordSnapshot;
    /**
     * Delete one generated summary record.
     * @param options - id of the record to delete.
     * @returns SummaryTaskMutationResult: ok, or error on failure.
     */
    deleteSummaryRecord(options: {
        id: number;
    }): SummaryTaskMutationResult;
    /**
     * Run a summary task: collect the group previous-day messages + LLM summary + record.
     * @param options - id of the task to run.
     * @returns SummaryTaskRunResult: ok + summary + message count, or error.
     */
    /** Run any enabled daily-summary task whose schedule time matches the current minute. */
    private maybeRunDueTasks;
    runSummaryTask(options: {
        id: number;
    }): Promise<SummaryTaskRunResult>;
    /**
     * Resolve a user avatar (head_image.db data or contact URL).
     * @param options - username to resolve the avatar for.
     * @returns AvatarResult: avatar data URL or fallback info.
     */
    getAvatar(options: {
        username: string;
        nickname?: string;
    }): AvatarResult;
    /**
     * 批量读取本地头像(head_image.db 单次打开,全部返回 data URL;绝不回退网络)。
     * @param options - usernames 列表。
     * @returns username → data URL 映射(未命中的不在其中)。
     */
    getAvatarsLocal(options: {
        usernames: string[];
    }): Record<string, string>;
    /**
     * Read the full WeChat config (incl. keys + resolved paths).
     * @returns WechatConfigFull: complete config with resolved paths.
     */
    getWechatConfigFull(): WechatConfigFull;
    /**
     * Save the WeChat config (merge patch).
     * @param options - patch of config fields to merge.
     * @returns SimpleResult: ok, or error on failure.
     */
    saveWechatConfig(options: {
        patch: WechatConfigPatch;
    }): SimpleResult;
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
    }): Promise<WhisperDownloadResult>;
    /**
     * Detect installed WeChat 4.x accounts.
     * @returns AccountsSnapshot: detected accounts (accounts + total).
     */
    detectWechatAccounts(): AccountsSnapshot;
    /**
     * Verify a database key (SQLCipher PBKDF2 + AES + HMAC).
     * @param options - dbPath and encKeyHex of the key to verify.
     * @returns VerifyKeyResult: valid flag plus optional AES/HMAC checks.
     */
    verifyDatabaseKey(options: {
        dbPath: string;
        encKeyHex: string;
    }): VerifyKeyResult;
    /**
     * Verify all DBs in db_dir and write all_keys.json.
     * @param options - dbDir, keysFile, encKeyHex and optional keyFormat.
     * @returns GenerateKeysResult: generation outcome.
     */
    generateKeysFile(options: {
        dbDir: string;
        keysFile: string;
        encKeyHex: string;
        keyFormat?: string;
    }): GenerateKeysResult;
    /**
     * Read all_keys.json info.
     * @returns KeysInfoResult: key format/count/loaded state.
     */
    getWechatKeysInfo(): KeysInfoResult;
    /**
     * Auto-recover the V4 database key from the running WeChat process
     * (key_v4 memory scan + Weixin.dll internal-key unmask).
     * @param options - optional probe db path and install dir.
     * @returns AutoDbKeyResult: ok + 64-hex key, or an error.
     */
    autoGetDbKey(options: {
        dbPath?: string;
        wechatInstallDir?: string;
    }): Promise<AutoDbKeyResult>;
    /**
     * Auto-recover the image key (V2-verified): a saved-and-valid config key
     * pair is returned first; otherwise the running WeChat process memory is
     * scanned.
     * @param options - account dir (wxid_* 文件夹或其 db_storage) and optional pid.
     * @returns AutoImageKeyResult: ok + xor/aes pair, or an error.
     */
    autoGetImageKey(options: {
        accountDir?: string;
        pid?: number;
    }): Promise<AutoImageKeyResult>;
    /**
     * Verify the saved image key pair against real V2 templates.
     * @returns VerifyImageKeyResult: verified flag + xor/template evidence.
     */
    /** Open the owned WeChat config.json (e.g. for manual edit). @returns the opened path. */
    /** Open an owned path (config/output dir/file) with the system default. @returns the opened path. */
    openPath(options: {
        path: string;
    }, signal: AbortSignal): Promise<{
        ok: boolean;
        path: string;
    }>;
    openConfig(signal: AbortSignal): Promise<{
        ok: boolean;
        path: string;
    }>;
    verifyImageKey(): VerifyImageKeyResult;
    /**
     * Full SQLCipher decryption: every .db under db_storage is re-decrypted
     * into the decrypted snapshot (逐库原子发布,单库失败不中断)。实时进度
     * 通过 getDecryptStatus 轮询读取。
     * @returns DecryptAllResult: total/ok/failed counts.
     */
    decryptAllDatabases(): Promise<DecryptAllResult>;
    /**
     * Batch-decode every md5-prefixed .dat image under msg/attach into the
     * decoded-images cache (并行池,已缓存/HEVC 跳过)。实时进度通过
     * getDecryptStatus 轮询读取。
     * @param options - optional worker concurrency (clamped 1..32).
     * @returns DecryptImagesResult: total/ok/failed/skipped counts.
     */
    decryptAllImages(options: {
        concurrency?: number;
    }): Promise<DecryptImagesResult>;
    /**
     * Live decryption progress snapshot (polled by the settings panel).
     * @returns DecryptStatus: op/done/total/failed/skipped + current item.
     */
    getDecryptStatus(): DecryptStatus;
    /**
     * Download + install the whisper.cpp CLI engine into the models dir
     * (`<modelsDir>/bin/whisper-cli.exe`), persisting the path as whisper_bin.
     * @returns WhisperDownloadResult: ok + path, or an error.
     */
    installWhisperEngine(): Promise<WhisperDownloadResult>;
    /**
     * Batch-transcribe the most recent voice messages: silk → WAV (bundled
     * wx_silk) → whisper-cli with the selected model → text cached per message.
     * @param options - optional message count (default 50, clamped 1..200).
     * @returns VoiceTranscribeResult: done/failed/skipped counts.
     */
    transcribeVoiceBatch(options: {
        limit?: number;
    }): Promise<VoiceTranscribeResult>;
    /**
     * Cached transcript for one voice message (if already transcribed).
     * @param options - message username + local_id.
     * @returns VoiceTranscriptResult: text or an error.
     */
    getVoiceTranscript(options: {
        username: string;
        localId: number;
    }): VoiceTranscriptResult;
    /**
     * Transcribe one voice message on demand (chat bubble 语音转文字).
     * @param options - message username + local_id.
     * @returns VoiceTranscribeOneResult: ok + text, or an error.
     */
    transcribeVoiceMessage(options: {
        username: string;
        localId: number;
    }): VoiceTranscribeOneResult;
    /**
     * Set CDN auto-fetch flag.
     * @param options - enabled: whether CDN auto-fetch is on.
     * @returns SimpleResult: ok, or error on failure.
     */
    setCdnImageEnabled(options: {
        enabled: boolean;
    }): SimpleResult;
    /**
     * Set CDN local/service decrypt flag.
     * @param options - localDecrypt: whether decryption runs locally.
     * @returns SimpleResult: ok, or error on failure.
     */
    setCdnImageLocalDecrypt(options: {
        localDecrypt: boolean;
    }): SimpleResult;
    /**
     * Delete favorite items by local_id.
     * @param options - ids of the favorite items to delete.
     * @returns DeleteFavoriteResult: ok + deleted count, or error.
     */
    deleteFavoriteItems(options: {
        ids: number[];
    }): DeleteFavoriteResult;
    /**
     * Compute the annual report for one year (local only).
     * @param options - year to compute the report for.
     * @returns AnnualReport: computed annual report data.
     */
    getAnnualReport(options: {
        year: number;
    }): AnnualReport;
    /**
     * Decrypted DB status summary.
     * @returns DbStatusSnapshot: per-database status summary.
     */
    getDbStatus(): DbStatusSnapshot;
    /**
     * Decode one message image to a base64 data URL.
     * @param options - username and localId of the message image.
     * @returns ImageDataUrlResult: base64 data URL or error.
     */
    getImageDataUrl(options: {
        username: string;
        localId: number;
    }): ImageDataUrlResult;
    /**
     * Resolve one SNS (朋友圈) media md5 to an offline base64 data URL
     * from the WeChat cache/<month>/Sns/Img V2-encrypted blobs.
     * @param options - media md5 from the moments XML.
     * @returns ImageDataUrlResult: base64 data URL or error.
     */
    getSnsImageDataUrl(options: {
        md5: string;
        timelineId?: string;
        mediaId?: string;
    }): ImageDataUrlResult;
    /**
     * Resolve a 公众号 article cover (og:image) to a base64 data URL.
     * @param options - mp.weixin.qq.com article URL.
     * @returns ImageDataUrlResult: base64 data URL or error.
     */
    getArticleCover(options: {
        contentUrl: string;
    }): Promise<ImageDataUrlResult>;
    /**
     * Resolve a received message file (msg/file) to a base64 data URL.
     * @param options - original file name from the message card.
     * @returns ImageDataUrlResult: data URL or error.
     */
    getMessageFile(options: {
        fileName: string;
    }): ImageDataUrlResult;
    /**
     * Add a WeChat task.
     * @param options - title + optional dueAt.
     * @returns TaskMutationResult.
     */
    addTask(options: {
        title: string;
        dueAt?: number;
    }): TaskMutationResult;
    clearOperationLog(): OperationLogClearResult;
    clearPrivacyAudit(): PrivacyAuditClearResult;
    createEncryptedBackup(options: {
        password: string;
    }): Promise<BackupMutationResult>;
    deleteTask(options: {
        id: number;
    }): TaskMutationResult;
    extractTasks(options?: {
        days?: number;
    }): TaskMutationResult;
    generatePeriodSummary(options: {
        from: string;
        to: string;
        provider?: string;
        model?: string;
    }): Promise<PeriodSummaryResult>;
    getAssetInsights(): AssetInsightsSnapshot;
    getContact360(options: {
        username: string;
    }): Contact360Snapshot;
    getDbHealth(): DbHealthSnapshot;
    getGroupInsights(options: {
        username: string;
    }): GroupInsightsSnapshot;
    getHandoffReminds(): HandoffRemindsSnapshot;
    getLedger(options?: {
        month?: string;
    }): LedgerSnapshot;
    getMediaAssets(): MediaAssetsSnapshot;
    getMomentsInsights(options?: {
        author?: string;
    }): MomentsInsightsSnapshot;
    getMomentsMonthly(options?: {
        author?: string;
        authorName?: string;
    }): MomentsMonthlyRow[];
    getOfficialAssets(): OfficialAssetsSnapshot;
    getOperationLog(options?: OperationLogQuery): OperationLogSnapshot;
    getPrivacyAuditRows(): PrivacyAuditRow[];
    getPrivacyState(): PrivacyStateSnapshot;
    getSnsVideoCoverDataUrl(options: {
        md5?: string;
        timelineId?: string;
        mediaId?: string;
    }): ImageDataUrlResult;
    /**
     * Resolve one SNS (朋友圈) video body to an offline base64 data URL so it can
     * be played inline. Returns an error when the cached container is missing.
     * @param options - media md5 from the moments XML (+ optional cache keys).
     * @returns ImageDataUrlResult: base64 data URL or error.
     */
    getSnsVideoDataUrl(options: {
        md5?: string;
        timelineId?: string;
        mediaId?: string;
    }): ImageDataUrlResult;
    listTasks(): TasksSnapshot;
    restoreBackup(options: {
        name: string;
        password: string;
    }): BackupRestoreResult;
    searchUnified(options: {
        query: string;
        limit?: number;
    }): UnifiedSearchSnapshot;
    setPrivacyState(options: {
        redactSensitive?: boolean;
        blockOutbound?: boolean;
    }): PrivacyStateSnapshot;
    setTaskStatus(options: {
        id: number;
        status: 'open' | 'done';
    }): TaskMutationResult;
    syncHandoffTasks(): TaskMutationResult;
}
export default WechatDataGateway;
//# sourceMappingURL=gateway.d.ts.map