# 02 · 运行时性能基线（2026-10-21，本机）

> 目标：给后续每一次优化提供**同机、同数据、同口径、可重复**的前后对比。
> 结论先行；本文所有数字来自 `scripts/perf/perf-baseline.mjs` 的 3 次独立启动（跨样本取中位，
> 噪声带 = min–max）；原始 JSON/日志在 `working/perf/baseline/`（索引见该目录 README）。
> 纪律：产品代码只读、未改 `wechat/config.json`、未跑全量 `npm test`。

## 1. 结论（带数字）

1. **首屏瓶颈在后端初始化，不在渲染**：渲染层 FCP 中位 **164ms**、DCL 42ms、导航可见 **422ms**；
   而后端 ready 中位 **2806ms**，总览数据落定 **3853ms**。即用户看到"有壳"不到半秒，
   "有数据"要等近 4 秒（后端 ready 占总览落定的 ~73%）。
2. **面板切换本身很快**：跨 5 个面板首次访问 P50 **168ms**、P95 **286ms**
   （聊天会话 286ms、朋友圈 241ms、收藏 168ms、通讯录 152ms、文件与存储 152ms）；
   最重的成本不是渲染，而是**数据 IPC + 懒加载 chunk**（通讯录一次切换 40 次业务 IPC、
   文件面板 31 次；朋友圈首内容要 167ms，其余面板 5–10ms 是缓存命中/预取）。
3. **内存大头是渲染进程与后端 worker，而非主进程**：四采样点的中位（峰值）——
   主进程 WS 123→140MB、渲染进程 WS 149→**286MB**、后端 worker WS 145→**375MB**
   （[min–max] 见 §5）、三进程总 WS 600→**928MB**。渲染进程随图片面板+滚动涨 ~137MB，
   是最大的可控项（面板图片 100% 是 `data:` URL，见 §6/§7）。
4. **请求画像**：启动稳定态累计 IPC 26 次（其中 harness 自身状态轮询 3 次，应用启动 IPC ≈23；
   `wechat:call` 11–15 次）；重载一次 19 个本地资源请求 / 1.31MB / p95 1.5ms（`file://` 秒开，
   资源加载不是瓶颈）；渲染层 HTTP(S) 直连 **0** 次（CSP 只信本机）；
   一次通讯录切换会引进 83 个 `data:` 图片"请求"——图片体积/份数比请求数更值得关注。
5. **缓存**：图片解码缓存已全热（`decoded_images` 48,539 文件 / 3.81GiB），浏览期间新增 **0** 文件、
   `wechat-media://` 请求 **0**；HTTP 缓存命中 0（渲染层无 http 请求）。
   query 结果缓存没有精确命中率端点，代理读数：`wechat:call` 快调用（<10ms）占比 **0.60**、
   后端 execution P50 **3ms** / P95 **140ms**（retained 147–165 条），>1s 慢调用日志 0–2 条
   （样本 1 抓到 `getStorageStats` 2253ms/1951ms，均在启动期）。
6. **"空闲 60s"并非空闲**：空闲期 CPU 秒/60s —— 后端 worker **13.9s（23.1% 单核）**、
   GPU **10.6s（17.7%）**、渲染 3.3s（5.4%）、主进程 0.1s；总 WS 中位反而 **下降 160MB**
   （Windows 工作集裁剪，不是释放）。这是"启动后后台同步/预热"的可量化证据。
7. **稳定复现性**：正式运行 3 个样本的启动/切换/内存（除 worker OS WS）噪声带普遍 <12%；
   worker OS WS 呈 145MB/364MB 双峰（与工作集裁剪+同机并发审计有关），详见 §9。

## 2. 环境与方法

| 项 | 值 |
|---|---|
| CPU / RAM | Intel Core i7-14700K（20C/28T，3.4GHz）/ 32GB |
| OS | Windows 10 专业工作站版 19045（x64） |
| Electron / Chrome / Node | 44.3.0 / 152.0.7977.78 / 24.20.0（主进程 runtime） |
| 应用 | 仓库工作树（`release/v1.0.9` 基线 + 在途改动，脏树）；`src/client/ui-dist` 已构建 |
| 数据 | 真实 `wechat-data`（图片解码缓存 48,539 文件/3.81GiB）；**临时 profile**：用 `scripts/real-profile.mjs` 复制真实 `config.json`/`llm.json`，数据根指向应用自己解析出的真实目录 |
| 启动 | `playwright _electron.launch`（同一个 electron.exe/仓库根；等价 `scripts/launch-app.mjs` 的"摘掉 ELECTRON_RUN_AS_NODE"）。差异：需要主进程 `app.evaluate` 通道做 IPC 计数/进程指标/关窗，launch-app 的 detached 子进程给不了 |
| 闸门 | `SUPERTIME_SKIP_ONBOARDING=1`（非打包态才生效，跳过首启三道闸门）；**不设** `SUPERTIME_TEST_MODE`（避免自动化横幅改变 DOM/布局） |
| 采样 | 每样本 = 一次独立启动；官方参数：`--panels=overview,chats,moments,favorites,contacts,files --image-panel=moments --samples=3 --idle-ms=60000 --scroll-rounds=6`；样本间 2s；每样本约 82s |
| 并发 | 采样期同机另有其它角色的探针/vitest 在跑（空闲内存 12.3–12.8GB/31.7GB）→ 噪声带已如实给出；**跨运行只比倍率 + 噪声带** |

