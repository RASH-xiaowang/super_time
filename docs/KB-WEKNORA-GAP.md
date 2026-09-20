# 知识库能力差异清单 · WeKnora 对照（KB-WEKNORA-GAP）

> **产出日期**：2026-09-19
> **对照对象**：WeKnora（腾讯开源知识库问答系统）官方文档站 `https://weknora.weixin.qq.com/docs/`
> **文档依据**：全站页面清单取自 `https://weknora.weixin.qq.com/docs/hashmap.json`（共 **54 页**），
> 其中 `03-features` 23 页、`02-architecture` 5 页、`04-api` 16 页、`05-clients` 8 页、`01-getting-started` 4 页、`06-development` 3 页。
> **本仓库对照基线**：`docs/KB-RAG-PLAN.md` 执行进度表（T1/T2/T3 ✅，T4~T6 ⚪）+ 源码实读
> （`src/backend/wechat-data/src/query/{kb,kb-files.ts,kb-search.ts,notes.ts,graph.ts,retrieval/*}` 与
> `src/client/ui-wechat/src/client/pages/wechat-data/panels/{KbFiles,KnowledgeBase,Ask,Graph}.tsx`）。
>
> **一句话结论**：本仓库知识库已完成「**能装进来、能看见、关键词能搜到**」的前半程；
> 与 WeKnora 的差距**不在后端工程规模**（多租户 / IM / 沙箱 / 云存储那一层对本产品是**不适用**，见第五节），
> 而在**三处真正的功能断层**：① 知识库**还没被问答管道消费**；② 解析侧只有纯文本族，**PDF / Word / Excel 进不来**；
> ③ 知识库检索**只有稀疏单通道**，没有融合、重排与查询改写。

---

## 摘要（结论先行）

| # | 断层 | 严重度 | 现状 |
|---|---|---|---|
| **G-01** | **知识库没有接入问答管道**——`searchKb` 只被 `KbFiles.tsx` 调用，`ask.ts` 全文 **0 处** 提到知识库 | 🔴 致命 | 计划的 1.1 目标是「让问答能引用你上传的东西」，T3 只做到「**面板内**可搜」 |
| **G-02** | **稠密通道缺席**（T4 未做），KB 每次检索都是降级态 | 🔴 高 | 消息侧 `dense` 通道早已可用，KB 侧复用不了 |
| **G-03** | **B 档解析器缺席**（T5 未做），PDF / docx / xlsx 登记后 `parse_state=unsupported` | 🔴 高 | B 档文案已写好、状态已预留，但**没有解析器** |
| **G-04** | KB 检索**无融合 / 无重排 / 无查询改写 / 无意图路由** | 🟠 中高 | 这四件在**消息侧全都已实现**（`retrieval/`），KB 侧一件都没接 |
| **G-05** | 解析**只有同步路径，没有任务队列与执行器** | 🟠 中 | 中间态（`parsing`/`chunking`/`embedding`）已预埋但**无人消费** |
| **G-06** | 图片 / 音视频内容不解析（计划明确不产出） | 🟡 中 | Whisper 本机已有（语音转写），但只作用于微信语音 |
| **G-07** | 无 FAQ 型条目、无文档主题页（Wiki）、无文档实体图谱（GraphRAG） | 🟡 中 | 现有「知识图谱」是**联系人/群社交关系图**，与文档实体图谱是两件事 |

---

## 一、WeKnora 能力谱（按类别归纳）

### 1.1 文档接入与解析

| 能力 | 作用与关键特性 | 文档位置 |
|---|---|---|
| 多格式文档接入 | PDF / Word / PPT / Excel / Markdown / HTML / EPUB / 图片 / 音频 / URL 均可入库；`MAX_FILE_SIZE_MB=50` | `03-features/03-document-parsing` |
| 解析引擎可插拔 | 两个域并存：Python `docreader` 侧 `builtin`/`markitdown`/`opendataloader`；Go 侧 `anydoc`/`mineru`/`weknoracloud`/`paddleocr_vl` | `03-features/03-document-parsing`、`02-architecture/03-document-pipeline` |
| PDF 逐页路由 | 逐页判定 `text` / `scanned`，扫描页转 OCR / VLM，不整份降级 | `03-features/03-document-parsing` |
| 解析状态机与异步管道 | `pending → processing → completed/failed`；解析在异步任务里跑，不阻塞请求 | `02-architecture/03-document-pipeline`、`02-architecture/05-async-tasks` |
| 外部数据源定时同步 | 飞书 / Lark / 飞书云盘 / Notion / 语雀 / GitLab / 腾讯 IMA / 钉钉 / RSS 共 10 类；cron 调度、增量/全量、删除检测、凭据 AES-256-GCM 加密、超时 2h、重试 5 次、失败样本上限 100、429 退避 2s/4s/8s | `03-features/10-datasource` |

### 1.2 分块

| 能力 | 作用与关键特性 | 文档位置 |
|---|---|---|
| 自适应分层分块 | 三 Tier：`heading`（有标题结构）/ `heuristic`（启发式）/ `legacy`（退化） | `03-features/04-chunking` |
| 父子分块 | parent `4096` / child `384`；检索命中 child，回填 parent 给模型 | `03-features/04-chunking` |
| 参数默认值 | `chunk_size=512` / `overlap=80` | `03-features/04-chunking` |
| 表格头追踪 | 表格块携带表头语义，避免「28000 是谁的月薪」这类无主语证据 | `03-features/04-chunking` |
| 图片子块 | 每个图片产 `caption` 子块 + `ocr` 子块，参与检索 | `03-features/04-chunking` |
| 分块预览调试接口 | `POST /chunker/preview`，改参数前先看切出来长什么样 | `03-features/04-chunking` |

