# SuperLanguage

SuperLanguage 是 Windows 原生 Win32 微信消息自动化应用，当前版本为
`1.0.0 / API revision 6`。项目提供本机界面、SQLite 持久队列、
HTTP/Webhook、附件资源 spool、MCP stdio 网关和隔离回归测试；运行时
不依赖 WebView、托管运行时、UI Automation、OCR 或 LLM。

## 主要能力

- 发现并启动微信 PC 客户端 `Weixin.exe`（4.x）或 `WeChat.exe`（3.x），
  按窗口类名、标题和尺寸识别登录界面与已登录主窗口。需要登录时只显示并
  前置登录窗口，由用户扫码或点击“进入微信”，最多等待 300 秒，登录后
  自动继续；程序不会代为点击。
- 通过 `ShowWindow` 显示、隐藏和前置微信主窗口，不改动窗口大小或最大化状态。
- 使用固定 `Ctrl+F` 搜索会话，清空输入后键入目标并回车，接受微信当前
  高亮结果。
- 搜索后识别右侧“搜一搜”Chromium 面板，沿鼠标轨迹点击其右上角关闭键；
  只有命中微信主窗口内嵌的 Chromium 子窗口时才执行，面板缺失时跳过。
- 支持仅搜索、文本发送和附件任务。仅搜索任务结束后保持微信窗口可见；
  文本和附件任务结束后尝试隐藏微信窗口。
- 简化发送链路是唯一链路：不读取会话标题，不回读正文或成员身份；
  @ 成员通过可见输入流程接入，详见下文。
- 钱学森式助推-滑翔鼠标轨迹：随机中段变轨、末段阻尼收敛、过冲回拉和
  自动回位；轨迹通过带注入标记的 `SendInput` 发送。
- 自动化期间仅锁定物理鼠标，键盘保持可用；支持超时自动释放和
  `Ctrl+Alt+Q` 紧急停止并退出程序。
- SQLite 任务队列、崩溃恢复、发送意图保护、微信不可用时任务回队等待、
  运行日志和独立队列窗口。
- Bearer 鉴权 HTTP API、Webhook、附件资源上传、任务查询和 MCP 工具接入。
- 系统托盘、单实例运行、Per-Monitor V2 DPI 适配、关闭/最小化后驻留。
- 隔离 API/队列回归测试和零第三方依赖的 MCP 离线测试。

## 当前发送链路

当前主调度只有“简化模式”一条链路，依赖微信发送快捷键为 `Ctrl+Enter`：

- 连续领取同一目标时，如果微信窗口和进程未变化，且上次已成功进入该目标，
  则跳过 `Ctrl+F` 搜索和回车。复用时不读取会话标题，只检查前台窗口属于
  该微信进程、任务未超时或被停止。带 @ 的任务总是重新搜索；首次发送、
  目标变化、窗口/进程变化或上次未成功进入时也会重新搜索。
- 复用依赖“程序上次确实已进入该目标”。程序不读取会话标题，无法检测用户
  在两次任务之间手动切换会话；若需要手动操作微信，请先切换回目标会话，
  或让下一次任务重新搜索。
- 搜索前截取输入框右下角发送按钮区域，若发送按钮呈绿色（输入框已有内容）
  则拒绝执行，任务以 `ERROR_ALREADY_EXISTS`（183）失败且未发送；截图失败
  按“空”处理。搜索词键入后若发现它落进了输入框，会清空并判失败。
- 按回车后直接接受微信当前高亮的第一项，不校验会话标题。
- 文本先沿鼠标轨迹点击输入区，再用 `Ctrl+Enter` 提交一次。字符逐个以同步
  `WM_CHAR`（`SendMessageTimeoutW`，单字符 2 秒超时）发给持有微信键盘焦点的
  窗口，字符间隔按 4–12ms 抖动；代理对（emoji、CJK 扩展 B 等非 BMP 字符）
  改走 `SendInput` Unicode，因为微信的 Qt 编辑器会丢弃孤立的代理项；换行没有
  `WM_CHAR` 等价物，改用真实 `Shift+Enter`，其后等待 250ms 再继续。
  不证明输入框焦点，也不做正文回读校验。
