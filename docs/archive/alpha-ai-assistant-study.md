# Alpha「AI 助手」能力提炼与三入口落地建议

> 分析范围：仅只读检查 `D:\Alpha\_recon\asar` 中的主进程、渲染器构建产物，以及
> `D:\Alpha\_recon\dist\Alpha-patched\resources\bin\alpha-agent-host.cjs`。未运行 Alpha，
> 未修改或清理 `D:\Alpha`，未分析订阅、许可证、凭证内容。本文只改本文件。
>
> 下文用 `main\index.js` 指 `D:\Alpha\_recon\asar\out\main\index.js`，用
> `index-C0qhFjlT.js` 指 `D:\Alpha\_recon\asar\out\renderer\assets\index-C0qhFjlT.js`。
> 证据口径：本文把“已实现”限定为在反编译产物中能定位到函数/分支的行为；构建产物行号会随版本漂移，
> 因此同时给出函数名，便于升级后重新定位。Alpha 的“可溯源”能力明显弱于本仓现有
> Answer Runtime V2 的证据包，不能把它当成引用正确性的完整方案。

## 1. 结论摘要

Alpha 的 AI 助手不是“一个会调工具的聊天框”，而是一套把模型输出限制在可恢复运行框架内的
Agent 协议：工具按需披露、工具结果按预算外置、上下文分层压缩、错误分类重试、请求幂等、
审批前后置校验、事件协议驱动 UI。真正值得借鉴的是这些**运行边界与状态机**，而不是它的
提示词篇幅、32 轮循环、远程 Gateway 部署或计费面板。

对本项目最重要的判断：

- 三个入口应继续共用同一套运行时与事件契约，但保留 profile 的硬白名单；Alpha 没有等价于
  `session-ask` 的“服务端锁定当前会话”机制。
- 最优先补的是**工具结果预算与回读**、**未完成问题恢复**、**发送幂等/不确定态**、
  **统一工具事件投影**；这些能直接改善可靠性，且不扩大数据权限。
- 不应照搬 Alpha 的“完整工具结果留在进程内、靠模型 `read_result` 自取”作为唯一溯源手段；
  本仓应保留 `evidenceId + locator + citation`，把 `result_id` 只作为上下文管理手段。
- Alpha 的审批是“人工交互 + Gateway 策略”形态；ClawBot 无人值守入口不能弹审批卡，必须改为
  执行前硬拒绝 + 发送前引用门禁，而不是“默认允许”。

## 2. Alpha 总体架构与能力边界

### 2.1 三层分工

| 层 | 位置 | 职责 | 对本项目的含义 |
| --- | --- | --- | --- |
| 主进程 | `asar\out\main\index.js` | Agent 设置、线程库、请求日志、审批、事件投影、Gateway HTTP 客户端 | 可借鉴其**状态持久化与幂等协议**，不必引入双进程 |
| Agent Host | `alpha-agent-host.cjs` | Provider 适配、工具目录/披露、参数聚合、上下文预算、流解析、重试、Turn 门闩 | 最值得提炼的运行时核心 |
| 渲染器 | `asar\out\renderer\assets\index-C0qhFjlT.js` | 线程 UI、流式合并、工具步骤、审批卡、停止、统计 | 可借鉴**事件到 UI 的映射**，不照搬组件和视觉 |

Alpha 的能力边界也很清楚：

- 它面向“本机微信数据 + 可选外部工具”的单用户桌面助手，默认工具审批为 `read-only`
  （`main\index.js:68178-68186`），并未把“所有工具默认可执行”当成安全模型。
- 它没有本项目的三入口 profile 体系。Alpha 的工具过滤是“内置工具白名单 + 敏感 URL 剔除
  + 图片能力开关”（`main\index.js:70370-70401`）。反编译产物中未发现与 `session-ask`
  等价的“profile 级当前会话硬锁”；本项目的会话锁定仍需在执行层单独实现。
- 它的“引用”主要是系统提示要求“说明是谁、在什么时间说的”
  （`main\index.js:70414`），加上截断结果的 `result_id` 回读；没有本仓
  `evidenceId / locator / citationsFromEvidence` 那种结构化引用校验。

### 2.2 一次 Turn 的真实路径

1. 主进程把系统规则、运行时上下文和用户消息提交为 run
   （`main\index.js:70673-70695`）。
2. Agent Host 绑定工具目录，按需披露工具，创建 provider conversation
   （`alpha-agent-host.cjs:5393-5404`）。
3. 每轮请求前先做上下文预算裁剪；请求后解析 SSE，聚合文本、reasoning、工具参数与 usage
   （`alpha-agent-host.cjs:5413-5465`、`5760-6016`）。
4. 有工具调用时，把调用投影成事件，等待主进程回传结果，追加到 conversation 后进入下一轮
   （`alpha-agent-host.cjs:5485-5530`、`6256-6267`）。
5. 没有工具调用且不是“声称 tool_calls 却没有调用”的异常 finish，则结束并发出 finish
   （`alpha-agent-host.cjs:5531-5536`）。
6. 主进程把 provider 事件投影成渲染器可消费的文本/思考/工具/重试/压缩事件
   （`main\index.js:70621-70636`、`11066-11120`）。
7. 渲染器按 cursor 轮询增量事件，合并到消息 parts，并在终态回读 run 结果
   （`index-C0qhFjlT.js:41933-41985`、`42491-42536`）。

### 2.3 面向用户的产品能力

