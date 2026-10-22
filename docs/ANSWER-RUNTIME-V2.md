# 问答运行时 V2：三个入口的统一能力边界与验收

本文记录 2026-10-22 对【微信问答】【AI 问答】【ClawBot 集群 AI 自动回复】的统一改造。
目标不是把三个入口写成同一段提示词，而是让它们共享同一套**可执行**的意图识别、工具循环、
参数修复、证据收敛和引用接地，同时保留各自的数据边界。

配套的机器可读验收契约在
[`acceptance-matrix.json`](../src/backend/wechat-data/tests/acceptance/answer-runtime/acceptance-matrix.json)，
三个入口的实现接入点是
[`askdeep.ts`](../src/backend/wechat-data/src/remotes/askdeep.ts) 与
[`ask-runtime.ts`](../src/backend/wechat-data/src/remotes/ask-runtime.ts)。

## 1. 三个模块的能力边界

边界不是提示词约定，而是在工具 schema、执行器和 profile 守卫三层同时生效。

| 入口 | profile | 数据范围 | 工具白名单 | 会话范围 |
|---|---|---|---|---|
| 微信问答 | `wechat-ask` | 本机微信数据，可选当前知识库 | 消息、语义、混合检索、聚合、会话、上下文、联系人、朋友圈、收藏、文件、账单、知识库等 14 个工具 | 调用方可选会话，不强制锁定 |
| AI 问答（会话内） | `session-ask` | 仅当前会话的消息数据 | `search_messages`、`search_semantic`、`get_session_messages`、`get_message_context`、`aggregate_messages`、`search_hybrid` | 服务端硬锁定 `username` |
| ClawBot 集群 AI 自动回复 | `clawbot-auto` | 仅知识库（`kb-only`） | `search_kb` | 不读取任何本机微信数据，必须提供 `kbId` |

`session-ask` 的 `search_hybrid` 只允许 `messages` 模式；`clawbot-auto` 的白名单只有
`search_kb`，即使模型直接构造工具调用，也会在执行层被拒绝。未知 profile 回退到权限最小的
`clawbot-auto`，避免配置错误放大数据权限。

当前明确不做的能力：

- `session-ask` 不提供跨会话检索、联系人、朋友圈、收藏、文件和账单工具。
- `clawbot-auto` 不提供本机消息、联系人或其他微信数据工具，也不会因为知识库为空而回退到消息库。
- ClawBot 自动回复不提供“无知识库纯聊天”模式：`autoReply=true` 必须同时满足
  `kbEnabled=true` 且 `kbId>0`。设置保存、运行决策与网关发送前校验共用这一条不变量；
  无库时开关不可开启，已有矛盾配置会在下一次保存时自动收敛为关闭。
- 三个入口都不自动执行有副作用的工具重试；自动重试只发生在运行时对工具调用的受控循环内。

## 2. 改造前的主要问题

改造前的问答链路依赖模型自由选择工具和参数，主要风险集中在以下位置：

1. **工具选择不稳定**：泛化消息检索容易替代文件、朋友圈、收藏或账单专用工具，导致数据面正确但命中率低。
2. **调用时机不清**：模型可能在没有足够上下文时直接回答，也可能在证据已足够后继续重复检索。
3. **参数不可控**：中文日期、相对时间、数字范围和联系人别名经常未归一化，错误参数会被当作空结果。
4. **越权只能靠提示词**：会话内问答缺少执行期 `username` 硬锁，跨会话或知识库模式切换存在泄漏风险。
5. **失败与空结果混淆**：超时、限流、内部异常和真实无命中没有统一分类，用户和审计日志难以区分。
6. **证据不可溯源**：消息、知识库、聚合事实和资源没有统一稳定键，引用可能指向错误片段或无法回放。
7. **回答可能脱离证据**：没有统一的引用校验、数值核对和无证据降级，容易生成听起来合理但不可核对的内容。
8. **三个入口体验不一致**：各自的提示词、检索策略和异常兜底不同，同类问题在不同入口表现不同。

