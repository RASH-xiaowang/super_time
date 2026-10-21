# 08 · 实施记录（Phase 3）

> 实施分支：`perf/resource-lifecycle-v1`，隔离工作树 `D:\super-time-wechat\.worktrees\perf-v1`
> 基线提交：`70c3ca6`（= `release/v1.0.9` HEAD）。主工作区 132 个在途改动**全程未触碰**。
> 回滚：`git revert <sha>`（单包一提交，互不依赖）。

## 1. 提交清单

| # | sha | 主题 | 包 | 证据/验收 |
|---|---|---|---|---|
| 1 | `5586254` | perf(cache): 后端 4 处缓存补字节预算 + 2 处无界表加界 | A（内存） | 5 spec / 47 用例绿；`build:backend` 与源码一致；`tsc --noEmit` 0 错 |
| 2 | `4e702f2` | fix(perf): 摘掉折叠面板未释放的 MQL 监听 + 清 601.5KiB 死资源 + 远程图分块对齐后端 | B（泄漏/死资源） | 3 spec / 65 用例绿；client tsc 0 错；`build:ui` 成功 |
| 3 | `4d49359` | perf(ui): 首屏 CSS 去掉 83.5KB 无用 Bootstrap Utilities | E1（首屏） | 主 CSS 242KB/3163 条 → 165KB/1921 条，少 1270/多 0，**危险次序 0**；overview-layout 21/21 |
| 4 | `5978d87` | test(perf): 修正折叠面板监听用例的 React 18 act 用法 | B（补） | 该 spec 1/1 绿、client tsc 0 错 |
| 5 | `6786cf0` | fix(perf): 内存哨兵在生产只采一次 —— 把真实定时器接上 | C1（观测） | sentinel spec 9/9（含新增接线守卫） |
| 6 | `3e7b7b7` | perf(media): 图片批量链路复用 hint、fileOnly 零读字节、并发加界（30 张开库 33→3） | D（资源加载速度） | 6 spec / 36 用例绿；`build:backend` 一致；`tsc` 0 错；`measure:quick` 18 文件/21 用例 27.15s（基线 27.08s，无退化）；`npm run typecheck` 全绿 |
| 7 | `70a63a7` | perf(boot): 敏感目录 ACL 已收紧时跳过递归传播（后端 ready 2.9s→0.4s，总览落定 4.0s→1.4s） | F（首屏/启动） | 5 spec / 49 用例绿；typecheck 0；measure:quick 27.20s；boot 分段实测见 §F |
| 8 | `0556d57` | perf(boot): 原图自动下载的启动恢复延后到首屏后（后端组装 320→98ms，总览落定 1.37→1.23s） | G（启动竞态） | autodownload spec 14/14；`check-generated --all` 一致；typecheck 0；3 样本复测见 §G |
| 9 | `140e183` | perf(sqlite): 分析型只读连接临时调大页缓存（storage 434→271ms、ledger 334→161ms） | H（查询提速） | analytics-cache 5/5；ledger 7/7；check-generated `--all` 一致；typecheck 0；measure:quick 27.07s |
| 10 | `2966bdc` | feat(perf): 受控缓存运行时可观测（`[mem]` 行带 当前/上限）+ 运行时内存归因 | I（内存基线） | cache-budget/sentinel/result-cache/autodownload 4 spec 48 用例绿；typecheck 0；check-generated `--all` 一致；measure:quick 26.63s |
| 11 | `e165933` | feat(perf): worker heap snapshot 抓取/归因工具 + `[mem]` 补齐 external/arrayBuffers | J（内存归因） | backend-supervisor 8/8（含 2 条 inspect 门控守卫）、sentinel 12/12；typecheck 0；check-generated `--all` 一致 |
| 12 | `77c441f` | feat(perf): sqlite 连接数进 `[mem]` + 诊断用 node-args/强制 GC 门控（三个内存策略实验） | K（内存实验） | sentinel 15/15、supervisor 9/9、sqlite-stats 3/3；typecheck 0；check-generated `--all` 一致；measure:quick 27.10s |
| 13 | `250d24d` | feat(perf): 首屏查询分段打点 + 两处聚合的跨启动磁盘缓存（条件性命中，附负结果证据） | L（查询提速） | query-trace 3/3、insights-shard-store 6/6、sig-disk-cache 6/6；typecheck 0；check-generated `--all` 一致；measure:quick 27.32s |
| 14 | `f60a350` | perf(query): overview 资源聚合用分析缓存 + insights 朋友圈解析去 split 分配（实测 +2%） | M（查询小优化） | overview/insights 20 用例绿；typecheck 0；check-generated `--all` 一致；measure:quick 27.32s |
| 15 | `b66648c` | perf(storage): file-names 整树扫描跨启动落盘缓存（冷 203ms → 1ms，首个真实命中的跨启动缓存） | N（跨启动缓存） | sig-disk-cache 7/7；typecheck 0；check-generated `--all` 一致；measure:quick 27.93s |
| 16 | `9f267a9` | refactor(perf): 收口验证并修绿两条项目棘轮（单文件 ≤1000 / 单函数 ≤250） | O（收口） | 棘轮/supervisor/media/overview 22 用例绿；typecheck 0；check-generated `--all` 一致；measure:quick 27.38s；全后端 3455 用例仅 1 例环境相关失败（`llm-embed-model`，与本分支无关） |

