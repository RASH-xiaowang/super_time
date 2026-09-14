# Super Time 上线实施计划

> 来源：2026-09 全面架构与代码审查（架构分层 / 模块划分 / 依赖关系 / 核心流程 / 代码质量 / 测试覆盖 / 错误处理 / 性能 / 依赖与安全 / UI 体验 / 文档完整度）。
> 用途：**任务计划与实施跟踪**。每个条目都有稳定的 ID、依赖关系与可执行的验收标准。
> 结论基线：**当前不具备上线条件**。高优先级项全部闭环是上线的前置条件。

---

## 一、如何使用本文档

**状态取值**（每个条目详情块中的「状态」字段）：

| 状态 | 含义 |
|---|---|
| `未开始` | 尚未动手 |
| `进行中` | 有人在做，尚未提交 |
| `待验收` | 代码已改完，等待按验收标准复验 |
| `已完成` | 验收标准已逐条通过，并记录了证据 |
| `已延期` | 本轮不做，需注明原因与重排计划 |

**跟踪规则**：

1. 状态变化时，**同时**更新条目详情块的「状态」与本阶段的汇总表，两处必须一致。
2. `待验收 → 已完成` 必须附「验证方式」的实际执行结果（命令 + 输出摘要），不接受「看起来没问题」。
3. 「变更记录」章节（文末）按时间倒序追加，记录谁在何时把哪个 ID 从什么状态改到什么状态。
4. 新增审查发现时，追加新 ID，不要复用旧 ID。

**预估单位**：`d` = 人日。仅用于排序参考，不是承诺。

---

## 二、进度总览

| 阶段 | 目标 | 条目数 | 未开始 | 进行中 | 待验收 | 已完成 |
|---|---|---|---|---|---|---|
| 阶段 0 | 止血：阻断发布的事故级问题 | 2 | 0 | 1 | 0 | 1 |
| 阶段 1 | 可验证性底座 | 3 | 0 | 0 | 0 | 3 |
| 阶段 2 | 合规闸门（并行推进） | 2 | 2 | 0 | 0 | 0 |
| 阶段 3 | 可靠性：超时、恢复、数据安全 | 5 | 0 | 0 | 0 | 5 |
| 阶段 4 | 安全加固与类型底座 | 3 | 0 | 0 | 0 | 3 |
| 阶段 5 | 中优先级：稳定性与性能 | 34 | 24 | 1 | 0 | 9 |
| 阶段 6 | 低优先级：清理与打磨 | 23 | 21 | 1 | 0 | 1 |
| **合计** | | **72** | **47** | **3** | **0** | **22** |

> 维护提示：改动任何条目状态后，请同步更新本表的四个计数与本阶段汇总表。

---

## 三、实施顺序与依赖

阶段 0 与阶段 2 可**立即并行**启动：阶段 2 是法务/合规流程，耗时不可压缩，越早启动越好。阶段 1 必须在阶段 3 之前完成——否则后续所有改动都无法回归验证。

```mermaid
flowchart TD
    A[阶段 0 止血<br/>H1 H2] --> B[阶段 1 可验证性底座<br/>H3 H4 H5]
    A --> C[阶段 2 合规闸门<br/>H13 H14]
    B --> D[阶段 3 可靠性<br/>H6 H7 H8 H9 H12]
    D --> E[阶段 4 安全与类型<br/>H10 H11 H15]
    C --> F{上线门禁}
    E --> F
    F --> G[阶段 5 中优先级<br/>M1–M24]
    G --> H[阶段 6 低优先级<br/>清理项]
```

**关键路径**：H1 → H2 → H3/H4/H5 → H7 → H8/H9 → H10/H11/H15 → 上线门禁。

---

## 四、阶段 0 · 止血（阻断发布）

这两项属于「发布即事故」级别，必须最先处理。H2 完成后，后续所有改动才有稳定的 diff 基线。

### 阶段汇总

| ID | 任务 | 依赖 | 预估 | 状态 |
|---|---|---|---|---|
| H1 | 清除已入库的真实密钥并轮换 | 无 | 0.5d | 进行中（仓库侧完成，待人工轮换 + 重写历史） |
| H2 | 收敛工作区与 HEAD 的脱节 | 无 | 1d | 已完成 |

---

### `[~]` H1 · 真实密钥已被 git 跟踪

- **状态**：进行中（仓库侧已完成；凭据轮换与历史重写待人工决策）　**依赖**：无　**预估**：0.5d
- **证据**：
  - `git ls-files wechat/` 列出 `wechat/config.json` 与 `wechat/llm.json`
  - `git show HEAD:wechat/llm.json` → `apiKey` 为一条真实 DeepSeek Key（形如 `sk-<32 位十六进制>`，此处不复制明文，避免二次泄露）
  - `git show HEAD:wechat/config.json` → `db_enc_key`、`image_aes_key` 明文（同样不复述）
  - **首轮遗漏、本轮补出**：`src/backend/wechat-data/tests/image-key.spec.ts` 有 3 处硬编码了与 config.json **同一个** `image_aes_key` 明文——首轮扫描只匹配 `sk-`/`AKIA`/`BEGIN PRIVATE KEY` 这类模式，漏掉了裸十六进制密钥。已替换为明显的假值（`0123456789abcdef`）
- **风险**：任何拿到仓库（含历史）的人可直接调用该 Key 消耗额度，并用 `db_enc_key` 解密该账号的微信数据库。
- **动作**：
  1. `git rm --cached wechat/config.json wechat/llm.json`
  2. `.gitignore` 追加 `wechat/*.json`（保留 `wechat/README.md`）
  3. 轮换凭据：作废并重发 DeepSeek API Key；重新获取微信 DB key / image key
  4. 清理 git 历史中的这两个文件（`git filter-repo` 或 BFG），并通知所有已克隆该仓库的人重新克隆
  5. 提供 `wechat/llm.example.json` 作为填写模板
- **验收标准**：
  - [ ] fresh clone 后 `wechat/` 下无任何含密钥的文件
  - [ ] `git log --all -p -- wechat/llm.json wechat/config.json | rg 'sk-|db_enc_key'` 无命中
  - [ ] 旧 Key 调用返回 401（已作废）
  - [ ] 应用首次启动引导用户自行填写 LLM 配置
- **备注**：安装包本身是干净的——`package.json` 的 `!wechat/*.json` 排除已生效，asar 中检索不到该串，**无需重新打包**。

---

### `[x]` H2 · 工作区与 HEAD 严重脱节

- **状态**：已完成　**依赖**：无　**预估**：1d
- **证据**：`git status --porcelain` 共 781 项——673 删除、62 修改、46 未跟踪。未跟踪项包含 **`src/license/`、`src/backend/wechat-data/src/query/retrieval/`、`src/client/ui-app/onboarding/`、`src/backend/wechat-data/native/`、`tools/`、全部新脚本**。
- **风险**：fresh clone 会缺少许可模块、RAG 检索层、新手引导、native WASM 解码器，并多出约 12.6MB 已废弃产物。即「仓库里的代码不是能跑的代码」。
- **动作**：
  1. 确认 673 项删除都是 CLEANUP.md 记录的有意清理（已核实：`build/*.py`、`src/client/ui-primitives/**`、`src/backend/resources/**`、whisper 多余 exe）
  2. 补齐 `.gitignore`：`.tmp-*`、`*.orig`、`*.tsbuildinfo`、根目录 `.*.log`
  3. 从 git 移除已入库的构建垃圾：`src/backend/deps/*/lib/tsconfig.tsbuildinfo`、`src/backend/wechat-data/lib/index.js.orig`
  4. `git add -A` 分主题提交（建议 4 个提交：清理产物 / 新增许可模块 / 新增 RAG 检索层 / 新增引导与工具），不要压成一个巨型提交
  5. 确认 `native/` 与 `src/license/` 已入库（前者是 SNS 视频解密的必需资产）
- **验收标准**：
  - [ ] `git status --porcelain` 输出为空
  - [ ] 全新目录 `git clone` → `npm ci` → `npm run build:ui` → `npm start` 应用可启动
  - [ ] 启动后 License 闸门生效（未导入许可时业务调用被拒）
  - [ ] RAG 问答面板可用（验证 `retrieval/` 已入库）
  - [ ] 朋友圈视频可解密播放（验证 `native/` 已入库）
  - [x] `git ls-files | rg 'tsbuildinfo|\.orig$|\.tmp-'` 无命中
- **本轮结果（2026-09-13）**：
  - [x] `git status --porcelain` 为空
  - [x] 关键模块确认已入库：`src/license/service.js`、`query/retrieval/pipeline.ts`、`ui-app/onboarding/OnboardingShell.tsx`、`native/weflow-isaac64/wasm_video_decode.wasm`、`tools/license-studio/main.js`
  - [x] 构建与运行：`build:ui`（822 modules）、`build:backend`（794.7kb）、应用可启动并进主界面
  - [x] 密钥文件与 15 个 tsbuildinfo 均不在索引；`git show HEAD:wechat/llm.json` 报 "exists on disk, but not in 'HEAD'"
  - [ ] **未做**：真正的 `git clone` → `npm ci` 全新环境复核（当前是原地验证；`npm ci` 需联网拉取 vite/electron 等 registry 包）
  - 提交序列（6 个主题提交）：`978f266` 安全出库（**该次误用 `git commit -- <pathspec>`，实际未生效**）→ `cc544b1` 清理废弃产物 687 项 → `89cd02a` 后端 → `b9e5336` 主进程与许可 → `0cb70bb` 前端 → `52660d4` 构建脚本与文档 → `f4d4956` 真正出库（修正 978f266）

---

## 五、阶段 1 · 可验证性底座

**必须先于阶段 3 完成。** 没有测试运行器与 CI，后续任何修复都无法证明没有引入回归。

### 阶段汇总

| ID | 任务 | 依赖 | 预估 | 状态 |
|---|---|---|---|---|
| H3 | 让 36 个测试文件真正可运行 | H2 | 1d | 已完成 |
| H4 | 建立 CI 门禁（含 bundle 一致性校验） | H3 | 1d | 已完成 |
| H5 | 修复验收脚本退出码静默通过 | 无 | 0.5d | 已完成 |

---

### `[x]` H3 · 测试套件完全无法运行

- **状态**：已完成　**依赖**：H2　**预估**：1d
- **证据**：
  - 36 个 spec 全部 `import { describe, expect, it } from 'vitest'`
  - `node_modules/vitest` 不存在；根 / `src/backend/wechat-data` / `src/client/ui-wechat` 三个 `package.json` 均无 vitest 依赖、无 `"test"` 脚本
  - 全仓无 `vitest.config.*`
- **风险**：约 474 处断言的测试资产价值为零。测试本身质量高（用 `mkdtempSync` + `node:sqlite` 造合成库，不依赖真实微信数据），只是跑不起来。
- **动作**：
  1. `npm i -D vitest`，根 `package.json` 加 `"test": "vitest run"`
  2. 加 `vitest.config.ts`，`include` 覆盖 `src/backend/wechat-data/tests/**/*.spec.ts`
  3. 确认 `.ts` 直连 import 能被 vitest 转译（spec 里 import 的是 `../src/*.ts`）
  4. 首次运行后处理失败项：区分「环境问题」与「真实回归」，后者单独开条目
- **验收标准**：
  - [ ] `npm test` 退出码为 0
  - [ ] 收集到 36 个 spec 文件，测试用例数 ≥ 161
  - [ ] CI 与本地结果一致（无「只在本地过」的用例）
  - [ ] `npm test` 在无真实微信数据、无网络的机器上同样通过
- **本轮结果（2026-09-13）**：
  - [x] `npm test` 能跑：36/36 文件收集成功，162 个用例执行
  - [x] 收集数 ≥ 161（实际 162）
  - [ ] **`npm test` 退出码为 0 —— 未达成**：151 通过 / 11 失败（见 N7）
  - 顺带前置了 H11 的 tsconfig 部分：补出根 `tsconfig.base.json`（原缺失、导致 vite/vitest 解析 `extends` 直接抛错），并断掉两处悬空 `references`
  - 环境说明：vitest 需装 `^3`；vitest 5 要求 vite ≥6，本仓库为 vite 5，装最新版会 ERESOLVE

---

### `[x]` H4 · 完全无 CI

- **状态**：已完成　**依赖**：H3　**预估**：1d
- **证据**：无 `.github/workflows`、无 `.gitlab-ci.yml`/`Jenkinsfile`/`.circleci`。`build:backend` 也不在 `dev`/`prestart` 链路中（`package.json:8-12`）。
- **风险**：改 `src/backend/**/*.ts` 后忘记 `npm run build:backend`，运行时静默使用旧 bundle（`scripts/build-wechat-bundle.js:6-10` 已明示此坑）；`lib/index.js` 已入库、已修改，无任何自动校验。
- **动作**：
  1. 建 CI（GitHub Actions），Windows runner（项目为 win32 原生依赖，ubuntu 跑不了 koffi）
  2. 流水线步骤：`npm ci` → `npm run build:backend` → **git diff 必须为空**（bundle 一致性门禁）→ `npm test` → `rag:check` → `ui:smoke` → `check:shim` → `check:sns-video` → `check:whisper-paths` → `license-smoke` → `license-gate-smoke`
  3. 把 `build:backend` 加入 `dev`/`prestart`，或至少加入 `prepack`
  4. 把 `license-gate-smoke.js` 挂进 `package.json`（当前是孤儿脚本）
- **验收标准**：
  - [ ] PR 在任一检查失败时被阻断
  - [ ] 故意改一处 `src/backend/**/*.ts` 不重建 bundle → CI 报失败
  - [ ] 故意让一个测试失败 → CI 报失败
  - [ ] CI 首次全绿，且耗时记录在案

---

### `[x]` H5 · 验收脚本断言失败仍返回 exit 0

- **状态**：已完成　**依赖**：无　**预估**：0.5d
- **证据**：`scripts/ui-acceptance.mjs:985`（`main()` 的 catch 只 `console.error`）、`:989-993`（退出码仅当「配置还原失败」才置 1）。
- **风险**：70 条 UI 断言全部失挂，自动化仍报成功——这是当前最危险的「假绿灯」。
- **动作**：
  1. 断言失败计数 > 0 时置 `process.exitCode = 1`
  2. `stepsOk !== results.length` 同样置 1
  3. `main()` 的 catch 分支置 1 后 rethrow 或退出
- **验收标准**：
  - [ ] 故意破坏一个断言（例如把期望文本改错）→ 脚本 exit code = 1
  - [ ] 全绿时 exit code = 0
  - [ ] CI 中该脚本的失败能阻断合并

---

## 六、阶段 2 · 合规闸门（与阶段 0/1 并行启动）

法务与政策类工作耗时不可压缩，**建议与 H1 同日启动**。

### 阶段汇总

| ID | 任务 | 依赖 | 预估 | 状态 |
|---|---|---|---|---|
| H13 | 解决许可未明的第三方资产 | 无（法务并行） | 外部依赖 | 未开始 |
| H14 | 补齐对外必备文档与隐私声明 | 无 | 2d | 未开始 |

---

### `[ ]` H13 · 许可未明的第三方资产随包分发

- **状态**：未开始　**依赖**：法务确认（外部）　**预估**：外部依赖
- **证据**：
  - `src/backend/wechat-data/native/weflow-isaac64/PROVENANCE.md:33-41` 自述：该 WASM 提取自微信客户端，上游 `THIRD_PARTY_NOTICES.md` 未登记其来源与许可证，**「再分发许可未明确」**——但当前随安装包分发
  - `src/client/ui-app/public/wxemoji/**` 为微信官方表情原图（`Expression_1..105@2x.png` + `new/*.png`），随包分发
- **风险**：公开发布存在侵权与商标风险；这两项是**唯一需要法务介入**的条目。
- **动作**：
  1. 法务评估两处资产的分发合规性
  2. 备选方案 A：取得书面授权
  3. 备选方案 B：改为用户自备（首次使用时引导用户从本机微信客户端目录导入表情资源；SNS 视频解密降级为提示不支持）
  4. 若走方案 B，改造点：`sns-keystream.ts:43`、`utils/wechat-emojis.ts`
- **验收标准**：
  - [ ] 法务书面结论归档（授权书 或 移除确认）
  - [ ] 发布物经扫描确认不含许可未明资产（若走方案 B）
  - [ ] 应用在缺少该资产的机器上给出可读降级提示，而非崩溃
  - [ ] `PROVENANCE.md` 更新为最终结论

---

### `[ ]` H14 · 缺少对外必备文档

- **状态**：未开始　**依赖**：无　**预估**：2d
- **证据**：
  - 无根 `README.md`（项目入口、功能概览、构建/启动说明全部缺失）
  - 无 `LICENSE` 文件（`package.json` 声明 MIT，但仓库内无正文）
  - 无 `CHANGELOG.md`、无安装说明、无用户手册、无 API 参考
  - **无隐私政策**——而本软件读取本地微信数据库，并**扫描 `Weixin.exe` 进程内存**以获取密钥（`keys/service.ts:111` → `win32-memory.ts:123,149`），隐私声明是合规必需
