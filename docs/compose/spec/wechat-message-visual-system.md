---
feature: wechat-message-visual-system
status: delivered
updated: 2026-09-13
branch: main
---

# 消息视觉体系全面对齐微信官方客户端

## Report

**What was built** — 把【聊天】面板消息流的全部 28 种 `renderType` 从「科幻青色卡片」
重做为「微信官方几何 + 微信官方色值」：气泡圆角 9px→4px、正文 14.5px→14px、内边距
10/14→6/12、头像 40→34px（圆角 6px）、尖角由 border 三角改为微信的 12×12 旋转方块（top 12px,
外挂 -4px, 圆角 2px）；卡片类统一到微信官方的定宽 + 底部类型条结构（文件/链接/小程序/聊天记录/
音乐 210px，群公告/接龙/直播 232px，位置 208px，视频号 135px，小程序 210×270）；转账改扁平
`#F79C46`、红包改扁平 `#FA9D3B`（去掉自造渐变），转账退回态用官方淡米色 `#FDE1C3`；原先走
`--nm-*` 青色 token 的卡片（群公告/笔记/卡片/商品/视频号/音乐/位置/名片/聊天记录/接龙/通话）
全部改走 `--wx-card-*` 微信卡片令牌。同时补齐三处缺失的微信交互：右键上下文菜单、悬停显示
完整时间戳、日期分隔改为「相邻消息间隔 ≥5 分钟才出现」（标签也换成微信的「今天 / 昨天 /
星期X / M月D日」口径）。消息流背景改为微信聊天页底色（浅 `#EDEDED` / 深 `#191919`）。

**Verification** — 构建期四道 + **运行时视觉验证一道**，全部可复现：

1. `npm run build:ui` PASS（804 modules，exit 0）。
2. **类型检查**：仓库没有 wired-up 的 `tsconfig.json`（`check:*` 脚本在清理时已被移除），故用
   `npx -y -p typescript@5.9.2 tsc` 配一份只 include 客户端源码的临时配置跑了一遍，并做了
   **改动前后基线对比**：改动前 67 条错误 / 去重后 46 条，改动后同样 67 条 / 46 条 ——
   **新引入 0 条、修掉 0 条**。这 46 条全是既有问题：`node_modules` 里的
   `@deepseek-ai/dsh-wechat-data` 是旧副本，缺 `MessageRenderKind` / `renderType` / `sysKind` /
   `atUsers` / `cursorLocalId` 等成员，而真源 `src/backend/wechat-data/src/types.ts` 里有。
3. **`npm run check:wx-tokens`**（本轮新增的脚本）：对构建产物断言 47 项新令牌 / 几何 / 色值确实
   穿过了 Vite 的 CSS Modules 管线（选择器被哈希、声明被压缩），且 9 项旧实现（自造渐变、
   `--wx-radius-tip`、border 三角尖角、14.5px 正文…）已从产物中清除。PASS。
4. **类名引用完整性**：把 `Chats.tsx` 里 293 个 `css.*` 引用逐个对回 `chats.module.css` 的 299 个类
   定义，全部命中 —— 没有会渲染成 `class="undefined"` 的引用（这是 CSS Modules 最常见的静默失败）。
