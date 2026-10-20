# Super Time 全站 UI 微信化改版 · 界面清单与逐屏改造建议

> 任务：共享任务 `task-1`（全量界面清单 + 逐屏改造建议）。
> 性质：**只读调研**。本文是唯一写入物，未改动任何代码 / 构建 / 脚本。
> 基线：仓库当前工作区（`nav-config.ts` 注释时间戳 2026-10-19；`WechatDataPanel.tsx` 注释 2026-10-17）。
> 口径：所有结论均以实际文件与选择器为依据；行号只在「装饰证据」里给出定位，代码改动后可能漂移，以选择器为准。
> 关联文档：[`UI-DENSITY.md`](./UI-DENSITY.md)（密度规范，Wave D1–D3 已完成）、[`BOOTSTRAP-RESPONSIVE.md`](./BOOTSTRAP-RESPONSIVE.md)（栅格/断点规约）、[`ARCHITECTURE.md`](./ARCHITECTURE.md)（进程与依赖方向）。

---

## 0. 一页结论（先给决策者）

1. **冲突在「皮肤层」，不在「布局骨架」。** 全站视觉身份是 NEON MATRIX：深空黑 + 霓虹青 `#00f0ff` / 紫 `#a855f7` + 毛玻璃 + 发光（令牌定义在 `src/client/ui-wechat/src/client/pages/wechat-data/scifi-theme.css`，浅色覆盖在 `light-theme.css`）。微信官方主题是「白/浅灰底、单一品牌绿、1px 分割线、无阴影、无渐变」。因此改版的第一刀应落在**令牌 + 共享组件**（一处改、144 个面板视图受益），而不是逐页堆补丁。
2. **布局骨架应保留密度成果。** `docs/UI-DENSITY.md` 的 A 层（`ui/compact-chrome.module.css`）已经把页头 ≤44px、统计区 ≤52px、卡片头 ≤36px、单滚动容器等约束固化；本次改版**不得回退**这些指标，只应在其上做「去装饰、减重复、统一层级」。
3. **重复内容集中在 4 类**：① 页头标题 ≈ 侧栏名/分段名；② 页头说明 ≈ 数据口径注释（"仅本地计算""数据来自消息库"）；③ 统计卡墙（4–8 张 `StatCard`）；④ 工具栏动作（刷新 / 导出 / 批量 / 同步）与三层筛选。统一为「标题一行 + 一行说明 + ≤2 动作 + 更多▾」。
4. **弹层有 4 套实现**：kit `Dialog`、kit `Drawer`、自绘 `calOverlay`（会话导出/日历/聊天记录/已编辑/图片查看器）、自绘 `moments overlay`（导出/灯箱/详情）以及 `files-lightbox`。微信心智只有「一个模态 + 一个抽屉」，应统一到 kit 两种。
5. **首启链路视觉噪声最重、也最该先改**：启动页有 Canvas 粒子、4 张全屏背景图、极光/网格/扫描线/HUD 角、渐变标题与发光按钮，以及大量英文装饰标签（`TELEMETRY`、`SYSTEM BOOT`、`STAGE 01/04`、`CONSENT REQUIRED`）。此外启动页文案已与 `nav-config.ts` 漂移（见 GT-03）。P0。

**改动量级（只读统计，供排期）**：`src/client/ui-wechat/src/client/pages/wechat-data/` 下 149 个非 spec TSX（约 3.68 万行）、64 个面板 CSS（合计约 994 KB）；改造面按「令牌 2 + 共享 kit 4 + 外壳 6 + 首启 12 + P0 面板 7」计，首轮约 31 个文件，远小于 144 视图。

---

## 1. 调研口径与基线事实

### 1.1 信息架构数字（以代码为准）

| 事实 | 数值 | 依据 |
|---|---:|---|
| 侧栏分组 | **5 组** | `nav-config.ts` 的 `NAV_GROUPS` |
| 侧栏可见条目 | **15 项** + 底栏「设置」1 项 | `WechatDataPanel.tsx` 头注；`nav-config.ts` 中非 `hidden` 且 `tab !== 'settings'` 的条目 |
| 可路由页签 | **39** | `WechatDataPanel.tsx` 头注（`TAB_LABELS` 由 `NAV_GROUPS` 含 hidden 项构建） |
| 合并面板外壳 | **9 组**（`WechatDataPanel.tsx` 8 处 + `KbShell.tsx` 1 处） | `panels/MergedSections.tsx`、`panels/KbShell.tsx` |
| 设置弹窗内节 | **15 节 / 5 组**（配置向导 5 + 智能与隐私 3 + 授权与更新 2 + 维护与自检 4 + 高级 1） | `panels/settings-state.tsx` 的 `createSettingsNavItems`；`Settings.tsx` 的 5 个 `sectionGroupTitle` |
| 首启闸门 | 3 道（启动引导 → 隐私同意 → License 授权）+ 手机浏览器令牌门 | `ui-entry.tsx` 的 `WechatApp` / `Root` |

> ⚠️ 代码内的**注释数字已互相漂移**：`Settings.tsx` 一处写「13 节」、另一处写「15 节」；`onboarding-content.tsx` 的 `FEATURE_GROUPS` 注释写「9 组」而实际固定为 5 组；`WechatDataPanel.tsx` 头注自称「5 组 / 15 项 / 39 页签」与 nav-config 一致。改版时应把「数字真源」收敛到 `nav-config.ts` 与 `settings-state.tsx`，并在文案里删除手写数字（见 §7）。

### 1.2 外壳几何（固定值）

| 元素 | 当前值 | 依据 |
|---|---|---|
| 自绘标题栏 | 38px 高，左品牌 + 右状态/主题/最小化/全屏/关闭 | `titlebar.css` `#titlebar`、`index.html` `#titlebar` |
| 侧栏 | 折叠 58px / 展开 176px；**默认展开**、不持久化 | `wechat-data.module.css` `.sidebar`、`WechatDataPanel.tsx` `navOpen` |
| 内容区 | padding 16px，自身滚动；面板内再自管滚动 | `wechat-data.module.css` `.content` |
| 设置弹窗 | `min(1080px, 96vw)` × `min(90vh, 1060px)` | `wechat-data.module.css` `.settingsDialog.settingsDialog` |
| 通用 Dialog | `min(520px, 92vw)`，`max-height: 84vh` | `ui/kit-overlay.module.css` `.dialog` |
| 通用 Drawer | `min(560px, 92vw)` 右侧滑出 | `ui/kit-overlay.module.css` `.drawer` |
| 手机档断点 | **≤560px**（与 `PHONE_QUERY` 同值，禁止改为 576） | `wechat-data.module.css` 尾部；`BOOTSTRAP-RESPONSIVE.md` §2 硬规约 7 |
| 启动页舞台 | 固定设计尺寸 1180×760，窗口小则整体等比缩放 | `onboarding/runtime.ts` `STAGE_W/STAGE_H` |

### 1.3 既有约定（改版必须遵守，避免与已交付工作冲突）

1. **密度不许回退**：`fixedRatio`（1440 ≤20% / 1280 ≤28%）、`headerH` ≤44px、`statH` ≤52px（overview 例外 ≤96px）、`cardHd` ≤36px、`toolbarH` 单行 ≤48 / 两行 ≤88、数据行 28–34px、`emptyRatio` 目标值。依据 `docs/UI-DENSITY.md` §1–§2。
2. **A 层唯一入口**：全站紧凑覆盖只能通过 `ui/compact-chrome.module.css`（`WechatDataPanel.tsx` 具名导入并在根节点挂 `.compactChrome`），不得逐面板重复抄写。
3. **Bootstrap 只借类**：`bootstrap-grid` + `bootstrap-utilities` + `bootstrap-bridge.css`，不引全量、不引 JS；CSS import 顺序不得早于主题（`ui-entry.tsx` 头注）。
4. **禁止 `!important`；间距只用 4/6/8/10/12/16**（`theme-geometry` 守卫）；圆角只用令牌或 0。
5. **禁止 `d-none` 隐藏业务内容**；表格滚动而非裁切；模态/抽屉窄屏全屏 sheet（`BOOTSTRAP-RESPONSIVE.md` §2）。
6. **行数棘轮**：`function-size-ratchet` 限制了多个大函数的行数（`Chats` / `Records` / `Settings` 等），删改页面时不能顺手把逻辑堆回大函数；1000 行文件上限同样生效（`OnboardingShell` 曾被拆分）。
7. **面板高度链**：`kit.module.css` `.panelShell`（定高、自滚）与 `.panelBody`（页头固定、正文滚动）是统一契约；删除/新增滚动容器会破坏密度审计与响应式审计。

---

## 2. 外壳与全局组件（SH）