采样点（四个）：`startup-stable`（启动稳定态）→ `image-panel`（打开朋友圈后）
→ `after-scroll`（朋友圈批量滚动 6 轮后）→ `after-idle`（空闲 60s 后）。
另有一次"页面重载"（`reload`）专测渲染层资源加载；面板切换在**后端队列排空后**测（见 §10 的闸门）。

## 3. 启动与首屏（中位 [最小–最大]）

| 指标 | 中位 [min–max] | 说明 |
|---|---|---|
| 进程/窗口就绪 | 270 [267–287]ms | `_electron.launch` → firstWindow |
| 导航可见（可点） | **422 [418–442]ms** | 侧栏按钮出现（渲染层 shell 可用） |
| 渲染层 FCP | 164 [164–192]ms | 页面内 `first-contentful-paint` |
| DCL | 42 [38–47]ms | 页面内 `domContentLoadedEventEnd` |
| 后端 ready | **2806 [2797–2883]ms** | `backendState.state === 'ready'`（轮询 250ms） |
| 总览数据落定 | **3853 [3821–4048]ms** | 正文文字稳定 + 无加载措辞 + 无骨架 + 网络静默 600ms |
| 启动后网络静默等待 | 621–1093ms | 落定后仍有图片/数据流，说明"落定"早于"全部资源到位" |

## 4. 面板切换与请求画像（首次访问，中位）

| 面板 | 落定 ms | 首内容 ms | 业务 IPC | 后端 completed | 本地请求 | `data:` 图片请求 | 新增图片 | 图片 e2e P50 |
|---|---|---|---|---|---|---|---|---|
| 聊天会话 | 286 [263–296] | 5 [4–8] | 2 | 2 | 14 | 8 [8–15] | 16 | 0 [0–7]ms |
| 朋友圈 | 241 [222–248] | **167 [153–169]** | 21 | 21 | 2 | 14 [13–15] | 16 | 4 [3–6]ms |
| 收藏与表情 | 168 [165–168] | 10 [10–11] | 4 | 4 | 5 | 7 | 16 | 3ms |
| 通讯录 | 152 [152–153] | 9 [9–10] | **40** | 40 | 6 | **83** | 84 | 15 [15–16]ms |
| 文件与存储 | 152 [151–152] | 10 [10–11] | 31 | 11 [11–12] | 2 | 0 | 0 | — |
| **跨面板** | **P50 168 / P95 286** | — | — | — | — | — | — | — |

- 落定判据：点按钮后 rAF 采样，正文文字连续 8 帧不变 + 无加载措辞/骨架 + 网络静默 350ms。
- `聊天会话`/`收藏` 的"首内容 5–10ms"说明数据已在总览阶段预热过；`朋友圈` 首内容 167ms 是真实冷取。
- **重载（渲染层资源加载）**：19 个 `file://` 请求 / 1,310,448B / P50 1.1ms / P95 1.5ms；
  导航可见等待 102ms、面板落定 801ms；重载期业务 IPC 24 [24–32]、后端 completed 13 [13–21]。
  注意：`data:` 图片请求数 1–228 不稳定（data URL 的 Chromium 内存缓存跨 reload 复用时不再发请求），
  **只把 `file:` 口径当资源加载基线**。

## 5. 内存（四个采样点；主进程=PowerShell `Get-Process`，渲染层=CDP）

