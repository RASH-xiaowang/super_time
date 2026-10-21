# 09 · 结果总账（Phase 4）

> 口径：同一台机器（i7-14700K / 32GB / Win10 19045 / Electron 44.3.0 / Node 24.20.0），
> 每组 3 次独立启动取中位，同一 harness（`scripts/perf/perf-baseline.mjs`）、同一参数、同一临时 profile。
> **三方对比**：`orig` = 优化前基线（`docs/perf/02-BASELINE.md`，采集时有其他探针并发）；
> `control` = 纯净 HEAD `70c3ca6` 在同时间窗重跑（用于剥离运行顺序/环境漂移）；
> `after` = 优化分支 `perf/resource-lifecycle-v1`。
> 判定规则沿用基线：差值 < 噪声带（spread 的 1/2，且 ≥2%）判「无差异」；只有 `control` 不变而 `after` 变，才判「可归因」。

## 1. 可归因的收益（control 未变，after 变）

| 指标 | orig | control（纯净 HEAD） | after（优化分支） | 归因 | 证据 |
|---|---|---|---|---|---|
| **后端 ready（3 样本中位）** | 2806ms | 2910ms | **142ms**（[1–256]，部分样本低于采集下限） | **−95%（20×）**：ACL 递归传播与自动下载恢复两笔启动阻塞被移除 | 对照组精确复现 2.9s；boot 分段打点见下两行 |
| **总览数据落定（3 样本中位）** | 3853ms | 3977ms | **1229ms**（[1133–1271]） | **−69%（3.2×）**：随后端 ready 前移；渲染/首屏资源同轮无退化 | 同 harness 同参数；`reload.fileBytes` 仍为优化后的 1,231,887B |
| `main:secrets-migrated` 段（boot 打点） | — | 2653ms（ACL 全树重写） | **120–153ms** | ACL 已收紧时跳过递归传播 | `SUPERTIME_BOOT_TRACE=1` 分段；`secure-fs-acl-verify.spec.ts` 11 条判据 |
| `createWechatBackend` 装配段（boot 打点） | — | 320ms | **98ms** | 自动下载恢复延后到首屏后 | `wechat-image-autodownload.spec.ts` 新增 3 条（不同步找进程/到点恢复/取消后不注入） |
| `getStorageStats` 慢调用（首屏最贵的单个查询） | 676ms（冷）/ 434ms（分段实测） | 同代码路径 434ms | **271–273ms** | **−37%**：分析型连接页缓存 256KB→8MB | `[storage-trace]` 分段（chats 183→43 / senders 58→28 / file-names 122 不变）+ 同库只读 A/B（chats+senders **233→64ms，3.6×**） |
| `getLedger` 慢调用 | 334ms | 334ms | **161–163ms** | **−52%**：同一缓存策略接到分片扫描 + general.db | 慢调用日志同 run 对照；全局 8MB 实验先证实「该查询对缓存敏感、overview/insights 不敏感」 |
| 重载本地资源字节 | 1,310,448 B | 1,309,967 B | **1,231,887 B** | **−78,080 B（−6.0%）**：首屏主 CSS 242→165KB | `scripts/css-bundle-diff.mjs` 规则序列对比：少 1270 条（全部工具类）/多 0 条/危险次序 0 处 |
| 通讯录面板业务 IPC | 40 | 40 | **18** | **−55%**：远程图分块 40→20 与后端上限对齐后，不再有「半批被整批拒绝 + 重试」 | 同轮 `newImages=84`、`dataImages=83` 两者不变 ⇒ 图一张没少，只是不再白跑来回 |
| 图片批量链路·30 张的 sqlite 句柄开合 | 33 次 | 33 次 | **3 次** | **−91%（11×）**：批量入口一次解析 hint 并透传，不再逐张开分片库；第二条对拍用例 35→5 | `gateway-image-batch.spec.ts` 的 `openCounter()`（数 `DatabaseSync.prototype.close`）设上界 + 断言「批量段不再出现逐张 `local_id = ?`」 |
| 图片批量·fileOnly 的字节读取 | 每张 readFile + base64（结果随后被网关删掉） | 同 | **readFile 0 次** | 白算归零（原图 base64 是文件 1.33×） | 该 spec 断言 `fs/promises.readFile` 调用数 = 0，且返回字段与普通结果剥 `url` 后逐字段相等 |
| 图片批量·并发 | 200 张 `Promise.all` 无界 | 同 | **峰值 8** | 峰值内存有界 | `image-batch-concurrency.spec.ts`：峰值 ≤8 且结果顺序与输入一致 |
| 后端基准 `measure:quick` | 18 文件/21 用例 27.08s | — | **18/21，27.15s** | 无退化（+0.3%） | 同参数复跑 |
| 主 CSS 规则数 | 3163 条 | 3163 条 | **1921 条** | −39%（−1242 条） | 同上 |
| 随包死资源 | 601.5 KiB | 601.5 KiB | **0** | 删除 4 张 0 引用 webp | `git rm` + `build:ui` 后 `ui-dist/onboarding/` 不再生成 |
| 折叠面板 MQL 监听 | add=1/remove=0 | 同 | **add=1/remove=1** | 每次挂载不再漏一个监听 | `kit-foldable.spec.ts`（渲染卸载后断言 `removeEventListener` 被调用） |
| `avatarAssets` 上限 | 无上限（320 条≈5.2MB/账号，只增不删） | 同 | **800 条 LRU** | 有界 | `graph-canvas.spec.ts` 灌 900 条断言 ≤800 且最早键被逐出 |
| 后端 4 处缓存字节上界 | 条数有界、字节无界（理论上限 341MB；典型 191MB） | 同 | **32+16+32+64=144MB 硬上界** | 缓存最坏情况可回收 ≈50–197MB | `cache-budget.spec.ts` 等 5 spec/47 用例；同 run 实测：远程图 60→31.5MiB、密钥流 30→15MiB、SNS 图 60→31.5MiB、resultCache 64.5→64MiB |
| `statsCache` / `failUntil` | 无界 | 同 | **512 / 500 条** | 确定性无界缺陷消除 | 同上（`boundedSet` 语义已有单测） |
| 内存哨兵 | **只采样 1 次**（80s 运行 1 条 `[mem]`） | 同 | 每 60s 一条 | 观测能力修复 | 新增接线守卫（源码级）；`worker-mem-sentinel.spec.ts` 9/9 |