| ID | 界面 / 触发 | 入口文件 · 主 CSS | 结构（固定区 / 滚动区） | 重复 / 冗余 | 装饰证据（文件:选择器） | 层级/布局问题 | 微信化改造要点 |
|---|---|---|---|---|---|---|---|
| SH-01 | 自绘窗口标题栏（拖拽区 + 窗口控制 + 主题） | `src/client/ui-app/index.html` `#titlebar`；`ui-entry.tsx` `initTitlebar()`；`titlebar.css` | 38px 固定条：左 logo+`Super Time`，右 `#tb-status` + 主题 + 最小化 + 全屏 + 关闭 | 品牌名同时出现在标题栏、侧栏 `.navBrandName`、启动页三处 | `titlebar.css` `.tb-logo`：青色底 + 青边框 + `border-radius`；`titlebar.css` `.tb-btn:hover` 中性 hover（OK）；关闭键 `#e81123`（平台色，保留） | 标题栏与侧栏品牌区重复占位；38px 内塞 6 个控件，状态区窄窗被 `display:none`（`@media max-width:720`） | ① 删 `.tb-logo` 的青色发光块，改为纯文字或 18px 头像；② 品牌名只留标题栏一处，侧栏顶部改为「微信账号头像 + 账号名」；③ 标题栏底色改为与内容区同色 + 1px 下边框，去掉「另一套导航」的观感 |
| SH-02 | 标题栏状态区（打开网页 / 模型余额 / 数据就绪） | `src/client/ui-app/titlebar-status.tsx`；`titlebar-status.css` | 独立 React root，横向胶囊：`打开网页` 按钮 + `SidebarBalance` + 数据状态点 | 「数据就绪」状态与侧栏/总览的"数据不可用"提示语义重复 | `titlebar-status.css` `.tb-webBtn` 青色描边胶囊；`.tb-apiTag[data-status='online'] .tb-statusDot`：`box-shadow: 0 0 8px` + `animation: nm-pulse-glow 2.2s infinite` | 三个状态胶囊 vs 窗口按钮同排，视觉重量比窗口控制更重；窄窗直接消失（可接受） | ① 去发光与呼吸动画，状态点改 6px 实心圆；② 「打开网页」降为文字按钮或收进「更多」；③ 状态文案统一「在线 / 离线 / 检测中」（与全站同一份词表） |
| SH-03 | 侧栏导航壳（品牌 / 搜索 / 折叠 / 5 组 / 设置） | `WechatDataPanel.tsx`（`<aside>` 部分）；`nav-config.ts`；`wechat-data.module.css` | 固定列：品牌 30px → 搜索框 → 折叠开关 → 可滚 `nav`（5 组）→ 底栏设置；`overflow:hidden` + 边缘渐隐/箭头 | 品牌名与副标题「微信数据工作台」；组名「概览 · 问答 · 总结」等 5 行；设置同时可被「设置」深链打开 | `wechat-data.module.css` `.panel::before`：48px 网格 `linear-gradient` + 径向 mask；`.navBrandLogo`：径向+线性渐变 + `box-shadow 0 0 12px`；`.navItem[data-active]`：`box-shadow: inset 0 0 20px` + `::before` 青色 3px 竖条 `box-shadow: 0 0 8px`；`.navHint`：`drop-shadow` + `nav-hint-bob` 无限浮动；手机档 `.sidebar` `backdrop-filter: blur(16px)` | 默认展开 176px 吃掉内容宽；组标签 + 15 条 + 设置 = 16 行，1280×800 下需滚动（已用渐隐提示）；激活态用「青竖条+青字+内发光」三重表达 | ① 侧栏底改为 `#F7F7F7`（深色 `#191919`），选中态 = 浅绿 `#E8F7EE` + 绿字，**删竖条与内发光**；② 删网格背景 `::before`、删 logo 渐变/发光，品牌位改「账号头像 + 名」；③ 组标签改 11px 常规字重、字色 `#7F7F7F`，去掉大写字母间距；④ 边缘箭头保留但去浮动动画（静态小箭头即可） |
| SH-04 | 全局搜索（Ctrl/Cmd+K） | `panels/global-search.tsx`；`global-search.module.css`；宿主 `WechatDataPanel.tsx` | 搜索框在侧栏内；结果面板 `createPortal` 到 body，按触发器位置定位，宽 `min(420, …)`；结果分 7 组（会话/消息/联系人/朋友圈/收藏/文件/记录） | 「搜索会话」与面板内搜索、消息搜索（`搜消息`）语义重叠；7 个分组在结果里全部平铺 | `global-search.module.css`：结果面板 `box-shadow` + （见 SH-03 侧栏玻璃） | 7 组结果无主次；空结果/读失败/加载三态与面板内搜索文案不统一（"未找到相关结果" vs "未找到相关消息"） | ① 结果按「会话、消息」优先分组，其余收进「更多结果 N 条」；② 分组标题去掉大写英文风，统一 11px 灰字；③ 定位面板改白底 + 1px 边框 + 小阴影（微信搜索面板样式） |
| SH-05 | 右下角主动提醒卡（更新/许可证临期） | `panels/NoticeBanner.tsx`；`notice.module.css` | `position:fixed` 右下堆叠卡；可拖动（`use-draggable.ts`）；每卡标题+说明+≤2 动作+关闭 | 与「设置 → 授权与更新」两张全量卡重复同源信息 | `notice.module.css`：`backdrop-filter`（3 处）、发光点（`box-shadow` 1 处） | 悬浮卡与首次配置向导卡（左下）同时出现时，两个角各挂一张大卡；关闭仅本会话生效（产品已定） | ① 去毛玻璃/发光，改白卡+1px 边框+轻阴影；② 两卡合并为一个「待办提醒」入口（角标 + 点开列表），默认只显示一行；③ 颜色只用于左侧 3px 状态条 |
| SH-06 | 左下角首次配置向导卡 | `panels/SetupGuide.tsx`；`setup-guide.module.css`；判定 `setup-guide.ts` | `position:fixed` 左下可拖动卡；四步清单（检测账号/数据库密钥/图片密钥/图片解码；语音为可选项）+ 进度 + 「去配置」「稍后」 | 与「设置 → 配置向导」同一套步骤重复；与 SH-05 同时占两角 | `setup-guide.module.css`：2 处 `box-shadow`、1 处渐变 | 与设置弹窗抢注意力；首次进入主界面时两张浮卡遮挡内容 | ① 与 SH-05 合并为**单张**「首次配置」卡，7 天内只出现一次；② 去掉拖动把手，固定右上或内容区顶部一行 44px 引导条（微信「服务通知」式），配完永久消失；③ 步骤名与设置左导航逐字一致（现文案一致，保持） |
| SH-07 | 手机端外壳（底部 tab + 更多 sheet） | `ui/mobile-nav.tsx`；`ui/mobile-nav.module.css`；`wechat-data.module.css` `@media max-width:560` | ≤560：侧栏塌成顶部 56px 搜索条；底部 4 高频 + 「更多」5 格栏；更多 = 全屏 sheet，3 列分组卡；设置进「更多」 | 手机端「更多」白名单 9 条与桌面 15 条不一致（有意收窄，但用户会问"为什么少"） | `mobile-nav.module.css` `.bar`：`backdrop-filter: blur(16px) saturate(1.4)` + `box-shadow: 0 -4px 24px`；`.barItem::before` 激活条 + `box-shadow: 0 0 10px` | 56px 栏 + 搜索条 + 内容 padding，375px 下可用高被压掉 ~112px | ① 底栏去模糊与发光，白底 + 0.5px 上边框；② 激活态只保留绿字 + 2px 顶部条（删外发光）；③ 更多 sheet 去掉分组圆角卡，改微信「设置」式分组列表（组名灰字 + 白底行） |
| SH-08 | 启动检查屏 / 「已收起」屏 / 后端与调试横幅 | `ui-entry.tsx`（`WechatApp` 内联 JSX + `bannerStyle`） | 全屏居中：微信气泡图标 + "正在检查本机状态…" + 说明；已收起屏 = 图标 + 标题 + 说明 + 一个按钮；横幅为 body 顶部插入的 div（内联样式） | 「已收起」屏与托盘、标题栏语义重复；调试/后端横幅三套硬编码色（`#b91c1c` / `#b45309` / `#7c3aed`） | `ui-entry.tsx`：检查屏与已收起屏用 `--nm-cyan` + 发光边框按钮（`--nm-cyan-35/10`）；横幅内联 `background:#7c3aed` 等 | 启动检查屏无品牌层级（只有一图标 + 两行小字）；三个横幅样式各自为政 | ① 启动检查屏改微信启动态：居中 32px 灰字「正在准备…」+ 底部 1px 进度条；② 已收起屏保留一个绿色主按钮即可；③ 三条横幅统一为同尺寸、同字号的页面顶部条（只换左侧状态色），并移出内联样式进 CSS |
| SH-09 | 通用合并外壳（9 组顶部分段条） | `panels/MergedSections.tsx`；`panels/merged.module.css` | 顶部 `Segmented` 一行（+ 右侧可选 `trailing`，知识库库切换）→ 下方嵌入原子面板（各自仍带 `PanelHeader` + `panelBody`） | 「分段条 + 子面板页头标题」双标题：朋友圈/收藏/总结/年度报告/媒体资产等直接重复 | `merged.module.css` 装饰为零（干净，可作为改造模板）；`kit-overlay.module.css` `.segItem[data-state='on']` 用青色底 | 分段条与子面板页头之间仅 14px；子面板页头再次说「这是什么」，一屏两个标题；知识库 `trailing` 库切换器与分段条混排（语义一层级不同） | ① 规定：**合并组内子面板不再画完整 PanelHeader**，只保留一条 36px 工具行（标题可省，操作保留）；② 分段条样式统一为微信「文字 + 下划线」或「胶囊」，全站只用一种；③ 库切换器提升为独立一行（作用域与视图分开） |
| SH-10 | 通用弹层（Dialog / Drawer / Confirm） | `ui/kit-overlay.tsx` + `kit-overlay.module.css`；`ui/confirm.tsx` + `confirm.module.css` | Dialog 居中 `min(520,92vw)`；Drawer 右侧 `min(560,92vw)`；均带 Overlay + 焦点管理；Confirm 独立遮罩 + 弹入动画 | 与自绘 `calOverlay` / `moments overlay` 并存（见 §5） | `kit-overlay.module.css` `.dialogOverlay/.drawerOverlay`：`backdrop-filter: blur(2px)` + 深色 60%；`.dialog/.drawer` `box-shadow: var(--nm-shadow-popup)`；`confirm.module.css` 遮罩 `blur(3px)` + `confirmPop` 弹性动画 | 弹窗圆角 20（`--nm-r-xl`）、阴影极深；遮罩模糊在大面积上耗性能；`confirmPop` 回弹与微信克制不符 | ① 圆角 12、阴影改 `0 8px 24px rgba(0,0,0,.12)`、遮罩改纯 40% 黑无模糊；② 动画改 150ms 淡入/位移 4px；③ 明确全站只允许 kit Dialog/Drawer 两种弹层，自绘弹层按 §5 逐步替换 |

---

## 3. 首启三道闸门与手机令牌门（GT）

**闸门顺序（`ui-entry.tsx`）**：`debugGates` 事实 → `onboardingDone && consented && isLicenseUsable(lic)` 三者齐备才 `openWechat()`；未过时渲染 `OnboardingShell`（4 页 + [隐私同意] + 授权），声明升版单独渲染 `PrivacyConsentGate`；授权第二层是 `LicenseGate` 包住 `WechatDataPanel`；浏览器态最外层是 `BrowserSession` 令牌门。调试/浏览器豁免时跳过本地三闸门（`bypassLocalGates`）。

| ID | 界面 / 触发 | 入口文件 · 主 CSS | 结构（固定区 / 滚动区） | 重复 / 冗余 | 装饰证据（文件:选择器） | 层级/布局问题 | 微信化改造要点 |
|---|---|---|---|---|---|---|---|
| GT-01 | 启动页外壳（4 内容页 + 2 闸门 + 页头/页脚） | `src/client/ui-app/onboarding/OnboardingShell.tsx`；`onboarding.module.css`；`onboarding-stage.module.css`；`onboarding-stages.module.css`；`runtime.ts` | 固定舞台 1180×760（等比缩放）：背景层栈 → 顶部品牌+标签+主题 → `neonRule` 分隔 → 可滚 `main`（各页）→ 页脚（进度环/圆点/STAGE 文本 + 上/下一页/进入系统）；滚轮/方向键翻页 | 页脚「STAGE 01/04」「已浏览 N」与进度环、圆点三重表达同一件事；顶部品牌与主标题都写 Super Time；`Onboarding · System Boot` 与产品无关 | `onboarding-stage.module.css` `.bgStack` 多背景 + `.stageWash` 极光；`.bgGrid` 网格（201-218）；`.scanlines` 扫描线（227-240）；`.geoRing/.geoDot` 发光圆环圆点（312-323）；`.hudFrame` 四角 HUD；`onboarding.module.css` `.neonRule`、`.moduleCard` 渐变/发光；`onboarding-stages.module.css` 渐变标题（114-121）、`text-shadow` 多处；`particles.tsx` Canvas 粒子 + 连线 + 汇聚脉冲 | 固定舞台在 1280×800 实际缩放 ~0.93，字小且四周留黑；背景四张 WebP（`STAGE_BGS`）与粒子抢内容；页脚一行 4 类控件；英文装饰标签破坏"中文、克制" | ① **删全部背景图层**（bgStack/bgVeil/stageWash/bgGrid/particles/scanlines/geoRing/geoDot/hudFrame），只留 `#F7F7F7` 纯色或微信登录页式浅灰；② 舞台改为**自适应单列**（max-width 720，上下滚动），取消 1180×760 固定缩放的"演示文稿感"；③ 页脚只保留「上一步 / 下一步（或进入系统）」+ 一行页码文本，删进度环与圆点；④ 所有英文装饰标签删掉或改中文（`SYSTEM BOOT`→无、`TELEMETRY`→无、`STAGE 01/04`→`第 1 步 / 共 4 步`） |
| GT-02 | 启动页①首页（hero + 三步开始 + 高频问法 + 系统概览） | `src/client/ui-app/onboarding/pages/HomePage.tsx`；`onboarding-content.tsx`（`FIRST_RUN_STEPS`/`QUESTION_CARDS`）；`onboarding.module.css`/`onboarding-stages.module.css` | 左列 hero + 三步；右列 rail「TELEMETRY」四个统计（MODULES 15 / REMOTE API 212 / RUNTIME / PLATFORM）；下方 4 张高频问法卡 | rail 标题 `TELEMETRY` 与隐私同意页「没有遥测」**直接矛盾**（详见 §6 D9）；「三步开始」与 HelpPage 四步、FeaturesPage 分组三重讲同一件事；MODULES/REMOTE API 是开发者指标，对用户无意义 | `onboarding-stages.module.css` `.heroTitleAccent` 渐变文字；`.railStat`/`.moduleCell` 卡片渐变 + 光晕；`Reveal` 入场动画（`onboarding.module.css` `riseIn`） | 首页信息量超过首启第 1 屏应承担的量（4 张问法卡 + 4 项指标 + 3 步）；右栏开发者指标造成"技术演示"观感 | ① rail 整块删除（或只保留「本机 / 离线」一句）；② 三步开始保留，措辞改为动词短句（"选数据目录""等解密""开始提问"）；③ 高频问法 4 张 → 2 张示例问句，其余放 HelpPage；④ 去渐变文字/光晕/入场动画 |
| GT-03 | 启动页②功能引导（按侧栏分组） | `src/client/ui-app/onboarding/pages/FeaturesPage.tsx`；`onboarding-content.tsx` `FEATURE_GROUPS` | `StageHead`（02 功能引导）+ 5 张分组行：序号 + 图标 + 组名 + 说明 + 条目 chips | **内容已与 nav-config 漂移**：`FEATURE_GROUPS` 注释写「9 组」，实际 5 组；「会话与消息」仍列「通话记录」为独立项（现为 chats 分段）；「行动与维护」仍列「隐私体检」「数据边界与出网」为独立项（现全部在设置弹窗内）；`导航与启动页漂移` 守卫只校验分组名与顺序 | `onboarding-stages.module.css` `.featureBadge` 图标底、`.chip` 胶囊、`featureRow` 卡片 + `Rise` 动画 | 5 张等权卡片，用户记不住；chips 共 30+ 个，超过一屏；与 Overview 的功能入口重复 | ① 组数/条目**从 `NAV_GROUPS` 现算**，禁止手写（同时修复 9→5 漂移）；② 每组只保留一行说明 + 一组 chips（≤5）；③ 若首页已讲三步，本页改为单屏「5 组导航一图流」 |
| GT-04 | 启动页③使用说明（四步 + FAQ + 注意） | `src/client/ui-app/onboarding/pages/HelpPage.tsx`；`onboarding-content.tsx` `HELP_STEPS`/`FAQ`/`NOTICES` | 左列 4 步（每步「做完应看到什么」）+ 2 条注意；右列 5 条 FAQ | 与首页「三步开始」重复（步骤内容几乎一样）；FAQ 与「关于」页的边界说明重复 | `onboarding-stages.module.css` `.step` 卡、`.notice` 卡；`Reveal` 入场 | 两列高度不等导致右列空；「做完应看到什么」是好设计但每条 2–3 行，合计很长 | ① 与首页三步**合并成一份**「首次配置」清单（3 步 + 1 个可选项），HelpPage 只留 FAQ；② FAQ 从 5 条压到 3 条（登录不上 / 图片不显示 / 数据在哪删） |
| GT-05 | 启动页④关于（版本 + 数据位置 + 出问题时） | `src/client/ui-app/onboarding/pages/AboutPage.tsx`；`runtime.ts` `APP_VERSION` | 两栏卡：左「它是什么」+ 版本表；右「数据在哪/怎么删/怎么断网」+「出问题时」 | 数据位置/删除/断网在「隐私同意」页也逐条写过；版本表（Electron/Chromium/Node）对用户价值低 | `onboarding-stages.module.css` `.aboutBlock` 卡片、`metaList` | 版本表占 5 行；两栏布局在缩放下字过小 | ① 版本只保留「应用版本 + 构建号」两行，其余进诊断日志；② 数据位置压成一句 + 一个「打开数据目录」按钮；③ 与隐私同意页去重：这里只留"去哪看完整声明"链接 |
| GT-06 | 隐私同意屏（启动页第 5 站 / 声明升版独立屏） | `src/client/ui-app/privacy/PrivacyConsentGate.tsx`；`PrivacyConsentGate.module.css`；`consent.ts` | `embedded=false` 时自己画页头（eyebrow + h1 + lead + 三条底线）；两栏 `grid`：左「一句话结论 + 三节说明 + 你的控制」，右「出网点逐条 + 入站监听」；两栏各自滚动；底部固定同意条（勾选 + 不同意退出 + 同意并继续） | 页头「隐私与数据边界」与启动页 `StageHead` 同名（embedded 时已避免）；「一句话结论」与下文三节重复；两栏内容密度差异大 | `PrivacyConsentGate.module.css`：`.pageHead` 渐变（210）、`.consentBar` 按钮渐变+发光（588-589）、行高亮 `box-shadow`（98） | 两栏各自滚动（两个滚动条）；固定同意条高度 ~92px；法律文本密集但无目录/折叠，首屏读完成本高 | ① 单列单滚动（max-width 760），同意条 sticky 底部；② 顶部加 3 条 TL;DR（数据只在本机 / AI 只发你自己配的模型 / 无遥测），正文用可展开小节；③ 按钮去渐变，主按钮微信绿、次按钮白底灰边；④ 保留"逐条出网点"——这是合规资产，不要删 |
| GT-07 | License 授权站（启动页最后一站）+ LicenseGate 兜底解锁页 | `src/client/ui-app/onboarding/OnboardingShell.tsx`（授权站）；`src/client/ui-app/license/LicenseAuthPanel.tsx`；`LicenseGate.tsx`；`license-gate.module.css` | 授权站 = `StageHead` + `LicenseAuthPanel compact`（两栏：左状态/步骤/明细/到期提醒，右导入按钮/粘贴框/常见问题/提示）；`LicenseGate` = 全屏 `lock` + 品牌 + 标题 + 导语 + meta + 三按钮 + 流程提示 | 站内页头「License 授权验证」+ 面板标题「已授权/未授权」+ 三步 + FAQ + 底部提示，同一件事说 4 遍；`LicenseGate` 与 `LicenseAuthPanel` 两套解锁页并存 | `license-gate.module.css`：`.lock` 双径向渐变（9-10）、`.card` `blur(12px)` + 深阴影（24-25）、`.brand/.title` 渐变文字（41/217/317）、`.primary` 渐变+发光（121-122） | 两栏各自滚动；右栏 FAQ 3 条 + paste 框很高；「选择 license.json 导入 / 校验并导入 / 导出激活请求」三按钮语义接近 | ① 合并为一个解锁组件，删「三步走」与底部提示重复（保留步骤在按钮上方一行）；② 去渐变/玻璃/发光，白卡 + 灰底；③ 按钮层级：主「导入许可证」、次「导出激活请求」、文字链「重新校验」；④ 粘贴框默认折叠（高级路径） |
| GT-08 | 手机浏览器令牌门（进主界面前） | `src/client/ui-app/browser-gate.tsx`；`browser-gate.module.css` | 全屏单卡：checking（spinner + 文案）/ gate（标题 + 说明 + 配对码输入 + 进入 + 注意）/ ready（离线横幅 + 应用）；会话丢失自动回到 gate | 说明文字同时提到「打开网页」与「扫码/输入配对码」两种入口，略长；令牌门标题 `Super Time` 与主界面品牌重复 | `browser-gate.module.css` 仅 spinner 旋转动画；**无渐变/发光/毛玻璃**——是全仓最接近微信克制风格的一屏，可作为改版视觉基线 | 卡片宽、说明 3 段（含 Wi-Fi/防火墙排查），手机上首屏需滚动 | ① 保留现有克制风格；② 说明压成两行 + 可展开「连不上怎么办」；③ 输入框/按钮统一微信尺寸（48px 高）与绿色主按钮；④ 保留"错误与没有结果分开"的文案纪律 |

