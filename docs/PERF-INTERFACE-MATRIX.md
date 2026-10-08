# 逐接口性能矩阵（172 个 Remote 方法 · 范围 / 目标 / 验证）

> ⚙️ **本文件由 `node scripts/perf-interface-matrix.mjs` 生成，不要手改**；
> CI 用 `node scripts/perf-interface-matrix.mjs --check` 校验它与源码一致。

它回答的是「**每一个**接口的优化范围、性能目标、验证方式各是什么」——
而不是只列被改过的那 23 处。归类由 `scripts/perf-interface-matrix.mjs` 的 `FAMILIES` 名单决定，
工具只保证**不漏、不重复、不悬空**。

- 接口总数：**172**（与 `docs/API.md` 一致：172）
- 家族数：**9**；未归类：**0**
- 探针读数来源：`working/probe-remote*.txt`（方法表行数 170）

## 口径（三条，必须一起读）

1. **片段上界** = `总耗时 / (让出次数 + 1)`。它是"串行 worker 上别的请求最多等多久"的上界，
   **不是**"用户少等多久"；让出 0 时即"整段独占"。
2. **探针耗时列不总是可信**：同一份代码同一台机器上曾漂移 250×；`> 180s` 的值一定是坏读数
   （32 位溢出），表里标 `⚠坏读数`。要引用这些数请看 `docs/PERF-THEME-LEDGER-2026-09-29.md` 的分档说明。
3. **进退出码的是结构与归类**（穷举 / 不悬空 / 文档不过期），**不是**上面那些毫秒值 ——
   所以 `--check` 不依赖本机数据根，可以进 CI。

## 本地整表扫（已优化：让出 + 结果缓存）

- **优化范围**：数据库查询：整表 `.all()` / 逐行 XML 解析 / 逐字符 bigram；算法复杂度：O(行数)；重复调用：同一会话内重复取数
- **性能目标**：片段上界（单次不让出的最长时长）≤ 50ms（登记例外：`planOriginalFetch` ≤ 302ms，账本第 14 项）；让出次数 > 0；热点方法热跑 ≤ 5ms。⚠️ 年报首次冷跑仍有 ~2.5s（扫约 200 万行），已登记为未闭环项，缓存只解决"重复查看"。
- **验证方式**：`query-yield-discipline.spec.ts`（tick 下界）+ `guard-coverage-ledger.spec.ts`（每处修复都有守卫）+ `working/verify-acceptance.mjs`（账本 ↔ 守卫 ↔ 实测三方核对）
- **接口数**：19

| # | 接口 | 壳文件 | 冷跑(ms) | 让出 | 片段上界(ms) | 备注 |
|---|---|---|---|---|---|---|
| 1 | `createBackup` | gateway-data-ops.ts | 145 | 14 | 10 |  |
| 2 | `exportAnnualReport` | gateway-data-ops.ts | 3065 | 1001 | 3 |  |
| 3 | `exportMoments` | gateway-data-ops.ts | 183 | 3 | 46 |  |
| 4 | `extractTasks` | gateway-data-ops.ts | 208 | 5 | 35 |  |
| 5 | `generateDailySummary` | gateway-ask-ops.ts | 138 | 5 | 23 |  |
| 6 | `generatePeriodSummary` | gateway-ask-ops.ts | 258 | 5 | 43 |  |
| 7 | `getAnnualReport` | gateway-read.ts | 3140 | 1001 | 3 |  |
| 8 | `getAnnualReview` | gateway-read.ts | 2318 | 68 | 34 |  |
| 9 | `getAssetInsights` | gateway-read.ts | 145 | 3 | 36 |  |
| 10 | `getCalls` | gateway-read.ts | 84 | 3 | 21 |  |
| 11 | `getMomentsInsights` | gateway-read.ts | 206 | 21 | 9 |  |
| 12 | `getMomentsMonthly` | gateway-read.ts | 161 | 10 | 15 |  |
| 13 | `getOfficialAssets` | gateway-read.ts | 37 | 3 | 9 |  |
| 14 | `getOverview` | gateway-read.ts | 85 | 8 | 9 |  |
| 15 | `getSessions` | gateway-read.ts | 69 | 4 | 14 |  |
| 16 | `getWordCloud` | gateway-read.ts | 997 | 83 | 12 |  |
| 17 | `planOriginalFetch` | gateway-data-ops.ts | 1002 | 7 | 125 |  |
| 18 | `resolveChatHistory` | gateway-read.ts | 94 | 8 | 10 |  |
| 19 | `upgradeDecodedImages` | gateway-data-ops.ts | 215 | 15 | 13 |  |