| 能力 | 表现 | 技术落点 |
| --- | --- | --- |
| 线程管理 | 新建、切换、置顶、重命名、删除、搜索历史 | `main\index.js:11254-11375`、`index-C0qhFjlT.js:44253+` |
| 流式回答 | 正文平滑输出，思考过程单独折叠 | `index-C0qhFjlT.js:44169-44216` |
| 工具步骤 | 显示工具用途、参数摘要、运行/完成/失败、耗时 | `index-C0qhFjlT.js:44129-44163` |
| 审批卡 | 显示用途、读/写说明、参数、拒绝/总是允许/允许一次 | `index-C0qhFjlT.js:42695-42725` |
| 停止生成 | 运行中把发送按钮切换为停止，并展示已停止 | `index-C0qhFjlT.js:43566`、`44239-44242` |
| 重试/压缩提示 | 显示限流、断流、续写、清理旧结果、摘要旧对话 | `index-C0qhFjlT.js:42152-42167` |
| 用量与上下文 | 输入/输出/缓存 token、上下文占用、工具耗时 | `index-C0qhFjlT.js:44050-44090` |
| 模型控制 | 模型选择、推理强度、审批模式 | `index-C0qhFjlT.js:43561-43565` |
| 结果操作 | 复制、生成分享图、查看统计 | `index-C0qhFjlT.js:44243-44249` |

## 3. 线程与上下文管理

### 3.1 线程持久化：轻索引 + 远端 transcript

`AgentThreadStore` 只持久化线程索引，不把完整聊天正文塞进本地线程文件：

- 线程字段为 `id/title/pinned/createdAt/updatedAt/asked/replies`
  （`main\index.js:11254-11286`）。
- 首次发问时创建线程，标题取首问前 24 个字符
  （`main\index.js:11244-11247`、`70657-70658`）。
- `asked` 最多保留 8 个“尚未拿到回复”的问题；失败/取消的问题会以
  `failed/canceled` 留在历史里（`main\index.js:11277-11303`）。
- 每条回复只保留最近 100 条统计（`main\index.js:11310-11315`）。
- 写入串行化，避免并发覆盖（`main\index.js:11361-11368`）。

这解决了一个很实际的问题：请求失败或应用重启后，用户仍能看到“我问过什么、为什么没有回答”，
而不是问题凭空消失。Alpha 在读取历史时会把未完成问题与远端历史按时间合并
（`main\index.js:70516-70533`），并在打开线程时只读回查 run 状态，不自动重发
（`main\index.js:71030-71040`）。

### 3.2 作用域隔离

线程按 scope 分区，新线程使用 `thread:<range>:<threadId>`，旧线程映射到账号级 scope
（`main\index.js:71287-71291`）。这避免切换微信账号或记忆范围后，旧线程被错误复用。

本项目的 `threadState` 已有“范围签名隔离”：范围或知识库切换后不继承旧状态
（`use-ask.ts:307-339`、`use-ask.ts:504-523`）。两者方向一致，但 Alpha 把“未完成问题”
也纳入了持久状态，这是本项目当前缺少的。

### 3.3 上下文分层压缩

Alpha 的预算不是拍脑袋的固定值，而是由模型窗口推导
（`alpha-agent-host.cjs:4484-4496`）：

- 输出预留：`min(maxOutputTokens, 窗口 25%, 32K)`；
- 安全余量：`max(1024, 窗口 5%)`；
- 单条工具结果预算：输入预算的 20%，夹在 2K–24K token；
- 75% 触发裁剪，裁剪目标 50%；
- 摘要预算：输入预算 5%，夹在 1024–4096 token。

裁剪顺序是“最不伤证据的先做”
（`alpha-agent-host.cjs:5546-5574`）：

1. 清理最旧的非当前轮工具结果；
2. 把更早的历史轮次压缩成摘要；
3. 仍超预算才丢弃最旧历史；
4. provider 报 context overflow 时，强制清理所有非当前轮工具结果并丢弃旧历史，
   不再花一次摘要请求（`alpha-agent-host.cjs:5559-5564`）。

摘要提示要求保留目标、约定、已完成工作、关键数字、人名/群名、时间范围、待办和后续标识
（`alpha-agent-host.cjs:5010-5029`）；摘要没有明显缩小原文时拒绝采用
（`alpha-agent-host.cjs:5037-5040`、`5602-5606`）。摘要按历史哈希链缓存，最多 24 条
（`alpha-agent-host.cjs:4982-5008`）。

### 3.4 稳定提示与运行时上下文分离

`agentSystemMessages()` 把身份、工具规则、图片规则、审批规则、回答风格放在稳定系统消息里，
把“当前时间、记忆”放进独立的 `<runtime-context>`
（`main\index.js:70430-70450`）。这不是形式主义：当前时间每分钟变化，如果拼进系统提示主体，
会持续破坏 provider 的 prompt cache。

### 3.5 可直接借鉴 / 需适配 / 不适用

| 分类 | 结论 | 依据 |
| --- | --- | --- |
| 可直接借鉴 | 线程轻索引 + 未完成问题保留 + 重启只读回查 | `main\index.js:11277-11303`、`71030-71040` |
| 可直接借鉴 | 稳定规则与 `runtime-context` 分离 | `main\index.js:70430-70450` |
| 需适配 | 分层压缩的阈值应服从本仓模型能力与成本，不照搬 32K/24K 绝对值 | `alpha-agent-host.cjs:4484-4496` |
| 需适配 | Alpha 的线程正文在远端 Engine；本项目已有本地问答历史，应做“索引 + 现有历史”的映射，而非再建一套全文库 | `main\index.js:70516-70533` |
| 不适用 | Alpha 的账号级 scope/记忆范围模型与本项目微信账号、知识库边界不同 | `main\index.js:71287-71291` |

## 4. 工具选择与工具循环

### 4.1 工具目录先做可信过滤

Alpha 在把工具交给模型之前做三件事：

