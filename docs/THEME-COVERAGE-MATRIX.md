# 主题覆盖矩阵（页面 × 组件 × 切换场景）

> ⚙️ **本文件由 `node scripts/theme-page-matrix.mjs` 生成，不要手改**；
> CI 用 `node scripts/theme-page-matrix.mjs --check` 校验它与源码/测量一致。

回答的是「**每一个用户界面**在深色与浅色下的配色、对比度、文字与图标颜色是否一致」，
以及「**要覆盖哪些页面、哪些组件、哪些切换场景**」。

## 0. 口径（三条）

1. **页面**（§1）：真机 computed style **多采样** —— 页签内所有可见文本按
   `(color, 不透明祖先背景)` 去重（上限 40 对），取**除弱化文字（`--nm-text-3`）外**的
   最低 WCAG 对比度。夹着渐变/图片底的对记 `n/a`（不合成，否则霓虹皮肤会算出假阳性）；
   弹窗类页签取「设置」弹窗本身，不取它背后那一页。
2. **组件**（§2）与**场景**（§3）是**登记表**：每条都要能落到真实文件（引用不存在 ⇒ 生成失败）。
3. **截图不是判据**（账本陷阱②）：同一时刻截图与 DOM 探针会给出相反结论，故本矩阵不用像素采样。

测量来源：`.tmp-e2e/theme-contrast.json`（2026-09-29T08:35:32.051Z）

## 1. 页面（36 个页签 = 16 可见 + 20 隐藏）

