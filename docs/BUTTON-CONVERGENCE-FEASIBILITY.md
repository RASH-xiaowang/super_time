# 按钮视觉收敛 · 可行性勘测报告

- 日期：2026-09-28
- 触发：R6/R7 之后的最后一条 UI 尾巴（「把 60 个自定义按钮类的样式删掉、交给 `Button` variant」）
- 口径：**实测**（正则 + 花括号配对解析 48 份 `module.css` + 全部 `panels/*.tsx`），未估算
- 结论：**不建议按原方向做**。理由见 §3 —— 这不是"60 个按钮"，是 **6 个语义不同的族**

---

## 1. 实测账目

对 `src/client/ui-wechat/src/client/pages/wechat-data/panels/` 全量扫描
（`<button>` 的 `className` 表达式 → 回溯该类在 `module.css` 里的规则块）：

| 分类 | 数量 | 说明 |
|---|---|---|
| **真按钮**（heavy≥3 且非列表项） | **69** | 有完整视觉（background/border/radius/font-size/padding） |
| 列表项 / 容器 | 4 | `.rankRow` / `.recentRow` / `.sessionItem` / `.navItem` —— **它们长得像按钮但语义是行** |
| 薄类（heavy<3） | 8 | 只改颜色/字重，几何继承 |
| 合计 `<button>`×类 组合 | **81** | 分布在 48 份 `module.css` |

> 注：R6 说「60 个重类」，实测 69；口径差异来自 heavy 阈值的取法。R6 的 60 是「60 个自定义按钮类」，本次把 `<button>` 的 `className` 全量回溯后是 69 处不同的 (css, class) 组合。

---

## 2. 关键发现：69 个"真按钮"的几何离散度极大

把 69 个按**几何签名**归族（padding / font-size / height）：

| 族 | 形态 | 典型类 | 实测几何 | 个数 | 语义 |
|---|---|---|---|---|---|
| **A. pill chip** | 胶囊筛选/标签 | `.catBtn` `.chip` | `padding:4px 12px` `font-size:12px` `radius:r-pill` | ~18 | **筛选器**（可选中态） |
| **B. 紧凑 icon btn** | 小图标条 | `.miniBtn` `.viewerBtn` | `padding:4px 8px` `font-size:11px` | ~12 | 工具条按钮 |
| **C. 文字链** | 无边框无底 | `.linkBtn` `.link` | `padding:0` `font-size:12px` `border:none` | ~6 | **链接式操作** |
| **D. 列表行 / 可点行** | 整行高 | `.rank` `.searchHit` `.msgRow` | `padding:8px 8px` 或 `8px 10px` | ~6 | **行选中**，非按钮 |
| **E. 独立表单按钮** | 主/次操作 | `.optApply` `.optDismiss` `.loadMore` | `padding:6px 14px` `font-size:12px` | ~8 | 真·按钮（最接近 `Button`） |
| **F. 特殊几何** | 圆/竖排/极小 | `.send`(44px 圆) `.indexLetter`(15px) `.detailClose`(16px) | 差异极大 | ~15（实测，见 §8） | **分三支，见 §8** |

**离散度实测**：
- `padding` 从 `0` 到 `12px 14px`（跨 7 档）
- `font-size` 从 `10.5px` 到 `13px`（且有 `var(--nm-dense-fs-sm)`）
- `height` 从 `15px` 到 `44px`（**近 3 倍**）

---

## 3. 为什么「删类交给 Button variant」是错的（结论）

**`Button` 组件只有 6 个 variant**（`primary`/`ghost`/`outline`/`toolbar`/`danger`/`pill`）+ 2 个 size（36px/28px）。

而实测的 69 个真按钮分属 **6 个语义族**，其中：
- **族 D（列表行）** 根本不是按钮 —— 换成 `Button` 是**语义错误**（`<button>` 包整行是当前的有意选择，改成 `Button` 会丢 `width:100%` / `text-align:left`）。
- **族 C（文字链）** 用 `Button variant="ghost"` 会**多出** 28px 高度与内边距 —— 布局会挤。
- **族 F（特殊几何）** 44px 圆形发送键、15px 索引字母格 —— **任何 variant 都表达不了**。
- **只有族 E（8 个）** 才是 `Button` 的真正目标用户。

**代价量化**：按 `Button.pill` 的 `padding: 7px 14px` / 36px 高 与现状 `4px 12px` / ~22px 相比，
若把族 A 全部换掉，**每个 chip 高 +8px**。族 A 有 18 个类、在 `DailySummary`（×20）/ `Graph`（×8）/
`Contacts`（×5）/ `Monitor`（×4）等密集面板里 —— 这些面板的**横向 chip 行会整体变高**，
连带行数/滚动位置变化（R2 刚做完断点收敛，这等于把几何重开一遍）。

---