## 密钥/解密类重任务（已加让出，不可中断）

- **优化范围**：数据库查询 + 文件遍历：微信进程内存扫描（读 `Weixin.exe`）、目录 BFS（最多 500 个）、全库重解密
- **性能目标**：片段上界 ≤ 150ms（`verifyImageKey` ≤ 110ms）；让出次数 > 0；不阻塞轻调用
- **验证方式**：`guard-coverage-ledger.spec.ts` 的委派白名单（`image-key-resolver.ts` → `keysdec.ts`）+ 探针 `working/probe-remote.txt`
- **接口数**：6

| # | 接口 | 壳文件 | 冷跑(ms) | 让出 | 片段上界(ms) | 备注 |
|---|---|---|---|---|---|---|
| 20 | `autoGetDbKey` | gateway-data-ops.ts | 37880 | 0 | 37880 |  |
| 21 | `autoGetImageKey` | gateway-data-ops.ts | 160 | 0 | 160 |  |
| 22 | `decryptAllDatabases` | gateway-data-ops.ts | 4157188997 | 0 | 4157188997 | ⚠坏读数（>180s 墙钟） |
| 23 | `generateKeysFile` | gateway-data-ops.ts | 2 | 0 | 2 |  |
| 24 | `verifyDatabaseKey` | gateway-read.ts | 2 | 0 | 2 |  |
| 25 | `verifyImageKey` | gateway-data-ops.ts | 1384 | 101 | 14 |  |

## 导出/备份长任务（后台 job + 进度 + 可取消）

- **优化范围**：重复调用：分页收集时每页一次完整查询（已把页大小调到 1000 并在页内切 100 条上报）；总量大但已切片
- **性能目标**：收集阶段 ≤ 1s/万条（实测 2449ms → 940ms/4.3 万条）；进度事件 ≥ 20 次；取消后无产出
- **验证方式**：`export-progress-job.spec.ts`、`export-stream.spec.ts`、`gateway-export-stream-progress.spec.ts`、`e2e:export-progress`、`e2e:export-nonblocking`
- **接口数**：7

| # | 接口 | 壳文件 | 冷跑(ms) | 让出 | 片段上界(ms) | 备注 |
|---|---|---|---|---|---|---|
| 26 | `createEncryptedBackup` | gateway-data-ops.ts | 2 | 0 | 2 |  |
| 27 | `deleteBackup` | gateway-data-ops.ts | 1 | 0 | 1 |  |
| 28 | `exportAllSessions` | gateway-data-ops.ts | 11588 | 1556 | 7 |  |
| 29 | `exportCsv` | gateway-data-ops.ts | 701 | 379 | 2 |  |
| 30 | `exportSessionMessages` | gateway-data-ops.ts | 29 | 0 | 29 |  |
| 31 | `previewBackup` | gateway-data-ops.ts | 0 | 0 | 0 |  |
| 32 | `restoreBackup` | gateway-data-ops.ts | 2 | 0 | 2 |  |

## 网络取图/取文（出网闸门 + 两级缓存 + 批量 + 并发上限）

