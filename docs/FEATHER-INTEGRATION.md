# Feather（“大肥鱼”）发送端接入

> 适用版本：Super Time 1.1.0，Feather 1.6.4  
> 核对日期：2026-10-29  
> 本文说明发送端能力、局域网部署、Super Time 的接入边界、跨机附件流程与验收方法。

## 1. 调研结论

“Feather”是纯 Win32 的 Windows 微信本地自动化发送程序，部署目录常以“轻羽”界面
出现，社区里也会用“大肥鱼”称呼同类 AI 微信桥接方案。它不是 Super Time 内置插件。
公开网络上被称作“大肥鱼”的 `doyokol/dsh-wechat-bridge` 是一个新兴、小众项目：
公开仓库核对时为 0 star / 0 fork，且“大肥鱼”只是默认唤醒词，不是项目名；其公开代码
使用 `/send/text`，没有 Feather 的 `/webhook/<token>` 协议。公开仓库也未提供可直接
复现安装所需的 Hook 产物和指定微信版本，因此不能把它当作 Feather 的官方安装包。

本机实际集成对象是 `C:\Users\Administrator\Desktop\wechat` 下的 Feather 1.6.4。
它负责把任务写入 SQLite 队列，再操作已登录的微信 PC 客户端完成发送；**不负责调用模型、
分析会话或生成回复**。AI 分析由 Super Time 当前 DSH 对话模型完成，Feather 只接收一条
已经落库并经隐私闸处理的消息。

因此本项目采用“职责分离”：

1. Super Time 读取当前单聊上下文并生成回复。
2. Super Time 先把回复写入「消息列表」，取得稳定的消息记录。
3. 消息列表投递器读取该记录，将正文或附件发送给 Feather Webhook。
4. Feather 返回 `202 queued` 后由发送端队列异步执行，消息列表记为 `queued`。
5. 页面会对带 `jobId` 的 `queued/running` 记录做有界自动查询；也可手动“查任务”。
6. `running` 表示发送端正在执行；只有 `succeeded` 才回写 `success`，失败终态回写
   `failed` 并保留脱敏原因。
7. HTTP 2xx 或 `queued/running` **都不表示微信已送达**。

## 2. Feather 安装与配置

Feather 必须与已登录的微信 PC 客户端运行在同一台 Windows x64 电脑上。部署时保留
`Feather.exe` 同目录下的运行文件，不要只复制 exe：

| 文件 | 作用 | 建议 |
|---|---|---|
| `api-enabled.txt` | HTTP API 与 Webhook 总开关 | 写入 `1` |
| `api-port.txt` | 固定监听端口 | 写入 `17890` |
| `api-token.txt` | 32 位十六进制 Webhook 路径令牌 | 随机生成，按凭据保管 |
| `api-listen.txt` | 监听地址模式 | 跨机部署写入 `lan`，仅本机写入 `127.0.0.1` |
| `queue.db` | 发送队列 | 不要删除或跨机器复制 |
| 日志与其它运行文件 | 排障 | 保留，不要用旧版本覆盖 |

跨机时，Feather 所在电脑应使用固定局域网 IPv4，或在路由器上配置 DHCP 地址保留。
Windows 防火墙需允许该程序在专用网络监听 TCP 17890。示例地址如下：

```text
http://192.168.1.4:17890/webhook/<token>
```

这里的路径令牌就是 Webhook 凭据。不要把它发到公共聊天、日志或截图里；轮换
`api-token.txt` 后，旧地址立即失效。

部署前先做只读连通性检查：

```powershell
Invoke-RestMethod -Method Get -Uri 'http://192.168.1.4:17890/webhook/<token>'
```

期望返回包含 `ok: true`、`service: feather` 与版本字段的 JSON。该 GET 不会发送微信消息。

## 3. Webhook 协议

### 3.1 发正文

```http
POST /webhook/<token>
Content-Type: application/json
```

```json
{"target":"Y.M","message":"上班！！！"}
```

群聊中 `target` 是群名，`mention` 是要 @ 的成员：

