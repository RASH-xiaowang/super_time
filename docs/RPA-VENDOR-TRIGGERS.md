# 多 RPA 厂商可选触发方案（调研 + 设计）

> 状态：**已实现（2026-10-21）**：S0 抽象重构（Webhook / 八爪鱼迁入注册表 + 通用管道 +
> `listRpaVendors` + 描述符驱动 UI）+ **7 个适配器**（内置 `webhook` / `bazhuayu`，新增
> `yingdao` / `uipath` / `aliyun-rpa` / `laiye` / `shizai`）；其中 **`aliyun-rpa` / `laiye` /
> `shizai` 为实验性**（参数待联调，见第 6 节风险）。**回调接收端 / 完成状态轮询 / 入站触发为后续**
> （v1 只到「厂商已受理」，`externalTaskId` 落库供后续扩展）。旧任务行为不变。
> 2026-10-21 追加**八爪鱼附加参数**（`mapping.extrasField` 通用机制，隐私 v25）；同日
> **v1.2.0 移除内置三参数**（`mapping.targets: []` = extras-only，默认 `Params: {}`，参数全部由用户在「附加参数」里显式配置）。
> 调研/核对时间：**2026-10-21（Asia/Shanghai）**。参数、鉴权、回调的原始证据见第 5 节与各厂商小节内引用链接。
> 背景：任务信息此前只有 `Webhook` 与 `八爪鱼 RPA` 两种触发方式（见 [`TASK-CENTER.md`](TASK-CENTER.md)）。
> 本方案把它推广为「**统一触发方式选择 + 厂商适配器注册表**」：新增厂商不改核心派发逻辑，只加一份厂商描述。

**实现映射（2026-10-21）**

| 层 | 文件 | 内容 |
|---|---|---|
| 共享类型（公开） | [`../src/backend/wechat-data/src/types-rpa.ts`](../src/backend/wechat-data/src/types-rpa.ts) | `RpaVendorDescriptor` / `RpaField` / `RpaVendorCatalog` / `RpaTriggerConfig` 等（`build:types` 后给前端用） |
| 运行时契约 | [`../src/backend/wechat-data/src/query/rpa/types.ts`](../src/backend/wechat-data/src/query/rpa/types.ts) | `RpaVendorAdapter`、请求/响应、派发上下文（不进公开 d.ts） |
| 注册表 | `src/backend/wechat-data/src/query/rpa/registry.ts` | 内置 + 5 家厂商的适配器数组（顺序即 UI 顺序）+ `listVendorDescriptors` |
| 通用管道 | `src/backend/wechat-data/src/query/rpa/dispatch.ts` | 本域**唯一**出网函数 `sendRequest` + `dispatchRpaRecord`（主机白名单/鉴权/重试/解析） |
| 字段校验与渲染 | `src/backend/wechat-data/src/query/rpa/template.ts` | `defaultConfigFor` / `validateVendorConfig` / `missingReadyFields` / `renderRequest` 等 |
| 鉴权 | `src/backend/wechat-data/src/query/rpa/auth.ts` | bearer / header / token-exchange / custom（阿里云签名） |
| 厂商适配器 | `src/backend/wechat-data/src/query/rpa/vendors/` | `webhook` `bazhuayu` `yingdao` `uipath` `aliyun-rpa` `laiye` `shizai`，每家一个文件 |
| Remote | `src/backend/wechat-data/src/gateway-taskcenter.ts` | 新增 `listRpaVendors` / `revealTaskTriggerSecret`（`@Remote` 方法数 217 → **219**） |

> 隐私与文档口径：`PRIVACY_VERSION` 26、[`PRIVACY.md`](PRIVACY.md) 第四节 G3、
> [`TASK-CENTER.md`](TASK-CENTER.md) §3.5/§6；出网台账登记 `query/rpa/dispatch.ts#sendRequest`。
> 设计文档以下内容保留为**调研与设计依据**（不随实现状态更新而删除）。

---

## 0. 一句话结论

把「触发方式」从**硬编码分支**升级成**注册表 + 描述符（descriptor）驱动**的通用管道：
任务只保存 `triggerMethod = <厂商 id>` 与厂商参数，派发时按注册表找到厂商描述符，通用地完成
「校验参数 → 组装请求 → 鉴权/签名 → 发送 → 解析结果 → 记录状态」；厂商间的差异全部收敛在
一个**声明式描述符 + 可选钩子**里，UI 表单由描述符自动渲染，因此**新增厂商 = 新增一个文件 + 注册一行**。

调研覆盖 5 个主流厂商（影刀、实在智能、来也、UiPath、阿里云 RPA），另列已有八爪鱼与备选
Power Automate。按公开契约完整度与落地成本，建议优先级：

| 优先级 | 厂商 | 理由（详见第 2/5 节） |
|---|---|---|
| P0（首个新增） | **影刀 RPA** | 官方开放 API 契约最完整（端点/参数/回调/幂等/限流齐全），SaaS + 专有云 |
| P0（对照基线） | 八爪鱼 RPA（已有） | 已是现有实现；改造中作为「内置适配器 0」回归基线 |
| P1 | **UiPath Orchestrator** | 官方文档最完整、生态成熟；回调不可靠需轮询兜底；适合外企/混合云 |
| P1 | **阿里云 RPA** | 触发能力最全（回调+幂等+状态查询），但成本与 POC 不确定性最高 |
| P2 | **来也 RPA** | 主 OpenAPI 文档不公开（需商务索取）；公开 MCP 通道可先落地，回调契约缺失 |
| P2（联调后） | **实在智能 RPA** | 有公开开放 API，但**鉴权 header 名未公开**（接入 blocker）、无回调/无幂等 |
| 备选（实验性） | Microsoft Power Automate | 仅「预生成 SAS URL」可触发；无受支持的按 flowId 触发管理 API；无原生完成回调 |

---

## 1. 口径与范围

### 1.1 两种「触发方向」

「触发入口」在本方案里拆成两个独立方向，避免把两件事混成一个字段：

| 方向 | 含义 | 本方案处理 |
|---|---|---|
| **A. 出站（应用 → 厂商）** | 任务命中关键词后，本应用调用厂商官方 API 启动流程/机器人，再由厂商回调或本应用轮询确认完成 | **本次设计的主体**；5 家厂商都按这个方向给出参数清单与适配器形态 |
| **B. 入站（厂商 → 本应用）** | 厂商的机器人/流程主动调用本应用的触发入口（例如影刀的 Webhook 触发器、UiPath API 触发器的工作原理反过来） | 提供扩展位（§4.7）。注意：本应用**默认不监听任何端口**（`docs/PRIVACY.md` 第四节 H），入站能力必须挂在用户显式开启的局域网访问/打开网页通道上，默认关闭 |

> 为什么以出站为主：5 家厂商里只有影刀、UiPath 明确提供「给第三方一个 URL 触发其流程」的入站触发器；
> 实在、阿里云没有，来也只有时间/队列触发器。而「厂商调用我们」在厂商侧只是一个普通 HTTP 请求节点，
> **不依赖厂商专有能力**；真正因厂商而异的是**我们调用厂商**的参数、鉴权与回调。因此把 5 家厂商
> 做成「出站适配器 + 统一回调/轮询模型」，同时把入站作为独立的、可选的扩展方向，是对当前产品最稳的切法。

### 1.2 与现有实现的关系

| 现状 | 本方案 |
|---|---|
| `TaskTriggerMethod = 'webhook' \| 'bazhuayu'`，`task-center-callback.ts` 里 `if (webhook) … else if (bazhuayu) …` | `triggerMethod: string`（内置 `webhook` + 注册表里的厂商 id）；派发走**一个**通用管道 |
| `bazhuayu_flow_id` / `bazhuayu_api_key` 专用列 | 通用列 `trigger_config`（非敏感 JSON）+ `trigger_secret`（敏感 JSON；默认不回读，桌面端本机可经 `revealTaskTriggerSecret` 按需回读）+ `trigger_vendor_version` |
| 编辑抽屉里两段硬编码表单 | 描述符驱动的**动态表单**（字段/必填/示例/默认/分组都来自 descriptor） |
| 隐私版本与出网点逐个人工登记 | 描述符必须声明 `hosts`/`contentOutbound`/`docs`，由守卫测试强制登记进 `PRIVACY.md` 与出网台账 |

现有 `webhook` 与 `bazhuayu` 会迁移为注册表里的两个内置条目，**用户可见行为不变**（见 §7 迁移计划）。

### 1.3 术语

- **厂商描述符（descriptor）**：一份可序列化的声明，描述某厂商的触发参数、鉴权、请求模板、响应解析、完成通知方式、来源与风险。UI 与通用派发都读它。
- **适配器（adapter）**：描述符 +（仅在声明式表达不了时）少量代码钩子（如阿里云 HMAC-RPC 签名）。一个厂商一个文件。
- **统一触发管道（pipeline）**：与厂商无关的派发流程（校验→组包→鉴权→发送→解析→落状态）。
- **语义参数位**：任务触发记录里固定的三个业务值 `room`（会话名）、`content`（触发文本）、`at`（触发对象），由映射表映射到各厂商的参数名/容器。

---

## 2. 厂商对比与适用场景

### 2.1 总览

