# 04 · 内存热点与泄漏审计（证据版）

- 审计对象：本仓库 `D:\super-time-wechat`（Electron 44 / Node 24.20.0；主进程 + `utilityProcess` 后端 worker + 渲染进程）。
- 姿态：产品代码只读；未读取 `wechat/config.json`；未改 git 状态；未跑全量 `npm test`。
- 可复现测量脚本：`working/perf/memory/measure-one.mjs`（逐结构独立进程测分配增量，输出见 `working/perf/memory/measure-one.out.txt`、`measure-one-2.out.txt`）；后端基线探针：`working/mem-log-probe.mjs`。
- 结论只对"文件:行号 + 源码常量/注释实测值 + 本机同等运行时测量"负责；无法定量的写「待测」。

## 1. 结论（结论先行）

1. **没有发现"经典泄漏"**：排除 `deps/lib/tests/ui-dist` 后 946 个源文件里，未发现模块级 sqlite 句柄常驻、未配对的 IPC/窗口监听器、未清理的后端定时器（详见 §7）；后端每进程缓存都是"故意常驻"，问题集中在**有上界但上界太高 / 只按条数不限字节**。
2. **后端 worker 是内存主战场**：`wechat-worker` 是独立进程，`worker-mem-sentinel.js:26-30` 每 60s 只**记日志**（RSS 阈值 1.2 GB，`wechat-worker.js:44`），**不重启、不回收**；因此本轮所有缓存会一直累到进程退出。
3. **最值得立刻加的 6 处"字节预算"**（都是"条数有界、字节无界"，修改只影响缓存命中率）：`remote-image.ts:100`（实测 300×200KB=**59.2MB**，最坏≈3.2GB）、`sns-keystream.ts:139`（实测 64×1.5MB=**96MB**）、`wechat-host.js:76-78`（实测 300×100KB=**36MB**，上限 185.3MB）、`sns-image.ts:19`（300 条**朋友圈原图 dataURL**，按原图 1–5MB 推算 300MB–1.5GB 上限，待测）、`wordcloud.ts:86+95`（上限 64×20k 词=**95MB**）、`graph-canvas-support.ts:102`（320 头像=**5.2MB**/账号，只增不删）。
4. **两处明确"只增不删"的小缓存**可低成本修：`messages.ts:576 statsCache`（无 delete/clear/max）、`remote-image.ts:87 failUntil`（失败地址永久留）。量级小（<1MB 级），但属于确定性缺陷。
5. **三个"数据规模"常驻项**（数据有界、非泄漏）：`sns-image.ts:292 attachIndex`（源码注释 5 万条路径）本机实测同形结构 **31.4MB**；`sns-image.ts:65 snsImageIndex`（15,220 文件/80 月）**10.6MB**；`sync.ts:807 pageHashCache` 按 147MB 分片实测 **9.2MB**、500MB 则 **31.3MB**。
6. **渲染层最大的两块都是"有意的"**：`image-cache.ts` 48MB 字节上限 + 512 条 + 按会话释放（§6）；`rain-window.tsx:344` 6 张 900×840 canvas ≈ **17.3MB** 固定常驻（仅在看过雨窗后创建，深浅两套）。

## 2. 进程与基线

- 主进程 `src/backend/*.js`（42 个文件）里的模块级可变容器只有：`wechat-host.js:78 resultCache`（已列 §3-3）、`wechat-args-guard.js:162,165`（ledger 上限 512 / 每方法只记第一条 schema 问题）、`wechat-worker.js:49 activeCalls`（每次调用 `finally delete`）、`wechat-paths.js:100 migratedCombos`（迁移标记）；其余是只读常量 Set。
- 后端 worker：`wechat-worker.js:31` `createWechatBackend()` → 所有 `wechat-data` 缓存都在**同一个 worker 进程**里；`backend-rpc.js:191` / `wechat-worker.js:94` 的 RPC 结果走 `postMessage`（结构化克隆），大对象会在这里多一份临时拷贝。
- 现有基线（本机历史日志，`node working/mem-log-probe.mjs`）：worker **RSS 65–70MB / heapUsed 3MB / external 2MB**，`mem-warn=0`（app.log 6 次、app.1 16 次、app.2 60 次采样，均为无负载启动态）。**这不是浏览/导出态基线，重负载数值全部待测。**

## 3. Top 清单（按可回收量级排序；量级=同运行时实测/上限推算）

