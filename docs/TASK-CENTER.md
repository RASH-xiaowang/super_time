# 任务信息（关键词触发与 Webhook / 八爪鱼 RPA 投递）

这份文档写给维护【任务信息】面板的人：先说明它到底是什么，再按界面、状态机、扫描、
投递、存储、权限和现有测试逐层拆开。目标是让下一个人能在不把“待办日程”“聊天素材
收集任务”“定时总结任务”混进来的前提下改这一域。

> 入口：桌面侧栏「行动与维护 → 任务信息」（`taskinfo`）。核心实现在
> [`../src/backend/wechat-data/src/query/task-center.ts`](../src/backend/wechat-data/src/query/task-center.ts)，
> 面板在 [`../src/client/ui-wechat/src/client/pages/wechat-data/panels/TaskCenter.tsx`](../src/client/ui-wechat/src/client/pages/wechat-data/panels/TaskCenter.tsx)。
> 隐私与出网声明见 [`PRIVACY.md`](PRIVACY.md) §四 G3；Remote 方法签名见 [`API.md`](API.md)。
> 多 RPA 厂商（影刀/实在/来也/UiPath/阿里云等）的可选触发方案与调研见
> [`RPA-VENDOR-TRIGGERS.md`](RPA-VENDOR-TRIGGERS.md)（方案阶段，未改动本域行为）。

---

## 1. 一句话理解

【任务信息】是一个**关键词触发的监听任务中心**：用户选定一个会话（群聊还要选定群内
某位成员）、一组关键词和**触发方式**（默认 Webhook；也可选八爪鱼 RPA）；任务启用后，系统只检查
该对象**新产生**的消息，命中关键词就落一条触发记录，再按触发方式投递：Webhook 把整条记录 POST 到
用户填写的地址，八爪鱼 RPA 调八爪鱼的「启动流程」接口。触发方式只决定「记录怎么投出去」，
不改变「任务由微信消息命中驱动」这一事实；两种方式都不能回扫历史。

它不是：

| 相邻功能 | 实际语义 | 与本域的关键区别 |
|---|---|---|
| 待办日程 | 从聊天文本里提取 TODO，供人查看/勾选 | 本域由用户**显式创建**，有触发对象、关键词和回调 |
| 聊天素材收集任务 | 创建时快照最近 N 条文本 + M 张图 | 本域不搬历史；只监听创建/启用之后的**新消息** |
| 定时总结任务 | 按时间生成总结，再交给模型 | 本域由**消息命中**驱动，不走模型、不生成总结 |

因此页面上的“任务”不是“下一步要做的事”，而是一条**监听规则 + 投递配置**。

## 2. 术语

| 术语 | 含义 | 代码位置 |
|---|---|---|
| 任务 / 任务信息 | 一条监听配置：会话、触发对象、关键词、@我限制、图片张数、**触发方式与对应配置**（Webhook 地址 / 八爪鱼 FlowId + API Key）、状态 | `TaskInfo` |
| 会话 | 被监听的单聊对象或群；存 `chatUsername` 和创建时的显示名 `chatName` | `TaskInfo.chatUsername` |
| 触发对象 | 单聊里是对方；群聊里是所选的那位群成员 | `TaskInfo.targetUsername` |
| 触发记录 | 一条新消息命中关键词后留下的事实快照，独立于任务配置 | `TaskTriggerRecord` |
| 仅匹配@我的文本 | 群聊可选条件：只处理结构化 `atuserlist` 包含登录账号的消息；`notify@all` 不算 | `TaskInfo.mentionMeOnly` |
| 水位 | 每个任务已扫描到的消息 `sort_seq`，只存在于 `task_info.last_scan_seq`，不返回前端 | `query/task-center.ts` |
| 触发方式 | 记录投出去的方式，二选一：`webhook`（整条记录 JSON POST 到你填的地址）或 `bazhuayu`（调八爪鱼启动流程，只发会话名 / 触发文本 / 触发对象）；旧库缺列按 `webhook` | `TaskTriggerMethod` |
| Webhook | 触发方式之一：把一条触发记录以 JSON POST 到该任务配置的地址 | `postTaskCallback` |
| 八爪鱼 RPA | 触发方式之一（2026-10-21 新增）：POST 到固定主机 `api-rpa.bazhuayu.com` 的启动流程接口，用任务里配的 FlowId + API Key，**不发图片** | `postBazhuayuTrigger` |
| 已完善 | 可参与扫描与投递；必须有关键词 + **当前触发方式**的必填配置（Webhook 方式要有地址；八爪鱼方式要有 FlowId 与 API Key），群聊还必须选目标成员 | `TaskInfoStatus = 'ready'` |
| 待完善 | 只保存配置，不扫描、不投递 | `TaskInfoStatus = 'incomplete'` |

## 3. 入口与界面结构

### 3.1 创建入口

创建动作不在任务信息面板内，而是在聊天侧统一打开
[`../src/client/ui-wechat/src/client/pages/wechat-data/panels/task-create-dialog.tsx`](../src/client/ui-wechat/src/client/pages/wechat-data/panels/task-create-dialog.tsx)：

1. 会话头部「更多 → 新建任务」；
2. 群信息抽屉底部「新建任务」；
3. 单聊聊天信息抽屉底部「新建任务」。

弹窗里选择会话、关键词、照片数量（0–9）和可选任务名；群聊再选一个目标成员，并可勾选
「仅匹配@我的文本」。创建结果固定为**待完善**，这里不填投递配置：Webhook 地址或八爪鱼
FlowId / API Key 都由任务信息页的**编辑抽屉**负责，因此
“新建完还要去任务信息里启用”是设计路径，不是漏了一步。

### 3.2 面板两栏与编辑抽屉

桌面端打开「任务信息」后是 3:7 的双栏；小于 900px 时上下堆叠。两栏各自滚动，页头
和工具栏不随记录列表滚走。点任务行的「编辑」从**右侧滑出编辑抽屉**（不再在行内展开表单），
抽屉由 `TaskCenterView` 根部渲染一次（kit `Drawer`，`role="dialog"`），标题是
「编辑任务 · <任务名>」；关闭按钮、遮罩与 Esc 都能关掉它，任务被删 / 刷新后不存在时抽屉自动关闭。

