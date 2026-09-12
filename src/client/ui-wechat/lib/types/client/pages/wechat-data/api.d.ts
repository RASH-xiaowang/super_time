/**
 * WeChat data access layer — backed by the DSH WechatDataGateway Remote
 * (node:sqlite over the owned local decrypted DBs). All panels read through
 * ctx.remote.wechatData.*; there is no HTTP dependency.
 *
 * Panels also use the stale-while-revalidate render cache below: the first
 * successful render is persisted, the next open renders it synchronously
 * (instant paint), and fresh data replaces it in the background.
 */
/** Subscribe to cache writes for one key (drives re-render after a background refresh). */
export declare function subscribeSnapshot(key: string, fn: () => void): () => void;
/** Invalidate the whole snapshot cache (realtime update / manual refresh). */
export declare function invalidateSnapshotCache(): void;
/** Read the last successfully rendered snapshot for a panel (sync, instant paint). */
export declare function readRenderCache<T>(key: string, ..._rest: T[]): T | null;
/** Save a snapshot after a successful render (quota-safe: drops silently when full). */
export declare function writeRenderCache(key: string, data: unknown): void;
import type { AccountsSnapshot, AnnualReport, AnnualSnapshot, AssetInsightsSnapshot, AutoDbKeyResult, AutoImageKeyResult, AskResult, AvatarResult, BackupMutationResult, BackupRestoreResult, BackupPreviewSnapshot, BackupSnapshot, CalendarSnapshot, ChatHistoryResolveResult, ConfigSnapshot, Contact360Snapshot, ContactsSnapshot, DailySummaryResult, DbHealthSnapshot, DbStatusSnapshot, DecryptAllResult, DecryptImagesResult, DecryptStatus, DeleteFavoriteResult, DraftClearResult, DraftsClearResult, EditMutationResult, EditedListSnapshot, EmoticonsSnapshot, ExportResult, FavoritesSnapshot, FilesSnapshot, GenerateKeysResult, GraphSnapshot, GroupInfoSnapshot, GroupInsightsSnapshot, HandoffRemindsSnapshot, ImageDataUrlResult, KeysInfoResult, LedgerSnapshot, MediaAssetsSnapshot, MemberSearchSnapshot, MessagesSnapshot, MomentsInsightsSnapshot, MomentsMonthlyRow, MomentsSnapshot, OfficialAssetsSnapshot, OverviewInsights, OverviewSnapshot, RegionMapSnapshot, OperationLogClearResult, OperationLogQuery, OperationLogSnapshot, PaymentStatus, PeriodSummaryResult, PrivacyAuditClearResult, PrivacyAuditRow, PrivacySnapshot, PrivacyStateSnapshot, RecordsSnapshot, RevokedSnapshot, SearchBuildResult, SearchIndexStatus, SearchSnapshot, SessionsSnapshot, SimpleResult, StorageSnapshot, SummaryRecordSnapshot, SummaryTask, SummaryTaskMutationResult, SummaryTaskRunResult, SummaryTaskSnapshot, TaskMutationResult, TasksSnapshot, UnifiedSearchSnapshot, VerifyImageKeyResult, VerifyKeyResult, VideoInfoResult, VoiceInfoResult, VoiceTranscriptResult, VoiceTranscribeOneResult, VoiceTranscribeResult, WechatConfigFull, WechatConfigPatch, WhisperDownloadResult, WhisperStatus } from '@deepseek-ai/dsh-wechat-data/types';
/** Remote face injected by ui-pages apply (ctx.remote.wechatData). */
export interface WechatRemote {
    getSessions(options?: {
        keyword?: string;
        limit?: number;
        offset?: number;
    }): Promise<RemoteResult<SessionsSnapshot>>;
    getContacts(options?: {
        limit?: number;
        offset?: number;
    }): Promise<RemoteResult<ContactsSnapshot>>;
    getContact360(options: {
        username: string;
    }): Promise<RemoteResult<Contact360Snapshot>>;
    getMessages(options: {
        talker: string;
        limit?: number;
        cursor?: number;
    }): Promise<RemoteResult<MessagesSnapshot>>;
    getNewMessages(options: {
        talker: string;
        after: number;
        limit?: number;
    }): Promise<RemoteResult<MessagesSnapshot>>;
    getMoments(options?: {
        offset?: number;
        limit?: number;
        author?: string;
    }): Promise<RemoteResult<MomentsSnapshot>>;
    getSelfUsername(): Promise<RemoteResult<{
        username: string;
    }>>;
    getMomentsAuthors(): Promise<RemoteResult<Array<{
        name: string;
        count: number;
    }>>>;
    getMomentsInsights(options?: {
        author?: string;
    }): Promise<RemoteResult<MomentsInsightsSnapshot>>;
    getMomentsMonthly(options?: {
        author?: string;
        authorName?: string;
    }): Promise<RemoteResult<MomentsMonthlyRow[]>>;
    getFavorites(options?: {
        limit?: number;
        offset?: number;
    }): Promise<RemoteResult<FavoritesSnapshot>>;
    getAssetInsights(): Promise<RemoteResult<AssetInsightsSnapshot>>;
    getOfficialAssets(): Promise<RemoteResult<OfficialAssetsSnapshot>>;
    getMediaAssets(): Promise<RemoteResult<MediaAssetsSnapshot>>;
    getFiles(options?: {
        limit?: number;
        offset?: number;
    }): Promise<RemoteResult<FilesSnapshot>>;
    getOverview(): Promise<RemoteResult<OverviewSnapshot>>;
    getOverviewInsights(): Promise<RemoteResult<OverviewInsights>>;
    getRegionMap(): Promise<RemoteResult<RegionMapSnapshot>>;
    getRecords(options: {
        kind: string;
        limit?: number;
        offset?: number;
        q?: string;
        from?: number;
        to?: number;
        direction?: 'asc' | 'desc';
    }): Promise<RemoteResult<RecordsSnapshot>>;
    getLedger(options?: {
        month?: string;
    }): Promise<RemoteResult<LedgerSnapshot>>;
    getRevoked(options?: {
        limit?: number;
        offset?: number;
    }): Promise<RemoteResult<RevokedSnapshot>>;
    getEmoticons(options?: {
        limit?: number;
        offset?: number;
    }): Promise<RemoteResult<EmoticonsSnapshot>>;
    getStorageStats(): Promise<RemoteResult<StorageSnapshot>>;
    getAnnual(): Promise<RemoteResult<AnnualSnapshot>>;
    getWechatConfig(): Promise<RemoteResult<ConfigSnapshot>>;
    getPrivacyScan(): Promise<RemoteResult<PrivacySnapshot>>;
    getPrivacyState(): Promise<RemoteResult<PrivacyStateSnapshot>>;
    setPrivacyState(options: {
        redactSensitive?: boolean;
        blockOutbound?: boolean;
    }): Promise<RemoteResult<PrivacyStateSnapshot>>;
    getPrivacyAuditRows(): Promise<RemoteResult<PrivacyAuditRow[]>>;
    clearPrivacyAudit(): Promise<RemoteResult<PrivacyAuditClearResult>>;
    getOperationLog(options?: OperationLogQuery): Promise<RemoteResult<OperationLogSnapshot>>;
    clearOperationLog(): Promise<RemoteResult<OperationLogClearResult>>;
    getGraph(): Promise<RemoteResult<GraphSnapshot>>;
    getSearchIndexStatus(): Promise<RemoteResult<SearchIndexStatus>>;
    buildSearchIndex(options?: {
        force?: boolean;
    }): Promise<RemoteResult<SearchBuildResult>>;
    searchMessages(options: {
        query: string;
        limit?: number;
        username?: string;
    }): Promise<RemoteResult<SearchSnapshot>>;
    searchUnified(options: {
        query: string;
        limit?: number;
    }): Promise<RemoteResult<UnifiedSearchSnapshot>>;
    askWechat(options: {
        question: string;
        username?: string;
        from?: string;
        to?: string;
    }): Promise<RemoteResult<AskResult>>;
    getGroupInfo(options: {
        username: string;
    }): Promise<RemoteResult<GroupInfoSnapshot>>;
    getGroupInsights(options: {
        username: string;
    }): Promise<RemoteResult<GroupInsightsSnapshot>>;
    searchMembers(options: {
        q: string;
        limit?: number;
        roomUsername?: string;
    }): Promise<RemoteResult<MemberSearchSnapshot>>;
    resolveChatHistory(options: {
        serverId: string;
    }): Promise<RemoteResult<ChatHistoryResolveResult>>;
    getPaymentStatus(options: {
        serverId: string;
    }): Promise<RemoteResult<PaymentStatus>>;
    getDailyCounts(options: {
        username: string;
        year: number;
        month: number;
    }): Promise<RemoteResult<CalendarSnapshot>>;
    getImageDataUrl(options: {
        username: string;
        localId: number;
    }): Promise<RemoteResult<ImageDataUrlResult>>;
    getSnsImageDataUrl(options: {
        md5: string;
        timelineId?: string;
        mediaId?: string;
    }): Promise<RemoteResult<ImageDataUrlResult>>;
    getSnsVideoCoverDataUrl(options: {
        md5?: string;
        timelineId?: string;
        mediaId?: string;
    }): Promise<RemoteResult<ImageDataUrlResult>>;
    getSnsVideoDataUrl(options: {
        md5?: string;
        timelineId?: string;
        mediaId?: string;
    }): Promise<RemoteResult<ImageDataUrlResult>>;
    getArticleCover(options: {
        contentUrl: string;
    }): Promise<RemoteResult<ImageDataUrlResult>>;
    getMessageFile(options: {
        fileName: string;
    }): Promise<RemoteResult<ImageDataUrlResult>>;
    getDbStatus(): Promise<RemoteResult<DbStatusSnapshot>>;
    getDbHealth(): Promise<RemoteResult<DbHealthSnapshot>>;
    getVoiceInfo(options: {
        username: string;
        localId: number;
    }): Promise<RemoteResult<VoiceInfoResult>>;
    getVideoInfo(options: {
        username: string;
        localId: number;
    }): Promise<RemoteResult<VideoInfoResult>>;
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
    }): Promise<RemoteResult<ExportResult>>;
    listBackups(): Promise<RemoteResult<BackupSnapshot>>;
    previewBackup(options: {
        name: string;
    }): Promise<RemoteResult<BackupPreviewSnapshot>>;
    createBackup(): Promise<RemoteResult<BackupMutationResult>>;
    createEncryptedBackup(options: {
        password: string;
    }): Promise<RemoteResult<BackupMutationResult>>;
    restoreBackup(options: {
        name: string;
        password: string;
    }): Promise<RemoteResult<BackupRestoreResult>>;
    deleteBackup(options: {
        name: string;
    }): Promise<RemoteResult<BackupMutationResult>>;
    generateDailySummary(options: {
        date: string;
        provider?: string;
        model?: string;
    }): Promise<RemoteResult<DailySummaryResult>>;
    generatePeriodSummary(options: {
        from: string;
        to: string;
        provider?: string;
        model?: string;
    }): Promise<RemoteResult<PeriodSummaryResult>>;
    listLlmProviders(): Promise<RemoteResult<{
        providers: Array<{
            id: string;
            name: string;
        }>;
    }>>;
    listLlmModels(options: {
        provider: string;
    }): Promise<RemoteResult<{
        models: Array<{
            id: string;
            name: string;
        }>;
    }>>;
    listEditedMessages(options?: {
        sessionId?: string;
    }): Promise<RemoteResult<EditedListSnapshot>>;
    editChatMessage(options: {
        username: string;
        localId: number;
        content: string;
    }): Promise<RemoteResult<EditMutationResult>>;
    resetEditedMessage(options: {
        username: string;
        localId: number;
    }): Promise<RemoteResult<EditMutationResult>>;
    exportCsv(options: {
        kind: string;
        recordsKind?: string;
    }): Promise<RemoteResult<ExportResult>>;
    exportAnnualReport(options: {
        year: number;
        format: string;
        dir?: string;
        filename?: string;
    }): Promise<RemoteResult<ExportResult>>;
    exportAllSessions(options?: {
        dir?: string;
        filename?: string;
    }): Promise<RemoteResult<ExportResult>>;
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
    }): Promise<RemoteResult<ExportResult>>;
    clearSessionDraft(options: {
        username: string;
    }): Promise<RemoteResult<DraftClearResult>>;
    clearAllSessionDrafts(): Promise<RemoteResult<DraftsClearResult>>;
    listSummaryTasks(): Promise<RemoteResult<SummaryTaskSnapshot>>;
    saveSummaryTask(options: {
        task: Omit<SummaryTask, 'id' | 'createdAt' | 'updatedAt'> & {
            id?: number;
        };
    }): Promise<RemoteResult<SummaryTaskMutationResult>>;
    deleteSummaryTask(options: {
        id: number;
    }): Promise<RemoteResult<SummaryTaskMutationResult>>;
    toggleSummaryTask(options: {
        id: number;
        enabled: boolean;
    }): Promise<RemoteResult<SummaryTaskMutationResult>>;
    runSummaryTask(options: {
        id: number;
    }): Promise<RemoteResult<SummaryTaskRunResult>>;
    listSummaryRecords(options?: {
        taskId?: number;
    }): Promise<RemoteResult<SummaryRecordSnapshot>>;
    deleteSummaryRecord(options: {
        id: number;
    }): Promise<RemoteResult<SummaryTaskMutationResult>>;
    listTasks(): Promise<RemoteResult<TasksSnapshot>>;
    getHandoffReminds(): Promise<RemoteResult<HandoffRemindsSnapshot>>;
    syncHandoffTasks(): Promise<RemoteResult<TaskMutationResult>>;
    addTask(options: {
        title: string;
        dueAt?: number;
    }): Promise<RemoteResult<TaskMutationResult>>;
    setTaskStatus(options: {
        id: number;
        status: 'open' | 'done';
    }): Promise<RemoteResult<TaskMutationResult>>;
    deleteTask(options: {
        id: number;
    }): Promise<RemoteResult<TaskMutationResult>>;
    extractTasks(options?: {
        days?: number;
    }): Promise<RemoteResult<TaskMutationResult>>;
    getAvatar(options: {
        username: string;
        nickname?: string;
    }): Promise<RemoteResult<AvatarResult>>;
    getAvatarsLocal(options: {
        usernames: string[];
    }): Promise<RemoteResult<Record<string, string>>>;
    getWechatConfigFull(): Promise<RemoteResult<WechatConfigFull>>;
    openConfig(signal?: AbortSignal): Promise<RemoteResult<{
        ok: boolean;
        path: string;
    }>>;
    openPath(options: {
        path: string;
    }, signal?: AbortSignal): Promise<RemoteResult<{
        ok: boolean;
        path: string;
    }>>;
    saveWechatConfig(options: {
        patch: WechatConfigPatch;
    }): Promise<RemoteResult<SimpleResult>>;
    detectWechatAccounts(): Promise<RemoteResult<AccountsSnapshot>>;
    autoGetDbKey(options: {
        dbPath?: string;
        wechatInstallDir?: string;
    }): Promise<RemoteResult<AutoDbKeyResult>>;
    autoGetImageKey(options: {
        accountDir?: string;
        pid?: number;
    }): Promise<RemoteResult<AutoImageKeyResult>>;
    verifyDatabaseKey(options: {
        dbPath: string;
        encKeyHex: string;
    }): Promise<RemoteResult<VerifyKeyResult>>;
    generateKeysFile(options: {
        dbDir: string;
        keysFile: string;
        encKeyHex: string;
        keyFormat?: string;
    }): Promise<RemoteResult<GenerateKeysResult>>;
    getWechatKeysInfo(): Promise<RemoteResult<KeysInfoResult>>;
    verifyImageKey(): Promise<RemoteResult<VerifyImageKeyResult>>;
    decryptAllDatabases(): Promise<RemoteResult<DecryptAllResult>>;
    decryptAllImages(options?: {
        concurrency?: number;
    }): Promise<RemoteResult<DecryptImagesResult>>;
    getDecryptStatus(): Promise<RemoteResult<DecryptStatus>>;
    getWhisperStatus(): Promise<RemoteResult<WhisperStatus>>;
    downloadWhisperModel(options: {
        model: string;
    }): Promise<RemoteResult<WhisperDownloadResult>>;
    installWhisperEngine(): Promise<RemoteResult<WhisperDownloadResult>>;
    transcribeVoiceBatch(options?: {
        limit?: number;
    }): Promise<RemoteResult<VoiceTranscribeResult>>;
    getVoiceTranscript(options: {
        username: string;
        localId: number;
    }): Promise<RemoteResult<VoiceTranscriptResult>>;
    transcribeVoiceMessage(options: {
        username: string;
        localId: number;
    }): Promise<RemoteResult<VoiceTranscribeOneResult>>;
    setCdnImageEnabled(options: {
        enabled: boolean;
    }): Promise<RemoteResult<SimpleResult>>;
    setCdnImageLocalDecrypt(options: {
        localDecrypt: boolean;
    }): Promise<RemoteResult<SimpleResult>>;
    deleteFavoriteItems(options: {
        ids: number[];
    }): Promise<RemoteResult<DeleteFavoriteResult>>;
    getAnnualReport(options: {
        year: number;
    }): Promise<RemoteResult<AnnualReport>>;
}
/** Remote envelope (mirror of dsh-typert-protocol RemoteResult). */
export interface RemoteResult<T> {
    ok: boolean;
    value?: T;
    error?: {
        code: string;
        message: string;
    };
}
/**
 * Install the Remote client (called from ui-pages apply).
 * @param remote - The Remote client to install.
 */