- **动作**：
  1. 补根 `README.md`：项目定位、系统要求、构建与启动、目录结构导航
  2. 补 `LICENSE`（与 `package.json` 的 MIT 声明一致）
  3. 写隐私声明：明确「数据不出本机」的边界、唯一出网点（LLM/embedding 调用）、进程内存扫描的目的与范围、用户如何关闭出网（隐私闸门）
  4. 首次启动加隐私同意流程（可复用现有 `ui-app/onboarding/` 骨架）
  5. 补 `CHANGELOG.md`，定版本策略
  6. 生成 Remote 接口参考（129 个方法）——可从 `@Remote` 装饰器自动生成，避免文档再次漂移
- **验收标准**：
  - [ ] 根目录存在 `README.md`、`LICENSE`、`CHANGELOG.md`
  - [ ] 隐私声明可公开访问，且与实际出网点逐条对应（LLM、embedding、模型列表三处）
  - [ ] 首次启动必须显式同意隐私声明后才能进入主界面
  - [ ] 接口参考列出的方法数与 `gateway.ts` 实际 `@Remote` 数量一致（当前 129）

---

## 七、阶段 3 · 可靠性：超时、恢复、数据安全

前置：阶段 1 已完成。

### 阶段汇总

| ID | 任务 | 依赖 | 预估 | 状态 |
|---|---|---|---|---|
| H6 | 修复 License 闸门 fail-open | 无 | 0.5d | 已完成 |
| H7 | 后端调用加超时 + worker 崩溃重启 | H3 | 2d | 已完成 |
| H8 | 导出改为流式，消除内存峰值与同步阻塞 | H7 | 3d | 已完成 |
| H9 | 搜索与建索引改为游标分批 | H7 | 2d | 已完成（1 项验收未达标 → N9） |
| H12 | 后端 bundle 与源码一致性治理 | H4 | 1d | 已完成 |

---

### `[x]` H6 · License 闸门 fail-open

- **状态**：已完成　**依赖**：无　**预估**：0.5d
- **证据**：`main.js:497-516`——授权检查包在 `try` 内，`catch` 只 `console.warn` 后**继续落到** `return wechatBackend.call(method, args)`（`:512-515`）。
- **风险**：许可 JSON 损坏、`readLicenseFile` 读盘失败、指纹采集异常等任一情况，请求即**无证放行**。授权体系形同虚设。
- **动作**：
  1. `catch` 分支改为 `return { ok: false, error: { code: 'LICENSE_REQUIRED', ... } }`，不再调用后端
  2. 复核 `authorizeCall` 之外是否还有其他绕过路径（当前仅这一处入口，`wechat:call` 是唯一分发点，方向正确）
- **验收标准**：
  - [ ] 构造损坏的 `license.json` → 所有 `wechat:call` 被拒且返回可读中文提示
  - [ ] 无许可证书时全部业务方法被拒（`license-gate-smoke.js` 覆盖）
  - [ ] 正常许可下功能不受影响
  - [ ] 该场景纳入 CI（`H4` 流水线含 `license-gate-smoke`）

---

### `[x]` H7 · 后端调用无超时、worker 无崩溃恢复

- **状态**：已完成（经两轮独立评审，2 critical + 5 major 全部修毕）　**依赖**：H3　**预估**：2d
- **证据**：
  - `main.js:112-120`：`request()` 只有 `seq` 递增与 `pending.set`，**无任何 deadline**。后端个别方法实测 12–21 秒（`getSnsImageDataUrl` 全量扫描），若真卡死则 `pending` 永不 settle，UI 无限转圈
  - `main.js:110`：`child.on('exit')` 仅 `failAll` 置 `deadReason`，**不 respawn**。之后所有调用固定 reject「微信+后端进程已退出」，功能整体失效，需用户重启应用
  - `main.js:483-485`：`init` 失败仅 `console.error`，界面只看到「微信+后端未初始化」
- **动作**：
  1. 每次 `call` 带可配置超时（建议默认 60s，长任务方法如导出/解密/转写单独放宽或走进度轮询）；超时 reject 并从 `pending` 清除
  2. worker 退出后按指数退避重启（建议上限 3 次），重启后重新 `init` 并重放必要的配置
  3. 重启失败时向渲染层推送事件，界面给出可操作提示（而非静默失效）
  4. `init` 失败改为 `dialog.showErrorBox` 或事件推送
  5. 补 `wechat-worker.js` 的 `process.on('uncaughtException')` 兜底（当前 handler 之外的同步异常直接杀进程）
- **验收标准**：
  - [ ] 手动 `taskkill` 后端 worker 进程 → 界面出现错误提示，worker 自动重启，功能恢复
  - [ ] 模拟一个永不返回的调用 → 超时后 UI 解除 loading 并提示，不再无限转圈
  - [ ] 超时不导致后续请求串台（`pending` 无残留）
  - [ ] 连续 3 次重启失败后给出明确人工指引
  - [ ] 正常长任务（导出、解密）不被误杀
- **本轮结果（2026-09-13）**：
  - [x] taskkill 后端 worker → 自动重建 → 功能恢复：`npm run check:backend-restart` **6/6 通过**
    （端到端，真实 Electron + taskkill；已接入 CI）
  - [x] 超时解除等待、不串台：逻辑抽到 `src/backend/backend-rpc.js`，
    由 `src/backend/tests/backend-rpc.spec.ts` **16 项确定性覆盖**
    （永不回包 / 回包晚于超时（迟到回包必须丢弃）/ 中途退出 / 死后调用 / postMessage 抛错）
  - [x] 连续 3 次失败给人工指引：渲染端横幅，已实测（把 init 窗口压到 1ms 造出 failed 态，
    截图确认红条与「请检查 wechat/config.json 与数据目录」逐字一致）
  - [x] init 失败可见：后端启动整体移到 `createWindow()` 之后（原先提示是死代码），
    并**移除阻塞式 `dialog.showErrorBox`** —— 它是模态、无人点击会卡住主进程，
    连 `app.quit()` 都到不了（实测验证脚本因此挂死 5 分钟）
  - 顺带完成 **M20**（首屏被 init 阻塞）：建窗先于后端启动
  - **两轮独立评审**：第一轮报 2 critical + 3 major（无消费者 / 提示死代码 / 陈旧句柄
    误伤 / init 失败泄漏进程 / 双定时器 + 长任务名单漂移），第二轮确认 critical 已解决、
    但指出重排新引入的启动窗口期与「泄漏只修一半」，均已修
  - **已知未覆盖**：就绪闸门的「等待」分支在本机没触发（init 亚秒级完成、快于面板挂载），
    只证明了「没有出现假的未就绪错误」，该分支目前靠代码复核

---

### `[x]` H8 · 导出全量载入内存并同步阻塞

- **状态**：已完成（经独立评审，1 critical + 3 major 已修）　**依赖**：H7　**预估**：3d
- **证据**：
  - `src/backend/wechat-data/src/query/export.ts:715-741`：`exportAllSessions` 对最多 1000 个会话逐个 `collectMessages(..., 0)`（`collectMessages:57-76` 上限 5 万条/会话）并 `formatTxt`，**全部字符串堆进 `entries`** 后才 `zipFiles`
  - `src/backend/wechat-data/src/query/zip.ts:49`：`deflateRawSync` 同步压缩
  - `export.ts:345,347,401,522,634,706,746`：7 处 `writeFileSync` 同步写盘；`formatXlsx:202-234` 用 `cells +=` 拼百万级 XML
- **风险**：最坏情形 1000 × 5 万条 = **数 GB 常驻内存**，并全程阻塞后端事件循环（该进程承载全部 129 个查询方法）。这是性能清单里最严重的一项。
- **动作**：
  1. 改逐会话写入临时文件，或直接流式写入 zip entry
  2. zip 压缩改 `zlib.createDeflate`（流式）替换 `deflateRawSync`
  3. `formatXlsx` 改流式拼接（参考 streaming 模式或分块写 XML）
  4. 全部输出改 temp 文件 + `rename` 原子落地（同时解决 M3 的「半成品文件」）
  5. 导出过程改为可取消 + 进度事件
- **验收标准**：
  - [ ] 导出 1000 个会话时进程内存有明确上界（记录实测峰值，目标 < 500MB，不随会话数线性增长）
  - [ ] 导出期间 UI 保持可交互，其他面板查询不被阻塞超过 1 秒
  - [ ] 中途取消/杀进程不留半成品文件
  - [ ] 输出内容与改造前逐字节一致（用同一数据集比对）
  - [ ] xlsx 导出 10 万行不 OOM
- **本轮结果（2026-09-13）**：
  - [x] 内存有明确上界：`exportAllSessions` 改为逐条目流式写盘（`zip.ts` 新增 `ZipFileWriter`），
    峰值只与**单个条目**相关。实测 240MB 输入时攒内存路径 RSS +738.3MB vs 流式**无可测增长**；
    端到端 150/600/1000 会话（每会话 300 条）为 +0.0 / +86.9 / +36.9MB，**不随会话数线性增长**，
    远低于 500MB 目标 ✅
  - [x] 不阻塞其它查询：20 万条导出期间事件循环最长阻塞 **73ms**（要求 <1 秒）✅
  - [x] 不留半成品：全部写盘点改「temp + rename」原子落地（顺带完成 M3 的导出半）
  - [x] 输出逐字节一致：`ZipFileWriter` 与旧 `zipFiles` 对同组条目**逐字节等价**，
    由 12 项测试覆盖（含同名跳过、STORE/DEFLATE 选择、中文/emoji 名、嵌套、反斜杠、
    65535 条目、3MB 随机块）；端到端另验证确定性与失败不留 `.partial-`
  - [ ] **xlsx 10 万行未验证**：单会话上限 5 万条走不到；且 `formatXlsx` 只把 `cells +=`
    改成数组 join，峰值仍与行数线性（真流式需要 zip 条目级流式 deflate，未做）
  - **评审发现并已修**：① critical —— 写流错误被吞且只等 `drain`，磁盘满时后续写入
    **永久挂起**（Node 出错时先 emit drain 再 emit error）；② moments 媒体上限 off-by-one
    （`>=4999` vs 旧语义 5000）；③ 补上内存与阻塞时长的实测证据
  - **复审（第二轮）**：critical 经注入式实测确认已修好（reject 而非挂起、无 `.partial-` 残留），
    但指出**我的补丁自身引入 2 个 major**，均已修：④ 背压等待的 `once` 监听器不注销会累积
    （1000 会话到千级，触发 `MaxListenersExceededWarning`）→ 改为手写监听 + 统一 cleanup；
    ⑤ `close()` 先置 `closed` 再判 ZIP64，使内部 `abort()` 成空操作（文件残留、句柄泄漏、
    再调 close 还静默成功）→ 调整判定顺序。两处均补了回归测试
  - **教训**：`events.once()` 进 `Promise.race` 后，没赢的监听器不会注销——在按次进入等待的
    长生命周期流上会累积；写「失败即中断」的流式代码时，**先查状态再挂监听**是必须的
    （destroy 的 close/error 可能已先发出，此时 once 永远等不到）
  - **仍未做**（计划动作 2/3/5 的一部分）：单条目仍是同步 deflate（`deflateRawSync`）、
    xlsx 未流式、无取消/进度事件

---

### `[x]` H9 · 搜索与建索引全表物化

- **状态**：已完成（经四轮独立评审；**1 项验收未达标并转记为 N9**）　**依赖**：H7　**预估**：2d
- **证据**：
  - `src/backend/wechat-data/src/query/search.ts:628-651`：`SELECT ... WHERE local_type=1` 后 `.all()` 把整张 Msg_ 表读入内存再 `includes` 过滤；`budget=800_000` 只限制处理量，**物化发生在过滤之前**
  - `search.ts:332-333`：`buildSearchIndex` 对每张 Msg_ 表同样 `.all()` 全量读入
- **风险**：百万级消息下内存峰值极高，且这是搜索与 AI 问答（建索引）的共同路径。
- **动作**：
  1. 改 `db.prepare(...).iterate()` 游标分批处理
  2. 索引构建同样改流式，分批提交
  3. 复核 `messages.ts` 的 `sort_seq + local_id` 复合游标分页能否复用到搜索路径
- **验收标准**：
  - [x] 100 万条消息下搜索的内存占用有上界（记录实测峰值）—— 20 万条实测，见下；百万级为外推
  - [x] 搜索结果与改造前一致（同数据集比对命中集合）—— 第二轮评审用 `git archive` 导出改造前整树做对照，18 组查询 hits/total/indexed 全一致
  - [x] 建索引不再产生秒级事件循环阻塞 —— 常见行长下成立（实测循环内单块 7–97ms）；**超大单行仍有界于「一行 + 一次批量写」**
  - [ ] **搜索可中断：未达标**，原样保留未勾选，并转记为 **N9**
- **本轮结果（2026-09-13 · 首轮）**：
  - [x] 内存有上界：两处 `.all()` 全量物化改为 `node:sqlite` 的 `iterate()`（边读边判、读完即释放）。
    实测 20 万行 × 约 500 字节/条：`.all()` 物化 RSS 峰值 **+345.2MB** vs `iterate` 兜底搜索
    **+13.0MB**（降 26 倍）；照此外推，百万级单会话的 `.all()` 会到 GB 量级
  - [x] 命中集合不变：新增行为等价测试（命中集合 / 容量上限 / 跨让出阈值后完整）
  - [x] 建索引不再秒级阻塞：`buildSearchIndex` 转 async 并周期性让出事件循环；gateway 三处调用点相应 await
