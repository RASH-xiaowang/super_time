/**
 * WeChat data access layer — backed by the DSH WechatDataGateway Remote
 * (node:sqlite over the owned local decrypted DBs). All panels read through
 * ctx.remote.wechatData.*; there is no HTTP dependency.
 *
 * Panels also use the stale-while-revalidate render cache below: the first
 * successful render is persisted, the next open renders it synchronously
 * (instant paint), and fresh data replaces it in the background.
 */
/**
 * In-memory snapshot cache with a short TTL. The WeChat panels unmount when
 * the user switches tabs; a shared cache makes returning to a tab show the
 * last snapshot instantly, then refresh in the background (stale-while-revalidate).
 * Invalidated wholesale when the host reports new decrypted data
 * (see the 'dsh-wechat-data-updated' DOM event).
 */
const SNAPSHOT_TTL_MS = 30_000;
const _snapshotCache = new Map();
const _snapshotListeners = new Map();
/** Read a fresh-enough cached snapshot, or undefined when absent/stale. */
function snapshotHit(key) {
    const hit = _snapshotCache.get(key);
    if (hit !== undefined && Date.now() - hit.ts < SNAPSHOT_TTL_MS)
        return hit.value;
    return undefined;
}
/** Fetch-through cache: returns the cached value immediately when fresh, else fetches and caches. */
function cachedGet(key, fetcher) {
    const hit = snapshotHit(key);
    if (hit !== undefined)
        return Promise.resolve(hit);
    return fetcher().then((value) => {
        _snapshotCache.set(key, { value, ts: Date.now() });
        for (const fn of _snapshotListeners.get(key) ?? []) {
            try {
                fn();
            }
            catch { /* ignore */ }
        }
        return value;
    });
}
/** Subscribe to cache writes for one key (drives re-render after a background refresh). */
export function subscribeSnapshot(key, fn) {
    const set = _snapshotListeners.get(key) ?? new Set();
    set.add(fn);
    _snapshotListeners.set(key, set);
    return () => { set.delete(fn); };
}
/** Invalidate the whole snapshot cache (realtime update / manual refresh). */
export function invalidateSnapshotCache() {
    _snapshotCache.clear();
    for (const set of _snapshotListeners.values())
        for (const fn of set) {
            try {
                fn();
            }
            catch { /* ignore */ }
        }
}
if (typeof window !== 'undefined') {
    // The ui-wechat plugin relays the host realtime sync signal as this DOM event;
    // new decrypted data means every cached snapshot is stale, so drop them all.
    window.addEventListener('dsh-wechat-data-updated', () => { invalidateSnapshotCache(); });
}
const RENDER_CACHE_PREFIX = 'wxdata-render-cache:';
/** Read the last successfully rendered snapshot for a panel (sync, instant paint). */
export function readRenderCache(key, ..._rest) {
    if (typeof localStorage === 'undefined')
        return null;
    try {
        const raw = localStorage.getItem(RENDER_CACHE_PREFIX + key);
        return raw ? JSON.parse(raw) : null;
    }
    catch { /* 无缓存或损坏:走正常加载 */ }
    return null;
}
/** Save a snapshot after a successful render (quota-safe: drops silently when full). */
export function writeRenderCache(key, data) {
    if (typeof localStorage === 'undefined')
        return;
    try {
        localStorage.setItem(RENDER_CACHE_PREFIX + key, JSON.stringify(data));
    }
    catch { /* 容量超限:放弃缓存,不影响主流程 */ }
}
let _remote = null;
/**
 * Rewrite a session-authentication failure (HTTP 401 from the API channel,
 * which is the browser cookie gate) into an actionable message. The raw
 * transport text ("transport failure for ...: HTTP 401") leaves the user with
 * no idea that reopening the app re-authenticates.
 * @param e - the thrown error from a remote call.
 * @returns an Error with a user-facing message when the failure is HTTP 401.
 */
function actionableRemoteError(e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/HTTP 401\b/.test(msg)) {
        return new Error('本地会话认证已失效（HTTP 401）：请关闭并重新打开本页面；若仍失败，请用「dsh web」启动时打印的带 token 的地址重新打开应用以完成重新认证');
    }
    return e instanceof Error ? e : new Error(msg);
}
/**
 * Install the Remote client (called from ui-pages apply).
 * @param remote - The Remote client to install.
 */
