# 安全加固与发布基线

> 面向 Super Time 的维护者、构建者与发布负责人。本文说明当前版本承诺保护什么、
> 不承诺保护什么，以及正式发布前必须通过的硬门禁。

> 安全结论必须以当前代码、打包配置和发布脚本为准，不以文案为准。代码与本文冲突时，
> 先停下来修复门禁或更新基线，不要绕过检查发版。

## 1. 威胁模型

### 1.1 信任边界

以下对象被视为发布链路的基本信任前提：

- 受保护的源码分支、版本 tag 和 GitHub Actions runner。
- Electron/Chromium 运行时、Windows 操作系统与构建工具链。
- 发布签名证书、其私钥密码，以及能够使用它们的发布账号。
- 用户自己的电脑，以及用户明确选择启用远程访问时所处的可信局域网。

以下输入一律按不可信处理：

- 所有 HTTP 请求、请求头、Cookie、URL 路径和请求体。
- 远程浏览器页面、跨站来源和 DNS 解析结果。
- 微信聊天正文、文件名、媒体内容，以及用户导入的文档。
- 本机配置文件、许可证文件和 `app.asar.unpacked` 中的内容；它们可能被本机用户或
  其他程序修改，运行前需要对应校验。
- 尚未通过签名、摘要和内容门禁的下载产物与更新元数据。

“受信”只表示该环节被假定未失陷，不表示可以跳过输入校验。例如发布 runner 可信，
但安装包中的聊天正文仍然不可信。

### 1.2 本基线覆盖的风险

| 编号 | 风险 | 处理目标 |
| --- | --- | --- |
| T1 | 源码映射、TypeScript、测试代码、配置或证书误入安装包 | 构建与打包门禁拒绝，发布停止 |
| T2 | 正式包携带截图、安全探针等测试钩子 | 正式发布签名门禁拒绝测试钩子标记 |
| T3 | 渲染进程被恶意内容利用后获得 Node 或特权 IPC | 沙箱、隔离、权限收口与 IPC 来源校验 |
| T4 | 其他窗口或子框架伪造 IPC 调用来源 | 校验 sender、主 frame 和入口 URL，失败关闭 |
| T5 | 局域网网页发起跨站请求或 DNS rebinding | Host 白名单、同源检查和浏览器请求元数据检查 |
| T6 | 未配对设备直接调用数据或原生能力 | 默认关闭服务、令牌/配对码换会话、方法白名单 |
| T7 | `fullAccess` 浏览器会话可调用本机原生能力 | 只允许显式配对、内存会话和短时有效期；原生动作分级仍待产品决策 |
| T8 | 本地替换 `app.asar` 后运行篡改代码 | ASAR integrity、fuses、自有 JS 不得解包 |
| T9 | 未签名、错误发布者或被替换的更新包 | 强制 Authenticode 签名、发布者、时间戳、版本与摘要校验 |
| T10 | 本机密钥被同机其他账户直接读取 | 密钥分流到独立文件，并尽力收紧目录/文件 ACL |

### 1.3 非目标

以下事项不在本基线能够提供保证的范围内：

- **绝对防逆向、防破解或 DRM。** 客户端代码最终运行在用户控制的机器上，可被提取、
  修改和重打包。压缩、ASAR、签名和完整性检查只能提高误发布与篡改成本。
- **对抗完全控制本机的攻击者。** 拥有管理员/SYSTEM 权限、可替换系统 DLL、驱动、
  Electron 运行时或调试器的一方，能够绕过客户端自身的所有检查。
- **物理安全。** 设备丢失、取证镜像、内存转储和屏幕窥视不在范围内。
- **被攻破的 OS、驱动、微信客户端或第三方服务。**
- **恶意或失陷的发布账号/签名私钥。** 本文的门禁用于发现常见错误和中间人替换，
  不能让一个已被攻破的合法签名者停止签发恶意更新。
- **公网暴露或敌意网络。** 当前局域网访问是明文 HTTP，不适用于公共 Wi-Fi、
  不可信路由器和公网直接暴露。
- **企业合规、等保、审计留证或法律意义上的证据链认证。**
- **第三方 LLM、原图服务、RPA 平台等外部系统的安全性。**

> **不得声称“客户端防逆向有效”。** 许可证、代码混淆、ASAR 和本地完整性检查都
> 不是可信执行环境；它们不能阻止有决心的本机攻击者重建客户端、修改校验逻辑，
> 或替换内嵌公钥后自行签发许可证。