- 带 @ 的文本任务严格按阶段执行：用 `SendInput` 注入 `@` → 等待 200ms →
  要求新的成员选择器窗口在 2 秒内出现，并在 1.5 秒内保持尺寸稳定 200ms，
  否则任务失败 → 逐字（间隔 100ms）输入成员名中最长的不含空格片段，期间
  选择器关闭即失败 → 等待 200ms，确认选择器仍可见 → 回车 → 等待 200ms →  等待选择器在 1.5 秒内关闭（未关闭时再回车一次并多等 0.8 秒，仍未关闭则
  失败）→ 重新聚焦输入框，等待 200ms → 按 `mention_separator` 输入空格或
  `Shift+Enter` 换行 → 写入正文并提交。
  该流程不回读最终成员身份；微信可能用群昵称显示被选中的成员。
- 附件任务不做焦点证明。它先用同样的发送按钮绿色像素启发式确认输入框
  为空（非空时返回 `NotAttempted`，任务记为失败），再以模块自建的
  message-only 窗口作为剪贴板所有者写入文件列表、`Ctrl+V` 粘贴，要求
  10 秒内输入框出现内容后才 `Ctrl+Enter`，最后恢复原剪贴板。提交前失败
  会清空输入框；一旦已注入 `Ctrl+Enter`，绝不再清理。自动化执行器单任务
  最多接收 10 个本机文件；MCP 和 `resource_ids` 最多 9 项；`attachments`
  数组最多解析 16 项，但超过 10 项会在执行阶段失败。
- 自动化结果只有 `NotAttempted`、`Failed` 和 `InjectedUnverified` 三种，
  文本和附件成功只会是 `InjectedUnverified`。因此任务即使状态为
  `succeeded`，`content_verified` 也恒为 `false`；只要已记录发送意图，
  API 就会报告 `delivery_uncertain=true`。

发送成功只表示本机自动化动作完成，不表示微信服务器已确认送达。
`delivery_uncertain=true` 时不得自动重发，必须人工检查目标会话。

## 构建

需要 Windows 10/11、Visual Studio 2022 C++ x64 Build Tools 和 Windows SDK。
Python 3 用于隔离 API 回归测试和图标缺失时的重新生成；MCP 与 MCP 离线
测试要求 Python 3.10+。

```powershell
.\build.bat /check
.\build.bat
.\build.bat /kill
.\build.bat /help
```

输出为 `build\SuperLanguage.exe`。默认构建会拒绝覆盖正在运行的本目录构建；
`/kill` 仅停止路径完全匹配的本目录进程后再构建。构建使用 MSVC C++17、
静态 CRT 和随项目提供的 SQLite amalgamation。

