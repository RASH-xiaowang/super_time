# 知识库三类模型可分别配置方案（KB-MODEL-CONFIG）

> **制定日期**：2026-09-19
> **上游输入**：`docs/KB-COMPLETION-PLAN.md`（G-01 ~ G-22 编号沿用；其 §三 C1 约束在本文件里**继续有效**）、
> `docs/KB-RAG-PLAN.md`（T4 稠密通道）、`docs/KB-WEKNORA-GAP.md`（G-07 实体抽取）
> **本文件回答**：三类模型各自负责什么、在哪些代码点被调用、配置存在哪儿、
> 在知识库管理界面的**哪个位置**以**什么交互**被配置、以及按什么顺序落地。
> **本轮已定的三个决策**见 §10。

---

## 一、目标

### 1.1 一句话

让知识库的每一次模型调用都**说得清用的是哪个模型**，并且**换一个模型不会悄悄把旧产物当成新模型的**——
语言模型、嵌入模型、重排序模型是三个独立旋钮，可全局配、可按库覆盖。

### 1.2 可检验成果（不写「更灵活」）

| # | 可检验判据 | 现在为什么不满足 |
|---|---|---|
| V1 | 换一个嵌入模型后，本库旧向量被标记为「模型不符」，`ready` 判假，界面上出现「需重建」，且**不会**被问答静默拿去用 | 向量库 meta 里记的模型名恒为 `'default'`（§7 F1），换模型不触发任何失效 |
| V2 | 一次提问的依据行能写出「精排：bge-reranker-v2（候选 60 → 取 12）」或「精排：本地线性加权（未配置重排序模型）」 | 全仓库**没有** rerank 调用，排序是 `query/retrieval/rank.ts:50-101` 的 8 特征线性加权 |
| V3 | 「文件」面板的检索在配了嵌入模型后返回 dense 命中，`degraded` 不再恒为「未建向量索引」 | `@Remote('searchKb')` 根本没把 embedFn 传下去（`gateway.ts:1138-1142`），`kb-search.ts:257` 的降级说明是硬编码 |
| V4 | 每个库能单独指定三个角色用哪个模型，且切换后**下一次调用**就用新值（不重启） | 只有全局一份扁平 `llm.json`；`kbs` 表只有 4 列，没有任何「每库设置」载体 |
| V5 | 换 profile 时三个角色**成套**跟着换，不会出现「A 家的重排序 + B 家的 API Key」 | `LLM_PROFILE_FIELDS`（`wechat-paths.js:406`）只含 chat+embedding 的 8 个字段 |
| V6 | 模型抽出的实体/建议链接在图上**与观测到的关系一眼可分**，且用户不点就不写进笔记 | 现在图谱只有本地确定性产物（`query/kb/entities.ts` 头注禁模型），`[[链接]]` 全靠手写 |
| V7 | 每一次出网（含新的 rerank）在审计表里是**独立功能名**，在 `docs/PRIVACY.md` 里有对应表格行 | `kb_rerank` 尚不存在 |

---

## 二、三类模型的职责与调用场景

### 2.1 语言模型（chat / LLM）

| 职责 | 调用点 | 发出去的东西 | 触发方式 | 频率 |
|---|---|---|---|---|
| **文件摘要**（已实现） | `gateway.ts:1040 @Remote('summarizeKbFile')` | 单文件正文前 8,000 字 | 用户点「生成摘要」 | 逐文件、手动 |
| **文档实体 / 主题抽取**（新） | 新 `query/kb/extract.ts`，由 `@Remote('extractKbFileEntities')` 驱动 | 单文件的分块摘要串（**按文件不按 chunk**） | 用户点「抽取实体」，或建索引时勾选顺带做 | 逐文件、可重放 |
| **双向链接建议**（新） | 新 `@Remote('suggestKbLinks')` | 一篇笔记的正文 + 候选标题清单（候选由嵌入召回，见 2.2） | 用户在笔记编辑器里点「建议链接」 | 逐笔记、手动 |
| 问答生成（既有） | `gateway.ts:1460 askWechat` | 检索后的上下文 | 提问 | 每次 |

**为什么抽取按文件而不是按 chunk**：`entities.ts:15-17` 立的规矩是「绝不做 chunk 级模型调用」——
一个 38 块的文件就是 38 次请求，成本与失败率都乘以块数，而产出（同一批主题词）高度重复。
按文件一次出全篇主题词，粒度够用。

**链接建议只产出文本，不产出边**（本轮最重要的一个设计取舍）：
建议结果是一排可点的芯片，点一下把 `[[目标]]` **插进笔记正文**，边仍由既有的
`parseWikiLinks`（`notes.ts:690-735`）从正文派生。这样：

- 链接图只有一处真源（笔记正文），模型「建议过但用户没采纳」的东西不会污染图；
- 撤销 = 删掉那几个字，不需要「回滚一次模型写入」；
- 笔记库与知识图谱仍然共用同一份 notes 表，`KB-COMPLETION-PLAN` §C1 的纯度不破。

### 2.2 嵌入模型（embedding）

职责（本轮明确定义）：

1. **文件块向量化** → `wechat_kb_vectors.db`，供语义检索与问答的 dense 通道召回；
2. **笔记向量化** → 与消息域同一套 `wechat_rag_vectors.db` 口径，让「问自己写过的笔记」也能语义命中；
3. **给链接建议供候选**：先用嵌入召回语义相近的笔记标题与文档实体，再交给语言模型判定该不该连
   —— 这一步把三个角色串成一条管道，而不是各调各的；
4. **换模型即作废**：本库所有向量按「行级模型名 ≠ 当前绑定模型」判为过期。

**不做**：跨库对齐。两个库用不同嵌入模型时它们的向量**不可比**，所以 dense 检索永远限定在单库内
（`kb_vectors` 已有 `kb_id` 列，`kb-vectors.ts:123-125`），这一点要写进 `ready` 判据而不是靠调用方记得传。

### 2.3 重排序模型（rerank）

职责（本轮明确定义，全部是「召回之后、进 prompt 之前」的活）：

1. **问答候选精排**：sparse + dense + kb 融合出 ~60 条 → rerank 按与问题的相关性重排 → 取 ~12 条进上下文。
   插入点在 `query/retrieval/pipeline.ts` 的 RRF 融合（`:425`）之后、`rank.ts` 打分之前；
2. **文件面板检索精排**：`searchKb` 的 bm25 名次只是词面相关性，配了 rerank 才谈得上「这段真的回答了这个问题」；
3. **链接建议打分**：给候选（笔记/实体）打「值得连」的分，决定芯片的排序与截断。

**与现有线性加权的关系（关键）**：rerank **不替换** `rank.ts:50-101` 的 8 特征打分，而是
**替换它之前的候选池排序**。未配置重排序模型时，整条链路**逐字节等于现在**——这不是「坏了才降级」，
而是默认路径本来就没有 rerank。降级必须在结果里显式说明（`channels[].note`），否则用户会把
「没配模型」读成「模型觉得这些最相关」。

---

## 三、关键约束（会让工作白做的硬条件）

### C1 · `notes.ts` 与 `kbs` 表继续一行不改 ⚠️ 架构级（沿用前序计划）

`notes.ts` 头注自述「只读写本地库，不出网、不调用模型」。把「每库模型设置」塞进 `kbs` 的
`ALTER TABLE` 会让这个模块变成模型配置的载体之一——**语义上就错了**。
**处置**：设置另立一个新 db（§4.2），由 `gateway.ts` 的 `getKbs` 合流带出（与 `fileCount`
由 `countKbFilesByKb` 合流是同一个既有范式）。

### C2 · 图谱的观测层不得被模型污染 ⚠️