export declare function setWechatRemote(remote: WechatRemote | (() => WechatRemote)): void;
/** Install the host directory chooser (ui-pages apply injects ctx.workspaces). */
export declare function setDirectoryPicker(pick: () => Promise<string | null>): void;
/** Open the native directory chooser; returns the picked path or null on cancel. */
export declare function pickDirectory(): Promise<string | null>;
/** Remove cache entries whose key starts with the given prefix (both layers). */
export declare function invalidateWechatCache(prefix: string): void;
/** Read one cached decrypted media data URL by key, or null. */
export declare function snsMediaCacheGet(key: string): Promise<string | null>;
/** Batch-read cached media data URLs for the given keys. */
export declare function snsMediaCacheGetMany(keys: readonly string[]): Promise<Record<string, string>>;
/** Persist one decrypted media data URL. */
export declare function snsMediaCacheSet(key: string, url: string): Promise<void>;
/**
 * Fetch the session list (optional keyword filter + limit).
 * @param options - Query options: keyword fuzzy search, limit max rows.
 * @returns SessionsSnapshot with items + total.
 */
export declare function apiGetSessions(options?: {
    keyword?: string;
    limit?: number;
    offset?: number;
}): Promise<SessionsSnapshot>;
/**
 * Fetch the contact list (optional page size + offset).
 * @param options - Query options: limit page size, offset page start.
 * @returns ContactsSnapshot.
 */
