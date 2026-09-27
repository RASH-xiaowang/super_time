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
2. **隐私同意**：必须显式勾选同意 [`docs/PRIVACY.md`](docs/PRIVACY.md) 所述的数据边界，才能继续往下走。
3. **授权（License）**：校验本机设备指纹与许可证签名，未导入许可证时业务方法一律被拒。

同意排在授权**之前**是有意的：没有取得同意，就不该先向用户要许可证 —— 反过来排会让
「机器上没有有效许可证」等于「永远看不到同意屏」。这个顺序由 `npm run e2e:h14-consent`
在 CI 里用真实 Electron 逐条钉住（含「不同意并退出」真的退出、同意之后才落到授权站）。

### 本地跑起来需要一份许可证

仓库**不含**签发私钥：私钥默认在 `~/.supertime/license-private.pem`（仓库之外，指到仓库内的路径会被直接拒），
`vendor-keys/` 里只留公钥。首次在开发机运行：

```bash
# 1) 生成签发密钥对：私钥写到 ~/.supertime/（仓库之外），公钥同步进 src/license/public-key.js 与 vendor-keys/
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
| `npm run typecheck` | 类型检查：后端 + 面板（`ui-wechat`）+ **打包入口那一层**（`ui-app`：壳、启动页三站、同意屏、授权面板）。三份串在一条脚本里，见 RELEASE-PLAN N31 |
| `npm run build:ui` / `npm run build:backend` | 分别构建前端静态资源与后端 bundle |
| `npm run pack` / `npm run dist` | 打包目录版 / 生成 NSIS 安装器（都会前置 `build:ui`） |
| `npm run package:smoke` | 启动**打包产物**跑断言（asar 内容、状态落点、语音解码资产、方法数…） |
| `npm run ui:smoke` / `npm run privacy-gate:smoke` | 面板的 SSR 冒烟 / 隐私同意屏的 SSR 断言（未勾选时按钮必须禁用） |
| `npm run e2e:export-progress` / `npm run e2e:h14-consent` | **真机 e2e**（Playwright 驱动真实 Electron）：导出进度与中止 / 隐私同意先于授权。两条都在 CI 里，都不需要许可证与签发私钥 |
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
src/client/ui-wechat/    数据面板（panels/ 下 102 个 .tsx 视图）
src/license/             授权：指纹、签名校验、许可证解析
tools/license-studio/    许可签发图形工具
scripts/                 构建、打包冒烟、各条 smoke 与校验脚本
docs/                    隐私声明、接口参考、RAG 架构、实施计划
```

