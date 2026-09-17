# Super Time 前端

本目录是从 `D:\deepseek-harness\packages\client\ui-wechat`
（`@deepseek-ai/dsh-client-ui-wechat`）完整迁移并适配到 Super Time Electron
渲染进程的「Super Time」前端。

## 迁移范围

| 类别 | 来源 | 本目录 |
|---|---|---|
| 前端源码（TSX/CSS Modules/地图数据等，88 个文件） | `packages/client/ui-wechat/src/**` | `src/client/ui-wechat/src/**` |
| UI 原语（Button/Input/Pill/StateDot/图标等，仅保留实际用到的子集） | `packages/client/ui-primitives` | `src/client/ui-primitives-shim/` |
| 构建入口（Electron 挂载壳） | 新增 | `src/client/ui-app/ui-entry.tsx` |
| 构建模板 | 新增 | `src/client/ui-app/index.html` |
| Vite 构建配置 | 新增 | `vite.config.js` |
| 构建产物（提交，供 Electron 运行） | 由 `npm run build:ui` 生成 | `src/client/ui-dist/` |

## 功能界面（16 个侧栏入口 / 35 个可路由页签，138 个 Remote 方法）

> 本节数字与结构于 2026-09-15 按 `panels/nav-config.ts` 实测重写：此前写「12 个侧栏入口 / 34 个页签」，
> 方法数也早已过期（图谱拆成两个入口后侧栏变 16 项）—— 三项全错，且没有任何东西会发现。
> 变更历史见 `docs/RELEASE-PLAN.md` 的 M22 与 `CHANGELOG.md`，**本文件只写当前值**。
> Remote 方法数的权威来源是 `gateway.ts` 的 `@Remote`（自动生成的清单见 `docs/API.md`，
> 一致性由 `src/backend/tests/api-docs.spec.ts` 与 `npm run docs:api:check` 守住）。

侧栏按 9 个分组组织（概览与问答 / 报告与总结 / 会话与消息 / 联系人与社交 / 内容资产 / 资金 /
洞察与行动 / 备份与安全 / 维护与设置）。**隐藏项不进侧栏但仍可路由**（深链、跨面板跳转都有效），
由所在分组的可见项用面板内分段/过滤进入（见 `panels/MergedSections.tsx`）：

| 侧栏项（可见） | 同组内隐藏、由它进入的视图 |
|---|---|
| 数据总览 | — |
| 微信问答 | — |
| 总结 | 年度报告 / 周期报告 |
| 聊天会话 | 会话·公众号 / 会话·服务号 / 会话·客服 |
| 群聊分析 | 群聊监控 |
| 通话记录 | 撤回消息 |
| 通讯录 | — |
| 朋友圈 | — |
| 社交图谱 | —（独立入口；好友网络 / 群组网络） |
| 知识图谱 | —（独立入口；知识网络 / 融合视图） |
| 收藏与表情 | 表情包 / 收藏表情统计 |
| 文件与存储 | 媒体资产 / 存储分析 / 公众号文章 |
| 资金往来 | 转账红包 |
| 朋友圈洞察 | — |
| 待办日程 | — |
| 隐私体检 | —（敏感信息扫描结果 · 风险联系人/群 TOP10） |
| 操作日志 | —（审计长表） |
| 设置 | 数据边界与出网 / 备份恢复 / 数据库健康 / 原图链路自检 |

2026-09 的重构：把「配置」「授权」「维护与自检」这三类从侧栏收进「设置」弹窗
（`panels/Settings.tsx`：**13 节**堆叠在右区**连续滚动**，滚到一节末尾自然接下一节；左导航充当
**目录** —— 点击滚到该节、高亮按滚动位置反推）。左导航分五组，口径是**用户意图**：
配置向导（首次配置 5 步）/ 智能与隐私（AI 大模型、数据边界与出网）/ 授权与更新 /
维护与自检（备份恢复、数据库健康、原图链路自检）/ 高级。

**哪些进弹窗、哪些留主界面**，判据是「改行为 vs 看数据」：配置、授权、维护与自检动作进弹窗；
**只读的数据视图留在主界面** —— 隐私体检（扫描结果与风险 TOP10，命中样本要能跳回会话）与
操作日志（审计长表）就因此没有进弹窗：弹窗右区只有 660px 宽、翻长表很别扭，而且从弹窗里
再跳回主界面看会话是反直觉的。