## 3. 统一运行时的具体改动

### 3.1 流程与意图识别

生产链路统一为：

```text
上下文归一 → 意图识别 → 工具循环 → 证据包 → 引用/资源映射 → 综合生成 → 接地复核
```

意图分类实现于
[`intent.ts`](../src/backend/wechat-data/src/query/answer-runtime/intent.ts)，覆盖
`lookup`、`aggregate`、`relation`、`timeline`、`content_media`、`open_qa` 和 `clarify`。
分类结果同时给出工具提示、时间范围、媒体类型、消息引用和实体线索，但**提示只影响排序**，
实际可执行工具仍由 profile 白名单决定。

**当前生产口径**：规则分类先跑；仅当规则置信度 `< 0.72` 或结果为 `clarify` 时，
运行时才通过注入的 `intentClassifier` 追加一次 LLM 复核。分类器默认复用同一
provider/model 的 `runChat`，有独立的 4 秒 deadline（传 `0` 表示关闭）。
LLM 返回经 `isValidIntentSuggestion` 形状校验后，统一交给
`applyAnswerIntentSuggestion` 保守合并：规则高置信时只允许补空字段，低置信/澄清时才允许
改 `kind`，且不能绕过 profile 白名单与范围守卫。超时、异常、非法返回分别回退规则并记录
`classifier:llm_timeout` / `classifier:llm_failed` / `classifier:llm_invalid`，
正常合并记录 `classifier:llm_done`。三个 profile 共用这条链路，ClawBot 仍是 `kb-only`。

工具循环结束、证据包构建完成后，运行时还会按问题语义计算必需数据域
（`messages/kb/files/favorites/moments/records/contacts`），对仍缺失且本 profile 允许的
域最多补一个专用工具；补查同样经过白名单、参数修复、deadline 与重试。这样避免泛化消息
检索命中后模型提前收尾，把文件、收藏、朋友圈或账单漏掉。

对明确的资源词（朋友圈、收藏、文件、转账/红包、联系人）增加确定性工具提示，减少模型把
专用查询退化成泛化消息检索的机会。空问题或缺少必要目标时返回“需要澄清”，而不是用空参数
扫全库。




### 3.2 范围与参数

[`profiles.ts`](../src/backend/wechat-data/src/query/tools/profiles.ts) 中的
`enforceProfileScope` 是执行前的最后一道门。它负责校验“请求是否允许执行”，与最终
“回答是否成功”是两套状态口径：

- 白名单外工具返回 `tool_not_allowed`；
- `session-ask` 缺少当前会话返回 `scope_required`，模型改写会话返回 `scope_violation`；
- 模型未填会话时注入服务端锁定值，不把显示名当作 username；
- `get_message_context` 的消息 key 必须属于锁定会话；
- 固定日期范围注入所有声明 `from` / `to` 的工具，冲突或倒序直接拒绝；
- `search_hybrid` 的 mode 在契约内校验，`session-ask` 自动收敛到 `messages`；
- `clawbot-auto` 缺少 `kbId` 时在运行时入口直接收敛为 `blocked`；即使绕过入口，
  执行守卫仍以 `not_configured` 拒绝工具调用。配置层另有对称的硬门禁：
  `query/clawbot/clawbot-config-invariant.ts` 的 `resolveInstanceConfigForSave` /
  `hasValidAutoReplyKnowledgeBase`，保证 UI、决策、网关三层不会各自解释“无库”的含义。

上述拒绝都属于**请求安全阻断**，验收时统一要求 `requestStatus=blocked`、最终
`answerStatus=blocked`，且不得改写成普通工具失败（`failed`）或空结果
（`insufficient`）。`requestStatus=accepted` 只表示没有越过安全边界，不代表后来一定
有答案或一定成功。

[`arguments.ts`](../src/backend/wechat-data/src/query/answer-runtime/arguments.ts) 负责参数归一
和可解释修复：中文日期与相对日期、数字范围、枚举别名、实体/会话解析、必填项与类型校验。
修复只做确定性转换；无法安全修复时进入 `needs_clarification`，不静默改成空查询或换一个会话。