```json
{"target":"项目群","message":"请确认","mention":"Y.M"}
```

### 3.2 上传附件资源

正文和附件必须拆成两个任务。附件先逐件上传：

```http
POST /webhook/<token>/resources
Content-Type: application/octet-stream
X-Feather-Filename: report.pdf
X-Feather-SHA256: <原始字节的 SHA-256>
```

请求体是文件原始字节。成功响应返回 40 位十六进制资源 id、文件名、大小与 SHA-256。
单件上限 20 MB，整组附件总量同样 ≤20 MB（最多 9 件）；上传失败时整条附件记录失败，
不静默丢件。

`/webhook/<token>/resources` 只是附件上传子路径，不是发送消息的 Webhook。消息列表
规则必须填写基础发送地址 `/webhook/<token>`；保存规则时会拒绝资源端点，旧记录若已有
该地址快照，dispatch 会在任何出网请求前失败并记录 `failed`。

### 3.3 触发附件任务

```json
{
  "target": "Y.M",
  "type": "attachments",
  "resource_ids": ["0123456789abcdef0123456789abcdef01234567"]
}
```

单任务最多 9 件附件，且单件与整组总量均 ≤20 MB。`resource_ids` 是 Feather 自己那台电脑的 spool 引用；Super Time
所在电脑的绝对路径对它没有意义，禁止把 `C:\...` 或 UNC 路径交给发送端。

### 3.4 查询任务

```http
GET /webhook/<token>/jobs/<job-id>
```

`POST` 正常返回 `202 {"ok":true,"id":"<16hex>","state":"queued"}`。后续状态为
`queued`、`running`、`succeeded` 或 `failed` 之一；`succeeded` 表示发送动作执行完毕，
仍不等于微信对方已读或服务端确认送达。

## 4. Super Time 中的配置

在「消息列表」新建或编辑一条规则：

| 字段 | 建议值 |
|---|---|
| 会话名 | 与聊天窗口显示名一致，例如 `小王` |
| 触发对象 | 单聊填联系人名；群聊可填要 @ 的成员 |
| Webhook | 完整的 Feather `/webhook/<token>` 地址 |
| 问候语 | 触发任务首次命中时写入消息列表的正文 |

规则匹配顺序是“精确会话 + 对象 → 同会话任意对象 → 任意会话指定对象 → 全局规则”。
每条消息记录保存当时的 Webhook 快照；之后改规则不会悄悄改变旧记录的目的地。
规则里的 Webhook 只能是 Feather 基础发送地址 `/webhook/<token>`；附件资源端点
`/webhook/<token>/resources` 会被拒绝保存，不能当作发送规则目标。

在聊天窗口**顶部**的「AI回复」按钮（紧跟「AI 问答」右边，纯图标）打开会话级开关。
它是**默认关闭**的无人值守出网开关，仅对当前账号、当前会话生效，**单聊与群聊都可开启**。
群聊里只有**结构化 `atuserlist` 点名了本机账号**的消息（即「@我」）才会触发，
`@所有人` 不算，其它群消息只作为上下文、既不触发也不会让在飞的一轮失效。
群聊的回复会 **@ 回提问者**：消息列表记录把群名放在 `chatName`（发送目的地）、
把那条 @我 消息的发送者放在 `targetName`，投递成
`{"target":"群名","message":"…","mention":"提问者昵称"}`。只有 `@我` 那条消息的
发送者会被 @，群里其它人不会被带上。**同一条回复被拆成多条时只有首条带
`mention`**：后续段落是群里自然的接话，不再重复点名同一个人（这是有意的：
3 段回复对同一个人 @ 3 次在群里就是刷屏）。
首次开启只建立消息水位，不会把历史消息全部回复一遍。

旁边紧邻的「AI回复设置」按钮（齿轮图标，**只在已开启时出现**）打开同一个弹窗，
还可以保存当前账号、当前会话的 **默认大肥鱼 Webhook**。
完整地址只写入本机任务库，界面只回显 `http://<host>:<port>/webhook/***` 形式的脱敏
端点；只接受 Feather 的 `/webhook/<token>` 路径。
更换 token 时重新输入完整地址即可，留空或保留 `***` 不会覆盖旧凭据。

