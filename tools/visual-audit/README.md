# 视觉审计脚本（从 `output/` 收回仓库）

这两个脚本原先住在 gitignore 的 `output/` 下，导致 `docs/compose/spec/chat-panel-visual-audit.md`
里那份 73KB 的审计结论**无法复现**（见 `docs/RELEASE-PLAN.md` 的 L17）。现在它们随仓库走，
审计结论可以按文档里的步骤重跑。

| 脚本 | 作用 | 产物（都写进 gitignore 的 `output/`） |
|---|---|---|
| `audit3.mjs` | 起真实 Electron → CDP → 打开「群聊信息」抽屉，采集计算样式 / 强制伪类交互态 / 响应式表现 | `output/visual-audit/`（截图 + JSON） |
| `audit4.mjs` | 整面板四层：会话列表 / 消息头部 / 消息流 / 群聊信息抽屉 | `output/visual-audit-panel/`（截图 + JSON） |

## 前置条件（缺一不可）

1. **本机已解密的微信数据**：脚本连的是开发态真实数据（`npm start` 能正常出图的那种环境）。
2. **playwright**：`npm i --no-save playwright`
   （PowerShell：`$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1; npm i --no-save playwright`）。
   只驱动 Electron，用应用自带 Chromium，不需要下载浏览器二进制。
3. **先关闭正在运行的 Super Time**（单实例锁会挡住脚本起的实例）。
4. 脚本自己给 Electron 传 `--remote-debugging-port`（开发态允许），**打包态会被主进程剥离**
   （见 H10），所以它们只能在开发态跑。

## 用法

```bash
node tools/visual-audit/audit3.mjs
node tools/visual-audit/audit4.mjs

# 指定要审计的会话（默认：audit3 按聊天列表顺序取前几个、audit4 取第一个）
AUDIT_GROUPS="群A,群B" node tools/visual-audit/audit3.mjs
AUDIT_GROUP="群A" node tools/visual-audit/audit4.mjs
```

**隐私提示**：脚本原先把两个**真实群名**硬编码在源码里（这也是不能原样入库的原因之一），
现已改为从环境变量读取。请不要再把真实会话名写回源码或提交产物截图——`output/` 已在
`.gitignore` 里，正是为了让截图（含真实联系人内容）不进仓库。

## 未验证

收回仓库时只做了路径解析与隐私清理（`REPO` 上溯两级、产物写回 `output/`、playwright 改为
常规解析），**没有重新执行过**（需要真实数据 + playwright + GUI 会话）。首次重跑若报错，
大概率是这两个脚本与当前前端 DOM 的漂移，请以实际输出为准更新脚本与审计文档。
