---
feature: chat-panel-visual-audit
status: delivered
updated: 2026-09-12
branch: feat/chat-message-module
---

# 聊天面板视觉验证与优化分析（对齐微信官方组件）

> **实施状态（2026-09-12 追加）**：批次 1–3 已全部落地，60 项断言全绿（25+22+13）。
> 详见文末「实施记录」——其中包含一次**我造成的编码事故**与修复过程的完整交代。

## 结论摘要

聊天面板的**消息流**上一轮已经对齐官方微信（气泡 4px / 头像 34px·6px / 正文 14px·1.6 / 卡片定宽，
见 `docs/compose/spec/wechat-message-visual-system.md`），但**面板的其余两层——会话列表与群聊信息抽屉
——停留在 sci-fi 青色语言**，于是同一屏里出现三种头像圆角、六种字号、四种图标口径，以及一个
窄窗口下会被裁到点不到的工具栏。共记录 **21 项**问题：P0 三项、P1 九项、P2 六项、P3 三项。

最需要先修的三条（都是"用户能直接看见/直接踩到"的）：

| # | 问题 | 一句话后果 |
|---|---|---|
| P0-1 | 头像圆角三处不一致（50% / 6px / 50%） | 微信全站方角，这里只有消息行是对的，同屏自相矛盾 |
| P0-2 | 窄窗口头部按钮被裁且窗口不可缩放 | 1152px 起丢 1 个、1024 起丢 3 个、960 起连"群信息"都点不到 |
| P0-3 | 成员搜索无结果时无空态 | 网格高度归零，界面只剩一片空白，用户不知道是搜不到还是坏了 |

## 验证方法（可复现）

不是静态读 CSS，是**真机运行时实测**：

- 起真实 Electron 44（`node_modules/electron/dist/electron.exe . --remote-debugging-port=...`），
  接本机已解密的微信库（`%APPDATA%/super-time-electron/wechat-data/decrypted`，143 个群 / 207k 消息）。
- 用 `playwright-core@1.56.1` 的 `connectOverCDP` 驱动，打开「聊天会话 → 南宁房东群95-零中介
  （256 人，含群公告）→ 群信息」。
- 采集物：`output/visual-audit/`（抽屉专项）、`output/visual-audit-panel/`（整面板）——
  逐元素 `getComputedStyle` + `getBoundingClientRect`、CDP `CSS.forcePseudoState` 强制
  `:hover`/`:active`/`:focus-visible`、`Emulation.setDeviceMetricsOverride` 跑 6 档窗口尺寸、
  深/浅两主题各一轮；共 **25 张截图** + `report.json`（`output/` 已被 .gitignore 忽略）。
- 脚本：`output/audit3.mjs`（抽屉）、`output/audit4.mjs`（整面板）。

**基准来源与诚实声明**：

1. 「实测值」列全部来自本机真机计算样式，可信。
2. 「微信官方基准」列来自三处：① 本项目上一轮已验证的官方数值（`--wx-*` 令牌表、
   `scripts/check-wx-tokens.js`）；② 官方客户端公开设计语言里稳定的部分（方角头像、列表行、
   品牌绿 `#07C160`、未读红 `#FA5151`、字号阶梯 17/16/14/12）；③ 本机虽装有微信 4.1.13.63，
   但其 UI 资源编译进 `Weixin.dll` / `RadiumWMPF.bin`，**没有可提取的 CSS**，
   因此**没有做官方端逐值实测**。凡标 ⚠️ 的基准值需在官方客户端上核对后再落地。
3. 只依赖「内部一致性」就能判定为缺陷的问题（字体未继承、空态缺失、按钮被裁、
   无按下态、无障碍语义缺失）不依赖官方基准，可直接修。

---

## P0 — 阻断级

### P0-1 头像圆角在同一屏内三套，与微信方角语言冲突

**现象** 一处方角、两处圆角，且圆角那两处恰好是用户最先看到的两个位置。

**位置** `chats.module.css:108-122`（`.avatar` / `.avatarImg` 全局 `border-radius: 50%`）；
`chats.module.css:441-442`（只有 `.msgRow` 作用域把它改成 6px）；
`Chats.tsx:2939`（抽屉里 `<Avatar size={40} />`）。

**证据** 实测四处的 `border-radius` 与尺寸：

| 位置 | 尺寸 | 圆角 | 微信应为 |
|---|---|---|---|
| 会话列表项头像 | 34×34 | `50%` | ⚠️ 方角（≈4-6px） |
| 消息行头像 | 34×34 | **`6px`** ✅ | 6px |
| 群成员格子头像 | 40×40 | `50%` | ⚠️ 方角 |
| 抽屉「添加」占位 | 40×40 | `50%` + 虚线边 | ⚠️ 方角实线 |

**方案** 把圆角做成随尺寸走的令牌而不是全局 50%：删除 `.avatar`/`.avatarImg` 上的 `50%`，
改为 `border-radius: var(--avatar-radius, 6px)`，只在确实需要圆形的地方（如状态点）覆盖。
这样 `chats.module.css:441-442` 那两行针对 `.msgRow` 的补丁也能一起删掉——补丁本身就是这个
全局 50% 造成的。

### P0-2 窄窗口下头部工具按钮被裁到不可达，且窗口不可缩放

**现象** 消息头部工具条是 `flex-shrink: 0` + `flex-wrap: wrap`，但它的容器没有可收缩宽度，
wrap 永远不触发；超出部分被消息区裁掉，按钮直接消失（不是变窄、不是进溢出菜单）。

**位置** `chats.module.css:288`（`.msgHeaderActions { flex-shrink: 0; flex-wrap: wrap }`）、
`chats.module.css:257-267`（`.msgHeader`）、`main.js:107-129`（窗口 `resizable: false`、
固定 `1664×1066`、无 `minWidth`）。

**证据** 逐档窗口实测（`msgHeaderActions` 内容宽恒为 468px）：

| 窗口 | 头部可用宽 | 头部高 | 被裁掉的按钮 |
|---|---|---|---|
| 1664×1066 | 926 | 94.6 | — |
| 1440×900 | 702 | 94.6 | — |
| 1280×800 | 542 | 94.6 | — |
| 1152×720 | 414 | 164.8（换行） | `清空草稿` |
| 1024×700 | 286 | 164.8 | `导出`、`已编辑`、`清空草稿` |
| 960×640 | 222 | 195.1 | **`群信息`**、`导出`、`已编辑`、`清空草稿` |

同时消息正文列在 960px 下只剩 222px 宽（截图 `p05-960x640.png` 里正文变成每行两三个字）。
`main.js:113` 把窗口设成不可缩放，用户在 1366×768 或 1080p@125% 缩放的机器上无法把窗口调小到
可用尺寸，也无法规避裁切。

**方案** 三步，按顺序做就能彻底解决：
1. 让动作区可收缩：`.msgHeaderActions` 去掉 `flex-shrink: 0`，改 `min-width: 0`，
   并把「导出 / 已编辑 / 清空草稿」这类低频动作收进一个「⋯」溢出菜单（微信的聊天头部也只有
   搜索 + 更多两个入口）。
2. 头部高度收回到单行：目前 94.6px 是"标题行 + 消息类型 chip 行"两层叠出来的（见 P1-9），
   chip 行应移进消息区顶部或折进溢出面板。
3. `main.js` 去掉 `resizable: false`，补 `minWidth: 960, minHeight: 640`
   （数字取实测能容纳三列的下限）。

### P0-3 成员搜索无结果时没有任何空态

**现象** 输入一个必然无匹配的串，成员网格整块消失、没有文案、没有"清空搜索"入口，
界面只剩「查看更多（256 人）」和下面的群聊名称/群公告——看起来像渲染坏了。

**位置** `Chats.tsx:2922-2949`（过滤 + `slice` 后直接 `.map()`，没有长度判断）；
`.memberGrid` 无 `:empty` 兜底。

**证据** 搜 `zzzz-no-such-member-zzzz` 后实测：`memberGrid` 存在但 `height: 0`，
`memberTile` 数量 0，`groupInfoBody.textContent` 只剩
`"查看更多（256 人）群聊名称南宁房东群95-零中介群公告…"`（截图 `10-search-empty.png`）。

**方案** 在过滤结果长度为 0 时渲染空态：图标 + 「未找到相关成员」+ 一行「清空搜索」按钮；
尺寸与 `.msgEmptyIcon` 一致。同时在这个状态下隐藏「查看更多（256 人）」（见 P1-4）。

---

## P1 — 体验显著受损

### P1-1 抽屉与会话列表的 `button`/`input` 没有继承字体，实际渲染成 Arial

**现象** 同一个面板里，`div` 用 Inter，`button` 和 `input` 用 Arial。

**位置** `chats.module.css:1990-2001`（`.memberSearchBox input` 未设 `font-family`）、
`:2055-2065`（`.memberMore`）、`:1972-1983`（`.groupInfoClose`）、`:70-85`（`.sessionItem`）、
`:291-306`（`.calBtn`）。

**证据** 实测 `font-family`：`.sessionItem` / `.memberSearchBox input` / `.memberMore` /
`.groupInfoClose` / `.calBtn` 全部是 **`Arial`**；而 `.msgHeaderName`、`.memberName`、
`.memberTile`（这条 CSS 里写了 `font: inherit`）是 Inter 全栈。
`.sessionItem` 也因此拿到 UA 默认的 `font-size: 13.3333px`。

**为什么值得修** 会话列表的会话名、摘要、时间全在 `button` 里 → **整个左侧列表都不是 Inter**；
含拉丁字母/数字的文本（时间 `12:08`、用户名、`查看更多（256 人）` 的 256）字形明显与邻列不同。

**方案** 在 `chats.module.css` 顶部（或 `scifi-theme.css` 的全局 reset 里）补一条：
`button, input, select, textarea { font: inherit; }`。这一条同时修掉面板里所有同类位置，
不止抽屉。

### P1-2 搜索框填充色与面板底色完全相同

**位置** `chats.module.css:1990-2001`（`background: var(--nm-bg-input)`）。

**证据** 深色主题：`--nm-bg-input` = `#0f172a`，抽屉底色 `--nm-bg-card` = `#0f172a` → 填充零对比；
浅色主题：`--nm-bg-input` = `#ffffff`，抽屉底色 `#ffffff` → 同样零对比。
两轮实测的输入框只剩 `1px rgba(...,0.12)` 描边（浅色截图里就是一个白底白框的线框）。