- **优化范围**：网络往返：逐条 RPC（已改批量）、单张 2 次往返（HTML + 图片）、超时叠加（40 张 ÷ 6 并发 × 12s ≈ 80s 已调到 20 ÷ 10 × 8s ≈ 16s）
- **性能目标**：RPC 次数 = ⌈N/批⌉；单批最坏 ≤ 16s；缓存命中 / 出网关闭 ≤ 5ms；永久 404 重抓间隔 ≥ 5min
- **验证方式**：`article-cover-cache.spec.ts`、`remote-image.spec.ts`、`emoticon-batch.spec.ts`、`article-cover-local-first.spec.ts`、`probe-perf5` 的 A/B 对照
- **接口数**：18

| # | 接口 | 壳文件 | 冷跑(ms) | 让出 | 片段上界(ms) | 备注 |
|---|---|---|---|---|---|---|
| 33 | `adoptLayaModel` | gateway-data-ops.ts | 3 | 0 | 3 |  |
| 34 | `downloadLayaModel` | gateway-data-ops.ts | 3 | 0 | 3 |  |
| 35 | `downloadWhisperModel` | gateway-data-ops.ts | 2 | 0 | 2 |  |
| 36 | `exportSnsVideo` | gateway-data-ops.ts | 15 | 0 | 15 |  |
| 37 | `fetchOriginalImagesBatch` | gateway-data-ops.ts | - | - | - |  |
| 38 | `getArticleCover` | gateway-read.ts | 1 | 0 | 1 |  |
| 39 | `getArticleCovers` | gateway-read.ts | 0 | 0 | 0 |  |
| 40 | `getAvatar` | gateway-data-ops.ts | 1 | 0 | 1 |  |
| 41 | `getAvatarsLocal` | gateway-data-ops.ts | 1 | 0 | 1 |  |
| 42 | `getEmoticonDataUrl` | gateway-data-ops.ts | 0 | 0 | 0 |  |
| 43 | `getEmoticonDataUrls` | gateway-data-ops.ts | 0 | 0 | 0 |  |
| 44 | `getImageOriginal` | gateway-data-ops.ts | 15 | 0 | 15 |  |
| 45 | `getMessageFile` | gateway-data-ops.ts | 1 | 0 | 1 |  |
| 46 | `getRemoteImages` | gateway-data-ops.ts | 0 | 0 | 0 |  |
| 47 | `getSnsImageDataUrl` | gateway-data-ops.ts | 0 | 0 | 0 |  |
| 48 | `getSnsVideoCoverDataUrl` | gateway-data-ops.ts | 0 | 0 | 0 |  |
| 49 | `getSnsVideoDataUrl` | gateway-data-ops.ts | 0 | 0 | 0 |  |
| 50 | `installWhisperEngine` | gateway-data-ops.ts | 14 | 0 | 14 |  |

## 本地模型 / 远端 LLM（推理不可中断，已实测否掉合批）

- **优化范围**：模型推理：ONNX 单次 forward 同步不可中断（`analyzeMessages` 1187ms 片段）；远端 LLM：provider 往返 + 生成 token 数（不在本仓控制内）
- **性能目标**：首 token 看门狗 15s（D1）；`analyzeMessages` 片段 ≤ 1200ms；本地部分 ≤ 100ms
- **验证方式**：`laya/` 相关 spec + `llm-rerank.spec.ts` + `tools/laya/bench-inference.mjs`（合批慢 41.8% 的反证）+ `working/probe-remote.txt`
- **接口数**：16