## 2. 已实施控制

### 2.1 构建、压缩与泄露门禁

- 前端构建使用 Vite 的 esbuild 压缩，关闭 sourcemap：
  `vite.config.mjs` 中设置 `minify: 'esbuild'`、`sourcemap: false`。
- 后端 bundle 使用 esbuild 压缩，关闭 sourcemap 和 legal comments：
  `scripts/build-wechat-bundle.js` 中设置 `minify: true`、`keepNames: true`、
  `legalComments: 'none'`、`sourcemap: false`。
- `keepNames: true` 会保留部分函数/类名以改善诊断，因此压缩不等于混淆，更不等于
  防逆向。
- `package.json` 的 `build.files` 白名单及其排除规则不收录 TypeScript、sourcemap、
  测试代码、`.env`、证书/私钥、真实 `wechat/config.json`、`wechat/llm.json`、
  `license.json` 和激活请求等材料。
- `scripts/release-hardening-rules.js` 对最终路径和自有脚本文本做规则检查：
  - 拒绝 `.map`、TypeScript、构建配置、测试代码/夹具、敏感配置、密钥材料和私钥块。
  - 拒绝自有脚本中的 `sourceMappingURL`、`debugger;` 和 PEM 私钥块。
  - 要求 `main.js`、`preload.js`、前端入口和后端 bundle 等运行时必需项存在。
  - 拒绝项目自有 `.js/.cjs/.mjs` 落入 `app.asar.unpacked`；第三方
    `node_modules` 按需解包不受这条规则误伤。
- `scripts/check-release-artifacts.js` 提供源码态与打包态扫描；
  `scripts/electron-builder-after-pack.js` 在 `afterPack` 阶段执行同一套打包内容
  检查，失败会让 electron-builder 停止后续签名和发布。
- **正式发布签名门禁** `scripts/verify-release-signature.js` 额外检查最终
  `app.asar` 内的 `package.json`：只要带有 `supertimeTestHooks: true` 就失败。
  这项检查刻意不放进通用的 `verifyPackagedResources()`，因为 CI 会先构建带测试
  钩子的合法 `npm run pack` 测试包来跑打包态冒烟。

门禁只检查当前产物。未能通过时，不得删除规则、注释规则或改用一个“更宽松”的
本地打包命令继续发布。

### 2.2 Electron 运行时与窗口边界

- 主窗口启用 `contextIsolation: true`、`sandbox: true`，关闭
  `nodeIntegration`、`webviewTag`、子框架/worker Node 集成和拖拽导航。
- 正式包关闭 DevTools；开发态才允许显式打开。
- 打包态尝试移除 `--inspect*`、`--remote-debugging-port`、
  `--remote-debugging-pipe`、`--remote-allow-origins`、`--no-sandbox` 等启动开关。
  CDP 类开关的剥离能阻止通过快捷方式或命令行接入调试端口。
- **已知限制**：`--no-sandbox` 等部分开关由 Electron 在更早阶段处理，主进程里的
  `removeSwitch` 不能可靠恢复沙箱。能控制本机启动参数的管理员仍可能让应用以
  无沙箱方式运行；不要把它当成可由应用侧彻底消除的边界。
- 导航、重定向、新窗口、`webview` 和子框架导航默认拒绝；只有入口文件与受控协议
  可以继续加载。
- 会话权限只允许用户手势触发的剪贴板写入和页面内全屏；摄像头、麦克风、屏幕采集、
  地理位置、USB/串口/HID、通知等请求一律拒绝。
- `package.json` 的 `electronFuses` 禁用 RunAsNode、NODE_OPTIONS 和 CLI inspect，
  启用嵌入式 ASAR integrity、OnlyLoadAppFromAsar 与 Cookie 加密。
  `scripts/electron-builder-after-all.js` 会在最终 exe 上复核这六项基线。

### 2.3 IPC、调用闸门与许可证

- `src/backend/ipc-trust.js` 校验 IPC 的 `sender`、`senderFrame` 必须属于当前主窗口
  主 frame，且 frame URL 必须等于受信本地入口 URL；任一缺失或不匹配都拒绝。