**方案** 微信搜索框是**填充式的灰底**（浅 `#F0F0F0`/`#EDEDED`，深 `#2E2E2E`），
不是描边式。新增 `--wx-search-bg` / `--wx-search-ph` 两个令牌（深浅各一值），
去掉边框、圆角按官方取 ⚠️（桌面端约 4-6px，当前 8px 偏软），补 `::placeholder`
用 `--nm-text-2`——目前该 input 连 `::placeholder` 都没定义，走的是 UA 默认色，
与面板里其他地方（`wechat-data.module.css:199` 有定义）不一致。

### P1-3 群成员名 10.5px，且一半以上被截断

**位置** `chats.module.css:2033-2040`（`.memberName { font-size: 10.5px }`）、
`:2012-2017`（`.memberGrid { grid-template-columns: repeat(4, 1fr); gap: 8px 6px }`）。

**证据** 在 1664px（最大窗口）下：格子宽 63.25px，成员名 `clientWidth: 63` /
`scrollWidth: 133` → **约 53% 的文字被省略号吃掉**（截图里 "房东直租19…"、"秀厢房东直…"）。
字号 10.5px 也不在微信的字号阶梯上（官方成员名 ⚠️ 12px）。

**方案** 三选一或组合：(a) 字号提到 12px 并给格子加宽（4 列 → 3 列，或抽屉加宽到 320-360px）；
(b) 名字允许两行（`-webkit-line-clamp: 2`），微信移动端就是两行；(c) 至少把 `title` 提示补上——
现在 `memberTile` 的 `title` 是有的（`Chats.tsx:2935`），但 hover 才可见，不算补救。

### P1-4 搜索命中时「查看更多（256 人）」的数字是错的

**位置** `Chats.tsx:2950-2954`（文案用 `groupInfo.members.length`，与过滤结果无关）。

**证据** 搜 `a` 后实测：`memberTile` 24 个（已过滤），按钮文案仍是 `查看更多（256 人）`。

**方案** 有查询词时改为「找到 N 位成员」并在 N ≤ 上限时隐藏该按钮；
展开上限也应基于过滤后的集合而不是原始 `members.length`。

### P1-5 群公告被静默截断在 3 行，没有展开入口

**位置** `chats.module.css:2072-2083`（`-webkit-line-clamp: 3` + `overflow: hidden`）。

**证据** 样本群公告实际 5 行文本（含一个链接），界面只显示前 3 行，
DOM 里也没有任何展开控件（`groupInfoSection` 只有 label + value）。

**方案** 加「展开/收起」或在 label 行右侧给一个「查看全部」；至少不要让它看起来是全文。

### P1-6 抽屉里没有任何"按下"反馈；「添加」是假可用控件

**位置** `chats.module.css` 全文件搜不到 `:active`（会话项只有 `:hover` + `[data-active='true']`，
`.calBtn` 只有 `:hover`/`[data-active]`/`:disabled`）；「添加」实体在 `Chats.tsx:2943-2948`
是一个 `<div className={css.memberTile}>`，`title="暂不支持邀请"`。

**证据** CDP 强制 `:active` 后 `.calBtn` 的计算样式与 baseline **逐项相同**
（background `#0f172a`、无 `transform`、无阴影变化）→ 点击无任何反馈。
「添加」格子则相反：`cursor: pointer`，且 `.memberTile:hover .memberAdd`（`chats.module.css:2054`）
把它 hover 成青色，**看起来可点**，实际是死控件。

**方案** (a) 给会话项/按钮补 `:active`（微信是 `background` 加深一档，不用位移）；
(b) 「添加」要么真做出邀请链路，要么改成明确的 disabled 语言：`aria-disabled="true"`、
去掉 hover 变色、降不透明度到 `.calBtn:disabled` 同款 `opacity: .5`、`cursor: not-allowed`。
参考 `chats.module.css:319` 已经有一套现成的 disabled 语言，直接复用即可。

### P1-7 抽屉缺对话框语义、Esc 不关闭、无焦点管理，关闭按钮命中区 23×23

**位置** `Chats.tsx:2902-2907`（抽屉 DOM）；`Chats.tsx:2008-2016`（Esc 与焦点管理的注册处）。

**证据**
- 语义：实测抽屉 `role: null`、`aria-modal: null`、`aria-label: null`（是个裸 `div`）。
  同一个文件里**灯箱是对的**：`Chats.tsx:310` 有 `role="dialog" aria-modal="true"`、
  `:332` 关闭按钮带 `aria-label="关闭"`。
- **Esc 不生效**：项目自带 `useEscapeToClose`，在 `Chats.tsx:2008-2011` 依次注册给了
  `exportOpen` / `chatlogStack` / `calOpen` / `editedOpen` 四个手写覆盖层 ——
  **`groupInfoOpen` 不在其中**，所以按 Esc 关不掉群聊信息抽屉。
- **无焦点管理**：`useDialogFocus` 在 `:2013-2016` 同样只注册了那四个；
  抽屉打开时焦点不进入、Tab 不循环、关闭后不复位，键盘用户 Tab 会越过抽屉跑到它背后的
  会话列表/消息区里。
- 命中区：关闭按钮实测 `23×23`（15px 图标 + `padding: 4px`）。

**方案** 全部复用现成机制，改动量很小：
1. 在 `Chats.tsx:2008` 那组里补两行 ——
   `useEscapeToClose(groupInfoOpen, () => { setGroupInfoOpen(false); setProfileMember(null) })` 与
   `useDialogFocus(groupInfoOpen, '[data-st-dialog="chats-groupinfo"]')`。
2. 抽屉 `div` 补 `role="dialog"` `aria-modal="true"` `aria-labelledby`（指向 `.groupInfoTitle`）
   与 `data-st-dialog="chats-groupinfo"`。
3. 关闭按钮 `padding` 提到 `8px`（→ 31×31），或给它一个 ≥32×32 的透明命中盒。

### P1-8 一个面板里六种字号，标题与正文同号

**证据** 实测字号：面板标题 `.msgHeaderName` 15px、抽屉标题 13px、抽屉搜索 12px、
会话名 13px、值 12px、标签 11px、成员名 10.5px（另有会话时间 11px）。
抽屉标题（13px/600）与正文同级——**标题没有建立层级**。

**方案** 定一条阶梯并落成令牌：标题 16px/600、区块标题 14px/600、正文/值 14px、
次要 12px、标签 12px。抽屉标题从 13px 提到 16px 是最省事的一步
（微信的聊天信息标题是 16-17px/600 ⚠️）。

### P1-9 聊天头部高 94.6px，其中一半被类型 chip 行占掉

**位置** `chats.module.css:257-267`（`.msgHeader { min-height: 52px; padding: 10px 14px; flex-wrap: wrap }`）、
`Chats.tsx:2799-2807`（类型统计 chip 行）。

**证据** 实测 `msgHeader` 高 94.6px = 标题行 39.3 + 间距 10 + chip 行 24.3 + 上下内边距 20。
微信的聊天头部是单行、约 60px ⚠️。
更糟的是窄窗口下的连带效果：960×640 时头部涨到 195.1px，六个类型 chip 从横排被挤成
**三行竖排的胶囊条**（截图 `p05-960x640.png` 里正好压住消息区左上角），而消息正文列只剩 222px。

**方案** chip 行移出头部（放到消息区顶部做成一行可折叠的筛选条，或收进溢出菜单）；
头部回到单行 52-60px，把这 35px 还给消息区。

### P1-10 会话列表的视觉语言与微信背离：渐变文字、等宽时间、发光未读

**位置** `chats.module.css:163-168`（`.sessionName` 渐变文字）、`:132-138`（`.sessionTime`
用 `--nm-font-mono`）、`:149-160`（`.unread` 45% 发光）、`:86-90` / `:92-107`（hover/选中态
用青色发光 + 左侧渐变竖条）。

**证据** 实测：`.sessionName` 是 `linear-gradient(135deg, text-1, cyan)` + `background-clip: text`；
`.sessionTime` 是 `"JetBrains Mono", "Fira Code", …`；`.unread` 深色 `#FF3B5C` + `0 0 10px 45%` 发光，
浅色主题翻成 `#B91C1C` 深枣红 + 同款发光。

**方案** 按用户选定的「结构对齐微信 · 配色沿用主题令牌」方向：
(a) 去掉会话名的渐变（微信是纯色 + 加粗），改 `color: var(--nm-text-1)`；
(b) 时间改用 UI 字体（保留 `font-variant-numeric: tabular-nums` 就够对齐了）；
(c) 未读徽标改微信口径：⚠️ 高 18px、圆角 9px、字号 12px、**无发光**，
颜色取 `#FA5151`（两主题同值，不要随主题翻成枣红）；
(d) hover/选中态去掉发光与渐变竖条，改成中性填充（微信选中是浅灰底，不描边不发光的），
选中态可以保留 `data-active` 语义，但视觉换成一档填充色。

---

## P2 — 一致性 / 性能 / 细节

### P2-1 图标口径四分五裂：4 种机制、4 种描边宽度

**证据** 同一个面板里并存：

| 机制 | 例子 | 实测 |
|---|---|---|
| SVG 描边 | shim 图标（search/trash/user）/ `IconCalendar` / `IconImage` | `strokeWidth` 1.25、1.3、**1.4** |
| SVG 填充 | `IconPin`（`Chats.tsx:58`）、`IconCloseOutline16` | 实心路径 |
| Emoji | 会话列表最后消息类型（`Chats.tsx:2570-2585`）🔗📞📢↩️ | 跟随系统字体 |
| 文本字形 | 抽屉「添加」（`Chats.tsx:2945` 的 `＋`） | `font-size: 18px` |

`IconMinus`（`Chats.tsx:76-82`）用的是 `strokeWidth="1.6"`，与 shim 的 1.25 并排看粗细明显不同。
描边宽度不一会让工具栏看起来"忽粗忽细"，这属于用户明确问到的"图标是否清晰且风格一致"。

**方案** 统一到 1.25（或统一 1.4）+ `stroke-linecap="round"`；把「添加」的 `＋` 换成 SVG；
emoji 类型图标若要"像微信"应换成 SVG（微信的消息类型图标是矢量资源）。
至少先统一 stroke-width——一处改动、零风险。

### P2-2 `transition: all` 遍布主要容器

**证据** 实测 `transition` 为 `all`（或 `0.15s`）的元素：`.groupInfo`、`.groupInfoHeader`、
`.groupInfoBody`、`.groupInfoSection`、`.memberTile`、`.groupInfoClose`、`.memberMore`、
`.memberSearchBox input`、`.sessionItem`、`.calBtn`、`.msgHeader`。
`transition: all` 会在主题切换时对每个属性（含布局属性）做动画，也是每次都重算的隐患。

**方案** 全部改成显式属性列表，如 `transition: background-color .15s ease, border-color .15s ease, color .15s ease`。

### P2-3 `.groupInfo` 不透明底 + `backdrop-filter` 是多余的合成层

**位置** `chats.module.css:1945-1955`。