---

## 4. 侧栏 5 组、全部合并分段与逐屏改造（NV）

### 4.1 侧栏 → 分段 → 入口映射（覆盖全部可见项与合并分段）

| 组 | 侧栏可见项（tab） | 面板内固定分段（合并外壳） | 入口组件 | 主 CSS | 合并外壳 |
|---|---|---|---|---|---|
| 概览 · 问答 · 总结 | 数据总览 `overview` | —（单页，卡片可折叠） | `panels/Overview.tsx` → `panels/overview-panel.tsx` | `panels/overview.module.css` | — |
|  | 微信问答 `ask` | —（右侧引用详情滑出） | `panels/Ask.tsx` | `panels/ask.module.css` | — |
|  | 总结 `dailysummary` | 总结 / 年度报告（`annual`） | `panels/SummaryWorkbench.tsx` / `panels/Annual.tsx` | `summary-workbench.module.css` / `annual.module.css` | `MergedSections`「总结与报告视图」 |
|  | （hidden）周期报告 `period` | 折进「总结」的时间范围选择器（无独立界面） | 同 `SummaryWorkbench` | 同左 | 同上 |
|  | 知识库 `kb` | 文件 `kbfiles` / 笔记库 / 知识图谱 `knowledge` + 左库 rail | `panels/KbShell.tsx`（内部 `KbFiles.tsx`、`KnowledgeBase.tsx`、`Graph.tsx`） | `kb-shell.module.css` + `kbfiles.module.css` / `knowledge-base.module.css` / `graph.module.css` | `KbShell` 内嵌 `MergedSections` |
| 会话与消息 | 聊天会话 `chats` | 聊天消息 / 通话记录 `calls` / 撤回消息 `revoked`；聊天内再分类 全部/公众号/服务号/客服 | `panels/Chats.tsx` → `chats-view.tsx`；`panels/Calls.tsx`；`panels/Revoked.tsx` | `chats.module.css` + `chats-rows.module.css` + `chats-cards.module.css` + `chats-shell.module.css`；`calls.module.css`；`list-panel.module.css` | `MergedSections`「消息视图」 |
|  | 群聊分析 `groupinsights` | 离线洞察 / 活跃监控 `monitor` | `panels/GroupInsights.tsx`；`panels/Monitor.tsx` | `group-insights.module.css`；`monitor.module.css` | `MergedSections`「群聊分析视图」 |
| 关系与社交 | 通讯录 `contacts` | 通讯录 / 社交图谱 `graph` | `panels/Contacts.tsx`；`panels/Graph.tsx` | `contacts.module.css`；`graph.module.css` | `MergedSections`「联系人与社交视图」 |
|  | 朋友圈 `moments` | 朋友圈 / 朋友圈洞察 `momentsinsights` | `panels/MomentsOptimized.tsx` → `moments-panel.tsx`；`panels/MomentsInsights.tsx` | `moments.module.css`；`moments-insights.module.css` | `MergedSections`「朋友圈视图」 |
| 资产与资金 | 收藏与表情 `favorites` | 我的收藏 / 表情包 `emoticons` / 收藏表情统计 `assetinsights` | `panels/Favorites.tsx`；`panels/Emoticons.tsx`；`panels/AssetInsights.tsx` | `list-panel.module.css`；`asset-insights.module.css` | `MergedSections`「收藏与表情视图」 |
|  | 文件与存储 `files` | 文件资产 / 媒体资产 `mediaassets` / 存储分析 `storage` / 公众号文章 `officialassets` | `panels/Files.tsx`；`MediaAssets.tsx`；`Storage.tsx`；`OfficialAssets.tsx` | `list-panel.module.css`；`media-assets.module.css`；`storage.module.css`；`official-assets.module.css` | `MergedSections`「文件与存储视图」 |
|  | 资金往来 `ledger` | 月度汇总 / 转账红包明细 `records` | `panels/Ledger.tsx`；`panels/Records.tsx` | `ledger.module.css`；`records.module.css` | `MergedSections`「资金往来视图」 |
| 行动与维护 | ClawBot集群 `clawbot` | 集成设置 / 接入会话（内嵌实例 rail + Segmented） | `panels/ClawBotPanel.tsx`（+ `clawbot-settings.tsx` / `clawbot-chat.tsx` / `clawbot-rail.tsx`） | `clawbot.module.css` | 自带 Segmented（非 `MergedSections`） |
|  | 待办日程 `tasks` | — | `panels/Tasks.tsx` | `tasks.module.css` | — |
|  | 任务信息 `taskinfo` | —（双栏：任务 / 触发记录） | `panels/TaskCenter.tsx` | `task-center.module.css` | — |
|  | 操作日志 `oplog` | —（长表 + 筛选） | `panels/OperationLogPanel.tsx` | `oplog.module.css` | — |
|  | 设置 `settings`（底栏，非 nav 组内） | 弹窗内 15 节 / 5 组 | `WechatDataPanel.tsx` 的 `<Dialog>` → `panels/Settings.tsx` | `settings.module.css`（+ `settings-accounts/models/remote-access`） | — |

> 深链改道（`DIALOG_SECTION_OF`）：`#settings→detect`、`#privacytrust→boundary`、`#privacy→privacy`、`#backup→backup`、`#health→health`、`#hook→hook`。改造时这几个 hidden tab 的 id 与改道表**不能删**，否则深链会静默落回总览。

### 4.2 第 1 组：概览 · 问答 · 总结

