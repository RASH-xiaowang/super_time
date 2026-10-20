# Super Time

把**本机**微信数据变成可检索、可分析、可导出的工作台。Electron + React 桌面应用，
数据全部在本机解析与存储；只有在你启用 AI 功能时，检索到的片段才会发给你自己配置的模型。

- **平台**：Windows 10/11 **x64**（唯一支持的目标，理由见 [`src/backend/README.md`](src/backend/README.md)）
- **许可**：MIT（[`LICENSE`](LICENSE)）；随包第三方资产见 [`src/backend/VENDORED-LICENSES.md`](src/backend/VENDORED-LICENSES.md)
- **隐私**：先读 [`docs/PRIVACY.md`](docs/PRIVACY.md) —— 出网点、内存扫描、如何关闭出网都写在那里
- **实施与上线状态**：见 [`docs/RELEASE-PLAN.md`](docs/RELEASE-PLAN.md)（阶段 0–4 的高优先级项已闭环；仍未闭环的调查项在该文档里逐条登记，**别照抄本文档里的旧结论**）

它**不是**微信客户端替代品：不登录、不发送消息、不修改微信的任何数据，也不连接微信服务器
同步你的聊天记录。它读的是本机已经存在的微信数据文件。

> **实验功能（默认关闭）：微信原图自动下载。** 设置 → 图片解码里显式打开后，应用会复用
> 上游 WeFlow-X（MIT）的 `img_helper.dll` 注入正在运行的微信，让微信在**接收新图片时**
> 自己下载高清原图（本应用不发请求、不碰凭据；只影响打开之后收到的图片）。
> 会修改微信进程内存，关闭/退出时还原；来源、许可与边界见
> [`docs/PRIVACY.md`](docs/PRIVACY.md) §一.5 与 [`src/backend/VENDORED-LICENSES.md`](src/backend/VENDORED-LICENSES.md)。

---

## 系统要求

| 项 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Windows 10/11 x64 | 原生依赖（`koffi`、`wx_silk.exe`、whisper 二进制）只有 win32-x64 一份 |
| Node.js | 22.x（CI 与发版用 22） | 构建与本地运行需要；安装版用户不需要 |
| npm | 随 Node | 安装依赖用 |
| 网络 | 安装依赖时需要访问 npm registry 与 `cdn.sheetjs.com`（`xlsx` 的 tarball） | 运行期的出网点（LLM、语音模型下载、更新检查、媒体取图等）逐条见 [`docs/PRIVACY.md`](docs/PRIVACY.md) |
| 微信 | PC 微信（`Weixin.exe` / `WeChat.exe`）已在本机登录 | 数据源；解析密钥需要它**正在运行** |
| 语音转写 | 仓库与安装包已带 whisper 引擎与 `ggml-tiny.bin` | 其它模型可在应用内下载（会出网） |

## 快速开始

```bash
npm ci            # 安装依赖（含 file: 内联依赖）
npm start         # 构建前端 + 后端 bundle，然后启动应用
```

`npm start` 会自动先跑 `build:all`（`prestart` 钩子：backend → types → ui），所以不需要手工构建。
开发调试用 `npm run dev`（同样会先构建，再启动 Electron）；`npm run dev:only` 只启动、不构建，适合产物已经是最新的时候。

几条容易踩的点：

- `npm ci` 不会下载 Electron 二进制（`node_modules/electron` 没有 postinstall）。若 `node_modules/electron/dist/electron.exe` 不存在，先执行 `node node_modules/electron/install.js`（CI 里也是这样做的）。
- 仓库根的 `SuperTime.cmd` 只是直接启动**已构建好**的应用，不会先构建：第一次请先跑 `npm start`，或手动执行 `npm run build:all`。
- 环境里若带着 `ELECTRON_RUN_AS_NODE=1`，Electron 会退化成纯 Node 并报 `app` 未定义。`npm start` / `npm run dev` / `npm run dev:only` 与 `SuperTime.cmd` 都会摘掉这个变量（见 [`scripts/launch-app.mjs`](scripts/launch-app.mjs)）；直接写 `electron .` 时需要自己摘。