### A · 后端缓存字节预算（详细）
- 新增 `wechat-data/src/query/cache-budget.ts`：条数 + 总大小 + 单条大小三维上界，LRU 逐出（纯逻辑）。
- `remote-image.ts`：`memCache` → 300 条 / 32MiB / 单条 2MiB 不入；`failUntil` → 500 条且写前清过期。
- `sns-keystream.ts`：64 条 / 16MiB / 单条 4MiB；**删掉「超 64 条整表 clear」**（RSS 锯齿根因），改逐条逐出。
- `sns-image.ts`：朋友圈原图 dataURL 缓存 `md5UrlCache` → 300 条 / 32MiB / 单条 8MiB。
- `wechat-host.js`：`resultCache` 在 300 条 + 单条 512KiB 之上加**总字符 64MiB**；定向失效/LRU 语义不变。
- `messages.ts`：`statsCache` → `boundedSet(…, 512)`。
- 单元内实测（同 run）：远程图 40×1.5MiB 60→31.5MiB；密钥流 20×1.5MiB 30→15MiB；SNS 图 40×1.5MiB 60→31.5MiB；resultCache 129×512KiB 64.5→64MiB（`clearAll()` 后 chars=0）。

### B · 客户端泄漏/死资源/口径
- `kit-foldable.tsx`：cleanup 补 `mq.removeEventListener('change', onMq)`（此前 add=1/remove=0）。
- `graph-canvas-support.ts`：`avatarAssets` 改 800 条有界 LRU（此前只增不删，320 条 ≈5.2MB/账号）。
- 删除 `src/client/ui-app/public/onboarding/bg-stage-{0..3}.webp`（601.5KiB，全仓 0 引用；构建后 `ui-dist` 不再生成）。
- `api-media.ts`：`REMOTE_IMAGE_CHUNK` 40→20，与后端 `MAX_IMAGES_PER_CALL=20` 对齐（此前 >20 张时后半批被整批拒绝并重试）。

### E1 · 首屏 CSS
- 移除 `bootstrap-utilities.min.css`（全仓唯一使用处是 overview 的 `d-flex flex-column gap-2`）。
- 该处改为 `overview.module.css` 的局部类 `.cardStack`（数值与工具类逐字一致：flex / column / .5rem）。
- 栅格（`bootstrap-grid`）保留（`row/col-*` 仍在用），级联顺序说明同步更新。
- 用仓库自带 `scripts/css-bundle-diff.mjs --save/--check` 做穷尽式规则序列对比：**删掉的 1270 条全部是工具类规则，0 条新增、0 处危险次序变化**。

