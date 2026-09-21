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
| 阶段 0 | 止血：阻断发布的事故级问题 | 2 | 0 | 0 | 0 | 2 |
| 阶段 1 | 可验证性底座 | 3 | 0 | 0 | 0 | 3 |
| 阶段 2 | 合规闸门（并行推进） | 2 | 0 | 0 | 0 | 2 |
| 阶段 3 | 可靠性：超时、恢复、数据安全 | 5 | 0 | 0 | 0 | 5 |
| 阶段 4 | 安全加固与类型底座 | 3 | 0 | 0 | 0 | 3 |
| 阶段 5 | 中优先级：稳定性与性能 | 51 | 2 | 2 | 0 | 47 |
| 阶段 6 | 低优先级：清理与打磨 | 23 | 0 | 0 | 0 | 23 |
| **合计** | | **89** | **2** | **2** | **0** | **85** |

> 维护提示：改动任何条目状态后，请同步更新本表的四个计数与本阶段汇总表。
> 计数口径：只数本文件里**有独立条目的** ID，逐阶段相加（2026-09-15 重算：此前几处合计与各阶段明细不一致，以本表为准）。

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
| H1 | 清除已入库的真实密钥并轮换 | 无 | 0.5d | 已完成（仓库侧 + 历史重写 + 轮换 401 实测，2026-09-21） |
| H2 | 收敛工作区与 HEAD 的脱节 | 无 | 1d | 已完成 |

---

### `[x]` H1 · 真实密钥已被 git 跟踪

- **状态**：已完成（2026-09-21）——仓库侧清理、历史重写与强推、fresh clone 验收、用户侧轮换与 401 实测全部闭环　**依赖**：无　**预估**：0.5d
- **证据**：
  - `git ls-files wechat/` 列出 `wechat/config.json` 与 `wechat/llm.json`
  - `git show HEAD:wechat/llm.json` → `apiKey` 为一条真实 DeepSeek Key（形如 `sk-<32 位十六进制>`，此处不复制明文，避免二次泄露）
  - `git show HEAD:wechat/config.json` → `db_enc_key`、`image_aes_key` 明文（同样不复述）
  - **首轮遗漏、本轮补出**：`src/backend/wechat-data/tests/image-key.spec.ts` 有 3 处硬编码了与 config.json **同一个** `image_aes_key` 明文——首轮扫描只匹配 `sk-`/`AKIA`/`BEGIN PRIVATE KEY` 这类模式，漏掉了裸十六进制密钥。已替换为明显的假值（`0123456789abcdef`）
  - **第二轮遗漏、2026-09-21 复核补出**：改用「真实 `image_aes_key` 字面量 + `git grep` 全历史」复查（不再依赖 `sk-`/PEM 这类模式匹配，因为裸十六进制正是首轮漏掉的那类），又发现 **5 个仍被跟踪的文件共 13 处**硬编码同一把密钥：`scripts/m1-secrets-migration-smoke.js`(1)、`src/backend/tests/atomic-json.spec.ts`(7)、`diag-log.spec.ts`(2)、`host-settings.spec.ts`(2)、`result-cache.spec.ts`(1) —— 即这些文件在 **HEAD 与公开仓库里都曾明文暴露**（用途全是回环/脱敏断言夹具）。已统一换成假值 `0123456789abcdef`（提交 `c5e7b33`），`npm test` 190 文件 / 2165 用例全绿。
- **风险**：任何拿到仓库（含历史）的人可直接调用该 Key 消耗额度，并用 `db_enc_key` 解密该账号的微信数据库。
- **动作**：
  1. ✅ `git rm --cached wechat/config.json wechat/llm.json`（09-13）
  2. ✅ `.gitignore` 追加 `wechat/*.json`（保留 `wechat/README.md`）（09-13）
  3. ✅ **已完成（2026-09-21，用户执行）**：DeepSeek API Key 已作废重发 —— 旧 Key 实测 `GET https://api.deepseek.com/v1/models` 返回 **HTTP 401**（`Your api key: ****8116 is invalid`）。微信 DB key / image key 处置：**不轮换**（其泄露面要求攻击者同时持有本机库文件，而库不出本机），作为残余风险保留在风险登记
  4. ✅ 历史重写（见下）。远端无 fork、无 PR（09-21 实测），但仍需告知克隆者重新克隆
  5. ✅ `wechat/llm.example.json` / `wechat/config.example.json` 已在册（09-13）
- **历史重写（2026-09-21，用户授权执行）**：
  - 范围与工具：`git filter-repo --invert-paths --path wechat/config.json --path wechat/llm.json --replace-text <三把密钥字面量>`；**重写前先做完整镜像备份**（本地 `D:\super_time-backup-20260921.git`，112 refs，滞留本机不上传）
  - 结果：113 → **112 个提交**（一个「仅删除这两个文件」的提交变空，被 `--prune-empty` 剪除）；`main` `ee9c956→7339eec`、`feat/chat-message-module` `658af7d→e039041`、tags `v1.0.3/1.0.4/1.0.5` 同步重写并强推；`v1.0.0–v1.0.2` 早于泄露，哈希未变
  - 本地分支上游顺带修正：原先 `feat/chat-message-module` 的上游被设成 `origin/main`（`git push` 会直推 main），现改为 `origin/feat/chat-message-module`
  - **实测验收（fresh clone 自 GitHub，不是本地自查）**：`git ls-files wechat/` 只剩 README 与两个 example；两文件全历史 0 条记录；三把密钥字面量对全部 112 个提交 `git grep` **0 命中**；Releases（v1.0.5 等）与三个资产完好
  - 遗留：旧对象仍可按 SHA 经 GitHub API 访问（实测 `ee9c956` 返回 200）——这是 GitHub 侧缓存，需官方支持清理；**轮换凭据才是唯一可靠止损**。另：重写使全部提交哈希变化，任何既有克隆必须重新克隆
- **验收标准**：
  - [x] fresh clone 后 `wechat/` 下无任何含密钥的文件（2026-09-21 实测：只剩 `README.md` / `config.example.json` / `llm.example.json`）
  - [x] `git log --all -p -- wechat/llm.json wechat/config.json | rg 'sk-|db_enc_key'` 无命中（fresh clone 实测 0；另加「三把密钥字面量全历史 git grep = 0」的加强版）
  - [x] 旧 Key 调用返回 401（已作废）——2026-09-21 用户完成轮换后实测命中（见动作 3）
  - [x] 应用首次启动引导用户自行填写 LLM 配置（首启引导第 2 页明示「需先在数据配置中接入 OpenAI 兼容模型（供应商、模型名、API Key、Base URL）」；`Ask` / `DailySummary` / `PeriodSummary` 在未配置模型时都给出「尚未配置」的明确文案）
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
| H13 | 解决许可未明的第三方资产 | 无（法务并行） | 外部依赖 | 已完成（2026-09-21 用户确认：允许保留） |
| H14 | 补齐对外必备文档与隐私声明 | 无 | 2d | 已完成 |

---

### `[x]` H13 · 许可未明的第三方资产随包分发

- **状态**：已完成（2026-09-21）　**依赖**：法务确认（外部）　**预估**：外部依赖
- **结论**：**允许保留**——2026-09-21 用户确认法务结论为「微信表情原图（`wxemoji/**`）与朋友圈视频解密 WASM（`weflow-isaac64`）可随包分发」。走方案 A（保留），不实施降级方案 B；因此 `docs/RELEASE-PLAN.md` 与 README「已知限制」中「许可未明、待法务结论」的表述需同步改为「已取得法务结论：允许分发」。（书面件编号/归档路径待补记于此行。）
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
  - [x] 法务结论归档（**结论：允许保留**；来源：用户 2026-09-21 确认，书面件编号/归档路径待补）
  - [x] 发布物经扫描确认不含许可未明资产 —— 不适用（未走方案 B，资产继续随包分发）
  - [x] 应用在缺少该资产的机器上给出可读降级提示，而非崩溃 —— 不适用（同上）
  - [ ] `PROVENANCE.md` 更新为最终结论

---

### `[x]` H14 · 缺少对外必备文档

- **状态**：已完成（逐条验收已核；「首次启动同意」为 SSR + 逻辑 + 接线三层证据，**未做真人点击验证**）　**依赖**：无　**预估**：2d
- **证据**：
  - 无根 `README.md`（项目入口、功能概览、构建/启动说明全部缺失）
  - 无 `LICENSE` 文件（`package.json` 声明 MIT，但仓库内无正文）
  - 无 `CHANGELOG.md`、无安装说明、无用户手册、无 API 参考
  - **无隐私政策**——而本软件读取本地微信数据库，并**扫描 `Weixin.exe` 进程内存**以获取密钥（`keys/service.ts:111` → `win32-memory.ts:123,149`），隐私声明是合规必需
- **动作与结果（2026-09-15）**：
  1. **根 `README.md`**：定位（读本机数据的桌面工作台，非微信客户端替代品）、系统要求、
     快速开始、**首次启动三道闸门**（引导 → 授权 → 隐私同意）、本地跑起来需要的许可证签发流程、
     常用脚本表、数据存放位置、目录结构导航、文档索引、已知限制与免责声明。
  2. **`LICENSE`**：MIT 正文（与 `package.json` 一致），并写明随包第三方资产的两处登记位置
     （`VENDORED-LICENSES.md`、`PROVENANCE.md`）与 H13 未决事项。
  3. **`CHANGELOG.md`**：Keep a Changelog 格式 + 版本策略（唯一版本来源是 `package.json`；
     材料性变更要连带提升 `PRIVACY_VERSION`）；首段明确写出**尚不具备公开发布条件**及其阻塞项。
  4. **`docs/PRIVACY.md`**：按**代码实测**逐条列出出网点，而不是照抄条目里的旧表述 ——
     实测出网点比条目写的多：条目只提到「LLM / embedding / 模型列表」三处，实际还有
     ① 头像（腾讯图片 CDN，本地约 82% 无缓存）、② 聊天图片/朋友圈视频/公众号封面（微信 CDN）、
     ③ 地图 GeoJSON（jsdelivr / unpkg / datav.aliyun）、④ whisper 引擎与模型下载
     （huggingface / hf-mirror / github）；**模型列表实测不发请求**（来自本机设置与内置目录）。
     另写明进程内存扫描的目的与范围（只读 `OpenProcess`/`VirtualQueryEx`/`ReadProcessMemory`，
     不写、不注入、不挂钩）、密钥与日志的落盘位置与权限、以及**如何关闭出网**。
  5. **首次启动隐私同意闸门**：新增纯逻辑模块 `src/client/ui-app/privacy/consent.ts`
     （`PRIVACY_VERSION` + 解析/判定/记录/清除；失败方向一律是「再问一次」）与
     `PrivacyConsentGate.tsx`（独立一屏，勾选框 + 「同意并继续」，另给「不同意并退出」出口）；
     接进 `ui-entry.tsx`：引导与授权都过后若未同意则**不放行**，自动进主界面的条件里也带上它。
     主界面「重新查看启动页」会连同意状态一起重置（即「重新审阅并再次同意」的路径）。
  6. **Remote 接口参考自动生成**：新增 `scripts/gen-api-docs.js` → `docs/API.md`
     （132 个方法，含签名、JSDoc 说明与 `@param`/`@returns`），挂 `docs:api` / `docs:api:check`
     并进 CI；顺手修掉**启动页上过期的方法数**（写着 114，实际 132）。
- **验收标准**：
  - [x] 根目录存在 `README.md`、`LICENSE`、`CHANGELOG.md`（另加 `docs/PRIVACY.md`、`docs/API.md`）
  - [x] 隐私声明的出网点与实际逐条对应 —— 由 `src/backend/tests/privacy-statement.spec.ts`
        **双向**绑住：`gateway.ts` 里每个 `privacyGate('<feature>')` 都必须在文档里出现
        （新增 AI 功能漏写即红），文档列出的主机也必须能在源码里抽到（地图/whisper/LLM 三组）
  - [x] 首次启动必须显式同意后才能进入主界面 —— 判定的**失败方向**（无记录/形状不对/版本偏低
        都要重问）、**接线**（闸门真的渲染、自动进主界面的条件含 `consented`）与
        **未勾选时按钮禁用**（SSR 渲染事实）三处均有用例；共 8 + 6 项
  - [x] 接口参考的方法数与 `gateway.ts` 的 `@Remote` 一致 —— **132**（条目原文写 129，已按实测更正）；
        `docs/API.md` 与源码双向无差集、无重复注册，`docs:api:check` 在 CI 中
- **验证方式（实际执行结果）**：
  - `npm test`：**64 文件 / 424 通过 / 9 跳过 / 0 失败**（其中本项新增 33 项：
    `app-identity` 5、`legacy-migration` 8、`consent` 8、`api-docs` 5、`privacy-statement` 7）
  - `npm run privacy-gate:smoke`：**6 项全过**（未勾选时 `disabled`、有「不同意」出口、
    出网清单含「无开关」字样、渲染阶段不触发同意回调）
  - `npm run docs:api:check`：`ok（132 个方法）`；`npm run typecheck` exit 0；
    `npm run build:ui` 822 modules exit 0；`check:shim` / `ui:smoke`(21) / `rag:check`(20) /
    `license-gate:smoke` / `check:sns-video`(18) / `check:whisper-paths`(11) /
    `check:knowledge-graph` 全部通过
  - **可逆 A/B（变异全部被杀，每题各自「先转红再还原」）**：
    ① 把 `app.setAppUserModelId` 注释掉 → 红（AST 守卫，非字符串）；改成别的字面量 → 红；
    ② 迁移里不剔除 `db_dir`/密钥 → 红；③ 自动进主界面条件去掉 `consented` → 红；
    把同意屏注释掉 → 红；④ `gateway.ts` 新增一个不在文档里的 `privacyGate` 功能 → 红；
    ⑤ 从 `docs/API.md` 删掉一个方法小节 → `docs:api:check` exit 1 且用例红；
    ⑥ 启动页方法数改回 131 → 红
- **未做/未验证（如实标注）**：
  - **没有真人/真窗口点击验证**过同意屏（仓库无浏览器与组件测试环境，见 M13/M14 的结论），
    靠的是「纯逻辑用例 + AST 接线守卫 + SSR 渲染断言」三层；
  - `scripts/ui-acceptance.mjs` 需要**新加**一步才能越过同意屏（注入同意的 init script + reload），
    该改动**本机未执行**（playwright 未安装、且需真实数据与许可证、需关闭正在运行的实例）；
  - README 里写的 mac/Linux 不支持、whisper 下载域名等结论来自 H10/M18/代码巡检，未逐条复跑。
- **顺带发现并登记**：`cdn_enabled` / `cdn_local_decrypt` / `api_enabled` / `api_port` / `api_token`
  在界面上可见可存，但**全仓没有任何消费者**（死开关，N24；
  **N24 已于同日完成**：CDN 开关真生效、`api_*` 撤下界面，隐私声明同步）；
  CI 的后端崩溃自愈那一步依赖被 gitignore 的签发私钥，干净检出必失败（N23，同日完成）。

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
  - [x] 模拟一个永不返回的调用 → 超时后 UI 解除 loading 并提示，不再无限转圈（2026-09-21：`scripts/loading-recovery-e2e.mjs` 端到端实测，10 项全过；变异自证见该轮变更记录）
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

### 工作流 A · 密钥与配置持久化安全（5 项）

| ID | 任务 | 证据位置 | 验收标准 | 状态 |
|---|---|---|---|---|
| M1 | 密钥明文落盘且三处镜像 | `key-store.ts:51-56,81` 写 `keys.json`；`config.ts:119` 写 `db_enc_key`；`wechat-paths.js:277-291` 把密钥一并镜像进 config.json（`DERIVED_SETTING_KEYS:96-103` 只剔除路径类字段）  **已完成（ACL 方案，经用户确认）**： ① **权限收紧** —— `src/backend/secure-fs.js`：把状态目录与数据根收紧到**当前用户**（Windows `icacls /inheritance:r /grant:r <SID>:(OI)(CI)F`，POSIX 0700/0600），目录级继承让之后新建的文件自动跟随。授权取**进程令牌里的 SID**（`whoami /user`）而不是 `process.env.USERNAME` —— 实测本机该变量是 `SYSTEM` 而进程是 `Administrator`，照环境变量授权会把目录锁成谁也进不去（含自己）。 ② **密钥搬出 config.json** —— 后端 `query/config.ts` 的 `SECRET_FIELDS`（`db_enc_key`/`image_aes_key`/`image_xor_key`/`api_token`）写进 `<数据根>/secrets.json`（原子 + 0600）并从 config.json 删除，`getConfig` 读回、调用方无感。 ③ **文档** —— `wechat-data/README.md` 新增「密钥存储与保护」（三处位置、谁写的、为什么不在 config.json、权限怎么收、三条告诫）。  **第二轮独立复审：1 critical + 3 major + 7 minor，全部已修或明确记为取舍**： ① **critical（C1，我引入的静默销毁）** —— `saveConfig` 把 patch 里的**显式空串**当成「用户要清空」：界面在配置还没读回来时也能点保存（`Settings.tsx` 无条件把 4 个密钥字段放进 patch，未加载时是 `''` 与 `136`），于是 `secrets.json` 里的真密钥被整体抹成空值 —— 原文件是合法 JSON，连 `.corrupt-*` 备份都不会留，**不可逆且无痕**。修：新增 `secretIsMeaningful`（`undefined`/空串/等于内置默认值都不算「真值」），三处判定（写入取舍、读回优先级、旧数据搬运）统一用它；客户端另加两道闸 —— 保存按钮在配置读到之前禁用、渲染缓存不再落密钥。 ② **major** —— `image_xor_key` 的内置默认值 `136` 被当成真值搬进 `secrets.json`，此后 `getConfig` 的「secrets 优先」让 config.json 里对它**手工修改永久失效**（复审实测：钉住 136 后手工改 60，读回来还是 136）。修：默认值不搬；`getConfig` 同样按 `secretIsMeaningful` 判定（老状态自愈）；config.json **恒不保留**密钥字段。 ③ **major** —— 渲染进程把**含明文密钥的完整配置**写进 `localStorage`（`wxdata-render-cache:settings-config`），而 `<userData>/Local Storage` 不在权限收紧范围内 —— 等于第四份不受保护的明文副本（复审在本机 dev profile 的 leveldb 里读到真 `db_enc_key`）。修：`Settings.tsx` 用 `Omit<WechatConfigFull, 密钥字段>` 类型化缓存，写入前剥掉密钥，并在挂载时把**老版本残留**的带密钥缓存重写成干净版（加载失败那条路径也会执行，避免残留一直躺在磁盘上）。 ④ **major** —— 我原先声称「清理镜像 + 空 patch 迁移」在干活，复审实测**两者在正常形态下都是空转**（`wechat-host.js` 在每次 `saveWechatConfig` 返回前会调 `recordWechatSettings` 把镜像重写一遍），真正完成迁移的是回灌保存那条老路径。顺着这条线索又查出两个真缺陷：(a) **只存在于宿主镜像里的密钥**会在那次重写中被无声丢弃 —— 改成把 `mirroredSecretValues()` 并进同一次回灌 patch（后端写 secrets、回写镜像时顺手过滤掉副本，迁移与去副本一步完成）；(b) `recordWechatSettings` 原本是**整体替换**，任何内部的部分保存都会抹掉镜像里的普通设置 —— 改为**合并**，并在合并时清掉基准里的密钥残留（老安装自愈）。已成死代码的 `pruneMirroredSecrets` 直接删掉（留着只会让后来者以为它在工作）。 ⑤ **顺带修出的真缺陷** —— `saveConfig` 会把 `getConfig()` 合出来的默认值 `image_xor_key: 136` **落盘进 config.json**，于是启动期「config.json 里还有旧密钥吗」的判据**每次启动都误判为真**，多跑一次空 patch 保存；再叠加 (b) 的替换语义，宿主镜像里的普通设置（`db_dir`/`api_port`/whisper 设置等）被白白抹掉。修法是 ④③ 的直接后果：config.json 恒不留密钥字段 → 该判据只对**真的**旧数据为真。 ⑥ **minor** —— 启动早期那次预收紧不再无条件传默认数据根（`restrictDir` 内部会 `mkdirSync`，会把一个空的 `<userData>/wechat-data` 凭空造出来）；后端重启成功后的路径也补跑 M1 收尾（原先只有首启那段会跑，首启 init 失败而重启成功时自定义数据根会一直不收紧）；去掉 `atomic-json.spec.ts` 里恒真的装饰性断言；跨进程原子性用例新增「**必须出现同目录 `.tmp-` 文件**」探针 —— 复审实测「先把目标改名挪走、再原地写一份」这类语义上非原子的实现能让原先两条判据 10 跑 0 红（完全假绿），加了探针后同变异立即变红。  **验收**： · 单元测试 —— `secure-fs.spec.ts` 改为**逐条 ACE 枚举**（除当前用户外**不允许任何其他主体**；被直接收紧的对象不得有 `(I)`；新增 `SENSITIVE_FILES` 契约用例）。原先「`icacls` 输出含当前用户名」是**恒真空转**（icacls 会回显路径，路径本身含 `\Users\<user>\`）。 · 新增 `host-settings.spec.ts`（宿主层过滤/合并/自愈，原先**零覆盖**）与 `wechat-dirs.spec.ts`（bootstrap 白名单必须带 `secrets.json`/`keys.json`，否则跨根导入静默丢密钥）。 · `atomic-json.spec.ts` 扩到 9 项密钥边界：合并语义、空串回退、损坏留痕/救回、**界面未加载就保存（patch 全空串/默认值）时 `secrets.json` 一字不动**、默认值不落 secrets、老钉住状态自愈，以及用**文件 ID（ino）变化**做「替换 vs 原地改写」的确定性判别（含对照组）。 · **变异矩阵 22 条全部被杀死**（在 `%TEMP%` 副本上跑）：含每一轮修复前的缺陷复原（无条件回写含默认值的 secrets、「损坏就一律不写」、patch 空串算真值、默认值不排除、删除密钥字段、合并忽略基准残留、去掉 `/inheritance:r`、`SENSITIVE_FILES` 漏项、宿主过滤失效、`writeSecrets` 退回原地写、bootstrap 漏项、「改名挪走+原地写」等）。 · **打包态端到端** —— `npm run m1-secrets:smoke`（`scripts/m1-secrets-migration-smoke.js`）扩到**三个场景**，各启动一次真实产物：A 后端 `config.json` 有旧密钥且宿主配置为**空**（否则回灌保存会抢跑）→ 走空 patch 迁移分支，并断言密钥**不出现在日志/诊断导出**里；B 宿主镜像里**只有**密钥 → 断言它们**落进了 `secrets.json`**（只断言「镜像里没有了」会把无声丢弃放过去）；C **真实升级形态**（镜像含普通字段与密钥、后端 config.json 含旧密钥）→ 断言镜像普通字段保留、密钥全部落进 `secrets.json`。三场景都断言数据根 / `secrets.json` / 宿主状态目录的 ACL **只剩当前用户**。 · 全量回归：`npm test` **146 文件 / 306 用例（302 通过 / 4 跳过 / 0 失败）**、`npm run typecheck` 退出 0、`npm run pack` + `package:smoke` 通过、`security-guard:smoke` 通过，其余 11 个 CI 步骤直接跑均退出 0。  **未覆盖 / 已知限制**：非管理员会话、SMB / FAT32-exFAT 移动盘、只读盘、POSIX 分支未实测（推断：拿不到写 DACL 权限时加固会静默失效、密钥仍是明文 —— 已作为三条告诫写进 README）；`m1-secrets:smoke` 需先 `npm run pack`，未接入 CI（与 `package:smoke` 同级）；`secrets.json` 损坏目前只在日志里可见、界面无提示（复审 minor，记为已知取舍）；两处「密钥改回默认/清空」不再支持 —— 那等价于「没有密钥 / 用默认值」，而它换来的静默丢失风险大得多。 | 已完成 |
| M2 | 配置写入非原子，损坏静默吞掉 | 同上 | **已完成**：宿主层（`wechat-paths.js` 的 `writeFileAtomic`/`preserveIfUnparseable`）与后端（`query/config.ts` 的同名实现）都改为 temp+rename；解析失败时**不改动文件**、给出可读告警（同签名只告警一次），并在下一次覆盖前把残缺文件改名成 `config.json.corrupt-<时间戳>` 留痕（原来会被「默认值+补丁」无声覆盖）。验收：`src/backend/tests/atomic-json.spec.ts` **10 项** —— 除两份实现逐条对照与 `saveConfig` 集成外，还有一条**真正的原子性判别**：子进程写 8MB 的同时父进程不停采样目标文件大小，断言读者只会看到「旧内容」或「完整新内容」（A/B 实测：把实现退回直接 `writeFileSync` → 采样到 1 次「写了一半」→ 用例变红）。评审后另修：`.corrupt-*` 备份加了保留上限（3 份，原先随损坏次数线性增长且含完整密钥）与「pid + 单调计数」后缀（原先同一毫秒内的多次备份会静默互相覆盖、丢掉最早的损坏内容） | 已完成 |
| M3 | 导出/备份留半成品文件 | `export.ts:345,347,401,522,634,706,746` 直接写盘；`backup.ts:188` 子目录 `catch{}` 后仍报成功；`:220-246` 失败不清理 `.wcb` | 全部输出 temp+rename；部分失败必须上报（不再报成功）；失败时清理中间产物。与 H8 同期实施。**H8 已完成 zip 流式写盘与原子落地（`zip.ts` 的 `ZipFileWriter` + temp+rename）；xlsx 仍未流式、无取消/进度事件** **已完成（2026-09-15，UI 进度未接，见末尾）**：① **xlsx 条目级流式**——`zip.ts` 新增 `ZipFileWriter.addStream`（分块流式 deflate → 临时文件 → 拿真实 CRC/长度写本地头，**不引入 data descriptor**，归档格式不变）与共享 `StreamWriter`（背压 + 错误传播，ZIP 与 `.wcb` 共用）；`export.ts` 新增 `writeXlsxStream` 与行 XML 分块规则（内存版/流式版同一套，防漂移）。**实测 10 万行：流式 RSS +26.5MB / heap +13.8MB，对照「行数组 + join + 整块压」+221.6MB / +139.2MB（8.4×）**，40 万行 58.0MB vs 569.4MB；真实链路 5 万条会话 +14.8MB vs +38.0MB。② **进度 + 取消**：三个导出入口加 `onProgress`/`signal`，在收集页/行/逐会话/媒体/格式化处响应取消；取消后目标文件不存在、目录内无 `.partial-`/`.entry-`/`.wcb`。③ **备份**：`createBackup` 改「临时目录 → rename」且子目录失败**汇总抛错**；`createEncryptedBackup` temp+rename + 看背压 + 失败/取消清理。④ **gateway 已接线**（收口批完成）：`exportAllSessions`/`exportMoments` 收 `jobId` 并透传 `StreamControl`，新增 `cancelExportJob`/`getExportProgress` + `wechat-export/progress` 推送；`exportSessionMessages` 改 async 走流式入口。**验收**：30 项用例 + 4 组逆转变异全部转红并逐字节还原。**未达标/未验证**：**进度事件的渲染层中继未接** ⇒ 进度**没有端到端跑通**、**面板进度 UI 未做**；`exportCsv`/`exportAnnualReport` 未加 ctrl；`exportMoments` 只覆盖空数据与取消路径；内存实测是门控脚本、不入 CI；xlsx 流式产物只逐字节比对了**解出的条目内容**（压缩块边界不同）。**顺带修掉**：`.wcb` 旧实现不看 `out.write()` 返回值、错误监听挂在写完之后（已随 `StreamWriter` 修）；`end()` 改用 `finished()`。 | 已完成 |
| M4 | 快照替换存在不可读窗口 | 同上 | **已完成**：去掉 `unlink`，只保留 rename + 重试。Windows 实测（`%TEMP%` 探针）：rename 覆盖**已存在但未被打开**的文件是允许的（旧实现白删一次，凭空制造 ENOENT 窗口）；而目标被 SQLite 句柄打开时 unlink（EBUSY）与 rename（EPERM）**都会失败**，真正让同步成功的是重试等待 —— 所以 unlink 只有害处。验收：`sync-wal.spec.ts` 新增「替换期间目标始终存在」用例（可逆 A/B：加回 unlink → 目标缺失 2 次、用例红；评审连跑 10 次红、新实现连跑 10 次绿，无假绿/假红）。**评审补充的反向面**：目标被**普通 fs 只读句柄**（不只是 SQLite 句柄）打开时 rename 也会 EPERM，而这种情况旧实现的 unlink 是能成功的 —— 即去掉 unlink 在「普通只读句柄并发读者」下要靠 8×120ms 重试兜底，超时则本轮同步失败（无数据风险）。另修：WAL 分支的 `finally` 补上 `stagingDb` 清理（`atomicReplace` 抛错时它会以完整快照副本留在盘上） | 已完成 |
| N28 | 「回退 keys.json」从未接通：图片密钥被复制成 7 份实现，且库存密钥只写不读、同机换账号会用错钥匙 | 产物 `lib/index.js` 里搜不到 `resolveImageKeyPair`（esbuild 按死代码摇掉），而 `wechat-data/README.md:159` 承诺「密钥优先 config.json，回退 keys.json 自动获取结果」；解码入口各写一份 `cfg['image_aes_key']` 取数（gateway 6 处 + `query/export.ts` 1 处），xor 兜底分别是 `136` / `0` / `0xff`（`defaultConfig()` 恒给 136，所以后两种从未生效）；`keys/service.ts:121,183,211` 三处写入全用字面量 `'default'`，而 `getAccountKeysFromStore` 在产物里同样是 0 次引用 —— `keys.json` 里那份明文图片密钥没有任何读取方。 | **已完成（2026-09-20）**：`query/image-key.ts` 成为解码路径上唯一的密钥判定处，并且**真的接上了**（`decryptAllImages` / `getImageDataUrl` / `getImageDataUrlsBatch` / `getSnsImageDataUrl` / `getFileImageDataUrl` / `getEmoticonDataUrl` 六个 Remote 加 `export.ts` 的 `exportMediaCtx` 共 7 处改调它），三份 xor 常数收敛为一个 `DEFAULT_IMAGE_XOR_KEY = 136`；「没有密钥」由返回 `''` 改成返回 `undefined`（原先 `decryptAllImages` 那一处连 `length > 0` 都不判，空串会一路传进解码器）。**新增归属校验**：库存记录写明属于别的账号（kvcomm 路径的 `image_key_derived_wxid`，或内存扫描路径本次新记的 `image_key_source_wxid_dir`）且与当前账号（`resolveSelfUsername`）明确不同时，按「没有密钥」处理 —— 拿错的图密钥不会报错，只会安静地解出一张垃圾图。**继续只读 cfg 的三处刻意不动**（`getWechatConfigFull` 要显示的是「用户保存过什么」、`autoGetImageKey` 的已保存短路、`verifyImageKey` 验证的是配置那一版）：让显示层去读 keys.json 会把从未保存过的密钥报成已保存。**验收**：`image-key.spec.ts` 扩到 8 项（回退生效、config 优先、无密钥给 undefined、别人账号判死、当前账号放行、目录名带 `_后缀` 仍对得上、同形状仅账号不同的判别式反例、非 wxid 形状放行）；新增 `image-key-single-source.spec.ts` 4 项源码守卫（7 个入口都走解析点且不再自己读 cfg、gateway 里 `image_aes_key` 仍只有那 3 处白名单、库存密钥必须先过归属判定）。**变异**：归属判定改成永远放行 → 红；只认 `derived_wxid` 不认来源目录 → **第一版用例这里假通过**，补上判别式反例后转红；某个解码入口退回自己读 cfg → 红；全部按 sha256 逐字节还原。**未验证 / 遗留**：两账号真机切换下的端到端解图（需两份真实库）；`keys.json` **仍是单槽位** —— 真正按 wxid 分账要改写入方并处理老库迁移，本次只在读取侧把「用错钥匙」降级为「报未配置」；`getKeysInfoSummary` 与 `keys/index.ts` 的部分导出仍无调用方，未清理。 | 已完成 |

### 工作流 B · 可诊断性与降级（3 项）

| ID | 任务 | 证据位置 | 验收标准 | 状态 |
|---|---|---|---|---|
| M5 | koffi 失败被永久缓存 | 同上 | **已完成**：初始化失败时清掉缓存的 promise（成功才保留，避免每次扫描重复 dlopen）；错误信息本地化并给排查方向（缺原生二进制/杀软拦截/非 x64 + 建议先用「手动填写密钥」）。验收：`tests/win32-memory-retry.spec.ts` 3 项（mock koffi 让头两次 load 失败，断言每次都**真的重新尝试**、第三次成功、成功后走缓存；可逆 A/B：去掉清缓存 → 3 项全红） | 已完成 |
| M6 | 无日志落盘 | 同上 | **已完成**：新增 `src/backend/diag-log.js`（大小轮转：app.log → .1.log → .2.log，单份 2MB/共 3 份，**绝不抛**）；主进程在 `STATE_DIR/logs` 起日志并接管 console（**在 console-safe 之后**装 —— 那层在管道断掉时会直接 return，顺序反了日志会一起没）；`uncaughtException` / `unhandledRejection` 一律落盘；设置 → 高级 增加「诊断日志」行（导出… / 打开所在目录），导出会把各轮转份按旧→新拼上环境信息交给保存对话框。验收：`tests/diag-log.spec.ts` **11 项** + 打包冒烟断言日志落盘、行带时间戳/级别、且**后端进程的日志也在文件里**（哨兵：`[backend] [wechat-worker] 后端进程已启动 pid=…`，实测 910 字节）。**评审后的三项修复**（原文只覆盖了主进程，且轮转/脱敏无覆盖）：① **后端进程日志原本完全不落盘** —— 它是独立 `utilityProcess`，RPC 走 `parentPort` 与 stdio 无关，原先 `stdio: 'inherit'` 时那些 `[wechat-sync]`/`[config]`/重试日志进的是主进程那条（GUI 态已断的）管道、于是静默消失；现改为 `stdio: 'pipe'` 并在主进程转进文件日志（同时转写一份到本进程标准流保持开发态可见）。后端加了一行启动留痕（带 pid）作为常驻哨兵。② **脱敏**：`JSON.parse` 的报错会带出错位置附近的**源码片段**（`Unexpected token 'x', ..."apiKey":sk-live-AB"...`），于是「损坏的 llm.json/config.json」告警会把密钥前若干位落盘、并随导出文件外发。现在所有落盘内容都过一个 `redact()` 收口（键值/`sk-`/`Bearer`/长 16 进制），并有 3 项用例锁住（含评审那条真实报错形态）。③ **轮转有了真判别**：原先「文件数 ≤3、总量 <1000」的阈值断言把 `rotate()` 整个禁用仍全绿；现在断言中间态（`.1/.2` 各自装哪一行、丢的是最旧那份），并修掉 `maxFiles=1` 时轮转完全不生效的无上界分支 | 已完成 |
| M7 | LLM/embedding 无重试 | 同上 | **已完成（「UI 可见重试状态」一项未做，见下）**：新增 `src/backend/llm-retry.js`（可注入 fetch，便于确定性单测）：只重试网络异常/408/429/5xx，`Retry-After` 优先但夹在 5s 内，退避 500/1500/4500ms + ≤20% 抖动，`signal` 中止后**不再发新请求**；接到 `wechat-host.js` 的三个调用点（chat 非流式、chat 流式**握手**、embedding），并加接线守卫用例（该文件里不得再出现裸 `fetch(`）。验收：`tests/llm-retry.spec.ts` 12 项（5xx 重试至成功、401 不重试、429 按 Retry-After 等待、网络异常重试耗尽后抛最后一个错、中止即停、退避上限）。**范围**：只覆盖 **LLM/embedding**（验收标准如此）。评审逐个列出全部出网点：`article-cover.ts`（公众号封面）、`media-image.ts`（图片）、`sns-video.ts`（朋友圈视频）、`whisper.ts`（引擎/模型下载，有镜像轮换但无重试/续传）**仍是单次尝试** → 已登记为 **N13**；`llm-model-catalog` 与 `wechat:llm-models` 经核实**不发网络请求**，不需要重试。**「UI 可见重试状态」有意未做**：成功的重试应当无感（界面不该闪），失败才报错；要显示「正在重试」需新增事件贯通渲染端，属独立小改动 | 已完成 |