| # | 位置 | 性质 | 上界/淘汰 | 量级（依据） |
|---|---|---|---|---|
| 1 | `wechat-data/src/query/remote-image.ts:100-119` `memCache` | 条数有界、**字节无界**，LRU | `MAX_MEM_ENTRIES=300`（:100）；单张另有 8MB 取回上限（:36） | 实测 300×200KB dataURL=**59.2MB**；理论最坏 300×8MB×1.33≈**3.2GB** |
| 2 | `wechat-data/src/query/sns-keystream.ts:139,183` `keystreamCache` | 条数有界、**字节无界**；超 64 条整表 clear（尖峰） | 64 条 | 实测 64×1.5MB=**96MB**；64×128KB=8.0MB（封面/只解头路径） |
| 3 | `src/backend/wechat-host.js:76-78,136-147` `resultCache` | 条数+单条有界、**总字节无界**，LRU+定向失效 | 300 条、单条 ≤512KB | 实测 300×100KB=**36MB**；上限 300×512KB=**185.3MB** |
| 4 | `wechat-data/src/query/sns-image.ts:19,709,737,764,841,850` `md5UrlCache` | 条数有界、**字节无界**（存的是解码后的 dataURL） | `boundedSet` 默认 **300 条**（`meta.ts:480`），无字节记账 | 单条=整张朋友圈图 base64；缩略 0.1–0.3MB→300 条 **30–90MB**，原图 1–5MB→**300MB–1.5GB**（待测） |
| 5 | `wechat-data/src/query/wordcloud.ts:86,95,185-189` `shardScanCache` | 条数有界、**字节无界**，FIFO | 64 个分片（注释 :92「每分片几万词条」） | 实测 20k 词=1.5MB / 50k=3.3MB；**上限 64×20k=95MB** |
| 6 | `wechat-data/src/query/sync.ts:807` `pageHashCache` | 随消息库页数线性增长、无上限 | 无（按分片文件数） | 每 4096B 页一个 sha256(32B) Buffer；实测 147MB 分片=**9.2MB**、500MB=**31.3MB** |
| 7 | `wechat-data/src/query/sns-image.ts:292` `attachIndex` | 数据规模索引，有删除清理 | 无条数上限（随 msg/attach 文件数） | 源码注释 5 万路径；同形实测 **31.4MB** |
| 8 | `wechat-data/src/query/sns-image.ts:65` `snsImageIndex` | 数据规模索引，按月增量/删月清理（:183） | 无（随 SNS 图片数） | 源码注释 15,220 文件/80 月；同形实测 **10.6MB** |
| 9 | `wechat-data/src/query/retrieval/embedding.ts:532` `HASH_CACHE`（及 `kb-vectors.ts:286 KB_HASH_CACHE`） | 全量向量粗筛行，按文件指纹缓存 | 每 DB 一份，无条数上限 | HashRow 实测 40k=**4.2MB**、135k=**15.6MB**；N8 台账已定性为"有意的结构性取舍" |
| 10 | `src/client/.../panels/graph-canvas-support.ts:102` `avatarAssets` | 只 set 不 delete（`graph-canvas-host.tsx:551`），跨图共享 | 无 | 320×(url+sprite) 实测 **5.2MB**/账号 |
| 11 | `src/client/.../panels/rain-window.tsx:344` `sceneCache` | 固定大小、只增不删 | 深浅 2 套 ×3 canvas | 900×840×4B×6≈**17.3MB**（CPU 位图；未计 GPU） |
| 12 | `src/client/.../wechat-data/cache.ts:19,56-66` `_snapshotCache` | 条数有界、**字节无界** | 60 条 | 实测 50 条消息/页≈6.7KB；60 页=0.4MB，200 条/页=1.5MB；含 KB 图谱大快照时才显著 |
| 13 | `src/client/.../api-media.ts:493` `remoteImageUrlCache` | **条数+字节双上限**（对照项） | 600 条 / 3M 字符（:459,466） | 与 §9 的 59.2MB 对照：该实现最多约 6MB 字符串，是本仓正确写法 |

## 4. ① 可立即修（明确无界/明确泄漏，低风险）