### C1 · 内存哨兵
- 基线实测 80s 运行只有 1 条 `[mem]`：`createMemSentinel` 缺省 `setIntervalFn` 是空函数（单测友好），而 `wechat-worker.js` 只传了 `log`。
- 修法：调用点传真实 `setInterval/clearInterval`；新增**接线守卫**（源码级截块断言两行都在）——单测里的假定时器只能证明逻辑，证明不了调用点。
- 意义：此后 `docs/perf/02-BASELINE.md` §9-2 那条「worker 内存时间序列测不到」才具备修复前提。

### D · 图片批量链路（资源加载速度，Codex 执行 / Lead 复核）
- **D1 hint 复用**：新增 `resolveImageResourceHintsBatch`（md5 + data_index，保留单张解析优先级），批量入口把 hint 透传给 `decodeImageDataUrlAsync`；`resolveImageMd5sBatch` 保留为兼容包装，预热路径不变。
- **D2 fileOnly 零读字节**：命中磁盘缓存时只 `access + stat`，返回 `format/file/thumb`，**不 readFile、不 base64**；`.dat` 解码可跳过 data URL（落盘失败仍按旧行为回退）。
- **D3 有界并发**：批量入口 200 张 `Promise.all` → `mapWithConcurrency(…, 8)`，按索引回填、结果顺序不变（选 8 是为限制大 base64 结果的峰值内存）。
- 守卫测试：`openCounter()` 对 `DatabaseSync.prototype.close` 计数并设上界；断言「批量段里不再出现逐张 `local_id = ?`」；fileOnly 断言 `fs/promises.readFile` 0 次；并发 spec 断言峰值 ≤8 且顺序保持。
- 实测（同 fixture 同 run）：30 张句柄开合 **33 → 3**；第二条对拍用例 **35 → 5**；fileOnly 预热后 `readFile` **0** 次。
- 未改任何 Remote 方法签名/返回字段/错误文案；双槽位（原图/缩略）选择顺序与原图升级语义保持。

### F · 启动分段打点 + 敏感目录 ACL 跳过（第二轮，Codex/Lead）
- **打点**：`SUPERTIME_BOOT_TRACE=1` 门控、默认零开销；时间原点在 worker 任何 require 之前，覆盖 `worker:requires-done → createWechatBackend 各装配段 → 主进程 spawn/init/settings/secrets/ready`。harness 采集并汇总 `[boot-phase]`（`scripts/perf`），后续启动优化按段验收。
- **根因**：`main:secrets-migrated − main:settings-applied` = **2653ms**，占后端 ready 的 87%。`restrictWechatState` 每次启动都对数据根执行 `icacls /inheritance:r /grant:r (OI)(CI)F`，Windows 必须把新的继承 ACE 传播给全部既有子对象 —— 本机 `decoded_images` **48,539 文件 / 3.81GiB**，且 `execFileSync` 阻塞主进程。真正的后端装配只有 318ms（bundle import 39 / typert 47 / gateway 3）。
- **改法**：`restrictWechatState` 先做**只读校验**（`icacls <dir>` 实测 4.8ms，与子对象数无关）：无 `(I)` 继承条目 + 只有一条 ACE 且权限含 `(OI)(CI)(F)` 且主体是当前身份 ⇒ 跳过递归传播；换账号/被改过/目录不存在才重跑；`SUPERTIME_FORCE_ACL=1` 强制完整加固。文件级收紧仍每次执行。判据从严：多一条 ACE 就重跑。
- **安全边界**：目录级 `(OI)(CI)` ACE 会持续继承给新建子对象 ⇒ 一次收紧对之后新建文件仍然生效；任何解析异常一律返回 false（退回完整加固）。
- 实测：该段 2653ms → **120–153ms**；`main:ready` 3047ms → 328ms；harness 3 样本后端 ready **142ms**、总览落定 **1229ms**。

