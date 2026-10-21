# 01 · 项目地图（Super Time / Electron）

> 只读分析（HEAD 70c3ca6，工作区有 192 行在途改动，未触碰）。行号以当前工作树为准；"实测"= PowerShell 只读统计，原始数据见 `working/perf/project-map/raw-measurements.md`。本文件 ≤250 行。

## 0. 结论（先看这 8 条）

1. **三进程、两条通道**：主进程 `main.js`（581 行）负责窗口/IPC/许可证/更新；后端跑在 `utilityProcess` worker（`src/backend/wechat-worker.js`），加载 1.88 MB 的 esbuild 单文件 bundle（`src/backend/wechat-data/lib/index.js`）；渲染进程是 React 18 + Vite 产物（`src/client/ui-dist`，4.42 MB / 248 文件）。渲染层只经 `preload.js` 的 `contextBridge` 说话，主进程↔worker 走 `postMessage`（见 `docs/ARCHITECTURE.md:14-30`、`src/backend/backend-supervisor.js:150-160`）。
2. **构建链三步串行**：`build:backend`（esbuild → lib/index.js，1884.9 KB）→ `build:types`（tsc → lib/types）→ `build:ui`（vite → ui-dist，60 个 JS chunk）。三者各有一致性门禁（`package.json:12-17`、`docs/ARCHITECTURE.md:184-194`）。
3. **前端已按面板懒加载**：31 个面板用 `React.lazy` 拆 chunk（`src/client/ui-wechat/src/client/pages/wechat-data/panel-loaders.tsx:12-46`），主包约 354 KB、最大的按需块 `installCanvasRenderer` 441.6 KB；vite 用 550 KB 阈值把"重新长回单体"变成可见回归（`vite.config.js:29-33`）。
4. **业务面**：侧栏 5 组/14 个可见入口、39 个可路由 tab（14 可见 + 24 隐藏 + settings；`src/client/README.md:33` 仍写 38，clawbot 后未更新，见 §8），后端 214 个 Remote 方法（`docs/API.md`，CI 校验）；后端 query/ 顶层 149 个文件（另有 bot/kb/retrieval/tools 子域）、23 个分域 remotes、19 个 gateway 分片。
5. **资源大头在安装包而非内存**：win-unpacked 530.9 MB（Electron 234.7 MB + whisper 模型 74.1 MB + app.asar 42.5 MB + onnxruntime 27.4 MB）；仓库内 ui-dist 4.42 MB 中图片占 1.52 MB（wxemoji 921.5 KB + 4 张 onboarding 背景 601.5 KB，后者**全仓无引用**）。
6. **启动编排已做对**：先建窗（占位首帧）→ 再起后端 init，首帧不等 1.88 MB bundle 解析（`main.js:523-530`）；后端 init 后 `setImmediate` 低优先级预热 shardCatalog/contact_fts（`query/startup-prewarm.ts:1-22`）。
7. **性能机制已成体系**（优化时先找它们，别重造）：签名缓存 SWR `cachedBySig`/`cachedFetch`、`decoded_images` 磁盘解码缓存 + `wechat-media://` 流式协议（字节不进 IPC）、虚拟列表 + `usePagedList/useLazySentinel`、`yieldToLoop` 让出、HTTP 队列并发 2/排队 32、worker 内存哨兵 1.2 GB 告警线。
8. **测试口径要小心**：共享简报的 813 = 645 个 `*.spec.ts` + 168 个 vendored zod `*.test.ts`；vitest 实际只收集 624 个 spec（`vitest.config.ts:51-62`）。性能基准 19 个（18 quick + 1 slow 801.5 s）。

## 1. 进程与入口