### ①-1 `remote-image.ts:100` 远程图内存层只有条数上限（字节无界）→ 加字节预算
- 证据：`MAX_MEM_ENTRIES=300`（:100）、`memSet` 只按条数淘汰（:112-119）；单张取回上限 8MB（:36）且 dataURL 是原字节 ×1.33（注释 :96）。
- 回收量级：**现实中 0–59MB**（实测 300×200KB=59.2MB，本机朋友圈/卡片图典型几十~几百 KB）；最坏 3.2GB 仅理论。
- 修法：照 `image-cache.ts:100-115` 记 `totalChars`，加 `MAX_MEM_CHARS ≈ 32MB`；单条 >2MB 不入缓存（或复用 `wechat-host.js:139` 的 512KB 口径）。只影响缓存命中率，不改返回语义。

### ①-2 `sns-keystream.ts:139` 密钥流缓存只按条数、超限整表 clear → 加字节预算/跳过大对象
- 证据：`keystreamCache`（:139）；`decryptSnsAll` 用 `wxIsaac64Keystream(key, buf.length)`（:222），图片整文件加密（注释 :207-209）；淘汰是 `if (size > 64) clear()`（:183）——**一次性释放全部，容易造成 RSS 锯齿**。
- 回收量级：**8–96MB**（实测 64×1.5MB=96MB；只解头路径 64×128KB=8MB）。
- 修法：`n > 1MB` 不入缓存；或加 `MAX_KEYSTREAM_BYTES=16MB` + 逐出最旧（不要 clear 全表）。只影响重复解密 CPU，不改正确性。

### ①-3 `wechat-host.js:76-78` 解码结果缓存：条数+单条有界，总字节无界
- 证据：`RESULT_CACHE_MAX=300`、`RESULT_CACHE_MAX_CHARS=512*1024` 是**单条**上限（:76-77,139），无总量记账；LRU 命中刷新（:127-134）。
- 回收量级：**36–185MB**（实测 300×100KB=36MB、300×512KB=185.3MB；后者是当前代码允许的上限）。
- 修法：加 `RESULT_CACHE_MAX_TOTAL_CHARS≈64MB`，`writeResultCache` 里同时按总字节逐出（连同已有的 300 条/单条 512KB）。既有定向失效（:101-107）不用动。

### ①-4 `sns-image.ts:19` 朋友圈图片 dataURL 缓存：`boundedSet` 只限 300 条、没有字节预算
- 证据：`md5UrlCache`（:19）由默认 `boundedSet(map,key,value)`（`meta.ts:480`，cap=300）写入（:709,737,764,841,850）；值是整张图的 `data:image/…;base64,…`（`dataUrlOf` :568-570）。同一份 dataURL 还要进 `wechat-host.js` 的 `resultCache`（`getSnsImageDataUrl` 在 `CACHEABLE_METHODS` :66）→ **同一张图最多三份**（模块缓存 + 结果缓存 + IPC 克隆）。
- 回收量级：按缩略图 0.1–0.3MB/张 → **30–90MB**；详情页 `allowThumb:false`（原图）1–5MB/张 → 上限 **300MB–1.5GB**（**待测**，需真机采样图片字节分布）。
- 修法：给该 Map 加总字节预算（如 32MB）并按插入序逐出，或单条 >1MB 不入；同族 `sns-video.ts:62 coverCache`、`article-cover.ts:13 coverCache` 也是"300 条无字节"，建议一并按同一工具处理。

### ①-5 `messages.ts:576` `statsCache` 只增不删（无 delete/clear/max）
- 证据：全文件仅 3 处引用：声明 :576、get :594、set :618；无失效路径。
- 回收量级：**<1MB**（key=decryptedDir:table，每会话一条；每条 total+≤10 条 typeStats ≈0.3–0.5KB；600 会话≈0.3MB 实测同量级）。量小但确定性无界。
- 修法：`boundedSet(statsCache, key, ..., 512)`（`meta.ts` 已有工具），或并入 `meta.ts` 的 `METADATA_KEY_FAMILY_LIMITS`。