### G · 原图自动下载的启动恢复延后（第二轮，Lead）
- 打点继续拆：`createWechatBackend` 在 `gateway-ctor`(96ms) 之后还有 **217ms** 空档 → 定位 `startWechatImageAutoDownloadOnBoot`：它在 init 路径上同步调用 `deps.findPid()`（PowerShell/CIM 查 Weixin 进程，超时 10s），本机实测 217ms，且主线程同步阻塞。
- 该功能在真实配置里是**开启的**（`wechat_image_autodownload_enabled=true` + marker 存在），所以每次启动都付这笔钱。
- 改法：boot hook 只做「读开关 + 支持性」毫秒级判断；真正的 marker 校验与注入延后 `BOOT_RESUME_DELAY_MS=1200ms`；加取消票据（`stop()`/配置关闭取消，避免停止后被定时器又注入回去）。语义不变：仍在启动阶段自动恢复，30s tick 继续兜底。
- 实测：`backend:assembled` 320ms→**98ms**；`main:ready` 522→**328ms**；3 样本：后端 ready **142ms [1–256]**、总览落定 **1229ms [1133–1271]**、面板切换 P50/P95 **153/251ms**（无退化）。
- 附带：重新生成 `lib/index.js` 与 `lib/types`，补齐 A/D 两包当时只跑 `--backend` 遗留的类型声明欠账（`check-generated-artifacts --all` 现已一致）。

### H · SQLite 分析型连接页缓存 + 存储查询分段打点（第三轮，Lead）
- **量具先行**：给 `computeStorageStats` 加 `SUPERTIME_STORAGE_TRACE=1` 分段打点（默认零开销），配合 harness `--keep-profile` 直接读 app.log。改前分布：**chats 183ms / file-names 122ms / senders 58ms / types 40ms，合计 434ms**。
- **根因**：`sqlite-connection.ts` 的全局读缓存是 **256KB**（为「短读连接不放大 RSS」而定）；`getStorageStats`/`getLedger` 是扫 29MB 资源库并按 `message_id` 随机 JOIN 回 `MessageResourceInfo` 的分析型查询，256KB 反复打穿页缓存。同库 A/B：chats+senders **233ms → 64ms（3.6×）**；档位 4MB 74ms / 8MB 64ms / 16MB 63ms（平台期）。
- **改法**：新增 `raiseAnalyticsCache(db)` —— 只给**当前这条**只读连接 `PRAGMA cache_size`，查询结束连接即关闭，不抬常驻 RSS；默认 8MB，`DSH_WECHAT_ANALYTICS_CACHE_KB` 可覆盖，0/负数=不干预。接在 `storage.ts` 与 `ledger.ts`（分片扫描 + general.db）的连接上。
- 应用内实测（慢调用日志）：`getStorageStats` 676(冷)/434(分段) → **271–273ms**；`getLedger` 334 → **161–163ms**。
- 边界：`getOverview`/`getOverviewInsights` 用**全局 8MB** 实验复测无变化（360/474ms）⇒ 它们不是缓存瓶颈，没有盲目加。

### 第三轮负结果登记（两条，均已回滚，供后人别再试）
1. **首屏查询预热（`prewarmFirstScreenQueries`）**：在 gateway 的 setImmediate 里提前跑 4 个首屏查询、每步让出事件循环。实测**首屏落定 1228 → 1447ms（变差 18%）**：直接调用不走 RPC 队列，预热占着 worker 事件循环，反而让刚挂载的面板请求排在它后面。`getStorageStats` 慢调用虽从 676→166ms，但 `getOverview/Insights` 反而升到 407/514ms。**结论：在这些查询本身没变快之前，预热只是把成本在时间轴上搬家。**已回滚。
2. **敏感文件逐条 `icacls` 合批**：想用一条 `icacls f1 f2 /inheritance:r /grant:r ...` 省掉 6 个进程。实测 icacls **不支持**多路径加选项（exit 87），进入逐文件回退后反而 **129ms vs 112ms**（+17ms）。**结论：icacls 没有可用的合批形态**，保留逐文件（5–10 次 × ~17ms）；真要省只能改为「目录已收紧就跳过文件级显式 ACE」，但那会把「敏感文件显式 ACL」这条既有不变量降级为「靠目录继承」，安全口径变化需单独评审，本轮不做。已回滚。

