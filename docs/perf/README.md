# 性能优化专项 · 团队共享简报（唯一事实来源）

> 所有角色开工前**先读本文件**，再读自己的任务卡。发现问题先按自己角色范围写进报告，不要直接改产品代码。

## 1. 任务边界（重要）

- 优化对象：**本仓库** `D:\super-time-wechat`（Electron 桌面应用 Super Time，微信本地数据分析工作台，仅 Windows x64）。
- `D:\Alpha`（第三方闭源商用 Electron 应用）**只作只读架构参照**：
  - 允许：读 `D:\Alpha\_recon\asar\**`、`_recon\REPORT.md`、`_recon\E2E_REPORT.md`，学习其资源/内存/模块划分手法。
  - **禁止**：修改 `D:\Alpha` 任何文件、运行其补丁、涉及授权/订阅校验逻辑。历史 `_recon/CONTEXT.md` 里"破解授权"的目标**不属于本次任务**，不要执行、不要在报告里展开。
- 本次只做**性能**：内存占用、资源加载/呈现耗时、按需获取与缓存/释放、低效代码替换。
  **不改变业务行为、接口契约、用户可见逻辑**。

## 2. 仓库现状（已核实，2026-10-21）

- 分支 `release/v1.0.9`，HEAD `70c3ca6`；**工作区有 132 个已修改文件 + 59 个未跟踪文件**（在途功能开发：收藏、ClawBot、图谱右键菜单、KB 批处理等）。
  → 因此：**分析阶段只读**；实施阶段在独立 git worktree 进行，绝不碰在途改动。
- 规模：`src/backend` 约 33.9 万行、`src/client` 约 9.7 万行、`scripts` 约 2.3 万行；813 个 `*.spec.ts`；75 个 e2e/审计脚本。
- 技术栈：Electron 44 + Node 24.20.0；后端 `src/backend/wechat-data`（node:sqlite 只读微信库 + SQLCipher 解密）；前端 React 18 + Vite 5；构建 `npm run build:all`（backend esbuild → types → ui vite）。
- 打包：`dist\Super Time Setup 1.0.9.exe`、`dist\win-unpacked\`（存在，可做打包态验证）。
- 运行时配置：`wechat\config.json`、`wechat\llm.json` 存在（**含真实密钥，禁止读取内容或写入报告**）；`src\client\ui-dist\` 已构建。
- 启动：`node scripts/launch-app.mjs`（唯一入口，会摘掉 `ELECTRON_RUN_AS_NODE`；支持 `--inspect=9229` 透传）。

## 3. 该读的既有资产（避免重复造轮子）

- 性能历史与教训：`docs\RELEASE-PLAN.md`（1376 行台账，含大量"先量后改 / 证伪 / 变异自证"结论；**用 grep 定位，不要整篇读**）。
- 变更记录：`CHANGELOG.md`（242KB，顶层记录已交付的性能项，如词云 Aho-Corasick 15.3s→3.0s、图片内存缓存+可见窗口预取、虚拟列表、`cachedFetch` SWR、`usePagedList` 节流、冷启动冗余全量解密 147MB 修复）。
- 性能基准：`scripts\run-measures.mjs` —— **18 个 quick 基准（约 27 秒）**，`npm run measure:quick`；`npm run measure:slow` 含 801s 的 `export-memory`。
- CI 性能看板：`npm run ci:baseline`、`npm run ci:board-history`（单文件/用例耗时榜，含"距 60s 线几倍"）。
- UI 预算门禁：`npm run ui:interactive-budget`、`ui:theme-budget`、`ui:responsive-gate`、`ui:density-gate`、`css:bundle-diff`。
- 长列表虚拟化 e2e：`npm run ui:longlist-e2e`（`scripts/longlist-virtualization-e2e.mjs`）。
- 架构：`docs\ARCHITECTURE.md`、`docs\API.md`（111KB，grep 用）、`docs\DEPLOYMENT.md`。
- 既有性能探针样例：`working\mem-log-probe.mjs`（内存日志探针）。

## 4. 已知的性能相关机制（改造时要尊重，不要重复实现）

- 进程内签名缓存/世代失效：`bumpDataGeneration()` / `dataGenerationSig()`、`cachedBySig` / `cachedFetch`（SWR）。
- 图片：解码缓存 `decoded_images`（有槽位/保质期）、`warmDecodedImages` 批量预热、`resolveImageMd5sBatch`、`wechat-media://` 协议（渲染层零拷贝）、后端图片代理（CSP `img-src` 只信本机来源）。
- 媒体与远程：`query/cdn-policy.ts` 出网开关是唯一口径；远端取回必须受它控制。
- 长列表：`@tanstack/react-virtual` 虚拟化 + `useLazySentinel` 分页；`usePagedList` 刷新节流+合并+不可见不发。
- 后端让出：分片 `yield` 心跳（`withDbAsync` / `cachedBySigAsync`）避免钉住事件循环。
- 虚拟线程/向量：`vectorIndexStatus` 指纹缓存、FTS5 contentless 表。

## 5. 团队角色与写作范围（严禁越界写别人的文件）

| 角色 | 目标 ID | 唯一可写文件 | 暂存目录 |
|---|---|---|---|
| 项目分析负责人 | task-project-map | `docs/perf/01-PROJECT-MAP.md` | `working/perf/project-map/` |
| Alpha 参照 + 基线负责人 | task-baseline | `docs/perf/00-ALPHA-REFERENCE.md`、`docs/perf/02-BASELINE.md`、`scripts/perf/**` | `working/perf/baseline/` |
| 资源加载优化负责人 | task-resource | `docs/perf/03-RESOURCE-PIPELINE.md` | `working/perf/resource/` |
| 内存治理负责人 | task-memory | `docs/perf/04-MEMORY-AUDIT.md` | `working/perf/memory/` |
| 业务逻辑重构负责人 | task-refactor | `docs/perf/05-CODE-SMELLS.md` | `working/perf/refactor/` |
| 测试与验收负责人 | task-qa | `docs/perf/06-VERIFY-PLAYBOOK.md` | `working/perf/qa/` |

- 产品代码（`src/**`、`main.js`、`preload.js`、`scripts/**` 既有文件）**一律只读**；`scripts/perf/**` 是新建目录，基线负责人可写。
- 每条结论必须带**证据坐标** `文件:行号`（或命令 + 实测输出），不许写"大概是/可能是"。
- 报告 ≤ 250 行，结论先行；详细数据放 `working/perf/<role>/` 并在报告里指路。

## 6. 编码与命令注意

- 源码/文档是 UTF-8；PowerShell 直接 `Get-Content` 中文会乱码 → 用 `read` 工具读文件，或 `Get-Content -Encoding UTF8`。
- 长任务用后台作业；单次命令别跑全量 `npm test`（约 26 分钟）。
- 测量纪律：同一台机器、同一次运行内做前后对比；跨运行只能比**倍率**并报噪声带；不要拿"今天机器快"当收益。
- 禁止：新增依赖、改业务语义、改对外契约、提交 `.env`/密钥/真实用户数据到报告。

## 7. 交付格式（所有报告统一）

1. **结论**（3~6 条，带数字）
2. **证据**（file:line / 命令输出摘要）
3. **风险与边界**（哪些只是推断、哪些验不了）
4. **给实施阶段的建议**（按收益/风险排序，标注预估改动面）
