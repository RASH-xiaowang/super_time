# 项目冗余清理记录

## 2026-09-20 轮：清空本机调试残留与打包产物

分两步。第一步清**工作树里的** gitignore 残留（仓库内容零改动）：工作树 2.6 GB → 998 MB。
两步的改动**当时都还没提交**（那是 2026-09-20 那一刻的快照，不是现状）：那一次工作树
`git status --porcelain` = 226 条（113 `M` / 12 `D` / 101 `??`）；那些改动后来都已入库。

那 12 条 `D` 里只有 11 条是本轮删的。第 12 条 `panels/RetrievalPanel.tsx` **不是本轮删的**，
它是 09-17「检索参数固化」那轮的下线删除（`docs/rag/RAG-ARCHITECTURE.md:342`、
`RELEASE-PLAN.md:1128`），并且有守卫盯着：`scripts/ui-ask-smoke.tsx:152` 断言
`ok(!existsSync(panel), 'RetrievalPanel.tsx 应已删除')` —— 把它 `git checkout` 回来反而会红。

| 删除 | 体量 | 依据 |
|---|---|---|
| `dist/`（`win-unpacked` + 1.0.0~1.0.4 五个 Setup） | 1.5 GB | `release.yml` 在 tag 推送时由 CI 重新构建并上传 GitHub Releases，`website/index.html` 只链向 `releases/latest`；本地这批不是分发副本 |
| `working/`（481 个 `cdp-*.mjs` 探针 + 验收产物） | 75 MB | 仓库内**无任何代码以其为输入**，只有注释里的历史证据引用 |
| `output/`（一次性 probe/verify 脚本、日志、截图、`backup/lib-index.js.bak`） | 83 MB | 同上；其中 `audit3/audit4.mjs` 是搬到 `tools/visual-audit/` 之前的旧副本 |
| `.tmp-e2e/` | 14 MB | `nav-shell-e2e` / `panel-audit` / `overview-layout-audit` 的运行产物，各自 `mkdirSync(recursive)` 重建 |
| 根目录 `.accept.log` 等 7 个点位日志、`.tmp-api-analysis.cjs`、`website/tests/smoke.log`、16 个 `*.tsbuildinfo` | ~60 KB | 零引用；tsbuildinfo 只影响增量编译速度 |

同时修的两处：

- `.gitignore`：`working/shots/` → `working/`。原先只忽略截图子目录，`working/` 整体是
  `?? working/`，一次 `git add -A` 就会把**含真实联系人名的截图**扫进仓库。
- `src/backend/wechat-data/tests/kb-real-samples.spec.ts`：`writeFileSync(cwd/working/…)`
  改成先 `mkdirSync(recursive)`。该测试把 `working/` 当**输出目录**却不建目录，目录不存在即
  ENOENT —— 清空 `working/` 后暴露，全新克隆同样会中。

### 「未被引用的冗余资源」审计（结论：源码图无死模块）

对 `wechat-data/src` 全部 107 个模块按 import  specifier 逐个反查入向引用，另扫
`src/client`、`src/backend/*.js`、`src/license`：仅两例零引用，且**都是误报** ——
`src/license/crypto.js|fingerprint.js|store.js` 被 `service.js:13-16` 以无扩展名 `require` 引用，
`console-safe.js` 被 `main.js:6` 引用，两个 `css-modules.d.ts` 是环境声明（本就不该被 import）。
`invariant.ts` / `query/image-key.ts` 看着像孤儿，实为 Cordis companion 与公开类型面成员
（`lib/types/query/image-key.d.ts` 由 `build:types` 产出），未动。

**删除**（跟踪在册，`git checkout -- build` 可整份还原）：

- `build/_icon_frames/`（10 件，216 KB）—— `report.txt` 自证是**把 `icon.ico` 反解成 PNG** 的
  校验回环产物：帧数据本就在 `icon.ico` 的 7 个 frame 里。生成它的 `build/make-icon.py`
  已在 09-12 那轮删除，全仓对 `frame_*.png` 的唯一引用就是这份报告自己。
- `build/icon.png`（256×256）—— 同尺寸已内嵌于 `icon.ico` 的 `frame[6]`，且零引用。

**保留**：`build/icon.ico`（`package.json:169` 唯一被消费的图标）、`icon-512.png`、`icon-1024.png`
（仅这两个分辨率是 `.ico` 里没有的源图，删了就再也回不去）。

**未删（都不是冗余）**：`wechat/config.json`、`wechat/llm.json`、`vendor-keys/`（运行态与**公钥**；签发私钥自 2026-09-27 起在 `~/.supertime/`，见 P3-10，
已 gitignore；明文密钥仍在 git 历史，见 `docs/RELEASE-PLAN.md` H1）、`.workbuddy/`（本机助手记忆）、
`src/index.html` + `renderer.js` + `styles.css`（`main.js:452` 的兜底路径，且已进打包白名单）、
`src/backend/deps/**` 的 91 个 `.map`（488 KB；deps 内 `lib/*.js` 无一处 `sourceMappingURL`，
确实无人按图索骥，但它们是上游包的逐字节副本，删了会让 vendored 依赖与来源不一致）。

验证：`build:ui`（887 modules）/ `build:backend` / `build:types` / `check:shim` /
`docs:api:check` / `typecheck` 全绿；`vitest run` 回到既有基线 **4 failed / 2096 passed**，
4 项全在 `secure-fs.spec.ts`（Git Bash 的 `whoami` 抢占 `System32\whoami.exe`，非产品缺陷）。
删图标残留后又整体复跑一遍六项门禁 + 全量用例，结果同上（4/2096，未新增失败）。

> ## ⚠️ 以下为 2026-09-12 那次的历史记录，不要当现状
>
> 核对出的具体出入：
>
> | 本文的说法 | 现状 |
> |---|---|
> | 「保留的运行时结构」含 `renderer.js` / `styles.css`（演示页回退） | **这条至今成立**：两个文件都在仓库里，并被 `scripts/package-content-rules.js:66-67` 白名单放行。09-15 补的那句「已不存在」是核对时的误记（`git log --diff-filter=D -- src/renderer.js` 无任何删除记录），本轮已删去 |
> | 第 8 节：「移除 package.json 死脚本 83 条」 | 计数口径已变：`scripts/` 已涨到 31 个文件（09-20 实测），`check:*` / `*:smoke` / `license-*` 等**又新增了一批**（且都进了 CI），不是「只保留 start/dev/build:ui/check:shim/pack/dist」那五个 |
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

## 历史明细（已归档）

「已删除内容及原因 / 验证结果 / 估算释放空间」三段是 2026-09-20 那一轮的记录，
搬到了 [`docs/archive/CLEANUP-2026-09-20.md`](docs/archive/CLEANUP-2026-09-20.md) ——
留在本页会让"当年删了什么"读起来像"现在还能这么删"。
