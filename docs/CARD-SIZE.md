# 卡片尺寸规范（CARD-SIZE）

> 2026-10-18 用户要求：「检查并修复所有卡片，限制每一张卡片的大小，不要因为分辨率影响每一张卡片的布局。」
> 本文是这次全站卡片尺寸收口的规范、实现位置、例外与验证方式；密度目标见 [UI-DENSITY.md](UI-DENSITY.md)，
> 响应式缺陷口径见 [BOOTSTRAP-RESPONSIVE.md](BOOTSTRAP-RESPONSIVE.md) §5.1。
>
> **二次反馈（同日）**：「不要居中，弄回之前的布局」—— 已撤销「内容画布 max-width:1480px 居中」这一层，
> 内容区恢复原来紧跟侧边栏、铺满可用宽度的排版；高度预算、卡内滚动、网格 `align-items:start` 保留。

## 1. 目标

1. **每张卡都有高度上界**：内容不再把卡片撑到 5000px 高；宽度沿用各面板原有布局（不设全局上限）。
2. **分辨率只影响列数，不影响卡内布局**：卡内排版（表格行列、图表、列表）按自身容器尺寸稳定渲染；
   卡与卡之间不做「一行里最高卡拉高其他卡」的拉伸。
3. **内容超出走卡内滚动**：不裁切、不藏内容，也不无限长高。

## 2. 约束（全局层，`ui/compact-chrome.module.css` §8）

| 约束 | 值 | 命中范围 |
|---|---|---|
| 内容卡卡身高度 | **≤ min(60vh, 526px)**，整卡 ≤ 卡身+72px（≈598px）；被父布局拉伸的卡同样封顶（显式标 `_fillCard_` 的铺满卡除外，见 §3） | 所有带标准卡身的卡（`_cardBd_*` 与 flush 卡身 `_cardBdFlush_*`，以及自定义 `_cardBody_*`） |
| 视觉卡卡身高度 | **≤ min(82vh, 788px)**，整卡 ≤ 卡身+72px（≈860px） | 含 `canvas / svg / _map_ / _graph_ / _heat_ / _calendar_ / _chart_ / _plot_ / _wordcloud_ / _stage_ / _editor_` 的卡 |
| 卡身滚动 | `overflow-y:auto; min-height:0` | 同上（高度预算落在**卡身**，卡片本身按 header+卡身自然高度） |
| 卡片宽度 | `max-width:100%`（不设全局上限，跟随面板原布局） | 所有 `_card_`（含 `<section>` 根，选择器不带标签） |
| 卡片网格 | `align-items:start` | 所有 `_cardGrid_`：卡高按内容，不被行内最高卡拉高 |

> 为什么高度预算落在卡身而不是整卡：整卡 `max-height` 会被外卡 `overflow:hidden` 静默裁掉内容，
> 响应式审计判为 y-clip（实测 officialassets / mediaassets / oplog / storage / monitor / groupinsights 都中招）。
> 卡身限高 + 卡身滚动后，卡片总高仍有界（预算 + 卡头 ~35px），内容可通过滚动到达。
>
> **卡片间距（2026-10-18）**：总览 `OvSection` 采用「Bootstrap 栅格列 wrapper（`.ovCol`）+ 卡片
> （`.ovSectionCard`）」两层结构，`col-*` 与 gutter 落在 wrapper 上，卡片铺满列内容盒 ——
> 横向 / 纵向间距统一为 Bootstrap `g-2` = **8px**（与 KPI 卡、卡内间距同一刻度）。
> 不要把 `col-*` 直接挂到 kit Card 上：那样 gutter 会变成卡片内 padding，卡片背景铺满整列，
> 横向间距会变成 0px（卡边贴卡边）。

## 3. 例外与非目标

- **视觉类卡**（地图 / 图谱 / 热力 / 日历 / 图表 / 词云 / 编辑器 / 二维码）按自身宽高比渲染，只给宽松上限
  （卡身 ≤788 / 整卡 ≤860）；这些卡的容器高度由各自设计决定（地图/图谱已有显式高度），硬压会变形。
- **主列表/表格/待办卡撑满屏幕**（2026-10-18 用户报「其他面板的卡片要撑满屏幕」）：
  操作日志表格卡、转账红包明细卡、待办卡对**面板剩余高度**做 `flex:1 + max-height:none`，
  内容溢出由卡内滚动接住；这三类卡不再套用全局 `min(60vh,526px)` 高度上限，
  其余卡片仍保留上界。实现见各面板 CSS 的 `.root > .tableCard` / `.panel > .recordsCard` /
  `.fill > [class*='_card_']`。