`build\` 是可再生成的构建与运行目录，不属于源码；其中的 `queue.db`、
API 令牌、运行日志等运行数据可能含敏感信息，不应分发。`tools\` 下的人工
探测工具默认把截图和采样写入 `artifacts\`（不存在时自动创建）；该目录可
随时整体删除，不参与构建或运行。注意 `tools\run-send.ps1` 会真实发送微信
消息，仅用于人工验证，必须显式传入 `-ConfirmRealSend` 才会执行。

### 分发前清理

分发包**只应包含** `build\SuperLanguage.exe` 与源码/文档，不要把 `build\` 或
`artifacts\` 整体打包。`dist\SuperLanguage-1.0.0-win64\` 中的
`SuperLanguage.exe` 早于当前源码，发布前需替换为新构建。运行过本程序的
目录会残留以下敏感物：

| 残留物 | 泄露后果 |
|---|---|
| `build\queue.db` | 含明文会话目标、正文与附件路径 |
| `build\api-token.txt` | 当前部署的有效 Bearer/Webhook 令牌 |
| `build\api-enabled.txt` 等 | 本机监听与超时配置 |
| `build\resource-spool\` | 已上传的附件与元数据 |
| `build\flow-debug.log*`、`build\mention-debug.log*` | 运行日志，含会话名称和任务时间线 |
| `build\instance.lock` | 实例锁文件，无敏感内容，但不应随包分发 |
| `artifacts\*.png` | 人工探测截图，可能含完整 Webhook URL（等同于令牌） |

清理步骤：

1. 关闭所有 `SuperLanguage.exe`（构建与测试也会拒绝在运行中覆盖）。
2. 删除 `build\queue.db*`、`build\api-*.txt`、`build\resource-spool\`、
   `build\*.log*`、`build\instance.lock`，以及整个 `artifacts\`。
3. 若截图或 Webhook URL 曾经外发，删除 `api-token.txt` 后重启程序以轮换
   令牌；旧令牌立即失效。
4. 只把 `build\SuperLanguage.exe`、`src\`、`docs\`、`mcp\`、`tests\` 放入发布包。

本目录已纳入 git，`.gitignore` 会排除 `build\`、`artifacts\`、`dist\` 和运行
数据；但直接“压缩整个目录”不受 `.gitignore` 约束。打包前可用
`git status --ignored` 确认这些目录已被排除。

## 运行与配置

> **2026-11-24 起：本程序由 Super Time 授权后才能运行。**
> 部署后的实例目录里必须存在 `instance.ini`（由 Super Time「应用托管」写入），
> 且启动时能连上本机授权管道换取票据；否则进程以**退出码 4** 拒绝启动
> （缺少文件时为 `NOT_MANAGED`，连不上主机时为 `BROKER_DOWN`，功能位未开通时为
> `FEATURE_DENIED`）。运行中票据失效超过 15 分钟宽限后，队列停止领取新任务，
> 已在发送的任务不打断；`/api/send-message`、`/api/send-attachments` 与 Webhook
> 入队会返回 403 `license_required`。
>
> **单实例锁按 exe 目录派生**：不同实例目录可以同时各跑一份（一个 Super Time 托管多个
> 实例），同一目录仍只允许一份 —— 第二次启动会激活已有窗口并以**退出码 5** 退出
> （托管模式下；手工双击的旧行为仍是 0）。Super Time 重启后会**接手**还在跑的实例，
> 不会再拉起第二个副本。
>
> **跨机托管（2026-11-24）**：`instance.ini` 里的 `broker` 支持两种取值 ——
> `\\.\pipe\...`（本机自取）与 `push`（由 Super Time 从局域网 POST 到
> `/api/license/lease`）。`push` 模式下实例**先开 HTTP API**，票据到达前
> `license.state=blocked`、队列暂停（不会有消息发出）；票据 10 分钟到期、宽限 15 分钟。
> 启动请求走实例目录里的 `.start-request`（由 `scripts\superlanguage-launch-watch.cmd`
> 消费），不额外开端口。详见 [`../../docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md) 第 8 节。
>
> 隔离测试用 `--test-skip-license` 跳过校验；`--no-error-ui` 只抑制启动失败对话框
> （自动化需要立刻拿到退出码），**不改变任何授权判定**。

```powershell
.\build\SuperLanguage.exe
.\build\SuperLanguage.exe --tray
```

首次运行会提示将微信发送快捷键设为 `Ctrl+Enter`。确认后写入
`shortcut-tip.txt`，之后不再提示。普通启动会立即检查微信状态，必要时启动
微信；`--tray` 启动不主动检查、启动或前置微信，等有任务时再检查。

运行数据位于 EXE 同目录：