**证据** 实测 `background-color: rgb(15, 23, 42)`（完全不透明）**同时** `backdrop-filter: blur(10px)`。
不透明底之上做背景模糊不会产生任何可见效果，但会强制提升一个合成层。

**方案** 二选一：要么删 `backdrop-filter`，要么把底色换成半透明（`--nm-bg-glass`）让模糊真的起作用。

### P2-4 群成员头像没有懒加载

**位置** `Chats.tsx:2922-2942`（`.map` 直接渲染 `Avatar`）。
对照会话列表：`Chats.tsx:2603` 用 `LazyMount rootMargin="400px 0px"` 包了头像。

**证据** 抽屉首次打开就渲染 25 个 `img`，点「查看更多」后 `slice(0, 200)` → 最多 200 个
`img` 同时发起请求（`wx.qlogo.cn` 远程图，样本里是 base64/远程混合）。

**方案** 给成员格子套同一个 `LazyMount`；「查看更多」的 200 上限也建议加虚拟滚动或降档。

### P2-5 `chats.module.css` 全文件 0 条 `@media`

**证据** `@media` 在 `chats.module.css` 出现 0 次（`kit.module.css` 只有 1 处）。
整个聊天面板没有任何断点规则，三列宽度是纯固定值：会话列表 302px（实测各档恒定）、
抽屉 300px（各档恒定）、消息区吃剩余。配合 P0-2 的不可缩放窗口，窄屏完全没有退路。

**方案** 见 P0-2 的三步；另建议给抽屉加断点：`<=1280px` 时抽屉改浮层覆盖在消息区上
（微信桌面端窄窗也是浮层行为），`<=1024px` 时抽屉默认收起。

### P2-6 单聊没有「聊天信息」入口

**位置** `Chats.tsx:2788-2790`（`{curSession.type === 'group' && (...)}`）。

**证据** 源码里 `groupInfoOpen && curSession?.type === 'group'` 双重限制；
单聊会话下头部没有"群信息"按钮，也没有任何等价入口。

**方案** 微信的单聊「聊天信息」是标配。若要覆盖用户提到的「聊天信息」，需要新增单聊信息面板
（头像/昵称/备注/来源/共同群聊），或至少把按钮对所有会话类型渲染并复用抽屉外壳。
本条属于**结构缺口**，不是视觉缺陷——列在这里是因为它直接决定"聊天信息界面"是否存在。

---

## P3 — 打磨

| # | 问题 | 位置 | 方案 |
|---|---|---|---|
| P3-1 | 成员网格 `gap: 8px 6px` 非对称 | `chats.module.css:2012-2017` | 改等值（微信是等距），如 `8px` |
| P3-2 | 抽屉与消息区同色，只靠 1px 12% 描边分隔 | `chats.module.css:1950` | 给抽屉一档独立底色（或加 1-2px 左侧分隔线的对比） |
| P3-3 | 成员格子高度固定 64.3px 而宽度随窗口变（63.25 → 60.75） | `chats.module.css:2018-2031` | 固定格子宽度 + 由容器决定列数，避免宽高比在两档间跳变 |

---

## 微信官方对照表（改前/改后目标）

⚠️ 标记者需在官方客户端核对；其余为实测或项目内已确立的官方值。

| 元素 | 当前实测 | 微信官方基准 | 优先级 |
|---|---|---|---|
| 头像圆角 | `50%`（列表/抽屉）·`6px`（消息行） | 方角 ⚠️≈4-6px，全站一致 | P0-1 |
| 头像尺寸 | 34（列表/消息）·40（成员格） | 34 消息 / ⚠️48 成员格 | P1-3 |
| 成员名字号 | 10.5px | ⚠️12px | P1-3 |
| 面板/抽屉标题 | 13px/600 渐变 | ⚠️16-17px/600 纯色 | P1-8 |
| 标签字号 | 11px | ⚠️12px | P1-8 |
| 值/正文字号 | 12px | ⚠️14px | P1-8 |
| 搜索框形态 | 描边式（填充色 == 底色） | 填充灰底 ⚠️`#F0F0F0`/`#2E2E2E` | P1-2 |
| 未读徽标 | `#FF3B5C`/`#B91C1C` + 45% 发光 | `#FA5151` 无发光 ⚠️18px/12px | P1-10 |
| 会话名 | 渐变文字 | 纯色 + 加粗 | P1-10 |
| 会话时间 | 等宽字体 | UI 字体 | P1-10 |
| hover / 选中 | 青色发光 + 描边 + 渐变竖条 | 中性填充 | P1-10 |
| `:active` | **无定义** | 填充加深一档 | P1-6 |
| 聊天头部高度 | 94.6px（两行） | ⚠️单行 ≈60px | P1-9 |
| 关闭按钮命中区 | 23×23 | ⚠️≥32×32 | P1-7 |
| 行结构 | 标签上 / 值下 + 上边框 + 3 行截断 | 标签左 / 值右 + 1px 分隔 + ⚠️44-56px 行高 | P1-5 · 见下 |
| 品牌绿 | 未使用（面板走青色） | `#07C160`（开关/强调） | 本轮不引入（用户选择沿用主题令牌） |

**关于「行结构」**：抽屉现在把「群聊名称 / 群公告」做成 `label 11px（上）+ value 12px（下）+ 上边框 + 3 行截断`
的块（`chats.module.css:2067-2083`）。微信的聊天信息是**列表行**：标签在左、值在右、
行高 44-56px、行间 1px 分隔、超长可点进详情。这是"结构对齐微信"里改动最大的一处，
也是收益最大的一处——它同时解决 P1-2 的层级问题、P1-5 的公告截断、以及"值区只有 271px 宽"的
连带问题。建议单独一批做。

---

## 建议实施顺序

**批次 1（P0，改 3 个文件，无设计争议）**
1. `chats.module.css`：头像圆角改令牌（P0-1）。
2. `chats.module.css` + `scifi-theme.css`：补 `button, input { font: inherit }`（P1-1）。
3. `Chats.tsx`：过滤结果为空时渲染空态、修正「查看更多」文案（P0-3 / P1-4）。
4. `Chats.tsx` + `chats.module.css` + `main.js`：头部动作区可收缩 + 溢出菜单 + 窗口可缩放
   （P0-2）。

**批次 2（P1 结构，改动集中在抽屉）**
5. 抽屉「群聊名称/群公告」改微信列表行（含公告展开）——一并吃掉 P1-5、P1-8 的一半。
6. 字号阶梯落成令牌并对齐（P1-8）；搜索框改填充式（P1-2）。
7. 抽屉补 `role="dialog"` / `aria-modal` / `aria-labelledby`，并在 `Chats.tsx:2008-2016`
   那两组 hook 里注册 `groupInfoOpen`（Esc 关闭 + 焦点管理），关闭按钮命中区提到 ≥32×32（P1-7）。
8. 「添加」改真 disabled 语言；全面板补 `:active`（P1-6）。

**批次 3（P1 会话列表 + P2）**
9. 去会话名渐变、时间改 UI 字体、未读徽标改微信口径、hover/选中改中性填充（P1-10）。
10. 图标 stroke-width 统一（P2-1）；`transition: all` 收敛（P2-2）；去冗余 `backdrop-filter`（P2-3）；
    成员格子加 `LazyMount`（P2-4）；补断点（P2-5）。

**批次 4（结构决策）**
11. 单聊「聊天信息」入口是否做（P2-6）需要产品决定；P3 三条随批次 2/3 顺手带掉。

**每批次完成后建议复跑本审计脚本**（`output/audit3.mjs` / `audit4.mjs`）做前后对比——
两个脚本都会输出 `report.json`，逐项断言可以直接 diff 出"哪一档窗口、哪个元素、哪个属性"变了。
另外建议把 P0-2 的六档窗口尺寸断言加进 `scripts/`（仓库已有 `check-wx-tokens.js` 这套构建期断言的先例），
让"窄窗口按钮不被裁"变成可回归的约束而不是一次性检查。


## 实施记录（2026-09-12）

### 已落地

**批次 1（P0）** — `chats.module.css` / `Chats.tsx` / `main.js` / `scifi-theme.css`

- P0-1 头像几何令牌提到 `.panel` 作用域（`--wx-avatar` / `--wx-avatar-radius`），
  `.avatar`/`.avatarImg` 改 `border-radius: var(--wx-avatar-radius)`，删掉 `.msgRow .avatar` 那两行补丁。
  四处头像现在同为 34px·6px 方角。顺带修掉一个未列入报告的缺陷：
  `.avatarStub` 因令牌挂在 `.msgBody` 上，在会话列表里取不到值 → 占位渲染成 0×0。
- P0-2 动作区去掉 `flex-shrink: 0`；低频动作（导出/已编辑/清空草稿）收进「更多」溢出菜单
  （`role="menu"`，Esc / 点外部 / 切会话都关闭）；`main.js` 改 `resizable: true` + `minWidth: 960 / minHeight: 640`。
- P0-3 / P1-4 搜索空态（图标 + 「未找到相关成员」+ 清空搜索）；命中集合、展示上限、
  「查看更多」文案改为共用同一份过滤结果，不再写死 256。
- P1-1 `scifi-theme.css` 补 `button/input/select/textarea { font-family: inherit; font-size: inherit }`
  —— **刻意不用 `font: inherit` 简写**，避免 line-height 一并继承把 `.memberMore` 这类靠行高撑高的元素改形。

**批次 2（P1）** — 抽屉为主

- P1-5 / P1-8 群聊名称、群公告改微信式列表行（标签左 / 值右 / 1px 分隔 / 行高 48）；
  公告从静默 `-webkit-line-clamp: 3` 改为 3 行 + 显式「展开 / 收起」（用 ref 量 scrollHeight 判断是否溢出）。
- P1-7 抽屉补 `role="dialog"` / `aria-modal` / `aria-labelledby` / `data-st-dialog`，
  并注册项目已有的 `useEscapeToClose` + `useDialogFocus`；关闭按钮命中区 23×23 → 32×32（头部总高仍 48px）。
  注册顺序把「更多」菜单放在最后，保证 Esc 优先关菜单。
- P1-6 全面板补 `:active`（会话项 / 头部按钮 / 成员格子 / 更多条目）；「添加」改真 disabled 语言
  （`data-disabled` + `aria-disabled` + 去掉 hover 反馈 + opacity .5）。
- P1-2 搜索框改填充式（新增 `--wx-search-bg`，深 `#2e2e2e` / 浅 `#f0f0f0`），去描边、补 `::placeholder`。
- P1-3 成员名 10.5px → 12px + 两行截断（4 列 63px 格宽下可见字数约翻倍）。
- P2-3 抽屉去掉不透明底上的冗余 `backdrop-filter`。

