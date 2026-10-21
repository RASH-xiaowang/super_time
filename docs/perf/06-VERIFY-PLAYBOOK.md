# 06 · 验证与回归 Playbook

> 作者：测试与验收负责人（task-qa）。目的：**每次 perf 改动都能在可接受时间内验完，并且"退化"有可复算的定义**。
> 实测机器：Windows x64 / Node 24.20.0 / npm 11.19.0 / 28 逻辑核；`release/v1.0.9` HEAD `70c3ca6`；工作树脏（192 个改动文件，含在途功能）。
> 原始日志：`working/perf/qa/logs/`（本报告每个数字都有对应 `.log`/`.timing.txt`）。

## 0. 结论（先看这 6 条）

1. **perf 改动最该跑的 5 条**：`npm run test:affected`（26.9s）→ `npm run typecheck`（24.6s）→ `npm run measure:quick`（28.3s）→ `npm run ui:longlist-e2e`（33.8s，长列表 DOM 上界）→ `npm run ui:interactive-budget`（需先跑一次 `theme:live-audit -- --stress`）。合计约 2 分钟（interactive-budget 前置另计）。
2. **全量 `npm test` 不跑**：仓内口径"约 26 分钟"来自 **CI 串行**（`vitest.config.ts:109` `maxWorkers: CI ? 1 : undefined`）。本机并行下 `test:affected` 覆盖**全部 624 个**纳入 vitest 的测试文件仅 26.9s，因此**本地全量大概率远低于 26 分钟**——但本任务按要求未跑全量，此句只作推断，不当基线。
3. **当前脏工作树本身就有 15 个失败 spec / 21 条失败用例**（`test:affected` 实测；见 §2.2 清单）。后续验证必须比对"失败集合"，不能以"全绿"为判据。
4. **CI 单测步的假红已归因并自动化**：`scripts/ci-unit-step.mjs` 只对"退出码非 0 + 日志有 `Timeout calling \"onTaskUpdate\"` + 没有任何失败文件/用例"三条同时成立的情况做**一次带记录重跑**（`src/backend/tests/helpers/ci-unit-retry.ts:17`；CI 把上限调到 3，见 `.github/workflows/ci.yml:79-96`）。本机不得把这套重试当成"再跑一遍"的理由。
5. **性能门禁有前置条件**：`ui:interactive-budget` 缺 `.tmp-e2e/interactive-timings.json` 时 **exit 2**（需先跑 `npm run theme:live-audit -- --stress`，本机实测 **172s**）；补齐后 **0.2s exit 0**：16 个面板全部在预算内，未登记为已知慢的 14 个 **505–519ms**（预算 1200ms）。`css:bundle-diff` 直接跑也 **exit 2**（需要 `--save`/`--check` 两段式 + `npm run build:ui`）。两者都不是"红"，是"没验"。
6. **e2e 有两个高频假红源**：本机 harness 注入的 `ELECTRON_RUN_AS_NODE=1`（会让脚本 0.5s 报 `Process failed to launch!`），以及并发的 Electron 探针（本次 `ui:nav-e2e` 从仓库基线 5.8s 被拖到 **184.4s**）。

## 1. 分层验证矩阵（改哪类文件 → 跑哪些命令）

### 1.1 单文件级（最快反馈，先跑这个）

```powershell
node node_modules/vitest/vitest.mjs run <spec 路径> --maxWorkers=1
```
- 判据：退出码 0 且 `Test Files 1 passed`；`Errors` 只允许 N36 那一句（见 §4.1）。
- 本机实测：`image-path-batch.spec.ts` **0.63s**、`remote-image.spec.ts` **5.2s**、`image-cache-release.spec.ts` **0.5s**（全部 exit 0）。

### 1.2 模块级（改 1~几十个文件时）