5. **运行时视觉验证（真实数据）** —— 用真实 Electron 应用 + 本机已解密的微信库
   （`%APPDATA%/super-time-electron/wechat-data/decrypted`，265 会话 / 207,020 条消息）：
   - **计算样式逐项核对（浅色端，真实消息）：33 / 33 PASS**，覆盖 27 个类：气泡圆角 4px、
     内边距 `6px 12px`、字号 14px、行高 22.4px（1.6）、无描边、我方 `#95EC69`/黑字、
     对方 `#FFFFFF`/`#1F2937`、流底色 `#EDEDED`、行间距 16px、头像 34px/圆角 6px、
     尖角 12×12 `rotate(45deg)` `top:12px` 外挂 `-4px` 圆角 2px、系统提示 12px `#9E9E9E` 无底无角、
     日期分隔同款、时间戳 10px `rgba(0,0,0,.7)` 默认隐藏、卡片定宽（文件/链接/小程序/名片/
     聊天记录/转账/红包 210px、位置 208px、群公告·接龙 232px、视频号 135px、小程序高 270px）、
     转账 `#F79C46`、红包 `#FA9D3B`、底栏 27px、引用块 `#E1E1E1`/`#525252`、图片最小热区 96px /
     上限 240px / 圆角 4px、图片组 gap 2px 圆角 4px 等。
   - **深色端：6 / 6 PASS** —— 流底色 `#191919`、我方 `#3EB575`/白字、对方 `#2E2E2E`/`#F5F5F5`、
     日期分隔 `#9F9F9F`。
   - **交互**：悬停时间戳 `opacity 0 → 1`，文案 `2026-03-22 18:18:28`（精确到秒），
     10px / 400 / `rgba(0,0,0,.7)` / 圆角 4px / 内边距 4px 8px，浮在气泡上方 —— 与微信一致。
     右键菜单白底、圆角 6px、字号 14px、`1px #E7E7E7` 描边、有阴影，条目按 `renderType` 变化
     （链接消息 = 复制文本 / 复制消息 JSON / 打开链接；纯文本消息 = 复制文本 / 复制消息 JSON /
     编辑消息副本），每项高 36px、内边距 `8px 16px`；Esc 关闭。
   - **日期分隔实际渲染**为「昨天 17:09」「星期一 18:45」—— 新的微信口径在真实数据上生效。
   - 本机数据里**不存在**的 6 类（音乐、公众号封面卡、自定义表情大图、视频封面/播放钮/时长角标）
     用与组件同构的 DOM 注入到真实消息流里验证 CSS：**15 / 15 PASS**（音乐卡 210px/封面 42px/底栏
     27px、封面卡 137px/图高 180px/无尖角、表情上限 130px、播放钮 48×48 圆形 `rgba(0,0,0,.45)`、
     时长角标 12px/圆角 4px、图片消息不套气泡）。
   - 证据截图存 `output/playwright/`（26 张，`output/` 已被 .gitignore 忽略）。

**已知非缺陷**：`getComputedStyle(bubble).maxWidth` 返回字面量 `min(384px, 72%)`（CSS 无法静态求值
`min()`），实际渲染中长文本气泡宽度 276px ≤ 384px，符合设计。

**仍未做的**：没有对像素级外观做逐张人工审美判断（自动化只断言了几何/色值/交互，不是「好不好看」）；
跨分辨率适配只在当前窗口尺寸下验证过，未在多种窗口尺寸下逐一回归。

**Journey log**
1. 参考项目 `D:\WeChatDataAnalysis-main` 的 MessageItem/MessageContent + chat.css 提供了可核对的
   数值（气泡 6/12、13px、圆角 4px、头像 34px、尖角 12×12@12px、卡片 210px、footer 27px…）；
   它本身是第三方工具，凡与微信官方明显不符处（如 sticker 96px）按更接近实机的值取，并在此标注。
2. 原 `.msgVoiceBubble`、`.msgImageGrid`、`.msgSystem`、`.msgQuoteBody` 都有重复定义（同一文件内
   两处），本轮全部合并为一处，删掉后置覆盖块；新增的两处属性拆分重复也一并合并。
3. 消息流背景改为微信底色是本轮视觉变动最大的一处；用 `--wx-chat-bg` 单令牌承载，便于回退。
4. 转账的「已收款」配色**没有做**：后端 `transferStateKey()` 的三个桶把「无状态」与「已收款」
   一起归到 `accepted`，界面无法区分。不造一个数据上不存在的状态。
5. 运行时验证踩的坑：CSS Modules 把类名哈希成 `_msgBubble_y7gyf_475`（尾号 = 源码行号），
   选择器必须用 `[class~="…"]` 且从**构建产物 CSS** 反查类名 —— 从 DOM 反查拿不到「本机数据里
   不存在的类型」的类名。另外 `page.screenshot({clip})` 的坐标语义与 `getBoundingClientRect()`
   不一致，最终改用 Playwright 的**元素级截图**（`locator.screenshot()`）才拍准。

## [S1] Problem

【聊天】面板已按后端 `classifyRender()` 的 `renderType` 正确分派 28 种消息，但**呈现层只有
文本/语音/图片/视频/文件五类做过一次对齐**（见 `chat-message-module.md`），其余类型仍是按
项目自己的科幻青色 token 画的通用卡片：

- **几何不一致**：气泡圆角 9px（微信 4px）、正文 14.5px（微信 13–14px）、内边距 10/14px
  （微信 6/12px）、头像 40px（微信 34px）、尖角是 `top:13px` 的 border 三角（微信是 12×12
  旋转方块、`top:12px`、外挂 -4px、圆角 2px）。
- **卡片结构不一致**：转账/红包用自造渐变 + 220–260px 宽 + 14/16px 内边距；文件卡 260px；
  小程序/视频号/音乐/名片/位置/接龙/群公告各自一套尺寸，均无微信卡片的「定宽 + 底部类型条」。