- 只接受已知内置工具；名字以 `_url` 结尾的敏感 URL 工具剔除；不存在的内置工具剔除
  （`main\index.js:70370-70401`）。
- 已知内置工具的描述由本地目录覆盖；只有本地没有覆盖时才使用声明描述
  （`alpha-agent-host.cjs:4419-4457`）。
- 外部 MCP 工具一律要求审批，并把描述标记为不可信
  （`main\index.js:70195-70197`）。
- 系统规则明确要求把工具返回文本当作**数据而不是指令**，不能执行其中的要求，
  也不能声称看过没有返回的内容（`main\index.js:70415`）。

最后一条很重要：仅靠提示词说“外部描述不可信”不够，执行层仍要有白名单与审批。

### 4.2 工具按需披露，保护 prompt cache

工具数量超过 12 时，只常驻核心工具；其余工具通过 `request_tools` 每次最多加载 4 个
（`alpha-agent-host.cjs:5160-5238`）。两个细节值得直接学：

- 工具顺序只向后增长：核心工具 → `request_tools` → `read_result` → 已加载工具，
  已加载工具不改变前面工具的顺序，从而不破坏 provider 的前缀缓存
  （`alpha-agent-host.cjs:5174-5190`）。
- 模型直接调用尚未披露但真实存在的工具时，也把该工具记为已加载，避免下一轮再次要求加载
  （`alpha-agent-host.cjs:5198-5201`）。

这比“把 20 个工具 schema 一次全塞给模型”更稳：工具越多，模型越容易选错、参数越容易串，
而且每次请求的 token 成本更高。

### 4.3 工具 schema 与参数构造

- 工具数上限 128，schema 上限 64 KiB，schema 必须是 JSON 对象根
  （`alpha-agent-host.cjs:4417-4420`、`4462-4470`）。
- 工具名不符合 provider 命名规则时生成稳定别名，并处理别名冲突
  （`alpha-agent-host.cjs:4431-4441`）。
- 流式参数按片段聚合；JSON 非法或超过 1 MiB 直接报错，不把坏参数交给执行层
  （`alpha-agent-host.cjs:6287-6348`）。
- 最终参数统一序列化为 canonical JSON，并在发出前再次检查大小
  （`alpha-agent-host.cjs:6017-6029`、`6324-6338`）。

这套“先聚合、再校验、再规范化”的顺序，比在工具函数里各自 `JSON.parse` 更可靠。

### 4.4 工具循环和结果门闩

`HttpProvider.runTurn()` 的循环上限是 32 轮、单轮最多 128 个调用
（`alpha-agent-host.cjs:5362-5368`、`5409-5413`）：

- 每轮先裁剪上下文，再发请求；
- 有工具调用就把调用投影成 `toolCall` 事件，等待执行结果；
- 结果只能按 `toolCallId + toolName` 匹配，重复提交、未知调用、非等待状态都拒绝
  （`alpha-agent-host.cjs:6707-6725`）；
- 取消时 reject 所有工具门闩，避免执行层永远挂着
  （`alpha-agent-host.cjs:6697-6705`）；
- provider 声称 `tool_calls` 但实际没有调用时，明确失败，而不是把半截回答当完成
  （`alpha-agent-host.cjs:5531-5534`）。

本项目的 `runToolLoop` 已有更保守的 4 轮、每轮 6 次、20 秒 deadline
（`tool-loop.ts:41-50`），并会在首轮无工具调用时做最多 3 个确定性兜底
（`tool-loop.ts:901-929`、`runtime.ts:323-332`）。这套边界更适合本项目的查询型场景，
不应为了“像 Alpha”而放宽到 32 轮。

### 4.5 可直接借鉴 / 需适配 / 不适用

| 分类 | 结论 | 依据 |
| --- | --- | --- |
| 可直接借鉴 | 工具按需披露，顺序只增不改 | `alpha-agent-host.cjs:5160-5238` |
| 可直接借鉴 | 坏参数在进入执行层前拒绝，结果按 callId+name 门闩匹配 | `alpha-agent-host.cjs:6287-6348`、`6707-6725` |
| 需适配 | 工具加载提示应由本项目意图分类提供“下一跳建议”，但不突破 profile 白名单 | 本项目 `runtime.ts:323-332`、`profileHints()` |
| 需适配 | Alpha 的 32 轮/128 调用预算不适合本项目，保留 4 轮/6 调用/20 秒 | `tool-loop.ts:41-50` |
| 不适用 | Alpha 的外部 MCP 生命周期与远程工具目录 | `main\index.js:70361-70367` |

## 5. 工具事件与 UI 呈现

### 5.1 统一事件，而不是让 UI 猜工具状态

主进程把 provider 事件投影成文本增量、思考增量、工具进度和重试/压缩提示
（`main\index.js:70621-70636`、`11066-11120`）；run 状态由单独的回读接口提供，
用量则另行累计到 tally。工具事件包含：

- `toolCallId`
- `toolName`
- `phase: called | completed | failed`
- 参数摘要（最多 600 字符，`main\index.js:11035`、`11081-11086`）
- 可选 `taskId/taskState`
- 时间戳

渲染器的 `applyRunEvents()` 用同一 `toolCallId` 合并同一工具的 `called → completed/failed`，
并把连续工具调用归入一个 `tools` part
（`index-C0qhFjlT.js:41933-41985`）。因此 UI 不需要理解 provider 的流格式。

但这里也有一个不应照抄的缺口：该 reducer 没有对 phase 做单调保护。如果 `completed`
先到、`called` 后到，后到的 `called` 会把 `endedAt` 清掉并把状态改回“运行中”
（`index-C0qhFjlT.js:41970-41977`）。本项目应把 phase 定义为只向前推进：
`called < completed/failed`，终态不允许被迟到的调用事件覆盖。