**批次 3（P1 + P2）**

- P1-10 会话名去渐变、时间改 UI 字体、未读徽标改微信口径（`#FA5151` 纯色 / 无发光 / 18px / 圆角 9px / 12px）、
  hover 与选中改中性填充，删掉左侧渐变发光竖条。
- P1-9 类型 chip 行移出 `.msgHeader` 成独立条；`.messages` 设 `container-type: inline-size`，
  `@container (max-width: 560px)` 时按钮收起文字变图标、`(max-width: 420px)` 时整条 chip 隐藏。
  **头部高度从 95 / 152 / 228 / 258px 收敛为全档位 60px。**
- P2-1 面板自有图标描边统一到 1.25；P2-2 23 处 `transition: all` 收敛为 `var(--nm-t-ui)`
  （只动颜色 / 阴影 / 透明度 / 位移）；P2-4 成员格子套 `LazyMount`；P3-1 网格 gap 改等距。

### 追加修复：气泡宽度（用户反馈）

- 现象：长文本气泡排成一根很高的窄柱。实测原因是**复合封顶**：
  --wx-bubble-maxw: 384px 先把 .msgCol 封在 384px，.msgBubble 上又写了一层
  min(var(--wx-bubble-maxw), 72%)，而那 72% 是相对**已封顶的 .msgCol** 解析的 →
  实际只有 384×72% ≈ **276.5px**，比设计值还窄一圈。
  （上一轮 spec 把这 276px 记为「≤384，符合设计」，实际是 bug。）
- 处置：按用户要求「宽度放到和时间齐平」——--wx-bubble-maxw 改为 @%，
  .msgCol 与 .msgBubble 共用该令牌、去掉那层 72%，封顶只由 .msgCol 单点控制。
  这是**刻意偏离微信官方 384px** 的一处，scripts/check-wx-tokens.js 的期望值已同步更新并注明原因。
- 实测（1664px 窗口，会话 ST_王国宁）：行宽 1204px，气泡 460→1620 = **1160px**，
  右边缘与时间分隔行右边缘完全重合（同在 x=1620）；用户截图那条 110 字消息
  由 6 行 / 276px 变为 **2 行 / 1160px**。短消息仍按内容收缩（sk-90841 之类仍是窄气泡）。
- 回归：三套断言 25/25、22/22、13/13 全绿；check:wx-tokens（47 项）通过。

### 追加修复：语音图标方向（用户反馈）

- 现象：**对方**语音的波纹方向反了（截图里是「锥体朝右 + 波纹朝左」）。
- 根因：微信只镜像**我方**图标。参考实现
  `D:\WeChatDataAnalysis-main\frontend\assets\css\chat.css:432` 写的是
  `.voice-icon-sent { transform: scaleX(-1) }`，**对方用基础方向**；基础图形是
  「锥体朝左 + 波纹朝右」（`◀)))`）。本项目写成 `<IconVoiceWaves mirror={!isSelf} />`，
  把两侧都镜像反了。
- 同时修掉一处连带错误：参考实现的 DOM 顺序是 `[图标][时长]`，我方用 `flex-row-reverse`
  把**图标推到靠头像那一端**（`[5″][图标]`）；本项目 `.msgRowSelf .msgVoiceBubble` 用
  `flex-direction: row` 把图标留在远离头像的左端 —— 一旦图标镜像，波纹就会朝气泡外。
  去掉那行 `flex-direction` 后，由基类 `row-reverse` + 时长 `order:1` 得到正确顺序。
- 实测（会话 a妈）：对方 `icon.left=509 < dur.left=535`、`transform: none`；
  我方 `dur.left=1525 < icon.left=1546`、`transform: matrix(-1,0,0,1,0,0)`（即 scaleX(-1)）。
- 回归：四套断言 25/25、22/22、13/13、**4/4** 全绿。

### 追加修复：语音气泡内内容的对齐（用户反馈 · 第二轮）

用户给了参考图，逐像素比对后发现**朝向其实已经一致**，真正的差异在**内容在定宽气泡内的对齐**：

| | 气泡宽 | 左内边距 | 右内边距 |
|---|---|---|---|
| 参考图（对方 2″） | 88px（= 80+2×4 ✓ 公式正确） | **20** | 37 |
| 修复前（对方 5″） | 105px | 58 | **13** |

规则是**内容贴尾角那一侧**（对方尾角在左 → 图标贴左；我方尾角在右 → 图标贴右），
空白留在远端。修复前两侧都被推到右边：基类 `.msgVoiceBubble` 是 `flex-direction: row-reverse`，
而 `justify-content` 默认 `flex-start` 在反向轴下等于「靠右」。

修法：去掉 `order` 技巧，顺序完全交给 `flex-direction` 决定 ——
基类改 `row`（对方 `[图标][时长]`、靠左），`.msgRowSelf` 用 `row-reverse`（视觉 `[时长][图标]`、靠右）。
`.msgVoiceDur` 上的 `order: -1` / `order: 1` 两条一并删除。

实测（元素级截图，5″ 气泡 100×39）：对方内容贴左（左内边距约 14、右侧留白约 51），
我方内容贴右；配合上一轮的方向修复，两端与参考图一致。

比对方法留档：把用户参考图与运行时元素截图放大后逐像素聚簇
（锥体约 3px 宽、波纹约 7px 宽，`[窄][宽]` = 锥体在左 + 波纹在右）。
截图与裁图存 `output/voice-ref/`。

### 追加修复：视频消息「连接不到路径」（用户反馈）

- 现象：视频气泡退化成一行文本
  `◉ 视频 0:06 （视频文件不在本地快照（原始文件在微信安装目录））`
  —— 括号还套了两层。
- 根因：`resolveVideoInfo()` 只在 `decoded_images/<用户名>/<md5>.<ext>` 一处找封面，
  既没查全局解码缓存、也没查**封面真正所在的地方**，而且它的签名里根本没有微信数据根目录：

  ```
  <微信数据根>/msg/video/<YYYY-MM>/<md5>_thumb.jpg   ← 封面（明文 JPG）
  <微信数据根>/msg/video/<YYYY-MM>/<md5>.mp4         ← 实体（本机播放/下载过才有）
  ```

  实测本机该目录有 **6771 个 `_thumb.jpg`**、145 个 `.mp4`；而 145 个 mp4 里
  **131 个能在解密库中匹配到视频消息，且 131 个都有同名封面** —— 也就是说绝大多数视频消息
  本来就有封面可画，只是没去那里找。
- 处置：
  1. `resolveVideoInfo` 加 `wechatBaseDir` 参数，解析顺序改为
     「全局解码缓存 → 会话内解码缓存 → `msg/video/*/<md5>_thumb.jpg`」，
     并顺带把 `<md5>.mp4` 的绝对路径作为 `videoPath` 返回；`gateway.getVideoInfo` 传
     `rawWechatBase(this._dirs.decrypted)`。
  2. 客户端：有封面就画封面；封面缺失但有实体时给一行**可点**入口
     （`apiOpenPath` → 系统播放器），不再报「不在本地」。
     这里走系统播放器而不是站内 `<video>`：渲染进程 CSP 是 `media-src 'self' data: blob:`，
     **不含 `file:`**，站内播放 `file://` 会直接被拦。
  3. 兜底文案去掉内层括号（`封面与视频文件都不在本地，在微信里打开一次后会缓存`），
     界面那层括号不再套两层。
- 实测（会话 a妈 / `#msg-145`，即用户截图里那条）：封面 720×1280 正常渲染、时长角标 `0:06`、
  容器 `role=button`、`title` 里是
  `…\msg\video\2026-08\8a717a27c77a753ead9b0c7c19aed660.mp4（点击用系统播放器打开）`。
  批量抽检 5 条视频消息：**封面 5/5**（修复前 0/5）、4 条同时拿到 `.mp4` 路径；
  打开会话后界面里「不在本地」的降级气泡为 **0**。
- 回归：五套断言 25/25、22/22、13/13、4/4、**4/4** 全绿；`tsc` 错误集仍为基线的 48 条。

#### 附带查明的一条工程事实（以后改后端必读）

运行时加载的是 **`src/backend/wechat-data/lib/index.js`**（`src/backend/wechat-host.js:379`
的 `import('./wechat-data/lib/index.js')` 是相对导入），那是一份 **770KB 的 esbuild bundle**。
所以**只改 `src/**` 不生效，必须重建这一份**；重建配方在仓库根 `.tmp-be-build.mjs`
（esbuild、ESM、`experimentalDecorators: false` —— decorator 语义决定 `@Remote()` 能否注册上）。
本次重建脚本落在 `output/build-backend.mjs`，重建前的产物备份在 `output/backup/lib-index.js.bak`。
另外 `node_modules/@deepseek-ai/dsh-wechat-data` 只是**类型副本**（日期 09/09，比 src 旧），
既有的 48 条类型错误全部来自这份旧副本的成员缺失 —— 运行时与此无关，但也别指望改 src 的类型能被客户端看见。

### 追加修复：通话气泡（用户反馈）

用户给了一张参考图（`[摄像机] 已在其它设备接听`，无类型标签）。逐像素比对后确认两处偏差：

**一、多画了「语音通话 / 视频通话」标签。** 微信的通话气泡只有「图标 + 结局」两段，
语音/视频由**图标**表达（话筒 / 摄像机），气泡内不写类型名。

| | 气泡尺寸 |
|---|---|
| 官方参考（用户给的图） | 165×36 |
| 本项目改前 | **215×38**（多出的 ~50px 就是 11px 的「视频通话」标签） |
| 本项目改后 | **163×38** |

（顺带确认过：`kitCss.textCaption` 是可见的 11px 灰字，不是被隐藏，所以那 50px 是实打实占位的。）

**二、`room_type` 的语音/视频映射反了。** 原实现沿用 WeChatDataAnalysis 的 `0=video / 1=audio`
（该结论在本仓库里一直被标注为 *unverified*）。本机 164 条通话消息的时长分布推翻了它：

| room_type | 条数 | 最长通话 | ≥30 分钟 | ≥10 分钟 |
|---|---|---|---|---|
| 0 | 61 | **1 小时 40 分 10 秒** | 1 | 2 |
| 1 | 103 | 12 分 40 秒 | 0 | 1 |

100 分钟的视频通话不现实、语音通话很常见；且 25 个有通话的会话里 **12 个两种值都出现**，
说明它是「每次通话」的属性（不是每会话固定），符合媒体类型标志的语义。
故改为 **0=语音、1=视频**，并把判据与反例写进 `parse.ts` 的 `parseVoipKind` 注释。

改后 `<msg>=已在其它设备接听` 那条（会话 a妈 / localId 1，room_type=0）：
`data-media=audio`、图标为话筒、气泡 163×38、`caption=null`，与官方参考一致。

