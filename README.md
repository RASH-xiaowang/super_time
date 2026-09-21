# Super Time

把**本机**微信数据变成可检索、可分析、可导出的工作台。Electron + React 桌面应用，
数据全部在本机解析与存储；只有在你启用 AI 功能时，检索到的片段才会发给你自己配置的模型。

- **平台**：Windows 10/11 **x64**（唯一支持的目标，理由见 [`src/backend/README.md`](src/backend/README.md)）
- **许可**：MIT（[`LICENSE`](LICENSE)）；随包第三方资产见 [`src/backend/VENDORED-LICENSES.md`](src/backend/VENDORED-LICENSES.md)
- **隐私**：先读 [`docs/PRIVACY.md`](docs/PRIVACY.md) —— 出网点、内存扫描、如何关闭出网都写在那里
- **实施与上线状态**：见 [`docs/RELEASE-PLAN.md`](docs/RELEASE-PLAN.md)（**当前不具备公开发布条件**，未闭环项在该文档里逐条登记）

它**不是**微信客户端替代品：不登录、不发送消息、不修改微信的任何数据，也不连接微信服务器
同步你的聊天记录。它读的是本机已经存在的微信数据文件。

---

## 系统要求

| 项 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Windows 10/11 x64 | 原生依赖（`koffi`、`wx_silk.exe`、whisper 二进制）只有 win32-x64 一份 |
| Node.js | 22.x（CI 用 22） | 构建与本地运行需要；安装版用户不需要 |
| npm | 随 Node | 安装依赖用 |
| 微信 | PC 微信（`Weixin.exe` / `WeChat.exe`）已在本机登录 | 数据源；解析密钥需要它**正在运行** |
| 可选 | whisper 引擎与模型 | 仅语音转写需要，可在应用内下载（会出网） |

## 快速开始

```bash
npm ci            # 安装依赖（含 file: 内联依赖）
npm start         # 构建前端 + 后端 bundle，然后启动应用
```

`npm start` 会自动先跑 `build:ui` 与 `build:backend`，所以不需要手工构建。
开发调试用 `npm run dev`（同样会先构建，再启动 Electron）。

### 首次启动会依次经过三道闸门

1. **启动引导**：四页介绍（首页 / 功能引导 / 使用说明 / 关于），首次必须逐页看完。
2. **授权（License）**：校验本机设备指纹与许可证签名，未导入许可证时业务方法一律被拒。
3. **隐私同意**：首次必须显式勾选同意 [`docs/PRIVACY.md`](docs/PRIVACY.md) 所述的数据边界后才能进入主界面。

### 本地跑起来需要一份许可证

仓库**不含**签发私钥（`vendor-keys/` 已 gitignore）。首次在开发机运行：

```bash
# 1) 生成签发密钥对：写入 vendor-keys/（勿提交），并把公钥同步进 src/license/public-key.js
npm run license-keygen

# 2) 从启动页「导出激活请求」拿到的 activation-request.json 签发
npm run license-issue -- --from-request ./activation-request.json --name "本机" --days 365 --out ./out/license.json

# 3) 回到启动页导入 ./out/license.json
```

也可以直接按设备指纹签发（`--fingerprint <指纹>`）。签发工具还支持
`--edition` / `--seats` / `--features` / `--notes`，完整参数见 [`scripts/license-issue.js`](scripts/license-issue.js)。
`npm run license-smoke` 与 `npm run license-gate:smoke` 覆盖了「签发 → 导入 → 校验」与「无证/过期/伪造一律拒绝」。

## 常用脚本

| 命令 | 作用 |
|---|---|
| `npm start` / `npm run dev` | 构建后启动应用 |
| `npm test` | 单元测试（vitest；不依赖真实微信数据、不联网） |
| `npm run typecheck` | 前后端类型检查（后端用 tsc + `lib/types`，前端只从仓库取类型） |
| `npm run build:ui` / `npm run build:backend` | 分别构建前端静态资源与后端 bundle |
| `npm run pack` / `npm run dist` | 打包目录版 / 生成 NSIS 安装器（都会前置 `build:ui`） |
| `npm run package:smoke` | 启动**打包产物**跑断言（asar 内容、状态落点、语音解码资产、方法数…） |
| `npm run ui:smoke` / `npm run privacy-gate:smoke` | 面板的 SSR 冒烟 / 隐私同意屏的 SSR 断言（未勾选时按钮必须禁用） |
| `npm run rag:check` / `npm run check:knowledge-graph` | 检索层 / 知识图谱后端冒烟 |
| `npm run security-guard:smoke` | 在真实渲染进程里验证开窗与外部导航被拒（打包态加 `:packaged`） |
| `npm run check:backend-restart` | 杀掉后端 worker → 自动重建 → 功能恢复（端到端） |
| `npm run docs:api` / `npm run docs:api:check` | 生成 / 校验 Remote 接口参考（见 [`docs/API.md`](docs/API.md)） |
| `npm run ui:accept` | 人工验收脚本（需要真实数据与许可证，手动运行） |