| 采样点 | 主进程 WS | 主进程 Private | 渲染 WS | 渲染 JS 堆(CDP) | 后端 worker WS | 三进程总 WS | DOM Nodes |
|---|---|---|---|---|---|---|---|
| 启动稳定态 | 123.4 | 93.4 | 149.4 [148.3–164.8] | 16.9 [16.5–18.3] | 145.0 [142.5–364.3] | 599.6 [595.0–835.8] | 2907 |
| 打开朋友圈后 | 132.9 | 101.7 | 235.3 [219.4–236.9] | 15.7 [14.5–22.7] | 215.1 [211.7–447.9] | 771.4 [751.9–1007.5] | 2566 |
| 批量滚动后 | 140.0 | 110.4 | **286.3 [280.4–289.0]** | 30.6 [29.2–30.9] | 282.8 [222.6–431.9] | 900.8 [843.4–1068.6] | 2732 |
| 空闲 60s 后 | 128.2 | 94.1 | 218.9 [199.9–220.9] | 25.9 [25.3–34.4] | 374.6 [179.7–378.1] | 913.4 [711.1–927.9] | 2581 |

单位 MB；中位 [min–max]。**峰值**：主进程 WS 140.0 / 渲染 WS 286.3 / 后端 worker 374.6
[282.8–447.9] / 总 WS 927.9 [900.8–1068.6] / 渲染 CDP 堆 30.9 [30.6–34.4] / 主进程 Node RSS 139.9。
渲染层 `Performance.getMetrics` 的 layout/task 增量：滚动段 TaskDuration +565ms [559–591]、
LayoutCount +76 [73–78]；其它段见 JSON（`renderer.perfMetrics.deltaSincePrevSnapshot`）。

**空闲 60s 的 CPU（进程累计 CPU 秒/60s，% 为单核百分比）**：
后端 worker 13.9s [5.7–22.5]（23.1% [9.5–37.5]）｜GPU 10.6s [10–11.3]（17.7%）｜
渲染 3.3s [3–4]（5.4%）｜主进程 0.1s（0.2%）。合计约 28s CPU/60s ≈ 0.47 个核。

## 6. 资源加载（渲染层）

- **Resource Timing API 在本仓库恒返回 0 条**（`performance.getEntriesByType('resource')` 在全部
  快照中 = 0）。原因：渲染层 `sandbox: true`（`src/backend/main-window.js:95`）+ `file://` 文档；
  实测连文档自己的 `assets/*.js`、`file://` fetch、`wechat-media://` 图片都不产生 entry。
  → 本 harness 改用 **CDP `Network` 逐请求**（`scripts/perf/lib/cdp-net.mjs`）作为等价量具；
  两者读数都写进 JSON（`page.resourceTiming` vs `network`）。
- 页面外壳：`index-BBsSWpvM.js` 362.7KB + `index-BlIehLSf.css` 247.5KB（`ui-dist/index.html:19-20`）
  在 19 个本地请求 / 1.31MB 里；P95 1.5ms —— **本地资源加载不是瓶颈**。
- 渲染层没有任何 http(s) 请求（CSP `connect-src 'self' data: blob: file:`，`ui-dist/index.html:16`）；
  远程图片/地图都由后端代理成 data URL/JSON。
- 图片：面板 `<img>` **100% 为 `data:` URL**（滚动后 52/52，启动总览 229 张）；
  `wechat-media://` 在本轮面板集合里 0 请求（该链路只出现在聊天图片详情/原图等交互，本 harness 未覆盖）。

## 7. 缓存（能读到的计数与命中比）

| 缓存 | 读数 | 口径/来源 |
|---|---|---|
| 图片解码缓存 `decoded_images` | 48,539 文件 / 3.81GiB（全热）；浏览期间新增 **0** 文件/0B | `decoded-cache-stats.txt` + 每阶段目录增量（`medians.cache.decodedNewFilesTotal=0`） |
| `wechat-media://` 协议请求 | 面板切换+滚动全程 **0** | CDP Network（`byScheme['wechat-media:']`） |
| HTTP 缓存 | `fromDiskCache=0`、`fromMemoryCache=0` | CDP `Network.responseReceived`（渲染层无 http 请求，缓存不适用） |
| query 签名缓存（代理） | `wechat:call` <10ms 占比 **0.60 [0.5–0.6]**；调用 171 [171–191] 次；P50 5ms [5–8]、P95 492ms [480–2416]；后端 execution（retained 147–165 条）P50 3ms、P95 140ms [138–1755]；>1s 慢调用日志 0 [0–2] 条 | 主进程 `ipcMain` 包装 + 后端 `callQueue.stats()`；**无精确命中率端点**（见 §9-3） |
| 后端日志打点（每样本 80s） | `[prewarm]` 1 条、`[wechat-sync]` 5–9 次、`[mem]` 1 条、`mem-warn` 0 | `<临时 profile>/wechat/logs/app.log` 增量解析 |

## 8. 后端基准（`npm run measure:quick`，18 个基准）

