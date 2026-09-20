/**
 * WeChat data types — re-exported from the host WechatDataGateway package so
 * the browser panels and the Remote client share one vocabulary.
 */
export type {
  WechatSession, WechatMessage, WechatContact, ContactBook,
  SessionsSnapshot, MessagesSnapshot, ContactsSnapshot,
} from '@deepseek-ai/dsh-wechat-data/types'

/** Monitor status (kept local; not yet in the host vocabulary). */
export interface MonitorStatus {
  running: boolean
  status: string
  [key: string]: unknown
}

// ── 知识笔记 / 知识图谱 ───────────────────────────────────────────────
// 契约的权威定义在 src/backend/wechat-data/src/types.ts。这里**刻意再声明一份**而不是
// 从 @deepseek-ai/dsh-wechat-data/types 引入：前端解析到的是 node_modules 里那份
// 手工维护的旧副本（非符号链接），它落后于后端源码，已经不匹配（api.ts 里记录过 48 条
// 类型错误）。把新类型挂到那份副本上只会把 H12/M17 的问题摊得更大。
// 待 H11/H12 落地（类型可从源码生成、同步自动化）后，这几条应迁回共享契约。

/** One knowledge note: manual entry, or distilled from an AI answer. */
export interface KnowledgeNote {
  id: number
  /** 所属知识库。老库升级后全部为 `DEFAULT_KB_ID`（=1）。 */
  kbId: number
  title: string
  /** Body text; `[[target]]` / `[[target|display]]` are wiki links. */
  body: string
  tags: string[]
  sourceKind: 'manual' | 'ask'
  sourceUsername?: string
  sourceQuestion?: string
  /** Distinct `[[target]]` values found in the body. */
  links: string[]
  createdAt: number
  updatedAt: number
}

/** Note list snapshot. */
export interface NotesSnapshot {
  items: KnowledgeNote[]
  total: number
}

/** Note mutation result (save/delete). */
export interface NoteMutationResult {
  ok: boolean
  id?: number
  error?: string
}

/**
 * Knowledge graph snapshot.
 *
 * Node ids are namespaced: `note:<id>` for notes, `kb:<normalized target>` for
 * stubs — so they never collide with social-graph ids (usernames / `self`).
 */
export interface KnowledgeSnapshot {
  notes: Array<{
    id: number
    title: string
    excerpt: string
    tags: string[]
    sourceKind: 'manual' | 'ask'
    sourceUsername?: string
    sourceQuestion?: string
    createdAt: number
    updatedAt: number
    /** Distinct outgoing wiki links (stubs included). */
    outLinks: number
    /** Incoming wiki links. */
    backLinks: number
  }>
  /** `[[target]]` values matching no note — rendered as dashed stub nodes. */
  stubs: Array<{ key: string; label: string; refCount: number; referencedBy: number[] }>
  /** 文档实体层：登记文件，一文件一节点（`file:<id>`）。**不是**按 chunk —— 见后端 query/kb/entities.ts。 */
  docFiles: Array<{ id: number; label: string; ext: string; chunkCount: number; charCount: number; parseState: string }>
  /** 文档实体层：归一化后跨文件合并的章节（`doc:<key>`）。 */
  docSections: Array<{ key: string; label: string; files: Array<{ id: number; count: number }>; occurrences: number }>
  /**
   * 模型抽出的实体（`ent:<key>`）—— **推断层**，与上面两个观测层字段不同源。
   * 画布上连到它们的边画虚线，表示「模型认为有关系」而不是「文档里观测到」。
   */
  docEntities: Array<{
    key: string
    label: string
    kind: string
    files: Array<{ id: number; weight: number }>
    occurrences: number
    model: string
    at: number
  }>
  edges: Array<{
    source: string
    target: string
    weight: number
    kind: 'wiki' | 'stub' | 'contain' | 'mention' | 'suggest'
  }>
  /** Source-chat usernames → display names (labels for the note's source-chat entry). */
  sessionNames: Record<string, string>
  summary: {
    noteCount: number
    linkCount: number
    stubCount: number
    orphanCount: number
    askCount: number
    manualCount: number
    fileCount: number
    sectionCount: number
    /** 模型抽出的实体节点数（推断层）。0 = 这个库还没抽过。 */
    entityCount: number
  }
}