- **第二轮评审发现（无 critical，3 条 major，均已处置）**：
  - **major · 让出预算被两处绕过**（`search.ts`）：① 计数器写在 `if (!text) continue` **之后**，
    被跳过的行（图片/系统消息，真实账号里成片出现）两个计数都不涨 —— 实测 30 万条无文本行
    单块 **1097ms 且一次不让出**；② `flush()` 的阈值只有「500 行」，不受字符上界约束，
    64KB/行时单次 flush **3.5s**、1MB/行时 **60.2s**。处置：计量移到 `continue` 之前（并按解码后
    字符数计），新增 `FLUSH_EVERY_CHARS`（1<<16）给批量写入设上界，同时把 `YIELD_EVERY_CHARS`
    从 1<<20 收紧到 1<<17（原先中文实测单块已到 237–533ms，属秒级临界）。
    **处置后实测**：700 行 × 2.1 万汉字/行，循环内单块 **32ms**（去掉 flush 上界则 863ms，
    去掉「跳过的行计次」则 0 次让出）
  - **major · 重建窗口内读侧静默降级**：DDL/DELETE 原本在 `BEGIN` **之前**各自 autocommit，
    于是 force 重建期间 `getSearchIndexStatus` 报 `ready:false`、`searchIndexBatch` 返回空、
    `searchIndexMessages` 静默退化成 LIKE 全表扫描（每次再阻塞 0.4–0.5s）；重建中途失败还会把
    已有索引留成空表。处置：DDL/DELETE 挪进事务 + 索引库开 `PRAGMA journal_mode = WAL`。
    实测依据：delete 模式下写事务一旦溢出页缓存（约 1.75MB）就持 EXCLUSIVE 到 COMMIT，
    读者整段被拒；WAL 下读者 0 次被拒。**旁路文件 + rename 原子替换这条路走不通**：
    Windows 上读者持有文件时 `rename` 直接失败（实测 `EPERM`/`EBUSY`，取决于句柄类型与时机）。
    转成回归测试：6000 行夹具，重建窗口内反复探测，要求每次都仍读到旧索引
  - **major · 单飞闸键控与 `busy_timeout`**：闸原按调用方传入的 `decryptedDir` 字符串键控，
    而争用的是索引文件；同一文件的不同写法（`\` vs `/`、带不带结尾分隔符）会各占一槽、
    并发写同一文件 —— 实测互相撞锁且事件循环停摆 **7.5s**。处置：键改为
    `searchIndexPath(decryptedDir)`，并移除 `busy_timeout`（进程内争用交给闸）
  - **minor 已修**：新常量插在 JSDoc 与函数之间导致 `@param/@returns` 挂错位置；测试里一句
    「覆盖迭代中途 await」不准确（`searchIndexMessages` 是同步函数，不走让出路径）
- **第三轮评审发现（无 critical，4 条 major，均已处置/登记）**：
  - **major · 循环内错误被吞 → 静默产出「部分索引 + 报成功」**：per-shard 的 `catch {}`
    把**一切**错误（含索引写入失败）都当成「跳过这个分片」，于是会 COMMIT 出一个缺行的索引
    并返回 `status:'ok'`。实测在 8000 行夹具第 5000 行注入错误：构建返回
    `ok / rows 4999 / ready:true`，读侧从此**永不重建**（比第二轮修掉的「留成空表」更难发现）。
    处置：把可跳过的 catch **收窄到只包读取**（open / prepare / `iterator.next()`），索引写入
    （`flush`）留在外面 —— 写失败向上抛并 ROLLBACK，旧索引完整保留。读取侧跳过仍是有意容错，
    但不再静默：计入结果 `message` 并打 stderr。新增用例：塞一个非 SQLite 的假分片 →
    构建仍 ok、好分片照常入库、`message` 含「已跳过」
  - **major · WAL 使主库可能落后整整一代**：有并发读者（哪怕只持一个旧读标记）时，
    重建成功后新数据全在 `-wal` 里、主库仍是旧内容；而 `dirs.ts` 的 bootstrap 正是
    「拷 `wechat_search.db`、跳过 `-wal/-shm`」→ 拷出来的索引**静默回退一代**。
    处置：COMMIT 后尽力 `PRAGMA wal_checkpoint(TRUNCATE)`（有读者时拿不到锁会跳过）；
    残余情形（拷贝发生在有并发读者期间）登记为 **N11**。另实测：无读者时 close 即清理干净；
    崩溃残留（`-wal` 51MB + `-shm`）不影响只读可用性，下一次读写开合即清掉
  - **major · 收尾不受让出预算约束**：末次 flush + COMMIT + `COUNT(*)` + meta 写 + close
    是连续同步段。实测 500B/行：收尾 20k→65ms、100k→299ms、200k→504ms、400k→1006ms。
    处置：统计与 meta 写挪进事务（COMMIT 即「新索引 + 版本 + 时间」原子落地，也消掉
    「索引已换但 meta 没写成功」的中间态 —— 这条经第四轮注入实验验证有效）；
    并开 `PRAGMA synchronous = NORMAL`（索引是可重建的派生数据，不值得为每次 COMMIT 付 fsync）。
    **注意**：`synchronous=NORMAL` 带来的收尾提速**未能复现** —— 第四轮在同一口径下实测
    FULL 与 NORMAL 的差落在 ±300ms 的跑间方差内（200k：651/659/923ms vs 655/675/936ms）。
    收尾的主导项不是那一次 fsync，而是**整次构建的脏页在单个大事务 COMMIT 时一次性落盘**
    （索引 165/328/660MB 分别对应 0.65/0.65/1.37s），400k 行收尾实测 **1.35–1.42s**。
    即这条处置**没有兑现「压住收尾」的目标**；真正能压住它的是「分批 COMMIT + 批间让出」，
    属结构性改动。第三轮提交信息里「100k 299→222ms、200k 504→442ms」是单次测量、不可复现，
    已作废（保留 `synchronous=NORMAL` 是因为它对派生索引的取舍本身合理，不是因为它提速）
  - **major · 数据根不可写时索引连只读都打不开**：WAL 模式持久化在库头里，而只读连接读 WAL 库
    需要 `-shm`/目录的写权限；实测不可写目录下 WAL 库报 `unable to open database file`，
    而同实验的 delete 库正常。此时 `indexReady()` 静默 false → 全链路退化成 LIKE 扫描。
    属**本轮引入的条件性回退**（应用本身就需要可写数据根），登记为遗留限制
  - **文档错误归因已更正**：第二轮把「事件循环停摆 7.5s」归因于 `busy_timeout` **是错的**。
    实测那是旧布局「DDL 在事务外各自 autocommit」的产物：DDL 进事务后写锁冲突走「延迟事务的
    读写升级」路径，压根不调用 busy 处理器（三形态探针 `BEGIN;写` 3341ms / autocommit 写
    3328ms / `BEGIN;读;写` 1ms）。移除 `busy_timeout` 因此只是收尾，不是主因
  - **minor 已修**：`search.ts` 重复的 WAL 注释块；测试注释引用的旧常量 `1<<20`；
    重建窗口用例「探测次数」与「是否降级」两个断言互相遮蔽（已改为先断言未降级）
  - **测试覆盖缺口已补**：① 字符预算**取值**原先没有任何断言（放宽到 1<<20 仍全绿）——
    夹具改卡在「只有字符上界能点亮」的区间（60 行 × 8KB ≈ 48 万字符），并把断言收紧到
    「至少 2 次让出」（把常量钉在 ≤24 万字符；放宽到 1<<18 只剩 1 次、1<<19 起为 0 次）；
    ② WAL 开关原先只能间接覆盖 —— 新增独立断言（构建后索引库 `journal_mode` 必须是 `wal`）；
    ③（第四轮补）核心修复的回归覆盖 + 分片中途损坏 + 空分片清单守卫，见上。
    仍然只有弱约束的：`FLUSH_EVERY_CHARS` 的取值（可放宽 32 倍仍绿）
- **评审确认无需改造**：`search.ts` 剩余的 `.all()` 都是 O(会话/联系人) 级元数据表；
  `iterate()` 与 `all()` 逐行等价，`break`/`throw`/未读完直接 `close()` 均安全；
  `lib/index.js` 与 `src/**` 字节级一致（评审用 esbuild 内存重放逐字节比对）；
  `@Remote`/typert schema/`api.ts`/长任务名单均无需改动；WAL 的核心收益可复现
  （delete 模式脏页到 1.73MB 后读者整段被拒，WAL 下 74–155 次探测 0 次被拒）
- **评审新增覆盖缺口（已登记）**：
  - `retrieval/embedding.ts:241-244` 对整张 `message_meta` 做 `.all()`（实测 20 万行 1876ms、
    RSS +271.7MB）→ **N8**。注意 H9 那句「剩余 `.all()` 都是小表」只对 `search.ts` 成立，
    同族还散落在 `group-insights.ts` / `asset-insights.ts` / `privacy.ts` / `*-insights.ts` /
    `embedding.ts` / `notes.ts` / `*-tasks.ts` 等处（清单见 N8）
  - `buildVectorIndex`（`embedding.ts:257-280`）持写事务跨 `await`（跨网络 embed 调用）且无闸，
    实测同进程并发两次必有一次 `database is locked` → **N10**
  - `members.ts:92` 是同一个索引库的**第二个写者**（写 `contact_fts`），不在单飞闸内：
    实测 40k 行构建在飞时 155/155 次成员搜索静默退化为 LIKE（读取可用性无损）→ **N12**
  - `dirs.ts` bootstrap 只拷主库、跳过 `-wal/-shm`，与 WAL 叠加会拷出旧一代索引 → **N11**
  - 兜底搜索仍是同步整循环，「可中断」需 AbortSignal 贯通到查询层 → **N9**
  - **修复中途失败会留半成品** → 见「第三轮」第 1 条与「第四轮」；空分片清单另加守卫
  - **第四轮（定向复审）结论：可收口**（无 critical、无新缺陷，第三轮的 4 条 major 逐条用
    注入/变异实验验证为实质修复）。它提出的两条「必须补」已做：
    ① **核心修复零回归覆盖**（把读错/写错分离改回旧行为，16 个用例全绿）→ 补 3 条用例：
    写侧失败必须整体回滚（`meta` 表 BEFORE INSERT 触发器注入失败，且**先给夹具加消息**让新旧
    索引行数不同，否则「先 COMMIT 再写 meta」的旧实现也能蒙混过关）、分片**读到一半损坏**只跳过
    该分片（此前只覆盖了 `prepare` 失败）、分片清单为空时中止重建（实测 `message/` 不可读会让
    一份好索引被**静默换成空索引**：`ok/rows 0/无 message` → 新增 3 行守卫）。三条均有可逆 A/B
    ② **「不再静默」只到操作日志**：两个用户可见的重建入口（`Chats.tsx` / `Health.tsx`）
    现在会把 `r.message` 显示出来，残缺索引不再显示成「已就绪」
  - **第四轮确认无风险**：`sdb.close()` 在 `next()` 抛错后安全（无抛错、无锁残留、后续分片正常）；
    `total` 在事务内取到完整自写行；meta/COUNT 失败一律回滚且旧 meta 不丢；显式 checkpoint
    不阻塞、不与 close 重复做无用功；`lib/index.js` 逐 hunk 与 `src` 语义一致（修复确实随产物发布）
- **遗留限制（实测过、本轮不修，均已登记或注明）**：
  - **收尾仍是无界区间**：400k 行实测 **1.35–1.42s**（第四轮复测，第三轮那次 1006ms 是单次
    测量）；外推 100 万行约 2.2–2.5s。主导项是单个大事务 COMMIT 落全部脏页，根治需分批提交，
    会牺牲「旧索引在重建期保持可用」——属取舍，不在本轮范围
  - **单条超大行的处理仍不可中断**：一条 200 万汉字的消息约 311ms、800 万约 1287ms
  - **重建大索引时磁盘短时约 2×**（主库 + `-wal`，实测 20k 行 1.91×）
  - **数据根不可写 → WAL 库不可读**（只读连接读 WAL 库需要 `-shm`/目录写权限）
  - **`wal_checkpoint(TRUNCATE)` 在有「游标未读完」的读者时静默空转**（实测返回
    `{busy:1, checkpointed:0}` 且 `db.exec()` **不抛错**，`try/catch` 实际是死代码）——
    恰恰是 N11 描述的最危险场景它救不了，可观测性也是零
  - **网络盘/同步盘不支持 WAL 时静默退回 delete**（用 `try/catch` 吞掉，代码里拿不到
    「已退回」的可观测性），届时重建窗口会退回改造前的降级行为
  - 100 万条量级的**内存**实测峰值未做（20 万条实测 + 外推）
  - **`FLUSH_EVERY_CHARS` 的取值仍只有弱约束**（可放宽 32 倍仍全绿）；
    字符预算用例把常量钉在 ≤24 万字符（容忍 3.66 倍），略松

---

### `[x]` H12 · 后端 bundle 与源码一致性治理

- **状态**：已完成　**依赖**：H4　**预估**：1d
- **证据**：
  - 运行时只 import `src/backend/wechat-data/lib/index.js`（`src/backend/wechat-host.js:430`），该产物已提交且被修改
  - `lib/types/**` 已 stale：`tsconfig.host.json` 的显式 `files` 列表列了 retrieval，但 `lib/types/query/retrieval/` **不存在**
  - `node_modules/@deepseek-ai/dsh-wechat-data` 是陈旧副本（`file:` 装的是真实拷贝，非符号链接），被前端用于取类型
- **动作与结果**：
  1. **bundle 继续入库**，一致性由 CI 门禁保证（H4 已纳入 `lib/index.js`）
  2. **`lib/types` 重新生成**：新增 `tsconfig.types.json`（声明-only；源码用 `import './x.ts'`，
     `allowImportingTsExtensions` 禁止 JS emit，所以只能是声明产物）；`lib/types` 由 81 个
     `.d.ts` 补到 **97** 个（补齐 `retrieval/`、`annual-review`、`calls`、`notes`、`sns-keystream` 等），
     CI 新增「`build:types` 后 `git diff --exit-code -- lib/types`」
  3. **删掉 243 个不可能再生成的死产物**（81 个 `.js` + 162 个 `.map`）：它们来自上游构建，
     本仓库的编译选项产不出来；同步清掉后端 `package.json` 里指向它们的 `exports["./types"].default`
     与 `files` 条目，避免留悬空指针
  4. **前端不再从 node_modules 取类型**：`src/client/ui-wechat/tsconfig.json` 加 `paths`
     指到仓库里的 `lib/types/types.d.ts`（`file:` 拷贝只在 `npm install` 时刷新，
     已因此把陈旧类型带进过前端）
  5. 删除陈旧的 `tsconfig.host.json`（显式 `files` 列表已不完整、被 include 版 `tsconfig.json`
     完全覆盖，且会让 `composite` 报 TS6307）
- **验收标准**：
  - [x] CI 中「重建 bundle 后 git diff 为空」——`lib/index.js`（H4）+ `lib/types`（本轮）两步都有
  - [x] `lib/types/**` 与 `src/**/*.ts` 一致 —— 连跑两次 `build:types`，`git diff` 为空（逐字节稳定）
  - [x] 前端不再出现因陈旧副本导致的类型错误 —— `paths` 绕开副本，前端错误数 36 → 0
  - [x] `npm run build:backend` 在干净 clone 上可复现（esbuild 已在 H4 声明为依赖）
- **遗留**：`lib/index.js.orig`、`*.tsbuildinfo` 早已被 gitignore 且未跟踪（本项第 3 条原目标已达成）；
  `node_modules` 里那份 `file:` 拷贝仍只随 `npm install` 刷新，但类型检查已不再依赖它

---

## 八、阶段 4 · 安全加固与类型底座

### 阶段汇总

| ID | 任务 | 依赖 | 预估 | 状态 |
|---|---|---|---|---|
| H10 | Electron 安全基线加固 | H3 | 2d | 已完成 |
| H11 | 修复类型检查为零的现状 | H2 | 3d | 已完成（strict 逐项收紧留下一轮） |
| H15 | asarUnpack 补 native 资产 | H2 | 0.5d | 已完成 |

---

### `[x]` H10 · Electron 安全基线未加固

- **状态**：已完成（5 条验收中 4 条已实测、1 条含一个已修复的回归 + 未验证项，见下）　**依赖**：H3　**预估**：2d
- **证据**（改造前基线 → 改造后状态）：

| 项 | 现状 | 位置 |
|---|---|---|
| `contextIsolation` | 已开启 | `main.js:336` |
| `nodeIntegration` | 已关闭 | `main.js:337` |
| `contextBridge` | 正确使用，未暴露 `ipcRenderer` 原语 | `preload.js` |
| `webSecurity` | 未关闭（默认 true） | 全仓无 `webSecurity:false` |
| 证书校验 | 未禁用 | 无 `setCertificateVerifyProc` |
| `remote` 模块 | 未使用 | — |
| **`sandbox`** | **false → true**（preload 只 `require('electron')`，沙箱下允许；实测渲染层无 `require`/`process`/`Buffer`） | `main.js:338` |
| **`shell.openExternal`** | **无白名单 → 只放行 http(s) 且拒绝带凭据的 URL** | `navigation-policy.js` + `main.js` 的 `installWebContentsGuards` |
| **导航守卫** | **无 → `will-navigate` + `will-redirect` + `will-attach-webview`，统一挂在全局 `web-contents-created`** | 同上 |
| **启动开关** | **无防护 → 打包态剥离 `--remote-debugging-port` 等** | `main.js` 的 `GUARDED_SWITCHES` |
| **asar 完整性 / fuses** | **写了但未强制 → 已启用 5 个 fuses（含强制 asar 完整性）** | `package.json` 的 `build.electronFuses` |
| 代码签名 | `signExecutable: false`（未改：属发布流程 / H13 联动） | `package.json` |

- **风险**：`setWindowOpenHandler` 把渲染进程给出的 URL 直接交给系统打开，而**渲染的聊天/朋友圈内容是不可信输入** —— `file:` 能直接拉起本地可执行文件，`smb:`/UNC 会带凭据外连。叠加 `sandbox:false` 与无完整性校验，本地攻击者可改 `app.asar` 绕过 H6 的授权。
- **动作与结果**：
  1. `shell.openExternal` 白名单：**只放行 http(s)**，且**拒绝带凭据的 URL**（`https://wechat.com:pass@evil.com/` 在地址栏里看着像 wechat.com、真实主机是 evil.com）。判定逻辑抽到 `src/backend/navigation-policy.js`（纯函数），`src/backend/tests/navigation-policy.spec.ts` 有 **11 项**单测：`file:`/`smb:`/`ms-msdt:`/`javascript:`/`data:`/空值/垃圾输入一律拒绝、含凭据 URL 拒绝、空 root 必须拒绝（fail-open 边界）、`super-time-wechat-evil` 不能因前缀相同被当作应用目录内
  2. 导航守卫：`will-navigate` 与 `will-redirect` 只允许落在应用目录内的 `file:` 页面；另加 `will-attach-webview`。**统一挂在 `app.on('web-contents-created')`**（注册在建窗之前），将来任何新建的 webContents 都不会绕过
  3. `sandbox: true`（实测渲染层 `typeof require/process/Buffer === undefined`，而 preload 的 11 个桥成员与事件回调全部正常 —— 沙箱没有把能力一起关掉）
  4. CSP：`connect-src` 由 `https:` 通配收紧为显式主机，并补 `object-src 'none'`、`base-uri 'self'`
  5. fuses：读现状（`@electron/fuses` 的 fuse wire）发现 **asar 完整性只是「写了」，强制开关是关的**，于是启用 5 个：`runAsNode:false`、`enableNodeOptionsEnvironmentVariable:false`、`enableNodeCliInspectArguments:false`、`enableEmbeddedAsarIntegrityValidation:true`、`onlyLoadAppFromAsar:true`。`grantFileProtocolExtraPrivileges` **有意保留开启**（应用从 `file://` 加载页面）。安全性依据：仓库不用 `process.fork`（用官方推荐的 `utilityProcess.fork`），也没有脚本依赖 `ELECTRON_RUN_AS_NODE` / `--inspect` / `NODE_OPTIONS`（已 grep 确认）
  6. 打包态剥离危险启动开关：**没有任何 fuse 覆盖 `--remote-debugging-port` / `-pipe`** —— 它们一旦生效，任何能传参启动本 exe 的一方都能经 CDP 拿到渲染进程与整条 IPC 桥（评审实测 `/json/list` 直接列出应用页面）。现在打包态一律 `removeSwitch` 并留日志；开发态保留（调试需要）。演示页 IPC 清理**未做** —— 属 L19