启用 AI 回复或保存默认 Webhook 时，系统会自动应用该地址：

- 自动规则额外绑定账号与会话 username（单聊与群聊都支持），只创建当前账号缺失的精确
  「会话名 + 触发对象」规则；
- 已有手工规则优先，默认地址绝不覆盖人工配置；
- 系统自动规则会跟随默认地址更新；同名会话在另一个微信账号下会创建独立规则，
  不会串用 Webhook；
- 已有规则若可用，会用它回填当前账号、当前会话中尚未写入地址的 AI `pending`
  记录；生成中的空正文预约不会被回填，也不会进入自动投递批次；
- 已有正文但没有可用的 Webhook 时不会反复记录失败，消息列表显示「待配置」，AI 状态
  进入 `waiting_config`；空正文预约不会进入这个状态，而按恢复逻辑继续生成或失败收口。
  规则补齐后沿用原记录继续投递，不重新调用模型。

同一动作带里的「AI回复设置」（齿轮图标，开启后才出现）用于配置当前会话的人格名称、回复风格和长回复分段。
人格只追加角色、称呼、语气和措辞偏好，固定防注入规则与输出格式始终优先。默认开启
「长回复自动分段」：模型只调用一次并生成完整正文，落库前按空行、句末标点和安全硬切
拆成多条消息，每段默认最多 25 个 UTF-16 单元，段尾自动去掉逗号、句号、分号等，只保留
问号或感叹号；关闭后仍只写一条，并按发送端 511 UTF-16 上限安全截断。修改人格或分段
设置会推进 revision 并取消尚未完成的旧任务，只影响之后新触发的消息。

## 5. AI 回复主流程

<!-- feather-facts:begin -->
<!-- 由 `node scripts/check-feather-facts.js` 生成；请勿手改，运行该脚本可重新生成。 -->
| 常量 | 源码值 | 含义 | 来源 |
|---|---|---|---|
| `CHAT_AI_REPLY_COALESCE_QUIET_MS` | `900`（900 ms） | 连续消息合并的静默窗口 | `src/backend/wechat-data/src/query/ai-reply/runner-coalesce.ts` |
| `CHAT_AI_REPLY_LEASE_MS` | `60_000`（60,000 ms / 1 分钟） | 会话执行租约 | `src/backend/wechat-data/src/query/ai-reply/lease-store.ts` |
| `INTERRUPTED_DISPATCH_STALE_MS` | `5 * 60_000`（300,000 ms / 5 分钟） | `dispatching` 崩溃恢复阈值 | `src/backend/wechat-data/src/query/message-list-store-shared.ts` |
<!-- feather-facts:end -->

后台扫描由微信实时同步事件与 10 秒兜底触发，不要求聊天页一直打开。主流程的顺序是
**先生成 sourceRef、再落空正文预约、再调用模型、再补全正文、最后才逐段认领投递**：

```text
新入站对话消息（文字 / 引用 / 图片 / 表情 / 语音 / 视频 / 文件 / 链接 / 卡片等）
  → 检查当前账号 + 当前单聊的 AI 回复开关
  → 同一轮只选最新一条对方消息作为锚点（连续消息合并为一次回复）
  → 生成 sourceRef：ai-reply:<账号>:<会话>:<createTime>:<localId>（此时还没有正文）
  → 先落一条空正文 pending 预约：source=ai_reply、note=AI 回复 · 生成中、不保存 Webhook 地址
  → 读取该单聊最近上下文（最多 60 条 / 约 6,000 token；「AI回复设置」里的上下文时间窗
    可进一步收窄到最近 1 小时～7 天，默认不限，窗口起点以触发消息时间为准；
    语音先在本机转写为文字，图片与自定义表情按需解码）
  → ai_reply_analyze 隐私闸
  → 当前 DSH 对话模型只生成一次完整正文
  → 按语义规划分段；后续段 sourceRef 追加 :segment:<N>
  → 在同一事务补全整组正文（首段预约 + 后续分段，source=ai_reply）
  → 逐段原子认领 pending → dispatching，并从首段开始匹配规则、投递 Feather
       ├─ 只有已有正文的记录才能被认领；空正文预约永远不进入投递
       ├─ 前段 queued/running → 等待终态，绝不越过发送后段
       ├─ 前段 succeeded → 才进入下一段
       ├─ 任一段失败/不确定 → 停止并收口后续 pending 段
       ├─ 有可用地址 → POST 202 → queued（或 running）
       ├─ 查任务 succeeded → success；failed/cancelled/expired → failed
       ├─ 网络结果不确定 → sent_unconfirmed
       └─ 已有正文但无可用地址 → 保持 pending + waiting_config，等待配置
  → 全程保存 job id / job state / 最近查询时间
```

