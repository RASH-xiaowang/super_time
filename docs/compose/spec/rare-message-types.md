---
feature: rare-message-types
status: designed
updated: 2026-09-12
branch: feat/chat-message-module
commits: faf5353..faf5353
---

# 稀有消息类型深挖（引用 / 图片组 / 表情 / 合并转发）

## Report

## [S1] Problem

上一轮已对齐气泡/语音/文件/视频主路径。稀有类型仍有可读性缺口：
- **引用**：只有昵称+纯文本+可选 CDN 缩略图；`referType` 已在后端解析却未在界面露出类型语义（图片/语音/视频/链接…），媒体引用仍显示成一行 `[图片]` 文案，缺少微信式预览条。
- **图片组**：已有 9 宫格归并，但格子尺寸/间距未按微信 3 列节奏，点击索引是否对准大图未统一。
- **表情**：自定义表情本体不在消息链路，界面长期是「😊 [表情]」占位；有 `rich.thumb` / `md5` 时也未优先展示，可读性差。
- **合并转发**：弹窗内子消息类型映射较粗（语音时长 `/20` 等历史写法）。

## [S2] Design

### 契约（不变）

- 分类真源仍是后端 `classifyRender` / `renderType`；本任务不改 `parse.ts`、不新增 Remote。
- 不引入表情文件解密接口（需动 bundle + 同步，留待后续）。

### 呈现契约

| 类型 | 增强 |
|---|---|
| quote | 按 `rich.referType` 显示类型芯片（图片/语音/视频/链接/名片/转账/文件/位置/文本）；布局为「色条 + 类型行 + 被引用摘要 + 本条回复」；有 `rich.thumb` 时右侧缩略图并可点开灯箱 |
| image group | 网格改为微信式 3 列等宽方格（gap 2px，圆角 4px）；`+N` 角标保留；点击任一格打开灯箱并定位到该张 |
| emoji / sticker | 有 `rich.thumb` 时按大表情渲染（无卡片边框）；无图时用类型化占位「[表情]」+ md5 tooltip |
| chatlog | 子消息行按 kind 用一致图标/前缀；语音时长用毫秒换算秒（若字段已是 ms） |

### 主题约束

- 继续 sci-fi 青色 token；引用色条用 `--nm-cyan`。

## [S3] Out of Scope

- 不改后端 parse/messages/lib bundle、不 `sync:wechat`。
- 不做表情 `.dat`/CDN 真图下载与解密。
- 不做语音引用的可播放预览（无 quoteVoiceUrl 本地解析）。
- 不恢复已删除的 CDP 回归脚本。

## Tasks

- [ ] T1: quote 类型映射 + 预览布局 + 可点缩略图 — acceptance: referType≥3 的引用显示类型芯片；thumb 可点开灯箱 (covers: S2)
- [ ] T2: 图片组 3 列网格 CSS + 灯箱定位 — acceptance: msgImageGrid 为 3 列；onOpenAt 传入对应消息 (covers: S2)
- [ ] T3: sticker/thumb 大表情与 emoji 占位统一 — acceptance: 有 thumb 不套 LabeledCard 重壳；无 thumb 显示 [表情] (covers: S2)
- [ ] T4: 构建并重启 — acceptance: build:ui PASS 且 electron 存活 (covers: S2; depends: T1,T2,T3)