`query/kb/entities.ts:15-17` 的三条规矩（不按 chunk、全本地确定性不出网、只看 `wechat_kb_files.db`）
**原样保留**。模型抽取的产物落在**新表、新边 kind**（`suggest`），画布上虚线、详情里写明
「模型推断，不是文档里观测到的」。合流点仍在 `gateway.ts:817-832`。

### C3 · 新增出网点必须过两道闸，且 `privacyBlocked` 判在所有早退之前 ⚠️ 隐私承诺

样板是 `summarizeKbFile`（`gateway.ts:1046` 先 `privacyBlocked`，`:1095` 再 `privacyGate`）。
rerank 的 `texts` 天然是 `query + N 个候选文档` ⇒ **必须一次过 gate 再拆回**，
不能只 gate query（那等于候选正文没脱敏就发出去了）。

### C4 · 嵌入调用的模型名与向量库记账名必须是同一个值

现在的缺陷是两者走两条路（§7 F1）。修好后 `meta.model` / 行级 `model` 记的必须是
**host 实际发出去的那个名字**（`wechat-host.js:291` 的 `opts.model || cfg.embeddingModel || cfg.model`），
所以解析要**下沉**：由后端解析出最终模型名，回传给调用方记账，而不是各层各猜一次。

### C5 · 换嵌入模型的代价必须**先说再删**

`kb-vectors.ts:486` 的 reset 现在是 `DELETE FROM kb_vectors` **清全表（所有库）**。
按库绑定后：只删本库（`WHERE kb_id = ?`），且界面在保存前就写明「会清空本库 N 块向量并重建」。
误删别的库的向量是不可逆的（重建要重新出网、重新花 token）。

### C6 · 计数与产物契约

新增 @Remote 方法要同步：`api.ts` 的 `interface WechatRemote`（`src/backend/wechat-data/tests/remote-contract.spec.ts:62-71` 双向无差集）、
`docs/API.md`（生成）、`src/client/ui-app/onboarding/OnboardingShell.tsx:451` 的 `'152'`、
`src/backend/tests/api-docs.spec.ts:34-36` 与 `:80-95`、
`src/client/README.md:18`（**这行还写着过期的「150 个 Remote 方法」**）。长调用还要进 `src/backend/backend-rpc.js:31-55` 的 `LONG_CALL_METHODS`。

### C7 · 缓存键必须带库 id，且只清该清的那一层

新设置按 `kbCacheKey('kb-model', kbId)`（`kb-scope-keys.ts:60-63` 是唯一拼法定义处）。
写完设置**只清这一层**，不要顺手 `invalidateKbCaches()`——库表内容没变，
广播 `KBS_UPDATED_EVENT` 只会让切换器白重取一次。

### C8 · 未配置 = 行为不变，且「未配置」要看得见

三个角色任何一个没配，对应能力**静默关闭**（不报错、不阻塞），并在界面上有一处说明为什么没有。
这是本仓库一贯的「降级必须被看见」（`searchKb` 的 `degraded` 字段就是为此存在的）。

---

## 四、配置模型（数据形状）

### 4.1 `llm.json`：三段角色，**角色前缀的扁平键**

```jsonc
{
  // ── 语言模型：沿用现有顶层键，一个都不改（旧版本读得到、行为不变）
  "provider": "deepseek", "model": "deepseek-chat",
  "apiKey": "...", "apiUrl": "...", "apiPath": "/chat/completions", "timeoutMs": 60000,

  // ── 嵌入模型：沿用现有的两个键，补一对可选凭据
  "embeddingModel": "bge-m3", "embedPath": "/embeddings",
  "embeddingApiUrl": "", "embeddingApiKey": "",   // 空 ⇒ 回落 chat 那对（与今天一致）

  // ── 重排序模型：本轮新增
  "rerankModel": "bge-reranker-v2", "rerankPath": "/rerank",
  "rerankApiUrl": "", "rerankApiKey": "", "rerankTimeoutMs": 20000,

  "profiles": [ /* 每条 profile 现在要成套带上三个角色的字段 */ ],
  "activeProfileId": "..."
}
```

**为什么扁平而不是嵌套三段**：`loadLlmConfig`（`wechat-paths.js:271-284`）是**按 `defaultLlmConfig()`
的键逐个覆盖**的——新键不先加进 `defaultLlmConfig`（`:255-269`），磁盘上写了也读不出来（静默）。
扁平键同时让 `LLM_PROFILE_FIELDS:406` / `pickLlmProfileFields:415` / `normalizeLlmProfile:429`
这三处「字段清单驱动」的代码保持原形状。

**为什么 `rerankApiUrl/Key` 允许留空回落**：嵌入今天就是这样（`wechat-host.js:282,290-299`），
而「同厂商三个模型」是常态；分开填才走独立端点（如自建 rerank 服务）。

**没有 `rerankEnabled`**：本轮决策是「填了模型名就自动启用」（§10 D3）。
仍然存在的关闸有两道：全局「禁止 AI 出网」（`privacyBlocked`）与逐文件的 `include_in_rag`。

### 4.2 按库覆盖：新 db `wechat_kb_models.db`

路径函数加进 `query/kb-paths.ts`（那个文件存在的理由就是「知识库产物路径的唯一真源，且依赖单向」）。

```sql
CREATE TABLE kb_models (
  kb_id         INTEGER PRIMARY KEY,
  chat_ref      TEXT NOT NULL DEFAULT '',    -- '' 继承 | 'p:<profileId>' | 'm:<模型名>'
  embed_ref     TEXT NOT NULL DEFAULT '',
  rerank_ref    TEXT NOT NULL DEFAULT '',
  entities_at   INTEGER NOT NULL DEFAULT 0,  -- 本库最后一次实体抽取（0 = 从未）
  updated_at    INTEGER NOT NULL DEFAULT 0
);
```

`'m:<模型名>'` 的语义是「**用当前端点，只换模型名**」——同厂商换嵌入模型是最常见的动作，
为它再造一套凭据字段没有意义。三种取值覆盖：继承全局 / 用某套 profile / 只点名一个模型。

**这张表只存「选择」，不存凭据**（Key 永远只在 `llm.json`）。它也不存派生态——
向量是否过期由向量库自己回答（下一节），避免两处记账不一致。

### 4.3 生效解析：`resolveKbModel(decrypted, kbId, role)`

新模块 `query/kb/model-config.ts`，一处解析、三处消费（摘要 / 建索引 / 精排）。
优先级：`kb_models.<role>_ref` → `llm.json` 的该角色 → chat 回落。
**返回里必须带最终模型名与来源标记**（`inherited | profile:<id> | inline`），因为：

- 界面要能显示「本库的重排序来自：全局 profile 硅基流动」；
- 审计与向量记账要用同一个名字（C4）。

### 4.4 向量库的模型溯源（P0 与按库绑定的共同前提）

`kb_vectors` 行级加一列 `model TEXT NOT NULL DEFAULT ''`（`kb-vectors.ts:123-125` 的建表 +
`PRAGMA table_info` → `ALTER TABLE` 的既有迁移纪律）。于是：

```
本库状态 = { rows, models: 去重后的行级 model, current: resolveKbModel(...).model }
ready    = rows > 0 && models.size === 1 && models.has(current)
```

`models` 多于一个 ⇒ 半重建的中间态，判**不 ready** 并提示重建（现在只比全局 meta 的 `prevModel`，
`kb-vectors.ts:366`，表达不了「本库用 A、他库用 B」）。

---

## 五、界面：布局位置、配置入口、交互形式

### 5.1 全局：「数据配置 → AI 大模型」改成三张分组卡

