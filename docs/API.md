# Remote 接口参考

> ⚙️ 本文件由 `npm run docs:api` 从 `src/backend/wechat-data/src/gateway*.ts` 各网关壳里的
> `@Remote('name')` 装饰器**自动生成**，请勿手工编辑；改了 gateway 请重跑生成命令。
> CI 的 `npm run docs:api:check` 会在文档与源码不一致时失败。

当前共 **195** 个 Remote 方法。

渲染进程通过这些方法与后端通信（方法面分布在 `src/backend/wechat-data/src/gateway*.ts` 的多个网关壳里）：
渲染层 → `preload.js` 的 `window.electronAPI.wechat.call(name, args)` → 主进程授权闸门 →
后端 worker → `gateway` 的同名方法。前端手写镜像 `WechatRemote`
（`src/client/ui-wechat/src/client/pages/wechat-data/api-core.ts`）必须与之一一对应，
由 `src/backend/wechat-data/tests/remote-contract.spec.ts` 守住。

## 概览

| # | 方法 | 说明 |
|---|---|---|
| 1 | `addKbFiles` | 登记一批文件（原生对话框多选的结果）。 |
| 2 | `addTask` | Add a WeChat task. |
| 3 | `adoptLayaModel` | Adopt an already-downloaded model directory (move it into the data dir) so the same 1.26 GB does not have to … |
| 4 | `analyzeMessages` | Analyze one conversation with the **local** decision model (laya · onnxruntime-node + JS tokenizer; no networ… |
| 5 | `analyzeVisibleMessages` | Per-message analysis for the message stream's visible window (local model · no network). |
| 6 | `askWechat` | AI Q&A over WeChat data: retrieve context + DSH LLM answer with citations. |
| 7 | `autoGetDbKey` | Auto-recover the V4 database key from the running WeChat process (key_v4 memory scan + Weixin.dll internal-ke… |
| 8 | `autoGetImageKey` | Auto-recover the image key (V2-verified): a saved-and-valid config key pair is returned first; otherwise the … |
| 9 | `buildKbVectorIndex` | 为**某个库**构建 / 增量更新向量索引（面板上那个「语义索引」按钮）。 |
| 10 | `buildRagVectorIndex` | 立即构建/增量更新稠密向量索引。 |
| 11 | `buildSearchIndex` | Build (or rebuild) the FTS5 message search index. |
| 12 | `cancelAsk` | 取消一轮正在生成的问答（W3-6.1）。 |
| 13 | `cancelExportJob` | Cancel one running export/backup job (M3). |
| 14 | `cancelKbIndexBuild` | 停止本库正在跑的向量构建（W3-11.5）。 |
| 15 | `cancelLayaAnalysis` | 停止一批正在跑的逐条本地分析（W3-11.5）。 |
| 16 | `cancelLayaDownload` | 取消正在进行的 laya 模型下载（W2-11.5）。 |
| 17 | `cancelSearch` | 取消一次正在跑的消息搜索（N9）。 |
| 18 | `cancelSearchIndexBuild` | 停止一次正在跑的搜索索引构建（W3-11.5）。 |
| 19 | `cancelWhisperDownload` | 停止一次正在跑的模型/引擎下载（W3-5.5）。 |
| 20 | `checkClawbotEnv` | 环境自检（精简 3 项：应用运行 / 绑定通道 / 集成状态）—— 第 ② 项读的是该实例的通道。 |
| 21 | `checkDbIntegrity` | 逐库完整性体检（`PRAGMA integrity_check`）—— 「库文件已损坏」那条处方 （`wechat-host.js` 的 READABLE_ERRORS）指向的检查。与 `getDbHealth` 的 … |
| 22 | `clearAllSessionDrafts` | Clear all session drafts, returning the cleared list. |
| 23 | `clearAskHistory` | 清空全部问答历史（由界面上的显式入口 + 二次确认触发，不做任何自动清理）。 |
| 24 | `clearOperationLog` | — |
| 25 | `clearPrivacyAudit` | — |
| 26 | `clearSessionDraft` | Clear one session draft (decrypted copy only). |
| 27 | `createBackup` | Create a local backup snapshot. |
| 28 | `createClawbotBindQr` | 申请绑定二维码（真实调用腾讯 iLink 服务；失败抛可读中文，渲染层按 message 展示）。 |
| 29 | `createClawbotInstance` | 新建一个实例（初始未绑定；随后用 `createClawbotBindQr` 为它取码）。 |
| 30 | `createEncryptedBackup` | — |
| 31 | `createKb` | Create one knowledge base. |
| 32 | `decryptAllDatabases` | Full SQLCipher decryption: every .db under db_storage is re-decrypted into the decrypted snapshot (逐库原子发布,单库失… |
| 33 | `decryptAllImages` | Batch-decode every md5-prefixed .dat image under msg/attach into the decoded-images cache (并行池,已缓存/HEVC 跳过)。实… |
| 34 | `deleteAskHistory` | 删除若干条问答历史。 |
| 35 | `deleteBackup` | Delete one backup by name. |
| 36 | `deleteClawbotInstance` | 删除一个实例（绑定行 + 配置 + **该实例的接入会话**一起删；条数如实回报）。 |
| 37 | `deleteExportHistory` | 删除若干条导出历史记录。 |
| 38 | `deleteFavoriteItems` | Delete favorite items by local_id. |
| 39 | `deleteKb` | Delete one knowledge base. |
| 40 | `deleteKbFile` | 删除一个文件（连带它的分块 / FTS 行 / 向量 / blob 副本）。 |
| 41 | `deleteNote` | Delete one knowledge note. |
| 42 | `deleteSummaryRecord` | Delete one generated summary record. |
| 43 | `deleteSummaryTask` | Delete a daily-summary task. |
| 44 | `deleteTask` | — |
| 45 | `detectWechatAccounts` | Detect installed WeChat 4.x accounts. |
| 46 | `downloadLayaModel` | Download the decision model assets (~1.26 GB: graph + tokenizer) into the data dir. |
| 47 | `downloadWhisperModel` | Download one official whisper.cpp ggml model into the models dir (streamed, atomic publish; huggingface.co wi… |
| 48 | `editChatMessage` | Edit one message content (records the original in the edit store). |
| 49 | `evaluateRetrieval` | 跑离线召回评估（合成评测集），并给出「混合 vs 纯稀疏」的消融对比。 |
| 50 | `exportAllSessions` | Export ALL sessions as a single txt ZIP archive (账号归档). |
| 51 | `exportAnnualReport` | — |
| 52 | `exportCsv` | Export a CSV table. |
| 53 | `exportMoments` | Export moments (朋友圈) with author + keyword + time filters. |
| 54 | `exportSessionMessages` | Export a conversation messages to txt/csv/excel/html. |
| 55 | `exportSnsVideo` | 把一条朋友圈视频（本机缓存优先，否则 CDN 取回+解密）写到用户选定路径。 |
| 56 | `extractKbEntities` | 让模型读一遍本库的文件，抽出实体（推断层）。 |
| 57 | `extractTasks` | — |
| 58 | `fetchOriginalImagesBatch` | 批量取回原图（免登录直链）：全库那 16.6% 一次取完，**可续跑**（`<decoded>/.originals-index.json`）。 |
| 59 | `generateAnnualNarrative` | 生成 AI 年报叙述（W2-8.6）：**分段**取材 → 逐段 LLM → 逐段进度。 |
| 60 | `generateDailySummary` | Generate a daily chat summary for one date via DSH LLM. |
| 61 | `generateKeysFile` | Verify all DBs in db_dir and write all_keys.json. |
| 62 | `generatePeriodSummary` | — |
| 63 | `getAnnual` | Annual years. |
| 64 | `getAnnualReport` | — |
| 65 | `getAnnualReview` | 年度回顾（看板）：15 张卡片所需的完整年度聚合。 |
| 66 | `getArticleCover` | Resolve a 公众号 article cover (og:image) to a base64 data URL. |
| 67 | `getArticleCovers` | 批量解析公众号文章封面（A1，2026-09-28 性能修复）。 |
| 68 | `getAskHistory` | 读取问答历史（供「微信问答 → 历史记录」弹窗）。 |
| 69 | `getAssetInsights` | — |
| 70 | `getAvatar` | Resolve a user avatar (head_image.db data or contact URL). |
| 71 | `getAvatarsLocal` | 批量读取头像(head_image.db 优先,未命中再用 contact 表 URL 兜底;一次 RPC)。 |
| 72 | `getCalls` | — |
| 73 | `getClawbotBindState` | 中继一次绑定状态轮询（弹窗打开期间反复调用；单次最长约 40 秒，见 remote-policy.js）。 |
| 74 | `getClawbotBinding` | 当前绑定行（设置卡片首屏）。 |
| 75 | `getClawbotMedia` | 取某条消息的附件（按需下载 + 解密 + 缓存；只在用户点开时发生）。 |
| 76 | `getContact360` | — |
| 77 | `getContacts` | Contact book. |
| 78 | `getDailyCounts` | Per-day message counts for one month (chat calendar heatmap). |
| 79 | `getDbHealth` | — |
| 80 | `getDbStatus` | Decrypted DB status summary. |
| 81 | `getDecryptStatus` | Live decryption progress snapshot (polled by the settings panel). |
| 82 | `getEmoticonDataUrl` | Resolve a custom emoticon (sticker) md5 to an offline base64 data URL. |
| 83 | `getEmoticonDataUrls` | 批量取表情（E1，2026-09-28 性能修复）。 |
| 84 | `getEmoticons` | Custom emoticons. |
| 85 | `getExportHistory` | 读取导出历史（供「导出记录」弹窗）。 |
| 86 | `getExportProgress` | Poll one export/backup job's latest progress (M3). |
| 87 | `getFavorites` | Favorites list. |
| 88 | `getFileImageDataUrl` | Resolve a file-library image (hardlink md5) to an offline base64 data URL. |
| 89 | `getFiles` | Resource files. |
| 90 | `getGraph` | Relationship graph. |
| 91 | `getGroupInfo` | Group chat info (群聊信息): name/remark, announcement, own alias, member grid and local settings mirror. |
| 92 | `getGroupInsights` | — |
| 93 | `getHandoffReminds` | 保留理由：读 `general.db` 的 `handoff_remind_v0`（微信自带待办提醒）。本机实测**这张表不存在** （22 个库里没有任何 `handoff%` 表）⇒ 界面若直接接上去只会永远显示空… |
| 94 | `getImageDataUrl` | Decode one message image to a base64 data URL. |
| 95 | `getImageDataUrlsBatch` | Decode a whole batch of message images to base64 data URLs (N16)。 |
| 96 | `getImageOriginal` | 取一条图片消息的**原图**，但只走消息里自带的免登录预签名直链（`<img tpurl=…/tphdurl=…>`）。 |
| 97 | `getKbFileChunks` | 读某个文件解析出来的正文（分页）。界面上「就地展开看内容」走这一条。 |
| 98 | `getKbFiles` | 一个知识库里的文件列表（新上传的在前）。 |
| 99 | `getKbModelConfig` | 某个知识库的**模型设置**（三个角色的引用 + 各自实际生效的名字）。 |
| 100 | `getKbVectorIndex` | 某个知识库的**向量索引状态**（面板的「语义索引」按钮与状态 chip 读这个）。 |
| 101 | `getKbs` | Knowledge base list — the scope selector's data source. |
| 102 | `getKnowledgeGraph` | Knowledge graph: note nodes, `[[…]]` edges, unresolved stubs, **plus the document entity layer** (registered … |
| 103 | `getLayaStatus` | Local decision model status: required files (model graph + tokenizer), size, source, active download progress… |
| 104 | `getLedger` | — |
| 105 | `getMapGeoJson` | 公共地图 GeoJSON 的后端代理。 |
| 106 | `getMediaAssets` | — |
| 107 | `getMessageFile` | Resolve a received message file (msg/file) to a base64 data URL. |
| 108 | `getMessages` | Messages of one talker. |
| 109 | `getMoments` | Moments page. |
| 110 | `getMomentsAuthors` | Full-history author activity counts (ranked desc). |
| 111 | `getMomentsInsights` | — |
| 112 | `getMomentsMonthly` | — |
| 113 | `getNewMessages` | Incremental messages newer than a sort_seq watermark (real-time polling). |
| 114 | `getNotes` | Knowledge notes list of **one** knowledge base. |
| 115 | `getOfficialAssets` | — |
| 116 | `getOperationLog` | — |
| 117 | `getOverview` | — |
| 118 | `getOverviewInsights` | One-screen data overview. |
| 119 | `getPaymentStatus` | Authoritative transfer/redpacket status by message server_id. |
| 120 | `getPrivacyAuditRows` | — |
| 121 | `getPrivacyScan` | Privacy scan. |
| 122 | `getPrivacyState` | — |
| 123 | `getRecords` | Records (revokes/transfers/redpackets/finder/miniprograms/friendverifications). |
| 124 | `getRegionMap` | Friend-region map (世界板块地图): world → country → province → city → friends. |
| 125 | `getRemoteImages` | 远程图片代理（M23）：一批 https 图片地址 → 后端取回并缓存 → data URL。 |
| 126 | `getRetrievalStatus` | RAG 检索层状态：配置 + 向量库 + 反馈统计 + 当前调参权重 + 意图分类自评。 |
| 127 | `getRevoked` | Revoked messages. |
| 128 | `getSearchIndexStatus` | Search index status. |
| 129 | `getSelfUsername` | Return the current account's own WeChat username (user_name). |
| 130 | `getSessions` | — |
| 131 | `getSnsImageDataUrl` | Resolve one SNS (朋友圈) media to a base64 data URL —— **先网后本**。 |
| 132 | `getSnsVideoCoverDataUrl` | 一条朋友圈视频封面 → data URL（W2-5.6 的单条入口保留；列表请走 `getSnsVideoCoversBatch`）。 |
| 133 | `getSnsVideoCoversBatch` | — |
| 134 | `getSnsVideoDataUrl` | Resolve one SNS (朋友圈) video body so it can be played inline. |
| 135 | `getStorageStats` | Storage stats. |
| 136 | `getVideoInfo` | Look up one video message: cover thumbnail + the on-disk video path. |
| 137 | `getVoiceDataUrl` | Resolve one voice message to an inline-playable wav data URL. |
| 138 | `getVoiceInfo` | Look up one voice message (silk decode degrades in Node). |
| 139 | `getVoiceTranscript` | Cached transcript for one voice message (if already transcribed). |
| 140 | `getWechatConfig` | WeChat config summary. |
| 141 | `getWechatConfigFull` | Read the full WeChat config (incl. |
| 142 | `getWechatKeysInfo` | Read all_keys.json info. |
| 143 | `getWhisperStatus` | Whisper transcription configuration status: engine detection, CUDA presence, models dir + installed ggml bina… |
| 144 | `getWordCloud` | — |
| 145 | `installWhisperEngine` | Download + install the whisper.cpp CLI engine into the models dir (`<modelsDir>/bin/whisper-cli.exe`), persis… |
| 146 | `listBackups` | List local WeChat backups. |
| 147 | `listClawbotInstances` | 实例列表（多实例：一个微信号 = 一个实例；每个实例有自己的自动回复与知识库开关）。 |
| 148 | `listClawbotMessages` | 接入会话检索（时间 / 关键词 / 方向 / 分页 / 续传）。 |
| 149 | `listEditedMessages` | List edited messages (optionally for one session). |
| 150 | `listLlmModels` | List the provider's configured models (from the "设置 → 模型" settings section), falling back to the provider cat… |
| 151 | `listLlmProviders` | List the daily-summary model provider(s): the default model's provider (the one the user actually configured)… |
| 152 | `listRetrievalFeedback` | 列出最近的问答反馈 + 汇总统计。 |
| 153 | `listSummaryRecords` | List generated summary records. |
| 154 | `listSummaryTasks` | List daily-summary tasks. |
| 155 | `listTasks` | — |
| 156 | `openConfig` | 保留理由：与「数据配置」面板现有那条路径等价 —— 界面用 `getWechatPathConfig()` 拿到路径后 再 `openPath()` 打开（Settings.tsx）。这里保留一份「直接打开 confi… |
| 157 | `openPath` | Open an owned path (config/output dir/file) with the system default. |
| 158 | `optimizeAskQuestion` | 提问优化：把用户问题改写为更利于本机检索的形式，并给出改进建议。 |
| 159 | `planOriginalFetch` | 盘点「每条图片消息的原图能不能拿到」——**纯本机扫描，不联网**。 |
| 160 | `previewBackup` | Preview a backup's contents (bounded file list) before restore. |
| 161 | `pruneExportHistory` | 按策略清理导出历史（按天数 / 保留最近 N 条 / 只清失效记录）。 |
| 162 | `renameKb` | Rename one knowledge base. |
| 163 | `repairCorruptDbs` | 修复损坏的库：体检 → 只重解密损坏的那几个 → 复检（`query/db-repair.ts`）。 |
| 164 | `resetEditedMessage` | Restore a message to its original content. |
| 165 | `resetRetrievalWeights` | 重置调参权重回默认值（丢弃反馈带来的偏移；反馈记录本身保留）。 |
| 166 | `resolveChatHistory` | — |
| 167 | `restoreBackup` | — |
| 168 | `runSummaryTask` | — |
| 169 | `saveNote` | Create (no `id`) or update (`id` given) one knowledge note. |
| 170 | `saveRetrievalConfig` | 保存检索参数（阈值/权重/容量）。 |
| 171 | `saveSummaryTask` | Save (insert/update) a daily-summary task. |
| 172 | `saveWechatConfig` | Save the WeChat config (merge patch). |
| 173 | `searchKb` | 在某个知识库里做检索 —— 稀疏（FTS5 bm25）+ 稠密（向量余弦）两路，RRF 名次融合。 |
| 174 | `searchMembers` | Contact / group-member search. |
| 175 | `searchMessages` | Full-text search over text messages (index first, scan fallback). |
| 176 | `searchUnified` | — |
| 177 | `sendClawbotMessage` | 发送一条消息到微信（用户主动触发；正文经腾讯服务中转，**唯一由内容驱动的出网路径**）。 |
| 178 | `setClawbotInstanceConfig` | 改某实例的**行为配置**（AI 自动回复 / 知识库增强；部分更新）。 |
| 179 | `setKbFileRag` | 切换一个文件是否参与向量化（出网）。 |
| 180 | `setKbModelConfig` | 写某个知识库的模型覆盖（只改传进来的那几项；传空串 = 取消覆盖、回到继承）。 |
| 181 | `setPrivacyState` | — |
| 182 | `setTaskStatus` | — |
| 183 | `submitAskFeedback` | 提交问答反馈（目标 5 的闭环入口）。 |
| 184 | `suggestKbLinks` | 笔记编辑器里的「模型建议的链接」—— 返回候选，**不写任何东西**。 |
| 185 | `suggestReplies` | 「推荐回复」：按**当前会话**的上下文（+ 用户选中的知识库）给出候选回复。 |
| 186 | `summarizeKbFile` | 用模型给某个知识库文件生成摘要。**这是一条出网调用**，与问答同一套闸门。 |
| 187 | `syncHandoffTasks` | — |
| 188 | `toggleSummaryTask` | Toggle a daily-summary task enabled state. |
| 189 | `transcribeVoiceBatch` | Batch-transcribe the most recent voice messages: silk → WAV (bundled wx_silk) → whisper-cli with the selected… |
| 190 | `transcribeVoiceMessage` | Transcribe one voice message on demand (chat bubble 语音转文字). |
| 191 | `unbindClawbot` | 解绑（断开该实例的通道；**接入会话保留**，见 PRIVACY.md 第三节）。 |
| 192 | `unloadLaya` | Unload the model, releasing roughly 1.2 GB of resident memory. |
| 193 | `upgradeDecodedImages` | 升级老解码缓存：把 `<decoded>/<md5>.<ext>` 里由低档 `.dat`（聊天版 / 缩略图）解出来的图， 用本机现存最好的一档（`_h` 原图，含 wxgf 转码）重解一遍。**不联网**。 |
| 194 | `verifyDatabaseKey` | Verify a database key (SQLCipher PBKDF2 + AES + HMAC). |
| 195 | `verifyImageKey` | — |

## 明细

### `addKbFiles`

```ts
addKbFiles(options: { kbId: number; paths: string[]; includeInRag?: boolean }): KbFileAddResult
```

登记一批文件（原生对话框多选的结果）。  逐个登记、逐个回执：每个文件各自一个事务，中途某一个失败不影响已经进来的那些。 于是一次多选的部分失败（重复 / 类型不支持 / 太大）是**可解释**的， 而不是一句笼统的「添加失败」。

- @param options - `kbId`、`paths`（绝对路径数组）、`includeInRag`（不给按 true）。
- @returns KbFileAddResult：`ok` = 至少进来一个；逐项原因在 `results` 里。

### `addTask`

```ts
addTask(options: { title: string; dueAt?: number }): TaskMutationResult
```

Add a WeChat task.

- @param options - title + optional dueAt.
- @returns TaskMutationResult.

### `adoptLayaModel`

```ts
adoptLayaModel(options: { sourceDir: string }): LayaStatus
```

Adopt an already-downloaded model directory (move it into the data dir) so the same 1.26 GB does not have to be fetched twice.

- @param options - sourceDir containing the model + tokenizer layout.
- @returns LayaStatus after the move.

### `analyzeMessages`

```ts
async analyzeMessages(options: { talker: string; contextLimit?: number }): Promise<LayaAnalysisView>
```

Analyze one conversation with the **local** decision model (laya · onnxruntime-node + JS tokenizer; no network, no LLM, not gated by the outbound privacy gate). Answers are per-question probability distributions. model is not ready (missing files / load failure) — an expected path, not an exception.

- @param options - talker (conversation username) + optional context limit (default 20, max 60).
- @returns LayaAnalysisView: per-question answers, or `ok:false` with the reason the

### `analyzeVisibleMessages`

```ts
async analyzeVisibleMessages(options: { talker: string targets: Array<{ localId: number; sortSeq: number }> jobId?: string }): Promise<LayaVisibleAnalysisResult>
```

Per-message analysis for the message stream's visible window (local model · no network). Each message is analyzed against the conversation **up to that point**; voice messages are transcribed first (whisper, disk-cached) and the transcript is what gets analyzed. Results are cached in `<data root>/laya_analysis.db` keyed by (session, message, model fingerprint).

- @param options - talker + targets (localId + sortSeq of each visible message).
- @returns LayaVisibleAnalysisResult: per-message answers; one bad message only fails its own item.

### `askWechat`

```ts
async askWechat(options: { question: string username?: string from?: string to?: string history?: Array<{ role: 'user' | 'assistant'; content: string }> streamId?: string source?: string usernameName?: string kbId?: number jobId?: string }): Promise<AskResult>
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

### `buildKbVectorIndex`

```ts
async buildKbVectorIndex(options: { kbId: number; force?: boolean; jobId?: string }): Promise<KbVectorBuildWireResult>
```

为**某个库**构建 / 增量更新向量索引（面板上那个「语义索引」按钮）。  两条纪律： ① 只建本库 —— 出网范围必须与用户此刻的意图一致，一次建全库会把别的库的正文也发出去； ② 语料只取 `include_in_rag = 1` 的文件，且写在 SQL 里（见 `kb-vectors.ts` 头注）。

- @param options - `kbId`；`force` 时清空本库重算。
- @returns 构建结果（`ok` 为假时带 `error`）。

### `buildRagVectorIndex`

```ts
async buildRagVectorIndex(options?: { force?: boolean }): Promise<VectorBuildResult>
```

立即构建/增量更新稠密向量索引。 界面已不暴露该入口：首次提问时网关会自动增量构建（失败则降级纯稀疏）， 本方法留给诊断与自动化测试使用。

- @param options - force=true 时清空重建。
- @returns 构建结果。

### `buildSearchIndex`

```ts
async buildSearchIndex(options?: { force?: boolean; jobId?: string }): Promise<SearchBuildResult>
```

Build (or rebuild) the FTS5 message search index.

- @param options - force: rebuild even when the index already exists.
- @returns SearchBuildResult: build outcome with row counts.

### `cancelAsk`

```ts
cancelAsk(options: { jobId: string }): { ok: boolean; message?: string }
```

取消一轮正在生成的问答（W3-6.1）。  为什么单独一个方法而不是让 `askWechat` 自己超时：生成是流式的、时长不可知 （实测单次十几到几十秒），而用户等不及的点是按秒计的。`AbortSignal` 过不了 IPC （与导出/搜索同一约束），所以沿用那两处的老办法：渲染层带一个 jobId（就是那轮的 streamId），这里去捅后端的 AbortController。

- @param options - jobId（必填）：要取消的轮次标识。
- @returns ok=false 时 message 说明为什么没取消掉（通常是那一轮已经结束了）。

### `cancelExportJob`

```ts
cancelExportJob(options: { jobId: string }): { ok: boolean; error?: string }
```

Cancel one running export/backup job (M3).  渲染层点「取消」时调用：这里只唤醒 AbortController，真正的收尾（不留半成品）由 query 层在各耗时循环的检查点完成（`throwIfCancelled` + temp+rename）。

- @param options - jobId the renderer passed to the export call.
- @returns ok when a running job was aborted; error otherwise.

### `cancelKbIndexBuild`

```ts
async cancelKbIndexBuild(options: { jobId: string }): Promise<{ ok: boolean; message?: string }>
```

停止本库正在跑的向量构建（W3-11.5）。  取消在〔认领下一批〕之前生效；两阶段构建的阶段二在全部批次之后，所以取消 ⇒ 一行都没写 ⇒ 旧索引原样（不是「留半份向量」）。

- @param options - jobId（即 `buildKbVectorIndex` 那次的同一标识）。
- @returns ok + 停不上的原因（该批已算完 / 标识不认识）。

### `cancelLayaAnalysis`

```ts
async cancelLayaAnalysis(options: { jobId: string }): Promise<{ ok: boolean; message?: string }>
```

停止一批正在跑的逐条本地分析（W3-11.5）。  取消只在每条之间生效（一次 ONNX forward 没法从中间打断），所以最坏延迟是最后一条的 推理时长；已经算完的那些会**连同缓存一起保留**（`canceled:true` + 部分 `items`）。

- @param options - jobId（必填，即 `analyzeVisibleMessages` 那批的同一标识）。
- @returns ok + 停不上的原因（该批已经算完 / 标识不认识）。

### `cancelLayaDownload`

```ts
cancelLayaDownload(options: { jobId: string }): { ok: boolean; message?: string }
```

取消正在进行的 laya 模型下载（W2-11.5）。

- @param options - jobId（与 `downloadLayaModel` 传的是同一个）。
- @returns ok，或没有该任务时的说明。

### `cancelSearch`

```ts
cancelSearch(options?: { jobId?: string }): { ok: boolean }
```

取消一次正在跑的消息搜索（N9）。

- @param options - `jobId` 为渲染层生成的任务标识。
- @returns `ok: true` 表示确实打断了一个在跑的搜索；找不到（已跑完/从未注册）时为 false。

### `cancelSearchIndexBuild`

```ts
async cancelSearchIndexBuild(options: { jobId: string }): Promise<{ ok: boolean; message?: string }>
```

停止一次正在跑的搜索索引构建（W3-11.5）。  取消只在**分片边界**与分片内的让出点生效；被取消的构建会 ROLLBACK， 所以旧索引原封不动（不是「留半份索引」）。

- @param options - jobId（必填，即 `buildSearchIndex` 那次的同一标识）。
- @returns ok + 停不上的原因（构建已结束 / 标识不认识）。

### `cancelWhisperDownload`

```ts
async cancelWhisperDownload(options: { jobId: string }): Promise<{ ok: boolean; message?: string }>
```

停止一次正在跑的模型/引擎下载（W3-5.5）。  取消只在下**一个 chunk** 生效；已下载的部分保留为 `.part`，下次可续传。

- @param options - jobId（即 `downloadWhisperModel` 那次的同一标识）。
- @returns ok + 停不上的原因。

### `checkClawbotEnv`

```ts
checkClawbotEnv(options?: { slot?: number }): ClawbotEnvSnapshot
```

环境自检（精简 3 项：应用运行 / 绑定通道 / 集成状态）—— 第 ② 项读的是该实例的通道。

- @param options.slot - 实例编号（缺省 = 第一个实例）。
- @returns 自检快照。

### `checkDbIntegrity`

```ts
async checkDbIntegrity(): Promise<DbIntegrityResult>
```

逐库完整性体检（`PRAGMA integrity_check`）—— 「库文件已损坏」那条处方 （`wechat-host.js` 的 READABLE_ERRORS）指向的检查。与 `getDbHealth` 的 大小统计分开：后者被「原图链路自检」等面板启动时顺带读取，挂全库扫描 会让每次挂载多几秒阻塞（并发纪律见 `query-yield-discipline.spec.ts`）。

- @returns DbIntegrityResult: checked / corrupted（可重解密修复）/ unreadable（占用等）。

### `clearAllSessionDrafts`

```ts
clearAllSessionDrafts(): DraftsClearResult
```

Clear all session drafts, returning the cleared list.

- @returns DraftsClearResult: cleared session list (items + total).

### `clearAskHistory`

```ts
clearAskHistory(): AskHistoryClearResult
```

清空全部问答历史（由界面上的显式入口 + 二次确认触发，不做任何自动清理）。

- @returns 实际删除条数。

### `clearOperationLog`

```ts
clearOperationLog(): OperationLogClearResult
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-config-ops.ts` 中该方法）_

### `clearPrivacyAudit`

```ts
clearPrivacyAudit(): PrivacyAuditClearResult
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-config-ops.ts` 中该方法）_

### `clearSessionDraft`

```ts
clearSessionDraft(options: { username: string }): DraftClearResult
```

Clear one session draft (decrypted copy only).

- @param options - username of the session to clear.
- @returns DraftClearResult: ok, or error on failure.

### `createBackup`

```ts
async createBackup(): Promise<BackupMutationResult>
```

Create a local backup snapshot.

- @returns BackupMutationResult: ok + backup name, or error.

### `createClawbotBindQr`

```ts
async createClawbotBindQr(options?: { slot?: number }): Promise<ClawbotBindQr>
```

申请绑定二维码（真实调用腾讯 iLink 服务；失败抛可读中文，渲染层按 message 展示）。

- @param options.slot - 为哪个实例取码（缺省 = 第一个实例）。
- @returns 一次性凭证 / 二维码内容 / 过期时间 / 初始四态。

### `createClawbotInstance`

```ts
createClawbotInstance(): ClawbotInstanceCreated
```

新建一个实例（初始未绑定；随后用 `createClawbotBindQr` 为它取码）。

- @returns 新实例编号 + 最新实例列表。

### `createEncryptedBackup`

```ts
async createEncryptedBackup(options: { password: string; jobId?: string }): Promise<BackupMutationResult>
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-export-ops.ts` 中该方法）_

### `createKb`

```ts
createKb(options: { name: string }): KbMutationResult
```

Create one knowledge base.

- @param options - `name`: required, normalized-unique, at most `KB_NAME_MAX` chars.
- @returns KbMutationResult: `{ ok, id }`, or `{ ok: false, error }`.

### `decryptAllDatabases`

```ts
async decryptAllDatabases(): Promise<DecryptAllResult>
```

Full SQLCipher decryption: every .db under db_storage is re-decrypted into the decrypted snapshot (逐库原子发布,单库失败不中断)。实时进度 通过 getDecryptStatus 轮询读取。

- @returns DecryptAllResult: total/ok/failed counts.

### `decryptAllImages`

```ts
async decryptAllImages(options?: { concurrency?: number }): Promise<DecryptImagesResult>
```

Batch-decode every md5-prefixed .dat image under msg/attach into the decoded-images cache (并行池,已缓存/HEVC 跳过)。实时进度通过 getDecryptStatus 轮询读取。

- @param options - optional worker concurrency (clamped 1..32).
- @returns DecryptImagesResult: total/ok/failed/skipped counts.

### `deleteAskHistory`

```ts
deleteAskHistory(options: { ids: number[] }): AskHistoryDeleteResult
```

删除若干条问答历史。  与导出历史不同，这里**没有**「连带删除外部文件」这个选项 —— 问答记录的内容全部在库里， 删记录就是删全部，没有第二个动作会顺手动到用户磁盘上的东西。

- @param options - ids。
- @returns 实际删除条数。

### `deleteBackup`

```ts
deleteBackup(options: { name: string }): BackupMutationResult
```

Delete one backup by name.

- @param options - name of the backup to delete.
- @returns BackupMutationResult: ok, or error on failure.

### `deleteClawbotInstance`

```ts
deleteClawbotInstance(options: { slot: number }): ClawbotInstanceDeleted
```

删除一个实例（绑定行 + 配置 + **该实例的接入会话**一起删；条数如实回报）。

- @param options.slot - 实例编号。
- @returns 连带删除的会话条数 + 最新实例列表。

### `deleteExportHistory`

```ts
deleteExportHistory(options: { ids: number[]; deleteFiles?: boolean }): ExportHistoryDeleteResult
```

删除若干条导出历史记录。  `deleteFiles` **默认为 false**：删记录与删文件是两件事，风险差一个量级， 必须由界面显式选择（见 `query/export-history.ts` 的说明）。

- @param options - ids + 是否连带删除磁盘文件。
- @returns 删除计数与文件删除失败清单。

### `deleteFavoriteItems`

```ts
deleteFavoriteItems(options: { ids: number[] }): DeleteFavoriteResult
```

Delete favorite items by local_id.

- @param options - ids of the favorite items to delete.
- @returns DeleteFavoriteResult: ok + deleted count, or error.

### `deleteKb`

```ts
deleteKb(options: { id: number; action: KbDeleteAction }): KbMutationResult
```

Delete one knowledge base.  `action` **必填、无默认值**：库里的笔记是「搬到别的库」还是「一起删掉」只有调用方 能决定，而这里最危险的默认值恰好是「一起删」—— 一次「我以为只是删个空壳库」的点击 会直接把几十条笔记带走。默认库本身也不可删（它是迁移兜底）。

- @param options - `id` plus `action` (`{kind:'reassign',targetKbId}` or `{kind:'purge'}`).
- @returns KbMutationResult carrying `movedNotes` / `removedNotes`.

### `deleteKbFile`

```ts
deleteKbFile(options: { kbId: number; id: number }): KbFileMutationResult
```

删除一个文件（连带它的分块 / FTS 行 / 向量 / blob 副本）。  **不碰用户电脑上的原文件** —— 删的是知识库里的这一份，那份原文件仍然在他的盘上。 `kbId` 是**守卫**：文件 id 全局自增，拿甲库的 id 调乙库会删掉甲库那一条， 而删除是物理的、没有撤销（与 `deleteNote` 同一条纪律）。

- @param options - `kbId` plus the file row id.
- @returns KbFileMutationResult（回执里带连带清掉的分块数与副本是否被删）。

### `deleteNote`

```ts
deleteNote(kbId: number, options: { id: number }): NoteMutationResult
```

Delete one knowledge note.  `kbId` 不是「附加信息」而是**守卫**：笔记 id 全局自增，拿着甲库的 id 调乙库 会删掉甲库那一篇（数据直接没了）。归属不符时返回「笔记不存在」。

- @param kbId - expected owner; a row belonging to another kb is **not** deleted.
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

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-config-ops.ts` 中该方法）_

### `detectWechatAccounts`

```ts
detectWechatAccounts(): AccountsSnapshot
```

Detect installed WeChat 4.x accounts.

- @returns AccountsSnapshot: detected accounts (accounts + total).

### `downloadLayaModel`

```ts
async downloadLayaModel(options?: { jobId?: string }): Promise<LayaDownloadOutcome>
```

Download the decision model assets (~1.26 GB: graph + tokenizer) into the data dir. Streamed with resume + atomic publish, mirror fallback; idempotent.

- @returns LayaDownloadOutcome.

### `downloadWhisperModel`

```ts
async downloadWhisperModel(options: { model: string; jobId?: string }): Promise<WhisperDownloadResult>
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
evaluateRetrieval(options?: { k?: number }): RetrievalEvalResult
```

跑离线召回评估（合成评测集），并给出「混合 vs 纯稀疏」的消融对比。  不依赖真实数据，因此可以随时直连调一次就看到当前算法的 P/R/MRR/NDCG （界面无入口），也可以在 CI 里断言「混合不低于纯稀疏」防止退化。

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
async exportAnnualReport(options: { year: number; format: string; dir?: string; filename?: string; jobId?: string }): Promise<ExportResult>
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-export-ops.ts` 中该方法）_

### `exportCsv`

```ts
async exportCsv(options: { kind: string; recordsKind?: string; dest?: string; category?: string; jobId?: string }): Promise<ExportResult>
```

Export a CSV table. when kind=records; `dest` = the full target path the user picked in the save dialog (falls back to `<dataRoot>/exports/` when omitted); `category` narrows kind=contacts to one category so the file matches what the panel is showing.

- @param options - `kind` (contacts/favorites/records/moments/privacy); `recordsKind`
- @returns ExportResult (path + filename + row count).

### `exportMoments`

```ts
async exportMoments(options?: { format?: string username?: string authorName?: string q?: string images?: boolean media?: string month?: string mine?: string zip?: boolean from?: number to?: number dir?: string filename?: string jobId?: string }): Promise<ExportResult>
```

Export moments (朋友圈) with author + keyword + time filters.

- @param options - format/username/authorName/q/from/to/dir/filename (+ 可选的 jobId 订阅进度/取消).
- @returns ExportResult: written file path + count.

### `exportSessionMessages`

```ts
async exportSessionMessages(options: { username: string format: string count?: number dir?: string types?: number[] richTypes?: string[] from?: number to?: number filename?: string zip?: boolean sessionName?: string jobId?: string }): Promise<ExportResult>
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

### `extractKbEntities`

```ts
async extractKbEntities(options: { kbId: number; fileIds?: number[]; limit?: number }): Promise<KbExtractResult>
```

让模型读一遍本库的文件，抽出实体（推断层）。  两条纪律： ① 只处理 `include_in_rag = 1` 的文件 —— 关掉那个开关的文件连一次抽取都不该被发出去 （条件在 SQL 里，见 `extract.ts` 的 `readDigestForExtract`）； ② 按文件、不按 chunk，且**整批替换**上一次结果（重跑不是追加）。

- @param options - `kbId`；`fileIds` 限定范围（默认整库）；`limit` 单次最多几个文件。
- @returns 逐文件结果 + 汇总（失败的逐个带原因，不因一个失败就整批失败）。

### `extractTasks`

```ts
async extractTasks(options?: { days?: number }): Promise<TaskMutationResult>
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-config-ops.ts` 中该方法）_

### `fetchOriginalImagesBatch`

```ts
async fetchOriginalImagesBatch(options?: { limit?: number; concurrency?: number }): Promise<OriginalBatchResult>
```

批量取回原图（免登录直链）：全库那 16.6% 一次取完，**可续跑**（`<decoded>/.originals-index.json`）。  边界：已有解密类任务在跑时一条请求都不发（回 `blocked`）；逐条失败不中断整批。 **明确不碰**只有 `cdnbigimgurl`/`cdnmidimgurl` 的那 83.4% —— 那要微信登录态凭据（边界见 `query/image-original.ts`），只能在微信里点开后用 「升级为原图」收进来。实时进度通过 getDecryptStatus 读取（`op` = `image-original-batch`）。

- @param options - `limit`（0/不传 = 本次不限）、`concurrency`（默认 4，封顶 8）。
- @returns OriginalBatchResult：候选/尝试/成功/失败/字节/耗时/逐条失败原因。

### `generateAnnualNarrative`

```ts
async generateAnnualNarrative(options: { year: number; jobId?: string }): Promise<AnnualNarrativeResult>
```

生成 AI 年报叙述（W2-8.6）：**分段**取材 → 逐段 LLM → 逐段进度。

- @param options - 年份 + 可选的进度任务标识（jobId）。
- @returns AnnualNarrativeResult: 各段结果 + 拼接全文 + 是否被段数上限截断。

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

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-ask-ops.ts` 中该方法）_

### `getAnnual`

```ts
async getAnnual(): Promise<AnnualSnapshot>
```

Annual years.

- @returns AnnualSnapshot: available yearly overview data.

### `getAnnualReport`

```ts
async getAnnualReport(options: { year: number }): Promise<AnnualReport>
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-read.ts` 中该方法）_

### `getAnnualReview`

```ts
async getAnnualReview(options: { year: number }): Promise<AnnualReview>
```

年度回顾（看板）：15 张卡片所需的完整年度聚合。 「人物类」指标只算我发出的（real_sender_id 归属），「规模类」算全部消息。

- @param options - year to compute the report for.
- @returns AnnualReview: 完整看板数据。

### `getArticleCover`

```ts
async getArticleCover(options: { contentUrl: string }): Promise<ImageDataUrlResult>
```

Resolve a 公众号 article cover (og:image) to a base64 data URL.  A4（2026-09-28）：先用朋友圈媒体索引确认本机有没有这张图 —— **索引命中才截流**， 没命中一律照旧出网（见 `article-cover.ts` 的 `LocalCoverProbe`）。

- @param options - mp.weixin.qq.com article URL.
- @returns ImageDataUrlResult: base64 data URL or error.

### `getArticleCovers`

```ts
async getArticleCovers(options: { urls: readonly string[] }): Promise<ArticleCoversResult>
```

批量解析公众号文章封面（A1，2026-09-28 性能修复）。  现场日志里 `getArticleCover` 是最频繁的慢调用（1221 次 / 均 1.9s），根因是前端逐张发 RPC。 这个批量壳把一屏的封面收成一个 RPC，后端按 `COVER_CONCURRENCY` 分批并发。 A4 之后本机已有封面的那些**连网络都不出**（同一个探测函数）。

- @param options - `urls` 为一屏待解析的文章链接（自动去重、忽略空串）。
- @returns 逐条结果（键 = 请求的 url），顺序与去重后的入参一致。

### `getAskHistory`

```ts
getAskHistory(options?: AskHistoryQuery): AskHistorySnapshot
```

读取问答历史（供「微信问答 → 历史记录」弹窗）。  与 `getExportHistory` 同样**不走**宿主的结果缓存：历史是「按当前事实」的数据， 刚问完就打开列表必须能看到那一条，缓存住的旧结果会表现成「问答没被保存」。

- @param options - 搜索 / 来源筛选 / 状态筛选 / 时间范围 / 排序 / 分页。
- @returns 一页条目 + 命中总数 + 各聚合计数。

### `getAssetInsights`

```ts
async getAssetInsights(): Promise<AssetInsightsSnapshot>
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-read.ts` 中该方法）_

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
async getCalls(options?: { topPeers?: number; recentLimit?: number }): Promise<CallsSnapshot>
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-read.ts` 中该方法）_

### `getClawbotBindState`

```ts
async getClawbotBindState(options?: { slot?: number }): Promise<ClawbotBindStateSnapshot>
```

中继一次绑定状态轮询（弹窗打开期间反复调用；单次最长约 40 秒，见 remote-policy.js）。

- @param options.slot - 哪个实例的这场扫码会话（缺省 = 第一个实例）。
- @returns 状态与绑定卡片快照。

### `getClawbotBinding`

```ts
getClawbotBinding(options?: { slot?: number }): ClawbotBindingSnapshot
```

当前绑定行（设置卡片首屏）。

- @param options.slot - 实例编号（缺省 = 第一个实例）。
- @returns 绑定卡片快照（含会话计数与通道状态）。

### `getClawbotMedia`

```ts
async getClawbotMedia(options: { id: number }): Promise<ClawbotMediaResult>
```

取某条消息的附件（按需下载 + 解密 + 缓存；只在用户点开时发生）。

- @param options.id - 会话行 id。
- @returns 取数结果（图片给小图 dataUrl；其余给本机路径）。

### `getContact360`

```ts
getContact360(options: { username: string }): Contact360Snapshot
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-read.ts` 中该方法）_

### `getContacts`

```ts
getContacts(options?: { limit?: number; offset?: number; category?: string }): ContactsSnapshot
```

Contact book. category filter (friend/group/official/service/enterprise/member/system/deleted). The filter is applied **before** pagination so a category tab shows its own complete list and an accurate `total`.

- @param options - Optional page size + offset for incremental loading, plus a
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

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-config-ops.ts` 中该方法）_

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

### `getEmoticonDataUrls`

```ts
async getEmoticonDataUrls(options: { items: Array<{ md5: string; emojiUrl?: string }> }): Promise<EmoticonDataUrlsResult>
```

批量取表情（E1，2026-09-28 性能修复）。  现场日志里 `getEmoticonDataUrl` 均 27.2s、峰值 71.9s。这个批量壳把一屏的表情收成 一个 RPC；后端先做一趟纯本地解码，再对剩下的按 {@link EMOTICON_FETCH_CONCURRENCY} 并发出网 —— 于是「N 条表情 = N 次网络往返」变成「1 次 RPC + ceil(N/8) 批」。

- @param options - `items` 为一屏待取的表情（自动去重、忽略空 md5）。
- @returns 逐条结果（键 = md5），顺序与去重后的入参一致。

### `getEmoticons`

```ts
getEmoticons(options?: { limit?: number; offset?: number }): EmoticonsSnapshot
```

Custom emoticons.

- @param options - Optional limit/offset for incremental loading.
- @returns EmoticonsSnapshot: emoticon items.

### `getExportHistory`

```ts
getExportHistory(options?: ExportHistoryQuery): ExportHistorySnapshot
```

读取导出历史（供「导出记录」弹窗）。

- @param options - 搜索 / 种类筛选 / 状态筛选 / 时间范围 / 排序 / 分页。
- @returns 一页条目 + 命中总数 + 各聚合计数。

### `getExportProgress`

```ts
getExportProgress(options: { jobId: string }): { found: boolean phase: string done: number total: number finished: boolean error?: string }
```

Poll one export/backup job's latest progress (M3).  为什么除了事件推送还要有这个轮询入口：进度事件要经过「宿主事件 → 渲染层」的中继， 而中继只对白名单事件名生效（见 `ui-app/ui-entry.tsx`）。轮询不依赖中继，是 「进度确实推得出去」的那条兜底路径。

- @param options - jobId the renderer passed to the export call.
- @returns 最近一次进度；`found:false` 表示 jobId 未知（如进程重启过）。

### `getFavorites`

```ts
getFavorites(options?: { limit?: number; offset?: number; q?: string }): FavoritesSnapshot
```

Favorites list.

- @param options - Optional limit for the number of rows returned.
- @returns FavoritesSnapshot: favorite items (items + total).

### `getFileImageDataUrl`

```ts
async getFileImageDataUrl(options: { md5: string }): Promise<ImageDataUrlResult>
```

Resolve a file-library image (hardlink md5) to an offline base64 data URL. 优先读已解密缓存，否则通过 hardlink.db 定位 .dat 原图解密。

- @param options - file md5.
- @returns ImageDataUrlResult: base64 data URL or error.

### `getFiles`

```ts
getFiles(options?: { limit?: number; offset?: number; category?: string; q?: string }): FilesSnapshot
```

Resource files.

- @param options - Optional limit/offset and category filter for incremental loading.
- @returns FilesSnapshot: resource file items.

### `getGraph`

```ts
async getGraph(): Promise<GraphSnapshot>
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

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-read.ts` 中该方法）_

### `getHandoffReminds`

```ts
getHandoffReminds(): HandoffRemindsSnapshot
```

保留理由：读 `general.db` 的 `handoff_remind_v0`（微信自带待办提醒）。本机实测**这张表不存在** （22 个库里没有任何 `handoff%` 表）⇒ 界面若直接接上去只会永远显示空列表，因此只保留接口； 「待办日程」面板用的是导入路径 `syncHandoffTasks`（把源数据落进插件自己的任务库）。

### `getImageDataUrl`

```ts
async getImageDataUrl(options: { username: string; localId: number }): Promise<ImageDataUrlResult>
```

Decode one message image to a base64 data URL.

- @param options - username and localId of the message image.
- @returns ImageDataUrlResult: base64 data URL or error.

### `getImageDataUrlsBatch`

```ts
async getImageDataUrlsBatch(options: { items: Array<{ username: string; localId: number }> }): Promise<{ items: ImageBatchItem[] }>
```

Decode a whole batch of message images to base64 data URLs (N16)。  理由与实测数字（20 万行 17.27ms/次、30 张 ≈518ms、以及「预热之后每张仍走一次单张入口」 那条诚实边界）**写在 `query/media-image.ts` 的 `resolveImageFilePathsByMd5`** 上 —— 这一层只是协议壳，不重复一份（重复的那份一定会漂）。

- @param options - `items`: 一批 (username, localId)；超过 {@link IMAGE_BATCH_MAX} 的截断。
- @returns 与传入顺序一一对应的条目（`url` 或 `error`，语义同单张入口）。

### `getImageOriginal`

```ts
async getImageOriginal(options: { username?: string; localId?: number }): Promise<{ ok: boolean; format?: string; bytes?: number; note?: string; error?: string }>
```

取一条图片消息的**原图**，但只走消息里自带的免登录预签名直链（`<img tpurl=…/tphdurl=…>`）。  为什么只做这一类：本机 39,923 张图片消息里 93% 磁盘上只有缩略图，而指向原图的指针有两种， `cdnbigimgurl` 那一种需要**微信登录态凭据**去发私有媒体请求 —— 那已经不是「读本机已有的密钥」， 而是「以你的身份向服务器发请求」，与本应用「不登录、不连微信服务器同步」的边界冲突 （口径写在 `query/image-original.ts` 的模块注释）。所以拿不到直链时要把话说清： 让用户回微信里打开那张图点「查看原图」，本机存下来之后这里自然就是原图。  取回的原图写进 `<decoded>/<md5>.<ext>`，也就是 `getImageDataUrl` 第 1a 步优先读的缓存槽， 于是**下一次渲染直接是原图**、之后离线可用（网络只花一次）。字节不经 RPC 回传。 `note` 是成功时要一并告诉用户的话（例如「这次是重解本机那一份，没联网」）。

- @param options - `username` 会话 username；`localId` 消息 local_id。
- @returns `{ok:true, format, bytes?, note?}`；失败时 `{ok:false, error}`，error 可直接显示。

### `getKbFileChunks`

```ts
getKbFileChunks(kbId: number, fileId: number, options?: { limit?: number; offset?: number }): KbFileChunkPage
```

读某个文件解析出来的正文（分页）。界面上「就地展开看内容」走这一条。  与 `getKbFiles` 同样：`kbId` 必填、没有「所有库」模式，而且这一条**还多一道** `fileId` 必须属于该库的确认 —— 它返回的是内容而不是计数，跨库串起来的后果重得多。 返回的是解析文本，不是原文件排版（表格 / 图片 / 页眉页脚在解析阶段已丢）， 界面上必须这样标注，别让人以为在看原稿。

- @param kbId - 目标库（必填）。
- @param fileId - 目标文件。
- @param options - 分页（limit 上限 200 块）。
- @returns KbFileChunkPage。

### `getKbFiles`

```ts
getKbFiles(kbId: number, options?: { limit?: number; offset?: number }): KbFileListSnapshot
```

一个知识库里的文件列表（新上传的在前）。  与 `getNotes` 同口径，`kbId` 必填：文件、分块、检索全部按库划作用域， **没有**「所有库的文件」这种视图 —— 那正是多库之后最容易出现的串数据。 好让面板说「读不到」而不是「还没有文件」。

- @param kbId - the knowledge base to read; required, there is no "all kbs" mode.
- @param options - Pagination (limit/offset).
- @returns KbFileListSnapshot. 库读不到时给 `readError` 而不是空列表，

### `getKbModelConfig`

```ts
getKbModelConfig(options: { kbId: number }): KbModelConfigView
```

某个知识库的**模型设置**（三个角色的引用 + 各自实际生效的名字）。  回包里同时给「引用串」和「解析结果」：下拉框要回填前者（用户改过什么）， 而界面要说的是后者（现在到底在用哪个模型）。只给一个就会出现 「显示的是全局值、实际用的是覆盖值」这类看起来无害的错位。 + 实体抽取的进度（同一个回包：弹层开一次要读三样，分开读会让首帧分三次跳）。

- @param options - `kbId`。
- @returns 设置 + 三角色的解析结果 + 全局值（下拉里「继承全局：xxx」那半句要用）

### `getKbVectorIndex`

```ts
getKbVectorIndex(options: { kbId: number }): KbVectorIndexView
```

某个知识库的**向量索引状态**（面板的「语义索引」按钮与状态 chip 读这个）。  为什么要单独一个读接口：向量索引此前只有一个隐式入口 —— 提问时顺手补齐 （`askWechat` 里那段），于是界面上既**触发不了**它也**看不见**它： 用户只知道「有时能语义搜到、有时搜不到」，而差别其实只是这个库建没建过。

- @param options - `kbId`。
- @returns 当前生效的模型名、是否配了通道、按库状态、以及本进程内的在飞构建进度。

### `getKbs`

```ts
getKbs(): KbListSnapshot
```

Knowledge base list — the scope selector's data source.  两个库文件在这里**合流**：笔记数来自笔记库（`listKbs`），文件数来自文件库 （`countKbFilesByKb`，一次 GROUP BY）。合并只能写在这一层 —— `notes.ts` 看不到文件库。  少了这次合并，界面上的 `fileCount` 会恒为 0，于是删库弹层对一个「0 条笔记 / 5 个文件」 的库说「这个库是空的」（真机探针实测）。文件库读失败时 `countKbFilesByKb` 返回空表 ⇒ 退化成 0，与本次改动前的行为一致，不是新增风险。 unreadable note store yields an empty list **plus** `readError`; callers must not read that as "there is no kb at all" and create one over the top.

- @returns KbListSnapshot: every kb with its note count **and** file count. An

### `getKnowledgeGraph`

```ts
getKnowledgeGraph(kbId: number): KnowledgeSnapshotRead
```

Knowledge graph: note nodes, `[[…]]` edges, unresolved stubs, **plus the document entity layer** (registered files and their normalized sections).  与 `getGraph` 分开而不是合并：社交图谱的节点口径（联系人/群/我）和知识图谱 （笔记/未解析目标）是两套语义，合并会让两个面板都变脆。 两份快照**不在前端拼**：知识图谱的节点必须只来自知识库，人/群是通讯录数据， 因此曾经的「融合视图」已删除（见前端 panels/graph-model.ts 的文件头约束）。  **一库一图**：`kbId` 必填且没有默认值可给 —— 改前这张图是全库合并的， 多库之后会把两个库里同名的笔记并成一个节点，`[[链接]]` 也会指错库。  文档实体在这里合流，而不是在 `notes.ts` 里：笔记库与文件库是**两个 db 文件**， `notes.ts` 那一层物理上看不见文件（它自己的注释就写着 `fileCount` 恒为 0）。 与 `getKbs` 的 fileCount 合流是同一个理由、同一个位置。 文件库读不到时图谱照常返回笔记部分，但把原因并进 `readError` —— 「这个库没登记过文件」与「文件库打不开」必须是两句话（N1）。

- @param kbId - the knowledge base to build from.
- @returns KnowledgeSnapshot（含运行期可能带上的 `readError`，见 `KnowledgeSnapshotRead`）。

### `getLayaStatus`

```ts
getLayaStatus(): LayaStatus
```

Local decision model status: required files (model graph + tokenizer), size, source, active download progress and runtime state (loaded / last inference ms / last error).

- @returns LayaStatus.

### `getLedger`

```ts
async getLedger(options?: { month?: string }): Promise<LedgerSnapshot>
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-read.ts` 中该方法）_

### `getMapGeoJson`

```ts
async getMapGeoJson(options: { urls?: string[] }): Promise<MapGeoJsonResult>
```

公共地图 GeoJSON 的后端代理。 渲染层只给候选地址，真正出网由后端按 `query/map-geo.ts` 的固定白名单执行。

- @param options - `urls`: 候选 GeoJSON 地址。
- @returns 第一份可用的 GeoJSON，或失败原因。

### `getMediaAssets`

```ts
getMediaAssets(): MediaAssetsSnapshot
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-read.ts` 中该方法）_

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
async getMomentsInsights(options?: { author?: string }): Promise<MomentsInsightsSnapshot>
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-read.ts` 中该方法）_

### `getMomentsMonthly`

```ts
async getMomentsMonthly(options?: { author?: string; authorName?: string }): Promise<MomentsMonthlySnapshot>
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-read.ts` 中该方法）_

### `getNewMessages`

```ts
getNewMessages(options: { talker: string; after: number; limit?: number }): MessagesSnapshot
```

Incremental messages newer than a sort_seq watermark (real-time polling).

- @param options - talker, after watermark, optional limit.
- @returns MessagesSnapshot with only the newer messages.

### `getNotes`

```ts
getNotes(kbId: number, options?: { query?: string; limit?: number }): NotesSnapshot
```

Knowledge notes list of **one** knowledge base.  命中集与 `total` 都只统计本库：改前 `total` 是全表 `COUNT(*)`，多库之后 会显示成「12 / 37」这种跨库数字。

- @param kbId - the knowledge base to read; required, there is no "all kbs" mode.
- @param options - Optional case-insensitive search query and row cap.
- @returns NotesSnapshot: notes (newest first) plus the same-kb unpaged total.

### `getOfficialAssets`

```ts
async getOfficialAssets(): Promise<OfficialAssetsSnapshot>
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-read.ts` 中该方法）_

### `getOperationLog`

```ts
getOperationLog(options?: OperationLogQuery): OperationLogSnapshot
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-config-ops.ts` 中该方法）_

### `getOverview`

```ts
async getOverview(): Promise<OverviewSnapshot>
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-read.ts` 中该方法）_

### `getOverviewInsights`

```ts
async getOverviewInsights(): Promise<OverviewInsights>
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

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-config-ops.ts` 中该方法）_

### `getPrivacyScan`

```ts
async getPrivacyScan(): Promise<PrivacySnapshot>
```

Privacy scan.

- @returns PrivacySnapshot: privacy scan result.

### `getPrivacyState`

```ts
getPrivacyState(): PrivacyStateSnapshot
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-config-ops.ts` 中该方法）_

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

### `getRemoteImages`

```ts
async getRemoteImages(options: { urls?: string[] }): Promise<{ items: Array<{ url: string; dataUrl?: string; fromCache?: boolean; error?: string }> }>
```

远程图片代理（M23）：一批 https 图片地址 → 后端取回并缓存 → data URL。  存在的原因：卡片缩略图 / 朋友圈远程图 / 视频号封面此前由**渲染层直接向消息里的地址发请求**， 那条路径不进操作记录、没有缓存、也不受主机白名单约束。 收到后端之后这三件事才成立，而 CSP `img-src` 的 `https:` 通配也才可能拿掉。 只代取腾讯系主机（判据见 `query/cdn-hosts.ts`）；站外图床会被拒。

- @param options - `urls`: 图片地址列表（去重后最多取 40 张，超出的条目回错误）。
- @returns `{items}`：每条 `{url, dataUrl?, fromCache?, error?}`，`url` 原样带回当键。

### `getRetrievalStatus`

```ts
getRetrievalStatus(): RetrievalStatus
```

RAG 检索层状态：配置 + 向量库 + 反馈统计 + 当前调参权重 + 意图分类自评。

- @returns 供「数据健康」面板与诊断脚本展示（原「检索设置」面板已于 2026-09-17 下线）。

### `getRevoked`

```ts
getRevoked(options?: { limit?: number; offset?: number; q?: string }): RevokedSnapshot
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
async getSessions(options?: { keyword?: string; limit?: number; offset?: number }): Promise<SessionsSnapshot>
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-read.ts` 中该方法）_

### `getSnsImageDataUrl`

```ts
async getSnsImageDataUrl(options: { md5: string timelineId?: string mediaId?: string url?: string token?: string seed?: string offline?: boolean }): Promise<ImageDataUrlResult>
```

Resolve one SNS (朋友圈) media to a base64 data URL —— **先网后本**。  有网（`offline` 非真）：直接向微信 CDN 要 `/0` 那份**原图**，取回即落盘到 `decoded_images/sns-media/`；**不做任何本地判断在前**。只有 CDN 这一趟失败才回落本机。 无网：全程不发网络请求，依次用「已下载的原图 → `cache/<month>/Sns/Img` → 缩略图」。  顺序与理由见 `remotes/media.ts` 的 `snsImageWithCdnFirst`。  `offline` 由界面按 `navigator.onLine` 判定，缺省按有网处理。

- @param options - `md5` 来自朋友圈 XML；`url`/`token`/`seed` 是 CDN 三件套；
- @returns ImageDataUrlResult: base64 data URL（`thumb: true` = 只能给缩略图）或 error。

### `getSnsVideoCoverDataUrl`

```ts
async getSnsVideoCoverDataUrl(options: { md5?: string; timelineId?: string; mediaId?: string; thumb?: string; key?: string; offline?: boolean }): Promise<ImageDataUrlResult>
```

一条朋友圈视频封面 → data URL（W2-5.6 的单条入口保留；列表请走 `getSnsVideoCoversBatch`）。

- @param options - md5 / timelineId / mediaId / thumb / key / offline。
- @returns ImageDataUrlResult。

### `getSnsVideoCoversBatch`

```ts
async getSnsVideoCoversBatch(options: SnsVideoCoverBatchOptions): Promise<SnsVideoCoverBatchResult>
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-media-ops.ts` 中该方法）_

### `getSnsVideoDataUrl`

```ts
async getSnsVideoDataUrl(options: { md5?: string; timelineId?: string; mediaId?: string; url?: string; key?: string }): Promise<ImageDataUrlResult>
```

Resolve one SNS (朋友圈) video body so it can be played inline.  两级来源：**先本机缓存**（明文，离线、最快），没有缓存再按朋友圈 XML 里的 `<url>` 从微信 CDN 按需取回。取回要过隐私闸门（与 AI 调用同一套：脱敏与审计， 见 `gateway-privacy.ts` —— 2026-09-30 起它只做这两件事，不再有拦截）， CDN 返回的是客户端加密流，按 `<enc key>` 解密后再**校验容器头与 md5**， 免得把一个放不出来的二进制塞给 <video>。 

- @param options - media md5 from the moments XML（+ 本地缓存键、`<url>` 与 `<enc key>`）。
- @returns ImageDataUrlResult: base64 data URL or an error explaining which source failed.

### `getStorageStats`

```ts
async getStorageStats(): Promise<StorageSnapshot>
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
async getVoiceDataUrl(options: { username: string; localId: number }): Promise<VoiceDataUrlResult>
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

### `getWordCloud`

```ts
async getWordCloud(options?: WordCloudOptions): Promise<WordCloudResult>
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-read.ts` 中该方法）_

### `installWhisperEngine`

```ts
async installWhisperEngine(options?: { jobId?: string }): Promise<WhisperDownloadResult>
```

Download + install the whisper.cpp CLI engine into the models dir (`<modelsDir>/bin/whisper-cli.exe`), persisting the path as whisper_bin.

- @returns WhisperDownloadResult: ok + path, or an error.

### `listBackups`

```ts
listBackups(): BackupSnapshot
```

List local WeChat backups.

- @returns BackupSnapshot: backup entries (items + total).

### `listClawbotInstances`

```ts
listClawbotInstances(): ClawbotInstancesSnapshot
```

实例列表（多实例：一个微信号 = 一个实例；每个实例有自己的自动回复与知识库开关）。

- @returns 实例列表快照（读失败时带 readError —— 与「一个实例都没有」不是一回事）。

### `listClawbotMessages`

```ts
listClawbotMessages(options?: ClawbotMessageQuery): ClawbotMessageSnapshot
```

接入会话检索（时间 / 关键词 / 方向 / 分页 / 续传）。

- @param options - 检索条件（关键词在服务端过滤；带 `slot` 即按实例分）。
- @returns 会话页快照。

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

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-config-ops.ts` 中该方法）_

### `openConfig`

```ts
async openConfig(signal: AbortSignal = new AbortController().signal): Promise<{ ok: boolean; path: string; error?: string }>
```

保留理由：与「数据配置」面板现有那条路径等价 —— 界面用 `getWechatPathConfig()` 拿到路径后 再 `openPath()` 打开（Settings.tsx）。这里保留一份「直接打开 config.json」的接口给宿主调用。

### `openPath`

```ts
async openPath(options: { path: string }, signal: AbortSignal = new AbortController().signal): Promise<{ ok: boolean; path: string; error?: string }>
```

Open an owned path (config/output dir/file) with the system default.  P2-6：这条路在 vendored 依赖里最终走到 `powershell.exe … Invoke-Item`， 而对 `.exe` 那就是**直接执行** —— 渲染层被控时就成了 RCE 原语。 现在只允许打开数据根之内、或应用确实往里写过产出的目录（导出对话框选过的位置）， 且可执行/脚本扩展名一律拒。被拒不等于静默失败：理由要回给界面， 否则用户看到的又是「点了没反应」（P1-1 那一族的反面）。

- @param options - 要打开的路径。
- @param signal - 调用取消信号。
- @returns 打开结果与被拒理由。

### `optimizeAskQuestion`

```ts
async optimizeAskQuestion(options: { question: string username?: string from?: string to?: string history?: Array<{ role: 'user' | 'assistant'; content: string }> }): Promise<AskOptimizeResult>
```

提问优化：把用户问题改写为更利于本机检索的形式，并给出改进建议。 供「微信问答」面板的「优化提问」按钮调用；出站前同样过隐私闸门。

- @param options - question（必填）+ 可选 scope/history 作上下文。
- @returns AskOptimizeResult: optimized + suggestions。

### `planOriginalFetch`

```ts
async planOriginalFetch(): Promise<OriginalFetchPlan>
```

盘点「每条图片消息的原图能不能拿到」——**纯本机扫描，不联网**。  三类答案分开报：本机已有 `_h`（离线就有）/ 有免登录直链可联网补 / 只有 `cdnbig*` （需微信登录态，本应用不取）。没有这个数，界面上只能给一句「取不到」。 与批量执行共用同一次扫描（`scanImageOriginalPlan`），所以两份数字对得上。

- @returns OriginalFetchPlan：条数、可补条数、需登录条数、XML 声明的预计字节数。

### `previewBackup`

```ts
previewBackup(options: { name: string }): BackupPreviewSnapshot
```

Preview a backup's contents (bounded file list) before restore.

- @param options - backup name.
- @returns BackupPreviewSnapshot: items + total.

### `pruneExportHistory`

```ts
pruneExportHistory(options?: ExportHistoryPruneOptions): ExportHistoryDeleteResult
```

按策略清理导出历史（按天数 / 保留最近 N 条 / 只清失效记录）。

- @param options - 清理策略；三项都缺省时**什么都不删**（安全闸）。
- @returns 删除计数与文件删除失败清单。

### `renameKb`

```ts
renameKb(options: { id: number; name: string }): KbMutationResult
```

Rename one knowledge base.  笔记**不动**：归属存在 `kb_id` 上，库名只是显示名。用库名当外键的话， 「改名」会退化成「迁移全部笔记」，还要处理迁移到一半崩掉。

- @param options - `id` plus the new `name`.
- @returns KbMutationResult.

### `repairCorruptDbs`

```ts
async repairCorruptDbs(): Promise<DbRepairResult>
```

修复损坏的库：体检 → 只重解密损坏的那几个 → 复检（`query/db-repair.ts`）。 与「立即解密」（`decryptAllDatabases`）的区别是**范围**：那个 22 个库一律 重解（分钟级），这个只动坏的 —— 这正是那条处方里「必要时对该库重新解密」 此前缺失的动作。实时进度走 `getDecryptStatus`（`op` = `databases`）。

- @returns DbRepairResult: found / repaired / stillCorrupted + 修不了的与原因。

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
async resolveChatHistory(options: { serverId: string }): Promise<ChatHistoryResolveResult>
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-read.ts` 中该方法）_

### `restoreBackup`

```ts
restoreBackup(options: { name: string; password: string }): BackupRestoreResult
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-export-ops.ts` 中该方法）_

### `runSummaryTask`

```ts
async runSummaryTask(options: { id: number }): Promise<SummaryTaskRunResult>
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-ask-ops.ts` 中该方法）_

### `saveNote`

```ts
saveNote(kbId: number, options: { id?: number title: string body?: string tags?: string[] | string sourceKind?: 'manual' | 'ask' sourceUsername?: string sourceQuestion?: string }): NoteMutationResult
```

Create (no `id`) or update (`id` given) one knowledge note.  `sourceKind: 'ask'` marks a note distilled from a WeChat Q&A answer — that is the join point with the social graph: the panel draws an edge from the note to its source chat instead of leaving knowledge nodes floating. Title uniqueness is checked **within** that kb, not across the whole store.

- @param kbId - owning knowledge base for a new note / expected owner for an update.
- @param options - Note fields; title is required and unique in that kb (case-insensitive).
- @returns NoteMutationResult: `{ ok, id }`, or `{ ok: false, error }`.

### `saveRetrievalConfig`

```ts
saveRetrievalConfig(options?: { patch?: RetrievalConfigPatch } | RetrievalConfigPatch): { ok: boolean; config: RetrievalConfig }
```

保存检索参数（阈值/权重/容量）。 **界面已不再暴露该入口**（面板下线，参数固化为产品默认值）——仅供诊断与自动化测试参考使用。

- @param options - 形如 `{ patch: {...} }`，或直接给字段子集。
- @returns 落盘后的完整配置。

### `saveSummaryTask`

```ts
saveSummaryTask(options: { task: SummaryTaskInput }): SummaryTaskMutationResult
```

Save (insert/update) a daily-summary task.  入参里没有 `lastRunAt` / `lastStatus` / `lastError` —— 那是运行状态，只有 `runSummaryTask` 那条路（`updateSummaryTaskRunState`）会写。理由见 `types-calls.ts` 的 `SummaryTaskInput`。

- @param options - task payload (id present = update, absent = insert).
- @returns SummaryTaskMutationResult: ok + id, or error.

### `saveWechatConfig`

```ts
saveWechatConfig(options: { patch: WechatConfigPatch }): SimpleResult
```

Save the WeChat config (merge patch).

- @param options - patch of config fields to merge.
- @returns SimpleResult: ok, or error on failure.

### `searchKb`

```ts
async searchKb(options: { kbId: number; query?: string; topK?: number }): Promise<KbSearchResult>
```

在某个知识库里做检索 —— 稀疏（FTS5 bm25）+ 稠密（向量余弦）两路，RRF 名次融合。  为什么稠密这一路要在网关做而不下沉进 `searchKbRows`：稠密要**出网**（把查询词送去 embedding），而隐私闸门与模型名解析都住在这一层；query 层保持「给什么函数用什么函数」， 才能被问答管道与面板同时复用（`retrieval/kb-channel.ts` 走的就是同一个 `searchKbDense`）。  `degraded` 现在说的是**本次真话**（原来是一句硬编码的「未建向量索引」）： 未配模型 / 索引过期 / embedding 失败 / 稠密跑成功，四种情形的出路完全不同， 混成一句会让用户以为「知识库里没有这个东西」。

- @param options - `kbId`、查询词、可选条数（上限 `MAX_KB_TOP_K`）。
- @returns KbSearchResult：命中 + 统计 + 降级说明。

### `searchMembers`

```ts
searchMembers(options: { q: string; limit?: number; roomUsername?: string }): MemberSearchSnapshot
```

Contact / group-member search. 保留理由：界面暂无入口（全局搜索走 searchUnified），保留给宿主/后续的群成员选择器。 第 96 轮补上了群内路径漏掉的 `quan_pin`/`alias`（此前「按备注全拼在群里搜人」永远搜不到）； 第 97 轮才发现 FTS 那条路径同样漏着（`contact_fts` 只有 `name` 可检索），且它才是默认路径。 把关：`wechat-data/tests/members-search-columns.spec.ts`。

- @param options - search term, optional limit and room scope.
- @returns MemberSearchSnapshot: matching members (items + total + source).

### `searchMessages`

```ts
async searchMessages(options: { query: string; limit?: number; username?: string; jobId?: string }): Promise<SearchSnapshot>
```

Full-text search over text messages (index first, scan fallback).  N9：可取消。渲染层每次搜索生成一个 `jobId`，切换面板/发起新搜索时用 `cancelSearch({ jobId })` 打断上一次 —— 兜底扫描会在百毫秒内收尾并返回部分结果（见 `query/search.ts` 的 `SearchControl`）。 不带 jobId 时行为与从前一致（跑完为止）。

- @param options - query string, optional result limit and optional talker scope.
- @returns SearchSnapshot: matched message items（被取消时带 `cancelled: true`）。

### `searchUnified`

```ts
searchUnified(options: { query: string; limit?: number }): UnifiedSearchSnapshot
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-read.ts` 中该方法）_

### `sendClawbotMessage`

```ts
async sendClawbotMessage(options: { text: string, slot?: number }): Promise<ClawbotSendResult>
```

发送一条消息到微信（用户主动触发；正文经腾讯服务中转，**唯一由内容驱动的出网路径**）。

- @param options.text - 正文原文（不打码、不改写）。
- @param options.slot - 从哪个实例发（缺省 = 第一个实例）。
- @returns 发送结果（失败不落库，error 为可读中文）。

### `setClawbotInstanceConfig`

```ts
setClawbotInstanceConfig(options: { slot: number, autoReply?: boolean, kbEnabled?: boolean, kbId?: number | null }): ClawbotInstanceConfig
```

改某实例的**行为配置**（AI 自动回复 / 知识库增强；部分更新）。  模型不在这里选：自动回复走与「微信问答」同一条 ask 管道 ⇒ 统一由设置里的「对话模型」决定（见 `remotes/clawbot.ts` 的 `ask` 注入点）。

- @param options - 实例编号 + 要改的字段。
- @returns 落库后的完整配置。

### `setKbFileRag`

```ts
setKbFileRag(options: { kbId: number; id: number; includeInRag: boolean }): KbFileMutationResult
```

切换一个文件是否参与向量化（出网）。  关掉之后该文件**完全不出网**，但仍然留在 FTS 索引里可被关键词搜到 —— 这正是「库里有合同，但我还想搜到它」的实现方式（设计稿 §9.2）。

- @param options - `kbId`、文件 id、是否参与。
- @returns KbFileMutationResult.

### `setKbModelConfig`

```ts
setKbModelConfig(options: { kbId: number; chatRef?: string; embedRef?: string; rerankRef?: string }): KbModelConfigResult
```

写某个知识库的模型覆盖（只改传进来的那几项；传空串 = 取消覆盖、回到继承）。  这一层**不写凭据**：引用串只能是「继承」或「m:<模型名>」，端点与 Key 永远只在 `llm.json`。 为什么收窄到这样：一条 profile 是一套同厂商的连接参数，按库引用它就会把 「A 家地址 + B 家 Key」这种 401 陷阱重新请回来（见 `model-config.ts` 头注）。

- @param options - `kbId` 加可选的 `chatRef` / `embedRef` / `rerankRef`。
- @returns 最新设置；引用串不合法时 `{ ok: false, error }`（不静默改成继承）。

### `setPrivacyState`

```ts
setPrivacyState(options: { redactSensitive?: boolean }): PrivacyStateSnapshot
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-config-ops.ts` 中该方法）_

### `setTaskStatus`

```ts
setTaskStatus(options: { id: number; status: 'open' | 'done' }): TaskMutationResult
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-config-ops.ts` 中该方法）_

### `submitAskFeedback`

```ts
submitAskFeedback(options: { retrievalId?: string rating: 'up' | 'down' useful?: number[] useless?: number[] question?: string answer?: string }): { ok: boolean; adaptedWeights?: RerankWeights; features?: string[]; feedbackTotal?: number; message?: string }
```

提交问答反馈（目标 5 的闭环入口）。  反馈 → 特征归因 → 权重微调 → 落盘。权重**由全部历史反馈重算**（幂等、可重放）， 而不是在旧权重上累加 —— 累加会因为重复提交同一条反馈而漂移。  N27：同一轮反馈在 10 秒窗口内的重复提交会被挡掉并返回可读的「已在处理」， 不再产生第二条反馈记录 / 第二次权重适配（前端闸门只管同一个面板的连点， 两个面板同时提交、旧版客户端重试、直接 RPC 调用都落到这里）。

- @param options - retrievalId（AskResult 里回传）+ rating + 有用/无用引用序号。
- @returns 调参后的权重；重复提交时 `ok:false` + `message`。

### `suggestKbLinks`

```ts
async suggestKbLinks(options: { kbId: number; text?: string; topK?: number; excludeTitle?: string }): Promise<KbLinkSuggestResult>
```

笔记编辑器里的「模型建议的链接」—— 返回候选，**不写任何东西**。  两条纪律（V6 的全部内容）： ① 出去的是**正文 + 候选标题**，所以 gate 的 texts 必须一次带上两边 （`makeEmbedFn` 内部对整批文本过一次闸，漏一半就等于漏的那半没脱敏）； ② 本方法**没有任何写路径**：连一行正文都不碰。边只在用户点芯片之后由 `parseWikiLinks` 从正文里派生 —— 模型判断错的代价因此是「没人点」， 而不是「图谱里多了一条用户没写过的边」。

- @param options - `kbId`、正在编辑的 `text`、可选 `topK` 与自身标题 `excludeTitle`。
- @returns 候选（按相似度降序）+ 参与排序的池大小 + 说明。

### `suggestReplies`

```ts
async suggestReplies(options: { username?: string; kbId?: number; count?: number }): Promise<ReplySuggestResult>
```

「推荐回复」：按**当前会话**的上下文（+ 用户选中的知识库）给出候选回复。  与问答的区别是**不检索全库**：上下文只取这个会话最近若干条，知识库片段也只在用户 显式选了库时才取。会话级功能不该把别处的聊天悄悄端上来 —— 这正是「单聊里冒出别人 消息」那类报障的教训。  出站顺序与当日总结一致：模型不可用时如实说明原因。

- @param options - `username` 会话；`kbId` 当前选中的库（可缺省）；`count` 想要几条（默认 3，上限 5）。
- @returns 候选回复；模型不可用时 `ok=false` 且 `error` 说明原因。

### `summarizeKbFile`

```ts
async summarizeKbFile(options: { kbId: number; id: number }): Promise<KbSummaryResult>
```

用模型给某个知识库文件生成摘要。**这是一条出网调用**，与问答同一套闸门。  顺序是硬性的（照 `optimizeAskQuestion` 的口径，理由写在它头上）： ① `include_in_rag = 0` 直接拒绝：那个开关的语义是「这份文件永不出网」， 给它做摘要等于推翻用户已经做过的决定，不是「再确认一下」能补的。 ② 发出去之前过一次 `privacyGate`（脱敏 + 审计）。  ⚠ 只喂得下前若干字：一份文件最多两万块、约一千万字，一次请求装不进去。 所以按 `SUMMARY_INPUT_CHARS` 截断，并把**实际覆盖的字符数**一起返回并落库 —— 界面必须据此标出「这只是前 N 字的摘要」。不标就是让一个局部摘要 顶着「摘要」的名字被当成整份文件的概括读，那是界面在骗人。

- @param options - `kbId`（守卫）与 `id`（目标文件）。
- @returns KbSummaryResult。

### `syncHandoffTasks`

```ts
syncHandoffTasks(): TaskMutationResult
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-config-ops.ts` 中该方法）_

### `toggleSummaryTask`

```ts
toggleSummaryTask(options: { id: number; enabled: boolean }): SummaryTaskMutationResult
```

Toggle a daily-summary task enabled state.

- @param options - task id and the new enabled flag.
- @returns SummaryTaskMutationResult: ok, or error on failure.

### `transcribeVoiceBatch`

```ts
async transcribeVoiceBatch(options?: { limit?: number }): Promise<VoiceTranscribeResult>
```

Batch-transcribe the most recent voice messages: silk → WAV (bundled wx_silk) → whisper-cli with the selected model → text cached per message.

- @param options - optional message count (default 50, clamped 1..200).
- @returns VoiceTranscribeResult: done/failed/skipped counts.

### `transcribeVoiceMessage`

```ts
async transcribeVoiceMessage(options: { username: string; localId: number }): Promise<VoiceTranscribeOneResult>
```

Transcribe one voice message on demand (chat bubble 语音转文字).

- @param options - message username + local_id.
- @returns VoiceTranscribeOneResult: ok + text, or an error.

### `unbindClawbot`

```ts
unbindClawbot(options?: { slot?: number }): ClawbotBindingSnapshot
```

解绑（断开该实例的通道；**接入会话保留**，见 PRIVACY.md 第三节）。

- @param options.slot - 实例编号（缺省 = 第一个实例）。
- @returns 解绑后的绑定卡片快照。

### `unloadLaya`

```ts
unloadLaya(): { ok: boolean }
```

Unload the model, releasing roughly 1.2 GB of resident memory. The next analysis call loads it again.

- @returns SimpleResult.

### `upgradeDecodedImages`

```ts
async upgradeDecodedImages(): Promise<ImageUpgradeResult>
```

升级老解码缓存：把 `<decoded>/<md5>.<ext>` 里由低档 `.dat`（聊天版 / 缩略图）解出来的图， 用本机现存最好的一档（`_h` 原图，含 wxgf 转码）重解一遍。**不联网**。  为什么要有这一条：缓存是「谁先解出来谁占坑」（见 `query/media-image.ts` 的 `cachedImage`）， 逐条读图时命中缓存就直接返回、不会回头找更好的源。所以 2026-09 那批先解了缩略图的缓存， 在用户后来于微信里点开原图、或本机装上 wxgf 解码库之后**仍然是糊的那一份**。 判据是「重解结果严格更大才覆盖」⇒ 幂等、且永远不会把 CDN 原图降级成本机的较小那份。 实时进度通过 getDecryptStatus 轮询读取（`op` = `image-upgrade`）。

- @returns ImageUpgradeResult: 检查/已升级/无需升级/本机无源/失败 计数 + 明细。

### `verifyDatabaseKey`

```ts
verifyDatabaseKey(options: { dbPath: string; encKeyHex: string }): VerifyKeyResult
```

Verify a database key (SQLCipher PBKDF2 + AES + HMAC).

- @param options - dbPath and encKeyHex of the key to verify.
- @returns VerifyKeyResult: valid flag plus optional AES/HMAC checks.

### `verifyImageKey`

```ts
async verifyImageKey(): Promise<VerifyImageKeyResult>
```

_（源码中未附说明 —— 请直接阅读 `src/backend/wechat-data/src/gateway-config-ops.ts` 中该方法）_