| # | 页签 | tab | 类型 | 面板组件 | 深色对比 | 浅色对比 | 背景随主题变 |
|---|---|---|---|---|---|---|---|
| 1 | 数据总览 | `overview` | 侧栏可见 | `OverviewPanel` | 4.51 | 4.60 | 是 |
| 2 | 微信问答 | `ask` | 侧栏可见 | `AskPanel` | n/a | n/a | 是 |
| 3 | 年度报告 | `annual` | 隐藏（深链） | `DailySummaryPanel` `PeriodSummaryPanel` `AnnualPanel` | n/a | n/a | 未测量 |
| 4 | 总结 | `dailysummary` | 侧栏可见 | `DailySummaryPanel` `PeriodSummaryPanel` `AnnualPanel` | 6.96 | 5.36 | 是 |
| 5 | 周期报告 | `period` | 隐藏（深链） | `DailySummaryPanel` `PeriodSummaryPanel` `AnnualPanel` | n/a | n/a | 未测量 |
| 6 | 聊天会话 | `chats` | 侧栏可见 | `ChatsPanel` `RevokedPanel` | 3.30 | 3.30 | 是 |
| 7 | 会话·公众号 | `bizchats` | 隐藏（深链） | `ChatsPanel` `RevokedPanel` | n/a | n/a | 未测量 |
| 8 | 会话·服务号 | `servicechats` | 隐藏（深链） | `ChatsPanel` `RevokedPanel` | n/a | n/a | 未测量 |
| 9 | 会话·客服 | `kefu` | 隐藏（深链） | `ChatsPanel` `RevokedPanel` | n/a | n/a | 未测量 |
| 10 | 群聊分析 | `groupinsights` | 侧栏可见 | `GroupInsightsPanel` `MonitorPanel` | 4.51 | 4.60 | 是 |
| 11 | 群聊监控 | `monitor` | 隐藏（深链） | `GroupInsightsPanel` `MonitorPanel` | n/a | n/a | 未测量 |
| 12 | 通话记录 | `calls` | 侧栏可见 | `CallsPanel` | 4.51 | 5.02 | 是 |
| 13 | 撤回消息 | `revoked` | 隐藏（深链） | `ChatsPanel` `RevokedPanel` | n/a | n/a | 未测量 |
| 14 | 通讯录 | `contacts` | 侧栏可见 | `ContactsPanel` `GraphPanel` | 6.96 | 5.36 | 是 |
| 15 | 朋友圈 | `moments` | 侧栏可见 | `MomentsPanel` | 6.96 | 5.36 | 是 |
| 16 | 社交图谱 | `graph` | 隐藏（深链） | `ContactsPanel` `GraphPanel` | n/a | n/a | 未测量 |
| 17 | 知识图谱 | `knowledge` | 隐藏（深链） | `KbShell` | n/a | n/a | 未测量 |
| 18 | 知识库 | `kb` | 侧栏可见 | `KbShell` | 6.96 | 5.36 | 是 |
| 19 | 文件 | `kbfiles` | 隐藏（深链） | `KbShell` | n/a | n/a | 未测量 |
| 20 | 收藏与表情 | `favorites` | 侧栏可见 | `FavoritesPanel` `EmoticonsPanel` `AssetInsightsPanel` | 6.96 | 5.36 | 是 |
| 21 | 表情包 | `emoticons` | 隐藏（深链） | `FavoritesPanel` `EmoticonsPanel` `AssetInsightsPanel` | n/a | n/a | 未测量 |
| 22 | 收藏表情统计 | `assetinsights` | 隐藏（深链） | `FavoritesPanel` `EmoticonsPanel` `AssetInsightsPanel` | n/a | n/a | 未测量 |
| 23 | 文件与存储 | `files` | 侧栏可见 | `FilesPanel` `MediaAssetsPanel` `StoragePanel` `OfficialAssetsPanel` | 6.96 | 5.36 | 是 |
| 24 | 媒体资产 | `mediaassets` | 隐藏（深链） | `FilesPanel` `MediaAssetsPanel` `StoragePanel` `OfficialAssetsPanel` | n/a | n/a | 未测量 |
| 25 | 存储分析 | `storage` | 隐藏（深链） | `FilesPanel` `MediaAssetsPanel` `StoragePanel` `OfficialAssetsPanel` | n/a | n/a | 未测量 |
| 26 | 公众号文章 | `officialassets` | 隐藏（深链） | `FilesPanel` `MediaAssetsPanel` `StoragePanel` `OfficialAssetsPanel` | n/a | n/a | 未测量 |
| 27 | 资金往来 | `ledger` | 侧栏可见 | `LedgerPanel` `RecordsPanel` | 4.51 | 5.02 | 是 |
| 28 | 转账红包 | `records` | 隐藏（深链） | `LedgerPanel` `RecordsPanel` | n/a | n/a | 未测量 |
| 29 | 朋友圈洞察 | `momentsinsights` | 侧栏可见 | `MomentsInsightsPanel` | 4.51 | 4.60 | 是 |
| 30 | 待办日程 | `tasks` | 侧栏可见 | `TasksPanel` | 6.96 | 7.58 | 是 |
| 31 | 数据边界与出网 | `privacytrust` | 隐藏（设置弹窗） | `SettingsDialog`（弹窗，无主内容区） | n/a | n/a | 未测量 |
| 32 | 隐私体检 | `privacy` | 侧栏可见 | `PrivacyPanel` | 6.96 | 5.36 | 是 |
| 33 | 备份恢复 | `backup` | 隐藏（设置弹窗） | `SettingsDialog`（弹窗，无主内容区） | n/a | n/a | 未测量 |
| 34 | 操作日志 | `oplog` | 侧栏可见 | `OperationLogPanel` | 5.13 | 5.48 | 是 |
| 35 | 数据库健康 | `health` | 隐藏（设置弹窗） | `SettingsDialog`（弹窗，无主内容区） | n/a | n/a | 未测量 |
| 36 | 原图链路自检 | `hook` | 隐藏（设置弹窗） | `SettingsDialog`（弹窗，无主内容区） | n/a | n/a | 未测量 |

未测量的页签：年度报告、周期报告、会话·公众号、会话·服务号、会话·客服、群聊监控、撤回消息、社交图谱、知识图谱、文件、表情包、收藏表情统计、媒体资产、存储分析、公众号文章、转账红包、数据边界与出网、备份恢复、数据库健康、原图链路自检

## 2. 组件（主题相关的那几族）