### 1.3 索引管道

| 能力 | 作用与关键特性 | 文档位置 |
|---|---|---|
| 六类索引并行 | **向量 / 关键词(BM25) / FAQ / Wiki / 知识图谱 / 预生成问题** | `02-architecture/04-rag-pipeline`、`03-features/02-knowledge-base` |
| 索引与模型绑定 | 换 embedding 模型 ⇒ **必须重建索引**（否则新旧向量不可比） | `03-features/06-models` |
| 知识库类型化 | KB 有类型（文档型 / FAQ 型），不同类型走不同索引管道 | `03-features/02-knowledge-base`、`03-features/17-faq` |

### 1.4 检索

| 能力 | 作用与关键特性 | 文档位置 |
|---|---|---|
| 混合检索 | 向量（语义）+ BM25（词法）双通道并发 | `03-features/05-retrieval-engines`、`02-architecture/04-rag-pipeline` |
| RRF 加权融合 | `score = vectorWeight/(k+vectorRank) + keywordWeight/(k+keywordRank)` | `03-features/05-retrieval-engines` |
| Rerank 复合打分 | 三特征加权 `0.6 / 0.3 / 0.1`；无 rerank 模型时退化为启发式 | `03-features/05-retrieval-engines` |
| MMR 多样性 | `λ = 0.7`，抑制近重复证据铺满上下文 | `03-features/05-retrieval-engines` |
| 查询改写 + 扩展 | 改写口语问法、扩展同义词后再召回 | `03-features/05-retrieval-engines` |
| 意图识别 | **9 种意图**，按意图切换通道组合与权重 | `03-features/05-retrieval-engines` |
| FAQ 加权 | FAQ 命中 `boost=1.2`；相似度 ≥ `0.9` **直接返回答案**，不再走 LLM | `03-features/17-faq` |
| Wiki 加权 | Wiki 页命中 `boost=1.3` | `03-features/14-wiki` |
| 多 store 并发与超时 | 并发上限 `4`、超时 `30s` | `03-features/19-storage-backends` |
| TopK 口径 | `DefaultRetrievalTopK=50`、`maxRetrievalPoolSize=500` | `03-features/05-retrieval-engines` |
| 分块级 grep 工具 | `grep_chunks`：在候选块里做**精确字面**定位，补语义检索的「记不住确切字段值」短板 | `03-features/07-agent` |

### 1.5 模型接入

| 能力 | 作用与关键特性 | 文档位置 |
|---|---|---|
| 五类模型 | LLM / Embedding / Rerank / **VLM** / **ASR** | `03-features/06-models` |
| Provider 数量 | **27 个** Provider | `03-features/06-models` |
| 三级绑定 | 可分别绑在 **知识库 / 空间 / 智能体** 三级 | `03-features/06-models` |
| 密钥安全 | `SYSTEM_AES_KEY` 存在时对密钥列做 **AES-256-GCM** 加密 | `03-features/06-models`、`03-features/01-tenant-auth` |

### 1.6 Agent 与工具

| 能力 | 作用与关键特性 | 文档位置 |
|---|---|---|
| 内置 Agent | `builtin-quick-answer` / `smart-reasoning` / `data-analyst` / `wiki-researcher` / `wiki-fixer` | `03-features/07-agent` |
| ReAct 多步 | `MaxIterations` 默认 10（内置 Agent 50）、超时 `120s` | `03-features/07-agent` |
| 工具审批（HITL） | 等待超时默认 `10 分钟`；**fail-close**（DB 出错按需审批） | `03-features/08-mcp` |
| 内置工具集 | `knowledge_search` / `grep_chunks` / `query_knowledge_graph` / `data_analysis` / `web_search` / `web_fetch` / `read_file` / `shell_exec` | `03-features/07-agent` |
| Skills 沙箱 | Docker / CubeSandbox / E2B 三后端；bundle 上限默认 `256 MiB`；出网默认允许，可 `deny_egress_by_default` | `03-features/22-skills-sandbox` |
| MCP | 既作客户端（`sse`/`http-streamable`，**禁用 stdio**）也提供 Server（stdio/sse/http，默认 stdio） | `03-features/08-mcp` |
| 联网搜索 | **13 个引擎**（DuckDuckGo / Google / Bing / Tavily / Baidu / SearXNG / 智谱 / Metaso / Exa / Bocha / Brave …）；检索 `count` 1–20 | `03-features/11-web-search` |

### 1.7 知识图谱（GraphRAG）

| 能力 | 作用与关键特性 | 文档位置 |
|---|---|---|
| 文档实体图谱 | chunk 级 LLM 抽取实体与关系 → 写入 Neo4j；查询时实体识别 → 图检索 → **补充召回** | `03-features/09-knowledge-graph` |
| 两级开关 | `NEO4J_ENABLE` + `IndexingStrategy.GraphEnabled` + `ExtractConfig.Enabled` 都要打开才生效 | `03-features/09-knowledge-graph` |

### 1.8 Wiki 与 FAQ

