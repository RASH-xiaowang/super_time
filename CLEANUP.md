# 项目冗余清理记录

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