| # | 接口 | 壳文件 | 冷跑(ms) | 让出 | 片段上界(ms) | 备注 |
|---|---|---|---|---|---|---|
| 51 | `analyzeMessages` | gateway-data-ops.ts | 3619 | 2 | 1206 |  |
| 52 | `analyzeVisibleMessages` | gateway-data-ops.ts | 3 | 0 | 3 |  |
| 53 | `askWechat` | gateway-ask-ops.ts | 54 | 0 | 54 |  |
| 54 | `buildKbVectorIndex` | gateway-ask-ops.ts | 0 | 0 | 0 |  |
| 55 | `buildRagVectorIndex` | gateway-ask-ops.ts | 0 | 0 | 0 |  |
| 56 | `buildSearchIndex` | gateway-ask-ops.ts | 4 | 0 | 4 |  |
| 57 | `evaluateRetrieval` | gateway-ask-ops.ts | 8 | 0 | 8 |  |
| 58 | `extractKbEntities` | gateway-ask-ops.ts | 0 | 0 | 0 |  |
| 59 | `getVoiceTranscript` | gateway-read.ts | 0 | 0 | 0 |  |
| 60 | `optimizeAskQuestion` | gateway-ask-ops.ts | - | - | - |  |
| 61 | `resetRetrievalWeights` | gateway-read.ts | 2 | 0 | 2 |  |
| 62 | `suggestKbLinks` | gateway-ask-ops.ts | 1 | 0 | 1 |  |
| 63 | `suggestReplies` | gateway-ask-ops.ts | 24 | 0 | 24 |  |
| 64 | `summarizeKbFile` | gateway-ask-ops.ts | 0 | 0 | 0 |  |
| 65 | `transcribeVoiceBatch` | gateway-data-ops.ts | 17 | 0 | 17 |  |
| 66 | `transcribeVoiceMessage` | gateway-read.ts | 2 | 0 | 2 |  |

## 本地图片/语音取数（缓存索引化，不出网）

- **优化范围**：缓存：`4×N` 次 `existsSync` 试扩展名（已改成 1 次 `readdir` 建索引）；重复读盘 + base64（已加内存 LRU）；扫 `msg/attach` 全树（已加索引 + 负缓存）
- **性能目标**：批量命中 ≤ 2ms/20 张；单张 ≤ 50ms；同一批 RPC 只发 1 次
- **验证方式**：`media-image-decode-shared.spec.ts`、`emoticon-batch.spec.ts`、`probe-perf5`（13.12ms → 1.95ms / 6.74×）
- **接口数**：6

| # | 接口 | 壳文件 | 冷跑(ms) | 让出 | 片段上界(ms) | 备注 |
|---|---|---|---|---|---|---|
| 67 | `getFileImageDataUrl` | gateway-data-ops.ts | 0 | 0 | 0 |  |
| 68 | `getImageDataUrl` | gateway-data-ops.ts | 30 | 0 | 30 |  |
| 69 | `getImageDataUrlsBatch` | gateway-data-ops.ts | 15 | 0 | 15 |  |
| 70 | `getVideoInfo` | gateway-data-ops.ts | 6 | 0 | 6 |  |
| 71 | `getVoiceDataUrl` | gateway-data-ops.ts | 0 | 0 | 0 |  |
| 72 | `getVoiceInfo` | gateway-data-ops.ts | 3 | 0 | 3 |  |

## 本地只读查询（30s 结果缓存；冷跑 ≤ 210ms、热跑 0ms）

- **优化范围**：数据库查询：单库/单表带索引查询；缓存：`cachedBySigAsync`（30s，按库文件签名失效）
- **性能目标**：冷跑 ≤ 210ms（本机基线；`probe-remote.txt` 的耗时列在受污染环境下不可比，见账本第 73/74/85 轮）、热跑 ≤ 5ms；无 ≥200ms 的整段独占
- **验证方式**：`cache-timing-coverage.spec.ts`、`cache-sig.spec.ts`、`probe-perf.ts`（29 接口冷/热对照）
- **接口数**：62