| ID | 界面（tab） | 入口文件 · 主 CSS | 固定区 → 滚动区（卡片/列表关系） | 重复内容 | 装饰证据（文件:选择器） | 层级/布局问题 | 微信化改造要点 |
|---|---|---|---|---|---|---|---|
| NV-01 | 数据总览 `overview` | `panels/overview-panel.tsx`（`Overview.tsx` 转发）；`panels/overview-sections.tsx`；`panels/overview.module.css` | 固定 `PanelHeader`（3 动作）→ `panelBody` 滚动：8 张 KPI `StatCard`（2/3/4 列两行）+ ≤44px 消息构成条 + **14 张分析卡**（趋势/热力/世界地图/地区/词云/交互/关系/朋友圈作者/内容资产/存储构成/撤回/清理建议/资金/健康），Bootstrap row/col、卡片可折叠 | 标题「微信数据总览」≠ 侧栏「数据总览」；说明「本机微信数据资产一屏纵览 · 最后更新 …」；KPI、构成条、内容资产卡三处重复统计消息类型；「导出全部会话 ZIP」与「导出▾（MD/JSON/PNG/JPG）」两组导出 | `overview.module.css` `.scanbar` 渐变扫描条 + `ov-scan` 无限动画（197-211）；`.updating .metric` 呼吸（213-221）；`.barFill/.topFill` 青紫渐变 + 发光（48-50/113/119-120）；`.exportMenu` `backdrop-filter: blur(12px)`（236）；`ui/kit.module.css` `.panelShell` 径向渐变底（375）；另：`panels/overview-neon.module.css`（30KB，极光/玻璃/渐变文字/粒子注释）**已无任何 import，是孤儿文件** | 首屏信息过载：8 KPI + 1 条 + 14 卡；固定区（页头 44 + KPI 两行 ~96 + 构成条 32 ≈ 172px）超过 1280×800 内容区的 20%；卡片头每张一个 22px 折叠按钮；KPI 数值 15px 与卡内 20/26px 数字并存 | ① KPI 8→4（会话/消息/好友/群聊），其余 4 项并入对应卡片；删消息构成条（并入"内容构成"卡）；② 14 卡→6 卡（趋势、热力、关系、内容、存储、资金），其余 8 卡收进「更多分析」折叠或删除（对应子页已存在）；③ 页头动作 3→2：刷新 + 更多▾（两个导出都进更多）；④ 删 `.scanbar` / 渐变条 / 发光 / 玻璃；⑤ 删孤儿 `overview-neon.module.css` |
| NV-02 | 微信问答 `ask` | `panels/Ask.tsx`；`panels/ask.module.css`；引用 `panels/AskProcess.tsx` / `AnswerBody.tsx` / `AskHistoryDialog.tsx` | `panelShell` → `askLayout`（横排：`askPage` + 320px 引用详情）→ `PanelHeader`（badge + 历史 + 清空）→ 检索上下文条（范围 Select + 时间 chip + 清除 + "已限定范围"）→ 时间面板（按需）→ `panelBody` 滚动（空态引导卡 / 对话流）→ 底部 `composer`（错误/优化建议/输入/发送） | 标题「微信问答」= 侧栏名（完全重复）；说明「本机检索 · AI 综合回答 · 点击引用跳转原文」= 三句话把功能又说一遍；badge「N 个会话可检索」与范围选择器重复；「已限定范围」与范围/时间 chip 状态重复 | `ask.module.css` `.scopeHost` 渐变+发光（263-269）；`.send` 青紫渐变 + `box-shadow 0 0 14px` + hover 位移（820-828）；`.processPulse`/`.streamCaret`/`.chatDots` 多个无限动画（437/578/746）；引用详情 `ask-cite-detail.module.css` 右侧 `box-shadow`（251/268）+ 滑入动画（79-85） | 页头 3 个动作 + badge；上下文条 3 控件 + 清除 + 提示；输入框上方还有错误、优化建议、模型选择；过程时间线**默认展开**（`AskProcess.tsx` 头注明示）挤压正文；320px 引用详情并排压缩正文（窄容器转 overlay） | ① 标题删除或改「问答」，说明保留一句（"只检索本机，回答带来源"）；② badge 合并进范围控件（「全部会话 · 128」）；③ 页头动作 ≤2（历史、更多▾；清空进更多）；④ 过程时间线默认折叠为一行「已完成 N 步 · 展开」，思考块默认折叠；⑤ 去渐变/发光/动画，主按钮微信绿；⑥ 引用详情改右侧抽屉（默认关闭），正文满宽 |
| NV-03 | 总结 `dailysummary`（合并组主段） | `panels/SummaryWorkbench.tsx`；`summary-workbench.module.css`；任务抽屉 `SummaryTaskDrawer.tsx` | `panel` → `PanelHeader`（标题+说明+定时任务）→ `SummaryToolbar`（区间+格式+生成+复制）→ `body` 网格 `[main 滚动 / history 320px]`：空态卡 / 加载卡 / StatsCard + 总结卡；任务抽屉在面板内绝对定位 | 标题「总结」= 分段名 = 结果卡标题「总结」**三重重复**；说明「每日与周期统一入口」与 hidden 的 period 双入口说两遍；工具栏「区间」+「格式」+「当前区间」+ history 列表四处时间信息 | `summary-workbench.module.css` 本身较克制（抽屉阴影 434、toast 动画 554-557、spin）；主要噪声来自相邻旧面板 `daily-summary.module.css`（22 处发光、20 处 blur，属**已无调用点的 DailySummary 旧面板**，见 §7 清理项） | history 320px 固定列常驻压缩正文；空态卡 `max-height:none; flex:1 0 auto` 可能撑满留白；5 个格式 chip + 生成 + 复制 + 定时任务，动作偏多；结果标题与页标题重复 | ① 标题只留一处（页头），结果卡标题改「生成结果」或删；② history 改抽屉/下拉，正文满宽；③ 格式 5 种收进「格式 ▾」下拉，记住上次选择；④ 空态单行 + 一个主按钮（选日期 → 生成），不铺满高；⑤ 定时任务按钮去 emoji，进页头「更多」 |
| NV-04 | 年度报告 `annual`（合并组分段） | `panels/Annual.tsx`；`panels/annual-more-cards.tsx`；`panels/annual-masonry.tsx`；`panels/annual.module.css` | `panelShell` → 页头（年度报告 + 覆盖年份静态标签/下拉 + 导出报告）→ `panelBody` 滚动：`YearPortrait` + **27 张卡片**（人物/群/媒体/资金/撤回/极值/口头禅/月度趋势/资产/朋友圈…）经 Masonry 排布 + 词云 | 标题「年度报告」= 分段名；说明「本机聊天记录的年度回顾 · 人物类指标只统计我发出的」（口径说明，有价值但过长） | `Annual.tsx` 头注：27 张卡按 **7 个语义 tone**（青/紫/粉/绿/琥珀/蓝/红）分色；`annual.module.css` 46KB，含 2 处渐变、12 处 emoji 图标记号；海报式卡片墙 | 27 卡墙 = 典型「花哨装饰」；7 种色调与微信单品牌色冲突；数据口径（人物只算发出）与规模类混排，需靠标注区分；导出是截屏 PNG | ① 卡片 27→8（年度概览/作息/关系/群/媒体/资金/朋友圈/极值），其余进「更多」折叠；② 7 tone 收敛为「中性 + 1 个强调色」；③ 口径说明收进卡片 subtitle 或 info tooltip；④ 导出保留但改「导出报告」文字按钮，去海报感 |
| NV-05 | 周期报告 `period`（hidden，无独立界面） | 折进 `SummaryWorkbench` 时间范围；`panels/PeriodSummary.tsx` 旧组件仍在 `panel-loaders.tsx` 导出但**无调用点** | 用户选多日区间即走周期链路 | `period` 仍在 `TAB_LABELS`（深链保活）；页面说明「每日与周期统一入口」 | 旧 `period-summary.module.css` 4 处 blur（死样式） | 隐藏项但保留标题，容易让维护者误以为还有独立页面 | ① 保持深链可用，但不新增任何视觉；② 清理 `PeriodSummary.tsx` / `period-summary.module.css`（连同 `DailySummary`），或至少在 `panel-loaders.tsx` 标注"仅为兼容导出" |
| NV-06 | 知识库 `kb`（三分段 + 库 rail） | `panels/KbShell.tsx`；`panels/KbRail.tsx`；`panels/KbFiles.tsx`→`kb-files-panel.tsx`；`panels/KnowledgeBase.tsx`；`panels/Graph.tsx`（knowledge 变体）；CSS `kb-shell.module.css` / `kb-rail.module.css` / `kbfiles.module.css` / `knowledge-base.module.css` / `graph.module.css` | `KbShell`：容器查询外壳 → `KbRail`（库列表，<900px 变顶部 chip）+ `MergedSections`（文件/笔记库/知识图谱）。文件段 = 搜索 + 过滤 + 列表 + 详情分栏（`KbFileDetailPane`）；笔记库 = 列表 + 详情/编辑器；图谱 = 顶部页头 + 统计条 + 画布 + 右侧 GraphRail | 侧栏「知识库」→ 默认落「文件」段（`KbShell` `landing`），用户预期「知识库=笔记」；`KbTitleRow` 标题与分段名重复；三段的空态各写一套；图谱页头「知识图谱 · 知识网络」与分段名重复 | `graph.module.css`：`backdrop-filter` 5 处（120/251/335/360/608）、节点脉冲动画 3 个（179-220）、图例条纹 `repeating-linear-gradient`（271/276/295）；`kbfiles.module.css` 35KB（本组最大文件）；`wordcloud-card.module.css` 5 处渐变 | 库 rail + 分段条 + 面板内过滤/搜索 = 三层 chrome；KbFiles 详情分栏在 900px 以下挤压；图谱右侧控制栏项目多（筛选/外观/布局/圈子） | ① 侧栏入口默认落「笔记库」或把入口名改成「文件与笔记」（与 landing 一致）；② 三段统一一个 36px 工具行，不再各画页头；③ 库 rail 与分段条合并为一行（库下拉 + 分段）；④ 图谱去玻璃/脉冲/条纹，节点与边用灰阶 + 1 个强调色 |
| NV-07 | 聊天会话 `chats`（消息视图主段） | `panels/Chats.tsx` → `panels/chats-view.tsx`；`chats-head-actions.tsx`；CSS `chats.module.css` / `chats-rows.module.css` / `chats-cards.module.css` / `chats-shell.module.css` | 双栏：左 304px 会话列（搜索 + 搜消息/批量 + 分类段条 + 统计 + 置顶/普通列表）→ 右消息区（空态雨窗 / 会话头 + 动作排 + 虚拟消息流 + 底部“回到最新”）；右侧可挂 384px AI 栏（问答/推荐回复+分析） | 会话分类段条「全部/公众号/服务号/客服」与侧栏 hidden 的 bizchats/servicechats/kefu 一一对应（一层信息两种入口）；会话头 username + 条数 + 导出回执三行说明；空态「从左侧选择一个会话」+「查看最近会话」+ 雨窗（三件套） | `chats-rows.module.css` `.panel` 径向+线性渐变（8-12）；`chats-cards.module.css` `backdrop-filter` 多处（10-11/308/430/506/828）、头像渐变（278/440/588）、导出主按钮渐变+发光（544-550）、空态图标 `filter: drop-shadow`（`chats-shell.module.css` 66）；空态右侧 `RainWindow`（`rain-window.tsx`，514 行 WebGL 雨玻璃着色器） | 左列 304 + 右列 AI 384，1280 窗口下消息区只剩 ~460px；会话头动作排最多 6 个（返回/问答/推荐/分析/日历/群信息或聊天信息/更多），窄容器逐级隐藏文字；雨窗是纯装饰且重；批量态与普通态切换整行统计 | ① **删 RainWindow**，空态改居中一行提示 + 一个主按钮；② 会话头动作 6→「问答 + 更多▾」两个，推荐/分析并入 AI 栏一个入口；③ 去渐变/玻璃/发光，会话列表行高 64（微信）：40 头像 + 名 + 摘要 + 时间/未读；④ 分类段条改筛选 chip 或下拉（与侧栏 hidden 项同名，不允许两套命名） |
| NV-08 | 通话记录 `calls`（chats 分段） | `panels/Calls.tsx`；`calls.module.css` | `panelShell` → 页头（标题 + 动态统计 desc + 刷新）→ **6 张 `StatCard`** → 月度柱 + 时段分布 + Top 联系人 + 最近通话列表 | 标题「通话记录」= 分段名；desc 把 4 个数字又说一遍（与 StatCard 重复）；「刷新」按钮与全局刷新习惯重复 | `calls.module.css`：3 处渐变（柱/环形）、1 处 emoji；`ui/kit.module.css` `.statCard` 深阴影 | 6 卡 + 3 图 + 1 列表，一屏过满；分段条 + 页头 + 统计区三层固定 | ① 标题删除（分段名已有）或改「通话」；desc 只留一句口径；② 6 卡→1 条内联 KPI（总数/时长/覆盖联系人）；③ 图与列表合并为「时间线 + 月度小柱」两卡；④ 去渐变柱与发光 |
| NV-09 | 撤回消息 `revoked`（chats 分段） | `panels/Revoked.tsx`；`list-panel.module.css` | `PanelHeader`（标题+desc+刷新）→ 隐私横幅 → 错误 → 统计（类型构成/Top5）+ 可展开列表 + 分页 | 标题「撤回消息记录」= 分段名；隐私横幅「数据仅来自本机…不联网、不上传」与全站多处同义（设置/隐私页/关于页） | `list-panel.module.css`：5 处发光、7 处渐变、3 处 blur（多面板共用，含本页）；`🛡️` emoji 横幅 | 统计与列表两套卡片；隐私横幅是本页第二高的固定块 | ① 标题改「撤回」；② 隐私横幅降为页脚一行灰字或 info tooltip（同一句全站只写一次）；③ 统计并入工具行内联；④ 列表行高统一 44 |
| NV-10 | 群聊分析 `groupinsights`（+ 活跃监控分段） | `panels/GroupInsights.tsx`；`panels/Monitor.tsx`；`group-insights.module.css`；`monitor.module.css` | 离线洞察：页头（标题+desc+群选择器）+ 指标 + 两栏（成员排行 / 公告与词云）；活跃监控：页头（标题+自动刷新/刷新）+ 指标 + 群列表/热力/消息流，3–10s 轮询 | 侧栏「群聊分析」vs 分段「离线洞察」vs 页标题「群聊离线洞察」三种叫法；监控页 desc「只读仪表盘 · 自动刷新 开/关」与按钮重复 | `group-insights.module.css` 1 渐变 + 6 emoji；`monitor.module.css` 3 处阴影 + 2 emoji；热力格多色 | 两个视图各有一套页头/指标/列表，切换时布局跳变；轮询状态文字与按钮重复 | ① 三段统一命名：「群聊分析」为入口名，视图名用「洞察 / 监控」；② 两页共用同一 36px 工具行（群选择器 + 刷新），不再各画页头；③ 热力格改单色深浅（微信绿阶）；④ 自动刷新做成开关 chip |
| NV-11 | 通讯录 `contacts`（+ 社交图谱分段） | `panels/Contacts.tsx`；`panels/Graph.tsx`；`contacts.module.css`；`graph.module.css` | **无 PanelHeader**：`panel` → `Toolbar`（搜索 + 9 个分类段条 + 导出 CSV + 导出记录）→ 字母索引条 → `scroll` 多列网格（240px 起，3–5 列）+ 字母分组；资料抽屉 460px（基础资料 + 社交画像 360） | 分段名「通讯录」= 侧栏名；分类段条 9 项（全部/联系人/群聊/公众号/服务号/企业微信/群成员/系统/已删除）与「消息视图」分类、联系人类型标签三套分类词表；导出 + 导出记录两按钮同义 | `contacts.module.css`：4 渐变 + 5 阴影 + 3 blur；`.indexBar` 竖排字母（26 个按钮）；`list` 多列网格 | 无页头导致与其它页不一致；9 段条 + 搜索 + 2 导出 = 一行放不下（窄屏换行）；26 个字母索引按钮在 3–5 列网格上作用有限；社交图谱页头「社交图谱 · 好友网络/群组网络」再分级 | ① 补一条 36px 工具行（标题「通讯录」+ 搜索 + 筛选▾ + 更多）；② 9 分类→5（全部/联系人/群聊/公众号/其它），其余进筛选；③ 字母索引保留（微信有），但只在列表 >50 时显示；④ 导出记录进「更多」；⑤ 图谱去玻璃/脉冲/条纹 |
| NV-12 | 朋友圈 `moments`（+ 朋友圈洞察分段） | `panels/MomentsOptimized.tsx` → `moments-panel.tsx`；`panels/MomentsInsights.tsx`；`moments.module.css`；`moments-insights.module.css` | 朋友圈：页头（标题 + 共 N 条 + 搜索/隐私/刷新/同步/最近同步/导出 **6 个动作**）→ `layout`：时间线虚拟列表（2/3）+ 右侧栏 1/3（作者 Top/筛选/月份/统计）+ 悬浮回到顶部；洞察：页头 + 指标带 + 5 行卡片（4/3/1/1/1）+ 词云 + 地图 | 标题「朋友圈」= 分段名；页头「共 N 条」与 desc「共 N 条」重复；右栏作者筛选与页头搜索/筛选三处过滤；隐私/同步/刷新/导出四个按钮同权 | `moments.module.css` `.panel` 径向渐变（13-15）；`.backTop` 青色发光圆钮（22-34）；`backdrop-filter` 14 处（62/103/137/261/267/352 等）；作者头像渐变（177）；`.count` 青色徽章（35-39）；遮罩 blur（261） | 页头 6 动作 + 搜索框 + 同步状态，1230px 下折行；左 2/3 + 右 1/3 在 1280 下时间线仅 ~700px；回到顶部按钮 46px 发光悬浮；洞察 10+ 卡 | ① 页头动作 6→2（搜索 + 更多▾：隐私/同步/导出全进更多）；② 标题删（分段名已有），「共 N 条」合并到搜索框右侧灰字；③ 右栏筛选改抽屉/下拉，时间线满宽；④ 去径向渐变/玻璃/发光/悬浮按钮；⑤ 洞察 10 卡→4 卡 + KPI 条 |
| NV-13 | 收藏与表情 `favorites`（3 分段） | `panels/Favorites.tsx`；`panels/Emoticons.tsx`；`panels/AssetInsights.tsx`；`list-panel.module.css`；`asset-insights.module.css` | 收藏：页头（标题 +「N 项 · 共 M」+ 批量/导出/删除）→ 列表虚拟化 + 类型过滤 + 详情弹窗；表情：页头（标题 + 动态 desc）→ 三个内页签（个人/其他/表情商店）+ 搜索 + 网格；统计：页头 + 4–6 统计卡 + 类型/年份分布 + 排行 | 分段名「我的收藏」vs 侧栏「收藏与表情」vs 标题「收藏」；表情页内再一套三页签（与顶部分段叠加成两层）；统计页标题「收藏/表情资产」= 分段名近重复 | `list-panel.module.css`（收藏/表情共用）含发光/渐变/blur；`asset-insights.module.css` 2 渐变；`wordcloud` 渐变（统计页） | 收藏页头 3 动作 + 过滤；表情页「三页签 + 搜索 + 列表过滤」两层；统计页与收藏/表情内容同源，却单独占一段 | ① 分段名统一「收藏 / 表情 / 统计」；② 表情内三页签改顶部分段的二级下拉（避免两层段条并排）；③ 统计页只保留 6 个指标的内联 KPI + 2 图，删除与收藏页重复的列表；④ 去渐变/发光 |
| NV-14 | 文件与存储 `files`（4 分段） | `panels/Files.tsx`；`panels/MediaAssets.tsx`；`panels/Storage.tsx`；`panels/OfficialAssets.tsx`；`list-panel.module.css`；`media-assets.module.css`；`storage.module.css`；`official-assets.module.css` | 文件资产：页头（标题「文件管理」+ 动态统计 + 刷新/导出/查找重复）+ 过滤 + 虚拟网格 + 详情/重复抽屉；媒体资产：页头（标题「媒体资产馆」+ 3 个跳转按钮）+ 3 统计卡 + 按类目动态卡 + 重复清单；存储分析：页头（标题「存储空间分析」+ 刷新）+ Hero 总占用 + 环形图 + 两张排行 + 大文件；公众号文章：页头 + 3 统计卡 + 表格 | 同组 4 个页标题各不相同：「文件管理 / 媒体资产馆 / 存储空间分析 / 公众号内容资产」，与分段名「文件资产 / 媒体资产 / 存储分析 / 公众号文章」**全部不一致**；4 页各有一套统计卡/刷新 | `storage.module.css`：5 渐变 + 11 阴影 + 4 blur（本组最重）；`list-panel.module.css` 共用发光；`official-assets.module.css` 干净；`media-assets.module.css` 2 阴影 | 4 个分段 = 4 套页头 + 4 套统计口径；「存储分析」与「媒体资产」都在盘点体积；「文件资产」导出/刷新/重复三动作；公众号文章只有 1 张表，独占分段 | ① 4 页标题统一为分段名（文件 / 媒体 / 存储 / 公众号），去掉「馆/管家/分析」修饰；② 合并「媒体资产 → 存储分析」为一页（同一批体积数据）；③ 统计一律内联 KPI 条（≤46px）；④ 页头动作 ≤2，其余进更多；⑤ 删 storage 的渐变/玻璃/深阴影 |
| NV-15 | 资金往来 `ledger`（2 分段） | `panels/Ledger.tsx`；`panels/Records.tsx`；`ledger.module.css`；`records.module.css` | 月度汇总：4 个 KPI + 两栏（联系人排行 / 红包手气）+ 异常清单 + 明细表；转账红包明细：页头（meta 图标 + label + desc + badge）+ 1 排分类段条 + 搜索 + 工具行（时间/排序/导出）+ 卡片表格（虚拟化 + sticky 表头 + 加载更多） | 分段「月度汇总 / 转账红包明细」vs 页标题「资金账本 / 转账记录」；Records 页头 badge「共 N 条」与分类计数重复；两种日期口径（月份 vs 区间）并存 | `ledger.module.css` 3 个动画（loading）；`records.module.css` 4 渐变 + 5 阴影 + 2 blur；`list-panel` 共用 | 明细页固定区 64px（段条+搜索）+ 工具行；分类 6 项每项带计数，段条很宽；月度页 4 KPI + 2 卡 + 2 列表 | ① 标题统一「资金往来」；② 明细页分类段条改下拉筛选（6 项带计数在 1280 下已换行）；③ 月度页 KPI 4→3（收入/支出/净额）；④ 去渐变/阴影 |
| NV-16 | ClawBot集群 `clawbot` | `panels/ClawBotPanel.tsx`；`clawbot-settings.tsx`；`clawbot-chat.tsx`；`clawbot-rail.tsx`；`clawbot.module.css` | 页头（🦞 emoji + 标题 + 说明 + Segmented「集成设置/接入会话」）→ 左侧实例 rail + 右侧工作区（设置/会话）；绑定卡片、环境自检、FAQ；会话区（检索/导出/发送） | 标题「ClawBot集群」= 侧栏名；desc「把 Super Time 接入微信，之后可在微信里直接指挥它执行任务」偏长；rail 实例名与页头 Segmented 两级切换 | `clawbot.module.css` 41KB；页头 emoji 🦞；rail 行状态 pill；`clawbot-qr` 二维码 | 实例 rail + 视图 Segmented + 组内卡片 = 三层；设置视图内容多（绑定/自检/FAQ）；会话视图与主聊天页两套消息 UI | ① 删 🦞 emoji；② 「集成设置/接入会话」改顶部 Two-tab 或直接合并为一页（设置在上、会话在下）；③ 实例切换改下拉（多数用户只有 1 个实例）；④ 去状态 pill 的多色发光 |
| NV-17 | 待办日程 `tasks` | `panels/Tasks.tsx`；`tasks.module.css` | 页头（标题「待办提取」+ 说明 + 提取/导入两按钮）→ 工具行（手动添加 + 计数）→ 卡片列表（完成/重开/删除/跳会话） | 侧栏「待办日程」vs 标题「待办提取」vs 按钮「提取最近 7 天待办」；说明「最近 7 天聊天 → LLM 提取」与实际（本地关键词匹配，见 `PrivacyTrust.tsx` 注释修正）**表述不一致** | `tasks.module.css` 2 处 blur + 1 阴影；`kit.empty` 空态 30px 图标 | 2 个主按钮 + 手动输入行 + 列表；空态与「读失败」分开（做得对，保留） | ① 标题改「待办日程」；② 说明改「从最近 7 天聊天提取待办（本地匹配，不调用模型）」；③ 提取/导入合并为「提取」+ 更多（导入微信原生提醒是低频）；④ 列表行高 44 + 0.5px 分割 |
| NV-18 | 任务信息 `taskinfo` | `panels/TaskCenter.tsx`；`task-center.module.css`；`task-create-dialog.tsx`；`task-center-record-modal.tsx` | 页头（标题「任务信息」+ 长说明 + 刷新/立即检查）→ 工具行（长提示 + 计数）→ 双栏 `board`：左任务列表（行内展开编辑表单）、右触发记录；记录详情弹窗 + 图片放大 | 标题「任务信息」= 侧栏名；页头说明与工具行说明**两段都在讲「立即检查/已完善/回调」**；左右两栏各自 paneHd 标题再重复一次 | `task-center.module.css` 4 处 blur、1 发光 | 页头 + 工具行两段长文案占高；双栏在 1280 下每栏 ~470px，编辑表单挤；「立即检查」是写操作，与刷新并排易误点 | ① 说明与工具行合并为一行（"命中关键词后记录并投递回调；仅「已完善」生效"）；② 页头只留「刷新 + 立即检查」并给立即检查加二次确认；③ 右栏标题动态（任务名/全部记录）已做，保留；④ 去 blur/发光，表单用微信表单行样式 |
| NV-19 | 操作日志 `oplog` | `panels/OperationLogPanel.tsx`；`oplog.module.css` | 页头（⚙ emoji + 标题 + 状态点 + N 条 + 动作「更多▾」）→ 统计行 → 筛选卡（分类/状态/日期/搜索 两行）→ 表格卡（sticky 表头 + 虚拟/分页 + 导出） | 标题「操作日志」= 侧栏名；页头状态徽标「N 条」与表格分页计数重复；「导出」「清空」都在更多菜单（合理，保留） | `oplog.module.css` 2 阴影 + 1 动画；页头 emoji ⚙ | 筛选卡本身是一个 Card（一层容器包一层）；两行筛选 64–70px（D2 已压）；表头 + 表格 | ① 删 ⚙ emoji；② 筛选区去掉 Card 外壳，直接两行控件；③ 表格行高 32、单元格 6/10（密度已定）；④ 统计行改页脚或筛选行右侧灰字 |
| NV-20 | 设置（弹窗，15 节 / 5 组） | `WechatDataPanel.tsx`（Dialog 容器）；`panels/Settings.tsx`；`panels/settings-state.tsx`；`settings-steps.tsx`；`settings-sections.tsx`；`settings-common.tsx`；`settings-browser.tsx`；CSS `settings.module.css` + `settings-accounts/models/remote-access` | Dialog `min(1080,96vw)`×`min(90vh,1060)`；左导航 15 项 5 组（带 value 副标题 + 状态点）→ 右区单一滚动：提示条 + 5 个分组标题 + 各节卡（`data-settings-section`）+ 底部固定 `saveBar`（配置路径 + 保存状态 + 保存按钮）；手机端整面板降级为「数据边界 + 仅桌面清单」；图片解码明细为嵌套 Dialog | 弹窗标题「设置」+ 副标题「配置向导 · 智能与隐私 · 授权与更新 · 维护与自检」（**漏了「高级」组**）；`Settings.tsx` 内又写 5 个分组标题与左导航一一对应（重复）；多处注释写「13 节」而实际 15 节；`PanelHeader`（「微信数据配置」）只在非弹窗时渲染（已避免重复） | `settings.module.css`：径向渐变底（18）、左导航激活项渐变（110）、提示条 blur + 深阴影 + `noticeIn` 动画（243-248）、进度条渐变（335/372/501/551）；`settings-accounts.module.css` 3 发光 | 弹窗 1080×1060 超过 1280×800 屏幕（90vh=720，实际裁到 720）；左导航 15 项 + value 两行 = 需滚动（注释自承认「14 节时溢出 88px」）；右区连续滚动 15 节，无「当前节」强定位；底部保存条常驻（正确）；手机端只显示 1 节，标题仍叫「设置」 | ① 弹窗尺寸降为 `min(880px, 94vw) × 86vh`；左导航改「分组标题 + 单项一行」（去掉 value 副标题，状态点保留）；② 右区按「一次只显示一节」分页（原注释说这样"滚到底就停住"，但 15 节连续滚动更难定位；建议左侧选中 + 右侧单节 + 上一节/下一节）；③ 删重复的 5 个分组标题（左导航已有）；④ 保存条保留但改微信底部栏样式（白底 + 0.5px 上边线）；⑤ 设置内所有「仅电脑」说明合并为统一提示条（`desktop-only.tsx` 已有 `DESKTOP_ONLY_KEYS` 清单）；⑥ 去渐变/blur/发光 |