## 4. 建议：换成「按族收敛」而不是「全局换组件」

| 方案 | 内容 | 收益 | 风险 | 工作量 |
|---|---|---|---|---|
| **P1（已落地，做法修正）** | ~~族 E（8 个）换 `Button`~~ → **族 E 共享几何对齐**（实测后改，见 §6） | 同族一致，零颜色语义损失 | 极低 | 0.5d |
| **P2（已落地）** | 族 A（chip）**只统一令牌**，不换组件：把 18 个类的 `padding`/`font-size`/`radius` 全部吸附到同一组 token | 视觉一致（间距/圆角/字号齐），**零高度变化** | 低（纯 CSS 值替换 + 守卫） | 1d |
| **P3（已落地，实测 6 类 / 8 处）** | 族 C（文字链）收成一个 `LinkButton` 薄封装（不是 `Button`），六份模块 CSS 合并到 `kit.module.css` 的 `.link` | 语义清晰（`<button>` 但长得像链接）+ 唯一定义点 | 低 | 0.5d |
| **P4（已落地，见 §8）** | 族 F 逐个说明「为什么不收敛」（写进 `UI-COMPONENT-GUIDE`） | 消除"看着没做"的误解 | 无 | 0.2d |
| ~~X~~ | ~~全局 69 个换 `Button`~~ | — | **高**（族 D 语义错、族 C/F 布局崩） | 3d+ |

**P1 + P2 + P3 + P4 合计约 2.2d，且全程零布局位移** —— 这才是"收敛"的正确形态：
**统一的是「同族之间的一致性」，不是「跨族之间的一致性」**（跨族本来就不该一致：链接不该长得像主按钮，筛选 chip 不该长得像发送键）。

---

## 5. 数据来源与复现

- 扫描脚本口径：`panels/*.tsx` 里 `<button ... className={...}>` 的 className 表达式 → 取 `css.X` / `cssrows.X` / `csskit.X` → 回溯 `*.module.css` 中 `.X` 的规则块（花括号配对，不用 `[^}]`）
- 排除：注释（`stripComments` 先剥离）、spec 文件、`ui/` 目录
- 实测计数：48 份 css / 81 个 (css,class) 组合 / 69 真按钮 / 4 列表项 / 8 薄类

---

## 6. P1 实测修正：族 E 不换组件，改「共享几何对齐」

> §4 的 P1 原文写「族 E 换 `Button`，几何本就接近、零位移」—— **开工前逐项核对后，这个前提不成立。**

### 6.1 实测：`Button` 根本不是族 E 的归宿

`Button`（`node_modules/@deepseek-ai/dsh-client-ui-primitives/src/Button.module.css`）实测几何：

| variant + size | height | padding | border |
|---|---|---|---|
| `outline` + `sm` | **28px 固定** | `0 10px` | `0.5px` |
| `pill` | `auto`（约 29px） | `7px 14px` | `1px` |

族 E 五个类逐一对接：

| 现类 | 现状 | 最优 variant | Δ高 | Δ左右 | Δ边框 |
|---|---|---|---|---|---|
| `.optApply` | `6px 14px` / 27px / `1px cyan` | `pill` | **+2** | 0 | 0 |
| `.optDismiss` | `6px 14px` / 27px | `pill` | **+2** | 0 | 0 |
| `.optBtn` | `0 12px` / **28px** / pill | `outline sm` | 0 | **-2** | **1→0.5** |
| `chats-cards .loadMore` | `6px 16px` / 27px | `pill` | **+2** | **-2** | 0 |
| `records .loadMore` | `6px 16px` / 27px | `pill` | **+2** | **-2** | 0 |

**没有一行是零位移。** 且 `.optApply` 的**青色语义**（`--nm-cyan-10` 底 / `--nm-cyan-text` 字 / `1px --nm-cyan` 边）
在 `Button` 的 6 个 variant 里**无对应**（`primary` 是 dsw 品牌色、`outline` 是无底透明）。

### 6.2 P1 实际做法

**族 E 共享几何对齐** —— 统一 `padding: 6px 14px` / `border-width: 1px` /
`border-radius: var(--nm-r-pill)` / `font-size: 12px`，**颜色语义各自保留**。

落地 4 处：
- `ask.module.css .optApply`：`border-radius: var(--nm-dense-r)` → `var(--nm-r-pill)`
- `ask.module.css .optDismiss`：同上
- `chats-cards.module.css .loadMore`：`padding: 6px 16px` → `6px 14px`
- `records.module.css .loadMore`：同上

**豁免** `.optBtn`：固定 `28px` + `@media (max-width: 680px)` 抬 `36px` 是
**WCAG 2.2 SC 2.5.8 触屏手指标**；且它在 `.composerFooter`、与前两者不在同一容器，本来不需对高。

### 6.3 验证