| 维度 | 影刀 RPA | 实在智能 RPA | 来也 RPA（机器人指挥官 V6.7） | UiPath Orchestrator | 阿里云 RPA |
|---|---|---|---|---|---|
| 部署形态 | SaaS（`api.yingdao.com`）+ 专有云（地址未公开给出） | SaaS（`z-commander-api.ai-indeed.com`）+ 私有化 | 企业版私有化（Docker；支持信创）为主 | SaaS（Automation Cloud）+ Standalone 私有化 | 公有云 SaaS + 线下部署；机器人分本地型/服务型 |
| 外部触发通道 | `POST /oapi/dispatch/v2/job/start`（单应用）/`/v2/task/start`（调度任务） | `POST /openAPI/v2/job/operation`（预建任务触发，since 1.8.0）/新增任务 `POST /openAPI/v1/job` | 公开：MCP `POST /automation/mcp`（`create_task`）；私有：OpenAPI（文档不公开） | `POST …/odata/Jobs/UiPath.Server.Configuration.OData.StartJobs`；或 API 触发器 URL | `POST /rpa/openapi/raas/task/CreateTask`（服务型）/`POST /rpa/openapi/task/createServiceTask`（本地型） |
| 鉴权 | AK/SK → Bearer token（2h） | `appKey`+`appSecret` 随 header（**header 名未公开**） | MCP 个人令牌 `rk-…`（Bearer）；OpenAPI：AppKey/Secret/UserKey（文档未公开） | PAT 或 OAuth2 client_credentials（Bearer） | AK/SK + HMAC-SHA1（RPC 签名，Version=20200430） |
| 完成回调 | 有；控制台全局配置、**无签名**、失败 24h 内每小时补偿 | **无**（只能轮询运行记录） | 有「事件推送地址」配置项，**payload/签名/重试契约未公开** | 有 Webhooks（HMAC-SHA256），但**不重试、不存储、失败即丢、会熔断** | 有 `CallbackUrl`；5s 超时、最多重试 3 次、**无签名** |
| 状态查询 | `/oapi/dispatch/v2/job/query`（正文未取证） | `work-execute/list` + `work-list` | `query_task_result`（MCP） | `GET /odata/Jobs({key})`（单作业不受限流） | `ListTasks` / `ListTaskDetails` |
| 幂等 | `idempotentUuid`（≤36，一次创建防重） | **无** | **无**（MCP） | **无**官方幂等键 | `X-Idempotent-Request-ID`（180s，非强制） |
| 限流 | job/start 10 次/秒；token 20 次/秒 | 未公开 | 未公开 | Jobs 列表按官方 rate-limits 页（与租户/版本相关）；**单作业 `GET /odata/Jobs({key})` 不受限流** | 未公开全局限 QPS；队列 100/机器人、1000/分组 |
| 公开契约完整度 | **高** | 中（鉴权头缺失为 blocker） | 低—中（主通道文档不公开，MCP 公开） | **高**（但 StartJobs 页无字段级必填表，需以实例 Swagger 为准） | 高（但官方示例自相矛盾，需 POC） |
| 适用场景 | 国内中小团队/电商等轻量 RPA；已有影刀控制台与机器人客户端 | 已采购实在控制器、私有化/信创、能接受轮询与联调 | 大型企业/政务信创、来也企业版客户、需要私有化与集中调度 | 外企/大型组织、已部署 Orchestrator、需要成熟 API 与 Webhook 体系 | 已采购阿里云 RPA（尤其服务型机器人/无影云电脑）的客户 |
| 建议 | **P0 首个新增** | P2（先联调确认鉴权 header） | P2（先商务拿集成指南） | **P1** | P1（POC 后） |

### 2.2 逐家说明

**影刀 RPA** — 配置门槛低（控制台建 AK/SK、选机器人/分组、填应用 uuid），官方把「异步 + 回调 + 轮询建议 + 幂等 + 限流」都写清楚了；缺点是两个高风险点：回调**无签名**（只能当信号，必须用查询接口二次确认）与**专有云地址未给**（base URL 必须可配）。适合作为第一个落地厂商：契约完整、有 SaaS 公网、失败面可控。

**实在智能 RPA** — 有完整的任务/运行记录模型，但官方只写 `appKey/appSecret`「随 header 传递」而**未给 header 字段名**，且无回调、无幂等。适合「已购实在控制器、能接受轮询、愿意先联调」的客户；不适合作为默认开箱即用选项。

**来也 RPA** — 企业版私有化能力强（Docker + 信创），但英文公开的 OpenAPI 创建任务接口文档被官方移除（要求联系销售获取），当前**唯一可公开落地**的是 v6.7 的 MCP 服务（`/automation/mcp`，`create_task`/`query_task_result`，参数表完整）；回调只有「事件推送地址」配置项，payload/签名/重试均未公开。适合「愿意走商务 + 联调、仍希望私有化」的客户。

**UiPath** — 公开文档最完整：OData `StartJobs`、PAT/OAuth2、权限、限流、Webhook 签名都有原文；API 触发器还提供「给第三方一个 URL」的入站形态。代价是 Webhook **明确不可靠**（不重试/不存储/失败即丢/熔断 1 小时），必须落 `Job.Key` + 轮询补偿。适合外企、已有 Orchestrator 的客户。

**阿里云 RPA** — 触发能力最全（CreateTask + CallbackUrl + 状态查询 + 幂等头），但：不是标准阿里云 OpenAPI（`console-rpa.aliyun.com` + HMAC-SHA1 + `Version=20200430`）；服务型/本地型是两套大小写敏感的 API；官方请求示例自相矛盾（body vs query 签名）；回调无签名；成本 5,000 元/机器人授权/年起 + 编辑器授权。适合已有阿里云 RPA 采购的客户。

**Microsoft Power Automate（备选）** — 外部只能说 POST「预生成的 SAS 触发器 URL」；官方明确 `api.flow.microsoft.com` 不受支持、管理连接器无 Run Flow；桌面流必须云端流中转；无原生完成回调；SAS 轮换只能浏览器 DevTools 手工做。只建议「实验性/第二阶段」，不作为默认选项。

---

## 3. 各厂商触发参数清单

> 每节两张表：
> **(a) 厂商 API 请求参数（官方原文口径）** —— 只写官方页出现过的字段；官方没写的必填/类型/默认值一律标「未标注」或「未取得官方原文」，不臆造。
> **(b) 本产品的触发方式配置字段** —— 用户在编辑抽屉里要填的内容（这才是落入 `trigger_config`/`trigger_secret` 的键）。
> 两家客户端的差异（SaaS/私有化）在「默认值」列体现为可配置 base URL。

### 3.1 八爪鱼 RPA（现有实现，迁移基线；v1.3.0 协议修正）

- 通道：`POST https://api-rpa.bazhuayu.com/api/v1/bots/scheduling/start`，固定主机。
- 鉴权：`X-API-Key: <API Key>`（官方 API Key 文档推荐）；官方也接受 `Authorization: Bearer <API Key>`。
- Body 字段（官方 **camelCase**）：`flowId`、`flowContentRetrievalMode`（固定 `ByNewestContent`）、`params`（可选；默认 `{}`，内容全部由「附加参数」逐条配置）。**可选字段留空时不发**（不再发送 `SpecifiedPublicationVersion` / `SpecifiedBot` / `UserStartSource`）。
- 成功响应：HTTP **200**，返回 `{ flowId, flowProcessNo }` → `flowProcessNo` 落到触发记录的 `external_task_id`（供后续轮询扩展）。
- 失败响应：常见 HTTP **400**，body 带 `{ code, description, requestId }`；界面「失败原因」展示 **HTTP 状态 + 厂商 `description`**（如 `身份凭证无效，请重新登录`，**不含本地凭据**）。
- 重试：**不自动重试**（接口无幂等键，避免同一个流程被重复启动）；失败由人工在触发记录里「重新投递」。
- 回调：无（HTTP 200 只代表「已受理启动」，执行结果需到八爪鱼控制台查看）。
- 迁移：`triggerMethod='bazhuayu'`，`trigger_config={flowId, extraParams}`（**v1.2.0 丢弃旧 `paramMap`**），`trigger_secret={apiKey}`；升级后默认不发送任何业务参数，需要旧行为（会话名/触发文本/触发对象）可在附加参数里各加一条恢复。

> **2026-10-21 v1.3.0 修正**：旧实现的 `POST /api/bots/scheduling/start`（**少了 `/v1`**）不是公开接口路径，对端会按未认证返回 **HTTP 401「身份凭证无效，请重新登录」**；旧 body 的 PascalCase（`FlowId` / `Params`）也不符合官方契约。v1.3.0 已按官方文档修正 URL、鉴权头（`X-API-Key`）与 camelCase body，并把 `flowProcessNo` 落库、失败时展示厂商 `description`。

**（b）本产品配置字段**（v1.2.0 起无内置参数；v1.3.0 协议修正）

| 显示名 | 配置键 | 类型 | 必填 | 默认 / 示例 | 说明 |
|---|---|---|---|---|---|
| FlowId | `flowId` | string | 是 | `6ad859ccee2df270d53fc6e5` | 控制台流程详情复制；不是凭据，随任务列表返回 |
| API Key | `apiKey` | secret | 是 | — | 只存本机 `trigger_secret`，投递时进 **`X-API-Key`** 请求头，**不参与参数** |
| 附加参数 | `extraParams` | paramList | 否 | 空 | **唯一参数入口**：最多 **20 条**「参数名 → 值来源」；值来源 11 种（见 §4.3）；默认 `params: {}`，要发什么就配什么 |