| 区域 | 内容与交互 |
|---|---|
| 页头 | 标题、功能说明、「刷新」「立即检查」；立即检查有二次确认 |
| 工具行 | 左侧提示“点任务可筛右栏”，右侧任务状态计数与当前记录总数 |
| 左栏 · 任务列表 | 任务搜索框、批量选择入口、任务名、状态徽标、会话/目标、触发次数、最近触发时间、关键词、图片张数、触发方式摘要（Webhook 主机 / 八爪鱼 FlowId）、编辑（打开右侧抽屉）/删除 |
| 右栏 · 触发记录 | 触发记录搜索框、批量选择入口、时间、任务名、回调状态、会话/目标、命中关键词、图片数、文本摘要、加载更多 |
| 记录弹窗 | 完整文本、按需解码的图片、回调状态/时间/错误、「重新投递」 |
| 编辑抽屉 | 任务名 / 触发关键词 / **触发方式** / 照片数量 / 触发方式对应配置 / 仅匹配@我的文本 / 动作区（保存、标记已完善、删除、状态说明） |

几个容易误解的交互：

- 点任务行会把右栏筛到该任务；点「编辑」打开右侧编辑抽屉（不改变右栏筛选），关闭抽屉
  不会丢已经保存的配置。
- 右栏记录行只放摘要；完整文本和图片只在记录弹窗里出现。
- 左栏搜索只过滤**已完整加载的任务列表**，匹配任务名、关键词、会话/对象名及其 username、
  Webhook 地址与八爪鱼 FlowId；右栏搜索是**服务端搜索**，匹配正文、任务名、会话/对象、关键词及投递错误，
  因此能命中尚未加载到当前页的历史记录。
- 两个搜索框都保留原文作为受控值；右栏在停止输入 250ms 后提交查询，前后端统一最多使用
  100 字。清除按钮清空搜索并回到该栏未筛选状态。

### 3.3 删除入口

任务行与编辑抽屉里的表单共用 `task-delete-button.tsx`，保证两处使用同一套危险色、二次确认、
桌面端降级和失败提示。确认框明确说明：**删除的是任务配置，已经产生的触发记录会保留**。
删除成功后容器会等待任务与触发记录两栏回源，再显示成功提示；历史记录仍可在右栏查看，
但所属任务不存在后，pending/failed 记录不能再重新投递。

### 3.4 批量删除

左右两栏各自有「批量 / 退出批量」入口，互不联动。进入批量后：

1. 行尾的单条编辑/删除入口收起，行本身与复选控件都用于切换选择；
2. 栏头下方出现「全选 / 清空 / 已选 N 条 / 删除所选 (N)」操作条；
3. 「全选」只覆盖当前可见行：左栏受任务搜索过滤，右栏受任务筛选与服务端搜索过滤；
4. 切换搜索条件、切换左栏任务筛选、退出批量或刷新后已不存在的 id，都会清理选择，
   避免把当前屏幕看不到的数据带进删除请求；
5. 一次最多提交 500 个去重后的 id；超过上限时整单拒绝并提示分批操作，不会只删前 500 条。

任务批量删除与单条删除语义相同：**只删除任务配置，关联触发记录仍保留**。确认框会明确
说明历史记录仍可在右栏回看。删除后若当前选中任务、正在编辑的任务或记录弹窗指向已删数据，
容器会清理对应状态，并等待任务、触发记录两栏回源后再显示成功提示。

触发记录批量删除确认框会说明三件事：删除不可恢复、不会删除微信里的原始消息、所属任务的
触发次数与最近触发时间会按剩余记录重算。后端删除记录与重算任务统计在同一个事务中完成；
任一步失败都会整体回滚，避免留下「记录已删、统计仍旧」的半完成状态。

### 3.5 编辑抽屉与触发方式

[`../src/client/ui-wechat/src/client/pages/wechat-data/panels/task-center-edit-form.tsx`](../src/client/ui-wechat/src/client/pages/wechat-data/panels/task-center-edit-form.tsx)
是抽屉里的表单本体；抽屉外壳与 `TaskEditForm` 的渲染在
[`../src/client/ui-wechat/src/client/pages/wechat-data/panels/TaskCenter.tsx`](../src/client/ui-wechat/src/client/pages/wechat-data/panels/TaskCenter.tsx)
（`TaskCenterView` 根部渲染一次），行上的「编辑」按钮在
[`../src/client/ui-wechat/src/client/pages/wechat-data/panels/task-center-panes.tsx`](../src/client/ui-wechat/src/client/pages/wechat-data/panels/task-center-panes.tsx)
的 `TaskRow`。
表单在抽屉里是**单列分区**：任务名 / 触发关键词 / 触发方式 / 照片数量 / 触发方式对应配置 /
仅匹配@我的文本（群聊才显示）/ 动作区。表单保留 `aria-label="编辑任务：<任务名>"`，
SSR 与 E2E 选择器依赖它。会话与触发对象在这一版不提供换绑入口。

**触发方式**（`Segmented`，`aria-label="触发方式"`）二选一，**默认 Webhook**：

- `Webhook`（原有）：填「Webhook 地址」（http/https；标记已完善前必填）。
- `八爪鱼 RPA`（2026-10-21 新增）：填 **FlowId** 与 **API Key** 两项。
  - FlowId 的 placeholder 例如 `6ad859ccee2df270d53fc6e5`；
  - API Key 是密码输入框：未配置时提示「填写八爪鱼 X-Api-Key」，已配置时提示
    「已保存，留空保持不变」——列表与表单都拿不到 Key 原文（见 §7）；
  - 一段说明写明：触发时会调用 `https://api-rpa.bazhuayu.com/api/bots/scheduling/start`，
    把 room_name=会话名、content=触发文本、at_name=触发对象 传给该流程；**图片不会发送**。
- 切换方式**不清空**另一方式已保存的配置（来回切不丢配置）；「标记已完善」的前置条件按
  当前方式判定（Webhook 要有地址；八爪鱼要有 FlowId 且 Key 已保存或本次填入）。