```powershell
npm run test:affected          # = node scripts/affected-tests.mjs
npm run test:affected:list     # 只看将跑哪些输入文件
```
- 选择规则（`scripts/affected-tests.mjs` + `scripts/mutation-scope.mjs:103`）：取 `git diff <base>...HEAD` ∪ unstaged ∪ staged ∪ **untracked** 的并集，剔除 `working/`、`.tmp*`、`node_modules/`、`src/backend/wechat-data/lib/`、`src/client/ui-dist/`，再交给 `vitest related --run`（**只按 import 关系**，不覆盖"读源码做断言"的守卫）。
- 本机实测（脏树 192 文件）：可测源码 **163** 个 → 选中并跑完 **624 个测试文件**（= `vitest include` 全集：`wechat-data/tests` 255 + `backend/tests` 115 + `ui-wechat/src/client` 245 + `ui-app` 9；另有 21 个 `src/backend/deps/**` spec 不在 include）、6341 条用例，**26.9s**，exit 1（15 个既有失败 spec，见 §2.2）；`[耗时榜]` 榜首 `clawbot-reply-durable.spec.ts` 20.2s（距 60s 线 2.97×）。
- 注意：工作树越脏，它越接近"全部 624 个"；干净小改动才会显著变快（`related` 只按 import 关系选）。

### 1.3 类型 / 生成物门禁（后端 src 一改必跑）

```powershell
npm run typecheck                                   # 5 个子项，本机合计 24.6s
node scripts/check-generated-artifacts.js --backend # bundle 与源码逐字节比对；本机 0.09s
```
- 改后端 `src/**`：`npm run build:backend`（必要时 `build:types`、`npm run docs:api`）后再跑 `check:backend`，否则门禁必红（`docs/CONTRIBUTING.md:25-39`）。
- 各子项本机实测：`typecheck:server` 1.3s / `typecheck:client` 6.7s / `typecheck:ui-app` 5.8s / `typecheck:checks` 6.4s / `typecheck:tests` 4.3s（全部 exit 0）。

### 1.4 性能门禁（perf 改动的"记分牌"）

| 命令 | 实测 | 判据 / 前置 |
|---|---|---|
| `npm run measure:quick` | **28.3s** exit 0 | 18 个基准（`scripts/run-measures.mjs:56+`）；门控变量由脚本注入，**直接 `vitest run <measure.spec>` 会静默 skip** |
| `npm run css:bundle-diff` | no-arg **0.3s exit 2**；`--save` 0.1s、`--check` 1.1s（自比 exit 0） | 两段式：改前 `npm run build:ui && node scripts/css-bundle-diff.mjs --save <f>`；改后重新 build 再 `--check <f>`。判据=规则多重集+危险次序变化均为 0 |
| `npm run ui:interactive-budget` | 缺前置 **0.2s exit 2**；补齐后 **0.2s exit 0**（16 面板全在预算内，14 个未登记 505–519ms） | 需 `.tmp-e2e/interactive-timings.json`（来自 `npm run theme:live-audit -- --stress`，本机 **172s**）；预算见 `scripts/interactive-budget.json`（默认 1200ms，`收藏与表情`/`朋友圈洞察` 登记 61000ms；缺登记=报错） |
| `npm run ui:panel-audit` | 未跑完（并发 Electron 卡住；见 §4.3） | 需真实解密数据根；逐页签量"最大空白带/空白占比"，16 个页签，预计 1~4 分钟 |
| `npm run theme:live-audit -- --stress` | 本次 **172s exit 0** | 17 页签回访 <3000ms（`STRESS_FAST_MS`，`scripts/theme-live-audit.mjs:87`）；本机"超过 3s 的面板：无"，深浅主题各一遍，并产出 interactive-timings.json |

### 1.5 端到端（75 个脚本里，perf 最该跑的 10 条）

> "预计耗时"分工：**仓库实测**= `scripts/ci-tiers.mjs`（2026-10-11 本机，权威成本表）；**本次实测**= 今天在这台机器上实跑（受并发探针/冷启动影响，仅供对照）。