### 5.2 工具步骤的可读性

渲染器把工具名映射成人能看懂的动作（搜索聊天记录、读取聊天记录、统计聊天数据、查看图片与文件、
导出等，`index-C0qhFjlT.js:42046-42063`），并显示：

- 运行中旋转图标、失败叉号、完成勾号；
- 参数摘要，可展开查看完整参数；
- 后台任务的排队/执行中/完成状态与耗时；
- “完成后会继续回答，可以切换页面”的提示
  （`index-C0qhFjlT.js:44129-44163`）。

这里有一个值得注意的取舍：Alpha 直接在 UI 展示工具 JSON 参数
（`index-C0qhFjlT.js:44145`、`42716`）。本项目不应原样照搬，应该复用已有的
`summarizeToolArguments()` 做字段白名单与脱敏（`trace.ts:62-68`），只在“查看详情”里展示
经过脱敏的参数。

### 5.3 可直接借鉴 / 需适配 / 不适用

| 分类 | 结论 | 依据 |
| --- | --- | --- |
| 可直接借鉴 | `toolCallId` 驱动的事件合并与三态展示 | `index-C0qhFjlT.js:41933-41985`、`44129-44163` |
| 可直接借鉴 | 工具名到用户语言的映射表 | `index-C0qhFjlT.js:42046-42063` |
| 需适配 | 参数展示必须脱敏、限长、可折叠，不能直接 `JSON.stringify` | 本项目 `trace.ts:62-68` |
| 需适配 | ClawBot 不展示审批卡，但要展示“检索→证据→发送门禁”的阶段 | 本项目 `ask-runtime.ts:397-415` |
| 不适用 | Alpha 的分享图、计费面板、UI 组件与样式 | `index-C0qhFjlT.js:44243-44249`、`44050-44090` |

## 6. 审批与权限门

### 6.1 三档审批

Alpha 定义 `always-ask / read-only / full-access` 三档，默认 `read-only`
（`main\index.js:68121-68122`、`68178-68186`）：

- `always-ask`：每次工具调用前都问；
- `read-only`：读取直接进行，导出、外部工具等写操作逐次审批；
- `full-access`：写操作不再问。

系统提示也明确要求“被拒绝时说明影响并停下，不要换个工具绕过”
（`main\index.js:70422-70426`）。

### 6.2 审批不是“点个确认”那么简单

Alpha 的审批记录包含 `approvalId/runId/turnId/toolCallId/descriptorSha256/
argumentsSha256/state/revision/decisionId/expiresAt`
（`main\index.js:11011-11031`）。审批流程有几层防错：

1. `inspectApproval()` 生成 5 分钟有效的短期 `viewId`，并把参数与副作用类型交给 UI
   （`main\index.js:70799-70812`）。
2. 客户端决策前会校验：view 未过期、run 属于当前 scope（`knownRun()` 校验，不是逐条比对
   threadId）、状态仍为 pending、审批未过期；
   决策请求同时携带 `decisionId + expected_revision + arguments_sha256`，由服务端拒绝
   过期 revision 或被替换的参数（`main\index.js:70819-70857`）。审批记录里另有
   `descriptorSha256`，但客户端决策请求本身不发送该字段，descriptor 一致性是否校验
   取决于服务端实现，不能仅凭客户端代码宣称已覆盖。
3. 决策带 `decisionId` 持久化；重复提交返回原结果，而不是再执行一次
   （`main\index.js:70825-70866`）。
4. 响应丢失时返回 `outcome: "unknown"`，界面提示“结果未知，不会重复提交”，
   之后只做只读回查（`main\index.js:70867-70872`、`index-C0qhFjlT.js:42718`）。

这比“前端弹窗 → 直接发一个 approve=true”安全得多：它防的是重放、参数被替换、
审批过期后继续执行，以及网络失败后的盲目重试。

### 6.3 策略在每次 run 前同步

`applyToolPolicy()` 在创建 run 前把审批模式和已批准工具同步给 Gateway
（`main\index.js:70877-70891`）。工具目录本身也带
`requiredFeature/requiredScopes/sideEffect/approvalPolicy`
（`main\index.js:10975-10997`），因此执行层能区分“读”和“写”，而不是只靠工具名猜。

### 6.4 对三个入口的意义

- 微信问答、AI 问答当前都是只读检索，可沿用“读自动、写逐次审批”的方向；
  未来若加入导出，必须把导出做成独立副作用工具，不能混进通用检索。
- ClawBot 是无人值守发送，不能弹交互审批。正确做法是：
  1. profile 白名单只留 `search_kb`；
  2. 任何写工具在执行前直接拒绝；
  3. 发送前再做引用归属与空回答门禁（本项目已有，见 `docs/ANSWER-RUNTIME-V2.md`
     “ClawBot 发送前校验”）。
- “总是允许”不能成为 ClawBot 的默认策略；无人值守场景宁愿不发，也不能放宽边界。

### 6.5 可直接借鉴 / 需适配 / 不适用

| 分类 | 结论 | 依据 |
| --- | --- | --- |
| 可直接借鉴 | 短期 view + revision + 参数哈希 + decisionId 幂等 | `main\index.js:70799-70872` |
| 可直接借鉴 | 审批前重新校验归属、状态、过期时间，并让服务端校验 revision/参数摘要 | `main\index.js:70819-70857` |
| 需适配 | 本项目目前只读，可先实现“读自动、写审批”，不要引入 `full-access` | `main\index.js:68121-68122` |
| 需适配 | ClawBot 用执行前拒绝 + 发送门禁替代交互审批 | 本项目 `docs/ANSWER-RUNTIME-V2.md` |
| 不适用 | Alpha 的 Gateway 级 tool-policy 远程同步 | `main\index.js:70877-70891` |