export declare function apiGetContacts(options?: {
    limit?: number;
    offset?: number;
}): Promise<ContactsSnapshot>;
/**
 * Fetch the contact 360° profile snapshot.
 * @param username - target username.
 * @returns Contact360Snapshot.
 */
export declare function apiGetContact360(username: string): Promise<Contact360Snapshot>;
/**
 * Fetch messages for a talker.
 * @param options - Query options: talker username, limit, cursor for paging.
 * @returns MessagesSnapshot.
 */
export declare function apiGetMessages(options: {
    talker: string;
    limit?: number;
    cursor?: number;
}): Promise<MessagesSnapshot>;
/**
 * Fetch messages newer than a sort_seq watermark (real-time polling).
 * @param options - Query options: talker, after watermark, optional limit.
 * @returns MessagesSnapshot with the newer messages only.
 */
export declare function apiGetNewMessages(options: {
    talker: string;
    after: number;
    limit?: number;
}): Promise<MessagesSnapshot>;
/**
 * Fetch the moments feed (paging + author filter).
 * @param options - Query options: offset, limit, author filter.
 * @returns MomentsSnapshot.
 */
export declare function apiGetMoments(options?: {
    offset?: number;
    limit?: number;
    author?: string;
}): Promise<MomentsSnapshot>;
/** Fetch the current account's own WeChat username (for filtering "我" authored comments). */
export declare function apiGetSelfUsername(): Promise<string>;
/** Fetch full-history author activity counts (ranked descending). */
export declare function apiGetMomentsAuthors(): Promise<Array<{
    name: string;
    count: number;
}>>;
/**
 * Fetch moments insights for an author (default: self).
 * @param options - optional author username.
 * @returns MomentsInsightsSnapshot.
 */