- **交互缺失**：没有右键/长按菜单；时间戳是每条消息下方常显（微信是悬停才显示完整时间）；
  日期分隔按自然日切分（微信按相邻消息间隔 ≥5 分钟）。
- 项目自身的文档（两次 delivered spec）都记载「保持 sci-fi 青色，不引入参考项目绿色气泡」，
  于是形成了「消息区看着像微信、卡片区看着像另一个产品」的断裂。

## [S2] Design

### 真源与边界（不变）

- 分类真源仍是后端 `classifyRender()` / `renderType`；本轮**不改** `parse.ts`、`messages.ts`、
  不新增 Remote、不改 lib bundle。
- 分派真源仍是 `Chats.tsx` 的 `MessageBody`（按 `renderType`）与 `RichCard`（按 `rich.type`）。
- 面板外壳（侧栏、会话列表、顶栏、搜索、日历、导出、群资料、灯箱）**保持 sci-fi 主题不动**。

### 设计令牌（新增/改写，全部挂在 `.msgBody` 上）

浅色主题是微信官方的精确值；深色主题取微信深色端的对应值。

| 令牌 | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--wx-chat-bg` | `#EDEDED` | `#191919` | 消息流底色 |
| `--wx-radius` | `4px` | `4px` | 气泡/卡片圆角（两侧四角相同，不再收角） |
| `--wx-avatar` / `--wx-avatar-radius` | `34px` / `6px` | 同 | 头像 |
| `--wx-gap` | `10px` | 同 | 头像↔气泡间距 |
| `--wx-row-gap` | `16px` | 同 | 相邻消息间距 |
| `--wx-bubble-self` / `-text` | `#95EC69` / `#000000` | `#3EB575` / `#FFFFFF` | 我方气泡 |
| `--wx-bubble-other` / `-text` | `#FFFFFF` / `#1F2937` | `#2E2E2E` / `#F5F5F5` | 对方气泡 |
| `--wx-bubble-maxw` | `384px` | 同 | 文本气泡最大宽 |
| `--wx-date-text` | `#9E9E9E` | `#9F9F9F` | 日期分隔/系统提示 |
| `--wx-sender-name` | `#6B7280` | `#B9B9B9` | 群内昵称 |
| `--wx-quote-bg` / `-text` | `#E1E1E1` / `#525252` | `#252525` / `#C9C9C9` | 引用块 |
| `--wx-card-bg` / `-hover` | `#FFFFFF` / `#F5F5F5` | `#2E2E2E` / `#383838` | 卡片底 / 悬停 |
| `--wx-card-title` / `-preview` | `#161616` / `#6B7280` | `#F5F5F5` / `#C4C4C4` | 卡片主/次文字 |
| `--wx-card-divider` / `-footer` | `#E8E8E8` / `#B2B2B2` | `#3A3A3A` / `#A8A8A8` | 卡片分隔线 / 底栏文字 |
| `--wx-transfer` / 退回态 | `#F79C46` / `#FDE1C3` | 同 | 转账卡 |
| `--wx-redpacket` / 底栏字 | `#FA9D3B` / `#FAECDA` | 同 | 红包卡 |
| `--wx-mention` / `--wx-link` | `#576B95` / `#245FBD` | `#7D90B8` / `#6F9BEA` | @提及 / 文本内链接 |

### 逐类型呈现契约