| 进程/角色 | 入口 | 关键事实（证据） |
|---|---|---|
| Electron 主进程 | `main.js` | 组合根：userData 隔离（`:130-145`）、单实例锁（`:198-211`）、打包态剥调试开关（`:56-67`）、安全守卫（`src/backend/main-window.js:185-227`）；所有 IPC 处理器在 `createWindow()` 之前注册（`main.js:352-461`） |
| 主窗口 | `src/backend/main-window.js` | `frame:false` 1440×900 基准（`:68-99`）；`sandbox:true`、`contextIsolation:true`、`backgroundThrottling:true`（`:87-98`）；加载 `ui-dist/index.html`，缺失回退 `src/index.html`（`:14-18`） |
| 后端 worker | `src/backend/wechat-worker.js` | `utilityProcess.fork(wechat-worker.js)`（`backend-supervisor.js:156-160`）；协议 init/call/cancel/dispose（`wechat-worker.js:71-135`）；启动即挂内存哨兵（`wechat-worker.js:39-45`） |
| 后端实现 | `src/backend/wechat-data/lib/index.js` | 运行时**只 import 这一份**（`src/backend/wechat-host.js:240-242`）；typert schema 影子校验另加载 197.6 KB（`wechat-host.js:266-272`）；gateway 单一出口（`wechat-data/src/index.ts:32-34`） |
| 渲染进程 | `src/client/ui-app/ui-entry.tsx` | `Proxy` 把 `api.ts` 每个方法转 `electronAPI.wechat.call`（`:83-92`）；事件转 DOM CustomEvent（`wechat-events.ts`）；壳/引导/同意/授权四屏 + 数据面板 |
| 附属窗口 | `src/backend/browser-handoff.js` / `handoff-preload.js` | 手机交接卡片独立窗口 + 473 B 独立 preload，与主 IPC 桥隔离（`main.js:407-420`） |
| 手机端 HTTP | `src/backend/http-server.js` | 与桌面 IPC 共用同一道 `gatedWechatCall` 与同一把 `createCallQueue`（`main.js:361-400`） |

## 2. 构建链（`npm run build:all` 三步）

| 步 | 命令/脚本 | 输入 → 输出 | 门禁 |
|---|---|---|---|
| 1 后端 bundle | `node scripts/build-wechat-bundle.js`（`package.json:14`） | `wechat-data/src/index.ts` + `net/fetch-retry.ts` → `lib/index.js`（1884.9 KB）+ `lib/net/fetch-retry.js`（≈3 KB）。esbuild ESM/node22/`packages:external`，TC39 装饰器语义（`build-wechat-bundle.js:71-91`） | `npm run check:backend` 临时目录重建后逐字节比对（`docs/ARCHITECTURE.md:189`） |
| 2 类型 | `node scripts/build-types.js`（`package.json:15`） | 清空后 `tsc -p tsconfig.types.json` → `lib/types/**`（`build-types.js:35-44`） | `npm run check:types` |
| 3 前端 | `vite build`（`package.json:13`） | root `src/client/ui-app`，outDir `src/client/ui-dist`，target chrome120（`vite.config.js:16-33`） | `build:ui` + `check:shim`；CSS/交互/主题/响应式另有 8 个 ui 门禁 |
| 打包 | `npm run pack` / `dist` | electron-builder NSIS x64（`package.json:79-80,241-258`）；`files` 白名单（`:177-223`），`asarUnpack` = koffi/onnx/原生/资源/whisper（`:225-233`），fuses 全收紧（`:234-240`） | `nightly.yml` 的 `pack → package:smoke` |

产物实测：`lib/index.js` 1884.9 KB；`ui-dist` 4.42 MB/248 文件（JS 2222.6 KB/60、CSS 673.3 KB/35、webp 601.5 KB/4、png 921.5 KB/148、html 5.6 KB）；`win-unpacked` 530.9 MB/553 文件；安装包 189.42 MB。

## 3. 依赖分层

```
main.js + src/backend/*.js（宿主层，CommonJS，手写 .d.ts）  src/license/**
      │ 只向下依赖（layer-direction.spec.ts 机检，ARCHITECTURE.md:48-62）
      ├─ src/backend/wechat-data/lib/**（ESM bundle）→ src/query/**、src/keys/**、src/query/retrieval/**
      ├─ src/backend/deps/**（17 个 vendor 包，file: 依赖；PROVENANCE.json 记版本+sha256）
      └─ electron / electron-updater（主进程）
src/client/**（ESM + React，devDependencies 只在构建期，运行期打进 ui-dist）
src/shared/llm-defaults.json（唯一共享文件）
```

- vendor 依赖 17 个：koffi/@koromix（原生，asarUnpack，`koffi.node` 1018.5 KB）、onnxruntime-node（27.4 MB DLL）、zod（717 文件 4.45 MB，含 168 个 `.test.ts`）、dsh-llm/cordis/typert-protocol 等；`deps/PROVENANCE.json` + `check:deps-provenance` 防静默漂移（`src/backend/README.md:49-60`）。
- 前端依赖：React 18、Radix、TanStack Table/Virtual、ECharts、graphology-forceatlas2（`package.json:133-162`）；`dedupe:['react','react-dom']` 防双 React 黑屏（`vite.config.js:51-61`）。