触发与理解边界：

- 文本、引用、图片、自定义表情、语音、视频、文件、链接、小程序、视频号、直播、音乐、
  商品、名片、位置、笔记、群公告、接龙、聊天记录、转账、红包、通话等入站消息均可触发。
- 系统消息、撤回、空消息、未知/不支持类型和拍一拍不会触发，也不会进入自动回复上下文。
- 图片与自定义表情会把实际视觉字节交给支持多模态的模型；**语音消息先用本机 whisper 转成
  文字再进上下文**（每轮最多 5 条、总预算约 45 秒，超预算或转写失败的保留 `[语音 …]`
  占位，转写不联网），视频只提供 `[视频 时长]` 这类占位与标题，不做视频抽帧。
- 上下文里每条消息都带自己的本地时间前缀；卡片类补上转账金额、红包金额与祝福语、引用的
  被引用原文与发言人、通话类型与结局、位置地址。界面气泡文案不变，只影响发给模型的文本。
- 表情先读本机解密缓存，未命中时再按消息内微信 CDN 地址兜底；单张解码失败只跳过视觉
  内容，仍用文字上下文生成回复。

关键不变量：

- **预约先行、先落库后出网**：生成 `sourceRef` 后、调用模型前，先落一条空正文
  `pending` 预约（`source=ai_reply`，备注「AI 回复 · 生成中」，不保存 Webhook 地址）；
  模型结果必须在同一事务补全整组正文后才允许投递。投递器只读取已有正文的消息记录，
  空正文预约永远不会出网。
- **待配置不是失败**：没有 Webhook 时保留原 pending 记录和 pendingCursor，只把会话
  状态标记为 `waiting_config`；这个状态只在记录**已有正文、仅缺发送地址**时出现，
  空正文预约不能被描述成「待配置」。同一原因重复扫描静默，配置完成后从原记录继续
  投递，不重新调用模型。
- **默认规则只补缺**：自动绑定只创建缺失的精确规则，不回写或覆盖已有手工规则。
- **同消息幂等**：基础 `sourceRef` 唯一约束防止同一入站消息重复生成；分段使用
  `:segment:<N>` 派生唯一键，重启后从首个未完成段继续，不重发已成功段。重复触发命中
  同一 `sourceRef` 时返回 `created=false`：已有正文的 pending 可继续补投；空白预约若
  没有对应的生成快照，无法证明模型是否已执行，必须 fail-closed（不重新生成、不投递），
  交由人工重新触发。
- **一次生成、多段落库**：长回复只调用一次模型；整组分段要么在同一事务完整写入，
  要么全部回滚，不会留下无法判定顺序的半成品。关闭分段时仍只写一条并安全截断到 511。
- **跨进程单跑**：`chat_ai_reply_settings` 以 owner + lease + fence 原子认领会话执行权；
  活动租约期间其他 runner 不会重复生成，租约过期被接管后旧 owner 的晚到结果也不能回写。
- **设置写入原子化**：开关保存使用 `BEGIN IMMEDIATE` 做 revision CAS，旧 revision 不能
  覆盖新设置；失败 pending 的收口、revision 推进和租约撤销在同一次事务内完成。