- **验收标准**：
  - [x] 聊天中构造 `file:///C:/Windows/System32/calc.exe` → **实测被拒**。证据比「看有没有弹出计算器」更硬：探针断言 `openExternal` **调用次数为 0**，即根本没走到「交给系统打开」那一步
  - [x] `smb://` 与自定义协议（`ms-msdt:/`）→ **实测被拒**（同上，计数为 0）
  - [x] `window.location = 'https://example.com/'` → **实测被阻止**：页面 URL 前后不变，仍停在应用自己的 `file:` 页面（打包态亦验）
  - [x] `sandbox:true` 下的功能回归 —— 打包产物正常启动（后端就绪、132 个 Remote 方法、渲染出图、状态落 userData；`package:smoke` 19 项全绿），且沙箱本身有**自动断言**（探针返回 `typeof require/process === undefined`）
  - [ ] **CSP 收紧后 LLM 调用 / 图片渲染 / 视频播放：部分实测**。已验证：页面在收紧后的 CSP 下正常加载与渲染；LLM 调用本就不经页面（在后端 worker 里），不受影响。**未验证**：图片渲染与视频播放的端到端路径（需真实微信数据）
  - **回归与修复**（第二轮复审发现）：我第一版 `connect-src` 只列了 jsdelivr 与 unpkg，**漏掉 `geo.datav.aliyun.com`** —— 那是省/市/区县地图 GeoJSON 的唯一来源，收紧后取数被拦（评审实测：违规 + 同 URL 无 CSP 对照页 200/167,894B），地图退化成 treemap。**已修**：把该主机补进 `connect-src` 并重新出包。附带更正两点事实：① 计划里「显式列出 LLM 域名」的前提是错的（渲染进程从不直连 LLM）；② `file:` token 其实冗余 —— `file://` 文档下 `'self'` 已含整个 `file:` scheme（实测可 fetch 任意本地文件），留着只是显式

- **验证方式（可复跑）**：
  - 判定函数：`npm test`（`navigation-policy.spec.ts` 11 项）
  - 守卫是否真的挂上：`npm run security-guard:smoke`（开发态，**已纳入 CI**）、`npm run security-guard:smoke:packaged`（打包态，另带 asar 完整性 + sandbox + fuses + 调试开关断言）。两者都靠 `SUPERTIME_SECURITY_PROBE=1` 钩子在**真实渲染进程**里跑探针，断言的是**行为事实**而非日志文案：`typeof require/process === undefined`、三次 `window.open` 返回 `null`、URL 未变、`openExternal` 调用次数为 0、导航尝试有结果返回（frame 未被带走）。原先把「拒绝」判据写成 grep 日志，评审实测该类回归（白名单放宽到 `file:`）会让行为断言全绿、只有文案变化 —— 现在改成计数后，同一变异实测变红（`count=1`）

- **遗留（不在本轮范围，均已实测确认）**：
  - **`--no-sandbox` 启动参数仍可关掉沙箱**：它在 Electron 更早的阶段被处理，`removeSwitch` 只影响后续判断。已留日志，但**无法从应用侧阻止**（同类问题对 `--remote-debugging-port` 已解决，因为它由 switch 表驱动）
  - **`app.asar.unpacked/**` 不在 asar 完整性覆盖内**：评审实测改 `wasm_video_decode.wasm` 一个字节仍能正常启动（asar 内的文件则直接 `ASAR Integrity Violation` 拒绝启动）。与 `signExecutable:false` 叠加 → 本地可篡改面仍在，建议并入 H13/代码签名收口
  - **`img-src` 仍是 `https:` 通配** ⇒ `connect-src` 的收紧可被 `<img src="https://任意主机/…">` 旁路（实测无违规）。收敛它需要枚举真实图片主机，而库里有大量 http/https 远程图片 URL（见 `utils/url.ts` 注释），代价明确 —— 故保留，**并已知「渲染层可向任意 https 主机发起图片请求」这个外发通道仍在**（M23 只完成了 connect-src 部分）
  - **`will-frame-navigate` 未挂守卫**：子框架外链当前由 CSP 的 `default-src 'self'`（即 `frame-src`）挡住，守卫没参与；一旦放宽 `default-src` 需同步补上
  - **主进程 `webContents.loadURL` 不触发 `will-navigate`**（Electron 固有行为，实测）：本仓库除启动时 `loadFile(uiEntryHtml())`（固定路径）外没有任何 `loadURL`，也没有把渲染层输入喂给负载导航的 IPC ⇒ 当前不可被渲染层触发
  - `will-attach-webview` 当前**不可达**（`webviewTag` 未开，`<webview>` 不是可用元素）—— 属防御性代码

---

### `[x]` H11 · 类型检查实际为零

- **状态**：已完成（前后端均 0 错误；`strict` 的逐项收紧见「遗留」）　**依赖**：H2　**预估**：3d
- **证据**（当时）：
  - `typescript` **未安装**（`node_modules/typescript` 不存在，无 `tsc`）
  - 两个 tsconfig 都 `extends ../../../tsconfig.base.json`，而该文件不存在（H3 前置期已补出）
  - `references` 指向 `../../../vendor/cordis` 等**不存在的路径**（H3 前置期已断掉）
  - `scripts/build-wechat-bundle.js` 用 esbuild——**只剥类型不校验**
- **风险**：131 个 `.ts`（约 1.5MB，含 `gateway.ts` 2800 行）从未被类型检查；前端同理，
  `api.ts` 的手写接口已滞后而无人发现。
- **实际做了什么**：
  1. 装 `typescript@^5.7`（`tsconfig.base.json` 用了 `rewriteRelativeImportExtensions`，
     必须 5.7+）与 `@types/node`；加 `typecheck:server` / `typecheck:client` / `typecheck` / `build:types`
  2. 后端用 `tsconfig.json`（`include: ["src"]`）而不是那份显式 `files` 列表的
     `tsconfig.host.json` —— 后者列表已不完整，`composite` 下直接报 TS6307（该文件已删，见 H12）
  3. **后端 63 → 0**：50 条 TS2454 集中在 `gateway.ts` 的 `citations`/`chunks`/`terms`/`statsCompat`
     （在闭包 `legacyRetrieve` 里赋值，TS 的确定性赋值分析看不穿）。这里用**真实默认值**初始化
     而不是 `!` 断言 —— 万一哪条路径漏赋值，宁可退化成「没有原文 → 不调模型」的硬约束
  4. **前端 36 → 0**：类型改从仓库取（H12 的 `paths`）后，陈旧类型类错误全部消失；
     剩下的是手写镜像滞后与真契约缺陷
  5. CI 新增 `npm run typecheck` 步骤（能阻断合并）
- **顺带修出的 3 个用户可见真 bug**（都是类型漂移掩盖的，之前无人发现）：
  - **反馈学习完全失效**：`feedback.ts` 的 `features` 存的是字符串键名，读取端却用
    `safeJson`（对每项 `Number()` 再滤非有限值）→ 永远读回 `[]`，`adaptWeights` 的循环
    一次都不执行。新增 `safeJsonKeys` + 回归用例（可逆 A/B：旧实现下 features 为 `[]`、
    权重纹丝不动）
  - **「最近活跃」显示 Invalid Date**：`overview-insights.ts:325` 发的是已本地化的字符串，
    `Overview.tsx` 却当数字 `* 1000` → NaN
  - **`RetrievalPanel` 传了不存在的 `Tone='warning'`**（回退成默认样式）、
    `SkLine` 的 `height` 传了字符串 `"28px"`
  - 另有几处真契约漂移：`RenderKind` 与 `MessageRenderKind` **都**漏了 `'unsupported'`
    （`RICH_TO_RENDER` 会产出它、渲染端已有分支）、`MomentEntry` 缺 `city/country/lat/lng`、
    `BatchDecryptResult` 缺 `skippedDetails`、`export.ts:628` 的 async 函数返回类型漏 `Promise`、
    `AskOptimizeResult` 没被 import、`QueryPlan` 从错误模块导入、`process.resourcesPath`
    是 Electron 专有字段、`wechat-ask/delta` 事件没在 `Events` 里声明（已补模块增强）
- **验收标准**：
  - [x] `npm run typecheck` 在前后端均退出码 0（实测 exit 0）
  - [x] `tsconfig` 无悬空 `extends` 与 `references`
  - [x] `npm run typecheck` 纳入 CI 且能阻断合并
  - [x] 前端手写接口与 `gateway.ts` 的 `@Remote` 集合无缺失 —— 已修 `WechatRemote` 的
    `getFileImageDataUrl`、`exportSnsVideo`，以及 `AnnualHighlight.username`、
    `AnnualReviewShape.starUsername`。**注意这只是「本次暴露出的漂移已清零」**，
    没有做成「从 `@Remote` 自动生成」，同类漂移仍可能再次发生（见 M16）
  - 并新增回归用例 `tests/remote-contract.spec.ts`，把「132 个 `@Remote` ↔ 132 个 `WechatRemote` 成员、双向无差集」钉住
    （可逆 A/B：从客户端接口删掉一个方法 → 红「expected ['exportSnsVideo'] to deeply equal []」）
  - 这条用例还顺手抓到一个真瑕疵：`gateway.ts` 的 `getSnsVideoCoverDataUrl` 上**挂了两次 `@Remote(...)`**
    （一次在 JSDoc 之前、一次在之后，复制粘贴残留），已删掉多余那个
  - [x] 记录 strict 收敛的分批计划（见下）
- **遗留（strict 收敛未做完，属计划内第二步）**：`tsconfig.base.json` 目前仍放宽
  `noImplicitAny` / `noImplicitThis` / `noUncheckedIndexedAccess` / `strictFunctionTypes`
  （当年为让存量通过而放宽）。逐项收紧的建议顺序与验收方式：
  `strictNullChecks`（已开）→ `noImplicitAny` → `noUncheckedIndexedAccess` → `strictFunctionTypes`，
  每项单独一个改动、附「错误数前后」对比。**这是 H11 的原定第二步，尚未开始**

---

### `[x]` H15 · asarUnpack 遗漏 native 资产

- **状态**：已完成（第 3 条验收未验证，见下）　**依赖**：H2　**预估**：0.5d
- **证据**：`package.json:103-108` 的 `asarUnpack` 只含 `koffi`、`@koromix`、`wechat/README.md`、`wechat/whisper/**`；而 `src/backend/wechat-data/src/query/sns-keystream.ts:43` 明确去 `app.asar.unpacked/src/backend/wechat-data/native/weflow-isaac64` 查找资产（3.8MB WASM）。该候选路径**永不匹配**，目前仅靠 `:42` 的 `HERE/../../native` 从 asar 内部读取 + `:75,:91` 传入 `wasmBinary` 才可用。
- **风险**：朋友圈视频解密属「偶然可用、非设计可用」；每次冷启动从 asar 读 3.8MB。且该资产（`native/`）当前**尚未入库**（H2 一并处理）。
- **动作**：
  1. `asarUnpack` 补入 `src/backend/wechat-data/native/**`
  2. `sns-keystream.ts` 的候选顺序改为 **unpacked 优先**：原来它排在第 3 位（永不命中），
     现在第 1 位 —— 从 asar 里读要走 Electron 的 fs 补丁、每次冷启动解压 3.8MB，
     unpacked 目录是真实文件，读它才是设计意图；后两个候选保留给开发态
  3. `scripts/packaged-smoke.js` 的断言随之修正：原来断言 WASM **在 asar 归档列表里** ——
     加了 asarUnpack 后这条会失真，而「不在列表里」也不是正确判据（解包条目在 asar 头部
     仍会被 `listPackage` 列出来，实测如此；内容才是不重复存的）。改为断言
     「`app.asar.unpacked` 下存在该文件」+「asar 头部标 `unpacked: true` 且**没有 `offset`**」，
     后者同时挡掉「解包 + 归档双份 3.8MB」
  4. 顺带修掉一个陈旧常量：冒烟脚本硬编码 `EXPECTED_METHODS = 128`，而 `gateway.ts` 实际
     已 132（冒烟会一直红或被人忽略）。改为**从 `gateway.ts` 源码数 `@Remote`**，
     此后新增方法不必再同步这个数字；数不出来或与打包产物不符才报错
- **验收标准**：
  - [x] 打包版 `app.asar.unpacked` 下存在 `native/weflow-isaac64/wasm_video_decode.wasm`
    —— 实测存在，**3,785,516 字节**；胶水 JS 174,692 字节亦在
  - [x] `npm run package:smoke` 通过 —— 19 项断言全绿（含 4 条解包断言、方法数 132）
  - [ ] **打包版朋友圈视频可正常解密播放：未验证** —— 需要真实微信数据 + 一条未缓存的朋友圈
    视频才能端到端验证，本机不具备条件。**已取得的替代证据**：① 冒烟断言了 resolver 第 1 个
    候选路径（`<resources>/app.asar.unpacked/src/backend/wechat-data/native/weflow-isaac64`）
    下是可读的真实文件；② `npm run check:sns-video` 的 18 项断言覆盖了解密逻辑本身
    （明文直达 / `<enc key>` 解密 / 种子错误拒绝 / md5 校验 / CDN 不可达），但跑的是开发态。
    残留风险：真实打包环境下 WASM 实例化失败（本机未复现）
- **观察（属 M19，未修）**：`files` 里的 `src/**/*` 会把整棵内联依赖源码树打进 asar
  （本次实测 asar 条目 **2852** 个），与 node_modules 重复；排除规则属 M19 范围。
  另：`npm run pack` 会往 `dist/` 写约 300MB 产物（该目录已 gitignore）

---

## 九、阶段 5 · 中优先级（稳定性、性能、可维护性）

不阻断上线，但建议在首个迭代内消化工作流 A 与 B——它们与阶段 3 的可靠性改造强相关，合并做更省成本。

### 工作流 A · 密钥与配置持久化安全（4 项）

