# 错误码与错误形状

这份文档回答三个问题：**错误长什么样传回来**、**有哪些机器码**、**用户/排障的人看到它该怎么办**。
不打算做成穷举 —— 查询层的中文错误串有 222 处（`grep -rnoE "error: '[^']{2,80}'" src/backend/wechat-data/src`），
穷举的表一定会烂；这里只收录**有代码含义的**（机器码）与**用户会撞上的**（家族 + 复现口径），
并给出重新取全量的命令。

## 1. 错误怎么传回来

```
@Remote 方法（后端包内）      →  { ok: false, error: '中文串' } 或直接 throw
worker → 主进程（backend-rpc）→  throw 被包成 msg.error.message，在主进程侧再 reject 成 Error
主进程 → 渲染层（ipc-wechat）  →  { ok: false, error: { message, code?, details? } }
渲染层（api-core）             →  throw new Error(r.error?.message ?? r.error?.code ?? 'remote call failed')
```

两条实际后果，排障时要记住：

- **`code` 在界面上多半看不见**：客户端优先取 `message`。所以"有 code 就够了"是不成立的 ——
  每个拒绝分支都必须同时给可读中文（`license-gate:smoke` 会断言这一点）。
- **worker 侧 throw 与 IPC 侧拒绝是两种形状**：前者到渲染层只是一个 Error 文本（无 code），
  后者带 `code`/`details`。看到"只有中文串、没有码"的错，说明它出自查询层而不是闸门。

## 2. 闸门与传输层的机器码

| 码 | 出处 | 触发条件 | 该怎么办 |
|---|---|---|---|
| `BACKEND_NOT_READY` | [`../src/backend/ipc-wechat.js`](../src/backend/ipc-wechat.js) | 后端 worker 还在启动/重启，等满 `BACKEND_CALL_READY_WAIT_MS` 仍没就绪（`details.state` 给当前状态、`message` 带上一次错误） | 稍后重试；持续出现看 `<userData>/wechat/logs/` 里的重启记录（`check:backend-restart` 覆盖"杀掉 worker 能自愈"） |
| `LICENSE_CHECK_FAILED` | 同上 | **授权校验自身抛错**（许可证 JSON 损坏、读盘失败、指纹采集异常）—— 一律拒绝而不是放行 | 让用户重新导入许可证；这条是 fail-closed，不是 bug |
| `LICENSE_REQUIRED` | [`../src/license/service.js`](../src/license/service.js) | 本机没有可用许可证 | 走激活流程（见 [`DEPLOYMENT.md`](DEPLOYMENT.md) 第 4 节） |
| `EXPIRED` / `DEVICE_MISMATCH` / `NOT_BEFORE` | [`../src/license/schema.js`](../src/license/schema.js) | 有效期外 / 设备指纹不符 / 尚未生效 | 重新签发对应设备与日期的许可证 |
| `BAD_SIGNATURE` / `INVALID_PAYLOAD` | [`../src/license/service.js`](../src/license/service.js) | 签名校验失败 / 载荷不合 schema | 许可证被改动过；重发一份 |
| `FEATURE_DENIED` | 同上 | 许可证的功能位不含这个方法所属功能（`details.feature` 说明是哪个） | 升级到含该功能的版本 |
| ~~`PRIVACY_BLOCKED`~~ | — | **已于 2026-09-30 随出网开关一起移除**：`wechat:llm-models` 不再做隐私拦截，因此不再产生这个码 | — |
| 调用超时 | [`../src/backend/backend-rpc.js`](../src/backend/backend-rpc.js) | 文本形如 `调用超时（60 秒未返回）：method`；窗口按方法分级 | 不是失败宣告：worker 仍在跑。要区分"慢"和"死"，看随后有没有 `Super Time 后端进程已退出` |
| worker 死亡 | 同上 | `Super Time 后端进程已退出 (code=N)`，在途请求一并摘除 | 主进程会重建；反复出现就抓 `logs/` 与退出码 |

## 3. 参数守卫的码（防的是"把活的对象递进 RPC"）

[`../src/backend/wechat-args-guard.js`](../src/backend/wechat-args-guard.js) 在 `wechat:call` 入口检查参数，
全部是拒绝而不是截断：