// ── 知识库（多库） ────────────────────────────────────────────────────
// 权威定义同样在后端 types.ts。与上面几段同一原因，这里刻意再声明一份。

/** 一个知识库的元信息（列表项）。 */
export interface KbMeta {
  id: number
  name: string
  /** 该库的笔记条数（列表里直接显示，一眼看出哪个库是空的）。 */
  noteCount: number
  /**
   * 该库登记的**文件**条数。
   *
   * 与 `noteCount` 并列的「这个库里有什么」—— 删库弹层与回执都要用它，
   * 只数笔记会对「0 条笔记 / 5 个文件」的库说「这个库是空的」。
   * 真值由后端 `gateway.getKbs` 把两个库文件合流后给出（`notes.ts` 看不到文件库）。
   */
  fileCount: number
  /**
   * 该库自定义了几个模型角色（0 = 全部跟随全局）。
   * rail 的「模型」芯片靠它决定写「继承全局」还是「N 项自定义」。
   * 同样是合流值：设置住在 `wechat_kb_models.db`，`notes.ts` 看不到它。
   */
  modelOverrides: number
  createdAt: number
  updatedAt: number
}

/** 知识库列表快照。 */
export interface KbListSnapshot {
  items: KbMeta[]
  total: number
}

/**
 * 删除知识库时对库内笔记的处理方式。**必须显式给出**：
 *   · `reassign` —— 先把笔记移到 `targetKbId`，再删库行；
 *   · `purge`    —— 连同笔记一起删。
 * 不给缺省值，是为了让「删掉一个非空库」永远是一个被看见的决定。
 */
export type KbDeleteAction =
  | { kind: 'reassign'; targetKbId: number }
  | { kind: 'purge' }

/** 知识库增 / 改名 / 删的结果。 */
export interface KbMutationResult {
  ok: boolean
  id?: number
  /** `reassign`：真正迁移到目标库的笔记条数（供界面回执「已移动 N 条」）。 */
  movedNotes?: number
  /** `purge`：随库一起删掉的笔记条数（与上一条分开，否则界面说不清是移了还是删了）。 */
  removedNotes?: number
  /**
   * 文件侧的清点结果。**`undefined` ≠ `0`**：
   * `undefined` = 这一步没跑（后端在跨库操作里只能 best-effort，失败只留痕），
   * `0` = 跑了、确实是 0 个。
   * 混成同一个值会让界面把「没清点」说成「一个都没有」——那是两句相反的话。
   */
  movedFiles?: number
  removedFiles?: number
  error?: string
}

// ── 知识库文件（KB-RAG 计划的 T2） ─────────────────────────────────────────
// 权威定义在后端 types.ts。与前几段同一原因，这里刻意再声明一份。

/**
 * 文件的解析状态。
 *
 * 三个中间态（`parsing` / `chunking` / `embedding`）在进程被杀之后**没有续跑机制**，
 * 所以后端在每次启动时把它们全部打回 `queued`；界面上它们只是「进行中」，
 * 不需要（也不该）区分。
 *
 * `unsupported` 与 `failed` 必须分开显示：
 *   · `unsupported` = 这台机器没有对应解析器（等版本升级就能解，**不是**文件的问题）；
 *   · `failed`      = 解析器存在但真的抛了（要用户换文件）。
 * 合成一档就等于把两件排查方向完全相反的事说成一件。
 * `sparse_only` = 正文已解析、只是没有向量（无 Key / 断网 / 出网被拦）——
 * 此时**仍然能被关键词搜到**，所以它不是失败态。
 */
export type KbFileParseState =
  | 'queued' | 'parsing' | 'chunking' | 'embedding'
  | 'ready' | 'unsupported' | 'failed' | 'sparse_only'