| ID | 任务 | 证据位置 | 验收标准 | 状态 |
|---|---|---|---|---|
| M1 | 密钥明文落盘且三处镜像 | `key-store.ts:51-56,81` 写 `keys.json`；`config.ts:119` 写 `db_enc_key`；`wechat-paths.js:277-291` 把密钥一并镜像进 config.json（`DERIVED_SETTING_KEYS:96-103` 只剔除路径类字段） **已完成（ACL 方案，经用户确认）**：① **权限收紧** —— 新增 `src/backend/secure-fs.js`，启动时把 `STATE_DIR` 与数据根收紧到**当前用户**（Windows `icacls /inheritance:r /grant:r <SID>:(OI)(CI)F`，POSIX 0700/0600）；目录级继承让之后新建的文件自动跟随，所以不必每写一个文件都调一次。授权用**进程令牌里的 SID**（`whoami /user`）而不是 `process.env.USERNAME` —— 实测本机该变量是 `SYSTEM` 而进程是 `Administrator`，照环境变量授权会把目录锁成谁也进不去（含自己）。② **密钥搬出 config.json** —— 后端 `query/config.ts` 新增 `SECRET_FIELDS`（`db_enc_key`/`image_aes_key`/`image_xor_key`/`api_token`）：`saveConfig` 把它们写进 `<STATE_DIR>/secrets.json`（原子 + 0600）并从 config.json 删除，`getConfig` 从 secrets.json 读回，调用方无感；**旧数据在下次保存时自动搬走**。宿主层 `recordWechatSettings` 也新增 `SECRET_SETTING_KEYS`，不再把密钥镜像进 `config.json.wechatSettings`。③ **文档** —— `src/backend/wechat-data/README.md` 新增「密钥存储与保护」小节（三处位置、谁写的、为什么不在 config.json、权限怎么收）。验收：`tests/secure-fs.spec.ts` 8 项（含**「收紧后没把自己锁在外面」**——这条正是从真实故障里长出来的，以及「目录 (OI)(CI) 继承对之后新建文件生效」）+ `atomic-json.spec.ts` 里 4 项密钥路由用例（写进 secrets、config 里没有、旧数据迁移、api_token 同样走 secrets）+ 运行态实测（打包产物启动后状态目录 ACL 只剩当前用户、新写的 config.json 继承同样权限且不含密钥） | 已完成 |
| M2 | 配置写入非原子，损坏静默吞掉 | 同上 | **已完成**：宿主层（`wechat-paths.js` 的 `writeFileAtomic`/`preserveIfUnparseable`）与后端（`query/config.ts` 的同名实现）都改为 temp+rename；解析失败时**不改动文件**、给出可读告警（同签名只告警一次），并在下一次覆盖前把残缺文件改名成 `config.json.corrupt-<时间戳>` 留痕（原来会被「默认值+补丁」无声覆盖）。验收：`src/backend/tests/atomic-json.spec.ts` **10 项** —— 除两份实现逐条对照与 `saveConfig` 集成外，还有一条**真正的原子性判别**：子进程写 8MB 的同时父进程不停采样目标文件大小，断言读者只会看到「旧内容」或「完整新内容」（A/B 实测：把实现退回直接 `writeFileSync` → 采样到 1 次「写了一半」→ 用例变红）。评审后另修：`.corrupt-*` 备份加了保留上限（3 份，原先随损坏次数线性增长且含完整密钥）与「pid + 单调计数」后缀（原先同一毫秒内的多次备份会静默互相覆盖、丢掉最早的损坏内容） | 已完成 |
| M3 | 导出/备份留半成品文件 | `export.ts:345,347,401,522,634,706,746` 直接写盘；`backup.ts:188` 子目录 `catch{}` 后仍报成功；`:220-246` 失败不清理 `.wcb` | 全部输出 temp+rename；部分失败必须上报（不再报成功）；失败时清理中间产物。与 H8 同期实施。**H8 已完成 zip 流式写盘与原子落地（`zip.ts` 的 `ZipFileWriter` + temp+rename）；xlsx 仍未流式、无取消/进度事件** | 进行中 |
| M4 | 快照替换存在不可读窗口 | 同上 | **已完成**：去掉 `unlink`，只保留 rename + 重试。Windows 实测（`%TEMP%` 探针）：rename 覆盖**已存在但未被打开**的文件是允许的（旧实现白删一次，凭空制造 ENOENT 窗口）；而目标被 SQLite 句柄打开时 unlink（EBUSY）与 rename（EPERM）**都会失败**，真正让同步成功的是重试等待 —— 所以 unlink 只有害处。验收：`sync-wal.spec.ts` 新增「替换期间目标始终存在」用例（可逆 A/B：加回 unlink → 目标缺失 2 次、用例红；评审连跑 10 次红、新实现连跑 10 次绿，无假绿/假红）。**评审补充的反向面**：目标被**普通 fs 只读句柄**（不只是 SQLite 句柄）打开时 rename 也会 EPERM，而这种情况旧实现的 unlink 是能成功的 —— 即去掉 unlink 在「普通只读句柄并发读者」下要靠 8×120ms 重试兜底，超时则本轮同步失败（无数据风险）。另修：WAL 分支的 `finally` 补上 `stagingDb` 清理（`atomicReplace` 抛错时它会以完整快照副本留在盘上） | 已完成 |

### 工作流 B · 可诊断性与降级（3 项）

| ID | 任务 | 证据位置 | 验收标准 | 状态 |
|---|---|---|---|---|
| M5 | koffi 失败被永久缓存 | 同上 | **已完成**：初始化失败时清掉缓存的 promise（成功才保留，避免每次扫描重复 dlopen）；错误信息本地化并给排查方向（缺原生二进制/杀软拦截/非 x64 + 建议先用「手动填写密钥」）。验收：`tests/win32-memory-retry.spec.ts` 3 项（mock koffi 让头两次 load 失败，断言每次都**真的重新尝试**、第三次成功、成功后走缓存；可逆 A/B：去掉清缓存 → 3 项全红） | 已完成 |
| M6 | 无日志落盘 | 同上 | **已完成**：新增 `src/backend/diag-log.js`（大小轮转：app.log → .1.log → .2.log，单份 2MB/共 3 份，**绝不抛**）；主进程在 `STATE_DIR/logs` 起日志并接管 console（**在 console-safe 之后**装 —— 那层在管道断掉时会直接 return，顺序反了日志会一起没）；`uncaughtException` / `unhandledRejection` 一律落盘；设置 → 高级 增加「诊断日志」行（导出… / 打开所在目录），导出会把各轮转份按旧→新拼上环境信息交给保存对话框。验收：`tests/diag-log.spec.ts` **11 项** + 打包冒烟断言日志落盘、行带时间戳/级别、且**后端进程的日志也在文件里**（哨兵：`[backend] [wechat-worker] 后端进程已启动 pid=…`，实测 910 字节）。**评审后的三项修复**（原文只覆盖了主进程，且轮转/脱敏无覆盖）：① **后端进程日志原本完全不落盘** —— 它是独立 `utilityProcess`，RPC 走 `parentPort` 与 stdio 无关，原先 `stdio: 'inherit'` 时那些 `[wechat-sync]`/`[config]`/重试日志进的是主进程那条（GUI 态已断的）管道、于是静默消失；现改为 `stdio: 'pipe'` 并在主进程转进文件日志（同时转写一份到本进程标准流保持开发态可见）。后端加了一行启动留痕（带 pid）作为常驻哨兵。② **脱敏**：`JSON.parse` 的报错会带出错位置附近的**源码片段**（`Unexpected token 'x', ..."apiKey":sk-live-AB"...`），于是「损坏的 llm.json/config.json」告警会把密钥前若干位落盘、并随导出文件外发。现在所有落盘内容都过一个 `redact()` 收口（键值/`sk-`/`Bearer`/长 16 进制），并有 3 项用例锁住（含评审那条真实报错形态）。③ **轮转有了真判别**：原先「文件数 ≤3、总量 <1000」的阈值断言把 `rotate()` 整个禁用仍全绿；现在断言中间态（`.1/.2` 各自装哪一行、丢的是最旧那份），并修掉 `maxFiles=1` 时轮转完全不生效的无上界分支 | 已完成 |
| M7 | LLM/embedding 无重试 | 同上 | **已完成（「UI 可见重试状态」一项未做，见下）**：新增 `src/backend/llm-retry.js`（可注入 fetch，便于确定性单测）：只重试网络异常/408/429/5xx，`Retry-After` 优先但夹在 5s 内，退避 500/1500/4500ms + ≤20% 抖动，`signal` 中止后**不再发新请求**；接到 `wechat-host.js` 的三个调用点（chat 非流式、chat 流式**握手**、embedding），并加接线守卫用例（该文件里不得再出现裸 `fetch(`）。验收：`tests/llm-retry.spec.ts` 12 项（5xx 重试至成功、401 不重试、429 按 Retry-After 等待、网络异常重试耗尽后抛最后一个错、中止即停、退避上限）。**范围**：只覆盖 **LLM/embedding**（验收标准如此）。评审逐个列出全部出网点：`article-cover.ts`（公众号封面）、`media-image.ts`（图片）、`sns-video.ts`（朋友圈视频）、`whisper.ts`（引擎/模型下载，有镜像轮换但无重试/续传）**仍是单次尝试** → 已登记为 **N13**；`llm-model-catalog` 与 `wechat:llm-models` 经核实**不发网络请求**，不需要重试。**「UI 可见重试状态」有意未做**：成功的重试应当无感（界面不该闪），失败才报错；要显示「正在重试」需新增事件贯通渲染端，属独立小改动 | 已完成 |

### 工作流 C · 后端性能（6 项）

| ID | 任务 | 证据位置 | 验收标准 | 状态 |
|---|---|---|---|---|
| M8 | 缓存失效风暴 | `meta.ts:276` + `wechat-host.js:47`：每次 `wechat-data/updated`（活跃期约 10s 一次）全量清空，随后重跑 `loadShardMeta` 遍历全部分片 | 改为只失效真正变更的分片；验收：空闲时活跃数据不再引发周期性全量重算（记录改造前后 CPU/查询耗时） | 未开始 |
| M9 | 向量检索每次全量排序 | `embedding.ts:356-363`：载入约 13.5 万行后每次查询 `map+sort`，O(N log N)≈2.3e6 | 建立倒排/分桶或预排序结构；验收：单次检索 CPU 时间显著下降并记录实测对比 | 未开始 |
| M10 | embedding 远程串行、无缓存 | `embedding.ts:259-279`（batchSize=16、maxDocsPerBuild=40000）→ 单次建库约 2500 次 HTTP 逐批 await；`simhash` 同步 O(64·dim) 阻塞 | 加并发控制与结果缓存（文本 hash → 向量）；`simhash` 改分批让出事件循环。验收：建库耗时有量化改善，期间后端可响应其他查询 | 未开始 |
| M11 | N+1 查询 | `messages.ts:665-728`（每分片×每表各一次 `WHERE server_id=?`，无索引→全表扫描）；`media-image.ts:99-153`（每张图新建连接）；`media-image.ts:637` | 合并为单次批量查询或加索引；`media-image.ts` 复用连接。验收：图片列表加载耗时与查询次数显著下降 | 未开始 |
| M12 | 去重 O(n²) | `fusion.ts:87-105` 每篇与已保留集合算 3-gram Jaccard 且 grams 未缓存；`compress.ts:102` 同理 | 缓存 n-gram、改用 MinHash/SimHash 近似去重。验收：候选数 2000 时去重耗时有量化改善 | 未开始 |
| M20 | 首屏被后端 init 阻塞 | `main.js:461` 在 `createWindow()`（`:622`）之前 `await wechatBackend.init()`，init 会 import 783KB bundle + 启动同步 | 先建窗口并显示加载态，后端 init 改为后台进行；验收：记录首帧时间对比，窗口在 init 完成前即可见 | 已完成 |

### 工作流 D · 前端体验与正确性（5 项）

| ID | 任务 | 证据位置 | 验收标准 | 状态 |
|---|---|---|---|---|
| M13 | 流式问答并发缺陷 | `use-ask.ts:106-149`：`asking` 在闭包中可能过期，快速连点可并发进入；`finally` 无条件 `setAsking(false)`，先返回者把仍在生成的轮次标记结束 | 用 ref 或状态机保证单飞；验收：快速连点两次提问只产生一轮；后进行中先返回不截断仍在生成的轮次 | 未开始 |
| M14 | 长列表虚拟化已装未接线 | `@tanstack/react-virtual` 在依赖中，`kit.tsx:392-470` 实现了 `<VirtualList>`，但全仓无引用；实际靠 `useProgressiveList` 增量挂载 | 二选一：接线 `VirtualList` 到 Chats/Moments/Contacts 等大列表，或移除该依赖。验收：1 万条消息滚动流畅且 DOM 节点数有上界 | 未开始 |
| M15 | 设置面板定时器泄漏 | `Settings.tsx:642,699,731,895` 的 `setInterval` 轮询仅在 finally/stop 清理，组件中途卸载不清理，持续打 IPC | 全部轮询移入 `useEffect` 并返回清理函数。验收：下载/转写中途切走面板，IPC 调用停止（抓取实际 IPC 日志验证） | 未开始 |
| M16 | IPC 死 channel 与类型契约滞后 | 死 channel：`window:maximize-toggle`(`main.js:398`)、`window:is-maximized`(`:410`)、`wechat:dispose`(`:518`)、`license:activation-request`(`:285`)、`license:fingerprint`(`:340`)；类型滞后：`api.ts:194-379` 手写 `WechatRemote` 未含 `getFileImageDataUrl`、`exportSnsVideo` | 清理死 channel（或接入实际 UI 需求）；类型契约与 `@Remote` 集合对齐（与 H11 合并处理） | 未开始 |
| M23 | CSP 过宽 | `connect-src 'self' https:` 与 `img-src ... https: file:` 允许向任意 https 主机外发 | **H10 已完成 connect-src 部分**：改为显式列出渲染进程真实消费者（jsdelivr / unpkg / geo.datav.aliyun.com）+ `'self' data: blob: file:`，并补 `object-src 'none'`/`base-uri 'self'`。**`img-src https:` 仍是通配**：收敛它需要枚举真实图片主机，而库里有大量 http/https 远程图片 URL（见 `utils/url.ts` 注释）→ 意味着「渲染层可向任意 https 主机发起图片请求」这条外发通道仍在，属已知遗留（见 H10 的遗留清单）。验收：connect-src 已收紧且地图/图片/语音/视频取数不受影响（评审实测省市区地图曾因漏 aliyun 被打断，已修） | 已完成（img-src 部分转遗留） |

### 工作流 E · 构建与工程化（6 项）

| ID | 任务 | 证据位置 | 验收标准 | 状态 |
|---|---|---|---|---|
| M17 | shim 同步机制脆弱 | `sync-ui-shim.js` 把源码写进 `node_modules`（npm 对 `file:` 装的是真实拷贝）；直接 `vite build` 会静默用旧副本；`cssSelectors`/`tsExports`(:66-93) 是正则启发式，漏 `@media`/`export default` | 改用 `npm link`/symlink 或 workspace，消除双份源码；验收：修改 shim 后无需手工同步即生效，构建不会静默用旧副本 | 未开始 |
| M18 | 跨平台声明与实际不符 | `package.json:127-138` 声明 mac(dmg)/linux(AppImage)，但原生依赖只内联 `@koromix/koffi-win32-x64`（`:56-57`） | 二选一：补齐各平台 koffi 二进制并跑通构建；或移除 mac/linux target 并在文档声明仅支持 Windows。验收：声明与可构建目标一致 | 未开始 |
| M19 | 打包冗余与窗口图标缺失 | `files` 的 `src/**/*` 把整棵内联依赖源码树打入 asar（`src/backend/deps/**` 984 条目/9.4MB，与 node_modules 重复，含 tests 与 .ts）；`build/` 不在 `files` 白名单 → 打包版窗口无图标（`main.js:150`） | `files` 排除 `!src/backend/deps/**` 与 `!src/**/*.ts`；把 `build/icon.ico` 纳入白名单。验收：asar 体积下降，打包版窗口图标正常 | 未开始 |
| M21 | 大文件可维护性 | `Chats.tsx` 175KB、`api.ts` 82KB、`Moments.tsx` 90KB、`Settings.tsx` 79KB、`chats.module.css` 94KB、`gateway.ts` 2800 行、`parse.ts` 74KB | 按建议边界拆分（`api.ts` → cache/media-cache/remote/按域；`Chats.tsx` → ChatList/MessageStream/MessageCard/GroupInfoDrawer/useSessionMessages；`Settings.tsx` 每节独立组件）。验收：单文件不超过约定行数上限，且行为无回归 | 未开始 |
| M22 | 文档与代码不一致 | 方法数三方打架：`gateway.ts` 实际 129 ← RAG 文档 126 ← `backend/README.md` 114；`backend/README.md:52,92` 引用不存在的 `npm run smoke:wechat`/`config:wechat`；`wechat/whisper/README.md` 声称的 exe 已被删 | 修正全部引用；方法数改为自动生成（并入 H14）。验收：文档中的命令均可执行，方法数与代码一致 | 未开始 |
| M24 | keys ↔ query 双向依赖 | `keys/service.ts:19`、`keys/db-key-v4.ts:18` → `query/config.ts`；而 `query/image-key.ts:8` → `keys/key-store.ts`，层次倒置 | 抽出共享的配置读取到独立层（如 `config/`），消除双向依赖。验收：依赖方向单向，单测可独立加载 | 未开始 |

### 工作流 F · 知识图谱交付与计划实施中暴露的问题（9 项）