## 4. 业务模块清单

**前端（`src/client/ui-wechat/src` 共 381 ts + 173 tsx + 77 css；数据面板在其 `pages/wechat-data/`）**
- 侧栏 5 组：概览·问答·总结 / 会话与消息 / 关系与社交 / 资产与资金 / 行动与维护；14 个可见入口（数据总览、微信问答、总结、聊天会话、群聊分析、通讯录、朋友圈、知识库、收藏与表情、文件与存储、资金往来、待办日程、操作日志、设置），`WechatTab` 联合类型实测 **39 个**（14 可见 + 24 隐藏 + settings；`nav-config.ts:29-33,59-256`）。
- 面板分片：`chats-*`、`graph-*`、`world-map-*`、`overview-*`、`settings-*`、`moments-*`、`kb-*`、`clawbot-*` 等（`docs/ARCHITECTURE.md:171-182`）；壳/引导/同意/授权在 `src/client/ui-app/`。
- 状态/取数：`api-*.ts` 拆 10 个域文件（config/core/read/media/search/kb/export-ops/task-center/clawbot/status）；`cache.ts` 的 `cachedFetch` SWR；`panels/hooks.tsx` 分页/懒加载（`useLazySentinel` 在 `:90`）；消息流/收藏/文件/朋友圈四处虚拟化（`ARCHITECTURE.md:179-182`）。

**后端查询域（`wechat-data/src/query/` 149 文件 + `remotes/` 23 文件 + `gateway*.ts` 19 文件 / 214 Remote）**

| 域 | 代表文件（域内文件数） | 说明 |
|---|---|---|
| 消息/会话/搜索 | `messages.ts`、`sessions.ts`、`search-*.ts`(4)+`search.ts`、`unified-search.ts`、`records.ts` | shardCatalog + FTS5 + 分页；排序覆盖索引见 measure MSG_PAGE |
| 媒体图片/视频/音频 | `media-image*.ts`、`media-video.ts`、`media-voice.ts`、`sns-*.ts`(7)、`remote-image.ts`、`article-cover.ts`、`image-*.ts`(6) | decoded_images 落盘缓存 + 本机优先 + CDN 兜底 |
| 解密/同步 | `decrypt-*.ts`(2)、`sync-*.ts`(9)+`sync.ts`、`sqlcipher-*.ts`(2) | 增量解密 + sync-state.json 签名账（ARCHITECTURE.md:136-151） |
| 分析/报告 | `overview*.ts`、`annual-*.ts`(6)+`annual.ts`、`group-insights.ts`、`wordcloud.ts`、`graph.ts` | 大多数走 `cachedBySigAsync` + 30s~TTL |
| 知识库/RAG/LLM | `kb-*.ts`(8)、`query/kb/*`、`query/retrieval/*`、`ask.ts`、`ask-history.ts`、`embed-cache.ts` | 向量库 + FTS + LLM 桥（`llm-http.js` 唯一出网传输） |
| 导出/备份/运维 | `export*.ts`(5)、`backup.ts`、`db-health.ts`、`db-repair.ts`、`operation-log.ts`、`privacy*.ts`(2)、`storage.ts` | 长任务 + 取消 + 审计 |
| 任务中心/ClawBot | `task-center*.ts`(3)、`wechat-tasks.ts`、`query/clawbot/*`、`remotes/clawbot.ts` | 关键词触发任务、实例管理 |
| 语音 | `voice*.ts`、`whisper.ts`、`voice-transcribe.ts` | whisper-cli 异步 spawn（`voice-transcribe.ts:126-134`） |

## 5. 资源清单（在哪、多大、谁加载）