---

## 5. 弹窗 / 抽屉 / 浮层清单（DL，含触发入口）

> 统一问题：弹层实现有 4 套（kit `Dialog`、kit `Drawer`、自绘 `calOverlay`、自绘 moments overlay / files lightbox），尺寸/圆角/遮罩/阴影各不相同；标题字号 16/15/14 混用。除非注明，改造要点均包含「收敛到 kit Dialog/Drawer + §8.4 弹层规范」。

| ID | 弹层 / 触发入口 | 入口文件 · 主 CSS | 实现与结构 | 重复 / 冗余 | 装饰证据 | 问题 → 改造要点 |
|---|---|---|---|---|---|---|
| DL-01 | 设置弹窗（点侧栏底「设置」；或深链 `#settings/#privacytrust/#privacy/#backup/#health/#hook`；或各页「去设置」） | 宿主 `WechatDataPanel.tsx`；`panels/Settings.tsx`；`settings.module.css` | kit `Dialog` + 自定义 `settingsDialog` 尺寸；内部见 NV-20 | 弹窗标题 + 面板内分组标题 + 左导航组名三处 | 见 NV-20 | → 见 NV-20；另：标题副标题删掉（分组由左导航表达） |
| DL-02 | 会话导出弹窗（聊天页「更多 → 导出消息」） | `panels/chats-export-dialog.tsx`；`chats-cards.module.css` `.calOverlay/.exportDialog`；触发 `chats-head-actions.tsx` | **自绘** overlay（`data-st-dialog="chats-export"`）：标题栏 + 格式 4 格 + 类型 chips + 区间 + 文件名 + 目录选择 + ZIP 开关 + 进度 + 底部导出/中止 | 导出格式（HTML/TXT/JSON/CSV？）与「导出全部会话 ZIP」「总览导出」三套导出命名；目录选择说明重复 | `chats-cards.module.css` 导出主按钮渐变+发光（544-550） | 自绘遮罩点击关闭已正确；字段多（6 组）纵向长；格式/类型无默认摘要 → 统一 kit Dialog（width 560）+ 分组折叠 + 底部固定按钮；主按钮改绿、去发光 |
| DL-03 | 消息日历弹窗（聊天页「日历」） | `panels/chats-calendar-dialog.tsx`；`chats-cards.module.css` `.calOverlay/.calDialog`；触发 `chats-head-actions.tsx` | 自绘：月导航 + 4 条统计 + 7 列热力网格（点击跳日） | 统计 4 条与网格内数字重复；热力色阶与全站热力（overview/Annual/Monitor）三套 | `calHeat` 内联色阶；`calDialog` 深阴影 | → 统一热力色阶令牌（单色深浅）；统计 4 条压成 1 行；对话统一 kit Dialog 小尺寸 |
| DL-04 | 聊天记录查看器（消息卡片「聊天记录」） | `panels/chats-chatlog-dialog.tsx`；`chats-rows.module.css` `.chatlogDialog`；触发 `chats-msg-row.tsx` / `openNestedChatlog` | 自绘栈式抽屉：标题（可返回）+ 记录行（头像/名/时间/文本/嵌套入口） | 行结构与会话列表/消息搜索命中行三套相似结构 | 深阴影；`chatlogRow` 1px 分隔（较克制） | → 统一 Drawer 宽 560；行结构抽成共享 `PersonRow`；栈深度提示只保留返回箭头 |
| DL-05 | 已编辑消息弹窗（聊天「更多 → 已编辑消息」） | `panels/chats-edited-dialog.tsx`；`chats-cards.module.css`；触发 `chats-head-actions.tsx` | 自绘 overlay：列表 + 恢复原文按钮 | 「已编辑 N 条」在菜单项与弹窗标题重复 | — | → 统一 kit Dialog；行内「恢复」改文字链；空态一行 |
| DL-06 | 编辑消息副本（消息右键菜单「编辑」） | `panels/chats-view.tsx`（内联 `Dialog`）；`chats-cards.module.css`；触发 `chats-msg-menu.tsx` | kit Dialog：提示文案 + textarea + 取消/保存 | 提示文案 2 行（"只改动本地解密副本…"）信息必要，保留 | kit 默认 | → 文案压成 1 行 + info tooltip；保存按钮绿色主按钮；textarea 高度 40vh |
| DL-07 | 群信息抽屉（聊天头「群信息」） | `panels/chats-group-info-view.tsx`；`chats.module.css`；触发 `chats-head-actions.tsx` | 自绘抽屉（`data-st-dialog="chats-groupinfo"`）：标题 + 成员网格（48px 头像 + 搜索 + 查看更多 + 添加占位）+ 资料行（群名/公告/群主/人数）+ 底部导出 + 新建任务 | 成员数在资料行与「查看更多」文案重复；群主在资料行与成员标记重复 | 自绘阴影；成员网格用头像色 | 结构已按微信对齐（注释详述），**保留骨架**；→ 换 kit Drawer 宽 460，去掉底部两个并排按钮（导出低频进更多，新建任务保留主按钮） |
| DL-08 | 聊天信息抽屉（单聊聊天头图标） | `panels/chats-contact-info-view.tsx`；`chats-contact-info.module.css`；触发 `chats-head-actions.tsx` | 自绘抽屉：标题 + 联系人 360 资料行 + 底部导出/新建任务 | 与通讯录资料抽屉（`Contacts.tsx` 460px Drawer）内容重复（同一人两套资料卡） | 自绘阴影 | → 统一为一个「联系人资料」组件，通讯录抽屉与聊天抽屉复用；kit Drawer 宽 460 |
| DL-09 | 新建任务弹窗（3 入口：聊天更多 / 群信息底部 / 聊天信息底部） | `panels/task-create-dialog.tsx`；`task-create.module.css`；触发 `chats-head-actions.tsx`、`chats-group-info-view.tsx`、`chats-contact-info-view.tsx` | 自绘（`data-st-dialog="task-create"`）：会话摘要 + 任务名 + 触发对象（群聊选成员）+ 关键词 chips + 图片数量 + 回调地址 + 提交 | 「等待完善」提示与任务信息页说明重复；关键词限制文案长 | `task-create.module.css` 干净 | → 收敛 kit Dialog；表单改微信「标签左 / 输入右」两列行；关键词 chips 保留（可输入）；底部固定「创建」 |
| DL-10 | 任务触发记录弹窗（任务信息右栏点记录） | `panels/task-center-record-modal.tsx`；`task-center.module.css`；触发 `TaskCenter.tsx` | 自绘（`task-center-record` + 图片 `task-center-zoom`）：记录详情（时间/群/对象/关键词/文本/图片）+ 重投/标记 | 记录字段与右栏行摘要重复 | 4 处 blur、1 发光 | → 收敛 kit Dialog；图片放大复用统一 ImageViewer |
| DL-11 | 聊天 AI 右栏（「问答」按钮整栏、或「推荐/AI 分析」） | `panels/SessionAsk.tsx`；`panels/ChatRightPanel.tsx`；`panels/ReplySuggest.tsx`；`panels/ChatAnalysisPanel.tsx`；`session-ask.module.css`；`chat-right-panel.module.css`；触发 `chats-head-actions.tsx` | 右栏 384px（min 300，可 `data-full` 铺满）：问答=外壳+头+回答流+输入；推荐回复+分析=一个容器上下分区（上 ≤45% 高，各自滚动） | 会话级问答与页签「微信问答」两套问答 UI（共享 `useAskSession`，但外壳/头部/过程各写一份）；「推荐回复/分析」两块各自标题 | `session-ask.module.css` 发送按钮渐变+发光（213-217）、闪烁 caret（130）、脉冲点（159） | 384px 右栏在 1280 下压消息区；推荐+分析上下分区各滚动（双滚动条）；问答整栏与右栏是两个不同外壳；→ 右栏统一为单一抽屉（宽 400），内部一个 Tab（问答/推荐/分析），只一个滚动区；去渐变/发光；问答与页签问答复用同一外壳组件 |
| DL-12 | 引用详情滑出（问答正文上标点击） | `panels/CiteDetailPanel.tsx`；`ask-cite-detail.module.css`；触发 `AnswerBody.tsx` / `SessionAsk.tsx` | 320px 右侧面板（窄容器 `[data-overlay]` 绝对定位叠加）：来源类型/原文/上下文/归档按钮 | 与问答右栏并列时两层右栏（320+320）压正文 | `ask-cite-detail.module.css` 右滑动画（79-85）、深阴影（251/268） | → 窄屏已是 overlay（正确）；统一为 Drawer 宽 360；去掉滑入弹性动画；「归档」改次按钮 |
| DL-13 | 图片查看器 / 灯箱（聊天图片、文件预览、朋友圈、任务记录、ClawBot 附件） | `panels/chats-media.tsx`（`data-st-dialog="chats-viewer"`）；`panels/Files.tsx`（`files-lightbox`）；`panels/moments-portals.tsx`（`moments-viewer`）；`panels/task-center-record-modal.tsx`（`task-center-zoom`）；`clawbot-chat.tsx`（`mediaZoomDialog`） | **5 套独立灯箱**：各自 overlay/缩放/关闭/Esc | 同一能力 5 份实现，快捷键/工具栏不一致 | 各 overlay 均有 blur + 深色遮罩；moments 灯箱 30px 发光 | → 抽一个共享 `ImageViewer`（缩放/旋转/切图/关闭/Esc/下载），5 处替换；遮罩纯 90% 黑无模糊 |
| DL-14 | 问答历史弹窗（问答页「历史记录」） | `panels/AskHistoryDialog.tsx`；`ask-history.module.css`；触发 `Ask.tsx`、`SessionAsk.tsx` | kit Dialog + `dialogWide`（940px）：sticky 工具条（搜索/状态段条/清空）+ 列表（问答摘要 + 状态徽标 + 引用只读清单）+ 分页；清空全部需逐字确认 | 「清空全部」按钮与删除单条动作并存；状态徽标 3 类（已回答/未检索到/未采用）与问答正文状态词两套 | `ask-history.module.css` 标题说明长；`dialogWide` 940×? | → 尺寸降 880；列表行高 72；清空全部收进「更多」；状态词统一到 `AskHistoryStatus` 词表 |
| DL-15 | 导出记录弹窗（通讯录「导出记录」） | `panels/ExportHistoryDialog.tsx`；`export-history.module.css`；触发 `Contacts.tsx`（`data-open-export-history`） | kit Dialog `dialogWide`（1200×760 固定）：标题两行 + 筛选行 + 表格（文件/类型/大小/行数/时间/状态/操作）+ 清理菜单 | 固定 1200px 弹窗在 1280 屏几乎满宽；「打开/在文件夹显示/复制路径/重新导出/删除记录/删除记录并删文件」6 个行内动作 | — | → 宽 960、高 80vh；行内动作 6→2（打开 + 更多▾）；表格列 7→5（文件/类型/时间/状态/操作） |
| DL-16 | 定时总结任务抽屉（总结页「定时任务」） | `panels/SummaryTaskDrawer.tsx`；`summary-workbench.module.css` `.drawer/.overlay`；触发 `SummaryWorkbench.tsx` | 面板内绝对定位 drawer（右侧 320+），遮罩 45% 黑：任务列表 + 新建/编辑表单（名称/群/时间/格式/开关） | 任务格式 5 种与页面格式重复；「每日/周期」两套任务概念 | `.drawer` 阴影 434 | → 改用 kit Drawer（在全屏层），宽 480；格式复用同一枚举与文案；去 45% 遮罩改 40% 纯黑 |
| DL-17 | 知识库管理弹窗（新建/重命名/删除库、模型、笔记编辑） | `panels/KbRail.tsx`（3 个 Dialog）；`panels/KbModelDialog.tsx`+`kb-model-dialog.module.css`；`panels/KnowledgeNoteEditor.tsx`；触发 KbRail / 笔记库 | kit Dialog：表单/确认/模型 + 笔记编辑器（标题/标签/正文/[[链接]]） | 删除库的确认文案与通用确认框重复；模型对话框说明长 | — | → 删除库走统一 Confirm；模型对话框说明压 1 行；笔记编辑器宽度 720、全屏 sheet on mobile |
| DL-18 | ClawBot 扫码绑定弹窗（实例 rail「绑定」） | `panels/clawbot-bind-modal.tsx`；`clawbot.module.css`；触发 `clawbot-rail.tsx`、`clawbot-settings.tsx` | kit Dialog：二维码 + 说明 + 状态（等待/已确认）+ 关闭 | 说明「请用手机微信扫描…绑定后即可…」与设置页说明重复 | 二维码容器样式 | → 保留；二维码白底 + 16px 边距；状态改一行灰字；说明删到 1 行 |
| DL-19 | 通用确认框（删除/覆盖/清空等） | `ui/confirm.tsx`；`confirm.module.css`；全站 `useConfirm()` 调用 | 自绘 overlay + 卡片：标题 + 说明 + 取消/确认（danger tone） | 与原生 `window.confirm` 已统一（好）；部分页面仍有自绘确认（KbRail 删除库、清空历史逐字确认） | `confirm.module.css` 遮罩 `blur(3px)` + `confirmPop` 回弹 | → 去模糊/回弹；宽度 400；危险按钮微信红 `#FA5151`；把 KbRail/清空历史的确认收敛到这里（逐字输入作为可选项保留） |
| DL-20 | 设置内嵌面板（隐私体检 / 数据边界 / 备份 / 数据库健康 / 原图自检 / 局域网访问） | `panels/Privacy.tsx`（list-panel CSS）、`PrivacyTrust.tsx`（privacy-trust CSS）、`Backup.tsx`、`Health.tsx`（health CSS）、`Hook.tsx`、`settings-remote-access.tsx`；均以 `embedded` 渲染进设置 | 各面板自带 `PanelHeader`（embedded 时仍渲染）+ 卡片；设置弹窗内再被 `embedPane` 包裹 | embedded 面板仍画页头标题，与设置左导航节名重复；「仅桌面」说明多节重复 | PrivacyTrust/Privacy 含渐变/发光；Health 干净 | → embedded 模式统一不画页头（只画一行节内工具行）；`desktop-only` 提示统一一条；卡片样式统一到 kit Card |