export declare function apiGetMomentsInsights(options?: {
    author?: string;
}): Promise<MomentsInsightsSnapshot>;
/**
 * Fetch the full monthly distribution of moments (all authors, or one author).
 * Not paginated, so it reflects every month.
 * @param options - optional author username (`author`) or author display-name
 *   (`authorName`) filter (all when omitted).
 * @returns monthly rows sorted ascending by month.
 */
export declare function apiGetMomentsMonthly(options?: {
    author?: string;
    authorName?: string;
}): Promise<MomentsMonthlyRow[]>;
/**
 * Fetch the favorites list.
 * @param options - Query options: limit.
 * @returns FavoritesSnapshot.
 */
export declare function apiGetFavorites(options?: {
    limit?: number;
    offset?: number;
}): Promise<FavoritesSnapshot>;
/**
 * Fetch favorites + emoticon asset insights.
 * @returns AssetInsightsSnapshot.
 */
export declare function apiGetAssetInsights(): Promise<AssetInsightsSnapshot>;
/**
 * Fetch official account content assets.
 * @returns OfficialAssetsSnapshot.
 */
export declare function apiGetOfficialAssets(): Promise<OfficialAssetsSnapshot>;
/**
 * Fetch media assets inventory.
 * @returns MediaAssetsSnapshot.
 */
export declare function apiGetMediaAssets(): Promise<MediaAssetsSnapshot>;
/**
 * Fetch the files list.
 * @param options - Query options: limit.
 * @returns FilesSnapshot.
 */
export declare function apiGetFiles(options?: {
    limit?: number;
    offset?: number;
}): Promise<FilesSnapshot>;
/**
 * Fetch the overall statistics overview.
 * @returns OverviewSnapshot.
 */
export declare function apiGetOverviewInsights(): Promise<OverviewInsights>;
export declare function apiGetOverview(): Promise<OverviewSnapshot>;
/**
 * Fetch the friend-region map (世界 → 国家 → 省 → 市 → 好友).
 * @returns RegionMapSnapshot.
 */
export declare function apiGetRegionMap(): Promise<RegionMapSnapshot>;
/**
 * Fetch records with kind filter + paging + free-text query.
 * @param options - Query options: kind, limit, offset, q.
 * @returns RecordsSnapshot.
 */