现状是 `AiModelConfig.tsx:496-530` 的一串扁平字段（且 `embedPath/timeoutMs/apiPath` 根本没有 UI）。
改成：

```
┌ 已配置模型（一套 = 三个角色成套）──────────────────────────┐
│ [硅基流动 ●] [DeepSeek] [本地 Ollama] [＋ 新增一套]        │
└────────────────────────────────────────────────────────────┘
┌ 语言模型 ─────────────────┐ ┌ 嵌入模型 ──────────────────┐
│ 供应商 / 模型 / Key / 地址 │ │ 模型 / 端点(默认同语言)     │
│ 摘要 · 问答 · 实体抽取用它 │ │ 语义索引用它 · 换模型需重建 │
└───────────────────────────┘ └────────────────────────────┘
              ┌ 重排序模型 ─────────────────┐
              │ 模型 / 端点 / 超时           │
              │ 填了即启用；空 ⇒ 本地线性加权 │
              └─────────────────────────────┘
```

三块共用既有的一条保存路径（走主进程 IPC 而非 Remote，`llm-config.ts:62-120` → `main.js:1046-1052`），
`ai-model-profiles.wiring.spec.ts` 那套「切换必须真 IPC / 芯片不得渲染 apiKey / 换厂商清空 Key / 单飞闸」
的断言全部沿用，只把字段成套清单扩到三个角色。

### 5.2 按库：rail 上常驻一枚「模型」芯片（**不放进 ⋯ 菜单**）

`KbRail.tsx` 每行的 ⋯ 里现在是「重命名 / 删除」——那是**破坏性操作**的位置。
模型配置是日常查看与调整，藏进 hover 才显形的菜单里等于没有（这个隐患我在 rail 上线时就标过）。
所以：在 rail 的**当前库区块底部**常驻一枚芯片：

```
┌ 知识库 ───────────────  ┐
│  测试111        12 文件   │ ← 当前库（高亮）
│   默认知识库     3 笔记    │
│                            │
│ 🧠 模型 · 继承全局         │ ← 常驻芯片；有覆盖时变「模型 · 2 项自定义」
└────────────────────────────┘
```

点击 → kit `Dialog`（与重命名/删除同一套：× / Esc / 焦点收口 / Portal）：

```
┌ 模型 · 测试111 ────────────────────────────────── × ┐
│ 语言模型   [继承全局：deepseek-chat            ▾]   │
│ 嵌入模型   [本库指定：bge-large-zh-v1.5        ▾]   │
│ 重排序     [继承全局：bge-reranker-v2          ▾]   │
│                                                     │
│ 语义索引   已建 1,240 块 · 行内模型 bge-m3          │
│            ⚠ 与本库绑定的 bge-large-zh-v1.5 不符    │
│            [重建本库索引]   ← 换嵌入模型后升为主操作 │
│                                                     │
│ 实体抽取   从未做过（12 个文件 · 29 块）            │
│            [抽取实体]                               │
│                                                     │
│ 出网提示：本库内容将发送给 硅基流动。               │
│ 关闭「参与语义检索」的文件永不出网。                │
│                                   [取消]  [保存]    │
└─────────────────────────────────────────────────────┘
```

交互要点：

- **代价写在按钮上**，不是保存之后才告诉用户（C5）：换嵌入模型时那句「会清空本库 1,240 块向量并重建」
  出现在保存前；
- 三个下拉的选项来自 `resolveKbModel` 能看到的真源（全局 profile 列表 + 「继承全局」+「只点名模型」），
  不硬编码厂商；
- 保存后只失效 `kbCacheKey('kb-model', kbId)`（C7），**不**广播库列表更新；
- 芯片文案就是状态：「继承全局」/「N 项自定义」/「嵌入模型待重建」（红点）。

### 5.3 文件分段：语义索引入口（现在完全没有）

向量索引目前只在提问时惰性建（`gateway.ts:1682-1697`），界面上既不能触发也看不见。
在「文件」分段的工具栏加：

- 按钮 **「语义索引」**（`variant="ghost"`，与「刷新」同级；主操作仍是「添加文件」）；
- 状态栏（`stateBar`）多一枚 chip：`索引 1,240 块 · bge-m3 · 7 天前` / `索引待重建` / `未配置嵌入模型`；
- 进度沿用摘要那套在飞标记（按钮文案变「建索引中…」，**不**禁用删除按钮）。

### 5.4 笔记编辑器：模型建议的链接

`KnowledgeNoteEditor.tsx` 正文下方加一排芯片：

```
模型建议的链接（点击插入）   [[发布门禁清单]]  [[Q3 交付节奏]]  [[bge-m3]]
```

点一下把 `[[目标]]` 插到光标处；不点什么都不发生（2.1 的取舍）。
芯片上标来源分（rerank 给的分），并有一行「建议来自 <model> · 刚刚」。

---

## 六、隐私与授权

### 6.0 出网许可边界（2026-09-19 维护者明确）

> **凡是 AI 大模型相关的功能都可以出网**，包括「知识库」、「微信问答」，以及聊天消息里的「AI 问答」。

这条把「要不要为某个 AI 功能单独征求同意」这个问题**关掉了**：本方案新增的三个出网点
（`kb_rerank` / `kb_extract` / `kb_link_suggest`）**不需要**各自的开关，也不需要"检测到模型就问一次"。

三点落实：

1. **界面侧**：不为新角色新增任何开关。重排序沿用 D3「填了模型名即启用」；
   实体抽取与链接建议只在**用户主动点击**时出网（那是交互设计，不是同意机制——它们不会后台自动跑）。
2. **仍然保留的两道闸**（它们不是"AI 功能的同意"，是用户对**自己数据**的表态）：
   全局「禁止 AI 出网」（`privacyBlocked`，`gateway.ts:498-506`）与逐文件的 `include_in_rag`。
   本方案的任何调用点都不得绕过——**"AI 功能可以出网"不等于"任何数据都可以出网"**。
3. **`askWechat` 一条路径覆盖两个界面**：会话内的「AI 问答」与「微信问答」共用
   `useAskSession` + 同一个 `@Remote('askWechat')`（`panels/SessionAsk.tsx:6` 自述"没有第二条实现路径"），
   所以许可边界落在**功能名**上（`ask_wechat` / `ask_embed` / `kb_embed` …），不落在界面名字上。

**唯一保留的"摩擦"是文档与版本，不是行为**：`docs/PRIVACY.md` 必须列出每个新出网点——
这是代码契约（`src/backend/tests/privacy-statement.spec.ts` 用正则从源码抽 feature 名，
逐个要求文档含该串，漏一个立刻红），不是可选项。至于 `PRIVACY_VERSION` 要不要升 4，见 §10 D5
——**已定：保持 3**（维护者 2026-09-19 拍板「放开」），代价与不变的部分记在那一条里。
> 落地时补的一处：这条守卫原先只从 `privacyGate('…'` 与 `makeEmbedFn(…'…'` 两种形状抽名字，
> 而 P4 走的是 `makeChatAsker(kbId, 'kb_extract')` 与 `privacyBlocked('kb_extract', …)` ——
> 新出网点可以完全不写文档而没人发现。抽取规则已在 P4 补全这两种形状。

### 6.1 逐项