### 首次启动会依次经过三道闸门

1. **启动引导**：四页介绍（首页 / 功能引导 / 使用说明 / 关于），首次必须逐页看完，之后进入同意站。
2. **隐私同意**：必须显式勾选同意 [`docs/PRIVACY.md`](docs/PRIVACY.md) 所述的数据边界，才能继续往下走；「不同意并退出」会直接退出应用。
3. **授权（License）**：校验本机设备指纹与许可证签名，未导入许可证时业务方法一律被拒。

同意排在授权**之前**是有意的：没有取得同意，就不该先向用户要许可证 —— 反过来排会让
「机器上没有有效许可证」等于「永远看不到同意屏」。这个顺序由 `npm run e2e:h14-consent`
在 CI 里用真实 Electron 逐条钉住（含「不同意并退出」真的退出、同意之后才落到授权站）。

## 本地跑起来需要一份许可证

仓库**不含**签发私钥：私钥默认在 `~/.supertime/license-private.pem`（仓库之外，指到仓库内的路径会被直接拒），
`vendor-keys/` 里只留公钥（该目录已 gitignore）。首次在开发机运行：

```bash
# 1) 生成签发密钥对：私钥写到 ~/.supertime/（仓库之外），公钥同步进 src/license/public-key.js 与 vendor-keys/
npm run license-keygen

# 2) 从启动页「导出激活请求」拿到的 activation-request.json 签发
npm run license-issue -- --from-request ./activation-request.json --name "本机" --days 365 --out ./out/license.json

# 3) 回到启动页导入 ./out/license.json
```

也可以直接按设备指纹签发（`--fingerprint <指纹>`）。签发工具还支持 `--company`、`--edition`、
`--features`、`--min-version`、`--hostname`、`--key`（私钥路径），完整参数见 [`scripts/license-issue.js`](scripts/license-issue.js) 文件头。
`npm run license-smoke` 与 `npm run license-gate:smoke` 覆盖了「签发 → 导入 → 校验」与「无证/过期/伪造一律拒绝」。

## 常用脚本