/** 知识库文件：`kb_files` 里的一行（不含块正文）。 */
export interface KbFileMeta {
  id: number
  /** 所属知识库。文件、分块、检索一律按它划作用域。 */
  kbId: number
  /** 文件名（不含路径）。 */
  name: string
  /** 小写扩展名（不含点）；无扩展名为 `''`。 */
  ext: string
  /**
   * 用户电脑上的原始路径。**只登记**：永不写、永不删、永不移。
   * 解析的输入是 blob 副本，所以用户改名 / 移动 / 删除原文件都不影响已入库的内容。
   */
  srcPath: string
  /** 内容指纹（sha256 hex）。**同库内唯一** —— 去重按内容而不是文件名。 */
  sha256: string
  /** blob 副本的相对文件名（`<sha256>.<ext>`）；副本写失败时为空串。 */
  blobName: string
  sizeBytes: number
  parseState: KbFileParseState
  /** 实际使用的解析器名；未解析时为空。 */
  parser: string
  /** 不可用原因或降级说明。`unsupported` 时非空，且**不得**写成「文件损坏」。 */
  parseError: string
  chunkCount: number
  charCount: number
  /** 是否参与向量化（出网）。默认 true，但它不是出网闸门本身（全局开关一起拦）。 */
  includeInRag: boolean
  /** 模型生成的摘要正文；`''` = 还没生成过。 */
  summary: string
  /** 生成这条摘要用的模型（`provider/model`）；换模型后用来判断它是不是旧的。 */
  summaryModel: string
  /** 生成时间（毫秒）；0 = 没有摘要。 */
  summaryAt: number
  /**
   * 这条摘要实际覆盖了前多少字。与 `charCount` 不等就说明摘要**没有**覆盖全文，
   * 界面必须把这件事写出来 —— 只标「摘要」会让人以为看到的是整份文件的概括。
   */
  summaryCoveredChars: number
  createdAt: number
  updatedAt: number
}

/**
 * 文件列表快照。
 *
 * 与 `KbListSnapshotRead` 那几条不同，这里**直接**把 `readError` 放进本地声明、
 * 不再另起一个 `…Read` 别名：整份形状本来就是本地声明的，加一层别名只是多一个要同步的名字。
 */
export interface KbFileListSnapshot {
  kbId: number
  items: KbFileMeta[]
  total: number
  /** 读不到库时非空（此时 `items` 恒为 `[]`）；确无文件时为 undefined。 */
  readError?: string
}

/**
 * 生成文件摘要的结果。
 *
 * `coveredChars` 与 `totalChars` 必须一起回：界面靠它俩决定要不要写
 * 「这只是前 N 字的摘要」。只回一段摘要文本，就等于把「覆盖了多少」藏进没人点的地方。
 */
export interface KbSummaryResult {
  ok: boolean
  error?: string
  summary?: string
  model?: string
  at?: number
  coveredChars?: number
  totalChars?: number
}

/**
 * 一个正文块。**是解析出来的文本，不是原文件的排版** —— PDF/DOCX 的表格、图片、
 * 页眉页脚在解析阶段就丢了，所以界面上必须标成「检索与问答实际读到的正文」，
 * 不能让人以为在看原稿。
 */
export interface KbFileChunk {
  ordinal: number
  /** 页码，0 = 无页概念（txt / md / csv 等）。 */
  page: number
  heading: string
  text: string
  charCount: number
}

/** 某个文件的正文分页（就地展开走这条）。 */
export interface KbFileChunkPage {
  kbId: number
  fileId: number
  items: KbFileChunk[]
  total: number
  totalChars: number
  /** 读不到、或该文件不存在 / 不属于当前库时非空（此时 `items` 恒为 `[]`）。 */
  readError?: string
}

/**
 * 单个文件的登记结果。失败时 `code` 是**可被判定的**原因，`error` 是给人看的一句话。
 *
 * 为什么要 `code` 而不只给文案：界面要按原因分支（重复 → 高亮已存在的那一行；
 * 类型不支持 → 提示白名单），而中文文案随时可能改。
 */