### 工作流 C · 后端性能（6 项）

| ID | 任务 | 证据位置 | 验收标准 | 状态 |
|---|---|---|---|---|
| M8 | 缓存失效风暴 | `meta.ts:276` + `wechat-host.js:47`：每次 `wechat-data/updated`（活跃期约 10s 一次）全量清空，随后重跑 `loadShardMeta` 遍历全部分片  **已完成**：改为「**按文件签名自失效 + 数据世代签名 + 宿主结果缓存定向失效**」。 ① **分片粒度** —— `meta.ts` 新增 `shardMetaOf(dbFile)`（按文件签名的缓存）；`shardCatalogDirs` 的目录级条目从此只管「文件清单与顺序」，逐分片内容各自缓存 —— 一个分片变了只重载那一个（原先签名由所有分片拼成，任何一个变了都让整条失效、把全部重载）。用例用**对象同一性**锁住：未变的分片必须复用同一个 `ShardMeta`、变了的必须是新对象且反映新结构。 ② **数据世代签名** —— `meta.ts` 新增 `bumpDataGeneration()` / `dataGenerationSig()`；同步回调由 `invalidateWechatMeta()` 改为 `bumpDataGeneration()`（全树被替换的场合仍整体清空）。给「依赖整棵树、没法用单文件签名表达」的条目一个廉价显式信号：算整树签名要每次查询 stat 成千上万个文件，比缓存本身还贵。 ③ **补齐 8 处签名没覆盖 loader 实际读的文件的条目**（原先进程内缓存靠那层整体清空兜住，去掉兜底后会只剩 TTL —— 这类退化看不出来，所以补了源码级接线守卫）：`sessions` 补消息分片；`calls` / `moments-insights` / `moments-monthly` 补 contact.db；`storage` 的 `msg/file` 树签名由「仅根目录」改为「根目录 + 各月份子目录」；`overview-extras` 补 contact.db、session.db + 世代签名；`status` / `db-health` 的常量签名改为世代签名。独立复审重做了穷举枚举，确认 8 处方向都对、无遗漏，另有 2 处（`overview`/`annual`）签名不含 `media/fts/resource` 三库而 loader 会打开它们 —— 复审实测真实数据下这 3 个库**没有** `Msg_`/`anti_revoke` 表 ⇒ 不可达，记为已知潜在缺口（签名它们要 readdir + N 次 stat，等于把缓存的成本付回去）。 ④ **宿主结果缓存定向失效** —— 原先每次数据更新整体 `clear()`，而这类方法里最贵的（朋友圈图片/视频帧）单次要「读文件 + AES 解密 + MD5」全量扫描（`wechat-host.js` 自己的注释记着实测 **12–21 秒**），活跃期等于让缓存永远命中不了。现在只丢**失败结果**（图片可能随后才下载到本地）与**内容会变的方法**（头像、远程封面）；内容寻址的成功条目保留。**复审（两轮）抓出两条我引入的回归，都已修**：(a) 手改 `secrets.json`/`config.json` 换图片密钥或 `db_dir` 不走任何 RPC，缓存里的旧结果不会失效 ⇒ 把「解码输入指纹」（这两个文件的 mtime+size）**放进缓存键**，自失效，不依赖任何通知。**第二轮复审用真实数据端到端纠正了我的说法**：磁盘上的 `decoded_images` 与 `sns-image`/`sns-video` 的内层缓存会先一步钉住字节（400/400 采样：换 AES 键 = 全程解码失败；只换 XOR = 字节不同但磁盘缓存优先命中），所以「永久回显旧字节」在真实链路上**不可达** —— 这条修法真正闭合的是「输入文件一变，已缓存的**失败**条目立刻重试」（同步暂停时事件永不到来，失败会一直留着），依然值得做，但不该说成「旧字节永久回显」；(b) `getArticleCover` 的「丢失败重试」本来是空转 —— 内层 `article-cover.ts` 把瞬时失败也存成负缓存（复审实测同一 URL 连查三次只发 1 次请求）⇒ 改为**不缓存瞬时失败**，并补回归用例。  **量化**（`node scripts/m8-cache-storm-bench.mjs`，本机真实数据；只改 mtime、测完复原）： · 目录里有 7 个 `.db`，其中**只有 4 个进入 catalog**（其余被 fts/resource 过滤器排除）——所以「上界」本身就该按 4 算。 · 一次事件后的分片元数据重算：**11.2ms → 2.6ms**（旧行为 = 清空后第一次查询；新行为 = 只 bump 一个分片）。模拟面板在 10 个事件后各查询一次：**104.3ms → 29.4ms（约 3.5×）**。 · **诚实结论**：元数据层省下的是每次事件约 8~10ms，属噪声量级（真实收益是首次查询延迟 11ms→3ms）；这次改造的**主要价值在宿主结果缓存那层**（一次 miss 是 12–21 秒，差三个数量级）。该层的 12–21s 量级本轮**未实测**（需要真实朋友圈图片/视频解码），只做了策略级单测与变异验证。  **验收**：`meta.spec.ts`（分片粒度对象同一性、世代签名契约、`getDbStatus` 随世代失效、**接线守卫**：同步回调必须推进世代且不得改回整体清空）、新增 `cache-sig.spec.ts`（签名必须覆盖 loader 读的东西：只改分片 mtime、内容不变，会话快照必须重算）、新增 `article-cover-cache.spec.ts`（瞬时失败必须能重试）、`result-cache.spec.ts`（定向失效策略 + 解码输入指纹进键 + 事件分支接线守卫）。**变异矩阵 10/10 被杀死**（含两条接线守卫）。全量：`npm test` 155 文件 / 324 用例（320 通过 / 4 跳过 / 0 失败）、`typecheck` 0、bundle 幂等 + 类型声明一致、`pack` + `package:smoke` 通过、`rag:check` / `check:knowledge-graph` / `check:backend-restart` 退出 0。  **已知缺口（如实记录）**：① 两处潜在签名缺口（见 ③，当前数据不可达）；② `storage-file-names` 的目录签名看不到「同名文件原地改 size」（NTFS 目录 mtime 不随内容变），已把该条目 TTL 从 30s 收回 **10s** 以回到改造前的实效上界；③ `db-health`/`status` 读的兄弟文件（`message_edits.db`、`decoded_images`、搜索索引）由非同步写入者改动时不推进世代，靠 5s TTL（与改造前一致）；④ `article-cover` 仍会缓存「文章里确实没有封面」这种稳定负结果（只放过了瞬时失败）；⑤ 宿主结果缓存的收益量级未实测。 | 已完成 |
| M9 | 向量检索每次全量排序 | `embedding.ts:356-363`（行号已随重构移动）：载入约 13.5 万行后每次查询 `map+sort`，O(N log N)≈2.3e6  **已完成**：粗筛改为**计数选择**（`selectByHamming`）—— 我们只需要前 `candidatePool` 名（几十到几百），却为十几万行各分配一个 `{r,d}` 对象再做一次全量比较排序。现在是：① 一遍算汉明距离存进 `Uint8Array`（距离恒在 [0,64]，一字节够）+ 65 格直方图；② 用直方图找「累计条数 ≥ pool」的距离上界 `limit`；③ 一遍**稳定计数排序**把 `d ≤ limit` 的行按 (距离升序, 原顺序) 落位，取前 `min(pool, N)`。选出的序列与「全量排序后取前 pool」**逐项相同**（含同距离内的先后），代价 O(N) 且零逐行分配。  **量化**（本机真实向量库是**空的** —— `wechat_rag_vectors.db` 的 vectors 表 0 行，所以用与 `loadHashRows` 产物同形状的合成数据；脚本进仓）： · `MEASURE_HAMMING=1 node node_modules/vitest/vitest.mjs run src/backend/wechat-data/tests/hamming-select.measure.spec.ts` · N=135000 / pool=200：**15.5ms → 1.2ms（12.9×，省 14.3ms/次）**；N=200000 / pool=400：**24.4ms → 2.2ms（11.0×，省 22.2ms/次）**。 · **诚实结论（复审也强调了这一点）**：这是**毫秒级**优化。一次真实检索的墙钟时间由 embedding 网络往返（几百 ms）主导，这一步的收益端到端几乎看不出来；它值钱的地方是「首次查询的粗筛延迟」与「每个改写变体各查一次时的累计 CPU」。顺带量到同一路径上还有两处 per-query 的 O(N) SQL（`vectorIndexStatus` 为一次提问重开两次连接、各做一次 `COUNT(*)`，实测各 ≈1.25ms），以及粗筛表加载本身 = **250ms**（但按文件指纹缓存，只在进程内首次/重建后付一次）——前者已登记为 **N14**。  **验收**：`retrieval.spec.ts` 里 30 项粗筛用例，核心是**差分测试**：把改动前的全量排序算法在测试里重写成 oracle，断言选出的 rowid 序列逐项相同 —— 覆盖面含 13.5 万行、`pool == N`、`pool == N-1`、`pool > N`、`pool = 0`、非整数/NaN/Infinity pool、距离全相同、距离恰好 = 64、大量并列、N = 0；另有 `popcount32` 与朴素实现的 1 万条独立对照（差分测试两侧共用它，所以「popcount 本身对不对」必须独立验）。**接线**两层齐备：源码级守卫（粗筛段必须调 `selectByHamming` 且不得出现 `.sort(`）+ 真值级端到端（`buildVectorIndex` 打桩 embedding → `searchDense`，用**余弦的定义**独立算出真值排序对照，`candidatePool ≥ N` 与 `candidatePool` 极小两种情形）。**变异矩阵 10 条被杀死**（含复审发现的「回退优化」「直方图少一格」「去掉 pool 归一化」三条），1 条（放宽 `limit` 同族）经复审证明**输出恒等**、无反例，记为等价变异。全量：162 文件 / 339 用例（334 通过 / 5 跳过 / 0 失败）、typecheck 0、bundle 幂等、pack + package:smoke 通过、rag:check / ui:smoke / check:backend-restart 退出 0。  **与旧行为的唯一有意分叉**：负数 `pool` 旧实现是 `slice(0, -k)`（返回「全部去掉尾部 k 条」，显然是笔误产物），新实现按 0 处理（返回空）。生产不可达（`pool = Math.max(candidatePool, topK)`，两者都非负），并且已写成显式用例记录该分叉，免得「差分测试全绿」被误读成「行为逐位一致」。  **复审（静态）**：本机 `bash` 被策略整体拒绝（`bash: ask` → denied），复审退化为静态审计 —— 它无法跑任何命令，但给出了等价性的静态证明与手工 trace、等价变异定理，并抓到三条实质问题（接线零覆盖、非整数 pool 抛 `RangeError`、`d=64` 与 popcount 独立校验缺失），全部已修；`docs/rag/RAG-ARCHITECTURE.md:132` 的实现描述已同步更新。复审未能独立复现任何实测数字（环境限制），相关结论按推断标注。 | 已完成 |
| M10 | embedding 远程串行、无缓存 | `embedding.ts:259-279`（行号已随重构移动）（batchSize=16、maxDocsPerBuild=40000）→ 单次建库约 2500 次 HTTP 逐批 await；`simhash` 同步 O(64·dim) 阻塞  **已完成**：两件事 —— 同文本只请求一次（扇出），请求有界并发。 ① **按「截断后的文本」分组**（即「文本 hash → 向量」缓存的实现形态）：同一文本只 embed 一次，向量扇出到该组所有行（每行仍有自己的 rowid/doc_key/时间戳）；每处理完一组即释放，向量不留驻。**立项实测**：真实搜索索引 `message_meta` 152446 行里只有 66270 个不同文本 ⇒ **56.5% 是重复的**，所以去重比并发更值钱。键用**截断后**的文本，因为那才是送进模型的输入（两个只在 `maxCharsPerDoc` 之后不同的文本本来就得到同一向量）。 ② **有界并发**：worker 原子认领下一批唯一文本；新增配置 `embedding.concurrency`（默认 4，运行时夹到 [1,16]），`batchSize` 也一并夹到 [1,256]（两者都来自可手改、且不做数值校验的 `rag-config.json`）。 ③ **失败不半写**：任一批失败置 `failure`，其余 worker 停手、在飞请求回来后不再写库，末了 `if (failure) throw` → 整库 ROLLBACK。 ④ 扇出每 512 行让出一次事件循环（复用 `search.ts` 的 `yieldToLoop`）；返回值新增 `embed_calls`，让「省了多少请求」在生产里可观测。  **量化**（`MEASURE_M10=1 node node_modules/vitest/vitest.mjs run src/backend/wechat-data/tests/vector-build.measure.spec.ts`；桩 embedding 带固定 40ms 延迟、合成数据 —— 本机真实向量库是空的）： · 4000 行（56.5% 重复、30% 是同一热门文本）：请求 **250 → 110** 次；墙钟 **11.70s → 1.32s（8.8×）**。 · 40000 行：请求 **2500 → 1088** 次；实测 **12.81s**；事件循环最长阻塞 **33.7ms**。 · 极端情形（90% 行是同一文本、单组 1.8 万行）：最长阻塞 **29.6 → 14.7ms**（周期让出的作用；常规规模下两者差异在噪声内 —— 常规阻塞主因是事务 COMMIT 的 fsync，复审另测得 1.8 万行扇出本身是 82ms 纯同步 insert）。 · **验收项「建库期间后端可响应其他查询」由复审直接实测**：建库期间并发只读查询 86 次采样 **0 错误、最长 1ms**（回滚日志模式下，写事务持 RESERVED 期间同库只读连接完全不受阻 —— 所以这项只需证明事件循环不被独占，不需要 WAL）。 · **旧实现的墙钟由复审实测**（它从 git 取出真实的 pre-M10 代码跑同一桩），我用「请求数 × 延迟」建模成 10.00s/100.0s，**低估约 17%** —— 真实加速 8.8×/9.1×。  **我主动证伪的一条立项假设**：「`simhash` 同步 O(64·dim) 阻塞」**不成立** —— 复审独立计时 **0.0335ms/篇**（dim=768、64 平面，`getPlanes` 有缓存），每批 16 篇 ≈0.54ms，相对 40ms 的网络往返可忽略；而且去重后 `simhash` 是**每个唯一文本一次**，总量比旧实现更小。周期让出因此是「最坏情况的兜底」而非「修好了一个复现出来的卡顿」—— 保留它是因为代价近乎为零而最坏情况减半。  **验收**：新增 `vector-build.spec.ts` 10 项 —— 重复文本合并成一次请求但**每行都有自己的向量**（含「改一行的 vec 不影响同组其它行」的别名检查：扇出共享的是 `Float32Array` **视图**，实测 sqlite 绑定即拷贝）、按截断后文本去重、无重复时行为不变、并发真的并行且**上限确实是 16**（夹具要顶到上限，否则上界断言是空转的）、`concurrency=1` 严格串行、`concurrency`/`batchSize` 的非法与越界值都被夹住、失败整库回滚且无未处理拒绝。**变异矩阵**：去重/截断/并发/扇出/钳位/回滚等 10 条被杀死；2 条属**结果等价**（在飞请求多写的行都会被回滚丢弃；`if (failure) return` 的冗余守卫），1 条是**运行时契约守卫**（别名检查，只有 node:sqlite 改成惰性绑定才会失败）。全量：168 文件 / 350 用例（344 通过 / 6 跳过 / 0 失败）、typecheck 0、bundle 幂等、`rag:check` / `ui:smoke` / `check:backend-restart` 退出 0。  **已知取舍（复审确认，非缺陷）**：若 provider 对同一文本返回不同向量，去重会**强制**同文本同向量（旧实现下同文本的 8 行实测拿到 7 个不同向量）——方向上是收敛而非发散；代价是单次坏响应会被扇出放大到整组，且增量建库不会重试该组。另外 `onProgress` 的语义由「批结束位置」变成「已写行数」，但两个调用点都不传它（生产不可达）；`gateway.ts` 的每日摘要任务仍是 N 次串行 LLM 调用（同形态但通常只有 1–2 项），已登记为 **N15**。 | 已完成 |
| M11 | N+1 查询 | `messages.ts:665-728`（每分片×每表各一次 `WHERE server_id=?`，无索引→全表扫描）；`media-image.ts:99-153`（每张图新建连接）；`media-image.ts:637`  **已完成（但按实测大幅收窄了范围）**：先在真实数据上量了一遍（`MEASURE_M11=1 node node_modules/vitest/vitest.mjs run src/backend/wechat-data/tests/nplus1.measure.spec.ts`），**条目里的三条假设有两条不成立**： · 「`WHERE server_id=?` 无索引 → 全表扫描」—— 实测**整型等值走覆盖索引**（`EXPLAIN QUERY PLAN` = `USING COVERING INDEX ..._SERVERID`）；全表扫只发生在**第二轮** `CAST(server_id AS TEXT)` 兜底。 · 「`media-image.ts:637` 每张图读整张 dir2id」—— `dir2id` 只有 **89 行**，整张读 **0.02ms**（30 张图 ≈1ms），不是瓶颈。 · 「每张图新建连接」真实但很小：**1.03–1.10ms/张**（30 张 ≈31ms），成本主要是建连 + 候选路径 `existsSync` 探测。 · 条目没提的一点：客户端 `apiResolveChatHistory` **全仓只有一处调用、且是用户点击时调一次**（不是循环）；`ledger.ts` 早就有分块（400/轮）两遍的批量实现 `resolveMessagesByServerIds`。  **实际改动**：给 `queryMessageByServerId` 加签名缓存（key 带 `decryptedDir`、sig = shardCatalogSig(dec, message 目录)，正负结果都缓存；实现挪进私有的 `queryMessageByServerIdUncached`）。同一 id 重复查询实测：命中 3.79ms → **0.09ms**、未命中 77.1ms → **0.07ms**。 **收益范围（复审纠正过我一次）**：`cachedBySig` 的 maxAge **从写入计时、不从访问计时**，所以省掉的是 **<5s 内的重复**（双击/重渲染/重试）；「点了没找到 → 等同步完再点」的间隔通常 >5s（实时同步 tick ≈10s），**那一次仍要重新扫**。表述已按此收敛。  **有意没做**：①「media-image 复用连接」——我原本的理由（Windows 长句柄会拖住同步的 `atomicReplace`）**对 `resolveImageFilePath` 用错了对象**（复审指正：`hardlink.db` 在本仓库没有任何写入点、也不是同步的替换目标，对它长期只读句柄是安全的；该理由只对 `resolveImageResourceHint` 里开的**消息分片**句柄成立）。真正的杠杆另有其事，见 N16。② 批量 RPC —— 属接口变更，不在本轮扩大范围。  **复审的另一处确认**：我担心的「sig 的过滤集与 `shardCatalog` 不一致 → 数据变了 sig 没变」**不存在** —— `shardCatalogDirs` 与 `shardCatalogSig` 共用同一段谓词字面量，实测同一批 4 个分片、增删分片两者同步变、把被过滤的文件加进去两者都不变。  **验收**：新增 `messages.spec.ts` 两项（重复查询返回同一个对象、分片 mtime 一变即失效、缓存不跨数据根串味）+ `nplus1.measure.spec.ts`（门控的真实数据测量，含「冷未命中每次换新 id」与「缓存后重复」分开量的方法说明）。全量：171 文件 / 353 用例（346 通过 / 7 跳过 / 0 失败）、typecheck 0、bundle 幂等、`rag:check` / `check:backend-restart` 退出 0。  **未做/遗留**：`msg-by-sid:` 条目落在 `meta.ts` 那个**无上限**的全局 `entries` Map 里（复审实测负条目 ~740B、命中条目可含整份 `rich`），条目数随「用户点过的不同 serverId」累积 —— 属既有缓存模式（`sessions`/`moments-insights` 同样如此），随 N16 一并处理。 | 已完成 |
| M12 | 去重 O(n²) | `fusion.ts:87-105`、`compress.ts:102`（n-gram 未缓存）  **已完成（范围按实测收窄，其中一处改完又撤回）**：先量后改（`MEASURE_M12=1 node node_modules/vitest/vitest.mjs run src/backend/wechat-data/tests/dedupe.measure.spec.ts`）： · `dedupeFused` 的 N 上界是 `fusion.keep`=120：最坏情形（全同会话、时间全在窗口内 ⇒ 两个廉价过滤都不生效）**14.28ms**；而现实形状（4 会话交替 + 时间散布）只要 **0.54ms**。 · compress 的句子级去重：`seenLines.some(s => … || jaccard(s.text, body) >= t)` **每次都重建两侧的 3-gram**，且要与**所有**会话的已见行比较 ⇒ **≈17.7ms/次提问**（10 窗口 × 6 行 × ≤60 条已见）。  **改动（只落在 compress）**：`seenLines` 由 `Array<{username,text}>` 改为 `Map<username, Array<{text, grams}>>` —— 每行 3-gram 只在建时算一次（新增私有的 `gramsOf3` / `jaccardGrams` 取代 `jaccard(a,b)`），跨会话比较随之消失。实测 **1.77ms → 0.92ms**/窗口（≈2×，即 ≈17.7 → 9.2ms/次提问）。 **fusion 那处改完又撤回**：按会话索引（`Map<username, indices[]>`）确实去掉了「每个候选都要与其它会话的已保留项比一轮」的无用比较，但在本机配置的 N（≤120）下**没有可测收益** —— 现实形状 0.54ms → 0.70ms（噪声内，Map 查找自身也有开销），最坏情形 14.28 → 14.06ms 不变。按「不加没有证据的代码」撤回原实现，并把这段测量与理由留在 `dedupe.measure.spec.ts` 作为「**为什么没改 fusion**」的证据；连带删掉那一版已变成同义反复的差分测试（oracle 与实现同源后不再能失败）。  **验收口径要说清（复审 major）**：原始验收写的是「候选数 2000 时去重耗时有量化改善」。实测**未触及那一档**：`dedupeFused` 是 O(N²)，N=1920 最坏 **3772ms**（复审实测 120→14ms、960→0.9s、1920→3.8s）。`keep` 默认 120 时现实形状只要 0.5ms，所以那一档只在**手改 `rag-config.json`** 时才可达 —— 而它可手改、`deepMerge` 又不做数值校验。因此本轮**改了验收口径**（本行已改写）并补上防爆措施：给 `fusion.keep` 加**硬上限 400**（最坏约 0.16s），load/save 两条路径都过，附用例与变异验证。想要更宽召回请调 `channels.*.topK`。 **诚实结论**：这两处都在一次问答的 LLM 调用（秒级）面前是**几十毫秒**量级 —— compress 那处值得做（2×、行为不变），fusion 那处不值得动（复审另试了「更显然更优」的 gram 倒排索引：最坏只有 1.9×，现实形状反而变慢）。  **验收**：`rag:check` 20 项通过（检索层回归含 fusion 去重）、`npm test` 173 文件 / 355 用例（346 通过 / 9 跳过 / 0 失败）、typecheck 0、bundle 幂等。新增 `dedupe.measure.spec.ts`（门控实测 + 撤回理由）。 | 已完成 |
| M20 | 首屏被后端 init 阻塞 | `main.js:461` 在 `createWindow()`（`:622`）之前 `await wechatBackend.init()`，init 会 import 783KB bundle + 启动同步 | 先建窗口并显示加载态，后端 init 改为后台进行；验收：记录首帧时间对比，窗口在 init 完成前即可见 | 已完成 |

### 工作流 D · 前端体验与正确性（7 项）

| ID | 任务 | 证据位置 | 验收标准 | 状态 |
|---|---|---|---|---|
| M13 | 流式问答并发缺陷 | `use-ask.ts:106-149`：`asking` 在闭包中可能过期，快速连点可并发进入；`finally` 无条件 `setAsking(false)`，先返回者把仍在生成的轮次标记结束  **已完成**：闸门从「闭包里的 `asking`」换成**独立模块里的 ref 单飞闸**（`panels/ask-gate.ts`），并认领轮次 id。 · `tryStart()` 已在跑则返回 null ⇒ 连点第二次直接被忽略（只产生一轮）；状态在 ref 里，同步判定（读-判-写之间无 `await`），不受 React 渲染时机影响 —— 原实现依赖 `asking` 的**闭包值**，而状态更新是异步的，第二次点击可能落在「已 setAsking(true)、还没重渲染」的窗口里。复审另确认本应用 `ui-entry.tsx` 用 `createRoot` 且**未包 StrictMode**，事件处理器不会被双调用，所以不存在「两个闸门实例」。 · `finish(id)` 只有**当前轮**才释放闸门并清流式缓冲 ⇒ 过期轮次迟到的 `finally` 不许截断仍在生成的新轮。复审穷举 5 轮共 1920 种交错，这个 false 分支**不可达**（0 次），已按建议把注释改为「防御性不变量」。 · 轮次 id 同时用作后端流式标识（原来另生成一个）。复审逐字实测过滤式：`streamIdRef` 为空串时三种 delta（无 id / `id:''` / 别的 id）**全被丢弃**，不存在「空 id 全量接纳」。**顺带修掉一个旧毛病**：原实现里过期轮的 `finally` 会把 `streamIdRef` 置空，导致仍在生成那轮的增量全丢（流式冻结、只出最终答案）。  **测试基建**：此前 vitest 只收后端 spec（配置注释也写着「前端组件级测试仍缺失」），这处改动连一个用例都进不来。给纯逻辑前端模块开了 include（`src/client/ui-wechat/src/client/**/*.spec.ts`，不 import react、不碰 DOM）。  **验收**：`ask-gate.spec.ts` 6 项（连点只开一轮 / 本轮结束后才能开下一轮 / 过期轮次 finish 不释放闸门也不被认作当前轮 / 同轮 finish 两次幂等 / 默认 id 不重复 / 初始无在跑轮次）+ **`use-ask.wiring.spec.ts` 3 项接线守卫**。守卫是复审要求的：它实测把 `use-ask.ts` 整体退回改动前，**全量 365 用例仍 0 红** ⇒ 没有守卫就无回归信号。变异双向验证：head 源绿；「早退改回闭包 `asking`」「finally 改回无条件收尾」两种回退各被对应用例抓住。全量：179 文件 / 368 用例（359 通过 / 9 跳过 / 0 失败）、typecheck 0、`build:ui` + `check:shim` + `ui:smoke` 通过。  **未验证（如实标注）**：仓库没有 hook/DOM 测试环境（jsdom、react-test-renderer、@testing-library 都不在依赖里），所以「真实快速连点」的端到端表现**未人工验证**；`use-ask.ts` 与闸门的接线由类型 + 守卫 + 代码审查保证。另记录两点不在本轮验收口径内的问题：闸门是**按 hook 实例**隔离的（「微信问答」页签与群聊 `SessionAsk` 面板同时挂载时可各跑一轮，各自的 turns/streamText 独立、流式按 id 不会串台）；闸门没有「取消/超时」出口（`apiAskWechat` 悬挂则该实例一直拒绝新提问 —— 旧实现同样如此，非回归）。 | 已完成 |
| M14 | 长列表虚拟化已装未接线 | `@tanstack/react-virtual` 在依赖中，`kit.tsx:392-470` 实现了 `<VirtualList>`，但全仓无引用；实际靠 `useProgressiveList`（`hooks.tsx` 的 `usePagedList`，首屏 30/120 条）增量挂载  **已完成（选项 b：移除，不是接线）**：条目允许「接线 或 移除」二选一，我选移除，理由是**形态不匹配**而不是「懒得接」： · `VirtualList` 的签名要求**固定 `rowHeight`**，而真实大列表（聊天消息、朋友圈、通讯录）的行是**可变高**的 —— 图片、多行文本、富卡片混排。按固定行高虚拟化会切行错位；正确的虚拟化要先做**动态测高 + 滚动锚定**，那是会改变滚动体验的改动。 · 本会话**没有浏览器验证条件**（仓库没有组件级测试环境，M13 复审已确认 jsdom / react-test-renderer / @testing-library 都不在依赖里），盲接一个会改滚动行为的组件不合格。 · 现有方案并非「漏了一个优化」：列表由 `usePagedList` 增量挂载，首屏只挂 30/120 条；`VirtualList` 是一份与它重复、且形态不匹配的死代码。  **改动**：删 `kit.tsx` 的 `VirtualList` 与其 `useVirtualizer` import（其余 hook 仍在用，未动）、删 `kit.module.css` 的 3 条 `.vlist*` 规则、从**两个** `package.json`（根 + `src/client/ui-wechat`）移除 `@tanstack/react-virtual`，并同步更新 `package-lock.json`（**只删该依赖相关的 30 行**，无连带改动）—— 这一步不能省：只改 manifest 会让 lock 与它不一致，CI 的 `npm ci` 会直接失败。  **验收**：全仓 `VirtualList` / `useVirtualizer` / `react-virtual` 引用数 **0**（grep 实测）；`npm ls @tanstack/react-virtual` 从「有声明」变为 extraneous（本地 node_modules 未清，下次 install 自然消失）；typecheck 0、`build:ui` + `check:wx-tokens`（CSS 改过）+ `check:shim` + `ui:smoke` 21 项通过；全量 179 文件 / 368 用例（359 通过 / 9 跳过 / 0 失败）。  **没达成的原验收**：条目原文的验收是「1 万条消息滚动流畅且 DOM 节点数**有上界**」。现状是增量挂载 —— 首屏有界（30/120），但用户一直往下滚时 `usePagedList` 的 `count` 会持续增长，**DOM 节点数没有硬上界**。这一条**未达成**，已按实际形态登记为 **N18**（需要动态测高的真虚拟化），并说明为什么不能靠现成的 `VirtualList` 抄近路。 | 已完成 |
| M15 | 设置面板定时器泄漏 | `Settings.tsx` 的四处 `setInterval` 轮询（whisper 模型下载 / 引擎安装 / 批量转写 / 解密）仅在 finally/stop 清理，组件中途卸载不清理，持续打 IPC  **已完成**：新增 `panels/poll-registry.ts`（纯模块、可测）—— 四处轮询全部改走 `polls().start(fn, ms)`，并在挂载时挂 `useEffect(() => () => pollsRef.current?.stopAll(), [])`： · 登记表按 id 追踪，`stopAll()` 一次清干净（**卸载即停**）；逐个 stop 幂等，且 `stopAll` 之后再调它不会去 clear 一个可能已被复用的 id。 · 修掉的真实窗口：原结构是「创建 interval → await 一个可能跑几分钟的下载/转写 → finally 里 clear」，而 `finally` 只在 await **落定之后**才执行 —— 用户中途切走面板时，interval 仍在每 400~500ms 打一遍 IPC，并在已卸载的组件上 setState。 · 抽成独立模块是因为仓库没有 hook/DOM 测试环境（M13 复审结论），而这里要守的正是「卸载后不再回调」这个语义：用例用**假时钟**把「切走面板」模拟成 `stopAll()`，断言回调真的不再触发。  **接线守卫**（按 M13 的教训补）：模块级用例测不到接线，所以另加 3 条源码级断言 —— 文件里**不得**再有裸 `setInterval(`/`clearInterval(`、四处轮询都走 `polls().start`、必须有卸载清理。少了任一条，泄漏会静默回来。  **验收**：全仓该文件里裸 `setInterval`/`clearInterval` 计数 **0**、`polls().start` 调用点 **4**；`poll-registry.spec.ts` 8 项（5 项模块语义 + 3 项接线守卫）；全量 182 文件 / 376 用例（367 通过 / 9 跳过 / 0 失败）、typecheck 0、`build:ui` + `check:shim` + `ui:smoke` 21 项通过。  **未验证（如实标注）**：条目原文的验收是「**抓取实际 IPC 日志验证**」。本会话没有跑起真实 App、并在下载中途切走面板的条件（仓库也没有组件级/端到端测试环境）⇒ 这一步**未做**。已由「假时钟语义用例 + 接线守卫」覆盖机制与接线两层，但没有真实 IPC 日志佐证。 | 已完成 |
| M16 | IPC 死 channel 与类型契约滞后 | 条目原文：死 channel `window:maximize-toggle`、`window:is-maximized`、`wechat:dispose`、`license:activation-request`、`license:fingerprint`；类型滞后 `api.ts` 手写 `WechatRemote` 未含 `getFileImageDataUrl`、`exportSnsVideo`  **类型契约那一半：已完成**（随 H11）—— 实测 `WechatRemote` 现在恰好声明 **132** 个成员，与 `gateway.ts` 的 `@Remote` 集合**零缺零多**，并且已有 `remote-contract.spec.ts` 三条断言守着（含「两侧数量非零且一致」防解析失效空转）。  **死 channel 那一半：实测推翻了「死 channel」的说法，改为进行中（等产品决定）**。全仓扫描（1256 个文件，含仓库根）结果：这 5 个 channel **每一个都被根目录 `preload.js` 通过 contextBridge 暴露**（与确定在用的 `window:minimize` / `window:is-fullscreen` 完全同形），也就是说链路是**通的**；真正缺的是**渲染层的调用方**： · `window:maximize-toggle` / `window:is-maximized` —— `preload.js` 暴露为 `windowControls.toggleMaximize` / `isMaximized`，但全仓**零调用**：`ui-app` 的自绘标题栏（`frame: false`）确实在用 `windowControls`，却只有最小化/关闭/全屏，没有最大化控件（Windows 上双击 `-webkit-app-region: drag` 区即可最大化，所以这是「少一个按钮」而非「功能坏了」）。 · `wechat:dispose` / `license:activation-request` / `license:fingerprint` —— 同样只被 preload 暴露、零调用方（`getDeviceFingerprint` 仍被 `backend-restart-smoke` 用着，删 handler 不会让它变成死模块）。  **处理（用户已确认走「删掉这 5 个暴露」）**：同时删掉 main.js 的 handler 与 preload.js 的包装 —— `window:maximize-toggle`（+`toggleMaximize`）、`window:is-maximized`（+`isMaximized`/`onMaximizedChange`，以及配套的 main 侧 `maximize`/`unmaximize` → `window:maximized-changed` 事件对）、`wechat:dispose`、`license:activation-request`、`license:fingerprint`。**保留**最小化/关闭/全屏三件套（`ui-app` 的自绘标题栏在用）。顺带清掉两处因删除变成死引用的东西：`main.js` 里只被那两个 license handler 用过的 `getDeviceFingerprint` require，以及 `src/backend/README.md` 里对 `wechat:dispose` 的描述行。`capabilities` 层面没有功能损失：最大化仍可用 Windows 的双击拖拽区，指纹与激活请求仍走 `license:export-request`（它内部会算指纹）。 | 已完成 |
| M23 | CSP 过宽 | `connect-src 'self' https:` 与 `img-src ... https: file:` 允许向任意 https 主机外发 | **H10 已完成 connect-src 部分**：改为显式列出渲染进程真实消费者（jsdelivr / unpkg / geo.datav.aliyun.com）+ `'self' data: blob: file:`，并补 `object-src 'none'`/`base-uri 'self'`。**`img-src https:` 仍是通配**：收敛它需要枚举真实图片主机，而库里有大量 http/https 远程图片 URL（见 `utils/url.ts` 注释）→ 意味着「渲染层可向任意 https 主机发起图片请求」这条外发通道仍在，属已知遗留（见 H10 的遗留清单）。验收：connect-src 已收紧且地图/图片/语音/视频取数不受影响（评审实测省市区地图曾因漏 aliyun 被打断，已修） | 已完成（img-src 部分转遗留） |
| N29 | 单聊「推荐回复」面板有三处在说谎（复制反馈 / 首帧空态 / 下拉空白） | 2026-09-20 新增的第三栏面板：① `copy()` 写的是 `void navigator.clipboard.writeText(text)` 紧跟 `setCopied(index)` —— 被拒时（窗口失焦是常态）界面照样显示「已复制」，而那条 reject 没人接（渲染进程里一条未处理拒绝）；② `loading` 初值 `false` 而挂载即发请求，于是**首帧**渲染的是「这个会话还没有可用的对话内容」（SSR 实测确认这句话真的会出现）；③ 知识库下拉把 `String(kbId)` 交给 Radix，而选项挂在 Portal 里、收起时不挂载 —— 选中值没有对应已挂载 item 时**连 placeholder 都不显示**，实测那一帧是 `<span style="pointer-events:none"></span>` 一块空白。 | **已完成（2026-09-20）**：复制改走共享助手 `utils/misc.ts` 的 `copyTextToClipboard`（它把异步 API 与 `execCommand` 兜底两条路径的失败都收敛成布尔值），只有 `ok === true` 才显示「已复制」，失败则明确说「复制失败…请手动选中后复制」，并按 `seqRef` 门控 —— 期间换过会话/库就不把标记打到新的行上；`loading` 初值改 `true`；错误呈现改用姊妹面板 `SessionAsk` 那套 `.error` + `role="alert"`；下拉在「拿不到库名」的三种状态（列表在读、读失败、当前库不在列表里）分别给 placeholder 文案并交空值，不再留一块没有说明的空白。**验收**：`ui:smoke` 新增一条 SSR 用例（首帧须是「正在生成」、那句假空态不许出现、触发器须说「读取知识库…」而不是通用的「请选择…」）—— **该面板此前在 SSR 冒烟里零覆盖**；`reply-suggest.wiring.spec.ts` 加 2 项源码守卫（复制必须走共享助手且不许 fire-and-forget、失败必须有出口）。**变异**：`loading` 初值改回 false → 红；`Select` 的 value 改回 `String(kbId)` → 红；`copy` 退回 fire-and-forget → 红；均按 sha256 还原。**未验证**：真实浏览器里 Radix 把选中项挂载一次之后库名是否显示（SSR 测不到那一帧，用例注释里已写明这条边界）；剪贴板被系统拒出的端到端观感需真窗口。 | 已完成 |
| N30 | 首启无数据源时，面板把原始英文 SQLite 报错甩给用户 | e2e 复跑时实测：空 userData 下点开「通讯录」，`role="alert"` 里是 `unable to open database file`。这是**每个查询面板都会撞到**的首启状态，用户既看不懂也不知道下一步做什么（对照：`Ask` 面板有专门的中文空态文案）。 | **已完成（2026-09-21）**：在 `wechat-host.js` 的 `call` 错误路径集中翻译已知形态（`unable to open database file` / `SQLITE_CANTOPEN`）为「读不到本机的微信数据：请先在「数据配置」中设置数据目录并完成解密（原始错误：…）」，**其余错误原样透传** —— 不猜形态，避免把真实故障说成「未配置」（比英文原文更有害）。新增 `host-error-message.spec.ts` 6 项（翻译命中 / 等价形态 / 其余原样反例 / 非 Error 输入 / 接线守卫 / e2e 钉文案）；`ui:loading-e2e` 增加断言「数据源缺失时必须是中文可执行文案」。**变异**：翻译判定改成 `if (false)` → 2 条转红，按 sha256 还原。**未验证**：其他底层英文报错（权限拒绝、库损坏等）未翻译 —— 按「只翻译已知形态」口径，遇到再加。 | 已完成 |