| 项 | 内容 |
|---|---|
| 新 feature 名 | `kb_rerank`（精排：候选文档正文）、`kb_extract`（实体抽取：文件正文）、`kb_link_suggest`（笔记正文 + 候选标题） |
| 闸门顺序 | 每个调用点先 `privacyBlocked(feature)`，判在**所有早退之前**（C3，样板 `gateway.ts:1046`） |
| gate 的 texts | rerank 必须 `[query, ...documents]` 一次过 gate 再拆回 |
| 审计 | `recordPrivacyAudit` 按功能名分列 ⇒ 三个新名字各自独立可查 |
| 文档 | `docs/PRIVACY.md` 第四节新开三张同结构表（行名固定：触发 / 发出内容 / 目的地 / 开关 / 审计 / 代码）；`wechat-host.js` 里若出现新的 `https://` 字面量，`src/backend/tests/privacy-statement.spec.ts:96-126` 会逐个要求文档列出 |
| 升版 | **建议**`PRIVACY_VERSION` 3 → 4（新增出网点是材料性变更），`src/client/ui-app/privacy/consent.ts:28` + 文档头「生效版本：vN」同步；是否升由 D5 拍板，但**文档列出是硬契约**：feature 名必须以 `privacyGate('kb_rerank'` 字面量出现（`privacy-statement.spec.ts:57-75` 用正则抽字面量，加常量不算） |
| 已知误伤 | `redactSensitiveText` 会把文件正文里 16–19 位连续数字整段换成 `[银行卡]`（订单号、无连字符 ISBN 都中）⇒ **送出去的字节与落库原文不同**，必须在 PRIVACY.md 写明，不能只说「已脱敏」 |
| 授权 | 新方法登记 `src/license/service.js:173-195 METHOD_FEATURE`（不登记 = fail-closed 回落到 `wechat-data` 档，`authorizeCall:220`）。三个新出网点建议挂 `ai-summary`；若要独立功能位则同时进 `schema.js:8-16 KNOWN_FEATURES` |
| 界面 | 未配置模型时对应入口**不报错、不显示**（C8）；被拦截时把拦截原因原样显示（摘要已经这么做，rerank 沿用） |

---

## 七、必须先修的地基（三条既有缺陷（编号 F1~F3），与本轮功能同源）

| # | 缺陷 | 证据 | 后果 |
|---|---|---|---|
| **F1** | 向量库记账的模型名恒为 `'default'` | `gateway.ts:1655,1688` 传的是 `retrConfig.embedding.model \|\| 'default'`，而该值默认 `''`（`retrieval/config.ts:107-109`）；host 实际用的是 `opts.model \|\| cfg.embeddingModel \|\| cfg.model`（`wechat-host.js:291`） | 改 `llm.json` 的 `embeddingModel` **不触发失效**（`kb-vectors.ts:366` 比的是 `'default' !== 'default'`）⇒ 旧模型的向量被当成新模型的用；维度碰巧相同就静默出错误判 |
| **F2** | 行级没有模型名，meta 只有一份全局 | `kb-vectors.ts:123-125,494-498` | 表达不了「本库 A 模型、他库 B 模型」；reset 是 `DELETE FROM kb_vectors` **清全表**（`:486`） |
| **F3** | `searchKb` 走不到 dense，降级说明硬编码 | `gateway.ts:1138-1142` 不传 embedFn；`kb-search.ts:257` 恒写 `no-vector-index` | 「文件」面板永远只有词面命中，且**永远**显示同一句降级，用户无法区分「没建」与「没配」 |

这三条不修，「按库配嵌入模型」就是在给一个会静默错用的记账系统加旋钮。

---

## 八、阶段总览

| 期 | 内容 | 出网 | 可独立回退 |
|---|---|---|---|
| **P0** | 地基 F1 / F2 / F3：模型名下沉到行、reset 只删本库、`searchKb` 接 dense + 按库建索引 @Remote | 沿用既有 `kb_embed` | ✅ 纯修账，不加能力 |
| **P1** | `llm.json` 三段角色 + profile 成套 + `AiModelConfig` 三分组卡 | 无新增 | ✅ |
| **P2** | `wechat_kb_models.db` + `resolveKbModel` + rail「模型」芯片与 Dialog | 无新增 | ✅ |
| **P3** | rerank：host 桥 + pipeline 精排阶段 + 面板精排 + 降级说明 | **新增 `ask_rerank`** | ⚠️ 需改 PRIVACY 文本（版本按 D5 保持 v3） |
| **P4** | LLM 实体抽取（推断层）+ 笔记链接建议芯片 | **新增 `kb_extract` / `kb_link_suggest`** | ⚠️ 需改 PRIVACY 文本（版本按 D5 保持 v3） |

**顺序理由（三条硬约束，不是「先易后难」）**：
① P0 不做，P2 的按库嵌入就是假配置；② P1 不做，P2 的三个下拉没有可枚举的真源；
③ P3/P4 都动隐私，合并一次 `PRIVACY_VERSION` 升版，避免让用户同意两遍。

### 各阶段步骤表

#### P0 · 地基

| 步骤 | 做什么 | 产出 |
|---|---|---|
| P0-1 | `kb_vectors` 加行级 `model` 列（`PRAGMA` → `ALTER`，迁移纪律同 `kb-files.ts:93-171`） | `query/kb-vectors.ts` |
| P0-2 | 解析出**实际**模型名并由调用方记账（C4）：host 的 `embed` 返回前把用到的名字回吐，或新增 `resolveEmbeddingModel()` 供两侧共用 | `wechat-host.js`、`gateway.ts:579` `makeEmbedFn` |
| P0-3 | reset 判据改为「本库行级 model 与当前不符」，删除加 `WHERE kb_id = ?` | `kb-vectors.ts:358-367,486` |
| P0-4 | `kbVectorIndexStatus` 回 `{rows, models, current, ready, staleReason}`；新增 `@Remote('buildKbVectorIndex')`（按库、可取消、带进度） | `gateway.ts`、`api.ts` |
| P0-5 | `searchKb` 接 dense：把 `kbChannel` 的稀疏+dense+RRR 融合格式化复用，`degraded` 改为**如实**（未配模型 / 未建索引 / 索引过期 三种文案） | `query/kb-search.ts`、`gateway.ts:1138` |
| P0-6 | 「文件」分段：语义索引按钮 + 状态 chip | `panels/KbFiles.tsx`、`kbfiles.module.css` |

**验收**：V1 + V3。变异：把 `WHERE kb_id = ?` 去掉 ⇒ 必须有测试变红（他库行数被清）；
把行级 model 写回常量 `'default'` ⇒ V1 的判据变红。

#### P1 · 三段可配

| 步骤 | 做什么 |
|---|---|
| P1-1 | `defaultLlmConfig` 补 `embeddingApiUrl/embeddingApiKey/rerankModel/rerankPath/rerankApiUrl/rerankApiKey/rerankTimeoutMs`（**先加这里**，否则读不出来） |
| P1-2 | `LLM_PROFILE_FIELDS` / `pickLlmProfileFields` / `normalizeLlmProfile` 扩到三角色成套；`apiPath/embedPath/rerankPath` 空串回落 base |
| P1-3 | `llmConfigFromEnv` 加 env 兜底；`WechatLlmConfig` 与 `llm-config.ts:64` 的第二份硬编码默认值同步 |
| P1-4 | `AiModelConfig.tsx` 三分组卡；profile 芯片显示「含 3 个角色」 |
| P1-5 | 守卫：`ai-model-profiles.wiring.spec.ts` 字段成套清单更新 + `llm-profiles.spec.ts` 加「只改 rerank 模型不换 chat Key」用例 |

**验收**：V5。

#### P2 · 按库绑定