## 2. 无可归因差异（control 与 after 同向，或均落在噪声带）

| 指标 | orig | control | after | 结论 |
|---|---|---|---|---|
| 导航可见 | 422ms | 460ms | 408ms | 运行顺序/环境主导；**无显著变化**（窗口壳层路径未改） |
| FCP | 164ms | 188ms | 172ms | 同上；**无显著变化** |
| 总览数据落定（第三轮复测） | 3853ms | 3977ms | 1229ms（第二轮）/ **1282ms**（第三轮单样本） | 第二轮收益保留；第三轮把两个查询各砍 37%/52% 后**该指标不再变化**——它的判据里含**固定 600ms「网络静默」窗口**，查询链已低于该窗口，继续砍查询不会体现在这个数上（真实体验改善见 §1 查询级） |
| 面板切换 P50 / P95 | 168 / 286ms | 154 / 281ms | 153 / 251ms | P50 的差异在 control 上同样出现 ⇒ 环境；P95 在噪声内 |
| 渲染 WS（滚动后，中位） | 286.3MB | 290.0MB | 303.9MB（第一轮） | 逐样本 orig 280/286/289、control 269/290/304、after 304/309/291 ⇒ **区间重叠，判无差异**；此前单跑看起来的 +6% 被 control 复现 |
| 渲染 JS 堆 | 30.6MB | 30.6MB | 30.8MB | 无差异 |
| 后端 worker WS | 282.8MB | 467.9MB | 383.0MB | **该指标不可用于跨运行对比**：orig 432/283/223、control 468/367/511、after 503/383/360（基线报告已记 145/364 双峰）。要量化缓存收益须用 heap snapshot 或更长重负载，见 §4 |
| 总 WS | 900.8MB | 1082.0MB | 1042.6MB | 由 worker WS 抖动主导 ⇒ 无结论 |
| 慢调用日志 | 0 | 0 | 0 | 无差异 |

