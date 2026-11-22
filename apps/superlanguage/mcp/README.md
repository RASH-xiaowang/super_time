# SuperLanguage MCP Server

`supertime_mcp.py` 通过 stdio 向 AI agent 暴露 SuperLanguage 的本机 HTTP API。
实现只使用 Python 标准库，不依赖第三方包，不直接操作微信。
`send_message` 和 `send_attachments` 只是把任务加入 SuperLanguage 队列。

## 环境要求

- Windows（SuperLanguage 本身仅支持 Windows）
- Python 3.10 或更高版本；本机验证版本为 Python 3.12.10
- SuperLanguage API 已启用，且可以读取 `api-token.txt` / `api-port.txt`

## 快速启动

从仓库根目录运行：

```powershell
python .\mcp\supertime_mcp.py
```

这是一个 stdio MCP server，不会在终端打印提示符；应由 MCP 客户端启动并通过
stdin/stdout 通信。诊断日志只写 stderr，不会污染 JSON-RPC 输出。

`supertime_mcp.py` 是唯一的 MCP 入口，`test_supertime_mcp.py` 是离线测试入口。

## 配置发现

服务在**每次工具调用时**重新解析配置，因此 SuperLanguage 重启后变化
`api-port.txt`，或令牌轮换后更新 `api-token.txt`，不需要重启 MCP server。

只读取 `SUPERTIME_*` 环境变量；旧 `FEATHER_*` 名称不再识别：

- `SUPERTIME_API_URL`
- `SUPERTIME_API_HOST`
- `SUPERTIME_API_PORT`
- `SUPERTIME_API_PORT_FILE`
- `SUPERTIME_API_TOKEN`
- `SUPERTIME_API_TOKEN_FILE`
- `SUPERTIME_CONFIG_DIR`
- `SUPERTIME_HOME`
- `SUPERTIME_API_TIMEOUT_SECONDS`
- `SUPERTIME_MCP_LOG`
- `SUPERTIME_ALLOW_REMOTE_API`

### 端点

1. `SUPERTIME_API_URL`，例如 `http://127.0.0.1:17890`（程序端口由系统自动
   分配，未显式指定时应让它读取配置目录的 `api-port.txt`）。不允许 URL
   内嵌用户名/密码、查询参数或 fragment。
2. 否则使用 `SUPERTIME_API_HOST`（默认 `127.0.0.1`）和端口：
   - `SUPERTIME_API_PORT`
   - `SUPERTIME_API_PORT_FILE`
   - 配置目录中的 `api-port.txt`

配置目录按以下顺序搜索并自动去重：

1. `SUPERTIME_CONFIG_DIR`
2. `SUPERTIME_HOME`
3. `<仓库根>\build`
4. `<当前目录>\build`
5. `<仓库根>`
6. `<当前目录>`
7. `<MCP 目录>`
8. `<MCP 目录>\build`

相对路径的配置目录和显式文件路径按当前工作目录解析。服务不会猜测端口，
也不会尝试未配置的远端地址。

为避免把 Bearer 令牌发往错误主机，默认只接受 `localhost`、IPv4
`127.0.0.0/8` 或 IPv6 `::1`。确实需要连接受信远端时，必须同时设置
`SUPERTIME_ALLOW_REMOTE_API=1`；系统代理环境变量不会作用于该 HTTP 客户端。

### 令牌

1. `SUPERTIME_API_TOKEN`，必须是 32 位十六进制字符串。
2. `SUPERTIME_API_TOKEN_FILE` 指向的文件。
3. 上述配置目录中的 `api-token.txt`。

### 可选环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SUPERTIME_CONFIG_DIR` | 自动搜索 | 优先配置目录，通常指向 `build` |
| `SUPERTIME_HOME` | 自动搜索 | 与 `SUPERTIME_CONFIG_DIR` 同等参与目录搜索 |
| `SUPERTIME_API_TIMEOUT_SECONDS` | `15` | HTTP 超时，范围 0.1–300 秒 |
| `SUPERTIME_MCP_LOG` | `WARNING` | stderr 日志级别，如 `DEBUG`、`INFO` |
| `SUPERTIME_ALLOW_REMOTE_API` | 未设置 | 设为 `1` 才允许非回环 API 主机 |

当 SuperLanguage 未运行时通常没有 `build\api-port.txt`，可以设置
`SUPERTIME_API_PORT` 或 `SUPERTIME_API_URL`。

## MCP 客户端配置

通用 JSON 配置示例见
[`examples/mcp-config.example.json`](examples/mcp-config.example.json)。将
占位路径替换为本机绝对路径即可：

```json
{
  "mcpServers": {
    "supertime": {
      "command": "python",
      "args": [
        "C:\\path\\to\\repo\\mcp\\supertime_mcp.py"
      ],
      "env": {
        "SUPERTIME_CONFIG_DIR": "C:\\path\\to\\repo\\build"
      }
    }
  }
}
```

