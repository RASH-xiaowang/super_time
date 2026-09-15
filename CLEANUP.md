# 项目冗余清理记录

> ## ⚠️ 本文已过期（2026-09-15 核对，见 `docs/RELEASE-PLAN.md` 的 L16）
>
> 这是 2026-09-12 那次清理的**历史记录**，不要把它当现状。核对出的具体出入：
>
> | 本文的说法 | 现状 |
> |---|---|
> | 「保留的运行时结构」含 `renderer.js` / `styles.css`（演示页回退） | 这两个文件**已不存在**，演示页只剩 `src/index.html`（主进程 `uiEntryHtml()` 的兜底仍指它） |
> | 第 8 节：「移除 package.json 死脚本 83 条」 | 计数口径已变：本轮 `scripts/` 下有 26 个文件，`check:*` / `*:smoke` / `license-*` 等**又新增了一批**（且都进了 CI），不是「只保留 start/dev/build:ui/check:shim/pack/dist」那五个 |
> | 打包布局（隐含 asar 含全部 `src/**`） | M19 之后 `src/backend/deps/**`、`src/**/*.ts`、`src/client/ui-app/**` 已被排除（asar 45.93MB → 23.4MB）；H15/N19 又把 `native/**`、`resources/**` 加进 `asarUnpack` |
> | 未提及 | `.gitignore` 后来补了 `.tmp-*`、`*.orig`、`*.tsbuildinfo`、`*.partial-*`、`wechat/*.json`（H1/H2/M1/M2/M3） |
>
> 需要「当前保留什么、删了什么」的权威口径，请看：`package.json` 的 `build.files`/`asarUnpack`、
> `docs/RELEASE-PLAN.md`（逐条状态与证据）、`src/backend/README.md`（后端目录职责）。

日期：2026-09-12

## 保留的运行时结构（未改动）

| 路径 | 作用 |
|---|---|
| `main.js` / `preload.js` | Electron 主进程 / 预加载 |
| `src/client/ui-app/` + `src/client/ui-wechat/src/` + `src/client/ui-primitives-shim/` | Vite 源码，构建到 `ui-dist` |
| `src/client/ui-dist/` | 主进程实际加载的前端产物 |
| `src/index.html` + `renderer.js` + `styles.css` | 演示页回退（`ui-dist` 缺失时） |
| `src/backend/wechat-data/lib/` | 后端运行时入口（`wechat-host.js` 动态 import） |
| `src/backend/wechat-data/resources/` | 区域映射 JSON + `wx_silk` 解码器 |
| `src/backend/deps/**` | 本地 vendored 依赖（运行时解析 `lib/`） |
| `wechat/whisper/bin/whisper-cli.exe` + DLL + `ggml-tiny.bin` | 语音转写引擎 |
| `build/icon.ico` 等 | 应用图标 |
| `SuperTime.cmd` | 当前启动器 |

## 已删除内容及原因

### 1. 上游预构建产物（约 10.1 MB）

- **`src/client/ui-wechat/lib/`**
  - 原因：上游 CJS 打包产物。本项目 Vite 从 `ui-wechat/src` 源码构建，`ui-entry.tsx` 用相对路径 import 源文件，不经过该 `lib`。

### 2. 完整 UI 原语库（约 2.5 MB）

- **`src/client/ui-primitives/`**（含 src/lib/tests）
  - 原因：`package.json` 实际依赖是 `file:src/client/ui-primitives-shim`；业务代码只 import Button/Input/Pill/StateDot/图标。完整库（markdown/katex/shiki 等）从未被本应用引用。

### 3. 损坏的上游构建配置

- **`src/client/ui-wechat/tsdown.config.ts`**
  - 原因：`import '../tsdown.client.ts'` 指向不存在的文件，仅为上游 monorepo 工具残留。

### 4. 重复的后端资源（约 0.55 MB）

- **`src/backend/resources/`**（`contact-region-lookup.json` + `wx_silk.exe`）
  - 原因：与 `src/backend/wechat-data/resources/` 逐字节相同。运行时解析优先命中 `wechat-data/resources`，本副本只是冗余备份。

### 5. 一次性构建辅助脚本

- `build/make-icon.py` — 已生成图标后不再需要
- `build/patch-emoticon-remote.py` — 一次性补丁脚本
- `build/rename-wechat-plus.py` — 一次性重命名脚本
- `build/verify-emoticon-remote.mjs` — 一次性校验脚本

### 6. 被取代的启动器

- **`start-app.cmd`**
  - 原因：由更新的 `SuperTime.cmd` 取代（ASCII-only，规避代码页问题）。

### 7. whisper.cpp 非转写工具（约 14.7 MB）

仅保留 `whisper-cli.exe` 转写路径所需文件。已删除：

- 测试：`test-*.exe`（7 个）
- 基准：`bench.exe`、`whisper-bench.exe`
- 服务/流：`whisper-server.exe`、`whisper-stream.exe`、`stream.exe`
- LLM/棋类等：`llama.dll`、`whisper-talk-llama.exe`、`wchess.exe`、`main.exe`、`command.exe`
- Parakeet 语音：`parakeet.dll`、`parakeet-cli.exe`、`parakeet-quantize.exe`
- 其它 CLI：`whisper-command.exe`、`whisper-lsp.exe`、`whisper-quantize.exe`、`whisper-vad-speech-segments.exe`
- 音频采集（whisper-cli 文件转写不需要）：`SDL2.dll`

保留：`whisper-cli.exe`、`whisper.dll`、`ggml.dll`、`ggml-base.dll`、全部 `ggml-cpu-*.dll`。

### 8. package.json 死脚本（83 条）

移除所有指向已不存在的 `scripts/*.js` 的 `check:*` / `audit:*` / `smoke:*` / `verify:*` 等条目。保留：

- `start` / `dev` / `prestart` / `build:ui`
- `check:shim`
- `pack` / `dist`

## 验证结果

| 检查 | 结果 |
|---|---|
| `npm run build:ui`（shim 同步 + vite build） | 通过（804 modules） |
| `import('./src/backend/wechat-data/lib/index.js')` | 通过，导出 `WechatDataGateway` |
| `wechat-paths` / `llm-model-catalog` / typert-protocol 加载 | 通过 |
| `whisper-cli.exe` + 必要 DLL + `ggml-tiny.bin` | 仍在 |
| `wechat-data/resources` 区域映射与 `wx_silk` | 仍在 |
| Electron 启动 | 单实例锁正常拦截重复启动（已有运行中实例） |

## 估算释放空间

约 **28 MB**（含 whisper 多余二进制、ui-wechat/lib、ui-primitives、重复 resources）。