CI（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）在 windows-latest 上跑上面这套检查，
并额外包含两条**一致性门禁**：后端 bundle / `lib/types` 重建后 `git diff` 必须为空。

## 数据放在哪里

| 目录 | 内容 |
|---|---|
| `<userData>/wechat/` | 运行期状态：`config.json`（路径与非敏感设置镜像）、`llm.json`（模型配置，含 API Key）、`logs/`（诊断日志） |
| `<userData>/wechat-data/` | 数据根：`decrypted/`（解密后的 SQLite）、`decoded_images/`（图片缓存）、检索/笔记/待办等派生库 |
| 数据根下的 `secrets.json` | 微信解密密钥（db/image），原子写 + 仅当前用户可读 |

Windows 上 `<userData>` 为 `%APPDATA%\Super Time`（可用 `SUPERTIME_USER_DATA_DIR` 覆盖，调试用）。
安装目录**只读**：升级/卸载不会带走配置，也不会把本机路径与密钥带到别的机器。
详见 [`docs/PRIVACY.md`](docs/PRIVACY.md)。

## 目录结构

```
main.js                  Electron 主进程：窗口、IPC 分发、授权闸门、后端进程监管
preload.js               contextBridge 暴露面（沙箱下运行）
src/backend/             宿主层：后端进程监管、RPC 超时、配置与路径、安全策略、诊断日志
  wechat-data/           后端包（gateway.ts 是 Remote 方法面）
    src/query/           查询层：消息、会话、朋友圈、导出、备份、隐私体检…
    src/query/retrieval/ RAG 检索层（稀疏 + 稠密）
    src/keys/            微信解密密钥获取（含 win32 进程内存扫描）
    native/              朋友圈视频解密 WASM（随包分发，许可见 PROVENANCE.md）
    resources/           语音解码器 wx_silk.exe（必须解包，不能从 asar 内执行）
  tests/                 宿主层单测（含各类「守卫」用例）
src/client/ui-app/       前端入口、启动引导、授权界面
src/client/ui-wechat/    数据面板（约 40 个视图）
src/license/             授权：指纹、签名校验、许可证解析
tools/license-studio/    许可签发图形工具
scripts/                 构建、打包冒烟、各条 smoke 与校验脚本
docs/                    隐私声明、接口参考、RAG 架构、实施计划
```

## 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/PRIVACY.md`](docs/PRIVACY.md) | 隐私声明：读什么、存哪里、出网点清单、如何关闭出网 |
| [`docs/API.md`](docs/API.md) | Remote 接口参考（由 `gateway.ts` 的 `@Remote` 自动生成） |
| [`docs/RELEASE-PLAN.md`](docs/RELEASE-PLAN.md) | 上线实施计划与逐条状态（含已知缺陷与验收证据） |
| [`docs/rag/RAG-ARCHITECTURE.md`](docs/rag/RAG-ARCHITECTURE.md) | 检索与问答链路 |
| [`src/backend/README.md`](src/backend/README.md) | 宿主层设计、平台支持、密钥存储与保护 |
| [`wechat/README.md`](wechat/README.md) | 配置模板（`config.example.json` / `llm.example.json`） |
| [`CHANGELOG.md`](CHANGELOG.md) | 版本变更与版本策略 |

## 已知限制

- **仅 Windows x64**：mac/Linux 不在支持范围（构建与数据源都不成立）。
- **第三方资产的许可结论**：微信表情原图与朋友圈视频解密 WASM 的再分发许可已取得法务结论
  （**允许随包分发**，2026-09-21，见 [`docs/RELEASE-PLAN.md`](docs/RELEASE-PLAN.md) H13）。
- **密钥获取依赖运行中的微信进程**：应用只读扫描 `Weixin.exe` 进程内存取密钥，
  微信未运行时需手动填写密钥。
- **尚无出网总闸门**：应用内的「禁止 AI 出网」只覆盖 LLM/embedding 调用；
  头像、聊天图片、视频、地图 GeoJSON 与 whisper 下载仍会按需出网，
  [`docs/PRIVACY.md`](docs/PRIVACY.md) 里逐条列明。
- 其余未闭环项（含性能与工程化遗留）逐条登记在 [`docs/RELEASE-PLAN.md`](docs/RELEASE-PLAN.md)。

## 免责声明

本软件与腾讯公司无关联，未获其授权或背书，仅用于处理用户**本人**本机数据的个人/内部场景。
请遵守当地法律与微信用户协议；因使用本软件造成的任何后果由使用者自行承担。