export declare function apiGetRecords(options: {
    kind: string;
    limit?: number;
    offset?: number;
    q?: string;
    from?: number;
    to?: number;
    direction?: 'asc' | 'desc';
}): Promise<RecordsSnapshot>;
/**
 * Fetch the funds ledger snapshot (transfer/red-packet aggregates).
 * @param options - Optional month filter (YYYY-MM).
 * @returns LedgerSnapshot.
 */
export declare function apiGetLedger(options?: {
    month?: string;
}): Promise<LedgerSnapshot>;
/**
 * Fetch revoked messages.
 * @param options - Query options: limit.
 * @returns RevokedSnapshot.
 */
export declare function apiGetRevoked(options?: {
    limit?: number;
    offset?: number;
}): Promise<RevokedSnapshot>;
/**
 * Fetch the emoticons list.
 * @param options - Query options: limit/offset.
 * @returns EmoticonsSnapshot.
 */
export declare function apiGetEmoticons(options?: {
    limit?: number;
    offset?: number;
}): Promise<EmoticonsSnapshot>;
/**
 * Fetch storage usage statistics.
 * @returns StorageSnapshot.
 */
export declare function apiGetStorageStats(): Promise<StorageSnapshot>;
/**
 * Fetch annual statistics.
 * @returns AnnualSnapshot.
 */
export declare function apiGetAnnual(): Promise<AnnualSnapshot>;
/**
 * Fetch the current WeChat config snapshot.
 * @returns ConfigSnapshot.
 */
export declare function apiGetWechatConfig(): Promise<ConfigSnapshot>;
/**
 * Fetch the privacy scan result.
 * @returns PrivacySnapshot.
 */
export declare function apiGetPrivacyScan(): Promise<PrivacySnapshot>;
/**
 * Fetch privacy settings + audit snapshot.
 * @returns PrivacyStateSnapshot.
 */
export declare function apiGetPrivacyState(): Promise<PrivacyStateSnapshot>;
/**
 * Update privacy settings.
 * @param options - partial settings patch.
 * @returns the updated privacy state snapshot.
 */
export declare function apiSetPrivacyState(options: {
    redactSensitive?: boolean;
    blockOutbound?: boolean;
}): Promise<PrivacyStateSnapshot>;
/**
 * Fetch recent raw privacy audit rows.
 * @returns recent audit rows.
 */
export declare function apiGetPrivacyAuditRows(): Promise<PrivacyAuditRow[]>;
/**
 * Clear the privacy audit log.
 * @returns clear result with removed row count.
 */
export declare function apiClearPrivacyAudit(): Promise<PrivacyAuditClearResult>;
/**
 * List recent operation-log rows (newest first) with optional filters.
 * @param options - time range / categories / status / limit filters.
 * @returns matching operation-log entries + total count.
 */
export declare function apiGetOperationLog(options?: OperationLogQuery): Promise<OperationLogSnapshot>;
/**
 * Clear the operation log (a sensitive action, itself recorded first).
 * @returns clear result with removed row count.
 */
export declare function apiClearOperationLog(): Promise<OperationLogClearResult>;
/**
 * Fetch the relationship graph snapshot.
 * @returns GraphSnapshot.
 */
export declare function apiGetGraph(): Promise<GraphSnapshot>;
/**
 * Fetch search index build status.
 * @returns SearchIndexStatus.
 */
export declare function apiGetSearchIndexStatus(): Promise<SearchIndexStatus>;
/**
 * Trigger a search index build (optionally forced).
 * @param options - Query options: force rebuild even when up to date.
 * @returns SearchBuildResult.
 */
export declare function apiBuildSearchIndex(options?: {
    force?: boolean;
}): Promise<SearchBuildResult>;
/**
 * Search messages by query text.
 * @param options - Query options: query text and limit.
 * @returns SearchSnapshot.
 */
export declare function apiSearchMessages(options: {
    query: string;
    limit?: number;
    username?: string;
}): Promise<SearchSnapshot>;
/**
 * Run the unified local search across several data domains.
 * @param options - Query options: query text, optional per-domain limit.
 * @returns UnifiedSearchSnapshot.
 */
export declare function apiSearchUnified(options: {
    query: string;
    limit?: number;
}): Promise<UnifiedSearchSnapshot>;
/**
 * Ask a question over the local WeChat data (retrieval + LLM answer).
 * @param options - Question plus optional talker/date scope.
 * @returns AskResult: answer and source citations.
 */
export declare function apiAskWechat(options: {
    question: string;
    username?: string;
    from?: string;
    to?: string;
}): Promise<AskResult>;
/** Group chat info (群聊信息) for the open chatroom. */
export declare function apiSearchMembers(options: {
    q: string;
    limit?: number;
    roomUsername?: string;
}): Promise<MemberSearchSnapshot>;
export declare function apiGetGroupInfo(username: string): Promise<GroupInfoSnapshot>;
/**
 * Fetch offline group insights for one chatroom.
 * @param username - chatroom username.
 * @returns GroupInsightsSnapshot.
 */
export declare function apiGetGroupInsights(username: string): Promise<GroupInsightsSnapshot>;
/** Resolve a nested merged chat-log pointer by its server_id. */
export declare function apiResolveChatHistory(serverId: string): Promise<ChatHistoryResolveResult>;
/** Authoritative transfer/redpacket status by message server_id. */
export declare function apiGetPaymentStatus(serverId: string): Promise<PaymentStatus>;
/**
 * Fetch per-day message counts for a month.
 * @param options - Query options: username, year, month.
 * @returns CalendarSnapshot.
 */
export declare function apiGetDailyCounts(options: {
    username: string;
    year: number;
    month: number;
}): Promise<CalendarSnapshot>;
/**
 * Resolve an image message to a data URL.
 * @param options - Query options: username and message localId.
 * @returns ImageDataUrlResult.
 */
export declare function apiGetSnsImageDataUrl(options: {
    md5: string;
    timelineId?: string;
    mediaId?: string;
}): Promise<ImageDataUrlResult>;
/**
 * Resolve a moments video cover to a data URL (offline Sns/Video jpg).
 * @param options - media md5 / timeline id / media id.
 * @returns ImageDataUrlResult.
 */