### ①-6 `remote-image.ts:87` `failUntil` 失败地址永久驻留；`graph-canvas-support.ts:102` `avatarAssets` 只增不删
- `failUntil`：只 `set`（:219,249）+ `get`，无删除/上限；每条 ≈100B，1 万失败地址≈1MB。修法：`boundedSet(..., 500)` + 取用时清过期（已有 `FAIL_COOLDOWN_MS=60s`）。
- `avatarAssets`：`:551 avatarAssets.set(...)`，全文件无 delete/clear；键=username，预算 320/图（`graph-canvas-theme.ts:166-168`），换账号/多图叠加时只增不减。修法：上限 800 LRU 或账号切换时 clear；实测 320≈5.2MB。
- 附带：`src/client/.../ui/kit-foldable.tsx:70` `mq.addEventListener('change')` 在卸载清理（:96-100）里**没有对应 removeEventListener**（全文件 add=1/remove=0）。每次挂载多一个 MQL 监听；是否真泄漏取决于 Chromium 是否复用 MQL，**低风险修法**：cleanup 里 `mq.removeEventListener('change', onMq)`。

## 5. ② 需测量确认（给测量方法；本报告不拍板）

1. **attach/sns 文件索引**（第 7、8 行）：先看 `[sns-trace]` 日志里的 `index=…ms`/`attach-scan`；测量：worker 进程 `process.memoryUsage()`（或 `--inspect` + heap snapshot）在「进入朋友圈并滚动 100 张图」前后各一次 `global.gc()`；对照 §9 实测 31.4+10.6MB。若确认>50MB，可考虑把 `AttachFileMeta.path` 改存相对名/索引号（省一半字符串），或按「最近 N 月」裁剪。
2. **wordcloud 分片词频**（第 5 行）：测量：打开总览词云 → 切 3 个年份 → 每次 `global.gc()` 后 `/heap`；判据是 `shardScanCache.size` 与总词条数（可在 `:189` 临时打印 `shardScanCache` 各 value.counts.size；产品代码只读，用 `--inspect` 求值）。若接近 64×20k 词，建议 `SHARD_CACHE_MAX` 降到 16 或加字节预算（实测 20k 词=1.5MB，按 32MB 预算≈21 分片）。
3. **pageHashCache**（第 6 行）：测量：一次完整 sync 前后 worker `process.memoryUsage().heapUsed/external`（页指纹主要是 Buffer external）；本机 message_1.db 147MB → 9.2MB，按分片总量线性外推（500MB→31.3MB）。若消息库 GB 级，考虑只存「变化页位图 + 每 64 页一块的聚合哈希」。
4. **HASH_CACHE / KB_HASH_CACHE**（第 9 行）：测量：`SELECT COUNT(*) FROM vectors`（embedding 的 N14 已说明 rows 在 meta）再乘 103–118B/行（本节实测 4.2MB/40k、15.6MB/135k）。N8 台账明确「要的产物就是数组」，除非改 mmap/分块，否则只做基线记录。
5. **渲染层 `_snapshotCache`**（第 12 行）：测量：在 `cache.ts:59 snapshotSet` 临时记录 `JSON.stringify(value).length` 总和（dev 分支），或 DevTools heap snapshot 对比「只开聊天」vs「再开知识图谱/联系人」。当前 60 条上限下实测消息页仅 0.4–1.5MB；风险来自 `kb:graph` 全量图谱快照（`api-read.ts:504`）。
6. **IPC 大 payload 峰值**：`sns-video.ts:369` 返回 `data:video/mp4;base64,…`（`toBase64Async` :132-136 分块）→ `wechat-worker.js:94` postMessage → 主进程 `ipc-wechat.js:59-80` 再克隆给渲染层，**同一份视频字节峰值约 3 份**（源 Buffer + base64 字符串 + 克隆）。测量：播放一个大视频时分别抓 worker/主进程/渲染进程 RSS 峰值（任务管理器或 `process.memoryUsage`）。同族：`avatarBudget` 注释（`graph-canvas-theme.ts:155-162`）自述「2000 节点全量头像 ≈20MB 级 IPC 载荷」。修法方向：视频/原图改走已有的 `wechat-media://` 零拷贝通道，而不是 base64 data URL。
7. **keep-alive 常驻 DOM**：`keep-alive.tsx:19,41-57` 保 `chats`/`taskinfo` 两个 ReactNode；测量：渲染进程 heap snapshot，对比「切走页签」前后（`WechatDataPanel.tsx:57` 接入点）。当前 `Chats` 的 `maxItems:600`（`Chats.tsx:268`），DOM 规模有界。
8. **渲染层重复副本**：`chats-support.tsx:197`/`Contacts.tsx:67`/`moments-support.tsx:16`/`settings-common.tsx:29` 四份 avatarCache（上限 300/300/300/100，实测 1000×4KB=5.0MB）+ 后端 `resultCache`/`getAvatarsLocal` 同一头像的多层副本。测量：同一账号打开三个面板后 DevTools heap snapshot 搜 `data:image` 总字节。可去重成一份共享缓存（改动面 4 文件，低风险但非泄漏）。
9. **`rain-window` 固定 17.3MB**：测量：进/出「天气/雨窗」面板前后 Renderer heap。仅当产品愿意为特效付这些内存时才动（可改为只在可见时创建、离开后置空，回收 8.6–17.3MB）。
10. **SNS 图片 dataURL 缓存**（第 4 行）：测量：浏览朋友圈缩略图/详情共 100 张后，worker heap snapshot（或 dev 分支打印 `md5UrlCache` 各 value.length 之和）；先量出「缩略 vs 原图」的真实字节分布，再决定是 32MB 预算还是「单条 >1MB 不缓存」。同法可覆盖 `sns-video.ts:62`/`article-cover.ts:13` 两个 coverCache。