- **积压合并、不补答旧问题**：扫描游标之后即使积压多批，也只以最新一条对方消息为
  锚点生成一次回复，前面的同轮消息只作为上下文；若最新可视消息是自己（人工回复或
  上一条 AI 回复），不会再次自动回复。恢复时若会话已出现更新的可视消息，旧 pending
  只收口、不生成也不投递；pending 锚点仍按 `localId` 精确回读，不依赖“最近 80 条”窗口。
- **水位与终态都不猜测**：首次开启以最近一条合法消息建立水位，即使最近 80 条没有
  对方消息也不会退化为 `0:0`；生成前、投递前复核失败时保留 pending。若下游返回成功
  但台账仍是 `pending`，转为 `sent_unconfirmed` 等待人工核对，禁止自动批次重发。
- **锁冲突不是租约丢失**：带 owner + fence 的状态写入遇到 `SQLITE_BUSY` / `SQLITE_LOCKED`
  会短暂退避重试；只有实际 owner / fence / revision 不匹配才判定旧 runner 失效。
- **有正文才投递**：投递条件不是 `created=true`，而是记录已有正文且仍是可认领的
  `pending`。`created=false` 的空白预约没有生成快照时 fail-closed；已有正文的 pending
  （包括进程在预约和投递之间退出后的恢复）可以继续补投，不会重新调用模型。
- **分段严格串行**：AI 分组按 `segment_index` 顺序逐段认领；前段未到终态时不发送后段，
  任一段失败后只收口后续 pending 段，已成功段保持成功。
- **原子认领**：`pending → dispatching` 使用条件更新，后台批次、AI 即时投递与人工重发
  不能同时发送同一条记录。
- **崩溃恢复有超时窗**：启动或周期批次默认只把超过 5 分钟仍未完成的 `dispatching`
  收口为 `sent_unconfirmed`；记录同时保存投递认领进程（owner），owner 进程已退出时
  可立即判定为中断并收口，不必等满窗口，同时不会误伤另一个仍存活进程正在进行的
  HTTP 投递。
- **不自动重试 POST**：下游会真实操作微信，HTTP 失败交由消息列表显式重发；避免自动重试
  造成重复消息。
- **202 不等于成功**：`queued/running` 只能说明下游已受理/执行中；消息列表不会把它们
  计入成功，也不会允许批次重发或删除。
- **任务终态回源**：任务查询到 `succeeded` 才记成功；`failed/cancelled/expired` 同步为
  可重试失败。未知状态只保存原文，不猜测结果。页面只对窗口内最多 10 条带 job id 的
  活动任务做 12 秒兜底查询，单条失败不阻断其它任务。
- **结果未知就停止自动重发**：已收到 2xx 但本地回写失败时标记 `sent_unconfirmed`，
  必须人工核对。
- **失败不自动回放**：当前采用 at-most-once，模型失败或投递失败不会在下一拍自动重复生成。
  `sent_unconfirmed` 表示“远端可能已受理、本地无法确认”，只能人工核对后单条重发或删除。

## 6. 跨机附件与图片

Super Time 与 Feather 分属两台电脑，不能共享本地文件路径。附件采用两层受控 spool：

```text
桌面端选择文件
  → Super Time 复制到 <数据根>\message-list-spool\<40hex>.bin
  → 消息记录只保存 stagedId / 展示名 / size / mime
  → 投递时按 stagedId 读取本机字节
  → POST Feather /webhook/<token>/resources
  → 换取 Feather 侧 40hex resource_id
  → POST {target,type:"attachments",resource_ids}
```

本机 spool 的安全边界：

- `stageMessageListAttachment` 只允许桌面端调用，HTTP 远程策略中属于 `LOCAL_ONLY`。
- 文件名由服务端随机生成；原文件名只作展示，不能参与路径拼接。
- 单件与整组附件总量均 ≤20 MB，单任务最多 9 件；只接受普通文件，不接受目录。
- 消息记录不保存源文件绝对路径，避免泄露用户名和目录结构。
- Webhook 入站明确禁止提交 `stagedId`，防止外部请求借记录引用桌面端文件。
- Webhook 入站的 `http(s)` 附件 URL 另做 SSRF 校验：字面地址、DNS 解析结果以及每次
  重定向目标都必须拒绝 loopback、私网、链路本地和云元数据地址；重定向逐跳手动校验，
  生产路径没有跳过校验的旁路。