## 3. 明确标注为「测量假象 / 不可归因」的读数
- **空闲 GPU CPU 0%**：after 三个样本 `gpu.cpuSeconds` 为 0 / 0.02 / 12.42 —— 前两个样本**没有匹配到 GPU 进程**（采集缺失），不是真的 0%。因此「GPU 空闲 CPU 从 17.7% 降到 0」**不成立**，不得对外引用。
- **空闲 worker CPU 下降（17.3%→5.2%，中位）**：after 三个样本 8.77/3.14/1.14s 全低于 control 中位，方向一致但 orig 也有 5.7s 的低值；机器负载与后台同步节奏不同步 ⇒ 记为「**方向性信号，未达可归因证据**」。
- **contacts IPC 40→18** 是本次最干净的性能归因（control 精确复现 40，after 三次全 18），但它是**修复重试浪费**带来的，不是「新算法更快」。
- **第三轮两条负结果**（均已回滚、登记在 `08-IMPLEMENTATION-LOG.md` §「第三轮负结果登记」）：① 首屏查询预热让落定 1228→1447ms（直接调用抢事件循环）；② `icacls` 多文件合批语法不存在（exit 87），回退后反而 +17ms。**不要重试这两条。**

## 4. 下一步该用什么量具/还能往哪优化（本轮未做）
1. **worker 内存**：已完成归因与策略实验（§4.6/§4.7）：缓存 18.9MB、连接 ≤4、`--max-old-space-size` 与强制 GC 都是负结果。内存主体是 V8 heapTotal + sqlite 堆外 + 原生页；再往下只能做「减少大对象分配/复用 Buffer」级别的重构，需单独立项评估收益/风险。
2. **渲染图片内存**：`data:` 图片占大头的是**已解码位图**（CDP JS 堆只有 31MB），迁 `wechat-media://` 前必须先做 heap snapshot 归因，否则可能只是把 base64 换成文件路径而位图内存不变。
3. **启动剩余 ~311ms**（boot 打点口径）：worker requires 5 / bundle import 39 / typert 47 / gateway 3 / 后端装配其余 ~4 / 主进程 init 回程 ~30 / 设置回灌 ~44 / ACL 校验+文件收紧 ~136 / 其余 ~3。可做的：`getStorageStats` 的 file-names 遍历 122ms（需持久化或改索引方式）、typert schema 按需加载（47ms，但会短暂降低入参校验覆盖）、ACL 文件级（安全口径需评审）。
4. **首屏两查询已分段（§4.8）**：`insights` 冷 370ms 最大头是 shards 191（239 表 GROUP BY）与 extras 109；`overview` 冷 98ms 最大头 resource 41。下一步：① 换「内容稳定」版本键（sync-state 指纹）让磁盘缓存真正命中；② moments 44ms 的 XML 解析改 `indexOf` 计数（去 split 数组分配）；③ overview resource 连接加 `raiseAnalyticsCache`。
5. **启动剩余 ~311ms**（boot 打点口径）：worker requires 5 / bundle import 39 / typert 47 / gateway 3 / 后端装配其余 ~4 / 主进程 init 回程 ~30 / 设置回灌 ~44 / ACL 校验+文件收紧 ~136 / 其余 ~3。可做的：`getStorageStats` 的 file-names 遍历 122ms（需持久化或改索引方式）、typert schema 按需加载（47ms，但会短暂降低入参校验覆盖）、ACL 文件级（安全口径需评审）。
6. **首屏落定已到判据下限**（600ms 静默窗口）；要再降真实体感，应换指标（首卡片可读时间/可交互）。
7. **首屏 CSS 剩余体积**：Bootstrap Grid 50.6KB 仍全量（只有总览/RegionBoard 用 `row/col-*`），迁到局部 CSS grid 需先做 `css:bundle-diff` + 面板截图验收。
8. **内存 WS 量化**：已归因（§4.6/§4.7），剩余只能做「减少大对象分配/复用 Buffer」级重构。