export interface KbFileRegisterResult {
  ok: boolean
  code?: 'bad-kb' | 'bad-path' | 'not-accepted' | 'too-large' | 'too-many'
    | 'duplicate' | 'read-failed' | 'store-failed'
  error?: string
  /** 成功时给出落地的那一行。 */
  file?: KbFileMeta
  /** `code:'duplicate'` 时指出撞上的是哪一行。 */
  duplicateOf?: { id: number; name: string }
}

/** 单文件变更结果（删除 / 出网开关）。 */
export interface KbFileMutationResult {
  ok: boolean
  error?: string
  /** 删除时回执：连带清掉的分块数。 */
  removedChunks?: number
  /** 删除时回执：blob 副本是否真的被删（还有别处引用时为 false）。 */
  removedBlob?: boolean
}

/**
 * 可添加的文件类型（**镜像**后端 `query/kb/types.ts` 的 `ACCEPTED_EXTS`）。
 *
 * 只用于 `dialog:open-file` 的 `filters`（让用户在选择时看不到不支持的类型），
 * **不是**接纳判据 —— 真正的判据在后端 `isAcceptedExt()`，选进来的东西一律
 * 逐项回执（`not-accepted` 会明说原因）。
 *
 * 分四档的理由与后端一致，四档都要有：
 *   · 文本族（A）：自实现解码，零依赖，**现在就能解析正文**；
 *   · HTML（A'）：去标签取可见文本，同样是现在就能解析；
 *   · PDF / Word / Excel（B）：本期只登记元数据，等解析器接入后自动补上正文；
 *   · 图片（C）：只登记，不做 OCR（识别率不足以当证据送给模型）。
 *
 * ⚠️ 改动这里必须同步后端；`kb-files.wiring.spec.ts` 会逐个集合比对，漂了就红。
 */
export const KB_ACCEPTED_EXTS: readonly string[] = [
  // A 档：文本族
  'txt', 'md', 'markdown', 'markdn', 'text', 'log', 'csv', 'tsv',
  'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'xml', 'srt', 'vtt', 'ini', 'conf',
  // A' 档：HTML
  'html', 'htm', 'xhtml',
  // B 档：等解析器接入
  'pdf', 'docx', 'xlsx', 'xls',
  // C 档：只登记元数据
  'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff',
]

/**
 * 一次「添加文件」（对话框多选的结果）的回执。
 *
 * 逐项结果都带回去，因为**部分成功是常态**：一次选了 10 个，其中 3 个重复、
 * 1 个类型不支持，不该把整次操作报成失败 —— 用户要看的是「这 6 个进来了，
 * 那 4 个分别因为什么没进来」。
 */
export interface KbFileAddResult {
  /** **至少有一个**登记成功才为 true；一个都没进来才是失败。 */
  ok: boolean
  added: number
  failed: number
  results: KbFileRegisterResult[]
  error?: string
}

/**
 * 知识库检索的通道名（**镜像**后端 `types.ts`，改一处必须同步另一处）。
 *
 * T3 只开 `sparse`（关键词）；`dense` 在 T4 接上向量库；`structured` 留给
 * 「按文件名 / 类型 / 页码这类元数据」的检索。三个名字一次定下来，是为了让
 * `ranks` / `stats.channels` 这两个形状在 T4 加通道时**不用改**。
 */
export type KbChannelName = 'sparse' | 'dense' | 'structured'

/**
 * 知识库检索的一条命中（**镜像**后端 `types.ts`）。
 *
 * 粒度是**块**而不是文件：一份文件命中三处就是三条 —— 用户要看的是「哪一段话对上了」，
 * 只给一个文件名等于把定位工作又推回给他。
 */