| # | 接口 | 壳文件 | 冷跑(ms) | 让出 | 片段上界(ms) | 备注 |
|---|---|---|---|---|---|---|
| 73 | `cancelSearch` | gateway-read.ts | 0 | 0 | 0 |  |
| 74 | `detectWechatAccounts` | gateway-read.ts | 29 | 0 | 29 |  |
| 75 | `getAnnual` | gateway-read.ts | 84 | 29 | 3 |  |
| 76 | `getAskHistory` | gateway-ask-ops.ts | 1 | 0 | 1 |  |
| 77 | `getContact360` | gateway-read.ts | 21 | 0 | 21 |  |
| 78 | `getContacts` | gateway-read.ts | 19 | 0 | 19 |  |
| 79 | `getDailyCounts` | gateway-read.ts | 3 | 0 | 3 |  |
| 80 | `getDbHealth` | gateway-data-ops.ts | 4 | 0 | 4 |  |
| 81 | `getDbStatus` | gateway-data-ops.ts | 1 | 0 | 1 |  |
| 82 | `getDecryptStatus` | gateway-data-ops.ts | 0 | 0 | 0 |  |
| 83 | `getEmoticons` | gateway-data-ops.ts | 1 | 0 | 1 |  |
| 84 | `getExportHistory` | gateway-data-ops.ts | 4 | 0 | 4 |  |
| 85 | `getExportProgress` | gateway-data-ops.ts | 0 | 0 | 0 |  |
| 86 | `getFavorites` | gateway-read.ts | 6 | 0 | 6 |  |
| 87 | `getFiles` | gateway-data-ops.ts | 12 | 0 | 12 |  |
| 88 | `getGraph` | gateway-read.ts | 42 | 3 | 10 |  |
| 89 | `getGroupInfo` | gateway-read.ts | 1 | 0 | 1 |  |
| 90 | `getGroupInsights` | gateway-read.ts | 11 | 0 | 11 |  |
| 91 | `getHandoffReminds` | gateway-data-ops.ts | 1 | 0 | 1 |  |
| 92 | `getKbFileChunks` | gateway-ask-ops.ts | 0 | 0 | 0 |  |
| 93 | `getKbFiles` | gateway-ask-ops.ts | 1 | 0 | 1 |  |
| 94 | `getKbModelConfig` | gateway-ask-ops.ts | 0 | 0 | 0 |  |
| 95 | `getKbs` | gateway-ask-ops.ts | 1 | 0 | 1 |  |
| 96 | `getKbVectorIndex` | gateway-ask-ops.ts | 1 | 0 | 1 |  |
| 97 | `getKnowledgeGraph` | gateway-ask-ops.ts | 4 | 0 | 4 |  |
| 98 | `getLayaStatus` | gateway-data-ops.ts | 0 | 0 | 0 |  |
| 99 | `getLedger` | gateway-read.ts | 34 | 4 | 7 |  |
| 100 | `getMediaAssets` | gateway-read.ts | 5 | 0 | 5 |  |
| 101 | `getMessages` | gateway-read.ts | 31 | 0 | 31 |  |
| 102 | `getMoments` | gateway-read.ts | 9 | 0 | 9 |  |
| 103 | `getMomentsAuthors` | gateway-read.ts | 9 | 0 | 9 |  |
| 104 | `getNewMessages` | gateway-read.ts | 25 | 0 | 25 |  |
| 105 | `getNotes` | gateway-data-ops.ts | 0 | 0 | 0 |  |
| 106 | `getOperationLog` | gateway-data-ops.ts | 0 | 0 | 0 |  |
| 107 | `getOverviewInsights` | gateway-read.ts | 310 | 7 | 39 |  |
| 108 | `getPaymentStatus` | gateway-read.ts | 1 | 0 | 1 |  |
| 109 | `getPrivacyAuditRows` | gateway-data-ops.ts | 0 | 0 | 0 |  |
| 110 | `getPrivacyScan` | gateway-data-ops.ts | 609 | 379 | 2 |  |
| 111 | `getPrivacyState` | gateway-data-ops.ts | 1 | 0 | 1 |  |
| 112 | `getRecords` | gateway-read.ts | 5 | 0 | 5 |  |
| 113 | `getRegionMap` | gateway-read.ts | 11 | 0 | 11 |  |
| 114 | `getRetrievalStatus` | gateway-ask-ops.ts | 1 | 0 | 1 |  |
| 115 | `getRevoked` | gateway-read.ts | 6 | 0 | 6 |  |
| 116 | `getSearchIndexStatus` | gateway-read.ts | 2 | 0 | 2 |  |
| 117 | `getSelfUsername` | gateway-read.ts | 0 | 0 | 0 |  |
| 118 | `getStorageStats` | gateway-read.ts | 179 | 108 | 2 |  |
| 119 | `getWechatConfig` | gateway-data-ops.ts | 0 | 0 | 0 |  |
| 120 | `getWechatConfigFull` | gateway-data-ops.ts | 0 | 0 | 0 |  |
| 121 | `getWechatKeysInfo` | gateway-data-ops.ts | 0 | 0 | 0 |  |
| 122 | `getWhisperStatus` | gateway-data-ops.ts | 1 | 0 | 1 |  |
| 123 | `listBackups` | gateway-data-ops.ts | 47 | 0 | 47 |  |
| 124 | `listEditedMessages` | gateway-read.ts | 0 | 0 | 0 |  |
| 125 | `listLlmModels` | gateway-data-ops.ts | 0 | 0 | 0 |  |
| 126 | `listLlmProviders` | gateway-data-ops.ts | 0 | 0 | 0 |  |
| 127 | `listRetrievalFeedback` | gateway-ask-ops.ts | 1 | 0 | 1 |  |
| 128 | `listSummaryRecords` | gateway-read.ts | 0 | 0 | 0 |  |
| 129 | `listSummaryTasks` | gateway-ask-ops.ts | 0 | 0 | 0 |  |
| 130 | `listTasks` | gateway-data-ops.ts | 0 | 0 | 0 |  |
| 131 | `searchKb` | gateway-ask-ops.ts | 0 | 0 | 0 |  |
| 132 | `searchMembers` | gateway-read.ts | 3 | 0 | 3 |  |
| 133 | `searchMessages` | gateway-ask-ops.ts | 8 | 0 | 8 |  |
| 134 | `searchUnified` | gateway-read.ts | 25 | 0 | 25 |  |