| 能力 | 作用与关键特性 | 文档位置 |
|---|---|---|
| Wiki 自动生成 | 从文档 map-reduce 生成**主题页面**，形成可读的知识层 | `03-features/14-wiki` |
| Wiki 版本管理 | 软上限 50 / 硬上限 200；编辑可回滚；目录树最深 3 级；`slug` 机制；10 个 Wiki 工具 | `03-features/14-wiki` |
| FAQ 型条目 | 标准问 / 相似问 / 反例问 / 答案；`index_mode`(question_only｜question_answer)、`question_index_mode`(combined｜separate)；**反例问不索引** | `03-features/17-faq` |
| FAQ 去重归一化 | `ContentHash` 对繁简 / 全半角 / 标点 / 大小写不敏感 | `03-features/17-faq` |
| FAQ 迭代召回 | 封顶 500 条 / 最多 5 轮；直接回答阈值 `0.9` | `03-features/17-faq` |

### 1.9 对话体验

| 能力 | 作用与关键特性 | 文档位置 |
|---|---|---|
| 流式回答 | 逐字输出 + 可中断 | `03-features/18-chat-experience` |
| 引用与来源 | 答案标注引用序号，可跳原文 | `03-features/18-chat-experience` |
| 建议问题 | 预生成问题（独立索引类），开屏即给可点的问法 | `03-features/18-chat-experience` |
| 会话内上传 | 聊天里直接传文件，临时入检索 | `03-features/18-chat-experience` |
| 跨会话长期记忆 | 按空间 + 调用者隔离；资料/偏好/事实/事项/兴趣五类；`write_mode`(explicit_only｜auto)；`max_items` 默认 **200**；`interest_threshold` 默认 **3**；默认**关闭** | `03-features/23-memory` |

### 1.10 评估与可观测性

| 能力 | 作用与关键特性 | 文档位置 |
|---|---|---|
| 评估数据集 | 5 个 Parquet（`queries`/`corpus`/`answers`/`qrels`/`qas`）；内置 `default` | `03-features/15-evaluation` |
| 12 项指标 | 检索 `precision / recall / ndcg3 / ndcg10 / mrr / map`；生成 `bleu1 / bleu2 / bleu4 / rouge1 / rouge2 / rougel` | `03-features/15-evaluation` |
| 评估任务状态机 | `Pending=0 / Running=1 / Success=2 / Failed=3`；结果**只存内存，重启即丢** | `03-features/15-evaluation` |
| 可观测性 | `LOG_LEVEL`(默认 debug) / `LOG_PATH` 经 lumberjack 落盘（50MB × 3 份 × 28 天）/ `LLM_DEBUG_LOG` 写 `llm_debug/<request_id>.log` / Langfuse 调用链（默认关）/ 审计日志保留 **90 天**、每 24h 清扫 / 健康检查 `GET /health` | `03-features/16-observability` |

### 1.11 多租户、安全与生态（本产品**不适用**，仅列全）

`03-features/01-tenant-auth` RBAC（owner40/admin30/contributor20/viewer10）、OIDC、JWT（Access 24h / Refresh 7d）、API Key 细粒度能力、`Tenant.StorageQuota` 默认 10GB ·
`03-features/19-storage-backends` 7 种存储后端（local/minio/cos/oss/s3/tos/obs） ·
`03-features/20-platform-admin` 系统管理员 / 运行时设置 / 队列面板 ·
`03-features/21-file-access` 四种文件访问形式（内部引用 / 鉴权代理 / 能力短链 2h / 预签名 24h） ·
`03-features/12-im-integration` 10 个 IM 平台、多实例 Redis leader 选举 ·
`03-features/13-embed-channel` 网页嵌入挂件、双 Token（`em_` 长效 / `ems_` 30 分钟） ·
`05-clients/*` CLI / Go SDK / 小程序 / 桌面 / Chrome 扩展 / Claw Skill / DeepSeek Harness ·
`06-development/02-database-schema` Postgres + ParadeDB。

---

## 二、本仓库知识库现状盘点

### 2.1 真源文件与职责

| 层 | 文件 | 职责 | 状态 |
|---|---|---|---|
| 纯函数域 | `query/kb/types.ts` | 类型 + 四张扩展名注册表（A / A' / B / C 档） | ✅ T1 |
| | `query/kb/chunk.ts` | 分块器：`500 / 80 / 200 / 表格 40 行`，`MAX_CHUNKS_PER_FILE=20000` | ✅ T1 |
| | `query/kb/parse-plain.ts` | A 档（txt/md/log/json/yaml/xml/srt/ini…）+ A' 档（html）+ csv/tsv 表格解析 | ✅ T1 |
| 写路径 | `query/kb-files.ts` | `wechat_kb_files.db`：登记 / 列表 / 删除 / 崩溃恢复 / 出网开关 / 删库迁移；blob 内容寻址副本（`MAX_FILE_BYTES=32MB`、`MAX_FILES_PER_KB=5000`） | ✅ T2 |
| 读路径 | `query/kb-search.ts` | FTS5 稀疏检索；`DEFAULT_KB_TOP_K=20`、`MAX_KB_TOP_K=100`、`KB_SNIPPET_RADIUS=60`；**库过滤只允许一处** | ✅ T3 |
| 笔记域 | `query/notes.ts` | `wechat_notes.db`：多库（`kbs` 表）+ 笔记 CRUD + `[[链接]]` + `buildKnowledgeGraph` | ✅ 早于本计划 |
| 关系图 | `query/graph.ts` | 联系人/群**社交关系图**（共同群派生边、备注班级键分组） | ✅ 早于本计划 |
| 消息侧 RAG | `query/retrieval/*` | 4 通道（sparse/dense/structured/time）+ 意图 + RRF 融合 + 重排 + 压缩 + 反馈 + 评估 | ✅ 早于本计划 |
| 问答 | `query/ask.ts` | `askWechat` 主流程；**全文 0 处引用知识库** | ⚠️ 见 G-01 |
| 界面 | `panels/KbFiles.tsx` + `KbSwitcher.tsx` + `KnowledgeBase.tsx` + `Graph.tsx` | 合并外壳三段：笔记库 / 知识图谱 / 文件 | ✅ T2 |
| 隐私 | `query/privacy-audit.ts` + `gateway.privacyGate` | 全局「禁止 AI 出网」闸门 + 敏感信息脱敏 + 审计行 | ✅ 早于本计划 |