export function setWechatRemote(remote) {
    const base = typeof remote === 'function' ? remote : () => remote;
    // Wrap every method so transport failures (HTTP 401 session expiry) surface an
    // actionable message across all panels, not only explicit catch sites.
    _remote = () => new Proxy(base(), {
        get(target, prop, receiver) {
            const v = Reflect.get(target, prop, receiver);
            if (typeof v !== 'function')
                return v;
            return (...args) => {
                try {
                    const r = v.apply(target, args);
                    return r instanceof Promise
                        ? r.catch((e) => { throw actionableRemoteError(e); })
                        : r;
                }
                catch (e) {
                    throw actionableRemoteError(e);
                }
            };
        },
    });
}
function remote() {
    if (_remote === null)
        throw new Error('wechat-data remote not installed');
    return _remote();
}
let _pickDirectory = null;
/** Install the host directory chooser (ui-pages apply injects ctx.workspaces). */
export function setDirectoryPicker(pick) {
    _pickDirectory = pick;
}
/** Open the native directory chooser; returns the picked path or null on cancel. */
export async function pickDirectory() {
    if (_pickDirectory === null)
        return null;
    return _pickDirectory();
}
function unwrap(r) {
    if (!r.ok)
        throw new Error(r.error?.message ?? r.error?.code ?? 'remote call failed');
    return r.value;
}
// ── 本地缓存层：先渲染缓存，后台刷新后再写回，加速资源预加载 ──
const CACHE_PREFIX = 'dsh-wechat-cache-v1:';
const CACHE_TTL_DEFAULT = 60_000;
function cacheGet(key, ttlMs = CACHE_TTL_DEFAULT) {
    try {
        const s = localStorage.getItem(CACHE_PREFIX + key);
        if (!s)
            return null;
        const env = JSON.parse(s);
        if (typeof env.at !== 'number' || !('v' in env))
            return null;
        if (Date.now() - env.at > ttlMs) {
            localStorage.removeItem(CACHE_PREFIX + key);
            return null;
        }
        return env.v;
    }
    catch {
        return null;
    }
}
function cacheSet(key, value) {
    try {
        localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), v: value }));
    }
    catch {
        /* localStorage 满时忽略（媒体大图不入缓存） */
    }
}
/** Remove cache entries whose key starts with the given prefix (both layers). */
export function invalidateWechatCache(prefix) {
    try {
        for (let i = localStorage.length - 1; i >= 0; i -= 1) {
            const k = localStorage.key(i);
            if (!k)
                continue;
            if (k.startsWith(CACHE_PREFIX + prefix))
                localStorage.removeItem(k);
            if (k.startsWith(RENDER_CACHE_PREFIX + prefix))
                localStorage.removeItem(k);
        }
    }
    catch { /* quota/security errors are best-effort */ }
}
// ── 解密媒体持久化缓存（IndexedDB）：已解密的朋友圈图片/视频封面跨会话复用，
//    避免下次进入朋友圈再次并发解密。localStorage 容量不足以存 base64 大图。 ──
const MEDIA_DB_NAME = 'dsh-wechat-media';
const MEDIA_STORE = 'sns-images';
const MEDIA_MAX_ENTRIES = 4000;
let mediaDb = null;
function openMediaDb() {
    if (mediaDb)
        return mediaDb;
    mediaDb = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('indexedDB unavailable'));
            return;
        }
        const req = indexedDB.open(MEDIA_DB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(MEDIA_STORE)) {
                db.createObjectStore(MEDIA_STORE).createIndex('by_at', 'at');
            }
        };
        req.onsuccess = () => { resolve(req.result); void trimMediaCache(req.result); };
        req.onerror = () => { mediaDb = null; reject(req.error ?? new Error('open media db failed')); };
    });
    return mediaDb;
}
/** 删除超出容量上限的最旧条目（按写入时间 at 升序）。 */
async function trimMediaCache(db) {
    try {
        await new Promise((resolve) => {
            const tx = db.transaction(MEDIA_STORE, 'readonly');
            const store = tx.objectStore(MEDIA_STORE);
            const keysReq = store.getAllKeys();
            const valsReq = store.getAll();
            let keys = [];
            let vals = [];
            keysReq.onsuccess = () => { keys = keysReq.result; };
            valsReq.onsuccess = () => { vals = valsReq.result; };
            tx.oncomplete = () => {
                if (keys.length <= MEDIA_MAX_ENTRIES) {
                    resolve();
                    return;
                }
                const rows = keys.map((key, i) => ({ key, at: vals[i]?.at ?? 0 })).sort((a, b) => a.at - b.at);
                const drop = rows.slice(0, keys.length - MEDIA_MAX_ENTRIES);
                if (drop.length === 0) {
                    resolve();
                    return;
                }
                const dtx = db.transaction(MEDIA_STORE, 'readwrite');
                for (const d of drop)
                    dtx.objectStore(MEDIA_STORE).delete(d.key);
                dtx.oncomplete = () => { resolve(); };
                dtx.onerror = () => { resolve(); };
            };
            tx.onerror = () => { resolve(); };
        });
    }
    catch { /* best-effort */ }
}
/** Read one cached decrypted media data URL by key, or null. */
export async function snsMediaCacheGet(key) {
    try {
        const db = await openMediaDb();
        return await new Promise((resolve) => {
            const req = db.transaction(MEDIA_STORE, 'readonly').objectStore(MEDIA_STORE).get(key);
            req.onsuccess = () => {
                const r = req.result;
                resolve(typeof r?.url === 'string' ? r.url : null);
            };
            req.onerror = () => { resolve(null); };
        });
    }
    catch {
        return null;
    }
}
/** Batch-read cached media data URLs for the given keys. */
export async function snsMediaCacheGetMany(keys) {
    const out = {};
    if (keys.length === 0)
        return out;
    try {
        const db = await openMediaDb();
        await new Promise((resolve) => {
            const tx = db.transaction(MEDIA_STORE, 'readonly');
            const store = tx.objectStore(MEDIA_STORE);
            for (const k of keys) {
                const req = store.get(k);
                req.onsuccess = () => {
                    const r = req.result;
                    if (typeof r?.url === 'string')
                        out[k] = r.url;
                };
            }
            tx.oncomplete = () => { resolve(); };
            tx.onerror = () => { resolve(); };
        });
    }
    catch { /* best-effort */ }
    return out;
}
/** Persist one decrypted media data URL. */
export async function snsMediaCacheSet(key, url) {
    try {
        const db = await openMediaDb();
        await new Promise((resolve) => {
            const tx = db.transaction(MEDIA_STORE, 'readwrite');
            tx.objectStore(MEDIA_STORE).put({ url, at: Date.now() }, key);
            tx.oncomplete = () => { resolve(); };
            tx.onerror = () => { resolve(); };
        });
    }
    catch { /* best-effort */ }
}
/** 读快照：命中缓存时先返回缓存作早显，随后前台等待新鲜值并写回；
 *  后台刷新失败降级返回缓存。无缓存时直接请求并写回。 */
