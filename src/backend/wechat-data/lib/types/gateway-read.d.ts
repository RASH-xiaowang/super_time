/**
 * WechatDataGateway 方法面 · 只读快照与本地逻辑壳（数据读取 / 检索取消 / 历史删除）（M21 结构刀自 gateway.ts 拆出）。
 *
 * 这一层只有 `@Remote` 壳（装饰器 + 签名 + 一行转发）；装饰器标记会落到**最派生原型**上，
 * 因此协议层枚举到的方法面与拆分前逐名相同（守卫：`gateway-remote-surface.spec.ts`）。
 */
import type { AccountsSnapshot, AnnualReport, AnnualSnapshot, AskHistoryClearResult, AskHistoryDeleteResult, CalendarSnapshot, CallsSnapshot, ChatHistoryResolveResult, ContactsSnapshot, DeleteFavoriteResult, DraftClearResult, DraftsClearResult, EditMutationResult, EditedListSnapshot, FavoritesSnapshot, GraphSnapshot, GroupInfoSnapshot, ImageDataUrlResult, MemberSearchSnapshot, MessagesSnapshot, MomentsSnapshot, OverviewInsights, OverviewSnapshot, PaymentStatus, RecordsSnapshot, RevokedSnapshot, SearchIndexStatus, SessionsSnapshot, SimpleResult, StorageSnapshot, SummaryRecordSnapshot, VerifyKeyResult, VoiceTranscriptResult, VoiceTranscribeOneResult, AssetInsightsSnapshot, Contact360Snapshot, GroupInsightsSnapshot, LedgerSnapshot, MediaAssetsSnapshot, MomentsInsightsSnapshot, MomentsMonthlyRow, OfficialAssetsSnapshot, RegionMapSnapshot, UnifiedSearchSnapshot } from './types.ts';
import type { RerankWeights } from './query/retrieval/types.ts';
import { type AnnualReview } from './query/annual-review.ts';
import { GatewayCore } from './gateway-core.ts';
/** 方法面的一层：继承链上的一环，不单独实例化（abstract：`runSummaryTask` 由更下面那层实现）。 */
export declare abstract class GatewayRead extends GatewayCore {
    getSessions(options?: {
        keyword?: string;
        limit?: number;
        offset?: number;
    }): SessionsSnapshot;
    /**
     * Contact book.
     * @param options - Optional page size + offset for incremental loading, plus a
     *   category filter (friend/group/official/service/enterprise/member/system/deleted).
     *   The filter is applied **before** pagination so a category tab shows its own
     *   complete list and an accurate `total`.
     * @returns ContactsSnapshot: contacts list (items + total) + per-category stats.
     */
    getContacts(options?: {
        limit?: number;
        offset?: number;
        category?: string;
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
     * 保留理由：界面暂无入口（全局搜索走 searchUnified），保留给宿主/后续的群成员选择器。
     *   第 96 轮补上了群内路径漏掉的 `quan_pin`/`alias`（此前「按备注全拼在群里搜人」永远搜不到），
     *   由 `scripts/check-members-search.js` 对着真实库把关。
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
        q?: string;
    }): RevokedSnapshot;
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
        q?: string;
    }): FavoritesSnapshot;
    /**
     * Messages of one talker.
     * @param options - Talker username, optional limit and pagination cursor.
     * @returns MessagesSnapshot: message items for the talker.
     */
    getMessages(options: {
        talker: string;
        limit?: number;
        cursor?: number;
        cursorLocalId?: number;
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
     * 取消一次正在跑的消息搜索（N9）。
     * @param options - `jobId` 为渲染层生成的任务标识。
     * @returns `ok: true` 表示确实打断了一个在跑的搜索；找不到（已跑完/从未注册）时为 false。
     */
    cancelSearch(options?: {
        jobId?: string;
    }): {
        ok: boolean;
    };
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
     * 重置调参权重回默认值（丢弃反馈带来的偏移；反馈记录本身保留）。
     */
    resetRetrievalWeights(): {
        ok: boolean;
        weights: RerankWeights;
    };
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
     * 删除若干条问答历史。
     *
     * 与导出历史不同，这里**没有**「连带删除外部文件」这个选项 —— 问答记录的内容全部在库里，
     * 删记录就是删全部，没有第二个动作会顺手动到用户磁盘上的东西。
     * @param options - ids。
     * @returns 实际删除条数。
     */
    deleteAskHistory(options: {
        ids: number[];
    }): AskHistoryDeleteResult;
    /**
     * 清空全部问答历史（由界面上的显式入口 + 二次确认触发，不做任何自动清理）。
     * @returns 实际删除条数。
     */
    clearAskHistory(): AskHistoryClearResult;
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
     * List generated summary records.
     * @param options - optional taskId filter.
     * @returns SummaryRecordSnapshot: summary records (items + total).
     */
    listSummaryRecords(options?: {
        taskId?: number;
    }): SummaryRecordSnapshot;
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
    /**
     * 年度回顾（看板）：15 张卡片所需的完整年度聚合。
     * 「人物类」指标只算我发出的（real_sender_id 归属），「规模类」算全部消息。
     * @param options - year to compute the report for.
     * @returns AnnualReview: 完整看板数据。
     */
    getAnnualReview(options: {
        year: number;
    }): AnnualReview;
    getAnnualReport(options: {
        year: number;
    }): AnnualReport;
    /**
     * Resolve a 公众号 article cover (og:image) to a base64 data URL.
     * @param options - mp.weixin.qq.com article URL.
     * @returns ImageDataUrlResult: base64 data URL or error.
     */
    getArticleCover(options: {
        contentUrl: string;
    }): Promise<ImageDataUrlResult>;
    getAssetInsights(): AssetInsightsSnapshot;
    getContact360(options: {
        username: string;
    }): Contact360Snapshot;
    getCalls(options?: {
        topPeers?: number;
        recentLimit?: number;
    }): CallsSnapshot;
    getGroupInsights(options: {
        username: string;
    }): GroupInsightsSnapshot;
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
    searchUnified(options: {
        query: string;
        limit?: number;
    }): UnifiedSearchSnapshot;
}