- 守卫 `panels/button-family-e-align.wiring.spec.ts`（3 例）：**首跑正确变红**（报出 4 处不一致，与勘测吻合）→ 改代码 → **转绿**。
- 变异 **6/6 RED-OK，全部逐字节还原**（M1/M2 圆角回退 / M3/M4 padding 回退 / M5 豁免项固定高被删 / M6 成员被改名）。
- `build:ui` rc=0（CSS 尺寸 459.93 kB **未变**——`var(--nm-dense-r)`→`var(--nm-r-pill)` 短 1 字节 ×2 = -2 字节，不足 0.01 kB 显示阈值）。
- postcss 解析三份 css **0 errors**，四个规则块最终声明值逐项确认一致。

---

## 7. P3 实测修正：族 C 规模比 R8 估的准，但收敛形态要写清楚

> §4 的 P3 原文写「族 C（文字链）收成 `LinkButton` 薄封装」—— **方向正确**，
> 但「族 C 有几个」与「收敛到什么程度」都得靠实测定。

### 7.1 族 C 的判据必须五项齐全

R8 的族表把族 C 记作 `padding:0` / `font-size:12px` / `border:none`，~6 个。
按「`padding` 以 0 打头 + `cursor:pointer`」粗筛得 **34 条** —— 把族 A（`.ctxChip`/`.optBtn`）、
族 D（`.contactItem`/`.calDay`）、族 E（`.fbBtn`）、族 F（`.send`）全卷进来了。

正确判据（**五项齐全才算族 C**）：

| 项 | 要求 | 为什么 |
|---|---|---|
| `padding` | 严格 `0` | 随文字流；占位会撑开表格单元格 |
| `border` | `none` | 无边框 |
| `background` | `none` / `transparent` | 无底 |
| `cursor` | `pointer` | 可点 |
| `color` | `--nm-cyan` | 链接身份色 |

⇒ **6 个类 / 8 处调用点**（`chats-export-dialog` ×2 + `Contacts` / `KnowledgeBase` /
`Storage` / `Tasks` / `Ledger` / `Records` 各 ×1）。

### 7.2 为什么不能复用 `Button`

同 §6.1 的结论：`Button` 的 6 variant **全都带内边距与固定高**（`ghost` 36px / `sm` 28px）。
族 C 多在**表格单元格**与「说明 + 操作」行里 —— 多 28px 会撑开行、顶掉滚动位置。
`LinkButton` 与 `Button` **平行**，只共享 kit 导出面。

### 7.3 P3 实际做法

- **唯一定义点**：`ui/kit.module.css` 的 `.link`（五项「无」+ `--nm-cyan` + `var(--nm-fs-sm)`）。
- **组件**：`ui/kit-fields.tsx` 的 `LinkButton`，内置 `type="button"`（八个调用点原来都没写，
  裸 `<button>` 在 `<form>` 内默认 `type="submit"` —— 顺带堵掉）。
- **删掉六份模块 CSS 的族 C 类**。
- **顺带统一**（用户 2026-09-28 裁决）：hover 三套花活（紫字 / `text-shadow` / 只下划线）
  → **纯下划线**；`font-size` 11/12px 混用 → `var(--nm-fs-sm)`。

### 7.4 验证

- 守卫 `panels/button-family-c-link.wiring.spec.ts`（**17 例**）：**首跑 16 红 / 1 绿**
  （绿的那条是静态哨兵，本来就该绿）→ 改代码 → **17/17 绿**。
- 变异 **9/9 RED-OK，全部逐字节还原**（M1 组件改 `div` / M2 丢 `type` / M3 不挂 `css.link` /
  M4 `padding` 回退 / M5 加回 `border` / M6 字号回退裸值 / M7 hover 加回发光 /
  M8 调用点改回手写 / M9 让已退役的类复活）。
- `build:ui` ✓，CSS **460.06 → 458.92 kB（-1.14 kB）** —— 删 6 份重复样式的净效果。
- typecheck 5/5 ✓ / `check:shim` ✓ / `build:backend` ✓ / `build:types` ✓ / `docs:api:check` ✓。

### 7.5 勘测更正（自己也要被哨兵管）

初版守卫的点名表按类数写成 **9 处**（凭印象），哨兵断言实测 **8** 才拦住：
`2+1+1+1+1+1+1 = 8`。
**这是「点名表必须配下限」的又一次实战价值** —— 光靠人眼数类名会错，让测试自己数。

---

## 8. P4 实测修正：族 F 不是「不可统一」，是**三支不同的约束**

> §2 的族表把族 F 记为「差异极大 / ~19 个 / **不可统一**」。这个措辞有两个问题：
> ① **数错了**（实测真族 F 是 15 个，另 3 条是判据误收）；
> ② 「不可统一」**没点名** —— 读者无从判断哪些是真不能动、哪些只是还没动。