`query/calls.ts`（通话记录面板）**仍然只暴露原始 `room_type`、不自己下标签** —— 面板的语义是
「按人/按月盘点」，语音还是视频不影响排序汇总，少一个可能错的断言更安全；那里已改为指向
`parseVoipKind` 的证据。两个文件不再互相矛盾。

**仍待用户确认的一点**：`room_type` 的映射是**推断**（时长分布 + 用户核对），不是官方定义。
参考图里的图标是摄像机（视频通话），与「0=语音/1=视频」自洽。请在微信客户端上核对该条消息的图标是否一致。

回归：六套断言 25/25、22/22、13/13、4/4、4/4、**5/5** 全绿；`tsc` 错误集仍为基线的 48 条。

### 追加修复：语音消息就地播放（用户反馈 · 上一轮已实现，此处补记）

**问题**：语音气泡只能看转写文本，点了不响；微信是点一下就地播放、再点暂停。

**位置**：`wechat-data/src/query/voice.ts`、`gateway.ts`、`src/client/.../wechat-data/api.ts`、
`panels/Chats.tsx`（`MessageVoice`）、`panels/chats.module.css`（`wxVoiceWave` 动效）。

**方案**：
1. 后端加 `resolveVoiceDataUrl()` + `@Remote('getVoiceDataUrl')`：silk → wav 用既有的
   `wx_silk.exe` 解码链路，产物落在 `<decoded>/voices/<svr_id>.wav`，**与转写共用同一份缓存**
   （首次解码实测 13ms，之后直接命中文件）。
2. 客户端 `<audio>` 走 **data URL**：`index.html` 的 CSP 里 `media-src` 是 `'self' data: blob:`，
   **不含 `file:`**，所以站内音频只能内联。实测 data URL 中位约 400KB（5″ 的一条约 195KB）。
3. 交互：点气泡 → 播放并给气泡打 `data-playing`，波纹走 `@keyframes wxVoiceWave`；再点一次暂停；
   播放另一条时自动停掉上一条（播放器是模块级单例 `currentVoiceAudio`，与微信「同时只放一条」一致）。

**回归**：`output/verify-voice-play.mjs` **6/6 PASS** —— 真的创建了 `data:audio/wav` 音频、
`paused=false` 且 `currentTime` 前进、气泡进入播放态且动画在跑、再点暂停、切第二条时同时只有一条在放。

**仍未做**：视频**不**就地播放（同一道 CSP 限制、且 mp4 体积远大于语音，data URL 方案不划算）。
视频仍是「点封面交系统播放器打开」，路径解析已由 `verify-video.mjs` 4/4 覆盖。

### 追加修复：引用行（用户参考图 · 官方竖条与类型图标）

**问题**：引用消息的样式与官方不一致。用户给的官方参考图（我方发「钱」、引用一条转账）里，引用行是
`昵称: <类型图标> 摘要 │` —— 一行灰字、**外侧压一道竖条**；我们的实现缺那道竖条，且转账类引用
渲染成「链接图标 + `[转账] 微信转账`」，类型词重复、图标也不对。

**位置**：`panels/Chats.tsx` 的 `case 'quote'` 与 `quoteKindIcon`、`panels/chats.module.css` 的
`.msgQuoteStrip`、`wechat-data/src/query/parse.ts` 的引用分支、`wechat-data/src/types.ts`。

**官方参考图实测**（参考图是 1x 截图的 5 倍放大版，下列数值均已 ÷5 还原为原生像素）：

| 元素 | 官方实测 | 我们改后 | 断言 |
|---|---|---|---|
| 竖条 | 2px 宽、17px 高、色约 `#333334`（≈ 白 13% 叠在 `#1e1e1f` 上） | 2px 宽、随行高 19.2px、用 `--wx-card-divider` `#3a3a3a` | `border-right: 2px solid rgb(58,58,58)` |
| 竖条位置 | 引用行**外侧**（我方在右 / 对方在左），外侧端与气泡**主体**边缘齐平（气泡尾巴再凸 4px） | 同（气泡尾巴同样凸 4px） | `strip.right == bubble.right`（±1px） |
| 摘要 → 竖条留白 | 9.6px | 10px（`padding-inline-end`） | ±1px |
| 昵称 → 图标 | 3.8px | 4px（`.msgQuoteWho` 右外边距） | — |
| 图标 → 摘要 | ~0.4px（图标紧贴文字） | 0（`gap: 0`） | — |
| 字号 / 行盒 | 摘要 4 个汉字共 48.8px → 字号 12.2px；行盒 18.6px | 12px / 19.2px | `12px / 19.2px` |
| 类型图标 | 外径 14px 的描边圆 + 圆内约 7×6 实心圆角块 | 14×14，圆环外径实测 14.0 | 圆 1 + 矩形 1、无 `path` |
| 引用行整宽 | 138px（含竖条） | 134.3px（同一条消息） | 差 3.7px，来自字体度量 |

**方案**（三处）：
1. **竖条**：`.msgQuoteStrip` 加 `padding-inline-end: 10px` + `border-inline-end: 2px solid var(--wx-card-divider)`，
   `.msgRow:not(.msgRowSelf)` 镜像到左侧。用主题已有的分隔线令牌，不新造色值（沿用「配色沿用主题令牌」）。
   同时把 `gap` 从 4px 改成 0、由 `.msgQuoteWho` 的 4px 右外边距提供间距（官方图标是紧贴摘要的），
   引用缩略图自己补 6px `margin-inline-start`。
2. **类型图标**：新增 `IconQuoteCard`（照参考图逐像素描的形状：14px 描边圆 + 圆内 7×6 实心圆角块），
   挂到 appmsg **2000（转账）**。参考图那个图标的语义（「转账专用」还是「卡片消息通用」）本机无从验证，
   所以这轮只做有证据的这一种；若日后证实是通用形，把 `quoteKindIcon` 第一行的条件放宽即可。
3. **不重复类型词**：引用行已经画了类型图标时，摘要不再保留 `[转账]` 前缀（`appType === 2000` 时去掉
   `^\[转账\]\s*`），得到与参考图一致的 `⊙微信转账`。为此后端新增 `rich.referAppType`
   —— refermsg 自己的 `<type>` 只有 49（appmsg 族），分不出转账与链接，子类型藏在内层 appmsg 里。
   该字段是**纯新增**，不动既有字段，也不改任何既有摘要文案。

**回归**：八套断言 **93/93** 全绿（新增 `output/verify-quote.mjs` 14/14）；`tsc` 仍为基线 48 条；
后端 bundle 重建后启动正常。

**证据**：`output/quote-check/A-strip.png`（我方转账引用行）、`output/quote-check/C-ref-case-row.png`
（参考图那条消息在 `a憨` 里的实际渲染：`ST_王国宁: ⊙微信转账 │`）、`output/cmp-icons-final.png`
（左官方 / 右我们，14px 图标并排）。

**仍待用户确认**：
- 竖条的**镜像**语义是我按「参考图只给了我方一条」+ 对称推出来的：对方引用时竖条在左
  （`verify-quote.mjs` B 段断言）。官方若其实固定在外侧同一侧，改一行 CSS 即可。
- 参考图里的引用灰字峰值约 `#7B7B80`，我们的令牌 `--wx-quote-text` 是 `#c9c9c9`（明显更亮）；
  参考图的底色/绿色（`#1e1e1f` / `#35D28D`）也与我们主题令牌（`#191919` / `#3EB575`）不同。
  按既定方向「配色沿用主题令牌」，这轮只取参考图的**几何**，没动颜色；要贴官方的暗灰只需改一个令牌值。

### 追加修复：头部「更多」下拉被消息流整块盖住（用户反馈）

**问题**：点聊天头部「更多」后，下拉菜单只有第一项露出一点点，其余三项被消息区吃掉（用户截图）。

**位置**：`panels/chats.module.css` 的 `.msgHeader`。

**根因**：`.msgHeader` 与 `.msgBody` 都是**同级**元素，且**都是 `z-index: 1`**，而 `.msgBody` 在 DOM 里更靠后 ——
同值靠后者胜，于是整块消息流画在头部之上。下拉自己的 `z-index: 40` 救不回来：它被关在
`.msgHeader` 建立的层叠上下文里，能压多高由 `.msgHeader` 那一行决定，与外层的 `.msgBody` 无关。
实测（1664×1066，菜单 1374,223 190×106）：第一项命中菜单图标，第二项命中 `_msgBody`、第三项命中 `_msgRow`。

**方案**：`.msgHeader` 的 `z-index` 由 `1` 抬到 `20`（一行改动 + 注释说明为何必须是这个数）。
改法先做运行时注入验证：注入前 3 项只有 1 项命中，注入后 3/3 命中。

**兼容性核查**（抬高头部不能把该盖住头部的东西反压下去）：
消息日历弹窗 `z-index: 1000`、群成员资料卡 `50`、右键菜单 / 工具提示 `2147483000` 都仍在头部之上；
群信息抽屉不是浮层而是 300px 的**并列 flex 兄弟**（`.groupInfo { width: 300px; flex-shrink: 0 }`），
不覆盖头部，不受影响。这条已固化成断言 M7。

**回归**：新增 `output/verify-more-menu.mjs` **12/12 PASS** —— 1600×1000 与 960×640 各查一遍：
逐项 `elementFromPoint` 命中测试（核心护栏）、菜单四边都不越出消息区可视框（防 `overflow` 裁切）、
纵向 10%/50%/90% 三个采样点都命中菜单、Esc 关闭、模态仍盖住头部。
加上原有八套，合计 **105/105**。

**为何以前没抓到**：`verify-batch1.mjs` 第 9 组只断言了「菜单能打开 / 有 3 项 / Esc 关 / 点外部关」，
**没有断言「看得见」**。遮挡类问题恰好全落在这条缝里（元素在 DOM 里、能被脚本点到，但被压在别的层下面）。
新套件用 `elementFromPoint` 补上这一维：不看元素是否存在，只看**最上层是不是它**。

### 追加修复：编辑消息副本点了没反应（用户反馈）

**问题**：右键消息 →「编辑消息副本」点下去什么都不发生（用户截图提出「为什么还不能编辑信息」）。

**位置**：`panels/Chats.tsx` 的 `doEdit` / `buildMsgMenu`、`wechat-data/src/query/edit.ts`、`panels/chats.module.css`。

**三个毛病叠在一起**（逐个复现确认）：

1. **客户端用 `window.prompt` 取新内容** —— Electron 渲染进程**不支持 prompt**：调用即抛
   `prompt() is not supported.`（实测 `window.prompt` 存在、一调就抛）。异常在 `case 'edit'` 的
   async 链里被吞掉，界面上除了控制台一行报错**毫无反应**。