/** 记录一次 panel 数据取数的耗时（超过阈值才打印，便于观察“及时响应”与回归）。 */
async function timedFetch(key, fetcher) {
    const t0 = performance.now();
    try {
        return await fetcher();
    }
    finally {
        const ms = performance.now() - t0;
        if (ms > 250)
            console.info(`[wxdata] ${key} ${ms.toFixed(0)}ms`);
    }
}
async function cachedFetch(key, fetcher, ttlMs = CACHE_TTL_DEFAULT) {
    const hit = cacheGet(key, ttlMs);
    if (hit !== null && !isEmptySnapshot(hit)) {
        try {
            const fresh = await timedFetch(key, fetcher);
            cacheSet(key, fresh);
            return fresh;
        }
        catch {
            return hit;
        }
    }
    const fresh = await timedFetch(key, fetcher);
    cacheSet(key, fresh);
    return fresh;
}
/**
 * 空结果不参与缓存：一个临时的空快照（例如数据根尚未就绪时写入的）会
 * 永久盖住真实数据——命中后界面渲染空列表，后台刷新只改写 localStorage
 * 而不重绘界面。列表型快照（moments/items/favorites/…）无任何条目且
 * 总数为 0 时视为空；统计类快照（无数组字段）不受影响。
 */
function isEmptySnapshot(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const entries = Object.values(value);
    let sawList = false;
    for (const entry of entries) {
        if (Array.isArray(entry)) {
            sawList = true;
            if (entry.length > 0)
                return false;
        }
    }
    if (!sawList)
        return false;
    return !entries.some(entry => typeof entry === 'number' && entry > 0);
}
// ── sessions / contacts / messages (Remote) ──
/**
 * Fetch the session list (optional keyword filter + limit).
 * @param options - Query options: keyword fuzzy search, limit max rows.
 * @returns SessionsSnapshot with items + total.
 */
export async function apiGetSessions(options) {
    return cachedFetch('sessions:' + JSON.stringify(options ?? {}), async () => unwrap(await remote().getSessions(options)), 30_000);
}
/**
 * Fetch the contact list (optional page size + offset).
 * @param options - Query options: limit page size, offset page start.
 * @returns ContactsSnapshot.
 */
export async function apiGetContacts(options) {
    return cachedGet('contacts:' + JSON.stringify(options ?? {}), async () => unwrap(await remote().getContacts(options)));
}
/**
 * Fetch the contact 360° profile snapshot.
 * @param username - target username.
 * @returns Contact360Snapshot.
 */
export async function apiGetContact360(username) {
    return unwrap(await remote().getContact360({ username }));
}
/**
 * Fetch messages for a talker.
 * @param options - Query options: talker username, limit, cursor for paging.
 * @returns MessagesSnapshot.
 */
export async function apiGetMessages(options) {
    if (options.cursor !== undefined)
        return unwrap(await remote().getMessages(options));
    return cachedFetch('messages:' + options.talker + ':' + String(options.limit ?? 50), async () => unwrap(await remote().getMessages(options)), 5_000);
}
/**
 * Fetch messages newer than a sort_seq watermark (real-time polling).
 * @param options - Query options: talker, after watermark, optional limit.
 * @returns MessagesSnapshot with the newer messages only.
 */
export async function apiGetNewMessages(options) {
    return unwrap(await remote().getNewMessages(options));
}
/**
 * Fetch the moments feed (paging + author filter).
 * @param options - Query options: offset, limit, author filter.
 * @returns MomentsSnapshot.
 */
export async function apiGetMoments(options) {
    return cachedFetch('moments:' + JSON.stringify(options ?? {}), async () => unwrap(await remote().getMoments(options)));
}
/** Fetch the current account's own WeChat username (for filtering "我" authored comments). */
export async function apiGetSelfUsername() {
    const r = await remote().getSelfUsername();
    return unwrap(r).username;
}
/** Fetch full-history author activity counts (ranked descending). */
export async function apiGetMomentsAuthors() {
    return unwrap(await remote().getMomentsAuthors());
}
/**
 * Fetch moments insights for an author (default: self).
 * @param options - optional author username.
 * @returns MomentsInsightsSnapshot.
 */
