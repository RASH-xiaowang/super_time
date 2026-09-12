---
feature: chat-message-module
status: delivered
updated: 2026-09-12
branch: feat/chat-message-module
commits: 622cbca..586c1a6
---

# 聊天消息模块完善（参考 WeChatDataAnalysis）

## Report

**What was built** — 对照 `D:\WeChatDataAnalysis-main` 的 MessageContent/chat.css，完善【聊天】消息呈现：文本气泡左右尖角与 max-width；语音改为微信三层波纹 SVG + 时长线性加宽 + 尖角；图片 min 96×96 热区与 hover 反馈；文件卡改为「主体 + 底部『微信电脑版』条」；视频播放钮加大为 48px 半透明圆。后端 `classifyRender` 分类契约未改。

**Verification** — `npm run build:ui` PASS（804 modules，exit 0）；重启 Electron 后 6 进程存活。未跑 CDP 真实 DOM 扫描（相关 scripts 已在清理中删除）。

**Journey log**
1. 参考项目为 Vue + 自有 API，不可直接移植组件；只对齐视觉契约。
2. 本目录原先无 Git，compose 前先 `git init` + 分支 `feat/chat-message-module` 并提交基线。
3. chats.module.css 底部曾有第二份 `.msgVoiceBubble` 覆盖新规则，已删除旧块。
4. 主题保持 sci-fi 青色，不引入参考项目绿色气泡，避免与全局 token 冲突。

## [S1] Problem

【聊天】面板已按 `renderType` 分派各类消息，但部分类型与微信原生视觉仍有差距：
气泡缺尖角、语音用通用播放图标而非微信波纹、文件卡信息层级偏弱、
小图点击热区偏小、红包/转账缺少底部类型条的一致性。需要对照
`D:\WeChatDataAnalysis-main` 的 `MessageContent.vue` / `chat.css` 做一轮
样式与呈现对齐，不改后端分类契约。

## [S2] Design

### 分类契约（不变）

- 后端 `classifyRender()` 仍是唯一真源；界面 `MessageBody` 只按 `renderType` 分派。
- 不改 `RenderKind` 集合、不新增 Remote 方法、不改 `parse.ts` 分类逻辑。

### 呈现契约（本轮增强）

| 类型 | 呈现要求 |
|---|---|
| text | 接收左尖角 / 自己右尖角；自己侧用青色强调气泡（主题内） |
| image | min 96×96 点击热区；hover 降透明；失败/加载有占位 |
| voice | 时长线性加宽；微信式三层波纹 SVG；时长右置 |
| video | 封面 + 大圆形播放钮 + 时长角标；无封面降级可读 |
| file | 类型 emoji + 文件名 + 扩展/大小 + 底部「微信电脑版」条 |
| quote | 左侧色条 + 被引用昵称/摘要 + 本条正文 + 可选缩略图 |
| transfer | 金额 + 状态 + 底部「微信转账」；退款灰化 |
| redpacket | 祝福语 + 金额 + 底部「微信红包」 |
| system/revoke | 居中胶囊；撤回/置顶/空记录分色 |
| link/default | 有 URL 才可点；无 URL 不画假链接 |

### 主题约束

- 保持 sci-fi 青色体系（`--nm-cyan` 等），不引入参考项目的绿色 `#95EC69`。
- 尖角用伪元素三角形，颜色与气泡背景一致。

## [S3] Out of Scope

- 不改后端 `parse.ts` / `messages.ts` / `lib/index.js` bundle。
- 不移植参考项目的 Vue 组件、Python 解密链路、实时同步。
- 不做语音播放音频链路（本项目以转写为主）。
- 不新增截图/CDP 自动化脚本（`working/` 已清理）。

## Tasks

- [x] T1: CSS 气泡尖角 + 语音波纹图标布局 + 图片 min 尺寸 — acceptance: chats.module.css 含 tail/wave/min 相关规则 (covers: S2)
- [x] T2: Chats.tsx 语音 SVG、文件卡底部条、视频播放钮 — acceptance: MessageVoice 使用微信波纹 SVG；OpenFileCard 有 CardFoot (covers: S2)
- [x] T3: 构建并重启应用 — acceptance: build:ui 成功且 electron 进程 ≥1 (covers: S2; depends: T1,T2)