## 7. 流式输出、错误与取消

### 7.1 流式协议统一

Agent Host 把四种 provider 的流统一成少量事件：

- `textDelta`
- `reasoningDelta`
- `toolCall`
- `usage`
- `retry`
- `compaction`
- `finish`

解析入口在 `parseBody()`（`alpha-agent-host.cjs:5539-5545`）：

- OpenAI Chat：`5760-5816`
- Gemini：`5817-5879`
- Anthropic：`5880-5947`
- OpenAI Responses：`5948-6016`

关键防护：

- 流结束但没有 finish、工具参数未聚合完整、provider 声称工具调用却没有调用，都明确失败
  （`5812-5814`、`5873`、`5940-5944`、`6014`）。
- SSE 单事件上限 8 MiB，错误体最多读 16 KiB，避免异常响应撑爆内存
  （`alpha-agent-host.cjs:5362-5368`）。
- 读取过程有 idle timeout，且支持取消（`alpha-agent-host.cjs:5613-5669`）。

### 7.2 类型化重试，而不是“失败就再来”

Alpha 的重试策略按原因分档（`alpha-agent-host.cjs:5084-5158`）：

- 限流最多 4 次；
- timeout 最多 3 次；
- 其他临时错误最多 6 次；
- 限流 5 秒基线、指数退避、15% 抖动；
- 普通错误 500ms 基线、10% 抖动，单次上限 10 秒；
- 尊重 `Retry-After`，超过 60 秒不再重试；
- 余额不足不重试；
- 取消会唤醒退避等待，不必等完整睡眠（`5145-5158`）。

更实用的是“可续写”：如果流式文本已经输出一部分后中断，重试时把已输出内容作为 assistant
消息追加，并要求模型从中断处继续，不重复已写内容
（`alpha-agent-host.cjs:5478-5483`、`6032-6054`）。UI 会明确提示
“会接着已写的内容继续”（`index-C0qhFjlT.js:42152-42163`）。

本项目的 `errors.ts` 已有同类分类：

- `invalid_arguments/not_found/unauthorized/scope_blocked/internal` 不重试；
- `timeout/rate_limited` 最多 1 次；
- `transient` 最多 2 次；
- 副作用工具一律禁止自动重试
  （`errors.ts:62-71`、`199-233`）。

差异在于：本项目的重试主要覆盖**工具调用**，Provider 层的流中断续写还没有等价实现。

### 7.3 取消的可观察性

Alpha 的取消不是前端把按钮变灰就结束：

- `cancelTurn()` 标记 `cancel_requested`、abort provider、reject 所有工具门闩
  （`alpha-agent-host.cjs:6697-6706`）；
- 取消 ID 持久化，重复取消不会重复提交（`main\index.js:70733-70751`）；
- 取消失败时只报“只能回查”，不猜测服务端是否已取消
  （`main\index.js:70747-70749`）；
- UI 对终态显示“已停止生成”（`index-C0qhFjlT.js:44239-44242`）。

本项目的取消已经能中断工具 deadline 与退避等待（`tool-loop.ts:270-297`、
`tool-loop.ts:358-366`），但底层多数检索工具尚未普遍监听 `AbortSignal`
（`docs/ANSWER-RUNTIME-V2.md` 的“残余风险”也明确承认）。这会导致 UI 已显示取消、
后台 SQLite/检索仍在跑。应把“收到取消信号”与“底层查询真正停止”分开验收。

### 7.4 请求幂等与“结果不确定”

Alpha 把“发送失败”和“不知道服务端有没有收到”区分开：

- 每次提问生成客户端 `requestId`，请求头带同名 `idempotency-key`
  （`main\index.js:70637-70640`、`70684-70687`）。
- 本地保存请求指纹，指纹覆盖 `contextId/threadId/prompt/effort` 和图片 SHA-256
  （`main\index.js:70640`）。
- 同一 `requestId` 且指纹一致时返回原请求结果；同一 ID 但内容不同直接报冲突
  （`main\index.js:70644-70648`）。
- 发送后网络失败、无法确认服务端是否收单时返回 `outcome: "unknown"`，不自动重发
  （`main\index.js:70709-70716`）。
- 恢复时通过 GET 回查请求；查不到就保持 `unknown`，查得到再读取 run
  （`main\index.js:70951-70961`）。
- 首次发送时已经把问题写入线程的 `asked`；`unknown` 不删除该问题，因此重开线程仍能看到
  （`main\index.js:70657-70665`、`70709-70716`）。

这套设计解决的是最容易被忽略的重复扣费/重复回答：网络超时并不等于服务端没执行。
本项目的 `wechat-ask` 目前以 `streamId/jobId` 管理流与取消，但没有等价的请求指纹与
`unknown` 状态；如果客户端超时后自动重试，仍可能产生两次回答。

### 7.5 可直接借鉴 / 需适配 / 不适用

| 分类 | 结论 | 依据 |
| --- | --- | --- |
| 可直接借鉴 | 类型化重试 + `Retry-After` + 取消唤醒退避 | `alpha-agent-host.cjs:5084-5158` |
| 可直接借鉴 | 流中断后续写，并向用户明示 | `alpha-agent-host.cjs:5478-5483`、`6032-6054` |
| 可直接借鉴 | `requestId + 内容指纹` 幂等，`unknown` 只回查不重发 | `main\index.js:70637-70716`、`70951-70961` |
| 需适配 | 续写只适用于“纯文本已输出”的 provider 中断；工具调用参数中断应整轮重试，避免半参数 | `alpha-agent-host.cjs:6287-6348` |
| 需适配 | 本项目需给 Provider 层补 retry/续写，但保留工具层“副作用不重放” | 本项目 `errors.ts:219-233` |
| 不适用 | Alpha 的 20 分钟硬上限与特定 provider 超时值 | `alpha-agent-host.cjs:5368` |