| # | 场景 | 命令 | 预计耗时 | 通过判据（脚本头/断言原文摘要） |
|---|---|---|---|---|
| 1 | 运行环境探针 + 提示自动消失 | `npm run ui:e2e-smoke` | 仓库 4.4s / 本次 **12.4s** exit 0 | 真 Chromium UA、body 有布局、preload 桥、Remote 调用 ok、真实点击换面板、提示 3s 自动消失、无 console error（`scripts/ui-e2e-smoke.mjs:82-175`） |
| 2 | 长列表 DOM 硬上界（**perf 核心**） | `npm run ui:longlist-e2e` | 仓库 34.0s / 本次 **33.8s** exit 0 | 消息 DOM ≤300、收藏卡 ≤200、文件格 ≤200、朋友圈行 ≤80；`#msg-1` 可达、`#msg-10000` 可达；点"加载更多"锚点位移 ≤40px（`scripts/longlist-virtualization-e2e.mjs:30-52,287-322`） |
| 3 | 加载恢复 / 超时解套 | `npm run ui:loading-e2e` | 仓库 6.1s / 本次 **25.5s exit 1（2/10 失败）** | 错误提示出现且含"调用超时"与方法名；`nm-skel=0`；worker 注入命中、主进程超时收敛；下一条调用照常收尾、无残留 alert、无 pageerror（`scripts/loading-recovery-e2e.mjs:96-129`） |
| 4 | 导航壳（面板/浮层） | `npm run ui:nav-e2e` | 仓库 5.8s / 本次 **184.4s exit 1（5/28）** | 收起/展开尺寸、搜索框显隐、下拉不被裁、无横向溢出、Ctrl+K 联动等 28 项（`scripts/nav-shell-e2e.mjs`） |
| 5 | 账本重载（P2-4 首帧/风暴） | `npm run e2e:ledger-reload` | 仓库 38.3s / 本次 **37.3s exit 0（10/10）** | `?skeleton=1` 强制态骨架 >0（哨兵）；二次进入**只等一帧**有资金数字、新增骨架 0；事件风暴 0 次闪空；主线程最大帧间隔 <500ms（`scripts/ledger-reload-e2e.mjs:205-277`） |
| 6 | 导出进度/中止（40k 条） | `npm run e2e:export-progress` | 本次 **5.5s exit 0（22/22）**（40k 夹具；仓库未单列，CI 上更慢） | 中继事件 >0、jobId 前缀 `chats-export-`、done≤total、进度多格递增、不定量态、"已取消"非失败、无 `.partial-*`、恰一个 xlsx 且 <200KB（`scripts/export-progress-e2e.mjs:240-306`） |
| 7 | 导出非阻塞（H8，UI ≤1s） | `npm run e2e:export-nonblocking` | **KNOWN ROT，别跑** | 断言 `LIMIT_MS=1000`（`scripts/export-nonblocking-e2e.mjs:29`），但脚本仍走"更多→导出消息"旧流程 + 原生目录选择器，headless 必红（`scripts/ci-tiers.mjs` KNOWN_ROT） |
| 8 | 加密备份进度/中止 | `npm run e2e:backup-progress` | 仓库 6.1s（夜间档） | `backup-enc-` jobId、files 阶段 done 递增、write 阶段递增、总量未知走不定量态、中止后进度收掉且提示"已取消加密备份"（`scripts/backup-progress-e2e.mjs:122-158`） |
| 9 | 渲染层 console 进诊断日志 | `npm run renderer-console:e2e` | 仓库 1s / 本次 **0.9s exit 0** | 渲染层 warn/error 真进 `app.log`（图片/取图失败排查的**唯一**真机证据链） |
| 10 | 面板留白/主题 + 交互预算 | `npm run ui:panel-audit`；`npm run theme:live-audit -- --stress` → `npm run ui:interactive-budget` | 见 §1.4 | 逐页签空白带/占比 + console error；回访 14/16 页签 ~520ms、预算 1200ms；缺登记 = 报错（不是通过） |

补充：`npm run task-center:e2e`（120 条触发记录、首屏 100 + 游标加载更多）属"面板/长列表"旁证，需要时跑；`npm run ui:accept` 会接管 `llm.json` 并清空向量/反馈库，**破坏性**，只在专门验收时跑且必须先关应用。

### 1.6 打包态（改了打包/依赖/resource 路径才跑）

```powershell
npm run package:smoke            # 启动 dist/win-unpacked/Super Time.exe；超时 180s（scripts/packaged-smoke.js:317）
npm run package:sns-video:smoke  # 0.3s，但**没有打包件时也 exit 0**（假绿陷阱，scripts/ci-tiers.mjs:97-98）
```
两者都要求先有 `dist/win-unpacked/`（本机存在）。

## 2. 实测基线（2026-10-21，本机，脏工作树）

### 2.1 关键命令耗时

