# 微信+后端（Super Time）

本目录是从 `D:\deepseek-harness\packages\host\wechat-data`（`@deepseek-ai/dsh-wechat-data`）
完整迁移并适配到 Super Time Electron 主进程的「微信+」后端。

## 迁移范围（无遗漏核对）

| 类别 | 来源 | 本目录 |
|---|---|---|
| 后端源码（TypeScript） | `packages/host/wechat-data/src/**` | `src/backend/wechat-data/src/**` |
| 运行时构建产物（ESM bundle） | `packages/host/wechat-data/lib/index.js` | `src/backend/wechat-data/lib/index.js` |
| 类型声明 | `packages/host/wechat-data/lib/types/**` | `src/backend/wechat-data/lib/types/**` |
| Typert host/remote 生成物 | `lib/typert.host.js`、`lib/typert.remote-client.js` | 同目录 |
| 资源文件 | `resources/**`（区域码表、Silk 解码器） | `src/backend/resources/**`、`src/backend/wechat-data/resources/**` |
| 单元测试 | `packages/host/wechat-data/tests/**` | `src/backend/wechat-data/tests/**` |
| 包配置 | `package.json`、`README.md`、`tsconfig*.json` | `src/backend/wechat-data/**` |
| 运行时依赖 | `cordis`、`cosmokit`、`dsh-typert-protocol`、`dsh-native-command`、`dsh-home-paths`、`dsh-invariants`、`dsh-llm`、`dsh-brand`、`dsh-timeout`、`dsh-util-crypto`、`dsh-util-values`、`schemastery`、`@standard-schema/spec`、`fzstd`、`koffi`、`@koromix/koffi-win32-x64`、`zod` | `src/backend/deps/**` |

后端对外提供 **114 个 Remote 方法**（`getSessions` / `getMessages` / `getContacts` /
`getMoments` / `getOverview` / `getGraph` / 备份 / 导出 / 隐私审计 / 密钥扫描 / 语音转写 /
每日总结 / 待办 / 操作日志等），方法清单见 `packages/host/wechat-data/README.md`
或运行时调用 `wechat:list-methods`。

## 与上游的适配点

1. **依赖不依赖 pnpm workspace**：上游的 `@deepseek-ai/*` peer 依赖被按原样「vendor」
   到 `src/backend/deps/`，并通过 `package.json` 的 `file:` 依赖在 `npm install` 时
   安装到 `node_modules`。
2. **Cordis Context 最小化**：新增 `src/backend/wechat-host.js`，实现
   `reflect.provide` / `effect` / `emit` / `settings` / `llm` 等网关
   `WechatDataGateway` 实际使用到的 Context 面；不加载完整 Cordis 插件系统。
3. **数据根**：默认改为 `app.getPath('userData')/wechat-data`（即 Super Time 自己的
   用户数据目录）。仍支持上游环境变量：
   - `DSH_WECHAT_DATA_DIR`：数据根（最高优先级）
   - `DSH_WECHAT_DECRYPTED_DIR` / `DSH_WECHAT_DECODED_DIR`：显式固定路径
   - `DSH_WECHAT_SOURCE_DIR`：一次性导入旧快照
   - `DSH_WECHAT_BASE_DIR`：原始微信目录（`.dat` 回退用）
   - `DSH_HOME`：不设 `DSH_WECHAT_DATA_DIR` 时数据根的父目录（默认 userData）
4. **LLM 桥接**：AI 问答/每日总结/周期总结/任务运行走 `createLlmBridge`，
   配置以下环境变量后即用 OpenAI 兼容接口：
   - `SUPERTIME_LLM_PROVIDER`（默认 `openai-compat`）
   - `SUPERTIME_LLM_MODEL`
   - `SUPERTIME_LLM_API_KEY`
   - `SUPERTIME_LLM_API_URL`（默认 `https://api.openai.com/v1`）
   - `SUPERTIME_LLM_API_PATH`（默认 `/chat/completions`）
   - `SUPERTIME_LLM_TIMEOUT_MS`（默认 120000）
   未配置时行为与上游一致：`askWechat` 报“未配置默认模型”，
   `generateDailySummary` 输出降级统计文本。
5. **路径配置中心**：所有路径配置统一记录在 `<userData>/wechat/config.json`
   （`src/backend/wechat-paths.js` 管理与映射），启动时自动应用并回写实际解析路径，
   详见 [wechat/README.md](../wechat/README.md)。命令行：
   `npm run config:wechat show|set|reset`。
5. **Electron IPC**：`main.js` 在 `app.whenReady` 后创建后端，注册
   - `wechat:list-methods` → `{ ok, value }`
   - `wechat:info` → 数据根 / 解密目录 / 当前账号 / 方法数
   - `wechat:call` → `(method, args[])` 调用任意 Remote 方法，返回
     `{ ok, value }` 或 `{ ok:false, error:{message,code,details} }`
   - `wechat:dispose` → 释放实时同步与调度器
   - 事件：`wechat-data/updated` 等经 `wechat:event` 广播到渲染进程。
   `preload.js` 以 `window.electronAPI.wechat` 暴露上述接口。

## 目录结构

```
src/backend/
├── wechat-host.js          # Electron 主进程适配层（Context + LLM 桥 + IPC 调用封装）
├── deps/                   # vendor 的上游运行时依赖（file: 依赖）
├── resources/              # 迁移资源（区域码表 + wx_silk.exe，供 bundle 运行时查找）
└── wechat-data/
    ├── lib/                # 上游构建产物（运行时使用的 ESM bundle + 类型声明）
    ├── src/                # 上游 TypeScript 源码（逐文件迁移，无遗漏）
    ├── resources/          # 上游资源副本
    ├── tests/              # 上游测试
    ├── package.json
    └── README.md
```

## 运行

```bash
npm install
npm start
```

渲染进程会显示后端初始化信息，并可通过下拉框调用 `getDbStatus` / `getSessions` /
`getContacts` 等方法。若尚未导入解密数据，绝大多数查询返回空结果或
「解密目录不存在」提示；数据布局说明见上游 README。

纯 Node 冒烟测试（不启动 Electron 窗口）：

```bash
npm run smoke:wechat
```

## 备注

- `lib/index.js` 是 `tsdown` 产出的单文件 ESM bundle，内部已包含
  `dsh-llm` 的 `BlockAssembler` / `createUserMessage` 等被合并的实现。
- `node:sqlite` 需要 Electron 44 内置的 Node 22+（已满足）。
- 许可证：迁移内容保留上游 MIT 声明（见 `wechat-data/lib` 与 `deps/*/LICENSE`）。