2. **后端 `editChatMessage` 把连接关了两次** —— 两个早退分支各自 `db.close()`，`finally` 又关一次；
   `node:sqlite` 对已关闭的连接再 `close()` 会抛 `database is not open`（已单独验证），
   于是它把真实原因（「消息不存在」）顶掉，用户看到的就是这句莫名其妙的错。
3. **分片选错** —— 同一会话的 `Msg_` 表**可能同时存在于多个分片**（实测「a妈」的表：
   message_0.db 只有 1 行、message_1.db 有 153 行）。旧的 `findShard` 取「第一个建了该表的分片」，
   拿到只有 1 行的那片后 `WHERE local_id = ?` 查不到目标行 —— 编辑**必然失败**。

**方案**：

1. **客户端换成应用内对话框**（复用 kit 的 Radix `Dialog`）：多行编辑、进入时预填并全选、
   `Esc`/取消可退、保存失败把原因显示在框内（不再是原生 alert）、保存中禁用按钮、
   未改动时「保存」置灰。
2. **后端按 localId 找分片**：`findShard(dir, table, localId)` 逐片查这行在哪，
   哪片命中用哪片；都没命中才退回「第一个有该表的分片」，交由调用方报「消息不存在」。
3. **后端早退分支不再自己 close**，统一由 `finally` 关。

**顺带修掉一个会丢数据的坑**：编辑记录的原文快照原来用 `cellStr()`，而它**对 BLOB 返回空串**。
本机文本消息里 BLOB 占近半（136,454 条文本中 **64,021 条是 BLOB**，见 `output/probe-storage.mjs` 普查），
这些消息一旦编辑，「恢复原文」会把内容写成**空串**、原始内容永久丢失。
现在 BLOB 走 base64 + 标记（`encodeOriginalCell` / `decodeOriginalCell`），恢复时按 BLOB 写回原始字节。

**范围收窄**：引用消息不再提供「编辑消息副本」。后端是**整列覆盖** `message_content`，
而引用消息（local_type 49，本机 13,213 行**全是 BLOB appmsg XML**）被覆盖成纯文本后，
引用卡片会被拍平成普通文本、被引用的原文从界面上消失。要支持得改成只改写 XML 里的 `<title>`
再按同编码写回，属另一件事（未做）。

**回归**：新增 `output/verify-edit.mjs` **25/25 PASS** —— 两条完整闭环：
A 段在「a妈」走一遍文本消息（菜单 → 对话框 → Esc 不写入 → 改文保存 → 「已编辑」标记 →
「已编辑消息 (1)」→ 恢复原文），B 段自动挑一个「新消息里就有 BLOB 文本」的会话，
用 `#msg-<localId>` 定位后走同一条闭环，并**直接读库比对字节**（编辑后为 TEXT 新文本、
恢复后仍是 BLOB 且逐字相同）。十套断言合计 **130/130**；`tsc` 仍为基线 48 条；
`check:wx-tokens` 47 项、`check:shim` 13 个文件；后端 bundle 重建后 `Remote 方法数: 119`（不变）。

**数据安全**：两条闭环跑完即恢复原状 —— `message_edits` 为空、全库扫「编辑测试/探针」等测试串
残留 **0** 条（`output/probe-residue.mjs`）。

**证据**：`output/edit-check/report.json`（含两次编辑的 prefill / 库内类型与文本）、
`edit-dialog.png`（对话框）、`edited-bubble.png`（已编辑标记）、`after-restore.png`；
诊断脚本 `probe-edit.mjs`（复现 prompt 抛错与菜单项）、`probe-edit-patch.mjs`（排除
「页缓存 Proxy 补丁」这个嫌疑）、`probe-edit-backend.mjs`、`probe-storage.mjs`、
`probe-blob-session.mjs`、`probe-residue.mjs`。

### 追加修复：编辑对话框跑到左下角且发虚（用户反馈）

**问题**：打开「编辑消息副本」后，对话框落在**窗口左下角**、并且看起来**模糊**（用户截图）。

**位置**：`ui/kit.module.css` 的 `.dialog`（共享组件，不是聊天面板私有样式）。

**根因（一个根因解释两个症状）**：Radix 把 `Overlay` 与 `Content` 渲染成**兄弟节点**
（都挂在 `body` 下），所以 kit 原本写在遮罩上的 `display: grid; place-items: center`
**根本居中不了**对话框。缺了定位的 `.dialog` 于是：

1. 掉进 `body` 的常规流（`body` 是 `display: flex`）→ 实测 `position: static`、`rect x=0 y=765`，
   也就是用户看到的**左下角**；
2. `z-index` 未设 → 被 `z-index: 70` 的遮罩**画在上面**，等于隔着 60% 暗色 + `blur(2px)` 看自己
   —— 这就是**「模糊」**的来源（不是字体渲染问题）。

实测数据（修前）：`position=static`、`rect {x:0, y:765.2, w:520}`、中心偏差 `dx=-572 dy=+382.6`。

**方案**：把定位与层级写回 `.dialog` 自己身上 —— `position: fixed; top/left: 50%;
transform: translate(-50%, -50%); z-index: 71`（遮罩是 70）。附带把 `kitPopIn` 关键帧的
首尾都补上 `translate(-50%, -50%)`：动画期间 `transform` 会覆盖基值，否则弹窗在动画那 ~0.2s 里
会先落到「视口中心当左上角」的位置再跳回。

**影响面（同时修好的）**：kit 的 `Dialog` 是共享组件，`Backup / Settings / Files / Favorites / Chats`
都在用 —— 这些面板里用它的弹窗此前同样落在左下角，这次一并修好（对照：kit 的 `Drawer` 一直是对的，
`.drawer` 自带 `position: fixed; z-index: 61`，只有 `Dialog` 漏了这两条）。

**回归**：`output/verify-edit.mjs` 从 25 条扩到 **28/28 PASS**，新增三条正是这次缺的那一维 ——
对话框**居中**（±2px）、**画在遮罩之上**（z-index 更高且中心命中自己而不是遮罩）、
**底色不透明**。同时给套件加了「等消息流真的渲出来再继续」的重试（首屏偶发慢会让整份套件假失败，
本轮实测遇到过一次）。十套断言合计 **133/133**。

**证据**：`output/dialog-check/dialog-position.png`（修后：居中、自身清晰）、`diag.json`
（修后的 computed style 与中心偏差 0/0）、`output/probe-dialog.mjs`（可复跑的定位诊断）。

**说明**：背景那层轻微变暗+模糊是模态遮罩的既定语言（kit 2px、面板自己的日历/已编辑弹窗是 6px），
对话框自身已不再被它盖住；若想改成「只变暗不模糊」，去掉 `.dialogOverlay` 的 `backdrop-filter` 一行即可。

### 追加修复：会话左栏顶部这块的间距（用户反馈「间隙要一致」）

**问题**：搜索行 / 分类 chips / 统计行 三块的间距不一致（用户截图指出）。

**位置**：`panels/chats.module.css` 的 `.search` / `.typeFilter` / `.stats` / `.searchActionBtn`；
`ui/kit.tsx` 的 `SearchInput`。

**实测（改前，1664×1066 窗口，左栏 x 80..382）**：

| 症状 | 实测值 |
|---|---|
| 左右内边距不一致 | 搜索行 12px、chips 行 12px、**统计行 14px** —— 统计文字起点 94 而上面两行都是 92 |
| 行间垂直间距不一致 | 「输入框 → chips」**14px**，「chips → 统计文字」**19px** |
| **分段控件上方那道缝是 0** | 第一轮把 `.typeFilter` 的上下内边距设成 0 之后，上一行底部的**分隔线紧贴分段控件的上边框**（用户第二轮指出「这个按钮上方的间隙没有弄好」） |
| 搜索框与同行按钮不等高 | 输入框 h=32、按钮 h=30，按钮上下各偏 1px |
| **同行按钮被顶出行外** | `.searchBox` 自带 `min-width: 220px`，加上两个按钮（58+46）与 2×6 间距 = 336px > 行内容宽 278px → **「批量」整颗落在 x 382..428，越出左栏 46px**（宽度越窄越明显） |

**方案**：

1. **一套节奏**：侧内边距一律 12px；行间间距按**可见边**取值 ——
   `分隔线 → 分段控件上边框` = **12px**，`分段控件下边框 → 统计文字` = **9px 盒距**。
   后者少 3px 不是误差：分段控件是**有边框的盒子**（边到边看得见），统计行是**没有底色的文字**，
   行盒上下各有约 3px leading，9 + 3 = 12 才与上面那道缝观感一致。
2. `.search` 改 `padding: 12px 12px 10px`（下 10 + 1px 分隔线）；`.typeFilter` 改 `padding: 12px 12px 0`
   —— 上面那 12px 就是第一轮漏掉的那道缝（当时上下都是 0，分隔线直接贴着分段控件）；
   统计行 `.stats` 改 `padding: 9px 12px 11px`。原先「搜索行下 10 + chips 行下 8 + 统计行上 8」
   三段叠加，才叠出 14 与 19 两个不同的值。
3. `.searchActionBtn` 改 `height: 32px; padding: 0 10px`，与搜索框等高同线（不再是 30px 高、上下各偏 1px）。
4. `SearchInput` 增加可选 `className`；会话左栏传 `.search .searchField { flex: 1 1 auto; min-width: 0 }`
   覆盖 kit 的工具栏默认宽度策略。选择器特意写成 `.search .searchField`（0,2,0）**显式**压过
   kit 的 `.searchBox`（0,1,0）—— 单类选择器同权重时只看样式表顺序，那种赢法太脆。
   改后按钮右边界 370 = 行内容右边界，输入框随行宽收缩（该窗口下 162px），不再顶出。
5. 顺带记录一条**不是错位**的事实：chips 相对 Segmented 容器内缩 3px（容器 1px 边框 + 2px 内边距），
   断言 S5 把它钉住，免得以后被当 bug 改掉。

**度量口径的教训**：第一轮我把「行间间距」量成 `输入框底 → chips 盒顶`（14px），自认为一致了；
但用户看到的是 `分隔线 → 分段控件边框` 那道缝 —— 当时是 0。断言因此在第二轮改成按**可见边**算
（S2 量分隔线到分段控件上边框、S2b 量分段控件下边框到统计文字行盒），并把首轮的错误读数留在上表里。

**回归**：`output/verify-sidebar.mjs` **13/13 PASS** —— 三行内边距一致且内容左边界对齐（92/92/92）、
分段控件上方那道缝 = 12px、统计行上方 9px 盒距（+3px leading）、**按钮全部在行内**（回归护栏）、
搜索框与按钮等高同线、chips 的 3px 内缩，以及 **1100×700 与 960×640 两档窄窗**下上述全部仍成立。
十一套断言合计 **146/146**；`tsc` 仍为基线 48 条；`check:wx-tokens` 47 项、`check:shim` 13 个文件。