export declare function apiGetSnsVideoCoverDataUrl(options: {
    md5?: string;
    timelineId?: string;
    mediaId?: string;
}): Promise<ImageDataUrlResult>;
/**
 * Resolve a moments video body to an offline data URL for inline playback.
 * @param options - media md5 / timeline id / media id.
 * @returns ImageDataUrlResult.
 */
export declare function apiGetSnsVideoDataUrl(options: {
    md5?: string;
    timelineId?: string;
    mediaId?: string;
}): Promise<ImageDataUrlResult>;
/**
 * Resolve a 公众号 article cover (og:image) to a data URL.
 * @param options - mp.weixin.qq.com article URL.
 * @returns ImageDataUrlResult.
 */
export declare function apiGetArticleCover(options: {
    contentUrl: string;
}): Promise<ImageDataUrlResult>;
/**
 * Resolve a received message file (msg/file) to a data URL.
 * @param options - original file name.
 * @returns ImageDataUrlResult.
 */
export declare function apiGetMessageFile(options: {
    fileName: string;
}): Promise<ImageDataUrlResult>;
export declare function apiGetImageDataUrl(options: {
    username: string;
    localId: number;
}): Promise<ImageDataUrlResult>;
/**
 * Fetch decrypted database status.
 * @returns DbStatusSnapshot.
 */
export declare function apiGetDbStatus(): Promise<DbStatusSnapshot>;
/**
 * Fetch the data-health snapshot.
 * @returns DbHealthSnapshot.
 */
export declare function apiGetDbHealth(): Promise<DbHealthSnapshot>;
/**
 * Fetch voice message info.
 * @param options - Query options: username and message localId.
 * @returns VoiceInfoResult.
 */
export declare function apiGetVoiceInfo(options: {
    username: string;
    localId: number;
}): Promise<VoiceInfoResult>;
/**
 * Fetch video message info.
 * @param options - Query options: username and message localId.
 * @returns VideoInfoResult.
 */
export declare function apiGetVideoInfo(options: {
    username: string;
    localId: number;
}): Promise<VideoInfoResult>;
/**
 * Export a session’s messages in the given format.
 * @param options - Query options: username, format, optional count.
 * @returns ExportResult.
 */
export declare function apiExportSessionMessages(options: {
    username: string;
    format: string;
    count?: number;
}): Promise<ExportResult>;
/**
 * List decrypted-data backups.
 * @returns BackupSnapshot.
 */
export declare function apiListBackups(): Promise<BackupSnapshot>;
/**
 * Preview a backup's contents before restore.
 * @param options - backup name.
 * @returns BackupPreviewSnapshot.
 */
export declare function apiPreviewBackup(options: {
    name: string;
}): Promise<BackupPreviewSnapshot>;
/**
 * Create a new backup.
 * @returns BackupMutationResult.
 */
export declare function apiCreateBackup(): Promise<BackupMutationResult>;
/**
 * Create an encrypted `.wcb` backup bundle.
 * @param options - encryption password.
 * @returns BackupMutationResult.
 */
export declare function apiCreateEncryptedBackup(options: {
    password: string;
}): Promise<BackupMutationResult>;
/**
 * Restore an encrypted backup into a plain directory.
 * @param options - backup name and password.
 * @returns BackupRestoreResult.
 */
export declare function apiRestoreBackup(options: {
    name: string;
    password: string;
}): Promise<BackupRestoreResult>;
/**
 * Delete a backup by name.
 * @param options - Query options: backup name.
 * @returns BackupMutationResult.
 */
export declare function apiDeleteBackup(options: {
    name: string;
}): Promise<BackupMutationResult>;
/**
 * Generate a daily summary for the given date.
 * @param options - Query options: the date (YYYY-MM-DD).
 * @returns DailySummaryResult.
 */
export declare function apiGenerateDailySummary(options: {
    date: string;
    provider?: string;
    model?: string;
}): Promise<DailySummaryResult>;
/**
 * Generate a period (weekly/monthly/custom) chat summary via DSH LLM.
 * @param options - inclusive date range plus optional model override.
 * @returns PeriodSummaryResult.
 */
export declare function apiGeneratePeriodSummary(options: {
    from: string;
    to: string;
    provider?: string;
    model?: string;
}): Promise<PeriodSummaryResult>;
/** List available LLM providers for the daily-summary model selector. */
export declare function apiListLlmProviders(): Promise<{
    providers: Array<{
        id: string;
        name: string;
    }>;
}>;
/** List models for one LLM provider. */
export declare function apiListLlmModels(options: {
    provider: string;
}): Promise<{
    models: Array<{
        id: string;
        name: string;
    }>;
}>;
/**
 * List edited-message records (optionally filtered by session).
 * @param options - Query options: optional sessionId filter.
 * @returns EditedListSnapshot.
 */
export declare function apiListEditedMessages(options?: {
    sessionId?: string;
}): Promise<EditedListSnapshot>;
/**
 * Apply an edit to a chat message.
 * @param options - Mutation options: username, message localId, new content.
 * @returns EditMutationResult.
 */
export declare function apiEditChatMessage(options: {
    username: string;
    localId: number;
    content: string;
}): Promise<EditMutationResult>;
/**
 * Reset an edited chat message back to its original content.
 * @param options - Mutation options: username and message localId.
 * @returns EditMutationResult.
 */
export declare function apiResetEditedMessage(options: {
    username: string;
    localId: number;
}): Promise<EditMutationResult>;
/**
 * Export a record kind to CSV.
 * @param options - Query options: record kind, optional recordsKind.
 * @returns ExportResult.
 */