---

## 6. 花哨装饰全站证据汇总（按处理方式）

> 「微信化」不是把颜色换个色号，而是**删除以下 6 类效果**。下表按影响面排序，供批量清理时逐条勾选。

| # | 模式 | 代表证据（文件 : 选择器） | 命中界面 | 处置 |
|---|---|---|---|---|
| D1 | Canvas / WebGL 动画背景 | `panels/rain-window.tsx`（514 行雨玻璃着色器，挂载于 `chats-view.tsx` 空态）；`onboarding/particles.tsx`（粒子 + 连线 + 汇聚脉冲） | 聊天空态、启动页 | **删除**（两处都是纯装饰） |
| D2 | 极光/网格/扫描线/HUD/几何装饰层 | `onboarding-stage.module.css` `.stageWash/.bgGrid/.scanlines/.geoRing/.geoDot/.hudFrame/.bgStack`；`wechat-data.module.css` `.panel::before`；`overview-neon.module.css`（孤儿文件，无 import） | 启动页、主壳、总览 | **删除**；`overview-neon.module.css` 删文件前需同步清理以文本读取它的 `panels/m6-phone.wiring.spec.ts` 与 `panels/light-theme-coverage.wiring.spec.ts` 断言 |
| D3 | 发光（`box-shadow: 0 0 N color-mix(cyan…)` / `drop-shadow` / neon 脉冲） | `wechat-data.module.css` `.navBrandLogo`、`.navItem[data-active]::before`、`.navHint`；`overview.module.css` `.barFill/.topFill/.hourFill[data-hot]`；`chats-cards.module.css` `.exportBtnPrimary`；`ask.module.css` `.send`；`moments.module.css` `.backTop`；`titlebar-status.css` 状态点（其余面板的深阴影归 D7） | 全站 | **全删**；保留唯一例外：危险操作 hover 可用主题色，不用发光 |
| D4 | 渐变（文字 / 按钮 / 柱状 / 背景） | `overview.module.css` `.barFill/.hourFill/.topFill`；`ask.module.css` `.send`；`chats-cards.module.css` 头像与主按钮；`moments.module.css` `.avatar`；`annual.module.css`；`onboarding-stages.module.css` `.heroTitleAccent`；`license-gate.module.css` `.brand/.title/.primary`；`ui/kit.module.css` 进度条（324） | 全站 | **一律改纯色**；图表需要分类色时用 6 级灰 + 1 个品牌绿（不用青紫） |
| D5 | 毛玻璃（`backdrop-filter: blur`） | `chats-cards.module.css`（≥8 处）、`moments.module.css`（≥14 处）、`graph.module.css`（5 处）、`storage.module.css`（4 处）、`settings.module.css`（3 处）、`contacts.module.css`（3 处）、`daily-summary.module.css`（20 处，死样式）、`ui/kit-overlay.module.css` 遮罩、`mobile-nav.module.css` 底栏 | 全站 | **全删**，改纯色面（深 `#191919` / 浅 `#FFFFFF`） |
| D6 | 无限动画 / 呼吸 / 脉冲 / 扫描 / 浮动 | `wechat-data.module.css` `nav-hint-bob`；`overview.module.css` `ov-scan`、`ov-update`；`ask.module.css` `process-pulse`、`stream-blink`、`chat-pulse`；`graph.module.css` `gp-pulse`、`gp-node`；`titlebar-status.css` `nm-pulse-glow`；`ui/kit.module.css` `progressSweep`；`onboarding.module.css` `riseIn`＋各类 `text-shadow` 光晕 | 外壳、总览、问答、图谱、标题栏、启动页 | 只保留「加载 spinner」与 `prefers-reduced-motion` 下的必要过渡；装饰动画全删 |
| D7 | 超大阴影 / 大圆角 | `scifi-theme.css` `--nm-shadow-card: 0 4px 32px rgba(0,0,0,.50)`、`--nm-shadow-popup: 0 16px 48px rgba(0,0,0,.60)`、`--nm-glow-*`；`--nm-r-lg: 14px`、`--nm-r-xl: 20px` | 全站 | 阴影改 `0 1px 2px rgba(0,0,0,.04)` / 弹层 `0 8px 24px rgba(0,0,0,.12)`；圆角 8/12 |
| D8 | emoji 充当图标 / 装饰性徽章 | 页头：`overview`/`records`/`oplog`（⚙）/`clawbot`（🦞）/`privacy`（🛡️）；按钮：「⏰ 定时任务」「🔒 隐私」「↻ 同步」「▶/⏸ 自动刷新」；卡片图标：`📙💬📰`（OfficialAssets）、`✉️`（总览构成条）、`📄`（导出结果）、`🗂️`（任务空态） | 全站 | 统一用 16px 线性图标（`@deepseek-ai/dsh-client-ui-primitives` 已有）；无法替换的 emoji 直接删 |
| D9 | 英文装饰标签 | `src/client/ui-app/onboarding/pages/HomePage.tsx` `TELEMETRY`、`src/client/ui-app/onboarding/OnboardingShell.tsx` `Onboarding · System Boot`、`stage-chrome.tsx` `SUPER TIME BOOT`、`CONSENT REQUIRED`/`LICENSE OK`、`STAGE 01/04` | 启动页 | 全删或改中文；`TELEMETRY` 与隐私页「没有遥测」矛盾，**必须删** |