## 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 架构总览：三个进程、依赖方向、一次调用的完整路径、哪些不变量有机检 |
| [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) | 改这个仓库的规矩：收口链顺序、四件套、棘轮只许变小、判据怎么写 |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | 部署与发布：构建、打包、许可证签发、装完之后怎么验 |
| [`docs/ERROR-CODES.md`](docs/ERROR-CODES.md) | 错误码与错误形状：错误怎么传回来、有哪些机器码、撞上之后该怎么办 |
| [`docs/PRIVACY.md`](docs/PRIVACY.md) | 隐私声明：读什么、存哪里、出网点清单、如何关闭出网 |
| [`docs/API.md`](docs/API.md) | Remote 接口参考（由 `gateway.ts` 的 `@Remote` 自动生成） |
| [`docs/RELEASE-PLAN.md`](docs/RELEASE-PLAN.md) | 上线实施计划与逐条状态（含已知缺陷与验收证据） |
| [`docs/rag/RAG-ARCHITECTURE.md`](docs/rag/RAG-ARCHITECTURE.md) | 检索与问答链路：混合召回、重排权重、上下文压缩、评估与反馈闭环 |
| [`docs/CODE-AUDIT-2026-09-26.md`](docs/CODE-AUDIT-2026-09-26.md) | 全面代码审计与整改台账（逐条状态记在「先读这里」） |
| [`docs/KB-RAG-REDESIGN.html`](docs/KB-RAG-REDESIGN.html) | 知识库重设计方案（多库 · 文件解析 · RAG 检索） |
| [`docs/KB-RAG-PLAN.md`](docs/KB-RAG-PLAN.md) | 上面那份设计的分阶段实施计划（阶段任务表与验收） |
| [`docs/KB-COMPLETION-PLAN.md`](docs/KB-COMPLETION-PLAN.md) | 知识库收口计划：目标、范围、逐阶段做什么 |
| [`docs/KB-MULTI-REDESIGN.html`](docs/KB-MULTI-REDESIGN.html) | 多知识库形态设计图（一个入口、多个库、一库一图） |
| [`docs/KB-MODEL-CONFIG.md`](docs/KB-MODEL-CONFIG.md) | 三类模型（向量 / 重排 / 生成）分别配置的方案与调用场景 |
| [`docs/KB-EVAL-BASELINE.md`](docs/KB-EVAL-BASELINE.md) | 检索基线报告：夹具集、怎么跑、改动前后要对哪些数字 |
| [`docs/KB-WEKNORA-GAP.md`](docs/KB-WEKNORA-GAP.md) | 与 WeKnora 的能力差异清单（结论先行 + 按类别归纳） |
| [`docs/GRAPH-KNOWLEDGE-REDESIGN.html`](docs/GRAPH-KNOWLEDGE-REDESIGN.html) | 知识图谱重设计方案（借鉴社交图谱的布局与分层） |
| [`docs/LAYA-TRIAGE-FEASIBILITY.md`](docs/LAYA-TRIAGE-FEASIBILITY.md) | laya 决策引擎接入可行性：目标形态对应 + 三重 PoC 实测 |
| [`docs/WXHOOK-ORIGINAL-IMAGE-EMBED.md`](docs/WXHOOK-ORIGINAL-IMAGE-EMBED.md) | wxhook「获取原图」拆解，以及嵌入本项目的方案与代价 |
| [`docs/PERF-BASELINE.md`](docs/PERF-BASELINE.md) | 加载性能基线：冷跑实测数据、瓶颈定位与优化方案 |
| [`docs/UI-PANELS-PLAN.md`](docs/UI-PANELS-PLAN.md) | 功能界面完善计划（17 个主导航页签的审计结果与逐轮任务） |
| [`docs/UI-GEOMETRY-SPEC.md`](docs/UI-GEOMETRY-SPEC.md) | UI 几何规范：圆角 / 间距 / 布局刻度（令牌值口径，2026-09-25 基线） |
| [`src/backend/README.md`](src/backend/README.md) | 宿主层设计、平台支持、密钥存储与保护 |
| [`wechat/README.md`](wechat/README.md) | 配置模板（`config.example.json` / `llm.example.json`） |
| [`CHANGELOG.md`](CHANGELOG.md) | 版本变更与版本策略 |

## 已知限制

- **仅 Windows x64**：mac/Linux 不在支持范围（构建与数据源都不成立）。
- **第三方资产的许可结论**：微信表情原图与朋友圈视频解密 WASM 的再分发许可已取得法务结论
  （**允许随包分发**，2026-09-21，见 [`docs/RELEASE-PLAN.md`](docs/RELEASE-PLAN.md) H13）。
- **密钥获取依赖运行中的微信进程**：应用只读扫描 `Weixin.exe` 进程内存取密钥，
  微信未运行时需手动填写密钥。
- **出网闸门分两层**：应用内的「禁止 AI 出网」覆盖 LLM/embedding 调用；**媒体类出网点**
  （表情、聊天图片/原图、文章封面、朋友圈封面/视频、卡片与朋友圈的远程图、**头像**）由设置里的
  「自动获取原图（CDN）」单独控制 —— 这些请求一律由后端发出，界面自己不再向任何远程主机要图
  （页面 CSP 的 `img-src` 只放行本机来源）。
  **地图底图 GeoJSON 与语音模型下载目前没有内置开关**，按需出网。
  每个出网点逐条列在 [`docs/PRIVACY.md`](docs/PRIVACY.md)。
- 其余未闭环项（含性能与工程化遗留）逐条登记在 [`docs/RELEASE-PLAN.md`](docs/RELEASE-PLAN.md)。

## 免责声明

本软件与腾讯公司无关联，未获其授权或背书，仅用于处理用户**本人**本机数据的个人/内部场景。
请遵守当地法律与微信用户协议；因使用本软件造成的任何后果由使用者自行承担。
