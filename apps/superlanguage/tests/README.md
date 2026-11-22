# SuperLanguage 隔离回归测试

使用 Windows PowerShell 运行 API、Webhook、资源上传和原生队列测试：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\verify.ps1
```

## 前置条件

- 已构建 `build\SuperLanguage.exe`。
- Python 3 位于 PATH 中，用于 API 测试驱动。
- Visual Studio 2022 C++ x64 Build Tools 可用，用于编译原生队列测试。
- 当前没有任何 `SuperLanguage.exe` 进程在运行。

测试运行器按设计拒绝在任何 `SuperLanguage.exe` 进程运行时启动，不区分进程
路径；它不会停止或干扰用户正在使用的实例。

## 隔离措施

每个 API 用例都会：

- 在系统临时目录（`GetTempPath`，先取 `TMP` 再取 `TEMP`）下的
  `supertime-tests\<run-id>` 中创建独立目录；
- 只复制 `build\SuperLanguage.exe`；
- 生成临时 API 令牌并写入隔离的 `api-token.txt`、`api-enabled.txt`、
  `api-listen.txt` 和 `shortcut-tip.txt`；
- 在私有 Windows desktop 上以 `--tray` 启动副本；
- 把进程放入最多允许一个活动进程的 Job Object，防止 SuperLanguage 启动微信；
- 只执行健康检查、被拒绝的 API 请求、独立资源上传和预置终态队列的只读
  查询，不发出有效发送请求。

注意：除 `loopback_listen_binds_127_only` 外，API 用例都写入
`api-listen.txt=lan`，使隔离实例在测试期间监听所有 IPv4 网卡。私有 desktop
和 Job Object 只隔离窗口与进程，不隔离网络。测试使用随机临时令牌，且不会
发出有效发送请求；但仍应避免在不信任的网络上运行该回归套件。

## API/Webhook 用例

当前共有 10 个用例：

1. `health_version_api6`
2. `failed_job_delivery_metadata_api_and_webhook`
3. `lan_api_local_path_403`
4. `lan_webhook_local_path_403`
5. `missing_resource_404`
6. `mutual_attachment_fields_400`
7. `bad_content_type_415`
8. `large_headers_small_body_not_413`
9. `loopback_listen_binds_127_only`
10. `resource_upload_201`

健康用例校验 `service=supertime`、版本 `1.0.0`、API revision `6`、
`webhook=true`，以及 `/api/health` 返回的端口与 `api-port.txt` 一致。

失败任务元数据用例预置的是混合终态队列，而不是单一失败队列：包含 2 条
`failed` 和 2 条 `succeeded`，并分别覆盖已尝试/未尝试、已验证/未验证。
测试同时核对 `/api/jobs/{id}` 与
`/webhook/<token>/jobs/{id}` 的 `state`、`content_verified`、
`delivery_attempted` 和 `delivery_uncertain`。

`lan_api_local_path_403` 用字符串和数组两种形式提交本机路径，
`lan_webhook_local_path_403` 用字符串形式提交，均期望 403 且队列为空。
服务端按请求来源判断本机路径（来自 `127.0.0.1` 的连接允许），所以这两个
用例改用本机第一个非回环 IPv4 地址连接；本机没有这类地址时跳过并记入
`summary.json` 的 `skipped_checks`。

`missing_resource_404` 用字符串和数组两种形式提交不存在的资源 ID，期望 404。

`large_headers_small_body_not_413` 分别向 `/api/send-attachments` 和
Webhook 发送超过 8192 字节的请求头和很小的请求体，验证 8192 字节限制只按
请求体计算：请求应进入字段校验并返回互斥字段的 400，而不是 413。

`loopback_listen_binds_127_only` 写入 `api-listen.txt=loopback`，确认
`127.0.0.1` 可访问，且本机所有非回环 IPv4 地址上的连接被拒绝；本机没有
非回环 IPv4 地址时该项检查记为跳过。

资源上传用例使用 `X-SuperTime-Filename` 和
`X-SuperTime-SHA256`，上传成功返回 `201`，spool 中生成 `.bin` 和 `.json`，
响应和元数据中的文件名、大小和 SHA256 一致。它还验证只带旧
`X-Feather-*` 头的上传返回 400 且不改变 spool。

每个用例结束时调用 `POST /api/stop`，验证返回 `202` 且隔离进程正常退出。
因此完整运行报告还会显示每个用例的停止接口结果。

## 原生队列测试

API 用例之后，运行器编译并执行 `tests\queue_state_test.cpp`，针对
`src\queue_store.cpp` 和临时 SQLite 数据库运行 94 条断言，覆盖：

- 新库打开与未尝试任务恢复；
- 任务 ID 为 16 位小写十六进制；
- 已完成任务不恢复；
- 重复发送意图被拒绝；
- 非搜索任务成功完成前必须具备发送意图；
- 搜索任务无需发送意图；
- 旧库迁移及历史 `running` 行的保守处理；
- 已尝试崩溃任务转为失败且不重放；
- 后续排队任务仍可正常领取；
- `requeue` 只接受未写意图的 `running` 任务，放回后可再次领取；排队中、
  已写意图或已完成的任务都不能放回；
- 启动时和运行期任务完成后的历史裁剪都只保留最近 50 条已完成任务。

`tests\build_queue_state_test.cmd` 先以 `/w` 单独编译 SQLite amalgamation，
再以 `/W4` 编译测试与 `queue_store.cpp`。该测试不启动 SuperLanguage，也不
访问微信。

## MCP 离线测试

MCP 测试独立运行，使用本地假 HTTP 服务：

```powershell
python .\mcp\test_supertime_mcp.py
```

共 28 个用例，覆盖初始化、协议版本、`notifications/initialized`、
`tools/list`、`ping`、参数校验、配置发现、旧 `FEATHER_*` 环境变量被忽略、
请求体超限先于配置错误报告、批量请求规则、`wait_job` 单次 HTTP 超时封顶、
HTTP 路径和请求体、401/404/503 映射、传输错误、无效响应和
`delivery_uncertain` 防重发提示。测试不启动 SuperLanguage，也不发送微信消息。

## 结果与清理

成功运行时，临时运行目录会被删除。失败运行会保留各用例日志和
`summary.json`，打印保留路径并返回非零退出码。

2026-11-18 在当前源码上的实测结果：

- 原生队列断言：`94/94`
- MCP 离线测试：`28/28`
- `build.bat` 完整编译链接：0 警告
- API/Webhook/资源上传 10 个用例：`10/10`，每个用例的 `/api/stop` 均正常退出

旧构建记录（不代表当前源码）：2026-11-12 API/Webhook/资源上传 `8/8`、
`/api/stop` 正常退出 `8/8`、原生队列断言 `61/61`、MCP 离线测试 `22/22`；
2026-11-14 原生队列断言 `66/66`。

真实微信登录、搜索、搜索面板关闭、文本/附件发送、@ 成员、超时和紧急停止
均未在当前构建上人工验收，需要在受控账号和交互式桌面上进行。