- 本机暂存文件保留 7 天；只有没有被任何消息记录引用的过期文件才会清理。

上述 SSRF 限制只约束入站附件 URL 的取回，不约束你配置的出站 Feather / 消息列表
Webhook 目标地址；后者仍可以是明确的局域网地址。

Feather 侧资源同样默认保留 7 天，只清理未被任务引用的文件；超时上传的孤立资源
不会永久堆积。磁盘配额和备份仍由部署方负责。

正文和附件不能混在同一个 Feather 任务里。Super Time 在出网前会明确失败并提示拆成
两条消息列表记录：一条只有正文，另一条只有附件。

## 7. 隐私与凭据边界

- Webhook 完整地址只存在本机任务库；普通 Remote 返回值会脱敏查询串和路径令牌。
- `stageMessageListAttachment`、AI 开关、重发、健康检查和任务查询均为桌面端能力。
- 模型请求发送固定 system 安全边界、当前会话可配置人格和裁剪后的上下文（每条带本地时间
  前缀，语音已在本机转写为文字，卡片类带金额/结局/地址等细节）；人格不能覆盖安全规则，
  且与上下文一起经过隐私闸。不发送其它会话、通讯录、朋友圈或数据库文件。
- Feather 请求不携带模型提示词、本机路径或其它会话；附件只通过一次性资源 id 传递。
- 隐私声明记录了无人值守模型调用、会话图片识别、跨机资源出网点与暂存目录。逐条口径见
  [PRIVACY.md](PRIVACY.md) 第四节 G4 / G5。

## 8. 改动范围与代码地图

| 层 | 文件 | 职责 |
|---|---|---|
| UI | `src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-head-actions.tsx` | 「更多」菜单装配与人格弹窗宿主 |
| UI 菜单 | `src/client/ui-wechat/src/client/pages/wechat-data/panels/chat-ai-reply-menu.tsx` | AI 回复开关、设置入口、立即检查动作组 |
| UI 人格 | `src/client/ui-wechat/src/client/pages/wechat-data/panels/chat-ai-reply-settings-dialog.tsx` | 会话级人格、回复风格与长回复分段策略编辑 |
| UI Webhook | `src/client/ui-wechat/src/client/pages/wechat-data/panels/chat-ai-reply-settings-dialog.tsx` | 默认大肥鱼 Webhook 的脱敏读取与保存 |
| UI 状态 | `src/client/ui-wechat/src/client/pages/wechat-data/panels/use-chat-ai-reply.ts` | 会话切换竞态防护、开关与扫描编排 |
| UI 人格动作 | `src/client/ui-wechat/src/client/pages/wechat-data/panels/chat-ai-reply-persona-action.ts` | revision、会话身份与异步回写校验 |
| UI 附件 | `src/client/ui-wechat/src/client/pages/wechat-data/panels/use-message-list-actions.ts` | 桌面选文件、暂存、最多 9 件 |
| Remote | `src/backend/wechat-data/src/gateway-chat-ai-reply.ts` | 状态、开关、人格、诊断扫描 |
| 编排 | `src/backend/wechat-data/src/remotes/chat-ai-reply.ts` | 当前账号、当前单聊、消息列表接线 |
| 执行器 | `src/backend/wechat-data/src/query/ai-reply/runner.ts` | 水位、单飞、幂等、先落库后投递 |
| 默认 Webhook | `src/backend/wechat-data/src/query/ai-reply/default-webhook-store.ts` | 按账号/会话保管默认地址、补缺规则、回填 pending |
| 上下文 | `src/backend/wechat-data/src/query/ai-reply/context.ts`（语音转写接入、视觉预算）· `src/backend/wechat-data/src/query/ai-reply/context-budget.ts`（每条消息的时间前缀与 token 预算） | 会话预算、提示词、输出清洗 |
| 人格 | `src/backend/wechat-data/src/query/ai-reply/persona.ts` | 固定安全边界、人格归一化与 system 拼装 |
| 模型 | `src/backend/wechat-data/src/query/ai-reply/generator.ts` | DSH 当前对话模型 |
| 资源 | `src/backend/wechat-data/src/query/ai-reply/feather-resources.ts` | 资源上传、SHA-256 校验、resource_ids |
| 暂存 | `src/backend/wechat-data/src/query/message-list-attachments.ts` | 本机受控 spool、7 天清理 |
| 台账 | `src/backend/wechat-data/src/query/message-list-store.ts` | 消息记录、规则、原子认领、脱敏快照 |
| 投递 | `src/backend/wechat-data/src/query/message-list-dispatch.ts` | Feather 请求体、任务查询、状态回写 |