### 2.2 已实现能力矩阵（对照 WeKnora 同类）

| 能力 | 本仓库 | 证据 |
|---|---|---|
| 关键词（BM25 / FTS5） | ✅ **已实现** | `kb-search.ts` 走 `kb_chunks_fts`，中文 bigram tokenize |
| 向量语义检索 | 🔵 消息侧有，KB 侧无 | `retrieval/embedding.ts` 仅服务消息 |
| 混合检索（双通道融合） | 🔵 消息侧有 | `retrieval/fusion.ts` RRF `k=60` |
| Rerank | 🔵 消息侧有（**特征加权**，非独立模型） | `retrieval/rank.ts`，权重 sparse1.0/dense0.9/entity1.2/coverage0.8/timePref0.6/recency0.5/agreement0.4 |
| 查询改写 | 🔵 消息侧有 | `retrieval/rewrite.ts`：全角归一 + 相对日期解析 + 同义词展开 |
| 意图识别 | 🔵 消息侧 **6 种** | `retrieval/intent.ts`：recency_lookup / entity_lookup / time_range / aggregation / comparison / open_qa |
| 上下文压缩与去重 | 🔵 消息侧有 | `retrieval/compress.ts`（`maxChars=6000`、Jaccard 去重 `0.85`） |
| 反馈闭环（权重自适应） | ✅ 消息侧有 | `retrieval/feedback.ts` 按赞/踩调 `RerankWeights` |
| 检索评估指标 | ✅ **已实现** | `retrieval/eval.ts`：P@K / R@K / MRR / nDCG@K / AP + 合成语料 + 意图准确率 |
| 表格块重复表头 | ✅ **已实现** | `chunk.ts` `splitTableRows` + heading 带「列名 …」面包屑 |
| 解析失败归因区分 | ✅ **已实现且更细** | `unsupported` ≠ `failed` ≠ `sparse_only`，且源码级禁止「文件损坏」文案 |
| 原文件只读保证 | ✅ **已实现** | `src_path` 只登记；解析输入是 blob 副本；真机探针第 9 步咬此条 |
| 出网可控可审计 | ✅ **已实现** | 全局闸门 + 文件级 `include_in_rag` + `privacyGate('kb_embed')` |
| 多库隔离 | ✅ **已实现** | `kbId` 必填位置参数；5 处隔离（SQL / Remote / 快照 key / 渲染缓存 key / 布局坐标） |
| 崩溃恢复 | ✅ **已实现** | `recoverInterrupted` 启动时一次性重置三个中间态 |
| 流式回答 + 引用跳转 + 逐条反馈 | ✅ 消息问答有 | `use-ask.ts` + `Ask.tsx` |

---

## 三、结构化差异清单

> 优先级口径：**P0** = 不做则核心目标不成立；**P1** = 决定功能是否成立；**P2** = 体验完善可延后；
> **—** = 与产品定位冲突，**建议不补**（见第五节）。

### 3.1 清单总表