| 码 | 含义 |
|---|---|
| `ARGS_TYPE` | 参数里出现函数 / `Symbol` / 类实例（后端只接受 plain data） |
| `ARGS_NUMBER` | 非有限数值（`NaN` / `Infinity`）—— 静默进 SQL 会变成查不到，所以直接拒 |
| `ARGS_SIZE` | 单串超长、数组项过多、对象键过多、二进制过大、整包字符量过界 |
| `ARGS_COUNT` | 一次调用参数个数超上界 |
| `ARGS_DEPTH` | 嵌套超过层数上界 |
| `ARGS_CYCLE` | 循环引用 |
| `ARGS_SCHEMA` | 与该方法登记的生成 schema 不符；白名单内的方法在执行前硬拒，白名单外只记进 `info().argGuard.mismatched` |

## 4. 业务载荷里的 `code` 字段（不是错误通道）

有些方法用返回对象的 `code` 表达**结果分类**而非失败，渲染层按它出文案，例如知识库入库：
`duplicate`（该文件已在库里，按内容判定）与 `not-accepted`（扩展名不支持）。
判据在 [`../src/client/ui-wechat/src/client/pages/wechat-data/panels/kb-files.wiring.spec.ts`](../src/client/ui-wechat/src/client/pages/wechat-data/panels/kb-files.wiring.spec.ts) ——
新增这类码时要一起改判据，别让它变成"前端 switch 里有、后端永远不发"的分支。

## 5. 查询层常见的中文错误家族

按"用户看到什么"归类，每族给一处代表源文件；完整清单用第 6 节的命令现取。

| 家族 | 代表串（逐字） | 出处与含义 |
|---|---|---|
| 数据源没配好 | `未配置数据库目录，无法定位图片数据`、`未配置微信原始目录，无法离线解码` | 图片/语音链路的入口闸门：只配了解密目录、没配原始微信目录 ⇒ 只能读缓存，不能解 `.dat` |
| 找不到数据 | `未找到消息分库`、`未找到语音消息`、`语音库不存在 (media_0.db)`、`SessionTable 不存在`、`解密 session.db 不存在` | 分库缺失或版本形状不同；界面对应"该会话没有数据 / 语音不可用" |
| 密钥不对 | `解密校验失败（数据损坏或密码错误）`、`解密后无法识别图片格式 (可能是密钥错误)`、`AES key 长度不足 16 字节`、`V2 文件头不完整` | 内存扫描拿到的 key 不对或过期 ⇒ 让用户重启微信后重新取钥 |
| 图片不可渲染 | `hevc-unsupported`、`表情文件无法解码为浏览器可渲染格式`、`微信 CDN 返回的是加密流，但该动态没有 <enc key>，无法解密` | 不是失败而是"需要系统解码/原图取不到"；界面按占位处理，日志保留原因 |
| 图片取不到 | `这张图刚才取失败过，稍后会自动重试`、`表情链接不是 http(s)`、`文章或封面获取失败` | 后端图片代理的负缓存与协议/白名单限制（`http` 一律不取；主机不在腾讯系清单内一律拒），见 `PRIVACY.md` |
| 任务占用 | `已有解密任务进行中`、`已有模型下载任务进行中`、`该导出任务已结束` | 单实例任务的正常拒绝；UI 应显示"进行中"而不是错误 |
| 知识库 | `知识库标识无效`、`没有指定知识库`、`该文件已在当前库中（按内容判定）：`、`这个文件还没有可用的正文块（解析未成功或还在排队），无法摘要。` | `kbId` 必须是正整数；后者是"解析还没跑完"的正常中间态 |
| 模型 | `未知模型: `、`模型通道不可用`、`未找到 whisper.cpp 引擎: `、`转写结果为空` | 模型名没在目录里 / 引擎资产缺失 |

## 6. 重新取全量（不要抄这份文档）

```bash
# 后端查询层所有 error 字面量（含文件与行）
grep -rnoE "error: '[^']{2,80}'" src/backend/wechat-data/src | sort -t: -k1,1

# 全部机器码
grep -rhoE "code: '[A-Z_]+'" src/backend src/license main.js preload.js | sort -u
```

改动这两类东西时（新增码、改文案），把本文对应行改掉 —— 有一条判据保证**引用的文件都还存在**
（[`../src/backend/tests/docs-index.spec.ts`](../src/backend/tests/docs-index.spec.ts)），
但文案与码的语义仍需人核对。新增机器码请同时在这里登记：一个只出现在代码里、没有说明的码，
排障时等于没有。