### I · 受控缓存运行时可观测 + 内存归因（第四轮，Lead）
- **缺口**：objective 的「显著降低运行时内存」此前只有单测证据（缓存字节上限），线上只有 worker 总 RSS，分不清 RSS 是缓存、sqlite 页缓存还是一次性大对象。
- **改法**：`createBoundedCache` 加 `label` + 进程内注册表，新增 `cacheBudgetSnapshot()`（条数/字节/上限）；三个受控缓存打 label（`remote-image` / `sns-image` / `sns-keystream`）；`wechat-host` 新增 `cacheStatsLine()`（含 `resultCache`，字符数×2 估字节并注明口径）；worker 哨兵新增 `extra` 注入，把 `caches=…` 拼到既有 `[mem]` **同一行**（便于对时间序列，`extra` 抛错不影响采样）；harness 的 LogTail 解析 `caches=` 存进 `memSamples`。
- **实测**（1 样本：overview→moments→contacts + 3 轮滚动 + 60s 空闲）：`remote-image=0.4MB/32MB`、`sns-image=0.0MB/32MB`、`sns-keystream=0.0MB/16MB`、`resultCache=5.8MB/128MB` ⇒ **受控缓存合计 ≈6MB，远低于 208MB 上限**；worker RSS 启动 68MB → 空闲 60s **449MB**（WS 357MB）。
- **归因结论（重要）**：worker RSS 的增长**不来自这些受控缓存** —— 典型负载下它们几乎不占内存，缓存上限的价值是保护最坏情况（例如 300 条 512KB 的 resultCache、1.5GB 的 md5UrlCache 理论最坏）。要解释 357–449MB 必须做 heap snapshot（指向 sqlite 页缓存/V8/大 buffer），这是下一轮的量具。

### J · worker heap snapshot 抓取/归因（第五轮，Lead）
- **问题**：第四轮已排除受控缓存（≈6–19MB），但 133MB V8 heap 与 343–449MB RSS 之间那 ~200MB 是什么，没有证据。
- **工具**：① `backend-supervisor` 仅在**未打包 + `SUPERTIME_BACKEND_INSPECT=1`** 时给 worker 加 `--inspect=127.0.0.1:<port>`（打包态一律不开，2 条守卫钉住）；② `scripts/perf/worker-heap.mjs` 用 Playwright 起应用（真实数据根 + 临时 profile），CDP `HeapProfiler.takeHeapSnapshot` 抓「启动后 15s / 再等 45s」两张 gzip 快照；③ `scripts/perf/analyze-heap.mjs` 按 `self_size` 聚合类型/名字排行 + 大字符串盘点；④ `[mem]` 增补 `arrayBuffers=`，harness 解析 `heapTotal/external/arrayBuffers`。
- **轻载结果**（启动+总览，空闲 60s）：heap self_size **47.9→48.2MB（+0.3MB，无泄漏迹象）**；构成 `string 21.7MB(45%) / object 6.6 / code 5.6 / array 5.5 / closure 3.3`；最大单条 3.3MB 字符串 = **bundle 自身 ESM 源文本**（含中文注释按 2 字节存），属 V8 正常保留，不是重复拷贝（bundle 里 `sourceMappingURL` 为 0）。
- **重载结果**（总览→朋友圈→通讯录→文件 + 6 轮滚动 + 60s 空闲）：**RSS 343MB = V8 heapUsed 133 + external 53 + 原生/代码等 ~157**；`heapTotal 175`（空余 42）、`arrayBuffers 0MB`（⇒ 53MB external 不是 Buffer，更像 node:sqlite 的堆外内存）；受控缓存合计 **18.9MB**。
- **归因结论**：缓存不是 RSS 主因；V8 heap（133MB，含 175MB 预留）与 sqlite 堆外（53MB）才是大头，剩余为原生/代码页。下一步应做**策略实验**而不是继续改缓存：`--max-old-space-size` 收 heapTotal、sqlite 连接/页缓存上限、以及重载后 GC 行为（本 run 空闲 60s 内 heapUsed 未回落，需确认是缓存保留还是 V8 未回收）。