- 结果：**18 文件 / 21 用例全部通过，vitest Duration 27.08s（墙钟 27.4s）**，退出码 0。
- 读数摘录（全部 146 行在 `working/perf/baseline/measure-quick.json`，原始在 `measure-quick.log`）：
  | 基准 | 读数 |
  |---|---|
  | N8 vector-build-read（20 万行内存） | 墙钟 9541ms；RSS 78MB → 峰值 184MB（+106MB） |
  | xlsx-stream（流式 vs 攒内存） | RSS 峰值增量 19.2MB vs 221.9MB（**11.5×**） |
  | N15 summary-run-due（串行 vs 有界并发） | 274ms → 151ms（**1.82×**，省 123ms） |
  | MSG-PAGE（分页 无索引 vs 有索引） | limit 20：2.27ms → 0.04ms（**56.1×**）；limit 1000：7.07→0.91ms（7.8×） |
- 复跑命令：`node scripts/perf/measure-quick-capture.mjs --out=working/perf/baseline/measure-quick.json`
  （包装器只追加日志/JSON，跑的是仓库既有 runner）。
- 未跑 `measure:slow`（`export-memory` 801s）—— 按纪律不在基线轮跑；需要时单独安排。

## 9. 测不到 / 测不准（原因与证据）

1. **Resource Timing 聚合（initiatorType/域名）**：API 恒 0（上述 §6），是环境属性不是漏采；
   已用 CDP Network 等价替代。若哪天要恢复原口径，需先去掉渲染层 sandbox 或换 `http(s)` 入口。
2. **后端 worker 的 RSS/heap/external 时间序列**：内存哨兵**实际上只打启动一行** ——
   `src/backend/wechat-worker.js:44` 只传 `log`，`src/backend/worker-mem-sentinel.js:67` 的
   `setIntervalFn` 默认是 `() => 0`（不是真 setInterval）；实测 80s 运行只有 1 条 `[mem]` 行
   （`logs.totals.memSampleCount=1`）。→ 本报告只能用 OS 口径 WS/Private + 启动自报 RSS（66–68MB）。
   另外 OS WS（145–447MB）与自报 RSS（66–68MB）差 2–6×，口径需内存负责人在修哨兵后复核。
3. **query 签名缓存的精确命中率**：worker 内 `resultCache` 没有只读端点
   （`src/backend/ipc-wechat.js:107-116` 的 `wechat:backend-state` 只回 callQueue/rpc/mutation；
   215 个 Remote 方法里没有 cache stats）。§7 的 fastRatio/execution/慢调用日志是**代理指标**。
4. **后端/主进程出网请求数**：CDN 图片等出网发生在 worker 内部，CDP 看不到；渲染层 CSP 禁直连。
   所以"HTTP 请求 0"只代表渲染层，不代表全应用未出网。
5. **图片"请求发起→decode→可见"的请求段**：面板图片 100% data URL，无请求阶段；
   只测到"元素挂载→decode(load)→进入视口" e2e（面板 3–15ms、滚动 8–12ms）。
   `wechat-media://` 图片链路本轮未触发。
6. **浏览器绘制完成/FPS/long task/GPU 显存/heap snapshot** 未采；面板切换"落定"是启发式
   （文字稳定+无骨架+网络静默），不是 Paint timing。heap snapshot 需要额外 HeapProfiler 采集。
7. **空闲 CPU 的百分比是"单核"**：进程累计 CPU 秒 ÷ 墙钟 ×100；整机占比需再除 28 线程。
8. **跨运行噪声**：worker OS WS 双峰（145 vs 364MB）、样本 1 为冷 OS 文件缓存、同机并发审计
   （QA 报告 §2 也记录并发探针污染计时）。结论表已带 min–max；优化前后必须**同机独占**复跑。

## 10. 复跑与前后对比（一行命令）

```bash
# 正式基线（约 4.5 分钟：3 样本 × 82s；建议独占机器、关掉其它探针/vitest）
node scripts/perf/perf-baseline.mjs --samples=3 \
  --panels=overview,chats,moments,favorites,contacts,files --image-panel=moments \
  --idle-ms=60000 --scroll-rounds=6 \
  --out=working/perf/baseline/runtime-baseline.json --tag=<本次改动>
# 后端基准（约 27s）
node scripts/perf/measure-quick-capture.mjs --out=working/perf/baseline/measure-quick.json
```