| renderType | 微信官方形态 | 本轮落地 |
|---|---|---|
| `text` | 白/绿气泡，圆角 4px，内边距 6/12，字号 13–14px，行高 1.6，最大宽 384px；尖角 12×12 旋转方块 @top12 外挂 -4px | `.msgBubble` 全量改；尖角改方块 |
| `image` | 96×96 最小热区、240×240 上限、圆角 4px | `.msgImage` 改；`.msgBubbleTight`/`.msgBubbleZoom` 内边距归 0、底与尖角一并去掉（微信图片消息不套气泡） |
| `image group` | 3 列等宽方格、gap 2px、圆角 4px | 合并重复定义，圆角 6→4 |
| `voice` | 宽度 `80 + 秒×4`（1–60s）、min 80 / max 200、内边距 8/12、图标 18×18 三层波纹、时长 14px、尖角 10×10 @50% | `voiceWidth()` 公式改；`IconVoiceWaves` 尺寸 22→18；气泡内边距/尖角改 |
| `video` | 封面 220px 宽、min-h 120、max 260；播放钮 48×48 `rgba(0,0,0,.45)`、图标 24；时长角标 12px `rgba(0,0,0,.55)`、右下 8px、圆角 4px | `.msgVideoPlay`/`.msgVideoDur` 改（去掉描边与 mono 字体） |
| `file` | 定宽 210px；主体 padding 10/12 min-h 58；图标 40×40；文件名 14px（2 行截断）；大小 12px；底栏 27px + 1px 分隔线内缩 13px；文案「微信电脑版」 | `.msgFileCard` 260→210；仍是「图标+正文」栅格，底栏靠 `grid-column: 1/-1` 占满一行 |
| `link` | 定宽 210px；正文区 padding 10/10/8 gap 8；标题 14px、摘要 12px、缩略图 42×42 | `.msgLinkCard` 改；封面式（公众号）保留 268px 大图布局 |
| `miniapp` | 定宽 210px、高 270px；顶栏图标 20×20 圆形 + 名称 13px；标题 13px；底栏 23px「小程序」 | `.msgMiniappCard` 改 |
| `channels` / `live` | 视频号：封面 135px 宽（≈135×185）+ 遮罩 + 作者行；直播加左上角状态角标；底栏「视频号 / 视频号直播」 | `.msgMediaCard` 改列向 + 封面满宽；角标改微信红 `rgba(250,81,81,.92)` |
| `music` | 微信把音乐按链接卡渲染：210px + 底栏 | `.msgMusicCard` 改 210px + 底栏 27px |
| `announcement` / `note` / `card` / `product` / `solitaire` | 232px 卡 + 底栏 26px；标题 12px/500、正文 13px/1.5 | `.msgAppmsgCard` 改；接龙名单独立列出（本地唯一形态，见「保留项」） |
| `location` | 208px；文字区在上（标题 13px/500 + 副标题 11px），地图 98px 在下；尖角 12×12 @12px | `.msgLocationCard` 改列向 + `order` 让地图落到文字下方 |
| `contactCard` | 210px；正文 padding 12；头像 40×40 圆角 4px；昵称 14px；别名 11px；底栏 28px | `.msgContactCard` 改 |
| `chatlog` | 210px；标题 14px、预览 12px、底栏 27px + 1.5px 分隔线内缩 13px | `.msgChatlogCard` 改 |
| `transfer` | 210px 扁平 `#F79C46`；主体 padding 10/12 min-h 58；金额 16px/500；状态 12px；底栏 27px + 1px `rgba(255,255,255,.2)` 内缩 13px，文案「微信转账」；尖角 10×10 @top16 | `.msgTransferCard` 去掉渐变改扁平 + 退回态 `#FDE1C3` + 尖角 |
| `redpacket` | 210px 扁平 `#FA9D3B`；祝福语 14px、状态 12px；底栏 27px，文案「微信红包」 | `.msgRedpacketCard` 去掉渐变改扁平 + 补上原先缺失的尖角 |
| `voip` | 使用气泡色（我方绿/对方灰），内边距 8/14、gap 8、min-width 120、图标 22×18、文字 14px、尖角 10×10 @50% | `.msgCall` 由青色系改为气泡色系 |
| `quote` | 回答正文气泡在上，「被引用块」在下：`--wx-quote-bg`、max-h 65px、padding 4/8、12px、圆角 4px、2 行截断、缩略图 98×49 | `.msgQuoteInner` 用 `order` 把正文提上来（DOM 里引用块在前）；引用块改微信灰底，两种气泡上用同一灰 |
| `system` / `revoke` / `pat` / `empty` | 居中 12px 灰字，**无底色无圆角**；日期分隔同款 | `.msgSystem` 去底去角，与 `.msgDayDivider` 共用一套字色字号 |
| `emoji` / `sticker` | 无气泡无尖角，表情大图居中 | `.msgStickerImg` 160→130px（微信实机约 130，参考项目写 96） |
| 文本内片段 | @提及 `#576B95`/500；链接 `#245FBD`；内联表情 1.25em | `.msgMention` / `.msgTextLink` / `.msgEmojiImg` 改 |

### 交互契约（本轮新增）