### 工作流 E · 构建与工程化（6 项）

| ID | 任务 | 证据位置 | 验收标准 | 状态 |
|---|---|---|---|---|
| M17 | shim 同步机制脆弱 | `sync-ui-shim.js` 把源码写进 `node_modules`（npm 对 `file:` 装的是真实拷贝）；直接 `vite build` 会静默用旧副本；`cssSelectors`/`tsExports` 是正则启发式，漏 `@media`/`export default`  **已完成（用比条目主张更小的代价达到同一条验收标准）**：条目主张改 `npm link`/symlink 或 workspace —— 那会动 npm 的安装与打包布局（electron-builder 的 `files`/`asarUnpack` 都建立在这套布局上）。实际做法是把**解析路径直接指到源码**： · `vite.config.js`：`resolve.alias` 把 `@deepseek-ai/dsh-client-ui-primitives`（及其 `/src/*` 子路径）映射到 `src/client/ui-primitives-shim/src` —— 构建产物必然来自源码； · `src/client/ui-wechat/tsconfig.json`：加同款 `paths`（与 H12 给后端类型那条并列）。那条的注释说的正是同一个陷阱：「`file:` 拷贝只在 `npm install` 时刷新，很容易落后于源码（已经因此把 48 条类型错误带进过前端）」—— M17 是它在构建侧的翻版。  **验收实验（决定性，可复现）**：给 shim 源码的 `Button.module.css` 追加一个标记类 → **不跑** `scripts/sync-ui-shim.js`、直接 `node node_modules/vite/bin/vite.js build` → 标记出现在产物 CSS（`index-B5BMokyK.css`）里；**全程 node_modules 里那份拷贝没有该标记**（证明它确实是旧的、而构建没用它）；复原源码后重建，标记从产物消失。⇒ 条目的两条验收（「修改 shim 后无需手工同步即生效」「构建不会静默用旧副本」）都成立。  `sync-ui-shim.js` 与 `check:shim` **保留但不再是构建前提**：它现在只保证磁盘上那份拷贝的一致（给任何直接解析 node_modules 的消费者用），其正则启发式的不完备（漏 `export default`、at-rule 头不参与比较等）因此**不再能影响构建结果**。  **验收**：typecheck 0（说明 tsc 也走了源码，不再可能读到陈旧类型）；`build:ui` + `check:shim` + `check:wx-tokens` + `ui:smoke` 21 项通过；全量 182 文件 / 376 用例（367 通过 / 9 跳过 / 0 失败）。  **未做/未验证**：没有真的删掉 `node_modules` 里那份拷贝（`npm ci` 仍会按 lockfile 造它），所以「双份源码」在磁盘上仍然存在 —— 只是**构建与类型检查都不再读它**。要彻底消灭它需要 workspace/symlink，属打包布局级改动，本会话没有余量做完整回归（pack + package:smoke 的布局断言依赖现有的 node_modules 结构）。 | 已完成 |
| M18 | 跨平台声明与实际不符 | `package.json:132-142` 只声明 `win/nsis`（x64）；原生依赖只内联 `@koromix/koffi-win32-x64`（`:69`） | 二选一：补齐各平台 koffi 二进制并跑通构建；或移除 mac/linux target 并在文档声明仅支持 Windows。验收：声明与可构建目标一致 | **已完成（选「移除声明」，但立项时写下的理由被复审推翻并已改写）**：  **改动**（`a447d86`）：删 `build.mac`(dmg) 与 `build.linux`(AppImage)；`description` 追加「（仅支持 Windows x64）」；`src/backend/README.md` 新增「支持平台 / 为什么是 Windows-only」。选移除而非补齐：产品读的是 Windows 微信（`Weixin.exe` 内存扫描取密钥、`HKCU\Software\Tencent\Weixin` 注册表、`xwechat_files` 数据根、`%APPDATA%/Tencent/xwechat/config/*.ini`），补齐其它平台等于为一份读不到数据的包长期维护两套构建。  **复审（独立 subagent，bash 可用；无 critical + 1 major + 2 minor）**：验收成立，但抓出我写错的因果 —— 我把两个平台都写成「那两种包里会缺原生二进制」。实测（本机 Windows 10.0.19045 / electron-builder 26.15.3）：`--mac` **直接失败**（`⨯ Build for macOS is supported only on macOS`，exit 1）—— 根本打不出，不存在「打出来但缺件」这个中间态；`--linux --dir` 反而**成功出包**（exit 0），但包里唯一的 koffi 原生模块是 `@koromix/koffi-win32-x64/win32_x64/koffi.node`（一个 Windows 二进制），缺 `@koromix/koffi-linux-x64` ⇒ 出得来、跑不了。README 已按这张对照表重写；`a447d86` 提交信息里同样的话不改写（amend 需用户明示），如实记在这里。  **守卫**（`a376f2e`）：新增 `src/backend/tests/platform-declaration.spec.ts` 8 条，守两件事 —— ① 声明别漂回去（build 无 mac/linux 键与 dmg/AppImage 等 target、显式声明的架构只能是 x64、npm scripts 无 `--mac`/`--linux` 入口、**所有** workflow 的 `runs-on` 都是 windows、manifest 与后端 README 都写明支持平台）；② 声明与打包白名单别脱节（每个 `@koromix/koffi-*` 的 `file:` 依赖必须同时被 `files` 与 `asarUnpack` 覆盖）。第二条来自复审的 E10 实验：删掉 `files` 里的 `node_modules/@koromix/**/*` 时第一版守卫全绿 —— 而那样打出的包没有原生模块。  **变异矩阵**（12 条，可逆 A/B，`%TEMP%\h9doc\m18-ab-matrix.mjs`）全部符合预期：抓得住 8 类漂移，对 3 类合法形态不误报（`target` 写成裸字符串 `nsis`、`description` 改大小写、README 支持平台段前插 2500 字）。**矩阵当场抓出我自己三处错**：target 收集函数不下钻对象数组（收集出空数组、断言全部空转）、用「配置 JSON 化找子串」误报 `mas`（`onlyloadappfromasar` 里含它）、把 `arch: ['x64']` 当成 target 收进集合。  **验收**：`npm run pack` ✓；`npm run dist` ✓（NSIS 安装器 212MB，本次重建 —— 复审指出改完没跑 dist 时交付物还是 9/14 的旧件）；`package:smoke` 22 项全绿（后端方法数 132 与 `gateway.ts` 源码一致、无 ENOTDIR、无模块解析失败、出图）；typecheck 0；`check:shim` 一致；全量 62 个测试文件 / 184 suite / 384 用例（375 通过 / 9 跳过 / 0 失败）。  **未验证/未做**：没有 mac/linux 真机（`--linux --dir` 的产物只查了包里有没有原生模块，没尝试启动）；`main.js:1211` 与 `tools/license-studio/main.js:277` 的 darwin 模板残留**保留不改**（win32 进程里不可达、不改变对外声明，已写进守卫注释）；**守卫守不住文档解释性文字的真伪** —— 这次 README 的错因只有人工复审能发现。 | 已完成 |
| M19 | 打包冗余与窗口图标缺失 | `files` 的 `src/**/*` 把三类内容打进 asar（实测 2877 条目 / 45.93MB）；`build/` 不在 `files` 白名单（`main.js:447` 的窗口图标路径在打包态不解析） | `files` 排除 `!src/backend/deps/**` 与 `!src/**/*.ts`；把 `build/icon.ico` 纳入白名单。验收：asar 体积下降，打包版窗口图标正常 | **已完成（体积那一半达标；图标那一半的立项假设经实测不成立）**：  **先量再改**：条目只给了两条排除，我用 asar 头部模拟了规则，发现第三条比前两条都大，一并做 —— `src/backend/deps/**` 8.07MB/984 条（与 node_modules 里 npm 装的那份重复）、`src/**/*.ts` 4.49MB/537 条、`src/client/ui-app/**` 12.29MB/164 条（其中 `public/` 的 onboarding 11.25MB 与 wxemoji 0.92MB 与 `ui-dist/` 里那份文件数与总字节完全一致）。三条并集 22.16MB/1333 条。**实测**：`app.asar` 45.93MB → **23.4MB**（24,580,422 B），条目 2877 → **1419**；安装器 212,062,944 → 197,654,897 B（−14.4MB；压缩后落差小于 asar 属正常）。  **排除安全性是先验证再改的**：后端 bundle 对裸模块是 external 的，运行时用 `await import("koffi")` 这类**裸模块名**经 node_modules 解析，实测 bundle 里对 `backend/deps` 的路径引用数 **0**；我在打包产物上**真加载**过 koffi（`require('.../app.asar.unpacked/node_modules/koffi').load('kernel32.dll')` 成功）；独立复审更强 —— 在 electron 内从 asar `require('.../app.asar/src/backend/wechat-host.js')` → `createWechatBackend` 成功、**132 方法**（与 `gateway.ts` 一致），koffi / dsh-typert-protocol / zod / fzstd 全部从 asar 内 node_modules 解析成功。  **图标：条目的因果不成立，故没照做**。打包目录里确实没有 `build/`（路径不解析，`icon` 为 undefined），但 `dist/win-unpacked/Super Time.exe` 的**内嵌图标就是同一份 artwork** —— 复审用 `PrivateExtractIcons` 取出 exe 全部 7 帧，与 `build/icon.ico` 对应帧**逐像素完全相同**（mean|d|=max|d|=0）⇒ 退回用 exe 图标，dev 与打包态一致，**不存在「打包版窗口无图标」**。加进 `files` 只会白带 83KB 并把图标改成读 asar 内的 .ico（打包态未验证的路径），可见收益为零；`main.js` 补了注释说明这一点（**我自己的第一次取证得的是反结论**：用 `new System.Drawing.Icon(path,32,32)` 解这个 ICO 会得到一张**噪声图**，差点据此认定「exe 图标与 ico 不同」——该 ICO 的帧是 PNG 压缩的，必须按 ICO 结构取帧）。  **守卫**：`scripts/packaged-smoke.js` 补 10 条断言（三条排除各断 0 条目、五条运行时必需物仍在、两条 koffi）。其中两条按复审意见修正过：① koffi 那条**第一版是空转的** —— 我断言 `entries` 里有 `/node_modules/koffi/**`，但该路径与 `@koromix/**` 都在 asarUnpack 里 ⇒ 全是**解包条目**，而解包条目照样被 `listPackage` 列出（实测两个条目都在列表里、header 为 `unpacked:true / offset:undefined`）⇒ 恒真；改为断言 `app.asar.unpacked` 下**磁盘上真有** `koffi/index.js` 与原生 `.node`（`await import` 与 .node 加载都只能走真实文件）。② 整个 asar 校验块原先把异常吞成一句「跳过 asar 列表校验」⇒ `@electron/asar` 一不可用，十几条打包内容断言静默消失而冒烟仍报 ✅（**假绿通道**）；改为记一条失败断言，A/B 实测（临时移走 `node_modules/@electron/asar`）冒烟 exit 1 并报出该条。  **复审建议否决项**：残余死重约 1.5MB（`ui-wechat` 1.40 / shim 0.12 / `*.tsbuildinfo` 0.13 / `*.d.ts.map` 0.04）**不**改「`src/` 走白名单」—— 那会误排当前确实在包内的 `src/backend/VENDORED-LICENSES.md` 与各 README，只省 1.5MB 而风险不对称。  **验收**：`npm run pack` ✓、`npm run dist` ✓、`package:smoke` 31 项全绿（含后端 132 方法、无 ENOTDIR、无模块解析失败、出图）、typecheck 0、全量 184 suite / 384 用例（375 通过 / 9 跳过 / 0 失败）。**未验证**：打包态**真实数据**的语音解码端到端没跑（本轮发现它本来就是坏的，见 N19）；冒烟只覆盖「启动 + 截图」，whisper 播种、区域码表、导出 zip 这几条路径静默改坏也照样全绿。**顺带发现**：N19（`wx_silk.exe` 未解包 → 打包版语音解码/批量转写坏，复审独立证实：同一 exe 磁盘路径 spawn 成功、asar 路径 ENOENT）、N20（未调 `setAppUserModelId`）、N21（`dist` 无前置构建）。 | 已完成 |
| M21 | 大文件可维护性 | `Chats.tsx` 175KB、`api.ts` 82KB、`Moments.tsx` 90KB、`Settings.tsx` 79KB、`chats.module.css` 94KB、`gateway.ts` 2800 行、`parse.ts` 74KB | 按建议边界拆分（`api.ts` → cache/media-cache/remote/按域；`Chats.tsx` → ChatList/MessageStream/MessageCard/GroupInfoDrawer/useSessionMessages；`Settings.tsx` 每节独立组件）。验收：单文件不超过约定行数上限，且行为无回归 **进行中（2026-09-15，只做了 api.ts 那一片）**：把 `api.ts` 的缓存层拆成 `cache.ts`（197 行）与 `media-cache.ts`（114 行），`api.ts` 保留转发 ⇒ **41 处 `from \'./api.ts\'` 一行都不用改**；`api.ts` 2072 → **1807 行（−265）**。**验收**：新增 `api-module-split.spec.ts` 4 项（17 个定义标记的纯搬移一致性、公开面继续转发、新模块不得反向 import 成环、api.ts 必须确实变短）+ 同步更新读 api.ts 的 `api-snapshot-listeners.spec.ts`；typecheck:client 0、`build:ui` 822 modules、`ui:smoke` 21 项。**施工细节**：`export … from` **不会**把名字带进模块作用域，而 `invalidateWechatCache` 等在 api.ts 内部也被调用 —— 第一版只写 `export … from` 直接报 30 处 `Cannot find name`，现为 import（内部用）+ export from（外部用）两态。**未做**：其余边界（`Chats.tsx` 175KB、`Moments.tsx` 90KB、`chats.module.css` 94KB、`gateway.ts` 2800 行、`parse.ts` 74KB）与「单文件不超过约定行数上限」的整体验收远未达标。 | 进行中 |
| M22 | 文档与代码不一致 | 方法数三方打架：`gateway.ts` 实际 129 ← RAG 文档 126 ← `backend/README.md` 114；`backend/README.md:52,92` 引用不存在的 `npm run smoke:wechat`/`config:wechat`；`wechat/whisper/README.md` 声称的 exe 已被删 | 修正全部引用；方法数改为自动生成（并入 H14）。验收：文档中的命令均可执行，方法数与代码一致 **已完成（2026-09-15）**：① 方法数不再三方打架——`src/client/README.md` 整节按 `nav-config.ts` 实测重写（16 个侧栏入口 / 35 个可路由页签 / **132** 个 Remote 方法，补齐社交图谱与知识图谱两个独立入口与隐藏项归属表，并修掉「虚拟列表」这条 M14 之后已失效的描述）；`src/backend/README.md` 改为指向 `docs/API.md`；`docs/rag/RAG-ARCHITECTURE.md` 标注「当前 132、以 `docs/API.md` 为准」。② 不存在的命令修正：`npm run smoke:wechat` → `rag:smoke`；`config:wechat` 标注为不存在。③ 顺带修掉 `src/backend/README.md` 里写错的相对链接（`../wechat/README.md` → `../../wechat/README.md`）。④ **新增守卫**：`api-docs.spec.ts` 多一条「文档里的方法数不再过期」——扫三份文档，出现 `114/126/129` 的声明即红，且必须写明 132 或指向 `docs/API.md`（这条守卫在修复过程中先红后绿，证明有判别力）。**注意（前提被推翻）**：`wechat/whisper/README.md` 的「某个 exe 已被删除」**未复现**（`bin/whisper-cli.exe` + 12 个 dll 都在）；真正过期的是「默认模型目录＝本目录」，实际是 `<数据根>/whisper`（`whisper.ts:451`）——已按实测修正。 | 已完成 |
| M24 | keys ↔ query 双向依赖 | `keys/service.ts:19`、`keys/db-key-v4.ts:18` → `query/config.ts`；而 `query/image-key.ts:8` → `keys/key-store.ts`，层次倒置 | 抽出共享的配置读取到独立层（如 `config/`），消除双向依赖。验收：依赖方向单向，单测可独立加载 **已完成（2026-09-15）**：共享配置读取下沉到新的 `src/config/` 层（`index/atomic-json/wechat-config/detect/resolve.ts`：原子写+损坏留痕、config.json/secrets.json 真源、账号发现、路径解析），DB 密钥校验移到 `keys/db-key-verify.ts`；`query/config.ts` 变成纯转发门面（-788 行）。依赖方向变为单向 **`config ← keys ← query`**。**验收**：搬移**逐字不变**可由「剥注释后 496/496 原始代码行都在新文件集合里」独立证明（只有两条聚合 import 行因拆分而不同）；M1 的密钥迁移与原子写用例 33 项全绿；新增 `tests/layer-direction.spec.ts` 6 项守卫（把 import 改回 `query/config.ts` 立刻红 3 项）。**顺带修掉**三处仍指向 `query/config.ts` 的注释（`wechat-paths.js:120`、`wechat-host.js:485`/`:551`）。**未做**：`query/image-key.ts` 未动（query→keys 已是单向）；`types.ts` 的 query→types→query 纯类型环为既有结构，守卫如实放行。 | 已完成 |

### 工作流 F · 知识图谱交付与计划实施中暴露的问题（19 项）