| 步骤 | 做什么 |
|---|---|
| P2-1 | `kb-paths.ts` 加 `KB_MODELS_DB` / `kbModelsDbPath`（保持依赖单向，见该文件头注的理由） |
| P2-2 | 新模块 `query/kb/model-config.ts`：建表 + `getKbModelSettings` / `setKbModelSettings` / `resolveKbModel` |
| P2-3 | `@Remote('getKbModelConfig')` / `@Remote('setKbModelConfig')`；`getKbs` 合流带出「是否自定义」 |
| P2-4 | 三个消费点改走 `resolveKbModel`：`summarizeKbFile`、`makeEmbedFn`（建索引）、rerank（P3 接入时即用） |
| P2-5 | rail 常驻芯片 + Dialog；缓存 `kbCacheKey('kb-model', kbId)`，写完只清这层（C7） |
| P2-6 | 换嵌入模型时代价提示 + 「重建本库索引」升为主操作（C5） |

**验收**：V4 + V1（切库不串味）。变异：`setKbModelConfig` 少清一层缓存 ⇒ 必须有测试变红；
`resolveKbModel` 漏掉 `kb_id` 作用域 ⇒ 另一个库读到覆盖值。

#### P3 · 重排序

| 步骤 | 做什么 |
|---|---|
| P3-1 | `wechat-host.js`：`embed` 旁新增 `rerank(query, documents, opts)`，形状照 `:289-321`（`fetchWithRetry` + `AbortController` + 按 `index` 归位 + 数组缺失兜底）；出口对象加 `rerank` |
| P3-2 | `gateway.ts`：`makeRerankFn(kbId, feature)` —— 先 `privacyBlocked('kb_rerank')`，再 `privacyGate` 一次过 `[query, ...docs]` |
| P3-3 | `pipeline.ts`：RRF 融合后、`rank.ts` 前插入精排；未配置 ⇒ 整段跳过且**逐字节等于现在**；`channels[].note` 写明用了什么 |
| P3-4 | `searchKb` 面板结果精排（配了才排）；候选文档**复用稀疏通道的同一条 SQL**（`onlyRag` 下推），不在别处另拼池子（R2） |
| P3-5 | 依据行/来源行显示「精排：<model>（候选 60 → 取 12）」或「精排：本地线性加权」 |
| P3-6 | 隐私三件套：`PRIVACY.md` 新表 + `PRIVACY_VERSION` 4 + `METHOD_FEATURE`；`docs:api`、计数同步（C6） |

**验收**：V2 + V7。变异：把 gate 的 texts 从 `[query, ...docs]` 改成 `[query]` ⇒ 隐私用例必须变红；
把 `privacyBlocked` 挪到「未配置模型」早退之后 ⇒ 顺序用例变红（这条在摘要上已经实测过一次）。

#### P4 · 实体抽取与链接建议

| 步骤 | 做什么 |
|---|---|
| P4-1 | 新模块 `query/kb/extract.ts`（推断层，与 `entities.ts` 并列且互不引用）：按文件一次、产出实体/主题词落 `kb_doc_entities(file_id, label, kind, model, at, ...)` |
| P4-2 | `@Remote('extractKbFileEntities')` / `@Remote('extractKbEntities')`（批量带进度） |
| P4-3 | `getKnowledgeGraph` 合流新增 `kind: 'suggest'` 边；画布虚线 + 图例「模型推断」；`graph-model.ts` 的节点命名空间白名单扩一支并保留反向守卫 |
| P4-4 | `@Remote('suggestKbLinks')`：嵌入召回候选 → rerank/LLM 判定 → 返回候选文本（**不写库**） |
| P4-5 | 编辑器芯片：点击插入 `[[目标]]`，边仍由 `parseWikiLinks` 派生 |
| P4-6 | 隐私与计数同 P3 走一遍 |

**验收**：V6。变异：让 `extract.ts` 去 import `entities.ts`（破坏 C2 的单向）⇒ 守卫变红；
让建议**自动写入**正文 ⇒ 契约用例变红。

---

## 九、风险登记册

| # | 风险 | 等级 | 处置 |
|---|---|---|---|
| R1 | 换嵌入模型 = 重新出网重建全库向量，用户在没看清代价时点下去 | 高 | C5：保存前写明块数与「会清空」；重建按钮要二次确认 |
| R2 | rerank 的候选文档若另起一处构造，可能绕过文件级出网开关 | 高 | **既有三条通道都过滤得对**（稀疏 `kb-channel.ts:251` 传 `onlyRag:true`；建库语料 `kb-vectors.ts:389` JOIN `include_in_rag = 1`；回读 `:585` 再判一次）。风险只在新阶段自己拼池子 —— P3 必须复用同源查询，并加断言「池子里出现 `include_in_rag = 0` 的文件即失败」 |
| R3 | 脱敏把订单号/ISBN 打成 `[银行卡]`，模型据此判相关性 → 结果不可复现 | 中 | PRIVACY.md 如实写明；审计记 `chars`；在精排的 note 里标「已脱敏」 |
| R4 | 三套配置命名空间（`llm.json` / `rag-config.json` / `agentDefaultModel`）继续并存，`rag-config.embedding.model` 是个没人配的幽灵字段 | 中 | P0-2 把「实际用的名字」收成一个解析函数；`rag-config` 里那个字段要么接上要么删，**不许留着不生效** |
| R5 | 精排引入新的失败模式（超时/429），一次提问被拖长 | 中 | 独立 `rerankTimeoutMs`（默认 20s，比 chat 短）；失败 ⇒ 记一条降级说明并回退到融合名次，**不整体失败** |
| R6 | 每库覆盖三个角色后，「同一句问题在两个库结果不同」难以解释 | 低 | 依据行始终标出本库三角色实际用的模型与来源（继承/profile/点名） |
| R7 | 方法计数与文档漂移（历史上红过两次） | 低 | C6 清单 + `docs:api:check` 已在 CI |

---

## 十、决策记录（本轮已定）

| # | 决策 | 影响 |
|---|---|---|
| D1 | 交付形态：**先落本设计文档，评审后再开工** | 本轮不写实现代码 |
| D2 | 按库绑定粒度：**三个角色各自可覆盖**（继承全局 / 指定 profile / 只点名模型） | `kb_models` 三列 + rail Dialog 三行下拉 |
| D3 | 重排序默认状态：**填了模型名即自动启用**，不设 `rerankEnabled` | 关闸只剩「禁止 AI 出网」与逐文件 `include_in_rag`；`PRIVACY.md` 必须写明「配了模型 = 会发」 |
| D4 | 出网许可边界：**AI 大模型相关功能整体可出网**（知识库 / 微信问答 / 会话内「AI 问答」），不为单个功能另设同意开关 | 详见 §6.0。数据级两道闸不变；「AI 功能可以出网」≠「任何数据都可以出网」 |
| D5 | `PRIVACY_VERSION` **保持 3，不升版**（2026-09-19 维护者拍板：「放开」） | 只更新 `docs/PRIVACY.md` 文本、逐个列出新出网点；`consent.ts:28` 不动。已知代价（维护者已接受）：已同意 v3 的用户不会被动重读新声明。**不变的部分**：`privacy-statement.spec.ts:48-55` 仍要求文档头「生效版本」与 `consent.ts` 一致，`:57-83` 仍要求每个 `privacyGate('xxx'` 字面量在文档里出现——这两条是代码契约，与升不升版无关 |

### 待确认（开工前需要拍板的三件小事）

1. `rag-config.json` 的 `embedding.model`（R4）：**已定 —— 保留，但改接进单一解析**。
   它现在是 `embedModelName(override)` 的 override 入参（不再是「记账用它、发送用另一个」的幽灵字段），
   因此既没有静默改变手改过该文件的人的行为，也让「实际用的名字」只剩一个出处。