- 任务行摘要：Webhook 显示 `Webhook <host>` / 未填时 `未填 Webhook`；八爪鱼显示
  `八爪鱼 RPA · <flowId>` / 未填 FlowId 时 `八爪鱼 RPA · 未填 FlowId`。

动作区：

- 「保存」写配置，保留当前任务状态。
- 「标记已完善」是**先保存配置、再改状态**的两次写入。第一次失败就停在原状态；第二次
  失败时配置可能已经保存，但任务仍是待完善。缺当前方式的必填项时整单拒绝，并把焦点移到
  对应字段（Webhook 地址 / 八爪鱼 FlowId / 八爪鱼 API Key）。
- 「标记待完善」可逆，只改状态；已产生的触发记录保留。
- 「删除」有二次确认；任务配置删除，触发记录刻意保留。

## 4. 创建到投递的完整流程

```mermaid
flowchart TD
    A[聊天侧新建任务] --> B[写入 task_info<br/>status=incomplete<br/>初始化 last_scan_seq]
    B --> C[打开任务信息<br/>在右侧抽屉补触发方式配置]
    C --> D{保存并标记已完善?}
    D -- 否 --> C
    D -- 是 --> E[先 save 配置<br/>再 setStatus ready]
    E --> F[把水位重置为该会话当前最大 sort_seq]
    F --> G[实时同步或 10s 兜底触发扫描]
    G --> H{新消息来自触发对象<br/>且通过@我限制<br/>且正文包含关键词?}
    H -- 否 --> G
    H -- 是 --> I[INSERT OR IGNORE 一条触发记录<br/>图片只存引用]
    I --> J[立即广播 task-center/updated]
    J --> K[后台单飞投递 pending 记录]
    K --> L{任务仍 ready<br/>且当前触发方式配置齐全?}
    L -- 否 --> M[skipped，等待人工处理]
    L -- 是 --> N[隐私闸处理触发文本]
    N --> O{触发方式?}
    O -- Webhook --> P[按需解码图片<br/>POST 整条记录 JSON]
    O -- 八爪鱼 RPA --> Q[POST 启动流程<br/>只带 room_name/content/at_name]
    P --> R{2xx?}
    Q --> R
    R -- 是 --> S[sent]
    R -- 否 --> T[failed<br/>人工重新投递]
```

投递分支的判定顺序：先看任务是否仍「已完善」且**当前触发方式**的必填配置齐全（Webhook 要有
地址；八爪鱼要有 FlowId 与 API Key），再看触发方式 —— 八爪鱼方式**不解码图片**，
`Params` 只有 `room_name` / `content` / `at_name` 三个字段；两种方式都由同一个隐私闸处理
触发文本，失败都只记状态、可人工重新投递。

### 4.1 水位为什么必须初始化

如果新建任务时水位为 0，下一次扫描会把该会话的全部历史消息当成“新消息”，可能一次
生成几百条记录并向外部地址发送几百次请求。所以：

- 新建任务时，水位初始化成该会话当前最大 `sort_seq`；
- 从待完善变已完善时，再次用“当前最大”初始化；
- 已完善任务换会话时，也必须按新会话重置。

代价是：**任务创建/启用之前的消息不会被补触发**。面板没有“回扫历史”的入口。

### 4.2 扫描判定顺序

每个已完善任务独立扫描：

1. 只取 `sort_seq > last_scan_seq` 的消息，每页 200 条、最多 5 页；
2. 先判触发对象：单聊只认对方（`isSender === 0`）；群聊只认配置的目标成员；
3. 若群聊任务勾选「仅匹配@我的文本」，要求消息的结构化 `atuserlist` 精确包含登录 wxid；
   正文里的普通 `@昵称` 不参与判断，`notify@all` 也不算 @ 我；
4. 再取可读正文，trim 后为空则跳过；
5. 按用户配置顺序找第一个命中的关键词，做**大小写不敏感的包含匹配**；
6. 一条消息最多生成一条记录，记录里保留第一个命中的关键词原文；
7. 触发文本最多保存 4,000 字；触发时间取消息时间，缺失时退回落库时间；
8. 图片按目标对象的“最近 N 张”收集引用，时间正序；扫描阶段不解码；
9. 水位只在确实见过更大的 `sort_seq` 时推进，空扫描不写库。

去重有两层：水位防止同一段消息被重复扫描；`UNIQUE(task_id, message_local_id)` 配合
`INSERT OR IGNORE` 防止同一任务对同一消息重复落记录。

因此，同一会话里先后发送两次相同文本（例如两条「你好」）会生成两条记录，只要它们
确实是两条不同的消息；反过来，同一条消息无论被扫描多少次都只保留一条。去重键是
消息身份，不是文本内容。

### 4.3 扫描的触发时机

关键词触发是常驻能力，不要求面板处于打开状态：

- **主路径**：实时同步回调发现新分片落地后，立即安排一拍扫描；
- **兜底**：每 10 秒（`SYNC_INTERVAL_MS`）一次定时扫描；
- **手动**：「立即检查」走同一个扫描调度器，并额外等待一批投递完成，以便如实回报
  投递条数。

扫描与投递是两条独立的单飞（single-flight）链路。扫描记录落库后会先广播
`task-center/updated`，再在后台开始投递；慢回调不会堵住下一拍扫描。并发请求只会合并成
一次补跑，不会并发打开同一个任务库。

## 5. 状态机

### 5.1 任务状态

```mermaid
stateDiagram-v2
    [*] --> incomplete: 新建（创建弹窗固定）
    incomplete --> ready: 保存配置 + 标记已完善<br/>重置水位
    ready --> incomplete: 标记待完善<br/>停止后续扫描与自动投递
    ready --> ready: 保存配置<br/>沿用状态与水位
    incomplete --> incomplete: 保存配置
    ready --> [*]: 删除任务<br/>保留触发记录
    incomplete --> [*]: 删除任务<br/>保留触发记录
```

`ready` 不是“永久启用”：任务被退回待完善后，已有记录不再进入后台批量投递；但右栏仍能
查看它们。删除任务后，记录同样保留，但所属任务已不存在。

### 5.2 回调状态