## 9. 验证与排障

先运行不触碰真实微信的测试与构建：

```powershell
npx vitest run src/backend/wechat-data/tests/message-list.spec.ts src/backend/wechat-data/tests/chat-ai-reply.spec.ts
npx vitest run src/backend/wechat-data/tests/chat-ai-reply-default-webhook.spec.ts src/backend/wechat-data/tests/chat-ai-reply-waiting-config.spec.ts
npm run typecheck:server
npm run typecheck:client
npm run build:types
npm run docs:api:check
```

线上联调必须按以下顺序，且每一步都要确认不会误发给真实联系人：

1. GET 健康检查，确认服务名和版本。
2. 用「文件传输助手」或内部测试号做一条文本投递。
3. 等消息列表先出现 `queued/running`，再用 job id 查询；终态后应变为
   `success` 或 `failed`。
4. 单独上传一个不超过 20 MB、且满足整组预算的内部测试附件，再触发附件任务。
5. 最后才在测试单聊开启 AI 回复，并观察消息列表记录与 Feather 队列。

常见问题：

| 现象 | 原因 | 处理 |
|---|---|---|
| 连接超时 | 不在同一局域网、IP 变了或防火墙拦截 | 在 Feather 电脑用 `ipconfig` 确认 IPv4；检查 17890/TCP |
| 401 / 403 | 路径令牌错误、轮换了令牌、请求带 Origin | 使用最新完整 Webhook 地址；服务端调用不要带浏览器 Origin |
| 202 但微信无消息 | 只是入队/执行中，并非已发送 | 看消息列表是否 `queued/running`；查 job 的 `state` 与 `error`，终态会回写台账 |
| 附件任务 404 | 资源已过期或不属于该令牌 | 重新暂存并上传，不要复用旧 resource_id |
| 正文与附件一起失败 | Feather 单任务不支持混发 | 拆成两条消息列表记录 |
| AI 回复记录显示「待配置」 | 记录已有正文，但当前会话没有默认 Webhook，且没有可用规则 | 在该会话顶部的「AI回复设置」里保存默认 Webhook；系统会回填原 pending 记录并自动继续（空正文预约不会显示为待配置） |
| 记录停在 `sent_unconfirmed` | 下游已接受但本地回写失败 | 先查 job 与微信，禁止盲目重发 |

## 10. 当前边界

Feather 发送链路保持“AI 生成 → 消息列表 → dispatch → Feather”。发送事实以
`message_list_records` 台账为准；网络结果未知或本地回写失败时收口为
`sent_unconfirmed`，人工核对后才能显式重发。启动恢复默认只处理超过五分钟仍未完成的
`dispatching`；记录带 owner 进程信息，owner 已退出时可立即收口，仍存活的另一进程
正在进行的 HTTP 投递不会被误伤。

任务中心的 RPA/Webhook 触发记录仍由 `task_triggers` 驱动，并不等同于消息列表记录；
这条链路仍按自身协议单独核算。

## 11. 验收边界

本轮只完成代码、文档、静态检查与自动化测试验证，**没有重启 Feather，没有调用示例内网
Webhook，也没有向真实微信联系人发送消息**。Feather 源码中的资源 spool 过期时间单位
问题已修复并重新编译；运行中的进程仍需在你确认测试对象后自行重启加载新 exe。