export async function apiGetMomentsInsights(options) { return cachedGet('momentsInsights:JSON.stringify((options ?? {}))', async () => unwrap(await remote().getMomentsInsights(options))); }
/**
 * Fetch the full monthly distribution of moments (all authors, or one author).
 * Not paginated, so it reflects every month.
 * @param options - optional author username (`author`) or author display-name
 *   (`authorName`) filter (all when omitted).
 * @returns monthly rows sorted ascending by month.
 */
export async function apiGetMomentsMonthly(options) {
    return unwrap(await remote().getMomentsMonthly(options));
}
/**
 * Fetch the favorites list.
 * @param options - Query options: limit.
 * @returns FavoritesSnapshot.
 */
export async function apiGetFavorites(options) { return cachedGet('favorites:JSON.stringify((options ?? {}))', async () => unwrap(await remote().getFavorites(options))); }
/**
 * Fetch favorites + emoticon asset insights.
 * @returns AssetInsightsSnapshot.
 */
export async function apiGetAssetInsights() {
    return unwrap(await remote().getAssetInsights());
}
/**
 * Fetch official account content assets.
 * @returns OfficialAssetsSnapshot.
 */
export async function apiGetOfficialAssets() {
    return unwrap(await remote().getOfficialAssets());
}
/**
 * Fetch media assets inventory.
 * @returns MediaAssetsSnapshot.
 */
export async function apiGetMediaAssets() {
    return unwrap(await remote().getMediaAssets());
}
/**
 * Fetch the files list.
 * @param options - Query options: limit.
 * @returns FilesSnapshot.
 */
export async function apiGetFiles(options) { return cachedGet('files:JSON.stringify((options ?? {}))', async () => unwrap(await remote().getFiles(options))); }
/**
 * Fetch the overall statistics overview.
 * @returns OverviewSnapshot.
 */
export async function apiGetOverviewInsights() { return cachedGet('overviewInsights:x', async () => unwrap(await remote().getOverviewInsights())); }
export async function apiGetOverview() { return cachedGet('overview:x', async () => unwrap(await remote().getOverview())); }
/**
 * Fetch the friend-region map (世界 → 国家 → 省 → 市 → 好友).
 * @returns RegionMapSnapshot.
 */
export async function apiGetRegionMap() {
    return unwrap(await remote().getRegionMap());
}
/**
 * Fetch records with kind filter + paging + free-text query.
 * @param options - Query options: kind, limit, offset, q.
 * @returns RecordsSnapshot.
 */
export async function apiGetRecords(options) {
    return cachedFetch('records:' + JSON.stringify(options), async () => unwrap(await remote().getRecords(options)));
}
/**
 * Fetch the funds ledger snapshot (transfer/red-packet aggregates).
 * @param options - Optional month filter (YYYY-MM).
 * @returns LedgerSnapshot.
 */
export async function apiGetLedger(options) {
    return unwrap(await remote().getLedger(options));
}
/**
 * Fetch revoked messages.
 * @param options - Query options: limit.
 * @returns RevokedSnapshot.
 */
export async function apiGetRevoked(options) { return cachedGet('revoked:JSON.stringify((options ?? {}))', async () => unwrap(await remote().getRevoked(options))); }
/**
 * Fetch the emoticons list.
 * @param options - Query options: limit/offset.
 * @returns EmoticonsSnapshot.
 */
export async function apiGetEmoticons(options) { return cachedGet('emoticons:JSON.stringify((options ?? {}))', async () => unwrap(await remote().getEmoticons(options))); }
/**
 * Fetch storage usage statistics.
 * @returns StorageSnapshot.
 */
export async function apiGetStorageStats() { return cachedGet('storage:x', async () => unwrap(await remote().getStorageStats())); }
/**
 * Fetch annual statistics.
 * @returns AnnualSnapshot.
 */
export async function apiGetAnnual() { return cachedGet('annual:x', async () => unwrap(await remote().getAnnual())); }
/**
 * Fetch the current WeChat config snapshot.
 * @returns ConfigSnapshot.
 */
export async function apiGetWechatConfig() {
    return unwrap(await remote().getWechatConfig());
}
/**
 * Fetch the privacy scan result.
 * @returns PrivacySnapshot.
 */
export async function apiGetPrivacyScan() {
    return cachedFetch('privacy', async () => unwrap(await remote().getPrivacyScan()));
}
/**
 * Fetch privacy settings + audit snapshot.
 * @returns PrivacyStateSnapshot.
 */
export async function apiGetPrivacyState() {
    return unwrap(await remote().getPrivacyState());
}
/**
 * Update privacy settings.
 * @param options - partial settings patch.
 * @returns the updated privacy state snapshot.
 */
export async function apiSetPrivacyState(options) {
    const r = await remote().setPrivacyState(options);
    invalidateWechatCache('privacy');
    return unwrap(r);
}
/**
 * Fetch recent raw privacy audit rows.
 * @returns recent audit rows.
 */
export async function apiGetPrivacyAuditRows() {
    return unwrap(await remote().getPrivacyAuditRows());
}
/**
 * Clear the privacy audit log.
 * @returns clear result with removed row count.
 */
export async function apiClearPrivacyAudit() {
    return unwrap(await remote().clearPrivacyAudit());
}
/**
 * List recent operation-log rows (newest first) with optional filters.
 * @param options - time range / categories / status / limit filters.
 * @returns matching operation-log entries + total count.
 */