| 资源 | 位置/大小 | 加载方 |
|---|---|---|
| 前端主包/按需 chunk | `ui-dist/assets/*.js` 2222.6 KB / 60 chunk（最大 installCanvasRenderer 441.6 KB、index 354.2 KB） | `ui-dist/index.html:19-20` 先加载 index.js+css；31 个面板 `React.lazy` 按 tab 拉（panel-loaders.tsx） |
| CSS | `ui-dist/assets/*.css` 673.3 KB / 35（index 241.7 KB，主题令牌 `scifi-theme.css` 50.8 KB） | 入口 CSS 首屏同步；面板 CSS 随 chunk 按需 |
| 表情 PNG | `ui-dist/wxemoji` 921.5 KB / 148 | `wechat-emojis.ts:862` 拼相对路径，消息里的 `<img loading="lazy">`（`utils/message-text.tsx:201`）按需 |
| 引导背景 webp | `ui-dist/onboarding/bg-stage-{0..3}.webp` 601.5 KB / 4 | **全仓 grep 无引用**（源码三份 onboarding CSS 无 `url()`，也无 `bg-stage` 字面量）；`first-impressions-tokens.spec.ts:54` 记"2026-10-19 背景层删除" → 疑似遗留死资源 |
| 应用图标 | `build/icon.ico`（0.4 MB build/ 共 3 文件） | 打包烘进 exe；dev 由 `main-window.js:56,86` 读 |
| whisper 引擎/模型 | `wechat/whisper/ggml-tiny.bin` 74.1 MB + `bin/` 13 个 DLL/EXE 约 9.5 MB；asarUnpack（`package.json:225-233`） | 转写时 `spawn whisper-cli`（`voice-transcribe.ts:133-134`），模型支持下载/换目录（`whisper.ts:35,543-604`） |
| 原生 wasm/dll | `wechat-data/native` 3.8 MB（wasm_video_decode.wasm 3.7 MB）、`img_helper.dll` 22.5 KB；asarUnpack | 视频解码/头像辅助（`native/**` 在 unpack 列表） |
| 区域码表等 | `wechat-data/resources` 3.81 MB / 366 文件（world.zh.json 301.2 KB 等） | 后端 bundle 运行时查找 |
| 分发资源 | win-unpacked 530.9 MB / 553；setup exe 189.42 MB | 安装包；asar 42.5 MB |
| 远程/CDN 资源 | 无直连：渲染层 CSP 只放行 `wechat-media:` / data: / file:（`ui-dist/index.html:16-17`）；远程图/地图统一后端代理（`ARCHITECTURE.md:127-135`） | `query/remote-image.ts`、`query/map-geo.ts` |
| 字体 | **无**（0 个 woff/ttf/otf、0 条 `@font-face`） | 系统字体 |

## 6. 测试体系

- **单测/契约**：645 个 `*.spec.ts`（wechat-data/tests 255、backend/tests 115、ui-wechat 245、ui-app 9、deps 21），vitest 收集其中 624 个（`vitest.config.ts:51-62`）；`fileParallelism:true`，本机超时 180 s，CI `maxWorkers:1`（`:82-83,109`）；报告器额外打印最慢文件/用例榜（`:17-37`）。
- **命名纪律**：`*.wiring.spec.ts` 118 个（"接上了"），`*.guard.spec.ts` 4 个，`*.measure.spec.ts` 19 个（默认 skip，靠门控变量跑）。
- **性能基准**：`scripts/run-measures.mjs` 19 项 = 18 quick（约 27 s）+ 1 slow（export-memory 801.5 s，脚本头 `:20-32`）；`npm run measure:quick/slow`（`package.json:67-69`）。
- **e2e/审计脚本**：scripts 顶层 116 文件，75 个 `.mjs`：e2e 12（longlist 虚拟化、loading 恢复、ledger 重载、导出/备份进度等）、audit/acceptance 10、gate/budget/diff 8（interactive-budget、theme-budget、responsive/density gate、css:bundle-diff）、smoke 12、SSR 冒烟 5 个 tsx、其余 CI/一致性/工具。
- **CI**：`.github/workflows/ci.yml`（typecheck→产物一致性→docs:api:check→build:ui→lint→deps-provenance→measure:quick→e2e/长列表/mutation diff）、`nightly.yml`（mutation、measure:slow、pack+package:smoke）、`release.yml`（打包签名发布）、`pages.yml`。

## 7. 关键性能机制坐标（先复用，再改造）