2. 笔记向量化（2.2 第 2 条）：**仍待定**（P4 之后）。
3. 实体抽取是否随「重建索引」顺带跑：**已定 —— 不顺带**（P4 落地时决定）。
   §6.0 第 4 条写的是「实体抽取与链接建议只在用户主动点击时出网」，把它挂到重建索引上
   等于让一次点按钮发出**两类**请求（正文进向量 + 正文进语言模型），
   而审计与代价提示都会糊在一起。界面上抽实体是弹层里独立的一行、独立的按钮。

---

## 十一、落地记录

### P0 · 地基（2026-09-20 完成 ✅）

| 项 | 证据 |
|---|---|
| F1 记账名 = 发送名 | `wechat-host.js` 新增 `resolveEmbedModel(cfg, override)`，`embed()` 与新的 `embeddingModelName()` **共用它**；`gateway.ts` 的 `embedModelName()` 转发给宿主，四处调用点（消息建库 / 知识库建库 ×2 / `buildRagVectorIndex`）全部改用它 |
| F2 行级溯源 | `kb_vectors` 加 `model` 列（`PRAGMA` → `ALTER` 迁移）；`done` 游标加 `AND model = ?`；状态新增 `models[] / current / staleReason` |
| C5 只作废本库 | 三种作废范围：结构升版清全表、`force` 清本库、换模型**只删本库非当前模型的行**。旧实现「换模型清全表」的前提（全库共用一个模型）已随按库绑定失效，头注同步改写 |
| F3 如实降级 | `@Remote('searchKb')` 现在跑稀疏 + 稠密 + RRF；`degraded.reason` 从 3 种扩到 6 种（新增 `no-embed-model` / `index-stale` / `embed-failed`），不再是硬编码 |
| 按库建索引入口 | 新增 `@Remote('getKbVectorIndex')` / `@Remote('buildKbVectorIndex')`（出站拦截判在最前、只建本库、只取 `include_in_rag=1`）；`LONG_CALL_METHODS` 已登记；方法数 152 → 154（`OnboardingShell` / `README` / `docs/API.md` 同步） |
| 界面 | 「文件」分段页头加「语义索引」按钮（ghost，只锁自己），工具栏右侧加状态徽标（ok / warn / muted 三色调 + 在飞进度后缀） |

**验收**：V1 + V3 达成。
- 网关级新用例 `src/backend/wechat-data/tests/kb-vector-index.spec.ts`（13 条）：换模型后状态立刻判 `model-mismatch` 且 `ready=false`、旧行不被偷删、别的库一行不动、出站拦截时 `embed.calls` 为空、逐文件关掉出网时正文从未发出、四种降级各有其话、关键词搜不到而语义搜到时稠密补上。
- 宿主级新用例 `src/backend/tests/llm-embed-model.spec.ts`（4 条）：假 fetch 收到的 `body.model` 与 `embeddingModelName()` **逐字相同**（这条是 F1 的根治判据 —— 网关用例注入的是桩 llm，看不见宿主桥）。
- 模块级用例扩到 28 条（新增老库迁移、漏传模型名不背书两条）。
- 变异自证：`working/mutate-kb-vectors.mjs` 5/5 被杀、`working/mutate-embed-accounting.mjs` 3/3 被杀、`working/mutate-kb-index-ui.mjs` 6/6 被杀。
  其中两条**第一轮是存活的**，各自补了用例才咬住：① 「调用方没给模型名时谎报就绪」（原先没有一条用例走 `current=''`）；
  ② 「host 侧 embed 不再走同一解析」（原先的网关用例用桩 llm，桥根本不在链路上）。
- 视觉：`working/kb-index-harness.png`（产物 CSS + 真哈希类名，五种状态并排），计算样式实测三种色调取到的是真实颜色而非 `rgba(0,0,0,0)`。
- 全量：1976 通过（仅 4 条 `secure-fs.spec.ts` 的 Git Bash `whoami` 环境失败，与本文件无关）；typecheck 干净；`build:backend` / `build:types` / `docs:api:check`(154) / `build:ui` 全绿。

**一处刻意的取舍**：`api.ts` 的长度门禁从 2300 抬到 2400。正解是把 `WechatRemote` 接口摘到独立模块，
但它引用了 16 个声明在 `api.ts` 本地的类型（`RemoteResult`、`VectorBuildResult`、`*SnapshotRead` …），
摘出去就得连它们一起搬 —— 那是 M21 的独立一片，不该塞进一次功能改动。抬档的理由与「仍能咬住什么」
写在 `api-module-split.spec.ts` 的沿革注释里（cache.ts 209 行 / media-cache.ts 113 行，
任一份被内联回来都会超过 2400）。

**未做**（P0 范围内确认不需要）：`buildKbVectorIndex` / `getKbVectorIndex` 未登记进 `METHOD_FEATURE`，
与消息域的 `buildRagVectorIndex` 保持一致（回落 `wechat-data` 档）。若之后要按功能位停掉索引能力，
两个方法要一起登记，否则会出现「能建不能看」或反之。

### P1 · 三段角色可配（2026-09-20 完成 ✅）

| 项 | 证据 |
|---|---|
| 4.1 字段 | `defaultLlmConfig` 补 8 个键（`embeddingApiUrl/Key`、`rerankModel/Path/ApiUrl/ApiKey/TimeoutMs`）；`LLM_PROFILE_FIELDS` 从 8 项扩到 15 项；`pickLlmProfileFields` 对两个超时统一收敛 |
| 读取链 | `llmConfigFromEnv` 加 7 行 + `SUPERTIME_LLM_RERANK_*` 环境变量兜底；`embed()` 改用**回落之后**的 `embeddingApiUrl \|\| baseUrl` 与 `embeddingApiKey \|\| apiKey` 判定与发请求（此前只会用 chat 那对，独立凭据填了也不生效） |
| 客户端镜像 | `WechatLlmConfig` 补 7 个可选字段 + `apiGetLlmConfig` 的兜底默认同步；`configOf` 改成「四个 chat 字段显式写 + 八个角色字段走循环 + 数值超时单列」 |
| 界面 | `AiModelConfig.tsx` 的扁平表单拆成三张分组卡（`RoleInput` 共用一个「标题 + 输入」件），`.roleHead` 用左侧竖条分组 —— 小屏单列时仍分得开 |
| 顺手修掉的一个真缺陷 | `saveLlmConfig` 以前把表单值**原样**写进顶层（只有 profile 那份走了收敛）。对 `timeoutMs` 恰好无害（读取端 `Number(x \|\| 默认)` 会吃掉 0），但 `rerankTimeoutMs: -5` 会一路活到 `setTimeout(-5)` ⇒ 每次精排在发出的同一刻被 abort，界面只显示「模型调用失败」。现在落盘前统一收敛 |

**验收**：V5 达成。
- `llm-profiles.spec.ts` 新增一组「三个角色成套」（4 条）：全套字段往返一致、切到不含精排的旧 profile 时**残留必须被清掉**、只改精排不动 chat 的 Key、坏超时按默认收敛。
- `llm-embed-model.spec.ts` 新增 2 条：独立凭据的回落、以及「只填 embeddingApiKey 时不得被误判成未配置」。
- `ai-model-profiles.wiring.spec.ts` 新增一组（3 条）：三张卡的存在与自述、七个字段接进表单而两个路径**刻意不暴露但必须被带着走**、`configOf` 逐字段点名。
- 变异自证 `working/mutate-llm-roles.mjs` 4/4 被杀。其中两条**第一轮存活**、补了断言才咬住：
  R2 缺 `embeddingApiKey`（原用例只查了 `embeddingModel` 被清）、R4 `configOf` 漏挑一个键（原用例只查了表单侧）。