| ID | 任务 | 证据位置 | 验收标准 | 状态 |
|---|---|---|---|---|
| N1 | 既有 write store 与知识笔记是同一类隐患：假设数据根目录已存在，且失败被静默吞掉 | `wechat-tasks.ts:19-23` 的 `openStore` 无 `mkdirSync`，与笔记库同类；`listTasks:56-58` 的 `catch` 把打不开库直接退化成空列表 —— 「待办为空」与「库读不到」在界面上无法区分 | 各 store 的 `openStore` 显式建父目录；读失败与「确无数据」必须可区分（至少日志留痕）。验收：在全新 userData（无 `decrypted/`）下写入待办成功 **已完成（2026-09-15，前端仅部分面板消费）**：① 三个 store（`wechat-tasks.ts`/`notes.ts`/`summary-tasks.ts`）的 `openStore` 显式建父目录（失败只留痕，不改变既有失败语义）；② 读失败改 `readError` + 日志留痕 —— 「库读不到」与「确无数据」在后端**已可区分**；③ **前端半边**：`api.ts` 透传 `readError`（5 个只读端点），`Tasks.tsx` 分开显示且**失败不写渲染缓存**。**验收**：7 项用例 + 5 组可逆变异。**顺带修正病因错位**：`notes.ts` 原有 mkdir 是**裸的**，父路径被文件占住时 catch 收到 `EEXIST` 而非「库打不开」。**未做**：`DailySummary`/`Graph` 等面板尚未区分显示 `readError`。 | 已完成 |
| N2 | 引导页「跳过」按钮要求 `licenseOk`，没有免许可证的跳过开关 → UI 自动化验证必须自签证书 | `ui-app/onboarding/OnboardingShell.tsx:952` `disabled={!licenseOk}`；本次为截图验证不得不签发临时许可证（一次性脚手架 `output/kb-verify-setup.js`，`output/` 已被 gitignore，非仓库资产；建议连同本项一并提升为 `scripts/` 下的常驻验证工具） | 加 `SUPERTIME_SKIP_ONBOARDING=1` 之类的显式调试开关（仅非打包态生效）。验收：设置该环境变量后可直接进入主界面，`ui-acceptance.mjs` 无需真实许可证 **已完成（2026-09-15，仅非打包态生效）**：新增 `src/backend/debug-gates.js` 的 `resolveDebugGates({ isPackaged, env })` —— `skipGates = 显式要 1 && isPackaged === false`，`isPackaged` 缺失/非布尔**一律不放行**；`main.js` 现取 `app.isPackaged` 并把 `{packaged, skipGates}` 当**事实**回给渲染层（`app:debug-gates`），`wechat:call` 的许可证豁免走同一判定；渲染层 `ui-app/debug-gates.ts` 再要求 `packaged === false`。**验收**：10 项纯函数用例 + AST 守卫（实参只能是 `app.isPackaged`）+ 4 组可逆变异；`scripts/ui-acceptance.mjs` 改用该开关并**删掉了伪造隐私同意的 localStorage 注入**。**未验证**：打包版实机（本批禁 `pack`）与 UI 真机（未装 playwright）——已在验收脚本步骤 1 加 `#debug-gates-banner` 断言充当下次真跑的闸。 | 已完成 |
| N6 | **换 userData 不能隔离数据源：应用会把真实微信库解密进新目录**（与 H1、H14 联动） | 实测：`SUPERTIME_USER_DATA_DIR=<空临时目录>` 启动后，该目录出现**完整的真实解密库** —— `message_1.db` 146MB、`sns.db` 13MB、`contact.db` 2143 个联系人，共约 282MB。成因链：`wechat-paths.js:108` 的「开发态一次性迁移」把仓库里**已提交**的 `wechat/config.json` 搬进新 STATE_DIR，该文件带 `db_dir`（真实原始库路径）+`db_enc_key`（H1）；`main.js:470-476` 随后把这份设置回灌后端（`saveWechatConfig`），于是 sync 用密钥把 `db_dir` 解密到新的 `decrypted_dir`。后果：① 任何「干净环境」测试其实都在真实数据上跑，测试隔离是假的；② 用户若更换/清空状态目录，应用会不经确认就把他 GB 级微信数据解密到新位置；③ 叠加 H1 后，任何拿到仓库 + 原始库路径的人都能完成解密 | 迁移不得携带 `db_dir`/密钥类字段（或迁移后强制清空路径与密钥，等待用户重新确认）；`decrypted_dir` 被指向空目录时不得自动全量解密，须显式确认。验收：全新 STATE_DIR 启动后不产生任何真实解密数据；日志能说明「数据源未配置」而非静默解密 **已完成（2026-09-15）**：`wechat-paths.js` 的 `migrateLegacyState` 不再原样复制 `config.json`，改为 `sanitizeMigratedConfig()` —— 顶层路径字段（`dataRoot`/`decryptedDir`/`decodedImagesDir`/`sourceDir`/`baseDir`/`selfWxid`/`silkBinary`/`resolved`）一律回落默认空值，镜像里剔除 `db_dir` + 密钥（`SECRET_SETTING_KEYS`）+ 派生路径（`DERIVED_SETTING_KEYS`），普通设置（`api_port`/whisper 参数等）照旧迁移；剔除内容打进日志并明确要求**重新确认数据源**（不再静默）。`llm.json` 仍照旧迁移（用户自己的模型配置）。迁移改成原子写 + 按 `<stateDir, legacyDir>` 记录已迁移（同一进程里换状态目录仍各迁一次）。**验收**：`src/backend/tests/legacy-migration.spec.ts` **8 项** —— 逐字节断言目标文件里不含 `db_enc_key`/`image_aes_key`/`api_token`/`db_dir`/旧路径片段，顶层路径字段回落空值、普通设置保留、日志含被剔除字段与「重新确认数据源」、老配置损坏不抛不留半个文件、已有配置不被覆盖、无老配置时不创建文件。**变异 A/B**：让迁移原样复制 → 逐字节与顶层断言转红。**未做**：`decrypted_dir` 指向空目录时要求「显式确认」这半条 —— 数据源不再被携带后该路径已不可自动触发（需要用户在「数据配置」里显式指定 `db_dir` 才会解密），故按现状收口。**旁证**：`host-settings.spec.ts` 原先为躲这条泄漏而在每个用例里预写占位 `config.json`（注释明写「本机那份含真实密钥会被复制进来」），现在不再需要那种规避 | 已完成 |
| N7 | 后端 11 个失败用例的 triage 与修复 | 11 项已全部清零，**其中 3 项是真缺陷**（2 个根因），不是测试过时——这一点与初次 triage 的结论相反：<br/>① `contacts.ts` 好友判据判反（把 1568 个非好友当联系人、417 个真好友当群成员）→ 已改源码；`contacts.spec` / `overview.spec` 夹具未动即转绿，证明它们一直在正确地报 bug。<br/>② `sns-video.ts` 朋友圈视频的 `msg/video/<月>/<md5>_thumb.jpg` 兜底成了死代码（只查根目录、不认月份子目录）→ 已改源码。<br/>其余 8 项确为夹具漂移：`ask.spec` 的 mock 不完整（3）、`messages.spec`/`ledger.spec` 的 appmsg 写成属性而非子元素（3）、`resource-classify.spec` 旧契约（1）、`sns-media.spec` 旧 cache-key 公式（1） | **教训**：初次 triage 用「回退源码后仍失败」判定漂移，但其中一次 A/B 是**空转实验**（被回退的 `parse.ts` 与 `resource-classify.ts` 毫无 import 关系），不能作为证据；而 `contacts.ts` 那项被建议「改夹具 1→3」，若照做会把 bug 固化。可疑结论必须回到领域语义（真实数据）复核 | 已完成 |
| N8 | 向量索引构建读整张 `message_meta` 物化（H9 同族反模式） | `query/retrieval/embedding.ts:241-244`：`SELECT … FROM message_meta ORDER BY m.rowid` 后 `.all()`，与 H9 修掉的搜索路径是同一反模式。实测（20 万行索引、单条 478 字符）：**1876ms、RSS 峰值 +271.7MB**。**同族位置（H9 的「剩余 `.all()` 都是小表」只对 `search.ts` 成立）**：`group-insights.ts:119`（整张 `Msg_*`）、`asset-insights.ts:97`、`privacy.ts:152`、`moments-insights.ts:108`、`overview-insights.ts:248`、`overview.ts:159`（`SnsTimeLine`）、`embedding.ts:236,306`（`vectors`）、`notes.ts:274`、`summary-tasks.ts:91`、`wechat-tasks.ts:52` | 改 `iterate()` 边读边判（`pending` 只取前 `maxDocsPerBuild` 条，天然适合游标）；同族位置按「行数是否随消息量增长」逐个评估，确属会话/联系人量级的在代码里注明。验收：同数据集下命中集合不变，且 RSS 峰值降到与「单批 embedding 数」同阶 **已完成（2026-09-15；第 2 条验收**未达标**，如实记在末尾）**：① **核心**（`embedding.ts` 构建路径）改游标边读边判，读到 `maxDocsPerBuild` 就 `break`；同时**每行不再携带自己那份长文本** —— 文本只作为分组键存一份，行上只留 `(rid, username, localId, createTime)` 四个标量（478 字符 × 4 万行本来还要多算几十 MB）；`done` 集合读 `vectors` 也改游标（那里只需建 Set，不需要数组副本）。② **同族逐个评估并处置**（条目清单 10 处）—— 随消息量增长、改游标的 7 处：`group-insights`（整张 `Msg_*` 累加）、`asset-insights`（`local_type=47` 扫描）、`privacy`（类型 1 扫描，**改前 `.all()` 先物化全表再在循环里按 `rowBudget` break —— 预算只限制处理量、不限制读取量**，换游标后预算才真正成为读取上界）、`moments-insights`（时间线 tid → Set、定位解析）、`overview-insights`（`SnsTimeLine` 内容统计）、`overview`（朋友圈作者统计）；有界或有意的 5 处**在代码里注明理由**：`privacy` 的 `SessionTable`/`contact`（会话/联系人量级）、`overview-insights` 的 `SessionTable`/`contact`、`moments-insights` 的提醒清单 `SnsTopItem_1`（本机 490 条）、`notes`/`summary-tasks`/`wechat-tasks`（用户笔记与待办量级）、`embedding` 的 `loadHashRows`（**要的产物就是那个数组**：粗筛要随机访问全表，已按文件指纹缓存、实测加载约 250ms，真压下去要改 mmap/分块，属结构性改动）。 **验收**：`vector-build-read.spec.ts` **5 项**（与「整表读→过滤→截断」的 **oracle 差分对照**、cap 语义含 0/NaN/负数一律按 0 的**有意分叉**（改前负数走 `slice(0,-n)` 的笔误语义，同 M9 对 `pool` 的处理）、增量不重算、以及**源码守卫：整个 `runBuildVectorIndex` 函数体内不得出现 `db.prepare(...).all()`**）+ `iterate-equivalence.spec.ts` **3 项**（补 `queryPrivacyScan` 与 `queryOverviewInsights` —— 这两处**原先没有任何 spec 直接调用**，游标写错在那边零信号；断言精确计数与 `rowBudget` 步进语义）。 **量化（同机同一脚本，20 万行 × 478 字符、上限 4 万）**：改前（换回 HEAD 实现）RSS 峰值 **+340MB**（基线 73 → 413MB）、改后 **+103MB**（74 → 177MB），两次结果**完全一致**（`rows=40000 / embedded=40000 / embed_calls=2500`）—— 这就是「命中集合不变」的规模化证据。残余随窗口缩放而非语料：同样 20 万行、上限改 4000 时仅 **+4MB**（约 2.6KB/行）。**可逆 A/B**：两处游标读不到任何行 → 对应用例转红并逐字节还原。 **第 2 条验收未达标（如实标注）**：「降到与单批 embedding 数同阶」没做到 —— 残余是 `pending` 窗口本身（分组键 + 元组 + 向量），由 `maxDocsPerBuild` 决定而不是语料规模；要再压到「批大小」量级需要**流式扇出**（边算边写、不攒 pending），而那与 N10 的「一次事务写完 + 重建原子回滚」直接冲突，属结构性取舍，不在本轮范围。 | 已完成 |
| N9 | 搜索不可中断（H9 验收标准 4 未达标） | `query/search.ts` 的兜底搜索是同步整循环（`budget=800_000`），实测 20 万行 × 500B 无命中时单次 **621ms**、期间 10ms 定时器 0 次触发，外推约 2.5s。用户切换面板无法打断，且该循环在每次索引重建窗口内会被反复触发 | 需要 AbortSignal 从渲染层贯通到查询层（`searchIndexMessages` 目前是同步 `@Remote`，改 async 会改动客户端契约与 `/api.ts`）。验收：取消后 100ms 内停止扫描，且不再持有 shard 读连接 | 未开始 |
| N10 | 向量索引构建持写事务跨网络调用且无并发保护（H9 同族，风险更高） | `query/retrieval/embedding.ts:257-280`：写事务跨 `await`（跨网络的 embedding 调用）保持开启，且既无单飞闸也无 busy_timeout。实测同进程并发两次：**1555ms 内一个成功 `ok/4000`、另一个 `database is locked`**。它被 Remote 按钮（`gateway.ts:1296`）与问答自动路径（`gateway.ts:946`）触发 | 不要把事务开着等网络：改为「先算好向量再一次性事务写入」，并给构建加单飞闸（参照 H9）。验收：并发两次调用均成功，且写事务的持有时长远小于网络往返 **已完成（2026-09-15）**：① **两阶段** —— 阶段一只算不写（`vectors: Map<截断文本, {blob, lo, hi}>`，按唯一文本计内存），阶段二 `BEGIN`→（重建时）`DELETE`→扇出 INSERT→COUNT/meta→`COMMIT`，**段内 0 个 await**；写事务持有时间 = 插入耗时，与网络往返无关。② **`DELETE` 挪进事务** —— 改前它在 `BEGIN` 之前各自 autocommit，中途失败会把已有索引留成空表（H9 第三轮在搜索路径上修过同一个问题）。③ **单飞闸** —— 按 `vectorDbPath(decryptedDir)` 键控（被争用的是那个 DB 文件；`dirname` 会归一化结尾分隔符），非 force 的并发调用**复用同一轮构建**，force 撞上在飞的非 force 构建则排队重做（否则「点重建」会拿到对方「已是最新」的答复）。④ **顺带**：原「每 512 行让出一次」随阶段二合并而取消（在事务里让出只会把写锁持得更久）；`up-to-date` 路径的两行 meta 写也包进事务。 **验收**：`vector-build-gate.spec.ts` **7 项** —— 建库在飞（第二批请求挂起）时另一条连接的写事务必须立刻提交（<500ms）；两次并发调用都成功且只发一轮请求；不同写法合并到同一槽；force 排队重做；**force 重建中途失败旧向量一条不少**；失败后单飞闸被释放；源码级守卫（每个 `BEGIN→COMMIT` 段内无 `await`，且 `DELETE` 落在事务区间内）。 **对照实验（关键）**：把 **HEAD 的改前实现**换回来跑同一套用例 —— 五条判据全红，第一条**逐字复现**条目里的症状 `Error: database is locked`，其余分别报「没有合并并发」「DELETE 不在事务里」「只扫到 1 处 BEGIN」。**量化**（同一 `MEASURE_M10` harness）：阶段二是同步段，落库 4 万行（含扇出）时**事件循环最长阻塞 32.3ms**、0.8 万行 11.1ms；建库墙钟仍由网络支配（40k 行 1088 次请求 4.21s）。**未做**：N8（同一函数里 `message_meta` 仍用 `.all()` 全量物化）不在本次范围。 | 已完成 |
| N11 | `dirs.ts` bootstrap「只拷主库、跳过 `-wal/-shm`」与 WAL 叠加会拷出旧一代索引 | `dirs.ts:44`（`BOOTSTRAP_ITEMS` 含 `wechat_search.db`）+ `:47`（`SKIP_SUFFIXES` 含 `-wal/-shm`）+ `:106,111`（copyTree 跳过运行时产物）。实测：3000 行索引建成后让另一连接持旧读标记，再 force 重建 6000 行 —— 主库仍是 3000 行、新数据全在 `-wal`（48.9MB）；此时只拷 `wechat_search.db` 读回 **rows=3000/旧 built_at**（静默回退一代），全量拷才对 | 二选一：拷贝 SQLite 库前后对源库做 `PRAGMA wal_checkpoint(TRUNCATE)`（让主库自包含）；或 `copyTree` 对 `.db` 连 `-wal`/`-shm` 一起拷（注意 `-shm` 不可跨机复用，SQLite 建议用 backup API）。H9 已尽力在构建 COMMIT 后 checkpoint，但**有并发读者时拿不到锁**，覆盖不到「源端应用正在跑」的情形（第四轮实测：读者游标未读完时 `wal_checkpoint(TRUNCATE)` 返回 `{busy:1, checkpointed:0}` 且不抛错，窗口未消除）。验收：数据根里存在活的 `-wal` 时，bootstrap 结果与源库一致 **已完成（2026-09-15）**：`dirs.ts` 新增 `isSqliteDatabase()`（只读 16B 文件头判真库）与 `copyFileWithWal()`：拷主库后**连 `-wal` 一起拷**（主库在前、`-wal` 在后，回放只会向前推进；`-shm` 永不拷——它不可跨机复用），`bootstrapWechatData()` 返回 `walCarried[]` 留痕。**验收**：`tests/dirs-wal-bootstrap.spec.ts` 5 项；变异还原「只拷主库」→ 3/5 红并**逐字复现**条目症状（读回 `{rows:3000, builtAt:2026-01-01}` vs 期望 `{6000, 2026-02-02}`）。**未覆盖**：源端**正在写**时的撕裂场景（完备解是 SQLite backup API / `VACUUM INTO`，现覆盖的是「源端静止」的常见情形）。另：夹具教训——只 `iterate().next()` 而不持游标引用会被 GC 终结、读标记释放，造出「主库已是最新」的**假绿**（实测撞到一次，已改为持引用 + 前提断言）。 | 已完成 |
| N13 | LLM 之外的 4 个出网点没有重试：公众号封面 / 图片 / 朋友圈视频 / whisper 下载 | `query/article-cover.ts:27,34`、`query/media-image.ts:529`、`query/sns-video.ts:271`、`query/whisper.ts:431,554` —— 全是单次尝试（whisper 有镜像轮换循环，但没有重试与断点续传）。M7 的重试只覆盖 LLM/embedding（验收范围如此）；这些点的一次网络抖动就是「图/视频/模型下载失败」，用户只能重试整个动作 | 把 `llm-retry.js` 的 `fetchWithRetry` 复用到这几个出点（它们都已有超时信号，接口兼容），whisper 下载另加断点续传。验收：断网重连后同一动作自动恢复；并给 `llm-retry.spec.ts` 的接线守卫加上「覆盖哪些文件」的显式清单 **已完成（2026-09-15）**：`llm-retry.js` 新增「单次尝试超时」`opts.timeoutMs` / `timeoutScope:'headers'` 并**逐次**武装信号（调用方自己塞 `AbortSignal.timeout` 会让第一次超时后就不再重试）；4 个出网点（`article-cover.ts` 两处、`media-image.ts`、`sns-video.ts`、`whisper.ts` 两处）改走 `fetchWithRetry`，N24 的开关判定仍在**发请求之前**。**whisper 断点续传**：`streamUrlToFile` 用 `Range` + 仅 206 追加、416 丢弃、起点/长度校验；模型 `.part` 失败不再删（引擎 zip 不续传——`releases/latest` 会换包）。接线守卫扩成**显式文件清单**（wechat-host + 4 个 query 文件）。**验收**：`outbound-retry.spec.ts` 13 项（503 重发到成功、401/404 只发 1 次、429 假时钟证明 999ms 未重发/1000ms 才重发、第二次尝试的信号未被中止）+ 既有 12 个 spec 87 项；变异 6 条全部转红。**顺带修掉一个真缺陷**：旧 whisper 模型下载会把**截断的流 rename 成正式模型**（短读不报错），已加长度校验。**行为变更**：`article-cover-cache.spec.ts` 的「失败只抓 1 次」随之改为 3 次（重试的必然结果，用例已同步并注明）。 | 已完成 |
| N12 | `members.ts` 是搜索索引库的第二个写者，不在单飞闸内 | `members.ts:92` 以**读写**方式打开 `wechat_search.db` 并写 `contact_fts`（`:55-79` 的 `BEGIN/INSERT/COMMIT`）。实测 40k 行 force 构建在飞时，**155/155 次** `searchMembers` 因写被拒而静默退化为 `source:'like'`（`members.ts:122` 吞掉错误），构建结束后立刻恢复 `source:'fts'`。读取可用性无损，但 H9 注释里「进程内争用一律交给单飞闸消除」的说法对它不成立 | 把搜索索引库的写入统一到一个闸（从 `search.ts` 导出 `withIndexWrite()`），或让 `members.ts` 在构建期间直接走 LIKE 并显式标注（而不是吞错）。验收：构建在飞时成员搜索不再出现「尝试写→被拒→静默降级」的路径 **已完成（2026-09-15）**：`search.ts` 新导出 `withIndexWrite()`（同步、不排队的索引库写闸：构建在飞即 `{ok:false}`）；`members.ts` 拆出 `contactFtsReady()`（只读判断，已建好就不建表、不需写锁）与 `buildContactFts()`（DDL+插入，失败 warn 不吞错），**只在真要写时进闸**，拿不到闸则明说「构建在飞、未尝试写」并显式走 LIKE。**验收**：`tests/members-index-gate.spec.ts` 4 项；变异还原「闸外无条件 DDL」→ 3/4 红（含「闸在飞时仍然写了索引库」与源码守卫）。**口径收窄（实测）**：`CREATE … IF NOT EXISTS` 在表已存在时是**纯读**（只有真正新建表才报 `database is locked`），所以退化窗口是「`contact_fts` 未建成 + 构建在飞」，不是「任何构建在飞」——条目原文的定级偏重。 | 已完成 |
| N14 | `vectorIndexStatus` 每次查询重开连接并做 `COUNT(*)`（M9 复审发现） | `retrieval/embedding.ts:88-102`（`new DatabaseSync` + `SELECT COUNT(*) AS c FROM vectors` + 2 次 meta 读），一次提问至少命中两次（`embedding.ts` 的 `searchDense` 内 + `pipeline.ts:140`，另有 `gateway.ts:956`）。 实测（合成 13.5 万行、vec 每行 3KB）：`COUNT(*)` **1.25ms**、走 `idx_vectors_doc` 覆盖索引 1.07ms；同一条 SQL 族里 `SELECT fts_rowid, hash_lo, hash_hi, username`（粗筛表加载）**250ms**，但它已按文件指纹缓存（`HASH_CACHE`），只在进程内首次/索引重建后付一次。 ⏳ 未开始 —— 与 M9 同一条路径但性质不同（per-query 的 O(N) SQL 与连接开销，不是排序）。修法：按 `statSig` 缓存 `vectorIndexStatus`（状态只在索引重建时变），或把 `rows` 写进 meta 表与 `built_at` 一起读，省掉 `COUNT(*)` 与一次连接。验收：一次提问的 `vectorIndexStatus` 调用从「2 次连接 + 2 次 COUNT」降到 ≤1 次连接且无 COUNT，并记录前后耗时。 **已完成（2026-09-15）**：`vectorIndexStatus` 改为按指纹缓存（`STATUS_CACHE` / `invalidateVectorStatusCache` / `readVectorIndexStatus`），并把行数作为 `meta.rows` 与 `built_at` **同事务**写入；冷路径 1 次连接 + 1 次 meta 查询，**热路径 0 连接 0 SQL**；重建后显式失效。**验收**：`tests/vector-status.spec.ts` 10 项（与「改前实现」oracle 差分逐字段等价，覆盖 9 种库形态：新库/老库无 `rows` 键/空值/非数值/meta 缺失/vectors 表缺失/版本不符/空库/文件不存在）+ `vi.mock` 直接数连接与 COUNT：**一次提问 3 次查询 6.32ms → 0.04ms（151×）**，连接 3→≤1、COUNT 3→0（对照单次 `COUNT(*)` 0.94ms）；变异 6 条全部转红。**有意分叉**：meta 说 0 行而表里确有行时信 meta（生产不可达，已写成显式用例）。**遗留**：`release` 里的显式失效造不出确定性用例（Windows 文件指纹 ~15.6ms 粒度），属兜底；老库仍需付一次 COUNT（下一次构建补键）。 | 已完成 |
| N15 | 每日摘要任务是 N 次串行 LLM 调用（M10 复审发现，同形态但影响小得多） | `gateway.ts:1818-1823`：`for (const t of tasks) await this.runSummaryTask(...)` —— 与 M10 之前的 `buildVectorIndex` 同形态（N 次串行远程调用），但受「同一分钟到期」约束，通常只有 1–2 项。`eval.ts:evaluate` 是全同步、非热点；ask 链路每问只 1 次 embed。 ⏳ 未开始 —— 复用的修复模式已经有了：M10 的「有界并发 + 失败不半写」可以照搬（`embedding.concurrency` 那套夹取也适用）。验收：同一分钟到期的多个摘要任务并发执行且互不串数据，并记录前后耗时。 **已完成（2026-09-15）**：`gateway.ts` 的到期摘要任务改为 `DUE_SUMMARY_CONCURRENCY=2` 的 worker 池有界并发、逐任务 catch + 末尾抛首个错误（保留 `summary_scheduler_error` 日志），失败不连坐。**验收**：`tests/summary-run-due.spec.ts` 6 项；桩 LLM 120ms 往返下 **2 项 273ms → 139ms（1.96×）、5 项 708ms → 423ms（1.67×，理论下限 360ms）**，在飞峰值 1→2 且封顶 2；变异 4 条全部转红。**顺带修掉一个既有真缺陷（→ N25）**：调度器的 `now - Number(t.lastRunAt) > 60_000` 对 NULL 是 `NaN > 60000 = false`，**从未手动「立即运行」过的任务永远等不到第一次调度**。**实测旁证**：单语句 autocommit 写 500 次交叉 0 次 SQLITE_BUSY（事务跨 await 才撞锁 20/20），故并发摘要不引入写冲突。 | 已完成 |
| N16 | 图片路径的真正杠杆：`lower(md5)=?` 全表扫描（M11 复审发现，附实测线性度） | `media-image.ts:642` 的 `SELECT ... FROM image_hardlink_info_v4 WHERE lower(md5) = ? ORDER BY modify_time DESC LIMIT 8` —— `EXPLAIN QUERY PLAN` = `SCAN ... USING INDEX image_hardlink_info_v4_MODIFY_TIME`（走的是 modify_time 索引再过滤，等价全扫）。**实测线性度**：本机真实表 3309 行 **0.30ms/次**；合成 20 万行 **17.27ms/次**（30 张图 ≈518ms）；60× 行数 → 57× 耗时。这就是 M11 验收里「图片列表加载耗时」的真杠杆。 ⏳ 未开始 —— 两条路：① **批量查询**（`WHERE lower(md5) IN (...)`，30 次扫描并成 1 次）需要一个批量 RPC，属接口变更；② 用表上已有的索引列 `md5_hash`（`SEARCH ... USING INDEX image_hardlink_info_v4_MD5_HASH`）**但推不出映射** —— 我试了前/后 4 字节 BE/LE、Java `String.hashCode` 共 6 种推导，对真实样本 **0/8 命中**，推不出就不能用（会静默漏结果）；要做得先把 WeChat 这个哈希的算法考证出来。附带处理：`meta.ts` 的全局 `entries` Map 无上限，应按需引入 `boundedSet` 式限界（`msg-by-sid:` 的 key 空间由用户点击驱动）。 **部分完成（2026-09-15）**：① **批量查询机制已落地**——`media-image.ts` 新增 `resolveImageFilePathsByMd5()`（一条 `WHERE lower(md5) IN (...)`、分块 400），单张路径改走它；**实测 20 万行合成表：30 张图逐张 454ms → 一次 `IN` 20.4ms（15.14 → 0.68ms/张）**。② **按需限界已落地**——`meta.ts` 的 `entries` 按族限界（`msg-by-sid:` 200 条 FIFO；不做全局 cap，免得挤掉 `contact-meta:`/`shard-meta:`）。③ **但批量入口未接到网关**：`getImageDataUrl` 是一图一次 RPC，接线需要**新增批量 RPC**（属接口变更，implementer 的写集不含 `gateway.ts`）。所以「图片列表加载耗时」这条用户可见收益**尚未兑现**。**未做**：`md5_hash` 映射的算法考证（推不出就不能用，会静默漏结果）。 **已完成（2026-09-15，含未达标项）**：① 机制：`resolveImageFilePathsByMd5()`（一条 `lower(md5) IN (...)`、分块 400）+ `meta.ts` 的 `entries` 按族限界；② **接线**：新增 Remote `getImageDataUrlsBatch`/`warmDecodedImages`，并让 `api.ts` 的 `apiGetImageDataUrl` 做**微任务窗口合并**（合并语义抽到新 `image-batch.ts`）——一图一次调用的面板**零改动**就吃到批量入口。**验收**：用 `prepare` 计数证明 **30 张图只查 1 次库**（逐张对照 30 次；关掉预热即转红）+ 前端 3 次取图 → 1 次 RPC。**未达标**：只合并**路径表查询**，单张 md5 解析仍每张一次；`MediaAssets.tsx` 未改；**无浏览器验证**。 | 已完成 |
| N17 | 反馈按钮用 state 当闸门（与 M13 同类，且 host 侧没有兜底）（M13 复审发现） | `Ask.tsx:262-287` 的 `submit`：`if (busy) return` 用 `useState` 的 `busy` 当闸门 —— 与 M13 修掉的是同一个「异步状态当同步闸门」的窗口；窗口内双击会发两条 `apiSubmitAskFeedback`、`patch()`/`setMarking(false)`/`setNote` 各写两次、权重适配跑两遍。而 host 侧 `gateway.ts` 的 `@Remote('submitAskFeedback')` **没有单飞、也没有去重**（复审 grep 实测）⇒ 与 M13 不同，重复副作用会真的落到后端。 ⏳ 未开始 —— 修法可直接复用 `panels/ask-gate.ts` 的 `createAskGate()`（M13 已落地并有 6 项单测）。验收：窗口内连续点击只发一次请求、只写一遍状态；并给该接线补一条源码级守卫（沿用 `use-ask.wiring.spec.ts` 的写法，注意 `[^}]` 那个坑）。**同族但后果较轻**（复审一并列出，可一起看）：`Chats.tsx:1922-1963` 导出、`Moments.tsx:713-730` 同步、`Settings.tsx:957/982` 解密 —— 这几个 host 侧已有单飞，双击的后果是**重复劳动**或「第二次收到 host 的『已有任务进行中』而被前端当失败弹假报错」，不会重复副作用。 **前端部分已完成（2026-09-15）**：`Ask.tsx` 的 `busy`（useState，异步状态当闸门）换成 `gateRef` + `panels/ask-gate.ts` 的 `createAskGate()`（惰性建闸、认领 ticket），`busy` 只留作禁用与文案；接线守卫 `panels/ask-feedback.wiring.spec.ts`（A/B：换回 HEAD 版转红）。**未做**：host 侧 `submitAskFeedback` **仍无单飞与去重**（`gateway.ts` 不在该实现的写集内）→ 已登记为 **N27**；即客户端窗口关了，重复副作用仍可能落到后端。**无浏览器环境**，双击只发一条请求未能真机确认。 **已完成（2026-09-15，前端 + host 两侧）**：前端闸门（`ask-gate`）＋**host 侧去重**（N27，同批完成）。 | 已完成 |
| N18 | 长列表 DOM 无硬上界（需要动态测高的真虚拟化）（M14 的延伸） | `hooks.tsx` 的 `usePagedList` 让 `count` 随滚动增长（首屏 30/120 条），所以「滚到底」时 DOM 节点数没有上界 —— 原 M14 验收里「DOM 节点数有上界」这一条**未达成**（M14 只做了「移除与现方案重复的死代码 + 无用依赖」）。 ⏳ 未开始 —— 需要的是**变高虚拟化**：动态测高（`ResizeObserver` 或按内容估算后回填）、滚动锚定（加载更多时不能跳位）、以及和「回到底部/跳到某条」的既有交互对齐。可直接用已装的 `@tanstack/react-virtual`（`measureElement` + `useVirtualizer` 的动态模式），但**必须先有能在浏览器里验证滚动行为的验收手段**（仓库当前只有 SSR 静态冒烟 `ui:smoke`，观测不到滚动）。验收：1 万条消息下 DOM 节点数有硬上界，且滚动到位、加载更多不跳位。 | 未开始 |
| N19 | **打包版语音 silk 解码坏掉**：`wx_silk.exe` 不在 `asarUnpack`，而它是要被 spawn 的可执行文件（M19 取证时发现，复审独立证实） | `src/backend/wechat-data/resources/win32/x64/wx_silk.exe`（248,320 B）**不在** `asarUnpack`（`package.json:121-129`），而 `src/backend/wechat-data/src/query/voice.ts:94-110` 的 `silkDecoderBin()` 用 `existsSync` 从 `import.meta.url` 上溯找它 —— 打包态该路径落在 asar **内部**，Electron 的 `fs` 补丁让 `existsSync` 判为**真**（不像隔壁 `whisper.ts` 的 `bundledWhisperAssetsDir` 走了 `unpackedAware()`），随后 `voice.ts:132` 的 `spawnSync(bin, ...)` **无法执行 asar 内的 exe**。复审实测同一 exe：磁盘路径 `spawnSync status=1`（真执行）、asar 路径 `error.code=ENOENT`。影响面：`voice.ts:172` 的语音取 WAV、`voice-transcribe.ts:154` 的批量转写 —— 即打包版**语音播放与转写均不可用**（开发态正常，因为路径是真的）。 **已完成**（分两轮：`7e44cf3` 修缺陷；`3a387f2` 收第一轮复审的四项反馈）——① **修法两条都做了**：`asarUnpack` 加 `src/backend/wechat-data/resources/**`；把 `whisper.ts` 里那份`unpackedAware()` **抽成共享模块** `src/backend/wechat-data/src/asar-path.ts`（是抽出来复用，不是抄第二份），并新增 `onDiskPath(candidate, exists?)` —— 只交出真实存在于磁盘的路径，asarUnpack 漏了时返回空串，让上层报「打包资源缺失」，而不是把跑不了的归档内路径交给 spawn 再得到一个与病因无关的 ENOENT。抽的过程中顺手修了原实现的一个缺陷：它只找 `app.asar` 前缀，对已经是 `app.asar.unpacked` 的路径会二次改写成 `app.asar.unpacked/.unpacked/...`（原调用点碰不到，共享后必须正确）。② **第一轮复审指出我的接线守卫不可信**：我原来断言「源码里含 `onDiskPath(candidate)`」，而把那个字符串留在**注释**里、底下仍用裸 `existsSync` 就能让它继续绿（复审实测）。已换成**行为级**：`silkDecoderBin(startDir?)` 新增可注入起点，用例按真实布局建临时目录（`<tmp>/app.asar/src/backend/wechat-data/{lib,resources/win32/x64/wx_silk.exe}` + unpacked sibling）直接断言返回值 —— 覆盖=返回 unpacked 那份 / asarUnpack 漏了=空串 / 开发态=原路径 / 无解码器=空串 / env 钉住优先。③ 复审另三项一并修掉：失败原因改取 `res.error.message`（原写法在 exe 起不来时只报「解码器退出码 null」，与「音频损坏」无法区分）；`silkToWav` 的临时 silk 加 `finally` 清理（原先从不删除，本机 `decoded/voices` 下实测积了十余个残留）；`spawnSync` 加 120s 上界。  **验收**：`package:smoke` **34 项 ✅ / 0 ❌**（按输出里 ✅ 行数计），含「`app.asar.unpacked` 下有 wx_silk.exe（asar 内的 exe 无法 spawn）」；两个 spec 共 **14 项**全绿（`asar-path.spec` 8 → 12、新增 `voice-silk.spec` 2）；**变异 A/B 三条各自「先转红再还原」**（回退 `onDiskPath` / 回退 `res.error` / 回退 `finally` 清理）；全量 **64 文件 / 190 suite / 398 用例（389 通过 / 9 跳过 / 0 失败）**；typecheck 0；重建 bundle 与 `lib/types` 后 `git diff --exit-code` 0（两条一致性门禁会过）。  **未验证（如实标注）**：① 打包态用**真实微信语音**端到端解码未验（需真实库 + whisper 模型）——已证的是三层：「解包后的 exe 可执行」「`onDiskPath` 语义正确」「返回值真的改写到 unpacked」；② 120s 超时上界无用例覆盖（要一个会挂起的假解码器）；③ `silkToWav` 临时文件同进程并发同名（`<pid>_<len%100000>`）的理论冲突未验，已列入收口复审的问题单。 | 已完成 |
| N20 | 任务栏图标可能出双份：`main.js` 未设 AppUserModelID，而 NSIS 快捷方式写的是 appId（M19 复审发现） | NSIS 会给快捷方式写 `com.supertime.electron`（`appId`），但 `main.js` 全文没有 `app.setAppUserModelId(...)` —— Windows 用「窗口的 AppUserModelID + 快捷方式的」做任务栏分组与固定，两者不一致时固定后再启动可能出现**双图标**（或固定项显示成另一个图标）。与 M19 的窗口图标无关（那一条已证不缺）。 ✅ 已完成 —— 在 `app.whenReady()` 之前调 `app.setAppUserModelId('com.supertime.electron')`（与 `appId` 同一个常量来源最好）。验收：安装后「固定到任务栏」再启动，任务栏不出现第二个图标。 **已完成（2026-09-15）**：新增 `src/backend/app-id.js`（`appIdFromManifest()` 只认非空字符串，异常输入退回兜底值 —— 返回 `undefined` 会让 `setAppUserModelId` 直接抛错；`APP_ID` 由 `require('../../package.json')` 的 `build.appId` 派生，**与 NSIS 快捷方式同源**，避免两处各写一份需要手工同步的常量）；`main.js` 在建窗与单实例锁之前调用 `app.setAppUserModelId(appId)` 并留一行日志。**验收**：`src/backend/tests/app-identity.spec.ts` **5 项**（appId 形态、`appIdFromManifest` 的畸形输入、`APP_ID === manifest.appId`、**AST 判定真实调用点**且实参就是本模块的值、调用发生在 `app.whenReady()` 之前）；`packaged-smoke` 新增**两条**断言并已实测：打包产物启动日志里的 `[app-id] AppUserModelID=` 必须存在且等于 `package.json` 的 `build.appId`（实测 `com.supertime.electron`，诊断日志里同样可见）。**守卫第一版是空转的**：写成源码字符串正则时，把调用点注释掉（`// app.setAppUserModelId(appId);`）仍 4 项全绿 —— 改用 TypeScript AST 只认真实 `CallExpression` 后，注释掉 / 换成别的字面量两种变异都转红（这正是 M12/N19 反复栽的同一个坑）。**未验证**：任务栏固定/分组的真实行为需要真机装包人工操作，仓库自动化里没有这一环 | 已完成 |
| N21 | 干净检出直接 `npm run dist` 会打出**没有前端**的包（M19 复审发现；排掉 `ui-app` 后已无第二份兜底） | `src/client/ui-dist/**` 在 `.gitignore` 里（构建产物），而 `dist` 脚本是 `electron-builder --win nsis`、`pack` 是 `electron-builder --dir` —— **都没有前置 `build:ui`**（对比 `prestart`/`dev` 都有）。于是干净检出直接打包时，asar 里 `src/client/ui-dist/index.html` 不存在，`main.js:422` 的 `uiEntryHtml()` 会退回到演示页 `src/index.html`。**M19 之前**这一条还「温和」（`src/client/ui-app/**` 也在包里）；M19 把 `ui-app` 排掉后，包里已**没有第二份前端**。 **已完成**（`23b54f1`）—— **实测坐实，而且失败是静默的**：移走 `src/client/ui-dist` 后用**改前**的脚本 `npm run pack`，冒烟转红 `❌ asar 仍含运行时必需 src/client/ui-dist/index.html`（1 条断言红、其余 32 条 ✅ —— M19 新增的那条断言正是先行兜底），说明干净检出确实会打出「只有演示页」的包（`main.js:422` 的 `uiEntryHtml()` 在构建产物缺失时回退到 `src/index.html`）。改法就是条目写的那条：`pack`/`dist` 前置 `npm run build:ui`（与 `prestart`/`dev` 同形的 `&&` 串接）；**刻意没用 `prepack`** —— 那是 npm 的发布生命周期钩子，混用会让 `npm pack`/`publish` 意外触发构建。  **验收**：保持 ui-dist 缺失 → `npm run pack` 的前置步骤自动重建它 → 冒烟 **34 项 ✅ / 0 ❌**；`npm run dist` 一并重建安装器（188.5MB，时间戳为本次）；asar 22.91MB。**未验证**：真·干净检出（`git clean -xdf` 后 `npm ci`）未跑，证到的是等价前提「ui-dist 缺失」。 | 已完成 |
| N22 | `files` 的 `src/**/*` 是通配：`src/` 下的**任何**多余目录/备份都会被打进包，而 M19 补的是「已知冗余不得存在」的**黑名单**，抓不到这类（N21 实施时我自己撞上） | 做 N21 的 A/B 时我把 `src/client/ui-dist` 临时改名为同级的 `src/client/ui-dist.bak`，再 `npm run pack` —— 它被照常打进 asar（约 +12MB），而 M19 那三条排除断言（`!src/backend/deps/**`、`!src/client/ui-app/**`、`src/**/*.ts`）全部照绿：黑名单只验证「已知的冗余不在」，验证不了「不该在的不在」。同类触发面：编辑器/同步工具留下的`src/**/*.orig`/`*.bak`、临时导出目录、被 gitignore 的构建中间产物。 ⏳ 未开始 —— 修法建议把打包内容从黑名单改成**白名单 + 体积预算**双保险：① `packaged-smoke` 加一条 asar 总体积上界断言（实测基线22.91MB，M19 报 23.4MB，建议上界取 1.3× ≈ 30MB，避免前端产物正常波动导致假红）；② 再加一条「`src/**` 下只允许出现哪些子树」的清单断言。验收：往 `src/` 放一个 1MB 的 `.bak` 后冒烟转红（当前会静默通过）。 **已完成（2026-09-15）**：新增 `scripts/package-content-rules.js`（`src/**` 白名单 + asar 体积预算 [10MiB, 30MiB]，纯函数便于单测），`scripts/packaged-smoke.js` 接线两条断言并新增 `--content-only`（默认流程不变）。**验收**：对已存在的 `app.asar`（24,033,395 B / 1420 条）跑同一规则 → 22.92MB/30MB、`src/` 322 条目全绿；放入 1MB `src/client/ui-dist.bak/probe.bin` → **2 条 ❌ exit 1**（而 M19 的三条黑名单照旧全绿——正是条目说的盲区），删除后复绿、工作树无残留。**证据强度限定**：走的是 `--content-only`（同一断言代码路径，未启动 Electron），非新打包产物。**注意**：白名单会拦「新增 `src/<新子树>` 或 `src/` 顶层新文件」，报错指向 `scripts/package-content-rules.js`（本轮 WS6 新增的 `src/backend/wechat-data/src/config/` 因 `.ts` 本就不入包而未受影响）。 | 已完成 |
| N23 | **CI 的「后端崩溃自愈」那一步在干净检出上必然失败**（H14 实施时发现） | `scripts/backend-restart-smoke.js:45` 直接 `fs.readFileSync('<repo>/vendor-keys/license-private.pem')` 给本机指纹签临时许可证（业务调用要过许可闸门），而 `vendor-keys/` 已在 `.gitignore` 里 —— 干净检出 / CI runner 上该文件**不存在**，`seedLicense()` 会抛异常（调用点在 `:148`，无 try/catch 兜底），脚本以非 0 退出。CI 里 `check:backend-restart` 是一步（`ci.yml`），因此**这一步在 CI 上是不成立的**：本机之所以全绿，只因为本机工作树里有那份私钥。 | 二选一：① 该步骤内部**临时生成一对密钥**并同步改写 `src/license/public-key.js`（`license-smoke.js` 已有这套在内存里做的做法，落到文件即可，用完还原）；② 明确把它降级为「需要签发私钥的本机步骤」并从 CI 摘掉、在文档里注明。验收：干净检出（`git clean -xdf` + `npm ci`，无 `vendor-keys/`）跑 `npm run check:backend-restart` 能通过，或它已不在 CI 步骤里。 **已完成（2026-09-15，走第三条路：让脚本不再需要许可证）**：先读断言再动手 —— 本脚本的六项全是**进程生命周期**（后端就绪 / 恰好一个 worker / 被杀后自动重启 / 重建出新进程 / 新 PID / 无重复拉起），**没有一项调用业务方法**，而许可证只影响业务调用的放行；`seedLicense()` 是多余依赖。于是直接删掉它（连同 `crypto`/私钥读取），并在文件头写明「为什么这里不该签许可证」。这比条目给的两条路都干净：不必临时改写 `src/license/public-key.js`（那正是 **L4** 登记的「中断即污染仓库」的做法），也不必失去这条端到端证据。**验收**：① **复现缺陷** —— 把 `vendor-keys/` 临时改名后跑**改前**版本：`ENOENT: vendor-keys\license-private.pem`、**exit 1**；② 同样条件下跑**改后**版本：**6/6 通过、exit 0**（真实 Electron + taskkill 的完整链路）；③ 恢复目录后复跑仍 6/6。**新增守卫** `src/backend/tests/ci-script-isolation.spec.ts` **6 项**：把 CI 的每个 `run:`（含 `run: \|` 多行块）解析出来 → 顺着 `npm run` 链展开 → 取出被执行的脚本文件，断言其**字符串字面量**（AST 抽取，注释不算）里不出现本机专有资产（`vendor-keys`、仓库里的 `wechat/llm.json`/`wechat/config.json`），并断言 CI 里的每个 `npm run` 都真实存在（防改名后静默空跑）；因 `npm test` 也是 CI 步骤，扫描范围还包含全部 `*.spec.ts`（排除守卫自身）；另有防空转断言（扫到的步骤/脚本/spec 数量下限）与「这些资产确实被 gitignore」的反面确认。**可逆 A/B**：把 `fs.readFileSync(path.join(root,'vendor-keys',…))` 加回脚本 → 用例转红并指名文件与字面量。**未覆盖（已写在用例头）**：`path.join(a,b,c)` 拼接出来的路径（段被拆成多个字面量）、间接依赖、运行期下载物。 | 已完成 |
| N24 | **界面上可见、可存，但全仓没有任何消费者的配置开关（死开关）** | 实测（全仓 grep，排除 node_modules/dist）：`cdn_enabled`、`cdn_local_decrypt`、`api_enabled`、`api_port`、`api_token` 只出现在 —— 默认值与示例配置（`query/config.ts:80`、`wechat/config.example.json`）、类型声明（`types.ts`）、`gateway.ts:1941-1944` 的读取与 `:2392,2404` 的写回、以及 `Settings.tsx` 的表单状态与 patch。**没有任何查询/取图路径读它们**：`media-image.ts` / `sns-video.ts` / `article-cover.ts` 取远端资源时都不看 `cdn_enabled`，后端也没有本地 HTTP 服务读 `api_port`/`api_token`。后果是「数据配置」页上那两个 CDN 开关给用户一种「关掉就不出网」的错觉（H14 的隐私声明里已如实写明它们不生效）。 | 三选一：① 让取图/取视频路径真正读 `cdn_enabled`（关掉即只用本地缓存）并给 `api_*` 补上或删掉；② 把死控件从界面撤下；③ 若确定不再需要，删除字段与类型。验收：每个界面可见的开关都有代码消费者，或被移除；并有守卫用例防止再次出现「只存不读」的配置项。 **已完成（2026-09-15，按用户确认的方向：让 CDN 开关真生效 + api_* 撤下界面）**：① **新增 `query/cdn-policy.ts`** 作为两个开关口径的**唯一出处**（`cdnFetchAllowed` / `localDecryptEnabled`，`undefined` ≠ 关闭，与 `config.ts` 的默认 `true` 一致），并给出两条可读文案（`CDN_DISABLED_MESSAGE` / `LOCAL_DECRYPT_DISABLED_MESSAGE`）。② **四处远端取回全部接线**：`media-image.ts` 的 `fetchEmoticonRemote`、`article-cover.ts` 的 `resolveArticleCoverDataUrl`、`sns-video.ts` 的 `fetchSnsMediaBytes`（覆盖视频与封面）、`loadSnsVideoBytes`（导出路径）—— 关闭时**在发请求之前**返回；`fetchAndDecodeVideo` / `fetchSnsCoverDataUrl` 的解密分支改由 `localDecrypt` 决定，且「开关关掉」与「真的解不开」给出**两种不同的提示**（否则用户看到「解密失败」找不到病因）。③ **网关读取并传参**：新增 `gateway.ts` 的 `cdnSwitches()`（读配置失败时**不拦**，沿用默认开启，避免读盘异常变成静默断功能），5 个调用点全部传入。④ **缓存语义**：关掉开关只影响「主动取回」，已有缓存（内存 / 落盘）照常返回 —— 用例显式覆盖。⑤ **api_\* 撤下界面**：`Settings.tsx` 移除 `api_enabled` / `api_port` / `api_token` 的状态、保存 patch 与三行控件（原先界面自称「HTTP API 遗留能力」且写着「本面板已通过 Remote 直读，无外部 HTTP 依赖」，即它自己承认没有服务端）；字段与类型**本期不动**（删字段要连带重建 bundle/types 并考虑旧配置兼容，超出条目范围）。 **验收**：`cdn-switch.spec.ts` **12 项**（打桩 `fetch` 计数：四类入口关闭时**调用次数为 0**、默认不传 opts 行为不变、缓存优先不受影响、「服务端解密」与「本地解密」给出不同提示、明文 MP4 两种设置都能取到）+ `settings-switch-wiring.spec.ts` **5 项**（AST 取**调用点实参**断言 5 处都传了 `cdnSwitches()`、`cdnSwitches` 方法体内真的读了两个键、界面仍保留两个 CDN 开关与保存 patch、界面不再出现 `api_enabled`/`api_port`、后端字段未被误删）。**可逆 A/B**：① 网关某调用点去掉 `...this.cdnSwitches()` → 红并指名调用点；② 界面加回 `api_enabled` → 红。两处均按字节还原。**打包态实测**：`npm run pack` 后用新 bundle 跑 `npm run package:smoke` **35 项 ✅ / 0 ❌**（后端就绪、132 方法、渲染出图、诊断日志落盘）；`build:backend` 幂等（重跑哈希不变），`build:types` 同步更新 4 个 `.d.ts`。**守卫第一版误报**：前端读配置是属性访问（`cachedCfg?.cdn_enabled`）、写回是属性赋值名，只看字符串字面量会把「界面里有这个开关」判成没有 —— 已改为「字符串字面量 + 属性名」并排除解构绑定名。**未验证**：真实微信数据下关掉开关后的端到端观感（需真实库 + 未缓存的表情/视频）；渲染层按消息地址直连加载的图片与头像**不受**该开关控制，已在隐私声明里写明。 | 已完成 |
| N25 | 每日摘要任务「从未手动运行过」时永不触发（N15 实施中发现的既有真缺陷） | `gateway.ts` 的调度判据 `now - Number(t.lastRunAt) > 60_000`：`t.lastRunAt` 为 NULL 时 `Number(null) = 0`… 实测真正发生的是 **`NaN` 比较**（字段缺失/非数值时 `NaN > 60000 === false`），于是**从未手动「立即运行」过的任务永远等不到第一次调度**，用户只能手动点一次才开始跑。 | **已完成（2026-09-15，随 N15 一并修掉）**：按「缺值按 0」处理（视为从未运行 ⇒ 立即到期）并加用例；变异回退该处理 → 转红。**遗留**：该调度器的其它时间语义（时区、跨天）未审计。 | 已完成 |
| N26 | 测试夹具在 Windows 上删临时目录偶发 `EPERM`（N10/N8 实施中反复出现） | `node:sqlite` 的 `DatabaseSync.close()` 是 **close_v2 语义**：**未 finalize 的语句**句柄会滞留到 GC，于是 `rmSync(tempDir)` 偶发 `EPERM`（`%TEMP%` 里成堆的 `wx-n10-*` 残留即此）。目前各 spec 靠「重试 rmSync」容忍，属治标。 | 二选一：① 每个数据库用完显式 finalize 语句再 close（或统一封一个 `withDb()` 助手）；② 在夹具清理处统一加带退避的重试并注明原因。验收：连续跑 10 次 `npm test`，`%TEMP%` 里不再新增 `wx-*` 残留目录。 **进行中（2026-09-15；条目病因经实测更正）**：实测 `node:sqlite` 的 `DatabaseSync.close()` 在本仓 Node 24 上**会** finalize 语句（已 close 的连接上 `stmt.all()` 报 `statement has been finalized`），所以 `rmSync` 的 `EPERM` **不是**「未 finalize 的语句滞留到 GC」，而是「**有连接没关**」，且**退避重试无效**（3 次重试仍 EPERM）。稳定来源：spec 辅助函数在 `try` 里开只读连接、异常路径走 `catch` 返回而跳过 `close()`。**处置**：新增 `src/backend/tests/helpers/temp-db.ts`（连接登记册 + 统一 cleanup），迁 `vector-status.spec.ts`、`vector-build-gate.spec.ts`。**实测**：迁移前每跑一次稳定 +1 个 `wx-n14-*`；迁移后 5 个 spec 连跑两次 44 项全绿、**新增 0**；变异（不关连接）一次 20 个残留。**剩余**：`wechat-data/tests` 下仍有 **37 个** spec 未迁移（迁移参考：`dirs-wal-bootstrap.spec.ts` 同一范式）。另注：`scripts/package-content-rules.js` 的 stray 规则按段名匹配 ⇒ **`src/` 下不得新建 `tmp-*` 命名**（本项因此命名为 `temp-db.ts`）。 | 进行中 |
| N27 | host 侧 `submitAskFeedback` 无单飞/去重（N17 只修了前端闸门） | `gateway.ts` 的 `@Remote('submitAskFeedback')` 既无单飞也无去重：客户端闸门（N17 已修）挡住的是「同一个面板的快速连点」，而**两个面板同时提交**、或旧版客户端/直接 RPC 调用时，重复副作用（权重适配跑两遍、审计写两遍）仍会落到后端。 | 参照 H9/N10 的单飞闸做法给该 RPC 加单飞（或按 `(questionId, turnId)` 去重）。验收：并发两次调用只产生一次副作用（用例可用打桩计数证明），且第二次调用得到可读的「已在处理」响应而非静默重复。 **已完成（2026-09-15）**：`submitAskFeedback` 加**内容键 + 时间窗**（10s 同轮）去重：同轮第二次提交返回可读的「已在处理」，换评分/标注或超窗各正常放行。**验收**：同轮两次提交后反馈库**只有 1 条**，去掉闸即转红。**实现要点（与 H9/N10 的闸不同）**：`@Remote` 是**同步**方法，函数体不会被交错打断，「在飞合并」式单飞闸在这里是**假闸**；重复副作用只能靠「内容键 + 时间窗」去重。 | 已完成 |