- **单卡铺满剩余高度（`fillCard` 契约，2026-10-18 第二轮）**：用户报「看一下其他面板，没有铺满屏幕的请修复」。
  体检 14 个主面板 + 6 组内部页签后，发现 5 个视图的单张列表/表格/消息卡被上面的全局上界截在 598px，
  下方留 88~300px 空白：知识库·文件、知识库·笔记库、文件与存储·公众号文章、收藏与表情·收藏/表情统计、
  群聊分析·活跃监控。修法是给这些卡加 `className={css.fillCard}`（类名会被哈希成 `_fillCard_*`），
  `compact-chrome.module.css` 用 `[class*='_fillCard_'][class*='_fillCard_']` 把特异度抬到 (0,3,0)
  后解除卡 + 卡身两条 `max-height`；各面板再让父布局（grid/flex）分配高度、卡身/表格/消息列表吃满，
  长内容在卡内滚动。铺满卡不参与「按内容封顶」的口径，但**长内容仍必须有卡内滚动**（不允许整页溢出）。
- **大屏（2560×1400）复查补漏（2026-10-18 第三轮）**：上一轮按 1456×908 体检，最大化窗口后仍有 4 处空白 ——
  群聊分析·离线洞察的发帖排行卡（被全局 598px 截住）、ClawBot 集群的设置卡（命中「视觉类卡」860px 上界）、
  ClawBot 会话视图的 `.chatCard`（同样被全局 598px 截住，消息列表只到卡的一半）、
  操作日志表格（卡身满了，但 kit `DataTable` 的 `.tableWrap` 仍受 `max-height:62vh` 限制，卡内余下 300px+）。
  修法：前三者同样接 `fillCard`（父级 `.col` / `.settingsCol` / `.workChat` 已经会分配整列高度），
  操作日志在面板 CSS 里把 `.tableWrap` 改成 `flex:1 1 auto + max-height:none`（滚动仍由 `.tableWrap` 自己承担，
  「已加载最近 N 条」提示条落在卡底）。四类改动都不放宽其他卡的上界。
- **无标准卡身的面板自定义卡**（没有 `_cardBd_*` 也没有 `_cardBody_*` 的，如朋友圈信息流卡、总结工作台卡、
  设置分节卡）由所属面板 CSS 模块自己给上界与卡内滚动，已收口的模块：
  - `moments.module.css` `.card`：`max-height:min(60vh,526px); overflow-y:auto`（长文/九图朋友圈卡）
  - `summary-workbench.module.css` `.card`：同上（总结工作台、每日总结）
  - `settings.module.css` / `settings-remote-access.module.css` `.card`：同上（设置分组卡）
- **隐藏页签**（设置弹窗里嵌入的分节）不参与卡片尺寸审计导航；它们走同一全局约束与各自模块上界。
- 年度日历热力图仍按**容器查询** ≤620px 隐藏月份/星期刻度（原有设计，与本次宽度回退无关；
  窄卡场景下生效，`scripts/responsive-accepted.json` 保留接受项）。

## 4. 审计工具

`working/team/card-size-audit.mjs`（真实 Electron + 真实数据，影子 profile）：

```bash
node working/team/card-size-audit.mjs --label=after --viewports=390x844,1280x800,2560x1440
# 可选 --only=overview,chats   --include-hidden
```

- 遍历可见页签 × 视口，测量每张顶层 kit 卡的宽/高、卡身 `scrollHeight`、computed `min/max-height`、
  面板根类型（panelShell / panelEmbed / panel / root）。
- 判定：内容卡 >560+8、视觉卡 >820+8、卡片级裁切（`scrollHeight>h && overflow:hidden`）、
  卡身不可达溢出（`bodyScrollH>bodyH && overflow:visible`）、跨分辨率高度差 >180px。
  宽度只做记录，不设上限（2026-10-18 二次反馈后恢复全宽布局）。
- 产物：`working/team/cards/<label>.json`（原始 cells + findings）。

**基线 → 修复后**（390 / 1280 / 2560，15 个可见页签，200 个卡片实例）：

| 阶段 | 可疑卡片 | 卡片最大高度 | 典型问题 |
|---|---|---|---|
| 修复前（baseline2） | 87 条 | maxH **5290px** | officialassets 公众号明细 5290px、mediaassets 重复资产 3997px、monitor/groupinsights 列表 1200/1050px |
| 高度收口 + 自定义卡上界（final4） | 11 条 | maxH **860px**（视觉卡）；内容卡 **598px** | 11 条全部是**跨分辨率高度差**（内容/图表随宽度变化）或视觉卡在 620–860 预算内；**0 卡片级裁切、0 卡身不可达溢出**；宽度沿用各面板原布局 |
| 其中 >620px 的卡 | 7 张 | — | **全部为视觉卡**（二维码 860/694/692、含 canvas 的 655/697/725），内容卡无一超过 598px |

## 5. 验证

- 响应式审计（6 档 × 38 tab）与 `ui-responsive-gate`：无阻塞新增。
- 密度审计（overview）与 `ui-density-gate`：无恶化（卡片限高后空置率继续下降）。
- `typecheck:client`、kit/主题/密度相关 spec、M21/函数行数棘轮、`check:shim`、`build:ui` 全绿。
- 二次反馈后恢复全宽布局：2560 档内容区不再居中，卡片宽度跟随原面板布局；高度约束不变。