## 6. ③ 不建议动（有意常驻缓存，理由）

- `image-cache.ts:29,37,39,163`：48MB 字节上限 + 512 条 + 单条 8MB + 按会话 `keepOnlyImages`；有 `image-cache-release.spec.ts` 守门。**是目前全仓最正确的一类缓存，勿改小上限**（注释说明原图流量下会挤掉缩略图）。
- `wechat-host.js:76-107`：条数/单条/定向失效三层已就位，本次只建议加"总字节"（①-3），不要改失效策略。
- `meta.ts:60,79-114,492`：`entries` 按族限界（`msg-by-sid:` 200、`contacts:` 96）+ 访问计时 LRU；其余族条数由数据目录决定（几十条），给全局上限反而挤掉最贵的条目（注释 :65-68 已论证）。
- `image-cache`/`thumb-cache.ts`/`media-cache.ts`（IndexedDB 512MB trim）/`wxgf-ffmpeg.ts`（字节上限）/`sns-video.ts:70`（videoUrlCache 64MB 字节上限）—— 都已有淘汰纪律。
- 导出/搜索的历史结论（`docs/RELEASE-PLAN.md:1015` H8、`:893` N8、`:1016` H9）：zip 攒内存 +737.1MB vs 流式 +0；搜索 `.all()` +345.2MB vs `iterate` +13.0MB。**这些已经是修好的形态，不要回退**；`export-memory`（`MEASURE_EXPORT_MEMORY`，slow 801s）可复跑。
- `graph-canvas-host.tsx:432-437`：已修「每开一次图谱多一个 worker」——`disposeLayoutWorker()` 在卸载时调用（注释 P3-13）；`GeoEchartsMap.tsx:291`/`CalendarHeatmap.tsx:113` 都 `dispose()`。不要动。
- 主进程/worker 定时器与监听器见 §7，全部已配对，勿重构成全局清理。

## 7. 监听器 / 定时器 / 句柄 / 流 / AbortController 审计

- **IPC/窗口监听**：`preload.js:58-59,90-91,173-174` 三个 `ipcRenderer.on` 都返回 `removeListener`；`ipcMain` 只有 12 处 `handle` + 4 处 `on`（`browser-handoff.js:252-257` 等），均为 app 生命周期。`browser-handoff.js:257` 的 `ipcMain.on` 在 `dispose()`（:245）里**未摘**，但只注册一次，非泄漏。
- **前端 addEventListener 全仓配对检查**（684 个源文件，排除 dsh/spec）：仅 5 个文件 add>remove，逐个人工核对后：`ui-entry.tsx:128-166` 是 index.html 静态按钮（app 生命周期）；`cache.ts:160` 是模块级数据事件（单例）；`wechat-events.ts` 无 addEventListener（纯映射表）；**只有 `kit-foldable.tsx:70` 是真未配对**（见 ①-6）。`removeAllListeners` 全仓 0 处。
- **定时器**：后端 `gateway-core.ts:304,311` 用 `ctx.effect(() => () => clearInterval(...))` 成对；`http-server.js:717,721` 在 close 时清（:775-776）；`clawbot-auto-reply.ts:1247-1272` `unref()`+`stop()`；`wechat-image-autodownload.ts:269-273` 提供 `clearTimer`；`main-window.js:147-158` 仅在 `SUPERTIME_ELD=1` 下创建且 `unref()`。**后端无泄漏定时器。**
- **sqlite 句柄**：`src/backend` 产品代码（排除 deps/lib/tests/native/spec）共 **110 处 `new DatabaseSync` / 186 处 `.close()`**；核心入口 `db-open.ts:33,84` 的 `withDb/withDbAsync` 统一 `finally close()`，`kb-files-store.ts:168 openStore` 是工厂、调用方（`kb-files-mutate.ts:63…`、`kb-files-register.ts:95…`、`kb-queue.ts:326,334`、`kb-search.ts:196,265`、`entities.ts:189,220`）全部在 `finally` 里 close。按"new>close"粗筛出的 3 个文件逐一核对后都是**注释误报或工厂函数**（`remotes/kb.ts:80`、`message-sort-index.ts:113` 是注释；`kb-files-store.ts:168` 是返回句柄的工厂）。**未发现模块级常驻连接或漏关。**
- **流/句柄**：`http-server.js:487`（`stream.on('error')` + `res.destroy`）、SSE 客户端在 `req.on('close'/'error')` 摘除（:561-562）；`AbortController` 152 处均随请求作用域释放（无模块级 signal）。**未发现泄漏。**
- **Electron 主进程日志**：`diag-log.js:20-23` 磁盘 2MB×3、单行 4000 字符、无内存环形缓冲。

