var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
/**
 * WeChatDataGateway — Host Remote service exposing st_control's decrypted
 * WeChat SQLite through the DSH Typert RPC. The browser client calls
 * ctx.remote.wechatData.* instead of an HTTP API.
 */
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { querySessions } from "./query/sessions.js";
import { queryGroupInfo } from "./query/group-info.js";
import { queryPaymentStatus } from "./query/payments.js";
import { queryContacts } from "./query/contacts.js";
import { queryRegionMap } from "./query/region-map.js";
import { queryMessageByServerId, queryMessages, queryNewMessages } from "./query/messages.js";
import { queryMoments, queryMomentsAuthors } from "./query/moments.js";
import { deleteFavoriteItems, queryFavorites } from "./query/favorites.js";
import { queryFiles } from "./query/files.js";
import { queryOverview } from "./query/overview.js";
import { queryRecords, queryRevoked } from "./query/records.js";
import { queryEmoticons } from "./query/emoticons.js";
import { queryStorageStats } from "./query/storage.js";
import { queryAnnual } from "./query/annual.js";
import { queryWechatConfig } from "./query/settings.js";
import { resolveSelfUsername } from "./query/config.js";
/** Compact, readable daily digest for the no-LLM fallback (short per-message previews). */
function compactDailyDigest(lines) {
    const parts = [];
    let lastSession = '';
    let shown = 0;
    for (const line of lines) {
        const m = line.match(/^【(.+?)】/);
        if (m && m[1]) {
            lastSession = m[1];
            parts.push('\n【' + lastSession + '】');
            continue;
        }
        if (shown >= 6) {
            parts.push('……');
            break;
        }
        const s = line.replace(/\s+/g, ' ').slice(0, 48);
        parts.push('- ' + s + (line.length > 48 ? '…' : ''));
        shown += 1;
    }
    return parts.join('\n');
}
import { startRealtimeSync } from "./query/sync.js";
import { openNativePath } from '@deepseek-ai/dsh-native-command';
import { queryPrivacyScan } from "./query/privacy.js";
import { queryGraph } from "./query/graph.js";
import { getDailyCounts } from "./query/calendar.js";
import { buildSearchIndex, getSearchIndexStatus, searchIndexMessages } from "./query/search.js";
import { searchMembers } from "./query/members.js";
import { decodeImageDataUrl } from "./query/media-image.js";
import { resolveSnsImageDataUrl } from "./query/sns-image.js";
import { resolveArticleCoverDataUrl } from "./query/article-cover.js";
import { resolveMessageFileDataUrl } from "./query/media-file.js";
import { queryOverviewInsights } from "./query/overview-insights.js";
import { getDbStatus } from "./query/status.js";
import { resolveVoiceInfo } from "./query/media-voice.js";
import { resolveVideoInfo } from "./query/media-video.js";
import { resolveAvatar, resolveAvatarsLocal } from "./query/avatar.js";
import { detectWechatAccounts, generateKeysFile, getConfig, getKeysInfo, saveConfig, verifyDatabaseKey, weixinInstallPath, weixinVersion } from "./query/config.js";
import { fetchDbKey, fetchImageKey, normalizeAccountDir } from "./keys/service.js";
import { scanV2Templates, trustedXorForVerifiedAesKey } from "./keys/image-key-resolver.js";
import { decryptAllDbs } from "./query/decrypt-all.js";
import { decryptAllImageDats } from "./query/decrypt-images.js";
import { WHISPER_DOWNLOAD_FILES, defaultWhisperModelsDir, installWhisperEngine, migrateWhisperEngineDir, migrateWhisperModels, whisperDownloadModel, whisperEnginePath, whisperHasCuda, whisperModelsStatus } from "./query/whisper.js";
import { cachedTranscript, transcribeOneVoice, transcribeVoiceBatch } from "./query/voice-transcribe.js";
import { svrIdByChatLocal } from "./query/voice.js";
import { exportAllSessions, exportAnnualReport, exportCsv, exportMoments, exportSessionMessages } from "./query/export.js";
import { buildAskContext } from "./query/ask.js";
import { createBackup as createBackupEntry, deleteBackup as deleteBackupEntry, listBackups as listBackupEntries, previewBackup as previewBackupEntry } from "./query/backup.js";
import { collectDayMessages, collectPeriodMessages } from "./query/daily-summary.js";
import { queryLedger } from "./query/ledger.js";
import { queryContact360 } from "./query/contact360.js";
import { queryDbHealth } from "./query/db-health.js";
import { queryGroupInsights } from "./query/group-insights.js";
import { queryAssetInsights } from "./query/asset-insights.js";
import { queryMediaAssets } from "./query/media-assets.js";
import { queryMomentsInsights } from "./query/moments-insights.js";
import { queryMomentsMonthly } from "./query/moments-monthly.js";
import { queryOfficialAssets } from "./query/official-assets.js";
import { clearOperationLog, listOperations, recordOperation } from "./query/operation-log.js";
import { clearPrivacyAudit, getPrivacyStateSnapshot, listPrivacyAudit, writePrivacySettings } from "./query/privacy-audit.js";
import { importHandoffTasks, listHandoffReminds } from "./query/handoff.js";
import { deleteTask, insertTask, listTasks as listWechatTasks, setTaskStatus } from "./query/wechat-tasks.js";
import { createEncryptedBackup, restoreEncryptedBackup } from "./query/backup.js";
import { searchUnified } from "./query/unified-search.js";
import { resolveSnsVideoCoverDataUrl, resolveSnsVideoDataUrl } from "./query/sns-video.js";
import { queryAnnualReport } from "./query/annual-report.js";
import { editChatMessage as editMsg, listEditedMessages as listEdits, resetEditedMessage as resetEdit } from "./query/edit.js";
import { clearAllSessionDrafts as clearAllDrafts, clearSessionDraft as clearDraft } from "./query/drafts.js";
import { invalidateWechatMeta } from "./query/meta.js";
import { deleteSummaryRecord as delRec, deleteSummaryTask as delTask, listSummaryRecords as listRecs, listSummaryTasks as listTasks, saveSummaryRecord as saveRec, saveSummaryTask as saveTask, toggleSummaryTask as toggleTask, updateSummaryTaskRunState } from "./query/summary-tasks.js";
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { bootstrapWechatData, resolveDecodedDir, resolveDecryptedDir } from "./dirs.js";
/**
 * Raw WeChat data base dir (the account root, parent of db_storage): env pin
 * first, then the live config db_dir. Resolved per call — config.json may be
 * bootstrapped or re-pointed after the gateway started, and a startup
 * snapshot would stay empty and leave media resolution dead.
 * @param decrypted - decrypted data root (locates config.json).
 * @returns the account root, or '' when config has no usable db_dir.
 */