## 4.5 运行时内存基线：受控缓存占用（第四轮新增量具）

`[mem]` 行现在同时带每个受控缓存的**当前/上限**（`caches=label=当前/上限,…`），不再只有总 RSS。

| 缓存 | 实测占用（1 样本：总览→朋友圈→通讯录 + 3 轮滚动 + 60s 空闲） | 上限 |
|---|---|---|
| `remote-image` | 0.4MB | 32MB |
| `sns-image` | 0.0MB | 32MB |
| `sns-keystream` | 0.0MB | 16MB |
| `resultCache`（host） | 5.8MB（字符×2 估字节） | 128MB（64M 字符） |
| **合计** | **≈6.2MB** | **208MB** |

同时段 worker `[mem]`：启动 RSS 68MB → 空闲 60s 后 **449MB**（进程 WS 357MB）。

**归因**：受控缓存只占 ~6MB ⇒ **worker RSS 的增长不来自这些缓存**。缓存字节上限的价值是
保护**最坏情况**（审计里的 300×512KB resultCache、1.5GB 级 md5UrlCache 理论最坏），
不是解释稳态 RSS；解释后者需要 worker heap snapshot（sqlite 页缓存 / V8 / 大 buffer）。

## 4.6 运行时内存归因：V8 heap snapshot（第五轮新增量具）

| 场景 | RSS / WS | V8 heapUsed | heapTotal | external | arrayBuffers | 受控缓存 | 结论 |
|---|---|---|---|---|---|---|---|
| 轻载（启动+总览，空闲 60s） | RSS 149MB | 42MB | 44MB | 7MB | 0MB | ≈0MB | heap self_size 47.9→48.2MB（+0.3MB）⇒ **无泄漏迹象** |
| 重载（总览→朋友圈→通讯录→文件 + 6 轮滚动 + 60s 空闲） | RSS 343MB / WS 420MB | 133MB | 175MB | 53MB | 0MB | 18.9MB | 缓存只占 5%，不是主因 |

轻载 heap 构成（self_size 48.2MB）：`string 21.7MB(45%)` / `object 6.6` / `code 5.6` / `array 5.5` / `closure 3.3` / `native 2.0`；最大单条字符串 3.3MB = bundle 自身 ESM 源文本（正常保留）。

重载归因：**RSS ≈ heapUsed 133 + external 53 + 原生/代码等 ~157**。`arrayBuffers=0` 说明 53MB external 不是 Buffer，更像 `node:sqlite` 的堆外内存；`heapTotal` 比 `heapUsed` 多 42MB 是 V8 预留。**下一步是策略实验**（`--max-old-space-size`、sqlite 连接/页缓存上限、重载后 GC 行为），而不是继续改缓存。

## 4.7 内存策略实验（第六轮，全部为负结果/边界确认）

| 实验 | 结果 | 判定 |
|---|---|---|
| sqlite 连接泄漏假设 | 重载空闲 `sqlite=0/4`（峰值 4） | **证伪**：external 53–54MB 与连接数无关 |
| worker `--max-old-space-size=192` | heapUsed 138→116，但 external 54→92、RSS 415→**532**、面板 P95 出现 1818ms 离群 | **负结果**：GC 更频繁/碎片更多，不可作默认 |
| `SUPERTIME_MEM_GC=1` 采样前强制 GC | RSS 415→521、heapUsed 138→204、external 54→156（单样本） | **单样本更差**，负载波动+碎片；仅保留工具，需多次采样才能下结论 |