### 3.3 工具循环

[`tool-loop.ts`](../src/backend/wechat-data/src/query/answer-runtime/tool-loop.ts) 的默认预算为：

- 最多 4 轮模型调用；
- 每轮最多 6 个工具调用；
- 单工具执行 deadline 20 秒；
- 首轮未调用工具时最多执行 3 个确定性兜底工具；
- 相同工具名加规范化参数的调用去重并复用结果；
- 回放给模型的结果只保留有界摘要，避免长正文撑爆上下文。

循环在每一轮检查取消信号、调用上限和证据状态。工具选择阶段只拿到范围规则，不直接拿到
原始证据；证据只在工具结果和最终综合阶段使用。这样既减少提示词注入面，也避免模型把
工具结果中的文本当成新指令。

### 3.4 重试与异常分类

[`errors.ts`](../src/backend/wechat-data/src/query/answer-runtime/errors.ts) 按错误类别设置
不同的重试预算：

| 错误类别 | 最多尝试次数 | 处理方式 |
|---|---:|---|
| `timeout` | 2 | 有界指数退避，记录 `deadlineExceeded` |
| `rate_limited` | 2 | 优先遵守 `retryAfterMs`，无值时有界退避 |
| `transient` | 3 | 仅对无副作用的工具重试 |
| `invalid_arguments` | 1 | 不重试，先修复参数或要求澄清 |
| `not_found` | 1 | 不重试，按真实无命中处理 |
| `scope_blocked` / `unauthorized` | 1 | 立即阻断，不通过重试绕开边界 |
| `internal` | 1 | 记录失败来源，进入降级/失败，不重复副作用 |

取消信号可以唤醒退避等待，避免用户取消后仍要等完整睡眠时间。重试次数、耗时、错误类别、
工具名和参数摘要都会进入脱敏 trace。每次工具尝试还会拿到独立的 `AbortController`：
deadline 触发时 abort 当前尝试，用户取消时同时传播到 `ToolContext.signal`，使已经开始的
数据库或网络 I/O 有机会尽快停止，而不是只在运行时侧停止等待。

`sideEffectTools` 已作为 profile 契约保留，供未来加入写操作时禁止自动重放；当前三个
入口的问答工具均为只读，因此没有副作用工具参与这轮自动重试。

### 3.5 证据收敛与可溯源

[`evidence.ts`](../src/backend/wechat-data/src/query/answer-runtime/evidence.ts) 把工具结果统一为
证据包，而不是直接把原始 JSON 交给模型：

- 消息证据键为 `msg:<username>:<localId>`；
- 知识库证据键为 `kb:<kbId>:<chunkId>`；
- 聚合事实使用稳定 slug，资源使用独立 `resource` locator；
- 同一证据被多个工具命中时合并并保留工具来源；
- 畸形 `hits` / `facts` 整条拒绝并计入统计，不进入引用列表；
- 按分数、时间和稳定键排序，再执行条数与字符预算；
- 最终状态区分 `ok`、`degraded`、`insufficient`、`failed`、`blocked` 和
  `needs_clarification`。

证据包构建还承担**输出侧边界复核**，不依赖工具是否自觉遵守范围：

- `session-ask` 只接受属于当前 `username` 的消息证据；跨会话消息、非消息来源和无法
  验证归属的统计事实会被拒绝；
- `clawbot-auto` 只接受 `source === 'kb'` 且带合法 `kbId/chunkId` 的命中；其他
  `kbId`、消息、资源与聚合事实会被拒绝；
- 被拒绝的条数计入 `stats.rejectedCount`，原因去重后写入 `rejectionNotes`；范围错误
  工具计入 `scopeBlockedResults`；
- 一旦证据包状态为 `blocked`，运行时不会进入综合生成，并清空 `citations/resources`，
  避免把已经检索到的合法片段与越界内容混合后出网。

