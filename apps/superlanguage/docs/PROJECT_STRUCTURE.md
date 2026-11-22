# SuperLanguage 项目结构与开发说明

> 当前版本：`1.0.0 / API revision 6`
>
> 适用目录：`C:\Users\Administrator\Desktop\new_supertime`

## 当前状态

SuperLanguage 是 Windows 原生 Win32 微信消息自动化应用。当前项目包含本机
界面、SQLite 持久队列、HTTP/Webhook、附件资源 spool、MCP stdio 网关、
隔离回归测试和真机调试工具。

- 构建产物为 `build\SuperLanguage.exe`，进程名为 `SuperLanguage`。
- 产品、窗口、托盘、资源版本和 MCP 服务品牌统一为 SuperLanguage。
- C++ 内部保留 `feather::` 命名空间，以及 `version.h` 中的
  `FEATHER_VERSION_*` / `FEATHER_API_REVISION` 宏；这些只是内部名称，不是
  用户可见品牌。旧 Feather 启动器、`FEATHER_*` 环境变量和 `X-Feather-*`
  上传头均已不再支持。
- 当前接口面为 10 个 HTTP/Webhook method+path 操作（6 个 `/api/*`、
  4 个 Webhook）和 6 个 MCP 工具；`API revision 6` 是版本号。
- 当前源码不包含 UI Automation、OCR、vision 或 LLM 识别模块，也不初始化 COM。
- 简化发送链路是唯一链路：不读取会话标题，不回读正文或成员身份；@ 成员
  通过输入 `@`、成员名、回车选择和分隔符流程接入。
- 发送状态表示本机自动化执行结果，不保证微信服务器已送达。

## 入口与模块

| 入口/模块 | 职责 | 主要依赖或产物 |
|---|---|---|
| `src\main.cpp` | Win32 界面、托盘、单实例与实例锁、配置、帮助、微信状态、登录等待和任务调度 | automation、API、queue |
| `src\automation.cpp/.h` | 微信发现、登录窗口识别、窗口控制、搜索、搜索面板关闭、草稿像素探测、键鼠注入和附件发送 | Win32（`SendInput`、`SendMessage`、剪贴板） |
| `src\api_server.cpp/.h` | HTTP/Webhook、鉴权、JSON、资源上传与暂存、状态查询 | automation、queue |
| `src\queue_store.cpp/.h` | SQLite 建库迁移、队列、发送意图、回队、崩溃恢复 | `third_party\sqlite` |
| `src\app.rc` | 图标、Manifest、版本资源 | `assets\`、`version.h` |
| `mcp\supertime_mcp.py` | 零第三方依赖的 MCP stdio 网关 | 本地 HTTP API |
| `tests\verify.ps1` | 隔离 API 与原生队列回归入口 | `verify_api.py`、队列测试 |
| `build.bat` | 唯一构建入口 | MSVC、Windows SDK、SQLite |

## 目录结构

```text
new_supertime/
  build.bat                  唯一构建入口
  README.md                  项目概览、运行与配置
  .gitignore                 运行数据、构建产物和密钥忽略规则
  .gitattributes             换行与二进制文件规则
  assets/
    app.ico                  应用图标
    app.manifest             DPI/兼容性/longPath Manifest
  src/
    main.cpp                 Win32 UI、托盘、配置、帮助和任务调度
    automation.cpp/.h        微信窗口发现、搜索和发送
    api_server.cpp/.h        HTTP/Webhook、鉴权、资源上传
    queue_store.cpp/.h       SQLite 队列、恢复和状态迁移
    app.rc                   图标、Manifest、版本资源
    resource.h               资源 ID
    version.h                产品版本和 API revision
  third_party/sqlite/
    sqlite3.c/.h             SQLite amalgamation
  mcp/
    supertime_mcp.py         SuperLanguage MCP stdio 网关
    test_supertime_mcp.py    离线 MCP 测试入口
    examples/
      mcp-config.example.json MCP 客户端配置示例（占位路径）
      stdio_client.py        只读 stdio 客户端示例
    tests/
      __init__.py
      test_supertime_mcp.py  MCP 单元与协议测试实现
    README.md                MCP 配置、工具和安全语义
  tests/
    verify.ps1               隔离 API/队列回归入口
    verify_api.py            API、Webhook、资源上传和失败状态回归
    queue_state_test.cpp     队列恢复和状态不变量
    build_queue_state_test.cmd 原生队列测试编译脚本
    README.md                测试范围与隔离措施
  tools/
    gen_icon.py              缺失图标时的生成脚本
    capture-window.ps1       UI 截图调试工具，默认输出到 artifacts/
    run-search.ps1           搜索流程调试工具，默认输出到 artifacts/
    run-send.ps1             发送流程调试工具，可能产生真实消息
  docs/
    PROJECT_STRUCTURE.md     本文件
    FEATURE_MATRIX.md        功能与验收矩阵
  build/
    SuperLanguage.exe        当前开发构建
    *.obj, app.res           构建时生成的编译中间物
    queue.db                 运行时任务队列
    api-*.txt                运行时 API 配置
    resource-spool/          上传附件暂存区
    flow-debug.log           运行日志镜像（超过 1 MiB 轮转为 .1）
    mention-debug.log        @/附件流程结构化诊断（超过 1 MiB 轮转为 .1）
    instance.lock            实例锁
  dist/                      旧发布包（其中 EXE 早于当前源码），已被忽略
  artifacts/                 调试截图和探测输出，由 tools 脚本按需创建，已被忽略