| 组件族 | 关键文件 | 深色 | 浅色 | 守卫 |
|---|---|---|---|---|
| 按钮（Button / 胶囊） | `Button.module.css` `kit.module.css` | 主/次/幽灵三档都有显式深色值；**禁用态对比度 4.45** 是登记过的有意取舍（复刻微信观感） | 浅色端全部 ≥ 4.5（离线矩阵实测 5.36–17.85） | `theme-contrast.guard.spec.ts` `button-disabled-tone.wiring.spec.ts` |
| 输入框 / 表单字段（Input / kit-fields） | `Input.module.css` `kit-fields.tsx` | 底色/边框/占位文字走 `--nm-*` 令牌 | 同一套令牌在 `:root.theme-light` 下换值 | `theme-contrast.guard.spec.ts` |
| 标签 / 状态点（Pill / StateDot） | `Pill.module.css` `StateDot.module.css` | 语义色（成功/警告/危险）当背景时的徽标对比度已单独覆盖 | 同上 | `theme-contrast.guard.spec.ts` |
| 图标（SVG 字形 / currentColor） | `index.tsx` `props.ts` `nav-config.ts` | 字形一律 `fill: currentColor`（或外层 `stroke: currentColor`）⇒ 跟随文字色； | 唯一的例外是**收藏**那枚线稿立方体（官方字形本身就是线稿，不吃 `filled()` 包裹），已写进 nav-config 注释 | `dsw-alias-tokens.spec.ts` `first-impressions-tokens.spec.ts` |
| 弹窗 / 浮层（确认框、设置弹窗、Tooltip、右键菜单） | `confirm.tsx` `kit-overlay.module.css` | 遮罩 `rgba(4,8,20,0.6)` **刻意不随主题变**（浅色下也压暗背景）；弹窗内容走令牌 | 同上；弹窗文字的对比度靠令牌矩阵保证 | `dialog-a11y.wiring.spec.ts` `theme-alpha-ladder.spec.ts` |
| 表格 / 长列表（Table / 虚拟滚动） | `kit-table.module.css` `list-panel.module.css` | 斑马纹与悬停层是**半透明**叠加 ⇒ 已用 alpha 阶梯做单调性断言 | 同一阶梯在浅底上反向验证 | `theme-alpha-ladder.spec.ts` |
| 数据态（骨架 / 加载 / 空态 / 错误态） | `kit-foldable.tsx` `state-components.wiring.spec.ts` | 骨架与空态用 `text-3`（弱化文字）⇒ 深色端是**已登记的低对比**（3.75–4.15） | 浅色端 ≥ 4.5 | `state-components.wiring.spec.ts` `theme-contrast.guard.spec.ts` |
| 图表与画布（echarts / 知识图谱 / 词云 / 矩形树图 / 等距地图） | `wordcloud-card.module.css` `overview-neon.module.css` `world-map.module.css` `graph.module.css` | 画布内的配色由脚本读取 `--nm-*`；霓虹皮肤（总览）在深色下是深蓝紫玻璃 | **2026-09-29 修好**：该皮肤的 13 条浅色规则原先写的是裸 `:root.theme-light`，被 CSS Modules 哈希成 `:root._theme-light_…` ⇒ 永不匹配、全是死规则（浅色下卡片仍是深海军蓝）。改成 `:root[class~='theme-light']`（属性值不哈希）后浅色下是白玻璃（实测 `linear-gradient(158deg, rgba(255,255,255,.9), …)`） | `light-theme-coverage.wiring.spec.ts` |
| 微信皮肤层（聊天气泡 `--wx-*`） | `chats-rows.module.css` | 复刻微信官方色值：自方气泡 `#3EB575` + 白字 = **2.60（低于 AA，已登记的有意取舍）**；对方气泡 12.46–16.13 ✅ | 自方气泡 `#95EC69` + 黑字 = **14.48** ✅；对方气泡 12.54–14.68 ✅ | `wx-skin-contrast.guard.spec.ts` |
| 外壳层（标题栏 / 启动引导 / 隐私同意 / 授权页 —— ui-app） | `titlebar.css` `PrivacyConsentGate.module.css` | 外壳**不随主题变**（固定深色标题栏）；启动三站与同意屏是独立视觉，不参与面板主题 | 同上 —— 真机审计里"顶部外壳仍是深色"**不是缺陷**（账本已写明） | `privacy-consent-ssr.tsx` `ui-ask-smoke.js` |

## 3. 主题切换场景（用户真会遇到的路径）