---

## 7. 可固定的重复内容 / 可合并 / 可删除清单

> 「可固定」= 同一信息在多处出现，应固化为**一处定义 + 全站引用**（组件或常量），而不是每页各写一遍。

| # | 重复内容 | 出现位置（证据） | 处置建议 |
|---|---|---|---|
| R1 | 页头标题 ≈ 侧栏名 / 分段名 | `nav-config.ts` labels；`MergedSections` 分段 label；各面板 `PanelHeader title`（朋友圈/收藏/总结/年度报告/媒体资产/群聊分析/通讯录…） | **合并组内子面板不再渲染标题**（只留工具行）；单页页头标题采用导航名（同一词表，从 `TAB_LABELS` 取），不再自造「xx馆/xx管家/xx分析」 |
| R2 | 页头说明 = 数据口径/来源注释 | 30 处 `PanelHeader desc`（如「仅本地计算」「数据来自消息库 type-50」「复用每日总结链路」「存储于 wechat_notes.db」） | 保留**一行**口径（≤24 字）；完整口径进 `title` 悬浮或「?」info；同一句只写一次（如「数据只在本机」只在隐私页/启动页写） |
| R3 | 统计卡/指标墙（3–8 项） | `Calls` 6、`MediaAssets` 3 + 按类目动态卡、`AssetInsights` 4、`MomentsInsights` 3、`Health` 6、`Storage` 1 Hero+、`Monitor` 4（自绘 Metric）、`GroupInsights` 6（自绘 Metric）、`Overview` 8、`OfficialAssets` 3 | 统一为**单行内联 KPI 条 40–46px**（`UI-DENSITY.md` §2.3 已定），主指标 ≤4 个；其余进「更多指标」 |
| R4 | 工具栏动作重复（刷新 / 导出 / 批量 / 同步 / 更多） | 几乎每个面板页头；`Overview` 有刷新+导出▾+导出全部会话；`Moments` 有刷新+同步+导出+隐私；`Files` 有刷新+导出+查找重复；`Records` 有导出+排序 | 全站页级动作固化为 **≤2 个可见**：主操作（按页定）+ 「更多▾」；刷新用图标按钮；批量/导出/同步进更多 |
| R5 | 三层筛选 | `Chats`：侧栏组 → 面板分段 → 分类段条（+搜索+搜消息）；`Favorites`：分段 → 内页签 → 过滤；`Kb`：库 rail → 分段 → 搜索/过滤；`ClawBot`：实例 rail → Segmented → 卡片 | 同一屏最多两层；第二层以下用「筛选」下拉/抽屉，不用并排段条 |
| R6 | 状态/计数徽标重复 | `Calls` desc 与 StatCard；`Records` badge 与分类计数；`Overview` KPI 与构成条；`oplog` 页头「N 条」与分页；`Ask` badge 与会话范围；`Moments`「共 N 条」出现两次 | 计数只保留一处（列表工具行右侧灰字），页头不重复 |
| R7 | 弹层标题/图标/关闭按钮各写一套 | 自绘 `calHeader`（`chats-cards.module.css`）vs `kit-overlay` `.drawerHd` vs moments overlay vs `files-lightbox` | 抽 `SheetHeader`（标题 16 + 关闭 32×32）供所有弹层复用；自绘弹层全部改用 kit |
| R8 | 隐私/仅本地/仅电脑说明 | `PrivacyTrust`、`Privacy`、`Revoked`、`Backup`、`Health`、`Hook`、`Tasks`、`TaskCenter`、`Files`、`Contacts`、`Settings`（`desktop-only.tsx` `DESKTOP_ONLY_KEYS`） | 全站一句标准文案 + 统一组件：桌面可用但手机不可用时用统一灰条（`desktop-only`）；「仅本地」只出现一次（隐私页/启动页） |
| R9 | 空态三联（大 emoji + 标题 + 说明 + 大卡） | `kit.module.css` `.empty`（30px 图标 + 居中 + 88px padding）；`SummaryWorkbench` 空态撑满；`Contacts`/`Favorites`/`Files` 各自空态 | 统一空态：**一行灰字 + 一个主操作**，居上 1/3；删大图标；最多 1 个（`EmptyState`）实现 |
| R10 | 启动引导叙事重复 | `HomePage` 三步 + `HelpPage` 四步 + `FeaturesPage` 5 组 + `AboutPage` 边界 + `PrivacyConsentGate` 边界 | 首启只留 **1 个 3 步清单 + 1 屏隐私同意 + 1 屏授权**；功能/FAQ/关于合并为「帮助」页（可从设置进） |
| R11 | 开发指标/技术细节暴露给用户 | `HomePage` `MODULES 15 / REMOTE API 212`；`AboutPage` Electron/Chromium/Node；`Settings` 路径配置文件链接；`oplog` 列 `context` | 用户界面只留「应用版本」；其余进「诊断信息」折叠区 |
| R12 | 死代码 / 孤儿样式（清理项） | `panels/overview-neon.module.css`（无 import）；`panels/DailySummary.tsx` + `daily-summary.module.css`、`panels/PeriodSummary.tsx` + `period-summary.module.css`（`panel-loaders.tsx` 仍有导出但无调用点）；`panels/DailySummary` 的 `data-st-dialog="daily-form"` 链路 | 删除孤儿文件与旧 loader 导出（同步删 `api-module-split.spec.ts` 与 `light-theme-coverage.wiring.spec.ts` / `m6-phone.wiring.spec.ts` 里对这些文件的文本断言），减少 30+KB CSS 与 2 个面板的维护面 |

---

## 8. 全站统一处理模式（设计系统落地）

### 8.1 令牌层（1 处改、全站生效）

`scifi-theme.css`（深色）与 `light-theme.css`（浅色）是唯一定义 `--nm-*` 的地方，64 个面板 CSS、kit、启动页、标题栏全部经它取色。建议**新增一层 `--wx-*` 语义令牌**并把 `--nm-*` 重映射过去（避免直接改 64 个面板），或直接改 `--nm-*` 值（改动更小，但会触发对比度/几何守卫更新，见 §10）。

| 角色 | 现值（深 / 浅） | 微信化建议 |
|---|---|---|
| 品牌主色 | `--nm-cyan` `#00f0ff` / `#0e7490` | **`#07C160`**（微信绿，深浅同值）；hover `#06AD56`；浅底 `#E8F7EE` |
| 次品牌（紫） | `--nm-purple` `#a855f7` / `#7c3aed` | **废弃**；仅图表分类色保留（改 6 级灰 + 1 绿） |
| 页面底 | `--nm-bg-0` `#050a18` / `#f6f8fb` | 深 `#111111` / 浅 `#F7F7F7` |
| 侧栏/标题栏 | `--nm-bg-1` `#0b1220` / `#eef1f6` | 深 `#191919` / 浅 `#F7F7F7` |
| 卡片/输入 | `--nm-bg-card` `#0f172a` / `#ffffff` | 深 `#191919` / 浅 `#FFFFFF` |
| 分割线 | `--nm-border` `rgba(0,240,255,.10)` / `rgba(15,23,42,.12)` | 深 `#2C2C2C` / 浅 `#EDEDED`（1px 或 0.5px） |
| 文字 | `#e2e8f0 / #94a3b8 / #64748b` | `#E5E5E5 / #B2B2B2 / #7F7F7F`；浅 `#191919 / #7F7F7F / #B2B2B2` |
| 状态色 | success `#00ff88`、danger `#ff3b5c`、amber `#f59e0b`、info `#3b82f6` | success `#07C160`、danger `#FA5151`、warning `#FA9D3B`、info `#10AEFF`、link `#576B95` |
| 阴影 | `--nm-shadow-card` 0 4px 32px black50；`--nm-glow-*` | card 改 `0 1px 2px rgba(0,0,0,.04)`（或只留边框）；glow 全部映射为 `none` |
| 圆角 | `--nm-r-md 10 / lg 14 / xl 20` | `6 / 8 / 12`；pill 保留 |
| 字体 | `Inter / SF Pro Display / JetBrains Mono` | 仅系统字体：`-apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif`；数字用 `font-variant-numeric: tabular-nums` |
| 动效 | `--nm-t-normal .25s` + 大量动画 | 统一 150ms `ease-out`；只保留状态过渡与 spinner |

### 8.2 共享组件规范（kit / compact-chrome）

| 组件 | 现状（文件） | 微信化规范 |
|---|---|---|
| `PanelHeader` | `ui/kit-shell.tsx`；compact 覆盖在 `ui/compact-chrome.module.css`：标题 15px + 说明 11px 同行 + 动作右对齐 | **标题 15px/600 `#191919`；说明 11px `#7F7F7F` 单行省略；动作 ≤2 + 更多▾；总高 ≤44px**；标题与导航名同词表；`desc` 可空 |
| `Card` | `kit-shell.tsx` + `kit.module.css` `.card`：圆角 14、深阴影、卡片头 36 | 白底、1px `#EDEDED`、圆角 8、**无阴影**；卡头 36px（13px 标题 + 11px extra）；卡体 12px；卡间距 8 |
| `StatCard` | `kit-shell.tsx`；compact 已改单行 KPI（40–46px） | 保持单行 KPI；删除 `data-tone` 多彩图标底；只允许「中性 / 绿 / 红」三态 |
| `Segmented` | `ui/kit-overlay.tsx`；激活态青底青字 | 微信式：文字 + 2px 绿色下划线（或 28px 胶囊，白底/绿底二选一，全站只用一种） |
| `Toolbar` / `SearchInput` | `kit-shell.tsx`：搜索 320/最小 220，toolbar 可换行 | 单行优先；搜索 240；时间预设短标签（今天/本周/本月/近7天/近30天）；总高 ≤48 |
| `Dialog` / `Drawer` | `kit-overlay.tsx` + `kit-overlay.module.css` | Dialog 520 / Drawer 460–560；圆角 12；遮罩 40% 纯黑；头部 48；底部动作 48；标题 16/600；关闭 32×32 |
| `EmptyState` | `kit.module.css` `.empty`：30px 图标 + 居中 + 88px padding | 单行灰字 + 一个主操作；padding ≤32；居上 1/3 |
| `DataTable` | `kit-table.tsx` + `kit-table.module.css` | 表头 30、行 32、单元格 6/10、斑马纹删除（微信不用斑马纹）、hover 浅灰 |
| 全局覆盖层 | `ui/compact-chrome.module.css`（A 层） | **继续作为唯一全局覆盖**；本次新增的皮肤规则也应放这里（用 `div[class*='_xxx_']` 属性选择器），不改 kit 源文件；不得使用 `!important` |

### 8.3 页头 / 卡片头 / 工具栏 / 弹层「四件套」规范（一页一屏只许出现一次）

1. **页头**：`[标题] [一行说明] ……… [主操作] [更多▾]`，≤44px；合并组内子面板**不画页头**（除工具行）。
2. **筛选行**：单行 ≤48px；只有搜索 + 1 个筛选入口（下拉/抽屉）；时间预设用短标签；不放刷新/导出。
3. **卡片头**：`[13px 标题] ……… [11px extra]`，≤36px；不再出现「卡片标题 = 页头标题」重复。
4. **弹层头**：`[16px 标题] ……… [关闭 32×32]`，48px；弹层内**不再画第二个标题**。

### 8.4 图标与文案规范

- 侧栏：保留 `nav-config.ts` 已按微信字形重画的填充图标（注释详述），不再改形状。
- 页内：统一 16px 线性图标（`@deepseek-ai/dsh-client-ui-primitives`），**禁止 emoji 当图标**（清单见 D8）。
- 文案：动作词统一（刷新/导出/更多/关闭/保存/取消）；状态词统一（在线/离线/检测中、成功/失败/跳过）；空态模板统一（「暂无 X」+ 一条下一步动作）；错误必须与「没有数据」分开（现状已做得不错，保留该纪律）。
- 数字：千分位 `toLocaleString('zh-CN')` 已普遍使用，保持；日期统一 `YYYY-MM-DD HH:mm`。

### 8.5 明确「不做」的边界（避免与现有工程约定冲突）

- 不引入 Bootstrap 全量 CSS / Bootstrap JS；不改 CSS import 顺序（`ui-entry.tsx` 头注）。
- 不改 560 手机断点（`PHONE_QUERY` 同值，`mobile-shell.spec.ts` 守着）。
- 不使用 `!important`、不新增 5/7/9/18 间距、不写死圆角字面量（`theme-geometry` 守卫）。
- 不回退 `UI-DENSITY.md` 指标；不把 `panelShell`/`panelBody` 双滚动契约改回单页整滚。
- 不删 `TAB_LABELS` 的任何 hidden 条目（删 = 深链静默落回总览，`nav-config.ts` 多处注释强调，`contacts-graph-merge.wiring.spec.ts` 守着）。
- 不改 `DIALOG_SECTION_OF` 的 6 个改道键。
- 不在本轮改后端/Remote 方法面（`API.md` 由 `docs:api` 生成并 CI 校验）。

---

## 9. 改版优先级清单

> 排序原则：P0 = 首屏与高频主路径（外壳 / 首启 / overview / chats / ask / 总结 / 设置）；P1 = 其余可见页与主链路弹层；P2 = 隐藏/低频页、设置内嵌节、清理项。每批 ≤8 个文件（沿用 `UI-DENSITY.md` §3 的批次纪律），每批后跑密度/响应式审计。