- 只读 `medians`：每项是 `{median,min,max,spreadRel}`，**对比 median；若差值 < spreadRel 的 1/2，一律判"无差异"**。
- 建议固定的对比清单（改动前/后各跑一遍）：`startup.{navVisibleMs,backendReadyMs,overviewSettledMs}`、
  `panelSwitchAll.{settleP50Ms,settleP95Ms}`、`memory.imagePanel.rendererWorkingSetBytes`、
  `memory.afterScroll.{rendererJsHeapUsedBytes,totalWorkingSetBytes}`、`reload.{fileRequests,fileBytes,fileP95Ms}`、
  `cache.queryProxy.fastCallRatio`、`idle.cpu.backend-worker.avgCorePercent`、`errors.*`。
- harness 自身改动会改变口径：对比时必须固定脚本 revision + 参数；`--repeat-visits=2` 可加测**热缓存切换**
  （第二次访问同一面板的 settle/IPC）。
- 面板切换测前会自动等**后端队列排空**（`waitBackendIdle`，最多 8s；加闸门前 run1 出现过 P95=1517ms
  的离群，见 `runtime-baseline-run1.json`）。同一面板的切换应在同一"队列空闲"前提下对比。

## 11. 给实施阶段的建议（按收益/风险）

1. **首屏：后端 ready 2.8s → 目标 ≤1.5s（收益最大，风险中）**。首屏依赖链是
   "backend init（解密/同步/prewarm）→ 首屏查询 → 总览渲染"；优先把总览必需的查询提前并行、
   把同步/prewarm 里非首屏的部分延后或降优先级（`src/backend/backend-supervisor.js` 启动顺序、
   `src/backend/wechat-host.js` 的 prewarm 调用点）。改完用 §10 对比 `startup.backendReadyMs/overviewSettledMs`。
2. **先修内存哨兵，再谈后端内存（低风险，1 行）**：`wechat-worker.js:44` 补 `setIntervalFn: setInterval`
   （或让 sentinel 默认用真 setInterval），否则 §5/§9-2 的 worker 内存永远只有一行启动读数。
   修完重跑 harness 取重负载（本 harness 已覆盖"滚动/空闲"）时的 `[mem]` 时间序列。
3. **启动重查询：`getStorageStats` 单次 2.0–2.3s（已抓到 >1s 慢调用）**。它出现在启动期且
   让后端队列变长（影响所有面板首取）。做缓存/分片按需（`src/backend/wechat-data/src/query/storage.ts`），
   用 `cache.queryProxy.*` + `panelSwitch.files.*` 验证。
4. **重面板 IPC 批量化**：通讯录 40 次 IPC/84 张图、文件 31 次 —— 按面板一次批量取
   （已有 `getAvatarsLocal`/`getImageDataUrlsBatch` 等批量入口）。目标：每面板 IPC ≤10；
   验证 `panelSwitch.{contacts,files}.ipcCalls` 与 `settleP95Ms` 不回归。
5. **渲染层 data URL 图片改零拷贝**（内存审计已列为 P3）：面板图片全量 base64 造成渲染 WS 峰值
   286MB / CDP 堆峰值 31MB；迁 `wechat-media://` 需资源管线协同（§6 已验证协议可用、当前 0 请求）。
   验证 `memory.afterScroll.rendererWorkingSetBytes` 与 `page.images.schemeByImg`。
6. **空载 GPU 17.7% 单核**：空闲时 GPU 进程每 60s 烧 10–11s CPU，优先排查总览 canvas/地图/词云是否
   持续重绘（对笔记本续航影响大）。收益待定位；用 `idle.cpu.gpu.*` 复测。

## 12. 证据坐标（全部可复跑）

- harness：`scripts/perf/perf-baseline.mjs`（采样主流程 `:203`、快照 `:431`、面板切换 `:639`、
  汇总 `:798`；"测前等后端队列空闲"闸门 `:373`）、`scripts/perf/lib/{instrument,cdp-net,proc,logs,stats,args}.mjs`、
  `scripts/perf/lib/proc-snapshot.ps1`、`scripts/perf/measure-quick-capture.mjs`。
- 原始数据：`working/perf/baseline/runtime-baseline.json`（242KB，含每次快照的进程/渲染/请求/IPC/日志明细）、
  `runtime-baseline-run1.json`（加闸门前对照）、`measure-quick.{json,log}`、`decoded-cache-stats.txt`。
- 关键源码坐标：`src/backend/main-window.js:95`（sandbox）、`src/backend/wechat-worker.js:44` +
  `src/backend/worker-mem-sentinel.js:67`（哨兵不周期）、`src/backend/ipc-wechat.js:107-116`（backend-state 无缓存计数）、
  `src/client/ui-dist/index.html:16/19/20`（CSP 与首屏资源体积）、`src/backend/http-queue.js:62-82`（execution 只保留 256 条）。
