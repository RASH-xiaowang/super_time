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

## 4. 下一步该用什么量具/还能往哪优化（本轮未做）
1. **worker 内存**：哨兵已恢复 60s 轮询；下一步做 `--inspect` heap snapshot（进朋友圈/词云/sync 前后各一张），按 retained size 对账 `docs/perf/04-MEMORY-AUDIT.md` §3。
2. **渲染图片内存**：`data:` 图片占大头的是**已解码位图**（CDP JS 堆只有 31MB），迁 `wechat-media://` 前必须先做 heap snapshot 归因，否则可能只是把 base64 换成文件路径而位图内存不变。
3. **启动剩余 328ms 的构成（boot 打点已可逐段看）**：worker requires 5ms / bundle import 39ms / typert 47ms / gateway 3ms / 后端装配其余 ~4ms / 主进程 init 回程 ~30ms / 设置回灌 ~44ms / ACL 校验 + 文件收紧 ~120–153ms / 其余 ~45ms。下一刀值得看的是：ACL 的文件级收紧能否合并成一次 `icacls`（省 ~100ms）、typert schema 能否按需加载（47ms）、`applySupervisorSettings` 能否合并进 init 的 config 回灌（44ms）。
4. **总览落定 1229ms 的构成**：它现在由「首屏 4 个查询 + 渲染」决定，后端 ready 已不是瓶颈；要再降需要 IPC 级打点（哪些查询占了多数），可用 harness 的 `panelSwitch.overview` / `cache.queryProxy` 读数继续切。
5. **首屏 CSS 剩余体积**：Bootstrap Grid 50.6KB 仍全量（只有总览/RegionBoard 用 `row/col-*`），迁到局部 CSS grid 需先做 `css:bundle-diff` + 面板截图验收。

## 5. 结论一句话
> **验证成立**：后端 ready **2910ms→142ms（−95%，control 对照归因）**、总览落定 **3977ms→1229ms（−69%）**；首屏 CSS −32%（传输 −6.0%）、contacts 面板 IPC −55%、图片批量 30 张句柄开合 33→3（−91%）且 fileOnly 白算 base64 归零、4 处后端缓存获得硬字节上界、随包 −601.5KiB、1 处监听泄漏与 2 处无界小表修复、内存哨兵恢复轮询；后端基准与全量 typecheck 无退化。
> **没有验证成立**：进程内存 WS（worker/renderer/总）—— 纯净 HEAD 对照跑的逐样本区间同样跨 145–535MB，本轮改动没有可归因的改善或退化，需要 heap snapshot 才能定量；导航可见/FCP/面板切换 P50 无显著变化（窗口壳层与交互路径未改）。
> 所有改动均有单测/守卫与独立提交可回滚；对外契约（Remote 方法、返回字段、错误文案）未变；`D:\Alpha` 仅作只读参照、未修改。