| 命令 | 耗时 | 退出码 | 输出形状 |
|---|---|---|---|
| `npm run test:affected` | **26.9s** | 1 | 624 files / 6341 tests；`15 failed, 585 passed, 24 skipped`；末尾有 `[耗时榜]/[用例榜]/[文件内账]` |
| `npm run typecheck`（5 项串行） | **24.6s** | 0 | 无输出=通过；分项见 §1.3 |
| `node scripts/check-generated-artifacts.js --backend` | **0.09s** | 0 | `✅ 后端 bundle与当前源码一致` |
| `npm run measure:quick` | **28.3s** | 0 | 18 基准逐条 ✓；同样打印三张榜 |
| `npm run css:bundle-diff`（无参 / save / check） | 0.3 / 0.1 / 1.1s | 2 / 0 / 0 | 无参打印用法；check 打印"规则集合逐条一致" |
| `npm run ui:interactive-budget`（缺前置 → 补前置） | 0.2s / 0.2s | 2 / 0 | 缺前置打印"找不到测量结果"；补齐后 16 面板全过（14 个 505–519ms / 1200ms） |
| `npm run theme:live-audit -- --stress` | **172s** | 0 | 压力项"回访超过 3s 的面板：无"；深浅主题各一遍 OK；落盘 `interactive-timings.json` |
| 单 spec ×3（`--maxWorkers=1`） | 0.63 / 5.2 / 0.5s | 0 | `Test Files 1 passed`；单文件榜可能出现"没有 ≥1 秒的慢文件" |

### 2.2 当前脏树已知红（**改动前的基线，不是你的改动造成**）

`test:affected` 15 个失败文件：`api-docs`、`docs-index`、`function-size-ratchet`、`http-remote-policy`、`m21-file-size-ratchet`、`mutation-registry-anchors`、`packaging-content`、`md5-image-key`、`remote-contract-shape`、`button-disabled-tone.wiring`、`knowledge-base.wiring`、`moments-videos`、`panel-feedback-matrix`、`theme-geometry`、`state-components.wiring`（均在 `src/backend/tests` 或 `src/backend/wechat-data/tests` 或 `src/client/.../wechat-data`）。
E2E 基线红：`ui:loading-e2e` 2/10、`ui:nav-e2e` 5/28（在途 UI 改动 + 并发探针污染，需在干净树复核）。
**纪律：验证 perf 改动时先跑一遍基线、把失败集合存进 `working/perf/qa/`，改完只允许"失败集合 ⊆ 基线失败集合"。**

### 2.3 E2E 实跑记录（本次）

| 脚本 | 本次耗时 | 结果 | 仓库基线（`ci-tiers.mjs`，2026-10-11） |
|---|---|---|---|
| `ui:e2e-smoke` | 12.4s | PASS | 4.4s（本次有并发 Electron → 2.8× 慢） |
| `ui:longlist-e2e` | **33.8s** | PASS（27 项） | 34.0s（DOM 断言不受算力影响，几乎一致） |
| `e2e:ledger-reload` | **37.3s** | PASS（10/10） | 38.3s（几乎一致） |
| `e2e:export-progress` | **5.5s** | PASS（22/22；本机全绿） | 未单列（CI 上偶发 N33，见 §4.15） |
| `renderer-console:e2e` | 0.9s | PASS | 1s |
| `ui:loading-e2e` | 25.5s | **FAIL 2/10**（脏树基线） | 6.1s |
| `ui:nav-e2e` | 184.4s | **FAIL 5/28**（脏树 UI 改动 + 并发污染） | 5.8s |
| `theme:live-audit --stress` | **172.0s** | PASS（"回访超过 3s 的面板：无"；深浅主题 OK） | 未纳入成本表 |
| `ui:interactive-budget`（有前置） | **0.2s** | PASS（16 面板 / 失败 0；14 个未登记 505–519ms vs 1200ms） | 预算 1200ms |
| `ui:panel-audit` | 中途终止 | 未完成（被并发 Electron 探针拖住，16 页签落定等待） | 未纳入成本表 |

> 结论：**DOM/断言型 e2e（longlist/ledger/export/renderer-console）本机稳定复现仓库基线**；**计时型**（nav 的 30s locator、panel 落定）在并发环境里不可信，必须独跑。`theme:live-audit --stress` 虽然要 ~3 分钟，但它把"交互 P95"变成了可复算的 16 个数字——**perf 改动值得为它花这 3 分钟**（再 0.2s 就能过预算门禁）。

## 3. 回归判据模板（A/B 同会话）

### 3.1 采集协议（缺一条就不算数）