```

运行数据、构建中间物和日志不属于发行包。`build\queue.db` 保存明文目标、
正文和附件路径，不能公开分发。

人工调试工具只读取 `build\SuperLanguage.exe`，默认把截图和采样写入
`artifacts\`，输出目录不存在时自动创建，不混入构建目录。该目录可以整体
删除，程序运行不依赖它。`run-search.ps1` 点击前会确认 SuperLanguage 位于
前台，否则拒绝点击。

## 命名约定

- MCP 入口只有 `mcp\supertime_mcp.py`，离线测试入口只有
  `mcp\test_supertime_mcp.py`。
- MCP 只读取 `SUPERTIME_*` 环境变量。
- 资源上传只识别 `X-SuperTime-Filename` / `X-SuperTime-SHA256`；只带旧
  `X-Feather-*` 头的上传返回 400。
- 配置文件使用通用名称 `api-token.txt`、`api-port.txt`、
  `api-enabled.txt`、`api-listen.txt`、`send-timeout.txt`。
- 内部 `feather::` 命名空间与 `FEATHER_VERSION_*` / `FEATHER_API_REVISION`
  宏保留为内部名称。

## 界面、托盘与启动

主窗口提供微信状态、会话对象、文本内容、附件路径、@ 参数、API 开关、
运行统计以及日志/队列入口。帮助窗口提供 7 组 API/Webhook/MCP 示例；
MCP 配置示例依次查找 `<exe目录>\mcp\supertime_mcp.py` 与
`<exe目录>\..\mcp\supertime_mcp.py`。

- 单实例互斥体为 `Local\SuperLanguage.AutomationShell.Singleton`。另外在
  EXE 目录独占打开 `instance.lock`：同一目录已在另一个 Windows 用户会话中
  运行时，新实例提示后退出，避免两个实例共用同一个队列。
- 普通启动后自动检查微信状态，并可能启动微信；`--tray` 启动不主动检查、
  启动或前置微信，等有任务时再检查。队列任务开始前都会检查。
- 关闭或最小化主窗口会隐藏到系统托盘，后台队列和 API 继续运行。
- 托盘右键菜单提供“打开 SuperLanguage”“检查微信状态”“退出”；
  左键双击恢复主窗口，不支持左键单击恢复。
- 首次 `Ctrl+Enter` 提示框、托盘菜单、窗口拖动/菜单等模态循环期间不领取
  新任务，也不推进登录轮询。
- Explorer 重启后监听 `TaskbarCreated` 并重新注册图标。
- 主窗口 `F5` 检查微信状态，`Esc` 将主窗口隐藏到托盘。
- 全局 `Ctrl+Alt+Q` 由独立线程注册：立即释放鼠标钩子并中止当前自动化，
  当前任务按超时（`ERROR_TIMEOUT`）判为失败，随后退出整个 SuperLanguage 进程。
- 运行统计中的“待确认”是文本/附件注入成功（`InjectedUnverified`）的次数。
- 界面、日志窗口、帮助窗口和 `flow-debug.log` 中的 API 令牌只显示首尾
  各 4 位；“复制”按钮仍复制完整令牌或完整 Webhook 地址。
- 界面使用 Per-Monitor V2 DPI 适配，不依赖 WebView 或托管运行时。
- 帮助窗口的“刷新示例”只重建示例文本；“刷新令牌”位于主界面 API 卡片，
  会轮换令牌并使旧令牌立即失效。

## 微信自动化链路

1. 发现 `Weixin.exe`（微信 4.x）或 `WeChat.exe`（微信 3.x）进程和窗口。
2. 按窗口类名、标题和尺寸识别登录界面或已登录主窗；可从 SuperLanguage 受控
   启动微信。发现登录窗口时只显示并前置它，提示用户扫码或点击“进入微信”，
   每秒轮询，最多等待 300 秒，界面状态为“等待登录微信”；登录后自动继续，
   程序不会代为点击。
3. 将微信前置并保持原窗口大小。显示/隐藏通过 `ShowWindow` 实现，不依赖微信的
   显示/隐藏快捷键。
4. 首次进入某个目标或目标发生变化时：先截取发送按钮区域，若发送按钮呈绿色
   （输入框已有内容）则以 `ERROR_ALREADY_EXISTS` 失败；再点击窗口左上
   `(100, 58)` DIP 处（窄布局下为返回箭头，宽布局下为会话列表搜索框），
   发送两次 `Ctrl+F`，用 `Ctrl+A` 和退格清空，注入会话名；若会话名落进
   输入框，清空后判失败。
5. 回车后使用 `accept_current_conversation()` 接受微信高亮结果，不读取会话
   标题。连续领取同一目标时，主调度检查上次成功进入的目标、微信窗口和进程
   是否一致，并通过 `accept_reused_conversation()` 复用当前会话：它只检查
   前台窗口属于该微信进程、任务未超时或被停止，不读取标题；成功则跳过
   搜索和回车，否则回退完整搜索。带 @ 的任务总是重新搜索，以恢复输入框
   焦点。用户在两次任务之间手动切换会话无法被程序检测，操作微信后应让
   下一次任务重新搜索。
6. 实际执行搜索或复用会话后检测右侧“搜一搜”嵌入网页面板。关闭点按客户区
   `right - 15 DIP`、`top + 45 DIP` 计算；只有该点命中微信主窗口内嵌的
   `Chrome_WidgetWin*` 子窗口时才沿鼠标轨迹点击，否则跳过。点击后不轮询
   面板是否消失。
7. 文本链路不证明输入框焦点。它沿鼠标轨迹点击输入区中下部，重新前置微信，
   然后逐字发送同步 `WM_CHAR`（`SendMessageTimeoutW`，单字符 2 秒超时）到持有
   微信键盘焦点的窗口，字符间隔 4–12ms 随机抖动；代理对（非 BMP 字符）改发
   `SendInput` Unicode 事件，因为 Qt 编辑器会丢弃孤立的代理项；换行用真实
   `Shift+Enter`，之后等待 250ms 再继续，最后用 `Ctrl+Enter` 提交一次。
   实测（微信 4.2.0.13，`tools\verify-characters.ps1`）：ASCII、拉丁、符号、
   CJK（1500+ 字）、谚文、全角/半角假名逐字一致，emoji 与 CJK 扩展 B 也能
   正确输入；只有它自身不可显示或未分配的码位会被编辑器丢弃。
   `SendInput` Unicode（`VK_PACKET`）不能用于普通字符：它会把紧跟 `-`
   之后的字符替换成 `-`（`ai-2` 变成 `ai--`）。
8. 附件链路不做焦点证明：用发送按钮绿色像素启发式确认输入框为空（截图失败
   按空处理），以模块自建 message-only 窗口作为剪贴板所有者写入 `CF_HDROP`，
   `Ctrl+V` 后要求 10 秒内输入框出现内容才 `Ctrl+Enter`，并恢复原剪贴板。
   提交前失败会清空输入框；已注入 `Ctrl+Enter` 后绝不清理。自动化执行器
   单任务最多接收 10 个本机文件。
9. @ 成员：`SendInput` 注入 `@` → 等待 200ms → 要求新的 Qt 成员选择器窗口
   2 秒内出现、1.5 秒内尺寸稳定 200ms，否则失败 → 逐字 100ms 注入成员名中
   最长的不含空格片段，期间选择器关闭即失败 → 等待 200ms，确认选择器仍可见
   → 回车 → 等待 200ms → 等待选择器 1.5 秒内关闭（未关闭再回车一次并多等
   0.8 秒）→ 重新聚焦输入框并等待 200ms → 按 `mention_separator` 输入空格
   或 `Shift+Enter` → 写入正文。不回读最终成员身份；微信可能使用群昵称
   显示成员。超时或停止时各轮询循环立即退出。
10. 发送前持久化不可逆的 `delivery_attempted` 意图。仅搜索任务结束后保持
    微信窗口可见；文本和附件任务结束后尝试隐藏微信窗口。

自动化期间低级鼠标钩子拦截物理鼠标移动、滚轮和按键，允许带注入标记的
`SendInput` 事件通过；键盘保持可用。鼠标轨迹使用助推-滑翔曲线、随机中段
变轨、末段阻尼、过冲回拉和光标回位。超时或紧急停止会释放钩子并终止当前
任务；`Ctrl+Alt+Q` 同时请求退出程序。鼠标锁定失败时任务直接以
`ERROR_LOCK_FAILED` 失败，未发送。

`mention-debug.log` 只记录 @ 与附件流程的结构化诊断（耗时、窗口类名、
错误码），不记录昵称、目标或正文；与 `flow-debug.log` 一样超过 1 MiB 时
轮转为 `.1`，只保留一份旧文件。

## 队列与崩溃恢复

`queue.db` 与 EXE 位于同一目录，使用 SQLite 持久化：

- 启动时执行旧库兼容迁移。
- 未开始投递的 `running` 任务安全回到 `queued`。
- 已记录发送意图的 `running` 任务转为 `failed`，错误码
  `ERROR_PROCESS_ABORTED`（1067）。
- 旧库中缺少意图字段的历史 `running` 行保守视为已尝试，不自动重放。
- 非搜索任务成功完成前必须已有发送意图。
- `requeue` 只接受尚未记录发送意图的 `running` 任务，放回后保留原 ID 和
  创建时间，因此仍按原顺序优先领取。
- 微信不可用（未安装、启动失败、登录超时、等待登录时微信退出、状态未确认）
  时，当前未写意图的任务回队，队列暂停领取：30 秒起逐次翻倍，上限 5 分钟，
  界面显示“队列等待微信 · N 秒后重试”。“检查微信状态”按钮、`F5`、托盘
  检查或登录成功立即恢复；回队失败才判失败。
- 最多允许 200 条 `queued+running` 任务。
- 启动时和每条任务完成后都裁剪历史，任何时刻最多保留 50 条
  `succeeded/failed` 记录。
- 任务 ID（`api_id`）为随机 16 位小写十六进制。
- 主队列窗口显示 6 条，队列详情窗口最多读取 64 条。
- SQLite 使用默认日志模式，未启用 WAL；连接设置 `busy_timeout=3000ms`。
- 附件 spool 资源仍被任意任务引用时不会被清理；数据库未打开时一律不删。

队列行包含任务 ID、类型、来源、目标、正文、@、附件路径、状态、创建和完成
时间、内容验证标记、发送数量、错误码和发送意图标记。界面只展示关键状态
字段，不展示正文、@ 或附件路径明细。

## HTTP API

`/api/*` 要求：

```http
Authorization: Bearer <api-token.txt>
```

令牌按常量时间比较，同时拒绝带 `Origin` 的请求。Webhook 使用 URL 中的
同一令牌，不要求 Bearer，但也拒绝 `Origin`。除无请求体的 `/api/stop` 外，
`/api/*` 的 POST 使用 `Content-Type: application/json`，缺失或错误类型
返回 415；普通 JSON 请求体上限为 8192 字节，只按请求体计算，请求头另有
16 KiB 上限（超出返回 413 `headers too large`）。请求头含 NUL 字节返回
400 `invalid request headers`。

连接与超时：

- 最多 8 个工作线程并发处理连接，第 9 个连接直接返回 503 `server busy`；
  监听 backlog 为 16。
- 每个连接的请求头和 JSON 请求体共用 10 秒截止时间，超时返回 408
  `request timeout`。
- 资源上传的截止时间为 10 秒加上按 64 KiB/s 计算的 `Content-Length`
  传输时间（20 MiB 约 320 秒）。

API 错误体为 `{"message":"..."}`；Webhook 错误体为
`{"ok":false,"message":"..."}`。两类接口都会在鉴权、方法或参数错误时返回
对应的 4xx；队列满或停止期间收到的新 POST 返回 503。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/health` | 版本、API revision、端口、`service=supertime`、Webhook 标志 |
| GET | `/api/status` | 队列、鼠标保护、微信运行/登录/可见状态 |
| GET | `/api/jobs/{id}` | 查询单个任务（1–16 位十六进制 ID，不区分大小写） |
| POST | `/api/send-message` | 文本和可选 @ 入队 |
| POST | `/api/send-attachments` | 本机路径或资源 ID 入队 |
| POST | `/api/stop` | 释放输入锁、返回 202 并请求退出 |

Webhook：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/webhook/<token>` | 连通性和版本检查 |
| POST | `/webhook/<token>` | 消息或附件任务入队；Content-Type 可省略、`application/json` 或 `text/plain`，正文仍按 JSON 解析 |
| GET | `/webhook/<token>/jobs/{id}` | 查询任务 |
| POST | `/webhook/<token>/resources` | 上传附件到 spool |

入队成功统一返回 `202`。API 响应为
`{"id":"<job-id>","state":"queued"}`，Webhook 响应额外包含 `"ok":true`。
这只表示任务入队，不表示已发送。

JSON 解析规则（`/api/*` 与 Webhook 共用）：

- 格式错误返回 400 `invalid json`；`mention_newline` 不是 `true`/`false`
  同样按格式错误处理。
- 同一字段重复出现时取第一次出现的值；Webhook 别名按下文列出的顺序，
  正式字段名优先。
- 空字符串视为未传。
- 超长按字段返回 400：`target too long`（超过 127 个宽字符）、
  `message too long`（超过 511）、`mention too long`（超过 127）、
  `mention_separator too long`、`attachments too long`（拼接后超过 1023 个
  宽字符或数组超过 16 项）、`resource_ids too long`（数组超过 9 项）。

`/api/send-message` 字段：

- `target`：必填，最多 127 个宽字符。
- `message`：必填，最多 511 个宽字符。
- `mention`：可选，最多 127 个宽字符；简化链路会输入 `@`、成员名中最长的
  不含空格片段，并在成员选择器出现且稳定后回车选择高亮项。
- `mention_separator`：可选，`space`/`newline` 或 `空格`/`换行`。
- `mention_newline`：可选布尔别名。

Webhook 还接受目标别名 `to`、`session`、`chat`、`receiver`、`group`、
`room`，正文别名 `text`、`content`、`msg`，@ 别名 `at`、
`mention_name`，附件别名 `files`、`file`，`resources` 作为 `resource_ids`
的别名，以及可选的 `type`（`message`/`text` 或
`attachments`/`attachment`/`file`/`files`）。`/api/*` 只接受正式字段名和
`resources` 别名。

`/api/send-attachments` 与 Webhook 附件任务：

- `attachments` 为本机路径，可以是 `;` 分隔的字符串或字符串数组；
  `resource_ids`/`resources` 同样接受字符串或字符串数组。数组元素为空或含
  `;` 返回 400。API/Webhook 不强制绝对路径，执行时相对路径按 SuperLanguage
  进程工作目录解析；MCP 则强制要求 Windows 绝对路径或 UNC 路径。
- `resource_ids`/`resources` 为本机 API 上传后的资源，最多 9 项；资源不存在
  返回 404，暂存失败返回 500 `resource staging failed`。
- `attachments` 与资源 ID 字段互斥，二者必须提供其一。
- 本机路径按请求来源判断：来自 `127.0.0.1` 的连接允许，来自其他地址的连接
  返回 403，与绑定地址无关。
- 资源附件以原始文件名发送：入队时为每个资源建立
  `resource-spool\<id>\<原文件名>`（优先硬链接，失败则复制），队列中保存
  该路径。
- 自动化执行器最多处理 10 个本机文件；`attachments` 数组解析上限为 16，
  超过 10 项会在执行阶段失败。

**部署警告**：本机若有把请求转发到 `127.0.0.1` 的反向代理或隧道（nginx、
IIS ARR、frp、`ssh -R` 等），远程请求会被当作本机来源而允许本机路径，
可读取并发送任意本地文件。不要这样部署；必须时远程只用 `resource_ids`。

任务查询响应包含 `id`、`type`、`state`、`content_verified`、`sent_count`、
`mention_newline`、`error`、`delivery_attempted` 和
`delivery_uncertain`。Webhook 查询额外包含 `"ok":true`。

资源上传要求：

- `Content-Type: application/octet-stream`
- `Content-Length`
- `X-SuperTime-Filename`（UTF-8 文件名）
- `X-SuperTime-SHA256`（64 位十六进制）
- 单文件 1 字节至 20 MiB
- 文件名最长 120 个字符，拒绝控制字符、0x7F、`<>:"/\|?*`、结尾的点或空格，
  以及 Windows 保留设备名（`CON`、`PRN`、`AUX`、`NUL`、`COM0`–`COM9`、
  `LPT0`–`LPT9` 等，带扩展名也拒绝）
- 成功后返回 `201`、40 位十六进制资源 ID、经安全校验后的文件名、大小和
  SHA256

spool 清理在 API 启动和每次上传成功后执行：`<id>.bin` 超过 7 天且未被任何
任务引用时，连同 `<id>.json` 和 `<id>\` 目录一起删除；孤立的 `.json` 或
`<id>\` 目录超过 7 天也删除；数据库未打开时不删除。

## 监听、配置与运行数据

- `api-enabled.txt`：首个字节为 `1` 时启动 API；默认关闭。只有界面开关会
  改写它，API 启动失败不会把它改成 `0`。
- `api-listen.txt`：缺失/空/`lan`、`any`、`all`、`0.0.0.0`、`*` 为
  全部 IPv4（默认，局域网可访问）；`loopback`/`0`/`127.0.0.1` 只绑定
  `127.0.0.1`；也可填写指定本机 IPv4。非法或不可绑定地址回退到
  `127.0.0.1` 并记录日志。
- `api-token.txt`：32 位十六进制明文令牌；缺失或格式错误时启动 API 自动
  生成。主界面“刷新”轮换令牌，旧令牌立即失效。
- `api-port.txt`：运行时记录实际端口；API 正常停止时删除。
- 端口由系统自动分配（每次启动可能不同），运行时写入 `api-port.txt`。
- `send-timeout.txt`：可选，5–600 秒，默认 45 秒；启动时读取。
- `shortcut-tip.txt`：首次 `Ctrl+Enter` 提醒已确认标记。
- `queue.db`：明文目标、正文、@、附件路径和任务状态。
- `resource-spool\`：上传文件、元数据和按原文件名暂存的 `<id>\` 目录。
- `flow-debug.log`：运行日志镜像，含会话名称，Webhook 令牌已打码；超过
  1 MiB 轮转为 `flow-debug.log.1`。
- `mention-debug.log`：@/附件流程结构化诊断；超过 1 MiB 轮转为
  `mention-debug.log.1`。
- `instance.lock`：实例锁，进程运行期间独占打开。

修改 `api-listen.txt` 或 `send-timeout.txt` 后需要重启。API 默认关闭，
可在主界面开启；也可以在 API 开启时通过帮助窗口复制当前 Webhook 地址。

## 发送状态语义

- `queued` 只表示任务进入本地队列，不表示微信已收到。
- `delivery_attempted=true` 表示不可逆发送意图已经持久化。
- `delivery_uncertain=true` 表示发送动作可能发生但结果无法确认，调用方不得
  自动重发，必须人工检查目标会话。
- `AutomationOutcome` 只有 `NotAttempted`、`Failed` 和
  `InjectedUnverified`；文本和附件成功只会是 `InjectedUnverified`。附件链路
  在草稿非空时返回 `NotAttempted`，任务层记为失败。因此 `content_verified`
  恒为 `false`。只要非搜索任务已记录发送意图，即使状态为 `succeeded`，
  API 也会报告 `delivery_uncertain=true`。
- 搜索前因输入框已有内容被拒绝的任务尚未记录发送意图，状态为 `failed`、
  错误码 183、`delivery_uncertain=false`。
- 仅搜索任务不记录发送意图，成功时为 `succeeded` 且通常
  `delivery_uncertain=false`。
- 带 @ 的文本任务会执行完整输入链：`@`、成员名、回车选择、分隔符、正文和
  提交。由于不回读成员身份，选中项可能与输入别名不同；发送意图仍会先于
  实际注入持久化，因此成功状态仍可能伴随 `delivery_uncertain=true`。
- 连接中断、超时、5xx 或非 JSON 发送响应后的 MCP 结果按不确定处理。

## MCP

`mcp\supertime_mcp.py` 通过 JSON-RPC 2.0 stdio 暴露：

- `health`
- `status`
- `send_message`
- `send_attachments`
- `get_job`
- `wait_job`

支持协议 `2024-11-05`、`2025-03-26`、`2025-06-18`，未知版本回退到
`2025-06-18`。协商为 `2025-06-18` 时以及 `initialize` 之前，JSON-RPC 批量
请求返回 `-32600`；旧版本协议仍支持批量。`get_job`/`wait_job` 的参数名是
`job_id`；`wait_job` 默认等待 30 秒、最大 120 秒，每次 HTTP 查询的超时
不超过剩余等待时间（下限 1 秒）。

服务只调用本地 HTTP API，不直接操作微信，不提供任意 URL 代理、令牌读取、
资源上传工具或 `/api/stop` 工具。发送工具只代表任务入队；投递不确定时
结果包含禁止自动重发提示。环境变量只读取 `SUPERTIME_*`。

完整配置发现顺序、工具参数、完整 JSON-RPC 示例和错误映射见
`mcp\README.md`。

## 构建

依赖：

- Windows 10/11
- Visual Studio 2022 C++ x64 Build Tools
- Windows SDK（`rc.exe`）
- Python 3 用于隔离 API 回归测试；MCP 与 MCP 测试要求 Python 3.10+；
  图标缺失时也使用 Python 重新生成

```bat
build.bat /check
build.bat
build.bat /kill
build.bat /help
```

`build.bat` 在构建前检查本目录 `build\SuperLanguage.exe` 是否被运行或锁定；
`/kill` 只停止路径完全匹配的本目录进程，`/check` 只检查环境和依赖。
构建使用 MSVC C++17、静态 CRT `/MT`，并编译
`src\*.cpp`、`third_party\sqlite\sqlite3.c` 和资源文件；项目源码以 `/W4`
编译，SQLite amalgamation 以 `/w` 单独编译。

## 测试

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\verify.ps1
python .\mcp\test_supertime_mcp.py
```

`tests\verify.ps1` 会拒绝在已有 `SuperLanguage.exe` 运行时启动。它把 EXE 复制
到系统临时目录（`GetTempPath`，先 `TMP` 后 `TEMP`）下的
`supertime-tests\<run-id>`，在私有 Windows desktop 和单进程 Job Object 中
运行 10 个 API 用例，不启动微信，也不发出有效发送请求。随后编译并执行
原生队列状态测试。MCP 测试使用本地假 HTTP 服务，不启动 SuperLanguage，
也不发送微信消息。

2026-11-18 在当前源码上的实测结果：

- `build.bat` 完整编译链接：0 警告
- `tests\verify.ps1` 的 10 个 API/Webhook 用例：`10/10`，`/api/stop` 正常退出 `10/10`
- 原生队列断言：`94/94`
- MCP 离线测试：`28/28`

旧构建记录（不代表当前源码）：2026-11-12 API/Webhook/资源上传 `8/8`、
`/api/stop` 正常退出 `8/8`、原生队列断言 `61/61`、MCP 离线测试 `22/22`、
`build.bat /check` 通过；2026-11-14 原生队列断言 `66/66`。

真实微信登录、搜索命中、搜索面板关闭、文本/附件发送、@ 成员和紧急停止
均未在当前构建上人工验收，需要在受控账号和交互式桌面中进行。

## 已知风险

- API 令牌为明文；Webhook 令牌位于 URL 中，拿到完整 URL 即可提交任务。
- 界面、日志和帮助窗口只显示令牌首尾各 4 位，但“复制”得到的是完整令牌或
  URL；`flow-debug.log` 含会话名称。日志、截图和复制内容都属于敏感数据。
  MCP 错误结果不会包含令牌。
- API 默认监听所有 IPv4 网卡（局域网可访问），仅限可信网络；需要仅本机
  访问时把 `api-listen.txt` 写成 `loopback`。
- 本机路径按来源地址判断；本机的反向代理或隧道会让远程请求获得本机路径
  权限。
- 队列数据库保存明文目标、正文和附件路径，不得公开分发。
- 发布 EXE 未做代码签名。
- 微信侧没有送达回执，当前构建也不会产生内容验证成功状态。
- 当前发送链路不读取会话标题，不证明输入焦点；搜索后回车依赖微信选择
  第一个高亮结果，存在误发风险。空草稿检查只是发送按钮颜色的像素启发式，
  截图失败时按空处理，且会话复用路径上的文本任务不做该检查。
- @ 输入要求成员选择器出现并稳定，但不回读高亮项或最终成员身份；别名
  与群昵称可能不同，存在选错成员的风险。
- 相似会话、微信界面升级、窗口布局或配色变化都可能导致自动化失败或误发，
  只应在受控账号和已知会话中使用。