- 视觉：`working/ai-model-roles-harness.png` —— 三张卡的竖条/标题/说明与 11 个输入框实测取到真实样式（`2px solid rgb(0,240,255)`、输入底色 `rgb(15,23,42)`、两列 358px）。
- 全量 1985 通过（仍只有那 4 条环境失败）；typecheck 干净；`build:backend` / `build:types` / `build:ui` 已重建。

**一处刻意的不同**：`embedPath` / `rerankPath` 与既有的 `apiPath` 同口径 —— **界面上不暴露**，
但必须留在类型与 `configOf` 清单里。守卫把这两件事分别钉住（有输入框 = 红，被漏挑 = 红）。

### P2 · 按库绑定（2026-09-20 完成 ✅，含一处对设计的收窄）

| 项 | 证据 |
|---|---|
| 4.2 存储 | 新 db `wechat_kb_models.db`（路径函数进 `kb-paths.ts`）+ 新模块 `query/kb/model-config.ts`；`kbs` 表与 `notes.ts` 的**语义**未动（只加了一行 `modelOverrides: 0` 占位，与 `fileCount: 0` 同一既有范式 —— 笔记层看不到别的 db 文件这件事在类型上留痕） |
| 4.3 解析 | `resolveModelRef(ref, globalModel)` 纯函数 + gateway 的 `kbModel(kbId, role)`；`globalModelName(role)` 三个角色都从宿主桥取，杜绝第二条链 |
| 消费点 | `summarizeKbFile`（chat）、`buildKbVectorIndex` Remote 与提问时惰性补齐（embed）、`getKbVectorIndex` / `searchKb` 的降级判定（embed）全部按库解析；`getKbs` 合流带出 `modelOverrides` |
| 两个 Remote | `getKbModelConfig`（同时回引用串 / 全局值 / 生效值）、`setKbModelConfig`（非法引用**拒绝**而不是静默改成继承）；方法数 154 → 156 |
| 级联 | 删库时清设置行 —— 不复用 rowid 是 SQLite 的事实，留着会让将来同一个 id 的新库**继承上一个库的模型覆盖** |
| 界面 | rail 底部常驻「模型」芯片（有自定义时染青），点开 `KbModelDialog`：三行角色 + 每行「实际使用：X · 继承全局/本库指定」+ 索引状态 + 换模型代价提示 + 「重建本库索引」（索引不可用时它升为 primary） |

**验收**：V4 达成。
- `kb-model-config.spec.ts`（17 条）：读路径无写副作用、非法引用不静默纠正、按库隔离、删库级联、`entities_at` 不算覆盖。
- `kb-vector-index.spec.ts` 新增 8 条网关级用例：本库指定 ⇒ 行记指定名、乙库不受影响、改覆盖后索引立刻判 `model-mismatch` 且面板降级说「需重建」、取消覆盖回到可用、`getKbs` 合流计数、非法引用被拒。
- 变异自证 `working/mutate-kb-model-binding.mjs` 5/5 被杀（漏带 kbId 解析 / 状态不看覆盖 / 不合流计数 / 写完不清列表层 / 失败也广播）。
- 界面守卫新增一条（`kb-files.wiring.spec.ts`）钉住「读键带库 id + 两层失效 + 只在写成功后清列表」。
- 视觉：`working/kb-model-dialog-harness.png` —— 芯片两态、三行角色、`effective` 的 inline/inherit 双色、索引不可用的琥珀色与代价提示均实测取到真实样式。
- 全量 2011 通过（仍只有那 4 条环境失败）；typecheck 干净；产物全部重建。
- 新面板被既有的 `transient-notice.wiring.spec.ts` 抓过一次（我自己写了 `setNotice` 而不是公共 hook），已改用 `useTransientNotice()` —— 这条门禁的价值当场兑现了一次。

**对设计的一处收窄（需要你知道）**：`§4.2` 原本写了三种引用（继承 / `p:<profileId>` / `m:<模型名>`），
实现只做了**继承与点名**。按库引用整条 profile 意味着每次调用都要带着那条 profile 的地址与 Key 走，
而「A 家地址 + B 家 Key」正是 profile 这套东西要消灭的 401 陷阱 —— 按库各持一份凭据等于把它请回来，
且要把 chat 的流式请求路径改成支持逐次端点覆盖。真要按库换厂商，正确动作是换全局生效的那一条。
理由记在 `model-config.ts` 头注与本节。

### P3 · 模型精排上线（2026-09-20 完成 ✅）

| 项 | 证据 |
|---|---|
| 宿主桥 | `wechat-host.js` 新增 `rerank(query, documents, opts)`（`fetchWithRetry` + `AbortController` + `rerankTimeoutMs`）与 `rerankModelName()`；响应兼容 `results/relevance_score`、`results/score`、`data/relevance` 三种形状，**按 `index` 贴回原位**，缺项按 0 分 |
| 隐私闸 | `gateway.ts` 的 `makeRerankFn`：`privacyBlocked('ask_rerank')` 判在最前 → `privacyGate('ask_rerank', …, [query, ...documents])` 一次过闸再拆回。功能名叫 `ask_rerank` 而不是设计稿里的 `kb_rerank` —— 候选既可能来自聊天也可能来自文件，按知识库命名会让审计那一列读起来只管文件（偏差记在 §6 与本节） |
| 管道 | `pipeline.ts` 的 **4.5 段**：本地打分选出头部 → 模型决定头部先后 → 尾部原样接上。`recencyFirst` / 纯时间问法**不参与**（那种问法要的是时间序，按相关性重排会把最新一条挤掉） |
| 界面 | 依据行追加 `· 精排：<model>（候选 N → 取 M）` 或 `· 精排：本地线性加权（未配置重排序模型）` |
| 文档 | `docs/PRIVACY.md` 新增 **B2 节**（触发/发出内容/目的地/开关/审计/代码 六行齐全），并如实写出脱敏误伤：文件正文里 16–19 位连续数字会被换成 `[银行卡]`，模型读到的字节与落库原文不同 |
| 版本 | `PRIVACY_VERSION` 保持 3（决策 D5：只改文本、不逼用户重读） |

**一个真实缺陷是被测试抓出来的**：第一版把精排插在**融合之后、本地打分之前**（照 §2.3 的字面写的）。
结果 `rerankDocs` 按自己的 8 个特征从头排序，模型给的顺序被完全覆盖 ——
「精排被调用了却没改变任何顺序」那条用例直接变红。位置改到本地打分**之后**才是对的语义：
本地打分负责选出该精排的头部，模型负责决定头部的先后。这条教训写进了 4.5 段的注释。

**验收**：V2 + V7 达成。
- `src/backend/tests/llm-rerank.spec.ts`（10 条）：端点/Key 回落、未配模型时拒发且不借用 chat 模型名、请求体形状、乱序响应对齐、缺项 0 分、三种形状、越界 index、空候选不发、HTTP 503 抛错、`rerankModelName()` 与实发同源。
- `kb-vectors.spec.ts` 新增 F 组（4 条）：不注入 ⇒ `used:false` 且写明本地加权；注入 ⇒ 查询词与全部候选送出、分数条数 == 候选数；**顺序真的变了**；抛错 ⇒ 不阻断、note 含原因、引用条数与不精排时一致。
- `privacy-statement.spec.ts` 新增一条源码级守卫：gate 的入参必须含候选文档、`privacyBlocked` 必须判在 `privacyGate` 之前。
- 变异自证 `working/mutate-rerank.mjs` 6/6 被杀。其中两条**第一轮存活**、查因后各自补硬：
  C3 的锚点 `[query, ...documents]` 在 JSDoc 里也出现，`String.replace` 只换第一处 ⇒ 变异改到了注释、代码没动，
  「存活」是假的；锚点改成带右括号的代码形状后被杀。这条教训值得记住：**变异锚点必须落在代码上**，
  与「断言不许被注释骗过」是同一条纪律的另一半。