**边界结论**：worker 内存主体 = V8 保留量（heapTotal 175–254）+ `node:sqlite` 堆外（external 53–156）+ 原生/代码页；
受控缓存 18.9MB、连接数 ≤4。不动业务查询路径时没有低风险削减手段；后续若继续只能从「减少大对象分配/复用缓冲」入手。

## 4.8 首屏两个大查询的分段与跨启动缓存（第七轮）

隔离实测（无并发争用、真实数据根；`SUPERTIME_QUERY_TRACE=1`）：

| 查询 | 冷总耗时 | 分段（ms） |
|---|---|---|
| `getOverview` | **98ms** | contacts 23 / counts 2 / revoked 7 / **resource 41** / sns 24 |
| `getOverviewInsights` | **370–391ms** | contacts 5 / **shards 191–208** / contact-rows 3 / **moments 44–46** / **extras 109** / assets 8 / db-walk 1 |

跨启动磁盘缓存（签名校验，落 `<数据根>/cache/`）：

| 场景 | overview | insights |
|---|---|---|
| 冷启动（无缓存） | 98ms | 370ms |
| 第二次启动、签名命中（隔离、无写入） | **<1ms** | **83ms（4.5×）** |
| 真实应用连续两次启动（有同步写入） | 345ms（miss） | 448ms（miss） |

**负结果证据**：`fileSig` 含 mtimeNs+size+SQLite change counter+WAL，而应用启动的 WAL checkpoint 会自增 change counter ⇒ 每次启动签名都变，磁盘缓存必然 miss；miss 成本仅一次 fs 读（≈1–2ms）。要稳定命中需换「内容稳定」版本键（如 sync-state 指纹）并验证失效语义，本轮不做。

## 4.9 insights 分片扫描的页缓存实验 + 微优化（第八轮）

| 项 | 结果 | 判定 |
|---|---|---|
| insights 374 表 GROUP BY 的页缓存 A/B | 256KB 196.3ms / 4MB 205.6 / 8MB 200.4 / 16MB 208.5（同批真实查询） | **页缓存无影响**（与 storage 的 JOIN 查询不同），假设证伪，不改扫描路径 |
| overview resource 连接加分析缓存 + 删除资源库 GROUP BY 冷段 | overview 冷 98.3→**96.4ms** | 小幅（−2%） |
| insights 朋友圈解析去 split 分配（`countSubstr`/indexOf） | insights 冷 369.9→**361.6ms** | 小幅（−2%）；moments 段仍 44–47ms 以扫描为主 |

## 4.10 file-names 跨启动缓存：首个真实命中（第九轮）

`getStorageStats` 的 `msg/file` 名称树扫描（逐文件 stat 上万个文件）改为签名落盘缓存；签名是目录树 mtime/size，**不受启动 WAL checkpoint 影响**。

| 场景（harness 2 样本、同一数据根） | file-names 段 | n |
|---|---|---|
| sample1（冷，生成缓存） | 108→311ms = **203ms** | 2844 |
| sample2（重启，磁盘命中） | 108→109ms = **~1ms** | 2844 |

⇒ **重复启动省 ~200ms**（getStorageStats 约 −40%）。这是第七轮磁盘缓存机制在真实启动中的**首次命中**（此前 overview/insights 因 `fileSig` 含 checkpoint 会自增的 change counter 而必然 miss）。

## 4.11 收口验证（第十轮）