状态口径统一如下：

| 场景 | 请求状态 | 最终回答状态 |
|---|---|---|
| 工具正常执行但没有任何命中/事实 | `accepted` | `insufficient` |
| 有可用证据，但部分工具失败或结果畸形 | `accepted` | `degraded` |
| 工具全部失败且没有可用证据 | `accepted` | `failed` |
| 会话/来源越权、缺少必需知识库 | `blocked` | `blocked` |
| 参数无法安全修复 | `accepted` | `needs_clarification` |

矩阵中每格通过 `statusSelector` 指定最终状态取值：普通格直接断言 `answerStatus`；
工具失败/超时/畸形结果等格按“有证据取 `answerStatus`，无证据取 `fallbackStatus`”
执行。纯空结果不是失败，也不能报成 `blocked`；工具全失败且无证据必须如实报
`failed`，不能与“没有命中”混为一谈。

资源证据不会伪装成消息引用。文件、收藏、朋友圈和账单各自保留资源键与可执行动作，前端
只展示后端给出的脱敏摘要，不把内部凭据拼成可疑链接。

### 3.6 回答接地与展示

最终综合阶段要求普通问答使用 `[n]` 引用证据；ClawBot 和纯资源回答不保留无意义的引用角标。
接地复核会检查回答中的数值和引用是否能在证据包中找到；高风险但无依据的数值会被撤回或
替换为证据格式化文本。综合生成失败时保留证据和引用，状态降为 `degraded`，而不是返回一段
看似完整的幻觉回答。

ClawBot 作为无人值守出网通道还有发送前门禁：只有 `ok/degraded`、实际使用知识库材料、
回答非空且没有 `withheld` 的结果才可发送；每条引用必须属于当前 `kbId`，且必须是规范
`kb:<kbId>:<chunkId>` 键。综合生成失败、没有引用、引用归属不明或降级结果仍有未核实数值，
一律不发送并记录可诊断原因。该检查位于网关发送前，不能靠提示词绕过。

前端通过
[`AskRuntimeMeta.tsx`](../src/client/ui-wechat/src/client/pages/wechat-data/panels/AskRuntimeMeta.tsx)
展示状态、脱敏工具 trace、证据包和独立资源卡；旧后端没有新增字段时整块不渲染，保持兼容。
资源卡的打开动作见
[`resource-card.tsx`](../src/client/ui-wechat/src/client/pages/wechat-data/panels/resource-card.tsx)。

### 3.7 ClawBot 运行详情回看

ClawBot 自动回复除了最终消息，还会把每次 run 的可诊断摘要写入
`clawbot_reply_run.result_json`。老库通过 `ALTER TABLE ADD COLUMN` 补齐这一列，
读取时若列尚不存在仍按旧列集合工作，不影响升级前的消息列表。

摘要由
[`clawbot-run-detail.ts`](../src/backend/wechat-data/src/query/clawbot/clawbot-run-detail.ts)
统一白名单序列化：保留状态、工具调用（含尝试次数/重试/错误类别与参数摘要）、证据、
引用、资源定位、接地统计和发送门禁；不保存回答正文，定位字段中的 URL/token/seed 不落库。
单条详情有 64KB 总预算、40 条数组上限和字符串截断，坏 JSON、循环引用或旧行解析失败时
降级而不抛给消息列表。

消息接口
[`attachReplyRunDetails`](../src/backend/wechat-data/src/query/clawbot/clawbot-db.ts)
按入站 `target_message_id` 与出站 `sent_message_id` 分块批量查询，把同一 run 同时附到
目标入站消息和所有出站分段，避免逐条 N+1。成功、生成失败、配置跳过、空答案、outbox
保存失败和发送失败都会留下对应 `sendDecision`；`send:false` 仍保留已生成的工具/证据/
引用摘要，用户能看到“为什么没发”。