```mermaid
stateDiagram-v2
    [*] --> pending: 命中且任务配置齐全
    [*] --> skipped: 命中但任务未配置当前触发方式的必填项
    pending --> sent: 投递得到 2xx
    pending --> failed: 网络/超时/非 2xx
    failed --> sent: 人工重新投递成功
    failed --> failed: 人工重新投递失败
    note right of pending
        任务待完善或删除后，后台查询会跳过；
        记录本身仍保持 pending，不自动改状态。
    end note
```

四种状态的中文口径：

| 状态 | 界面文案 | 含义 |
|---|---|---|
| `pending` | 待投递 | 生成时配置齐全，等待后台或人工投递 |
| `sent` | 已投递 | 已收到 2xx |
| `failed` | 投递失败 | 请求已尝试，但失败原因已落库 |
| `skipped` | 未配置 | 记录生成时任务没有当前触发方式的必填配置（Webhook 地址 / 八爪鱼 FlowId 与 API Key） |

`skipped` 不会因为后来补上配置而自动转成 `pending`；后台批量投递只捞 `pending`。

## 6. 投递协议

### 6.1 Webhook 请求（触发方式 = `webhook`）

只在任务触发方式为 `Webhook` 时发生。

- 方法：`POST`
- 头：`content-type: application/json`
- 超时：单次 15 秒
- 重试：最多尝试 2 次（含首次，即最多 1 次重试）；只有 HTTP
  `408 / 429 / 500 / 502 / 503 / 504` 与网络/超时错误会重试
- 成功判定：HTTP 2xx

请求体形状来自 `TaskCallbackPayload`。示例（图片用省略号表示）：

```json
{
  "taskId": 12,
  "taskName": "项目群 · 小王 · 报价",
  "recordId": 87,
  "triggeredAt": 1760926983000,
  "triggeredAtText": "2026/10/20 09:03:03",
  "chat": {
    "username": "123456@chatroom",
    "name": "项目群",
    "type": "group"
  },
  "target": {
    "username": "wxid_target",
    "name": "小王"
  },
  "keyword": "报价",
  "text": "王工，最新报价请今天发我",
  "images": [
    {
      "localId": 456,
      "createTime": 1760926900000,
      "sender": "小王",
      "md5": "0123456789abcdef0123456789abcdef",
      "dataUrl": "data:image/jpeg;base64,..."
    }
  ]
}
```

图片解码在投递时进行。单张超过约 8,000,000 字符的 data URL、解码失败或路径不安全时，
该张图片省略并带 `error`，不会让整条回调失败。

### 6.2 八爪鱼 RPA 启动流程请求（触发方式 = `bazhuayu`）

只在任务触发方式为「八爪鱼 RPA」时发生。请求由后端的独立函数 `postBazhuayuTrigger`
发出（出网点台账单独登记这一条）。

- 方法：`POST`
- 地址：`https://api-rpa.bazhuayu.com/api/bots/scheduling/start`（**固定主机**，不可改）
- 头：`content-type: application/json` + `X-Api-Key: <该任务保存的八爪鱼 API Key>`
- 超时 / 重试：与 6.1 相同（单次 15 秒、最多尝试 2 次）；非 2xx 抛
  「八爪鱼触发失败：HTTP xxx」，失败原因写进触发记录的 `callback_error`
- **不含图片**：RPA 接口没有图片参数，触发记录里的图片引用不会解码、也不会发送

请求体形状来自 `TaskBazhuayuStartPayload`，示例：

```json
{
  "FlowId": "6ad859ccee2df270d53fc6e5",
  "FlowContentRetrievalMode": "ByNewestContent",
  "SpecifiedPublicationVersion": "",
  "SpecifiedBot": "",
  "Params": {
    "room_name": "项目群",
    "content": "王工，最新报价请今天发我",
    "at_name": "小王"
  },
  "UserStartSource": "OpenApi"
}
```

字段映射：

| 字段 | 来源 |
|---|---|
| `FlowId` | 任务编辑抽屉里该任务的「FlowId」 |
| `FlowContentRetrievalMode` | 固定 `ByNewestContent`（八爪鱼开放接口要求） |
| `SpecifiedPublicationVersion` / `SpecifiedBot` | 固定空串（同上） |
| `UserStartSource` | 固定 `OpenApi`（同上） |
| `Params.room_name` | 触发记录的会话显示名 |
| `Params.content` | 触发文本（上限 4,000 字；过隐私闸后发送） |
| `Params.at_name` | 触发对象显示名：群聊用目标成员 `targetName`；**单聊任务创建时不填 `targetName`，`at_name` 回落会话名 `chatName`**（否则单聊任务会把它发成空串） |

### 6.3 文本隐私闸

两种触发方式投递前都会以功能名 `task_callback` 调用同一个隐私闸：

- 开启「敏感字段打码」时，只对**触发文本**做脱敏；
- 同时写一条本机 AI 出站审计（字符数 / 会话数 / 消息数）。

当前不会对任务名、会话名、目标名、wxid、关键词或图片内容做脱敏。

## 7. 数据模型与存储

数据库文件是 `<数据根>/wechat_task_center.db`，与 `wechat_tasks.db` 同级。两张表：

| 表 | 作用 | 关键列 |
|---|---|---|
| `task_info` | 任务配置与扫描状态 | `keywords`（JSON）、`photo_limit`、`mention_me_only`、`trigger_method`、`callback_url`、`bazhuayu_flow_id`、`bazhuayu_api_key`、`status`、`last_scan_seq`、`trigger_count` |
| `task_triggers` | 触发事实与投递状态 | 任务/会话/目标的快照、`text`、`images`（JSON 引用）、`message_local_id`、`callback_status`、`callback_error` |

`task_info.last_scan_seq` 是内部字段，不进入前端契约。`task_triggers.task_name` 等快照
字段保证任务改名或删除后，历史记录仍可读。

`mention_me_only` 为 `0/1`，只对群聊有意义；单聊即使调用方传入 `mentionMeOnly: true`，
后端也会归一为 `false`。老库由 `ensureTaskSchema()` 通过 `PRAGMA table_info` 检查后执行
`ALTER TABLE` 自动补列，旧行默认 `0`。