- 全量 2025 通过（仍只有那 4 条环境失败）；typecheck 干净；后端 bundle / types / `docs:api:check`(156) 已重建。

**没有新增 @Remote**：精排骑在 `askWechat` 里，所以 `METHOD_FEATURE` 不需要新条目（`askWechat` 已是 `ai-ask`），
`LONG_CALL_METHODS` 也已有它。

### P4 · 实体抽取与链接建议（2026-09-20 完成 ✅，含两处对设计的收窄）

| 项 | 证据 |
|---|---|
| 推断层模块 | 新 `query/kb/extract.ts`：`parseEntityLines`（宽容格式、**吃不下的行丢弃并计数**）、`buildExtractPrompt`（截断过就写明「只是开头部分」）、`readDigestForExtract`（`include_in_rag = 1` 写在 SQL 里）、`saveDocEntities`（**整批替换**该文件上一次的结果）、`kbEntitySummary`（进度：可抽 / 还没抽 / 已存 / 最近用的模型） |
| 落库 | `kb_doc_entities(kb_id, file_id, label, kind, weight, model, created_at)` 在**文件库**里（它数的是「这个库的文件里有什么」），`UNIQUE(kb_id, file_id, label)` |
| 图谱合流 | `getKnowledgeGraph` 追加 `docEntities` 节点与 `kind: 'suggest'` 边；`mergeDocEntities` 把逐文件的**行**合并成**节点**（同名同类跨文件一个点、同名不同类**不**合并） |
| 渲染 | `ent:` 第五个命名空间；实体额度只有文档族的一半（`entLimit`），`suggest` 与 `mention` 同属推断层、共吃观测层剩下的额度；画布 `docColors()` 屏幕与导出 SVG 共用一份，虚线 = 推断；详情与气泡一律自报「模型推断 · 由 <模型> 抽出」 |
| 两个 Remote | `extractKbEntities`（批量、单轮 ≤20 文件、逐文件失败原因带回）、`suggestKbLinks`（**只读**）；方法数 156 → 158，两者都进 `LONG_CALL_METHODS` 与 `METHOD_FEATURE`（挂 `ai-summary`） |
| 建议模块 | 新 `query/kb/suggest.ts`：纯排序，唯一依赖是 `vector-math.ts`，**没有任何写路径**（源码级守卫钉住），也不 import 笔记/文件模块 |
| 界面 | 弹层加「实体抽取」一行（还剩几个没抽 + 「抽取实体」按钮，未配语言模型时禁用并说明）；笔记编辑器正文下加芯片行 —— **点「找链接建议」才出网**，点芯片才把 `[[目标]]` 插到光标处 |
| 文档 | `docs/PRIVACY.md` 新增 **B3 / B4** 两节（六行齐全），并写明「它不写你的笔记」；`PRIVACY_VERSION` 保持 3（D5） |

**一个真实缺陷是测试抓出来的**：`alreadyLinked` 第一版按 `\[\[(.+?)\]\]` 整段取目标，
于是 `[[验收标准|Q3 的验收标准]]` 这种**别名写法**算没连过 —— 用户已经连上的目标会被再建议一次，
而且那个候选还会带着 `|` 后面的显示文本被发出去。判据改成与 `parseWikiLinks` /
编辑器 `extractTargets` 同一口径（取 `|` 之前那段）后被咬住。这是「同一个语法在四处各解析一遍」
的老代价，第四处也补了断言。

**顺带把一道守卫补全了**：`privacy-statement.spec.ts` 原来只从 `privacyGate('…'` 与
`makeEmbedFn(…'…'` 两种形状抽功能名。P4 的两条走的是 `makeChatAsker(kbId, 'kb_extract')`
与 `privacyBlocked('kb_extract', …)` —— 也就是说**新出网点可以完全不写文档而没人发现**。
抽取规则补了这两种形状（`sns_cover_fetch` / `sns_video_fetch` 因此也被要求列出，文档如实写明它们进的是操作记录而不是 AI 审计表）。

**两处刻意的不同（需要你知道）**：
1. `P4-2` 原本要 `extractKbFileEntities` + `extractKbEntities` 两个 Remote，实现只有**一个**：
   单文件就是 `fileIds: [id]` 的特例。两个入口会把「重跑覆盖上一个结果」这条语义写两遍，
   而它是这一层最容易写错的地方。
2. `P4-4` 原本写「嵌入召回候选 → rerank/LLM 判定」，实现只做到**嵌入排序 + 阈值**：
   候选是几十个短标题，余弦序够用；再叫一次模型要多发一遍正文、多一种失败模式（超时/429），
   换来的只是「把 0.42 分说成值得连」—— 值不值得连由人点，不由模型说。
   rerank 也没借：`makeRerankFn` 的审计名是 `ask_rerank`（问答管道），用它会把
   「笔记正文出网」记成「聊天候选出网」，正是 §6.1 要防的那种含糊。

**验收**：V6 达成。
- `kb-extract.spec.ts`（21 条）：格式宽容但不猜结构、封顶与截断标注、重跑是替换、按库隔离、
  越界 fileId 一次不发、关掉出网开关的文件不发、模型抛错不写库、成功路径带模型名与时间；
  ④ 组合并成节点（该合的合 / 同名不同类不合 / 权重取每文件最高 / 模型取最近一次 / 空输入不造幽灵点）。
- `kb-link-suggest.spec.ts`（17 条）：`alreadyLinked` 含别名写法、相似度降序 + 阈值 + topK、
  去重、池上限与实际发出的文本条数一致、空正文零请求、抛错带回原因；网关级：拦截优先于「未配置」、
  不出网的文件既不进本轮也不算进「可抽」、进度可见地变化、单文件失败不拖垮整轮、
  **建议前后笔记一字未变**、已连目标不再被发出去。
- 图谱侧：`graph-model.stub.spec.ts` 新增「模型实体层」6 条（`ent:` 前缀 / 中性灰 / 自报模型 /
  suggest 断链与额度 / 不吃文档族额度 / 旧渲染缓存不崩），`graph-canvas.spec.ts` 新增文档层 5 条
  （三色可辨且深浅两套齐、**导出 SVG 与屏幕同源**、三类都不要头像、entity 气泡自报推断、`docColors` 单一定义两处调用）。
- 界面守卫 `kb-inference-ui.wiring.spec.ts`（14 条）：芯片接 Remote 且抽完重读、未配模型时禁用并说明、
  代价写在按钮上、进度说「还剩几个」、点击才插入（无自动触发）、用光标位置、每次打开清候选、
  **缓存里可能没有 `entities` 时必须兜底**（`cachedFetch` 命中且远程失败会直接回吐上一份，
  而那份可能是 P4 之前的形状 —— 与图谱 `docEntities ?? []` 同一取舍）、
  api 层缓存口径（抽完清两层、只在真有新东西时广播、建议**不缓存**）。
- 变异自证：`working/mutate-kb-entity-graph.mjs` 7/7 被杀，`working/mutate-kb-inference.mjs` 14/14 被杀。
- 视觉：`working/kb-inference-harness.png`（弹层的实体抽取行 + 编辑器的芯片行，实测 `chip` 边框
  `dashed 1px rgb(245,158,11)`、底色 10% 琥珀、圆角 999px）与 `working/kb-graph-legend-harness.png`
  （图例六格全部取到真实颜色，含新增的青/灰蓝/琥珀三点与琥珀虚线）。
- 全量 2095 通过（仍只有那 4 条环境失败）；typecheck 干净；后端 bundle / types /
  `docs:api:check`(158) / `build:ui` 已重建。