- 桌面 IPC 与 HTTP 远程调用共用 `src/backend/call-gates.js` 的闸门顺序：
  等待后端就绪 → 调试豁免 → 许可证授权。
- 许可证检查自身抛异常时返回拒绝，而不是放行；这是 fail-closed。
- 许可证使用 Ed25519 公钥验签，并检查设备指纹、生效/过期时间、应用版本下限和
  功能位。它能挡住没有签发私钥的普通伪造，但不是服务端 DRM。
- 打包态禁止跳过授权闸门和注入 hang 调试；环境变量不能把正式包变成开发包。

### 2.4 测试钩子与调试自动化

- `src/backend/test-hooks.js` 规定：未打包态允许测试钩子；打包态只有
  `package.json` 明确带有 `supertimeTestHooks === true` 的测试包才允许。
- `main.js` 不把调用者的 `SUPERTIME_TEST_HOOKS` 原样传给后端 worker；只有包元数据
  门控通过后，主进程才注入该标记。
- 安全守卫探针、截图自动化和主题/页签自动化都受该门控约束。
- `electron-builder.test.config.js` 仅通过 `extraMetadata` 给本地测试包写入
  `supertimeTestHooks: true`；正式构建使用 `package.json` 的 `build`，不继承该标记。
- 正式发布签名门禁再次检查最终包元数据，防止测试配置被误用于正式产物。

### 2.5 局域网远程访问

- 服务默认关闭；只有 `api_enabled === true` 且长期令牌非空时才监听。
- 服务绑定一个具体局域网地址，不监听 `0.0.0.0`。
- 所有请求先校验 `Host`：必须与当前监听 IP 一致（回环态额外允许 `localhost`），
  防止 DNS rebinding 和错误 Host 访问。RPA 图片直链与消息 Webhook 只获得受控的
  额外 Host 例外。
- 浏览器态会改变状态或触发能力的 `POST /api/auth`、`POST /api/wechat/call`、
  `POST /api/native/*` 都经过 `src/backend/http-request-guard.js`：
  `Origin` 必须是同 host 的 HTTP 源；显式的跨站/同站 `Sec-Fetch-Site` 会被拒绝。
  无 `Origin` 的非浏览器客户端（脚本、RPA）仍走各自原有的令牌/签名逻辑。
- 认证、方法调用、原生代理和消息 Webhook 的请求体要求
  `application/json`；读取有大小上限，超限连接会被销毁。
- 配对码默认 5 分钟有效、最多尝试 5 次、最多同时保留 8 个；长期令牌和配对码使用
  定长摘要比较。
- 会话 Cookie 为 `HttpOnly`、`SameSite=Lax`、`Path=/`，默认 12 小时；会话只存在
  内存中，应用重启后全部失效。
- 当前设置页生成的局域网扫码二维码与标题栏“打开网页”交接码都会签发
  `fullAccess` 会话，二者都可调用全部 Remote 方法与 `/api/native/*` 原生能力。
  只有通过长期 `api_token` 登录且未带 `fullAccess` 标记的会话会走远程方法白名单。
- 服务端只认内存中的 `fullAccess` 标记；伪造 URL 的 `mode=desktop` 不能提权，
  停服、轮换令牌或交接结束都会清空会话。但 `fullAccess` 本身等同桌面端权限，
  二维码只能给本人设备；原生动作分级仍是尚未消除的产品风险，见第 6 节。
- 远端静态页面对 HTML 返回 CSP，并统一设置禁止嵌入、禁止 MIME 嗅探、
  `Referrer-Policy: no-referrer`、COOP/CORP 和空权限策略。静态路径先解析再校验
  根目录前缀，拒绝 `../`、反斜杠和编码穿越。

### 2.6 ASAR 与原生资产

- 自有运行时代码必须留在受 ASAR integrity 保护的 `app.asar` 内。
  `app.asar.unpacked` 不受该完整性层覆盖，因此不能把项目自己的 JS 放到那里。
- 只解包运行时必须由操作系统加载或执行的资产，例如 koffi/ONNX 原生模块、
  `img_helper.dll`、`wx_silk.exe`、whisper 资源等。
- 朋友圈 SNS 的 WASM 与胶水 JS 刻意留在 `app.asar` 内；
  `src/backend/wechat-data/src/query/sns-keystream.ts` 从归档体内解析资产，
  不退回 `app.asar.unpacked`。`scripts/packaged-smoke.js` 和
  `scripts/packaged-sns-video-check.js` 会检查布局、字节一致性和真实 Electron
  运行时可加载性。