`#privacytrust` / `#health` / `#hook` / `#backup` 深链与各面板里的跳转仍可用：
`WechatDataPanel.tsx` 的 `DIALOG_SECTION_OF` 会把它们改道成「开弹窗并落到对应节」
（挂载即滚到那一节），弹窗内的跳转则由 `Settings.tsx` 的 `innerNavigate` 就地滚过去
（弹窗装不下的「文件资产 / 存储分析」才交回宿主关弹窗再切）。

**状态管理与路由**：沿用上游 `wechat-state.ts`（打开/关闭状态）、
`WechatDataPanel.tsx` 的页签状态 + `location.hash` 深度链接、`api.ts` 的
snapshot 缓存（localStorage + 30s TTL + 实时更新失效）、`panels/hooks.tsx`
的分页 / 懒加载 / 渐进挂载（`usePagedList` / `useProgressiveList`）。
注：`@tanstack/react-virtual` 的 `VirtualList` 已于 M14 移除（固定行高与可变高列表形态不匹配），
长列表当前靠**增量挂载**——DOM 节点数没有硬上界，这是已登记的限制（N18），不要照旧文档去找虚拟列表。

**样式逻辑**：CSS Modules + `scifi-theme.css` NEON MATRIX 主题令牌，
全部 `.module.css` 与 `*.css` 原样保留，由 Vite 编译。

**主题**：深色（默认/NEON MATRIX）与浅色双主题。
`theme.ts` 管理模式（默认深色，不跟随系统 `prefers-color-scheme`；手动切换后写入
localStorage 并以它为准），`light-theme.css` 通过 `:root.theme-light` 覆盖全部
`--dsw-alias-*` / `--nm-*` 令牌；顶栏「☀️ 浅色 / 🌙 深色」按钮随时切换。

## 与主进程/后端的连接

- `ui-entry.tsx` 用一个 Proxy 把 `api.ts` 的每个 Remote 方法调用转发为
  `window.electronAPI.wechat.call(method, args)`（Electron IPC）。
- 后端实时更新事件 `wechat-data/updated` 经 `wechat:event` 广播后，
  `ui-entry.tsx` 转成上游监听的 `dsh-wechat-data-updated` DOM 事件。
- 目录选择器接主进程 `dialog:open-directory`（`window.electronAPI.pickDirectory()`）。
- **例外：右下角的主动提醒卡片不走 `api.ts`。** `panels/NoticeBanner.tsx` 直接读 preload 的
  `electronAPI.update`（事件 + 快照）与 `electronAPI.license.status()` —— 这两份都是**主进程
  状态**（更新服务的 phase、许可证的 daysToExpiry），不属于 back-end Remote 的数据；设置弹窗里的
  「软件更新 / 软件授权」两张卡读的是同一来源。它挂在**每一屏**上（主界面 `WechatDataPanel`、
  启动引导 `OnboardingShell`、授权解锁 `LicenseGate`、隐私同意 `PrivacyConsentGate`）——
  更新与到期与「走到哪一屏」无关，停在启动页的用户同样需要知道有新版本。判定口径抽在
  `panels/notice.ts`（纯函数 + 单测），渲染层拆成纯展示的 `NoticeList`（SSR 冒烟直接喂夹具断言）
  与接线的 `NoticeBanner`（宿主不给 `onOpenLicense` 时会摘掉「去软件授权」那个动作，
  免得留下点了没反应的按钮）。

## 构建与运行

```bash
npm run build:ui     # vite build -> src/client/ui-dist
npm start            # prestart 自动先 build:ui，再启动 Electron
```

Electron 主进程 `main.js` 优先加载 `src/client/ui-dist/index.html`，
缺失时回退到演示页 `src/index.html`。

## 依赖说明

前端运行依赖（React 18、Radix UI、TanStack Table/Virtual、ECharts、
dsh-client-ui-primitives、dsh-wechat-data types 等）集中在
`package.json` 的 `devDependencies`，仅用于 `build:ui` 编译；
运行时打包进 `src/client/ui-dist`，不随应用分发 node_modules。
vite 构建使用 `pnpm-workspace.yaml` 中的版本 override 对齐本机 pnpm store。