- **全后端套件**（`src/backend/tests` + `src/backend/wechat-data/tests`）：3455 用例 → **3420 通过 / 34 跳过 / 1 失败**。唯一失败 `llm-embed-model` 与本分支无关（链路未改、隔离仍失败、移走本地 llm.json 仍失败 ⇒ 宿主环境注入配置），记为环境项待干净环境复验。
- **项目棘轮全部绿**：单文件 ≤1000 行（拆出 `scripts/perf/lib/report.mjs`，基线 1096→811；`media.ts` 1006→982，并发工具拆到 `query/concurrency.ts`）、单函数 ≤250 行（`createBackendSupervisor` 286→241、`computeOverviewInsights` 263→~225）。
- typecheck 0；check-generated `--all` 一致；measure:quick 18/21 用例 27.38s。
- **完成态最终 3 样本**（修掉 report.mjs 拆分后漏 import `quantile` 的一处工具 bug 后）：后端 ready **2ms**（低于采集下限）、总览落定 **1143ms [1116–1151]**（历次最优）、重载字节 1,231,887B、面板 P50 153 / P95 249、样本/渲染错误 **0**。

## 4.12 文件面板图片：从「永远占位」到按需解密 + 协议流式（第十一轮）

| 项 | 之前 | 之后 |
|---|---|---|
| 文件库图片解码命中 | **0 / 13,071**（只读 decoded 缓存，无任何链路去解） | 按需解密（探针 8/8 成功，单张 0.8–67ms） |
| 传输 | 整张原图 base64 走两次结构化克隆（单张最大 1.18MB→base64 ≈1.57MB） | `wechat-media://decoded/<rel>?w=320` 流式 + 主进程缩略图（`.w320.jpg` 落盘复用） |
| 网格 | 永久「dat」占位图标 | `<img loading=lazy decoding=async>`（thumb 档）；灯箱单独取原图档 |
| 实测（harness panels=files） | — | decoded_images **+10**、`.w320.jpg` **0→5**、错误 0 |

借鉴 D:\Alpha（只读）：`alpha-media://viewer/<token>/<i>/(thumb|full)` + media thumb/full 两档 + IntersectionObserver 懒加载。

## 5. 结论一句话
> **验证成立**：后端 ready **2910ms→142ms（−95%，control 对照归因）**、总览落定 **3977ms→1229ms（−69%）**；首屏两个最贵查询 `getStorageStats` **676/434→271ms**、`getLedger` **334→161ms**（分析型连接页缓存 256KB→8MB，同库 A/B 最高 3.6×）；首屏 CSS −32%（传输 −6.0%）、contacts 面板 IPC −55%、图片批量 30 张句柄开合 33→3（−91%）且 fileOnly 白算 base64 归零、4 处后端缓存获得硬字节上界、随包 −601.5KiB、1 处监听泄漏与 2 处无界小表修复、内存哨兵恢复轮询；后端基准与全量 typecheck 无退化。
> **没有验证成立**：进程内存 WS（worker/renderer/总）没有可归因的下降 —— 纯净 HEAD 对照跑的逐样本区间同样跨 145–535MB。第四~六轮已完成归因与策略实验：缓存 18.9MB、sqlite 连接 ≤4、`--max-old-space-size` 与强制 GC 均为负结果（§4.5–§4.7）；重载 RSS 343–415MB ≈ V8 heapTotal 175 + external 53 + 原生 ~157，轻载 heap 空闲 60s 无增长（+0.3MB）。再往下只能做「减少大对象分配/复用 Buffer」级重构，需单独立项；导航可见/FCP/面板切换 P50 无显著变化（窗口壳层与交互路径未改）；总览落定在查询变快后不再变化（判据含固定 600ms 静默窗口，已到量具下限）。首屏两查询已分段（隔离冷跑 overview 98ms / insights 370ms，§4.8）；跨启动磁盘缓存为**条件性**优化（无写入窗口 4.5×），真实启动因 WAL checkpoint 改签名而 miss，负结果已记录。
> 两条负结果（首屏预热、icacls 合批）已登记并回滚，不虚报收益；所有改动均有单测/守卫与独立提交可回滚；对外契约（Remote 方法、返回字段、错误文案）未变；`D:\Alpha` 仅作只读参照、未修改。