export declare function apiExportAnnualReport(options: {
    year: number;
    format: string;
    dir?: string;
    filename?: string;
}): Promise<ExportResult>;
export declare function apiExportAllSessions(options?: {
    dir?: string;
    filename?: string;
}): Promise<ExportResult>;
export declare function apiExportMoments(options?: {
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
}): Promise<ExportResult>;
export declare function apiExportCsv(options: {
    kind: string;
    recordsKind?: string;
}): Promise<ExportResult>;
/**
 * Clear a session’s draft.
 * @param options - Mutation options: session username.
 * @returns DraftClearResult.
 */
export declare function apiClearSessionDraft(options: {
    username: string;
}): Promise<DraftClearResult>;
/**
 * Clear all session drafts.
 * @returns DraftsClearResult.
 */
export declare function apiClearAllSessionDrafts(): Promise<DraftsClearResult>;
/**
 * List summary tasks.
 * @returns SummaryTaskSnapshot.
 */
export declare function apiListSummaryTasks(): Promise<SummaryTaskSnapshot>;
/**
 * Create or update a summary task.
 * @param options - Mutation options: the task payload (with optional id for updates).
 * @returns SummaryTaskMutationResult.
 */
export declare function apiSaveSummaryTask(options: {
    task: Omit<SummaryTask, 'id' | 'createdAt' | 'updatedAt'> & {
        id?: number;
    };
}): Promise<SummaryTaskMutationResult>;
/**
 * Delete a summary task by id.
 * @param options - Mutation options: task id.
 * @returns SummaryTaskMutationResult.
 */
export declare function apiDeleteSummaryTask(options: {
    id: number;
}): Promise<SummaryTaskMutationResult>;
/**
 * Enable or disable a summary task.
 * @param options - Mutation options: task id and enabled flag.
 * @returns SummaryTaskMutationResult.
 */
export declare function apiToggleSummaryTask(options: {
    id: number;
    enabled: boolean;
}): Promise<SummaryTaskMutationResult>;
/**
 * Run a summary task now.
 * @param options - Mutation options: task id.
 * @returns SummaryTaskRunResult.
 */
export declare function apiRunSummaryTask(options: {
    id: number;
}): Promise<SummaryTaskRunResult>;
/**
 * List summary records (optionally filtered by task).
 * @param options - Query options: optional taskId filter.
 * @returns SummaryRecordSnapshot.
 */
export declare function apiListSummaryRecords(options?: {
    taskId?: number;
}): Promise<SummaryRecordSnapshot>;
/**
 * Delete a summary record by id.
 * @param options - Mutation options: record id.
 * @returns SummaryTaskMutationResult.
 */
export declare function apiDeleteSummaryRecord(options: {
    id: number;
}): Promise<SummaryTaskMutationResult>;
/**
 * List extracted WeChat tasks.
 * @returns TasksSnapshot.
 */
export declare function apiListTasks(): Promise<TasksSnapshot>;
/**
 * List native WeChat reminders.
 * @returns HandoffRemindsSnapshot.
 */
export declare function apiGetHandoffReminds(): Promise<HandoffRemindsSnapshot>;
/**
 * Import native reminders into the plugin task store.
 * @returns TaskMutationResult with added count.
 */
export declare function apiSyncHandoffTasks(): Promise<TaskMutationResult>;
/**
 * Add one manual task.
 * @param options - title and optional due epoch ms.
 * @returns TaskMutationResult.
 */
export declare function apiAddTask(options: {
    title: string;
    dueAt?: number;
}): Promise<TaskMutationResult>;
/**
 * Set a task status.
 * @param options - task id and target status.
 * @returns TaskMutationResult.
 */
export declare function apiSetTaskStatus(options: {
    id: number;
    status: 'open' | 'done';
}): Promise<TaskMutationResult>;
/**
 * Delete a task.
 * @param options - task id.
 * @returns TaskMutationResult.
 */
export declare function apiDeleteTask(options: {
    id: number;
}): Promise<TaskMutationResult>;
/**
 * Extract todo/reminder items from recent messages via DSH LLM.
 * @param options - optional lookback days.
 * @returns TaskMutationResult with added count.
 */
export declare function apiExtractTasks(options?: {
    days?: number;
}): Promise<TaskMutationResult>;
/**
 * Fetch the avatar for a username.
 * @param options - Query options: username.
 * @returns AvatarResult.
 */
export declare function apiGetAvatar(options: {
    username: string;
    nickname?: string;
}): Promise<AvatarResult>;
/**
 * 批量读取本地头像(head_image.db,单次请求,纯本地)。
 * @param options - usernames 列表。
 * @returns username → data URL。
 */
export declare function apiGetAvatarsLocal(options: {
    usernames: string[];
}): Promise<Record<string, string>>;
/**
 * Fetch the full WeChat config (including keys-related settings).
 * @returns WechatConfigFull.
 */
export declare function apiGetWechatConfigFull(): Promise<WechatConfigFull>;
/**
 * Save a WeChat config patch.
 * @param options - Mutation options: the config patch.
 * @returns SimpleResult.
 */
/** Open the owned WeChat config.json (e.g. for manual edit). @returns the opened path. */
/** Open an owned path (dir/file) with the system default. @returns the opened path. */
export declare function apiOpenPath(path: string): Promise<{
    ok: boolean;
    path: string;
}>;
export declare function apiOpenConfig(): Promise<{
    ok: boolean;
    path: string;
}>;
export declare function apiSaveWechatConfig(options: {
    patch: WechatConfigPatch;
}): Promise<SimpleResult>;
/**
 * Detect locally installed WeChat accounts.
 * @returns AccountsSnapshot.
 */
export declare function apiDetectWechatAccounts(): Promise<AccountsSnapshot>;
/**
 * Auto-recover the V4 database key from the running WeChat process.
 * @param options - optional probe db path and install dir.
 * @returns AutoDbKeyResult: ok + 64-hex key, or an error.
 */