| 文件或目录 | 说明 |
|---|---|
| `queue.db` | SQLite 任务队列与历史记录；启动时和每条任务完成后只保留最近 50 条已完成记录 |
| `api-enabled.txt` | 写入 `1` 时下次启动开启 HTTP API；默认关闭。只有在界面开关时改写，API 启动失败不会把它改成 `0` |
| `api-listen.txt` | 缺失/空/`lan`/`any`/`all`/`0.0.0.0`/`*` 为全部 IPv4（默认，局域网可访问）；`loopback`/`0`/`127.0.0.1` 只绑定 `127.0.0.1`；也可指定本机 IPv4 |
| `api-token.txt` | 32 位十六进制 Bearer/Webhook 令牌；缺失或无效时自动生成 |
| `api-port.txt` | API 运行时写入的实际端口；正常停止时删除 |
| `send-timeout.txt` | 单任务鼠标保护超时，5–600 秒，默认 45 秒；启动时读取 |
| `shortcut-tip.txt` | 首次 `Ctrl+Enter` 提醒的确认标记 |
| `resource-spool\` | 上传附件及元数据，以及按原文件名暂存的 `<id>\<原名>`；未被引用的资源保留 7 天 |
| `flow-debug.log` | 运行日志镜像；含会话名称，Webhook URL 中的令牌已打码；超过 1 MiB 轮转为 `.1`（只保留一份） |
| `mention-debug.log` | @ 与附件流程的结构化诊断，不记录昵称、目标或正文；超过 1 MiB 轮转为 `.1` |
| `instance.lock` | 实例锁；同一目录在另一个 Windows 用户会话中重复启动会被拒绝。**单实例互斥体按 exe 目录派生**，因此不同实例目录可并存（多实例托管），同目录第二份会激活已有窗口并以退出码 5 退出 |

API 默认关闭，可在主界面开启。监听端口由系统自动分配（每次启动可能不同），
运行时写入 `api-port.txt`。`api-listen.txt` 指定的地址不可用时会回退到 `127.0.0.1` 并记录
日志。修改监听或超时配置后需要重启程序。

默认监听 `0.0.0.0`，同一局域网的其他电脑可用 `http://<本机局域网 IP>:<端口>`
和同一令牌调用。首次监听时 Windows 防火墙可能询问，需允许“专用网络”。

本机附件路径按请求来源判断：来自 `127.0.0.1` 的请求允许本机路径；来自其它
电脑的请求即使绑定在 `0.0.0.0` 也拒绝本机路径（返回 403），请改用资源上传
后传 `resource_ids`。把 `api-listen.txt` 写成 `loopback` 可恢复仅本机访问。

**部署警告**：如果本机运行着把外部请求转发到 `127.0.0.1` 的反向代理或隧道
（nginx、IIS ARR、frp、`ssh -R` 等），远程请求会被当作本机来源，从而可以
用本机路径读取并发送任意本地文件。不要这样部署；确有必要时，远程调用方
只能使用 `resource_ids`。

微信未安装、启动失败、登录超时、等待登录时微信退出或状态无法确认时，
尚未写入发送意图的当前任务会放回队列，队列暂停领取（30 秒起逐次翻倍，
上限 5 分钟），界面显示“队列等待微信 · N 秒后重试”。点击“检查微信状态”、
按 `F5`、使用托盘菜单检查或微信登录成功都会立即恢复领取；放回失败时才
判为失败。鼠标锁定失败的任务直接以 `ERROR_LOCK_FAILED`（167）失败，未发送。

界面和日志里的 API 令牌只显示首尾各 4 位；“复制”按钮仍复制完整令牌或
完整 Webhook 地址。

## HTTP、Webhook 与 MCP

当前接口面共 10 个 HTTP/Webhook method+path 操作（6 个 `/api/*`、
4 个 Webhook）和 6 个 MCP 工具。`API revision 6` 是接口版本号，不是接口
数量。

HTTP API：

- `GET /api/health`
- `GET /api/status`
- `GET /api/jobs/{id}`
- `POST /api/send-message`
- `POST /api/send-attachments`
- `POST /api/stop`

Webhook：