逐条核验后分**三支**，各支结论不同。

### 8.1 先剔除 3 条「看着像族 F、其实不是」

| 被误收的 | 真实性质 | 判据哪一步漏了 |
|---|---|---|
| `kbfiles.switchBox`、`export-history.pick` | `<input type="checkbox">` | 只看几何不看标签名 —— **它们不是 `<button>`** |
| `moments.monthFill` | 柱状图的柱子（`min-height: 2px` + 渐变） | `cursor: pointer` 被当成"按钮标志"，实际是"可点选中" |
| `retrieval.markToggle` | `[data-on="useful"]` / `[data-on="useless"]` | **属族 A chip**（已被 P2 覆盖） |

**教训**：族 F 的判据必须加一条「**排除非 `<button>` 元素**」——
几何特殊是必要不充分条件。

### 8.2 支 F1「内嵌 icon 按钮」（13 处）—— 尺寸由宿主定，**改了会坏布局**

共享 `--nm-r-sm` 圆角 + 正方形形态，边长跨 **7 档**（16/18/20/22/26/30/32）。逐档都有宿主约束：

| 类 | 边长 | 宿主的约束 |
|---|---|---|
| `global-search.clear` | 16 | 搜索框内右侧（框高 28） |
| `ai-model.profileDel` | 18 | `position:absolute` 塞进 `.profileChip` 右上角 |
| `graph.noteEdit` / `.noteDel` | 20 | 笔记行内（行高约 24） |
| `notice.close` | 20 | 顶部通知条（条约 40px 高） |
| `kb-rail.addBtn` / `.rowBtn` | 22 | 知识库侧栏（栏宽仅 44） |
| `ai-model.keyEye` / `session-ask.iconBtn` / `moments.videoActBtn` | 26 | 输入框眼睛 / 输入区图标 / 视频浮层 |
| `list-panel.lightboxClose` | 30 | 全屏灯箱 |
| `chats-contact-info.close` | 32 | 抽屉（480px 宽） |

**`profileDel` 做到 22px 会盖住 chip 文字；`rowBtn` 做到 26px 会撑破 44px 侧栏；
`keyEye` 做到 30px 会顶坏 `padding-right: 34px` 那条款式。**
⇒ **统一尺寸 = 逐个改宿主布局**，属设计变更且收益为负。

**已经统一的部分**：`border-radius` 11/13 是 `--nm-r-sm`
（另 2 处：`.clear` 用 `50%` 因为它**是圆的**；两个 `.close` 用 `--nm-dense-r` 因为它们**带边框**，
圆角档位跟着边框走）。

### 8.3 支 F2「独立圆形按钮」（3 处）—— 刻意不同，**改了会丢语义**

| 类 | 尺寸 | 语义 |
|---|---|---|
| `session-ask.send` | 32 | 输入区发送键（与 26px 的 `.iconBtn` 同排，略大以突出） |
| `ask.send` | 44 | **主发送键**（44px 是触屏拇指热区下限） |
| `moments.backTop` | 46 | 浮动回顶（`position: fixed`，要一眼看到） |

三处 `border-radius` **都是 `50%`**（同语义已统一）。尺寸差异表达**主次层级**：
统一成 44 会让输入区那枚撑破行；统一成 32 会让主发送键失去分量。⇒ **不收敛。**

### 8.4 支 F3「覆盖层关闭键」（2 处）—— 唯一可收的一支，但**没有 token 可用**

`list-panel.lightboxClose` **30px** vs `chats-contact-info.close` **32px** —— 两者之间**没有功能理由**，
纯粹是两处各写了一遍。**但它们已经共用同一个圆角 token（`--nm-dense-r`）**，差别只有 2px 边长。

**结论：不动**，两条理由：
1. **2px 在两种完全不同的容器里（全屏灯箱 vs 480px 抽屉），用户不可能并列看到** —— 零一致性收益。
2. 硬收就得先**新增一组控件尺寸 token**（本仓设计系统只有圆角与间距，**没有控件尺寸层**）。
   那是更大的设计决策，不该由"按钮收敛"顺手引入。**若要收，单独立项。**

### 8.5 一句话总结

> 族 F 不是"乱"，是**三种不同约束**挤在一个族名里：
> **F1 尺寸由宿主定**（改了会坏布局）、**F2 尺寸表达主次**（改了会丢语义）、
> **F3 只差 2px 且没有 token**（改了要有新设计决策）。
> 三支都不该在"按钮收敛"里动 —— 但**圆角已经统一**，那是它们真正共享的东西。

### 8.6 交付物

`docs/UI-COMPONENT-GUIDE.md` §5 的「**P4 结论**」段（本节的完整版，含逐类表格与理由）。
**P4 零代码改动**（纯文档）—— 这正是它的价值：**让「没做」变成「说清了为什么不做」。**