export async function apiGetOperationLog(options) {
    return unwrap(await remote().getOperationLog(options));
}
/**
 * Clear the operation log (a sensitive action, itself recorded first).
 * @returns clear result with removed row count.
 */
export async function apiClearOperationLog() {
    return unwrap(await remote().clearOperationLog());
}
/**
 * Fetch the relationship graph snapshot.
 * @returns GraphSnapshot.
 */
export async function apiGetGraph() { return cachedGet('graph:x', async () => unwrap(await remote().getGraph())); }
/**
 * Fetch search index build status.
 * @returns SearchIndexStatus.
 */
export async function apiGetSearchIndexStatus() {
    return unwrap(await remote().getSearchIndexStatus());
}
/**
 * Trigger a search index build (optionally forced).
 * @param options - Query options: force rebuild even when up to date.
 * @returns SearchBuildResult.
 */
export async function apiBuildSearchIndex(options) {
    return unwrap(await remote().buildSearchIndex(options));
}
/**
 * Search messages by query text.
 * @param options - Query options: query text and limit.
 * @returns SearchSnapshot.
 */
export async function apiSearchMessages(options) {
    return unwrap(await remote().searchMessages(options));
}
/**
 * Run the unified local search across several data domains.
 * @param options - Query options: query text, optional per-domain limit.
 * @returns UnifiedSearchSnapshot.
 */
export async function apiSearchUnified(options) {
    return unwrap(await remote().searchUnified(options));
}
/**
 * Ask a question over the local WeChat data (retrieval + LLM answer).
 * @param options - Question plus optional talker/date scope.
 * @returns AskResult: answer and source citations.
 */
export async function apiAskWechat(options) {
    return unwrap(await remote().askWechat(options));
}
/** Group chat info (群聊信息) for the open chatroom. */
export async function apiSearchMembers(options) {
    return unwrap(await remote().searchMembers(options));
}
export async function apiGetGroupInfo(username) {
    return cachedFetch('group:' + username, async () => unwrap(await remote().getGroupInfo({ username })));
}
/**
 * Fetch offline group insights for one chatroom.
 * @param username - chatroom username.
 * @returns GroupInsightsSnapshot.
 */
export async function apiGetGroupInsights(username) {
    return unwrap(await remote().getGroupInsights({ username }));
}
/** Resolve a nested merged chat-log pointer by its server_id. */
export async function apiResolveChatHistory(serverId) {
    return unwrap(await remote().resolveChatHistory({ serverId }));
}
/** Authoritative transfer/redpacket status by message server_id. */
export async function apiGetPaymentStatus(serverId) {
    return cachedFetch('pay:' + serverId, async () => unwrap(await remote().getPaymentStatus({ serverId })));
}
/**
 * Fetch per-day message counts for a month.
 * @param options - Query options: username, year, month.
 * @returns CalendarSnapshot.
 */
export async function apiGetDailyCounts(options) {
    return cachedFetch('daily:' + options.username + ':' + String(options.year) + '-' + String(options.month), async () => unwrap(await remote().getDailyCounts(options)));
}
/**
 * Resolve an image message to a data URL.
 * @param options - Query options: username and message localId.
 * @returns ImageDataUrlResult.
 */
export async function apiGetSnsImageDataUrl(options) {
    return unwrap(await remote().getSnsImageDataUrl(options));
}
/**
 * Resolve a moments video cover to a data URL (offline Sns/Video jpg).
 * @param options - media md5 / timeline id / media id.
 * @returns ImageDataUrlResult.
 */
export async function apiGetSnsVideoCoverDataUrl(options) {
    return unwrap(await remote().getSnsVideoCoverDataUrl(options));
}
/**
 * Resolve a moments video body to an offline data URL for inline playback.
 * @param options - media md5 / timeline id / media id.
 * @returns ImageDataUrlResult.
 */
export async function apiGetSnsVideoDataUrl(options) {
    return unwrap(await remote().getSnsVideoDataUrl(options));
}
/**
 * Resolve a 公众号 article cover (og:image) to a data URL.
 * @param options - mp.weixin.qq.com article URL.
 * @returns ImageDataUrlResult.
 */
export async function apiGetArticleCover(options) {
    return unwrap(await remote().getArticleCover(options));
}
/**
 * Resolve a received message file (msg/file) to a data URL.
 * @param options - original file name.
 * @returns ImageDataUrlResult.
 */
export async function apiGetMessageFile(options) {
    return unwrap(await remote().getMessageFile(options));
}
export async function apiGetImageDataUrl(options) {
    return unwrap(await remote().getImageDataUrl(options));
}
/**
 * Fetch decrypted database status.
 * @returns DbStatusSnapshot.
 */
export async function apiGetDbStatus() {
    return unwrap(await remote().getDbStatus());
}
/**
 * Fetch the data-health snapshot.
 * @returns DbHealthSnapshot.
 */
export async function apiGetDbHealth() {
    return unwrap(await remote().getDbHealth());
}
/**
 * Fetch voice message info.
 * @param options - Query options: username and message localId.
 * @returns VoiceInfoResult.
 */
export async function apiGetVoiceInfo(options) {
    return unwrap(await remote().getVoiceInfo(options));
}
/**
 * Fetch video message info.
 * @param options - Query options: username and message localId.
 * @returns VideoInfoResult.
 */