### K · 内存策略实验：连接数 / 堆上限 / 强制 GC（第六轮，Lead）
- **仪表**：`sqlite-connection` 记录当前打开/峰值连接数（每连接一份页缓存），经 bundle 导出并拼进 `[mem]` 的 `sqlite=open/peak`；`backend-supervisor` 新增 `SUPERTIME_BACKEND_NODE_ARGS`（**仅未打包**透传，打包态忽略）；worker 哨兵新增 `SUPERTIME_MEM_GC=1` + `--expose-gc` 时采样前强制 GC（诊断用）。
- **实验 1 · sqlite 连接泄漏假设 ⇒ 证伪**：重载空闲时 `sqlite=0/4`（峰值 4）⇒ external 53–54MB 与连接数无关。
- **实验 2 · `--max-old-space-size=192` ⇒ 负结果**：heapUsed 138→116，但 external 54→92、RSS 415→**532**（GC 更频繁、碎片变多），面板 P95 出现 1818ms 离群 ⇒ 不作为默认。
- **实验 3 · 强制 GC ⇒ 单样本更差**：RSS 415→521、heapUsed 138→204、external 54→156 ⇒ GC 碎片与负载波动叠加，不能作线上策略；工具保留（多次采样 + 固定负载才可下结论）。
- **结论**：内存主体是 V8 保留量 + `node:sqlite` 堆外 + 原生/代码页，**既不是缓存也不是连接泄漏**。不动业务查询路径时没有低风险削减手段；本轮把「可观测 + 可实验」补齐，并明确记录已知边界。

### L · 首屏查询分段打点 + 跨启动磁盘缓存（第七轮，Lead）
- **量具**：新增 `query-trace`（`SUPERTIME_QUERY_TRACE=1` 门控、默认零日志、打点失败不影响查询），覆盖 `overview` / `insights` / `extras` 各主要阶段；隔离实测（无并发、真实数据根）：
  * `overview` 冷 **98ms** = contacts 23 / counts 2 / revoked 7 / **resource 41** / sns 24
  * `insights` 冷 **370–391ms** = contacts 5 / **shards 191–208（239 张 Msg 表 GROUP BY）** / contact-rows 3 / **moments 44–46** / **extras 109（extras.shards 104 又一次全表扫描）** / assets 8 / db-walk 1
- **缓存**：新增 `sig-disk-cache`（签名+值，原子写、损坏/缺失退化、8MB 上限）与 `insights-shard-store`（分片聚合缓存），把 overview 结果 / overviewExtras 结果 / insights 分片聚合落到 `<数据根>/cache/*.v1.json`；命中判断仍逐字比对签名（数据一变立即失效）。
- **隔离验证**（两个独立进程、无写入）：`insights` **370→83ms（4.5×）**（shards 208→20、extras 109→disk-hit 0），`overview` 98→<1ms。
- **负结果证据**：真实应用连续两次启动（harness 2 样本、同一数据根）仍全冷（sample2 `getOverviewInsights` 448ms / `getOverview` 345ms）。原因：`fileSig` 含 mtimeNs+size+SQLite change counter+WAL，而应用启动的 **WAL checkpoint 会自增 change counter** ⇒ 每次启动签名都变。缓存文件确实写出（insights 49KB / extras 3.8KB / overview 3KB），miss 成本仅一次 fs 读（≈1–2ms）。
- **结论**：跨启动缓存是**条件性**优化（只有无同步写入的窗口才命中）；要稳定吃满收益需换「内容稳定」版本键（如 sync-state 指纹），须先验证失效语义，本轮不做。