- `img_helper.dll` 在 `koffi.load()` 前复核钉死的 SHA-256；不匹配时拒绝加载。
  这是单个高风险管理资产的前置校验，不代表其他解包 DLL/exe/原生模块都已逐个做
  加载前哈希校验。

### 2.7 本机密钥与配置

- 指定的密钥字段会迁移到数据根旁边的 `secrets.json`，而不是继续留在
  `config.json`；`src/backend/secure-fs.js` 会尽力把状态目录、数据根和已知敏感
  文件收紧到当前账户可访问。
- Windows 使用 `icacls` 去除继承并授权当前身份；POSIX 使用 `0700/0600`。
  权限收紧失败只告警，不会阻止应用启动。
- 这只是降低同机其他账户误读的暴露面，不等于静态加密；`secrets.json`、本机
  `config.json` / `llm.json` 中的密钥和模型配置仍应由操作系统加密能力
  （DPAPI / Electron `safeStorage`）继续加固。

## 3. 本地测试包与正式包

| 产物 | 生成方式 | 测试钩子 | 签名要求 | 用途 |
| --- | --- | --- | --- | --- |
| 开发态 | `npm start` / `npm run dev` | 始终允许 | 无 | 本地开发与调试 |
| 本地测试包 | `npm run pack` | `supertimeTestHooks: true` | 允许未签名 | 打包态冒烟、安全探针、SNS/原生布局检查 |
| 正式安装包 | GitHub `Release` workflow 的 `dist --publish never` | 不允许 | 必须 Authenticode 有效、带时间戳、发布者匹配 | 上传到 GitHub Releases 的唯一正式产物 |

本地测试包和正式包不能混用：

- `npm run pack` 只生成 `dist/win-unpacked` 的测试目录，不生成可发布安装器。
- `npm run dist` 会生成安装器，但单独执行它仍不构成正式发布；必须再通过
  `security:artifacts`、`security:artifacts:packaged` 和 `security:release`。
- `security:artifacts:packaged` 是通用打包内容检查，它必须允许带测试钩子标记的
  合法测试包，因此**不能单独用它证明正式包没有测试钩子**；正式包必须由
  `security:release` 放行。
- 测试包的未签名状态不适用于用户分发。不要把 `dist/win-unpacked` 直接压缩后发给
  用户，也不要用测试包覆盖 Release 资产。

## 4. 正式发布流程

### 4.1 发版前准备

1. 更新 `package.json` 版本与 changelog；tag 必须是 `v` 加同版本号，例如
   `v1.2.0` 对应 `package.json` 的 `1.2.0`。
2. 确认 GitHub 仓库已配置以下发布 secret，且发布者名称与签名证书 Subject 一致：
   - `WINDOWS_CERT_PFX_BASE64`
   - `WINDOWS_CERT_PASSWORD`
   - `WINDOWS_CERT_PUBLISHER_NAME`
3. 建议仓库管理员启用 tag 保护、发布 Environment 审批、2FA 和最小权限；
   当前工作流会把 `contents: write` 权限授予发布 job，因此账号安全直接关系到
   更新链安全。
4. 在任何导出或日志中只检查 secret 是否存在，不打印 secret 值。

### 4.2 自动化发布门禁

`.github/workflows/release.yml` 由 `v*` tag 触发，按以下顺序执行：

1. 全历史 checkout、Node.js 22、`npm ci`，并单独安装 Electron 二进制。
2. 类型检查、单元测试、全量变异自证、接口文档一致性、后端 lint、依赖来源检查、
   生成产物一致性和性能基准。
3. 校验 tag 与 `package.json` 版本完全一致。
4. 先 `npm run pack` 构建测试包，运行打包态冒烟、安全守卫、SNS 视频字节比对和
   密钥迁移检查。此处的测试包有意带测试钩子，不能上传。
5. 检查三个签名 secret 是否存在。缺少任何一个都必须失败。
6. 强制签名构建正式包：

   ```powershell
   npm run dist -- --publish never --config.forceCodeSigning=true "--config.win.signtoolOptions.publisherName=$env:SUPERTIME_WIN_PUBLISHER_NAME"
   ```

   `--publish never` 保证构建和检查完成前不会在 GitHub 上出现未验证资产。