export async function apiGetVideoInfo(options) {
    return unwrap(await remote().getVideoInfo(options));
}
/**
 * Export a session’s messages in the given format.
 * @param options - Query options: username, format, optional count.
 * @returns ExportResult.
 */
export async function apiExportSessionMessages(options) {
    return unwrap(await remote().exportSessionMessages(options));
}
/**
 * List decrypted-data backups.
 * @returns BackupSnapshot.
 */
export async function apiListBackups() {
    return unwrap(await remote().listBackups());
}
/**
 * Preview a backup's contents before restore.
 * @param options - backup name.
 * @returns BackupPreviewSnapshot.
 */
export async function apiPreviewBackup(options) {
    return unwrap(await remote().previewBackup(options));
}
/**
 * Create a new backup.
 * @returns BackupMutationResult.
 */
export async function apiCreateBackup() {
    return unwrap(await remote().createBackup());
}
/**
 * Create an encrypted `.wcb` backup bundle.
 * @param options - encryption password.
 * @returns BackupMutationResult.
 */
export async function apiCreateEncryptedBackup(options) {
    return unwrap(await remote().createEncryptedBackup(options));
}
/**
 * Restore an encrypted backup into a plain directory.
 * @param options - backup name and password.
 * @returns BackupRestoreResult.
 */
export async function apiRestoreBackup(options) {
    const r = await remote().restoreBackup(options);
    invalidateWechatCache('');
    return unwrap(r);
}
/**
 * Delete a backup by name.
 * @param options - Query options: backup name.
 * @returns BackupMutationResult.
 */
export async function apiDeleteBackup(options) {
    return unwrap(await remote().deleteBackup(options));
}
/**
 * Generate a daily summary for the given date.
 * @param options - Query options: the date (YYYY-MM-DD).
 * @returns DailySummaryResult.
 */
export async function apiGenerateDailySummary(options) {
    return unwrap(await remote().generateDailySummary(options));
}
/**
 * Generate a period (weekly/monthly/custom) chat summary via DSH LLM.
 * @param options - inclusive date range plus optional model override.
 * @returns PeriodSummaryResult.
 */
export async function apiGeneratePeriodSummary(options) {
    return unwrap(await remote().generatePeriodSummary(options));
}
/** List available LLM providers for the daily-summary model selector. */
export async function apiListLlmProviders() {
    return unwrap(await remote().listLlmProviders());
}
/** List models for one LLM provider. */
export async function apiListLlmModels(options) {
    return unwrap(await remote().listLlmModels(options));
}
/**
 * List edited-message records (optionally filtered by session).
 * @param options - Query options: optional sessionId filter.
 * @returns EditedListSnapshot.
 */
export async function apiListEditedMessages(options) {
    return unwrap(await remote().listEditedMessages(options));
}
/**
 * Apply an edit to a chat message.
 * @param options - Mutation options: username, message localId, new content.
 * @returns EditMutationResult.
 */
export async function apiEditChatMessage(options) {
    const r = await remote().editChatMessage(options);
    invalidateWechatCache('messages:');
    invalidateWechatCache('chat-msgs:');
    invalidateWechatCache('sessions:');
    return unwrap(r);
}
/**
 * Reset an edited chat message back to its original content.
 * @param options - Mutation options: username and message localId.
 * @returns EditMutationResult.
 */
export async function apiResetEditedMessage(options) {
    const r = await remote().resetEditedMessage(options);
    invalidateWechatCache('messages:');
    invalidateWechatCache('chat-msgs:');
    invalidateWechatCache('sessions:');
    return unwrap(r);
}
/**
 * Export a record kind to CSV.
 * @param options - Query options: record kind, optional recordsKind.
 * @returns ExportResult.
 */
export async function apiExportAnnualReport(options) {
    return unwrap(await remote().exportAnnualReport(options));
}
export async function apiExportAllSessions(options) {
    return unwrap(await remote().exportAllSessions(options));
}
export async function apiExportMoments(options) {
    return unwrap(await remote().exportMoments(options));
}
export async function apiExportCsv(options) {
    return unwrap(await remote().exportCsv(options));
}
/**
 * Clear a session’s draft.
 * @param options - Mutation options: session username.
 * @returns DraftClearResult.
 */
export async function apiClearSessionDraft(options) {
    const r = await remote().clearSessionDraft(options);
    invalidateWechatCache('sessions:');
    return unwrap(r);
}
/**
 * Clear all session drafts.
 * @returns DraftsClearResult.
 */
export async function apiClearAllSessionDrafts() {
    const r = await remote().clearAllSessionDrafts();
    invalidateWechatCache('sessions:');
    return unwrap(r);
}
/**
 * List summary tasks.
 * @returns SummaryTaskSnapshot.
 */
export async function apiListSummaryTasks() {
    return unwrap(await remote().listSummaryTasks());
}
/**
 * Create or update a summary task.
 * @param options - Mutation options: the task payload (with optional id for updates).
 * @returns SummaryTaskMutationResult.
 */
export async function apiSaveSummaryTask(options) {
    return unwrap(await remote().saveSummaryTask(options));
}
/**
 * Delete a summary task by id.
 * @param options - Mutation options: task id.
 * @returns SummaryTaskMutationResult.
 */
