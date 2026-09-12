# 微信+前端（Super Time）

本目录是从 `D:\deepseek-harness\packages\client\ui-wechat`
（`@deepseek-ai/dsh-client-ui-wechat`）完整迁移并适配到 Super Time Electron
渲染进程的「微信+」前端。

## 迁移范围

| 类别 | 来源 | 本目录 |
|---|---|---|
| 前端源码（TSX/CSS Modules/地图数据等，88 个文件） | `packages/client/ui-wechat/src/**` | `src/client/ui-wechat/src/**` |
| 前端构建产物与类型 | `packages/client/ui-wechat/lib/**` | `src/client/ui-wechat/lib/**` |
| UI 原语（Button/Input/Pill/StateDot/图标等） | `packages/client/ui-primitives` | `src/client/ui-primitives/` |
| 构建入口（Electron 挂载壳） | 新增 | `src/client/ui-app/ui-entry.tsx` |
| 构建模板 | 新增 | `src/client/ui-app/index.html` |
| Vite 构建配置 | 新增 | `vite.config.js` |
| 构建产物（提交，供 Electron 运行） | 由 `npm run build:ui` 生成 | `src/client/ui-dist/` |

## 功能界面（17 个侧栏入口 / 34 个路由页签，114 个 Remote 方法）

侧栏只列 17 项（含固定在底部的「数据配置」）；被合并的视图仍可路由（深链、跨面板跳转都有效），
只是改为在宿主面板顶部用分段切换进入（见 `panels/MergedSections.tsx`）：

| 侧栏项 | 合并的视图 |
|---|---|
| 总结 | 每日总结与任务 / 周期总结 / 年度报告 |
| 聊天会话 | 聊天消息 / 撤回消息（另有 公众号·服务号·客服 过滤） |
| 群聊分析 | 离线洞察 / 活跃监控 |
| 通讯录 | 通讯录 / 社交图谱 |
| 收藏与表情 | 我的收藏 / 表情包 / 收藏·表情统计 |
| 文件与存储 | 文件资产 / 媒体资产 / 存储分析 / 公众号文章 |
| 资金往来 | 月度汇总 / 转账红包明细 |
| 隐私与信任 | 数据边界与出网 / 隐私体检 |
| 数据健康 | 数据库健康 / 原图链路自检 / 操作日志 |

侧栏项：数据总览、微信问答、总结、聊天会话、群聊分析、通话记录、通讯录、朋友圈、
收藏与表情、文件与存储、资金往来、朋友圈洞察、待办日程、隐私与信任、备份恢复、
数据配置、数据健康。

**状态管理与路由**：沿用上游 `wechat-state.ts`（打开/关闭状态）、
`WechatDataPanel.tsx` 的页签状态 + `location.hash` 深度链接、`api.ts` 的
snapshot 缓存（localStorage + 30s TTL + 实时更新失效）、`panels/hooks.tsx`
的分页/懒加载/虚拟列表逻辑。

**样式逻辑**：CSS Modules + `scifi-theme.css` NEON MATRIX 主题令牌，
全部 `.module.css` 与 `*.css` 原样保留，由 Vite 编译。

**主题**：深色（默认/NEON MATRIX）与浅色双主题。
`theme.ts` 管理模式（默认跟随系统 `prefers-color-scheme`，手动切换后写入
localStorage），`light-theme.css` 通过 `:root.theme-light` 覆盖全部
`--dsw-alias-*` / `--nm-*` 令牌；顶栏「☀️ 浅色 / 🌙 深色」按钮随时切换。

## 与主进程/后端的连接

- `ui-entry.tsx` 用一个 Proxy 把 `api.ts` 的每个 Remote 方法调用转发为
  `window.electronAPI.wechat.call(method, args)`（Electron IPC）。
- 后端实时更新事件 `wechat-data/updated` 经 `wechat:event` 广播后，
  `ui-entry.tsx` 转成上游监听的 `dsh-wechat-data-updated` DOM 事件。
- 目录选择器接主进程 `dialog:open-directory`（`window.electronAPI.pickDirectory()`）。

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