| 编号 | 能力 | 具体作用 | WeKnora 依据 | 当前实现的差距 | 优先级 |
|---|---|---|---|---|---|
| **G-01** | 知识库接入问答管道 | 让「我上传的合同/日志」成为回答的证据来源，而不只是能被搜到 | `02-architecture/04-rag-pipeline`、`03-features/18-chat-experience` | `ask.ts` **0 处**引用知识库；`searchKb` 只被 `KbFiles.tsx` 调用；无「知识库作为第 5 个检索通道」这条路 | **P0** |
| **G-02** | chunk 向量库 + 稠密通道 | 换一种问法（同义、改写）也能命中文件内容 | `03-features/05-retrieval-engines` | T4 未做；`kb-search.ts` 恒返回 `degraded{reason:'no-vector-index'}`；`kb_vectors` 只被删除级联「表存在才删」引用 | **P0** |
| **G-03** | B 档解析器（pdf / docx / xlsx） | 真实工作文档能进来——这是「文档底座」的实际构成 | `03-features/03-document-parsing` | T5 未做；`PENDING_PARSER_EXTS` 里的四种扩展名一律 `unsupported` + 「本机还没有 PDF 解析器」 | **P0** |
| **G-04** | 知识库检索的融合 / 重排 / 改写 / 意图 | 多通道结果合成一条有序列表，并让问法变形不影响召回 | `03-features/05-retrieval-engines`、`02-architecture/04-rag-pipeline` | KB 侧只有 `bm25 ORDER BY rank`；无 RRF、无 rerank、无 synonym 展开、无意图 | **P0** |
| **G-05** | 解析任务队列与执行器 | PDF 解析要数百毫秒到数十秒，必须挪出请求线程 | `02-architecture/03-document-pipeline`、`02-architecture/05-async-tasks` | `parsing`/`chunking`/`embedding` 三个状态**已预埋但无执行器**；`registerKbFile` 全程同步；仅复用 `yieldToLoop()` 让出事件循环 | **P1** |
| **G-06** | 图片 OCR / 音视频转写入库 | 截图、扫描件、录音也能作为证据 | `03-features/03-document-parsing`、`03-features/06-models`(VLM/ASR) | 图片仅登记元数据（`REGISTER_ONLY_EXTS`，按文件名可搜）；音视频**完全不在白名单**；本机 Whisper 只服务微信语音 | **P1** |
| **G-07** | URL / 网页抓取入库 | 贴一个链接就把网页变成可检索内容 | `03-features/03-document-parsing`、`03-features/11-web-search`(web_fetch) | 无 URL 入参；对话框白名单里没有 `url` 这一类型 | **P1** |
| **G-08** | 知识库检索评估 | 改分块/参数前先量出「好没好」，而不是凭感觉 | `03-features/15-evaluation` | 有 `eval.ts` 通用指标与合成语料，但**只覆盖消息侧**；无 KB 真实数据集、无 Parquet 装载、无生成侧指标（BLEU/ROUGE） | **P1** |
| **G-09** | FAQ 型条目 | 「标准问 + 相似问」直接命中并**直接回答**，省一次 LLM 往返 | `03-features/17-faq` | 完全没有 FAQ 概念；无 `index_mode`、无 `ContentHash` 归一化去重、无 `0.9` 直接回答阈值 | **P1** |
| **G-10** | 分块预览调试接口 | 调分块参数前先看切出来的块长什么样 | `03-features/04-chunking`(`POST /chunker/preview`) | 无此接口；参数固化在 `chunk.ts` 常量里，只有 `kb-chunk.spec.ts` 能观测 | **P1** |
| **G-11** | 父子分块 | child 精确召回、parent 提供完整上下文，兼顾精度与可读性 | `03-features/04-chunking`(parent 4096 / child 384) | 只有扁平块（500 字）；命中的块就是喂给模型的全部上下文 | **P1** |
| **G-12** | 自适应分块 Tier | 有标题结构走 heading Tier，无结构走 heuristic，退化走 legacy | `03-features/04-chunking` | 单一策略（段落 > 句末 > 硬切），不因文档形态切换；HTML/MD 的 heading 已进面包屑但**不参与切点决策** | **P1** |
| **G-13** | 文档主题页（Wiki 式生成） | 把一堆原始文档 map-reduce 成「主题页」，形成可读知识层 | `03-features/14-wiki` | 无自动生成。现有是**手写笔记**（`notes.ts`）+ `[[链接]]` + 社交关系图，语义上是「人写的 Wiki」 | **P2** |
| **G-14** | 笔记版本历史与回滚 | 改错能退回去；能看谁什么时候改了什么 | `03-features/14-wiki`(软 50/硬 200、可回滚、slug) | `saveNote` 原地覆盖，**无版本表、无回滚、无 slug、无目录树** | **P2** |
| **G-15** | 文档实体图谱（GraphRAG 召回） | 跨文档的实体关系参与召回（「谁和谁在哪份合同里同框」） | `03-features/09-knowledge-graph` | 现有 `graph.ts` 是**联系人/群社交关系图**（共同群派生边），**不是文档实体图谱**、不进检索通道、无 Neo4j 类图存储 | **P2** |
| **G-16** | MMR 多样性重排 | 防止近似重复的证据铺满上下文预算 | `03-features/05-retrieval-engines`(λ0.7) | 消息侧只有 Jaccard `dedupeFused` 去重，**无 MMR 的 λ 插值** | **P2** |
| **G-17** | 建议问题（预生成问题索引） | 开屏给可点的问法，降低「不知道能问什么」的门槛 | `03-features/18-chat-experience` | 无。`Ask.tsx` 只有静态 `CAPABILITIES` 文案 | **P2** |
| **G-18** | 会话内文件上传 | 聊天里直接传文件立刻参与检索，不走知识库登记流程 | `03-features/18-chat-experience` | 无。上传只发生在知识库「文件」分段，且必须选定某个库 | **P2** |
| **G-19** | 跨会话长期记忆 | 记住用户偏好与既往事实，后续会话直接复用 | `03-features/23-memory` | 无。只有会话内多轮 `turns`；无偏好/事实提取、无五类条目、无 `max_items` 治理 | **P2** |
| **G-20** | 日志落盘轮转与 LLM 调试日志 | 线上问题可回溯；每次模型调用有请求级留痕 | `03-features/16-observability` | 日志走 `console`（有 `SUPERTIME_RENDERER_LOG` 开关）；**无落盘轮转、无 request_id 维度模型调用日志、无 Langfuse 类追踪** | **P2** |
| **G-21** | 更多文档格式（PPT / EPUB） | 演示稿与电子书也能进来 | `03-features/03-document-parsing` | `ACCEPTED_EXTS` 不含 `ppt/pptx/epub`，选择器里都看不到 | **P2** |
| **G-22** | 意图识别扩到 9 种 | 更细的路由带来更准的召回 | `03-features/05-retrieval-engines` | 消息侧 6 种；KB 侧 0 种 | **P2** |

### 3.2 P0 逐条展开

#### G-01 知识库接入问答管道

- **为什么是最高优先级**：`docs/KB-RAG-PLAN.md` §1.1 的核心目标原话是——「让问答能**引用你上传的东西**，而不再只引用聊天记录」。
  现状是：文件能被搜到，但**只在这个文件面板里**。用户问「我上传的那份合同里违约金怎么写的」，
  `askWechat` 走的仍然只有消息四通道，知识库一个字都不参与。**这条不补，T1~T3 的全部投入只兑现了一半。**