7. 依次运行：

   ```powershell
   npm run security:artifacts
   npm run security:artifacts:packaged
   npm run security:release
   ```

8. 只有以上全绿后，工作流才用同一次构建的 `dist/` 文件覆盖上传
   `latest.yml`、安装器和 blockmap。Release 先保持草稿，远端资产名、大小、
   `latest.yml` 版本全部核对，并重新下载远端安装包实算 SHA-512；该值与本地构建
   和两份 `latest.yml` 一致后才公开。上传失败或内容替换不会留下公开的空包。

发布脚本不得用 `${{ github.ref_name }}` 或 `${{ github.repository }}` 直接拼接
PowerShell 源码。tag/repo 只从 `GITHUB_REF_NAME` / `GITHUB_REPOSITORY` 环境变量
读取并做格式校验，避免恶意 tag 名称进入持有 `contents: write` 令牌的脚本。

`scripts/verify-release-signature.js` 是正式发布签名门禁，负责：

- 检查发布文件齐全，并再次执行打包内容检查。
- 检查最终 `app.asar` 内 `package.json` 不含 `supertimeTestHooks: true`。
- 要求应用 exe 与安装包 Authenticode 状态为 `Valid`。
- 要求两者都有时间戳，且证书 Subject 包含 `app-update.yml` 声明的发布者名称。
- 校验 `latest.yml` 的版本、安装包文件名和 SHA-512 与本次构建一致。

`package.json` 中的 `verifyUpdateCodeSignature: true` 让自动更新器继续校验下载
安装包的发布者签名。不要把 `latest.yml` 的摘要当成唯一信任根：它和安装包都可能
被同一个 GitHub 发布账号替换；Authenticode 和签名私钥保护是独立的一层。

### 4.3 发布后检查

- Release 上必须存在 `latest.yml`、`Super-Time-Setup-<version>.exe` 和对应
  `.blockmap`，版本号与 tag 一致，远端资产大小与本地 `dist/` 一致；工作流还必须
  下载远端 exe 复算 SHA-512，不能只比较两份 YAML 里的摘要字段。
- 重新下载安装包，确认 Authenticode 状态、发布者和时间戳正常，再进行安装。
- 从上一正式版本执行一次自动更新，确认能正常下载、校验和重启。
- 发布后发现泄露、错误签名或错误资产时，不要静默覆盖已发布的同一版本；撤销资产，
  轮换受影响凭据，修复后发布新的补丁版本。

## 5. 自检命令

以下命令用于人工复核。它们是否真正通过，以命令退出码和输出为准；不要只看其中
某一步的绿色提示。

### 5.1 常规源码与测试门禁

```powershell
npm run typecheck
npm test
npm run check:backend
npm run check:types
npm run docs:api:check
npm run lint:db
npm run check:deps-provenance
npm run check:mutation
```

### 5.2 本地测试包与打包态检查

```powershell
npm run pack
npm run package:smoke
npm run security-guard:smoke:packaged
npm run package:sns-video:smoke
npm run m1-secrets:smoke
npm run security:artifacts
npm run security:artifacts:packaged
```

- `package:sns-video:smoke` 在没有 `dist/win-unpacked/resources/app.asar` 时会打印
  “跳过”并以 0 退出。它**不算通过**；必须紧跟在成功执行 `npm run pack` 之后运行，
  并确认输出中没有跳过提示。
- `security:artifacts` 检查源码态构建产物；`security:artifacts:packaged` 检查当前
  打包目录中的 asar/unpacked 内容。

### 5.3 正式发布前

在已注入签名凭据的 Windows 环境执行：

```powershell
npm run dist -- --publish never --config.forceCodeSigning=true "--config.win.signtoolOptions.publisherName=$env:SUPERTIME_WIN_PUBLISHER_NAME"
npm run security:artifacts
npm run security:artifacts:packaged
npm run security:release
```

检查 secret 是否存在但不打印内容：

```powershell
$required = @('CSC_LINK', 'CSC_KEY_PASSWORD', 'SUPERTIME_WIN_PUBLISHER_NAME')
$missing = $required | Where-Object {
  [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_))
}
if ($missing.Count -gt 0) {
  throw "缺少发布签名凭据：$($missing -join ', ')"
}
Write-Host '签名凭据存在性检查通过'
```

发布流程还应确认：