| 交互 | 微信行为 | 落地 |
|---|---|---|
| 右键/长按菜单 | 消息上右键弹出菜单 | `buildMsgMenu()` 按 `renderType` 生成条目（纯函数，先算条目数才能把菜单夹进视口），`runMenuAction()` 分发：复制文本 / 复制消息 JSON / 打开链接 / 查看大图 / 打开文件 / 查看聊天记录 / 编辑消息副本；`.msgCtxMenu` 定位到光标并夹进视口，点外部、Esc、滚动、改窗口大小即关 |
| 悬停时间戳 | 悬停时在气泡上方浮出完整时间 | `.msgTimeChip`：`bottom: 100%+6px`，10px 白字 `rgba(0,0,0,.7)`，padding 4/8，圆角 4px；文案 `YYYY-MM-DD HH:MM:SS`；已编辑追加「 · 已编辑」 |
| 日期分隔 | 相邻消息间隔 ≥5 分钟才出现 | `buildMessageItems` 改为 `首条 || 跨天 || 间隔≥300s` 才插分隔项；标签按微信格式（今天 `HH:MM` / 昨天 `昨天 HH:MM` / 本周 `星期X HH:MM` / 今年 `M月D日 HH:MM` / 更早 `YYYY年M月D日 HH:MM`） |

### 保留的自定义元素及理由（对应需求第 5 点）

| 元素 | 处置 | 理由 |
|---|---|---|
| 常显「编辑 / 复制 JSON」按钮 | **替换**为右键菜单项 | 微信没有常显于每条消息下方的按钮；常显按钮还在每条消息上引入两个焦点，与微信的「悬停/右键才交互」相悖 |
| 转账/红包的 CSS 渐变 | **替换**为微信扁平色 | 微信官方是纯色填充（`#F79C46` / `#FA9D3B`）；渐变是自造 |
| 转账箭头 / 红包 🧧 的自绘字形 | **保留**（缩到 36×36 / 32×36） | 微信用 PNG 资源（`wechat-trans-icon*.png`）；本项目不便新增二进制资源，自绘字形语义等价且可换色 |
| 撤回/置顶/拍一拍的**分色 + 胶囊底** | **替换**为微信统一灰字；保留行首小字形（↩ / 📌） | 微信里这三者与普通通知同款居中灰字，无底无边；但小字形让「动作 vs 通知」仍可扫读，属于低成本的本地增强 |
| 群接龙的参与者名单卡 | **保留**（外形改 232px 微信卡） | 微信把接龙当纯文本渲染，名单不可见；本项目已解析出名单，丢掉是信息损失 |
| 引用块里的「类型芯片」（图片/语音/视频…） | **保留**，色值改 `--wx-quote-*` | 微信引用块只显示摘要文本；类型芯片补上了 `[图片]`/`[语音]` 这类被折成文案后丢失的语义 |
| 消息流 sci-fi 玻璃外壳 | **保留** | 这是产品外壳身份；需求针对「消息样式」。消息流底色已按微信改，形成「微信聊天窗嵌在宿主面板里」的结构 |
| 位置卡的路网示意（非真实瓦片） | **保留**，改 98px 满宽 | 无离线瓦片可用；画假地图误导性更强，坐标芯片可核对 |
| 消息状态（发送中/已发送/已读） | **不添加** | 本应用只读本地库、无发送链路，数据上不存在这三个状态；微信官方普通消息本身也不显示「已读」。真实存在的异步态（图片/语音/文件加载、转写中、打开失败）本轮统一为微信式「加载中/失败」文字样式 |

## [S3] Out of Scope

- 不改后端 `parse.ts` / `messages.ts` / `lib/index.js` bundle，不 `sync:wechat`。
- 不改面板外壳（侧栏/会话列表/顶栏/搜索/日历/导出/群资料/灯箱）的 sci-fi 主题。
- 不做语音播放音频链路、不做表情 `.dat`/CDN 真图下载与解密。
- 不新增二进制图标资源（转账/红包沿用自绘字形）。
- 不做运行时截图比对（需已解密的微信数据目录）。

## Tasks

- [x] T1: 盘点现有消息类型与分派 — acceptance: 列出 28 个 renderType 与 MessageBody/RichCard 分派，确认缺失的交互 (covers: S1)
- [x] T2: 调研微信官方 UI 规范 — acceptance: 拿到逐类型几何/色值数值 (covers: S2)
- [x] T3: 编写设计规格与设计 token — acceptance: 本文档含令牌表 + 逐类型契约 + 保留项理由 (covers: S2)
- [x] T4: 实现样式与交互改造 — acceptance: chats.module.css 消息段无重复定义、无写死颜色的卡片底色；Chats.tsx 新增右键菜单/悬停时间/间隔分隔 (covers: S2)
- [x] T5: 构建并静态校验 — acceptance: `npm run build:ui` PASS 且 `scripts/check-wx-tokens.js` 断言通过 (covers: S2; depends: T4)