- 后端缓存：`query/meta.ts:58`（`cachedBySig`/`cachedBySigAsync` 唯一入口，生产代码不许直接动 Map）；前端 SWR：`pages/wechat-data/cache.ts:74`。
- 图片：`wechat-media://` 协议（`main.js:15-18,337-338`；`src/backend/media-protocol.js:45-117`，`Cache-Control: no-store` 在 `:109`）；解码缓存目录 `decoded_images/<username>/<md5>.<ext>`（`query/media-image.ts:5-6`）；远程图 data URL 内存层按条数封顶 300（`query/remote-image.ts:90-117`，大对象未按字节限）。
- 让出：`ARCHITECTURE.md:155-169`（`yieldToLoop` 三档预算、探针 `query-yield-discipline.spec.ts`）。
- 背压：`src/backend/http-queue.js:36-58`（并发 2、排队 32、重活排队 4、等待 240 s）。
- 前端分页/虚拟化：`panels/hooks.tsx:90`（`useLazySentinel` rootMargin 600px）、`usePagedList`；虚拟列表 e2e `scripts/longlist-virtualization-e2e.mjs`。
- 内存观测：`src/backend/worker-mem-sentinel.js:25-30`（60 s 采样，1.2 GB、连续 3 次才 warn，只告警不重启）。
- 启动：`main.js:523-530`（先窗后后端）；`query/startup-prewarm.ts:1-22`（`setImmediate` 预热，不抢写闸）。

## 8. 与共享简报的偏差（会影响优化方案的 4 处）

1. **`query/cdn-policy.ts` 已不存在**：2026-09-30 出网开关整体移除（`CHANGELOG.md:1077`、`query/gateway-privacy.ts:4-6`），并有反向守卫「该文件必须不存在」（`tests/gateway-privacy-gate.spec.ts:76-79`）。简报 §4 的"唯一口径"已失效；现口径是 `privacyGate` 只做脱敏+审计，出网按 `fetch(` 调用点台账登记（`src/backend/tests/outbound-site-coverage.spec.ts`）。
2. **后端 bundle 是 1884.9 KB 不是 783 KB**：`main.js:524` 的注释（"import 783KB 的 bundle"）是旧值，冷启动量级应按 ~1.9 MB + typert 197.6 KB 估。
3. **813 个 spec 的组成**：645 本仓 `.spec.ts` + 168 个 vendored zod `.test.ts`；vitest 实收集 624 个。别把 zod 测试算进本仓测试规模。
4. **tab 计数口径**：`src/client/README.md:33` 写"可路由页签 38"，`nav-config.ts:29-33` 实测联合类型 39 个（clawbot 后加未更新）；14 个可见侧栏入口不变。写方案时以代码实测为准。

## 9. 给优化方案的建议（按价值排序）

| 序 | 建议 | 依据/预估 | 风险 |
|---|---|---|---|
| 1 | **先量化三处内存/启动大头**：worker RSS（哨兵已有）、renderer 各面板堆（31 个 lazy chunk）、主进程 decoded 缓存 | 哨兵每 60 s 已有数据；`measure:quick` 18 项 27 s 可作回归门 | 低（只观测） |
| 2 | **清死资源、压首包**：删 4 张未引用 webp（601.5 KB）+ 核对 wxemoji 是否可合并体积；ui-dist 首包 JS 354.2 KB + CSS 241.7 KB 可继续切 | 实测 + grep 无引用；删文件不改业务 | 低（需确认没有动态拼接路径） |
| 3 | **媒体链路只做"少拷贝/少读盘"**：`wechat-media://` 已去掉 base64 双份；下一步量 `Cache-Control: no-store` 对重复图片的影响，评估 ETag/immutable（需自定义协议补 header） | `media-protocol.js:107-110`；不改变渲染结果 | 中（协议缓存语义） |
| 4 | **长列表/大面板的"不可见不发"再收紧**：`usePagedList` 已有节流；用 longlist e2e + interactive-budget 定基准后调 rootMargin/批量大小 | `hooks.tsx:90`、`ui:longlist-e2e` | 低 |
| 5 | **启动期让后端 init 更早/更省**：当前窗口先出，但 worker init 串行加载 1.9 MB bundle + typert + 预热；可测「init 各段耗时」再决定是否拆 bundle/延迟 typert 校验 | `wechat-host.js:240-276`、`startup-prewarm.ts` | 中（后端契约） |
| 6 | **安装包磁盘体积**：530.9 MB 里 whisper 74.1 MB / Electron 234.7 MB / onnx 27.4 MB；whisper 已有下载能力，可评估"装包不带模型" | 实测；`whisper.ts:35,543-604` | 中（产品/离线体验） |
| 7 | **把 measure 基线与 CI 门禁对齐**：18 quick 已进 CI；建议把"内存/首屏"两项补成可对比数字（当前只有耗时） | `run-measures.mjs`、`ci:baseline` | 低 |

> 详细测量命令与输出摘要：`working/perf/project-map/raw-measurements.md`。