**证据**：`output/sidebar-check/sidebar-1600.png`、`sidebar-1100.png`、`sidebar-960.png`（这块的实拍）、
`geo.json` / `report.json`（逐元素 rect 与计算内边距）、`output/probe-sidebar.mjs`（可复跑的几何探针）。

### 追加修复：公众号推送改按官方形态渲染（用户参考图）

**问题**：公众号（`gh_*`）会话里每条推送都渲染成 210×92 的**紧凑链接卡**（左文右图 + 底部账号名），
与官方形态不符。用户给出的参考图里，官方是**大图封面卡**：封面铺满卡宽，单篇推送标题在图下，
多篇推送把次条排成「标题 + 右侧小方图」的行。

**位置**：`wechat-data/src/query/parse.ts`（`applyMpNews` / `xmlTagBlocks`）、`wechat-data/src/types.ts`
（`MpArticle` / `mpNews` / `mpArticles`）、`panels/Chats.tsx`（`MpNewsCard` + `case 'link'` 分流）、
`panels/chats.module.css`（`.msgMpCard` 系列）。

**数据结构实测**（`biz_message_0.db` 里 gh_ 会话，2026-09；`output/probe-mp-flags.mjs`）：

```xml
<mmreader><category type="20" count="2"><name>公众号名</name>
  <topnew><cover>头条封面</cover><width>0</width><height>0</height></topnew>
  <item>…头条自身：title / url 与 appmsg 完全重复…</item>
  <item>…次条：title_v2 / url / cover / summary…</item>
</category></mmreader>
```

- 推送是**一条** type-49 appmsg（`<type>5</type>`），多图文不在多条消息里，而在 `<item>` 列表里。
- `<category count="N">` = 篇数；`<topnew><cover>` 才是头条那张**大图**（`thumburl` 是同一个 URL）。
- `items[0]` 与 appmsg 自身的 title/url 相同（#9/#10/#11 三条实测一致），所以**次条从第 2 个 item 起**。
- `<width>`/`<height>` 实测**恒为 0**，别拿它算比例 —— 封面统一按 16:9 裁。

**方案**：

1. **后端**：遇到原始 XML 含 `<mmreader>` 就标记 `rich.mpNews = true`、强制 `linkStyle = 'cover'`
   （既有启发式靠摘要里的 `#话题#`/PC 信息流判断，而推送的 `des` 是空的，必然被判成小卡），
   封面取 `<topnew><cover>`（回退 `thumburl`），次条列表写进 `rich.mpArticles`。
2. **客户端**：新增 `MpNewsCard` —— 卡片宽度按**微信的 384px** 封顶（普通气泡本项目是 100%，
   但 16:9 封面在宽窗口下会被拉成横带）；封面 16:9 铺满、由卡片圆角裁切；
   单篇给标题（≤3 行），多篇把次条排成行（标题 ≤2 行 + 44px 方图 + 1px 分隔线）。
   封面与每一行都可点，且**各点各的**文章链接（`mp.weixin.qq.com/s?…&idx=N`）。
3. 普通链接卡（聊天里分享的网页）**不变**，仍是原来的紧凑卡 —— 分流只认 `rich.mpNews`。

**回归**：新增 `output/verify-mp.mjs` **10/10 PASS** —— 11 条推送全部渲染成大图卡（不再是紧凑卡）、
封面比例 1.778（16:9）且卡宽 384、封面图 **11/11 真的加载出来**（naturalWidth > 0）、
9 张单篇走「图下标题」且无次条行、2 张多篇的次条行为「标题 + 44px 方图 + `role=link`」、
点击时分别打开各自的链接（stub `window.open` 取 URL 比对）、窄窗 960×640 下结构不变，
以及一条**跨层交叉核对**：DOM 里的次条行总数（2）等于库里各推送 `(count-1)` 之和（2）。
十二套断言合计 **156/156**；`tsc` 仍为基线 48 条；`check:wx-tokens` 47 项、`check:shim` 13 个文件；
后端 bundle 重建后 `Remote 方法数: 119`（不变）。

**证据**：`output/mp-check/after-body.png`（改后整屏）、`narrow-960.png`（窄窗）、`report.json`
（每张卡的封面比例/宽度/次条行/图片加载）、`before-body.png`（改前：紧凑链接卡）、
`output/probe-mp.mjs` / `probe-mp2.mjs` / `probe-mp-full.mjs` / `probe-mp-flags.mjs`（结构与字段普查）。

**仍未做 / 待确认**：

- 参考图底部那排「壮苗工程 / 壮美广西 / 壮建组织」是公众号的**自定义菜单**，本地解密库里没有这份数据
  （只有消息、联系人、朋友圈等），要还原得另找数据来源。
- 参考图的头部只有账号名；我们的头部还有一排类型统计 chips（语音/通话/图片/文本…）。
  这一排对公众号会话价值不大，但要不要给 `gh_*` 会话隐藏属于产品决定，本轮没动。
- 「无封面的纯文字推送」（参考图第 1 条那种）代码已覆盖（没有封面就只画标题卡），
  但本机这 11 条推送都带封面，样本没测到。

### 追加修复：群里的表情包不显示（用户反馈）

**问题**：群里收到的表情（骰子、狗头等）全部渲染成「😊 [表情]」占位芯片，而官方客户端显示的是图。

**位置**：`wechat-data/src/query/parse.ts`（`case 47` / `case 8` / `xmlAttr`）、
`wechat-data/src/query/media-image.ts`（`fetchEmoticonRemote`）、`wechat-data/src/gateway.ts`
（`getEmoticonDataUrl` 改异步 + 兜底）、`panels/Chats.tsx`（`MessageEmoticon` 把 CDN 地址传下去）。

**根因是三层叠在一起**（全部有实测）：

1. **找错目录**：`decodeEmoticonDataUrl` 只在 `decoded_images/<md5>.*` 与 `<微信根>/msg/attach/**`
   找表情文件。而微信 4.x 的表情图**不在** `msg/attach` —— 实测它们在
   `business/emoticon/Persist|Thumb/<前两位>/<md5>` 与 `cache/<月>/Emoticon/<前两位>/<md5>`
   （`output/probe-sticker.mjs`：5 个 md5 全部命中这些目录，`msg/attach` 一个都没有）。
2. **那些文件是加密的**：整文件 16 字节对齐；单字节 XOR（256 种，含"跳头再 XOR"的偏移感知扫描）、
   配置里的 `image_aes_key`（ascii / hex）、消息自带的 `aeskey`（hex / ascii，ECB / CBC，
   IV 取 0 或首 16 字节）全都解不开（`output/probe-sticker-crypt*.mjs` 四份探针）。
3. **兜底本来就有，但被正则挡住**：消息 XML 里的 `cdnurl` 是**未加密**的那一份（实测 200 + 明文
   GIF/PNG/JPEG，体积与消息里的 `len` 逐字节一致），可 `xmlAttr` 的正则要求等号紧跟属性名，
   而部分消息把它写成 `cdnurl = "…"`（等号两边带空格）→ 这些消息取不到 URL（本群 15 条里 8 条）。

**方案**：

1. 解析出 CDN 地址：`cdnurl`（回退 `thumburl`）写进 `rich.emojiUrl`，并**还原 XML 实体**
   （`&amp;` 不还原就是非法查询串，实测直接 400）。type-47 与 appmsg `<type>8` 两条路径都覆盖。
2. `getEmoticonDataUrl` 改为异步：先走原有本地解码；失败且消息带了 URL 时，
   `fetchEmoticonRemote` 下载一次（10s 超时、校验确实是图片）→ **落进
   `decoded_images/<md5>.<ext>`** → 返回 data URL。于是网络只花一次，**之后（含离线）走本地路径**。
   两边都失败时把两条原因都返回，便于区分「没走远端」和「远端失败」。
3. `xmlAttr` 的正则改成容忍 `\s*=\s*` —— 这条顺带修好了所有「等号带空格」写法消息的属性读取。

**覆盖率**（`output/probe-sticker-coverage.mjs`，全库 1880 条 type-47）：
`md5` 100%、**`cdnurl` 99.3%**（1867）、`encrypturl` 98.8%、`aeskey` 99.2%、`thumburl` 24%。

**回归**：新增 `output/verify-sticker.mjs` **7/7 PASS** —— 该群 15 条表情里 **14 条渲染成真图**
（骰子 100×100 GIF、狗头 210×300 JPEG、动图 358×374 等）、1 条占位；断言含「真图比例 ≥80%」、
「图确实解码出来（naturalWidth>0）」、「decoded 缓存里出现这些 md5（离线重开也显示）」、
「库里带 cdnurl 的比例 ≥80%」与窄窗。十三套断言合计 **163/163**；`tsc` 仍为基线 48 条；
`check:wx-tokens` 47 项、`check:shim` 13 个文件；后端 bundle 重建后 `Remote 方法数: 119`（异步方法不影响注册数）。

**两处测量陷阱（都已固化进断言）**：

- 表情图的 `<img>` 带 `loading="lazy"` —— **视口外的图不会解码**，直接读 `naturalWidth` 会得到 0。
  断言里先逐条滚过一遍再判定，否则把「没滚到」误判成「渲染失败」。
- 同一行里第一个 `<img>` 是**头像**，取表情图必须限定在 `.msgSticker` 里。

**仍未做 / 待确认**：

- 那条没有 `cdnurl`/`thumburl` 的消息（md5 `da1c…`，15 条里 1 条）目前无法取图，界面保持占位芯片
  （不比原来更差）。要覆盖最后这点，得拿到微信 4.x 表情缓存的解密方式 —— 本轮 4 组方案（含单字节
  XOR 偏移扫描、image_aes_key、消息 aeskey 的 hex/ascii × ECB/CBC × 跳头）均未命中，已在报告里留档。
- 首次显示需要联网（每张一次性，之后就本地缓存）；表情尺寸沿用微信的 130px 上限。

### 验证