2026-10-21 新增三列（同样由 `ensureTaskSchema()` 给老库补列）：

- `trigger_method TEXT NOT NULL DEFAULT 'webhook'`：只认 `'bazhuayu'`，其它值（含老库缺列）
  一律归为 `'webhook'`，因此**旧任务行为不变**；
- `bazhuayu_flow_id TEXT NOT NULL DEFAULT ''`：trim 后存，≤128 字符、只允许
  `[A-Za-z0-9_-]`；FlowId 不是凭据，随任务列表返回；
- `bazhuayu_api_key TEXT NOT NULL DEFAULT ''`：trim 后存，≤512 字符。**任何公开快照都不返回
  原文**：`TaskInfo` 只回 `bazhuayuApiKeySet: boolean`，列表与编辑抽屉里的表单都拿不到 Key 本身，
  投递时由后端从库里读出放进 `X-Api-Key` 请求头。Key 以明文存在本机 SQLite 里，保护方式
  与任务库其它内容一致（数据根与目录权限），没有额外加密。

更新语义沿用既有的「`undefined` = 沿用旧值，空串 = 清空」：`triggerMethod` 缺省用旧行值
（新建 = `webhook`）；`bazhuayuFlowId` 缺省用旧值；`bazhuayuApiKey` 缺省 = **保留旧 Key**
（编辑表单不显示原文，所以「没改动」必须能与「清空」区分开）。切换触发方式不清空另一方式
的字段 —— 用户在两种方式间来回切不应该丢配置。