## 8. 引用与可溯源

### 8.1 Alpha 做到了什么

Alpha 的溯源能力由三部分组成：

1. 提示词要求引用聊天内容时说明“是谁、在什么时间说的”，不暴露内部 ID/路径
   （`main\index.js:70414-70415`）。
2. 工具结果过长时保留 `result_id`，模型可用 `read_result` 按 offset 继续读或按关键词搜索
   （`alpha-agent-host.cjs:4507-4529`、`4597-4666`）。
3. 工具事件保留工具名、参数摘要、调用/完成时间，UI 能显示“查了什么、查了多久”
   （`main\index.js:11081-11095`、`index-C0qhFjlT.js:44129-44163`）。

但它没有：

- 稳定的 `evidenceId`；
- 证据定位器（消息 key、知识库 chunk key）；
- 引用编号到证据包的结构化映射；
- 输出侧引用归属校验。

因此，Alpha 的“可溯源”更接近“可回读 + 可解释”，不是“每条结论都能机器校验”。

### 8.2 本项目的优势不能丢

本仓 `evidence.ts` 已经把工具结果统一成证据，并做：

- 同一证据多工具命中合并、保留来源；
- 畸形 `hits/facts` 整条拒绝；
- `session-ask` 只接受当前会话消息；
- `clawbot-auto` 只接受当前 `kbId` 的合法知识库键；
- 引用与资源分别建模，不把文件/收藏伪装成消息引用。

此外，综合生成链会调用 `resolveGroundedAnswer()` 做接地复核，并把结果写回
`withheld / grounding / citedIndexes`（`ask-runtime.ts:652-677`）；最终状态映射会在
“模型内容被撤回”或“有引用但正文一个角标都没标”时把 `ok` 降为 `degraded`
（`ask-runtime.ts:455-474`）。`runtime.ts:521-558` 只负责综合生成失败后的证据格式化降级，
两者是不同层，不应混为一谈。这是 Alpha 没有的能力，应该保留并加强，而不是用
`result_id` 取代。

### 8.3 可直接借鉴 / 需适配 / 不适用

| 分类 | 结论 | 依据 |
| --- | --- | --- |
| 可直接借鉴 | 大结果 `result_id` + offset/search 回读，作为上下文管理手段 | `alpha-agent-host.cjs:4507-4529`、`4597-4666` |
| 可直接借鉴 | 工具事件保留参数摘要与耗时，支撑“查了什么”的解释 | `main\index.js:11081-11095` |
| 需适配 | `result_id` 只能辅助回读，不能替代 `evidenceId/locator/citation` | 本项目 `evidence.ts`、`runtime.ts:430-436` |
| 需适配 | Alpha 提示词式引用需升级为本项目“引用归属 + 数值核对 + 降级” | 本项目 `ask-runtime.ts:455-500`、`652-677` |
| 不适用 | 把完整工具结果留在 Host 进程、靠模型自觉回读 | `alpha-agent-host.cjs:4597-4666` |

## 9. 预算、压缩与 Provider 兼容

### 9.1 工具结果外置

`ResultStore` 最多保留 32 条、总量上限 `16 * 1024 * 1024` 个字符（不是 16 MiB 字节）；
单次 `read_result` 默认 6000 字符、
最多 16000 字符、最多 8 个匹配，每个匹配前后 200 字符上下文
（`alpha-agent-host.cjs:4597-4666`）。

`fitToolResult()` 会优先找最长的数组做二分截断，保留总数、字段路径和 `result_id`
（`alpha-agent-host.cjs:4510-4559`）；没有数组时才做头尾截断（70% 头 + 30% 尾）
（`4560-4576`）。这比简单 `slice(0, N)` 更不容易丢掉结尾的关键结论。

### 9.2 Provider 兼容层

Alpha 支持：

- `openai-chat`
- `openai-responses`
- `anthropic`
- `gemini`
- `opencode-go`

`normalizeKind()` 把 `openai/openai-compatible/deepseek` 归一为 `openai-chat`
（`alpha-agent-host.cjs:6191-6197`）；`opencode-go` 按模型名前缀路由到不同 wire format
（`5320-5325`）。

请求构造差异集中在 `buildRequest()`（`5671-5759`）：

- Gemini：`systemInstruction + contents + generationConfig`
- Anthropic：`system + messages + max_tokens + thinking`
- Responses：`instructions + input + store:false`
- OpenAI Chat：`messages + stream_options.include_usage + tools`

结构化输出也不是“所有 provider 同一套”：

- Anthropic 用 `output_config.format`
- Responses 用 `text.format`
- Gemini 用 `responseMimeType + responseJsonSchema`
- OpenAI Chat 用 `response_format`，DeepSeek 只支持 `json_object`
  （`alpha-agent-host.cjs:5671-5759`、`6222-6226`）

这套兼容层的价值不在代码本身，而在“能力探测 + 明确降级”：

- 模型 profile 声明 `contextWindow/maxOutputTokens/imageInput/reasoningLevels`
  （`alpha-agent-host.cjs:5042-5082`）；
- 不支持的 reasoning level 自动降级到最接近的可用档位，而不是静默失败
  （`5073-5082`）；
- 模型不支持图片时，系统提示明确说“不能查看画面”，且不提供图片工具
  （`main\index.js:70418-70421`、`70396-70401`）。

本项目的 Provider 接入在 `ask-run-chat.ts`，与 Alpha 的双进程 Host 不同，不应整层移植；
但“能力声明 + 请求前降级 + 错误码可解释”可以直接借鉴。