---

## 十、阶段 6 · 低优先级（清理与打磨）

不影响功能与上线，适合作为机动任务穿插进行。

| ID | 任务 | 位置 | 状态 |
|---|---|---|---|
| L1 | `.gitignore` 补全 `.tmp-*`、`*.orig`、`*.tsbuildinfo`、根 `.*.log` | `.gitignore` **已完成（2026-09-15）**：核对后四项其实早已在 `.gitignore` 里（`.tmp-*`/`*.orig`/`*.tsbuildinfo`/`.*.log` 等价覆盖），本次只补了说明性注释——条目要求的「补全」是空的，如实记录。 | 已完成 |
| L2 | 删除遗留死文件（无任何引用） | `.tmp-be.js`(770KB)、`.tmp-be-lib-index.pre-rag.bak.js`(777KB)、`.tmp-be-build.mjs`、`lib/index.js.orig`(874KB) **已完成（2026-09-15）**：删除 `.tmp-be.js`(770KB)、`.tmp-be-lib-index.pre-rag.bak.js`(777KB)、`lib/index.js.orig`(874KB)（零引用，已记 sha256）与 `.tmp-be-build.mjs`。**前提部分不成立**：`.tmp-be-build.mjs` 的唯一引用是 `docs/compose/spec/chat-panel-visual-audit.md:556`（不是代码），该文档已改为指向 `scripts/build-wechat-bundle.js`（重建命令现在是 `npm run build:backend`），随后才删除。 | 已完成 |
| L3 | 把孤儿脚本挂进 npm scripts | `scripts/license-gate-smoke.js`（依赖 H4） | 已完成 |
| L4 | 测试脚本改为不写仓库（当前临时改写 `public-key.js`，中断即污染） | `license-smoke.js:52-54` **已完成（2026-09-15）**：`license-smoke.js` 全量重写——`withTestPublicKey()` 把测试公钥注入 require 缓存，**不再写仓库里的 `src/license/public-key.js`**。**验收**：A/B 把 `public-key.js` 设成只读 → 新脚本 exit 0，而等价的旧写法 EPERM。 | 已完成 |
| L5 | 声明被脚本依赖但缺失的依赖 | `esbuild`（`rag:check`/`ui:smoke`/`build:backend`）：**已声明**（因阻塞 H4 而前置）。`playwright`（`ui:accept`）尚未：它是 300MB 级依赖且会拖慢每次 `npm ci`，而 `ui:accept` 是需要真实数据+人工介入的手动脚本 —— 建议与「H5 之后的验收脚本重整」一起处理，届时用 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` 交由显式安装 **已完成（2026-09-15）**：`playwright` 1.63.0 已声明为 devDependency（lockfile 同步，integrity 取自 registry）。**立项前提不成立（实测）**：该版本**没有 install/postinstall 脚本**，所以 `npm ci` 不会去拉浏览器、解包约 18MB，而不是原先担心的 300MB 级；`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` 只在手动 `npm i` 时才有必要。**未验证**：未真跑 `npm ci`。 | 已完成 |
| L6 | 快照监听者清空后未删键（轻微 Map 泄漏） | `api.ts:63-68` **已完成（2026-09-15）**：`api.ts` 退订时若 `set.size === 0` 且仍是当前那个 Set 则删键（守卫 `api-snapshot-listeners.spec.ts`；空集键残留本身无可观测行为，故为源码级守卫 + A/B 转红）。 | 已完成 |
| L7 | `hasMore` 判定在 total 不可信或整页末页时错误 | `hooks.tsx:268` **已完成（2026-09-15）**：新 `panels/paged-list.ts` 抽出纯逻辑 `computeHasMore`（注释写明旧判据为何会静默截断），`hooks.tsx` 接线；守卫在 `paged-list.spec.ts`，A/B 转红。 | 已完成 |
| L8 | 布局动画期间每次 `finished` 重算小地图并写 localStorage | `EchartsGraphCanvas.tsx:743` **已完成（2026-09-15）**：新 `panels/timers.ts`（`createRestartableTimer` / `createNoticeController`，可注入时钟）+ `EchartsGraphCanvas.tsx` 的 `finished` 改为 300ms 静默期合并，卸载时先补一次再 dispose；守卫 `echarts-settle.wiring.spec.ts`。**未验证**：真机上小地图不再逐帧重算，需浏览器确认。**后续（画布重写，2026-09-15 晚）**：ECharts 画布整体被手写 Canvas2D 画布取代，`EchartsGraphCanvas.tsx` 与 `echarts-settle.wiring.spec.ts` 已删除；同一条约束（坐标落盘必须合并到静默期、绝不逐帧写）搬到 `GraphCanvas.tsx`，守卫改为 `graph-canvas.wiring.spec.ts`，并已由真机探针验证。 | 已完成 |
| L9 | 渲染中重复计算未 memo | `WorldMap.tsx:261,282` **已完成（2026-09-15）**：`WorldMap.tsx` 的 `railKey` / `geoRegions`（定引用后 `geoMarkers` 的 memo 才真正命中）/ `geoMax` / `geoRipple` 全部 memo。**未验证**：memo 是否命中需真机。 | 已完成 |
| L10 | 每块重建余串 O(k·n)，改 `substring` 偏移 | `moments.ts:158` **已完成（2026-09-15）**：`moments.ts` 改成单次 `indexOf('<media', pos)` 前缀搜索 + 绝对偏移（不再每块重建余串）。**条目诊断被实测推翻**：V8 的 `slice` 是 **O(1) 视图**（2 万次 ≈0ms），真正的平方项是**每块一次落空的 `indexOf('<media ')`**（2 万块 17.8s）。按实测改完：2.9MB / 2 万块 **12.97s → 2.88ms**，输出逐字节相同；A/B 转红。 | 已完成 |
| L11 | 正则预编译，避免每次动态构造 | `parse.ts:44,1133` **已完成（2026-09-15）**：`parse.ts` 新增 `cachedRe` 预编译（四处热路径），并去掉噪声标签表里重复的 `revoketime`（原本白跑一次）。A/B 转红。 | 已完成 |
| L12 | 签发私钥位于工作树，建议物理隔离到签发机 | `vendor-keys/license-private.pem`（已 gitignore 且不入包） **已完成（2026-09-15）**：`src/backend/README.md` 新增「签发私钥隔离」节（私钥只在签发机、工作树中的 `vendor-keys/` 已 gitignore 且不入包、轮换与历史重写联动 H1）；并核对了哪些脚本依赖工作树里的私钥（`backend-restart-smoke` 的依赖已在 N23 去掉，现在只剩签发工具）。 | 已完成 |
| L13 | 「添加成员」为有意死控件，补文档或实现 | `Chats.tsx:3333`、`chats.module.css:2224` **已完成（2026-09-15）**：`Chats.tsx` 的「添加成员」死控件补 why 注释（有意保留 = 产品未定，不是漏实现）。 | 已完成 |
| L14 | 知识库 stub（无对应文档的 `[[目标]]` 节点），标注或实现 | `graph-model.ts:26` **已完成（2026-09-15，结论=已实现，无需改源码）**：实测 stub 节点链路完整——`query/notes.ts:338` → `graph-model.ts:531-542`（注释 :31-35）→ `EchartsGraphCanvas.tsx:235-281,344-371` → `Graph.tsx:509-510`；仅新增 `graph-model.stub.spec.ts` 锁定契约。 | 已完成 |
| L15 | 文档引用了已删除的 CDP 脚本 | `docs/compose/spec/chat-message-module.md` **已完成（2026-09-15）**：`docs/compose/spec/chat-message-module.md` 把「相关 scripts 已在清理中删除」改成明确写「本页视觉结论**没有可复跑的 DOM 证据**」，并列出今天可用的替代工具（`tools/visual-audit/audit3.mjs`、`audit4.mjs`、`scripts/ui-acceptance.mjs`），提醒不要把将来回补的证据写成「当时已验」。 | 已完成 |
| L16 | CLEANUP.md 与现状矛盾（称已删项与现状不符、称移除 83 条死脚本但现又新增 20+ 条） | `CLEANUP.md` **已完成（2026-09-15）**：`CLEANUP.md` 顶部加「本文已过期」对照表（`renderer.js`/`styles.css` 已不存在；「移除 83 条死脚本」的口径已变，现在 `scripts/` 26 个且新增批进了 CI；M19 之后的打包排除与 H15/N19 的解包项；`.gitignore` 后续补充项），并指向当前权威口径（`package.json` 的 `files`/`asarUnpack`、本计划、后端 README）。 | 已完成 |
| L17 | 视觉审计证据脚本被 gitignore，导致 73KB 审计结论不可复现 | `docs/compose/spec/chat-panel-visual-audit.md:553` 引用的 `output/audit3.mjs` **已完成（2026-09-15）**：把 `output/audit3.mjs`、`audit4.mjs`（原在被 gitignore 的 `output/` 下，导致 73KB 审计结论不可复现）收回仓库 → `tools/visual-audit/`，修好路径解析（`REPO` 上溯两级、产物写回 `output/`）、playwright 改为常规解析，**并清掉源码里硬编码的两个真实群名**（改 `AUDIT_GROUPS`/`AUDIT_GROUP` 环境变量）；新增 `tools/visual-audit/README.md` 说明前置条件（真实数据 + playwright + 关闭运行中实例 + 开发态），`chat-panel-visual-audit.md` 三处引用同步更新。**未验证**：收回时只做路径与隐私清理，**未重跑**这两个脚本。 | 已完成 |
| L18 | 过期描述（称仓库无 wired-up tsconfig、称 `check:*` 已移除） | `docs/compose/spec/wechat-message-visual-system.md` **已完成（2026-09-15）**：`docs/compose/spec/wechat-message-visual-system.md` 的类型检查那条补上「当时 vs 今天」对照——今天仓库有 `npm run typecheck`（前后端 0 错误，已入 CI），`check:*` 脚本也都在 `package.json` 里，且前端类型改从 `lib/types` 取（H12），当年那 46 条「旧副本缺成员」的错误已不复存在。 | 已完成 |
| L19 | 若 H10 未一并处理，清理死 channel | `main.js:398,410,518,285,340`、`preload.js:17,32-43,49,67,72` **已完成（2026-09-15，实测=已由 M16 处理完）**：5 个死 channel 残留 0；`preload.js` 暴露的 29 个 channel 全部有 main 侧配对；那 5 个也没有渲染层调用者 —— M16 已经删干净，本条无需改动。 | 已完成 |
| L20 | 「notice 3 秒自动消失」重复十余处，抽公共实现 | 各面板 **部分完成（2026-09-15）**：新增 `panels/timers.ts`（`createNoticeController`）与 `hooks.tsx` 的 `useTransientNotice`（可注入时钟，守卫 `timers.spec.ts`）；**但 0 处调用点迁移**——12 处「notice 3 秒消失」全在写集白名单之外（其它面板文件），迁移改法已逐条写进 `hooks.tsx` 注释（行号 + 改法），后续成本极低。**当前 `useTransientNotice` 没有消费者**，如实记录。 **已完成（2026-09-15）**：把各面板重复的「notice N 秒自动消失」全部迁到公共实现（`panels/timers.ts` 的 `createNoticeController` + `hooks.tsx` 的 `useTransientNotice`），**共 14 处 / 11 个面板**（含 `Settings.tsx` 那处形态更富的：kind/details/关闭按钮 + 5s/12s 两档）；期间新增 `hold()` —— 失败类提示改前**不带定时器**（常驻），直接套 `flash` 会把它们变成自动消失（行为变更）。**验收**：源码级接线守卫 33 项 + `timers.spec.ts` 原语用例（假时钟）；变异把 `Ledger` 退回手写 `setTimeout` → 4 项转红。**未验证**：面板行为（真 3 秒消失、卸载不写 state、连发不互相截断）**无浏览器验证**（无 jsdom/组件测试环境，SSR 不跑定时器）。 | 已完成 |
| N3 | 构建成功信息恒报 `(0 KB)`：`result.metafile.outputs[outfile]` 的键匹配不上，体积统计失效 | `scripts/build-wechat-bundle.js:50-52`（本次实测输出 `794.1kb` 与 `0 KB` 并存） **已完成（2026-09-15）**：`scripts/build-wechat-bundle.js` 的 `outputBytes()` 改为三级取值 + `require.main` 守卫；现在构建输出是 `837.1 KB / 857223 B`，不再恒报 `(0 KB)`；新增 `bundle-size-report.spec.ts` 3 项。 | 已完成 |
| N4 | 无真实微信数据时后端每次启动向 stderr 打 `realtime sync paused` 告警，污染冒烟输出并被 PowerShell 判为 NativeCommandError（易被误读为失败） | `wechat-data/src/query/sync.ts:753` 附近；本次运行 `knowledge-graph-smoke` 时复现 **已完成（2026-09-15）**：`sync.ts` 未配置数据源时改为**一次性 stdout**（不再是每次启动的 stderr 告警），配置了但读不到仍走 stderr。**验收**：A/B 把 idle 分支改回 `console.warn` → 2 用例转红，还原后 sha256 逐字节一致；`check:knowledge-graph`/`rag:smoke` 现在输出 `realtime sync idle: no data source configured` 且退出码 0（不再被 PowerShell 判成 NativeCommandError）。**运行时生效依赖一次 bundle 重建**（已在本次收口执行）。 | 已完成 |
| N5 | 文档与注释中的图谱命名未与「社交图谱 / 知识图谱」两个入口对齐 | 中间版本曾叫「知识社交图谱」，该名称现已不存在；`src/client/README.md`、`docs/compose/spec/*` 等处的旧称（「社交图谱」「114 个方法」）仍待更 **已完成（2026-09-15）**：`src/client/README.md` 的界面结构按 `nav-config.ts` 实测重写——通讯录不再与「社交图谱」并成一项，社交图谱/知识图谱作为**两个并列入口**各占一行，隐藏项按分组归属列出（详见 M22）。 | 已完成 |

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
| 前端 | `EchartsGraphCanvas.tsx`：笔记用紫色圆角矩形、stub 用虚线半透明圆、`wiki`/`source` 边独立线型、tooltip 按物种分派；修正 stub 透明度被 dim 覆盖、头像额度被笔记占用两个副作用（该文件已在随后的画布重写中删除，同样的视觉规格由 `graph-canvas.ts` 承接） |
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
- [x] fresh clone 全历史中不含任何真实密钥（H1；2026-09-21 重写后自 GitHub fresh clone 实测：两文件全历史 0 条、三把密钥字面量 0 命中）
- [x] License 闸门在所有异常路径下均拒绝而非放行（H6；2026-09-21 `license-gate:smoke` 复跑全过：无证/过期/伪造/遗留试用文件一律拒绝）
- [x] `shell.openExternal` 拒绝非 http(s) 协议；导航守卫生效（H10；2026-09-21 `security-guard:smoke` 复跑全过：三次 window.open 全被拒、页面未被导航、openExternal 调用 0 次）
- [x] 法务对许可未明资产给出书面结论（H13；2026-09-21 结论为「允许保留」，书面件编号待补）
- [x] 隐私声明齐全、可访问，且首次启动强制同意（H14）

**可验证性**
- [x] `npm test` 全绿（H3；2026-09-21 实测 **191 文件 / 2176 用例 / 14 跳过 / 0 失败**——「36 个 spec」是 H3 当时的数字，已随两年演进）
- [x] CI 全绿且能阻断合并，含 bundle 一致性门禁（H4；2026-09-21：CI 全绿在**重写后**的 main `7339eec` 上实测 success；分支保护已按用户选择开启 —— 要求 PR + 必过检查 `verify`、`enforce_admins: true`、禁 force push/删除。**注意：此保护下直接 push main 会被拒**，发版改走「PR → CI 绿 → 合并 → 打 tag」）
- [x] `ui-acceptance.mjs` 失败时退出码非 0（H5；2026-09-21 **负向实测**：隔离 userData 下运行（不碰真实库），12 条断言失败 → 打印「退出码 1：断言未全通过（12 条失败 / 93 条通过，步骤 4/14）」且进程 exit 1；**正向**：2026-09-18 全绿 14/14 exit 0）
- [x] `npm run typecheck` 全绿（H11）

**版本与可复现**
- [x] `git status` 干净，无未提交改动（H2；2026-09-21 实测 0 条）
- [x] 全新目录 clone → `npm ci` → 构建 → 启动（H2；2026-09-21 实测：自 GitHub fresh clone → `npm ci` → `node node_modules/electron/install.js` → `build:ui` + `build:backend` 全过 → 以临时 userData 启动，日志确认「后端已就绪，Remote 方法数 158」（该 clone 落在 main，数字与 main 相符））
- [x] 打包版经 `package:smoke` 验证，SNS 视频解密走设计路径（H15；2026-09-21 `npm run pack` + `package:smoke` 全过：asar 白名单/体积预算/160 方法/安装目录只读/日志落点，且 `app.asar.unpacked` 下 WxIsaac64 WASM 在位）
- [x] `CHANGELOG.md` 记录了本次发布内容（H14；首段同时写明尚未闭环的阻塞项）

**可靠性**
- [x] 后端进程被杀后能自动恢复（H7；2026-09-21 `check:backend-restart` 复跑 6/6：taskkill 后自动重建、PID 变化、无重复拉起）
- [x] 无任何调用会导致 UI 无限 loading（H7；2026-09-21 **新增端到端验收** `npm run ui:loading-e2e` 10 项全过：注入「永不回包」+ 压到 1.5s 超时后，界面出现「调用超时…getSessions」、骨架屏清零、两侧日志均有记录、下一条调用照常收尾；变异（禁用注入）4 条转红）
- [ ] 导出 1000 会话不 OOM、不阻塞 UI（H8）
- [x] 百万级消息下搜索内存有上界（H9；验收证据见 H9 条目：20 万行 ×500B 实测 `iterate` +13.0MB vs `.all()` +345.2MB，百万级为外推；本轮未重跑测功）

---

## 十三、风险登记

| 风险 | 影响 | 应对 | 关联 |
|---|---|---|---|
| git 历史中含真实密钥，已在多人机器上 | 已泄露，轮换不可逆地依赖第三方配合 | 立即轮换凭据；通知所有克隆者重新克隆；后续所有配置禁止入库 | H1 |
| 修复 H1 需重写 git 历史，会打断他人分支 | 协作中断 | 选在低活跃窗口执行；事先广播；必要时保留旧仓库只读 | H1 |
| H13 法务结论可能要求移除核心资产 | 功能降级（表情资源、SNS 视频解密） | 提前准备方案 B 的降级实现与用户提示文案，避免临时救火 | H13（2026-09-21 已闭环：结论为**允许保留**，方案 B 未启用） |
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

| 2026-09-14 | 评审 | M1 | 第二轮独立复审（1 critical + 3 major + 7 minor） | ① **critical（我引入的静默销毁）**：`saveConfig` 把 patch 里的显式空串当成「用户要清空」，而界面在配置未加载完时也能点保存（无条件提交 4 个密钥字段）→ `secrets.json` 被整体抹成空值，原文件合法 JSON 连备份都没有、不可逆。② major：默认值 `image_xor_key:136` 被钉进 secrets，config.json 手工修改永久失效；渲染进程把含明文密钥的完整配置写进 `localStorage`（不在收紧范围，本机 leveldb 实测有真密钥）；**我声称在干活的「清理镜像 + 空 patch 迁移」实测都是空转**，而真正干活的回灌保存还有两条隐藏缺陷（镜像独有密钥被无声丢弃、`recordWechatSettings` 的替换语义会抹掉普通设置）。③ minor：预收紧凭空造空目录、重启路径不跑收尾、恒真装饰断言、ino 判据对「改名挪走+原地写」完全假绿（10 跑 0 红）。 |
| 2026-09-14 | 实施 | M1 | 修复批次（critical 1 + major 3 + minor 4 + 顺带修出 1 条真缺陷） | ① `secretIsMeaningful`（空串/默认值都不算真值）统一三处判定（写入取舍、读回优先级、旧数据搬运）+ 客户端保存按钮在配置读到之前禁用 + 渲染缓存按 `Omit<>` 类型化剥离密钥并自愈重写老缓存。② config.json **恒不保留**密钥字段（顺带修掉「默认 136 落盘 → 启动期旧密钥判据每次都误判 → 多跑一次空 patch 保存并抹掉宿主镜像普通设置」这条真缺陷）。③ 镜像密钥**并进同一次回灌 patch**（后端写 secrets、回写镜像时顺手过滤），`recordWechatSettings` 改为**合并**并在合并时清掉密钥残留，删掉已成死代码的 `pruneMirroredSecrets`。④ 预收紧不再创建空数据根、重启路径补跑 M1 收尾、去掉恒真断言、跨进程用例新增「必须出现 `.tmp-`」探针。**变异矩阵 22 条全部被杀死**；打包态冒烟扩到三场景 |
| 2026-09-14 | 实施 | 教训（M1 第二轮） | — | ① 「读取失败回退默认值 + 之后无条件回写」= 静默销毁；**输入侧的默认值同样危险** —— 「显式空串」在界面上从来不是「用户要清空」，而是「表单还没填」。默认值参与判定时，必须问一句「这个值带信息吗」（`136` 不带，`''` 不带）。② 把数据从一个有损坏留痕机制的文件搬到没有该机制的文件 = 韧性净下沉。③ **声明机制在干活之前先实测归因**：我写了两条「迁移分支」，复审一跑发现正常形态下它们都是空转、还遮住了真正在干活那条路径上的两个缺陷 —— 顺着「谁真正改了这个文件」查，比顺着自己的设计意图查有效得多。④ 一个函数的语义要配得上它的名字：`recordWechatSettings`（记录）做成**整体替换**，直接导致任何内部的部分保存都会抹掉镜像；实测踩了两次才改。⑤ 测试判据要防「假绿家族」：ino 只能区分「原地改写」与「替换」，区分不了「原子替换」与「删掉/改名后再建」—— 加一条「必须出现临时文件」的探针才闭合。⑥ 一条 e2e 场景不够：我最初的两个场景都是**构造态**，真实升级形态（镜像含普通字段）反而没覆盖。 |
| 2026-09-14 | 实施 | 合计 | 72 项：未开始 47 / 进行中 3 / 已完成 22 | M1 保持「已完成」（本轮是同一项的加固与补测，不新增条目）；阶段 5 仍 34 项、阶段 6 仍 23 项 |
| 2026-09-14 | 评审 | M8 | 独立复审（无 critical + 2 major + 5 minor） | 独立重做签名枚举（20 条）与接线守卫变异（6 条），确认我补的 8 处方向都对、两处接线守卫非假绿；抓到两条**我引入的回归**：① 手改 `secrets.json`/`config.json` 换图片密钥或 `db_dir` 不走 RPC ⇒ 宿主缓存里的成功条目永久返回旧字节（旧行为靠 ≤10s 的事件清空自愈）；② `getArticleCover` 的失败重试是空转 —— 内层负缓存吞掉了（实测同 URL 连查三次只发 1 次请求）。另指出：量化脚本没进仓不可复现、「7 个分片」与实测不符（catalog 只纳入 4 个）、旧行为还会丢 `contact-meta`（3.2–7.5ms）所以 15ms 是下限、`db-health`/`status` 的兄弟文件靠 TTL、`overview`/`annual` 的签名缺 media/fts/resource。**复审的关键判断**：元数据层省的是噪声量级（约 8–10ms/事件），真正价值在宿主结果缓存层（12–21s/次 miss）。 |
| 2026-09-14 | 实施 | M8 | 未开始 → 已完成 | ① `shardMetaOf` 按文件粒度缓存分片元数据；② `bumpDataGeneration()`/`dataGenerationSig()` 替代整体清空；③ 补齐 8 处签名；④ 宿主结果缓存定向失效 + **解码输入指纹进键**（修 M2）+ `article-cover` 不再缓存瞬时失败（修 M3）；⑤ `storage-file-names` TTL 收回到 10s。新增 `scripts/m8-cache-storm-bench.mjs`（可复现量化）。**变异矩阵 10/10 被杀死**，含两条源码级接线守卫（此前删掉 `bumpDataGeneration()` 或把事件分支改回整体 `clearResultCache()`，现有用例全绿 —— 自查发现并补上）。 |
| 2026-09-14 | 实施 | 教训（M8 第二轮） | — | ① **接线守卫不是可选项**：两条「实现改对了但调用点没接上」的路径（同步事件不推进世代、事件分支仍整体清空）在补守卫前**全绿**；这类退化只有源码级守卫或端到端能抓。② 缓存策略改动的正确性边界是「**谁在什么时候改这个文件**」：把「数据更新时清空」换成「按签名失效」时，必须把**非 RPC 的写入者**（用户手工编辑 `config.json`/`secrets.json`）也算进来 —— 我把密钥/数据根指纹放进键才闭合。③ 改上层失效策略前要先看下层有没有自己的缓存：内层负缓存让上层「丢失败重试」变成空转（复审用 `fetch` 计数实测）。④ 量化脚本要进仓，否则数字不可复现甚至记错（我把「7 个分片」当成上界，实际进 catalog 的只有 4 个）。⑤ 别把小优化说成大收益：元数据层省的是毫秒级噪声，真正值钱的是另一层。 |
| 2026-09-14 | 实施 | 合计 | 72 项：未开始 46 / 进行中 3 / 已完成 23 | 阶段 5 完成 10（M20/N7/M23/M2/M4/M5/M6/M7/M1 加固/M8） |
| 2026-09-14 | 评审 | M8 | 修复定向复审（两条 major 关闭；2 条变异存活 + 4 条 minor） | ① **两条 major 的修法都实测有效**：真值级端到端（真实 `createWechatBackend` + 打桩方法计数）证明改 `secrets.json`/`config.json` 会让同参调用重新执行、不改则命中，且两种数据根模式口径一致；`article-cover` 的负缓存变异被新用例抓住。② **但纠正了我的前提**：陈旧「成功字节」在真实链路**不可达**（内层磁盘/内存缓存先钉住，换 AES 键=解码失败）⇒ 该修法的价值是「输入一变就重试**失败**条目」，措辞已收敛。③ **两条变异存活**：源码级守卫只保证调用点写法（把 `decodeInputSig` 改成恒返回空串、或读错目录，守卫照样通过）；10s TTL 无任何覆盖。④ minor：`wechat-host.js` 一处排版噪声；指纹对每个 `call()` 求值（实测 `statSync` 命中 9.4µs、文件缺失 84µs，相对 12–21s 可忽略）；`decoded_images` 不在指纹里、内层三层缓存对改键不敏感（既有行为）；瞬时失败不再永久负缓存后，永久 404 会按渲染节奏反复抓。 |
| 2026-09-14 | 实施 | M8 | 按定向复审补强 | ① 补**真值级**用例（真实后端 + 打桩计数，覆盖「改密钥/改数据根必须重新解码」）—— 它杀死了复审发现的两条存活变异（`decodeInputSig` 恒空、读错目录）。② `article-cover` 的瞬时失败改为**60s 短暂负缓存**（既不把抖动变成永久坏掉、也不让永久 404 反复抓），用例用假时钟锁住两个方向。③ `storage-file-names` 的 10s 上限加字面量守卫（目录签名看不到「原地改大小」，TTL 是唯一上界）。④ 修掉 `wechat-host.js` 的排版噪声。**变异矩阵 14/14 被杀死**。全量：`npm test` 157 文件 / 326 用例（322 通过 / 4 跳过 / 0 失败）、typecheck 0、pack + package:smoke 通过、rag:check 20 项通过。 |
| 2026-09-14 | 实施 | 教训（M8 第二轮） | — | ① **字符串级接线守卫不够**：它保证调用点写法，不保证被调函数真的读了正确输入 —— 凡是用守卫保护接线的改动，都要再配一条**真值级**用例（本轮 `decodeInputSig` 的两条变异就是这么被放过去的）。② 声明收益前先确认**这条链路上到底能不能观察到差异**：我给出的 major 前提（旧字节永久回显）被内层缓存吸收、真实不可达；这类「理论上该坏但被下层挡住」的结论必须实测。③ 反过来，下层缓存也会**吞掉**上层策略（`article-cover` 的永久负缓存让「丢失败重试」空转）—— 改上层策略前先查下层有没有缓存。④ 折中方案要写清两个方向：永久负缓存 = 抖动变永久坏；完全不缓存 = 404 反复抓；60s 短暂负缓存同时解决，且能用假时钟确定性地测。 |
| 2026-09-14 | 评审 | M9 | 定向复审（**静态**：本机 bash 被策略拒绝，未能跑任何命令） | ① 给出等价性的静态证明与手工 trace（`cursor` 是组起始前缀和、`next` 稳定落位、`limit` 必在「第 take 项所在距离」停下），并证明**等价变异定理**：任何「放宽 limit 且保持 `cum(limit) ≥ take`」的变异输出恒等、无反例（只有「收窄」与「破坏稳定性」两个方向可被杀）⇒ 我先前记为「存活」的那条不是覆盖缺口。② 抓到三条实质问题：**接线零覆盖**（把调用点退回旧 `map+sort+slice` 不会让任何用例变红 —— 两者按定义等价，只能由源码级守卫兜住）；**非整数/NaN pool** 会让 `new Array(take)` 抛 `RangeError`（旧 `slice` 天然容忍，而 `pool` 来自可手改的 `rag-config.json`、`deepMerge` 不做数值校验）；**`d=64` 这个承重边界**与 `popcount32` 本身都缺独立校验（差分测试两侧共用它，popcount 错了两侧一起错）。③ 指出同一路径上还有 per-query 的 `COUNT(*)`（⇒ 登记 N14），并给出「LSH 在这个召回半径下拿不到数量级」的定量判断（池边界 ≈ 直径一半，banded LSH 要么召回只剩 1/3、要么桶大到没加速）⇒ 维持计数选择。④ 判断测试里的旧算法 oracle **不算**「复述生产逻辑」，但要求把 popcount 的独立性补上。⑤ 澄清一处我担心的语义：旧 `slice` 参数确实是 `Math.max(opts.candidatePool, opts.topK)`（已用 `git show` 复核），本次未改变召回集。 |
| 2026-09-14 | 实施 | M9 | 未开始 → 已完成 | 粗筛改**计数选择**（`Uint8Array` 存距离 + 65 格直方图 + 稳定计数排序），实测 13.5 万行 15.5ms → 1.2ms（12.9×）、20 万行 24.4ms → 2.2ms（11.0×）。按复审补：**源码级接线守卫**（粗筛段必须调 `selectByHamming`、不得出现 `.sort(`）+ **真值级端到端**（`buildVectorIndex` 打桩 embedding → `searchDense`，用余弦定义独立算真值对照）；`pool` 归一化（非整数/NaN/Infinity）；补 `d=64`、`pool==N/N-1/0`、非整数/NaN/Infinity、距离全相同等边界与 `popcount32` 的 1 万条独立对照；把「负数 pool 的行为分叉」写成显式用例。`docs/rag/RAG-ARCHITECTURE.md:132` 实现描述同步更新。**变异矩阵 10 条被杀死**（含回退优化、直方图少一格、去掉 pool 归一化）。登记 **N14**。 |
| 2026-09-14 | 实施 | 教训（M9） | — | ① **「等价的重构」不是自明的**：把全量排序换成计数选择，正确性必须拿**旧实现当 oracle** 做差分（我把改动前的算法重写进测试）——复审确认这是差分测试的正确形态，但提醒 oracle 不能与被测**共用**基础函数（`popcount32`），否则「基础函数本身对不对」变成无覆盖命题（已补独立对照）。② **等价变异别补测试**：放宽 `limit` 那一族输出恒等（复审给了定理），为它加用例只会逼着测试去撬私有中间量。③ **边界要挑承重的那个**：`MAX_HAMMING + 1 = 65` 这一格之所以承重，是因为两段 32 位 popcount 之和**可以恰好等于 64**（查询向量取反 ⇒ simhash 逐位取反）—— 少一格会静默丢行还留空槽。④ **配置边界要设防**：`pool` 来自可手改的 JSON，旧 `slice` 的宽容掩盖了「非整数会抛」的坑。⑤ 再次印证「别把小优化说成大收益」：这里省的是毫秒，端到端由 embedding 往返主导 —— 同一路径上真正的大头（粗筛表加载 250ms）恰好已被缓存，而另一个 per-query O(N)（`COUNT(*)`）被漏在了旁边（登记 N14）。 |
| 2026-09-14 | 实施 | 合计 | 73 项：未开始 46 / 进行中 3 / 已完成 24 | 阶段 5 完成 11（…/M8/M9）；阶段 5 条目 34 → 35（+N14） |
| 2026-09-14 | 评审 | M10 | 独立复审（bash 可用，复现全部数字；1 major + 8 minor，无 critical） | ① 复现了 4000/40000 两档的请求数与墙钟、simhash 单位成本（0.0335ms/篇）、让出 A/B。② **纠正了我一处低估**：旧实现墙钟我是「请求数 × 延迟」建模（10.00s/100.0s），它从 git 取出**真实 pre-M10 代码**跑同一桩实测 **11.70s/116.9s** ⇒ 真实加速 8.8×/9.1× 而非 7.6×/7.8×。③ **直接实测了验收项**：建库期间并发只读查询 86 次采样 0 错误、最长 1ms。④ **major：并发上限断言是空转的** —— 原夹具 8 文本/batchSize 4 ⇒ 最多 2 个批次在飞，`<= 16` 恒真，删掉上限夹取整套用例照样绿。⑤ 另有 8 条 minor：`batchSize` 没同类钳位、`embed_calls` 在 await 之后计数（失败漏报）、`yieldToLoop` 重复造轮子（`search.ts:530` 已有）、实测脚本 `distinct` 统计算错、别名用例杀不了变异、`onProgress` 语义变化但生产不可达、`gateway.ts` 摘要是第二处同形态热点（→ N15）、`groups` 峰值堆 +7MB（可接受）。⑥ 确认我的两处自述成立：simhash 证伪站得住；`if (failure) return` 冗余但无害（正确性由单事务 + ROLLBACK + `close()` 保证，且 `Promise.all` 会静默吞掉同伴的后续拒绝 —— 所以靠监听 unhandledRejection 的用例会给出**假绿**）。 |
| 2026-09-14 | 实施 | M10 | 未开始 → 已完成 | 去重扇出 + 有界并发 + 失败不半写 + 周期性让出（复用 `yieldToLoop`）+ `embed_calls` 可观测。按复审整改：并发上限换成「夹具顶到上限」的断言（变异已验证可杀）、`batchSize` 一并夹到 [1,256]、`embed_calls` 改为发起前计数、实测脚本统计修正、别名用例降级为「运行时契约守卫」（只有 node:sqlite 改成惰性绑定才会红）。**变异矩阵 10 条被杀死**（含两条钳位；另 2 条结果等价、1 条契约守卫）。登记 **N15**。 |
| 2026-09-14 | 实施 | 教训（M10） | — | ① **上界断言很容易是空转的**：`maxInFlight() <= N` 只有在「夹具的可并发工作单元数 > N」时才有杀伤力（本轮 8 文本/batchSize 4 ⇒ 上限 2，`<= 16` 恒真）。写「不该超过 N」时，先问一句「这个夹具能顶到 N 吗」。② **别用建模数字当实测**：我把旧实现的墙钟用「请求数 × 延迟」算出来就当结论，复审跑真代码发现低估 17%。可建模的地方一定要标注「建模」，或干脆把旧代码取出来跑。③ **`Promise.all` 会吞掉同伴 promise 的后续拒绝** —— 所以「共享状态 + 长生命周期资源」的缺陷不会以 unhandledRejection 形式暴露，靠监听它的回归用例会给假绿（本轮那条守卫测试杀不死正是因为结果等价，而不是因为它没用）。④ 立项假设要拿测量过一遍：`simhash` 阻塞（0.037ms/篇）与「N 次串行往返」相比根本不是同一个量级的问题，好在去重那条恰好是真正的瓶颈（56.5% 重复）。⑤ 同一形态的热点要全库找一遍（复审顺手指出摘要任务也是 N 次串行 LLM 调用 → N15）。⑥ 新加机制前先查有没有现成 helper（`yieldToLoop` 已有，我内联了一遍）。 |
| 2026-09-14 | 实施 | 合计 | 74 项：未开始 46 / 进行中 3 / 已完成 25 | 阶段 5 完成 12（…/M8/M9/M10）；阶段 5 条目 35 → 36（+N15） |
| 2026-09-14 | 评审 | M11 | 独立复审（真实数据，1 major + 若干 minor，无 critical） | ① **确认了我最担心的那件事不存在**：`shardCatalogSig` 与 `shardCatalogDirs` 共用同一段谓词字面量 ⇒ 过滤集恒一致（实测 7 个 .db 两侧同为 4 个、增删分片同步变、加被过滤文件两者都不变）⇒ 缓存不会因此陈旧。② **纠正我的两处**：(a) 收益表述过宽 —— `cachedBySig` 的 TTL **从写入计时**，所以「同步完再点」那条路径（间隔 ≈10s > 5s）省不掉；(b) 「不做连接复用」的理由**用错了对象** —— `hardlink.db` 在本仓库无写入点、也不是同步目标，长期只读句柄是安全的。③ **指出我漏掉的真正杠杆**：`lower(md5)=?` 是 `SCAN`，实测 3309 行 0.30ms、20 万行 17.27ms（线性）⇒ 30 张图 ≈518ms，一行索引或一次批量查询即可（已登记 N16）。④ 确认缓存对象共用**无可观察影响**（RPC 经 zod/JSON 跨进程，引用穿不过边界；客户端只读、有防重入）。⑤ 确认 `entries` 无上限累积（负条目 ~740B）属既有模式。⑥ 复核我的读数方法（冷未命中每次换新 id、缓存后重复分开量）**不误导**；`resolveImageFilePath` 的 1.03ms 是紧上界。⑦ 顺带发现 `storage.ts:resolveFileTitle` 每文件重跑一次冗余 `PRAGMA table_info`（Minor）。 |
| 2026-09-14 | 实施 | M11 | 未开始 → 已完成 | 按实测把范围收窄为「安全且可度量」的一处：`queryMessageByServerId` 加签名缓存（实测重复查询 3.79ms → 0.09ms、77.1ms → 0.07ms）。按复审整改：收益表述收敛到「<5s 内的重复」、把「不会返回旧结论」限定为「同步走 rename 时成立」。**有意不做**连接复用（理由已被复审证伪，且真杠杆另有其事）与批量 RPC（接口变更）。新增 `nplus1.measure.spec.ts` + 两项缓存用例。登记 **N16**。 |
| 2026-09-14 | 实施 | 教训（M11） | — | ① **「N+1」要先证明它真是 N**：条目列了三处，实测有两处不成立（整型查询其实走了覆盖索引；`dir2id` 只有 89 行），而客户端调用点根本不是循环。先量再改，省下两次无谓甚至有害的改动。② **理由要落到正确的对象上**：我拿「Windows 长句柄会拖住同步」去否掉连接复用，但那个文件在本仓库根本没有写入点 —— 机制没错，用的对象错了（复审一句话点破）。③ **TTL 的方向会改变结论**：`cachedBySig` 从**写入**计时，于是「相隔 10s 的重复」不在覆盖范围内，我原来的收益表述就成了过度声明。④ 担心缓存陈旧时，先核对**签名与数据源是否同源**（这里共用同一段谓词字面量 ⇒ 过滤集恒一致），能省掉一整轮怀疑。⑤ 找杠杆要顺着**执行计划**找：`EXPLAIN QUERY PLAN` 一眼看出 `lower(md5)` 无索引可用（`md5_hash` 虽被索引，但我试了 6 种推导都推不出映射，那就不能拿它当 key）。 |
| 2026-09-14 | 实施 | 合计 | 75 项：未开始 46 / 进行中 3 / 已完成 26 | 阶段 5 完成 13（…/M8/M9/M10/M11）；阶段 5 条目 36 → 37（+N16） |
| 2026-09-14 | 实施 | M12 | 未开始 → 已完成（范围收窄） | 先量后改：compress 的句子级去重改为「按会话分组 + 3-gram 只算一次」，实测 1.77ms → 0.92ms/窗口（≈17.7 → 9.2ms/次提问）；**fusion 的按会话索引改完测出没有可测收益后撤回**（现实形状 0.54 → 0.70ms，最坏情形不变），把理由与测量留在 `dedupe.measure.spec.ts`，并删掉因此变成同义反复的差分测试。 |
| 2026-09-14 | 实施 | 教训（M12） | — | 「O(n²)」不等于「是瓶颈」：这条路径的 N 由配置夹住（`fusion.keep`=120），最坏 14ms、现实 0.5ms，而同一路径上真正重复构建 n-gram 的 compress 才是那 17.7ms。**改完要复测，且要能接受「改完撤回」**：按会话索引在纸面上显然更优，实测却在噪声内 —— 没有证据的代码不该留（撤掉时连带删掉那张变同义反复的差分测试，否则它会假装在守护什么）。 |
| 2026-09-14 | 实施 | 合计 | 75 项：未开始 45 / 进行中 3 / 已完成 27 | 阶段 5 完成 14（…/M8/M9/M10/M11/M12） |
| 2026-09-14 | 评审 | M12 | 独立复审（bash 可用；无 critical + 2 major + 3 minor） | ① **确认行为等价**：用「旧版 / 新版 / 把分歧点还原成旧式的对照版」三条实现跑同一夹具（结构化 + 阈值 fuzz + 400 组随机 ranked = 1593 个窗口），输出**逐字节相等**；`gramsOf3` 的 `&& s` 分歧不可达（`body` 先过非空判断）也不可观测（旧 `jaccard` 的 `if (!a||!b) return 0` 早返回让那行本来就是死代码），62.7 万对逐对比对 0 差异。② **major：compress 有接线、零守卫** —— 改回旧写法全套用例仍绿（仓库既定惯例是补源码级守卫）。③ **major：原验收口径（候选数 2000）未触及**，实测 N=1920 最坏 3772ms，而 `fusion.keep` 可手改且无校验。④ minor：源码注释里硬编码了机器相关的耗时；把「按会话分组」与「3-gram 缓存」两件事归成一个 2×（实测主项是后者）。⑤ 确认**撤回 fusion 的按会话索引是对的**：它另试 gram 倒排索引，最坏仅 1.9× 而现实形状反而变慢（0.52 → 1.55ms）。⑥ 顺带指出 `fusion-dedupe.spec.ts` 从未入库（确实如此，我建完删掉了没提交）。 |
| 2026-09-14 | 实施 | M12 | 按复审整改 | ① 给 `fusion.keep` 加硬上限 400（load/save 两条路径）+ 用例（9999/1920→400、0/-5→1、abc→120、200.7→200）+ 变异验证（去掉上限即红）。② compress 补**源码级守卫** —— 注意我第一版守卫写成 `toContain('jaccardGrams(')`，那只匹配得上函数定义本身、变异照样通过（自查发现），改成断言**调用点**后才杀死变异。③ 删掉源码注释里硬编码的耗时、把两件事分开归因。全量 175 文件 / 359 用例（350 通过 / 9 跳过 / 0 失败）。 |
| 2026-09-14 | 实施 | 教训（M12） | — | ① **源码级守卫要断言「调用点」而不是「名字出现过」**：`toContain('f(')` 连函数定义都能匹配，等于没守（我第一版就是这样，变异照样绿）。② **改验收口径要显式承认**：原始验收盯着 N=2000（实测最坏 3.8s），我按实测把范围收窄到默认配置下的热路径 —— 这没问题，但必须在文档里说清「原口径未达成 + 为什么」，并补上防爆措施（这里就是 `keep` 的硬上限）。③ 判「n-gram 缓存类重写是否等价」时，关键是对比 helper 的**唯一消费者**跑差分（旧 `jaccard` 的早返回让一处分歧不可观测），而不是只对比 helper 本身。④ 改完要能接受「撤回」——复审自己试的更优方案也测不出收益（倒排索引让现实形状变慢），这类结论值得留档。 |
| 2026-09-14 | 评审 | M13 | 独立复审（bash 可用；无 critical + 1 major + 若干 minor） | ① **确认修复达成且窗口真的关上**：`tryStart` 是同步读-判-写、应用未开 StrictMode（全仓 grep 只命中 react-dom bundle 字符串）、事件处理器不被双调用 ⇒ 不会出现两个闸门实例。② **major：接线零守卫** —— 把 `use-ask.ts` 整体退回改动前（`git diff --no-index` 校验逐字节相同），全量 365 用例**零变红**；它给出候选守卫并双向验收（head 4 绿 / 退回 4 红）。③ 指出 `finally` 的 false 分支**不可达**（穷举 5 轮 1920 种交错 0 次）⇒ 属死代码但建议保留，注释措辞该改（已改）。④ 逐字实测 id 合并**无副作用**（空串时三种 delta 全丢弃），并确认顺带修掉了「过期轮 finally 置空 streamIdRef 导致新轮增量全丢」的旧毛病。⑤ **顺带发现同类缺陷**：`Ask.tsx` 反馈按钮用 state 当闸门，且 host 的 `submitAskFeedback` **没有单飞**（重复副作用会真落到后端）⇒ 登记 N17；另列出导出/同步/解密几处「后果较轻」的同族。⑥ 给了一条写守卫的坑：`[\s\S]*?` 会跨内层花括号对**正确**代码误报红，要用 `[^}]`。 |
| 2026-09-14 | 实施 | M13 | 未开始 → 已完成 | 闸门改为 ref 持有的独立模块 `panels/ask-gate.ts`（同步判定 + 轮次 id 认领）；vitest include 扩到前端纯逻辑模块；新增 `ask-gate.spec.ts` 6 项 + 按复审要求补 `use-ask.wiring.spec.ts` 3 项接线守卫（双向变异验证：两种回退各被抓住）。登记 **N17**。 |
| 2026-09-14 | 实施 | 教训（M13） | — | ① **用异步状态当同步闸门是陷阱**：`useState` 在闭包里读到的是上一次渲染的值，两次快速调用双双通过；要单飞就把闸门放进 `useRef` 或独立模块。② **先返回者不许清别人的状态**：`finally` 无条件收尾在并发/重入下必然出错，正确做法是认领 id。③ **改一处没人能测的代码，先把测试基建补上**（vitest include 不含前端时，连 spec 都进不来）；④ **修完还要问「退回旧写法会不会有人发现」** —— 复审实测 0 红，这才促成了守卫；写守卫时 `[\s\S]*?` 会跨内层花括号误报，要用 `[^}]`。 |
| 2026-09-14 | 实施 | 合计 | 76 项：未开始 45 / 进行中 3 / 已完成 28 | 阶段 5 完成 15（…/M8/M9/M10/M11/M12/M13）；阶段 5 条目 37 → 38（+N17） |
| 2026-09-14 | 实施 | M14 | 未开始 → 已完成（选「移除」而非「接线」） | 删掉未被引用的 `VirtualList`、它的 `useVirtualizer` import、`kit.module.css` 里 3 条 `.vlist*` 规则，以及根与 `src/client/ui-wechat` **两个** package.json 里的 `@tanstack/react-virtual`，并**同步更新 lockfile**（只删该依赖的 30 行）—— 只改 manifest 会让 CI 的 `npm ci` 直接失败。选移除的理由是 `VirtualList` 要求固定行高而真实列表是可变高的（接线会切行错位），且本会话没有浏览器验证条件；原验收「DOM 有硬上界」**未达成**，登记为 N18。 |
| 2026-09-14 | 实施 | 教训（M14） | — | ① 条目给了「接线 or 移除」两个选项时，要按**形态是否匹配**选，而不是按「哪个显得更有产出」：`VirtualList` 的固定行高签名与聊天/朋友圈/通讯录的可变高行根本不兼容，接线等于制造缺陷。② **移除依赖必须连 lockfile 一起改**（`npm uninstall <pkg> --package-lock-only`）—— 只改 `package.json` 会让 `npm ci` 失败，而本地 `npm test` 完全看不出来。③ 验收标准没达成时要说清楚「哪一条没达成、为什么」，并登记后续项（这里是「DOM 节点数上界」→ N18），而不是把条目改写成只覆盖自己做到的部分。 |
| 2026-09-14 | 实施 | 合计 | 77 项：未开始 45 / 进行中 3 / 已完成 29 | 阶段 5 完成 16（…/M8…M14）；阶段 5 条目 38 → 39（+N18） |
| 2026-09-14 | 实施 | M15 | 未开始 → 已完成 | 四处轮询收口到 `panels/poll-registry.ts`（纯模块 + 假时钟用例）+ 卸载统一 `stopAll()`；按 M13 的教训另加 3 条源码级接线守卫（无裸 setInterval/clearInterval、四处都走 polls().start、必须有卸载清理）。全量 182 文件 / 376 用例。**未验证**：条目原文要求「抓取实际 IPC 日志」，本会话没有跑真实 App 中途切面板的条件，该端到端一步未做。 |
| 2026-09-14 | 实施 | 教训（M15） | — | ① 「在 finally 里清理」在 **await 一个长任务**时等于没清理：组件卸载不打断 await，interval 会一直活到任务结束 —— 清理必须挂在组件生命周期（`useEffect` 的返回值）上，而不是挂在业务的收尾分支里。② 这已是本会话第三次「抽出纯模块 + 假时钟/状态机用例」来测一个原本测不到的 React 行为（M13 的 ask-gate、M15 的 poll-registry）；没有 hook 测试环境时这是可复制的路子。③ 接线守卫要按 M13 的模板一起补，否则「机制改了但接线没接上」照样零信号。 |
| 2026-09-14 | 实施 | 合计 | 77 项：未开始 44 / 进行中 3 / 已完成 30 | 阶段 5 完成 17（…/M8…M15） |
| 2026-09-14 | 实施 | M16 | 未开始 → 进行中（类型契约已完成；死 channel 待产品决定） | ① 类型契约实测**已达标**：`WechatRemote` 132 个成员与 `@Remote` 集合零缺零多，且 `remote-contract.spec.ts` 三条断言守着（随 H11 完成）。② **推翻条目的「死 channel」说法**：全仓扫 1256 文件，5 个 channel 每一个都被根目录 `preload.js` 暴露（与在用的 `window:minimize` 同形），链路是通的；缺的是渲染层调用方 —— `ui-app` 自绘标题栏（`frame:false`）在用 `windowControls`，但只有最小化/关闭/全屏，没有最大化控件。③ 因此条目给的两条路（删 API / 接入实际 UI）是**有后果的产品选择**，已向用户提问，未擅自删 API。 |
| 2026-09-14 | 实施 | 教训（M16） | — | **「死 channel」要先查 preload**：IPC 的调用点往往不在 `src/**`，而在仓库根的 `preload.js`（contextBridge 暴露的包装函数）。我第一版探针只扫了 `src/` + `scripts/` + `tools/`，没扫仓库根，于是把 5 个「已暴露但没被渲染层调用」的 channel 误判成「没有任何引用」 —— 差一步就去删了能用的 API。判断 IPC 死活要**三层一起看**：main 的 handler、preload 的包装、渲染层的调用。 |
| 2026-09-14 | 实施 | M16 | 进行中 → 已完成（按用户决定：删掉 5 个暴露） | 同时删 main.js 的 handler 与 preload.js 的包装（maximize-toggle / is-maximized + maximized-changed 事件对 / wechat:dispose / license:activation-request / license:fingerprint），保留最小化关闭全屏；清掉因此变成死引用的 `getDeviceFingerprint` require 与 README 里的 `wechat:dispose` 描述。**专门重打了包并跑打包态启动验证**（这次改的正是 main/preload 的 IPC 面）：后端就绪 132 方法、无 ENOTDIR、截图与日志正常。全量 182 文件 / 376 用例。 |
| 2026-09-14 | 实施 | 教训（M16） | — | **「死 channel」要先查 preload**：IPC 的调用点往往不在 `src/**`，而在仓库根的 `preload.js`（contextBridge 包装）。我第一版探针只扫 `src/` + `scripts/` + `tools/`、漏了仓库根，于是把 5 个「已暴露但没被渲染层调用」的 channel 误判成「零引用」——差一步就去删了能用的 API。判断 IPC 死活要**三层一起看**：main 的 handler、preload 的包装、渲染层的调用；而且改 IPC 面**必须重打包跑打包态启动**（`ui:smoke` 是 SSR，观测不到 preload）。 |
| 2026-09-15 | 实施 | M17 | 未开始 → 已完成（用更小的代价达到同一条验收） | vite `resolve.alias` + tsconfig `paths` 把 shim 直接解析到源码目录，构建与类型检查都不再读 node_modules 里那份 `file:` 拷贝。**验收实验**：只改源码、不跑同步、直接 vite build → 标记出现在产物 CSS，而拷贝全程是旧的；复原后标记消失。「不再静默用旧副本」因此在结构上成立。`sync-ui-shim.js`/`check:shim` 保留为磁盘一致性检查，不再是构建前提。 |
| 2026-09-15 | 实施 | 教训（M17） | — | ① 条目主张的修法（workspace/symlink）**代价更大**：它会动 npm 安装与 electron-builder 的打包布局，而验收标准要的只是「构建不静默用旧副本」—— `resolve.alias` + tsconfig `paths` 就能达到，且零打包风险。选修法要对着**验收标准**选，不是对着「更彻底」选。② 同一个陷阱在这个仓库出现过两次（H12 的前端类型、M17 的构建），说明「`file:` 依赖 = 只在 install 时刷新的拷贝」是这套布局的系统性坑；两处现在都改成直读源码。③ 验收要做**对照实验**：只证明「产物里有改动」不够，还要同时确认「那份拷贝里没有」——否则分不清是读了源码还是同步脚本正好也把它刷过去了。 |
| 2026-09-15 | 评审 | M18 | 独立复审（bash 可用；无 critical + 1 major + 2 minor） | ① **major：我写错了因果** —— README 与 `a447d86` 提交信息都称 mac/linux「会缺原生二进制」，实测 `--mac` 在本机直接抛错（`Build for macOS is supported only on macOS`）、`--linux --dir` 反而成功出包但缺 `koffi-linux-x64`（「出得来、跑不了」）。真正的理由是数据源。② 14 组沙箱变异（junction 到真 node_modules）逐条比对旧守卫，列出 4 个漏法（加 `dist:mac` 脚本、`arch` 改 arm64、新增 ubuntu runner 的 workflow、`files` 去掉 `@koromix`）与 2 处过拟合（`description` 大小写、README 取前 2000 字符窗口），并更正我一个猜法：`electron-builder.yml` **不**覆盖 `package.json` 的 `build`（实测日志 `loaded configuration file=package.json`），故 yml 不算漏。③ minor：条目仍标未开始且证据行号已过期；`tools/license-studio/main.js:277` 与 `main.js:1212` 是同款模板残留（前者是 dev 工具、无 build 配置、不进包）。④ 遗漏提醒：改完没跑 `npm run dist`，而交付物（安装器）还是 9/14 的旧件；也没查 mac/linux 失败的**真实原因**（于是 README 写错因）。⑤ 副作用：复审跑全量用例时仓库脚本往 `build/_icon_frames/` 写了 10 个未跟踪件；同一时间窗内还凭空出现一个 `website/`（92KB 官网 + 自带验收日志），两者都不是本次 M18 的产物，**均原样保留未删**（提交只用显式路径，未被带入）。 |
| 2026-09-15 | 实施 | M18 | 未开始 → 已完成 | 删掉 `build.mac`/`build.linux` 并在 manifest 与后端 README 声明仅支持 Windows；按复审实测重写 README 的因果（mac 打不出 vs linux 出得来跑不了，附两平台对照表）；新增 `src/backend/tests/platform-declaration.spec.ts` 8 条守卫（声明不漂回 + 声明与 `files`/`asarUnpack` 白名单不脱节）。**验收**：`npm run pack` ✓、`npm run dist` ✓（NSIS 212MB 重建）、`package:smoke` 22 项全绿（方法数 132 与源码一致）、typecheck 0、`check:shim` 一致、全量 62 文件 / 184 suite / 384 用例（375 通过 / 9 跳过 / 0 失败）；12 条变异矩阵全部符合预期。**未验证**：无 mac/linux 真机，linux 产物只查了原生模块有无、未尝试启动。 |
| 2026-09-15 | 实施 | 教训（M18） | — | ① **「声明不一致」的修法要先量三种失败形态**：同一个「跨平台声明」在本机对应「根本打不出」（mac）与「出得来但缺件」（linux）两种事实，我却把它们归成一个理由 —— 结论（Windows-only）碰巧没变，但**理由错了就是错的**，因为它会被后来者当依据。② **守卫的漏法要靠矩阵找，不是靠想**：我第一版 5 条断言里，2 条过拟合（大小写、字符窗口）、4 类漂移完全漏掉（脚本入口、arch、其它 workflow、打包白名单），全是复审用变异试出来的。③ **写守卫时最常见的自查题是「空转吗」**：收集函数对 `{ target: 'nsis', arch: ['x64'] }` 这种对象数组不下钻 ⇒ 收集出空数组 ⇒ 全部断言恒真；这类错必须靠「收集结果非空」的前置断言兜住。④ **别用 JSON 子串扫描做配置断言**：`onlyloadappfromasar` 里含 `mas`、`directories` 里含 `dir`，误报来自与语义无关的巧合。⑤ 计数口径要写清：后续条目里的「N 文件」实际一直是我那个解析脚本打的 `numTotalTestSuites`（文件 + describe 块），真实文件数是 62（本次核对 `testResults` 与磁盘 glob 一致）。 |
| 2026-09-15 | 实施 | 合计 | 77 项：未开始 41 / 进行中 3 / 已完成 33 | 阶段 5 完成 20（…/M8…M18）；下一步 M19（打包冗余与窗口图标：asar 45.9MB / 2877 条目，其中 `src/backend/deps` 1095 条、`src/**/*.ts` 536 条） |
| 2026-09-15 | 评审 | M19 | 独立复审（bash 可用但不在 PATH；无 critical + 2 major + 3 minor） | ① **验收两条都复现**：asar 与我报的 24,580,422 B / 1419 条逐字一致；并用自己的 `FileMatcher` 模拟规则复算出 deps 8.07MB/984、`src/**/*.ts` 4.49MB/537、ui-app 12.29MB/164、并集 1333/22.16MB。② **图标那一半它验得比我强**：用 `PrivateExtractIcons` 取出 exe 全部 7 帧（16→256），与 `build/icon.ico` 对应帧**逐像素完全相同**（mean|d|=max|d|=0）⇒ 不加 `build/` 正确；我那条「`new Icon(path,32,32)` 会得噪声图」的提醒也被复现。③ **major：我新加的 koffi 断言是空转的** —— `node_modules/koffi/**` 与 `@koromix/**` 都在 asarUnpack 里 ⇒ 全是解包条目，而解包条目照样被 `listPackage` 列出，故「entries 里有它」恒真。④ **major：假绿通道** —— `packaged-smoke.js` 的 asar 校验整块把异常吞成「跳过」，`@electron/asar` 一不可用则十几条断言静默消失而冒烟仍 ✅。⑤ 它还做了一条我没做的强验证：electron 内从 asar `require('.../app.asar/src/backend/wechat-host.js')` → `createWechatBackend` 成功、132 方法，koffi/zod/fzstd 均从 asar 内 node_modules 解析 ⇒「deps 树可排」被真跑证实。⑥ minor：`main.js` 的注释指向 RELEASE-PLAN 的 M19 而当时那行还是「未开始」（本次回写后成立）；残余死重 1.5MB **不建议**改 `src/` 白名单（会误排 `VENDORED-LICENSES.md` 与各 README，风险不对称）；另发现两条非本次引入的问题（已登记 N20、N21）。 |
| 2026-09-15 | 实施 | M19 | 未开始 → 已完成 | 先量后改：条目给了 2 条排除，我用 asar 头部模拟后发现第三条更大，一并做（deps 8.07MB + `.ts` 4.49MB + `ui-app` 12.29MB = 22.16MB/1333 条）。**实测 asar 45.93MB → 23.4MB、条目 2877 → 1419；安装器 −14.4MB（212,062,944 → 197,654,897 B）**。排除安全性：bundle 里对 `backend/deps` 路径引用数 0、打包产物里真加载 koffi 成功（kernel32 句柄 + GetTickCount）。**图标没按条目做**：打包目录确实没有 `build/`（路径不解析），但 exe 内嵌图标就是同一份 artwork ⇒ 不存在「打包版窗口无图标」，加进 `files` 只白带 83KB 且引入未验证路径；`main.js` 补注释说明。**守卫**：新增 10 条断言，并按复审修掉两处 —— koffi 那条从「entries 里有」改成「`app.asar.unpacked` 下磁盘上真有」（附实测证据：两条目都在列表里但 header 是 `unpacked:true/offset:undefined`）；asar 校验块的 `catch{打印跳过}` 改成记一条失败断言（A/B：移走 `node_modules/@electron/asar` → 冒烟 exit 1）。**验证**：pack ✓、dist ✓、package:smoke 31 项全绿、typecheck 0、184 suite / 384 用例（375/9/0）。 |
| 2026-09-15 | 实施 | 教训（M19） | — | ① **「先量再改」又一次找出比条目更大的靶子**：条目盯着 `deps`（8.07MB），实测最大的冗余是 `src/client/ui-app/**`（12.29MB，其中 `public/` 与 `ui-dist` 逐字节重复）。只按条目做会漏掉一半收益。② **我的新断言第一版就是空转的** —— 「`entries` 里有 `/node_modules/koffi/**`」看着很直接，但 asarUnpack 的条目同样出现在列表里（`unpacked:true / offset:undefined`）。**断言要直接测目标性质**（这里的目标是「真实文件在磁盘上，因为 `await import` 与 .node 只能读真实文件」），而不是测一个看起来等价、实际恒真的代理量。③ **静默跳过 = 假绿通道**：`catch { 打印一句「跳过」 }` 能让十几条打包断言整体消失而套件仍绿 —— 这与本会话反复修的是同一类问题（守卫能不能静默失效）。④ **取证工具本身也会错**：`System.Drawing` 的 `new Icon(path,32,32)` 解 PNG 压缩帧的 ICO 得到一张**噪声图**，我据此差点得出「exe 图标与 ico 不是同一张」的反结论 —— 反直觉的结果要换工具复核（这里换成按 ICO 结构取帧 + 复审用 Win32 API，两边一致）。⑤ 条目的**修法与因果都可能不成立**：icon 那半把「路径不解析」直接等同于「图标缺失」，我实测才知是两件事。 |
| 2026-09-15 | 实施 | N19、N20、N21 | 新增 | M19 取证与复审暴露：**N19**（`resources/win32/x64/wx_silk.exe` 不在 `asarUnpack` 而会被 `spawnSync` 执行 ⇒ 打包版语音 silk 解码与批量转写**坏掉**；复审实测同一 exe 磁盘路径 spawn 成功、asar 路径 ENOENT —— 属交付物功能缺陷，建议按高优先级处理）、**N20**（未调 `setAppUserModelId`，NSIS 快捷方式写的是 appId ⇒ 任务栏固定/分组可能双图标）、**N21**（`ui-dist` 被 gitignore 而 `pack`/`dist` 无前置 `build:ui` ⇒ 干净检出打出**没有前端**的包；排掉 `ui-app` 后已无第二份兜底）。 |
| 2026-09-15 | 实施 | 合计 | 80 项：未开始 43 / 进行中 3 / 已完成 34 | 阶段 5 条目 39 → 42（+N19/N20/N21）、完成 21（…/M8…M18、M19）。下一步：N19（打包版语音解码坏，priority 最高）。 |
| 2026-09-15 | 评审 | N19 | 独立复审（`7e44cf3`；无 critical + 若干 major） | ① **独立证实缺陷**：同一个 exe，磁盘路径 `spawnSync status=1`（真执行）、asar 路径 `error.code=ENOENT` ⇒ 打包版语音播放与批量转写确实坏掉（开发态正常）。② **major：我的接线守卫是源码字符串断言、可绕过** —— 把 `onDiskPath(candidate)` 留在**注释**里、底下仍用裸 `existsSync`，守卫照样绿。③ **major：`res.error` 没被用上** —— 失败时只报 `stderr || 「解码器退出码 null」`，而 exe 起不来时 `status` 为 null、`stderr` 为空 ⇒「缺二进制」与「音频损坏」在日志里长得一模一样。④ **major：临时 silk 从不删除**（本机 `decoded/voices` 下积压十余个）。⑤ 确认 `whisper.ts` / `sns-keystream.ts` 的路径解析早已走 unpacked 逻辑、不受本次改动影响。⑥ 系统性排查（问题单 A 项）另找出两条同族缺陷，登记为 **N20**、**N21**。 |
| 2026-09-15 | 实施 | N19 | 未开始 → 已完成（缺陷已修；复审反馈随后收口） | `asarUnpack` 加 `src/backend/wechat-data/resources/**`；新增共享模块 `src/backend/wechat-data/src/asar-path.ts` —— `unpackedAware` 从 `whisper.ts` **抽出来复用**（不是抄第二份），并新增 `onDiskPath(candidate, exists?)`；`silkDecoderBin()` 改走它。**抽的过程中顺手修掉原实现一个缺陷**：只找 `app.asar` 前缀，对已经是 `app.asar.unpacked` 的路径会二次改写成 `app.asar.unpacked/.unpacked/...`。**验收**：`asar-path.spec.ts` 8 项；`package:smoke` 新增「`app.asar.unpacked` 下有 wx_silk.exe」并全绿；手工执行解包后的 exe 得 `usage: wx_silk <sample_rate> <in.silk> <out.wav>`。**未验证**：真实微信语音端到端解码（需真实库 + whisper 模型）。 |
| 2026-09-15 | 实施 | N19 | 复审反馈四项收口（`3a387f2`；状态保持已完成） | ① **字符串守卫 → 行为级**：`silkDecoderBin(startDir?)` 新增可注入起点，用例按真实布局建临时目录直接断言返回值（覆盖 / 漏了 / 开发态 / 无解码器 / env 钉住，5 条）；② 失败原因改取 `res.error.message`；③ `silkToWav` 的临时 silk 加 `finally` 清理；④ `spawnSync` 加 120s 上界。**验收**：两个 spec 共 14 项全绿（`asar-path.spec` 8 → 12、新增 `voice-silk.spec` 2）；**三条变异 A/B 各自「先转红再还原」**；`package:smoke` **34 项 ✅ / 0 ❌**；全量 64 文件 / 190 suite / 398 用例（389 通过 / 9 跳过 / 0 失败）；typecheck 0；重建 bundle 与 `lib/types` 后 `git diff --exit-code` 0。**未验证**：120s 上界无用例覆盖、真实语音端到端、`silkToWav` 临时文件同进程并发同名（`<pid>_<len%100000>`）。 |
| 2026-09-15 | 实施 | 教训（N19） | — | ① **「路径存在」≠「路径可用」**：Electron 的 fs 补丁让 `existsSync` 对 asar 内路径也答真，但补丁**不覆盖 `child_process` 与写**。凡是要 spawn 或写的包内资源都必须同时满足「改写到 `app.asar.unpacked`」与「在 `asarUnpack` 里」，缺一即坏 —— 而且这类缺陷**开发态永远看不见**（`package:smoke` 这类真启动打包产物的脚本才抓得到）。② **源码字符串守卫是我反复栽的同一个坑**（M12 的 `toContain('f(')`、这次的 `toContain('onDiskPath(candidate)')`）：在注释里留个字符串就能骗过它。凡能写成行为断言的就不写字符串断言；两次落地的办法都是「给被测函数注入依赖 + 在临时目录里搭真实布局」（`onDiskPath` 的 `exists` 参数、`silkDecoderBin` 的 `startDir`）。③ **打包冒烟的「项数」口径此前几处不一致**（22/31/32/34，因为计数方式不同），本行起统一按输出里的 ✅ 行数计（本次 34）；项数不是验收标准，**❌ 为 0 才是**。④ 计数口径更正后对齐：M18 时真实 spec 文件数 62 → N19 加 `asar-path.spec` 得 63 → 本次加 `voice-silk.spec` 得 **64**，与 `testResults.length` 及磁盘 glob 一致（「文件数」以前一直误用 `numTotalTestSuites`，那是文件 + describe 块）。 |
| 2026-09-15 | 实施 | 合计 | 80 项：未开始 42 / 进行中 3 / 已完成 35 | 阶段 5 条目 42、完成 22（…/M8…M19、N19）。下一步：N21（干净检出 `npm run dist` 会打出没有前端的包 —— 属交付物风险）→ N20（任务栏 AppUserModelID）→ 阶段 5 剩余的 M/N 条目。 |
| 2026-09-15 | 实施 | N20 | 未开始 → 已完成 | 新增 `src/backend/app-id.js`（从 `package.json` 的 `build.appId` 派生，与 NSIS 快捷方式同源），`main.js` 在建窗前调 `app.setAppUserModelId(appId)`。**接线守卫第一版是空转的**：源码字符串正则把调用点注释掉仍 4 项全绿 → 改为 TypeScript AST 只认真实 `CallExpression`，注释掉/换字面量两种变异均转红。新增 `app-identity.spec.ts` 5 项 + `packaged-smoke` 两条断言。**打包态实测**：`npm run pack` 成功后 `npm run package:smoke` **35 项全绿 / 0 ❌**，其中「主进程已声明 AppUserModelID」与「AppUserModelID == build.appId」实到 `com.supertime.electron`。**未验证**：任务栏固定/分组的真实行为需真机人工操作。 |
| 2026-09-15 | 实施 | N6 | 未开始 → 已完成 | `migrateLegacyState` 不再原样复制 `config.json`：新增 `sanitizeMigratedConfig()` —— 顶层路径字段回落默认空值、镜像里剔除 `db_dir`+密钥+派生路径、保留普通设置，剔除内容进日志并要求**重新确认数据源**；另改为原子写 + 按「状态目录 × 老配置目录」记录已迁移。新增 `legacy-migration.spec.ts` 8 项（含逐字节断言目标文件无密钥、畸形容错、已有配置不被覆盖）。变异 A/B：退回原样复制 → 红。**半条验收未做**：`decrypted_dir` 指空时要求「显式确认」——数据源不再被携带后该路径已不可自动触发。 |
| 2026-09-15 | 实施 | H14 | 未开始 → 已完成 | ① 补根 `README.md`、`LICENSE`（MIT）、`CHANGELOG.md`（含「尚不具备公开发布条件」与其阻塞项）；② 新增 `docs/PRIVACY.md` —— 出网点按**代码实测**逐条重列（比条目原文多出 4 类：头像 / 聊天图片与朋友圈视频与公众号封面 / 地图 GeoJSON / whisper 下载；**模型列表实测不发请求**），并写明内存扫描的目的与范围、数据落盘位置与权限、如何关闭出网；③ 新增 `src/client/ui-app/privacy/consent.ts` + `PrivacyConsentGate.tsx` 并接进 `ui-entry.tsx`（引导与授权之后、主界面之前，未同意不放行；「重新查看启动页」连同意一起重置）；④ 新增 `scripts/gen-api-docs.js` → `docs/API.md`（132 个方法，`docs:api` / `docs:api:check` 进 CI），顺手修掉启动页上过期的「114」。**验收**：`npm test` 64 文件 / 424 通过 / 9 跳过 / 0 失败（新增 33 项）；`privacy-gate:smoke` 6 项；`docs:api:check` ok；typecheck 0；`build:ui` 822 modules；**`npm run pack` + `npm run package:smoke` 35 项全绿 / 0 ❌**（含 app-identity 两条）；六条既有冒烟全绿；**六组变异 A/B 全部被杀**。**未验证**：真人点击同意屏（无浏览器/组件测试环境）；`ui-acceptance.mjs` 越过同意屏的那步改动本机未执行。 |
| 2026-09-15 | 实施 | 教训（H14/N20/N6） | — | ① **源码字符串守卫第三次栽在同一个坑**（M12 的 `toContain('f(')`、N19 的 `toContain('onDiskPath(candidate)')`、本次 N20 的正则）：把调用点注释掉就能骗过它。这次的解法是把 TypeScript 编译器的 AST 拿来只认真实 `CallExpression` —— 比「剥注释」更稳（字符串、注释、嵌套对象里的同名文本都不算）。② **文档最危险的不是缺失而是过期**：条目原文的出网点清单（「LLM/embedding/模型列表三处」）既多算了一处（模型列表不发请求）又漏了四处。写声明的第一步应该是**照着代码枚举**，再用双向守卫（代码→文档、文档→代码）把它钉住，否则它必然随代码漂移。③ **「我们有没有暴露什么」这类问题要查消费方，不是查声明**：`cdn_enabled`/`api_port` 在类型、示例、设置页都齐全，看着像功能，实际全仓没有消费者 —— 界面上的开关比没有开关更容易误导用户（已登记 N24）。④ **本机全绿 ≠ CI 会绿**：`check:backend-restart` 依赖工作树里的 gitignored 私钥，本机有、CI 没有（已登记 N23）。凡是「用到了被 gitignore 的本地资产」的脚本都在这个风险面里。 |
| 2026-09-15 | 实施 | N23、N24 | 新增 | H14 实施中暴露：**N23**（CI 的 `check:backend-restart` 直接读被 gitignore 的 `vendor-keys/license-private.pem`，干净检出必失败 —— 本机全绿只是因为本机有那份私钥）；**N24**（`cdn_enabled` / `cdn_local_decrypt` / `api_enabled` / `api_port` / `api_token` 界面可见可存但**全仓无消费者**，属给用户造成「关掉就不出网」错觉的死开关；隐私声明里已如实写明）。 |
| 2026-09-15 | 实施 | 合计 | 83 项：未开始 41 / 进行中 3 / 已完成 39 | 阶段 2 完成 1（H14）、阶段 5 完成 2（N6/N20）并在工作流 F 新增 2 项（N23/N24）。**计数口径已重算**：此前几处「合计/阶段 5 条目数」与各阶段明细不一致（表头写 81/43，而逐阶段相加为 80/42），本行起以逐阶段相加为准（83 = 2+3+2+5+3+45+23）。本次实测汇总：`npm test` 64 文件 / 424 通过 / 9 跳过 / 0 失败、typecheck 0、`build:ui` 822 modules、`pack` + `package:smoke` **35 项 ✅ / 0 ❌**、`privacy-gate:smoke` 6 项、`ui:smoke` 21 项、`rag:check` 20 项、`check:sns-video` 18 项、`check:whisper-paths` 11 项、`license-gate:smoke`、`check:knowledge-graph`、`check:shim` 全绿；六组变异 A/B 全部被杀死且文件按字节还原。下一步建议：N23（CI 端口缺陷）→ N24（死开关：让开关生效或撤下）→ 阶段 5 剩余的 M/N 条目（M3 的 xlsx 流式、M21 大文件拆分、N8/N10/N11/N12 索引侧遗留、M22 文档与代码不一致）。 |
| 2026-09-15 | 实施 | N23 | 未开始 → 已完成 | 先读断言再动手：`check:backend-restart` 的六项全是进程生命周期，**不需要业务调用**，所以「签一张许可证」是多余依赖 —— 而它需要被 gitignore 的签发私钥，使这一步在干净检出/CI 上必然 ENOENT。直接删掉 `seedLicense()`（比临时改写 `public-key.js` 更干净：那正是 L4 登记的「中断即污染仓库」）。**验收**：① 复现 —— 移走 `vendor-keys/` 跑改前版本 → `ENOENT` exit 1；② 同条件跑改后版本 → **6/6 通过 exit 0**（真实 Electron + taskkill）；③ 恢复后复跑 6/6。**新增守卫** `ci-script-isolation.spec.ts` 6 项：解析 CI 全部 `run:`（含多行块）→ 展开 `npm run` 链 → 取脚本文件，用 **AST 字符串字面量**断言不出现 `vendor-keys` / 仓库 `wechat/llm.json`、`wechat/config.json`；并断言 CI 里每个 `npm run` 都真实存在、扫到的集合非空、以及这些资产确实被 gitignore。全量 `npm test` **65 文件 / 430 通过 / 9 跳过 / 0 失败**。|
| 2026-09-15 | 实施 | 教训（N23） | — | ① **先读断言，再挑修法**：条目给的两条路（临时造密钥 / 从 CI 摘掉）都默认了「这一步需要许可证」，而实际断言一行都没用到业务方法 —— 删掉依赖比给它配钥匙好。挑修法前先问「这条路径真的需要它吗」。② **本机全绿 ≠ CI 会绿**（承接 H14 的第 ④ 条教训，这次把它变成守卫）：凡是读「被 gitignore 的本机资产」的 CI 步骤都有一模一样的缺口，现在由 `ci-script-isolation.spec.ts` 统一钉住 —— 这类缺口只有静态守卫能发现，因为本地跑永远不会失败。③ **守卫自己的判据也要防误报**：第一版按原始文本 includes 匹配，结果被**我自己刚写的解释性注释**触红（注释里提到了那个路径）。改用 AST 只取字符串字面量后，注释不算、真实依赖必中 —— 这已经是本轮第四次用到「判定要看真的用到了，不是字面上出现过」。④ 用 PowerShell 做可逆 A/B 时要注意**编码**：`Get-Content -Raw` / `Set-Content` 不带 `-Encoding UTF8` 会把含中文的 UTF-8 文件往返成乱码，进而让变异实验的结果不可信（本次先得到一次假绿，加上 `-Encoding UTF8` 后才复现预期行为）。 |
| 2026-09-15 | 实施 | N24 | 未开始 → 已完成（经用户确认：CDN 开关真生效 + api_* 撤下界面） | ① 新增 `query/cdn-policy.ts` 作为两个开关口径的唯一出处；② 表情原图 / 公众号封面 / 朋友圈视频与封面 / 导出视频四处远端取回全部接线，**关闭时在发请求之前返回**，且「开关关掉」与「真解不开」给两种不同提示；③ 网关新增 `cdnSwitches()`（读配置失败不拦，沿用默认开启）并在 5 个调用点传参；④ 关掉开关不影响已有缓存；⑤ `Settings.tsx` 撤下 `api_enabled`/`api_port`/`api_token` 三个无服务端的控件（字段与类型本期不动）。**验收**：`cdn-switch.spec.ts` 12 项（打桩 fetch 计数：关闭时四类入口调用次数为 0）+ `settings-switch-wiring.spec.ts` 5 项（AST 断言调用点实参、`cdnSwitches` 方法体读键、界面保留 CDN 开关且不再出现 api_*）；**两向变异 A/B** 均转红并逐字节还原。**守卫第一版误报**：前端用属性访问/属性赋值名读写配置，只看字符串字面量会把「有这个开关」判成没有。**未验证**：真实数据下端到端观感；渲染层按消息地址直连的图片与头像不受该开关控制（已在隐私声明写明）。 |
| 2026-09-15 | 实施 | 教训（N24） | — | ① **「死开关」是隐私声明里最难自查的谎**：`cdn_enabled` 在类型、默认值、示例配置、设置页、gateway 快照里都齐全，看上去像已完成的功能，唯一的问题是**没有任何代码在取图时读它**。判据只能是「有没有消费者」，不能看声明面有多完整。② **让开关生效要在「发请求之前」判**，不能「发了再失败」：后者既违背开关的承诺（照样出网），也让「有没有出网」不可判定 —— 用例因此把判据定成 `fetch` 调用次数为 0。③ **错误提示要区分病因**：同一份加密流，「用户选了服务端解密」与「真的解不开」必须给不同的话，否则用户按提示排查会查错方向（N19 的 `res.error` 是同一课）。④ **接线守卫的抽取器要覆盖该语言的真实写法**：前端读 `cachedCfg?.x`（属性访问）、写 `x: v`（属性赋值名），只看字符串字面量必然误报；这类守卫的「防空转/防误报」要一起设计（本轮两种都踩了一次）。⑤ 撤下界面控件时**要区分「删界面」与「删数据」**：后端字段还在、旧配置还能读，属于刻意收窄范围（删字段要连带重建 bundle/types 并处理兼容），守卫里专门钉了这条。 |
| 2026-09-15 | 实施 | 合计 | 83 项：未开始 39 / 进行中 3 / 已完成 41 | 本轮完成 N23、N24（阶段 5 完成数 27）。实测汇总：`npm test` **67 文件 / 447 通过 / 9 跳过 / 0 失败**、typecheck 0、`build:ui` 822 modules、bundle 重建幂等、`docs:api:check` ok、`pack` + `package:smoke` **35 项 ✅ / 0 ❌**、`check:sns-video` 18 项、`rag:check` 20 项、`ui:smoke` 21 项、`privacy-gate:smoke` 6 项、`check:whisper-paths` 11 项、`check:shim`/`license-gate:smoke`/`check:knowledge-graph` 全绿；三组变异 A/B 全部转红并逐字节还原。 |
| 2026-09-15 | 实施 | N10 | 未开始 → 已完成 | 两阶段改造（先算后写，事务段内 0 await）+ `DELETE` 挪进事务 + 按 DB 路径键控的单飞闸（force 排队重做）；顺带取消「每 512 行让出一次」（在事务里让出只会把写锁持得更久）。**7 项用例** + **关键对照实验**：换回 HEAD 的改前实现跑同一套用例，五条判据全红且逐字复现 `Error: database is locked`。**量化**：阶段二同步突发在 4 万行时阻塞 32.3ms（0.8 万行 11.1ms）。全量 `npm test` **68 文件 / 454 通过 / 9 跳过 / 0 失败**；bundle 与 `lib/types` 同步重建。**未做**：N8（同函数内的 `.all()` 物化）仍待办。 |
| 2026-09-15 | 实施 | 教训（N10） | — | ① **对照实验要换「改前实现」，不是自己臆造的变异**：我先把 `BEGIN` 挪到网络阶段之前，结果行为判据照绿 —— 因为改前实现是**在事务里发请求并边写**，而「只开了 BEGIN 还没写」在 SQLite 里仍是 DEFERRED、不持写锁。换成 `git show HEAD:<file>` 把真代码换回来，判据立刻逐字复现症状。**变异实验要复现原缺陷的机制，不是它的形状**。② **N10 与 N9/N12 是同一模式的三种表象**：「同步封装 + 改成 async」之后，写事务/长循环跨 macrotask 就会与同进程的其它访问撞上；H9 用单飞闸 + 事务内不放 await，这里把同一套办法复用到向量库（键同样取**资源路径**）。③ **让出事件循环在事务里是反效果**：让出会让别的 JS 跑，但写锁还在这条连接手上 —— 于是「更友好」的让出反而延长了锁的持有时间。正确做法是把同步段做短、把网络段移出事务。④ 判据要写在**外部可观测面**上（另一条连接能不能提交写事务），而不是「代码里有没有那个关键字」；后者只能作为补充守卫（本轮两者都有，且对照实验证明前者才真正区分新旧）。 |
| 2026-09-15 | 实施 | 合计 | 83 项：未开始 38 / 进行中 3 / 已完成 42 | 本轮完成 N23、N24、N10（阶段 5 完成数 28）。实测汇总：`npm test` **68 文件 / 454 通过 / 9 跳过 / 0 失败**、typecheck 0、`build:ui` 822 modules、bundle 与 `lib/types` 重建幂等、`docs:api:check` ok、`pack` + `package:smoke` **35 项 ✅ / 0 ❌**、`check:sns-video` 18 项、`rag:check` 20 项、`ui:smoke` 21 项、`privacy-gate:smoke` 6 项、`check:whisper-paths` 11 项、`check:shim`/`license-gate:smoke`/`check:knowledge-graph` 全绿；四组变异/对照实验（含换回 HEAD 实现）全部转红并逐字节还原。下一步候选：**N8**（同族 `.all()` 物化，清单已列在条目里）、**N11/N12**（bootstrap 跳过 `-wal`、索引库第二个写者不在闸内）、**M3**（导出 xlsx 未流式、无取消/进度）、**M22**（文档与代码不一致）、**M21**（大文件拆分）。 |
| 2026-09-15 | 实施 | N8 | 未开始 → 已完成（第 2 条验收未达标，已如实登记） | ① 核心：`embedding.ts` 的 `message_meta` 全表 `.all()` 改游标 + 读到 cap 就 break，并让每行不再携带长文本（文本只作分组键存一份）；`done` 集合读 `vectors` 同样改游标。② 同族 10 处逐个评估：**7 处随消息量增长的改游标**（`group-insights`/`asset-insights`/`privacy`/`moments-insights`×2/`overview-insights`/`overview`），其中 `privacy` 的 `rowBudget` 改前只限制「处理量」不限制「读取量」；**5 处有界或有意的在代码里注明理由**（会话/联系人量级、提醒清单、用户笔记待办、粗筛表要的产物就是数组）。**量化（20 万行 × 478 字符、上限 4 万）**：改前 RSS **+340MB** → 改后 **+103MB**，两次结果完全一致（rows/embedded/embed_calls 逐项相同）；上限改 4000 时仅 **+4MB**（残余随窗口而非语料缩放）。**验收**：8 项新用例（oracle 差分、cap 语义含非法值归一的有意分叉、增量不重算、源码守卫「构建函数体内不得有 `.all()`」；另补 `queryPrivacyScan`/`queryOverviewInsights` 原先零覆盖的行为断言），两处「游标读不到任何行」的变异均转红并逐字节还原。全量 `npm test` **70 文件 / 462 通过 / 10 跳过 / 0 失败**。 |
| 2026-09-15 | 实施 | 教训（N8） | — | ① **「改成游标」要同时问「读多少」与「留多少」**：把 `.all()` 换成 `iterate()` 只解决了「读多少」；`pending` 窗口（分组键 + 行元组 + 向量）仍随 `maxDocsPerBuild` 线性，所以这次同时在**行结构**上减了负（把每行的文本换成标量元组）。② **预算/上限常常只作用在循环体内**：`privacy` 的 `rowBudget` 改前是先物化全表再 break —— 这类「有上限但上限不约束读取」的写法，只能靠体检「物化点在上限之前」发现（H9 在搜索路径上已经踩过一次）。③ **清单式条目的价值在于逐条判定，不在于逐条改**：10 处里只有 7 处该改，另 5 处（会话/联系人量级、粗筛表）改了对内存没意义甚至有害 —— 判据是「行数是否随消息量增长」+「产物是不是就是这个数组」，并把结论**写在代码旁边**（否则下一轮体检会重新怀疑它们）。④ **对照实验要用真代码**（承接 N10 的教训）：这次三组对照里最有力的一条是「换回 HEAD 实现跑同一脚本」，两次结果逐项相同才敢说「命中集合不变」。⑤ **验收没达标就写没达标**：条目原文要求「RSS 降到与单批 embedding 数同阶」，实际只做到「由窗口而非语料决定」，把差距与原因（与 N10 的单事务写入冲突）写进条目，而不是把口径改宽后勾上。 |
| 2026-09-15 | 实施 | 合计 | 83 项：未开始 37 / 进行中 3 / 已完成 43 | 本轮完成 N23、N24、N10、N8（阶段 5 完成数 29）。实测汇总：`npm test` **70 文件 / 462 通过 / 10 跳过 / 0 失败**、typecheck 0、bundle 与 `lib/types` 重建、`rag:check` 20 项、`ui:smoke` 21 项、`privacy-gate:smoke` 6 项、`check:sns-video` 18 项、`check:knowledge-graph` 全绿；两组对照实验（换回 HEAD 实现 + 两处游标变异）全部转红并逐字节还原。下一步候选：**N11**（bootstrap 只拷主库、跳过 `-wal` → 静默回退一代）、**N12**（索引库第二个写者不在单飞闸内）、**M3**（导出 xlsx 未流式、无取消/进度）、**M22**（文档与代码不一致）、**M21**（大文件拆分）、**N9**（搜索不可中断，需 AbortSignal 贯通）。 |
| 2026-09-15 | 实施 | WS1（N11+N12） | 未开始 → 已完成（N12 口径收窄） | `dirs.ts` 的 bootstrap 改为「主库 + `-wal`」（`-shm` 永不拷），成员索引写统一走 `search.ts` 新导出的 `withIndexWrite()` 闸、拿不到闸则显式走 LIKE 并留痕。**9 项用例**；变异还原「只拷主库」→ 逐字复现条目症状（读回 `{rows:3000, builtAt:2026-01-01}`）。**口径收窄（实测）**：`CREATE … IF NOT EXISTS` 在表已存在时是纯读，退化窗口只是「表未建成 + 构建在飞」。 |
| 2026-09-15 | 实施 | WS2（N13+N16） | 未开始 → 已完成（N13）/ 进行中（N16） | N13：4 个出网点改走 `fetchWithRetry`，`llm-retry.js` 支持**逐次**超时（否则第一次超时后就不再重试），whisper 加 `Range` 断点续传（416/长度校验），接线守卫扩成显式文件清单；13+87 项用例、6 条变异转红；**顺带修掉**「旧 whisper 模型下载把截断流 rename 成正式模型」。N16：批量 `IN (...)` 入口 + `entries` 按族限界已落地（30 张图 454ms → 20.4ms），**但批量入口未接网关（需新 RPC）**。 |
| 2026-09-15 | 实施 | WS3（N14+N15） | 未开始 → 已完成 | N14：`vectorIndexStatus` 改指纹缓存 + `meta.rows` 同事务写入，**一次提问 6.32ms → 0.04ms（151×）**、连接 3→≤1、COUNT 3→0（10 项用例，含 9 种库形态的 oracle 差分）。N15：到期摘要任务改有界并发（2），**5 项 708ms → 423ms**；**顺带修掉既有真缺陷**：调度器 `lastRunAt` 为 NULL 时 `NaN > 60000 === false`，从未手动运行过的任务永不触发（→ N25）。 |
| 2026-09-15 | 实施 | WS4（前端一批） | N17 进行中，其余 → 已完成 | N17 前端闸门（`ask-gate`）完成；L6/L7/L8/L9/L10/L11/L13/L14/L20 落地：L10 的条目诊断被实测推翻（V8 `slice` 是 O(1) 视图，真平方项是每块一次**落空**的 `indexOf`）→ 2.9MB/2 万块 **12.97s → 2.88ms** 且输出逐字节相同；L14 实测=已实现（仅补契约用例）；L20 只抽公共实现、**0 处迁移**（调用点全在写集外，改法已写进注释）。55 项新用例、6 条守卫 A/B 转红。 |
| 2026-09-15 | 实施 | WS5（工程化） | L1/L2/L4/L5/L12/L19/N3/N4 → 已完成；N22 → 已完成 | N22：新增 `scripts/package-content-rules.js`（`src/**` 白名单 + 体积预算）+ 冒烟两条断言，放 1MB `.bak` 后冒烟 **exit 1**（M19 黑名单照旧全绿＝正是盲区）。L4：测试脚本不再改写仓库里的 `public-key.js`（注入 require 缓存）。**两条前提被实测推翻**：playwright 1.63.0 无 postinstall（`npm ci` 不会拉浏览器，约 18MB 而非 300MB）；whisper README 的「exe 已删」未复现（真正过期的是默认模型目录）。 |
| 2026-09-15 | 实施 | WS6（M24） | 未开始 → 已完成 | 配置读取下沉到 `src/config/`（原子写+损坏留痕、secrets.json 真源、账号发现、路径解析），DB 密钥校验移到 `keys/db-key-verify.ts`，`query/config.ts` 变纯转发门面；依赖方向变单向 `config ← keys ← query`。**搬移逐字不变**由「剥注释后 496/496 行都在新集合」独立证明；新增 `layer-direction.spec.ts` 6 项守卫。 |
| 2026-09-15 | 实施 | 收口（主智能体） | — | 一次性重建 `lib/index.js`（837.1 KB）与 `lib/types`；**全量 `npm test` 90 文件 / 594 通过 / 12 跳过 / 0 失败**（本轮并行新增 132 项用例）；typecheck 0、bundle 重建幂等、`docs:api:check` ok；`pack` + `package:smoke` **全绿**（132 方法、N22 预算 22.95MB/30MB、AppUserModelID 就位）；9 条冒烟脚本全过。另修掉并行改动的两处交叉回归：我的 `settings-switch-wiring.spec.ts` 因 M24 搬家而红（改为按实际位置找默认值）、`privacy-statement.spec.ts` 因 N13 改走 `fetchWithRetry` 而红（判据放宽为「有出网调用」）；并替 WS5 收尾 L2 的最后一个死文件（唯一引用在我负责的文档里）。 |
| 2026-09-15 | 实施 | 教训（本轮并行） | — | ① **多智能体并行必须先划文件写集**：本轮 6 条工作流按「文件不重叠」分区，只出现两处**交叉回归**（M24 搬走配置默认值让 N24 的用例红、N13 换掉 `fetch` 让隐私声明的守卫红），都由主智能体收口修掉——反面教训是**共享文件（gateway.ts/package.json/docs）只能有一个写者**。② **判据要写在不随重构漂移的锚点上**：我那两条用例都钉在「某个文件的具体内容」上，重构一动就红；正确做法是钉「可执行/可观测的事实」（如 N22 的「放个 .bak 就转红」）。③ **条目原文的前提必须实测**：本轮至少 5 条被推翻或收窄（L5 的 300MB、L2 的「无任何引用」、L10 的 O(k·n)、N12 的定级、whisper README 的 exe）——引用式条目的诊断不等于事实。④ **并行会放大噪声**：目录级跑测时失败集合每轮都在变（别人正在写），团队里要按「目标 spec + import 清单」判断归属，不要用全量红绿当信号。⑤ **别用 PowerShell 改仓库源码**：`Set-Content` 按控制台编码写盘，会把 UTF-8 的中文与破折号写坏（WS6 实测踩到，按 HEAD blob 逐字节还原）；变异实验也必须走编辑工具。 |
| 2026-09-15 | 实施 | 合计 | 86 项：未开始 8 / 进行中 5 / 已完成 73 | 本轮并行完成 32 条（含 3 条新登记：N25 已随 N15 修掉、N26/N27 未开始）。**未开始剩**：H13（法务）、M21、N1、N2、N9、N18、N26、N27。**进行中**：H1（人工轮换+历史重写）、M3（xlsx 流式/取消进度）、N16（批量入口未接网关）、N17（host 无单飞）、L20（公共实现未迁移调用点）。 |
| 2026-09-15 | 实施 | W1A（M3） | 进行中 → 已完成（含未达标） | xlsx 改**条目级流式**（`ZipFileWriter.addStream`：分块流式 deflate → 临时文件 → 真实 CRC 写本地头，格式不变）+ 共享 `StreamWriter`（背压/错误传播，ZIP 与 `.wcb` 共用）+ 进度/取消 + 备份「临时目录→rename、部分失败上报」。**10 万行 RSS +26.5MB vs 对照 +221.6MB（8.4×）**；取消后零残留；30 项用例 + 4 组变异。**未达标**：进度事件的渲染层中继未接、面板进度 UI 未做。**顺带修**：`.wcb` 旧实现不看 `write` 返回值 + 错误监听挂太晚。 |
| 2026-09-15 | 实施 | W1B（N2+N26） | N2 → 已完成；N26 → 进行中（病因更正） | N2：新增 `debug-gates.js`（`skipGates` 要求环变量显式 `1` **且** `app.isPackaged === false`，判定留在主进程、渲染层二次校验），`ui-acceptance.mjs` 改用该开关并删掉伪造隐私同意；10 项用例 + AST 守卫 + 4 组变异。**N26 条目病因经实测更正**：`close()` 会 finalize 语句，`EPERM` 只由「有连接没关」引起、**退避重试无效**；新增 `helpers/temp-db.ts` 连接登记册，迁 2 个 spec（`%TEMP%` 新增从 1/跑 → 0），**剩 37 个**未迁。 |
| 2026-09-15 | 实施 | W1C（L20+N1） | L20 → 已完成；N1 → 已完成（前端部分面板） | L20：13 处先迁 + 收口批把 `Settings.tsx` 那处也迁掉，**共 14 处/11 面板**统一到 `useTransientNotice`，并新增 `hold()` 保住「失败类常驻」语义；守卫 33 项 + 变异。N1：三个 store 显式建父目录 + `readError` 可区分，前端 `api.ts` 透传、`Tasks.tsx` 区分显示且失败不写渲染缓存；7 项用例 + 5 组变异；**顺带修正** `notes.ts` 裸 mkdir 导致的病因错位。 |
| 2026-09-15 | 实施 | W2（gateway 接线） | M3/N16/N27 接线完成 | ① M3：导出入口收 `jobId` 透传 `StreamControl`，新增 `cancelExportJob`/`getExportProgress` + `wechat-export/progress` 推送；`exportSessionMessages` 改 async 走流式。② N16：新增 `getImageDataUrlsBatch`/`warmDecodedImages`，`api.ts` 用**微任务窗口合并**让面板零改动吃到批量（**30 张图只查 1 次库**）。③ N27：`submitAskFeedback` 加「内容键 + 10s 时间窗」去重（**同步 `@Remote` 上「在飞合并」是假闸**）。6 个新 spec + 6 组变异；相关 32 文件/250 项全绿。**未达标**：进度未端到端、面板进度 UI 未做；N16 只合并路径表查询；`DailySummary`/`Graph` 的 `readError` 未区分显示。 |
| 2026-09-15 | 实施 | M21 | 未开始 → 进行中（api.ts 切片） | 缓存层拆成 `cache.ts`(197 行) / `media-cache.ts`(114 行)，api.ts 保留转发（41 处引用零改动），**2072 → 1807 行**；新增 `api-module-split.spec.ts` 4 项。**其余边界与「单文件上限」的整体验收远未达标**。 |
| 2026-09-15 | 实施 | 收口（主智能体） | — | 重生成 `docs/API.md`（**135** 个方法）并重建 `lib/index.js`（860.1 KB）/`lib/types`（新增 3 个 `@Remote` 与一个推送事件）；**全量 `npm test` 104 文件 / 734 通过 / 14 跳过 / 0 失败**（本轮两批并行新增 140 项用例）；typecheck 0、bundle 幂等、`docs:api:check` ok；`pack` + `package:smoke` 全绿（方法数 135、N22 预算 25.05MB/30MB）；10 条冒烟全过。顺手把 `src/client/README.md` 的方法数从 132 改成 135。 |
| 2026-09-15 | 实施 | 教训（并行批 2） | — | ① **同一个文件不能派给两个智能体**：本批 `gateway.ts` 是热点（M3 取消/进度、N16 批量、N27 去重、N9 可中断都要它），因此先跑「不碰它」的三条，再把它集中给一个智能体 —— 零冲突。② **条目给的文件清单会漏**：M3 的接线必须动 `types.ts`（推送事件要在 typert 事件表里声明）、N16 的批量入口必须动 `api.ts`，都在原写集之外；派活时要说清「按接口需要可小改共享文件，但报告里点名」。③ **新增 `@Remote` 会连带三件事**：`docs:api:check` 失败、`lib/index.js` 与 `lib/types`（含 typert host 事件描述符）必须重建、前端镜像 `WechatRemote` 与 `remote-contract` 要同步 —— 收口顺序就是 docs → bundle → types → 全量验证。④ **「同步方法上的单飞闸」是假闸**：`@Remote` 同步函数体不会交错，只能用内容键 + 时间窗去重（N27）。⑤ **门控内存实测必须独立进程**：同文件先跑别的用例会抬高 RSS 基线（第一版测出「+0.0MB」即此因）。⑥ **条目诊断本身要实测复核**：本批又更正两条（N26 的病因、L10 的「V8 `slice` 是 O(k·n)」）。 |
| 2026-09-15 | 实施 | 合计 | 86 项：未开始 3 / 进行中 3 / 已完成 80 | **未开始**：H13（法务）、N9（搜索可中断，需 AbortSignal 贯通同步 RPC 与客户端契约）、N18（变高虚拟化，需浏览器验证手段）。**进行中**：H1（人工轮换密钥 + 重写历史）、M21（大文件拆分，仅完成 api.ts 一片）、N26（夹具迁移剩 37 个 spec）。 |
| 2026-09-17 | 实施 | 检索参数固化（面板下线） | 新增 | 用户诉求：检索参数全部设置好并生效、面板从界面上移除，「默认配置开箱即用、不暴露需要用户手动调整的配置项」。① 后端 `query/retrieval/config.ts` 的**内置默认值本就已是产品最优值**，未改；② 删除「检索设置（RAG）」面板（`RetrievalPanel.tsx`）与 Ask 页的「检索」chip / 侧开布局 / Esc 外点关闭，`retrieval.module.css` 135 → 56 行、`ask.module.css` 852 → 806 行（只删面板专用类，保留 Ask 仍在用的漏斗行与反馈样式）；③ 稠密索引**无需手动构建** —— `askWechat` 本就有「未就绪则懒构建」的兜底，`ui:accept` 步骤 4 由「点按钮建索引」改为「向量库为空 → 仅提一次问 → 自动入库」；④ 修掉 §16.1 步骤 3 留下的磁盘残留 `fusion.k=37` → 60，并给验收脚本加「只写文档默认值」约束；⑤ `retrieval.spec.ts` 补一组**默认值契约用例**把 RAG 文档 §11 参数表逐项钉死。 |
| 2026-09-17 | 实施 | 教训（检索参数固化） | — | ① **「界面上不出现」要用源码事实去守，不能用渲染断言**：渲染断言只在面板被挂回来且默认展开时才红，把默认态改成 `open=false` 就能骗过 —— 所以守卫改成断言「文件已删 / Ask 里不再有入口标识符 / 界面源码不再调用 6 个 `api*Retrieval*`」，并加了防空转断言（扫到的源码文件数 > 30）；② **删一处 UI 前先确认它是不是链路必需**：面板上的「增量构建向量索引」看着像关键动作，实际网关在首次提问时本就有懒构建兜底 —— 不先确认就会误判为「删了会退化」；③ **Dual-purpose 的样式文件要按「谁还在用」反查**：`retrieval.module.css` 同时装着面板样式与 Ask.tsx 的漏斗行/反馈样式，整文件删除会连带把正常功能搞坏；④ **测试的还原逻辑也可能留下真实副作用**：`ui:accept` 步骤 3 把 `fusion.k` 填成 37 后，还原只覆盖了整文件备份路径、没覆盖该字段 ⇒ 本机盘上长期是 37。凡是往**真实用户配置**里写测试值的用例，都必须写「等于默认值」或做强制还原，否则残留值是无声的；⑤ 注释也是契约：`gateway.ts` 的 JSDoc 会生成 `docs/API.md`，所以「前端面板改一个开关也走这里」这种描述必须同步改，否则自动生成出来的文档会继续宣称一个已不存在的入口。 |
| 2026-09-17 | 实施 | 合计 | 几何不变：本次为产品决策 + 清理，未新增/结清条目 | 实测：`typecheck` 前后端 exit 0；`npm test` **159 文件 / 1388 通过 / 14 跳过 / 2 失败** —— 两处失败均**与本轮改动无关**（`src/backend/tests/update.spec.ts` 断言 `Settings.tsx` 含 `activeKey !== 'update'`，而该文件从未被本轮触碰；`src/backend/tests/temp-db.spec.ts` 期望 `EPERM` 实测 `EBUSY`，属 Windows 文件句柄时序），已单独记录待办；`rag:check` 20 项 ✅、`ui:smoke` 35 项 ✅（含 3 条新闸门）、`check:wx-tokens` ✅、`check:shim` ✅、`docs:api:check` ✅。`ui:accept` 已按新形态改写完毕（语法校验通过），可在关闭运行实例后实跑。 |
| 2026-09-18 | 修复 | **构建回归：CSS 注释提前闭合** | 自查发现 → 已修复 | 现象：`dev-run.py` 拉起失败，`build:ui` exit=1，`vite build` 报 `[vite:css] [postcss] postcss-modules-local-by-default: retrieval.module.css:4:23: Unexpected '/'`。根因：上一轮裁剪该文件时在**注释正文**里罗列面板类名，末项写成 `.btn*/` —— 那个 `*/` **提前闭合了注释**，余下的 `.msg*/.report/…` 成了非法 CSS。修复：注释改用 ` / ` 分隔重写，并补一句「本注释内不得出现星号与斜杠相邻的字符组合」。**这是本轮自己造出来的回归，不是既有缺陷。** |
| 2026-09-18 | 修复 | **校验套件漏掉 build（套件本身的洞）** | 已修复 | 上述 CSS 语法错误**骗过了全套静态检查**：`typecheck:client/:server`（CSS 不进 tsc）、`ui:smoke` 35 项（jsdom SSR，CSS Modules 被忽略）、`rag:check` 20 项、`check:wx-tokens`、`check:shim`、`docs:api:check` **全绿**。原因是 `working/run-check.py` 的 `build:ui` **只映射到 `sync-ui-shim.js`、压根没跑 vite**。修复：`TASKS` 的值由「单条命令」改为**命令序列**，`build:ui` 现在等价于 `package.json` 里的两步（`sync-ui-shim.js` + `vite build`），并补 `CODEBUDDY_SAFE_DELETE_ENABLED=0`。 |
| 2026-09-18 | 验证 | 运行时验收（CDP 直连真实渲染窗口） | 全绿 | 静态断言只能证明「源码里没有」，故补运行期一环（`working/cdp-panel.mjs`）：`section[aria-label="检索设置"]`=**0**、「检索」入口按钮精确文案计数=**0**、11 条面板文案在 `body.innerText` 里**一条不剩**、`[data-side-open]`=**0**；**对照组**（防「页面崩了所以没面板」）：问答页标题在、`[aria-label="微信问答问题"]`=1、「✨优化提问」在、`275 个会话可检索` 徽标在；**产物逐字搜**：把 1 个 script（1.63 MB）拉下来搜 13 个禁用串（含 `RetrievalPanel` / `apiSaveRetrievalConfig` / `apiBuildRagVectorIndex`）→ **ghostHits=[]**。 |
| 2026-09-18 | 实施 | 教训（本轮） | — | ① **`build` 不是可选检查项**：CSS Modules 的语法错误**只在 postcss 阶段**暴露，而 `ui:smoke` 是 jsdom SSR、**对 CSS 完全无感** ⇒「typecheck + 冒烟全绿」**推不出**「能构建」。校验套件里没有 build 就等于没有护栏。② **注释里罗列类名/通配符是高危写法**：`*/`、`/*` 会就地改变语法边界，而写的时候看上去只是普通文本。③ **探针的匹配式错了会伪装成产品缺陷**：本轮 ③ 里「优化提问」写成精确相等，而真实文案是 `✨优化提问` → 量到 0。按钮/文案一律用 `includes`；**探针本身也要当代码审**。④ **改写过的验收脚本必须实跑**：`ui:accept` 上一轮改完只做了语法校验，未执行 = 未验收。⑤ 会话注入的 `current_time`（Sep 17 21:01）与本机时钟（Sep 18 00:48）会不一致，**日志落哪个日期文件要按机器时钟判**（`stat().st_mtime` + `datetime.now()`），别照抄注入值。 |
| 2026-09-18 | 修复 | **ui:accept 步骤 11 的量法缺陷（滚到底差 55px）** | 已修复 | 现象：`✗ 确实滚到了底部 [6749/6803]`、`✗ 滚到底高亮落到最后一节 [原图链路自检…]`。在**运行中的真实窗口**上用 CDP 逐帧采样（`working/cdp-1112.mjs`）定位：右区里有几节是异步自检（原图链路自检 / 数据库健康），滚到底之后它们才把结果渲染进来 —— `scrollHeight 7033 → 7088`（+55），`scrollTop` 停在旧最大值 6368、新的是 6423（差 55 即断言失败量）；再滚一次即到底，高亮也正确落到「高级设置」。⇒ 根因是**量法没跟上异步渲染**，不是产品缺陷。修复：滚到底 → 等 `scrollHeight` 稳定 → 再滚一次 → 才断言（循环上限 15 次）。 |
| 2026-09-18 | 修复 | **ui:accept 步骤 12 的尺寸前提（一屏 vs 预期降级）** | 已修复 | 现象：`✗ 一屏无滚动条 [714 vs 655]`、`✗ 没有卡片越出可视区 [年度口头禅,还有这些人]`。CDP 实测（`working/cdp-annual-probe.mjs` / `working/cdp-annual-size.mjs`）：1440×900 下面板只有 684px，组件**按设计主动退化**成 `data-compact`（瀑布流 + 滚动；14 张卡 `clip` 全为 0，即一张都没被裁）；窗口切到设计基准尺寸 1664×1066（面板 850）后 `scroll=850=client`、无越界、无裁切、14 张卡 —— 全部成立。修复：该步骤先在基准尺寸上验「一屏」，再切回 1440×900 验「退化也不许藏内容」（新增 2 条断言）；换尺寸走 `resizeWin()` 并**确认真的换成了**（`innerWidth/innerHeight` 不符即抛错，不留静默降级）。 |
| 2026-09-18 | 验证 | **ui:accept 首次全绿：14/14 步骤 · 185/185 断言 · exit 0** | 全绿 | 前两轮分别 7/14（5 步因「后端异步启动没等就绪 ⇒ 夹具静默跳过、拿真实配置跑完全程」）与 12/14（步骤 11/12）。本轮 202.5s：步骤 2/3/7/8/9（检索相关 5 步，修的是夹具就位）与 11/12（修的是量法）全部转绿；`mock 调用 chat=16（规划器 6）· embed=10`。**这是脚本改写后的第一次真实执行、第一次全绿** ——此前只做过语法校验（见上一轮教训 ④）。 |
| 2026-09-18 | 实施 | 教训（验收脚本的量法） | — | ① **「一屏装下」这类断言必须写明尺寸基准**：同一份界面在 1440×900 是「compact + 滚动（不裁切）」、在 1664×1066 才是「一屏装下」，**两者都是正确行为**；不写基准就会把预期降级量成缺陷（本次 714 vs 684）。② **异步渲染的内容会在你量完之后长高**：凡「滚到底/滚到顶」的断言都要「等高度稳定再滚一次」，否则量到的是「它还是旧最大值」的那个瞬间（本次差 55px）。③ **对照组既防「蒙混过关」也防「冤枉产品」**：同一步里同时量基准尺寸与默认尺寸，既证明「一屏」成立、也证明「退化时不许藏内容」，比放宽阈值诚实。④ **换环境参数的辅助函数必须自证生效**（`resizeWin` 校验并抛错）：上一轮刚栽在「静默降级继续跑」上，同一个模式第二次出现。 |
| 2026-09-20 | 实施 | N28、N29 | 新增两条，均直接 → 已完成 | 自主巡检发现的两处后端真缺陷 + 三处界面说谎。**后端**：① 「回退 keys.json」从未接通 —— `resolveImageKeyPair` 在产物里 0 次引用（esbuild 按死代码摇掉），而 `wechat-data/README.md:159` 承诺着这条回退；7 处解码入口各自复制 `cfg['image_aes_key']` 取数，xor 兜底写成 `136` / `0` / `0xff` 三种（后两种从未生效）。改为**唯一解析点**并真接上（gateway 6 个 Remote + `exportMediaCtx`），“没有密钥”从 `''` 改 `undefined`。② `keys/service.ts:121,183,211` 三处写入全用字面量 `'default'`，而 `getAccountKeysFromStore` 在产物里同样 0 次 —— 库存的明文图片密钥只写不读；本次在**读取侧**加归属校验（别人账号的密钥按「未配置」处理，不再静默解出垃圾图），并让内存扫描路径新记 `image_key_source_wxid_dir`；**单槽位本身不动**（真按 wxid 分账要连带老库迁移，已记为遗留）。**前端（推荐回复面板）**：③ `copy()` fire-and-forget 却立刻显示「已复制」（说谎 + 一条未处理拒绝）→ 改走共享助手 `copyTextToClipboard` 且只认真实布尔结果，失败有出口；④ `loading` 初值 false 使**首帧**渲染成「这个会话还没有可用的对话内容」→ 改 true；⑤ Radix 下拉在选中项未挂载时整块空白 → 三态（在读 / 读失败 / 库不在列表里）各给 placeholder 文案。**验收**：`npm test` **188 文件 / 2147 通过 / 14 跳过 / 0 失败**（新增 `image-key-single-source.spec.ts` 4 项、`image-key.spec.ts` 3 → 8 项、`reply-suggest.wiring.spec.ts` +2 项）、`ui:smoke` **37 项 ✅**（该面板首次进入 SSR 覆盖）、`privacy-gate:smoke` 8 项、`typecheck` 0、`docs:api:check` ok（仍 159 方法）、`check:shim` 一致、bundle 与 `lib/types` 重建**幂等**（两次 sha 相同）。**变异 6 组全部转红并按 sha256 还原**：归属永远放行 / 只认 `derived_wxid`（**第一版用例在这里假通过，补上同形状仅账号不同的判别式反例后才抓到**）/ 解码入口退回自读 cfg / `loading` 初值 false / `Select` 的 value 回 `String(kbId)` / 复制退回 fire-and-forget。另修两处漂移：`wechat-worker.js` 注释写「115 个 Remote 方法」（实际 159，去掉这个数字以免再腐化）、`reply-suggest.ts` 把 `queryMessages` 的参数序号写错（cursor 是第 4、`cursorLocalId` 第 6）。**未验证**：两账号真机切换下的端到端解图；Radix 把选项挂载一次之后库名是否显示（SSR 测不到那一帧，已在用例注释里写明这条边界）。 |
| 2026-09-20 | 实施 | 聊天图片「取原图」（免登录直链） | 新增（已交付） | 起因是实测：本机 39,923 张图片消息里 **93% 磁盘上只有 `_t.dat` 缩略图** —— 图糊的根因不是解码失败，而是微信从来没存原图。能力边界先划清：指向原图的指针分两类，`tpurl`/`tphdurl` 预签名直链（实测 **16.2%**）免登录可直取；`cdnbigimgurl`（**47.6%**）要的是微信**登录态凭据**，**明确不做**（那已经是「以你的身份向服务器发请求」，与 README/PRIVACY 开头「不登录、不发送消息、不连微信服务器同步」是同一条承诺）。**实现**：新增 `query/image-original.ts`（XML 解析 + `&amp;` 反转义 + 域名白名单严格后缀匹配 + 64MB 上限 + 图片魔数嗅探）→ 落进 `<decoded>/<md5>.<ext>`，也就是 `decodeImageDataUrl` 第 1a 步优先读的缓存槽，**因此不用改任何显示路径**，下一次渲染即原图、之后离线可用（网络只花一次）；`@Remote('getImageOriginal')`（第 160 个方法）先过「禁止出网」总闸、再过界面「自动获取原图（CDN）」开关，结果写操作记录 `image_original_fetch`；`Chats.tsx` 图片气泡下方加「取原图」按钮，取不到时显示**具体原因**而不是「失败」。**本轮实测的一个重要发现**：`<img md5=…>` **不是文件身份** —— 与 `msg/attach` 文件名 0% 命中、与 `packed_info_data` 里那份 0/3997 相同，真键只在 packed_info（100% 命中）；应用现状本来就对，但已加守卫禁止以后改用 XML 那个值（我自己前两版探针就是栽在这里拿到的假结论）。**登记**：`docs/PRIVACY.md` D 段补出网点、白名单主机与「只做 16%」的边界说明（`privacy-statement.spec.ts` 要求主机必须写在文档里）；按 `KB-MODEL-CONFIG.md` 决定 D5 **不提升** `PRIVACY_VERSION`（新增出网点以文档如实描述为准）；license 侧登记进 `NON_AI_OUTBOUND`（它带 `privacyBlocked` 接缝，与 SNS 封面/视频同一类）；`settings-switch-wiring.spec.ts` 的 `REMOTE_CALL_SITES` 补第 6 处；`OnboardingShell` 方法数 159 → 160。**验收**：`npm test` **190 文件 / 2161 通过 / 14 跳过 / 0 失败**（新增 `image-original.spec.ts` 11 项 + `image-original.wiring.spec.ts` 3 项）、`typecheck` 退出 0、`docs:api:check` ok（160）、`check:shim` 一致、`ui:smoke` 37 项、`privacy-gate:smoke` 8 项、bundle 与 `lib/types` 重建**幂等**（sha 不变）。**变异 4 组全部转红并按 sha256 还原**：白名单退回裸 `endsWith(suf)`（会放过 `notqq.com`）→ 行为 + 守卫共 2 红；缓存键改用 XML 的 `md5=` → 5 红；CDN 开关关掉仍发请求 → 红；取回成功后不 bump nonce → 红。**未验证**：真实点击的端到端观感（需真窗口 + 未过期的真实直链）；`package:smoke` 需先 `npm run pack`，本轮未跑。 |
| 2026-09-20 | 修复 | 解码缓存槽位会永久遮蔽后到的原图（用户实测反馈） | 已完成 | 现象：用户「已经在微信里点开过原图，应用里还是缩略图」——而上一条刚交付的提示语正是「去微信里点一下就能看到」，那句话当时**是假的**。**根因**（实测，不是推断）：`decoded_images` 只有一个槽名 `<md5>.<ext>`，谁先解出来谁永久占住；`decodeImageDataUrl` 第 1a/1 步先读缓存、命中就返回，**永远走不到 attach 里那份大 .dat**。本机量到：117 条缓存条目里 106 条在 attach 有更大的 .dat，其中 **35 条缓存比本机那份小 2 倍以上（31 条小 8 倍以上）**。**修法**：① 槽位一分为二 —— `<md5>.<ext>` = 本机最好的一份，`<md5>.t.<ext>` = `_t`/`_h` 的缩略兜底，读取端先要前者；写入端按 `scoreDatPath(f) > 0` 决定落哪个槽（缩略图不再占住正位）。② `decodeImageDataUrl` 返回值加 `thumb?: boolean`，界面据此显示「本机只有缩略图」，不再让用户猜。③ 新增 `clearDecodedImageCache()`，`getImageOriginal` 在**没有免登录直链**时不再只回一句提示：先丢掉这张图的两个缓存槽、回到 attach 重解一次，重解到更大那份就成功（并说明「这次没联网」），确实只有缩略图时才让用户去微信里点、且告诉他回来再点一次。④ 读缓存失败不再直接报错，落到 .dat 重解（顺手覆盖坏条目）。**验收**：`image-original.spec.ts` 11 → 15 项（两槽优先级、只有 `.t.` 时 `thumb:true`、`clearDecodedImageCache` 删净两个槽、写入端分槽的源码守卫），`npm test` **190 文件 / 2165 通过 / 14 跳过 / 0 失败**、`typecheck` 0、`docs:api:check` ok、`check:shim` 一致、`ui:smoke` 37 项、bundle 与 types 重建幂等（sha 不变）。**变异 2 组转红并按 sha256 还原**：读取端优先看缩略槽 → 红；写入端不分槽（`thumb` 恒 false）→ 红。**教训**：交付一条「用户照着做就能好」的提示语之前，必须先把那条路自己走通一遍 —— 这次的提示语比它描述的能力早到了两天。 |
| 2026-09-21 | 实施 | H1 | 进行中（仓库侧与历史重写完成并实测；仅剩用户轮换） | 用户授权后执行 `git filter-repo` 重写：移除 `wechat/config.json`/`wechat/llm.json` 全历史路径 + 三把密钥字面量全历史替换；重写前做完整镜像备份（本地，112 refs）；`main` `ee9c956→7339eec`、`feat/chat-message-module` `658af7d→e039041`、tags v1.0.3–1.0.5 同步强推；**自 GitHub fresh clone 实测**：两文件全历史 0 条、三把密钥字面量 0 命中、Releases 完好。**另补出第二轮遗漏**：5 个跟踪文件（`m1-secrets-migration-smoke.js` + 4 个后端 spec）共 13 处硬编码同一把 image key，已换假值（`c5e7b33`）。剩余：用户轮换凭据（旧 Key 应实测 401）；旧对象仍可按 SHA 经 GitHub API 取到，需官方支持清理缓存。顺带修正本分支上游（原指向 `origin/main`，现为 `origin/feat/chat-message-module`） |
| 2026-09-21 | 实施 | H13 | 未开始 → 已完成 | 用户确认法务结论为「允许保留」（方案 A，方案 B 未启用）；README「已知限制」与 `PROVENANCE.md` 中「许可未明」的表述同步更新（PROVENANCE 保留原记述并加日期标注取代）；风险登记表对应行加闭环标注 |
| 2026-09-21 | 实施 | H7、N30 | H7 的「UI 解除 loading」验收项：未达标 → 已验证；N30 新增 → 已完成 | **H7**：new `scripts/loading-recovery-e2e.mjs`（`npm run ui:loading-e2e`）—— 用 `SUPERTIME_DEBUG_HANG_METHODS`（主进程按 `app.isPackaged` 判定、打包态显式删变量后 fork；worker 命中即不回应答）+ `SUPERTIME_CALL_TIMEOUT_MS=1500` 在真实窗口里复现「后端卡死」，断言超时 alert（含方法名）、骨架屏清零、两侧日志留痕、下一条调用照常收尾。变异（禁用注入）4 条转红、接线守卫变异 1 条转红，均按 sha256 还原。**N30**：同一次复跑暴露 —— 空数据源下「通讯录」显示原始英文 `unable to open database file`；在 `wechat-host` 的 call 错误路径集中翻译为可执行中文并保留原文，其余错误原样透传；`host-error-message.spec.ts` 6 项 + e2e 断言。**验收**：`npm test` 191 文件 / 2176 通过 / 14 跳过；`ui:loading-e2e` 10 项；`license-gate:smoke` / `security-guard:smoke` / `check:backend-restart` / `check:sns-video`(18) / `check:whisper-paths`(11) / `rag:check`(20) 复跑全过。**门禁清单**：License 异常路径、openExternal/导航、npm test、git status、fresh clone 全流程、package:smoke、后端自愈、无限 loading、H9 内存上界 已勾选；H4 的「CI 能阻断合并」仍缺分支保护机制、H5（负向退出码）与 H8（导出内存）复跑在途 |
| 2026-09-21 | 实施 | H1、H4、H5 | H1 进行中 → 已完成；H4/H5 的门禁项勾选 | **H1**：用户完成 DeepSeek Key 轮换，旧 Key 实测 401（作废生效）；微信 db/image key 决定不轮换（需同时持有本机库文件才可利用，列残余风险）。**H4**：用户选择「要求 PR + CI」→ 已通过 API 开启 main 分支保护（required check `verify`、require PR、`enforce_admins: true`、禁 force push/删除），直接 push main 从此被拒，发版走 PR。**H5**：负向实测（隔离 userData、不碰真实数据）12 条断言失败 → exit 1，与 09-18 的全绿 exit 0 构成完整口径 |