export interface KbHit {
  /** 命中的文件行 id；点一条结果就按它去左侧列表里选中那个文件。 */
  fileId: number
  fileName: string
  /** 小写扩展名（不含点）。 */
  fileExt: string
  chunkId: number
  /** 块在文件内的序号（0 基）。 */
  ordinal: number
  /** 页码（1 基）；非分页形态为 0。 */
  page: number
  /** 面包屑（`H1 › H2`）；无标题时为空串。 */
  heading: string
  /** 摘要：命中词前后各 60 字符。 */
  snippet: string
  /**
   * 块**完整正文**（与 `snippet` 是两件事）。
   *
   * ⚠ 面板检索**不读它**（界面上显示的就是 `snippet` 那一段）；它存在的原因是**问答引用**：
   * 拿 `snippet` 当引用证据会丢掉块里其余的内容 —— 模型看到半句话就只能猜后半句，
   * 重排的「词覆盖率」也会把只落在窗口外的检索词误判成未命中。
   * 这里保留它的直接目的是与后端 `types.ts` 的 `KbHit` **逐字段一致**：
   * `kb-files.wiring.spec.ts` 有逐字段镜像守卫，漂了的前端会**静默**拿到 `undefined`（不报错）。
   */
  text: string
  /**
   * 高亮区间，**偏移相对 `snippet`**（不是相对块原文）。
   *
   * 由后端算好给前端用，前端只渲染、**不做二次匹配** ——
   * 让前端自己再找一遍词，就会出现「后端按 bigram 命中、前端按字面找」的错位，
   * 表现为「搜到了但一个词都没高亮」。
   */
  marks: Array<{ start: number; end: number }>
  /** 相关度，**越大越相关**（后端把 `bm25` 取了负）。跨查询之间不可比。 */
  score: number
  /** 各通道内的名次（1 基）；未命中该通道则缺省。 */
  ranks: Partial<Record<KbChannelName, number>>
}

/**
 * 知识库检索的统计（**镜像**后端 `types.ts`）。
 *
 * 刻意**不复用**消息域的 `RetrievalStats`：那 13 个字段里有一半是「消息 + 时间轴 +
 * 意图分类」特有的，知识库检索一个都产生不了，硬套就只能填假值 ——
 * 而它们会直接显示在「为什么这条被召回」的解释里。
 */
export interface KbSearchStats {
  /** 各通道的参与情况。`active:false` 时 `note` 说明为什么没跑。 */
  channels: Array<{ channel: KbChannelName; count: number; active: boolean; note?: string }>
  /** 召回条数（= 命中块数）。 */
  recalled: number
  /** 最终保留条数；T3 无重排、无截断，与 `recalled` 相同。 */
  kept: number
  /** 实际生效的检索词数（纯标点会被 bigram 化丢弃）。 */
  terms: number
  elapsedMs: number
}

/**
 * 一次知识库检索的结果（**镜像**后端 `types.ts`）。
 *
 * 三个可选字段分别对应三种「没搜成」，界面上必须分开说：
 *   · `degraded`  —— 搜成了，但只走了部分通道（「仅关键词（未建向量索引）」）；
 *   · `error`     —— 这次请求本身无效（如库标识缺失），重试无用；
 *   · `readError` —— 库打不开，可能只是被占用，重试可能成功。
 */
export interface KbSearchResult {
  kbId: number
  /** 回显用户输入：结果区标题原样显示它，用户才能确认「看到的是这一次的结果」。 */
  query: string
  hits: KbHit[]
  stats: KbSearchStats
  /**
   * 降级说明：`reason` 给代码判分支，`label` 给界面直接显示。
   * 四种「只有关键词」的出路不同，界面不许合并成一句（镜像后端同名联合类型）。
   */
  degraded?: {
    reason: 'no-vector-index' | 'no-network' | 'no-key' | 'no-embed-model' | 'index-stale' | 'embed-failed'
    label: string
  }
  error?: string
  readError?: string
}

