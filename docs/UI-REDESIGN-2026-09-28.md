# Super Time 界面重设计方案（UI/UX 设计总监评审）

> 状态：提案（待评审）
> 日期：2026-09-28
> 范围：桌面端单平台（Windows x64）。窄窗 960–1100px 是唯一「小屏」档。
> 口径：**保留信息架构（IA）与交互骨架，重做视觉语言与令牌层。**
> 前置文档：`docs/UI-GEOMETRY-SPEC.md`（圆角/间距量化基线）、`docs/UI-PANELS-PLAN.md`（17 页签审计 + R0–R7）。

---

## 0. 先说结论（TL;DR）

**这个项目不缺设计系统。它缺的是「设计系统被普遍采纳」。**

全站 68 个 CSS 文件、**4,355 处令牌引用**、**556 处裸色**，整体采纳率 **88.7%**。但采纳率不是均匀的，它按「用户先看到哪个界面」严格递减：

| 用户旅程顺序 | 表面 | 采纳率 |
|---|---|---|
| 第 1 眼 | 自绘标题栏 | **35.7%** |
| 第 2 眼 | 授权 LicenseGate | **36.6%** |
| 第 3 眼 | 启动引导 Onboarding | **37.4%** |
| 第 4 眼 | 隐私同意 PrivacyConsent | **61.1%** |
| 进入主界面后 | 聊天消息区 | 86.0% |
| 进入主界面后 | 数据面板 panels/* | 95.4% |
| 组件库 | kit | **97.2%** |

**四个「第一印象」表面的采纳率全部低于 62%，而用户进入产品前必须穿过这四道门。**
这不是"风格不统一"，这是**门面和内室不是同一栋楼**。

三个结论性判断：

1. **问题定位精确** —— 不是"重做设计系统"，而是"把已有系统补到最后 12% 的表面"，其中前 4 个表面是 80% 的收益所在。
2. **风格方向需要一次"收敛式换新"**：现状是**三套视觉语言并行**（见 §2.3），必须收敛成**一套基底 + 一个受控例外**。
3. **移动端不做** —— 本项目 `package.json` 明写「仅支持 Windows x64」，`src/backend/main-window.js` 设 `MIN_W = 960 / MIN_H = 640`。**窄窗（960–1100px）就是唯一的小屏档**，本方案给窄窗单独定档，不虚构手机布局。

---

## 1. 界面构成与用户场景梳理

### 1.1 界面总图（实测）

| 层 | 构成 | 计数 | 真源文件 |
|---|---|---|---|
| 应用外壳 | 自绘标题栏（无系统边框） | 1 | `src/client/ui-app/titlebar.css` |
| 前置门 | 启动引导 / 授权 / 隐私同意 | 3 | `ui-app/onboarding` `license` `privacy` |
| 主 shell | 侧栏（收起 58 / 展开 176）+ 内容区 | 1 | `wechat-data.module.css` |
| 导航 IA | 分组 **9** / 侧栏可见条目 **16** / 可路由 tab **37** | — | `nav-config.ts` |
| 主导航页 | `WechatDataPanel` 的 switch 分支 | **17** 个可见路由 | `WechatDataPanel.tsx` |
| 合并视图组 | `MergedSections`（一处外壳承载多个 tab） | **8** 组 | 同上 + `KbShell.tsx` |
| 数据面板 | `panels/*.tsx` | **105** 个 tsx / **53** 个 module.css | `panels/` |
| 组件库 | kit 五件套 | 4 tsx + 4 css | `ui/` |
| 设置弹窗 | 分组 4 / 节 **13** | — | `Settings.tsx` + `settings-state.tsx` |

### 1.2 九个导航分组（IA 真源 = `nav-config.ts`）

| # | 分组 | 可见条目 | 隐藏但可路由 | 已做的 IA 合并 |
|---|---|---|---|---|
| 1 | 概览与问答 | 数据总览、微信问答 | — | — |
| 2 | 报告与总结 | 总结 | 年度报告、周期报告 | 周期报告 → 总结（段条） |
| 3 | 会话与消息 | 聊天会话、群聊分析、通话记录 | 公众号/服务号/客服、群聊监控、撤回消息 | 4 种会话视图 → 聊天会话；监控 → 群聊分析 |
| 4 | 联系人与社交 | 通讯录、朋友圈 | 社交图谱 | **社交图谱 → 通讯录** |
| 5 | 内容资产 | 收藏与表情、文件与存储、知识库 | 表情包、收藏统计、媒体资产、存储分析、公众号文章、**知识图谱**、**文件** | **知识图谱/文件 → 知识库** |
| 6 | 资金 | 资金往来 | 转账红包 | 明细 → 月度汇总 |
| 7 | 洞察与行动 | 朋友圈洞察、待办日程 | — | — |
| 8 | 隐私与安全 | 隐私体检 | 数据边界与出网、备份恢复 | 两条 → 设置弹窗 |
| 9 | 维护与设置 | 设置、操作日志 | 数据库健康、原图链路自检 | 两条 → 设置弹窗 |

> ⚠️ **IA 纪律（必须写进设计原则）**：`hidden` 条目**绝不能整行删除**。`TAB_LABELS` 由 `NAV_GROUPS` 构建，删条目等于删掉深链 id，`#graph` 会**静默**落回「数据总览」——typecheck / build 全绿，只有功能坏掉。这条曾被真实触发过（2026-09-18），现由 `contacts-graph-merge.wiring.spec.ts` 钉住。**重设计不得改动 `nav-config.ts` 的条目集合。**

### 1.3 用户使用场景（按任务而非按页面分）

| 场景 | 用户是谁 | 主路径 | 关键诉求 | 对应表面 |
|---|---|---|---|---|
| **S1 首次上手** | 新用户 | 启动引导 → 授权 → 隐私同意 → 配置向导 | **3 分钟内搞懂要不要给权限**；任何一步卡住就流失 | 前置门 3 + 设置-配置向导 4 节 |
| **S2 日常查看** | 回流用户 | 数据总览 → 聊天会话 / 通讯录 | 一眼扫到「今天发生了什么」 | overview / chats / contacts |
| **S3 深度检索** | 分析者 | 微信问答 → 会话定位 → 导出 | 问题→证据→原文的链路不能断 | ask / chats / kb |
| **S4 资产盘点** | 整理者 | 文件与存储 → 存储分析 → 清理 | 谁占了多少、删得掉吗 | files / storage / mediaassets |
| **S5 关系洞察** | 社交分析 | 群聊分析 / 朋友圈洞察 / 社交图谱 | 趋势、异常、TOP 榜 | groupinsights / momentsinsights / graph |
| **S6 资金对账** | 有转账往来者 | 资金往来 → 转账红包明细 | 数字必须可核对、可跳原文 | ledger / records |
| **S7 隐私与信任** | 谨慎用户 | 隐私体检 → 数据边界与出网 | **"数据出没出网"要有确定答案** | privacy / 设置-boundary |
| **S8 排查故障** | 遇到问题者 | 操作日志 / 数据库健康 / 原图链路自检 | 拿到可上报的证据 | oplog / 设置-health,hook |
| **S9 长任务等待** | 任意 | 解密 / 转写 / 模型下载 | **进度要真实，别假装在动** | 跨面板 |

**设计含义**：S1 与 S7 是**信任构建**场景，视觉权重最高（用户第一次决定"这个软件可不可信"）；S9 是**挫败感最高**场景（无进度 = 卡死）。

---

## 2. 六维问题评估（每条带代码证据）

### 2.1 布局（Layout）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| L1 | **44 个不同断点值，全部是单边 `max-width`** | `working/visual-audit.txt`：900px×13 之后长尾一路到 90px、110px、120px… | 无统一档位；改一个组件不知道会不会撞另一个 |
| L2 | **断点体系缺"窄窗"档的共识** | 只有 900/1100 两个值出现 ≥5 次；`960px` 仅 2 处（正是最小窗宽，却没被当档位） | 960–1100px 这个**真实存在**的区间没有统一策略 |
| L3 | **侧栏展开是"推挤式"重排，非覆盖** | `wechat-data.module.css:266-271` 注释自陈：展开 200ms 内内容逐帧重排，挂 `ResizeObserver` 的地图/ECharts/长表会跟着重算 | 展开侧栏时图表抖动；切页签时世界地图重算 |
| L4 | **`--nm-panel-pad` 左右归零是补丁而非设计** | `scifi-theme.css` 第 80 轮注释：shell 的 `.content` 已给左右各 16px，面板再写 18px 会横向跳 18px | 面板左右留白不可控，是"凑"出来的对齐 |
| L5 | **遗留 `src/styles.css` 与 NEON MATRIX 并行** | `src/styles.css` 自带 `--bg:#0f172a / --accent:#38bdf8`，与 `--nm-*` 完全并行；`.app{max-width:960px}` | 仅作 `ui-dist` 缺失时的兜底演示页（N21），生产不可见——但**是隐患**：一旦回退，视觉完全脱节 |
| L6 | **`min-height` 基准 640 与内容高度无契约** | `main-window.js` `MIN_H=640`；内容区在 1440×900 下约 802px 高（`UI-PANELS-PLAN.md`） | 640px 高时密集面板是否可滚动，无守卫 |

### 2.2 信息层级（Information Hierarchy）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| H1 | **落地态是"一行字"** | `UI-PANELS-PLAN.md` P0-U1：通用缺陷 | 页面加载中显示一行文案，与真实布局骨架不一致 |
| H2 | **骨架与真实布局不一致** | 同上 P0-U3 | 骨架屏跳变成完全不同的版式 |
| H3 | **密集面板空白带过大** | `UI-PANELS-PLAN.md` 量出「最大空白带 / 空白占比」逐页签数据；`npm run ui:panel-audit` 是测量器 | 内容稀疏时页面"空得发慌" |
| H4 | **`default` 分支是"重构中"占位文案** | `WechatDataPanel.tsx:368-374`：`🚧「{label}」面板正在重构中` | 37 个可路由 tab 中若有未接的，用户看到的是 emoji + 开发字样 |
| H5 | **`Card` 与 `StatCard` 的关系无层级规范** | `kit-shell.tsx` 同时提供 `Card` / `StatCard` / `StatGrid`；无文档说明何时用哪个 | 同类信息在不同面板用不同容器 |
| H6 | **数值/文本区分靠"约定"不靠规范** | `kit-foldable.tsx` 的 `Mono`（等宽数字）与 `CellPrimary` 靠人记得用 | 表格数字对齐不稳定 |

### 2.3 视觉一致性（Visual Consistency）——**本方案的核心**

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| **V1** | **三套视觉语言并行** | ① `--nm-*` NEON MATRIX（深空黑+霓虹青紫，190 处声明）② `--wx-*` 微信官方（48 个令牌，只服务聊天消息区，浅 `#EDEDED`/深 `#191919`）③ **裸字面量**（556 处） | 用户从"科幻霓虹"切到聊天页变"微信原生"再切回来，**身份认同断裂** |
| **V2** | **四个"第一印象"表面采纳率断崖** | 标题栏 **35.7%** / 授权 **36.6%** / 引导 **37.4%** / 同意 **61.1%**（vs kit 97.2%） | 最该建立信任的地方视觉最弱 |
| **V3** | **"有令牌却不用"（非"缺令牌"）** | `OnboardingShell.tsx` / `PrivacyConsentGate.tsx` **确实 import 了** `scifi-theme.css` + `light-theme.css`，采纳率却是 37.4% / 61.1% | 修法明确：改样式引用，不动基础设施 |
| **V4** | **引导页混入硬编码浅色调色板** | `onboarding.module.css`：`#0e7490`、`rgba(255,255,255,0.55)`、`rgba(15,23,42,0.08)`、`rgba(247,249,252,…)` —— 这些是**浅色主题色值**被写死在深色主题文件里 | 深色主题下这些块会**发白发亮**，是真缺陷不是风格偏好 |
| **V5** | **重复裸值本可用令牌** | `rgba(0,240,255,0.1)` 裸写 **22 次**，而 `--nm-cyan-10` 已被引用 60 次 | 改一次霓虹青色要全局搜 22 处 |
| **V6** | **裸色集中在少数文件** | Top5：`onboarding.module.css` **165**、`chats-rows.module.css` **61**、`PrivacyConsentGate.module.css` **56**、`overview-neon.module.css` **50**、`license-gate.module.css` **45** | 收敛工作量**高度集中**，前 5 个文件吃掉 377/556 = **68%** |
| **V7** | **主题切换机制是好的，但覆盖不全** | `:root.theme-light` 覆盖 `--nm-*`（128 行），`@property` 令牌级过渡 400ms 已就绪 | **换新的正确做法是改 `scifi-theme.css` 的令牌值**，一处改、全站生效 |

### 2.4 交互流程（Interaction Flow）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| I1 | **长任务无真实进度** | `UI-PANELS-PLAN.md` P0-U2 | 解密/转写/下载时用户无法判断"活着还是在卡" |
| I2 | **裁切（clipping）** | 同上 P0-U4 + 验收口径「裁切=0」 | 数据被切掉，用户以为是数据缺失 |
| I3 | **读失败可能被渲染成"没有数据"** | 仓库已有守卫 `read-error-visibility.spec.ts`（记忆：前端读失败不许渲染成"没有数据"） | 这是**语义级**交互缺陷：空态 vs 错误态不可混 |
| I4 | **深链改道不透明** | `DIALOG_SECTION_OF`：`#privacytrust`/`#backup`/`#health`/`#hook` 命中时改开设置弹窗 | 用户点了个导航项，出来的是弹窗——需要过渡说明 |
| I5 | **合并视图的段条依赖 `initial` 首帧** | `MergedSections` 的 `useState` 只在首次生效（注释明写） | 同一页面内跨段深链可能不同步 |
| I6 | **`!important` 12 处** | 分散 7 文件（`chats-rows` 4、`license-gate` 2、`onboarding` 2…） | 数量少、纪律良好；但集中在弱采纳文件，是"覆盖不掉的样式"的征兆 |

### 2.5 配色（Color）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| C1 | **裸 hex 244 处 / 去重 102 个色值** | Top：`#fff` 25、`#e2e8f0` 16、`#00f0ff` 16、`#94a3b8` 11 | 102 个色值里绝大多数应是令牌的别名 |
| C2 | **裸 rgb/rgba 312 处 / 去重 179 个** | `rgba(0,240,255,α)` 一族占大头（α=0.1/0.25/0.4/0.45/0.55…） | alpha 阶梯没有规范，全靠手写 |
| C3 | **浅色主题存在"色相保留、明度重调"的良好实践** | `light-theme.css:19-20` 注释：`#00ff88/#00f0ff` 在白底对比不足，压暗为 `#0e7490` 等 | **这套方法论应被引导/授权层复用**，它们现在绕过令牌自带浅色值 |
| C4 | **语义色（success/warning/danger/info）已就绪但对齐不全** | `scifi-theme.css` 有 `--nm-success/-text` 混色版；`light-theme.css` 有 `-15` 透明度版 | 命名后缀（`-text` vs `-15` vs `-10`）需统一 |
| C5 | **`--dsw-alias-*` 别名族与 `--nm-*` 双层** | `wechat-data.module.css:10-18`：`--dsh-scrollbar-thumb` ← `--dsw-alias-scrollbar-bg-l2` | 两层间接，改滚动条要穿两层 |

### 2.6 组件规范（Component Spec）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| P1 | **kit 组件库本身是最好的（97.2%）** | `ui/` 五件套：`kit-shell`(PanelHeader/Toolbar/SearchInput/Card/StatCard/StatGrid)、`kit-overlay`(Tabs/Segmented/Drawer/Dialog)、`kit-fields`(Tooltip/Badge/ProgressBar/EmptyState/DateField…)、`kit-table`(DataTable)、`kit-foldable`(FoldableBar/Mono/CellPrimary) | 组件词汇**完整**，问题不在"缺组件"而在"绕开组件" |
| P2 | **`kit.module.css` 799 行偏大** | 已有 `kit-css-split.wiring.spec.ts` 守卫拆分 | 拆分已启动，需延续 |
| P3 | **组件无"该用哪个"的决策表** | 无文档说明 `Tabs` vs `Segmented`、`Drawer` vs `Dialog`、`Card` vs `StatCard` 的分界 | 同类需求不同面板选不同组件 |
| P4 | **`EmptyState` 与 `EmptyMaybeSyncing` 双份空态** | `kit-fields.tsx` 两者并存 | 空态语义（真空 vs 可能同步中）值得保留，但需明确使用条件 |
| P5 | **进度组件存在但未被长任务普遍使用** | `kit-fields.tsx` 有 `ProgressBar`；I1 仍成立 | **不是缺组件，是不用**——与 V3 同源 |

### 2.7 问题汇总（按收益排序）

| 优先级 | 问题簇 | 编码 | 一句话 |
|---|---|---|---|
| **P0** | 前置门视觉断崖 | V1 V2 V3 V4 V6 | 四个门面用裸色堆出来，与内室不是一栋楼 |
| **P0** | 三套视觉语言并行 | V1 | 霓虹 / 微信原生 / 裸值，身份断裂 |
| **P1** | 结构性问题未闭环 | H1 H2 I1 I2 I3 | 落地态、骨架、进度、裁切、空/错态 |
| **P1** | 断点碎片化 | L1 L2 | 44 个值、无窄窗档 |
| **P2** | 令牌收尾 | C1 C2 C4 C5 | alpha 阶梯、语义后缀、别名层 |
| **P2** | 组件决策表缺失 | P3 P4 | 有组件，缺"何时用" |
| **P3** | 遗留兜底页 | L5 | `styles.css` 生产不可见，但脱节 |

---

## 3. 统一重设计方案

### 3.1 设计目标（Objectives）

| # | 目标 | 可度量判据 |
|---|---|---|
| **G1** | **一致性**：全站单一视觉语言 | 全站令牌采纳率 **88.7% → ≥97%**；四个前置门 **35.7–61.1% → ≥95%** |
| **G2** | **第一印象**：门面与内室同源 | 引导/授权/同意三页**零裸色**（除 `--wx-*` 受控例外）；与主 shell 同色板同字阶 |
| **G3** | **密度**：窄窗不被裁切 | 960×640 下逐页签「裁切 = 0、console error = 0」（沿用 `ui:panel-audit` 口径） |
| **G4** | **可预测**：进度/空态/错误态语义明确 | 所有 >2s 任务有真实进度；错误态与空态视觉可区分（`read-error-visibility.spec.ts` 已钉） |
| **G5** | **可维护**：改一处、全站生效 | 主题色改动**只碰 `scifi-theme.css` + `light-theme.css`**；断点收敛到 **4 档** |

### 3.2 设计原则（Principles）

1. **令牌优先，例外须登记**（Token-first, registered exceptions）
   写色值前先问"哪个令牌"。确需裸值（如微信官方色）必须走 `--wx-*` 并在 `docs/PRIVACY.md` 同级登记。
   → 直击 V2 V3 V5 V6。

2. **门面即产品**（The door is the product）
   引导 / 授权 / 同意是用户对产品的**第一次也是最后一次信任投票**，其视觉质量**不得低于**主界面。

3. **一套基底，一个受控例外**（One base, one sanctioned exception）
   `--nm-*` 是全站基底；`--wx-*` 是**唯一**允许的例外，且**仅限聊天消息流内部**（因为它承载"微信原样"的语义诚实）。两套之间必须有**明确的边界**，不允许第三套。

4. **保留 IA，只换皮肉**（Same bones, new skin）
   `nav-config.ts` 的 9 组 / 37 tab / 8 组合并视图**不动**；hidden 条目**不删**。重设计只动令牌层与视觉语言。

5. **量化验收，不靠肉眼**（Measure, don't eyeball）
   沿用 `npm run ui:panel-audit`；每条改动附"改前/改后"数字。UI 修复必须配套守卫。

6. **窄窗是一等公民**（Narrow window is first-class）
   960–1100px 是**唯一**的小屏档，按它定档，不为它道歉。

### 3.3 风格方向（Style Direction）——**视觉换新**

> 用户裁决：**评估 + 视觉换新（换风格方向）**，保留 IA 与交互骨架。

**现状**：NEON MATRIX —— 深空黑 + 霓虹青紫 + 网格底纹 + 毛玻璃 + 发光弥散。

**诊断**：这套语言本身**完成度高**（令牌齐、过渡顺、焦点环全），但它有两个结构性问题：
- **霓虹青（`--nm-cyan`，被引用 722 次）承载了过多语义**——品牌色 = 强调色 = 边框色 = 发光色 = 图表主色，视觉噪声高；
- **发光/网格/毛玻璃在密集数据面板里是负担**——13 个设置节、214,027 条消息的表格前，辉光是干扰而非助益。

**新方向：`PRECISION MATRIX`（精密矩阵）—— 从"霓虹发光"收敛到"仪表盘级精确"。**

一句话：**保留深色与青色身份，去掉"装饰性发光"，把视觉预算全部投给层级、对齐与数据可读性。**

| 维度 | 现状（NEON MATRIX） | 新方向（PRECISION MATRIX） | 理由 |
|---|---|---|---|
| 底色 | 深空黑 `--nm-bg-0` + 青网格底纹 | **去掉网格底纹**；保留深底，提升 1 阶对比 | 网格在密集表格下是摩尔纹源；V/H 类问题 |
| 品牌色用法 | 青 `#00f0ff` 用于**所有**强调（722 处） | 青**降为"交互态"专用**（hover/focus/选中/链接）；品牌身份交给**渐变徽标 + 少量高光** | 释放 722 处的视觉噪声预算 |
| 发光 | `--nm-glow-sm/md/lg` 弥散辉光到处用 | **辉光仅用于"活跃态"**（运行中任务、选中项）；静态元素零辉光 | 辉光表示"这里在动"，不再表示"这好看" |
| 毛玻璃 | `--nm-bg-glass` 弹窗/侧栏 | **仅在覆盖层**（Dialog/Drawer）保留；内容区全部实色 | 毛玻璃在内容区降低文字对比 |
| 层级 | 靠边框 + 辉光区分 | 靠**底色阶 + 间距**区分；边框降为 `--nm-border` 单一强度 | 层级用"面"不用"线" |
| 数据可读 | 表格无等宽数字强制 | **所有数值列强制 `Mono`**（`kit-foldable.tsx` 已有组件） | 直接修 H6 |
| 密度 | `--nm-dense-*` 已就绪但选择性使用 | **密集面板默认走 dense 档**，宽松档是例外 | 直击 H3 空白带 |
| 微信例外 | 聊天页与全站并存无边界 | 聊天消息流**明确划为 `--wx-*` 保护域**，头部/侧栏/工具栏仍走 `--nm-*` | 收敛 V1 的三套语言 |

**为什么不是"推翻重来"**：
- 令牌层已经能承载这次换新（`:root.theme-light` + `@property` 过渡已验证）；
- 换新 = **改令牌值 + 改少数基元样式**，`--nm-*` 名字不变 → 4,355 处引用**自动跟着变**；
- 换成完全不同的色相（比如暖橙）会与"微信数据工具"的冷静语义冲突，且 `--wx-*` 的微信绿/白会打架。

### 3.4 关键改动清单

#### A. 令牌层（一处改、全站生效）

| # | 改动 | 落点 | 验收 |
|---|---|---|---|
| A1 | 定义 **alpha 阶梯**：`--nm-cyan-4/6/8/10/14/20/35/50`，消灭 `rgba(0,240,255,α)` 手写 | `scifi-theme.css` + `light-theme.css` | `rgba(0,240,255,` 出现次数 **22+ → 0** |
| A2 | 统一语义色后缀：`-15`（底）/`-text`（字）/`-line`（边）三件套 | 同上 | `--nm-success` 族在浅/深两套定义一致 |
| A3 | 收敛 **中性色阶**：`--nm-text-1/2/3` + 新增 `--nm-text-4`（占位/禁用） | 同上 | 裸 `#94a3b8`(11) / `#64748b`(7) / `#6b7280`(2) → 令牌 |
| A4 | 品牌色**分层**：`--nm-brand`（身份渐变）+ `--nm-accent`（交互态，= 现 `--nm-cyan`） | 同上 | 交互态仍用 `--nm-cyan`，身份用 `--nm-brand` |
| A5 | 新增**密度令牌**在密集面板的默认绑定 | `wechat-data.module.css` | dense 档默认生效 |
| A6 | 断点收敛 `--nm-bp-*`（**仅作文档 + 注释级**，CSS 变量不能用于媒体查询） | `scifi-theme.css` 注释块 | 44 → **4 档**（见 A7） |
| A7 | **4 档断点定案** | 全站 | `≤1100`（窄窗）/ `≤900`（紧凑）/ `≤720`（极窄）/ 其余默认 |

> ⚠️ A6 注：CSS 变量**不能**用于 `@media`，所以"断点令牌"只能是**文档化的常量约定**，由守卫扫描字面量。这是 `UI-GEOMETRY-SPEC.md` 同类做法。

#### B. 前置门（收益最高的 80%）

| # | 改动 | 落点 | 验收 |
|---|---|---|---|
| B1 | 引导/授权/同意三页**全量换令牌**，消灭硬编码浅色值 | `onboarding.module.css`(165) `license-gate.module.css`(45) `PrivacyConsentGate.module.css`(56) | 采纳率 **37.4/36.6/61.1% → ≥95%** |
| B2 | **删除 V4 硬编码浅色块**（`#0e7490` / `rgba(255,255,255,.55)` / `rgba(15,23,42,.08)`） | 同上 | 深色主题下不再"发白" |
| B3 | 自绘标题栏换令牌 | `titlebar.css`(9 裸色) | **35.7% → ≥95%** |
| B4 | 三页共用 kit 的 `PanelHeader`/`Card`/`Badge` 词汇 | `ui-app/*` | 与主界面同构 |
| B5 | 引导页保留 `Reveal.tsx`/`particles.tsx` 动效，但**去辉光**（符合 3.3） | `onboarding/` | 动效仍在，静态零辉光 |

#### C. 聊天消息域边界（收敛三套语言）

| # | 改动 | 落点 | 验收 |
|---|---|---|---|
| C1 | **明确 `--wx-*` 边界**：以 `.chatsMessages` 容器为界，内部走 `--wx-*`，容器外（头部/工具栏/侧栏）走 `--nm-*` | `chats.module.css` 等 7 文件 | 边界写入 `docs/compose/spec/wechat-message-visual-system.md` |
| C2 | 收敛 `chats-rows.module.css` 的 **61 裸色** 到 `--wx-*` 或 `--nm-*` | `chats-rows.module.css` | 该文件裸色 → ≤10 |
| C3 | `check:wx-tokens`（47 断言）扩展覆盖边界断言 | `scripts/check-wx-tokens.js` | 边界被守卫钉住 |

#### D. 结构性问题闭环

| # | 改动 | 落点 | 验收 |
|---|---|---|---|
| D1 | **落地态统一骨架**：所有面板首帧渲染 `SkeletonLayout`（与真实布局同构），非"一行字" | `kit-shell.tsx` + 各 panel | P0-U1/U3 消除；`ui:panel-audit` 空白带 <150px |
| D2 | **长任务进度契约**：>2s 任务必须用 `ProgressBar` + 阶段文案 | 跨面板 | P0-U2；新增守卫扫描长任务调用点 |
| D3 | **空态/错误态强制区分**：错误态不得渲染为"没有数据" | `kit-fields.tsx` | 沿用并强化 `read-error-visibility.spec.ts` |
| D4 | **裁切归零**：960×640 逐页签 | 全站 | `ui:panel-audit` 裁切 = 0 |
| D5 | `default` 分支改为**带脚手架的"即将上线"**，非 `🚧 重构中` | `WechatDataPanel.tsx:368` | H4；无 emoji、有 issue 链接占位 |
| D6 | 密集面板默认 dense 档 | 密集 tab | H3 空白带收窄 |

#### E. 组件与文档

| # | 改动 | 落点 | 验收 |
|---|---|---|---|
| E1 | 新增 **组件选择决策表**（`Tabs` vs `Segmented`；`Drawer` vs `Dialog`；`Card` vs `StatCard`；`EmptyState` vs `EmptyMaybeSyncing`） | `docs/UI-COMPONENT-GUIDE.md`（新） | P3 P4 |
| E2 | 数值列强制 `Mono` | `kit-table.tsx` | H6 |
| E3 | 延续 `kit.module.css` 拆分（799 行） | `ui/` | P2 |
| E4 | 遗留兜底页 `src/index.html` + `src/styles.css`：**明确标注为 N21 兜底**，或改为引用 `--nm-*` | `src/styles.css` | L5 消除隐患 |

---

## 4. 目标规范（Desktop-Only）

### 4.1 平台边界

| 项 | 值 | 真源 |
|---|---|---|
| 平台 | **仅 Windows x64** | `package.json` description |
| 最小窗 | **960 × 640**（内容尺寸） | `main-window.js` `MIN_W/MIN_H` |
| 基准窗 | 1440 × 900 | 同上 `BASE_W/BASE_H` |
| 窗口边框 | 无（`frame: false`），自绘标题栏 | 同上 |
| 沙箱 | `sandbox: true` | 同上 |
| 移动端 | **无** | 无 touch、无手机布局、无 mac/linux 构建目标 |

### 4.2 断点定档（44 → 4）

| 档 | 条件 | 用途 | 现状值映射 |
|---|---|---|---|
| **Narrow** | `≤ 1100px` | 侧栏默认收起、双栏→单栏、表格降列 | 1100 / 1080 / 980 / 960 |
| **Compact** | `≤ 900px` | 卡片网格降列、工具栏折行 | 900 / 860 / 820 / 800 / 760 |
| **Tight** | `≤ 720px` | 极端紧凑（仅在窗口被压到近最小宽时） | 720 / 700 / 680 / 660 |
| **Default** | `> 1100px` | 基准（1440） | 1200 及以上的散值 |

> 其余 **30 个 ≤650px 的值**（320/210/232/130/120/110/90…）多为**组件内部尺寸断点**（如单元格宽度），应改名为"容器断言"并入 A6 的文档，不进全局档位。

### 4.3 令牌规范（变更摘要）

| 族 | 令牌 | 变更 |
|---|---|---|
| 底色 | `--nm-bg-0/1/2/card/glass/hover/active/input` | 保留；`glass` 限覆盖层 |
| 品牌 | `--nm-brand`（新）| 身份渐变（徽标/标题） |
| 强调 | `--nm-cyan` | **语义收窄为交互态** |
| alpha | `--nm-cyan-4/6/8/10/14/20/35/50`（新） | 消灭手写 rgba |
| 文字 | `--nm-text-1/2/3` + `--nm-text-4`（新） | 补占位/禁用 |
| 语义 | `--nm-success/warning/danger/info` + `-15`/`-text`/`-line` | 后缀统一 |
| 圆角 | `--nm-r-xs/sm/md/lg/xl/pill` = 4/6/10/14/20/999 | **不变**（`UI-GEOMETRY-SPEC.md` 已定案） |
| 间距 | `--nm-s-1..8` = 4/8/12/16/20/24/32 | **不变** |
| 密度 | `--nm-dense-*` | 密集面板默认 |
| 动效 | `--nm-t-fast/normal/slow/ui` | **不变**；`prefers-reduced-motion` 降 120ms |
| 微信域 | `--wx-*`（48） | **冻结**，仅聊天消息流内部 |

### 4.4 组件规范（保留 + 补决策表）

**保留**：kit 五件套是资产（97.2%），**不改组件 API**。

**补**：决策表（E1），核心分界：

| 需求 | 用 | 不用 |
|---|---|---|
| 同级视图切换（≤5 项，常驻） | `Segmented` | `Tabs` |
| 同级视图切换（>5 项 或 需滚动） | `Tabs` | `Segmented` |
| 阻塞式确认 / 需填写 | `Dialog` | `Drawer` |
| 侧边详情 / 不阻塞主流程 | `Drawer` | `Dialog` |
| 指标卡（单值 + 趋势） | `StatCard` + `StatGrid` | `Card` |
| 一般容器 | `Card` | `StatCard` |
| 确定无数据 | `EmptyState` | `EmptyMaybeSyncing` |
| 可能正在同步 | `EmptyMaybeSyncing` | `EmptyState` |
| 数值单元格 | `Mono` | 裸文本 |

---

## 5. 执行路线图（建议分阶段）

> 沿用仓库既有的 **B0–B5 批次闸门 + checkpoint + 阶段间 commit** 节奏；每阶段收口跑 `vitest-one.py --all` 全量（环境类失败为基线）。

| 阶段 | 内容 | 产出 | 闸门 | 状态 |
|---|---|---|---|---|
| **R0** | 冻结基线：跑 `ui:panel-audit` + 采纳率扫描，存档数字 | `tools/ui-token-baseline.py` + `.txt` | 数字可复现 | ✅ 完成 |
| **R1** | 令牌层（A1–A7）| `scifi-theme.css` + `light-theme.css` 改造 | 4,355 引用全绿；`build:ui` | ✅ 完成（+7 令牌） |
| **R2** | 前置门（B1–B5）收益最高 | 首见表面采纳率 ≥95% | 零裸色断言 + 守卫 | ✅ 完成（118→8 豁免；+19 令牌） |
| **R3** | dsw 别名层收编（原「聊天域边界」并入）| 35 个 dsw 转发 nm + 桥接层反转 | `dsw-alias-tokens.spec.ts` 9 例 + var() 环检测 | ✅ 完成（消 15 环） |
| **R4** | 结构闭环（D1–D6） | `ErrorState` + `LoadingState` 进 kit；46 处错误态 + 14 处加载态收编 | `state-components.wiring.spec.ts` 17 例 + 7/7 变异 | ✅ 完成（删 7 份重复错误样式；隐私扫描加真进度） |
| **R5** | 组件与文档（E1–E4） | `docs/UI-COMPONENT-GUIDE.md` | typecheck 5 份 | ✅ 完成（34 导出全覆盖） |
| **R6** | 按钮禁用态统一（追加轮） | 4 处野值 → `.5`；`button-disabled-tone.wiring.spec.ts` 4 例 | 变异 5/5 | ✅ 完成（零视觉变更；**更正了 R5 的焦点环误判**） |
| **R7** | 手写覆盖层无障碍接线（追加轮） | 12 个 `role="dialog"` 补 `useEscapeToClose` + `useDialogFocus`；`dialog-a11y.wiring.spec.ts` 5 例 | 变异 5/5 | ✅ 完成（净补 2 处真缺口；零视觉变更） |

**R3 说明**：原计划的「聊天域边界」（`.chatsMessages` 为 `--wx-*` 界）**不再需要**——`--wx-*` 是刻意的语义诚实例外（微信消息区要"原样微信"），已由 `check:wx-tokens` 的 47 断言 + `docs/compose/spec/wechat-message-visual-system.md` 管住，**不合并、不改造**。R3 的实际收获落在 `--dsw-alias-*`（外部 UI 库别名层）的收编上——它能与 nm 重复定义 27 处、并掩盖了 15 个 var() 环。

**R4 说明**：病灶不是"缺空/错/加载组件"，而是**同一语义各写一份**——`kitCss.error` 有 48 个调用点分布在 31 个面板，但 `role="alert"` 只覆盖 51 处、7 个面板另起炉灶定义了自己的 `.error`/`.errBanner`（同一语义 8 份样式），于是"出错"与"没数据"在视觉上分不开。R4 把 `ErrorState`（红框 + `role="alert"` + 可折叠详情 + 可选重试）与 `LoadingState`（`skeleton`/`compact`/`timed` 三档）**收进 kit**，样式落在 `kit.module.css` 的 `.error` 邻近处（**不新建 CSS 文件**，避开 `kit-css-split.wiring.spec.ts` 的跨份引用坑），然后**全量收编**：46 处错误态、14 处一行字加载态，删除 7 份自定义错误样式；顺带把 `PrivacyTrust` 三处「加载态复用 `.emptyInline`」的语义塌陷修掉、给 `RegionBoard` 空列补占位、给隐私体检（实测 `queryPrivacyScan` 1020ms，冷启更久）补上 `ProgressBar` + 已等待秒数。**收益：错误态与空态在视觉上第一次真正分得开，且新增面板直接复用两个组件即可拿全。**

**R5 说明**：kit 有 **34 个导出、66 个文件引用**，但**一直没有选型文档**——于是同一个问题在不同面板有不同解法（三种加载形态、8 份错误样式，正是 R4 要修的东西）。`docs/UI-COMPONENT-GUIDE.md` 补齐这一层：决策表（按"用户看到什么"选，不按"哪个组件更像"）+ 每个导出的契约与反直觉点 + 新面板标准骨架 + **已知缺口**。三份 UI 真源就此分工明确：`UI-GEOMETRY-SPEC`（数值）/ `UI-PANELS-PLAN`（审计）/ `UI-COMPONENT-GUIDE`（选型）。

**R6 说明（追加轮，2026-09-28）**：R5 把「裸 `<button>` 356 处 + 缺焦点环」列为下一重点，R6 核验后**两处都更正**——真实是 **335** 处；焦点环**不缺**（`scifi-theme.css` §5 的**元素级** `button:focus-visible` 早已覆盖全部，逐类检查会假阴性）。并且指出**「换成 `<Button>`」是错的方向**：60 个自定义类几乎全是「重」类、承担完整视觉，换标签只是套层皮；真正的收敛要删掉类的样式交给 variant，那会改视觉（按钮高 ~22px → ~30px），**属设计变更需单独授权**。R6 因此只做零视觉变更的部分：**4 处禁用态野值统一 `.5`**（唯一豁免 `profileDel` 的 `.3`——它的基准态即 `.5`，改 `.5` 会撞值）。**收益：全站按钮禁用态从 5 种收敛到 1 种，且有守卫防回归。**

**R7 说明（追加轮，2026-09-28）**：项目早有一套手写覆盖层的无障碍钩子（`kit-overlay.tsx` 的 `useEscapeToClose` / `useDialogFocus`），但**接线靠人肉**，漏了不会有任何编译错误。`chats-thread.tsx` 的注释记录过一次实测事故（Esc 关不掉、Tab 跑到抽屉背后，审计 P1-7）。R7 把全仓 **12 个** `role="dialog"` 手写覆盖层逐一点名核验，净补 **2 处真缺口**：

1. `chats-contact-info-view.tsx` —— 有 `data-st-dialog` 属性但全仓无人引用它（属性加了、hook 忘了），两条 hook 补在**组件内部**（该组件刻意自包含，`chats-view.tsx` 已近 M21 上限）。
2. `chats-media.tsx` 的图片查看器 —— 注释声称 "ESC/backdrop close"，实际是**自带 keydown 监听**：能关，但**不进 `escStack`**，之上再叠一层弹窗时一次 Esc 会关掉两层。已**收编**到 `useEscapeToClose`（方向键翻页保留）。

核验中**推翻了首版审计的错误结论**：按「同文件搜 hook」判缺口得出「9 个文件缺接线」，实际 12 个里 5 个是**跨文件**架构（属性在对话框组件、hook 在父级 `chats-msg-search.tsx` / `moments-panel.tsx` / `chats-thread.tsx`）。判据必须**全仓按名字配对**。

**变异抓出的守卫缺陷**（比 R6 更进一步）：首版用 `src.includes('useEscapeToClose')` 判「有没有调用」——那一行 `import { … } from '../ui/kit.tsx'` 同样含这个字符串，于是**删掉调用点守卫照样绿**（M1/M4 双绿）。改成钉**调用点**：`/[^A-Za-z0-9_$.]useEscapeToClose\s*\(/`。另一条 M3（删掉点名表里的一行）也绿——因为点名表只变短、没有下限哨兵，补 `NAMED_OVERLAYS.length >= 12`。**通用教训与 R6 一致：要敏锐就必须点名，而点名表本身也要有下限。**

**每阶段必备**：

- 守卫/spec 先行 + 变异测试（锚点唯一、必须变红、逐字节还原）；
- 收口链：`typecheck`（5 份）→ `vitest` → **`build:ui`（强制，CSS 语法错只有它抓得到）** → `build:backend` + `build:types`；
- 未获显式批准不推送。

---

## 6. 本方案明确不做的事

| 不做 | 理由 |
|---|---|
| **移动端 / 手机布局** | 项目为仅 Windows x64 的 Electron 应用，`minWidth: 960`，无 touch 落点 |
| **改动 `nav-config.ts` 的条目集合** | IA 已三次刻意合并；hidden 条目删除会造成深链静默失效（typecheck/build 都不报） |
| **合并 `--wx-*` 到 `--nm-*`** | 微信消息区要"原样微信"，是**语义诚实**的受控例外；合并会破坏 H5 的既有成果 |
| **推倒重来换色相** | 令牌层可承载换新；换暖色与"微信数据工具"语义冲突且与 `--wx-*` 打架 |
| **改组件 API** | kit 采纳率 97.2%，是资产 |

---

## 附：证据索引

| 证据 | 位置 |
|---|---|
| 令牌真源 | `src/client/ui-wechat/src/client/pages/wechat-data/scifi-theme.css`（R3 后 ~800 行；`--nm-*` 真源 + `--dsw-alias-*` 别名层（已转发 nm）+ `@property` 令牌级过渡） |
| 浅色主题 | `.../light-theme.css`（R3 后 ~140 行，`:root.theme-light`） |
| dsw 收编守卫 | `.../wechat-data/dsw-alias-tokens.spec.ts`（9 例：转发目标语义对口 / 无裸色 / 浅色不重复定义 / 桥接层不反向依赖） |
| R4 状态组件 | `.../wechat-data/ui/kit-fields.tsx` 的 `ErrorState` / `LoadingState`（经 `ui/kit.tsx` 的 `export *` 转发；样式在 `ui/kit.module.css` 的 `.error` 邻近处） |
| R4 收编守卫 | `.../wechat-data/ui/state-components.wiring.spec.ts`（17 例：红框与 `role="alert"` 绑定 / 加载态三档不复用空态视觉 / 全仓不得各自造错误样式 / 长任务必须有真进度 / 列表空态必须有占位） |
| R5 组件指南 | `docs/UI-COMPONENT-GUIDE.md`（kit 34 导出决策表 + 契约 + 新面板骨架 + 已知缺口；与本文、`UI-GEOMETRY-SPEC.md` 并列三份 UI 真源） |
| var() 环检测 | `theme.spec.ts`（30 例，含「引用图无环」+「无自引用 fallback」）+ `tools/r3-cycles.py` |
| 采纳率表 | `working/token-adoption.txt` |
| 断点/裸色扫描 | `working/visual-audit.txt` |
| 几何基线 | `docs/UI-GEOMETRY-SPEC.md` |
| 面板审计 | `docs/UI-PANELS-PLAN.md` + `scripts/panel-audit.mjs` |
| IA 真源 | `.../wechat-data/nav-config.ts` |
| 面板路由 | `.../wechat-data/WechatDataPanel.tsx`（switch + `DIALOG_SECTION_OF`） |
| 设置节 | `.../panels/settings-state.tsx`（`navItems`）+ `Settings.tsx` |
| 组件库 | `.../wechat-data/ui/*` |
| 平台边界 | `src/backend/main-window.js` + `package.json` |
| 微信消息体系 | `docs/compose/spec/wechat-message-visual-system.md` + `scripts/check-wx-tokens.js` |