记录按 `triggered_at DESC, id DESC` 读取，默认每页 100 条、最大 200 条。搜索条件作用于
正文、任务名、会话/对象名与 username、关键词和回调错误；`%`、`_`、`\` 按普通字符匹配。
翻页使用
`(triggeredAt, id)` 复合游标，而不是 offset：先补同一时间戳下更小的 id，再用剩余额度
取严格更早的记录，因此扫描期间新增记录不会让后续页整体位移。`TaskTriggerSnapshot.total` 是
**当前筛选条件下的真实总数**；`nextCursor` 只在后面确实还有记录时返回。面板刷新或切换
任务/搜索条件会回到第一页。同一筛选下的静默刷新会保留已加载范围：先重取第一页，再按
游标补齐到刷新前的条数，最后一次性替换列表，因此不会缩成一页、不会把滚动位置钳回顶部。
为免很深的列表把后端队列占满，一轮最多补齐 8 页；超过时保留旧列表等待下一次手动刷新。
「加载更多」只在当前筛选下追加并按 id 去重。搜索条件同时进入总数、首屏、续页和
`hasMore` 探测，避免列表与计数采用两套口径。

## 8. 前端刷新与事件

面板不把任务或记录放进长期快照缓存；`useFreshData` 打开即查，失败时才回退本地渲染缓存
并标“缓存数据”。已有内容时，刷新按钮、事件回源和写操作后的回源都走 `reloadSilent()`：
不翻 `loading`、不闪骨架、不清空列表，失败保留旧值，只在按钮上暴露轻量 `aria-busy`。
同筛选触发记录会补齐原已加载范围后再整体替换；只有切换任务/搜索条件才清空并回到第一页。
刷新有四条通路：

1. 打开页签时主动查询；
2. 前端写操作成功后广播 `dsh-wechat-task-center-updated`，两栏一起回源；
3. 后端扫描/投递成功广播 `task-center/updated`，宿主转成同一个 DOM 事件；
4. 微信数据同步事件到达时，再安排一次显式回源。

后端事件只带 `{ created, dispatched }` 计数，不携带快照；面板收到后重新查库，避免事件
payload 变成第二份数据源。

选中任务或打开编辑抽屉后，如果下一次任务列表里已经找不到对应 id，右栏会回到“全部记录”、
抽屉关闭，并给出一次可见提示。

## 9. 权限、桌面端与移动端

| 能力 | 桌面端 | 普通手机/浏览器会话 | 桌面「打开网页」交接会话 |
|---|---|---|---|
| 查看任务与触发记录 | 可 | 可（只读方法在白名单） | 可 |
| 新建/编辑/删除任务 | 可 | 否 | 可（fullAccess，与桌面同权） |
| 批量删除任务/触发记录 | 可 | 否 | 可（fullAccess，与桌面同权） |
| 立即检查（会写库） | 可 | 否 | 可 |
| 重新投递（会出网） | 可 | 否 | 可 |

普通手机导航直接不显示 `taskinfo`；即使通过深链进入，写按钮也会禁用。权限的最终边界在
[`../src/backend/http-remote-policy.js`](../src/backend/http-remote-policy.js)：只读列表在
「总结与任务」族；写侧与投递分别落在本机写入族和内容出网族。

## 10. 当前已知限制与风险

下面这些是**当前实现事实**，不是待办承诺。修改前应先决定产品语义，再补行为判据。

### 10.1 高优先级

1. **回调没有幂等协议。** 请求没有幂等键；后台批量投递与人工「重新投递」也没有数据库
   抢占/租约。慢请求期间若同一记录被另一条路径再次选中，外部平台可能收到重复 POST。
   对端若要可靠去重，目前只能使用 `recordId`。
2. **Webhook 地址没有 SSRF/私网防护。** 只校验 `http/https`、主机名非空和长度 ≤2048；
   不拒绝回环、私网、链路本地地址，也没有签名或鉴权。能编辑任务的人可以诱导本机后端
   向任意 HTTP(S) 目标发请求，接收方也无法验证请求确实来自本应用。八爪鱼 RPA 方式的目的地
   写死、不受这条影响，但 `X-Api-Key` 会发给该固定主机，Key 的权限边界由八爪鱼侧控制。
3. **隐私闸覆盖范围窄。** 只处理触发文本；任务名、会话/目标名称、wxid、关键词和图片
   都不经过打码。开启“敏感字段打码”不等于整条 payload 已脱敏。
### 10.2 状态与一致性

4. **保存与启用不是原子操作。** 「标记已完善」先 `save` 再 `setStatus`；第二步失败时，
   配置可能已更新但任务仍为待完善。界面会显示第二次调用的错误，但不会回滚第一次保存。
5. **已完善任务可直接改关键词/触发方式配置。** 保存后立即沿用 `ready` 状态，不要求重新
   确认；新的关键词从下一次扫描开始生效，新的配置（Webhook 地址 / 八爪鱼 FlowId 与 Key）
   也会马上用于 pending 记录。
6. **待完善任务会“卡住” pending 记录。** 扫描只处理 ready 任务，所以通常不会新增
   pending；但若记录生成后任务被退回待完善或删除，后台批量投递会跳过它。记录弹窗的
   「重新投递」也要求任务存在且 ready，因此这些记录当前没有恢复投递的路径。
7. **记录的回调状态不随任务删除而清理。** 记录保留是对的，但 pending/failed 记录在任务
   删除后只能查看，不能投递。

### 10.3 扫描与数据边界

8. **不补历史。** 创建或重新启用前命中的消息永远不会生成记录；水位读失败时退 0 的
   防御分支反而可能多扫历史，但仍受对象与关键词过滤。
9. **群聊目标匹配依赖解析出的 sender。** 如果消息解析层拿不到稳定的 sender，目标过滤
    会漏触发；这个问题不会在面板上报错。
10. **图片引用不是内容快照。** 记录只保存 `localId/createTime/sender/md5`；如果原消息
    被清理、图片缓存失效或密钥变化，弹窗和回调都可能解码失败。
11. **扫描按任务串行。** 每个任务最多翻 5×200 条；任务很多或会话很大时，一拍扫描可能
    持续较久。单任务失败只记错误，不连坐其它任务。
12. **八爪鱼 API Key 以明文存在本机任务库。** `task_info.bazhuayu_api_key` 没有额外加密，
    保护只到数据根与文件权限这一层；它不进列表返回值、导出与日志，但能读到这个库的人
    就能读到原文。编辑表单不提供单独的清空 Key 入口：轮换 Key 只能重新填写覆盖，
    要停用这条任务则把它「标记待完善」或删除。

### 10.4 文档漂移

13. [`PRIVACY.md`](PRIVACY.md) 与生成的 [`API.md`](API.md) 已按实际按钮「重新投递」和
    精确重试白名单修正；[`UI-WECHAT-REDESIGN-INVENTORY.md`](UI-WECHAT-REDESIGN-INVENTORY.md) 的 DL-09 行
    也标明创建弹窗没有 Webhook 地址字段。

## 11. 修改时的决策清单

在动回调、状态或扫描逻辑前，先回答这些问题并把答案写成行为判据：

| 决策 | 需要明确的行为 |
|---|---|
| 回调幂等 | 请求带什么稳定键？同一记录并发投递如何只成功一次？ |
| 回调安全 | 是否允许私网/回环？是否加签名、时间戳、密钥轮换？八爪鱼方式的主机固定，Key 权限边界在哪？ |
| 触发方式 | 切换方式是否保留另一方式的配置？八爪鱼失败是否回退 Webhook？Key 如何轮换 / 清空？ |
| 隐私 | 会话名、目标名、wxid、关键词、图片是否也应受打码控制？ |
| 待完善任务 | 已有 pending 记录应保留、转 skipped、还是允许人工投递？ |
| 删除任务 | 历史 pending/failed 记录是否仍有投递入口？ |
| 启用语义 | 改关键词/改地址后是否要重新确认？是否重置水位？ |
| @我限制 | 单聊是否允许？`@所有人` 是否算？正文 `@昵称` 是否可替代结构列表？ |
| 记录查询 | 游标字段是否仍能唯一定位一行？total 与筛选条件是否同源？ |
| 原子性 | 保存+启用是否合成一次后端事务或补偿操作？ |

默认原则：不静默回扫历史、不静默清掉历史记录、不让仅查看的会话获得出网能力。

## 12. 验收清单

### 12.1 产品路径

- [ ] 从聊天头部、群信息、单聊信息三个入口都能打开创建弹窗。
- [ ] 新任务显示为「待完善」，不会产生记录，也不会投递。
- [ ] 点任务行「编辑」在右侧打开编辑抽屉（`role="dialog"`）；关闭按钮、遮罩与 Esc 都能关闭，关闭后右栏筛选不变。
- [ ] 抽屉标题是「编辑任务 · <任务名>」，表单保留 `aria-label="编辑任务：<任务名>"`。
- [ ] 「触发方式」分段控件默认选中 Webhook；切到「八爪鱼 RPA」后出现 FlowId 与 API Key 两个输入，并显示固定主机与「不发图片」的说明。
- [ ] 八爪鱼方式填好 FlowId 与 API Key、点「标记已完善」后任务参与触发；缺 FlowId 或 API Key 时整单拒绝并把焦点移到对应字段。
- [ ] 八爪鱼任务保存后，任务行摘要显示「八爪鱼 RPA · <flowId>」；重新打开抽屉时 Key 输入框显示「已保存，留空保持不变」。
- [ ] 列表与 Remote 返回值只有 `bazhuayuApiKeySet`，JSON 里不含 Key 原文。
- [ ] 切换触发方式时，另一方式已保存的配置不丢（来回切两次后两套配置都还在）。
- [ ] 补好对应触发方式的配置（Webhook 地址 / 八爪鱼 FlowId + API Key）并点「标记已完善」后，任务参与触发；已有历史消息不被回扫。
- [ ] 单聊只认对方消息；群聊只认所选成员的消息。
- [ ] 群聊勾选「仅匹配@我的文本」后，无结构 @、只 @所有人或只 @ 别人都不触发；结构化 @ 登录账号才触发。
- [ ] 单聊不显示该勾选项，后端始终保存为未勾选。
- [ ] 一条消息只生成一条记录，命中的是配置顺序里的第一个关键词。
- [ ] 图片数量 0 时不带图；1–9 时取目标对象最近 N 张并按时间正序；**八爪鱼方式触发时不带任何图片**。
- [ ] 记录弹窗能看到完整文本、图片、回调状态；失败时可「重新投递」。
- [ ] 左栏可按任务名、关键词、会话/对象、Webhook 地址或八爪鱼 FlowId 过滤；无匹配时显示空态。
- [ ] 右栏可跨页搜索正文、任务、会话/对象、关键词和投递错误，而不只搜索当前页。
- [ ] 两个搜索框都有清除按钮；右栏清空后恢复当前任务的全部记录。
- [ ] 超过一页时能连续「加载更多」；跨页不重不漏，同一时间戳的记录也能正确续接。
- [ ] 同筛选刷新不清空列表、不改变滚动位置，触发记录保持刷新前的已加载条数；加载下一页失败时保留已加载记录，只在底部报错。
- [ ] 切换任务或搜索条件后回到第一页；输入框中的未提交文字与抽屉里的编辑草稿不被后台刷新覆盖。
- [ ] 任务行和编辑抽屉里都能删除；确认框说明历史记录保留，删除后记录仍可查看，右栏选中项回到全部记录。
- [ ] 左右两栏都能进入批量模式；全选只覆盖当前可见行，清空、退出批量与搜索变化会清理选择。
- [ ] 任务批删只移除所选配置，历史触发记录保留；选中任务、正在编辑的任务与记录弹窗指向已删数据时会自动失效。
- [ ] 触发记录批删后总数与列表更新，任务行的触发次数和最近触发时间按剩余记录重算。
- [ ] 批量删除为空或超过 500 条时不会发起部分删除；超过上限时给出明确分批提示。
- [ ] 手机端不显示入口；普通浏览器会话的写按钮禁用。

### 12.2 后端与数据

- [ ] 新建/启用/换会话都会正确初始化或重置水位。
- [ ] 重复扫描同一消息不会生成第二条记录。
- [ ] 关键词去重大小写不敏感，单条 ≤64 字，总数 ≤20。
- [ ] `photoLimit` 被夹在 0–9，非法模式/URL 整单拒绝。
- [ ] 老任务库缺少 `mention_me_only` / 三个新列时自动迁移，旧任务默认未勾选、`triggerMethod === 'webhook'` 且行为不变。
- [ ] `triggerMethod` 只认 `'bazhuayu'`，其它值（含缺列）一律归一为 `'webhook'`。
- [ ] 八爪鱼方式标记「已完善」要求 FlowId 与 API Key 都齐全：缺任一项整单失败，`setTaskInfoStatus('ready')` 也拦得住。
- [ ] Webhook 方式缺 `callbackUrl` 仍不能标记「已完善」（与旧口径一致）。
- [ ] 更新任务不传 `bazhuayuApiKey` ⇒ 保留旧 Key（`bazhuayuApiKeySet` 仍为 true）；传空串 ⇒ 清空。
- [ ] 列表返回值与 `JSON.stringify` 里不含八爪鱼 API Key 原文。
- [ ] 投递成功写 `sent`，失败写 `failed` 和错误；命中时任一必填配置缺失 ⇒ 记录落 `skipped`，后台批量投递只捞 `pending`。
- [ ] 投递时任务已退回待完善 / 已删除 ⇒ 返回 `skipped`，不改变记录已有状态。
- [ ] Webhook 投递：假 fetch 收到的地址 / body 与既有 `TaskCallbackPayload` 完全一致，记录状态 `sent`。
- [ ] 八爪鱼投递：假 fetch 收到的 URL / `X-Api-Key` / body 字段（`FlowId`、固定字段、`Params.room_name` / `content` / `at_name`）与 §6.2 完全一致，记录状态 `sent`，且**不含图片**。
- [ ] 八爪鱼投递失败（假 fetch 回 500 或抛错）⇒ 记录 `failed` + 错误落库，不回退到 Webhook。
- [ ] 八爪鱼方式缺 Key / 缺 FlowId ⇒ `skipped`，一个请求都不发。
- [ ] 批量 `dispatchPendingTaskCallbacks` 能捞到八爪鱼方式的 pending 记录（SQL 条件按触发方式分支）。
- [ ] 单条图片解码失败只影响该张，不影响整条 Webhook 回调。
- [ ] 读库失败返回 `readError`，与“确实没有数据”区分。
- [ ] 搜索对 `%` / `_` / `\` 按普通字符处理，`taskId + search` 可组合。
- [ ] `nextCursor` 只在本页之后仍有记录时返回，`total` 与搜索/任务条件同口径。
- [ ] 批删 id 去重并只接受正整数；空选择、全无有效 id 与超过 500 条均整单失败。
- [ ] 批删触发记录与任务统计重算同事务提交，删除失败时两者都不变。

### 12.3 回归命令

```powershell
npx vitest run src/backend/wechat-data/tests/task-center.spec.ts `
  src/backend/wechat-data/tests/task-center-scheduler.spec.ts `
  src/backend/wechat-data/tests/task-center-bazhuayu.spec.ts `
  src/client/ui-wechat/src/client/pages/wechat-data/panels/task-center.spec.ts `
  src/client/ui-wechat/src/client/pages/wechat-data/panels/task-create.spec.ts `
  src/client/ui-wechat/src/client/pages/wechat-data/panels/task-center.wiring.spec.ts `
  src/client/ui-wechat/src/client/pages/wechat-data/panels/task-create.wiring.spec.ts