| 套件 | 结果 | 覆盖 |
|---|---|---|
| `npm run build:ui` | PASS | 804 modules |
| `npm run check:wx-tokens` | PASS | 47 项令牌 / 几何 / 色值，9 项旧实现已清除 |
| `npm run check:shim` | PASS | 13 个文件逐字节一致 |
| `tsc --noEmit`（临时配置） | 48 条，**与会话开始基线逐条相同** | 无新增；语法类 0 条 |
| `output/verify-batch1.mjs` | **25/25 PASS** | 头像 / 字体 / 空态 / 窄窗裁切 / 溢出菜单 |
| `output/verify-batch2.mjs` | **22/22 PASS** | 抽屉语义 / Esc / 焦点 / 命中区 / 列表行 / 字号 / 搜索框 / `:active` |
| `output/verify-batch3.mjs` | **13/13 PASS** | 会话列表视觉 / 动效令牌 / 容器查询 / 懒挂载 / 窗口可缩放 |
| `output/verify-voice.mjs` | **4/4 PASS** | 语音图标方向（对方不镜像 / 我方镜像 + 内容贴尾角侧） |
| `output/verify-video.mjs` | **4/4 PASS** | 视频封面命中率 + `.mp4` 路径解析 |
| `output/verify-call.mjs` | **5/5 PASS** | 通话 `room_type` 映射 / 气泡无类型标签 / 尺寸 163×38 |
| `output/verify-voice-play.mjs` | **6/6 PASS** | 语音就地播放：音频真的在响 / 播放态与动效 / 再点暂停 / 同时只放一条 |
| `output/verify-quote.mjs` | **14/14 PASS** | 引用行：外侧竖条（含对方镜像）/ 令牌色 / 类型图标 / 不再重复 `[转账]` / 与气泡边缘齐平 |
| `output/verify-more-menu.mjs` | **12/12 PASS** | 「更多」下拉：逐项 `elementFromPoint` 命中 / 四边不越界 / 1600×1000 与 960×640 / Esc / 模态仍盖住头部 |
| `output/verify-edit.mjs` | **28/28 PASS** | 编辑消息副本：**对话框居中/在遮罩之上/底色不透明** + 预填/聚焦/无报错 / Esc 不写入 / 保存 + 已编辑标记 / 恢复原文 / **BLOB 消息逐字节还原** |
| `output/verify-sidebar.mjs` | **13/13 PASS** | 左栏顶部节奏：三行内边距一致 / 左边界对齐 / 分段控件上方那道缝 =12px / 统计行 9px 盒距 / 按钮不越界 / 等高同线 / 1100×700 与 960×640 |
| `output/verify-mp.mjs` | **10/10 PASS** | 公众号推送：大图卡 / 封面 16:9 且 ≤384px / 图片真的加载 / 单篇图下标题 / 多篇次条行(44px 方图) / 各点各的链接 / **DOM 次条行数 = 库里 count-1 之和** / 窄窗 |
| `output/verify-sticker.mjs` | **7/7 PASS** | 群表情：大图卡渲染（14/15）/ 图真的解码 / decoded 缓存落盘 / 库里 cdnurl 覆盖 ≥80% / 窄窗（含**懒加载须先滚过**的测量口径） |

合计 **163/163**。

### 事故与修复（必须交代）

统一图标描边与收敛 `transition` 时，我用 PowerShell 的 `Get-Content -Raw` + `Set-Content`
回写了 `Chats.tsx` 与 `chats.module.css`。该环境把无 BOM 文件按 cp936 解码后以 UTF-8 写回，
遇到「中文字符紧跟 ASCII」的字节序列会**丢字节** —— `已收款'` 变成 `已收␦?`，
连字符串的收尾引号一起消失，构建直接报 `Unterminated string literal`。

- **范围**：仅这两个文件。`Chats.tsx` 304 行 / 608 处；`chats.module.css` 118 行 / 268 处。
- **不可自动恢复**：编码往返不可逆；git 里 HEAD 是更旧的版本（2793 / 2229 行）而工作区是 3281 / 2621 行，
  说明这两个文件带着未提交改动，不能拿 HEAD 覆盖。同时没有 sourcemap / 暂存副本 / stash / 编辑器本地历史。
- **修复方式**：逐行还原。字符串字面量从上一轮成功的构建产物 `index-pfcca75C.js` 里取**原文**对齐
  （`已收款` / `已退还` / `📽️` / `直播中` / `‹` / `至` 等都是这样定下来的），注释按上下文重建。
  CSS 端 118 处**全部落在注释里**，没有一条声明或选择器受损，功能面本就完整。
- **修复后可核验的**：0 个替换字符、文件可解析、`tsc` 错误集与基线逐条一致、构建通过、60 项功能断言全绿。
- **修复后无法保证的**：注释措辞是否与原句一字不差；以及是否存在**其它被整行吞掉、但 tsc 与测试都没覆盖到**
  的代码。为此做了一次专项扫描（列出所有「受损点之后仍有非空内容」的行，共 18 处并全部补齐）——
  其中 `if (kind === 'system' || kind === 'revoke') return <MessageSystem m={m} />`、
  轮询的归属校验 `sessionAlive(epoch, talker)`、以及三个 `useEscapeToClose` 注册都是**真影响行为**的，
  是 `tsc` 抓不到（没有未定义标识符）而功能断言抓到的。扫完后为 0 处。
- **复核入口**：`output/corrupt/repair-diff-Chats.txt` 与 `output/corrupt/repair-diff-css.txt`
  是「损坏版 → 修复版」的逐行 diff（485+/304-、149+/118-），即这次修复改过的全部内容；
  `output/corrupt/damage-Chats.txt` / `damage-css.txt` 是原始损坏清单。
- **教训**：源文件一律只用编辑器工具（显式 UTF-8）读写，不要用 shell 的 `Get-Content`/`Set-Content` 回写。

### 仍未做

- **P2-6 单聊「聊天信息」入口**：需要产品决定（当前只在 `type === 'group'` 渲染入口）。
- **P1-3 残余**：最长成员名（22 字）在 300px 抽屉的 4 列布局下仍需 5 行、只显示 2 行。
  彻底解决要动抽屉宽度或列数（会挤占消息区），属布局决策，本轮未做。
- **P3-2 / P3-3**：抽屉与消息区同色只靠 1px 分隔；成员格子宽高比随窗口跳变。
- **回归护栏**：建议把「六档窗口下头部无按钮被裁」写进 `scripts/`，让 P0-2 成为构建期可回归的约束。

## 证据文件

- `output/visual-audit/report.json` — 抽屉专项（计算样式 / 强制伪类 / 6 档响应式 / 深浅主题）
- `output/visual-audit-panel/report.json` — 整面板（会话列表 / 头部 / 三处头像 / 禁用态 / 窄窗溢出）
- `output/visual-audit/03-groupinfo-dark.png`、`11-groupinfo-light.png`、`10-search-empty.png`、
  `04-tile-hover.png`、`05-tile-focus.png`、`07-input-focus.png`、`08-responsive-*.png`
- `output/visual-audit-panel/p01-full-dark.png`、`p06-full-light.png`、`p05-960x640.png`（裁切最严重的一档）
- `output/audit3.mjs`、`output/audit4.mjs` — 可复跑驱动脚本
- `output/verify-batch1..3.mjs`、`verify-voice.mjs`、`verify-video.mjs`、`verify-call.mjs`、
  `verify-voice-play.mjs`、`verify-quote.mjs`、`verify-more-menu.mjs`、`verify-edit.mjs`、
  `verify-sidebar.mjs`、`verify-mp.mjs`、`verify-sticker.mjs` — 十三套可复跑断言（合计 163 条）
- `output/quote-check/` — 引用专项：`report.json`（几何 / 计算样式）、`A-strip.png`（我方转账引用行）、
  `A-self-transfer.png`、`B-other-quote.png`（对方引用镜像）、`C-ref-case-row.png`（参考图那条消息的实拍）
- `output/cmp-icons-final.png`、`output/cmp-ref-strip4.png` — 官方参考图与我们的 14px 类型图标 / 引用行并排
- `output/capture-quote-ref.mjs` — 翻页定位参考图那条引用并截图的取证脚本
- `output/more-menu-check/` — 「更多」下拉专项：`report.json`、`menu-1600.png`、`menu-960.png`（窄窗）、
  `modal-over-header.png`（日历弹窗仍盖住头部）
- `output/probe-more-menu.mjs` — 遮挡诊断（祖先链的 position/z-index/overflow + `elementFromPoint` 逐项命中）
- `output/probe-menu-fix.mjs` — 修复前/后对比：运行时注入 `z-index` 验证根因
- `output/edit-check/` — 编辑消息副本专项：`report.json`（两次闭环的 prefill 与库内类型/文本）、
  `edit-dialog.png`、`edited-bubble.png`、`after-restore.png`
- `output/probe-edit.mjs`（复现 `prompt() is not supported.`）、`probe-edit-patch.mjs`（排除页缓存 Proxy 补丁）、
  `probe-edit-backend.mjs`、`probe-edit-db2.mjs`、`probe-storage.mjs`（各类型 TEXT/BLOB 普查）、
  `probe-blob-session.mjs`、`probe-residue.mjs`（测试残留扫描）
- `output/dialog-check/dialog-position.png`、`diag.json` — 编辑对话框定位（修后居中，中心偏差 0/0）
- `output/probe-dialog.mjs` — 对话框定位诊断（视口/文档尺寸、能创建包含块的属性、overlay 与 dialog 的
  computed style 与 rect、祖先链）
- `output/sidebar-check/sidebar-1600.png`、`sidebar-1100.png`、`sidebar-960.png`、`geo.json`、`report.json`
  — 左栏顶部的实拍与逐元素几何
- `output/probe-sidebar.mjs` — 左栏顶部几何探针（三行的 rect / 计算内边距 / 行间间距）
- `output/mp-check/after-body.png`、`narrow-960.png`、`before-body.png`、`report.json` — 公众号推送卡
  （改后 / 窄窗 / 改前 / 每张卡的封面比例·宽度·次条行·图片加载）
- `output/probe-mp.mjs`、`probe-mp2.mjs`、`probe-mp-full.mjs`、`probe-mp-flags.mjs` — 公众号推送的结构与
  字段普查（哪张库/表、`<mmreader>` 结构、`count` 与 `<item>` 的关系、`width/height` 恒为 0 等实测）
- `output/sticker-check/group-after.png`、`narrow-960.png`、`report.json` — 群表情修复后的实拍与逐条状态
- `output/probe-sticker.mjs`（md5 与本地文件落在哪）、`probe-sticker-find.mjs`（全盘搜文件）、
  `probe-sticker-crypt{,2,3}.mjs`（单字节 XOR 偏移扫描 / image_aes_key / 消息 aeskey 等 4 组解密尝试）、
  `probe-sticker-coverage.mjs`（全库 1880 条的字段覆盖率）、`probe-sticker-cdn{,2}.mjs`（CDN 取图实测，
  含 `&amp;` 未还原导致 400 的对照）
- `output/q-find5.mjs`、`output/q-session.mjs`、`output/q-received.mjs`、`output/q-transfer.mjs` —
  直接读解密库找引用样本的查询脚本（`message_content` 是嵌套 zstd，需先按字节解压再解一层）