前端
[`clawbot-run-detail.tsx`](../src/client/ui-wechat/src/client/pages/wechat-data/panels/clawbot-run-detail.tsx)
按 `runId` 去重渲染：同一 run 优先挂在入站目标消息下，只附在出站分段时挂到第一条分段；
旧消息或非法 `runId` 不伪造详情，无字段时不渲染空壳。

## 4. 目标效果（非实测结论）

| 维度 | 目标 |
|---|---|
| 理解准确 | 明确资源词、时间词和多轮指代进入正确的意图与工具提示，减少泛化检索替代专用查询 |
| 范围安全 | 会话内问答和 ClawBot 的越权请求在执行前阻断，跨会话泄漏目标为零（待实测） |
| 结果可靠 | 工具失败与真实无命中分离，超时/限流有界重试，内部错误不伪装成空结果 |
| 可溯源 | 每条消息、知识库和资源证据都有稳定键、定位信息和来源工具 |
| 抗幻觉 | 引用、数值和状态经过接地复核；无证据时不生成可被误认为事实的结论 |
| 体验一致 | 三个入口共享状态、trace、证据和资源展示结构，差异只来自数据边界 |

上表描述设计目标。除异常矩阵和确定性守卫外，质量类目标仍需固定评测集验证；当前不能
把“目标”表述为“已达成”。

## 5. 验收标准

机器可读契约见
[`acceptance-matrix.json`](../src/backend/wechat-data/tests/acceptance/answer-runtime/acceptance-matrix.json)。
它覆盖三个 profile × 六类异常：`empty`、`tool_error`、`tool_timeout`、`scope_violation`、
`invalid_arguments`、`malformed_result`。每格同时写明 `requestStatus`（请求安全门禁）、
`answerStatus`（有可用证据时的回答状态）、`fallbackStatus`（无证据时的最终状态）、
`statusSelector`（本格如何取得 `finalStatus`）、证据状态和验收说明。

质量门槛：

| 指标 | 门槛 | 性质 |
|---|---:|---|
| 意图/范围准确率 | ≥ 0.92 | 离线评测集门槛 |
| 会话跨范围泄漏 | 0 | 硬性契约 |
| 工具 Top-1 准确率 | ≥ 0.90 | 离线评测集门槛 |
| 参数校验通过率 | ≥ 0.99 | 硬性回归门槛 |
| 参数自动修复率 | ≥ 0.80 | 离线评测集门槛 |
| Recall@20 相对提升 | ≥ 0.15 | 相对改造前基线 |
| MRR 相对提升 | ≥ 0.10 | 相对改造前基线 |
| 聚合 SQL parity | ≥ 0.99 | 确定性对照 |
| 引用准确率 | ≥ 0.95 | 抽样人工核对 |
| 高风险无依据数值率 | ≤ 1% | 接地复核 |
| 零证据编造 | 0 | 硬性契约 |
| 指代消解准确率 | ≥ 0.90 | 离线评测集门槛 |
| 六类异常覆盖 | 100% | 矩阵元测试 |
| 工具循环 p95 | ≤ 1,500ms | 不含模型生成时间 |
| 延迟相对回归 | ≤ 10% | 相对改造前基线 |
| ClawBot 引用违规 | 0 | 硬性契约 |
| 证据键稳定性 | 100% | 重复运行一致性 |
| profile 白名单精确性 | 100% | 代码与矩阵逐项一致 |

**口径说明（关键）**：上表是**质量门槛已定义**，不是“已经实测达成”。目前仓库没有固定
离线评测集、标注数据或自动评测脚本；Recall@20、MRR、意图/范围准确率、工具 Top-1、指代
准确率、引用准确率和延迟 p95 都没有可复核的实测结果。定向 Vitest 通过只证明确定性契约，
不等同于这些统计阈值通过。只有评测集跑完并保留结果后，才能在本文或发布说明中写“已达成”。

其中只有 `sixAnomalyCoverage` 由矩阵元测试检查“18 格齐全”，`profileWhitelistExactness`
有 profile 白名单单测支撑；它们也不等于三个入口在真实问题集上的质量已经通过。