### P0（首批，决定"第一眼是不是微信"）

| 序 | 范围 | 含条目 | 关键动作 | 依赖 |
|---:|---|---|---|---|
| 1 | 令牌与共享组件 | §8.1、§8.2；`scifi-theme.css`、`light-theme.css`、`ui/kit.module.css`、`ui/compact-chrome.module.css` | 品牌绿、去发光/渐变/玻璃、圆角/阴影/字体重定调 | 需同步更新主题对比度/几何守卫（§10） |
| 2 | 外壳 | SH-01、SH-02、SH-03、SH-04、SH-08、SH-09、SH-10 | 标题栏/侧栏/搜索/合并条/弹层统一；删网格与发光；品牌位收敛 | 1 |
| 3 | 首启闸门 | GT-01～GT-08 | 删粒子/背景/扫描线/HUD；启动页改单列自适应；文案去重并修 nav 漂移；隐私同意单列；授权页合并 | 1 |
| 4 | 数据总览 | NV-01 | KPI 8→4、卡 14→6、动作 3→2、删扫描条；孤儿 CSS 删除 | 1、2 |
| 5 | 聊天会话 | NV-07、NV-08、NV-09、DL-02/03/04/05/06/07/08/09/11/12/13 | 删雨窗；会话头动作 6→2；AI 右栏统一抽屉；5 套灯箱收敛 1 套；自绘弹层换 kit | 1、2 |
| 6 | 微信问答 | NV-02、DL-11/12/14 | 标题/说明/badge 收敛；过程时间线折叠；引用详情改抽屉 | 1、2 |
| 7 | 总结 | NV-03（+ NV-04 年度报告可顺带）、DL-16 | 删三重标题；history 改抽屉；格式收下拉；空态单行 | 1、2 |
| 8 | 设置弹窗 | NV-20、DL-01、DL-20 | 尺寸收缩、左导航单行、右区单节、删重复分组标题；内嵌节去页头 | 1、2 |

### P1（其余可见页与主链路弹层）

| 范围 | 含条目 | 关键动作 |
|---|---|---|
| 知识库 | NV-06、DL-17 | 默认落点与入口名一致；三段统一工具行；库 rail 与分段合并；图谱去玻璃/脉冲 |
| 群聊分析 | NV-10 | 三套命名统一；共用工具行；热力改单色 |
| 通讯录 | NV-11、DL-15 | 补 36px 工具行；9 分类→5；导出记录进更多；资料抽屉复用 |
| 朋友圈 | NV-12 | 页头 6 动作→2；右栏筛选改抽屉；删发光/玻璃；洞察 10 卡→4 卡 |
| 收藏与表情 | NV-13 | 分段名统一；内层页签改二级下拉；统计页去列表重复 |
| 文件与存储 | NV-14 | 4 页标题统一分段名；媒体合并进存储；KPI 条；动作≤2 |
| 资金往来 | NV-15 | 标题统一；6 分类段条改筛选；KPI 4→3 |
| ClawBot | NV-16、DL-18 | 删 🦞；两级切换改下拉；设置/会话合一页 |
| 待办日程 / 任务信息 | NV-17、NV-18、DL-09/10 | 标题统一；两段说明合一；写操作二次确认；弹窗收敛 |
| 操作日志 | NV-19 | 删 ⚙；筛选去 Card 外壳；统计并进工具行 |
| 手机端外壳 | SH-07 | 底栏去模糊/发光；更多 sheet 改分组列表 |
| 年度报告 | NV-04 | 27 卡→8 卡；7 tone→中性+强调；口径收进 subtitle |

### P2（隐藏/低频页、内嵌节与清理项）

| 范围 | 含条目 | 关键动作 |
|---|---|---|
| 设置内嵌节 | DL-20（privacy / boundary / backup / health / hook / remote） | 随 P0 设置容器统一为 kit Card + 无页头；各节视觉微调 |
| hidden 分段 | calls/revoked/monitor/graph/knowledge/kbfiles/emoticons/assetinsights/mediaassets/storage/officialassets/records 的剩余装饰 | 跟随所在 P0/P1 页面的令牌与组件自动收敛；仅补删遗留渐变/发光 |
| 周期报告 | NV-05 | 保持深链；清理 `PeriodSummary`/`DailySummary` 旧面板与 CSS、`overview-neon.module.css` |
| 图表/地图类视觉 | overview 世界地图、词云、Annual 海报卡、footprint | 统一灰阶+单绿；词云字体/配色收敛；地图非品牌色改浅灰 |
| 提示/审计类 | NoticeBanner、SetupGuide 合并后的单卡、诊断预览 Dialog | 收尾统一 |

---

## 10. 验收与守卫清单（改版会触碰的既有判据）

| 判据 / 文档 | 位置 | 改版影响 | 处理 |
|---|---|---|---|
| `docs/UI-DENSITY.md` §1 指标 | 文档 + `npm run ui:density-audit` | 去装饰通常改善 `emptyRatio`，但删页头可能改变 `headerH` 统计口径 | 每批后跑审计与 `ui:density-gate`，0 回退 |
| `ui/compact-chrome.module.css` 三根硬线 | 文件头注 | 新皮肤规则必须沿用「标签+属性子串 + 无 !important」 | 新增规则进同文件/同模式 |
| `theme-contrast.guard.spec.ts` / `wx-skin-contrast.guard.spec.ts` | `src/client/ui-wechat/src/client/pages/wechat-data/` | 品牌绿/中性色替换后会重算对比度 | 同步更新期望值（这是一次**有意的皮肤变更**，不是回退） |
| `theme.spec.ts` / `theme-tokens.spec.ts` / `theme-alpha-ladder.spec.ts` | `src/client/ui-wechat/src/client/pages/wechat-data/` | 令牌值被固定断言 | 同步更新令牌字面量断言 |
| `theme-geometry.spec.ts` | `src/client/ui-wechat/src/client/pages/wechat-data/` | 圆角/间距/阴影令牌 | 新值必须是 4/6/8/10/12/16 与合法圆角 |
| `light-theme-coverage.wiring.spec.ts` | `panels/` | 浅色必须覆盖所有新皮肤（含启动页 `overview-neon` 的裸色规则） | 新增皮肤同时写深/浅两套 |
| `brand-consistency.spec.ts` | `src/client/ui-app/` | 品牌名/标题/图标一致性 | 品牌位收敛后同步 |
| `dialog-a11y.wiring.spec.ts` | `src/client/ui-wechat/src/client/pages/wechat-data/panels/` | 自绘弹层改 kit 后焦点/aria 断言 | 确认 `data-st-dialog` 探针保留 |
| `nav-migration.spec.ts` / `panels/nav-onboarding-drift.wiring.spec.ts` / `ui/mobile-nav.spec.ts` | `panels/`、`ui/` | 侧栏标签/启动页分组/手机白名单 | 启动页改「从 NAV_GROUPS 现算」时一并更新；`nav-onboarding-drift` 只比分组名与顺序，**不比 items**（本次发现的 items 漂移不会被它拦住，需补一条 items 判据） |
| `onboarding-ssr` 冒烟 + `onboarding-css-split.wiring.spec.ts` | `scripts/`、`onboarding/` | 启动页删层后 SSR 结构改变 | 更新 SSR 夹具与 CSS 拆分断言 |
| `function-size-ratchet.spec.ts` | `src/backend/tests/` | 删改大函数时行数只能变小 | 拆组件而不是堆回原函数 |
| `panels/docs-consistency.wiring.spec.ts` / `src/backend/tests/api-docs.spec.ts` | `panels/`、`src/backend/tests/` | 首页 `MODULES 15 / REMOTE API 212` 等数字 | 若删开发指标，同步删该断言；导航数字改由代码现算 |
| `ui:responsive-gate` / `ui:density-gate` | `package.json` 脚本 | 启动页从固定舞台改自适应会改变 390/768 截图 | 先改启动页再跑 228 格响应式审计 |
| `scripts/nav-shell-e2e.mjs` | `scripts/` | 侧栏「默认展开 → 收起 → 展开」真机几何 | 改侧栏样式后复跑 |

---

## 11. 附录 A：覆盖自检

| 需求项 | 覆盖条目 | 状态 |
|---|---|---|
| 外壳：`ui-entry.tsx` / `index.html` / `titlebar-status.tsx` / `titlebar.css` / `browser-gate.tsx` / `WechatDataPanel.tsx` / `nav-config.ts` / `wechat-data.module.css` | SH-01、SH-02、SH-03、SH-04、SH-08、SH-09、GT-08 | ✅ |
| 首启：`onboarding/**`（Shell + 4 页 + particles/stage-chrome/runtime）、`PrivacyConsentGate`、`LicenseGate`、`LicenseAuthPanel` | GT-01～GT-07 | ✅ |
| 侧栏 5 组全部可见项（overview/ask/dailysummary/kb/chats/groupinsights/contacts/moments/favorites/files/ledger/clawbot/tasks/taskinfo/oplog/settings） | NV-01～NV-20 + 4.1 映射表 | ✅ |
| 全部合并分段：chats 家族（chats / calls / revoked）、总结族（dailysummary / annual / period）、知识族（kb / knowledge / kbfiles）、contacts / graph、moments / momentsinsights、favorites / emoticons / assetinsights、files / mediaassets / storage / officialassets、ledger / records、groupinsights / monitor | 4.1 映射表；NV-03/04/05/06/07/08/09/10/11/12/13/14/15 | ✅ |
| 主要弹窗/抽屉：设置各节、会话导出/日历/聊天记录/已编辑、群信息/聊天信息、新建任务/触发记录、AI 右栏、引用详情、图片查看器、问答历史、导出记录、定时任务、知识库管理、扫码绑定、确认框、设置内嵌面板 | DL-01～DL-20 | ✅ |
| 每项记录：入口 id / 入口文件 / 主 CSS / 固定区与滚动区 / 重复文案 / 装饰证据（文件+选择器）/ 层级问题 / 微信化要点 | §2–§5 各表齐全 | ✅ |
| 结论：P0/P1/P2 + 可固定重复内容 + 全站统一模式 | §7、§8、§9 | ✅ |
| 与既有文档对齐（UI-DENSITY / BOOTSTRAP-RESPONSIVE / ARCHITECTURE） | §1.3、§10 | ✅ |
| 路径真实性 | 本文所有 `src/**`、`scripts/**`、`docs/**` 路径均已用文件系统逐条核对存在（293 个文件路径 token，0 缺失；`license.json` 为产品数据文件名，非仓库源码路径） | ✅ |

## 12. 附录 B：主要文件索引（按目录）

- **外壳**：`src/client/ui-app/ui-entry.tsx`、`src/client/ui-app/index.html`、`src/client/ui-app/titlebar.css`、`src/client/ui-app/titlebar-status.tsx`、`src/client/ui-app/titlebar-status.css`、`src/client/ui-app/browser-gate.tsx`、`src/client/ui-app/browser-gate.module.css`、`src/client/ui-app/scrollbars.css`、`src/client/ui-app/mobile-viewport.css`、`src/client/ui-app/mobile-browser.css`、`src/client/ui-app/bootstrap-bridge.css`
- **首启**：`src/client/ui-app/onboarding/OnboardingShell.tsx`、`src/client/ui-app/onboarding/onboarding.module.css`、`src/client/ui-app/onboarding/onboarding-stage.module.css`、`src/client/ui-app/onboarding/onboarding-stages.module.css`、`src/client/ui-app/onboarding/onboarding-content.tsx`、`src/client/ui-app/onboarding/runtime.ts`、`src/client/ui-app/onboarding/particles.tsx`、`src/client/ui-app/onboarding/stage-chrome.tsx`、`src/client/ui-app/onboarding/Reveal.tsx`、`src/client/ui-app/onboarding/store.ts`，以及 `src/client/ui-app/onboarding/pages/` 下 `HomePage.tsx`、`FeaturesPage.tsx`、`HelpPage.tsx`、`AboutPage.tsx`；`src/client/ui-app/privacy/PrivacyConsentGate.tsx`、`src/client/ui-app/privacy/PrivacyConsentGate.module.css`、`src/client/ui-app/privacy/consent.ts`；`src/client/ui-app/license/LicenseGate.tsx`、`src/client/ui-app/license/LicenseAuthPanel.tsx`、`src/client/ui-app/license/license-gate.module.css`、`src/client/ui-app/license/license-expiry.ts`
- **主容器**：`src/client/ui-wechat/src/client/pages/wechat-data/WechatDataPanel.tsx`、`src/client/ui-wechat/src/client/pages/wechat-data/wechat-data.module.css`、`src/client/ui-wechat/src/client/pages/wechat-data/nav-config.ts`、`src/client/ui-wechat/src/client/pages/wechat-data/panel-loaders.tsx`、`src/client/ui-wechat/src/client/pages/wechat-data/scifi-theme.css`、`src/client/ui-wechat/src/client/pages/wechat-data/light-theme.css`
- **共享 UI**：`src/client/ui-wechat/src/client/pages/wechat-data/ui/kit.module.css`、`kit-shell.tsx`、`kit-overlay.tsx`、`kit-overlay.module.css`、`kit-table.tsx`、`kit-table.module.css`、`compact-chrome.module.css`、`confirm.tsx`、`confirm.module.css`、`mobile-nav.tsx`、`mobile-nav.module.css`、`desktop-only.tsx`、`error-boundary.tsx`
- **面板**：`panels/` 下 149 个非 spec TSX / 64 个 CSS；本文涉及的入口组件与 CSS 已在 §4.1 与 §5 逐条列出
- **既有规范**：`docs/UI-DENSITY.md`、`docs/BOOTSTRAP-RESPONSIVE.md`、`docs/ARCHITECTURE.md`、`docs/CARD-SIZE.md`

---

*本文只读产出，未改动任何源码、构建或脚本。若需按本文执行改版，建议先开一个只改「令牌 + kit + compact-chrome」的皮肤 PR（P0-1），在真机 6 档截图与密度/响应式审计通过后，再按 P0-2…P0-8 分批推进。*