| 命令 | 作用 |
|---|---|
| `npm start` / `npm run dev` / `npm run dev:only` | 构建后启动 / 构建后启动（开发用）/ 只启动、不构建 |
| `npm test` | 单元测试（vitest；不依赖真实微信数据、不联网） |
| `npm run typecheck` | 类型检查：后端 + 面板（`ui-wechat`）+ **打包入口那一层**（`ui-app`：壳、启动引导、同意屏、授权面板）。五份串在一条脚本里，见 RELEASE-PLAN N31 |
| `npm run build:all` | 按依赖顺序一次构建后端 bundle、后端类型声明和前端静态资源 |
| `npm run build:ui` / `npm run build:backend` / `npm run build:types` | 分别构建前端静态资源、后端 bundle、后端类型声明（`lib/types`） |
| `npm run lint:db` | 后端源码的 DB 连接所有权纪律（ESLint） |
| `npm run check:shim` | 前端原语 shim 的源码与安装副本一致性（仅检查；构建直接 alias 到源码） |
| `npm run pack` / `npm run dist` | 打包目录版 / 生成 NSIS 安装器（都会前置 `build:all`） |
| `npm run package:smoke` | 启动**打包产物**跑断言（asar 内容、状态落点、语音解码资产、方法数…） |
| `npm run ui:loading-e2e` | **真机 e2e**：加载态恢复 |
| `npm run ui:longlist-e2e` | **真机 e2e**：四张长列表（消息流 / 收藏 / 文件网格 / 朋友圈时间线）的 DOM 上界 / 两端可达 / 悬浮日期头 / **滚动帧数**（约 34 秒，在 PR 门禁里） |
| `npm run measure:quick` / `npm run measure:slow` | 性能基准（quick 进 PR 门禁，slow 进 nightly）；各条实测数字写在基准自己的文件头 |
| `npm run check:mutation` / `npm run check:mutation:diff` | 变异自证（全量 / 只跑这次改动波及的）；登记表在 `scripts/mutations-registry*.mjs` |
| `npm run ci:baseline` / `npm run ci:board-history` | 采**本机串行基线** / 查 CI 榜历史并按 A 类（真活）B 类（停顿）判 N36 验收；两条都手动跑 |
| `npm run ui:smoke` / `npm run privacy-gate:smoke` | 面板的 SSR 冒烟 / 隐私同意屏的 SSR 断言（未勾选时按钮必须禁用） |
| `npm run e2e:export-progress` / `npm run e2e:h14-consent` | **真机 e2e**（Playwright 驱动真实 Electron）：导出进度与中止 / 隐私同意先于授权。两条都在 CI 里，都不需要许可证与签发私钥 |
| `npm run e2e:ledger-reload` / `npm run e2e:backup-progress` | **真机 e2e**：台账重载 / 备份进度。两条都在夜间档（nightly）里 |
| `npm run rag:check` / `npm run check:knowledge-graph` | 检索层 / 知识图谱后端冒烟 |
| `npm run security-guard:smoke` | 在真实渲染进程里验证开窗与外部导航被拒（打包态加 `:packaged`） |
| `npm run check:backend-restart` | 杀掉后端 worker → 自动重建 → 功能恢复（端到端） |
| `npm run docs:api` / `npm run docs:api:check` | 生成 / 校验 Remote 接口参考（见 [`docs/API.md`](docs/API.md)） |
| `npm run check:deps-provenance` | `file:` 本地依赖的来源表（`src/backend/deps/PROVENANCE.json`）一致性 |
| `npm run license-studio` | 许可签发 GUI（`tools/license-studio`，Electron 窗口） |
| `npm run ui:accept` | 人工验收脚本（需要真实数据与许可证，手动运行） |
| `npm run theme:live-audit -- --all-tabs` | 真机主题审计**全部 37 个页签**（默认 17 个可见页签） |

CI（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）在 windows-latest 上跑上面这套检查，
并额外包含两条**一致性门禁**：后端 bundle / `lib/types` 重建后 `git diff` 必须为空。

检查分**三档**，口径与逐条成本见 [`scripts/ci-tiers.mjs`](scripts/ci-tiers.mjs)
（由 `src/backend/tests/ci-tiers.spec.ts` 对着 workflow 核对）：

| 档 | 触发 | 内容 |
|---|---|---|
| 1（PR 门禁） | 每次 push / PR（`ci.yml` 的 `verify`） | 类型检查与一致性门禁（产物、接口参考、lint、依赖来源）、18 个快基准（约 27 秒）、起真 Electron 的 e2e 与冒烟、**增量**变异自证 |
| 2（nightly） | 每天 03:17（`nightly.yml`） | **全量**变异自证 + 慢基准（`export-memory`，约 13 分钟）+ 两条真机 e2e + **打包冒烟**（`npm run pack` 之后） |
| 3（发版前） | 打 `v*` tag（`release.yml`） | 发布门禁（类型检查 + `npm test` + tag 与 `package.json` 版本一致）+ 打包态检查，且必须在 `--publish always` **之前** |

`ci.yml` 里还有几条起真 Electron 的检查（如 `security-guard:smoke`、`check:backend-restart`、`e2e:h14-consent`）
没有出现在 `scripts/ci-tiers.mjs` 的 TIER1 表里 —— 以 workflow 文件为准。

一条**明知坏、故意不接进任何一档**的检查记在 `KNOWN_ROT` 里，并有断言禁止把它接进 workflow ——
因为"门禁常红"与"门禁没这条"一样糟，通常的结果是把 `continue-on-error` 打开。
`ui:longlist-e2e` 原先也躺在那里；它唯一的红判据其实只是**夹具每天 10 条导致那个场景永远不可能发生**，
修好之后已毕业进第 1 档（原地留了墓碑，免得下一个人照着过期结论重新规划）。