function rawWechatBase(decrypted) {
    const pinned = process.env.DSH_WECHAT_BASE_DIR;
    if (pinned && pinned.trim().length > 0)
        return pinned.trim();
    const cfg = getConfig(decrypted);
    const dbDir = typeof cfg['db_dir'] === 'string' ? cfg['db_dir'] : '';
    if (!dbDir)
        return '';
    const parts = dbDir.replace(/[\\/]+$/, '').split(/[\\/]/);
    return (parts[parts.length - 1] ?? '') === 'db_storage' ? parts.slice(0, -1).join('/') : '';
}
/** Resolve the data layout and run the one-time bootstrap. */
function resolveDirs() {
    bootstrapWechatData();
    return { decrypted: resolveDecryptedDir(), decoded: resolveDecodedDir() };
}
/** Coerce a config cell to a string (null -> '', else String()). */
function cellStr(v) {
    if (typeof v === 'string')
        return v;
    if (v === null || v === undefined)
        return '';
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol')
        return String(v);
    return '';
}
/** Remote-only service exposing WeChat data queries. */
let WechatDataGateway = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _getSessions_decorators;
    let _getContacts_decorators;
    let _getOverviewInsights_decorators;
    let _getOverview_decorators;
    let _getRegionMap_decorators;
    let _getRecords_decorators;
    let _searchMembers_decorators;
    let _getRevoked_decorators;
    let _getEmoticons_decorators;
    let _getStorageStats_decorators;
    let _getAnnual_decorators;
    let _getWechatConfig_decorators;
    let _getPrivacyScan_decorators;
    let _getGraph_decorators;
    let _getMoments_decorators;
    let _getSelfUsername_decorators;
    let _getMomentsAuthors_decorators;
    let _getFavorites_decorators;
    let _getFiles_decorators;
    let _getMessages_decorators;
    let _getNewMessages_decorators;
    let _getSearchIndexStatus_decorators;
    let _buildSearchIndex_decorators;
    let _searchMessages_decorators;
    let _getGroupInfo_decorators;
    let _getPaymentStatus_decorators;
    let _resolveChatHistory_decorators;
    let _getDailyCounts_decorators;
    let _getVoiceInfo_decorators;
    let _getVideoInfo_decorators;
    let _exportSessionMessages_decorators;
    let _askWechat_decorators;
    let _listBackups_decorators;
    let _previewBackup_decorators;
    let _createBackup_decorators;
    let _deleteBackup_decorators;
    let _generateDailySummary_decorators;
    let _listEditedMessages_decorators;
    let _editChatMessage_decorators;
    let _resetEditedMessage_decorators;
    let _listLlmProviders_decorators;
    let _listLlmModels_decorators;
    let _exportAnnualReport_decorators;
    let _exportAllSessions_decorators;
    let _exportMoments_decorators;
    let _exportCsv_decorators;
    let _clearSessionDraft_decorators;
    let _clearAllSessionDrafts_decorators;
    let _listSummaryTasks_decorators;
    let _saveSummaryTask_decorators;
    let _deleteSummaryTask_decorators;
    let _toggleSummaryTask_decorators;
    let _listSummaryRecords_decorators;
    let _deleteSummaryRecord_decorators;
    let _runSummaryTask_decorators;
    let _getAvatar_decorators;
    let _getAvatarsLocal_decorators;
    let _getWechatConfigFull_decorators;
    let _saveWechatConfig_decorators;
    let _getWhisperStatus_decorators;
    let _downloadWhisperModel_decorators;
    let _detectWechatAccounts_decorators;
    let _verifyDatabaseKey_decorators;
    let _generateKeysFile_decorators;
    let _getWechatKeysInfo_decorators;
    let _autoGetDbKey_decorators;
    let _autoGetImageKey_decorators;
    let _openPath_decorators;
    let _openConfig_decorators;
    let _verifyImageKey_decorators;
    let _decryptAllDatabases_decorators;
    let _decryptAllImages_decorators;
    let _getDecryptStatus_decorators;
    let _installWhisperEngine_decorators;
    let _transcribeVoiceBatch_decorators;
    let _getVoiceTranscript_decorators;
    let _transcribeVoiceMessage_decorators;
    let _setCdnImageEnabled_decorators;
    let _setCdnImageLocalDecrypt_decorators;
    let _deleteFavoriteItems_decorators;
    let _getAnnualReport_decorators;
    let _getDbStatus_decorators;
    let _getImageDataUrl_decorators;
    let _getSnsImageDataUrl_decorators;
    let _getArticleCover_decorators;
    let _getMessageFile_decorators;
    let _addTask_decorators;
    let _clearOperationLog_decorators;
    let _clearPrivacyAudit_decorators;
    let _createEncryptedBackup_decorators;
    let _deleteTask_decorators;
    let _extractTasks_decorators;
    let _generatePeriodSummary_decorators;
    let _getAssetInsights_decorators;
    let _getContact360_decorators;
    let _getDbHealth_decorators;
    let _getGroupInsights_decorators;
    let _getHandoffReminds_decorators;
    let _getLedger_decorators;
    let _getMediaAssets_decorators;
    let _getMomentsInsights_decorators;
    let _getMomentsMonthly_decorators;
    let _getOfficialAssets_decorators;
    let _getOperationLog_decorators;
    let _getPrivacyAuditRows_decorators;
    let _getPrivacyState_decorators;
    let _getSnsVideoCoverDataUrl_decorators;
    let _getSnsVideoDataUrl_decorators;
    let _listTasks_decorators;
    let _restoreBackup_decorators;
    let _searchUnified_decorators;
    let _setPrivacyState_decorators;
    let _setTaskStatus_decorators;
    let _syncHandoffTasks_decorators;
    return class WechatDataGateway extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _getSessions_decorators = [Remote('getSessions')];
            _getContacts_decorators = [Remote('getContacts')];
            _getOverviewInsights_decorators = [Remote('getOverviewInsights')];
            _getOverview_decorators = [Remote('getOverview')];
            _getRegionMap_decorators = [Remote('getRegionMap')];
            _getRecords_decorators = [Remote('getRecords')];
            _searchMembers_decorators = [Remote('searchMembers')];
            _getRevoked_decorators = [Remote('getRevoked')];
            _getEmoticons_decorators = [Remote('getEmoticons')];
            _getStorageStats_decorators = [Remote('getStorageStats')];
            _getAnnual_decorators = [Remote('getAnnual')];
            _getWechatConfig_decorators = [Remote('getWechatConfig')];
            _getPrivacyScan_decorators = [Remote('getPrivacyScan')];
            _getGraph_decorators = [Remote('getGraph')];
            _getMoments_decorators = [Remote('getMoments')];
            _getSelfUsername_decorators = [Remote('getSelfUsername')];
            _getMomentsAuthors_decorators = [Remote('getMomentsAuthors')];
            _getFavorites_decorators = [Remote('getFavorites')];
            _getFiles_decorators = [Remote('getFiles')];
            _getMessages_decorators = [Remote('getMessages')];
            _getNewMessages_decorators = [Remote('getNewMessages')];
            _getSearchIndexStatus_decorators = [Remote('getSearchIndexStatus')];
            _buildSearchIndex_decorators = [Remote('buildSearchIndex')];
            _searchMessages_decorators = [Remote('searchMessages')];
            _getGroupInfo_decorators = [Remote('getGroupInfo')];
            _getPaymentStatus_decorators = [Remote('getPaymentStatus')];
            _resolveChatHistory_decorators = [Remote('resolveChatHistory')];
            _getDailyCounts_decorators = [Remote('getDailyCounts')];
            _getVoiceInfo_decorators = [Remote('getVoiceInfo')];
            _getVideoInfo_decorators = [Remote('getVideoInfo')];
            _exportSessionMessages_decorators = [Remote('exportSessionMessages')];
            _askWechat_decorators = [Remote('askWechat')];
            _listBackups_decorators = [Remote('listBackups')];
            _previewBackup_decorators = [Remote('previewBackup')];
            _createBackup_decorators = [Remote('createBackup')];
            _deleteBackup_decorators = [Remote('deleteBackup')];
            _generateDailySummary_decorators = [Remote('generateDailySummary')];
            _listEditedMessages_decorators = [Remote('listEditedMessages')];
            _editChatMessage_decorators = [Remote('editChatMessage')];
            _resetEditedMessage_decorators = [Remote('resetEditedMessage')];
            _listLlmProviders_decorators = [Remote('listLlmProviders')];
            _listLlmModels_decorators = [Remote('listLlmModels')];
            _exportAnnualReport_decorators = [Remote('exportAnnualReport')];
            _exportAllSessions_decorators = [Remote('exportAllSessions')];
            _exportMoments_decorators = [Remote('exportMoments')];
            _exportCsv_decorators = [Remote('exportCsv')];
            _clearSessionDraft_decorators = [Remote('clearSessionDraft')];
            _clearAllSessionDrafts_decorators = [Remote('clearAllSessionDrafts')];
            _listSummaryTasks_decorators = [Remote('listSummaryTasks')];
            _saveSummaryTask_decorators = [Remote('saveSummaryTask')];
            _deleteSummaryTask_decorators = [Remote('deleteSummaryTask')];
            _toggleSummaryTask_decorators = [Remote('toggleSummaryTask')];
            _listSummaryRecords_decorators = [Remote('listSummaryRecords')];
            _deleteSummaryRecord_decorators = [Remote('deleteSummaryRecord')];
            _runSummaryTask_decorators = [Remote('runSummaryTask')];
            _getAvatar_decorators = [Remote('getAvatar')];
            _getAvatarsLocal_decorators = [Remote('getAvatarsLocal')];
            _getWechatConfigFull_decorators = [Remote('getWechatConfigFull')];
            _saveWechatConfig_decorators = [Remote('saveWechatConfig')];
            _getWhisperStatus_decorators = [Remote('getWhisperStatus')];
            _downloadWhisperModel_decorators = [Remote('downloadWhisperModel')];
            _detectWechatAccounts_decorators = [Remote('detectWechatAccounts')];
            _verifyDatabaseKey_decorators = [Remote('verifyDatabaseKey')];
            _generateKeysFile_decorators = [Remote('generateKeysFile')];
            _getWechatKeysInfo_decorators = [Remote('getWechatKeysInfo')];
            _autoGetDbKey_decorators = [Remote('autoGetDbKey')];
            _autoGetImageKey_decorators = [Remote('autoGetImageKey')];
            _openPath_decorators = [Remote('openPath')];
            _openConfig_decorators = [Remote('openConfig')];
            _verifyImageKey_decorators = [Remote('verifyImageKey')];
            _decryptAllDatabases_decorators = [Remote('decryptAllDatabases')];
            _decryptAllImages_decorators = [Remote('decryptAllImages')];
            _getDecryptStatus_decorators = [Remote('getDecryptStatus')];
            _installWhisperEngine_decorators = [Remote('installWhisperEngine')];
            _transcribeVoiceBatch_decorators = [Remote('transcribeVoiceBatch')];
            _getVoiceTranscript_decorators = [Remote('getVoiceTranscript')];
            _transcribeVoiceMessage_decorators = [Remote('transcribeVoiceMessage')];
            _setCdnImageEnabled_decorators = [Remote('setCdnImageEnabled')];
            _setCdnImageLocalDecrypt_decorators = [Remote('setCdnImageLocalDecrypt')];
            _deleteFavoriteItems_decorators = [Remote('deleteFavoriteItems')];
            _getAnnualReport_decorators = [Remote('getAnnualReport')];
            _getDbStatus_decorators = [Remote('getDbStatus')];
            _getImageDataUrl_decorators = [Remote('getImageDataUrl')];
            _getSnsImageDataUrl_decorators = [Remote('getSnsImageDataUrl')];
            _getArticleCover_decorators = [Remote('getArticleCover')];
            _getMessageFile_decorators = [Remote('getMessageFile')];
            _addTask_decorators = [Remote('addTask')];
            _clearOperationLog_decorators = [Remote('clearOperationLog')];
            _clearPrivacyAudit_decorators = [Remote('clearPrivacyAudit')];
            _createEncryptedBackup_decorators = [Remote('createEncryptedBackup')];
            _deleteTask_decorators = [Remote('deleteTask')];
            _extractTasks_decorators = [Remote('extractTasks')];
            _generatePeriodSummary_decorators = [Remote('generatePeriodSummary')];
            _getAssetInsights_decorators = [Remote('getAssetInsights')];
            _getContact360_decorators = [Remote('getContact360')];
            _getDbHealth_decorators = [Remote('getDbHealth')];
            _getGroupInsights_decorators = [Remote('getGroupInsights')];
            _getHandoffReminds_decorators = [Remote('getHandoffReminds')];
            _getLedger_decorators = [Remote('getLedger')];
            _getMediaAssets_decorators = [Remote('getMediaAssets')];
            _getMomentsInsights_decorators = [Remote('getMomentsInsights')];
            _getMomentsMonthly_decorators = [Remote('getMomentsMonthly')];
            _getOfficialAssets_decorators = [Remote('getOfficialAssets')];
            _getOperationLog_decorators = [Remote('getOperationLog')];
            _getPrivacyAuditRows_decorators = [Remote('getPrivacyAuditRows')];
            _getPrivacyState_decorators = [Remote('getPrivacyState')];
            _getSnsVideoCoverDataUrl_decorators = [Remote('getSnsVideoCoverDataUrl')];
            _getSnsVideoDataUrl_decorators = [Remote('getSnsVideoDataUrl')];
            _listTasks_decorators = [Remote('listTasks')];
            _restoreBackup_decorators = [Remote('restoreBackup')];
            _searchUnified_decorators = [Remote('searchUnified')];
            _setPrivacyState_decorators = [Remote('setPrivacyState')];
            _setTaskStatus_decorators = [Remote('setTaskStatus')];
            _syncHandoffTasks_decorators = [Remote('syncHandoffTasks')];
            __esDecorate(this, null, _getSessions_decorators, { kind: "method", name: "getSessions", static: false, private: false, access: { has: obj => "getSessions" in obj, get: obj => obj.getSessions }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getContacts_decorators, { kind: "method", name: "getContacts", static: false, private: false, access: { has: obj => "getContacts" in obj, get: obj => obj.getContacts }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getOverviewInsights_decorators, { kind: "method", name: "getOverviewInsights", static: false, private: false, access: { has: obj => "getOverviewInsights" in obj, get: obj => obj.getOverviewInsights }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getOverview_decorators, { kind: "method", name: "getOverview", static: false, private: false, access: { has: obj => "getOverview" in obj, get: obj => obj.getOverview }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getRegionMap_decorators, { kind: "method", name: "getRegionMap", static: false, private: false, access: { has: obj => "getRegionMap" in obj, get: obj => obj.getRegionMap }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getRecords_decorators, { kind: "method", name: "getRecords", static: false, private: false, access: { has: obj => "getRecords" in obj, get: obj => obj.getRecords }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _searchMembers_decorators, { kind: "method", name: "searchMembers", static: false, private: false, access: { has: obj => "searchMembers" in obj, get: obj => obj.searchMembers }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getRevoked_decorators, { kind: "method", name: "getRevoked", static: false, private: false, access: { has: obj => "getRevoked" in obj, get: obj => obj.getRevoked }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getEmoticons_decorators, { kind: "method", name: "getEmoticons", static: false, private: false, access: { has: obj => "getEmoticons" in obj, get: obj => obj.getEmoticons }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getStorageStats_decorators, { kind: "method", name: "getStorageStats", static: false, private: false, access: { has: obj => "getStorageStats" in obj, get: obj => obj.getStorageStats }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getAnnual_decorators, { kind: "method", name: "getAnnual", static: false, private: false, access: { has: obj => "getAnnual" in obj, get: obj => obj.getAnnual }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getWechatConfig_decorators, { kind: "method", name: "getWechatConfig", static: false, private: false, access: { has: obj => "getWechatConfig" in obj, get: obj => obj.getWechatConfig }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getPrivacyScan_decorators, { kind: "method", name: "getPrivacyScan", static: false, private: false, access: { has: obj => "getPrivacyScan" in obj, get: obj => obj.getPrivacyScan }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getGraph_decorators, { kind: "method", name: "getGraph", static: false, private: false, access: { has: obj => "getGraph" in obj, get: obj => obj.getGraph }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getMoments_decorators, { kind: "method", name: "getMoments", static: false, private: false, access: { has: obj => "getMoments" in obj, get: obj => obj.getMoments }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getSelfUsername_decorators, { kind: "method", name: "getSelfUsername", static: false, private: false, access: { has: obj => "getSelfUsername" in obj, get: obj => obj.getSelfUsername }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getMomentsAuthors_decorators, { kind: "method", name: "getMomentsAuthors", static: false, private: false, access: { has: obj => "getMomentsAuthors" in obj, get: obj => obj.getMomentsAuthors }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getFavorites_decorators, { kind: "method", name: "getFavorites", static: false, private: false, access: { has: obj => "getFavorites" in obj, get: obj => obj.getFavorites }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getFiles_decorators, { kind: "method", name: "getFiles", static: false, private: false, access: { has: obj => "getFiles" in obj, get: obj => obj.getFiles }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getMessages_decorators, { kind: "method", name: "getMessages", static: false, private: false, access: { has: obj => "getMessages" in obj, get: obj => obj.getMessages }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getNewMessages_decorators, { kind: "method", name: "getNewMessages", static: false, private: false, access: { has: obj => "getNewMessages" in obj, get: obj => obj.getNewMessages }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getSearchIndexStatus_decorators, { kind: "method", name: "getSearchIndexStatus", static: false, private: false, access: { has: obj => "getSearchIndexStatus" in obj, get: obj => obj.getSearchIndexStatus }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _buildSearchIndex_decorators, { kind: "method", name: "buildSearchIndex", static: false, private: false, access: { has: obj => "buildSearchIndex" in obj, get: obj => obj.buildSearchIndex }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _searchMessages_decorators, { kind: "method", name: "searchMessages", static: false, private: false, access: { has: obj => "searchMessages" in obj, get: obj => obj.searchMessages }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getGroupInfo_decorators, { kind: "method", name: "getGroupInfo", static: false, private: false, access: { has: obj => "getGroupInfo" in obj, get: obj => obj.getGroupInfo }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getPaymentStatus_decorators, { kind: "method", name: "getPaymentStatus", static: false, private: false, access: { has: obj => "getPaymentStatus" in obj, get: obj => obj.getPaymentStatus }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _resolveChatHistory_decorators, { kind: "method", name: "resolveChatHistory", static: false, private: false, access: { has: obj => "resolveChatHistory" in obj, get: obj => obj.resolveChatHistory }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getDailyCounts_decorators, { kind: "method", name: "getDailyCounts", static: false, private: false, access: { has: obj => "getDailyCounts" in obj, get: obj => obj.getDailyCounts }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getVoiceInfo_decorators, { kind: "method", name: "getVoiceInfo", static: false, private: false, access: { has: obj => "getVoiceInfo" in obj, get: obj => obj.getVoiceInfo }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getVideoInfo_decorators, { kind: "method", name: "getVideoInfo", static: false, private: false, access: { has: obj => "getVideoInfo" in obj, get: obj => obj.getVideoInfo }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _exportSessionMessages_decorators, { kind: "method", name: "exportSessionMessages", static: false, private: false, access: { has: obj => "exportSessionMessages" in obj, get: obj => obj.exportSessionMessages }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _askWechat_decorators, { kind: "method", name: "askWechat", static: false, private: false, access: { has: obj => "askWechat" in obj, get: obj => obj.askWechat }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _listBackups_decorators, { kind: "method", name: "listBackups", static: false, private: false, access: { has: obj => "listBackups" in obj, get: obj => obj.listBackups }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _previewBackup_decorators, { kind: "method", name: "previewBackup", static: false, private: false, access: { has: obj => "previewBackup" in obj, get: obj => obj.previewBackup }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _createBackup_decorators, { kind: "method", name: "createBackup", static: false, private: false, access: { has: obj => "createBackup" in obj, get: obj => obj.createBackup }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _deleteBackup_decorators, { kind: "method", name: "deleteBackup", static: false, private: false, access: { has: obj => "deleteBackup" in obj, get: obj => obj.deleteBackup }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _generateDailySummary_decorators, { kind: "method", name: "generateDailySummary", static: false, private: false, access: { has: obj => "generateDailySummary" in obj, get: obj => obj.generateDailySummary }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _listEditedMessages_decorators, { kind: "method", name: "listEditedMessages", static: false, private: false, access: { has: obj => "listEditedMessages" in obj, get: obj => obj.listEditedMessages }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _editChatMessage_decorators, { kind: "method", name: "editChatMessage", static: false, private: false, access: { has: obj => "editChatMessage" in obj, get: obj => obj.editChatMessage }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _resetEditedMessage_decorators, { kind: "method", name: "resetEditedMessage", static: false, private: false, access: { has: obj => "resetEditedMessage" in obj, get: obj => obj.resetEditedMessage }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _listLlmProviders_decorators, { kind: "method", name: "listLlmProviders", static: false, private: false, access: { has: obj => "listLlmProviders" in obj, get: obj => obj.listLlmProviders }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _listLlmModels_decorators, { kind: "method", name: "listLlmModels", static: false, private: false, access: { has: obj => "listLlmModels" in obj, get: obj => obj.listLlmModels }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _exportAnnualReport_decorators, { kind: "method", name: "exportAnnualReport", static: false, private: false, access: { has: obj => "exportAnnualReport" in obj, get: obj => obj.exportAnnualReport }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _exportAllSessions_decorators, { kind: "method", name: "exportAllSessions", static: false, private: false, access: { has: obj => "exportAllSessions" in obj, get: obj => obj.exportAllSessions }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _exportMoments_decorators, { kind: "method", name: "exportMoments", static: false, private: false, access: { has: obj => "exportMoments" in obj, get: obj => obj.exportMoments }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _exportCsv_decorators, { kind: "method", name: "exportCsv", static: false, private: false, access: { has: obj => "exportCsv" in obj, get: obj => obj.exportCsv }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _clearSessionDraft_decorators, { kind: "method", name: "clearSessionDraft", static: false, private: false, access: { has: obj => "clearSessionDraft" in obj, get: obj => obj.clearSessionDraft }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _clearAllSessionDrafts_decorators, { kind: "method", name: "clearAllSessionDrafts", static: false, private: false, access: { has: obj => "clearAllSessionDrafts" in obj, get: obj => obj.clearAllSessionDrafts }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _listSummaryTasks_decorators, { kind: "method", name: "listSummaryTasks", static: false, private: false, access: { has: obj => "listSummaryTasks" in obj, get: obj => obj.listSummaryTasks }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _saveSummaryTask_decorators, { kind: "method", name: "saveSummaryTask", static: false, private: false, access: { has: obj => "saveSummaryTask" in obj, get: obj => obj.saveSummaryTask }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _deleteSummaryTask_decorators, { kind: "method", name: "deleteSummaryTask", static: false, private: false, access: { has: obj => "deleteSummaryTask" in obj, get: obj => obj.deleteSummaryTask }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _toggleSummaryTask_decorators, { kind: "method", name: "toggleSummaryTask", static: false, private: false, access: { has: obj => "toggleSummaryTask" in obj, get: obj => obj.toggleSummaryTask }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _listSummaryRecords_decorators, { kind: "method", name: "listSummaryRecords", static: false, private: false, access: { has: obj => "listSummaryRecords" in obj, get: obj => obj.listSummaryRecords }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _deleteSummaryRecord_decorators, { kind: "method", name: "deleteSummaryRecord", static: false, private: false, access: { has: obj => "deleteSummaryRecord" in obj, get: obj => obj.deleteSummaryRecord }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _runSummaryTask_decorators, { kind: "method", name: "runSummaryTask", static: false, private: false, access: { has: obj => "runSummaryTask" in obj, get: obj => obj.runSummaryTask }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getAvatar_decorators, { kind: "method", name: "getAvatar", static: false, private: false, access: { has: obj => "getAvatar" in obj, get: obj => obj.getAvatar }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getAvatarsLocal_decorators, { kind: "method", name: "getAvatarsLocal", static: false, private: false, access: { has: obj => "getAvatarsLocal" in obj, get: obj => obj.getAvatarsLocal }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getWechatConfigFull_decorators, { kind: "method", name: "getWechatConfigFull", static: false, private: false, access: { has: obj => "getWechatConfigFull" in obj, get: obj => obj.getWechatConfigFull }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _saveWechatConfig_decorators, { kind: "method", name: "saveWechatConfig", static: false, private: false, access: { has: obj => "saveWechatConfig" in obj, get: obj => obj.saveWechatConfig }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getWhisperStatus_decorators, { kind: "method", name: "getWhisperStatus", static: false, private: false, access: { has: obj => "getWhisperStatus" in obj, get: obj => obj.getWhisperStatus }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _downloadWhisperModel_decorators, { kind: "method", name: "downloadWhisperModel", static: false, private: false, access: { has: obj => "downloadWhisperModel" in obj, get: obj => obj.downloadWhisperModel }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _detectWechatAccounts_decorators, { kind: "method", name: "detectWechatAccounts", static: false, private: false, access: { has: obj => "detectWechatAccounts" in obj, get: obj => obj.detectWechatAccounts }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _verifyDatabaseKey_decorators, { kind: "method", name: "verifyDatabaseKey", static: false, private: false, access: { has: obj => "verifyDatabaseKey" in obj, get: obj => obj.verifyDatabaseKey }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _generateKeysFile_decorators, { kind: "method", name: "generateKeysFile", static: false, private: false, access: { has: obj => "generateKeysFile" in obj, get: obj => obj.generateKeysFile }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getWechatKeysInfo_decorators, { kind: "method", name: "getWechatKeysInfo", static: false, private: false, access: { has: obj => "getWechatKeysInfo" in obj, get: obj => obj.getWechatKeysInfo }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _autoGetDbKey_decorators, { kind: "method", name: "autoGetDbKey", static: false, private: false, access: { has: obj => "autoGetDbKey" in obj, get: obj => obj.autoGetDbKey }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _autoGetImageKey_decorators, { kind: "method", name: "autoGetImageKey", static: false, private: false, access: { has: obj => "autoGetImageKey" in obj, get: obj => obj.autoGetImageKey }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _openPath_decorators, { kind: "method", name: "openPath", static: false, private: false, access: { has: obj => "openPath" in obj, get: obj => obj.openPath }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _openConfig_decorators, { kind: "method", name: "openConfig", static: false, private: false, access: { has: obj => "openConfig" in obj, get: obj => obj.openConfig }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _verifyImageKey_decorators, { kind: "method", name: "verifyImageKey", static: false, private: false, access: { has: obj => "verifyImageKey" in obj, get: obj => obj.verifyImageKey }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _decryptAllDatabases_decorators, { kind: "method", name: "decryptAllDatabases", static: false, private: false, access: { has: obj => "decryptAllDatabases" in obj, get: obj => obj.decryptAllDatabases }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _decryptAllImages_decorators, { kind: "method", name: "decryptAllImages", static: false, private: false, access: { has: obj => "decryptAllImages" in obj, get: obj => obj.decryptAllImages }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getDecryptStatus_decorators, { kind: "method", name: "getDecryptStatus", static: false, private: false, access: { has: obj => "getDecryptStatus" in obj, get: obj => obj.getDecryptStatus }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _installWhisperEngine_decorators, { kind: "method", name: "installWhisperEngine", static: false, private: false, access: { has: obj => "installWhisperEngine" in obj, get: obj => obj.installWhisperEngine }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _transcribeVoiceBatch_decorators, { kind: "method", name: "transcribeVoiceBatch", static: false, private: false, access: { has: obj => "transcribeVoiceBatch" in obj, get: obj => obj.transcribeVoiceBatch }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getVoiceTranscript_decorators, { kind: "method", name: "getVoiceTranscript", static: false, private: false, access: { has: obj => "getVoiceTranscript" in obj, get: obj => obj.getVoiceTranscript }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _transcribeVoiceMessage_decorators, { kind: "method", name: "transcribeVoiceMessage", static: false, private: false, access: { has: obj => "transcribeVoiceMessage" in obj, get: obj => obj.transcribeVoiceMessage }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _setCdnImageEnabled_decorators, { kind: "method", name: "setCdnImageEnabled", static: false, private: false, access: { has: obj => "setCdnImageEnabled" in obj, get: obj => obj.setCdnImageEnabled }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _setCdnImageLocalDecrypt_decorators, { kind: "method", name: "setCdnImageLocalDecrypt", static: false, private: false, access: { has: obj => "setCdnImageLocalDecrypt" in obj, get: obj => obj.setCdnImageLocalDecrypt }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _deleteFavoriteItems_decorators, { kind: "method", name: "deleteFavoriteItems", static: false, private: false, access: { has: obj => "deleteFavoriteItems" in obj, get: obj => obj.deleteFavoriteItems }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getAnnualReport_decorators, { kind: "method", name: "getAnnualReport", static: false, private: false, access: { has: obj => "getAnnualReport" in obj, get: obj => obj.getAnnualReport }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getDbStatus_decorators, { kind: "method", name: "getDbStatus", static: false, private: false, access: { has: obj => "getDbStatus" in obj, get: obj => obj.getDbStatus }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getImageDataUrl_decorators, { kind: "method", name: "getImageDataUrl", static: false, private: false, access: { has: obj => "getImageDataUrl" in obj, get: obj => obj.getImageDataUrl }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getSnsImageDataUrl_decorators, { kind: "method", name: "getSnsImageDataUrl", static: false, private: false, access: { has: obj => "getSnsImageDataUrl" in obj, get: obj => obj.getSnsImageDataUrl }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getArticleCover_decorators, { kind: "method", name: "getArticleCover", static: false, private: false, access: { has: obj => "getArticleCover" in obj, get: obj => obj.getArticleCover }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getMessageFile_decorators, { kind: "method", name: "getMessageFile", static: false, private: false, access: { has: obj => "getMessageFile" in obj, get: obj => obj.getMessageFile }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _addTask_decorators, { kind: "method", name: "addTask", static: false, private: false, access: { has: obj => "addTask" in obj, get: obj => obj.addTask }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _clearOperationLog_decorators, { kind: "method", name: "clearOperationLog", static: false, private: false, access: { has: obj => "clearOperationLog" in obj, get: obj => obj.clearOperationLog }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _clearPrivacyAudit_decorators, { kind: "method", name: "clearPrivacyAudit", static: false, private: false, access: { has: obj => "clearPrivacyAudit" in obj, get: obj => obj.clearPrivacyAudit }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _createEncryptedBackup_decorators, { kind: "method", name: "createEncryptedBackup", static: false, private: false, access: { has: obj => "createEncryptedBackup" in obj, get: obj => obj.createEncryptedBackup }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _deleteTask_decorators, { kind: "method", name: "deleteTask", static: false, private: false, access: { has: obj => "deleteTask" in obj, get: obj => obj.deleteTask }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _extractTasks_decorators, { kind: "method", name: "extractTasks", static: false, private: false, access: { has: obj => "extractTasks" in obj, get: obj => obj.extractTasks }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _generatePeriodSummary_decorators, { kind: "method", name: "generatePeriodSummary", static: false, private: false, access: { has: obj => "generatePeriodSummary" in obj, get: obj => obj.generatePeriodSummary }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getAssetInsights_decorators, { kind: "method", name: "getAssetInsights", static: false, private: false, access: { has: obj => "getAssetInsights" in obj, get: obj => obj.getAssetInsights }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getContact360_decorators, { kind: "method", name: "getContact360", static: false, private: false, access: { has: obj => "getContact360" in obj, get: obj => obj.getContact360 }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getDbHealth_decorators, { kind: "method", name: "getDbHealth", static: false, private: false, access: { has: obj => "getDbHealth" in obj, get: obj => obj.getDbHealth }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getGroupInsights_decorators, { kind: "method", name: "getGroupInsights", static: false, private: false, access: { has: obj => "getGroupInsights" in obj, get: obj => obj.getGroupInsights }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getHandoffReminds_decorators, { kind: "method", name: "getHandoffReminds", static: false, private: false, access: { has: obj => "getHandoffReminds" in obj, get: obj => obj.getHandoffReminds }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getLedger_decorators, { kind: "method", name: "getLedger", static: false, private: false, access: { has: obj => "getLedger" in obj, get: obj => obj.getLedger }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getMediaAssets_decorators, { kind: "method", name: "getMediaAssets", static: false, private: false, access: { has: obj => "getMediaAssets" in obj, get: obj => obj.getMediaAssets }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getMomentsInsights_decorators, { kind: "method", name: "getMomentsInsights", static: false, private: false, access: { has: obj => "getMomentsInsights" in obj, get: obj => obj.getMomentsInsights }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getMomentsMonthly_decorators, { kind: "method", name: "getMomentsMonthly", static: false, private: false, access: { has: obj => "getMomentsMonthly" in obj, get: obj => obj.getMomentsMonthly }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getOfficialAssets_decorators, { kind: "method", name: "getOfficialAssets", static: false, private: false, access: { has: obj => "getOfficialAssets" in obj, get: obj => obj.getOfficialAssets }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getOperationLog_decorators, { kind: "method", name: "getOperationLog", static: false, private: false, access: { has: obj => "getOperationLog" in obj, get: obj => obj.getOperationLog }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getPrivacyAuditRows_decorators, { kind: "method", name: "getPrivacyAuditRows", static: false, private: false, access: { has: obj => "getPrivacyAuditRows" in obj, get: obj => obj.getPrivacyAuditRows }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getPrivacyState_decorators, { kind: "method", name: "getPrivacyState", static: false, private: false, access: { has: obj => "getPrivacyState" in obj, get: obj => obj.getPrivacyState }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getSnsVideoCoverDataUrl_decorators, { kind: "method", name: "getSnsVideoCoverDataUrl", static: false, private: false, access: { has: obj => "getSnsVideoCoverDataUrl" in obj, get: obj => obj.getSnsVideoCoverDataUrl }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _getSnsVideoDataUrl_decorators, { kind: "method", name: "getSnsVideoDataUrl", static: false, private: false, access: { has: obj => "getSnsVideoDataUrl" in obj, get: obj => obj.getSnsVideoDataUrl }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _listTasks_decorators, { kind: "method", name: "listTasks", static: false, private: false, access: { has: obj => "listTasks" in obj, get: obj => obj.listTasks }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _restoreBackup_decorators, { kind: "method", name: "restoreBackup", static: false, private: false, access: { has: obj => "restoreBackup" in obj, get: obj => obj.restoreBackup }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _searchUnified_decorators, { kind: "method", name: "searchUnified", static: false, private: false, access: { has: obj => "searchUnified" in obj, get: obj => obj.searchUnified }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _setPrivacyState_decorators, { kind: "method", name: "setPrivacyState", static: false, private: false, access: { has: obj => "setPrivacyState" in obj, get: obj => obj.setPrivacyState }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _setTaskStatus_decorators, { kind: "method", name: "setTaskStatus", static: false, private: false, access: { has: obj => "setTaskStatus" in obj, get: obj => obj.setTaskStatus }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _syncHandoffTasks_decorators, { kind: "method", name: "syncHandoffTasks", static: false, private: false, access: { has: obj => "syncHandoffTasks" in obj, get: obj => obj.syncHandoffTasks }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        /** Services this gateway depends on at runtime (LLM + default model). */
        static inject = ['llm', 'agentDefaultModel'];
        _ctx = __runInitializers(this, _instanceExtraInitializers);
        _dirs;
        _selfUsername;
        _schedBusy = false;
        /** Live decrypt progress (polled by the settings panel). */
        decryptState = {
            op: null, active: false, done: 0, total: 0, failed: 0, skipped: 0, message: '',
        };
        /** Active whisper model download (polled by the settings panel). */
        whisperDownload = null;
        /** Active voice batch transcription (polled by the settings panel). */
        whisperTranscribing = { active: false, done: 0, total: 0, failed: 0, skipped: 0, current: '' };
        constructor(ctx) {
            super(ctx, 'wechatData');
            this._ctx = ctx;
            this._dirs = resolveDirs();
            this._selfUsername = resolveSelfUsername(this._dirs.decrypted);
            // Real-time sync: watch WeChat's raw message shards and re-decrypt the
            // snapshot so the chat panel sees new messages (st_control monitor style).
            const decrypted = this._dirs.decrypted;
            const rawDbDir = () => {
                const cfg = getConfig(decrypted);
                return typeof cfg['db_dir'] === 'string' ? cfg['db_dir'] : '';
            };
            const stopSync = startRealtimeSync(rawDbDir, () => decrypted, (synced) => {
                console.log('[wechat-sync] updated:', synced.join(', '));
                // 新数据落地：先丢弃进程内指纹缓存（≤5s 的 TTL 兜底之外，让下一次
                // 查询立即读到新快照），再向客户端广播更新事件。
                invalidateWechatMeta();
                try {
                    ctx.emit('wechat-data/updated', synced);
                }
                catch { /* event best-effort */ }
            });
            ctx.effect(() => stopSync, 'wechat-data: realtime sync');
            // Daily-summary scheduler: every 30s, run any enabled task whose schedule
            // time (HH:MM) matches the current minute and has not run in the last minute.
            const schedTimer = setInterval(() => { void this.maybeRunDueTasks(); }, 30_000);
            ctx.effect(() => () => { clearInterval(schedTimer); }, 'wechat-data: summary scheduler');
        }
        /**
         * Append one operation-log row. Metadata only — never message bodies or
         * image/file contents — so an export stays safe to share. Best-effort: a
         * logging failure never affects the operation it records.
         */
        op(category, action, status, target = '', detail = '') {
            recordOperation(this._dirs.decrypted, { category, action, target, status, detail });
        }
        /**
         * Session list (search/filter/limit).
         * @param options - Filter options: keyword fuzzy search, limit max rows.
         * @returns SessionsSnapshot: sessions list (items + total).
         */
        getSessions(options) {
            return querySessions(this._dirs.decrypted, options?.keyword, options?.limit, options?.offset);
        }
        /**
         * Contact book.
         * @param options - Optional page size + offset for incremental loading.
         * @returns ContactsSnapshot: contacts list (items + total) + per-category stats.
         */
        getContacts(options) {
            return queryContacts(this._dirs.decrypted, options);
        }
        /**
         * One-screen data overview.
         * @returns OverviewSnapshot: aggregate counts for the overview screen.
         */
        getOverviewInsights() {
            return queryOverviewInsights(this._dirs.decrypted);
        }
        getOverview() {
            return queryOverview(this._dirs.decrypted);
        }
        /**
         * Friend-region map (世界板块地图): world → country → province → city → friends.
         * @returns RegionMapSnapshot.
         */
        getRegionMap() {
            return queryRegionMap(this._dirs.decrypted);
        }
        /**
         * Records (revokes/transfers/redpackets/finder/miniprograms/friendverifications).
         * @param options - Record kind to query plus pagination/filter options.
         * @returns RecordsSnapshot: record items (items + total).
         */
        getRecords(options) {
            return queryRecords(this._dirs.decrypted, options.kind, options.limit, options.offset, options.q, options);
        }
        /**
         * Contact / group-member search.
         * @param options - search term, optional limit and room scope.
         * @returns MemberSearchSnapshot: matching members (items + total + source).
         */
        searchMembers(options) {
            return searchMembers(this._dirs.decrypted, options.q, options);
        }
        /**
         * Revoked messages.
         * @param options - Optional limit for the number of rows returned.
         * @returns RevokedSnapshot: revoked message items.
         */
        getRevoked(options) {
            return queryRevoked(this._dirs.decrypted, options?.limit, options?.offset);
        }
        /**
         * Custom emoticons.
         * @param options - Optional limit/offset for incremental loading.
         * @returns EmoticonsSnapshot: emoticon items.
         */
        getEmoticons(options) {
            return queryEmoticons(this._dirs.decrypted, options?.limit, options?.offset);
        }
        /**
         * Storage stats.
         * @returns StorageSnapshot: per-category storage usage stats.
         */
        getStorageStats() {
            return queryStorageStats(this._dirs.decrypted, rawWechatBase(this._dirs.decrypted) || undefined);
        }
        /**
         * Annual years.
         * @returns AnnualSnapshot: available yearly overview data.
         */
        getAnnual() {
            return queryAnnual(this._dirs.decrypted);
        }
        /**
         * WeChat config summary.
         * @returns ConfigSnapshot: current WeChat config summary.
         */
        getWechatConfig() {
            return queryWechatConfig(this._dirs.decrypted);
        }
        /**
         * Privacy scan.
         * @returns PrivacySnapshot: privacy scan result.
         */
        getPrivacyScan() {
            return queryPrivacyScan(this._dirs.decrypted);
        }
        /**
         * Relationship graph.
         * @returns GraphSnapshot: chat relationship graph data.
         */
        getGraph() {
            return queryGraph(this._dirs.decrypted, this._selfUsername);
        }
        /**
         * Moments page.
         * @param options - Pagination (offset/limit) and optional author filter.
         * @returns MomentsSnapshot: moments items (items + total).
         */
        getMoments(options) {
            // Pass selfUsername so queryMoments can mark is_self (drives the "我" tag + 范围 filter).
            return queryMoments(this._dirs.decrypted, options?.offset, options?.limit, options?.author, this._selfUsername);
        }
        /**
         * Return the current account's own WeChat username (user_name).
         * @returns { username } - used by the panel to filter "我" authored comments.
         */
        getSelfUsername() {
            return { username: this._selfUsername };
        }
        /**
         * Full-history author activity counts (ranked desc).
         * @returns Array of { name, count } for every moments author.
         */
        getMomentsAuthors() {
            return queryMomentsAuthors(this._dirs.decrypted);
        }
        /**
         * Favorites list.
         * @param options - Optional limit for the number of rows returned.
         * @returns FavoritesSnapshot: favorite items (items + total).
         */
        getFavorites(options) {
            return queryFavorites(this._dirs.decrypted, options?.limit, options?.offset);
        }
        /**
         * Resource files.
         * @param options - Optional limit/offset for incremental loading.
         * @returns FilesSnapshot: resource file items.
         */
        getFiles(options) {
            return queryFiles(this._dirs.decrypted, options?.limit, options?.offset);
        }
        /**
         * Messages of one talker.
         * @param options - Talker username, optional limit and pagination cursor.
         * @returns MessagesSnapshot: message items for the talker.
         */
        getMessages(options) {
            return queryMessages(this._dirs.decrypted, options.talker, options.limit, options.cursor, this._selfUsername);
        }
        /**
         * Incremental messages newer than a sort_seq watermark (real-time polling).
         * @param options - talker, after watermark, optional limit.
         * @returns MessagesSnapshot with only the newer messages.
         */
        getNewMessages(options) {
            return queryNewMessages(this._dirs.decrypted, options.talker, options.after, options.limit, this._selfUsername);
        }
        /**
         * Search index status.
         * @returns SearchIndexStatus: whether the FTS5 index exists and its row count.
         */
        getSearchIndexStatus() {
            return getSearchIndexStatus(this._dirs.decrypted);
        }
        /**
         * Build (or rebuild) the FTS5 message search index.
         * @param options - force: rebuild even when the index already exists.
         * @returns SearchBuildResult: build outcome with row counts.
         */
        buildSearchIndex(options) {
            try {
                const r = buildSearchIndex(this._dirs.decrypted, options?.force);
                this.op('sync', 'build_search_index', r.status === 'ok' ? 'ok' : 'skip', '', r.message ?? `rows=${r.rows ?? 0}`);
                return r;
            }
            catch (e) {
                this.op('sync', 'build_search_index', 'fail', '', e.message);
                throw e;
            }
        }
        /**
         * Full-text search over text messages (index first, scan fallback).
         * @param options - query string, optional result limit and optional talker scope.
         * @returns SearchSnapshot: matched message items.
         */
        searchMessages(options) {
            return searchIndexMessages(this._dirs.decrypted, options.query, options.limit, options.username);
        }
        /**
         * Group chat info (群聊信息): name/remark, announcement, own alias, member
         * grid and local settings mirror.
         * @param options - chatroom username.
         * @returns GroupInfoSnapshot: the group (null when unknown).
         */
        getGroupInfo(options) {
            return queryGroupInfo(this._dirs.decrypted, options.username, this._selfUsername);
        }
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
        getPaymentStatus(options) {
            return queryPaymentStatus(this._dirs.decrypted, options.serverId);
        }
        resolveChatHistory(options) {
            return queryMessageByServerId(this._dirs.decrypted, options.serverId);
        }
        /**
         * Per-day message counts for one month (chat calendar heatmap).
         * @param options - username, year and month to aggregate.
         * @returns CalendarSnapshot: per-day message counts.
         */
        getDailyCounts(options) {
            return getDailyCounts(this._dirs.decrypted, options.username, options.year, options.month);
        }
        /**
         * Look up one voice message (silk decode degrades in Node).
         * @param options - username and localId of the voice message.
         * @returns VoiceInfoResult: voice metadata / decoded file info.
         */
        getVoiceInfo(options) {
            return resolveVoiceInfo(this._dirs.decrypted, options.username, options.localId);
        }
        /**
         * Look up one video message (cover thumbnail + degradation).
         * @param options - username and localId of the video message.
         * @returns VideoInfoResult: video cover/thumbnail info.
         */
        getVideoInfo(options) {
            return resolveVideoInfo(this._dirs.decrypted, this._dirs.decoded, options.username, options.localId);
        }
        /**
         * Export a conversation messages to txt/csv/excel/html.
         * @param options - username, export format and optional message count.
         * @returns ExportResult: exported file path/count info.
         */
        exportSessionMessages(options) {
            try {
                const r = exportSessionMessages(this._dirs.decrypted, options.username, options.format, options.count, options.dir, options.types, options.richTypes, options.from, options.to, options.filename, options.zip);
                this.op('export', 'export_session_messages', 'ok', options.username, `共 ${r.count} 条`);
                return r;
            }
            catch (e) {
                this.op('export', 'export_session_messages', 'fail', options.username, e.message);
                throw e;
            }
        }
        /**
         * AI Q&A over WeChat data: retrieve context + DSH LLM answer with citations.
         * @param options - question to ask over the WeChat data.
         * @returns AskResult: LLM answer with citations.
         */
        async askWechat(options) {
            const ctx = this._ctx;
            const { context, citations } = buildAskContext(this._dirs.decrypted, options.question);
            const defaultModel = ctx.agentDefaultModel;
            const sel = defaultModel?.currentSelection();
            if (!sel || !sel.provider || !sel.model) {
                this.op('task', 'ask_wechat', 'fail', '', '未配置默认模型（agentDefaultModel）');
                throw new Error('未配置默认模型（agentDefaultModel），无法调用 AI 问答');
            }
            const prompt = '问题：' + options.question + '\n\n' + context + '\n\n请基于以上检索结果回答，必要时标注来源编号 [n]。';
            const userMsg = createUserMessage({
                content: [{ type: 'text', text: prompt }],
                source: { kind: 'plugin', plugin: 'dsh-wechat-data' },
            });
            const messages = [userMsg];
            const llm = ctx.llm;
            const assembler = new BlockAssembler();
            const opts = {
                provider: sel.provider,
                model: sel.model,
                messages,
                system: '你是本地微信数据助手，基于检索到的聊天记录回答用户问题，语言用中文，引用来源用 [n] 标注。',
                maxTokens: 1024,
            };
            for await (const chunk of llm.stream(opts))
                assembler.push(chunk);
            const blocks = assembler.blocks();
            const answer = blocks.map(b => (b.type === 'text' ? b.text : '')).join('').trim();
            this.op('task', 'ask_wechat', 'ok', '', citations.length > 0 ? `引用 ${citations.length} 条` : '');
            return { answer: answer || '（模型未返回有效回答）', citations };
        }
        /**
         * List local WeChat backups.
         * @returns BackupSnapshot: backup entries (items + total).
         */
        listBackups() {
            return listBackupEntries(this._dirs.decrypted);
        }
        /**
         * Preview a backup's contents (bounded file list) before restore.
         * @param options - backup name.
         * @returns BackupPreviewSnapshot: items + total.
         */
        previewBackup(options) {
            return previewBackupEntry(this._dirs.decrypted, options.name);
        }
        /**
         * Create a local backup snapshot.
         * @returns BackupMutationResult: ok + backup name, or error.
         */
        createBackup() {
            try {
                const e = createBackupEntry(this._dirs.decrypted);
                this.op('backup', 'create_backup', 'ok', e.name);
                return { ok: true, name: e.name };
            }
            catch (err) {
                this.op('backup', 'create_backup', 'fail', '', err.message);
                return { ok: false, error: err.message };
            }
        }
        /**
         * Delete one backup by name.
         * @param options - name of the backup to delete.
         * @returns BackupMutationResult: ok, or error on failure.
         */
        deleteBackup(options) {
            const r = deleteBackupEntry(this._dirs.decrypted, options.name);
            this.op('delete', 'delete_backup', r.ok ? 'ok' : 'fail', options.name, r.error ?? '');
            return r;
        }
        /**
         * Generate a daily chat summary for one date via DSH LLM.
         * @param options - date (YYYY-MM-DD) to summarize.
         * @returns DailySummaryResult: summary text with session/message counts.
         */
        async generateDailySummary(options) {
            const { lines, count, sessions, total, types, hourly, topSessions } = collectDayMessages(this._dirs.decrypted, options.date);
            const ctx = this._ctx;
            const defaultModel = ctx.agentDefaultModel;
            const sel = defaultModel?.currentSelection();
            const useProvider = (options.provider && options.provider.trim()) ? options.provider.trim() : (sel?.provider ?? '');
            let useModel = (options.model && options.model.trim()) ? options.model.trim() : (sel?.model ?? '');
            const llm = ctx.llm;
            // Plain-text summarization: avoid a default vision/experimental model that returns empty text. Respect an explicit selection.
            if (!options.model && useModel && /vision|-exp/i.test(useModel)) {
                try {
                    const ms = await llm.listModels(useProvider);
                    const chatModelRe = /chat|flash|pro|v4/i;
                    const pick = ms.find(m => chatModelRe.test(m.id) && !/vision|image|exp/i.test(m.id))
                        ?? ms.find(m => !/vision|image|exp/i.test(m.id))
                        ?? ms[0];
                    if (pick && pick.id)
                        useModel = pick.id;
                }
                catch { /* keep */ }
            }
            if (!useProvider || !useModel) {
                const fallback = 'AI 不可用（未配置默认模型或 LLM 服务）。\n\n当日统计：共 ' + String(total) + ' 条消息 / ' + String(sessions) + ' 个活跃会话。' + (compactDailyDigest(lines) || '\n（当天无文本消息）');
                this.op('task', 'generate_daily_summary', 'fail', options.date, '未配置默认模型或 LLM 服务');
                return { summary: fallback, date: options.date, sessions, messages: count, total, types, hourly, topSessions };
            }
            const prompt = '请总结 ' + options.date + ' 当天的微信聊天内容，输出简洁的中文要点：\n\n' + lines.join('\n');
            const userMsg = createUserMessage({
                content: [{ type: 'text', text: prompt }],
                source: { kind: 'plugin', plugin: 'dsh-wechat-data' },
            });
            const assembler = new BlockAssembler();
            const opts = {
                provider: useProvider,
                model: useModel,
                messages: [userMsg],
                system: '你是微信每日总结助手，用中文输出简洁的当日聊天要点总结。',
                maxTokens: 1024,
            };
            let summary = '';
            try {
                for await (const chunk of llm.stream(opts))
                    assembler.push(chunk);
                summary = assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim();
            }
            catch (e) {
                summary = 'LLM 调用失败: ' + e.message;
            }
            const finalSummary = summary ||
                (lines.length > 0
                    ? '模型未返回内容（请为默认模型配置 DEEPSEEK_API_KEY 或其它 LLM 密钥）。\n\n当日统计：共 ' + String(total) + ' 条消息 / ' + String(sessions) + ' 个活跃会话。' + (compactDailyDigest(lines) || '\n（当天无文本消息）')
                    : '（当天没有可用的文本消息）');
            const ok = !finalSummary.startsWith('LLM 调用失败');
            this.op('task', 'generate_daily_summary', ok ? 'ok' : 'fail', options.date, ok ? `共 ${count} 条消息` : finalSummary.slice(0, 120));
            return { summary: finalSummary, date: options.date, sessions, messages: count, total, types, hourly, topSessions };
        }
        /**
         * List edited messages (optionally for one session).
         * @param options - optional sessionId filter.
         * @returns EditedListSnapshot: edited message records (items + total).
         */
        listEditedMessages(options) {
            return listEdits(this._dirs.decrypted, options?.sessionId);
        }
        /**
         * Edit one message content (records the original in the edit store).
         * @param options - username, localId and new content.
         * @returns EditMutationResult: ok, or error on failure.
         */
        editChatMessage(options) {
            const r = editMsg(this._dirs.decrypted, options.username, options.localId, options.content);
            this.op('edit', 'edit_chat_message', r.ok ? 'ok' : 'fail', options.username, r.error ?? `localId=${options.localId}`);
            return r;
        }
        /**
         * Restore a message to its original content.
         * @param options - username and localId of the edited message.
         * @returns EditMutationResult: ok, or error on failure.
         */
        resetEditedMessage(options) {
            const r = resetEdit(this._dirs.decrypted, options.username, options.localId);
            this.op('edit', 'reset_edited_message', r.ok ? 'ok' : 'fail', options.username, r.error ?? `localId=${options.localId}`);
            return r;
        }
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
        listLlmProviders() {
            const ctx = this._ctx;
            let provider = '';
            try {
                const am = (ctx.settings?.get('agent-default-model') ?? {});
                provider = am.provider ?? '';
            }
            catch { /* ignore */ }
            if (!provider) {
                try {
                    const adm = this._ctx.agentDefaultModel;
                    const sel = adm && adm.currentSelection ? adm.currentSelection() : undefined;
                    provider = sel?.provider ?? '';
                }
                catch { /* ignore */ }
            }
            if (!provider)
                return { providers: [] };
            const name = (() => {
                try {
                    const found = ctx.llm?.listConfigurableProviders().find(p => p.provider === provider);
                    return found?.displayName ?? provider;
                }
                catch {
                    return provider;
                }
            })();
            return { providers: [{ id: provider, name }] };
        }
        /** List the provider's configured models (from the "设置 → 模型" settings section), falling back to the provider catalog. */
        async listLlmModels(options) {
            const ctx = this._ctx;
            // 1) read the configured models from the provider's settings section.
            let ns = '';
            let settingsPath = [];
            try {
                const conf = (ctx.llm?.listConfigurableProviders() ?? []).find(p => p.provider === options.provider);
                if (conf) {
                    ns = conf.settingsNs;
                    settingsPath = conf.settingsPath;
                }
            }
            catch { /* ignore */ }
            if (ns) {
                try {
                    const doc = (ctx.settings?.get(ns) ?? {});
                    let profile = doc;
                    if (settingsPath.length > 0) {
                        profile = settingsPath.reduce((acc, k) => {
                            const v = acc[k];
                            return v ?? {};
                        }, doc);
                    }
                    const ms = (profile.models ?? []);
                    if (Array.isArray(ms) && ms.length > 0) {
                        return { models: ms.map(m => ({ id: typeof m === 'string' ? m : (m.id ?? ''), name: typeof m === 'string' ? m : (m.name ?? m.id ?? '') })).filter(m => m.id) };
                    }
                }
                catch { /* ignore */ }
            }
            // 2) fallback: provider catalog.
            try {
                const ms = (await ctx.llm?.listModels(options.provider)) ?? [];
                return { models: ms.map(m => ({ id: m.id, name: m.name })).filter(m => m.id) };
            }
            catch {
                return { models: [] };
            }
        }
        exportAnnualReport(options) {
            try {
                const r = exportAnnualReport(this._dirs.decrypted, options.year, options.format, options.dir, options.filename);
                this.op('export', 'export_annual_report', 'ok', String(options.year), `共 ${r.count} 条`);
                return r;
            }
            catch (e) {
                this.op('export', 'export_annual_report', 'fail', String(options.year), e.message);
                throw e;
            }
        }
        /**
         * Export ALL sessions as a single txt ZIP archive (账号归档).
         * @param options - optional dir/filename.
         * @returns ExportResult: written zip path + total messages.
         */
        exportAllSessions(options) {
            try {
                const r = exportAllSessions(this._dirs.decrypted, options);
                this.op('export', 'export_all_sessions', 'ok', '', `共 ${r.count} 条`);
                return r;
            }
            catch (e) {
                this.op('export', 'export_all_sessions', 'fail', '', e.message);
                throw e;
            }
        }
        /**
         * Export moments (朋友圈) with author + keyword + time filters.
         * @param options - format/username/authorName/q/from/to/dir/filename.
         * @returns ExportResult: written file path + count.
         */
        exportMoments(options) {
            try {
                const r = exportMoments(this._dirs.decrypted, options);
                this.op('export', 'export_moments', 'ok', options?.username ?? '', `共 ${r.count} 条`);
                return r;
            }
            catch (e) {
                this.op('export', 'export_moments', 'fail', options?.username ?? '', e.message);
                throw e;
            }
        }
        exportCsv(options) {
            try {
                const r = exportCsv(this._dirs.decrypted, options.kind, options.recordsKind);
                this.op('export', 'export_csv', 'ok', options.kind, `共 ${r.count} 行`);
                return r;
            }
            catch (e) {
                this.op('export', 'export_csv', 'fail', options.kind, e.message);
                throw e;
            }
        }
        /**
         * Clear one session draft (decrypted copy only).
         * @param options - username of the session to clear.
         * @returns DraftClearResult: ok, or error on failure.
         */
        clearSessionDraft(options) {
            const r = clearDraft(this._dirs.decrypted, options.username);
            this.op('delete', 'clear_session_draft', r.ok ? 'ok' : 'fail', options.username, r.error ?? `已清除 ${r.updated} 条草稿`);
            return r;
        }
        /**
         * Clear all session drafts, returning the cleared list.
         * @returns DraftsClearResult: cleared session list (items + total).
         */
        clearAllSessionDrafts() {
            const r = clearAllDrafts(this._dirs.decrypted);
            this.op('delete', 'clear_all_session_drafts', r.ok ? 'ok' : 'fail', '', r.error ?? `已清除 ${r.count} 个会话草稿`);
            return r;
        }
        /**
         * List daily-summary tasks.
         * @returns SummaryTaskSnapshot: summary tasks (items + total).
         */
        listSummaryTasks() {
            return listTasks(this._dirs.decrypted);
        }
        /**
         * Save (insert/update) a daily-summary task.
         * @param options - task payload (id present = update, absent = insert).
         * @returns SummaryTaskMutationResult: ok + id, or error.
         */
        saveSummaryTask(options) {
            const r = saveTask(this._dirs.decrypted, options.task);
            this.op('task', 'save_summary_task', r.ok ? 'ok' : 'fail', options.task.groupUsername, r.error ?? `id=${r.id ?? ''}`);
            return r;
        }
        /**
         * Delete a daily-summary task.
         * @param options - id of the task to delete.
         * @returns SummaryTaskMutationResult: ok, or error on failure.
         */
        deleteSummaryTask(options) {
            const r = delTask(this._dirs.decrypted, options.id);
            this.op('delete', 'delete_summary_task', r.ok ? 'ok' : 'fail', `id=${options.id}`, r.error ?? '');
            return r;
        }
        /**
         * Toggle a daily-summary task enabled state.
         * @param options - task id and the new enabled flag.
         * @returns SummaryTaskMutationResult: ok, or error on failure.
         */
        toggleSummaryTask(options) {
            const r = toggleTask(this._dirs.decrypted, options.id, options.enabled);
            this.op('task', 'toggle_summary_task', r.ok ? 'ok' : 'fail', `id=${options.id}`, r.error ?? (options.enabled ? '启用' : '停用'));
            return r;
        }
        /**
         * List generated summary records.
         * @param options - optional taskId filter.
         * @returns SummaryRecordSnapshot: summary records (items + total).
         */
        listSummaryRecords(options) {
            return listRecs(this._dirs.decrypted, options?.taskId);
        }
        /**
         * Delete one generated summary record.
         * @param options - id of the record to delete.
         * @returns SummaryTaskMutationResult: ok, or error on failure.
         */
        deleteSummaryRecord(options) {
            const r = delRec(this._dirs.decrypted, options.id);
            this.op('delete', 'delete_summary_record', r.ok ? 'ok' : 'fail', `id=${options.id}`, r.error ?? '');
            return r;
        }
        /**
         * Run a summary task: collect the group previous-day messages + LLM summary + record.
         * @param options - id of the task to run.
         * @returns SummaryTaskRunResult: ok + summary + message count, or error.
         */
        /** Run any enabled daily-summary task whose schedule time matches the current minute. */
        async maybeRunDueTasks() {
            if (this._schedBusy)
                return;
            this._schedBusy = true;
            try {
                const now = new Date();
                const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
                const tasks = listTasks(this._dirs.decrypted).items;
                for (const t of tasks) {
                    if (!t.enabled)
                        continue;
                    const sched = (t.scheduleTime || '08:00').slice(0, 5);
                    if (sched === hhmm && now.getTime() - Number(t.lastRunAt) > 60_000) {
                        await this.runSummaryTask({ id: t.id });
                    }
                }
            }
            catch (e) {
                this.op('error', 'summary_scheduler_error', 'fail', '', e.message);
            }
            finally {
                this._schedBusy = false;
            }
        }
        async runSummaryTask(options) {
            const tasks = listTasks(this._dirs.decrypted).items;
            const task = tasks.find(t => t.id === options.id);
            if (!task)
                return { ok: false, error: '任务不存在' };
            const prev = new Date();
            prev.setDate(prev.getDate() - 1);
            const date = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-${String(prev.getDate()).padStart(2, '0')}`;
            const { lines, count } = collectDayMessages(this._dirs.decrypted, date, 50, task.groupUsername);
            const ctx = this._ctx;
            const llm = ctx.llm;
            const defaultModel = ctx.agentDefaultModel;
            const sel = defaultModel?.currentSelection();
            let summary = '';
            let status = 'done';
            let errMsg = '';
            if (!sel || !sel.provider || !sel.model) {
                status = 'error';
                errMsg = 'LLM/模型不可用';
            }
            else {
                // build the prompt from the task's format (mirror daily_summary.rs summary_formats)
                const targets = task.targetUsers.length > 0 ? task.targetUsers.join('、') : '全部成员';
                const formats = {
                    brief: '请用简洁的中文概括当天聊天记录的重点，3-5 句话以内，不要分点。',
                    detailed: '请对当天聊天记录做详细总结：按主题分点（Markdown 列表），包含关键事件、讨论的话题、达成的共识与结论；只依据记录内容，不编造。',
                    bullets: '请用 Markdown 无序列表提炼当天聊天记录的核心要点，每条一句话，控制在 10 条以内。',
                    story: '请以第三人称、叙事的方式回顾当天聊天记录：谁和谁聊了什么、发生了什么、有什么进展或插曲，读起来像一篇日记。',
                    custom: (task.customPrompt || '').replace(/\{date\}/g, date).replace(/\{group\}/g, task.groupName || task.groupUsername).replace(/\{targets\}/g, targets),
                };
                const fmtPrompt = formats[task.format || 'brief'] || formats['brief'] || '';
                const prompt = '群聊【' + task.groupName + '】(' + task.groupUsername + ') ' + date + ' 的聊天记录如下：\n\n' + lines.join('\n') + '\n\n' + fmtPrompt;
                const userMsg = createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'dsh-wechat-data' } });
                const assembler = new BlockAssembler();
                const opts = { provider: sel.provider, model: sel.model, messages: [userMsg], system: '你是微信每日总结助手，按要求的格式输出总结。', maxTokens: 1024 };
                try {
                    for await (const chunk of llm.stream(opts))
                        assembler.push(chunk);
                    summary = assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim();
                }
                catch (e) {
                    status = 'error';
                    errMsg = e.message;
                }
            }
            const rec = {
                id: 0,
                taskId: task.id,
                groupUsername: task.groupUsername,
                summaryDate: date,
                summary,
                messageCount: count,
                status,
                error: errMsg,
                createdAt: Date.now(),
            };
            saveRec(this._dirs.decrypted, rec);
            // update task last run state
            updateSummaryTaskRunState(this._dirs.decrypted, task.id, Date.now(), status, errMsg);
            const done = status === 'done';
            this.op('task', 'run_summary_task', done ? 'ok' : 'fail', task.groupUsername, errMsg || `共 ${count} 条消息`);
            return done ? { ok: true, summary, messageCount: count } : { ok: false, error: errMsg || '生成失败' };
        }
        /**
         * Resolve a user avatar (head_image.db data or contact URL).
         * @param options - username to resolve the avatar for.
         * @returns AvatarResult: avatar data URL or fallback info.
         */
        getAvatar(options) {
            return resolveAvatar(this._dirs.decrypted, options.username, rawWechatBase(this._dirs.decrypted) || undefined, options.nickname);
        }
        /**
         * 批量读取本地头像(head_image.db 单次打开,全部返回 data URL;绝不回退网络)。
         * @param options - usernames 列表。
         * @returns username → data URL 映射(未命中的不在其中)。
         */
        getAvatarsLocal(options) {
            return resolveAvatarsLocal(this._dirs.decrypted, options.usernames);
        }
        /**
         * Read the full WeChat config (incl. keys + resolved paths).
         * @returns WechatConfigFull: complete config with resolved paths.
         */
        getWechatConfigFull() {
            const cfg = getConfig(this._dirs.decrypted);
            const resolved = cfg['resolved'] ?? {};
            return {
                db_dir: cellStr(cfg['db_dir'] ?? ''),
                wechat_process: cellStr(cfg['wechat_process'] ?? 'Weixin.exe'),
                key_format: cellStr(cfg['key_format'] ?? 'wx_key_v4.1'),
                db_enc_key: cellStr(cfg['db_enc_key'] ?? ''),
                image_aes_key: cellStr(cfg['image_aes_key'] ?? ''),
                image_xor_key: Number(cfg['image_xor_key'] ?? 136),
                api_enabled: Boolean(cfg['api_enabled'] ?? true),
                api_port: Number(cfg['api_port'] ?? 5032),
                api_token: cellStr(cfg['api_token'] ?? ''),
                cdn_enabled: Boolean(cfg['cdn_enabled'] ?? true),
                cdn_local_decrypt: Boolean(cfg['cdn_local_decrypt'] ?? true),
                whisper_device: cfg['whisper_device'] === 'gpu' ? 'gpu' : 'cpu',
                whisper_model: cellStr(cfg['whisper_model'] ?? 'medium'),
                whisper_threads: Number(cfg['whisper_threads'] ?? 0),
                whisper_models_dir: cellStr(cfg['whisper_models_dir'] ?? ''),
                whisper_bin: cellStr(cfg['whisper_bin'] ?? ''),
                resolved,
            };
        }
        /**
         * Save the WeChat config (merge patch).
         * @param options - patch of config fields to merge.
         * @returns SimpleResult: ok, or error on failure.
         */
        saveWechatConfig(options) {
            const before = getConfig(this._dirs.decrypted);
            // Models/engine may live in the default dir even when none was persisted.
            const oldDirRaw = typeof before['whisper_models_dir'] === 'string' && before['whisper_models_dir'].trim().length > 0
                ? before['whisper_models_dir']
                : defaultWhisperModelsDir(this._dirs.decrypted);
            const oldBin = typeof before['whisper_bin'] === 'string' ? before['whisper_bin'] : '';
            // Resolved before the switch: engines found by search (e.g. Release/ layout)
            // also need to move to the new dir, even when whisper_bin was never persisted.
            const oldEngine = whisperEnginePath(oldBin, oldDirRaw);
            const res = saveConfig(this._dirs.decrypted, options.patch);
            if (res.ok && typeof options.patch.whisper_models_dir === 'string') {
                const newDir = (options.patch.whisper_models_dir ?? '').trim();
                if (newDir && newDir.toLowerCase() !== oldDirRaw.toLowerCase()) {
                    // Move previously downloaded models + engine install into the new dir.
                    migrateWhisperModels(oldDirRaw, newDir);
                    const after = getConfig(this._dirs.decrypted);
                    const bin = typeof after['whisper_bin'] === 'string' ? after['whisper_bin'] : '';
                    const relocated = migrateWhisperEngineDir(bin || oldEngine, oldDirRaw, newDir);
                    if (relocated && relocated !== (bin || oldEngine))
                        saveConfig(this._dirs.decrypted, { whisper_bin: relocated });
                }
            }
            this.op('settings', 'save_wechat_config', res.ok ? 'ok' : 'fail', '', res.error ?? '配置已保存');
            return res;
        }
        /**
         * Whisper transcription configuration status: engine detection, CUDA
         * presence, models dir + installed ggml binaries, active download progress
         * (inference itself stays bridge-side).
         * @returns WhisperStatus: engine/hasCuda/models inventory.
         */
        getWhisperStatus() {
            const cfg = getConfig(this._dirs.decrypted);
            const configured = typeof cfg['whisper_models_dir'] === 'string' && cfg['whisper_models_dir'].trim().length > 0
                ? cfg['whisper_models_dir']
                : defaultWhisperModelsDir(this._dirs.decrypted);
            const configBin = typeof cfg['whisper_bin'] === 'string' ? cfg['whisper_bin'] : '';
            const engine = whisperEnginePath(configBin, configured);
            const result = {
                engine,
                hasCuda: whisperHasCuda(),
                modelsDir: configured,
                models: whisperModelsStatus(configured),
                downloading: this.whisperDownload,
                transcribing: this.whisperTranscribing,
            };
            if (engine)
                result.enginePath = engine;
            return result;
        }
        /**
         * Download one official whisper.cpp ggml model into the models dir
         * (streamed, atomic publish; huggingface.co with hf-mirror fallback).
         * @param options - model id to download.
         * @returns WhisperDownloadResult: ok + file/bytes, or an error.
         */
        async downloadWhisperModel(options) {
            if (this.whisperDownload !== null) {
                this.op('settings', 'download_whisper_model', 'fail', options.model, '已有模型下载任务进行中');
                return { ok: false, error: '已有模型下载任务进行中' };
            }
            const cfg = getConfig(this._dirs.decrypted);
            const modelsDir = typeof cfg['whisper_models_dir'] === 'string' && cfg['whisper_models_dir'].trim().length > 0
                ? cfg['whisper_models_dir']
                : defaultWhisperModelsDir(this._dirs.decrypted);
            this.whisperDownload = { model: options.model, file: '', received: 0, total: 0 };
            try {
                const result = await whisperDownloadModel(options.model, modelsDir, (received, total) => {
                    if (this.whisperDownload !== null) {
                        this.whisperDownload.received = received;
                        this.whisperDownload.total = total;
                    }
                });
                // whisperDownload 在本方法开头必然已赋非空值，直到 finally 才清空。
                this.whisperDownload.file = WHISPER_DOWNLOAD_FILES.find(([id]) => id === options.model)?.[1] ?? options.model;
                this.op('settings', 'download_whisper_model', result.ok ? 'ok' : 'fail', options.model, result.error ?? `bytes=${result.bytes ?? 0}`);
                return result;
            }
            finally {
                this.whisperDownload = null;
            }
        }
        /**
         * Detect installed WeChat 4.x accounts.
         * @returns AccountsSnapshot: detected accounts (accounts + total).
         */
        detectWechatAccounts() {
            const accounts = detectWechatAccounts();
            const snapshot = { accounts, total: accounts.length };
            const installDir = weixinInstallPath();
            if (installDir) {
                snapshot.install_dir = installDir;
                const version = weixinVersion(installDir);
                if (version)
                    snapshot.version = version;
            }
            this.op('keys', 'detect_accounts', 'ok', '', `发现 ${snapshot.total} 个账号`);
            return snapshot;
        }
        /**
         * Verify a database key (SQLCipher PBKDF2 + AES + HMAC).
         * @param options - dbPath and encKeyHex of the key to verify.
         * @returns VerifyKeyResult: valid flag plus optional AES/HMAC checks.
         */
        verifyDatabaseKey(options) {
            const r = verifyDatabaseKey(options.dbPath, options.encKeyHex);
            this.op('keys', 'verify_db_key', r.valid ? 'ok' : 'fail', options.dbPath, r.error ?? (r.valid ? '有效' : '无效'));
            return r;
        }
        /**
         * Verify all DBs in db_dir and write all_keys.json.
         * @param options - dbDir, keysFile, encKeyHex and optional keyFormat.
         * @returns GenerateKeysResult: generation outcome.
         */
        generateKeysFile(options) {
            const r = generateKeysFile(options.dbDir, options.keysFile, options.encKeyHex, options.keyFormat);
            this.op('keys', 'generate_keys_file', r.ok ? 'ok' : 'fail', options.keysFile, r.error ?? `通过 ${r.verified}/${r.total}`);
            return r;
        }
        /**
         * Read all_keys.json info.
         * @returns KeysInfoResult: key format/count/loaded state.
         */
        getWechatKeysInfo() {
            return getKeysInfo(this._dirs.decrypted);
        }
        /**
         * Auto-recover the V4 database key from the running WeChat process
         * (key_v4 memory scan + Weixin.dll internal-key unmask).
         * @param options - optional probe db path and install dir.
         * @returns AutoDbKeyResult: ok + 64-hex key, or an error.
         */
        async autoGetDbKey(options) {
            const r = await fetchDbKey(options);
            this.op('keys', 'auto_get_db_key', r.ok ? 'ok' : 'fail', options.dbPath ?? '', r.error ?? (r.source ?? ''));
            return r;
        }
        /**
         * Auto-recover the image key (V2-verified): a saved-and-valid config key
         * pair is returned first; otherwise the running WeChat process memory is
         * scanned.
         * @param options - account dir (wxid_* 文件夹或其 db_storage) and optional pid.
         * @returns AutoImageKeyResult: ok + xor/aes pair, or an error.
         */
        async autoGetImageKey(options) {
            const accountDir = normalizeAccountDir(options.accountDir ?? '');
            if (accountDir && existsSync(accountDir)) {
                const cfg = getConfig(this._dirs.decrypted);
                const savedAes = typeof cfg['image_aes_key'] === 'string' ? cfg['image_aes_key'].trim() : '';
                if (savedAes) {
                    const scan = scanV2Templates(accountDir);
                    if (scan.templates.length > 0) {
                        const xor = trustedXorForVerifiedAesKey(savedAes, scan);
                        if (xor !== null) {
                            const result = { ok: true, aesKey: savedAes, xorKey: xor, verified: true };
                            const template = scan.templates[0];
                            if (template)
                                result.templatePath = template.path;
                            this.op('keys', 'auto_get_image_key', 'ok', accountDir, '使用已保存并验证的图片密钥');
                            return result;
                        }
                    }
                }
            }
            const fetchOpts = { accountDir };
            if (options.pid !== undefined)
                fetchOpts.pid = options.pid;
            const r = await fetchImageKey(fetchOpts);
            this.op('keys', 'auto_get_image_key', r.ok ? 'ok' : 'fail', accountDir, r.error ?? (r.verified ? '内存扫描成功' : ''));
            return r;
        }
        /**
         * Verify the saved image key pair against real V2 templates.
         * @returns VerifyImageKeyResult: verified flag + xor/template evidence.
         */
        /** Open the owned WeChat config.json (e.g. for manual edit). @returns the opened path. */
        /** Open an owned path (config/output dir/file) with the system default. @returns the opened path. */
        async openPath(options, signal) {
            const p = options.path;
            try {
                await openNativePath(p, signal);
                return { ok: true, path: p };
            }
            catch {
                return { ok: false, path: p };
            }
        }
        async openConfig(signal) {
            const p = join(this._dirs.decrypted, '..', 'config.json');
            try {
                await openNativePath(p, signal);
                return { ok: true, path: p };
            }
            catch {
                return { ok: false, path: p };
            }
        }
        verifyImageKey() {
            const cfg = getConfig(this._dirs.decrypted);
            const aesKey = typeof cfg['image_aes_key'] === 'string' ? cfg['image_aes_key'].trim() : '';
            if (!aesKey) {
                this.op('keys', 'verify_image_key', 'fail', '', '尚未配置图片 AES 密钥');
                return { verified: false, error: '尚未配置图片 AES 密钥' };
            }
            const rawRoot = rawWechatBase(this._dirs.decrypted);
            if (!rawRoot) {
                this.op('keys', 'verify_image_key', 'fail', '', '未配置数据库目录，无法定位账号数据');
                return { verified: false, error: '未配置数据库目录，无法定位账号数据' };
            }
            const scan = scanV2Templates(rawRoot);
            if (scan.templates.length === 0) {
                this.op('keys', 'verify_image_key', 'fail', '', '未找到 V2 图片模板（_t.dat）');
                return { verified: false, error: '未找到 V2 图片模板（_t.dat）' };
            }
            const xor = trustedXorForVerifiedAesKey(aesKey, scan);
            const result = {
                verified: xor !== null,
                aesKey,
                xorKey: xor ?? Number(cfg['image_xor_key'] ?? 0),
            };
            const template = scan.templates[0];
            if (template)
                result.templatePath = template.path;
            this.op('keys', 'verify_image_key', result.verified ? 'ok' : 'fail', '', result.error ?? (result.verified ? '已通过' : '验证失败'));
            return result;
        }
        /**
         * Full SQLCipher decryption: every .db under db_storage is re-decrypted
         * into the decrypted snapshot (逐库原子发布,单库失败不中断)。实时进度
         * 通过 getDecryptStatus 轮询读取。
         * @returns DecryptAllResult: total/ok/failed counts.
         */
        async decryptAllDatabases() {
            if (this.decryptState.active) {
                this.op('sync', 'decrypt_databases', 'fail', '', '已有解密任务进行中');
                return { ok: false, total: 0, okCount: 0, failed: [], error: '已有解密任务进行中' };
            }
            const cfg = getConfig(this._dirs.decrypted);
            const rawDbDir = typeof cfg['db_dir'] === 'string' ? cfg['db_dir'] : '';
            this.decryptState.op = 'databases';
            this.decryptState.active = true;
            this.decryptState.done = 0;
            this.decryptState.total = 0;
            this.decryptState.failed = 0;
            this.decryptState.skipped = 0;
            this.decryptState.message = '';
            try {
                const r = await decryptAllDbs(rawDbDir, this._dirs.decrypted, (done, total, failed, message) => {
                    this.decryptState.done = done;
                    this.decryptState.total = total;
                    this.decryptState.failed = failed;
                    this.decryptState.message = message;
                });
                // 全部解密库被原子替换：进程内元数据/统计缓存必须整体失效。
                invalidateWechatMeta();
                this.op('sync', 'decrypt_databases', r.ok ? 'ok' : 'fail', '', r.error ?? `成功 ${r.okCount}/${r.total}${r.failed.length > 0 ? `，失败 ${r.failed.length}` : ''}`);
                return r;
            }
            finally {
                this.decryptState.active = false;
                this.decryptState.message = '';
            }
        }
        /**
         * Batch-decode every md5-prefixed .dat image under msg/attach into the
         * decoded-images cache (并行池,已缓存/HEVC 跳过)。实时进度通过
         * getDecryptStatus 轮询读取。
         * @param options - optional worker concurrency (clamped 1..32).
         * @returns DecryptImagesResult: total/ok/failed/skipped counts.
         */
        async decryptAllImages(options) {
            if (this.decryptState.active) {
                this.op('sync', 'decrypt_images', 'fail', '', '已有解密任务进行中');
                return { ok: false, total: 0, okCount: 0, failed: 0, skipped: 0, errors: [], error: '已有解密任务进行中' };
            }
            const cfg = getConfig(this._dirs.decrypted);
            const aesKey = typeof cfg['image_aes_key'] === 'string' ? cfg['image_aes_key'] : undefined;
            const xorKey = Number(cfg['image_xor_key'] ?? 0xff);
            const rawRoot = rawWechatBase(this._dirs.decrypted);
            if (!rawRoot) {
                this.op('sync', 'decrypt_images', 'fail', '', '未配置数据库目录，无法定位图片数据');
                return { ok: false, total: 0, okCount: 0, failed: 0, skipped: 0, errors: [], error: '未配置数据库目录，无法定位图片数据' };
            }
            const concurrency = Math.floor(options.concurrency ?? 8) || 8;
            this.decryptState.op = 'images';
            this.decryptState.active = true;
            this.decryptState.done = 0;
            this.decryptState.total = 0;
            this.decryptState.failed = 0;
            this.decryptState.skipped = 0;
            this.decryptState.message = '';
            try {
                const result = await decryptAllImageDats(rawRoot, this._dirs.decoded, aesKey, xorKey, concurrency, (processed, total, failed, message) => {
                    this.decryptState.done = processed;
                    this.decryptState.total = total;
                    this.decryptState.failed = failed;
                    this.decryptState.message = message;
                });
                this.decryptState.skipped = result.skipped;
                this.op('sync', 'decrypt_images', result.failed === 0 ? 'ok' : 'fail', '', `成功 ${result.okCount}/${result.total}${result.failed > 0 ? `，失败 ${result.failed}` : ''}`);
                return { ok: true, ...result };
            }
            finally {
                this.decryptState.active = false;
                this.decryptState.message = '';
            }
        }
        /**
         * Live decryption progress snapshot (polled by the settings panel).
         * @returns DecryptStatus: op/done/total/failed/skipped + current item.
         */
        getDecryptStatus() {
            return {
                op: this.decryptState.op,
                active: this.decryptState.active,
                done: this.decryptState.done,
                total: this.decryptState.total,
                failed: this.decryptState.failed,
                skipped: this.decryptState.skipped,
                message: this.decryptState.message,
            };
        }
        /**
         * Download + install the whisper.cpp CLI engine into the models dir
         * (`<modelsDir>/bin/whisper-cli.exe`), persisting the path as whisper_bin.
         * @returns WhisperDownloadResult: ok + path, or an error.
         */
        async installWhisperEngine() {
            if (this.whisperDownload !== null) {
                this.op('settings', 'install_whisper_engine', 'fail', '', '已有下载任务进行中');
                return { ok: false, error: '已有下载任务进行中' };
            }
            const cfg = getConfig(this._dirs.decrypted);
            const modelsDir = typeof cfg['whisper_models_dir'] === 'string' && cfg['whisper_models_dir'].trim().length > 0
                ? cfg['whisper_models_dir']
                : defaultWhisperModelsDir(this._dirs.decrypted);
            const configBin = typeof cfg['whisper_bin'] === 'string' ? cfg['whisper_bin'] : '';
            const existing = whisperEnginePath(configBin, modelsDir);
            if (existing) {
                this.op('settings', 'install_whisper_engine', 'skip', '', '引擎已存在');
                return { ok: true, file: 'whisper-cli.exe', bytes: 0 };
            }
            this.whisperDownload = { model: 'engine', file: 'whisper-bin-x64.zip', received: 0, total: 0 };
            try {
                const result = await installWhisperEngine(modelsDir, (received, total) => {
                    if (this.whisperDownload !== null) {
                        this.whisperDownload.received = received;
                        this.whisperDownload.total = total;
                    }
                });
                if (result.ok && result.path) {
                    saveConfig(this._dirs.decrypted, { whisper_bin: result.path });
                }
                const out = { ok: result.ok, file: 'whisper-cli.exe' };
                if (result.error)
                    out.error = result.error;
                this.op('settings', 'install_whisper_engine', out.ok ? 'ok' : 'fail', '', out.error ?? '引擎已安装');
                return out;
            }
            finally {
                this.whisperDownload = null;
            }
        }
        /**
         * Batch-transcribe the most recent voice messages: silk → WAV (bundled
         * wx_silk) → whisper-cli with the selected model → text cached per message.
         * @param options - optional message count (default 50, clamped 1..200).
         * @returns VoiceTranscribeResult: done/failed/skipped counts.
         */
        async transcribeVoiceBatch(options) {
            if (this.whisperTranscribing.active) {
                this.op('task', 'transcribe_voice_batch', 'fail', '', '已有转写任务进行中');
                return { ok: false, total: 0, done: 0, failed: 0, skipped: 0, errors: [], engine: '', error: '已有转写任务进行中' };
            }
            const cfg = getConfig(this._dirs.decrypted);
            const modelsDir = typeof cfg['whisper_models_dir'] === 'string' && cfg['whisper_models_dir'].trim().length > 0
                ? cfg['whisper_models_dir']
                : defaultWhisperModelsDir(this._dirs.decrypted);
            const configBin = typeof cfg['whisper_bin'] === 'string' ? cfg['whisper_bin'] : '';
            const engine = whisperEnginePath(configBin, modelsDir);
            if (!engine) {
                this.op('task', 'transcribe_voice_batch', 'fail', '', '未检测到 whisper.cpp 引擎');
                return { ok: false, total: 0, done: 0, failed: 0, skipped: 0, errors: [], engine, error: '未检测到 whisper.cpp 引擎（可在第 5 步点击「下载引擎」，或设 DSH_WECHAT_WHISPER_BIN）' };
            }
            const modelId = typeof cfg['whisper_model'] === 'string' && cfg['whisper_model'] ? cfg['whisper_model'] : 'medium';
            const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 50), 200));
            this.whisperTranscribing = { active: true, done: 0, total: 0, failed: 0, skipped: 0, current: '' };
            try {
                const result = await transcribeVoiceBatch(this._dirs.decrypted, this._dirs.decoded, modelsDir, modelId, engine, limit, (done, total, failed, current) => {
                    this.whisperTranscribing.done = done;
                    this.whisperTranscribing.total = total;
                    this.whisperTranscribing.failed = failed;
                    this.whisperTranscribing.current = current;
                });
                this.whisperTranscribing.skipped = result.skipped;
                this.op('task', 'transcribe_voice_batch', result.ok ? 'ok' : 'fail', '', result.error ?? `成功 ${result.done}/${result.total}，失败 ${result.failed}`);
                return result;
            }
            finally {
                this.whisperTranscribing.active = false;
                this.whisperTranscribing.current = '';
            }
        }
        /**
         * Cached transcript for one voice message (if already transcribed).
         * @param options - message username + local_id.
         * @returns VoiceTranscriptResult: text or an error.
         */
        getVoiceTranscript(options) {
            const svrId = svrIdByChatLocal(this._dirs.decrypted, options.username, options.localId);
            if (!svrId)
                return { error: '未找到语音消息' };
            const text = cachedTranscript(this._dirs.decoded, svrId);
            return text ? { text } : { error: '尚未转写' };
        }
        /**
         * Transcribe one voice message on demand (chat bubble 语音转文字).
         * @param options - message username + local_id.
         * @returns VoiceTranscribeOneResult: ok + text, or an error.
         */
        transcribeVoiceMessage(options) {
            if (this.whisperTranscribing.active) {
                this.op('task', 'transcribe_voice_message', 'fail', options.username, '已有转写任务进行中');
                return { ok: false, error: '已有转写任务进行中' };
            }
            const cfg = getConfig(this._dirs.decrypted);
            const modelsDir = typeof cfg['whisper_models_dir'] === 'string' && cfg['whisper_models_dir'].trim().length > 0
                ? cfg['whisper_models_dir']
                : defaultWhisperModelsDir(this._dirs.decrypted);
            const configBin = typeof cfg['whisper_bin'] === 'string' ? cfg['whisper_bin'] : '';
            const engine = whisperEnginePath(configBin, modelsDir);
            if (!engine) {
                this.op('task', 'transcribe_voice_message', 'fail', options.username, '未检测到 whisper.cpp 引擎');
                return { ok: false, error: '未检测到 whisper.cpp 引擎（可在第 5 步点击「下载引擎」）' };
            }
            const modelId = typeof cfg['whisper_model'] === 'string' && cfg['whisper_model'] ? cfg['whisper_model'] : 'medium';
            const r = transcribeOneVoice(this._dirs.decrypted, this._dirs.decoded, modelsDir, modelId, engine, options.username, options.localId);
            this.op('task', 'transcribe_voice_message', r.ok ? 'ok' : 'fail', options.username, r.error ?? '转写成功');
            return r;
        }
        /**
         * Set CDN auto-fetch flag.
         * @param options - enabled: whether CDN auto-fetch is on.
         * @returns SimpleResult: ok, or error on failure.
         */
        setCdnImageEnabled(options) {
            const r = saveConfig(this._dirs.decrypted, { cdn_enabled: options.enabled });
            this.op('settings', 'set_cdn_image_enabled', r.ok ? 'ok' : 'fail', '', r.error ?? (options.enabled ? '开启' : '关闭'));
            return r;
        }
        /**
         * Set CDN local/service decrypt flag.
         * @param options - localDecrypt: whether decryption runs locally.
         * @returns SimpleResult: ok, or error on failure.
         */
        setCdnImageLocalDecrypt(options) {
            const r = saveConfig(this._dirs.decrypted, { cdn_local_decrypt: options.localDecrypt });
            this.op('settings', 'set_cdn_image_local_decrypt', r.ok ? 'ok' : 'fail', '', r.error ?? (options.localDecrypt ? '本地解密' : '服务端解密'));
            return r;
        }
        /**
         * Delete favorite items by local_id.
         * @param options - ids of the favorite items to delete.
         * @returns DeleteFavoriteResult: ok + deleted count, or error.
         */
        deleteFavoriteItems(options) {
            const r = deleteFavoriteItems(this._dirs.decrypted, options.ids);
            this.op('delete', 'delete_favorite_items', r.ok ? 'ok' : 'fail', '', r.error ?? `删除 ${r.deleted} 项`);
            return r;
        }
        /**
         * Compute the annual report for one year (local only).
         * @param options - year to compute the report for.
         * @returns AnnualReport: computed annual report data.
         */
        getAnnualReport(options) {
            try {
                const r = queryAnnualReport(this._dirs.decrypted, options.year);
                this.op('task', 'generate_annual_report', 'ok', String(options.year), `共 ${r.total} 条`);
                return r;
            }
            catch (e) {
                this.op('task', 'generate_annual_report', 'fail', String(options.year), e.message);
                throw e;
            }
        }
        /**
         * Decrypted DB status summary.
         * @returns DbStatusSnapshot: per-database status summary.
         */
        getDbStatus() {
            return getDbStatus(this._dirs.decrypted);
        }
        /**
         * Decode one message image to a base64 data URL.
         * @param options - username and localId of the message image.
         * @returns ImageDataUrlResult: base64 data URL or error.
         */
        getImageDataUrl(options) {
            const base = rawWechatBase(this._dirs.decrypted) || undefined;
            const cfg = getConfig(this._dirs.decrypted);
            const aesKey = typeof cfg['image_aes_key'] === 'string' && cfg['image_aes_key'].length > 0 ? cfg['image_aes_key'] : undefined;
            const xorKey = Number(cfg['image_xor_key'] ?? 0xff);
            return decodeImageDataUrl(this._dirs.decrypted, this._dirs.decoded, options.username, options.localId, base, aesKey, xorKey);
        }
        /**
         * Resolve one SNS (朋友圈) media md5 to an offline base64 data URL
         * from the WeChat cache/<month>/Sns/Img V2-encrypted blobs.
         * @param options - media md5 from the moments XML.
         * @returns ImageDataUrlResult: base64 data URL or error.
         */
        getSnsImageDataUrl(options) {
            const base = rawWechatBase(this._dirs.decrypted) || undefined;
            const cfg = getConfig(this._dirs.decrypted);
            const aesKey = typeof cfg['image_aes_key'] === 'string' && cfg['image_aes_key'].length > 0 ? cfg['image_aes_key'] : undefined;
            const xorKey = Number(cfg['image_xor_key'] ?? 0xff);
            return resolveSnsImageDataUrl(base, aesKey, xorKey, options.md5, options.timelineId, options.mediaId);
        }
        /**
         * Resolve a 公众号 article cover (og:image) to a base64 data URL.
         * @param options - mp.weixin.qq.com article URL.
         * @returns ImageDataUrlResult: base64 data URL or error.
         */
        async getArticleCover(options) {
            return resolveArticleCoverDataUrl(options.contentUrl, this._dirs.decoded);
        }
        /**
         * Resolve a received message file (msg/file) to a base64 data URL.
         * @param options - original file name from the message card.
         * @returns ImageDataUrlResult: data URL or error.
         */
        getMessageFile(options) {
            return resolveMessageFileDataUrl(rawWechatBase(this._dirs.decrypted) || undefined, options.fileName);
        }
        /**
         * Add a WeChat task.
         * @param options - title + optional dueAt.
         * @returns TaskMutationResult.
         */
        addTask(options) {
            const r = insertTask(this._dirs.decrypted, options);
            this.op('task', 'add_task', r.ok ? 'ok' : 'fail', options.title, r.error ?? '');
            return r;
        }
        clearOperationLog() {
            const r = clearOperationLog(this._dirs.decrypted);
            this.op('delete', 'clear_operation_log', r.ok ? 'ok' : 'fail', '', r.ok ? `已清除 ${r.removed} 条` : '清除失败');
            return r;
        }
        clearPrivacyAudit() {
            const r = clearPrivacyAudit(this._dirs.decrypted);
            this.op('delete', 'clear_privacy_audit', r.ok ? 'ok' : 'fail', '', r.ok ? `已清除 ${r.removed} 条` : '清除失败');
            return r;
        }
        async createEncryptedBackup(options) {
            try {
                const entry = await createEncryptedBackup(this._dirs.decrypted, options.password);
                this.op('backup', 'create_encrypted_backup', 'ok', entry.name);
                return { ok: true, name: entry.name };
            }
            catch (e) {
                this.op('backup', 'create_encrypted_backup', 'fail', '', e.message);
                return { ok: false, error: e.message };
            }
        }
        deleteTask(options) {
            const r = deleteTask(this._dirs.decrypted, options.id);
            this.op('delete', 'delete_task', r.ok ? 'ok' : 'fail', `id=${options.id}`, r.error ?? '');
            return r;
        }
        extractTasks(options) {
            const days = options?.days ?? 7;
            const to = new Date();
            const from = new Date(to.getTime() - days * 86400000);
            const { lines } = collectPeriodMessages(this._dirs.decrypted, from.toISOString().slice(0, 10), to.toISOString().slice(0, 10), 50);
            const re = /(记得|待办|要做|提醒|别忘了|稍后|待处理|deadline)/i;
            let added = 0;
            for (const line of lines) {
                if (re.test(line)) {
                    const title = line.trim().slice(0, 60) || '待办';
                    const r = insertTask(this._dirs.decrypted, { title });
                    if (r.ok)
                        added += 1;
                }
            }
            this.op('task', 'extract_tasks', 'ok', '', `新增 ${added} 条待办`);
            return { ok: true, added };
        }
        async generatePeriodSummary(options) {
            const collected = collectPeriodMessages(this._dirs.decrypted, options.from, options.to);
            const { lines, count, sessions, total, types, hourly, topSessions } = collected;
            const ctx = this._ctx;
            const defaultModel = ctx.agentDefaultModel;
            const sel = defaultModel?.currentSelection();
            const useProvider = (options.provider && options.provider.trim()) ? options.provider.trim() : (sel?.provider ?? '');
            let useModel = (options.model && options.model.trim()) ? options.model.trim() : (sel?.model ?? '');
            const llm = ctx.llm;
            if (!options.model && useModel && /vision|-exp/i.test(useModel)) {
                try {
                    const ms = await llm.listModels(useProvider);
                    const chatModelRe = /chat|flash|pro|v4/i;
                    const pick = ms.find(m => chatModelRe.test(m.id) && !/vision|image|exp/i.test(m.id))
                        ?? ms.find(m => !/vision|image|exp/i.test(m.id))
                        ?? ms[0];
                    if (pick && pick.id)
                        useModel = pick.id;
                }
                catch { /* keep */ }
            }
            if (!useProvider || !useModel) {
                const fallback = 'AI 不可用（未配置默认模型或 LLM 服务）。\n\n周期统计：共 ' + String(total) + ' 条消息 / ' + String(sessions) + ' 个活跃会话。' + (compactDailyDigest(lines) || '');
                this.op('task', 'generate_period_summary', 'fail', `${options.from}~${options.to}`, '未配置默认模型或 LLM 服务');
                return { summary: fallback, from: options.from, to: options.to, sessions, messages: count, total, types, hourly, topSessions };
            }
            const prompt = '请总结 ' + options.from + ' 至 ' + options.to + ' 的微信聊天内容，输出简洁的中文要点：\n\n' + lines.join('\n');
            const userMsg = createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'dsh-wechat-data' } });
            const assembler = new BlockAssembler();
            const opts = { provider: useProvider, model: useModel, messages: [userMsg], system: '你是微信周期总结助手，用中文输出简洁的要点总结。', maxTokens: 1024 };
            let summary = '';
            try {
                for await (const chunk of llm.stream(opts))
                    assembler.push(chunk);
                summary = assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim();
            }
            catch (e) {
                summary = 'LLM 调用失败: ' + e.message;
            }
            const finalSummary = summary || (lines.length > 0 ? '模型未返回内容。\n\n周期统计：共 ' + String(total) + ' 条消息 / ' + String(sessions) + ' 个活跃会话。' + (compactDailyDigest(lines) || '') : '（该周期没有可用的文本消息）');
            const ok = !finalSummary.startsWith('LLM 调用失败');
            this.op('task', 'generate_period_summary', ok ? 'ok' : 'fail', `${options.from}~${options.to}`, ok ? `共 ${count} 条消息` : finalSummary.slice(0, 120));
            return { summary: finalSummary, from: options.from, to: options.to, sessions, messages: count, total, types, hourly, topSessions };
        }
        getAssetInsights() {
            return queryAssetInsights(this._dirs.decrypted);
        }
        getContact360(options) {
            return queryContact360(this._dirs.decrypted, options.username);
        }
        getDbHealth() {
            return queryDbHealth(this._dirs.decrypted);
        }
        getGroupInsights(options) {
            return queryGroupInsights(this._dirs.decrypted, options.username);
        }
        getHandoffReminds() {
            return listHandoffReminds(this._dirs.decrypted);
        }
        getLedger(options) {
            return queryLedger(this._dirs.decrypted, options?.month, this._selfUsername);
        }
        getMediaAssets() {
            return queryMediaAssets(this._dirs.decrypted);
        }
        getMomentsInsights(options) {
            return queryMomentsInsights(this._dirs.decrypted, options?.author);
        }
        getMomentsMonthly(options) {
            return queryMomentsMonthly(this._dirs.decrypted, options?.author, options?.authorName);
        }
        getOfficialAssets() {
            return queryOfficialAssets(this._dirs.decrypted);
        }
        getOperationLog(options) {
            return listOperations(this._dirs.decrypted, options);
        }
        getPrivacyAuditRows() {
            return listPrivacyAudit(this._dirs.decrypted);
        }
        getPrivacyState() {
            return getPrivacyStateSnapshot(this._dirs.decrypted);
        }
        getSnsVideoCoverDataUrl(options) {
            return resolveSnsVideoCoverDataUrl(rawWechatBase(this._dirs.decrypted) || undefined, options.md5, options.timelineId, options.mediaId);
        }
        /**
         * Resolve one SNS (朋友圈) video body to an offline base64 data URL so it can
         * be played inline. Returns an error when the cached container is missing.
         * @param options - media md5 from the moments XML (+ optional cache keys).
         * @returns ImageDataUrlResult: base64 data URL or error.
         */
        getSnsVideoDataUrl(options) {
            return resolveSnsVideoDataUrl(rawWechatBase(this._dirs.decrypted) || undefined, options.md5, options.timelineId, options.mediaId);
        }
        listTasks() {
            return listWechatTasks(this._dirs.decrypted);
        }
        restoreBackup(options) {
            const r = restoreEncryptedBackup(this._dirs.decrypted, options.name, options.password);
            this.op('backup', 'restore_backup', r.ok ? 'ok' : 'fail', options.name, r.path ?? r.error ?? '');
            return r;
        }
        searchUnified(options) {
            return searchUnified(this._dirs.decrypted, options.query, options.limit);
        }
        setPrivacyState(options) {
            try {
                writePrivacySettings(this._dirs.decrypted, options);
                const snapshot = getPrivacyStateSnapshot(this._dirs.decrypted);
                this.op('settings', 'set_privacy_state', 'ok', '', `脱敏=${options.redactSensitive ?? '不变'}，出站拦截=${options.blockOutbound ?? '不变'}`);
                return snapshot;
            }
            catch (e) {
                this.op('settings', 'set_privacy_state', 'fail', '', e.message);
                throw e;
            }
        }
        setTaskStatus(options) {
            const r = setTaskStatus(this._dirs.decrypted, options.id, options.status);
            this.op('task', 'set_task_status', r.ok ? 'ok' : 'fail', `id=${options.id}`, r.error ?? options.status);
            return r;
        }
        syncHandoffTasks() {
            const r = importHandoffTasks(this._dirs.decrypted);
            this.op('task', 'sync_handoff_tasks', r.ok ? 'ok' : 'fail', '', r.error ?? `导入 ${r.added ?? 0} 条`);
            return r;
        }
    };
})();
export { WechatDataGateway };
export default WechatDataGateway;
//# sourceMappingURL=gateway.js.map