- `GET|POST /webhook/<token>`
- `GET /webhook/<token>/jobs/{id}`
- `POST /webhook/<token>/resources`

`/api/*` 使用 `Authorization: Bearer <token>`，Webhook 使用 URL 中的令牌；
两类接口都会拒绝带 `Origin` 的请求。普通 JSON 请求体上限为 8192 字节
（只按请求体计算），资源上传单文件为 1 字节至 20 MiB，上传头只识别
`X-SuperTime-Filename` / `X-SuperTime-SHA256`，成功返回 40 位十六进制资源 ID。
服务最多 8 个连接并发处理，第 9 个连接返回 503 `server busy`；每个连接的
请求头和 JSON 请求体须在 10 秒内收完，否则返回 408 `request timeout`。

MCP 网关为 `mcp\supertime_mcp.py`，从 stdin/stdout 提供
`health`、`status`、`send_message`、`send_attachments`、`get_job` 和
`wait_job` 六个工具。发送工具只表示任务入队，不表示已送达。完整配置、
JSON-RPC 示例和错误语义见 [mcp/README.md](mcp/README.md)。

应用内“帮助”窗口提供 7 组示例：Webhook 地址、健康检查、发送消息、
发送附件、@ 成员流程、任务查询、MCP 配置与调用。MCP 配置示例依次查找
`<exe目录>\mcp\supertime_mcp.py` 与 `<exe目录>\..\mcp\supertime_mcp.py`。

## 验证

```powershell
.\build.bat /check
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\verify.ps1
python .\mcp\test_supertime_mcp.py
```

`tests\verify.ps1` 会拒绝在已有 `SuperLanguage.exe` 运行时启动。它把构建产物
复制到系统临时目录（`GetTempPath`，先取 `TMP` 再取 `TEMP`）下的
`supertime-tests\<run-id>`，在私有 Windows desktop 和单进程 Job Object 中运行
API 用例，不启动微信，也不发出有效发送任务。

2026-11-18 在当前源码上的实测结果：`build.bat` 完整编译链接 0 警告、
`tests\verify.ps1` 的 API/Webhook/资源上传 `10/10` 与 `/api/stop` 正常退出
`10/10`、原生队列断言 `94/94`、MCP 离线测试 `28/28`。

同一天在真机（微信 4.2.0.13）上用 `tools\verify-characters.ps1` 做了全字符集
保真测试：把约 3000 个码位（ASCII、拉丁、符号、箭头、数学符号、制表符、
CJK 标点、假名、CJK 统一表意文字 1500+ 字、谚文、全角、半角假名、兼容区、
emoji 与 CJK 扩展 B）逐块输入并 `Ctrl+A`/`Ctrl+C` 读回比对。修好后的链路
（BMP 走 `WM_CHAR`、代理对走 `SendInput` Unicode）除编辑器自身无法显示的
码位外逐字一致；`SendInput` Unicode 单独用于普通字符时会把紧跟 `-` 的字符
替换成 `-`（`ai-2` → `ai--`），这是首个缺陷的成因。脚本只输入到输入框并清空，
不发送任何消息。

旧构建记录（仅供参考，不代表当前源码）：2026-11-12 隔离复测
API/Webhook/资源上传 `8/8`、`/api/stop` 正常退出 `8/8`、原生队列断言
`61/61`、MCP 离线测试 `22/22`；2026-11-14 原生队列断言 `66/66`。

真实微信登录、搜索、文本/附件发送、@ 成员、搜索面板关闭、超时和紧急
停止均未在当前构建上人工验收，需要在受控账号和交互式桌面中进行。

## 文档

- [项目结构与开发说明](docs/PROJECT_STRUCTURE.md)
- [功能与验收矩阵](docs/FEATURE_MATRIX.md)
- [MCP 配置与安全语义](mcp/README.md)
- [隔离回归测试说明](tests/README.md)

API 令牌、Webhook URL、`queue.db`、运行日志及包含令牌的截图均属于敏感数据。