- **WeKnora 依据**：`02-architecture/04-rag-pipeline` 把「知识库检索」与「对话检索」合成同一条 RAG 管道；
  `03-features/18-chat-experience` 要求答案携带来源引用。
- **当前差距**：`src/backend/wechat-data/src/query/ask.ts` 全文检索 `kb` / `Kb` / `知识库` **零命中**。
  `searchKb` 的唯一调用方是 `gateway.searchKb`（`@Remote`）→ `api.ts:apiSearchKb` → `KbFiles.tsx`。
- **建议做法**：把 KB 检索做成 `retrieval/` 里的**第 5 个通道**（`kb`），与 `sparse/dense/structured/time` 并列走同一套
  融合 → 重排 → 压缩；`channelTopK` 加一员，形状不动（`kb-search.ts` 头注已为此预留：「T4 接上稠密通道只需往 `channels` 里加一员，形状不动」）。
  新增 `KbHit → RetrievedDoc` 的适配层（KB 的 docKey 已是 `'chunk:' + chunkId`）。
- **风险**：`notes.ts` 与 `kbs` 表全程一行不改的纪律要保住；出网闸门要在新通道上同样生效。

#### G-02 chunk 向量库 + 稠密通道（T4）

- **作用**：让「语义相近」的问法命中——用户问「押金怎么退」，文件里写的是「保证金返还流程」。
- **WeKnora 依据**：`03-features/05-retrieval-engines`（混合检索 + RRF）。
- **当前差距**：`kb-search.ts` 每次都返回 `degraded: { reason: 'no-vector-index' }`——设计上诚实，但功能上是缺的；
  `kb-files.ts` 的删除级联里 `vectors` 一步是靠 `tableExists(db,'kb_vectors')` 兜着的**空步骤**。
- **已就绪的前置**：`EmbedFn` 注入机制、`privacyGate('kb_embed')` 登记位、`include_in_rag` 文件级开关全都已落地，
  只缺向量表本身与建索引入口。
- **必须同批做**：① 删文件时 `vectors` 步骤要真的删到（现在跨库无事务，头注已标 ⚠）；
  ② 换 embedding 模型要能**重建索引**（WeKnora `06-models` 明确要求）；③ `docs/PRIVACY.md` 同步 `kb_embed`。

#### G-03 B 档解析器（pdf / docx / xlsx，T5）

- **作用**：真实工作文档（合同、报表、方案）是「文档底座」的主要构成；没有它，知识库只装得下 txt/csv。
- **WeKnora 依据**：`03-features/03-document-parsing`、`02-architecture/03-document-pipeline`。
- **当前差距**：`PENDING_PARSER_EXTS = ['pdf','docx','xlsx','xls']` 四个扩展名在 `parse-plain.ts` 里直接返回
  `unsupported` + 「本机还没有 PDF 解析器（需要 pdfjs，属后续步骤）」——**文案已备好、状态已预留，只差解析器**。
- **计划已识别的风险必须一起处理**：
  - R1 **打包白名单**：`package.json` 的 `build.files` 是白名单，新依赖不写进去 = **开发机能跑、打包后找不到模块**（等级：高）。
  - R3 **阻塞事件循环**：复用既有 `yieldToLoop()`，每抽一页 / 每 200 块让出一次。
  - R10 **真实样本不足导致验收虚**：**需要用户提供若干真实 .pdf / .docx / .xlsx（含中文、含表格、含合并单元格更好）**，
    否则这条无法真正缓解。
  - 同时要把 G-05（异步执行器）一起做，否则大 PDF 会把**所有** `@Remote` 调用一起卡住。

#### G-04 知识库检索的融合 / 重排 / 改写 / 意图

- **作用**：多通道结果合成一条有序列表；让「换个说法问」不影响召回。
- **WeKnora 依据**：`03-features/05-retrieval-engines`（RRF + Rerank 0.6/0.3/0.1 + 查询改写 + 9 种意图）。
- **当前差距**：KB 侧检索只有一句 `ORDER BY rank`（`kb-search.ts:203`），排序完全交给 bm25；
  没有 RRF、没有重排、没有同义词展开、没有意图路由。
- **已就绪的前置**：`retrieval/fusion.ts`(`fuseResults`/`dedupeFused`)、`retrieval/rank.ts`(`rerankDocs`)、
  `retrieval/rewrite.ts`(`synonymExpand`/`normalizeQuestion`)、`retrieval/intent.ts`(`classifyIntent`) 全都现成且带用例——
  **这是「复用」而不是「新建」**，成本远低于从零实现；差距全在「没接上」。
- **建议顺序**：G-01（接入）→ G-02（稠密）→ G-04（融合+重排），因为 G-04 的融合需要有第二个通道才有意义。

### 3.3 P1 逐条展开（摘要）