1. **同一台机器、同一次开机、同一会话内**完成 A（改前）与 B（改后）；跨会话只许比倍率。
2. 采集前记录：`git rev-parse HEAD`、`git status --porcelain | Measure-Object -Line`、`lib/index.js` 与 `src/client/ui-dist` 的 mtime/sha、夹具规模、探针版本。
3. **安静机器**：`(Get-CimInstance Win32_Process -Filter "Name='electron.exe'").Count -eq 0`；无其它 teammate 的 `st-*` 临时 profile 进程；不在跑 `test:affected`/measure。
4. **交错采集**：A、B、A、B、A（至少各 3 次；内存类 ≥5 次）。先热身一次丢弃（冷启动不算）。
5. 每次采样输出：`n`、median、P95（或 max）、噪声带（MAD×1.4826）。
6. 探针必须读**同一选择器/同一方法**（如 `[role=progressbar]`、`data-st-ledger-money`、`#msg-*`），不许换量具。

### 3.2 退化判据（任一条成立即判"退化"，需回滚或逐个证伪）

| 指标 | 退化阈值（同时满足才算，避免把噪声当回归） |
|---|---|
| 进程/渲染内存（RSS、heapUsed、external） | B 中位数比 A **+5%**，且差值 > max(2×MAD, **20MB**)；峰值同样口径 |
| 面板交互 P95（点击→正文出现） | B **+10%** 且 > max(2×MAD, **30ms**)；同时不得越过 `interactive-budget.json` 的 1200ms 预算 |
| 长列表 DOM 节点数 | 任何方向**只许 ≤ 硬上界**（消息 300 / 收藏 200 / 文件 200 / 朋友圈 80）；越界=失败，不看噪声 |
| 加载/导出吞吐（条/秒、张/秒） | B **-10%** 且差值 > 2×MAD |
| 导出/备份峰值内存 | B **+5%** 且 > max(2×MAD, 20MB)；或越过既有台账验收线（如 1000 会话亚线性） |
| 首帧/首内容时间（冷启动、二次进入） | B **+10%** 且 > max(2×MAD, 50ms) |

- 反方向同理：**只有 B 的改善也超过噪声带**才能宣称收益（`--compare` 精神：差值要超过两边带之和，见 `docs/RELEASE-PLAN.md` N36 ⑱）。
- 探针示例：内存用 `[mem] rss=… heapUsed=… heapTotal=… external=… over=… (limit=…)`（`src/backend/.../worker-mem-sentinel.js:88`，可用 `working/mem-log-probe.mjs` 汇总）；交互/列表用 e2e 内已有的 `evaluate` 采样。
- 记录表（写进 `working/perf/qa/`）：`probe | metric | A:n/median/P95 | B:n/median/P95 | Δ% | 噪声带 | 判定 | 证据日志`。

## 4. 已知假红与陷阱（按踩坑频率排序）