| ID | 任务 | 证据位置 | 验收标准 | 状态 |
|---|---|---|---|---|
| N1 | 既有 write store 与知识笔记是同一类隐患：假设数据根目录已存在，且失败被静默吞掉 | `wechat-tasks.ts:19-23` 的 `openStore` 无 `mkdirSync`，与笔记库同类；`listTasks:56-58` 的 `catch` 把打不开库直接退化成空列表 —— 「待办为空」与「库读不到」在界面上无法区分 | 各 store 的 `openStore` 显式建父目录；读失败与「确无数据」必须可区分（至少日志留痕）。验收：在全新 userData（无 `decrypted/`）下写入待办成功 | 未开始 |
| N2 | 引导页「跳过」按钮要求 `licenseOk`，没有免许可证的跳过开关 → UI 自动化验证必须自签证书 | `ui-app/onboarding/OnboardingShell.tsx:952` `disabled={!licenseOk}`；本次为截图验证不得不签发临时许可证（一次性脚手架 `output/kb-verify-setup.js`，`output/` 已被 gitignore，非仓库资产；建议连同本项一并提升为 `scripts/` 下的常驻验证工具） | 加 `SUPERTIME_SKIP_ONBOARDING=1` 之类的显式调试开关（仅非打包态生效）。验收：设置该环境变量后可直接进入主界面，`ui-acceptance.mjs` 无需真实许可证 | 未开始 |
| N6 | **换 userData 不能隔离数据源：应用会把真实微信库解密进新目录**（与 H1、H14 联动） | 实测：`SUPERTIME_USER_DATA_DIR=<空临时目录>` 启动后，该目录出现**完整的真实解密库** —— `message_1.db` 146MB、`sns.db` 13MB、`contact.db` 2143 个联系人，共约 282MB。成因链：`wechat-paths.js:108` 的「开发态一次性迁移」把仓库里**已提交**的 `wechat/config.json` 搬进新 STATE_DIR，该文件带 `db_dir`（真实原始库路径）+`db_enc_key`（H1）；`main.js:470-476` 随后把这份设置回灌后端（`saveWechatConfig`），于是 sync 用密钥把 `db_dir` 解密到新的 `decrypted_dir`。后果：① 任何「干净环境」测试其实都在真实数据上跑，测试隔离是假的；② 用户若更换/清空状态目录，应用会不经确认就把他 GB 级微信数据解密到新位置；③ 叠加 H1 后，任何拿到仓库 + 原始库路径的人都能完成解密 | 迁移不得携带 `db_dir`/密钥类字段（或迁移后强制清空路径与密钥，等待用户重新确认）；`decrypted_dir` 被指向空目录时不得自动全量解密，须显式确认。验收：全新 STATE_DIR 启动后不产生任何真实解密数据；日志能说明「数据源未配置」而非静默解密 | 未开始 |
| N7 | 后端 11 个失败用例的 triage 与修复 | 11 项已全部清零，**其中 3 项是真缺陷**（2 个根因），不是测试过时——这一点与初次 triage 的结论相反：<br/>① `contacts.ts` 好友判据判反（把 1568 个非好友当联系人、417 个真好友当群成员）→ 已改源码；`contacts.spec` / `overview.spec` 夹具未动即转绿，证明它们一直在正确地报 bug。<br/>② `sns-video.ts` 朋友圈视频的 `msg/video/<月>/<md5>_thumb.jpg` 兜底成了死代码（只查根目录、不认月份子目录）→ 已改源码。<br/>其余 8 项确为夹具漂移：`ask.spec` 的 mock 不完整（3）、`messages.spec`/`ledger.spec` 的 appmsg 写成属性而非子元素（3）、`resource-classify.spec` 旧契约（1）、`sns-media.spec` 旧 cache-key 公式（1） | **教训**：初次 triage 用「回退源码后仍失败」判定漂移，但其中一次 A/B 是**空转实验**（被回退的 `parse.ts` 与 `resource-classify.ts` 毫无 import 关系），不能作为证据；而 `contacts.ts` 那项被建议「改夹具 1→3」，若照做会把 bug 固化。可疑结论必须回到领域语义（真实数据）复核 | 已完成 |
| N8 | 向量索引构建读整张 `message_meta` 物化（H9 同族反模式） | `query/retrieval/embedding.ts:241-244`：`SELECT … FROM message_meta ORDER BY m.rowid` 后 `.all()`，与 H9 修掉的搜索路径是同一反模式。实测（20 万行索引、单条 478 字符）：**1876ms、RSS 峰值 +271.7MB**。**同族位置（H9 的「剩余 `.all()` 都是小表」只对 `search.ts` 成立）**：`group-insights.ts:119`（整张 `Msg_*`）、`asset-insights.ts:97`、`privacy.ts:152`、`moments-insights.ts:108`、`overview-insights.ts:248`、`overview.ts:159`（`SnsTimeLine`）、`embedding.ts:236,306`（`vectors`）、`notes.ts:274`、`summary-tasks.ts:91`、`wechat-tasks.ts:52` | 改 `iterate()` 边读边判（`pending` 只取前 `maxDocsPerBuild` 条，天然适合游标）；同族位置按「行数是否随消息量增长」逐个评估，确属会话/联系人量级的在代码里注明。验收：同数据集下命中集合不变，且 RSS 峰值降到与「单批 embedding 数」同阶 | 未开始 |
| N9 | 搜索不可中断（H9 验收标准 4 未达标） | `query/search.ts` 的兜底搜索是同步整循环（`budget=800_000`），实测 20 万行 × 500B 无命中时单次 **621ms**、期间 10ms 定时器 0 次触发，外推约 2.5s。用户切换面板无法打断，且该循环在每次索引重建窗口内会被反复触发 | 需要 AbortSignal 从渲染层贯通到查询层（`searchIndexMessages` 目前是同步 `@Remote`，改 async 会改动客户端契约与 `/api.ts`）。验收：取消后 100ms 内停止扫描，且不再持有 shard 读连接 | 未开始 |
| N10 | 向量索引构建持写事务跨网络调用且无并发保护（H9 同族，风险更高） | `query/retrieval/embedding.ts:257-280`：写事务跨 `await`（跨网络的 embedding 调用）保持开启，且既无单飞闸也无 busy_timeout。实测同进程并发两次：**1555ms 内一个成功 `ok/4000`、另一个 `database is locked`**。它被 Remote 按钮（`gateway.ts:1296`）与问答自动路径（`gateway.ts:946`）触发 | 不要把事务开着等网络：改为「先算好向量再一次性事务写入」，并给构建加单飞闸（参照 H9）。验收：并发两次调用均成功，且写事务的持有时长远小于网络往返 | 未开始 |
| N11 | `dirs.ts` bootstrap「只拷主库、跳过 `-wal/-shm`」与 WAL 叠加会拷出旧一代索引 | `dirs.ts:44`（`BOOTSTRAP_ITEMS` 含 `wechat_search.db`）+ `:47`（`SKIP_SUFFIXES` 含 `-wal/-shm`）+ `:106,111`（copyTree 跳过运行时产物）。实测：3000 行索引建成后让另一连接持旧读标记，再 force 重建 6000 行 —— 主库仍是 3000 行、新数据全在 `-wal`（48.9MB）；此时只拷 `wechat_search.db` 读回 **rows=3000/旧 built_at**（静默回退一代），全量拷才对 | 二选一：拷贝 SQLite 库前后对源库做 `PRAGMA wal_checkpoint(TRUNCATE)`（让主库自包含）；或 `copyTree` 对 `.db` 连 `-wal`/`-shm` 一起拷（注意 `-shm` 不可跨机复用，SQLite 建议用 backup API）。H9 已尽力在构建 COMMIT 后 checkpoint，但**有并发读者时拿不到锁**，覆盖不到「源端应用正在跑」的情形（第四轮实测：读者游标未读完时 `wal_checkpoint(TRUNCATE)` 返回 `{busy:1, checkpointed:0}` 且不抛错，窗口未消除）。验收：数据根里存在活的 `-wal` 时，bootstrap 结果与源库一致 | 未开始 |
| N13 | LLM 之外的 4 个出网点没有重试：公众号封面 / 图片 / 朋友圈视频 / whisper 下载 | `query/article-cover.ts:27,34`、`query/media-image.ts:529`、`query/sns-video.ts:271`、`query/whisper.ts:431,554` —— 全是单次尝试（whisper 有镜像轮换循环，但没有重试与断点续传）。M7 的重试只覆盖 LLM/embedding（验收范围如此）；这些点的一次网络抖动就是「图/视频/模型下载失败」，用户只能重试整个动作 | 把 `llm-retry.js` 的 `fetchWithRetry` 复用到这几个出点（它们都已有超时信号，接口兼容），whisper 下载另加断点续传。验收：断网重连后同一动作自动恢复；并给 `llm-retry.spec.ts` 的接线守卫加上「覆盖哪些文件」的显式清单 | 未开始 |
| N12 | `members.ts` 是搜索索引库的第二个写者，不在单飞闸内 | `members.ts:92` 以**读写**方式打开 `wechat_search.db` 并写 `contact_fts`（`:55-79` 的 `BEGIN/INSERT/COMMIT`）。实测 40k 行 force 构建在飞时，**155/155 次** `searchMembers` 因写被拒而静默退化为 `source:'like'`（`members.ts:122` 吞掉错误），构建结束后立刻恢复 `source:'fts'`。读取可用性无损，但 H9 注释里「进程内争用一律交给单飞闸消除」的说法对它不成立 | 把搜索索引库的写入统一到一个闸（从 `search.ts` 导出 `withIndexWrite()`），或让 `members.ts` 在构建期间直接走 LIKE 并显式标注（而不是吞错）。验收：构建在飞时成员搜索不再出现「尝试写→被拒→静默降级」的路径 | 未开始 |

---

## 十、阶段 6 · 低优先级（清理与打磨）

不影响功能与上线，适合作为机动任务穿插进行。