## 数据放在哪里

| 目录 | 内容 |
|---|---|
| `<userData>/wechat/` | 运行期状态：`config.json`（路径与非敏感设置镜像）、`llm.json`（模型配置与配置集，含 API Key）、`logs/`（诊断日志，轮转） |
| `<userData>/wechat-data/` | 数据根：`decrypted/`（解密后的 SQLite）、`decoded_images/`（图片缓存）、`sync-state.json`（同步签名账）、检索索引 / 知识库 / 任务与摘要等派生库（`wechat_*.db`、`message_edits.db`、`daily_summary.db` 等） |
| 数据根下的 `secrets.json` | 微信解密密钥（db / image），原子写 + 仅当前用户可读；`config.json` 里**不存**密钥 |

`<userData>` 在 Windows 上的位置：

- 安装版：`%APPDATA%\Super Time`（`main.js` 显式隔离，避免吃到开发态或旧版本遗留的数据）；
- 开发态（`npm start` 等）：`%APPDATA%\super-time-electron`（取 `package.json` 的 `name`）；
- 两者都可用环境变量 `SUPERTIME_USER_DATA_DIR` 覆盖（调试用）。

安装目录**只读**：升级/卸载不会带走配置，也不会把本机路径与密钥带到别的机器。
开发态首次启动时，仓库 `wechat/` 下老位置的 `config.json` / `llm.json` 会被迁移到 `<userData>/wechat/`
（`config.json` 只搬 `wechatSettings` 里的非敏感偏好），细节见 [`wechat/README.md`](wechat/README.md)。
更多见 [`docs/PRIVACY.md`](docs/PRIVACY.md)。

## 目录结构

```
main.js                  Electron 主进程：窗口、IPC 分发、授权闸门、后端进程监管
preload.js               contextBridge 暴露面（沙箱下运行）
SuperTime.cmd            直接启动已构建应用的 Windows 启动器（不构建）
src/backend/             宿主层：后端进程监管、RPC 超时、配置与路径、安全策略、诊断日志
  wechat-data/           后端包（gateway.ts 是 Remote 方法面的入口，gateway-*.ts 是按域拆开的网关类）
    src/query/           查询层：消息、会话、朋友圈、导出、备份、隐私体检…
    src/query/retrieval/ RAG 检索层（稀疏 + 稠密）
    src/query/kb/        知识库：文件解析、分块、向量化
    src/remotes/         各域的 @Remote 处理器体（按域拆分）
    src/keys/            微信解密密钥获取（含 win32 进程内存扫描）
    src/config/          config.json / secrets.json（配置与密钥的真源）
    src/laya/            本地决策模型（onnxruntime-node + JS 分词）
    lib/                 后端 bundle（`npm run build:backend` 产物；运行时只加载 lib/index.js）
    native/              朋友圈视频解密 WASM（随包分发，许可见 PROVENANCE.md）
    resources/           区域映射 JSON；`resources/win32/x64/wx_silk.exe` 是语音解码器（必须解包，不能从 asar 内执行）
  tests/                 宿主层单测（含各类「守卫」用例）
src/client/ui-app/       前端入口、启动引导（四页）、隐私同意屏、授权界面
src/client/ui-wechat/    数据面板（panels/ 下 149 个 .tsx 视图）
src/client/ui-primitives-shim/  组件原语的本地 shim（构建时直接读源码）
src/client/ui-dist/      前端构建产物（**不入库**，`.gitignore` 已忽略；`pack`/`dist` 前置 `build:all` 生成后由 `src/**/*` 打进 asar）
src/license/             授权：指纹、签名校验、许可证解析
wechat/                  随包只读资产：语音引擎与预置模型（`wechat/whisper/`）、配置模板（`*.example.json`）
build/                   应用图标（`icon.ico` 供安装包使用）
vendor-keys/             许可证**公钥**（私钥不在仓库里；本目录已 gitignore）
tools/                   laya 模型导出与验证脚本、许可签发 GUI（license-studio）、视觉审计脚本
scripts/                 构建、打包冒烟、各条 smoke 与校验脚本、CI 分档表（ci-tiers.mjs）、变异登记表
website/                 官网单文件（不参与打包；由 .github/workflows/pages.yml 发布）
docs/                    十三份当前有效的文档（见下方索引）
.github/workflows/       CI（ci.yml）、夜间（nightly.yml）、发版（release.yml）、官网（pages.yml）
```