| 编号 | 关键理由 |
|---|---|
| **G-05** | 三个中间态已预埋在 `kb-files.ts`（`INTERRUPTED_STATES`）与 `KbFiles.tsx`（`PARSE_LOOK`），**但没有消费方**。plan R3 说得很清楚：大 PDF 单线程抽取会让所有 `@Remote` 一起卡住。这是 G-03 的**前置**，不是可选项。 |
| **G-06** | 本机已有 Whisper（`query/whisper.ts` / `voice-transcribe.ts`），把同一能力接到知识库音频上，边际成本低；图片 OCR 才有真成本，且计划 §1.3 明确「不产出」（理由是中文 OCR 识别率不足以当证据）。建议**只做音频**，图片维持现状。 |
| **G-07** | WeKnora 的 `web_fetch` 有完整参数（单页 ≤ 5000 字符、`limit` 上限 8000、超时 60s、缓存 ≤ 8 页）。本仓库注意：这是**唯一一条「用户主动拉取外部内容」**的路径，与「数据不出本机」不冲突（是拉进来，不是发出去），但要过全局出网闸门。 |
| **G-08** | `eval.ts` 的 P@K / R@K / MRR / nDCG / AP **已经写好**，缺的是「给它一批 KB 真实数据」。这是性价比最高的一项：不改产品、只加数据与一条跑分入口，就能让 T4/T5 的调参有据可依。 |
| **G-09** | FAQ 的价值是**省一次 LLM 往返**（≥0.9 直接回答）。本仓库已有 `ContentHash` 类归一化的基础（`normalizeQuestion` 做全角/标点归一），可复用。 |
| **G-10** | 与其开放参数，不如开放**可观测的预览**——这与本项目「参数固化、不给旋钮」的既有纪律不冲突：预览是只读的，不改变行为。 |
| **G-11** | 现在一块最长 500 字，命中即上下文全部。父子块能让「命中 384 字的精确片段、回填 4096 字的完整章节」——对中文合同类文档收益明显。 |
| **G-12** | `parse-plain.ts` 已经把 `H1 › H2 › H3` 写进 heading，但 `chunk.ts` **不用它决定切点**。让 heading 参与切点选择是**低成本、高收益**的一步。 |

### 3.4 P2 逐条展开（摘要）

| 编号 | 说明 |
|---|---|
| **G-13 / G-14** | Wiki 自动生成与版本管理是「从文档到可读知识层」的第二步。当前是手写笔记，产品语义已经成立；自动生成属于**增量价值**，不是缺口。版本管理（回滚）风险低、收益明确，可先做这一半。 |
| **G-15** | 现有图谱是**社交关系图**（谁和谁在同一个群、备注里的班级分组），与 GraphRAG 的「文档实体关系」是**两种东西**。补 GraphRAG 意味着引入图存储 + chunk 级 LLM 抽取（**出网量突增**，与隐私定位有张力），建议延后并单独评估。 |
| **G-16** | MMR 是 `rank.ts` 的一个新增特征，改动面小；但只有在候选池够大（G-02 后）才有意义。 |
| **G-17 / G-18** | 建议问题（G-17）依赖「预生成问题」索引类；会话内上传（G-18）会绕过知识库的文件登记与出网可见性，需要先想清楚「临时文件是否出网、多久清理」。 |
| **G-19** | 长期记忆默认关闭（WeKnora 也是），且它是**跨会话的隐式出网**——与本产品「出网可控可审计」的纪律需要专门设计，不宜顺带做。 |
| **G-20** | 日志落盘轮转（50MB × 3 × 28 天）对桌面工具同样有价值；Langfuse 类追踪则需要一个外部服务，与本地化定位冲突，建议只做「本地 request_id 日志」。 |
| **G-21 / G-22** | 格式与意图种类的边际收益递减，放在最后。 |

---

## 四、建议的补齐顺序

```
第 1 批（核心闭环，P0 全部）
  G-01 知识库接入 askWechat（第 5 通道）
  G-04 复用 retrieval/ 的融合 + 重排 + 改写（先接稀疏通道即可）
  G-02 T4 chunk 向量库 + 稠密通道 + kb_embed 隐私登记
  G-03 T5 B 档解析器（pdf / docx / xlsx）
     └─ 必须同时做 G-05 异步执行器（否则大文件卡住全后端）
       与 G-08 评估（否则 T4/T5 的调参没有判据）

第 2 批（能力补全，P1）
  G-08 知识库评估数据集接入
  G-10 分块预览（只读，无行为风险）
  G-11 父子分块 + G-12 heading 参与切点
  G-07 URL 入库
  G-06 音频转写入库（复用既有 Whisper）
  G-09 FAQ 型条目

第 3 批（体验层，P2）
  G-14 笔记版本与回滚 → G-13 Wiki 自动生成
  G-16 MMR → G-17 建议问题 → G-18 会话内上传
  G-20 日志落盘轮转
  G-19 长期记忆（需先设计隐私边界）
  G-15 GraphRAG（需单独评估出网量）
  G-21 / G-22 格式与意图扩展
```

**排序理由（三条硬约束）**

1. **G-01 必须最先**：它是「投入是否兑现」的判定条件。前四批里其他任何一项先做，都是在扩大一个**用户还吃不到**的能力。
2. **G-03 必须与 G-05 同批**：plan R3 已判定「大 PDF 单线程抽取会让所有 `@Remote` 一起卡住」——单独交付 G-03 等于交付一个**会使整个后端失灵**的功能。
3. **G-08 必须在 T4/T5 之前或同批**：分块参数、融合权重、rerank 权重都要靠它来定；先做功能再补评估，等于所有参数都是拍的。

---

## 五、明确建议「不补」的清单（附理由）

WeKnora 是**服务端多租户开源系统**，本产品是**单机单用户的 Windows 桌面工具**，且核心承诺是
「数据在本机、出网可控可审计」。下表列出的能力**不建议补**——不是「以后再说」，而是与定位直接冲突。