| ID | 任务 | 位置 | 状态 |
|---|---|---|---|
| L1 | `.gitignore` 补全 `.tmp-*`、`*.orig`、`*.tsbuildinfo`、根 `.*.log` | `.gitignore` | 未开始 |
| L2 | 删除遗留死文件（无任何引用） | `.tmp-be.js`(770KB)、`.tmp-be-lib-index.pre-rag.bak.js`(777KB)、`.tmp-be-build.mjs`、`lib/index.js.orig`(874KB) | 未开始 |
| L3 | 把孤儿脚本挂进 npm scripts | `scripts/license-gate-smoke.js`（依赖 H4） | 已完成 |
| L4 | 测试脚本改为不写仓库（当前临时改写 `public-key.js`，中断即污染） | `license-smoke.js:52-54` | 未开始 |
| L5 | 声明被脚本依赖但缺失的依赖 | `esbuild`（`rag:check`/`ui:smoke`/`build:backend`）：**已声明**（因阻塞 H4 而前置）。`playwright`（`ui:accept`）尚未：它是 300MB 级依赖且会拖慢每次 `npm ci`，而 `ui:accept` 是需要真实数据+人工介入的手动脚本 —— 建议与「H5 之后的验收脚本重整」一起处理，届时用 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` 交由显式安装 | 进行中 |
| L6 | 快照监听者清空后未删键（轻微 Map 泄漏） | `api.ts:63-68` | 未开始 |
| L7 | `hasMore` 判定在 total 不可信或整页末页时错误 | `hooks.tsx:268` | 未开始 |
| L8 | 布局动画期间每次 `finished` 重算小地图并写 localStorage | `EchartsGraphCanvas.tsx:743` | 未开始 |
| L9 | 渲染中重复计算未 memo | `WorldMap.tsx:261,282` | 未开始 |
| L10 | 每块重建余串 O(k·n)，改 `substring` 偏移 | `moments.ts:158` | 未开始 |
| L11 | 正则预编译，避免每次动态构造 | `parse.ts:44,1133` | 未开始 |
| L12 | 签发私钥位于工作树，建议物理隔离到签发机 | `vendor-keys/license-private.pem`（已 gitignore 且不入包） | 未开始 |
| L13 | 「添加成员」为有意死控件，补文档或实现 | `Chats.tsx:3333`、`chats.module.css:2224` | 未开始 |
| L14 | 知识库 stub（无对应文档的 `[[目标]]` 节点），标注或实现 | `graph-model.ts:26` | 未开始 |
| L15 | 文档引用了已删除的 CDP 脚本 | `docs/compose/spec/chat-message-module.md` | 未开始 |
| L16 | CLEANUP.md 与现状矛盾（称已删项与现状不符、称移除 83 条死脚本但现又新增 20+ 条） | `CLEANUP.md` | 未开始 |
| L17 | 视觉审计证据脚本被 gitignore，导致 73KB 审计结论不可复现 | `docs/compose/spec/chat-panel-visual-audit.md:553` 引用的 `output/audit3.mjs` | 未开始 |
| L18 | 过期描述（称仓库无 wired-up tsconfig、称 `check:*` 已移除） | `docs/compose/spec/wechat-message-visual-system.md` | 未开始 |
| L19 | 若 H10 未一并处理，清理死 channel | `main.js:398,410,518,285,340`、`preload.js:17,32-43,49,67,72` | 未开始 |
| L20 | 「notice 3 秒自动消失」重复十余处，抽公共实现 | 各面板 | 未开始 |
| N3 | 构建成功信息恒报 `(0 KB)`：`result.metafile.outputs[outfile]` 的键匹配不上，体积统计失效 | `scripts/build-wechat-bundle.js:50-52`（本次实测输出 `794.1kb` 与 `0 KB` 并存） | 未开始 |
| N4 | 无真实微信数据时后端每次启动向 stderr 打 `realtime sync paused` 告警，污染冒烟输出并被 PowerShell 判为 NativeCommandError（易被误读为失败） | `wechat-data/src/query/sync.ts:753` 附近；本次运行 `knowledge-graph-smoke` 时复现 | 未开始 |
| N5 | 文档与注释中的图谱命名未与「社交图谱 / 知识图谱」两个入口对齐 | 中间版本曾叫「知识社交图谱」，该名称现已不存在；`src/client/README.md`、`docs/compose/spec/*` 等处的旧称（「社交图谱」「114 个方法」）仍待更 | 未开始 |

---

## 十一、已交付功能记录 · 知识社交图谱（2026-09-13）

把原本 `hidden` 的「社交图谱」补全为**两个并列入口**：**社交图谱**（我的人脉：好友网络 / 群组网络）与 **知识图谱**（我的笔记：知识网络 / 融合视图）。

> 初版做成了「一个面板四模式」，用户反馈后改为两个独立导航项。原因：两个维度的数据源、指标口径（消息量 vs 连接度）、默认筛选都不同，共用一个面板会让默认视图变含糊 —— 打开图谱的人多数是想看好友。

**实现范围**

| 层 | 改动 |
|---|---|
| 契约 | `wechat-data/src/types.ts` 新增 `KnowledgeNote` / `NotesSnapshot` / `NoteMutationResult` / `KnowledgeSnapshot` |
| 后端 | 新增 `wechat-data/src/query/notes.ts`：`wechat_notes.db`（与 `wechat_tasks.db` 同构）+ 笔记 CRUD + `[[目标]]` 解析 + stub 保留 + 知识图谱快照 |
| 后端 | `gateway.ts` 新增 4 个 `@Remote`：`getNotes` / `saveNote` / `deleteNote` / `getKnowledgeGraph`（运行时方法数 128 → 132） |
| 前端 | `api.ts` 接入 4 个方法 + 两层缓存失效（内存快照层与 localStorage 渲染层） |
| 前端 | `graph-model.ts`：`GNode.kind` 加 `note`/`stub`、`GEdge.kind` 加 `wiki`/`source`、`GraphSettings.mode` 加 `knowledge`/`fused`；新增 `buildKnowledgeNetwork` |
| 前端 | `EchartsGraphCanvas.tsx`：笔记用紫色圆角矩形、stub 用虚线半透明圆、`wiki`/`source` 边独立线型、tooltip 按物种分派；修正 stub 透明度被 dim 覆盖、头像额度被笔记占用两个副作用 |
| 前端 | `Graph.tsx`：新增 `variant`（`social` / `knowledge`）——模式分段、默认模式、统计条、图例、详情文案、rail 区块、海报控件全部按 variant 分流；知识侧含笔记管理区（新建/编辑/删除/跳转） |
| 前端 | 新增 `KnowledgeNoteEditor.tsx`：`[[链接]]` 实时提示、同名标题冲突提示 |
| 前端 | `Ask.tsx`：每轮回答新增「📝 沉淀为笔记」（带 `sourceKind='ask'` + 来源会话 → 融合视图连到人的边） |
| 导航 | `nav-config.ts`：新增 `knowledge` tab；`graph` 取消 `hidden`。两个并列导航项「社交图谱」「知识图谱」 |
| 导航 | `WechatDataPanel.tsx`：拆开路由 —— `contacts` 直连通讯录（不再与图谱合并成分段）、`graph` → `variant="social"`、`knowledge` → `variant="knowledge"` |

**验证证据（均为实际执行结果）**

- `node scripts/knowledge-graph-smoke.js` → **26 项断言全过，exit 0**。新脚本已挂 `npm run check:knowledge-graph`，覆盖：方法注册、`[[链接]]` 成边、未解析目标成 stub、同名/空标题拒绝、出链反链计数、问答沉淀带出 `sessionNames`、**删除笔记后指向它的链接退回 stub**、更新笔记复用 id 且未提供字段保持原值。
- `npm run build:backend` → 794.7kb，方法数 128 → 132。
- `npm run build:ui` → 822 modules，3.1s，无解析错误。
- `npm run rag:check`（20 项）、`npm run ui:smoke`（21 项）、`npm run check:sns-video`（18 项）→ 全过，无回归。
- **真实渲染验证**（`SUPERTIME_SCREENSHOT` + 脚本化点击，跑在开发态既有数据上，未再复制任何数据）：
  - **社交图谱**入口（`output/panel-social.png`）：标题「社交图谱 · 好友网络」，模式分段**只有**好友网络/群组网络，统计条为 251 节点 / 998 连线 / 8 圈子 / **250 联系人** / 群聊，rail 为「最亲近 · 消息量」+ 圈子概览，无知识笔记区，海报控件在位。
  - **知识图谱**入口（`output/panel-knowledge.png`）：标题「知识图谱 · 知识网络」，模式分段**只有**知识网络/融合视图，统计条为 4 节点 / 4 连线 / 1 圈子 / **3 笔记** / **1 待补笔记**，画布为紫色笔记节点 + 指向 stub「张三」的虚线边，rail 出现知识笔记管理区（含「·来自问答」标记）。
  - 早期（单面板四模式版本）另拍有 `output/kb-verify-knowledge.png`、`output/kb-verify-fused.png`；渲染暴露并已修复的 3 处文案错误（面板标题、rail 指标名、圈子人数单位在知识语义下仍是社交口径）保留在案。

**已知限制（需后续处理）**

- 融合视图的 **note → 来源会话** 跨物种边，只有在社交图谱里存在该会话节点时才会画出来；至今未在截图里验证过（见下条）。
- 笔记编辑器的完整交互（新建/编辑/删除按钮点击、同名冲突提示）只验证到渲染层，未做点击级端到端验证（依赖 N2 的调试开关才能免许可证自动化）。
- `docs/compose/spec/*` 与 `src/client/README.md` 中的图谱命名尚未与「社交图谱 / 知识图谱」两个入口对齐（见 N5）。

---

## 十二、上线门禁（Release Gate）

高优先级全部闭环后，按下列清单逐条核验。**任何一条不通过，不得发布。**

**安全与合规**
- [ ] fresh clone 全历史中不含任何真实密钥（H1）
- [ ] License 闸门在所有异常路径下均拒绝而非放行（H6）
- [ ] `shell.openExternal` 拒绝非 http(s) 协议；导航守卫生效（H10）
- [ ] 法务对许可未明资产给出书面结论（H13）
- [ ] 隐私声明齐全、可访问，且首次启动强制同意（H14）

**可验证性**
- [ ] `npm test` 全绿，收集 36 个 spec（H3）
- [ ] CI 全绿且能阻断合并，含 bundle 一致性门禁（H4）
- [ ] `ui-acceptance.mjs` 失败时退出码非 0（H5）
- [x] `npm run typecheck` 全绿（H11）

**版本与可复现**
- [ ] `git status` 干净，无未提交改动（H2）
- [ ] 全新目录 clone → `npm ci` → 构建 → 启动，功能完整（H2）
- [ ] 打包版经 `package:smoke` 验证，SNS 视频解密走设计路径（H15）
- [ ] `CHANGELOG.md` 记录了本次发布内容

**可靠性**
- [ ] 后端进程被杀后能自动恢复（H7）
- [ ] 无任何调用会导致 UI 无限 loading（H7）
- [ ] 导出 1000 会话不 OOM、不阻塞 UI（H8）
- [ ] 百万级消息下搜索内存有上界（H9）

---

## 十三、风险登记

| 风险 | 影响 | 应对 | 关联 |
|---|---|---|---|
| git 历史中含真实密钥，已在多人机器上 | 已泄露，轮换不可逆地依赖第三方配合 | 立即轮换凭据；通知所有克隆者重新克隆；后续所有配置禁止入库 | H1 |
| 修复 H1 需重写 git 历史，会打断他人分支 | 协作中断 | 选在低活跃窗口执行；事先广播；必要时保留旧仓库只读 | H1 |
| H13 法务结论可能要求移除核心资产 | 功能降级（表情资源、SNS 视频解密） | 提前准备方案 B 的降级实现与用户提示文案，避免临时救火 | H13 |
| H11 开启类型检查后暴露出大量既有错误 | 排期失控 | 分两步收敛：先让存量通过再逐目录开 strict；先量化错误数再定排期 | H11 |
| H2 提交超大基线后 review 困难 | 缺陷漏过 | 按主题拆分提交；关键模块（license、retrieval）单独 review | H2 |
| 阶段 3 的性能改造缺少基准数据 | 无法证明改善 | 改造前先建立基准（内存峰值、事件循环阻塞时长、耗时），纳入验收标准 | H8, H9 |

---

## 十四、审查范围与方法（基线记录）

本次审查基于以下证据，未修改任何代码：

- 分层与依赖：`main.js`、`preload.js`、`src/backend/wechat-host.js`、`src/backend/wechat-worker.js`、`vite.config.js`、各 `tsconfig*.json`、三份 `package.json`
- 后端：`src/backend/wechat-data/src/gateway.ts`（129 个 `@Remote`）、`keys/**`、`query/**`（约 60 个模块）、`query/retrieval/**`（12 个模块）
- 前端：`src/client/ui-app/**`、`src/client/ui-wechat/**`（40 余面板）、`api.ts`、`preload.js`
- 测试与脚本：36 个 `*.spec.ts`、`scripts/**`（约 20 个冒烟/校验脚本）
- 仓库状态：`git log`、`git status --porcelain`（781 项）、`git ls-files`、`.gitignore`
- 打包产物：`dist/win-unpacked/resources/app.asar`（2802 条目）
- 文档：`docs/**`、各 README、`CLEANUP.md`、`VENDORED-LICENSES.md`、`PROVENANCE.md`

**审查中确认的良好实践**（改造时不要破坏）：三层错误传播链（worker → host → IPC）完整无吞没；密钥获取降级路径分层合理；SQL 全部参数化、无注入点；WAL salt 校验与只读连接管理规范；gateway 是清晰的委托结构而非巨型 switch；echarts 实例与监听器清理到位；`LazyMount`/`useProgressiveList` 设计得当；项目自身代码零 TODO/FIXME；`npm audit` 无已知漏洞；17 个内联依赖许可证登记完整（全 MIT）。

---

## 十五、变更记录

> 按时间倒序追加。格式：`日期 · 操作者 · ID · 旧状态 → 新状态 · 备注`

| 日期 | 操作者 | ID | 状态变化 | 备注 |
|---|---|---|---|---|
| 2026-09-13 | 审查 | 全部 | — → 未开始 | 初始建立：15 项高、24 项中、20 项低，共 59 项 |
| 2026-09-13 | 实施 | 知识社交图谱 | 新增（已交付） | 补全知识维度：4 个 Remote 方法（128→132）、`wechat_notes.db` + `[[链接]]`/stub、四模式图谱、问答沉淀入口；新增 `check:knowledge-graph` 冒烟（26 项）；完成真实渲染截图验证 |
| 2026-09-13 | 实施 | L3 | 未开始 → 已完成 | 顺手把孤儿脚本 `license-gate-smoke.js` 挂进 npm scripts（`license-gate:smoke`） |
| 2026-09-13 | 实施 | N1–N5 | 新增 | 交付过程暴露：既有 store 建目录/静默吞错同类隐患、无免许可证跳过开关（阻碍 UI 自动化）、构建体积统计恒 0KB、无数据时 stderr 噪声、旧称「社交图谱」未同步 |
| 2026-09-13 | 实施 | N6 | 新增 | 用 `SUPERTIME_USER_DATA_DIR` 指向空目录启动后，该目录出现约 282MB 真实解密库：开发态配置迁移把仓库里已提交的 `wechat/config.json`（含 `db_dir` + `db_enc_key`）搬进新 STATE_DIR，后端随即用密钥把原始库解密到新的 `decrypted_dir`。换 userData 并不能隔离数据源，测试隔离与 H1 的严重度都要按此重估；临时目录已清理 |
| 2026-09-13 | 实施 | 图谱拆分为两个入口 | 新增 | 用户反馈「知识社交图谱里面的界面应该是我的好友」→ 确认为截图误导（默认本就是好友网络），但按反馈把单面板四模式改为两个并列导航项：社交图谱（好友/群组）与知识图谱（知识网络/融合视图），`Graph.tsx` 引入 `variant` 按面板分流模式、统计、图例与 rail；两个入口均以开发态真实数据截图验证 |
| 2026-09-13 | 实施 | H1 | 未开始 → 进行中 | 仓库侧完成：两个密钥文件出库 + .gitignore 覆盖 + 模板；额外补出 `image-key.spec.ts` 里 3 处硬编码的**同一个**真实 image key 并替换为假值。待人工：轮换凭据、重写历史 |
| 2026-09-13 | 实施 | H2 | 未开始 → 已完成 | 790 项改动按主题分成 6 提交（清理 687 项废弃产物 / 后端 / 主进程与许可 / 前端 / 构建脚本与文档 / 密钥出库修正）；工作区干净，关键模块确认入库。未做真正的 fresh-clone 复核 |
| 2026-09-13 | 实施 | H3 | 未开始 → 进行中 | 接入 vitest（^3，vitest 5 与 vite 5 冲突）：36/36 spec 可收集、162 用例执行、151 通过 / 11 失败。顺带前置 H11 的 tsconfig 修复（根 base 缺失 + references 悬空） |
| 2026-09-13 | 实施 | H11 | 未开始 → 进行中 | 补出根 `tsconfig.base.json`（两个 tsconfig 都 extends 它却从未提交），断掉两处指向不存在 monorepo 路径的 `references`；typecheck 脚本与 strict 收敛未做 |
| 2026-09-13 | 实施 | N7 | 新增 | 11 个失败用例待 triage；其中 resource-classify 已用可逆 A/B 实验证伪「本地改动所致」 |
| 2026-09-13 | 实施 | 合计 | 65 → 66 | 阶段 5 +1（N7）；H2 完成、H1/H3/H11 转进行中 |
| 2026-09-13 | 实施 | 教训 | — | `git commit -- <pathspec>` 会**按工作区内容提交并绕过索引**，导致首次 H1 出库提交实际未生效（反而多提交了一份含明文密钥的 config.json）。补救：改用「`git rm --cached` 暂存 → 不带路径 `git commit`」，并保留 `978f266` 作为记录、另起 `f4d4956` 真正生效 |
| 2026-09-13 | 实施 | N7 | 未开始 → 已完成 | 11 项失败清零：**3 项真缺陷**（contacts 好友判据判反、sns-video 聊天缓存兜底失效）+ 8 项夹具漂移。`npm test` 36/36 文件、162/162 用例、exit 0 |
| 2026-09-13 | 实施 | H3 | 进行中 → 已完成 | 运行器 + 全绿：162 用例通过、退出码 0 |
| 2026-09-13 | 实施 | H4 | 未开始 → 已完成 | 新增 `.github/workflows/ci.yml`（windows-latest，12 步）；bundle 一致性门禁经正反两向验证；`dev`/`prestart` 补 `build:backend`（esbuild 仅 ~24ms，消除「忘记重建 bundle」这类静默故障）；声明 esbuild 为 devDependency（原 L5）；12 步本机全绿 |
| 2026-09-13 | 实施 | H5 | 未开始 → 已完成 | 断言失败 / 执行异常 / 环境还原不完整三者任一即置退出码 1，并打印归因 |
| 2026-09-13 | 实施 | H6 | 未开始 → 已完成 | 授权校验异常改为拒绝（`LICENSE_CHECK_FAILED`）；license 门禁与签发 smoke 无回归 |
| 2026-09-13 | 实施 | L5 | 未开始 → 进行中 | esbuild 已声明（阻塞 H4，前置完成）；playwright 待与验收脚本重整一并处理 |
| 2026-09-13 | 实施 | H7 | 未开始 → 已完成 | 超时（两档窗口）+ 有界退避重启（≤3 次，0.5/1.5/4.5s）+ 就绪闸门 + 渲染端状态横幅；逻辑抽到 `backend-rpc.js` 以便确定性单测（16 项）+ 端到端冒烟（6 项，已入 CI） |
| 2026-09-13 | 实施 | M20 | 未开始 → 已完成 | 建窗先于后端启动（H7 重排的副产品） |
| 2026-09-13 | 评审 | H7 | 两轮 | ① 第一轮：2 critical（后端状态无渲染端消费者、init 失败提示是死代码）+ 3 major（陈旧句柄误伤、init 失败泄漏进程、双定时器 + 长任务名单漂移含两个不存在的名字）；② 第二轮确认 critical 已解决、无新增 critical，但指出重排新引入的启动窗口期与「泄漏只修一半」。全部修毕 |
| 2026-09-13 | 实施 | 教训 | — | ① 把长初始化从建窗前移到建窗后，是用「短暂假错误」换首帧——依赖启动期 IPC 返回值的调用方必须能区分「未就绪」与「永久失败」（原先只回一句 message、无 code，渲染端无从重试）；② 进程监管里「成功启动后的后续调用失败」是独立分支，只给 init 的 catch 做清理覆盖不到，会留下被身份校验主动忽略的孤儿进程，比普通泄漏更难发现；③ 阻塞式 `dialog.showErrorBox` 会让 `app.quit()` 都到不了，验证脚本实测挂死 5 分钟；④ 可逆 A/B 若被回退的文件与目标模块无引用关系即为空转实验，不能当证据（见 N7） |
| 2026-09-13 | 实施 | 合计 | 66 项：未开始 54 / 进行中 3 / 已完成 9 | 阶段 0 完成 1（H2）、进行中 1（H1 待轮换）；阶段 1 全部完成（3）；阶段 3 完成 2（H6/H7）；阶段 4 进行中 1（H11）；阶段 5 完成 2（N7/M20）；阶段 6 完成 1（L3）、进行中 1（L5） |
| 2026-09-13 | 实施 | H8、H9 | 进行中 → 已完成 | H8 经两轮评审修毕。H9 首轮实现后被评审指出「转 async 引入写事务跨 macrotask 持锁」，补单飞闸 + busy_timeout；第二轮的 3 条 major（让出预算两处被绕过、重建窗口读侧静默降级、闸键控与 busy_timeout 反效应）也已修毕 |
| 2026-09-13 | 评审 | H9 | 第二轮 · 3 major → 已修 | ① 让出预算：计数器写在 `continue` 之后，且 `flush()` 只有「500 行」阈值——实测 30 万无文本行单块 1097ms 零让出、1MB/行单次 flush 60.2s；已把计量前移并给批量写入加字符上界。② 重建窗口：DDL 在事务外 autocommit，读者整段看到半成品（ready:false / LIKE 降级）；已挪进事务 + 开 WAL（实测 delete 模式溢出页缓存后读者全段被拒，WAL 下 0 次被拒；旁路文件 rename 在 Windows 上 EPERM，不可行）。③ 闸按调用方字符串键控——同一文件不同写法并发会让 worker 停摆 7.5s；已改按 `searchIndexPath` 键控并**移除 busy_timeout**（单线程里它是同步忙等，实测 7.6s 后才报错，净负收益） |
| 2026-09-13 | 评审 | 教训 | — | ① ~~单线程同步 SQLite 封装里 `busy_timeout` 对进程内争用是净负收益~~ **（该归因已被第三轮评审证伪，见下条）**。② 让出计数器必须计在 `continue` 之前，且批量写入也要纳入预算——只给循环设上界给不出单块上界。③ 写事务跨 `await` 时，事务**之外**的 DDL/DELETE 会把半成品状态暴露给读者；DDL 要么进事务，要么旁路文件原子替换（Windows 上后者对已打开的文件会失败）。④ 单飞闸的键应当是被争用的**资源**（DB 文件路径），不是调用方传入的字符串。⑤ 计时类断言的夹具必须高熵：`'震'.repeat(n)` 只有极少数 distinct bigram，会让 FTS 成本低到看不出差别（本次因此先得到一次假绿） |
| 2026-09-13 | 评审 | H9 | 第三轮 · 4 major → 已修/已登记 | ① 循环内错误被 per-shard `catch{}` 吞掉 → 静默产出「部分索引 + 报 ok」（实测注入错误后 ok/rows 4999/ready:true，读侧永不重建）；已把可跳过的 catch 收窄到只包读取，写失败改为向上抛并 ROLLBACK → 新增「不可读分片记入结果」用例。② WAL 使主库可能落后一代、而 `dirs.ts` bootstrap 只拷主库 → 已在 COMMIT 后尽力 `wal_checkpoint(TRUNCATE)`，残余登记 N11。③ 收尾（末次 flush+COMMIT+COUNT+meta+close）不受让出预算约束（400k 行 1006ms）→ 统计与 meta 写挪进事务 + `synchronous=NORMAL`（100k 299→222ms、200k 504→442ms），仍未根治，已入遗留限制。④ 数据根不可写时 WAL 库连只读都打不开（delete 库正常）→ 已入遗留限制。另更正第二轮的 `busy_timeout` 归因（见下条教训） |
| 2026-09-13 | 评审 | 教训（更正） | — | **撤回「`busy_timeout` 对进程内争用是净负收益」这条结论**：第三轮用三形态原始探针实测，7.5s 停摆的真正来源是**旧布局「DDL 在事务外各自 autocommit」**（`BEGIN;写` 3341ms / autocommit 写 3328ms / `BEGIN;读;写` **1ms**）——DDL 进事务后写锁冲突走「延迟事务的读写升级」路径，压根不调用 busy 处理器（加回 `busy_timeout=5000` 也是 15ms 快速失败）。移除它只是收尾。**教训**：判断同步 SQLite 的争用行为必须先做形态探针，别把布局的产物归因到参数上。其余新增教训：① 让出预算是「循环内」预算，收尾（COMMIT/COUNT/close）与单条超大行是两段无界区间，量测方法若有意排除收尾就等于把该验收变成不可回归项；② `try{}catch{}` 的粒度决定修复的真实覆盖面——把 DDL 挪进事务只保护「会向上抛」的失败，行循环内的 catch 会把失败变成「部分成功 + 报 ok」，比留成空表更难发现；③ WAL 化后必须同时审计所有「跳过 `-wal`」的拷贝/打包/枚举路径；④ 「有回归用例」与「常量取值被钉住」是两件事（本轮实测 `FLUSH_EVERY_CHARS` 可放宽 32 倍仍全绿）；⑤ 计时断言的余量要按最薄的那条评估，且两个命题别互相遮蔽 |
| 2026-09-13 | 实施 | N11、N12 | 新增 | H9 第三轮评审暴露：`dirs.ts` bootstrap 只拷主库（N11）、`members.ts` 是索引库的第二写者且不在闸内（N12）；N8 补全同族 `.all()` 清单 |
| 2026-09-13 | 评审 | H9 | 第四轮 · 结论「可收口」 | 定向复审第三轮改动（只审 c8cb229）：无 critical、无新缺陷，4 条 major 逐条用注入/变异实验验证为实质修复；确认 `sdb.close()` 在 `next()` 抛错后安全、事务内 `COUNT(*)` 可见自写行、meta 失败一律回滚、显式 checkpoint 不阻塞也不与 close 重复、`lib/index.js` 逐 hunk 与 src 语义一致。它提的两条「顺手做」已做：核心修复的回归用例（此前改回旧行为 16/16 全绿）+ 残缺索引在 UI 可见 |
| 2026-09-13 | 实施 | H9 | 纠正一处不可复现的性能宣称 | 第三轮提交信息里的「`synchronous=NORMAL`：100k 299→222ms、200k 504→442ms」在第四轮被复测**证伪**（FULL 与 NORMAL 的差落在 ±300ms 跑间方差内）；收尾主导项是单一大事务 COMMIT 落全部脏页，400k 实测 1.35–1.42s。文档已改为如实记录，`synchronous=NORMAL` 因「对派生索引取舍合理」保留，不再声称提速 |
| 2026-09-13 | 实施 | H9 | 补 4 条用例 + 1 条守卫（16 → 19 项） | 写侧失败整体回滚（含「先加消息让新旧行数不同」的关键设计）、分片读到一半损坏只跳过该分片、分片清单为空中止重建（防静默清空好索引）、字符预算断言收紧到「≥2 次让出」；`Chats.tsx`/`Health.tsx` 显示 `r.message`。三条新用例均有可逆 A/B；全量 209 通过；UI `vite build` 通过 |
| 2026-09-13 | 实施 | 教训（补充） | — | ① 「顺手做」的用例必须检查**它真的能抓住目标改动**：我第一版注入型用例（meta 触发器）在旧实现下也通过 —— 因为夹具两次构建行数相同。把「新旧索引行数不同」做成前置条件后才真正判别；② 单次计时测量不能当性能宣称（第三轮的 NORMAL 提速就是单次读数）；③ `PRAGMA wal_checkpoint` **不抛错**，busy 情况以结果行返回 → `try/catch` 是死代码，判断「是否生效」只能读结果行 |
| 2026-09-13 | 实施 | 合计 | 69 → 71：未开始 56 / 进行中 4 / 已完成 11 | 阶段 5 条目 31 → 33（+N11/N12）；M3 按条目级实际状态改为「进行中」（H8 只做掉 zip 部分） |
| 2026-09-13 | 实施 | N8、N9、N10 | 新增 | H9 第二轮评审暴露的同族问题：向量索引读整表物化（N8）、搜索不可中断即 H9 未达标项（N9）、向量索引构建持事务跨网络调用且无并发保护（N10） |
| 2026-09-13 | 实施 | 合计 | 66 → 69：未开始 54 / 进行中 4 / 已完成 11 | 阶段 3 完成 4（H6/H7/H8/H9）；阶段 5 条目 28 → 31（+N8/N9/N10） |

| 2026-09-13 | 实施 | H11 | 进行中 → 已完成 | 装 typescript@^5.7 + @types/node，加 typecheck:server/client/typecheck/build:types 脚本并纳入 CI；后端 63 → 0（50 条 TS2454 用真实默认值初始化而非 `!` 断言）、前端 36 → 0。顺带修出 3 个用户可见真 bug（反馈学习因 features 读回空数组而完全失效、Overview「最近活跃」显示 Invalid Date、RetrievalPanel 传了不存在的 Tone）与若干真契约漂移（RenderKind/MessageRenderKind 都漏 'unsupported' 等）。strict 逐项收紧尚留下一轮 |
| 2026-09-13 | 实施 | H12 | 未开始 → 已完成 | 新增 tsconfig.types.json（声明-only）并删除陈旧的 tsconfig.host.json；lib/types 由 81 补到 97 个 .d.ts；删掉 243 个不可能再生成的死产物（81 .js + 162 .map，源码头用 `.ts` 扩展名 → allowImportingTsExtensions 禁止 JS emit），同步清掉 exports.default 与 files 里的悬空指针；前端类型改从仓库取（tsconfig paths）。CI 新增 typecheck 与 build:types 一致性两步 |
| 2026-09-13 | 实施 | 教训（H11/H12） | — | ① 类型检查一开就抓到 3 个「用户可见但没人发现」的真 bug —— 这类漂移靠读代码是看不出来的；② 类型源的选取要盯住「哪份是权威」：前端一直从 node_modules 的 file: 拷贝取类型，而那份只在 npm install 时刷新，等于给陈旧类型开了后门；③ 不可再生成的构建产物不该入库（243 个 .js/.map 谁也不敢删、也没人能重建）；④ 测试夹具要留意「兄弟文件」型路径（反馈库、搜索索引库都是 `<解密目录>/../x.db`），共用父目录会让多个用例串库（本次踩到过） |
| 2026-09-13 | 实施 | 合计 | 71 项：未开始 55 / 进行中 3 / 已完成 13 | 阶段 3 全部完成（5）；阶段 4 完成 1（H11）、未开始 2（H10/H15） |
| 2026-09-13 | 实施 | H15 | 未开始 → 已完成 | asarUnpack 补 `src/backend/wechat-data/native/**`；sns-keystream 的候选顺序改为 unpacked 优先（原第 3 个候选永不命中，现在第 1）；packaged-smoke 断言改为「unpacked 目录下有真实文件 + asar 头部标 unpacked 且无 offset」（`listPackage` 仍会列出解包条目，所以「不在列表里」是错判据）。实测：pack 后 wasm 3,785,516 字节就位，19 项断言全绿。顺带把冒烟里硬编码的 EXPECTED_METHODS=128（实际已 132）改为从 gateway.ts 源码数 @Remote。第 3 条验收（打包版视频解密播放）未验证：需真实微信数据，已记录替代证据 |
| 2026-09-13 | 实施 | 合计 | 71 项：未开始 54 / 进行中 3 / 已完成 14 | 阶段 4 完成 2（H11/H15）、未开始 1（H10） |
| 2026-09-13 | 实施 | H10 | 未开始 → 已完成 | ① openExternal 白名单（只放行 http(s)），判定逻辑抽到 navigation-policy.js + 9 项单测；② will-navigate / will-attach-webview 守卫，统一挂在 app.on('web-contents-created') 上（不只护主窗口）；③ sandbox: true；④ CSP 的 connect-src 由 https: 通配收紧为「两个 GeoJSON CDN + self/data/blob/file」，并补 object-src 'none'/base-uri 'self'；⑤ 启用 5 个 fuses（含强制 asar 完整性 —— 原先只是「写了」而开关是关的）。新增 SUPERTIME_SECURITY_PROBE 钩子 + scripts/security-guard-smoke.js：在真实渲染进程里验证三次 window.open 全被拒、外部导航被阻止、且 openExternal 根本没被调用；开发态已入 CI，打包态亦实测通过 |
| 2026-09-13 | 实施 | 合计 | 71 项：未开始 53 / 进行中 3 / 已完成 15 | 阶段 4 全部完成（H10/H11/H15） |
| 2026-09-13 | 实施 | 教训（H10） | — | ① 计划里「CSP 显式列出 LLM 域名」的前提是错的 —— 渲染进程从不直连 LLM（那些调用在后端 worker 里），照做会白白放开用不上的域；收紧 CSP 前要先 grep 出**真实**的消费者；② 「配置了」不等于「生效了」：asar 完整性一直被写入 exe，但强制它的 fuse 是关的 —— 读 fuse wire 才看得出来；③ 判定逻辑抽成纯函数后，`file:`/`smb:`/自定义协议这些边界能穷举，剩下要端到端验的就只有「守卫有没有挂上」，用一个 env 钩子就能覆盖；④ 关 runAsNode 前必须确认没人用 process.fork（本仓库用 utilityProcess，安全） |
| 2026-09-13 | 评审 | H10 | 第二轮复审（第一轮定向） | 无 critical：渲染层未找到可利用的守卫绕过（meta refresh / 表单 / location / target 变体 / 子框架开窗全部实测被拦；摘掉守卫的对照实验里 6 个窗口真的开了出来，证明守卫是唯一拦截者）。两条 major：① **我引入的功能回归** —— connect-src 收紧漏掉 `geo.datav.aliyun.com`（省/市/区县地图 GeoJSON 的唯一来源），取数被拦、地图退化成 treemap；已补该主机并重新出包，文档里「唯一外网消费者是两个 CDN」的错误说法一并更正；② 打包产物仍接受 `--remote-debugging-port`（CDP 可直接拿到渲染层与 IPC 桥）→ 已加打包态开关剥离 + 断言（端口不可达）。另修：补 `will-redirect` 守卫、拒绝带凭据 URL、`isInsidePath('')` 的 fail-open、探针改为断言行为事实（`openExternal` 调用计数）并加沙箱断言 |
| 2026-09-13 | 评审 | 教训（H10 第二轮） | — | ① 「显式列出 X 域名」这类收紧必须先把消费者 grep 干净（我漏了第三个 GeoJSON 主机，直接把功能改坏）；② 安全冒烟的判据不能用日志文案 —— 评审实测把白名单放宽到 file: 时行为断言全绿、真实环境里 calc.exe 已经被拉起；改成「openExternal 计数」后同一变异立即变红；③ `file://` 文档下 CSP `'self'` = 整个 `file:` scheme（可读任意本地文件），所以 `connect-src` 里加 `file:` 是冗余的、也不构成目录约束；④ 打包 Electron 应用对「能传参启动它的人」默认是完全可调试的 —— 没有任何 fuse 覆盖 `--remote-debugging-port`/`--no-sandbox`，必须在主进程自行剥离 |
| 2026-09-13 | 实施 | M23 | 未开始 → 已完成（img-src 部分转遗留） | 与 H10 是同一件事：connect-src 已按真实消费者收紧；img-src 的 https 通配因需要枚举图片主机而保留，明确记为「渲染层仍可向任意 https 主机发起图片请求」的外发通道 |
| 2026-09-13 | 实施 | 合计 | 71 项：未开始 52 / 进行中 3 / 已完成 16 | 阶段 5 完成 3（M20/N7/M23） |
| 2026-09-13 | 实施 | M2、M4、M5 | 未开始 → 已完成 | ① M2 配置写入原子化 + 损坏文件留痕：宿主层与后端两份实现都改 temp+rename，解析失败只告警不重置，覆盖前把残缺文件改名成 `config.json.corrupt-<ts>`（原来会被默认值+补丁无声覆盖）；新增 9 项对照用例。② M4 去掉快照替换的 `unlink`：Windows 实测 rename 覆盖「已存在但未被打开」的文件本来就允许，而目标被 SQLite 句柄打开时 unlink(EBUSY) 与 rename(EPERM) 都会失败 —— unlink 只额外制造 ENOENT 窗口；新增「替换期间目标始终存在」用例（A/B 下旧实现缺失 2 次）。③ M5 koffi 初始化失败不再永久缓存，错误本地化 + 给排查方向；新增 3 项用例（mock koffi 让头两次 load 失败，断言每次真的重试） |
| 2026-09-13 | 实施 | 合计 | 71 项：未开始 49 / 进行中 3 / 已完成 19 | 阶段 5 完成 6（M20/N7/M23 + M2/M4/M5） |
| 2026-09-13 | 实施 | M6、M7 | 未开始 → 已完成 | ① M6 文件日志：新增 diag-log.js（大小轮转、绝不抛）+ 主进程接管 console（装在 console-safe 之后）+ 崩溃/未处理拒绝落盘 + 设置里「导出诊断日志/打开所在目录」；打包冒烟新增「日志已落盘且行带时间戳级别」断言（实测 508 字节）。② M7 有界重试：新增 llm-retry.js（只重试网络异常/408/429/5xx，Retry-After 优先夹 5s，退避 500/1500/4500ms + 抖动，中止后不再发新请求），接到 chat 非流式/流式握手/embedding 三处，并加「不得再有裸 fetch」的接线守卫。「UI 可见重试状态」有意未做（成功重试应当无感） |
| 2026-09-13 | 实施 | 教训（M6/M7） | — | ① 日志接管**必须在 console-safe 之后**：那层包装在管道断掉时直接 return，顺序反了日志会跟着一起消失 —— 而「管道断掉」正好是 GUI 态常态；② 重试实现里「中止检查」必须放在**发请求之前**：只在等待前检查时，sleep 期间被中止的下一轮仍会真打一次（单测实测调用次数 2 而非 1）；③ 把「拼装诊断报告」抽成函数才发现顺序（旧→新）值得单独锁住 —— 这类顺序错误在弹对话框那一步看不出来 |
| 2026-09-13 | 实施 | 合计 | 71 项：未开始 47 / 进行中 3 / 已完成 21 | 阶段 5 完成 8（M20/N7/M23/M2/M4/M5/M6/M7） |
| 2026-09-13 | 评审 | M2/M4/M5/M6/M7 | 批次复审（无 critical，4 major） | ① **M6 的后端进程日志完全不落盘**（独立 utilityProcess，RPC 走 parentPort、stdio 原为 inherit → GUI 态静默消失）→ 改 `stdio:'pipe'` 并在主进程转进文件日志 + 后端启动留痕作哨兵（打包冒烟实测 910 字节，含 `[backend] [wechat-worker] 后端进程已启动 pid=…`）。② **脱敏缺口**：`JSON.parse` 报错会带原文片段（实测泄漏 `image_aes_key` 前 10 位、`apiKey` 的 `sk-live-AB`），并随导出文件外发 → 所有落盘内容过 `redact()`。③ **M2 的「原子写」零覆盖**（退回 writeFileSync 仍全绿）→ 加跨进程「读者看不到写了一半」的判别用例（A/B 下变红）。④ **轮转零覆盖** + `maxFiles=1` 无上界 → 断言中间态 + 修退化分支。另修 8 项 minor：备份保留上限与撞名、宿主层告警去重、stagingDb 清理、koffi 错误带 `cause`、M5 用例顺序依赖、api.ts 注释悬挂、main.js 重复 require |
| 2026-09-13 | 实施 | N13 | 新增 | 评审列出全部出网点：LLM/embedding 之外还有 4 处（封面/图片/视频/whisper 下载）仍是单次尝试，M7 未覆盖（验收范围如此） |
| 2026-09-13 | 实施 | 合计 | 71 → 72：未开始 48 / 进行中 3 / 已完成 21 | 阶段 5 条目 33 → 34（+N13） |
| 2026-09-13 | 实施 | M1 | 未开始 → 已完成 | 经用户确认走「ACL 收紧 + 密钥搬出 config.json」：新增 `secure-fs.js`（启动时把状态目录/数据根收紧到当前用户，SID 取自进程令牌而不是 `USERNAME`）＋后端 `SECRET_FIELDS` 把密钥改写到 `secrets.json`（原子 + 0600）并从 config.json 删除（旧数据下次保存自动搬走）＋宿主层不再镜像密钥＋README 补「密钥存储与保护」。**过程中踩到一个真故障**：先按 `process.env.USERNAME` 授权，而本机该变量是 `SYSTEM`、进程是 `Administrator`，结果目录被锁成连自己都 EPERM（残留目录只能 takeown 后清）—— 已改为按 SID，并补一条「收紧后没把自己锁在外面」的用例 |
| 2026-09-13 | 实施 | 合计 | 72 项：未开始 47 / 进行中 3 / 已完成 22 | 阶段 5 完成 9 |