1. **`Timeout calling "onTaskUpdate"`（N36）**：形状=`Test Files/Tests 全 passed` + `Errors 1 error` + 退出码 1。机制：birpc `DEFAULT_TIMEOUT=6e4` 硬编码在 worker 自己的事件循环上（`vitest.config.ts` 注释与 `docs/RELEASE-PLAN.md` N36）。处置：本机**不要盲目重跑**，先看同一份日志的 `[耗时榜]`（单文件越 60s 线即"环境停顿"候选）；CI 才允许**一次带记录重试**——`scripts/ci-unit-step.mjs:55-89`（默认 `SUPERTIME_UNIT_MAX_RETRIES=1`；CI/发布链按 N36 把上限提到 3，但判据不放宽：退出码非 0 + 有征兆 + 无失败用例，任一不成立立即红），重跑记录写 `$GITHUB_STEP_SUMMARY` 供 PR 页复核（`src/backend/tests/helpers/ci-unit-retry.ts:97-117`）。
2. **`ELECTRON_RUN_AS_NODE=1`（本机 harness 注入）**：所有把 `...process.env` 传给 `_electron.launch` 的脚本 0.5s 就报 `Process failed to launch!`（本次 `ui:e2e-smoke`/`ui:loading-e2e` 首轮即此）。修复：运行前 `Remove-Item Env:ELECTRON_RUN_AS_NODE`。自带剥离的脚本：`launch-app.mjs:87`、`panel-audit.mjs:138`、`theme-live-audit.mjs:322`、`responsive-audit-browser.mjs:394`、`ui-density-audit.mjs:710`、`mutation-check.mjs:192`。
3. **并发 Electron/探针污染计时**：README 与 `scripts/ui-verify.mjs` 都要求串行；2026-09-29 曾泄漏 20 个 Electron → 截图从 12s 级劣化。本次 `ui:nav-e2e` 5.8s→184.4s 就是并发探针所致。跑计时类 e2e 前先数进程。
4. **脏工作树让 `test:affected` 近似全量且自带 15 红**（§2.2）。永远先存基线失败集合。
5. **脚本腐烂（KNOWN ROT）**：`e2e:export-nonblocking` 已失效（旧"更多"菜单 + 原生目录选择器，`scripts/ci-tiers.mjs` KNOWN_ROT）；`package:sns-video:smoke` 无打包件时 **exit 0 假绿**（`ci-tiers.mjs:97-98`）；`ui:accept` 有破坏性副作用。
6. **前置缺失 ≠ 通过**：`ui:interactive-budget` / `css:bundle-diff` / `panel-audit` / `theme-live-audit` / `m8-cache-storm-bench` 缺 timings、缺 ui-dist、缺真实数据根时 **exit 2 或跳过**；别把"跳过"记成绿。
7. **measure 基准被门控**：`describe.skipIf(MEASURE_* !== '1')`；必须走 `npm run measure:quick`，直接跑 spec 只会得到 `↓ skipped`。
8. **生成物漂移**：改了后端 `src` 未 `build:backend`/`build:types`/`docs:api` ⇒ `check:*` 必红（这是真红，不是假红）。
9. **编码**：PowerShell 读中文必须 `-Encoding UTF8`（否则乱码）；`Tee-Object -FilePath` 默认写 UTF-16（本次 timing 文件第一次就是 UTF-16 乱码），统一用 `Out-File/Add-Content -Encoding utf8`；git 的 CRLF 警告是 stderr 噪声，不影响退出码。
10. **机器相关绝对路径**：`working/mem-log-probe.mjs:3` 硬编码 `C:/Users/Administrator/...`；`m8-cache-storm-bench` 默认 `%APPDATA%` 数据根；e2e 的临时 userData 在 `%TEMP%/st-*`。报告/结论里引用路径要注明来源机器。
11. **`interactive-budget` 的 knownSlow 不是失败**：`收藏与表情`/`朋友圈洞察` 登记 61000ms（队列积压已归因），删登记前它们会按 1200ms 判红。
12. **超时=180s**：`vitest.config.ts:82` 把 test/hook 超时提到 180s，真死循环会晚 3 分钟才报；"慢"与"挂"要分开看。
13. **Windows 临时目录 `EPERM`（N26）**：`node:sqlite` 未 finalize 的语句会让 `rmSync` 偶发失败，spec 内靠重试容忍——不要当成产品回归。
14. **`css:bundle-diff` 基线版本**：旧版基线（无 `mods` 字段）会被拒绝并 exit 2；拆 CSS 前必须用当前工具重存基线。
15. **N33 导出进度中继偶发（CI）**：CI 上 `e2e:export-progress` 曾红在"中继事件 0 条"，而本机 22/22 全绿（本次 5.5s）。脚本自带 `[N33 计数]`（本次 `阶段① DOM事件=6 主进程到达=150 回调抛错=0 额外加载=0 页面异常=0`）——红了先读这行，不要当成本机可复现的产品缺陷（`docs/RELEASE-PLAN.md` N33）。

## 5. 不做什么

- 不跑全量 `npm test`（CI 口径 26 分钟）；本地用 §1.1/§1.2 收敛。
- 不改 `vitest.config.ts`、不改产品代码；不新增依赖。
- 不把"重跑后绿"当证据（除 §4.1 的 CI 政策外）。
- 不在并发 Electron/多人探针时做计时结论。

## 6. 原始日志索引（`working/perf/qa/logs/`）

`test-affected.log` + `.timing.txt`｜`typecheck.log` + `.timing.txt`｜`check-generated-backend.log`｜`measure-quick.log` + `.timing.txt`｜`gates.timing.txt` + `css-bundle-diff-*.log` + `css-before.json`｜`spec-*.log`｜`e2e-ui-smoke.log` / `e2e2-*.log` / `e2e3-*.log`（含 `e2e.timing.txt` / `e2e2.timing.txt` / `e2e3.timing.txt`）。

基线快照（含 15 个失败 spec 清单、E2E 结果、环境陷阱）：`working/perf/qa/BASELINE-2026-10-21.md`。