**来源与核对（2026-10-21 在线核对）**：
[机器人调度-启动单个应用](https://rpa.bazhuayu.com/helpcenter/features/enterprise/api/robot-scheduling-start-single) ·
[API Key](https://rpa.bazhuayu.com/helpcenter/features/enterprise/api/api-key) ·
[授权](https://rpa.bazhuayu.com/helpcenter/features/enterprise/api/authorization) ·
[Webhook 触发器](https://rpa.bazhuayu.com/helpcenter/features/enterprise/api/webhook-trigger)。

### 3.2 影刀 RPA（建议 P0）

**触发 API**：`POST https://api.yingdao.com/oapi/dispatch/v2/job/start`（单应用；另有 `/v2/task/start` 调度任务）。
**鉴权**：先 `GET https://api.yingdao.com/oapi/token/v2/token/create?accessKeyId=…&accessKeySecret=…` 换 `accessToken`（最大 2 小时，`expiresIn` 秒，不要自定缓存）；调 API 带 `Authorization: Bearer <token>`。

**（a）API 请求参数（官方原文）**

| 参数 | 必填 | 类型 | 示例 | 默认 | 说明/约束 |
|---|---|---|---|---|---|
| `robotUuid` | **是** | string | `73d9a119-7ec7-4226-b679-506afefae667` | — | 应用 uuid（控制台-应用管理-应用详情） |
| `accountName` | 否（与 `robotClientGroupUuid` 二选一） | string | `admin@fckj` | — | 机器人账号名；两者都填以分组为准 |
| `robotClientGroupUuid` | 否（二选一） | string | — | — | 机器人分组（UUID） |
| `idempotentUuid` | 否 | string | `69ba7c82-…` | — | 幂等 uuid，≤36 位；重复请求只成功创建一次 |
| `waitTimeoutSeconds` | 否 | number | `600` | `600` | 排队超时秒；60–950400 |
| `runTimeout` | 否 | number | — | — | 应用运行超时秒；60–950400；**需客户端 5.10+** |
| `priority` | 否 | string | `middle` | `middle` | 排队优先级（枚举值页未取证） |
| `executeScope` | 否 | string | `any` | — | 仅分组生效：`any` 随机一个 / `all` 全部 |
| `params[]` | 否 | object[] | 见下 | — | 应用入参；合计建议 ≤8000（专有云 6.0.0 前 3000） |
| `params[].name` | 否 | string | `room_name` | — | 参数名（须与 RPA 应用入参名一致） |
| `params[].value` | 否 | string | `10` | — | 参数值 |
| `params[].type` | 否 | string | `str` | — | 参数类型（枚举值页未取证） |

**（b）本产品配置字段**

| 显示名 | 配置键 | 类型 | 必填 | 示例 | 默认 |
|---|---|---|---|---|---|
| 服务地址 | `baseUrl` | string | 是 | `https://api.yingdao.com` | 同左（专有云改专有地址） |
| AccessKeyId | `accessKeyId` | secret | 是 | `ak-…` | — |
| AccessKeySecret | `accessKeySecret` | secret | 是 | — | — |
| 应用 UUID | `robotUuid` | string | 是 | `73d9a119-…` | — |
| 机器人账号 | `accountName` | string | 二选一 | `admin@fckj` | — |
| 机器人分组 UUID | `robotClientGroupUuid` | string | 二选一 | — | — |
| 参数映射 | `paramMap` | map | 否 | `room_name/content/at_name` | 同左（可改成自己应用的入参名） |

**回调（应用运行回调）**：控制台「api 配置」全局配置；请求头仅 `Content-Type: application/json`，**无签名/Token**；payload 含 `jobUuid/dataType/status/msg/startTime/endTime/robotClient*/robotName/idempotentUuid/result[]`；返回 2xx 停止补偿，非 2xx 连续重试 3 次 + 24 小时内每小时补偿；官方建议按 `jobUuid` 幂等、并用查询接口轮询兜底（job/start 后建议 2 分钟级轮询）。
**限制**：job/start 10 次/秒；回调是全局单点配置，不能按任务区分目的地。
**来源与核对**（2026-10-21；官方帮助中心为 SPA，用无头浏览器渲染读取，页面未标版本号）：
[启动应用运行](https://www.yingdao.com/yddoc/rpa/zh-CN/710488569666060288)；
[启动任务](https://www.yingdao.com/yddoc/rpa/zh-CN/710492920473436160)；
[鉴权](https://www.yingdao.com/yddoc/rpa/zh-CN/710499792859115520)；
[应用运行回调](https://www.yingdao.com/yddoc/rpa/zh-CN/710484124829691904)；
[任务运行回调](https://www.yingdao.com/yddoc/rpa/zh-CN/710489613909069824)；
[Webhook 触发器](https://www.yingdao.com/yddoc/rpa/zh-CN/818374413316812800)；
[限流说明](https://www.yingdao.com/yddoc/rpa/zh-CN/912893828744491008)。
**风险**：high｜回调无鉴权（只当信号）；high｜开通门槛（社区有「只有企业版才可调 API?」未获官方答复）与专有云地址未给 → base URL 可配；medium｜`waitTimeout` 即将作废、`runTimeout` 依赖客户端 5.10+、参数体积按版本分档。

### 3.3 实在智能 RPA（P2，先联调）

**触发 API**：推荐「预建任务 + 每次触发」`POST https://z-commander-api.ai-indeed.com/openAPI/v2/job/operation`（since 1.8.0，返回 `works[].workUuid`）；降级 `PUT /openAPI/v1/job/{jobUuid}/{operation}`；新建任务 `POST /openAPI/v1/job`。
**鉴权**：`appKey` + `appSecret`「随 header 传递」——**官方未给 header 字段名**（实测未登录响应也不提示）。

**（a）API 请求参数（官方原文，v2/job/operation）**

| 参数 | 必填 | 类型 | 示例 | 默认 | 说明/约束 |
|---|---|---|---|---|---|
| `jobUuid` | **是** | string | `UADACDSKKAKSDLLAL` | — | 预建任务 UUID |
| `operation` | **是** | integer | `1` | — | 1 立即/再次执行；2 停止；3 强制停止；4 删除 |
| `inputParam` | 否 | object | `{"room_name":"…"}` | — | 任务入参；受流程「引用参数/模板」约束，键名须与流程一致 |

**（a′）新建任务 `POST /openAPI/v1/job` 关键参数**

| 参数 | 必填 | 类型 | 示例 | 默认 | 说明 |
|---|---|---|---|---|---|
| `jobName` | **是** | string | `测试任务` | — | 最长 30 字符 |
| `processDetailUUID` | **是** | string | `UADACDSKKAKSDLLAL` | — | 流程版本 UUID |
| `executeType` | **是** | integer | `2` | — | 2=立即执行，9=定时 |
| `inputParam` | 否 | object | `{"param1":"value1"}` | — | 机器人任务入参 |
| `priority` | 否 | integer | `1` | `2`（中） | 1 高 / 2 中 / 3 低 |
| `distributionType` | 否 | integer | `2` | `1`（自动分配） | 2=指定 bot，需 `botList` |
| `processChannel` | 否 | integer | `"1"` | `0` | 0 流程管理 / 1 企业市场（since 1.7.3.1） |

**（b）本产品配置字段**

| 显示名 | 配置键 | 类型 | 必填 | 示例 | 默认 |
|---|---|---|---|---|---|
| 服务地址 | `baseUrl` | string | 是 | `https://z-commander-api.ai-indeed.com` | 同左（私有化改私有地址） |
| AppKey | `appKey` | secret | 是 | — | — |
| AppSecret | `appSecret` | secret | 是 | — | — |
| 任务 UUID | `jobUuid` | string | 是（模板式） | `UADACDSKKAKSDLLAL` | — |
| 参数映射 | `inputParamMap` | map | 是 | `room_name/content/at_name` | 同左（键名须与流程引用参数一致） |
| 优先级 | `priority` | select(1/2/3) | 否 | `2` | `2` |
| 分配方式 | `distributionType` | select(1/2) | 否 | `1` | `1`（自动） |

**回调**：无（平台接口文档无回调；「消息中心」只有站内消息）。**状态查询**：`POST /openAPI/work-execute/list`（时间窗）与 `POST /openAPI/v1/work-list`（`workUuids`），两套状态枚举（运行记录 `-2/-1/1/2/3/4/5/6/8`；任务 `1–5`）。
**来源与核对**（2026-10-21；核心接口页「发刊日期 2023/08/22」，页面无更新记录）：
[API 授权](https://rpa-college.ai-indeed.com/doc/2475.html)、
[任务管理](https://rpa-college.ai-indeed.com/doc/2477.html)、
[流程管理](https://rpa-college.ai-indeed.com/doc/2476.html)、
[控制器简介](https://rpa-college.ai-indeed.com/doc/521.html)、
[消息中心](https://rpa-college.ai-indeed.com/doc/77.html)。
**风险**：high｜鉴权 header 名缺失（blocker，必须联调确认）；high｜无回调 + 无幂等（重试会重复建任务/重复执行 → 适配器禁止 POST 自动重试）；medium｜`inputParam` 受流程模板约束、接口能力随控制器版本（1.7.3.1 / 1.8.0）变化、文档较旧。

### 3.4 来也 RPA（P2，先商务/联调）

**触发通道**：①（目标形态）机器人指挥官 **OpenAPI 创建任务**——官方文档**不公开**（发行说明原文要求联系销售）；②（公开可落地）**MCP 服务** `POST {基址}/automation/mcp`，工具 `create_task` / `query_task_result` / `get_task_templates`。
**鉴权**：MCP 个人令牌 `Authorization: Bearer rk-{CompanyOpenId}-{randomString}`（有效期未公开，可重置/删除，重置即失效）。

**（a）MCP `create_task` 参数（官方原文，v6.7）**

| 参数 | 必填 | 类型 | 示例 | 默认 | 说明/约束 |
|---|---|---|---|---|---|
| `flowName` | **是** | string | `finance_report_flow` | — | 流程名 |
| `assignType` | **是** | string | `automatic` | — | `automatic` / `designate` |
| `workerName` | 否 | string | `"0"` | — | 指定分配时的机器人名 |
| `workerGroupName` | 否 | string | `财务机器人组` | — | 自动分配时的机器人组 |
| `count` | 否 | integer | `1` | `1` | 1–100 |
| `departmentName` | 否 | string | `Laiye Tech` | — | 用户多部门时必填 |
| `priority` | 否 | string | `high` | `middle` | high/middle/low |
| `isRecord` | 否 | boolean | — | 依组织配置 | 是否录屏 |
| `hasMaxRunningTime` | 否 | boolean | — | `false` | 是否启用最大运行时长 |
| `maxRunningTime` | 否 | integer | — | — | 分钟 |
| `validityDays` | 否 | integer | — | `30` | 任务有效期（天） |
| `parameters[]` | 否 | array | — | — | 每项含 `parameterName/parameterType/parameterValue`；类型 string/number/boolean；**暂不支持凭据类型参数** |

**（b）本产品配置字段**

| 显示名 | 配置键 | 类型 | 必填 | 示例 | 默认 |
|---|---|---|---|---|---|
| Commander 基址 | `baseUrl` | string | 是 | `https://rpa.example.com:8182` | — |
| 个人访问令牌 | `token` | secret | 是 | `rk-abc123-a1b2…` | — |
| 流程名 | `flowName` | string | 是 | `finance_report_flow` | — |
| 分配方式 | `assignType` | select | 是 | `automatic` | `automatic` |
| 机器人/组 | `workerName`/`workerGroupName` | string | 否 | — | 空 |
| 参数映射 | `parameterMap` | map | 是 | `room_name/content/at_name` | 同左 |

**回调**：管理后台「系统设置 → 应用设置 → 事件推送地址」（6.3.0+）；V6.2 发行说明列出 Webhook 事件（任务已开始/已完成等），但 **payload/签名/重试契约未公开**。**状态查询**：MCP `query_task_result`（`taskId`，状态 pending/running/completed/failed/cancelled/stopped/expired）。
**来源与核对**（2026-10-21；文档站页头 `V6.7`）：
[MCP 服务](https://documents.laiye.com/automation-commander/docs/MCP)、
[触发器](https://documents.laiye.com/automation-commander/docs/Trigger)、
[任务](https://documents.laiye.com/automation-commander/docs/任务)、
[队列](https://documents.laiye.com/automation-commander/docs/队列)、
[系统设置（事件推送地址）](https://documents.laiye.com/user-center/docs/ManagementPlatform/SystemSetting)、
[V6.2 发行说明](https://documents.laiye.com/automation-commander/docs/V6.2.0.2311/)、
[历史应用管理（V6.0.0.2211）](https://documents.laiye.com/automation-commander/docs/V6.0.0.2211/应用管理)。
**风险**：high｜OpenAPI 创建任务契约未公开（需商务索取 + 联调）；high｜回调契约缺失（只能轮询兜底）；medium｜无入站 API 触发器（仅时间/队列触发器）；medium｜版本差异大（6.0→6.7 菜单与端点多次变化）；medium｜MCP 响应需二次/三次 JSON 解析、示例域名带 8182 端口。

### 3.5 UiPath Orchestrator（P1）

**触发 API**：`POST {AutomationCloudURL}/{organizationName}/{tenantName}/orchestrator_/odata/Jobs/UiPath.Server.Configuration.OData.StartJobs`。
**鉴权**：PAT（`Authorization: Bearer <PAT>`；仅本地用户，撤销后缓存 1 小时）或 OAuth2 外部应用（client_credentials，令牌端点 `https://cloud.uipath.com/{org}/identity_/connect/token`，`expires_in=3600`，无 refresh）；权限 `Jobs.Create`；新式文件夹需传 `X-UIPATH-OrganizationUnitId`（或 `X-UIPATH-FolderKey`/`X-UIPATH-FolderPath`/`X-UIPATH-FolderPath-Encoded`）。

**（a）StartJobs 请求参数（官方示例可证；官方**无字段级必填表**，未标注者不臆造）**

| 参数 | 必填 | 类型 | 示例 | 默认 | 说明/约束 |
|---|---|---|---|---|---|
| `startInfo` | 未标注（所有示例均用） | object | `{"ReleaseKey":…}` | — | 包装对象 |
| `startInfo.ReleaseKey` | 未标注（示例均含） | string(GUID) | `795cbab2-8008-4a54-b1cb-f9ff1ece139e` | — | 指定流程版本 |
| `startInfo.Strategy` | 未标注 | string | `All` / `Specific` / `ModernJobsCount` | — | 仅见这三个值；`All` 不适用于新式文件夹 |
| `startInfo.RobotIds` | 未标注（`Specific` 时） | int[] | `[121]` | — | 指定机器人 |
| `startInfo.JobsCount` | 未标注 | int | `0` / `1` | — | 与 `ModernJobsCount` 同用 |
| `startInfo.NoOfRobots` | 未标注（仅 `All` 示例） | int | `0` | — | — |
| `startInfo.InputArguments` | 未标注（示例出现） | string（JSON 文本） | `"{\"age\":33}"` | — | **必须序列化为字符串**；总长 ≤10,000 字符 |
| `startInfo.ProcessKey`/`Reference`/`JobPriority`/`ResumeOnSameContext` | **未取得官方原文** | — | — | — | 需按客户实例 Swagger 核对，首版不使用 |
| 文件夹头（header） | 未标注（新式文件夹必需） | header | `X-UIPATH-OrganizationUnitId: 770643` | — | 四选一 |

**（b）本产品配置字段**

| 显示名 | 配置键 | 类型 | 必填 | 示例 | 默认 |
|---|---|---|---|---|---|
| 部署形态 | `deployment` | select(cloud/onprem) | 是 | `cloud` | `cloud` |
| AutomationCloudURL | `baseUrl` | string | 是 | `https://cloud.uipath.com` | 同左 |
| 组织 / 租户 | `organizationName` / `tenantName` | string | 是（cloud） | `myorg` / `mytenant` | — |
| 文件夹 | `folderKey` | string | 是 | `6ea73196-…` | —（优先 FolderKey，FolderId 会随许可变化） |
| 流程 ReleaseKey | `releaseKey` | string | 是 | `795cbab2-…` | — |
| 鉴权方式 | `authMode` | select(pat/oauth) | 是 | `pat` | `pat` |
| PAT | `pat` | secret | pat 时必填 | — | — |
| OAuth client_id/secret/scope | `clientId`/`clientSecret`/`scope` | secret/string | oauth 时必填 | `OR.Default` | — |
| Strategy / JobsCount | `strategy` / `jobsCount` | select/int | 否 | `ModernJobsCount` / `1` | `ModernJobsCount` / `1` |
| 参数映射 | `inputArgumentsMap` | map | 是 | `room_name/content/at_name` | 同左 |

**回调（Orchestrator Webhooks）**：`job.completed`/`job.faulted`/`job.stopped` 等；`X-UiPath-Signature: Base64(HMAC-SHA256(secret, rawBody))`；**官方明确不重试/不存储/失败即丢、失败熔断 1 小时、连续 7 天 >50% 失败自动禁用**。**失败/丢失兜底**：用返回的 `Job.Key` 轮询 `GET /odata/Jobs({key})`（单作业不受限流）。
**来源与核对**（2026-10-21；文档通道 Automation Cloud · latest，页面无最后更新时间）：
[作业请求](https://docs.uipath.com/orchestrator/automation-cloud/latest/api-guide/jobs-requests)、
[构建 API 请求](https://docs.uipath.com/orchestrator/automation-cloud/latest/api-guide/building-api-requests)、
[身份验证方法](https://docs.uipath.com/automation-cloud/automation-cloud/latest/api-guide/authentication-methods)、
[PAT](https://docs.uipath.com/automation-cloud/automation-cloud/latest/api-guide/personal-access-tokens)、
[外部应用 OAuth](https://docs.uipath.com/automation-cloud/automation-cloud/latest/api-guide/accessing-uipath-resources-using-external-applications)、
[Webhooks](https://docs.uipath.com/orchestrator/automation-cloud/latest/user-guide/about-webhooks)、
[事件类型](https://docs.uipath.com/orchestrator/automation-cloud/latest/user-guide/types-of-events)、
[限流](https://docs.uipath.com/orchestrator/automation-cloud/latest/api-guide/rate-limits)、
[API 触发器](https://docs.uipath.com/orchestrator/automation-cloud/latest/user-guide/api-triggers)、
[管理 API 触发器](https://docs.uipath.com/orchestrator/automation-cloud/latest/user-guide/managing-api-triggers)。
**风险**：high｜Webhook 不可靠（必须轮询补偿）；high｜StartJobs 无字段级必填表（需实例 Swagger 二次取证）；medium｜Cloud 与 Standalone 私有化 URL/租户头差异未取证（需客户实例联调）；medium｜PAT 不适用目录/SAML 用户 → 企业客户主推 OAuth 外部应用；medium｜InputArguments ≤10,000 字符、Jobs 列表限流 100/1,000 每分钟。

### 3.6 阿里云 RPA（P1，POC 后）

**触发 API（两套，大小写敏感，不可混用）**：
- 服务型：`POST https://console-rpa.aliyun.com/rpa/openapi/raas/task/CreateTask`（参数首字母大写）；
- 本地型：`POST https://console-rpa.aliyun.com/rpa/openapi/task/createServiceTask`（参数小写 `appId/appParams/clientId`）。

**鉴权**：AK/SK + 老版 RPC 签名（`HMAC-SHA1`、`SignatureVersion=1.0`、`Version=20200430`、`Format=json`、`SignatureNonce`、`Timestamp` ISO8601 UTC）；接口自定义参数也要参与加签。

**（a）CreateTask 请求参数（官方原文）**

| 参数 | 必填 | 类型 | 示例 | 默认 | 说明/约束 |
|---|---|---|---|---|---|
| `AppId` | **是** | String | `2e8e34bf-…` | — | 应用 ID（控制台-企业应用列表） |
| `AppParams` | 否 | Array of Json | `[{"name":"参数1","value":""}]` | — | 应用入参，最大 40KB |
| `AllocateMode` | 否 | String | `auto` | 空=auto | `auto` 自动分配 / `manu` 手动指定 |
| `PackId` | 否 | String | `bv2XPrDl` | 空=默认分组 | 配合 auto |
| `RobotId` | 否 | String | `11DC81…` | — | 配合 `AllocateMode=manu` |
| `TaskPriority` | 否 | Integer | `85` | **50** | 1–100，100 最高 |
| `CallbackUrl` | 否 | String | `http://example.callback.com/example` | — | 完整 http/https；仅 POST；最大重试 3 次 |
| `AppVersion` | 否 | String | `1.0.0` | 空=应用默认运行版本 | 空 / 具体版本 / `dynamic` |

**（b）本产品配置字段**

| 显示名 | 配置键 | 类型 | 必填 | 示例 | 默认 |
|---|---|---|---|---|---|
| 接口族 | `apiFamily` | select(service/local) | 是 | `service` | `service` |
| 服务地址 | `baseUrl` | string | 是 | `https://console-rpa.aliyun.com` | 同左（线下部署改控制台地址） |
| AccessKeyId / Secret | `accessKeyId`/`accessKeySecret` | secret | 是 | — | — |
| 应用 ID | `appId` | string | 是 | `2e8e34bf-…` | — |
| 应用版本 | `appVersion` | string | 建议必填 | `1.0.0` 或 `dynamic` | 空（有隐式版本漂移，建议强制填） |
| 分配方式 | `allocateMode` | select(auto/manu) | 否 | `auto` | `auto` |
| 机器人/分组 | `robotId`/`packId` | string | 否 | — | — |
| 优先级 | `taskPriority` | int(1-100) | 否 | `85` | `50` |
| 回调地址 | `callbackUrl` | string | 否 | `https://…/callback?token=…` | 空 |
| 参数映射 | `appParamsMap` | map | 是 | `room_name/content/at_name` | 同左 |

**回调**：RPA 服务端 POST，`Content-Type: application/x-www-form-urlencoded`（原文如此），body `taskId` / `taskStatus`（running/complete/terminated）/ `taskResult`（仅 complete，base64）；**无签名**，官方建议 https+token 放 query；超时 5s、最多重试 3 次，失败不再重发。**状态查询**：`ListTasks`、`ListTaskDetails`（TaskIds ≤10/次）。**幂等**：`X-Idempotent-Request-ID`（≤50 字符，180 秒，非强制）。
**来源与核对**（2026-10-21；多数页面「更新时间」为空）：
[CreateTask](https://help.aliyun.com/zh/rpa/developer-reference/createtask)、
[createServiceTask](https://help.aliyun.com/zh/rpa/developer-reference/createservicetask)、
[ListTasks](https://help.aliyun.com/zh/rpa/developer-reference/listtasks)、
[ListTaskDetails](https://help.aliyun.com/zh/rpa/developer-reference/listtaskdetails)、
[HTTP 调用说明](https://help.aliyun.com/zh/rpa/developer-reference/http-calling-method/)、
[集成服务型机器人](https://help.aliyun.com/zh/rpa/user-guide/integrated-service-robot)、
[调用限制](https://help.aliyun.com/zh/rpa/developer-reference/call-limits)、
[幂等调用](https://help.aliyun.com/zh/rpa/developer-reference/idempotent-call)、
[计费](https://help.aliyun.com/zh/rpa/product-overview/billing)、
[v3 停止服务](https://help.aliyun.com/zh/rpa/product-overview/v3-version-out-of-service-and-replacement-schedule)。
**风险**：high｜回调无签名（必须随机路径+token+`taskId` 比对+`ListTaskDetails` 二次核对）；high｜官方示例矛盾（body/query 签名位置、Python/Java 不一致、Content-Type 拼写错误）→ POC 前不能标「已支持」；medium｜两套 API 易混（大小写敏感）；medium｜成本与开通门槛高（5,000 元/机器人授权/年起 + 编辑器授权；服务型需无影云电脑 + 主账号授权）。

### 3.7 Power Automate（备选，实验性）

- 触发：`POST <预生成的 HTTP 触发器 URL>`（URL 含 `api-version=2016-06-01&sp=…&sv=1.0&sig=…`，SAS 即凭据）；请求体 JSON Schema 由流程作者定义；入站请求 120 秒上限；同步 Response 需流程里加 Response 动作。
- 鉴权：URL 内 SAS；或把触发器限制为租户用户后额外带 Bearer（audience 需精确匹配云区，如 `https://service.flow.microsoft.com/`）。
- 完成通知：**无原生回调**；可选「流程末尾 HTTP 动作回调我们」/ 轮询 run（无受支持 run 管理 API）。
- 幂等：无；重复 POST 会创建多个 run。
- 限制：管理 API `api.flow.microsoft.com` 不受支持；管理连接器只有 `List Callback URL`/`Get Flow` 等，**无 Run Flow**；SAS 轮换只能浏览器 DevTools 手工做；桌面流必须云端流中转、无人值守需 Process 计划、Windows 需无活动会话。
- 来源与核对（2026-10-21）：HTTP 触发器 OAuth <https://learn.microsoft.com/en-us/power-automate/oauth-authentication>（2026-04-29）；SAS 轮换 <https://learn.microsoft.com/en-us/power-automate/regenerate-sas-key>（2024-09-27）；限制 <https://learn.microsoft.com/en-us/power-automate/limits-and-config>（2026-07-18）；云端流调度桌面流 <https://learn.microsoft.com/en-us/power-automate/desktop-flows/trigger-desktop-flows>（2026-05-06）；管理连接器 <https://learn.microsoft.com/en-us/connectors/flowmanagement/>；不受支持的 API <https://learn.microsoft.com/en-us/power-automate/manage-flows-with-code>（2024-10-29）。
- 结论：**不纳入默认支持**；若目标客户大量使用 Power Platform，再按「流程末尾回调我们」落地。

### 3.8 入站方向：厂商提供的「第三方触发 URL」

| 厂商 | 入站触发器 | 参数传递 | 鉴权 | 说明 |
|---|---|---|---|---|
| 影刀 | 有：Webhook 触发器（管理文档 → 高级任务计划 → 触发事件），唯一 URL | Query/Header/Body 全部传给流程 | **无签名/Token**（URL 即密钥） | 仅 POST，收到立即返回、流程后台异步；能否启动 RPA 客户端应用未取得官方原文 |
| UiPath | 有：API 触发器 `…/orchestrator_/t/{folderKey}/{slug}` | 查询串 / 表单 / JSON body；`$callMode` 三种调用模式 | Bearer（PAT 或 OAuth） | 每租户 ≤1,000 个；待处理作业默认上限 10（最大 100）；可同步长轮询取结果 |
| 来也 | **无**（仅时间/队列触发器） | — | — | 只能由我们持有凭据主动调用 |
| 实在 | **未取得官方原文支持** | — | — | 平台接口文档无入站触发；机器人本地触发仅文件/热键/鼠标/邮件 |
| 阿里云 RPA | **无对外入站触发器** | — | — | 服务型仅 OpenAPI/MCP 调度；本地型人工/定时/接口触发（非入站 URL） |

> 若未来做「厂商机器人调用我们」的入站能力，建议**不按厂商做不同参数**：我们的入口固定为
> `POST /api/rpa/trigger/{channelToken}`，body 统一 `{taskKey, room, content, at, occurredAt, requestId}`；
> 厂商差异只在**鉴权头/签名校验**（`none`/`bearer`/`hmac-sha256`）与**响应形状**（同步结果或 202）。
> 该入口必须挂在用户显式开启的入站通道上（`docs/PRIVACY.md` §H），默认关闭。

---

## 4. 统一选择结构与扩展机制

### 4.1 设计原则

1. **声明式优先**：厂商差异用数据（描述符）表达；只有「阿里云 RPC 签名」「MCP 二次 JSON 解析」这类确实无法模板化的点，才在厂商文件里写钩子函数。
2. **核心不认识任何具体厂商**：通用管道只依赖描述符；`if (vendor === 'xxx')` 不进核心。
3. **凭据与配置分离**：`trigger_config`（可回读、非敏感）与 `trigger_secret`（默认不返回，仅桌面端本机可按需回读）分开存；列表/触发记录只显示「已配置」布尔。
4. **完成状态不靠猜**：每家声明 `completion.mode = callback | poll | none`；没有可靠回调的一律要轮询兜底。
5. **隐私/安全可登记**：描述符必须声明 `hosts`（出网目的地）与 `contentOutbound`，守卫测试强制逐家登记进隐私声明与出网台账。
6. **未知厂商不崩**：库里出现未注册/已停用的厂商 id → 该任务标记「触发方式不可用」，派发 skipped 并给可读原因，不参与自动重试。

### 4.2 数据模型（存储与共享类型）

```sql
-- v24 迁移（在 task_info 上）
ALTER TABLE task_info ADD COLUMN trigger_config TEXT NOT NULL DEFAULT '{}';       -- 非敏感配置 JSON
ALTER TABLE task_info ADD COLUMN trigger_secret TEXT NOT NULL DEFAULT '{}';       -- 敏感配置 JSON（默认不返回；桌面端本机可按需回读）
ALTER TABLE task_info ADD COLUMN trigger_vendor_version TEXT NOT NULL DEFAULT ''; -- 保存时 descriptor.version
-- 兼容窗口保留 bazhuayu_flow_id / bazhuayu_api_key 两列；写入双写、读取回退，v25 删除
```

```ts
/** 触发方式 id：内置 'webhook'，其余为注册表中的厂商 id（开放字符串，新增厂商不改类型）。 */
export type TaskTriggerMethodId = string

export interface TaskInfo {
  triggerMethod: TaskTriggerMethodId
  /** 非敏感配置（含已填充的默认值）；不含密钥。 */
  triggerConfig: Record<string, unknown>
  /** 只回「是否已配置」：字段名 → bool。 */
  triggerSecretSet: Record<string, boolean>
  /** 保存时的描述符版本；与当前注册表不一致时 UI 提示「厂商参数已更新，请复核」。 */
  triggerVendorVersion: string
  // …其余现有字段不变（callbackUrl 保留为 webhook 的内置配置别名，兼容期）
}

export interface TaskInfoInput {
  triggerMethod?: TaskTriggerMethodId
  /** 整体替换（缺省=沿用）。 */
  triggerConfig?: Record<string, unknown>
  /** 仅出现的键才覆盖；'' 表示清除该密钥；缺省=保留。 */
  triggerSecret?: Record<string, string>
}
```

```ts
/** 新增 1 个 Remote 方法（注册表即运行时目录，前端不打包厂商清单）。 */
@Remote('listRpaVendors')
listRpaVendors(): {
  items: RpaVendorDescriptor[]   // 可序列化描述符（不含任何密钥/钩子）
  registryVersion: string
}
```

### 4.3 厂商描述符（扩展的核心）

```ts
export interface RpaVendorDescriptor {
  /** 稳定 id，写入 task_info.trigger_method；永不复用。 */
  id: string
  name: string                 // 影刀 RPA
  vendor: string               // 厂商正式名
  version: string              // 描述符版本：参数/协议变更必须 bump
  builtin?: boolean            // 'webhook' / 'bazhuayu' 等内置条目
  docs: {
    home: string               // 厂商文档入口
    triggerApi: string         // 触发 API 文档
    lastVerifiedAt: string     // 参数核对时间（ISO date）
    pageVersion?: string       // 官方页版本/更新时间（拿不到就标注）
  }
  capabilities: {
    direction: 'outbound' | 'inbound' | 'both'
    synchronous: boolean       // 调用是否同步返回最终结果
    completion: 'callback' | 'poll' | 'none'
    idempotency: 'vendor-key' | 'none'
    deployment: Array<'cloud' | 'onprem'>
  }
  applicability: {
    scenarios: string[]        // 适用场景（对比页/选择页展示）
    limitations: string[]      // 已知限制（用于 UI 提示与文档）
  }
  /** 鉴权：声明式策略；custom 时由同文件 sign/auth 钩子实现。 */
  auth: {
    strategy: 'header' | 'bearer' | 'token-exchange' | 'hmac-rpc' | 'custom'
    fields: RpaField[]         // 凭据字段（secret）；token-exchange 声明换 token 模板
    exchange?: RpaRequestTemplate  // 影刀/UiPath OAuth 的换 token 请求
  }
  /** 本产品配置字段（UI 自动渲染；required 决定「标记已完善」）。 */
  fields: RpaField[]           // 非敏感：robotUuid/ReleaseKey/baseUrl/参数映射…
  /** 语义参数位映射到厂商容器的形状（2026-10-21：`mapField`/`targets` 均可为空 = extras-only）。 */
  mapping: {
    style: 'object' | 'nameValueArray' | 'nameValueTypeArray' | 'formParams' | 'jsonStringObject'
    /** 可选：参数映射字段（`type:'map'`，值 `{room,content,at}` 可逐项覆盖 defaultKey）；缺省 = 无映射。 */
    mapField?: string
    /** 可为空：`targets: []` 表示该厂商**没有内置语义参数**，参数全部走 `extrasField`（八爪鱼 v1.2.0）。 */
    targets: Array<{ semantic: 'room' | 'content' | 'at'; defaultKey: string; label?: string }>
    /** 可选：指向一个 `type:'paramList'` 字段；其条目追加到参数容器（targets 为空时容器只有这些条目）。 */
    extrasField?: string
  }
  request: {
    method: 'POST' | 'PUT'
    url: string                // 模板：${config.baseUrl}/oapi/dispatch/v2/job/start
    headers?: Record<string, string>
    body: unknown              // JSON 模板，占位符见 §4.4
  }
  response: {
    okHttpStatus: number[]     // 如 [200, 201]
    okPath?: string            // 业务码路径，如 code
    okValue?: number | string | boolean  // 业务码成功值，如 200 / 0 / true
    externalTaskIdPath?: string // 如 data.jobUuid / value[0].Key
    messagePath?: string
  }
  completion?: {
    callback?: { verify: 'hmac-sha256' | 'token-query' | 'none'; signatureHeader?: string }
    poll?: RpaPollSpec        // 轮询请求模板 + 状态映射 + 间隔/超时
  }
  retry: { maxAttempts: number; retryOn: Array<'network' | 'http-5xx' | 'http-429'> }
  governance: {
    contentOutbound: boolean
    hosts: string[]            // 出网主机白名单（含私有化自定义域名的校验规则）
    privacySection: string     // 隐私声明里的章节（如 'G3'）
  }
  risks: string[]              // 已知不稳定/缺失点（UI「厂商说明」与文档共用）
}
```

`RpaField` 是 UI 与校验共用的字段描述：

```ts
export interface RpaField {
  key: string
  label: string
  type: 'text' | 'password' | 'number' | 'boolean' | 'select' | 'map' | 'paramList'
  required: boolean
  secret?: boolean             // true → 存 trigger_secret；默认只回 configured 布尔（桌面端本机可按需回读）
  example?: string             // UI placeholder（示例值）
  defaultValue?: unknown       // 新任务预填
  options?: Array<{ value: string; label: string }>
  help?: string                // 一句话说明/限制
  advanced?: boolean           // 折叠在「高级」
  pattern?: string             // 校验正则（可序列化）
  /** 仅 type='paramList'：允许的值来源子集（缺省 = 全部 11 种；实验性厂商可收窄）。 */
  paramSources?: RpaParamSource[]
  /** 仅 type='paramList'：最多允许几条附加参数（缺省 50；八爪鱼 = 20）。 */
  maxItems?: number
}
```

### 4.3.1 附加参数机制（`mapping.extrasField`，2026-10-21 v25）

描述符可在 `mapping.mapField` + `mapping.targets` 之外声明 `extrasField`，指向一个
`type:'paramList'` 的配置字段（如八爪鱼 `extraParams`）。用户在表单里逐条配置
「参数名 → 值来源」，投递时由通用管道解析成最终字符串，**追加在语义参数之后**
（同一个参数容器；顺序 = 用户排列顺序）。若 `mapping.targets` 为空（八爪鱼 v1.2.0），
该容器**只含附加参数**（默认 `{}`），即「extras-only」形态。

```ts
export type RpaParamSource =
  | 'room' | 'content' | 'at'                 // 三个语义位（content 已过隐私闸）
  | 'taskName' | 'keyword' | 'triggeredAt'    // 触发记录/任务内置字段
  | 'chatType' | 'taskId' | 'recordId'
  | 'fixed' | 'template'                      // 固定值 / 自定义模板

export interface RpaParamEntry {
  name: string                    // 发到厂商的 key（须与对端入参名一致）；同列表唯一
  source: RpaParamSource
  fixedValue?: string             // source='fixed' 时必填（≤2048 字）
  template?: string               // source='template' 时必填（≤512 字）
}
```

**模板白名单**：只允许 `${record.chatName}` / `${record.targetName}` /
`${record.targetUsername}` / `${record.username}` / `${record.keyword}` / `${record.text}` /
`${record.chatType}` / `${record.triggeredAt}` / `${task.name}` / `${task.id}`；
**不允许 `${secret.*}` / `${config.*}` 或白名单外字段**（保存时校验报错）。模板只做字符串
插值 / 整值替换，不执行表达式。参数名 ≤64 字；附加参数条数 ≤`maxItems`（八爪鱼 20，
缺省 50）；空列表合法（等价于不发业务参数）。

> 该机制**通用**：其他厂商后续只需在描述符声明 `extrasField`（+ 一个 `paramList` 字段），
> 即可复用同一套表单与解析逻辑，核心管道无需改动。

**影刀描述符示例（节选，示意声明式表达力）**：

```ts
const yingdao: RpaVendorAdapter = {
  descriptor: {
    id: 'yingdao', name: '影刀 RPA', vendor: '影刀 RPA（YingDao，官网 yingdao.com）', version: '1.0.0',
    docs: { home: 'https://www.yingdao.com/yddoc/rpa/zh-CN/710488569666060288',
            triggerApi: '…/710488569666060288', lastVerifiedAt: '2026-10-21' },
    capabilities: { direction: 'outbound', synchronous: false, completion: 'callback', idempotency: 'vendor-key', deployment: ['cloud', 'onprem'] },
    auth: {
      strategy: 'token-exchange',
      fields: [{ key: 'accessKeyId', label: 'AccessKeyId', type: 'password', required: true, secret: true },
               { key: 'accessKeySecret', label: 'AccessKeySecret', type: 'password', required: true, secret: true }],
      exchange: { method: 'GET', url: '${config.baseUrl}/oapi/token/v2/token/create',
                  query: { accessKeyId: '${secret.accessKeyId}', accessKeySecret: '${secret.accessKeySecret}' },
                  // 响应字段名/嵌套以官方页为准（页面只明确「响应含 expiresIn」，未给完整 JSON 示例）→ 联调核对
                  tokenPath: '（待联调核对）', expiresPath: 'expiresIn', headerPrefix: 'Bearer ' },
    },
    fields: [{ key: 'baseUrl', label: '服务地址', type: 'text', required: true, defaultValue: 'https://api.yingdao.com' },
             { key: 'robotUuid', label: '应用 UUID', type: 'text', required: true, example: '73d9a119-…' },
             { key: 'accountName', label: '机器人账号', type: 'text', required: false, help: '与机器人分组二选一' },
             { key: 'robotClientGroupUuid', label: '机器人分组 UUID', type: 'text', required: false },
             { key: 'paramMap', label: '参数映射', type: 'map', required: false,
               defaultValue: { room: 'room_name', content: 'content', at: 'at_name' } }],
    mapping: { style: 'nameValueTypeArray', targets: [
      { semantic: 'room', defaultKey: 'room_name' }, { semantic: 'content', defaultKey: 'content' },
      { semantic: 'at', defaultKey: 'at_name' }] },
    request: {
      method: 'POST', url: '${config.baseUrl}/oapi/dispatch/v2/job/start',
      headers: { Authorization: '${auth.token}', 'Content-Type': 'application/json' },
      body: { robotUuid: '${config.robotUuid}',
              ...(/* accountName 或 group 二选一由通用渲染器处理 */ {}),
              idempotentUuid: '${invocation.idempotencyKey}',
              params: '${mapped.nameValueTypeArray}' },
    },
    response: { okHttpStatus: [200], okPath: 'code', okValue: 200, externalTaskIdPath: 'data.jobUuid', messagePath: 'msg' },
    completion: {
      callback: { verify: 'none' },  // 官方无签名 → 只当信号
      poll: { /* GET job/query 字段待补；官方未公开正文 → 首版仅回调信号 + 人工兜底 */ },
    },
    retry: { maxAttempts: 2, retryOn: ['network', 'http-5xx'] },
    governance: { contentOutbound: true, hosts: ['api.yingdao.com'], privacySection: 'G3' },
    risks: ['回调无签名，只能作为信号并用查询接口二次确认', '专有云地址需用户自填', '参数合计建议 ≤8000'],
  },
}
```

### 4.4 统一派发流水线（与厂商无关）

```text
任务触发记录（pending）
  → ① resolve(triggerMethod)        未注册/停用 → skipped + 可读原因
  → ② validate(descriptor.fields)   必填/类型/正则/秘密是否已配置 → 缺 → skipped「配置不完整」
  → ③ gate(record.text)             隐私闸（沿用 feature 'task_callback'；两种方式同一口径）
  → ④ render(descriptor.request)    模板上下文：config / secret / record / invocation / mapped
                                     （mapped = 语义参数 + extrasField 附加参数；targets 为空时
                                      只有附加参数，见 §4.3.1；占位符白名单，禁止 eval）
  → ⑤ auth(descriptor.auth)         header/bearer/token-exchange（通用 token 缓存，单飞）
                                     hmac-rpc/custom → 厂商文件内钩子
  → ⑥ send()                        统一 fetchWithRetry；重试策略来自 descriptor.retry；
                                     厂商支持幂等键时注入（影刀 idempotentUuid / 阿里云 X-Idempotent-Request-ID）
  → ⑦ parse(descriptor.response)    HTTP 状态 + 业务码 + 外部任务 id；成功/失败/可重试分类
  → ⑧ persist()                     callback_status / external_task_id / callback_error / attempt
  → ⑨ completion                    callback：只当信号 → 校验 → 用 poll 二次确认
                                     poll：按 RpaPollSpec 轮询（单作业/运行记录）→ 映射终态
                                     none：sent 即「已受理」，不代表执行成功（UI 文案要区分）
```

**模板占位符**（只允许这四个根，且只做「整值替换」或字符串插值，不执行表达式）：

| 根 | 示例 | 说明 |
|---|---|---|
| `${config.xxx}` | `${config.robotUuid}` | 非敏感配置 |
| `${secret.xxx}` | `${secret.apiKey}` | 密钥（只在 header/body 中使用，永不写日志） |
| `${record.xxx}` | `${record.chatName}` / `${record.text}` / `${record.targetName}` | 触发记录快照（text 已过隐私闸） |
| `${invocation.xxx}` | `${invocation.idempotencyKey}` | 本次派发标识（`taskId:recordId`） |
| `${mapped.xxx}` | `${mapped.object}` / `${mapped.nameValueArray}` | 按 `mapping.style` 生成的参数容器 |

**参数容器的 5 种形态**（覆盖本次 5 家厂商 + 八爪鱼）：

| style | 形态 | 厂商 |
|---|---|---|
| `object` | `{"room_name":"…","content":"…","at_name":"…"}` | 实在 `inputParam`（八爪鱼 `Params` 默认 `{}`，v1.2.0 起全部来自附加参数） |
| `nameValueArray` | `[{"name":"room_name","value":"…"}]` | 阿里云 `AppParams` |
| `nameValueTypeArray` | `[{"name":"room_name","value":"…","type":"str"}]` | 影刀 `params[]` |
| `jsonStringObject` | `"{\"room_name\":\"…\"}"`（JSON 文本再转义） | UiPath `InputArguments` |
| `formParams` | `room_name=…&content=…`（form-urlencoded） | 阿里云 POST body（若 POC 确认走 body） |

> 五种容器**都会在语义参数之后**追加 `mapping.extrasField` 解析出的附加参数
> （见 §4.3.1）：`object` 加对象键、数组形态加条目、`formParams` 加 `&name=value`；
> `targets` 为空时容器只含附加参数（八爪鱼 v1.2.0 = extras-only）；
> 描述符没声明 `extrasField` 的厂商行为不变。该机制通用，其他厂商后续只需声明字段即可。

### 4.5 选择结构（UI）

编辑抽屉里的「触发方式」从两段硬编码表单变成：

```text
触发方式   [ Webhook ▾ | 八爪鱼 RPA | 影刀 RPA | UiPath | 阿里云 RPA | … ]   ← 选项来自 listRpaVendors
  ↓ 选中厂商后，按 descriptor.fields 自动渲染（分组：账号与鉴权 / 流程与参数 / 高级）
[账号与鉴权]  AccessKeyId   [••••••]        AccessKeySecret [••••••]
[流程与参数]  应用 UUID     [________________] 示例：73d9a119-…
              参数映射      room_name / content / at_name（可改）
[高级]        服务地址、超时、回调地址、私有化地址（默认折叠）
   ↓
[厂商说明] 官方文档 · 参数核对时间 2026-10-21 · ⚠ 回调无签名，仅作信号
   ↓ 「标记已完善」按 descriptor.fields.required + secretSet 校验
任务行摘要：影刀 RPA · 73d9a119…（或 Webhook example.com / 八爪鱼 RPA · FlowId）
```

- **字段渲染**：`type` 决定控件；`secret` 决定密码框与「已配置，留空保持不变」占位；`defaultValue` 预填；`example` 作 placeholder；`help`/`risks` 展示在字段下方或厂商说明区。
- **必填校验**：前端用同一份 descriptor（来自 `listRpaVendors`）做本地校验；后端保存/标记已完善时用注册表再校验一次（前后端同一真源）。
- **未知/停用厂商**：任务行显示「触发方式不可用」，抽屉说明原因；不允许标记已完善；已有记录仍可查看。
- **描述符版本变化**：任务保存了 `triggerVendorVersion`；打开抽屉时若与当前版本不同 → 顶部提示「厂商参数已更新，请复核后再保存」，不静默改配置。

### 4.6 完成通知的统一模型

| 能力 | 设计 |
|---|---|
| `completion.mode='callback'` | 厂商回调只更新「信号」；**必须**用描述符声明的 `poll` 做二次确认（阿里云/影刀/UiPath 均如此），防伪造与漏单 |
| `completion.mode='poll'` | 按 `RpaPollSpec` 轮询（如 UiPath `GET /odata/Jobs({key})`、来也 `query_task_result`、实在 `work-list`）；指数退避 + 上限可配 |
| `completion.mode='none'` | 只到「已受理」；UI 文案必须写「已提交，执行结果需到厂商控制台查看」（八爪鱼/PA 属此类） |
| 回调接收端 | 应用默认**不监听端口**（PRIVACY §H）。实现时挂到用户显式开启的入站通道：`/api/rpa/callback/{vendorId}/{randomToken}`；保留 raw body 再验签（UiPath 需 HMAC-SHA256 原文；阿里云无签名 → 随机路径+token+taskId 比对+二次查询；影刀无签名 → 只当信号） |
| 幂等 | 回调按 `(vendorId, externalTaskId, status)` 幂等 upsert；同一记录重复回调不产生重复状态变更 |

> 若首版不做入站回调接收端（推荐），则所有厂商的完成状态先按「轮询兜底」实现；回调能力作为
> 第二阶段、依赖用户显式开启入站通道后再启用。

### 4.7 扩展机制：新增厂商要改什么、不改什么

**不改（核心逻辑）**：通用派发管道（§4.4）、存储结构、`listRpaVendors`、编辑抽屉 UI、任务行摘要、隐私版本机制。

**要加（一个厂商 = 一个目录文件 + 注册一行 + 登记两处）**：

```text
src/backend/wechat-data/src/query/rpa/
  types.ts                 # descriptor / field / template / poll 类型（共享契约，生成 d.ts）
  registry.ts              # 唯一注册表：显式 import + 数组（新增厂商只改这一行）
  dispatch.ts              # 通用管道；不认识任何具体厂商
  template.ts              # 占位符渲染、参数容器映射、校验
  vendors/
    webhook.ts             # 内置
    bazhuayu.ts            # 内置（迁移现有实现）
    yingdao.ts             # 新增厂商 = 本文件（descriptor + 可选 auth/sign/parse 钩子）
    uipath.ts
    aliyun-rpa.ts
    laiye.ts
    shizai.ts
```

**新增厂商 SOP**：

1. 在 `vendors/` 新建文件，导出 `RpaVendorAdapter`（descriptor 必填字段见 §4.3；标准 REST 无需写代码钩子）。
2. 在 `registry.ts` 的数组里加一行 import。
3. 在 `docs/PRIVACY.md` 登记该厂商出网主机与发送内容（隐私版本 +1，材料性变更）；`outbound-site-coverage` 台账新增登记（若通用管道只有一个出网函数，则登记该函数并在此声明主机清单）。
4. 在 `docs/TASK-CENTER.md`/本文件补该厂商的参数表与来源核对时间。
5. 跑守卫：`rpa-vendors.contract.spec.ts`（描述符完整性/唯一 id/字段校验/秘密字段声明/来源与风险字段非空）、请求快照测试、隐私/台账/文档守卫。
6. 若厂商有非标准签名/协议：在同文件写 `signRequest`/`parseResponse`/`buildBody` 钩子；**仍然不改核心**。
7. 界面无需改：`listRpaVendors` 自动带出，抽屉自动渲染新厂商。

**守卫（新增，防止静默失效）**：

```ts
// rpa-vendors.contract.spec.ts（示意）
for (const adapter of RPA_VENDORS) {
  expect(adapter.descriptor.docs.triggerApi).toMatch(/^https:\/\//)
  expect(adapter.descriptor.docs.lastVerifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(new Set(adapter.descriptor.fields.map(f => f.key)).size).toBe(adapter.descriptor.fields.length)
  for (const f of adapter.descriptor.fields) {
    if (f.required) expect(f.example !== undefined || f.defaultValue !== undefined).toBe(true)  // 必填必须有示例/默认
  }
  expect(adapter.descriptor.governance.hosts.length).toBeGreaterThan(0)
  // 厂商主机必须已登记进 PRIVACY.md；描述符的 risks/docs 不得为空
}
```

**变更边界**：厂商参数变化 → 只改该厂商文件并 bump `descriptor.version`（旧任务提示复核）；厂商下线 → 从注册表移除并保留 id 黑名单，旧任务显示「触发方式不可用」；新增标准厂商 → 上述 SOP，**核心 0 行改动**。

### 4.8 安全与隐私设计（必须与现有机制对齐）

| 项 | 设计 |
|---|---|
| 凭据 | 存 `trigger_secret`（与现有八爪鱼 API Key 同口径：本机 DB）；**默认不返回**，列表 / 触发记录只回 `triggerSecretSet`；**桌面端本机**可按需回读原文（`revealTaskTriggerSecret`：远程 HTTP 通道 `LOCAL_ONLY` 拒绝、不写日志 / 不留痕、关闭抽屉即丢弃）；日志/错误信息脱敏（不含凭据） |
| 出网目的地 | 描述符声明 `hosts`；通用管道校验 `url` 的 host 在允许清单内（固定域名或 `*.厂商域` 模板）；私有化自定义 base URL 需用户显式勾选「私有化地址」并受「禁止 localhost/私网」默认策略约束（与现有 Webhook 的 http/https 口径衔接） |
| 隐私版本 | 新增厂商=新增内容出网点 → `PRIVACY_VERSION` +1 并重新同意；同意屏出网清单补「任务触发（Webhook / 你选择的 RPA 厂商）」，具体主机以 `docs/PRIVACY.md` G3 为准 |
| 出网台账 | 通用管道只有一个 `fetch` 调用点；台账登记该点，并在 `why` 里说明「主机来自注册表描述符，逐家已登记隐私声明」；新增厂商触发 `outbound-site-coverage` 的注册表一致性守卫（描述符 hosts ⊆ 隐私文档） |
| 幂等/重试 | 仅 `idempotency='vendor-key'`（影刀/阿里云）允许网络/5xx 自动重试；`none`（实在/来也/UiPath/PA）默认**不自动重试**，失败留给人工「重新投递」；重试前先查本地派发记录防重复 |
| 入站 | 默认不监听；仅在用户显式开启「局域网访问」后挂回调/触发端点；每厂商鉴权策略独立，无签名厂商的 payload 不得直接写业务状态 |

### 4.9 迁移计划（分阶段，可回滚）

| 阶段 | 内容 | 风险 |
|---|---|---|
| **S0 抽象重构** | 把现有 `webhook`/`bazhuayu` 迁进注册表；存储加通用列并双写；`listRpaVendors` 上线；UI 改为描述符驱动但只显示这两个内置项；契约测试/快照测试 | 需保证行为逐字节一致；用现有 task-center 单测 + E2E 回归 |
| **S1 影刀** | 新增 `yingdao` 适配器（token 缓存、幂等键、回调信号+轮询兜底） | 官方回调无签名；专有云地址自填 |
| **S2 UiPath** | `uipath` 适配器（PAT/OAuth2、文件夹头、StartJobs、Job.Key 轮询） | Webhook 不可靠 → 轮询兜底必做；Cloud/On-Prem 差异 |
| **S3 阿里云** | `aliyun-rpa`（先 POC 打通签名位置；服务型优先） | 官方示例矛盾；成本/开通门槛 |
| **S4 来也** | 先 MCP 通道（公开契约），OpenAPI 待商务文档 | 回调契约缺失 → 轮询 |
| **S5 实在** | 联调确认鉴权 header 后接入 | header 名缺失是 blocker；无幂等 |
| **S6（可选）入站** | 统一触发入口 + 厂商鉴权适配（影刀/UiPath 的入站触发器思路反过来） | 需用户开启入站通道；默认关闭 |
| 备选 | Power Automate（实验性，SAS URL） | 无管理 API/无回调/许可门槛 |

---

## 5. 调研来源、官方版本与核对时间

> 核对时间均为 **2026-10-21（Asia/Shanghai）**。页面版本/更新时间为官方页可见标识；「无」= 页面未标注。
> 第三方来源只用于补缺并标注「需官方核对」；未取得官方原文的字段在第 6 节风险表逐条列出。

| 厂商 | 官方文档入口 | 官方页版本/更新时间 | 本次核对结论 |
|---|---|---|---|
| 影刀 RPA | 帮助中心 `yingdao.com/yddoc/rpa/zh-CN/…`（启动应用/启动任务/鉴权/回调/Webhook 触发器/限流 共 7 页） | 页面未标注版本/更新时间（SPA，用无头浏览器渲染读取） | 端点、参数表、回调、限流均有官方原文；专有云地址未给出；社区关于「仅企业版」的问题无官方答复 |
| 实在智能 | 实在学院 `rpa-college.ai-indeed.com/doc/…`（API 授权/任务管理/流程管理/控制器/消息中心） | 核心接口页「发刊日期 2023/08/22」；站点无更新记录 | 端点/参数/轮询有原文；**鉴权 header 名缺失**；无回调/无幂等 |
| 来也 RPA | `documents.laiye.com`（机器人指挥官 V6.7：MCP/触发器/任务/队列；用户中心系统设置；发行说明 V6.2；历史 V6.0.0.2211） | 文档站页头 **V6.7**；发行说明 V6.2.0.2311 | MCP 通道参数表完整；OpenAPI 创建任务文档官方不公开（要求联系销售）；回调契约未公开 |
| UiPath | `docs.uipath.com` Automation Cloud · latest（Jobs/API 构建/鉴权/PAT/OAuth/Webhooks/事件/限流/API 触发器）；Standalone 2023.10 站存在 | 通道标 **Automation Cloud · latest**；页面无最后更新时间 | StartJobs/鉴权/Webhook 签名/限流有原文；StartJobs 无字段级必填表；私有化 URL 差异未取证 |
| 阿里云 RPA | `help.aliyun.com/zh/rpa/…`（开发参考/集成服务型机器人/计费/v3 停止服务等 21 页） | 多数页面「更新时间」为空；产品线 v4（v3 已于 2024-12-31 停止服务） | CreateTask/createServiceTask/回调/幂等/状态查询有原文；官方示例自相矛盾；回调无签名 |
| Power Automate（备选） | `learn.microsoft.com/en-us/power-automate/…`（HTTP 触发器 OAuth/SAS 轮换/限制/桌面流/管理连接器/不受支持 API） | 页面更新时间 2024-09-27 ～ 2026-08-31（逐页记录） | SAS URL 触发/限制有原文；无受支持 run 管理 API；无原生回调 |

**证据强度分级**：①官方原文直读（来也/UiPath/阿里云/PA 的多数页面）；②官方 SPA 渲染后读取（影刀；页面无版本号）；③官方目录/发行说明间接证据（来也 OpenAPI 存在性、实在入站能力缺失）；④第三方来源（仅补缺，均标注「需官方核对」，未作为设计依据）。

---

## 6. 参数不稳定 / 信息缺失风险总表

| 厂商 | 级别 | 风险/缺失 | 设计缓解 |
|---|---|---|---|
| 影刀 | high | 回调**无签名/Token**（请求头仅 Content-Type） | 回调只当信号；以查询接口二次确认；回调入口随机路径 + 已知 jobUuid 校验 |
| 影刀 | high | 专有云地址未给出；「API 是否仅企业版」无官方答复 | `baseUrl` 必填可配；文档/UI 标注「需企业管理员开通 API，专有云地址向厂商获取」 |
| 影刀 | medium | `waitTimeout` 即将作废；`runTimeout` 需客户端 5.10+；参数体积按专有云版本分档 | 不使用 `waitTimeout`；参数合计 >8000 时提示截断/文件方案；记录客户端最低版本 |
| 实在 | **high** | **鉴权 header 字段名缺失**（官方只写「随 header 传递」） | 适配器默认禁用/标「待联调」；联调确认前不承诺可用 |
| 实在 | high | 无回调、无幂等：超时重试会重复建任务/重复执行 RPA | `retry.maxAttempts=1`；重试须人工确认；预建任务 + 运行记录软去重 |
| 实在 | medium | `inputParam` 受流程「引用参数/模板」约束；两套状态枚举；接口随控制器版本变化 | 参数键名可配置（不固定三字段）；状态映射两套；标注最低版本 1.8.0（v2 触发） |
| 来也 | **high** | OpenAPI 创建任务契约不公开（官方要求联系销售） | 首版只走公开 MCP 通道；OpenAPI 等商务文档 + 联调；禁止按 MCP 参数臆造 OpenAPI |
| 来也 | high | 回调契约（payload/签名/重试）未公开 | 回调不作为唯一完成信号；`query_task_result` 轮询兜底 |
| 来也 | medium | 无入站 API 触发器（仅时间/队列）；版本差异大（6.0→6.7） | 不做入站承诺；适配器绑定最低版本 + 客户实例联调 |
| UiPath | **high** | Webhook 不重试/不存储/失败即丢/熔断 1 小时/连续 7 天 >50% 失败自动禁用 | 落 `Job.Key` + `GET /odata/Jobs({key})` 轮询补偿；回调只当信号 |
| UiPath | **high** | StartJobs 官方页无字段级必填/类型/默认值；部分字段未取得原文 | 首版只用官方示例可证字段；上线前按客户实例 Swagger 二次核字段 |
| UiPath | medium | Cloud vs Standalone 私有化 URL/租户头差异未取证；PAT 不适用目录/SAML 用户 | 部署形态分支 + OAuth 外部应用优先；私有化单独联调 |
| UiPath | medium | InputArguments ≤10,000 字符；Jobs 列表限流 100/1,000 每分钟；`$top`≤100 | 长文本截断/走 QueueItem；轮询单作业端点（不受限） |
| 阿里云 | **high** | 回调无签名；body 仅 taskId/status/result，可伪造/重放 | 随机路径 + token + taskId 与本地派发记录比对 + `ListTaskDetails` 二次核对 |
| 阿里云 | **high** | 官方示例自相矛盾（body vs query 签名；Python/Java 不同；Content-Type 拼写错误） | **POC 前不标「已支持」**；POC 清单：签名参数位置、POST body 是否参与签名、回调编码 |
| 阿里云 | medium | 服务型/本地型两套 API 大小写敏感、易混；`AppVersion` 默认语义多处冲突 | 配置显式 `apiFamily`，参数名由适配器映射（不让用户填）；首版强制填版本 |
| 阿里云 | medium | 成本/开通门槛高（授权 5,000 元/年起 + 编辑器；服务型需无影云电脑 + 主账号授权） | 定位「已有阿里云 RPA 客户的可选项」，不做零成本承诺 |
| PA | high | SAS URL 即凭据，轮换只能浏览器手工；无受支持 run 管理 API；无原生回调 | 存 URL 加密/脱敏；不做自动轮换；首版只承诺「触发成功/失败」 |
| PA | high | 许可门槛（premium + Process 计划 + Windows 机器）；桌面流需云流中转 | 标注「实验性/备选」；文档写清客户侧前置条件 |
| 全厂商 | medium | 厂商文档普遍无版本号/更新时间（影刀/实在/阿里云部分页面） | 每个适配器记录 `lastVerifiedAt` + 页面版本/发行说明；上线前复查；参数版本化并在任务上提示复核 |
| 全厂商 | medium | 私有化/区域差异（专有云、私有化地址、中国区） | `baseUrl` 可配 + 部署形态字段 + 联调 checklist |

**上线门槛（POC checklist，任何厂商进入「已支持」前必须完成）**：
1. 真实环境打通「触发」并落库厂商任务 id；
2. 回调/轮询任一方式能确认终态（含失败分类）；
3. 幂等/重试策略与厂商能力匹配（无幂等键的厂商禁止自动重试）；
4. 超时/限流/体积上限在 UI 与文档中可见；
5. 出网主机已进隐私声明与出网台账，`PRIVACY_VERSION` 已升版。

---

## 7. 待产品决策的开放问题

1. **是否要入站触发（厂商 → 本应用）**：需要用户显式开启入站通道（PRIVACY §H），默认关闭；若要做，建议先统一入口协议再谈厂商差异（§3.8）。
2. **凭据归属**：按任务独立配置（当前设计），还是增加「厂商账号」全局配置、任务只引用？前者简单、后者便于轮换（UiPath OAuth/影刀 token 都有过期语义，倾向后者作为后续演进）。
3. **完成状态的产品语义**：`sent`（已受理）与 `completed`（执行完成）是否需要向用户区分展示？本方案建议区分（厂商能力不同，不能假装都一样）。
4. **长文本/图片**：影刀参数 ≤8000、UiPath InputArguments ≤10,000、阿里云 AppParams ≤40KB；超限时截断还是走「文件/Storage Bucket/OSS」？首版建议截断并在记录里标注。
5. **私有化地址策略**：允许用户填任意 base URL（内网）会扩大 SSRF 面；是否沿用现有 Webhook 的「用户自担」口径，还是增加「私网地址需显式确认」开关？
6. **是否引入插件包机制**：当前注册表要求改一行代码；若要「第三方厂商包可直接安装」，需要再加一层动态加载/签名校验，建议单独立项。

---

## 8. 建议的实施顺序与「先做什么」

1. **先做 S0 抽象重构**（不新增厂商）：把 webhook/八爪鱼迁进注册表 + 通用派发 + `listRpaVendors` + 描述符驱动 UI + 契约/快照守卫。这一阶段用户可见行为不变，风险最低，但它决定后续每个厂商是「一个文件」还是「一次伤筋动骨」。
2. **再做影刀 S1**（公开契约最完整、可验证性最好），用真实 SaaS 环境跑通「触发 → 回调信号 → 查询二次确认」。
3. **UiPath S2 / 阿里云 S3** 并行评估（前者外企客户、后者国内已有采购客户），按客户实际需求排序。
4. **来也/实在** 在拿到官方文档/联调环境后再排期；PA 保持备选。

> 本文所有参数均按第 5 节来源与第 6 节风险标注使用；未取得官方原文的字段**不得**在实现中猜测补全，
> 必须走「联调确认 → 回填文档 → 再加适配器」的流程。
