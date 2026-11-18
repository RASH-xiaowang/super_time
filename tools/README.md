# 工具目录

`tools/` 只放**可重复使用、可验证**的开发与发布工具。一次性 probe、临时日志、
`tmp-*` 调查脚本放在 `working/` 或系统临时目录，不提交到仓库。

## 根级脚本

| 文件 | 用途 | 入口 |
|---|---|---|
| `audit-remote-types.mjs` | 双向校验后端 `@Remote` 方法与前端 `WechatRemote` 镜像的类型、参数与返回值 | `npm run audit:remote-types`（CI） |
| `remote-files.json` | 由 `scripts/sync-remote-files.mjs` 自动推导的网关类与前端接口文件清单 | `npm run sync:remote-files` |
| `LicenseStudio.cmd` | Windows 下启动许可签发 GUI 的快捷入口 | 双击或命令行运行 |

## 子目录

| 目录 | 内容 | 说明 |
|---|---|---|
| `daily-push/` | 按需生成真实 Electron 面板截图与产品海报 | 成品不再入库；截图写入被忽略的临时目录，不得提交含真实用户数据的截图 |
| `laya/` | 已移除：本地 ONNX 决策模型（2026-11-18 改为对话模型分析，见 `src/backend/wechat-data/src/query/analysis/`） | — |
| `license-studio/` | 本机许可证签发 Electron GUI | 按中文业务模块勾选 27 项开放功能；由 `npm run license-studio` 启动；私钥不得进入仓库 |
| `visual-audit/` | 真实 Electron + CDP 的面板视觉采集脚本 | 需要真实数据与 Playwright；用法见 `tools/visual-audit/README.md` |

## 授权签发台

启动方式：`npm run license-studio`，或双击 `tools/LicenseStudio.cmd`。

- 功能目录由 `src/license/features.js` 统一维护，签发台、设置页和后台拦截共用，避免界面与校验逻辑各维护一份。
- 开放功能按「基础 / 数据浏览 / 智能能力 / 交付与维护」分组，界面只显示中文名称和说明；英文功能 ID 仅写入许可证，供程序兼容使用。
- 「基础数据访问」是所有新许可证的必选项。签发台支持「全选」「基础浏览」「仅基础」三种快捷选择。
- 新许可证使用功能目录版本 2，后台按勾选结果逐项放行。基础数据访问包含首次配置、密钥映射和数据库/图片解密链路，确保「仅基础」许可证也能正常完成初始化。
- 旧许可证没有目录版本时保留兼容行为：基础位继续覆盖新增数据模块，原有 AI、导出、备份、语音转写、隐私体检功能位仍须显式授权。
- 图片文字识别、图片智能理解由主进程 IPC 直接校验，不经过普通 Remote 方法表，关闭对应选项后无法调用。
- 功能授权改造不会生成或替换现有密钥；密钥生成、同步和签发流程保持原样。私钥、许可证文件和客户激活请求不得提交到仓库。

改动授权目录或校验逻辑后至少运行：

```powershell
npx vitest run src/backend/tests/license-feature-catalog.spec.ts src/backend/tests/license-outbound-coverage.spec.ts src/backend/tests/ipc-wechat.spec.ts src/backend/tests/call-gates.spec.ts
node scripts/license-gate-smoke.js
node scripts/license-smoke.js
```

## 维护规则

- 新工具必须说明**输入、输出、前置条件和失败判据**；能进 CI 的优先接入 `package.json` 脚本。
- 产物写到 `output/`、`working/`、`.tmp-*` 或系统临时目录，并确保已被 `.gitignore` 覆盖。
- 不提交真实微信昵称、联系人、聊天截图、许可证私钥、API Key 或本机绝对路径。
- 临时调查结束后删除脚本；若结论需要留存，写进 `docs/`，不要把一次性脚本留成“以后可能有用”。
