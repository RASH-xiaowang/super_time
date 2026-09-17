# Super Time 后端

本目录是从 `D:\deepseek-harness\packages\host\wechat-data`（`@deepseek-ai/dsh-wechat-data`）
完整迁移并适配到 Super Time Electron 主进程的后端。

## 支持平台

**仅 Windows（x64）**。产品读的是 Windows 微信的数据：`Weixin.exe` 内存扫描取密钥、
`xwechat_files` 数据根、`HKCU\Software\Tencent\Weixin` 注册表、`%APPDATA%/Tencent/xwechat/config/*.ini`。

### 为什么是 Windows-only

**根因是数据源，不是打包配置。** 产品读的是 Windows 微信的数据：`Weixin.exe` 内存扫描取密钥、
`xwechat_files` 数据根、`HKCU\Software\Tencent\Weixin` 注册表、`%APPDATA%/Tencent/xwechat/config/*.ini`。
这些在 mac/linux 上都不存在，所以即使打得出包也没有可读的数据。

构建侧是**结果**，而且两个平台的形态并不一样（实测，本机 Windows 10.0.19045）：

| 目标 | 实测行为 |
|---|---|
| `--mac` | **直接失败**：`⨯ Build for macOS is supported only on macOS`（exit 1）。不是「打出个缺二进制的包」，是根本打不出。 |
| `--linux --dir` | **成功出包**（exit 0），但包里唯一的 koffi 原生模块是 `@koromix/koffi-win32-x64/win32_x64/koffi.node` —— 一个 **Windows** 二进制；`@koromix/koffi-linux-x64` 不在包里。即「出得来、跑不了」。 |

`koffi` 的各平台原型包都是 `os`/`cpu` 门控的 optional dependency（`package-lock.json` 里 15 个都在），
而本仓库只把 `@koromix/koffi-win32-x64` 作为 `file:` 依赖内联（见 `package.json` 的
`dependencies`/`optionalDependencies`/`asarUnpack`）。所以即便将来要支持别的平台，也不是「加一行配置」，
而是要补对应原型包 + 在对应平台上构建与验证。

结论：`electron-builder` 的构建目标只保留 `win`/`nsis`（mac/linux 目标已移除）。

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

后端对外提供的方法清单**以自动生成的 [`docs/API.md`](../../docs/API.md) 为准**：它由
`npm run docs:api` 从 `src/backend/wechat-data/src/gateway.ts` 的 `@Remote` 装饰器生成，
`npm run docs:api:check`（CI 一步）守着「文档与源码一致」；运行时可用 `wechat:list-methods`
取当前实际注册的方法。文档里**不再写死方法数量** —— 历史上这里写过的数字已多次漂移。

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
   详见 [wechat/README.md](../../wechat/README.md)。写入入口是界面里的**「数据配置」**面板
   （以及「语音转写」那一节的模型目录 / 引擎路径）；**没有**对应的 npm 脚本 ——
   最早版本文档里写的 `config:wechat`（`show|set|reset`）在当前 `package.json` 里不存在。
6. **Electron IPC**：`main.js` 在 `app.whenReady` 后创建后端，注册
   - `wechat:list-methods` → `{ ok, value }`
   - `wechat:info` → 数据根 / 解密目录 / 当前账号 / 方法数
   - `wechat:call` → `(method, args[])` 调用任意 Remote 方法，返回
     `{ ok, value }` 或 `{ ok:false, error:{message,code,details} }`
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
npm run rag:smoke      # 直接构造后端并调用 Remote 方法（检索层为主）
npm test               # 后端包 + 宿主层 + 前端纯逻辑的全部单测（vitest）
```

## 许可证与签发私钥（L12）

- **签发私钥 `vendor-keys/license-private.pem` 只应存在于「签发机」**：物理隔离到一台专门的
  机器上，那台机器上有一份仓库检出、`vendor-keys/` 只在那里生成与保存。它已被 `.gitignore`
  忽略、也不在 `package.json` 的 `files` 白名单与 `asarUnpack` 里（实测 asar 条目里
  `vendor-keys` 命中数为 0），所以它既不会入库也不会随包分发。
- **开发机不需要它**。依赖它的只有签发侧工具：`npm run license-keygen`（生成密钥对）、
  `npm run license-issue`（用私钥签许可证）、`npm run license-studio`（签发 GUI）——
  它们都从工作树的 `vendor-keys/` 读私钥，因此只能在签发机上跑。
  **没有任何 CI 步骤与冒烟脚本依赖它**（`check:backend-restart` 曾读它，已改为不需要许可证；
  `src/backend/tests/ci-script-isolation.spec.ts` 守着这条不变量）。
- 仓库里只带**公钥**（`src/license/public-key.js`，随包分发，用于本地验签），
  它必须与签发机上的私钥同源；换密钥时要同步更新这个文件并重新打包。
- 想验证签发链路时用 `npm run license-smoke`：它**在内存里注入一对一次性测试密钥**
  （不写仓库、不碰 `public-key.js`），详见 `scripts/license-smoke.js` 头部说明。

## 备注

- `lib/index.js` 是 `tsdown` 产出的单文件 ESM bundle，内部已包含
  `dsh-llm` 的 `BlockAssembler` / `createUserMessage` 等被合并的实现。
- `node:sqlite` 需要 Electron 44 内置的 Node 22+（已满足）。
- 许可证：迁移内容保留上游 MIT 声明（见 `wechat-data/lib` 与 `deps/*/LICENSE`）。