### 9.3 可直接借鉴 / 需适配 / 不适用

| 分类 | 结论 | 依据 |
| --- | --- | --- |
| 可直接借鉴 | 大结果外置 + 二分截断 + 头尾保留 | `alpha-agent-host.cjs:4510-4576`、`4597-4666` |
| 可直接借鉴 | 模型能力声明与 reasoning 档位降级 | `alpha-agent-host.cjs:5042-5082` |
| 需适配 | 预算阈值应按本项目模型配置动态计算，不写死 32K | `alpha-agent-host.cjs:4484-4496` |
| 需适配 | Provider 兼容应在现有 `ask-run-chat` 内做适配层，不引入 Gateway/Host 双进程 | 本项目 `remotes/ask-run-chat.ts` |
| 不适用 | Alpha 的模型价格表、成本估算、用量计费 | `main\index.js:11180-11205` |
| 不适用 | `opencode-go` 等特定订阅路由 | `alpha-agent-host.cjs:5315-5359` |

## 10. 三个入口的落地建议

### 10.1 共通改造（三入口共享）

**P0：统一事件契约**

- 新增内部事件类型：`text/reasoning/tool/retry/compaction/status`，工具事件统一带
  `toolCallId/toolName/phase/argumentsSummary/startedAt/endedAt/errorClass`。
- 后端只投影脱敏后的参数摘要，不把完整工具结果或密钥送往前端。
- 前端按 `toolCallId` 合并三态，连续工具调用归组；不要为每个入口各写一套。

验收：

- 同一轮同时调用 3 个工具时，UI 只出现 3 个步骤，不重复、不串行错位；
- 工具失败时步骤显示失败与脱敏错误码，正文不出现工具原始错误；
- 事件乱序（completed 先于 called）时仍合并为一条，且终态不被迟到的 called 覆盖。

**P0：工具结果预算与回读**

- 给工具结果增加“预算裁剪 + 完整结果缓存 + 回读键”，但回读键只用于上下文，
  不作为对外引用。
- 裁剪优先保留结构化字段（总数、时间范围、消息 key、文件名），并显式标注
  `truncated/result_id`。

验收：

- 单条工具结果超预算时，模型仍能看到总数与定位键；
- 回读可按 offset 继续、可按关键词搜索；
- 缓存满时淘汰最旧项，不出现“回读键存在但内容已被清空”的假成功。

**P1：请求幂等与未完成问题**

- 每次提问生成客户端 `requestId`，服务端按 `requestId + 内容指纹` 幂等；
- 同 ID 不同内容返回冲突；
- 发送后无法确认是否送达时返回 `unknown`，只做只读回查，不自动重发；
- 线程保留未完成问题，失败/取消后可重新打开。

验收：

- 同一请求重复提交只产生一个 run；
- 网络断开后重进线程，能看到原问题与“结果未知/失败/已取消”状态；
- 重启后不会重复调用模型。

**P1：Provider 层重试与取消**

- 区分 `rate_limit/timeout/transport/stream/quota/refusal`；
- 尊重 `Retry-After`，余额不足不重试；
- 流式文本中断可续写；工具参数中断整轮重试；
- 取消必须同时中止 provider 请求、工具 deadline、退避等待，并让底层查询收到
  `AbortSignal`。

验收：

- 取消后 1 秒内不再有新的模型/工具事件；
- 限流时按服务端建议等待，不出现固定 5 秒风暴；
- 续写不重复已输出段落。

### 10.2 微信问答（`wechat-ask`）

定位：跨会话、跨资源域的调查型问答，工具最多、范围最宽。

建议：

1. 保持 14 个工具的全集，但按“消息 / 联系人 / 朋友圈 / 收藏 / 文件 / 账单 / 知识库”
   分组做按需披露；首轮只暴露与意图相关的 4–6 个，其余通过 `request_tools` 加载。
2. 意图提示只影响排序，不突破白名单；对“文件/收藏/朋友圈/转账”等明确资源词，
   强制优先专用工具，不能只跑 `search_hybrid`。
3. 对统计类问题优先 `aggregate_messages`，并保留“统计口径 + 时间范围 + 数据源”
   三项证据，避免模型自行数消息。
4. 结果裁剪后保留消息 `username + local_id`，支持从证据直接跳回原文。

验收：

- 资源类问题 Top-1 工具命中率达到离线评测门槛；
- 任一引用都能通过 `username + local_id` 回放到原消息；
- 统计回答的数字与 `aggregate_messages` 返回值一致。

### 10.3 AI 问答（`session-ask`）

定位：只读当前会话，范围最窄、上下文最连续。

建议：

1. 服务端强制 `username`，模型参数里的其他会话一律在执行层拒绝；不要只靠提示词。
2. 工具集保持 6 个，不加载跨会话、联系人、朋友圈、文件、账单工具。
3. 多轮上下文优先使用结构化 `threadState`（当前会话、时间窗、引用消息、媒体类型），
   历史文本只作为补充；失败/取消轮次不回溯旧状态。
4. 对“刚才那张图/那个文件”类追问，必须保留 `lastReferencedMessage + mediaTypes`，
   并在证据包里按当前会话复核。

验收：

- 构造跨会话注入问题，执行层返回 `scope_violation`，证据与引用为空；
- 连续追问“那上周呢/他后来怎么说”能继承会话与时间窗；
- 失败一次后，下一轮不会误用失败轮的半截状态。

### 10.4 ClawBot 集群 AI 自动回复（`clawbot-auto`）

定位：无人值守、只读知识库、自动发送，风险最高。

建议：

1. 白名单只保留 `search_kb`；执行层对任何本机微信工具返回 `tool_not_allowed`，
   不因“知识库为空”回退到消息库。