export async function apiDeleteSummaryTask(options) {
    return unwrap(await remote().deleteSummaryTask(options));
}
/**
 * Enable or disable a summary task.
 * @param options - Mutation options: task id and enabled flag.
 * @returns SummaryTaskMutationResult.
 */
export async function apiToggleSummaryTask(options) {
    return unwrap(await remote().toggleSummaryTask(options));
}
/**
 * Run a summary task now.
 * @param options - Mutation options: task id.
 * @returns SummaryTaskRunResult.
 */
export async function apiRunSummaryTask(options) {
    return unwrap(await remote().runSummaryTask(options));
}
/**
 * List summary records (optionally filtered by task).
 * @param options - Query options: optional taskId filter.
 * @returns SummaryRecordSnapshot.
 */
export async function apiListSummaryRecords(options) {
    return unwrap(await remote().listSummaryRecords(options));
}
/**
 * Delete a summary record by id.
 * @param options - Mutation options: record id.
 * @returns SummaryTaskMutationResult.
 */
export async function apiDeleteSummaryRecord(options) {
    return unwrap(await remote().deleteSummaryRecord(options));
}
/**
 * List extracted WeChat tasks.
 * @returns TasksSnapshot.
 */
export async function apiListTasks() {
    return unwrap(await remote().listTasks());
}
/**
 * List native WeChat reminders.
 * @returns HandoffRemindsSnapshot.
 */
export async function apiGetHandoffReminds() {
    return unwrap(await remote().getHandoffReminds());
}
/**
 * Import native reminders into the plugin task store.
 * @returns TaskMutationResult with added count.
 */
export async function apiSyncHandoffTasks() {
    return unwrap(await remote().syncHandoffTasks());
}
/**
 * Add one manual task.
 * @param options - title and optional due epoch ms.
 * @returns TaskMutationResult.
 */
export async function apiAddTask(options) {
    return unwrap(await remote().addTask(options));
}
/**
 * Set a task status.
 * @param options - task id and target status.
 * @returns TaskMutationResult.
 */
export async function apiSetTaskStatus(options) {
    return unwrap(await remote().setTaskStatus(options));
}
/**
 * Delete a task.
 * @param options - task id.
 * @returns TaskMutationResult.
 */
export async function apiDeleteTask(options) {
    return unwrap(await remote().deleteTask(options));
}
/**
 * Extract todo/reminder items from recent messages via DSH LLM.
 * @param options - optional lookback days.
 * @returns TaskMutationResult with added count.
 */
export async function apiExtractTasks(options) {
    return unwrap(await remote().extractTasks(options));
}
/**
 * Fetch the avatar for a username.
 * @param options - Query options: username.
 * @returns AvatarResult.
 */
export async function apiGetAvatar(options) {
    return unwrap(await remote().getAvatar(options));
}
/**
 * 批量读取本地头像(head_image.db,单次请求,纯本地)。
 * @param options - usernames 列表。
 * @returns username → data URL。
 */
export async function apiGetAvatarsLocal(options) {
    return unwrap(await remote().getAvatarsLocal(options));
}
/**
 * Fetch the full WeChat config (including keys-related settings).
 * @returns WechatConfigFull.
 */
export async function apiGetWechatConfigFull() {
    return unwrap(await remote().getWechatConfigFull());
}
/**
 * Save a WeChat config patch.
 * @param options - Mutation options: the config patch.
 * @returns SimpleResult.
 */
/** Open the owned WeChat config.json (e.g. for manual edit). @returns the opened path. */
/** Open an owned path (dir/file) with the system default. @returns the opened path. */
export async function apiOpenPath(path) {
    return unwrap(await remote().openPath({ path }));
}
export async function apiOpenConfig() {
    return unwrap(await remote().openConfig());
}
export async function apiSaveWechatConfig(options) {
    return unwrap(await remote().saveWechatConfig(options));
}
/**
 * Detect locally installed WeChat accounts.
 * @returns AccountsSnapshot.
 */
export async function apiDetectWechatAccounts() {
    return unwrap(await remote().detectWechatAccounts());
}
/**
 * Auto-recover the V4 database key from the running WeChat process.
 * @param options - optional probe db path and install dir.
 * @returns AutoDbKeyResult: ok + 64-hex key, or an error.
 */
export async function apiAutoGetDbKey(options = {}) {
    return unwrap(await remote().autoGetDbKey(options));
}
/**
 * Auto-recover the image key from the running WeChat process (V2-verified).
 * @param options - account dir (wxid_* folder) and optional pid.
 * @returns AutoImageKeyResult: ok + xor/aes pair, or an error.
 */
export async function apiAutoGetImageKey(options = {}) {
    return unwrap(await remote().autoGetImageKey(options));
}
/**
 * Verify a decrypted database key against a database file.
 * @param options - Mutation options: dbPath and encKeyHex.
 * @returns VerifyKeyResult.
 */
export async function apiVerifyDatabaseKey(options) {
    return unwrap(await remote().verifyDatabaseKey(options));
}
/**
 * Generate a keys file from the given encrypted key.
 * @param options - Mutation options: dbDir, keysFile, encKeyHex, optional keyFormat.
 * @returns GenerateKeysResult.
 */