矩阵中的 `thresholdEvaluation.status` 固定为 `not-measured`；已知但尚未由运行时实现的
目标或待同步测试写在 `knownRuntimeGaps`，而不是用空的 `pendingRuntime` 掩盖。

交付验收还必须满足：

1. 三个 profile 的白名单与矩阵逐项一致；越权工具在执行前返回 `tool_not_allowed`，
   最终状态为 `blocked`。
2. 会话内问答的任何跨会话路径都返回 `scope_violation`，不存在“先检索再过滤”，
   最终状态必须为 `blocked` 而不是 `failed`。
3. 所有工具失败都进入 trace，区分空结果、超时、限流、内部错误和参数错误；纯空结果为
   `insufficient`，工具全部失败且无证据为 `failed`。
4. 每条可引用消息和知识库片段都能通过稳定键回放到原始证据；SessionAsk 的 msg key 必须
   属于当前 `username`，ClawBot 的引用必须是当前 `kbId` 下的合法知识库键。
5. 普通问答没有 `[n]` 引用时不得标记为 `ok`；ClawBot 不输出无意义角标。
6. 综合生成异常时保留证据并降级，不丢失已经检索到的可用内容。
7. ClawBot 发送前必须逐条校验引用属于当前 `kbId` 且为规范知识库键；缺少知识库、
   综合生成失败、`withheld` 或空答案都不得出网。
8. ClawBot 的 `autoReply=true` 必须同时满足 `kbEnabled=true` 和 `kbId>0`。设置页在缺少
   有效知识库时禁用自动回复开关；配置保存拒绝“显式开启但无库”，并在知识库被关闭或清空时
   自动关闭已有的自动回复，避免留下必然不发送的矛盾状态。

## 6. 实施与验证记录

本次交付的确定性守卫包括：

- [`answer-runtime-foundations.spec.ts`](../src/backend/wechat-data/tests/answer-runtime-foundations.spec.ts)
- [`answer-runtime-intent.spec.ts`](../src/backend/wechat-data/tests/answer-runtime-intent.spec.ts)
- [`answer-runtime-tool-loop.spec.ts`](../src/backend/wechat-data/tests/answer-runtime-tool-loop.spec.ts)
- [`answer-runtime-runtime.spec.ts`](../src/backend/wechat-data/tests/answer-runtime-runtime.spec.ts)
- [`answer-runtime-malformed.spec.ts`](../src/backend/wechat-data/tests/answer-runtime-malformed.spec.ts)
- [`answer-runtime-evidence-trace.spec.ts`](../src/backend/wechat-data/tests/answer-runtime-evidence-trace.spec.ts)
- [`ask-runtime-orchestrator.spec.ts`](../src/backend/wechat-data/tests/ask-runtime-orchestrator.spec.ts)
- [`ask-tool-profiles.spec.ts`](../src/backend/wechat-data/tests/ask-tool-profiles.spec.ts)
- [`content-tools-resources.spec.ts`](../src/backend/wechat-data/tests/content-tools-resources.spec.ts)
- [`acceptance-matrix.spec.ts`](../src/backend/wechat-data/tests/acceptance/answer-runtime/acceptance-matrix.spec.ts)
- [`clawbot-boundary.spec.ts`](../src/backend/wechat-data/tests/acceptance/answer-runtime/clawbot-boundary.spec.ts)
- [`scope-evidence.spec.ts`](../src/backend/wechat-data/tests/acceptance/answer-runtime/scope-evidence.spec.ts)
- [`tool-contracts.spec.ts`](../src/backend/wechat-data/tests/acceptance/answer-runtime/tool-contracts.spec.ts)
- [`ask-runtime.wiring.spec.ts`](../src/client/ui-wechat/src/client/pages/wechat-data/panels/ask-runtime.wiring.spec.ts)
- [`ask-runtime-meta.spec.ts`](../src/client/ui-wechat/src/client/pages/wechat-data/panels/ask-runtime-meta.spec.ts)
- [`resource-card.spec.ts`](../src/client/ui-wechat/src/client/pages/wechat-data/panels/resource-card.spec.ts)
- [`revoked-content.spec.ts`](../src/client/ui-wechat/src/client/pages/wechat-data/panels/revoked-content.spec.ts)
- [`avatar.spec.ts`](../src/client/ui-wechat/src/client/pages/wechat-data/panels/avatar.spec.ts)
- [`chats-edit-revoked.wiring.spec.ts`](../src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-edit-revoked.wiring.spec.ts)
- [`media-video-md5.spec.ts`](../src/backend/wechat-data/tests/media-video-md5.spec.ts)
- [`media-file-resolve.spec.ts`](../src/backend/wechat-data/tests/media-file-resolve.spec.ts)