SuperLanguage 帮助窗口的 MCP 示例会依次查找
`<exe目录>\mcp\supertime_mcp.py` 与 `<exe目录>\..\mcp\supertime_mcp.py`，
并把 `SUPERTIME_CONFIG_DIR` 填为 EXE 所在目录，可直接复制使用。

也可以完全通过环境变量传入并运行只读示例客户端：

```powershell
$env:SUPERTIME_API_URL = "http://127.0.0.1:<api-port.txt 中的端口>"
$env:SUPERTIME_API_TOKEN = "<32-hex-token>"
python .\mcp\examples\stdio_client.py --health
```

`stdio_client.py` 只演示初始化、工具列表、ping 和只读 `health` 调用，
不会调用发送工具。

## 兼容协议

- `2024-11-05`
- `2025-03-26`
- `2025-06-18`

客户端请求其他版本时，服务回退到最新支持版本 `2025-06-18`。支持的方法：
`initialize`、`notifications/initialized`、`ping`、`tools/list`、
`tools/call`。stdio 使用每行一个 UTF-8 JSON-RPC 消息的格式。

JSON-RPC 批量请求只在协商为 `2024-11-05` 或 `2025-03-26` 后支持；协商为
`2025-06-18` 时以及 `initialize` 之前，批量请求返回 `-32600`。

## 工具

| 工具 | HTTP 调用 | 说明 |
|---|---|---|
| `health` | `GET /api/health` | 只读健康检查 |
| `status` | `GET /api/status` | 只读队列、鼠标保护、微信状态 |
| `send_message` | `POST /api/send-message` | 文本和可选 @ 入队 |
| `send_attachments` | `POST /api/send-attachments` | 本机路径或 resource IDs 入队 |
| `get_job` | `GET /api/jobs/{id}` | 只读查询任务 |
| `wait_job` | 周期性 `GET /api/jobs/{id}` | 等待任务结束，默认 30 秒、最大 120 秒 |

### 参数与限制

`send_message`：

- `target` 必填，最多 127 个 UTF-16 单元。
- `message` 必填，最多 511 个 UTF-16 单元。
- `mention` 可选，最多 127 个 UTF-16 单元。
- `mention_separator` 可选，`space` 或 `newline`。
- `mention_newline` 可选布尔值，是分隔符的别名。
- @ 成员由简化发送链路执行：输入 `@` → 等待 200ms → 要求成员选择器在
  2 秒内出现并稳定，否则任务失败 → 逐字 100ms 输入成员名中最长的不含空格
  片段 → 等待 200ms → 回车 → 等待 200ms，选择器关闭后按
  `mention_separator` 注入空格或换行。该流程不回读最终成员身份；微信可能用
  群昵称显示成员。发送意图仍可能使任务报告 `delivery_uncertain=true`。

`send_attachments`：

- `target` 必填。
- `attachments`、`resource_ids`、`resources` 三组字段互斥。
- 最多 9 项。`attachments` 必须是在 SuperLanguage 主机上解析的 Windows 绝对
  路径或 UNC 路径，路径中不能含 `;`；本机路径只在请求来自
  SuperLanguage 主机本机（`127.0.0.1`）时可用。
- `resource_ids`/`resources` 为 40 位小写十六进制 ID。
- MCP 把数组转换为 SuperLanguage API 使用的 `;` 分隔字符串。

`get_job` / `wait_job`：

- `job_id` 必填，为 1–16 位十六进制字符。
- `wait_job` 的 `timeout_seconds` 为 0–120，默认 30；0 表示只查询一次。
- `wait_job` 的 `poll_interval_seconds` 为 0.05–10，默认 1。
- `wait_job` 每次 HTTP 查询的超时不超过剩余等待时间（下限 1 秒），因此
  总耗时不会因单次请求而明显超出 `timeout_seconds`。

### JSON-RPC 请求示例

以下示例是完整的 `tools/call` 请求；`<任务ID>` 必须替换为发送工具返回的
真实 job ID。

发送文本：

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"send_message","arguments":{"target":"文件传输助手","message":"你好"}}}
```

查询任务：

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_job","arguments":{"job_id":"<任务ID>"}}}
```