| WeKnora 能力 | 文档位置 | 不补的理由 |
|---|---|---|
| 多租户 / RBAC / OIDC / JWT / 组织与邀请 | `03-features/01-tenant-auth` | 单机单用户，没有「别人」这个角色；引入 RBAC 只是把无权限问题变成有权限问题 |
| 平台管理（系统管理员、运行时设置、队列面板） | `03-features/20-platform-admin` | 同上；本机没有「运维者」这一角色 |
| 多云存储后端（minio/cos/oss/s3/tos/obs） | `03-features/19-storage-backends` | 数据必须留在本机；这是「不出网」承诺的物理基础 |
| IM 渠道接入（企业微信 / 飞书 / 钉钉 / Slack …） | `03-features/12-im-integration` | 需要长连接与多实例 leader 选举；且会把本机数据推到外部 IM 通道 |
| 网页嵌入挂件 / 双 Token | `03-features/13-embed-channel` | 面向公开网站的访客问答，与本产品场景无关 |
| 数据源定时同步（飞书 / Notion / 语雀 / RSS …） | `03-features/10-datasource` | 计划 §1.3 已明确「不产出 watch 文件夹」；定时同步会把「不出网」变成「持续出网」 |
| Skills 沙箱（Docker / Cube / E2B） | `03-features/22-skills-sandbox` | 需要 Docker daemon 与脚本执行权限，对桌面数据工具是**反向**的安全面 |
| MCP 客户端/Server | `03-features/08-mcp` | 对外暴露检索能力 = 绕开本产品所有出网闸门与审计 |
| 联网搜索 13 引擎 | `03-features/11-web-search` | 与「本机检索、不出网」的定位正面冲突（`Ask.tsx` 的能力标语就是这句） |
| 对外 REST API `/api/v1` + API Key | `04-api/*` | 现有 `@Remote` IPC 是**进程内**边界；对外 HTTP 端口会引入新的攻击面 |
| 文件访问短链 / 预签名 URL | `03-features/21-file-access` | 依赖公网可达的服务端；本机文件直读已足够 |
| 客户端矩阵（CLI / Go SDK / 小程序 / Chrome 扩展 …） | `05-clients/*` | 单一 Electron 桌面端是本产品的交付形态 |
| 生成侧评估指标（BLEU / ROUGE） | `03-features/15-evaluation` | 中文生成质量用 n-gram 重叠衡量误导性大于参考性；检索侧指标（已有）才是本产品需要的 |

---

## 附录 A · WeKnora 文档页索引（分析覆盖范围）

- `01-getting-started`：`01-introduction` `02-installation` `03-quickstart` `04-configuration` — **已分析**（introduction / quickstart 全文）
- `02-architecture`：`01-overview` `02-backend-design` `03-document-pipeline` `04-rag-pipeline` `05-async-tasks` — pipeline 两页**已分析**
- `03-features`（23 页）：`01-tenant-auth` `02-knowledge-base` `03-document-parsing` `04-chunking` `05-retrieval-engines` `06-models` `07-agent` `08-mcp` `09-knowledge-graph` `10-datasource` `11-web-search` `12-im-integration` `13-embed-channel` `14-wiki` `15-evaluation` `16-observability` `17-faq` `18-chat-experience` `19-storage-backends` `20-platform-admin` `21-file-access` `22-skills-sandbox` `23-memory` — **全部已分析**
- `04-api`（16 页）、`05-clients`（8 页）、`06-development`（3 页）— 按目录结构纳入范围，接口级细节未逐页展开（对本产品为不适用）

## 附录 B · 关键参数对照

| 维度 | WeKnora | 本仓库 | 说明 |
|---|---|---|---|
| 单文件大小上限 | `MAX_FILE_SIZE_MB=50` | `MAX_FILE_BYTES=32MB` | 本仓库解析上限同为 32MB（`MAX_PARSE_BYTES`） |
| 分块长度 | `chunk_size=512` / `overlap=80` | `CHUNK_MAX_CHARS=500` / `CHUNK_OVERLAP_CHARS=80` | **基本一致**（重叠完全相同） |
| 最小块长 | 文档未给 | `CHUNK_MIN_CHARS=200` | 本仓库额外有「切点不得早于窗口 40%」的约束 |
| 父子块 | parent `4096` / child `384` | 无 | G-11 |
| 表格分组 | 表头追踪 | `TABLE_ROWS_PER_CHUNK=40` + 每块重复表头 | **已对齐** |
| 检索 TopK | `DefaultRetrievalTopK=50` / pool `500` | KB `20` / `MAX 100`；消息侧 sparse `400` | 口径不同：KB 单元是文件块 |
| RRF 常数 | 未给具体 k | `fusion.k=60`、`keep=120`（硬上限 400） | 本仓库有明确的 O(N²) 上限论证 |
| 多 store 并发 | `4`，超时 `30s` | `embedding.concurrency=4` | 数量级一致 |
| 评估指标 | 12 项（含 BLEU/ROUGE） | 5 项（P@K/R@K/MRR/nDCG/AP） | 检索侧覆盖对齐；生成侧刻意不做 |
| Provider 数 | 27 | 8 个内置模板 | G-04 之外的另一处规模差距（可延后） |

---

*本文件的差异编号（G-01 ~ G-22）可直接用作后续任务的引用锚点；P0 四项与 `docs/KB-RAG-PLAN.md` 的 T4 / T5 存在重叠（G-02 = T4、G-03 = T5），G-01 与 G-04 是该计划**尚未列入**的两项——建议在下一轮把 G-01 提升为 T0 级前置。*