## 写操作（本地落盘 / DB 写 / 配置写，原子写）

- **优化范围**：写放大：整文件重写、`cpSync`（已改异步原子写）；重复写：同一配置反复落盘
- **性能目标**：单次 ≤ 200ms；写失败不产生半截文件（原子替换）
- **验证方式**：`backup-atomic.spec.ts`、`gateway-operation-log.spec.ts`、`m1-secrets-migration-smoke.js`、`read-failure-contract.spec.ts`
- **接口数**：32

| # | 接口 | 壳文件 | 冷跑(ms) | 让出 | 片段上界(ms) | 备注 |
|---|---|---|---|---|---|---|
| 135 | `addKbFiles` | gateway-ask-ops.ts | 0 | 0 | 0 |  |
| 136 | `addTask` | gateway-data-ops.ts | 5 | 0 | 5 |  |
| 137 | `clearAskHistory` | gateway-read.ts | 3 | 0 | 3 |  |
| 138 | `clearOperationLog` | gateway-data-ops.ts | 5 | 0 | 5 |  |
| 139 | `clearPrivacyAudit` | gateway-data-ops.ts | 3 | 0 | 3 |  |
| 140 | `createKb` | gateway-ask-ops.ts | 2 | 0 | 2 |  |
| 141 | `decryptAllImages` | gateway-data-ops.ts | - | - | - |  |
| 142 | `deleteAskHistory` | gateway-read.ts | 2 | 0 | 2 |  |
| 143 | `deleteExportHistory` | gateway-data-ops.ts | 2 | 0 | 2 |  |
| 144 | `deleteFavoriteItems` | gateway-read.ts | 2 | 0 | 2 |  |
| 145 | `deleteKb` | gateway-ask-ops.ts | 1 | 0 | 1 |  |
| 146 | `deleteKbFile` | gateway-ask-ops.ts | 2 | 0 | 2 |  |
| 147 | `deleteNote` | gateway-data-ops.ts | 1 | 0 | 1 |  |
| 148 | `deleteSummaryRecord` | gateway-ask-ops.ts | 2 | 0 | 2 |  |
| 149 | `deleteSummaryTask` | gateway-ask-ops.ts | 2 | 0 | 2 |  |
| 150 | `deleteTask` | gateway-data-ops.ts | 2 | 0 | 2 |  |
| 151 | `editChatMessage` | gateway-read.ts | 5 | 0 | 5 |  |
| 152 | `pruneExportHistory` | gateway-data-ops.ts | 1 | 0 | 1 |  |
| 153 | `renameKb` | gateway-ask-ops.ts | 1 | 0 | 1 |  |
| 154 | `resetEditedMessage` | gateway-ask-ops.ts | 6 | 0 | 6 |  |
| 155 | `runSummaryTask` | gateway-ask-ops.ts | 0 | 0 | 0 |  |
| 156 | `saveNote` | gateway-data-ops.ts | 2 | 0 | 2 |  |
| 157 | `saveRetrievalConfig` | gateway-ask-ops.ts | 2 | 0 | 2 |  |
| 158 | `saveSummaryTask` | gateway-ask-ops.ts | 2 | 0 | 2 |  |
| 159 | `saveWechatConfig` | gateway-data-ops.ts | 3 | 0 | 3 |  |
| 160 | `setKbFileRag` | gateway-ask-ops.ts | 0 | 0 | 0 |  |
| 161 | `setKbModelConfig` | gateway-ask-ops.ts | 2 | 0 | 2 |  |
| 162 | `setPrivacyState` | gateway-data-ops.ts | 2 | 0 | 2 |  |
| 163 | `setTaskStatus` | gateway-data-ops.ts | 1 | 0 | 1 |  |
| 164 | `submitAskFeedback` | gateway-ask-ops.ts | 4 | 0 | 4 |  |
| 165 | `syncHandoffTasks` | gateway-data-ops.ts | 2 | 0 | 2 |  |
| 166 | `toggleSummaryTask` | gateway-ask-ops.ts | 2 | 0 | 2 |  |