## 文档索引

`docs/` 下只保留**十三份**当前有效的文档。其余阶段性台账（性能逐项验收账、知识库分阶段计划、
代码审计报告、覆盖矩阵等）已随 2026-10-08 的文档精简删除，**原文都在 git 历史里**（见本节末尾的取回方法）。
正在实施的重设计提案按「当届有效」保留一份（当前：全站微信主题改版）；已落地收口的提案（ClawBot 指挥台 v2）
保留为已交付设计记录，上一届之前的原文在 git 历史里。

| 文档 | 内容 |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 架构总览：三个进程、依赖方向、一次调用的完整路径、哪些不变量有机检 |
| [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) | 改这个仓库的规矩：收口链顺序、四件套、棘轮只许变小、判据怎么写 |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | 部署与发布：构建、打包、许可证签发、装完之后怎么验 |
| [`docs/ERROR-CODES.md`](docs/ERROR-CODES.md) | 错误码与错误形状：错误怎么传回来、有哪些机器码、撞上之后该怎么办 |
| [`docs/PRIVACY.md`](docs/PRIVACY.md) | 隐私声明：读什么、存哪里、出网点清单、如何关闭出网 |
| [`docs/API.md`](docs/API.md) | Remote 接口参考（由 `gateway*.ts` 的 `@Remote` 自动生成，`npm run docs:api` 刷新） |
| [`docs/BOOTSTRAP-RESPONSIVE.md`](docs/BOOTSTRAP-RESPONSIVE.md) | 响应式与 Bootstrap 适配：npm 引入方式、栅格/断点规约、五类组件策略、验收清单与审计门禁 |
| [`docs/UI-DENSITY.md`](docs/UI-DENSITY.md) | UI 密度规范：固定内容/空白率指标与目标、卡片与组件紧凑化规则、实施分层与验收清单 |
| [`docs/CARD-SIZE.md`](docs/CARD-SIZE.md) | 卡片尺寸规范：每张卡的宽高上界、卡内滚动、视觉卡例外与全站卡片审计工具 |
| [`docs/UI-WECHAT-REDESIGN-PLAN.md`](docs/UI-WECHAT-REDESIGN-PLAN.md) | 全站 UI 改版方案：微信官方主题定调、设计令牌、界面清单、逐屏改造与验收口径 |
| [`docs/UI-WECHAT-REDESIGN-INVENTORY.md`](docs/UI-WECHAT-REDESIGN-INVENTORY.md) | 全量界面清单：外壳/闸门/侧栏 5 组 15 项与合并分段/主要弹层的逐屏现状与改造建议 |
| [`docs/UI-WECHAT-REDESIGN-CONSTRAINTS.md`](docs/UI-WECHAT-REDESIGN-CONSTRAINTS.md) | 改版约束与门禁：主题令牌、对比度、几何棘轮、聊天皮肤 `--wx-*` 与验证命令序列 |
| [`docs/RELEASE-PLAN.md`](docs/RELEASE-PLAN.md) | 上线实施计划与逐条状态（含已知缺陷与验收证据） |
| [`src/backend/README.md`](src/backend/README.md) | 宿主层设计、平台支持、密钥存储与保护 |
| [`src/backend/wechat-data/README.md`](src/backend/wechat-data/README.md) | 后端包：子目录职责、Remote 方法面的分组、派生库与缓存 |
| [`src/client/README.md`](src/client/README.md) | 数据面板结构、导航注册表真源、测试辅助的落位 |
| [`src/backend/VENDORED-LICENSES.md`](src/backend/VENDORED-LICENSES.md) | 随包第三方资产的许可与来源 |
| [`wechat/README.md`](wechat/README.md) | 配置说明：配置落在哪、`config.json` / `llm.json` 字段、开发态迁移（模板见 `wechat/*.example.json`） |
| [`wechat/whisper/README.md`](wechat/whisper/README.md) | 语音转写引擎与模型的目录约定 |
| [`tools/visual-audit/README.md`](tools/visual-audit/README.md) | 视觉审计脚本的前置条件与用法 |
| [`website/tests/smoke.js`](website/tests/smoke.js) | 官网冒烟脚本（jsdom + 自写 CSS 解释器校验布局） |
| [`CHANGELOG.md`](CHANGELOG.md) | 版本变更与版本策略 |
| [`CLEANUP.md`](CLEANUP.md) | 冗余清理记录：每一轮删了什么、为什么删、验证结果 |