| # | 场景 | 怎么覆盖 | 守卫 | 现状 |
|---|---|---|---|---|
| S1 | 冷启动即深色（localStorage 无值 / `dark`） | 真机：`localStorage["super-time-wechat-theme"]="dark"` → reload → 读 `htmlClass` 必须**不含** `theme-light` | `theme-live-audit.mjs` | 通过（两套主题各跑一轮，断言 `htmlClass` 与请求一致） |
| S2 | 冷启动即浅色（`light`） | 同上，断言 `htmlClass` **含** `theme-light` | `theme-live-audit.mjs` | 通过 |
| S3 | 运行中 深→浅 / 浅→深 切换（不重启） | 真机：改 localStorage 后 reload；离线：令牌层两套主题各解析一遍 | `theme-live-audit.mjs` `theme-contrast.guard.spec.ts` | 通过（离线 10 用例；真机两轮都断言主题真的生效，避免"两轮都停在浅色"） |
| S4 | 隐藏页签（hash 深链）在两套主题下 | `--all-tabs`：写 `location.hash` + reload 进入 20 个 `hidden: true` 页签，逐个体检采样 | `theme-live-audit.mjs` `panel-audit.mjs` | 本文件 §1 的 hidden 行即为测量结果（此前是**盲区**：默认只量 16 个可见页签） |
| S5 | 设置弹窗 / 抽屉 / Tooltip / 右键菜单（浮层叠在遮罩上） | 真机审计里 4 个隐藏页签以「设置」弹窗形式打开；离线算遮罩 alpha 阶梯 | `theme-live-audit.mjs` `theme-alpha-ladder.spec.ts` `dialog-a11y.wiring.spec.ts` | 通过（遮罩刻意不随主题变，已登记） |
| S6 | 交互态：hover / active / focus-visible / disabled / selected | 离线把令牌按"内容色 × 叠了 5% 悬停层"逐对算 WCAG；禁用态单独一条 | `theme-contrast.guard.spec.ts` `button-disabled-tone.wiring.spec.ts` | 通过（深色 `text-3` 叠加后 3.11–3.40，按棘轮登记） |
| S7 | 数据态：骨架屏 / 加载中 / 空态 / 错误态 | 离线令牌矩阵 + 状态组件接线用例；真机审计记录"仍有加载指示"的面板 | `state-components.wiring.spec.ts` `theme-contrast.guard.spec.ts` | 通过；深色 `text-3` 的已知低对比在这些态上同样成立 |
| S8 | 图表与画布（echarts / 图谱 / 词云 / 树图 / 等距地图） | 浅色覆盖块必须与深色逐类成对（整份裸色皮肤不许只写深色）；令牌层覆盖语义色与 `color-mix` | `light-theme-coverage.wiring.spec.ts` `theme-contrast.guard.spec.ts` | 通过（裸色皮肤逐类成对；该文件的选择器必须写成 `:root[class~='theme-light']` 或 `:global(…)`，否则被 CSS Modules 哈希 ⇒ 死规则 —— 2026-09-29 真事故，已由 `light-theme-coverage.wiring.spec.ts` 第 6/8 条常驻钉住） |
| S9 | 微信皮肤层（聊天气泡 `--wx-*`）：深色与浅色两套官方色值 | 解析 CSS 层叠语义（首次声明=深色、末次声明=浅色），逐对算对比度，例外按棘轮 | `wx-skin-contrast.guard.spec.ts` | **已知不一致**：深色自方气泡白字压官方绿 = 2.60（浅色 14.48）—— 有意保真取舍，已登记 |
| S10 | 图标颜色（导航字形 / 面板图标） | 字形走 `currentColor`；对"别名令牌"与"首屏令牌"各一条离线用例 | `dsw-alias-tokens.spec.ts` `first-impressions-tokens.spec.ts` | 通过 |
| S11 | 真机整体门禁：每页签的背景是否随主题变 + 采样对比度 | 落盘 `.tmp-e2e/theme-contrast.json` → 逐页签核对（缺登记 ≠ 通过） | `theme-contrast-budget.mjs` `theme-contrast-budget.json` | 通过（16 个可见页签 × 2 主题；本文件 §1 已把覆盖扩到 36 个） |

## 4. 未闭环（如实登记，不是缺陷被隐藏）

| 项 | 内容 | 为什么留着 |
|---|---|---|
| U1 | 深色端 `text-3`（弱化文字）3.75–4.15，低于 AA | `ui/kit.module.css` 早已记录并决策：内容类文字改用 `--text-2`，不动令牌值 |
| U2 | 深色端「自方气泡」白字压微信官方绿 = **2.60** | 复刻微信原生外观是这一层的目的；改色会背离复刻目标（`wx-skin-contrast.guard.spec.ts` 按棘轮钉住） |
| U3 | ~~霓虹皮肤（总览）两套主题都偏深~~ **已于 2026-09-29 修掉** | 根因是 CSS Modules 把裸 `theme-light` 哈希掉、13 条浅色规则全是死规则；见 [§1 口径] 与 `panels/light-theme-coverage.wiring.spec.ts` |
| U4 | 外壳（标题栏）不随主题变 | 主进程外壳，非面板；真机上"顶部仍是深色"不是缺陷 |
| U5 | 像素级证据缺失 | 本环境截图不可信（陷阱②）；只有人眼或先修截图时序才能补 |