## 8. 重复加载 / 重复解析 / 重复拷贝（已定位的确定项）

1. **图片解码**：`media-image.ts:398,424,509,568` 与 `remote-image.ts:144` 都是 `readFileSync → toString('base64')`；`wechat-host` 的 `resultCache` 只缓存 ≤512KB 结果，**>512KB 的原图每次重挂载都重新读盘+base64**（`wechat-host.js:139`），再经 postMessage/IPC 各克隆一次。
2. **数据 URL 跨进程多份**：worker `remote-image.ts:101 memCache` + 渲染 `api-media.ts:493 remoteImageUrlCache` 同时存同一批 base64（两个上限相加 ≈65MB 级），且每次 IPC 再克隆一份；SNS 图另有 `sns-image.ts:19 md5UrlCache` 与 `wechat-host.js:66` 的 `resultCache` 各存一份（≤512KB 时）。
3. **渲染缓存**：`api-media.ts:431`/`api-cache` 系列 + `cache.ts:403-411 cacheSetIfChanged` 每次 SWR 写回都 `JSON.stringify(整个快照)`（大对象瞬时 2 份），随后 `writeRenderCache`（`cache.ts:209-238`）再 stringify 一次；单条 >1.5MB 会被拒（:170）。
4. **头像**：四份 avatarCache（§5-8）与后端 `getAvatarsLocal` 批量结果重复持有。
5. **图谱**：`Graph.tsx:104-109` 社交/知识两快照各自 `useFreshData` + `buildGraph` 每次挂载重算（CPU 非内存；图谱快照 ≤1.5MB 时还会落 localStorage）。
6. **`sns-video.ts:369` 视频 base64**：源 Buffer → base64 字符串（1.33×）→ postMessage 克隆 → IPC 克隆，峰值 ≈3 份（§5-6）。

## 9. 测量数据（本机 Node 24.20.0，逐项独立进程，`global.gc()` 前后内存差）

| 结构 | 规模 | 实测占用 | 与源码对应 |
|---|---|---|---|
| page hash Buffers | 147MB 分片（37,632 页） | 9.2MB | `sync.ts:807` / `sync-page-diff.ts:39-48` |
| page hash Buffers | 500MB（128,000 页） | 31.3MB | 同上 |
| HashRow[] | 40k / 135k 行 | 4.2MB / 15.6MB | `embedding.ts:532` / N8、N14 |
| SNS 月索引 | 15,220 文件 / 80 月 | 10.6MB | `sns-image.ts:65`（注释 :27） |
| attach 索引 | 50k 路径 | 31.4MB | `sns-image.ts:292`（注释 :268） |
| 词频 Map | 20k / 50k 词 | 1.5MB / 3.3MB；64 分片=95.0MB | `wordcloud.ts:86,95` |
| 密钥流 | 64×1.5MB / 64×128KB | 96.0MB / 8.0MB | `sns-keystream.ts:139` |
| 解码结果缓存 | 300×100KB / 300×512KB | 36.0MB / 185.3MB | `wechat-host.js:76-78` |
| 远程图内存层 | 300×200KB dataURL | 59.2MB | `remote-image.ts:100-119` |
| SNS 图 dataURL 缓存 | 300×(0.1–5MB) | 30–90MB（缩略）/300MB–1.5GB（原图，推算待测） | `sns-image.ts:19` + `meta.ts:480` |
| 头像缓存 | 1000×4KB | 5.0MB | 四处 avatarCache |
| avatarAssets | 320×(url+sprite) | 5.2MB | `graph-canvas-support.ts:102` |
| 快照缓存 | 60×50 条消息 / 60×200 条 | 0.4MB / 1.5MB | `cache.ts:19,56` |
| 雨窗 canvas | 6×(900×840×4B) | 17.3MB（算术） | `rain-window.tsx:263-306,344` |