- `npm run security:release` 明确输出了“发布签名门禁通过”。
- 最终 `app.asar` 的 `package.json` 没有 `supertimeTestHooks: true`。
- `app.asar.unpacked` 中没有项目自有 `.js/.cjs/.mjs`。
- 安装器和应用 exe 的 Authenticode 都是 `Valid`，不是仅检查文件存在。
- 日志、Issue、Release 说明和 CI 输出中没有 secret 原文、Cookie、令牌或私钥。

## 6. 残余风险与后续加固

| 残余风险 | 影响 | 后续方向 |
| --- | --- | --- |
| 客户端许可证可被补丁、重打包或替换校验根绕过 | 无法可靠阻止破解；离线许可证的 `seats`、吊销和到期只能提高成本 | 增加服务端签发/短期令牌、可选在线吊销和异常激活检测；不要对外宣称防破解 |
| 局域网访问是明文 HTTP，Cookie 没有 `Secure`，会话 12 小时 | 可信局域网内的嗅探者可取得令牌、会话和查阅的数据；泄漏的 `fullAccess` 会话可触发原生动作 | 仅在可信网络启用，用完关闭并轮换令牌；后续引入 TLS/reverse proxy，并单独设计 `fullAccess` 的短时授权 |
| 本机密钥仍是本地文件，ACL 是尽力而为 | 同机高权限进程、备份、同步盘或误配置仍可能读取 | 迁移到 DPAPI/Electron `safeStorage`，限制明文导出路径；轮换所有曾离开受控环境的密钥 |
| `app.asar.unpacked` 不受 ASAR integrity 覆盖 | 本机攻击者可替换解包 DLL/exe/原生模块；当前只有 `img_helper.dll` 有钉死哈希的加载前校验 | 为每个解包资产建立 SHA-256/Authenticode 清单并在加载前复核；持续缩小解包面 |
| GitHub tag、发布账号或签名私钥失陷 | 攻击者可替换 Release 资产或签发看似合法的更新 | 2FA、受保护 tag、发布 Environment 审批、最小权限、硬件/HSM 保护签名私钥；发现失陷立即吊销并通知用户 |
| 压缩和 ASAR 只提高提取成本 | 任何本机用户都可从包中恢复 JS 并分析逻辑；不能把它当知识产权保护 | 明确不承诺防逆向；敏感信任逻辑放到服务端，客户端只保留必要校验 |
| 依赖和原生资产供应链不完整可复现 | 上游包或构建机器被污染时，内容门禁可能仍显示绿色 | 固定版本、校验哈希/来源、最小依赖、构建环境隔离和持续审计 |
| 测试包/开发态带有调试钩子 | 误分发会暴露自动化入口和额外攻击面 | 只在 CI 测试阶段使用；正式发布必须由签名门禁确认无测试钩子标记 |
| `--no-sandbox` 等早期启动开关无法由应用内撤销 | 能控制启动参数的本机管理员可让渲染进程失去 OS 沙箱，放大渲染层漏洞影响 | 不把它当作已消除风险；限制本机管理员权限、监控异常启动方式，并继续收紧渲染层输入与 IPC |
| 可选的 `img_helper.dll` 会修改微信进程内存 | 可能引发兼容性、稳定性、杀软拦截或第三方条款风险 | 默认关闭，明确告知影响；保持哈希校验，失败时拒绝加载并安全回滚 |

本威胁模型明确不覆盖：完全控制本机或 SYSTEM 权限的恶意者、物理访问、被攻破的
操作系统/驱动、能够合法读取本机用户数据的内部人员，以及任何形式的绝对 DRM。
这些场景需要独立的终端安全、企业策略和运维体系，不能由应用内门禁单独解决。

## 7. 维护约定

- 新增 IPC 必须经过 `ipc-trust` 包装，并补来源伪造测试。
- 新增浏览器可触发的写接口必须同时考虑 Host、会话、同源和请求体约束。
- 新增原生文件必须说明为什么不能留在 asar，并同步打包布局、冒烟检查和完整性策略。
- 新增密钥字段必须进入敏感字段迁移/ACL 策略，不得出现在源码、构建产物或日志。
- 修改发布脚本、`build.files`、`asarUnpack` 或 fuses 时，必须同步更新本文和
  对应自检命令；任何“先发版、后补门禁”的做法都不符合本基线。