npm run task-center:smoke
npm run task-center:e2e
npx vitest run src/backend/tests/docs-index.spec.ts
```

## 13. 代码地图

| 层 | 文件 | 职责 |
|---|---|---|
| 共享类型 | [`../src/backend/wechat-data/src/types-taskcenter.ts`](../src/backend/wechat-data/src/types-taskcenter.ts) | `TaskInfo`、`TaskTriggerRecord`、回调 payload 等单一契约 |
| 存储/CRUD | [`../src/backend/wechat-data/src/query/task-center.ts`](../src/backend/wechat-data/src/query/task-center.ts) | 建库、校验、水位、任务读写、记录查询 |
| 扫描 | [`../src/backend/wechat-data/src/query/task-center-scan.ts`](../src/backend/wechat-data/src/query/task-center-scan.ts) | 新消息过滤、关键词匹配、图片引用、水位推进 |
| 投递 | [`../src/backend/wechat-data/src/query/task-center-callback.ts`](../src/backend/wechat-data/src/query/task-center-callback.ts) | payload、图片解码、隐私闸、两种出网 POST（`postTaskCallback` / `postBazhuayuTrigger`）、状态回写 |
| Remote 壳 | [`../src/backend/wechat-data/src/gateway-taskcenter.ts`](../src/backend/wechat-data/src/gateway-taskcenter.ts) | 9 个 `@Remote`、扫描/投递单飞调度、事件广播 |
| 处理器 | [`../src/backend/wechat-data/src/remotes/task-center.ts`](../src/backend/wechat-data/src/remotes/task-center.ts) | 目录/密钥/隐私闸注入与操作留痕 |
| 前端入口 | [`../src/client/ui-wechat/src/client/pages/wechat-data/panels/task-create-dialog.tsx`](../src/client/ui-wechat/src/client/pages/wechat-data/panels/task-create-dialog.tsx) | 三个聊天侧入口共用的创建弹窗 |
| 前端面板 | [`../src/client/ui-wechat/src/client/pages/wechat-data/panels/TaskCenter.tsx`](../src/client/ui-wechat/src/client/pages/wechat-data/panels/TaskCenter.tsx) | 取数、事件刷新、双栏视图根与右侧编辑抽屉（kit `Drawer`） |
| 面板视图 | [`../src/client/ui-wechat/src/client/pages/wechat-data/panels/task-center-panes.tsx`](../src/client/ui-wechat/src/client/pages/wechat-data/panels/task-center-panes.tsx) | 左栏任务列表（`TaskPane` / `TaskRow`，编辑按钮只打开抽屉）与右栏触发记录（`TriggerPane`） |
| 搜索分页 | [`../src/client/ui-wechat/src/client/pages/wechat-data/panels/use-task-center-triggers.ts`](../src/client/ui-wechat/src/client/pages/wechat-data/panels/use-task-center-triggers.ts) | 触发记录防抖搜索、第一页快照与游标分页 |
| 编辑表单 | [`../src/client/ui-wechat/src/client/pages/wechat-data/panels/task-center-edit-form.tsx`](../src/client/ui-wechat/src/client/pages/wechat-data/panels/task-center-edit-form.tsx) | 单列表单、触发方式（Webhook / 八爪鱼 RPA）与保存/状态/删除 |
| 删除入口 | [`../src/client/ui-wechat/src/client/pages/wechat-data/panels/task-delete-button.tsx`](../src/client/ui-wechat/src/client/pages/wechat-data/panels/task-delete-button.tsx) | 任务行与抽屉表单共用确认、危险色和桌面降级 |
| 记录弹窗 | [`../src/client/ui-wechat/src/client/pages/wechat-data/panels/task-center-record-modal.tsx`](../src/client/ui-wechat/src/client/pages/wechat-data/panels/task-center-record-modal.tsx) | 完整记录、图片解码、重新投递 |
| 前端取数 | [`../src/client/ui-wechat/src/client/pages/wechat-data/api-task-center.ts`](../src/client/ui-wechat/src/client/pages/wechat-data/api-task-center.ts) | Remote 包装与前端更新事件 |
| 权限 | [`../src/backend/http-remote-policy.js`](../src/backend/http-remote-policy.js) | 远程只读白名单、桌面写侧与投递拒绝族 |
| 后端测试 | [`../src/backend/wechat-data/tests/task-center.spec.ts`](../src/backend/wechat-data/tests/task-center.spec.ts) | 真实临时消息分片上的 CRUD、扫描、图片、投递行为 |
| 八爪鱼测试 | [`../src/backend/wechat-data/tests/task-center-bazhuayu.spec.ts`](../src/backend/wechat-data/tests/task-center-bazhuayu.spec.ts) | 老库迁移、ready 校验、Key 保留/清空与不回读、两种投递请求体与失败状态 |
| 调度测试 | [`../src/backend/wechat-data/tests/task-center-scheduler.spec.ts`](../src/backend/wechat-data/tests/task-center-scheduler.spec.ts) | 单飞、合并、事件与扫描/投递解耦 |
| 前端测试 | [`../src/client/ui-wechat/src/client/pages/wechat-data/panels/task-center.wiring.spec.ts`](../src/client/ui-wechat/src/client/pages/wechat-data/panels/task-center.wiring.spec.ts) | 导航、懒加载、接线、弹窗无障碍与 SSR |

## 14. 现有测试覆盖与空档

现有判据主要分三层：

- **后端行为**：用临时目录合成真实 `Msg_*` 表，覆盖 CRUD、校验、水位、对象过滤、
  最近图片、回调请求体、隐私闸、失败状态和读错误口径；八爪鱼方式另有独立用例覆盖
  老库迁移、ready 校验、Key 保留/清空与「Key 不进返回值」、两种投递请求体与失败状态。
- **调度行为**：覆盖扫描单飞/补跑、事件时机、扫描与投递解耦、失败不卡死，以及
  “不得退回只靠 30 秒定时器”的接线守卫。
- **前端契约**：覆盖纯逻辑文案/校验、导航与懒加载、API 接线、手机降级、弹窗焦点与
  SSR 冒烟（含右侧编辑抽屉与触发方式两种配置）。
- **桌面端到端**：`npm run task-center:e2e` 使用临时用户目录启动真实 Electron，
  经 preload → Remote → worker → SQLite 走通双栏空态、任务搜索、120 条同毫秒记录的
  跨页加载、`%` / `_` / 回调错误搜索、任务批删保留历史、触发记录批删重算统计，
  以及编辑抽屉（含切到八爪鱼 RPA、填 FlowId + Key 保存后经 Remote 读回）与历史记录保留。

仍未覆盖的关键空档：

- 没有并发回调的行为判据（同一记录同时被后台和人工投递）。
- 没有 SSRF/私网拒绝、签名校验、幂等键的判据（因为实现尚未定义）。
- 没有八爪鱼 API Key 轮换 / 清空的界面路径判据（当前表单只能覆盖保存）。
- 没有验证敏感字段打码是否应覆盖会话/目标名称、wxid、关键词和图片（当前明确不覆盖）。
- 没有“保存成功、改状态失败”的半成功状态恢复测试。