export declare function apiAutoGetDbKey(options?: {
    dbPath?: string;
    wechatInstallDir?: string;
}): Promise<AutoDbKeyResult>;
/**
 * Auto-recover the image key from the running WeChat process (V2-verified).
 * @param options - account dir (wxid_* folder) and optional pid.
 * @returns AutoImageKeyResult: ok + xor/aes pair, or an error.
 */
export declare function apiAutoGetImageKey(options?: {
    accountDir?: string;
    pid?: number;
}): Promise<AutoImageKeyResult>;
/**
 * Verify a decrypted database key against a database file.
 * @param options - Mutation options: dbPath and encKeyHex.
 * @returns VerifyKeyResult.
 */
export declare function apiVerifyDatabaseKey(options: {
    dbPath: string;
    encKeyHex: string;
}): Promise<VerifyKeyResult>;
/**
 * Generate a keys file from the given encrypted key.
 * @param options - Mutation options: dbDir, keysFile, encKeyHex, optional keyFormat.
 * @returns GenerateKeysResult.
 */
export declare function apiGenerateKeysFile(options: {
    dbDir: string;
    keysFile: string;
    encKeyHex: string;
    keyFormat?: string;
}): Promise<GenerateKeysResult>;
/**
 * Fetch information about loaded WeChat keys.
 * @returns KeysInfoResult.
 */
export declare function apiGetWechatKeysInfo(): Promise<KeysInfoResult>;
/**
 * Verify the saved image key pair against real V2 templates.
 * @returns VerifyImageKeyResult: verified flag + xor/template evidence.
 */
export declare function apiVerifyImageKey(): Promise<VerifyImageKeyResult>;
/**
 * Full SQLCipher decryption of every db under db_storage.
 * @returns DecryptAllResult: total/ok/failed counts.
 */
export declare function apiDecryptAllDatabases(): Promise<DecryptAllResult>;
/**
 * Batch-decode every md5-prefixed .dat image into the decoded-images cache.
 * @param options - optional worker concurrency.
 * @returns DecryptImagesResult: total/ok/failed/skipped counts.
 */
export declare function apiDecryptAllImages(options?: {
    concurrency?: number;
}): Promise<DecryptImagesResult>;
/**
 * Read the live decryption progress snapshot.
 * @returns DecryptStatus: op/done/total/failed/skipped + current item.
 */
export declare function apiGetDecryptStatus(): Promise<DecryptStatus>;
/**
 * Read Whisper transcription configuration status.
 * @returns WhisperStatus: engine detection, CUDA presence, model inventory.
 */
export declare function apiGetWhisperStatus(): Promise<WhisperStatus>;
/**
 * Download one official whisper.cpp ggml model into the models dir.
 * @param options - model id to download.
 * @returns WhisperDownloadResult: ok + file/bytes, or an error.
 */
export declare function apiDownloadWhisperModel(options: {
    model: string;
}): Promise<WhisperDownloadResult>;
/**
 * Download + install the whisper.cpp CLI engine into the models dir.
 * @returns WhisperDownloadResult: ok + path, or an error.
 */
export declare function apiInstallWhisperEngine(): Promise<WhisperDownloadResult>;
/**
 * Batch-transcribe the most recent voice messages (silk → whisper-cli).
 * @param options - optional message count.
 * @returns VoiceTranscribeResult: done/failed/skipped counts.
 */
export declare function apiTranscribeVoiceBatch(options?: {
    limit?: number;
}): Promise<VoiceTranscribeResult>;
/**
 * Cached transcript for one voice message.
 * @param options - username + local_id.
 * @returns VoiceTranscriptResult.
 */
export declare function apiGetVoiceTranscript(options: {
    username: string;
    localId: number;
}): Promise<VoiceTranscriptResult>;
/**
 * Transcribe one voice message on demand (chat bubble 语音转文字).
 * @param options - username + local_id.
 * @returns VoiceTranscribeOneResult: ok + text, or error.
 */
export declare function apiTranscribeVoiceMessage(options: {
    username: string;
    localId: number;
}): Promise<VoiceTranscribeOneResult>;
/**
 * Enable or disable CDN image handling.
 * @param options - Mutation options: enabled flag.
 * @returns SimpleResult.
 */
export declare function apiSetCdnImageEnabled(options: {
    enabled: boolean;
}): Promise<SimpleResult>;
/**
 * Enable or disable local decryption of CDN images.
 * @param options - Mutation options: localDecrypt flag.
 * @returns SimpleResult.
 */
export declare function apiSetCdnImageLocalDecrypt(options: {
    localDecrypt: boolean;
}): Promise<SimpleResult>;
/**
 * Delete favorite items by ids.
 * @param options - Mutation options: favorite item ids.
 * @returns DeleteFavoriteResult.
 */
export declare function apiDeleteFavoriteItems(options: {
    ids: number[];
}): Promise<DeleteFavoriteResult>;
/**
 * Fetch the annual report for a year.
 * @param options - Query options: the report year.
 * @returns AnnualReport.
 */
export declare function apiGetAnnualReport(options: {
    year: number;
}): Promise<AnnualReport>;
/**
 * Remote gateway readiness status: unknown before the first probe, online/offline after.
 */
export type ApiStatus = 'unknown' | 'online' | 'offline';
/**
 * Return the current Remote gateway readiness status.
 * @returns ApiStatus ('unknown' | 'online' | 'offline').
 */
export declare function getApiStatus(): ApiStatus;
/**
 * Subscribe to Remote gateway status changes.
 * @param fn - Callback invoked when the status changes.
 * @returns An unsubscribe function that removes the listener.
 */
export declare function subscribeApiStatus(fn: () => void): () => void;
/**
 * Probe the WeChat Remote gateway (local decrypted data ready).
 * @returns true when the gateway responds to a minimal getSessions probe, false otherwise.
 */
export declare function checkApiHealth(): Promise<boolean>;
//# sourceMappingURL=api.d.ts.map