### M · insights 分片扫描页缓存实验 + 两个小优化（第八轮，Lead）
- **假设验证（负结果）**：insights 冷 370ms 里 191ms 是 374 张 Msg 表各一次 GROUP BY，怀疑同样被 256KB 页缓存拖累（storage 的 JOIN 查询曾 3.6×）。同口径微基准（同一批真实查询/同一批库文件）：
  `256KB→196.3ms / 4MB→205.6 / 8MB→200.4 / 16MB→208.5` ⇒ **页缓存对顺序 GROUP BY 扫描基本无影响**，该假设证伪，分片扫描路径不动（避免为错误假设改代码）。
- **保留的小优化**：① overview 的 resource 聚合连接加 `raiseAnalyticsCache`（29MB 资源库 GROUP BY，与 getStorageStats 同口径）；② insights 朋友圈解析的 `split().length-1` / `match(regex)` 换成 `countSubstr`（indexOf 循环），只去临时数组分配。
- **隔离实测**：`overview` 98.3→96.4ms；`insights` 369.9→361.6ms（**+2%**）。明确不宣称更大收益：moments 段仍以字符串扫描为主（44–47ms）。

### N · file-names 整树扫描的跨启动落盘缓存（第九轮，Lead）
- **为什么换目标**：第七轮的磁盘缓存因 `fileSig` 含 SQLite change counter（启动 WAL checkpoint 会自增）在真实启动中必然 miss。本轮选**签名不依赖 SQLite** 的目标：`getStorageStats` 里 `msg/file` 名称树的逐文件 stat（上万个文件）。
- **可命中原理**：该签名 = `msg/file` 各月份目录 mtime/size，启动 checkpoint 只改库文件、不碰这棵树 ⇒ 数据没新增文件时连续启动签名稳定。
- **实现**：`loadFileNamesBySize` 加一层 `sig-disk-cache`（`<数据根>/cache/file-names.v1.json`，原子写/损坏退化/签名逐字比对；进程内 10s TTL 与磁盘层互不放大陈旧窗口）+ 源码级接线守卫。
- **实测**（harness 2 样本、同一数据根、`SUPERTIME_STORAGE_TRACE=1`）：sample1 file-names 段 108→311ms（**203ms**，n=2844）；sample2 108→109ms（**~1ms**，n=2844）⇒ **首个真实命中的跨启动缓存，重复启动省 ~200ms**（getStorageStats 约 −40%）。
- 剩余大头：large-files 段 91ms（100 条大文件逐条 `resolveFileTitle`，冷 OS 缓存）。

### O · 收口验证与两条项目棘轮（第十轮，Lead）
- **全后端套件**（`src/backend/tests` + `src/backend/wechat-data/tests`，3455 用例）：**3420 通过 / 34 跳过 / 1 失败**。唯一失败 `llm-embed-model`（"什么都没配 ⇒ 名字为空串"）与本次 25 个提交无关：该链路 `git log 70c3ca6..HEAD` 为空、隔离运行同样失败、移走工作树本地 `wechat/llm.json` 仍失败 ⇒ 宿主环境注入的 LLM 配置导致，需干净环境复验（已记入已知环境项）。
- **修绿两条项目棘轮**（否则分支不可合并）：
  * `m21-file-size-ratchet`：`scripts/perf/perf-baseline.mjs` 1096 行 → 拆出 `scripts/perf/lib/report.mjs`（extractMetrics/aggregateSamples/printSummary）→ **811 行**；另删除工作树里**误拷贝的 `scripts/perf/perf/` 整份副本**（未跟踪文件，被棘轮按 scripts 全树扫到）。
  * `function-size-ratchet`：`createBackendSupervisor` 286 → **241 行**（`spawn` 实现在模块级 `spawnWorkerProcess(ctx)`，闭包依赖显式传入）；`computeOverviewInsights` 263 → ~225 行（朋友圈扫描抽成 `scanMomentsStats`，并按其规则删除棘轮清单里的 252 条目）；`remotes/media.ts` 1006 → **982 行**（`IMAGE_BATCH_CONCURRENCY`/`mapWithConcurrency` 拆到 `query/concurrency.ts`，re-export 保持外部用法不变）。