/** 知识库向量索引状态（镜像后端 `kb-vectors.ts` 的 `KbVectorIndexStatus`）。 */
export interface KbVectorIndexStatus {
  exists: boolean
  rows: number
  dim: number
  /** meta 里「最近一次构建用的模型名」，诊断用。 */
  model: string
  /** 本库向量行里实际出现过的模型名（去重 + 排序）。 */
  models: string[]
  /** 判定时后端用的当前模型名；空串 = 没配向量模型。 */
  current: string
  /** 未就绪的原因；`''` = 就绪。 */
  staleReason: '' | 'no-index' | 'model-mismatch' | 'schema-mismatch' | 'no-dim' | 'no-model'
  built_at: string | null
  ready: boolean
}

/** `getKbVectorIndex` 的返回：状态 + 当前模型 + 在飞构建进度。 */
export interface KbVectorIndexView {
  kbId: number
  model: string
  /** 模型名的来源：本库覆盖（inline）还是跟随全局（inherit）。 */
  source: 'inherit' | 'inline'
  configured: boolean
  status: KbVectorIndexStatus
  job: { done: number; total: number; startedAt: number; error: string } | null
}

/** 一个角色引用串：`''` = 继承全局，`m:<模型名>` = 只点名模型（端点沿用全局）。 */
export type KbModelRef = string

/** 某个库的三个角色设置。 */
export interface KbModelSettings {
  kbId: number
  chatRef: KbModelRef
  embedRef: KbModelRef
  rerankRef: KbModelRef
  entitiesAt: number
  updatedAt: number
}

/** 一次解析的结果（名字 + 来源 + 原始引用）。 */
export interface KbResolvedModel {
  model: string
  source: 'inherit' | 'inline'
  ref: KbModelRef
}

/** `getKbModelConfig` 的返回。 */
export interface KbModelConfigView {
  kbId: number
  settings: KbModelSettings
  global: Record<'chat' | 'embed' | 'rerank', string>
  resolved: Record<'chat' | 'embed' | 'rerank', KbResolvedModel>
  /** 实体抽取的进度（同一个回包里给：弹层开一次要读三样，分三次读首帧会跳三下）。 */
  entities: KbEntitySummary
}

/**
 * 本库实体抽取的进度概览（镜像后端 `KbEntitySummary`）。
 * 「还没抽的文件数」与「已存条数」必须分开：只报后者时，
 * 「抽了 3 个文件各 20 条」看起来像快做完了，而实际还剩 40 个文件没动。
 */
export interface KbEntitySummary {
  /** 开着「参与语义检索」的文件数 —— 也是抽取按钮上的分母。 */
  ragFiles: number
  pending: number
  entities: number
  /** 最近一次抽取用的模型名；空串 = 一条都没有。 */
  model: string
}

/** 一次实体抽取（整库批量）的结果（镜像后端 `extractKbEntities`）。 */
export interface KbExtractResult {
  ok: boolean
  error?: string
  /** 这轮实际发了几个文件（受单次上限约束，不是一键抽完整个库）。 */
  files: number
  saved: number
  failed: Array<{ id: number; error: string }>
  model: string
}

/** 一条链接建议（`suggestKbLinks` 的候选；**点了才会写进正文**）。 */
export interface KbLinkSuggestion {
  label: string
  kind: 'note' | 'entity'
  /** 与正文的余弦相似度（已四舍五入到三位）。 */
  score: number
}

/** `suggestKbLinks` 的返回。 */
export interface KbLinkSuggestResult {
  ok: boolean
  error?: string
  candidates: KbLinkSuggestion[]
  /** 参与排序的候选数（截断到池上限之后）。 */
  pool: number
  model: string
  note?: string
}

/** `setKbModelConfig` 的返回。 */
export type KbModelConfigResult = { ok: true; settings: KbModelSettings } | { ok: false; error: string }

/** 一次向量索引构建的结果（镜像后端 `KbVectorBuildResult`，外加 ok/error）。 */
export interface KbVectorBuildResult {
  ok: boolean
  error?: string
  status: string
  rows: number
  embedded: number
  embed_calls: number
  elapsed_ms: number
  message?: string
}