**已删文档的取回**：代码注释、台账与 `CLEANUP.md` 里还会提到一批已经不在仓库中的文档（如 `CODE-AUDIT-2026-09-26`、
`PERF-AUDIT-172`、`PERF-THEME-LEDGER`、`UI-REDESIGN-2026-09-28.md`、`rag/RAG-ARCHITECTURE.md`、`compose/spec/*`、`archive/*`）。
它们的文件名与删除提交都可以查到：

```bash
git log --diff-filter=D --name-only -- docs/     # 列出删过的文档
git show 1c060dd^:docs/<文件名>                    # 取回 2026-10-08 精简时删掉的那批（提交 1c060dd）
```

注释里的 `CODE-AUDIT-2026-09-26 P1-5` 之类编号指向那份审计报告；编号只能对照报告原文，`RELEASE-PLAN.md` 里没有对应条目。

## 已知限制

- **仅 Windows x64**：mac/Linux 不在支持范围（构建与数据源都不成立）。
- **第三方资产的许可结论**：微信表情原图与朋友圈视频解密 WASM 的再分发许可已取得法务结论
  （**允许随包分发**，2026-09-21，见 [`docs/RELEASE-PLAN.md`](docs/RELEASE-PLAN.md) H13）。
- **密钥获取依赖运行中的微信进程**：应用只读扫描 `Weixin.exe` 进程内存取密钥，
  微信未运行时需手动填写密钥。
- **应用内没有任何出网开关**（2026-09-30 起）：此前那批开关（出站拦截、地图底图拦截、
  远端取图与解密方式）已全部移除 —— 同类功能一律允许出网。**媒体类出网点**
  （表情、聊天图片/原图、文章封面、朋友圈封面/视频、卡片与朋友圈的远程图、**头像**）
  一律由后端发出，界面自己不再向任何远程主机要图（页面 CSP 的 `img-src` 只放行本机来源）。
  **要彻底断网只能靠系统防火墙或断网**；每个出网点逐条列在 [`docs/PRIVACY.md`](docs/PRIVACY.md)。
- **已知不通、未接入任何门禁的脚本**：`npm run e2e:export-nonblocking`（选择器腐烂，且导出流程需要原生目录选择器），
  登记在 `scripts/ci-tiers.mjs` 的 `KNOWN_ROT` 里。
- 其余未闭环项（含性能与工程化遗留）逐条登记在 [`docs/RELEASE-PLAN.md`](docs/RELEASE-PLAN.md)。

## 免责声明

本软件与腾讯公司无关联，未获其授权或背书，仅用于处理用户**本人**本机数据的个人/内部场景。
请遵守当地法律与微信用户协议；因使用本软件造成的任何后果由使用者自行承担。