## 10. 风险与边界

- 上表是**同形结构的分配增量**，不等于线上常驻：String 会被 V8 存成 Latin1/rope，真实 dataURL 多为 ASCII（≈1B/字符），与实测的 base64 样本一致；V8 堆测量有批次噪声，已按"独立进程 + 单次分配"规避。
- 历史日志里的 worker RSS 65–70MB 是**无负载启动态**；重负载（浏览朋友圈、年度导出、向量重建）没有可回看的采样，全部标注"待测"。
- 未评估 GPU 显存（雨窗 WebGL 纹理、ECharts canvas）与 Chromium 自身缓存（localStorage/IndexedDB 走浏览器配额，未计入 JS 堆）。
- 本轮未运行应用、未跑 `npm run measure:quick`（避免与基线负责人重复/抢机器）；建议基线负责人按 §5 的项在同一台机器上补测。

## 11. 给实施阶段的建议（按收益/风险排序）

1. **P0（低风险、可量化）**：①-1 remote-image 字节预算 → ①-2 密钥流字节预算/跳过大对象 → ①-3 resultCache 总字节预算 → ①-4 SNS/封面 dataURL 字节预算。按实测/推算，重负载下可回收 **80–300MB**（四者上限合计 ≈600MB 级）。
2. **P1（低风险）**：①-5 statsCache 加界；①-6 failUntil 加界 + avatarAssets 上限/账号清理 + kit-foldable 摘监听。预估 **5–10MB**，主要是"消除确定性缺陷"。
3. **P2（先测量再动）**：§5-1/2/3（attach/SNS 索引、词云、页指纹）——若基线负责人测出 >50MB，再按"最近 N 月/字节预算/分块哈希"改造，改动面较大，需单独验收。
4. **P3（结构性）**：§5-6 IPC 大 payload 改走 `wechat-media://` 零拷贝（视频/原图），收益是峰值 RSS，不是常驻；需要资源管线负责人协同。
5. **不要做**：缩小 `image-cache.ts` 的 48MB（会回归图片闪烁）；给 `meta.ts` 加全局上限（历史论证过会挤掉最贵的条目）；把 `resultCache` 失效改回整体 clear（历史 M8 已证错误）。

## 12. 需基线负责人配合的测量项（同一台机器、同一运行内前后对比）

1. 重负载 worker 基线：浏览 100 条会话 + 朋友圈滚动 100 图 + 打开年度报告后，`[mem]` 行的 rss/heap/external（当前日志只有启动态）。
2. 用 `--inspect=9229` 抓 worker heap snapshot（`scripts/launch-app.mjs` 支持透传）：分别在"进朋友圈前 / 滚动后 / 打开词云并切 3 个年份后 / 一次完整 sync 后"各一张，按 retained size 对照 §3 的第 1–10 行。
3. 渲染进程 heap snapshot：开 3 个面板（chats/contacts/moments）前后各一张，搜 `data:image` 总字节，验证 §5-8 的四份头像 + 两份远程图缓存。
4. 峰值：播一个 >50MB 朋友圈视频时三进程 RSS 峰值（验证 §5-6 的 3 份拷贝），以及 `avatarBudget=320` 批量头像时的 IPC 峰值（`graph-canvas-theme.ts:161` 自述 3MB）。
5. 复跑既有 benchmark：`npm run measure:quick`（27s）取 `MEASURE_N8`/`MEASURE_M10`/`MEASURE_AVATAR_BATCH` 的 RSS 口径；`MEASURE_EXPORT_MEMORY`（slow，801s）作为导出回归基线。