## 系统/壳层操作（打开路径、状态查询、模型装载）

- **优化范围**：进程与系统调用：shell open、onnxruntime session 装载/卸载（`unloadLaya` 释放内存）
- **性能目标**：单次 ≤ 200ms；不阻塞 worker 队列
- **验证方式**：`security-guard:smoke`（开窗/外链被拒）+ `package:smoke`
- **接口数**：6

| # | 接口 | 壳文件 | 冷跑(ms) | 让出 | 片段上界(ms) | 备注 |
|---|---|---|---|---|---|---|
| 167 | `cancelExportJob` | gateway-data-ops.ts | 0 | 0 | 0 |  |
| 168 | `clearAllSessionDrafts` | gateway-read.ts | 2 | 0 | 2 |  |
| 169 | `clearSessionDraft` | gateway-read.ts | 2 | 0 | 2 |  |
| 170 | `openConfig` | gateway-data-ops.ts | 119 | 7594 | 0 |  |
| 171 | `openPath` | gateway-read.ts | 0 | 0 | 0 |  |
| 172 | `unloadLaya` | gateway-data-ops.ts | 2 | 0 | 2 |  |

## 附：全部方法名清单（字典序，便于核对穷举性）

`addKbFiles` · `addTask` · `adoptLayaModel` · `analyzeMessages` · `analyzeVisibleMessages` · `askWechat` · `autoGetDbKey` · `autoGetImageKey` · `buildKbVectorIndex` · `buildRagVectorIndex` · `buildSearchIndex` · `cancelExportJob` · `cancelSearch` · `clearAllSessionDrafts` · `clearAskHistory` · `clearOperationLog` · `clearPrivacyAudit` · `clearSessionDraft` · `createBackup` · `createEncryptedBackup` · `createKb` · `decryptAllDatabases` · `decryptAllImages` · `deleteAskHistory` · `deleteBackup` · `deleteExportHistory` · `deleteFavoriteItems` · `deleteKb` · `deleteKbFile` · `deleteNote` · `deleteSummaryRecord` · `deleteSummaryTask` · `deleteTask` · `detectWechatAccounts` · `downloadLayaModel` · `downloadWhisperModel` · `editChatMessage` · `evaluateRetrieval` · `exportAllSessions` · `exportAnnualReport` · `exportCsv` · `exportMoments` · `exportSessionMessages` · `exportSnsVideo` · `extractKbEntities` · `extractTasks` · `fetchOriginalImagesBatch` · `generateDailySummary` · `generateKeysFile` · `generatePeriodSummary` · `getAnnual` · `getAnnualReport` · `getAnnualReview` · `getArticleCover` · `getArticleCovers` · `getAskHistory` · `getAssetInsights` · `getAvatar` · `getAvatarsLocal` · `getCalls` · `getContact360` · `getContacts` · `getDailyCounts` · `getDbHealth` · `getDbStatus` · `getDecryptStatus` · `getEmoticonDataUrl` · `getEmoticonDataUrls` · `getEmoticons` · `getExportHistory` · `getExportProgress` · `getFavorites` · `getFileImageDataUrl` · `getFiles` · `getGraph` · `getGroupInfo` · `getGroupInsights` · `getHandoffReminds` · `getImageDataUrl` · `getImageDataUrlsBatch` · `getImageOriginal` · `getKbFileChunks` · `getKbFiles` · `getKbModelConfig` · `getKbs` · `getKbVectorIndex` · `getKnowledgeGraph` · `getLayaStatus` · `getLedger` · `getMediaAssets` · `getMessageFile` · `getMessages` · `getMoments` · `getMomentsAuthors` · `getMomentsInsights` · `getMomentsMonthly` · `getNewMessages` · `getNotes` · `getOfficialAssets` · `getOperationLog` · `getOverview` · `getOverviewInsights` · `getPaymentStatus` · `getPrivacyAuditRows` · `getPrivacyScan` · `getPrivacyState` · `getRecords` · `getRegionMap` · `getRemoteImages` · `getRetrievalStatus` · `getRevoked` · `getSearchIndexStatus` · `getSelfUsername` · `getSessions` · `getSnsImageDataUrl` · `getSnsVideoCoverDataUrl` · `getSnsVideoDataUrl` · `getStorageStats` · `getVideoInfo` · `getVoiceDataUrl` · `getVoiceInfo` · `getVoiceTranscript` · `getWechatConfig` · `getWechatConfigFull` · `getWechatKeysInfo` · `getWhisperStatus` · `getWordCloud` · `installWhisperEngine` · `listBackups` · `listEditedMessages` · `listLlmModels` · `listLlmProviders` · `listRetrievalFeedback` · `listSummaryRecords` · `listSummaryTasks` · `listTasks` · `openConfig` · `openPath` · `optimizeAskQuestion` · `planOriginalFetch` · `previewBackup` · `pruneExportHistory` · `renameKb` · `resetEditedMessage` · `resetRetrievalWeights` · `resolveChatHistory` · `restoreBackup` · `runSummaryTask` · `saveNote` · `saveRetrievalConfig` · `saveSummaryTask` · `saveWechatConfig` · `searchKb` · `searchMembers` · `searchMessages` · `searchUnified` · `setKbFileRag` · `setKbModelConfig` · `setPrivacyState` · `setTaskStatus` · `submitAskFeedback` · `suggestKbLinks` · `suggestReplies` · `summarizeKbFile` · `syncHandoffTasks` · `toggleSummaryTask` · `transcribeVoiceBatch` · `transcribeVoiceMessage` · `unloadLaya` · `upgradeDecodedImages` · `verifyDatabaseKey` · `verifyImageKey`