等待任务：

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"wait_job","arguments":{"job_id":"<任务ID>","timeout_seconds":30}}}
```

### 工具 arguments 示例

以下对象只是 `tools/call.params.arguments`，需要再包一层完整 JSON-RPC
请求。`send_attachments` 的 resource ID 示例：

```json
{
  "target": "项目群",
  "resource_ids": [
    "0123456789abcdef0123456789abcdef01234567",
    "89abcdef0123456789abcdef0123456789abcdef"
  ]
}
```

本机路径示例：

```json
{
  "target": "项目群",
  "attachments": ["C:\\work\\report.pdf"]
}
```

## 发送安全语义

- `send_message` / `send_attachments` 返回 `state=queued` 只表示 SuperLanguage
  **已接收任务**，不表示微信消息已经送达。
- 正常入队结果中 `delivery_status` 为 `queued_not_delivered`，
  `delivery_confirmed=false`，`safe_to_retry=false`。
- 随后应调用 `get_job` 查询。返回的 `delivery_uncertain=true` 表示发送动作
  可能已发生但无法确认；此时必须读取微信会话并请用户确认，**不得自动重发**。
- 当前 SuperLanguage 构建的文本和附件发送不会产生内容验证成功状态；任务成功
  仍会带 `content_verified=false`，并在已记录发送意图时带
  `delivery_uncertain=true`。
- `wait_job` 会短轮询到 `succeeded`/`failed` 或 `delivery_uncertain`；超时只
  表示任务仍未结束，不代表发送失败，不能据此重复发送。SuperLanguage 在
  微信不可用时会把任务放回队列等待，任务可能长时间保持 `queued`。
- 发送请求若遇到超时、连接中断、非 JSON 响应或 HTTP 5xx，结果会标记
  `delivery_uncertain=true`，并返回明确的 `do_not_automatically_retry`
  策略。
- 参数校验失败、配置错误和明确返回的 4xx 错误不会标记为已发送；但自动
  重试仍不是默认行为，修正参数/配置后再显式调用。
- 本地会校验非空目标/正文、UTF-16 长度、不成对的代理字符、@ 分隔符冲突、
  附件互斥关系、resource ID 格式、任务 ID 格式，以及 SuperLanguage 的
  8192 字节请求体上限；请求体超限在解析端口/令牌配置之前就会报告。

发送工具的描述和结果包含防重复发送提示。MCP 客户端应把发送工具视为非幂等、
有外部副作用的操作。

## API 错误映射

工具不会把 HTTP 失败伪装成成功。`tools/call` 返回 `isError=true`，并在
`structuredContent.error` 中提供错误对象。例如 401：

```json
{
  "kind": "auth_error",
  "message": "SuperLanguage API HTTP 401: unauthorized",
  "http_status": 401,
  "delivery_uncertain": false,
  "safe_to_retry": true,
  "retryable": false,
  "hint": "Verify SUPERTIME_API_TOKEN or build/api-token.txt..."
}
```

常见 `kind`：

| kind | 含义 |
|---|---|
| `validation_error` | MCP 参数校验失败，未发出 HTTP 请求 |
| `config_error` | 端口/令牌/URL 无法解析，未发出 HTTP 请求 |
| `auth_error` / `permission_error` | 401 / 403 |
| `not_found` | 任务或接口不存在 |
| `method_not_allowed` | HTTP 405 |
| `rate_limited` | HTTP 429 |
| `invalid_request` | HTTP 400 |
| `service_unavailable` / `server_error` | SuperLanguage 5xx；发送时通常为未知状态 |
| `transport_error` | 连接失败或超时 |
| `invalid_response` | 2xx 但响应不是预期 JSON 对象 |
| `http_error` | 其他 HTTP 状态，包括 411/413/415 |
| `internal_error` | MCP 工具执行时出现未预期异常 |

错误信息不包含 API 令牌。

## 离线测试

测试使用本地假 SuperLanguage HTTP 服务，不启动真实 SuperLanguage，也不会发送
微信消息：

```powershell
python .\mcp\test_supertime_mcp.py
```

当前覆盖 28 个用例：初始化/协议版本、未知版本回退、`notifications/initialized`、
`tools/list`、`ping`、stdio 握手与工具调用、参数校验、配置发现、环境变量
覆盖文件、旧 `FEATHER_*` 环境变量被忽略、远端主机需显式授权、请求体超限
先于配置错误报告、批量请求按协议版本拒绝或支持、HTTP 路径与请求体转换、
`wait_job` 单次 HTTP 超时封顶、401/404/503 映射、传输错误、无效响应和
`delivery_uncertain` 防重发提示。2026-11-18 在当前源码上实测 `28/28` 通过。

## 风险与限制

- `api-token.txt` 是明文凭据；MCP 结果会隐藏令牌，但同一用户权限下的进程仍可
  读取配置文件。
- 默认拒绝非回环 API 主机，防止把令牌发往意外地址。只有显式设置
  `SUPERTIME_ALLOW_REMOTE_API=1` 才会连接远端，且令牌仍可能通过明文 HTTP 传输。
- `attachments` 表示 SuperLanguage 主机上的本机路径。MCP 与 SuperLanguage 不在同一台
  机器时应改用 `resource_ids`。
- 本实现不包含资源上传工具；需要附件时，请先通过 SuperLanguage 的 Webhook
  资源上传接口（`POST /webhook/<token>/resources`）获得 resource ID，或仅在
  本机调用时使用本机路径。
- SuperLanguage 的任务队列可能成功入队后执行失败；MCP 只能转述 SuperLanguage 的
  `delivery_uncertain` 状态，无法从微信侧独立证明消息是否送达。