- 证明：改动全是搬运（无行为变更）；棘轮 + supervisor + media/overview 相关 **22 用例绿**；typecheck 0；check-generated `--all` 一致；measure:quick 27.38s。

## 2. 已评估但**本轮未做**（附理由，避免被误读成遗漏）

| 项 | 证据/收益 | 为什么不做 |
|---|---|---|
| 新增 `getVideoInfosBatch` / `getVoiceInfosBatch`（refactor T4、resource #11/#12） | 20 条视频/语音：20→1 RPC | **新增 Remote 方法属对外契约增面**，与「不改契约」冲突；需单独立项（`docs/API.md`/契约测试同步） |
| 热力图 `LazyMount`（resource #4） | Overview 首开不拉 441.6KB echarts | 热力卡在首屏可视区内，IntersectionObserver 会立即触发；占位文案可能造成「加载中」闪烁，且基线「落定」判据会把占位算作未落定 ⇒ 指标可能反向。需先真机截图/时序验证再定 |
| `decoded_images` + `voices` 磁盘预算/淘汰（resource #8） | 磁盘占用可预测 | 属**磁盘**治理，不改运行时内存/首屏；淘汰后需重新解码（13ms/语音、图片一次解码），需单独开关与回滚设计 |
| `queryStorageStats` 跨重启磁盘缓存 | 冷启动单次 2.25s（基线慢调用日志） | 已有签名缓存（`cachedBySigAsync`），冷算才是 2.25s；落盘缓存需处理签名口径（当前 sig 未含 contacts 库，见 `storage.ts:152-162` 注释与代码不一致）→ 先修口径再谈持久化 |
| data URL 图片全面迁 `wechat-media://`（baseline §11-5） | 渲染 WS 峰值 286MB | 面板图片是**已解码位图**占大头（CDP JS 堆仅 31MB，base64 字符串不是主因）；原型面广（moments/contacts/favorites/头像各自取数链），需先做 heap snapshot 归因 |
| `React.memo`（refactor T7） | 未定量 | 报告明确要求「先 Profiler 采样再决定」，本轮无采样 |
| 四份 avatarCache 合并（memory §5-8） | ≈5MB | 改动面 4 文件、收益小，排后 |
| `worker_threads` 搬解码/索引 | — | 项目已实测 Electron 主进程 `new Worker` 抛 `Cannot transfer object of unsupported type`（`kb/parse-pdf.ts:12-13`）；正解是既有 `yieldToLoop` |

## 3. 已知基线红（**不是本轮引入**）
- `npm run ui:smoke`：45/47，2 项失败（SessionAsk 空态文案、朋友圈面板 desc）。已在**纯净 HEAD `70c3ca6`** 的独立 worktree 复跑，同样 2 项失败 → 既有基线。
- qa 记录的 `test:affected` 15 个失败 spec / `ui:loading-e2e` 2/10 / `ui:nav-e2e` 5/28：来自主工作区在途脏树 + 并发探针，与本分支无关（本分支从干净 HEAD 拉出）。

## 4. 改动范围与风险
- 只改 11 个产品文件 + 6 个测试文件；未新增依赖、未改任何 Remote 方法签名/返回字段/错误文案。
- 风险最高的是 A 的缓存上限：只影响命中率，理论上可能让「长时间不看的图」重新读盘/解码一次；上限按实测典型批的 8 倍以上设定，且既有 spec 覆盖回归。
- 逐包回滚命令：`git revert 6786cf0 4d49359 4e702f2 5586254`（或按需单个）。