建议按以下顺序验证：

```powershell
npm run typecheck
npm run build:all
npm test
npm run check:backend
npm run check:types
```

再单独复跑运行时重点套件：

```powershell
npx vitest run src/backend/wechat-data/tests/answer-runtime-foundations.spec.ts src/backend/wechat-data/tests/answer-runtime-tool-loop.spec.ts src/backend/wechat-data/tests/answer-runtime-runtime.spec.ts src/backend/wechat-data/tests/answer-runtime-malformed.spec.ts src/backend/wechat-data/tests/answer-runtime-evidence-trace.spec.ts
npx vitest run src/backend/wechat-data/tests/answer-runtime-intent.spec.ts src/backend/wechat-data/tests/ask-runtime-orchestrator.spec.ts src/backend/wechat-data/tests/ask-tool-profiles.spec.ts
```

## 7. 残余风险与后续工作

- **质量指标仍需评测集**：本仓已有确定性异常矩阵和运行时守卫，但意图准确率、Recall@20、
  MRR、指代准确率和引用准确率需要固定问题集与人工/自动标注；在这些数据产出前，只能按
  “门槛已定义”交付，不能宣称数值目标已完成。
- **LLM 意图复核仍是残余风险**：低置信/澄清时已接入 LLM 复核，并有 4 秒 deadline、
  形状校验与保守合并；但尚未用固定评测集证明它相对纯规则带来稳定增益。分类器只能细化
  意图，不能绕过 profile 白名单或范围守卫，失败时必须回退规则。
- **质量阈值尚未实测**：`thresholdEvaluation.status` 仍为 `not-measured`。Recall@20、
  MRR、意图准确率、工具 Top-1、指代消解与 p95 延迟都只有门槛，没有可复核结果。
- **底层工具未普遍响应取消**：运行时已注入并 abort `ToolContext.signal`，但多数检索工具
  尚未把 signal 继续传给数据库/网络调用。deadline 仍能限制运行时等待时间，但底层 I/O
  可能要稍后才自行结束。
- **旧归档视频定位**：撤回面板已支持用 `media.md5`（或 `fileMd5`）在无 `username/local_id`
  时查询视频封面与实体；该路径依赖本机已存在对应封面或视频缓存。两者都没有时仍会明确
  提示“缺少视频定位信息”，不会伪造路径。
- **文件 MD5 消歧成本**：同名同大小的文件候选会读取内容计算哈希，比只做 `stat` 略慢；
  命中 `fileMd5` 后不会再按修改时间猜测其他文件。
- **真实客户端差异**：微信不同版本的消息表、资源路径和删除缓存结构可能不同；缺少数据时
  运行时返回 `insufficient` 或明确错误，不以空结果冒充“没有发生过”。
- **生成模型差异**：运行时把工具选择与证据收敛放在执行层，但最终措辞仍受模型影响；高风险
  问答应继续依赖接地复核和引用校验，不能只看回答是否流畅。

后续评测建议先建立三个 profile 各自的分层问题集（单轮查询、时间聚合、多轮指代、资源检索、
越权诱导、异常注入），再以同一批问题比较改造前后 Top-1、Recall@20、MRR、引用准确率和
p95 延迟；每次调整意图规则或工具描述都重跑矩阵，避免用单条演示替代整体验收。
