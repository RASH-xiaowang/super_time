# Remote 接口参考

> ⚙️ 本文件由 `npm run docs:api` 从 `src/backend/wechat-data/src/gateway.ts` 的
> `@Remote('name')` 装饰器**自动生成**，请勿手工编辑；改了 gateway 请重跑生成命令。
> CI 的 `npm run docs:api:check` 会在文档与源码不一致时失败。

当前共 **135** 个 Remote 方法。

渲染进程通过这些方法与后端通信（`gateway.ts` 是唯一分发点）：
渲染层 → `preload.js` 的 `window.electronAPI.wechat.call(name, args)` → 主进程授权闸门 →
后端 worker → `gateway` 的同名方法。前端手写镜像 `WechatRemote`
（`src/client/ui-wechat/src/client/pages/wechat-data/api.ts`）必须与之一一对应，
由 `src/backend/wechat-data/tests/remote-contract.spec.ts` 守住。

## 概览

| # | 方法 | 说明 |
|---|---|---|
| 1 | `addTask` | Add a WeChat task. |
| 2 | `askWechat` | AI Q&A over WeChat data: retrieve context + DSH LLM answer with citations. |
| 3 | `autoGetDbKey` | Auto-recover the V4 database key from the running WeChat process (key_v4 memory scan + Weixin.dll internal-ke… |
| 4 | `autoGetImageKey` | Auto-recover the image key (V2-verified): a saved-and-valid config key pair is returned first; otherwise the … |
| 5 | `buildRagVectorIndex` | 立即构建/增量更新稠密向量索引（设置面板的「重建向量索引」按钮）。 |
| 6 | `buildSearchIndex` | Build (or rebuild) the FTS5 message search index. |
| 7 | `cancelExportJob` | Cancel one running export/backup job (M3). |
| 8 | `clearAllSessionDrafts` | Clear all session drafts, returning the cleared list. |
| 9 | `clearOperationLog` | — |
| 10 | `clearPrivacyAudit` | — |
| 11 | `clearSessionDraft` | Clear one session draft (decrypted copy only). |
| 12 | `createBackup` | Create a local backup snapshot. |
| 13 | `createEncryptedBackup` | — |
| 14 | `decryptAllDatabases` | Full SQLCipher decryption: every .db under db_storage is re-decrypted into the decrypted snapshot (逐库原子发布,单库失… |
| 15 | `decryptAllImages` | Batch-decode every md5-prefixed .dat image under msg/attach into the decoded-images cache (并行池,已缓存/HEVC 跳过)。实… |
| 16 | `deleteBackup` | Delete one backup by name. |
| 17 | `deleteFavoriteItems` | Delete favorite items by local_id. |
| 18 | `deleteNote` | Delete one knowledge note. |
| 19 | `deleteSummaryRecord` | Delete one generated summary record. |
| 20 | `deleteSummaryTask` | Delete a daily-summary task. |
| 21 | `deleteTask` | — |
| 22 | `detectWechatAccounts` | Detect installed WeChat 4.x accounts. |
| 23 | `downloadWhisperModel` | Download one official whisper.cpp ggml model into the models dir (streamed, atomic publish; huggingface.co wi… |
| 24 | `editChatMessage` | Edit one message content (records the original in the edit store). |
| 25 | `evaluateRetrieval` | 跑离线召回评估（合成评测集），并给出「混合 vs 纯稀疏」的消融对比。 |
| 26 | `exportAllSessions` | Export ALL sessions as a single txt ZIP archive (账号归档). |
| 27 | `exportAnnualReport` | — |
| 28 | `exportCsv` | — |
| 29 | `exportMoments` | Export moments (朋友圈) with author + keyword + time filters. |
| 30 | `exportSessionMessages` | Export a conversation messages to txt/csv/excel/html. |
| 31 | `exportSnsVideo` | 把一条朋友圈视频（本机缓存优先，否则 CDN 取回+解密）写到用户选定路径。 |
| 32 | `extractTasks` | — |
| 33 | `generateDailySummary` | Generate a daily chat summary for one date via DSH LLM. |
| 34 | `generateKeysFile` | Verify all DBs in db_dir and write all_keys.json. |
| 35 | `generatePeriodSummary` | — |
| 36 | `getAnnual` | Annual years. |
| 37 | `getAnnualReport` | — |
| 38 | `getAnnualReview` | 年度回顾（看板）：15 张卡片所需的完整年度聚合。 |
| 39 | `getArticleCover` | Resolve a 公众号 article cover (og:image) to a base64 data URL. |
| 40 | `getAssetInsights` | — |
| 41 | `getAvatar` | Resolve a user avatar (head_image.db data or contact URL). |
| 42 | `getAvatarsLocal` | 批量读取头像(head_image.db 优先,未命中再用 contact 表 URL 兜底;一次 RPC)。 |
| 43 | `getCalls` | — |
| 44 | `getContact360` | — |
| 45 | `getContacts` | Contact book. |
| 46 | `getDailyCounts` | Per-day message counts for one month (chat calendar heatmap). |
| 47 | `getDbHealth` | — |
| 48 | `getDbStatus` | Decrypted DB status summary. |
| 49 | `getDecryptStatus` | Live decryption progress snapshot (polled by the settings panel). |
| 50 | `getEmoticonDataUrl` | Resolve a custom emoticon (sticker) md5 to an offline base64 data URL. |
| 51 | `getEmoticons` | Custom emoticons. |
| 52 | `getExportProgress` | Poll one export/backup job's latest progress (M3). |
| 53 | `getFavorites` | Favorites list. |
| 54 | `getFileImageDataUrl` | Resolve a file-library image (hardlink md5) to an offline base64 data URL. |
| 55 | `getFiles` | Resource files. |
| 56 | `getGraph` | Relationship graph. |
| 57 | `getGroupInfo` | Group chat info (群聊信息): name/remark, announcement, own alias, member grid and local settings mirror. |
| 58 | `getGroupInsights` | — |
| 59 | `getHandoffReminds` | 保留理由：读 `general.db` 的 `handoff_remind_v0`（微信自带待办提醒）。本机实测**这张表不存在** （22 个库里没有任何 `handoff%` 表）⇒ 界面若直接接上去只会永远显示空… |
| 60 | `getImageDataUrl` | Decode one message image to a base64 data URL. |
| 61 | `getImageDataUrlsBatch` | Decode a whole batch of message images to base64 data URLs (N16). |
| 62 | `getKnowledgeGraph` | Knowledge graph: note nodes, `[[…]]` edges and unresolved stubs. |
| 63 | `getLedger` | — |
| 64 | `getMediaAssets` | — |
| 65 | `getMessageFile` | Resolve a received message file (msg/file) to a base64 data URL. |
| 66 | `getMessages` | Messages of one talker. |
| 67 | `getMoments` | Moments page. |
| 68 | `getMomentsAuthors` | Full-history author activity counts (ranked desc). |
| 69 | `getMomentsInsights` | — |
| 70 | `getMomentsMonthly` | — |
| 71 | `getNewMessages` | Incremental messages newer than a sort_seq watermark (real-time polling). |
| 72 | `getNotes` | Knowledge notes list. |
| 73 | `getOfficialAssets` | — |
| 74 | `getOperationLog` | — |
| 75 | `getOverview` | — |
| 76 | `getOverviewInsights` | One-screen data overview. |
| 77 | `getPaymentStatus` | Authoritative transfer/redpacket status by message server_id. |
| 78 | `getPrivacyAuditRows` | — |
| 79 | `getPrivacyScan` | Privacy scan. |
| 80 | `getPrivacyState` | — |
| 81 | `getRecords` | Records (revokes/transfers/redpackets/finder/miniprograms/friendverifications). |
| 82 | `getRegionMap` | Friend-region map (世界板块地图): world → country → province → city → friends. |
| 83 | `getRetrievalStatus` | RAG 检索层状态：配置 + 向量库 + 反馈统计 + 当前调参权重 + 意图分类自评。 |
| 84 | `getRevoked` | Revoked messages. |
| 85 | `getSearchIndexStatus` | Search index status. |
| 86 | `getSelfUsername` | Return the current account's own WeChat username (user_name). |
| 87 | `getSessions` | — |
| 88 | `getSnsImageDataUrl` | Resolve one SNS (朋友圈) media md5 to an offline base64 data URL from the WeChat cache/<month>/Sns/Img V2-encryp… |
| 89 | `getSnsVideoCoverDataUrl` | Resolve one SNS (朋友圈) video cover. |
| 90 | `getSnsVideoDataUrl` | Resolve one SNS (朋友圈) video body so it can be played inline. |
| 91 | `getStorageStats` | Storage stats. |
| 92 | `getVideoInfo` | Look up one video message: cover thumbnail + the on-disk video path. |
| 93 | `getVoiceDataUrl` | Resolve one voice message to an inline-playable wav data URL. |
| 94 | `getVoiceInfo` | Look up one voice message (silk decode degrades in Node). |
| 95 | `getVoiceTranscript` | Cached transcript for one voice message (if already transcribed). |
| 96 | `getWechatConfig` | WeChat config summary. |
| 97 | `getWechatConfigFull` | Read the full WeChat config (incl. |
| 98 | `getWechatKeysInfo` | Read all_keys.json info. |
| 99 | `getWhisperStatus` | Whisper transcription configuration status: engine detection, CUDA presence, models dir + installed ggml bina… |
| 100 | `installWhisperEngine` | Download + install the whisper.cpp CLI engine into the models dir (`<modelsDir>/bin/whisper-cli.exe`), persis… |
| 101 | `listBackups` | List local WeChat backups. |
| 102 | `listEditedMessages` | List edited messages (optionally for one session). |
| 103 | `listLlmModels` | List the provider's configured models (from the "设置 → 模型" settings section), falling back to the provider cat… |
| 104 | `listLlmProviders` | List the daily-summary model provider(s): the default model's provider (the one the user actually configured)… |
| 105 | `listRetrievalFeedback` | 列出最近的问答反馈 + 汇总统计。 |
| 106 | `listSummaryRecords` | List generated summary records. |
| 107 | `listSummaryTasks` | List daily-summary tasks. |
| 108 | `listTasks` | — |
| 109 | `openConfig` | 保留理由：与「数据配置」面板现有那条路径等价 —— 界面用 `getWechatPathConfig()` 拿到路径后 再 `openPath()` 打开（Settings.tsx）。这里保留一份「直接打开 confi… |
| 110 | `openPath` | Open an owned path (config/output dir/file) with the system default. |
| 111 | `optimizeAskQuestion` | 提问优化：把用户问题改写为更利于本机检索的形式，并给出改进建议。 |
| 112 | `previewBackup` | Preview a backup's contents (bounded file list) before restore. |
| 113 | `resetEditedMessage` | Restore a message to its original content. |
| 114 | `resetRetrievalWeights` | 重置调参权重回默认值（丢弃反馈带来的偏移；反馈记录本身保留）。 |
| 115 | `resolveChatHistory` | — |
| 116 | `restoreBackup` | — |
| 117 | `runSummaryTask` | — |
| 118 | `saveNote` | Create (no `id`) or update (`id` given) one knowledge note. |
| 119 | `saveRetrievalConfig` | 保存检索参数（阈值/权重/容量）。前端面板改一个开关也走这里。 |
| 120 | `saveSummaryTask` | Save (insert/update) a daily-summary task. |
| 121 | `saveWechatConfig` | Save the WeChat config (merge patch). |
| 122 | `searchMembers` | Contact / group-member search. |
| 123 | `searchMessages` | Full-text search over text messages (index first, scan fallback). |
| 124 | `searchUnified` | — |
| 125 | `setCdnImageEnabled` | Set CDN auto-fetch flag. |
| 126 | `setCdnImageLocalDecrypt` | Set CDN local/service decrypt flag. |
| 127 | `setPrivacyState` | — |
| 128 | `setTaskStatus` | — |
| 129 | `submitAskFeedback` | 提交问答反馈（目标 5 的闭环入口）。 |
| 130 | `syncHandoffTasks` | — |
| 131 | `toggleSummaryTask` | Toggle a daily-summary task enabled state. |
| 132 | `transcribeVoiceBatch` | Batch-transcribe the most recent voice messages: silk → WAV (bundled wx_silk) → whisper-cli with the selected… |
| 133 | `transcribeVoiceMessage` | Transcribe one voice message on demand (chat bubble 语音转文字). |
| 134 | `verifyDatabaseKey` | Verify a database key (SQLCipher PBKDF2 + AES + HMAC). |
| 135 | `verifyImageKey` | — |

## 明细

### `addTask`

```ts
addTask(options: { title: string; dueAt?: number }): TaskMutationResult
```

Add a WeChat task.

- @param options - title + optional dueAt.
- @returns TaskMutationResult.

### `askWechat`

```ts
async askWechat(options: { question: string username?: string from?: string to?: string history?: Array<{ role: 'user' | 'assistant'; content: string }> streamId?: string }): Promise<AskResult>
```

AI Q&A over WeChat data: retrieve context + DSH LLM answer with citations.

- @param options - question to ask over the WeChat data.
- @returns AskResult: LLM answer with citations.

### `autoGetDbKey`

```ts
async autoGetDbKey(options: { dbPath?: string; wechatInstallDir?: string }): Promise<AutoDbKeyResult>
```

Auto-recover the V4 database key from the running WeChat process (key_v4 memory scan + Weixin.dll internal-key unmask).

- @param options - optional probe db path and install dir.
- @returns AutoDbKeyResult: ok + 64-hex key, or an error.

### `autoGetImageKey`

```ts
async autoGetImageKey(options: { accountDir?: string; pid?: number }): Promise<AutoImageKeyResult>
```

Auto-recover the image key (V2-verified): a saved-and-valid config key pair is returned first; otherwise the running WeChat process memory is scanned.

- @param options - account dir (wxid_* 文件夹或其 db_storage) and optional pid.
- @returns AutoImageKeyResult: ok + xor/aes pair, or an error.

### `buildRagVectorIndex`

```ts
async buildRagVectorIndex(options?: { force?: boolean }): Promise<{ ok: boolean; status: string; rows: number; embedded: number; elapsed_ms: number; message?: string }>
```

立即构建/增量更新稠密向量索引（设置面板的「重建向量索引」按钮）。

- @param options - force=true 时清空重建。
- @returns 构建结果。

### `buildSearchIndex`

```ts
async buildSearchIndex(options?: { force?: boolean }): Promise<SearchBuildResult>
```

Build (or rebuild) the FTS5 message search index.

- @param options - force: rebuild even when the index already exists.
- @returns SearchBuildResult: build outcome with row counts.

### `cancelExportJob`

```ts
cancelExportJob(options: { jobId: string }): { ok: boolean; error?: string }
```

Cancel one running export/backup job (M3).  渲染层点「取消」时调用：这里只唤醒 AbortController，真正的收尾（不留半成品）由 query 层在各耗时循环的检查点完成（`throwIfCancelled` + temp+rename）。

- @param options - jobId the renderer passed to the export call.
- @returns ok when a running job was aborted; error otherwise.

### `clearAllSessionDrafts`

```ts
clearAllSessionDrafts(): DraftsClearResult
```

Clear all session drafts, returning the cleared list.

- @returns DraftsClearResult: cleared session list (items + total).

### `clearOperationLog`

```ts
clearOperationLog(): OperationLogClearResult
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `clearPrivacyAudit`

```ts
clearPrivacyAudit(): PrivacyAuditClearResult
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `clearSessionDraft`

```ts
clearSessionDraft(options: { username: string }): DraftClearResult
```

Clear one session draft (decrypted copy only).

- @param options - username of the session to clear.
- @returns DraftClearResult: ok, or error on failure.

### `createBackup`

```ts
createBackup(): BackupMutationResult
```

Create a local backup snapshot.

- @returns BackupMutationResult: ok + backup name, or error.

### `createEncryptedBackup`

```ts
async createEncryptedBackup(options: { password: string; jobId?: string }): Promise<BackupMutationResult>
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `decryptAllDatabases`

```ts
async decryptAllDatabases(): Promise<DecryptAllResult>
```

Full SQLCipher decryption: every .db under db_storage is re-decrypted into the decrypted snapshot (逐库原子发布,单库失败不中断)。实时进度 通过 getDecryptStatus 轮询读取。

- @returns DecryptAllResult: total/ok/failed counts.

### `decryptAllImages`

```ts
async decryptAllImages(options: { concurrency?: number }): Promise<DecryptImagesResult>
```

Batch-decode every md5-prefixed .dat image under msg/attach into the decoded-images cache (并行池,已缓存/HEVC 跳过)。实时进度通过 getDecryptStatus 轮询读取。

- @param options - optional worker concurrency (clamped 1..32).
- @returns DecryptImagesResult: total/ok/failed/skipped counts.

### `deleteBackup`

```ts
deleteBackup(options: { name: string }): BackupMutationResult
```

Delete one backup by name.

- @param options - name of the backup to delete.
- @returns BackupMutationResult: ok, or error on failure.

### `deleteFavoriteItems`

```ts
deleteFavoriteItems(options: { ids: number[] }): DeleteFavoriteResult
```

Delete favorite items by local_id.

- @param options - ids of the favorite items to delete.
- @returns DeleteFavoriteResult: ok + deleted count, or error.

### `deleteNote`

```ts
deleteNote(options: { id: number }): NoteMutationResult
```

Delete one knowledge note.

- @param options - Note id.
- @returns NoteMutationResult.

### `deleteSummaryRecord`

```ts
deleteSummaryRecord(options: { id: number }): SummaryTaskMutationResult
```

Delete one generated summary record.

- @param options - id of the record to delete.
- @returns SummaryTaskMutationResult: ok, or error on failure.

### `deleteSummaryTask`

```ts
deleteSummaryTask(options: { id: number }): SummaryTaskMutationResult
```

Delete a daily-summary task.

- @param options - id of the task to delete.
- @returns SummaryTaskMutationResult: ok, or error on failure.

### `deleteTask`

```ts
deleteTask(options: { id: number }): TaskMutationResult
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `detectWechatAccounts`

```ts
detectWechatAccounts(): AccountsSnapshot
```

Detect installed WeChat 4.x accounts.

- @returns AccountsSnapshot: detected accounts (accounts + total).

### `downloadWhisperModel`

```ts
async downloadWhisperModel(options: { model: string }): Promise<WhisperDownloadResult>
```

Download one official whisper.cpp ggml model into the models dir (streamed, atomic publish; huggingface.co with hf-mirror fallback).

- @param options - model id to download.
- @returns WhisperDownloadResult: ok + file/bytes, or an error.

### `editChatMessage`

```ts
editChatMessage(options: { username: string; localId: number; content: string }): EditMutationResult
```

Edit one message content (records the original in the edit store).

- @param options - username, localId and new content.
- @returns EditMutationResult: ok, or error on failure.

### `evaluateRetrieval`

```ts
evaluateRetrieval(options?: { k?: number }): { report: string hybrid: { precision: number; recall: number; mrr: number; ndcg: number; map: number; cases: number; hits: number } sparseOnly: { precision: number; recall: number; mrr: number; ndcg: number; map: number; cases: number; hits: number } intentAccuracy: { correct: number; total: number; accuracy: number } }
```

跑离线召回评估（合成评测集），并给出「混合 vs 纯稀疏」的消融对比。  不依赖真实数据，因此可以随时在设置面板点一下就看到当前算法的 P/R/MRR/NDCG， 也可以在 CI 里断言「混合不低于纯稀疏」防止退化。

- @param options - k（截断位置，默认 10）。
- @returns 可读报告 + 结构化指标。

### `exportAllSessions`

```ts
async exportAllSessions(options?: { dir?: string; filename?: string; jobId?: string }): Promise<ExportResult>
```

Export ALL sessions as a single txt ZIP archive (账号归档).

- @param options - optional dir/filename（+ 可选的 jobId：订阅 `wechat-export/progress` 进度并允许取消）.
- @returns ExportResult: written zip path + total messages.

### `exportAnnualReport`

```ts
exportAnnualReport(options: { year: number; format: string; dir?: string; filename?: string }): ExportResult
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `exportCsv`

```ts
exportCsv(options: { kind: string; recordsKind?: string }): ExportResult
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `exportMoments`

```ts
async exportMoments(options?: { format?: string username?: string authorName?: string q?: string images?: boolean media?: string month?: string mine?: string zip?: boolean from?: number to?: number dir?: string filename?: string jobId?: string }): Promise<ExportResult>
```

Export moments (朋友圈) with author + keyword + time filters.

- @param options - format/username/authorName/q/from/to/dir/filename (+ 可选的 jobId 订阅进度/取消).
- @returns ExportResult: written file path + count.

### `exportSessionMessages`

```ts
async exportSessionMessages(options: { username: string format: string count?: number dir?: string types?: number[] richTypes?: string[] from?: number to?: number filename?: string zip?: boolean }): Promise<ExportResult>
```

Export a conversation messages to txt/csv/excel/html.  M3：本入口改为 `async` 并走**流式**实现 —— 同步版必须「先把整份 xlsx 拼进内存」， 行数一大峰值就与行数成正比；`exportSessionMessagesStreamed` 把 sheet 逐块写进 zip 条目 （峰值与行数无关）。契约没变：仍是 `Promise<ExportResult>`，客户端镜像无需改。

- @param options - username, export format and optional message count.
- @returns ExportResult: exported file path/count info.

### `exportSnsVideo`

```ts
async exportSnsVideo(options: { md5?: string; timelineId?: string; mediaId?: string; url?: string; key?: string; dest: string }): Promise<{ ok: boolean; bytes?: number; source?: string; error?: string }>
```

把一条朋友圈视频（本机缓存优先，否则 CDN 取回+解密）写到用户选定路径。  为什么放在后端写：视频本体几十 MB，走渲染端 `<a download>` 既落不了盘 （实测点了没反应），把 base64 经 IPC 传回主进程也白白多一次几十 MB 的拷贝。 这里直接取字节写文件 —— 路径由主进程的保存对话框给出。 

- @param options - 缓存键 / 远端地址与种子 / 目标路径。
- @returns ok + 字节数，或错误说明。

### `extractTasks`

```ts
extractTasks(options?: { days?: number }): TaskMutationResult
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `generateDailySummary`

```ts
async generateDailySummary(options: { date: string; provider?: string; model?: string }): Promise<DailySummaryResult>
```

Generate a daily chat summary for one date via DSH LLM.

- @param options - date (YYYY-MM-DD) to summarize.
- @returns DailySummaryResult: summary text with session/message counts.

### `generateKeysFile`

```ts
generateKeysFile(options: { dbDir: string; keysFile: string; encKeyHex: string; keyFormat?: string }): GenerateKeysResult
```

Verify all DBs in db_dir and write all_keys.json.

- @param options - dbDir, keysFile, encKeyHex and optional keyFormat.
- @returns GenerateKeysResult: generation outcome.

### `generatePeriodSummary`

```ts
async generatePeriodSummary(options: { from: string; to: string; provider?: string; model?: string }): Promise<PeriodSummaryResult>
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `getAnnual`

```ts
getAnnual(): AnnualSnapshot
```

Annual years.

- @returns AnnualSnapshot: available yearly overview data.

### `getAnnualReport`

```ts
getAnnualReport(options: { year: number }): AnnualReport
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `getAnnualReview`

```ts
getAnnualReview(options: { year: number }): AnnualReview
```

年度回顾（看板）：15 张卡片所需的完整年度聚合。 「人物类」指标只算我发出的（real_sender_id 归属），「规模类」算全部消息。

- @param options - year to compute the report for.
- @returns AnnualReview: 完整看板数据。

### `getArticleCover`

```ts
async getArticleCover(options: { contentUrl: string }): Promise<ImageDataUrlResult>
```

Resolve a 公众号 article cover (og:image) to a base64 data URL.

- @param options - mp.weixin.qq.com article URL.
- @returns ImageDataUrlResult: base64 data URL or error.

### `getAssetInsights`

```ts
getAssetInsights(): AssetInsightsSnapshot
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `getAvatar`

```ts
getAvatar(options: { username: string; nickname?: string }): AvatarResult
```

Resolve a user avatar (head_image.db data or contact URL).

- @param options - username to resolve the avatar for.
- @returns AvatarResult: avatar data URL or fallback info.

### `getAvatarsLocal`

```ts
getAvatarsLocal(options: { usernames: string[] }): Record<string, string>
```

批量读取头像(head_image.db 优先,未命中再用 contact 表 URL 兜底;一次 RPC)。

- @param options - usernames 列表。
- @returns username → data URL(本地)或 https URL(远端兜底)映射;未命中的不在其中。

### `getCalls`

```ts
getCalls(options?: { topPeers?: number; recentLimit?: number }): CallsSnapshot
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `getContact360`

```ts
getContact360(options: { username: string }): Contact360Snapshot
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `getContacts`

```ts
getContacts(options?: { limit?: number; offset?: number }): ContactsSnapshot
```

Contact book.

- @param options - Optional page size + offset for incremental loading.
- @returns ContactsSnapshot: contacts list (items + total) + per-category stats.

### `getDailyCounts`

```ts
getDailyCounts(options: { username: string; year: number; month: number }): CalendarSnapshot
```

Per-day message counts for one month (chat calendar heatmap).

- @param options - username, year and month to aggregate.
- @returns CalendarSnapshot: per-day message counts.

### `getDbHealth`

```ts
getDbHealth(): DbHealthSnapshot
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `getDbStatus`

```ts
getDbStatus(): DbStatusSnapshot
```

Decrypted DB status summary.

- @returns DbStatusSnapshot: per-database status summary.

### `getDecryptStatus`

```ts
getDecryptStatus(): DecryptStatus
```

Live decryption progress snapshot (polled by the settings panel).

- @returns DecryptStatus: op/done/total/failed/skipped + current item.

### `getEmoticonDataUrl`

```ts
async getEmoticonDataUrl(options: { md5: string; emojiUrl?: string }): Promise<ImageDataUrlResult>
```

Resolve a custom emoticon (sticker) md5 to an offline base64 data URL. 先读 decoded 缓存 → 扫 msg/attach 与微信的表情缓存目录里解密； 本地解不开时（微信 4.x 的表情缓存是加密文件，项目里没有对应解码器） 用消息 XML 带来的 `cdnurl` 下载一次并落进 decoded 缓存。

- @param options - emoticon md5 (+ optional CDN url from the message).
- @returns ImageDataUrlResult: base64 data URL or error.

### `getEmoticons`

```ts
getEmoticons(options?: { limit?: number; offset?: number }): EmoticonsSnapshot
```

Custom emoticons.

- @param options - Optional limit/offset for incremental loading.
- @returns EmoticonsSnapshot: emoticon items.

### `getExportProgress`

```ts
getExportProgress(options: { jobId: string }): { found: boolean phase: string done: number total: number finished: boolean error?: string }
```

Poll one export/backup job's latest progress (M3).  为什么除了事件推送还要有这个轮询入口：进度事件要经过「宿主事件 → 渲染层」的中继， 而中继只对白名单事件名生效（见 `ui-app/ui-entry.tsx`）。轮询不依赖中继，是 「进度确实推得出去」的那条兜底路径。

- @param options - jobId the renderer passed to the export call.
- @returns 最近一次进度；`found:false` 表示 jobId 未知（如进程重启过）。

### `getFavorites`

```ts
getFavorites(options?: { limit?: number; offset?: number }): FavoritesSnapshot
```

Favorites list.

- @param options - Optional limit for the number of rows returned.
- @returns FavoritesSnapshot: favorite items (items + total).

### `getFileImageDataUrl`

```ts
getFileImageDataUrl(options: { md5: string }): ImageDataUrlResult
```

Resolve a file-library image (hardlink md5) to an offline base64 data URL. 优先读已解密缓存，否则通过 hardlink.db 定位 .dat 原图解密。

- @param options - file md5.
- @returns ImageDataUrlResult: base64 data URL or error.

### `getFiles`

```ts
getFiles(options?: { limit?: number; offset?: number; category?: string }): FilesSnapshot
```

Resource files.

- @param options - Optional limit/offset and category filter for incremental loading.
- @returns FilesSnapshot: resource file items.

### `getGraph`

```ts
getGraph(): GraphSnapshot
```

Relationship graph.

- @returns GraphSnapshot: chat relationship graph data.

### `getGroupInfo`

```ts
getGroupInfo(options: { username: string }): GroupInfoSnapshot
```

Group chat info (群聊信息): name/remark, announcement, own alias, member grid and local settings mirror.

- @param options - chatroom username.
- @returns GroupInfoSnapshot: the group (null when unknown).

### `getGroupInsights`

```ts
getGroupInsights(options: { username: string }): GroupInsightsSnapshot
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `getHandoffReminds`

```ts
getHandoffReminds(): HandoffRemindsSnapshot
```

保留理由：读 `general.db` 的 `handoff_remind_v0`（微信自带待办提醒）。本机实测**这张表不存在** （22 个库里没有任何 `handoff%` 表）⇒ 界面若直接接上去只会永远显示空列表，因此只保留接口； 「待办日程」面板用的是导入路径 `syncHandoffTasks`（把源数据落进插件自己的任务库）。

### `getImageDataUrl`

```ts
getImageDataUrl(options: { username: string; localId: number }): ImageDataUrlResult
```

Decode one message image to a base64 data URL.

- @param options - username and localId of the message image.
- @returns ImageDataUrlResult: base64 data URL or error.

### `getImageDataUrlsBatch`

```ts
getImageDataUrlsBatch(options: { items: Array<{ username: string; localId: number }> }): { items: ImageBatchItem[] }
```

Decode a whole batch of message images to base64 data URLs (N16).  为什么需要批量入口：`getImageDataUrl` 是**一图一次 RPC**，而每张图内部的路径解析 （`WHERE lower(md5) = ?`）在 `image_hardlink_info_v4` 上是全表扫 —— 实测 20 万行 17.27ms/次，30 张图各查一次 ≈518ms。这里先用一次 `IN (...)` 把整批 md5 的 .dat 路径 查出来并预热解码缓存，之后逐张走原有单张入口时命中缓存，不再各扫一次路径表。  诚实边界：① 单张的 md5 仍要各查一次消息分片（`resolveImageResourceHint`，`WHERE local_id = ?`，不是那个全表扫）；② 拿不到原始微信目录（`wechatBaseDir` 未知）时批量 路径查不出东西，行为与逐张调用完全一致。

- @param options - `items`: 一批 (username, localId)；超过 {@link IMAGE_BATCH_MAX} 的截断。
- @returns 与传入顺序一一对应的条目（`url` 或 `error`，语义同单张入口）。

### `getKnowledgeGraph`

```ts
getKnowledgeGraph(): KnowledgeSnapshot
```

Knowledge graph: note nodes, `[[…]]` edges and unresolved stubs.  与 `getGraph` 分开而不是合并：社交图谱的节点口径（联系人/群/我）和知识图谱 （笔记/未解析目标）是两套语义，合并会让两个面板都变脆；融合视图交给前端把 两份快照按 `sourceUsername` 拼起来（笔记 → 来源会话）。

- @returns KnowledgeSnapshot.

### `getLedger`

```ts
getLedger(options?: { month?: string }): LedgerSnapshot
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `getMediaAssets`

```ts
getMediaAssets(): MediaAssetsSnapshot
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `getMessageFile`

```ts
getMessageFile(options: { fileName: string; size?: number; createTime?: number }): ImageDataUrlResult
```

Resolve a received message file (msg/file) to a base64 data URL.

- @param options - original file name from the message card.
- @returns ImageDataUrlResult: data URL or error.

### `getMessages`

```ts
getMessages(options: { talker: string; limit?: number; cursor?: number; cursorLocalId?: number }): MessagesSnapshot
```

Messages of one talker.

- @param options - Talker username, optional limit and pagination cursor.
- @returns MessagesSnapshot: message items for the talker.

### `getMoments`

```ts
getMoments(options?: { offset?: number; limit?: number; author?: string }): MomentsSnapshot
```

Moments page.

- @param options - Pagination (offset/limit) and optional author filter.
- @returns MomentsSnapshot: moments items (items + total).

### `getMomentsAuthors`

```ts
getMomentsAuthors(): Array<{ name: string; count: number }>
```

Full-history author activity counts (ranked desc).

- @returns Array of { name, count } for every moments author.

### `getMomentsInsights`

```ts
getMomentsInsights(options?: { author?: string }): MomentsInsightsSnapshot
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `getMomentsMonthly`

```ts
getMomentsMonthly(options?: { author?: string; authorName?: string }): MomentsMonthlyRow[]
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `getNewMessages`

```ts
getNewMessages(options: { talker: string; after: number; limit?: number }): MessagesSnapshot
```

Incremental messages newer than a sort_seq watermark (real-time polling).

- @param options - talker, after watermark, optional limit.
- @returns MessagesSnapshot with only the newer messages.

### `getNotes`

```ts
getNotes(options?: { query?: string; limit?: number }): NotesSnapshot
```

Knowledge notes list.

- @param options - Optional case-insensitive search query and row cap.
- @returns NotesSnapshot: notes (newest first) plus the unpaged total.

### `getOfficialAssets`

```ts
getOfficialAssets(): OfficialAssetsSnapshot
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `getOperationLog`

```ts
getOperationLog(options?: OperationLogQuery): OperationLogSnapshot
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `getOverview`

```ts
getOverview(): OverviewSnapshot
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `getOverviewInsights`

```ts
getOverviewInsights(): OverviewInsights
```

One-screen data overview.

- @returns OverviewSnapshot: aggregate counts for the overview screen.

### `getPaymentStatus`

```ts
getPaymentStatus(options: { serverId: string }): PaymentStatus
```

Authoritative transfer/redpacket status by message server_id.

- @param options - the message server_id (string, may exceed 2^53).
- @returns PaymentStatus: found flag plus authoritative fields.

### `getPrivacyAuditRows`

```ts
getPrivacyAuditRows(): PrivacyAuditRow[]
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `getPrivacyScan`

```ts
getPrivacyScan(): PrivacySnapshot
```

Privacy scan.

- @returns PrivacySnapshot: privacy scan result.

### `getPrivacyState`

```ts
getPrivacyState(): PrivacyStateSnapshot
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `getRecords`

```ts
getRecords(options: { kind: string; limit?: number; offset?: number; q?: string; from?: number; to?: number; direction?: 'asc' | 'desc' }): RecordsSnapshot
```

Records (revokes/transfers/redpackets/finder/miniprograms/friendverifications).

- @param options - Record kind to query plus pagination/filter options.
- @returns RecordsSnapshot: record items (items + total).

### `getRegionMap`

```ts
getRegionMap(): RegionMapSnapshot
```

Friend-region map (世界板块地图): world → country → province → city → friends.

- @returns RegionMapSnapshot.

### `getRetrievalStatus`

```ts
getRetrievalStatus(): { enabled: boolean config: unknown vector: { rows: number; dim: number; model: string } feedback: { total: number; up: number; down: number } weights: RerankWeights intentAccuracy: { correct: number; total: number; accuracy: number } }
```

RAG 检索层状态：配置 + 向量库 + 反馈统计 + 当前调参权重 + 意图分类自评。

- @returns 供「数据健康 / 检索设置」面板展示。

### `getRevoked`

```ts
getRevoked(options?: { limit?: number; offset?: number }): RevokedSnapshot
```

Revoked messages.

- @param options - Optional limit for the number of rows returned.
- @returns RevokedSnapshot: revoked message items.

### `getSearchIndexStatus`

```ts
getSearchIndexStatus(): SearchIndexStatus
```

Search index status.

- @returns SearchIndexStatus: whether the FTS5 index exists and its row count.

### `getSelfUsername`

```ts
getSelfUsername(): { username: string }
```

Return the current account's own WeChat username (user_name).

- @returns { username } - used by the panel to filter "我" authored comments.

### `getSessions`

```ts
getSessions(options?: { keyword?: string; limit?: number; offset?: number }): SessionsSnapshot
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `getSnsImageDataUrl`

```ts
getSnsImageDataUrl(options: { md5: string; timelineId?: string; mediaId?: string }): ImageDataUrlResult
```

Resolve one SNS (朋友圈) media md5 to an offline base64 data URL from the WeChat cache/<month>/Sns/Img V2-encrypted blobs.

- @param options - media md5 from the moments XML.
- @returns ImageDataUrlResult: base64 data URL or error.

### `getSnsVideoCoverDataUrl`

```ts
async getSnsVideoCoverDataUrl(options: { md5?: string; timelineId?: string; mediaId?: string; thumb?: string; key?: string }): Promise<ImageDataUrlResult>
```

Resolve one SNS (朋友圈) video cover.  先本机缓存（明文、离线）；没有缓存再按 XML 里的 `<thumb>` 从微信 CDN 取回， 取回要过隐私闸门，并按 `<enc key>` 解密加密头（封面同样是加密流）。 

- @param options - XML 里的 md5/缓存键，加上 `<thumb>` 地址与 `<enc key>` 种子。
- @returns ImageDataUrlResult。

### `getSnsVideoDataUrl`

```ts
async getSnsVideoDataUrl(options: { md5?: string; timelineId?: string; mediaId?: string; url?: string; key?: string }): Promise<ImageDataUrlResult>
```

Resolve one SNS (朋友圈) video body so it can be played inline.  两级来源：**先本机缓存**（明文，离线、最快），没有缓存再按朋友圈 XML 里的 `<url>` 从微信 CDN 按需取回。取回要过隐私闸门（与 AI 调用同一套「出站拦截」）， CDN 返回的是客户端加密流，按 `<enc key>` 解密后再**校验容器头与 md5**， 免得把一个放不出来的二进制塞给 <video>。 

- @param options - media md5 from the moments XML（+ 本地缓存键、`<url>` 与 `<enc key>`）。
- @returns ImageDataUrlResult: base64 data URL or an error explaining which source failed.

### `getStorageStats`

```ts
getStorageStats(): StorageSnapshot
```

Storage stats.

- @returns StorageSnapshot: per-category storage usage stats.

### `getVideoInfo`

```ts
getVideoInfo(options: { username: string; localId: number }): VideoInfoResult
```

Look up one video message: cover thumbnail + the on-disk video path. 封面与实体都在真实微信目录 `msg/video` 下，所以要带上数据根目录。

- @param options - username and localId of the video message.
- @returns VideoInfoResult: video cover/thumbnail info.

### `getVoiceDataUrl`

```ts
getVoiceDataUrl(options: { username: string; localId: number }): VoiceDataUrlResult
```

Resolve one voice message to an inline-playable wav data URL. 语音实体是 silk，需要解码成 wav 才能播；产物落在转写链路同一份缓存里。

- @param options - username and localId of the voice message.
- @returns VoiceDataUrlResult: base64 wav data URL (+ duration) or error.

### `getVoiceInfo`

```ts
getVoiceInfo(options: { username: string; localId: number }): VoiceInfoResult
```

Look up one voice message (silk decode degrades in Node).

- @param options - username and localId of the voice message.
- @returns VoiceInfoResult: voice metadata / decoded file info.

### `getVoiceTranscript`

```ts
getVoiceTranscript(options: { username: string; localId: number }): VoiceTranscriptResult
```

Cached transcript for one voice message (if already transcribed).

- @param options - message username + local_id.
- @returns VoiceTranscriptResult: text or an error.

### `getWechatConfig`

```ts
getWechatConfig(): ConfigSnapshot
```

WeChat config summary.

- @returns ConfigSnapshot: current WeChat config summary.

### `getWechatConfigFull`

```ts
getWechatConfigFull(): WechatConfigFull
```

Read the full WeChat config (incl. keys + resolved paths).

- @returns WechatConfigFull: complete config with resolved paths.

### `getWechatKeysInfo`

```ts
getWechatKeysInfo(): KeysInfoResult
```

Read all_keys.json info.

- @returns KeysInfoResult: key format/count/loaded state.

### `getWhisperStatus`

```ts
getWhisperStatus(): WhisperStatus
```

Whisper transcription configuration status: engine detection, CUDA presence, models dir + installed ggml binaries, active download progress (inference itself stays bridge-side).

- @returns WhisperStatus: engine/hasCuda/models inventory.

### `installWhisperEngine`

```ts
async installWhisperEngine(): Promise<WhisperDownloadResult>
```

Download + install the whisper.cpp CLI engine into the models dir (`<modelsDir>/bin/whisper-cli.exe`), persisting the path as whisper_bin.

- @returns WhisperDownloadResult: ok + path, or an error.

### `listBackups`

```ts
listBackups(): BackupSnapshot
```

List local WeChat backups.

- @returns BackupSnapshot: backup entries (items + total).

### `listEditedMessages`

```ts
listEditedMessages(options?: { sessionId?: string }): EditedListSnapshot
```

List edited messages (optionally for one session).

- @param options - optional sessionId filter.
- @returns EditedListSnapshot: edited message records (items + total).

### `listLlmModels`

```ts
async listLlmModels(options: { provider: string }): Promise<{ models: Array<{ id: string; name: string }> }>
```

List the provider's configured models (from the "设置 → 模型" settings section), falling back to the provider catalog.

### `listLlmProviders`

```ts
listLlmProviders(): { providers: Array<{ id: string; name: string }> }
```

List the daily-summary model provider(s): the default model's provider (the one the user actually configured), clean and unambiguous.

### `listRetrievalFeedback`

```ts
listRetrievalFeedback(options?: { limit?: number }): { items: FeedbackRecord[] stats: { total: number; up: number; down: number } }
```

列出最近的问答反馈 + 汇总统计。

- @param options - limit。

### `listSummaryRecords`

```ts
listSummaryRecords(options?: { taskId?: number }): SummaryRecordSnapshot
```

List generated summary records.

- @param options - optional taskId filter.
- @returns SummaryRecordSnapshot: summary records (items + total).

### `listSummaryTasks`

```ts
listSummaryTasks(): SummaryTaskSnapshot
```

List daily-summary tasks.

- @returns SummaryTaskSnapshot: summary tasks (items + total).

### `listTasks`

```ts
listTasks(): TasksSnapshot
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `openConfig`

```ts
async openConfig(signal: AbortSignal): Promise<{ ok: boolean; path: string }>
```

保留理由：与「数据配置」面板现有那条路径等价 —— 界面用 `getWechatPathConfig()` 拿到路径后 再 `openPath()` 打开（Settings.tsx）。这里保留一份「直接打开 config.json」的接口给宿主调用。

### `openPath`

```ts
async openPath(options: { path: string }, signal: AbortSignal): Promise<{ ok: boolean; path: string }>
```

Open an owned path (config/output dir/file) with the system default. @returns the opened path.

### `optimizeAskQuestion`

```ts
async optimizeAskQuestion(options: { question: string username?: string from?: string to?: string history?: Array<{ role: 'user' | 'assistant'; content: string }> }): Promise<AskOptimizeResult>
```

提问优化：把用户问题改写为更利于本机检索的形式，并给出改进建议。 供「微信问答」面板的「优化提问」按钮调用；出站前同样过隐私闸门。

- @param options - question（必填）+ 可选 scope/history 作上下文。
- @returns AskOptimizeResult: optimized + suggestions。

### `previewBackup`

```ts
previewBackup(options: { name: string }): BackupPreviewSnapshot
```

Preview a backup's contents (bounded file list) before restore.

- @param options - backup name.
- @returns BackupPreviewSnapshot: items + total.

### `resetEditedMessage`

```ts
resetEditedMessage(options: { username: string; localId: number }): EditMutationResult
```

Restore a message to its original content.

- @param options - username and localId of the edited message.
- @returns EditMutationResult: ok, or error on failure.

### `resetRetrievalWeights`

```ts
resetRetrievalWeights(): { ok: boolean; weights: RerankWeights }
```

重置调参权重回默认值（丢弃反馈带来的偏移；反馈记录本身保留）。

### `resolveChatHistory`

```ts
resolveChatHistory(options: { serverId: string }): ChatHistoryResolveResult
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `restoreBackup`

```ts
restoreBackup(options: { name: string; password: string }): BackupRestoreResult
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `runSummaryTask`

```ts
async runSummaryTask(options: { id: number }): Promise<SummaryTaskRunResult>
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `saveNote`

```ts
saveNote(options: { id?: number title: string body?: string tags?: string[] | string sourceKind?: 'manual' | 'ask' sourceUsername?: string sourceQuestion?: string }): NoteMutationResult
```

Create (no `id`) or update (`id` given) one knowledge note.  `sourceKind: 'ask'` marks a note distilled from a WeChat Q&A answer — that is the join point with the social graph: the panel draws an edge from the note to its source chat instead of leaving knowledge nodes floating.

- @param options - Note fields; title is required and unique (case-insensitive).
- @returns NoteMutationResult: `{ ok, id }`, or `{ ok: false, error }`.

### `saveRetrievalConfig`

```ts
saveRetrievalConfig(options?: { patch?: unknown } | unknown): { ok: boolean; config: unknown }
```

保存检索参数（阈值/权重/容量）。前端面板改一个开关也走这里。

- @param options - 形如 `{ patch: {...} }`，或直接给字段子集。
- @returns 落盘后的完整配置。

### `saveSummaryTask`

```ts
saveSummaryTask(options: { task: Omit<SummaryTask, 'id' | 'createdAt' | 'updatedAt'> & { id?: number } }): SummaryTaskMutationResult
```

Save (insert/update) a daily-summary task.

- @param options - task payload (id present = update, absent = insert).
- @returns SummaryTaskMutationResult: ok + id, or error.

### `saveWechatConfig`

```ts
saveWechatConfig(options: { patch: WechatConfigPatch }): SimpleResult
```

Save the WeChat config (merge patch).

- @param options - patch of config fields to merge.
- @returns SimpleResult: ok, or error on failure.

### `searchMembers`

```ts
searchMembers(options: { q: string; limit?: number; roomUsername?: string }): MemberSearchSnapshot
```

Contact / group-member search. 保留理由：界面暂无入口（全局搜索走 searchUnified），保留给宿主/后续的群成员选择器。 第 96 轮补上了群内路径漏掉的 `quan_pin`/`alias`（此前「按备注全拼在群里搜人」永远搜不到）， 由 `scripts/check-members-search.js` 对着真实库把关。

- @param options - search term, optional limit and room scope.
- @returns MemberSearchSnapshot: matching members (items + total + source).

### `searchMessages`

```ts
searchMessages(options: { query: string; limit?: number; username?: string }): SearchSnapshot
```

Full-text search over text messages (index first, scan fallback).

- @param options - query string, optional result limit and optional talker scope.
- @returns SearchSnapshot: matched message items.

### `searchUnified`

```ts
searchUnified(options: { query: string; limit?: number }): UnifiedSearchSnapshot
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `setCdnImageEnabled`

```ts
setCdnImageEnabled(options: { enabled: boolean }): SimpleResult
```

Set CDN auto-fetch flag.

- @param options - enabled: whether CDN auto-fetch is on.
- @returns SimpleResult: ok, or error on failure.

### `setCdnImageLocalDecrypt`

```ts
setCdnImageLocalDecrypt(options: { localDecrypt: boolean }): SimpleResult
```

Set CDN local/service decrypt flag.

- @param options - localDecrypt: whether decryption runs locally.
- @returns SimpleResult: ok, or error on failure.

### `setPrivacyState`

```ts
setPrivacyState(options: { redactSensitive?: boolean; blockOutbound?: boolean }): PrivacyStateSnapshot
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `setTaskStatus`

```ts
setTaskStatus(options: { id: number; status: 'open' | 'done' }): TaskMutationResult
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `submitAskFeedback`

```ts
submitAskFeedback(options: { retrievalId?: string rating: 'up' | 'down' useful?: number[] useless?: number[] question?: string answer?: string }): { ok: boolean; adaptedWeights?: RerankWeights; features?: string[]; message?: string }
```

提交问答反馈（目标 5 的闭环入口）。  反馈 → 特征归因 → 权重微调 → 落盘。权重**由全部历史反馈重算**（幂等、可重放）， 而不是在旧权重上累加 —— 累加会因为重复提交同一条反馈而漂移。  N27：同一轮反馈在 10 秒窗口内的重复提交会被挡掉并返回可读的「已在处理」， 不再产生第二条反馈记录 / 第二次权重适配（前端闸门只管同一个面板的连点， 两个面板同时提交、旧版客户端重试、直接 RPC 调用都落到这里）。

- @param options - retrievalId（AskResult 里回传）+ rating + 有用/无用引用序号。
- @returns 调参后的权重；重复提交时 `ok:false` + `message`。

### `syncHandoffTasks`

```ts
syncHandoffTasks(): TaskMutationResult
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_

### `toggleSummaryTask`

```ts
toggleSummaryTask(options: { id: number; enabled: boolean }): SummaryTaskMutationResult
```

Toggle a daily-summary task enabled state.

- @param options - task id and the new enabled flag.
- @returns SummaryTaskMutationResult: ok, or error on failure.

### `transcribeVoiceBatch`

```ts
async transcribeVoiceBatch(options: { limit?: number }): Promise<VoiceTranscribeResult>
```

Batch-transcribe the most recent voice messages: silk → WAV (bundled wx_silk) → whisper-cli with the selected model → text cached per message.

- @param options - optional message count (default 50, clamped 1..200).
- @returns VoiceTranscribeResult: done/failed/skipped counts.

### `transcribeVoiceMessage`

```ts
transcribeVoiceMessage(options: { username: string; localId: number }): VoiceTranscribeOneResult
```

Transcribe one voice message on demand (chat bubble 语音转文字).

- @param options - message username + local_id.
- @returns VoiceTranscribeOneResult: ok + text, or an error.

### `verifyDatabaseKey`

```ts
verifyDatabaseKey(options: { dbPath: string; encKeyHex: string }): VerifyKeyResult
```

Verify a database key (SQLCipher PBKDF2 + AES + HMAC).

- @param options - dbPath and encKeyHex of the key to verify.
- @returns VerifyKeyResult: valid flag plus optional AES/HMAC checks.

### `verifyImageKey`

```ts
verifyImageKey(): VerifyImageKeyResult
```

_（源码中未附说明 —— 请直接阅读 `gateway.ts` 中该方法）_