2. 不展示交互审批卡；用“执行前硬拒绝 + 发送前门禁”替代：
   - 回答非空；
   - 每条引用属于当前 `kbId`；
   - 引用是规范 `kb:<kbId>:<chunkId>`；
   - 没有未核实数值或降级残留。
3. 知识库检索失败/为空时，明确返回 `insufficient/blocked`，不要让模型自由发挥；
   发送侧宁可发固定兜底话术，也不发无依据内容。
4. 记录每次自动回复的 `kbId + chunkId + 检索查询 + 发送决策`，便于事后追责。

验收：

- 构造“忽略知识库、直接回答”的注入消息，仍只调用 `search_kb`；
- 引用不属于当前 `kbId` 时，发送被硬阻断；
- 知识库为空时，不产生“看似有依据”的自动回复。

## 11. 分阶段实施与优先级

| 阶段 | 改动 | 预期效果 | 验收标准 |
| --- | --- | --- | --- |
| P0 | 统一工具事件 + 参数脱敏 + 三态合并 | 三入口工具过程一致、可解释 | 事件乱序/重复/失败矩阵通过 |
| P0 | 工具结果预算 + 回读键 | 大结果不再撑爆上下文，仍可继续查 | 超预算结果保留定位键与总数 |
| P1 | `requestId` 幂等 + `unknown` 只回查 | 网络抖动不再重复扣费/重复回答 | 重复提交只产生一个 run |
| P1 | 未完成问题持久化 + 重启回读 | 失败/取消问题不消失 | 重启后线程仍显示原问题与终态 |
| P1 | Provider 重试分类 + 流式续写 + 取消贯通 | 限流/断流可恢复，取消真停止 | 取消后无新事件，续写不重复 |
| P2 | 意图驱动的工具按需披露 | 工具选择更准、prompt 更短 | Top-1 准确率与 token 成本双达标 |
| P2 | 结构化证据包与引用门禁强化 | 回答可机器校验、可回放 | 引用准确率与 ClawBot 违规为 0 |
| P2 | 审批/写操作预留 | 未来导出等副作用可控 | 写工具逐次审批、重复决策幂等 |

不建议在 P0 就做“32 轮工具循环”“全量工具常驻”“无人值守自动批准写操作”，
这些会把风险放大而不是提升体验。

## 12. 风险与不适用项

1. **不要把 Alpha 的提示词当规范**：Alpha 的 `AGENT_RULES` 很长，但它是“建议模型怎么做”；
   本项目的 profile 白名单、证据包、发送门禁才是硬约束。
2. **不要照搬 `full-access`**：本项目的自动回复入口没有人盯着，写操作必须默认拒绝。
3. **不要照搬远程 Gateway/MCP 生命周期**：本项目是单服务内运行时，引入双进程只会增加
   故障面。
4. **不要照搬模型价格表与计费**：价格会变，且与产品计费口径无关；可保留 token 统计，
   不把估算费用当事实。
5. **不要用 `result_id` 替代证据 ID**：`result_id` 是进程内、会淘汰的临时键；
   证据 ID 必须可跨请求、跨重启回放。
6. **不要直接展示工具 JSON**：聊天正文、文件名、路径、token 都可能出现在参数里；
   必须经过 `summarizeToolArguments()` 类脱敏。
7. **不要把“取消按钮变灰”当取消完成**：要验证 provider、工具 deadline、退避定时器、
   底层查询都收到取消信号。

## 13. 与本仓现有文档的关系

- 能力边界、三 profile、证据与验收门槛以 `docs/ANSWER-RUNTIME-V2.md` 为准；
  本文只补充 Alpha 的可借鉴实现，不重复定义产品边界。
- 若两者冲突，优先遵守本项目已有的硬约束：
  - `session-ask` 锁定当前会话；
  - `clawbot-auto` 仅 `search_kb`；
  - 引用必须可回放；
  - 副作用工具不自动重试。

## 14. 关键证据索引

| 主题 | Alpha 证据 | 本项目对应 |
| --- | --- | --- |
| 系统规则与运行时上下文 | `main\index.js:70405-70450` | `runtime.ts` 系统提示拼装 |
| 工具过滤与按需披露 | `main\index.js:70370-70401`、`alpha-agent-host.cjs:5160-5238` | `profiles.ts:91-152`、`tool-loop.ts:98-106` |
| 参数聚合与校验 | `alpha-agent-host.cjs:6287-6348` | `arguments.ts`、`tool-loop.ts:448-508` |
| 工具门闩 | `alpha-agent-host.cjs:6707-6770` | `tool-loop.ts` 的 callId/结果配对 |
| 上下文预算 | `alpha-agent-host.cjs:4484-4576` | 本项目尚无等价分层压缩 |
| 大结果回读 | `alpha-agent-host.cjs:4597-4666` | 本项目暂无 `read_result` |
| 重试与续写 | `alpha-agent-host.cjs:5084-5158`、`6032-6054` | `errors.ts:62-71` |
| 审批 | `main\index.js:70785-70891` | 本项目当前只读，尚未接执行层 |
| 事件投影 | `main\index.js:11066-11120`、`index-C0qhFjlT.js:41933-41985` | `wechat-ask/delta`、`wechat-ask/reasoning`、`wechat-ask/stage` |
| 线程与未完成问题 | `main\index.js:11254-11375`、`71030-71040` | `thread-state.ts`、`use-ask.ts` |
| 证据与引用 | Alpha 仅有提示词 + `result_id` | 本项目 `evidence.ts`、`runtime.ts:430-436` |
| Provider 兼容 | `alpha-agent-host.cjs:5671-6016` | `remotes/ask-run-chat.ts` |