export async function apiGenerateKeysFile(options) {
    return unwrap(await remote().generateKeysFile(options));
}
/**
 * Fetch information about loaded WeChat keys.
 * @returns KeysInfoResult.
 */
export async function apiGetWechatKeysInfo() {
    return unwrap(await remote().getWechatKeysInfo());
}
/**
 * Verify the saved image key pair against real V2 templates.
 * @returns VerifyImageKeyResult: verified flag + xor/template evidence.
 */
export async function apiVerifyImageKey() {
    return unwrap(await remote().verifyImageKey());
}
/**
 * Full SQLCipher decryption of every db under db_storage.
 * @returns DecryptAllResult: total/ok/failed counts.
 */
export async function apiDecryptAllDatabases() {
    return unwrap(await remote().decryptAllDatabases());
}
/**
 * Batch-decode every md5-prefixed .dat image into the decoded-images cache.
 * @param options - optional worker concurrency.
 * @returns DecryptImagesResult: total/ok/failed/skipped counts.
 */
export async function apiDecryptAllImages(options) {
    return unwrap(await remote().decryptAllImages(options));
}
/**
 * Read the live decryption progress snapshot.
 * @returns DecryptStatus: op/done/total/failed/skipped + current item.
 */
export async function apiGetDecryptStatus() {
    return unwrap(await remote().getDecryptStatus());
}
/**
 * Read Whisper transcription configuration status.
 * @returns WhisperStatus: engine detection, CUDA presence, model inventory.
 */
export async function apiGetWhisperStatus() {
    return unwrap(await remote().getWhisperStatus());
}
/**
 * Download one official whisper.cpp ggml model into the models dir.
 * @param options - model id to download.
 * @returns WhisperDownloadResult: ok + file/bytes, or an error.
 */
export async function apiDownloadWhisperModel(options) {
    return unwrap(await remote().downloadWhisperModel(options));
}
/**
 * Download + install the whisper.cpp CLI engine into the models dir.
 * @returns WhisperDownloadResult: ok + path, or an error.
 */
export async function apiInstallWhisperEngine() {
    return unwrap(await remote().installWhisperEngine());
}
/**
 * Batch-transcribe the most recent voice messages (silk → whisper-cli).
 * @param options - optional message count.
 * @returns VoiceTranscribeResult: done/failed/skipped counts.
 */
export async function apiTranscribeVoiceBatch(options) {
    return unwrap(await remote().transcribeVoiceBatch(options));
}
/**
 * Cached transcript for one voice message.
 * @param options - username + local_id.
 * @returns VoiceTranscriptResult.
 */
export async function apiGetVoiceTranscript(options) {
    return unwrap(await remote().getVoiceTranscript(options));
}
/**
 * Transcribe one voice message on demand (chat bubble 语音转文字).
 * @param options - username + local_id.
 * @returns VoiceTranscribeOneResult: ok + text, or error.
 */
export async function apiTranscribeVoiceMessage(options) {
    return unwrap(await remote().transcribeVoiceMessage(options));
}
/**
 * Enable or disable CDN image handling.
 * @param options - Mutation options: enabled flag.
 * @returns SimpleResult.
 */
export async function apiSetCdnImageEnabled(options) {
    return unwrap(await remote().setCdnImageEnabled(options));
}
/**
 * Enable or disable local decryption of CDN images.
 * @param options - Mutation options: localDecrypt flag.
 * @returns SimpleResult.
 */
export async function apiSetCdnImageLocalDecrypt(options) {
    return unwrap(await remote().setCdnImageLocalDecrypt(options));
}
/**
 * Delete favorite items by ids.
 * @param options - Mutation options: favorite item ids.
 * @returns DeleteFavoriteResult.
 */
export async function apiDeleteFavoriteItems(options) {
    const r = await remote().deleteFavoriteItems(options);
    invalidateWechatCache('favorites');
    return unwrap(r);
}
/**
 * Fetch the annual report for a year.
 * @param options - Query options: the report year.
 * @returns AnnualReport.
 */
export async function apiGetAnnualReport(options) {
    return unwrap(await remote().getAnnualReport(options));
}
let _status = 'unknown';
const _listeners = new Set();
/**
 * Return the current Remote gateway readiness status.
 * @returns ApiStatus ('unknown' | 'online' | 'offline').
 */
export function getApiStatus() { return _status; }
/**
 * Subscribe to Remote gateway status changes.
 * @param fn - Callback invoked when the status changes.
 * @returns An unsubscribe function that removes the listener.
 */
export function subscribeApiStatus(fn) {
    _listeners.add(fn);
    return () => { _listeners.delete(fn); };
}
function setApiStatus(s) {
    if (_status === s)
        return;
    _status = s;
    for (const fn of _listeners) {
        try {
            fn();
        }
        catch { /* ignore */ }
    }
}
/**
 * Probe the WeChat Remote gateway (local decrypted data ready).
 * @returns true when the gateway responds to a minimal getSessions probe, false otherwise.
 */
export async function checkApiHealth() {
    try {
        await remote().getSessions({ limit: 1 });
        setApiStatus('online');
        return true;
    }
    catch {
        setApiStatus('offline');
        return false;
    }
}
//# sourceMappingURL=api.js.map