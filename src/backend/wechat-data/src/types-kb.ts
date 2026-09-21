/**
 * `types.ts` 的 kb 部分（M21 拆分；纯类型，无运行期值）。
 *
 * 从 `types.ts` 原样搬出，`types.ts` 继续以 `export *` 转发 ⇒ 所有
 * `from './types.ts'` / `from '../types.ts'` 的导入路径一行都不用改。
 *
 * @module types-kb
 */
/**
 * One knowledge base: a partition of the note store.
 *
 * 一个库 = 一批笔记 + 一个 `[[链接]]` 解析域 + 一张由这批笔记构成的图谱。
 * 库只存**名字**，笔记只存 `kb_id` —— 改名不动任何笔记（见 `renameKb`）。
 */
export interface KbMeta {
  id: number
  name: string
  /** 该库的笔记条数（列表里直接显示，一眼看出哪个库是空的）。 */
  noteCount: number
  /**
   * 该库登记的**文件**条数。
   *
   * 与 `noteCount` 并列的「这个库里有什么」。**只数笔记会让删库弹层说谎**：
   * 一个「0 条笔记 / 5 个文件」的库会被写成「这个库是空的」，用户点下「一并删除」
   * 就丢掉了 5 份登记（blob、分块、FTS、向量一并清）。真机探针实测到过这一句。
   *
   * ⚠ 真值只有文件库知道，而 `listKbs()` 在 `notes.ts` 里、看不到那个独立 db 文件，
   * 所以那里出 `0`、由 `gateway.getKbs` 覆盖（见该处注释）。别直接拿 `listKbs()`
   * 的返回值去渲染删库文案。
   */
  fileCount: number
  /**
   * 该库自定义了几个模型角色（0 = 全部跟随全局）。
   *
   * 第三个合流源：设置住在 `wechat_kb_models.db`，而 `listKbs()` 在 `notes.ts` 里看不到它。
   * 只带计数不带引用串 —— rail 的芯片只需要知道「继承 / N 项自定义」，
   * 具体是哪几个模型由 `getKbModelConfig` 按需读（打开弹层时才读）。
   */
  modelOverrides: number
  createdAt: number
  updatedAt: number
}

/** Knowledge base list snapshot. */
export interface KbListSnapshot {
  items: KbMeta[]
  total: number
}

/**
 * 删除知识库时对**库内笔记**的处理方式。必须显式给出，后端不猜：
 *   · `reassign` —— 先把笔记移到 `targetKbId`，再删库行；
 *   · `purge`    —— 连同笔记一起删。
 * 不给缺省值，是为了让「删掉一个非空库」永远是一个被看见的决定。
 */
export type KbDeleteAction =
  | { kind: 'reassign'; targetKbId: number }
  | { kind: 'purge' }

/** Knowledge base mutation result (create/rename/delete). */
export interface KbMutationResult {
  ok: boolean
  id?: number
  /** `reassign`：真正迁移到目标库的笔记条数（供界面回执「已移动 N 条」）。 */
  movedNotes?: number
  /** `purge`：随库一起删掉的笔记条数（与上一条分开，否则界面说不清是移了还是删了）。 */
  removedNotes?: number
  /**
   * 连带处理的知识库文件条数。
   *
   * ⚠ `undefined` 与 `0` **不是一回事**：`0` = 清点过、这个库确实没有文件；
   * `undefined` = 文件清点没做成。两个库文件（笔记 / 文件）之间没有跨库事务，
   * 所以文件侧是 best-effort —— 界面必须能分开说「这个库没有文件」与
   * 「文件清点未完成」，否则一次失败会显示成「一个文件都没有」。
   */
  movedFiles?: number
  removedFiles?: number
  error?: string
}

/** One knowledge note: manual entry or distilled from an AI answer. */
export interface KnowledgeNote {
  id: number
  /** 所属知识库。老库升级后全部为 `DEFAULT_KB_ID`（=1）。 */
  kbId: number
  title: string
  /** Markdown-ish body; `[[target]]` / `[[target|display]]` are wiki links. */
  body: string
  tags: string[]
  /** 'manual' = user-authored; 'ask' = distilled from a WeChat Q&A answer. */
  sourceKind: 'manual' | 'ask'
  /** Chat the note was distilled from (used by the「跳回来源聊天」entry; not a graph node). */
  sourceUsername?: string
  /** Question that produced the note (details panel). */
  sourceQuestion?: string
  /** Unique `[[target]]` values found in the body, unresolved ones included. */
  links: string[]
  createdAt: number
  updatedAt: number
}

/** Knowledge note list snapshot. */
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
 * 知识库文件的解析状态。
 *
 * 取值域刻意包含**三个物理上不可续跑的中间态**（`parsing` / `chunking` / `embedding`）：
 * 进程被杀之后没有任何机制能从一半继续，所以启动时必须把它们全部重置为 `queued`
 * （见 `kb-files.ts` 的 `recoverInterrupted`）—— 不重置就会永久停在「正在解析」转圈。
 *
 * `unsupported` 与 `failed` 必须分开：
 *   · `unsupported` = 这台机器**没有**对应的解析器（等版本升级就能解，不是错误）；
 *   · `failed`      = 解析器存在但**真的抛了**（要用户换文件）。
 * 两者的排查方向完全不同，合并成一档就等于让用户去猜。
 * `sparse_only` = 正文已解析、但没有向量（无 Key / 断网 / 被出网闸门拦），
 * 此时**仍然可被关键词搜到** —— 不能因为嵌入不可用就把已解析好的正文一起废掉。
 */
export type KbFileParseState =
  | 'queued' | 'parsing' | 'chunking' | 'embedding'
  | 'ready' | 'unsupported' | 'failed' | 'sparse_only'

/** 知识库文件：`kb_files` 里的一行（不含块正文）。 */
export interface KbFileMeta {
  id: number
  /** 所属知识库。文件、分块、检索一律按它划作用域。 */
  kbId: number
  /** 文件名（不含路径），如 `2026Q1 合同.pdf`。 */
  name: string
  /** 小写扩展名（不含点）；无扩展名为 `''`。 */
  ext: string
  /**
   * 用户电脑上的原始路径。**只登记**：永不写、永不删、永不移。
   *
   * 解析的输入是 blob 副本而不是它，所以用户改名 / 移动 / 删除原文件都不影响
   * 已经入库的内容（设计稿 §10 边界 3）。
   */
  srcPath: string
  /** 内容指纹（sha256 hex）。同库内唯一 —— 去重按**内容**而不是文件名。 */
  sha256: string
  /** blob 副本的相对文件名（`<sha256>.<ext>`）；副本写失败时为空串。 */
  blobName: string
  sizeBytes: number
  parseState: KbFileParseState
  /** 实际使用的解析器名（`plain-text` / `markdown` / `html` / `csv`…）；未解析时为空。 */
  parser: string
  /** 不可用原因或降级说明。`unsupported` 时非空，且**不得**写成「文件损坏」。 */
  parseError: string
  chunkCount: number
  charCount: number
  /**
   * 是否参与向量化（出网）。默认 `true`，但它**不是**出网闸门本身：
   * 全局「禁止 AI 出网」仍然一起拦下。给文件级开关是为了让含敏感内容的文件
   * 完全不出网、却仍能被关键词搜到（设计稿 §9.2）。
   */
  includeInRag: boolean
  /**
   * 模型生成的摘要（`''` = 还没生成过）。
   *
   * ⚠ 它只覆盖**送进 prompt 的那一段**正文，不是全文的摘要 —— 一份几百万字的日志
   * 塞不进一次请求。所以界面上必须连 `summaryCoveredChars` 一起显示，
   * 只写「摘要」会让人以为看到的是整份文件的概括。
   */
  summary: string
  /** 生成这条摘要时用的模型标识；换模型后用来判断这条是不是旧的。 */
  summaryModel: string
  /** 生成时间（毫秒）；0 = 没有摘要。 */
  summaryAt: number
  /**
   * 本次摘要实际喂给模型的字符数。
   *
   * 必须**落库**而不是当场算：一份几百万字的日志只能喂前若干字，隔一周再看这条摘要时
   * 若不记得当时覆盖了多长，就没法诚实地标出「这只是前 8,000 字的摘要」。
   * 与 `charCount`（全文字数）不等就说明摘要没有覆盖全文。
   */
  summaryCoveredChars: number
  createdAt: number
  updatedAt: number
}

/** 文件列表快照。`readError` 只在读失败时出现（与 `KbListSnapshotRead` 同一纪律）。 */
export interface KbFileListSnapshot {
  kbId: number
  items: KbFileMeta[]
  total: number
  /** 读不到库时非空（此时 `items` 恒为 `[]`）；确无文件时为 undefined。 */
  readError?: string
}

/**
 * 一个正文块。**是解析出来的文本，不是原文件的排版** —— PDF/DOCX 的表格、图片、
 * 页眉页脚在解析阶段就丢了。界面必须把这件事说出来：看「检索与问答实际读到的正文」
 * 和看原稿可能得出不同结论。
 */
export interface KbFileChunk {
  /** 块在文档内的序号（原有顺序）。 */
  ordinal: number
  /** 页码，0 = 无页概念（txt / md / csv 等）。 */
  page: number
  /** 所属章节标题（`父 › 本段`，可为空串）。 */
  heading: string
  text: string
  charCount: number
}

/** 某个文件的正文分页。 */
export interface KbFileChunkPage {
  kbId: number
  fileId: number
  items: KbFileChunk[]
  /** 这个文件的总块数（用于「已读 N / M」与是否还有下一页）。 */
  total: number
  /** 总字数。 */
  totalChars: number
  /** 读不到、或该文件不存在 / 不属于当前库时非空（此时 `items` 恒为 `[]`）。 */
  readError?: string
}

/** 登记一个文件的入参。 */
export interface KbFileRegisterInput {
  /** 目标知识库（必填，没有「默认落哪个库」这种猜测）。 */
  kbId: number
  /** 用户电脑上的原始路径（对话框返回的那个）。 */
  srcPath: string
  /** 是否参与向量化；不给按 `true`。 */
  includeInRag?: boolean
}

/**
 * 登记结果。失败时 `code` 是**可被判定的**原因，`error` 是给人看的一句话。
 *
 * 为什么要 `code` 而不是只给文案：前端要按原因分支（重复 → 高亮已存在的那一行；
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

/** 单文件变更结果（删除 / 开关）。 */
export interface KbFileMutationResult {
  ok: boolean
  error?: string
  /** 删除时回执：连带清掉的分块数 / 副本是否被删。 */
  removedChunks?: number
  removedBlob?: boolean
}

/**
 * 生成文件摘要的结果。
 *
 * `coveredChars` 与 `totalChars` **必须一起返回**：界面靠它俩决定要不要写
 * 「这只是前 N 字的摘要」。只回一句摘要文本，就等于把「摘要覆盖了多少」这件事
 * 藏进了界面上没人会去点开的地方。
 */
export interface KbSummaryResult {
  ok: boolean
  error?: string
  summary?: string
  /** 生成它的模型（`provider/model`）。 */
  model?: string
  at?: number
  coveredChars?: number
  totalChars?: number
}

/**
 * 删库时对**库内文件**的处理回执。
 *
 * `movedFiles` 与 `removedFiles` 必须分开：`reassign` 时目标库若已有同内容文件，
 * 唯一索引不允许两行同 sha256，该文件**不迁移**并计入 `removedFiles` ——
 * 静默合并会让用户以为文件丢了（设计稿 §10 边界 7）。
 */
export interface KbFilesDeleteReport {
  ok: boolean
  movedFiles: number
  removedFiles: number
  error?: string
}

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

/** 崩溃恢复回执。 */
export interface KbFileRecoveryReport {
  /** 本次真正重置的行数（`skipped` 为 true 时恒为 0）。 */
  reset: number
  /** 本进程是否已经对同一个数据根做过恢复。 */
  skipped: boolean
  readError?: string
}

/**
 * 知识库检索的通道名。
 *
 * T3 只开 `sparse`（关键词）；`dense` 在 T4 接上向量库；`structured` 留给
 * 「按文件名 / 类型 / 页码这类元数据」的检索。把三个名字一次定下来，
 * 是为了让 `ranks` / `stats.channels` 这两个形状在 T4 加通道时**不用改**——
 * 改形状会让前端的解释面板跟着改一遍，而那正是最容易漏测的地方。
 */
export type KbChannelName = 'sparse' | 'dense' | 'structured'

/**
 * 知识库检索的一条命中。
 *
 * 粒度是**块**（一个 chunk），不是文件：同一份文件命中三处就是三条。
 * 这与设计稿的 `docKey = 'chunk:' + chunkId` 一致 —— 融合阶段靠它把同一块
 * 在多通道的命中合并成一条，所以粒度必须统一在块上。
 */
export interface KbHit {
  /** 命中的文件行 id（探针第 6 步断言「结果第一条的 fileId = 该文件」用的就是它）。 */
  fileId: number
  /** 文件名（含扩展名），来自 `kb_files.name`。 */
  fileName: string
  /** 小写扩展名（不含点）。 */
  fileExt: string
  /** 命中的块 id。 */
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
   * 为什么必须一并返回：`snippet` 只是命中词附近的窗口（`KB_SNIPPET_RADIUS` 两侧各 60 字），
   * 拿它当问答的引用证据会丢掉块里其余内容 —— 模型看到半句话就只能猜后半句，
   * 而重排的「词覆盖率」特征也会把只落在窗口外的检索词误判成未命中。
   * 面板检索只读 `snippet`（界面显示的就是那一段），不受影响。
   */
  text: string
  /**
   * 高亮区间，**偏移相对 `snippet`**（不是相对块原文）。
   *
   * 由后端算好给前端用，前端只做渲染、不做二次匹配 ——
   * 让前端自己再找一遍词，就会出现「后端按 bigram 命中、前端按字面找」的错位，
   * 表现为「搜到了但一个词都没高亮」。
   */
  marks: Array<{ start: number; end: number }>
  /** 相关度，**越大越相关**（`bm25` 取负）。跨查询之间不可比。 */
  score: number
  /** 各通道内的名次（1 基）；未命中该通道则缺省。 */
  ranks: Partial<Record<KbChannelName, number>>
}

/**
 * 知识库检索的统计。
 *
 * 刻意**不复用**消息域的 `RetrievalStats`：那 13 个字段里有一半是
 * 「消息 + 时间轴 + 意图分类」特有的（`intent` / `timeHint` / `hintHits` /
 * `recency` / `windowMessages` / `compressed` / `entity` / `fused`），
 * 知识库检索一个都产生不了。硬套的结果是往这些字段里填假值 ——
 * 而它们会直接显示在「为什么这条被召回」的解释里，等于给用户假信息。
 * 字段名与 `RetrievalStats` 的重合部分是刻意对齐的，T4 加稠密通道时形状不用动。
 */
export interface KbSearchStats {
  /** 各通道的参与情况。`active:false` 表示该通道没跑（附 `note` 说明原因）。 */
  channels: Array<{ channel: KbChannelName; count: number; active: boolean; note?: string }>
  /** 召回条数（= 命中块数）。 */
  recalled: number
  /** 最终保留条数；T3 无重排、无截断，与 `recalled` 相同。 */
  kept: number
  /** 实际生效的检索词数（标点被 bigram 化丢弃后可能少于用户输入）。 */
  terms: number
  /** 端到端耗时（毫秒）。 */
  elapsedMs: number
}

/**
 * 一次知识库检索的结果。
 *
 * 三个可选字段分别对应三种「没搜成」，**不能合并**：
 *   · `degraded` —— 搜成了，但只走了部分通道（界面上是「仅关键词（未建向量索引）」）；
 *   · `error`    —— 这次请求本身无效（如库标识缺失），重试无用；
 *   · `readError` —— 库打不开，可能是临时占用，重试可能成功。
 */
export interface KbSearchResult {
  kbId: number
  /** 回显用户输入（界面在结果区标题上原样显示，避免「看到的是上一次的结果」）。 */
  query: string
  hits: KbHit[]
  stats: KbSearchStats
  /**
   * 降级说明：`reason` 给代码判分支，`label` 给界面直接显示。
   *
   * 四种「只有关键词」的出路完全不同，混成一句就是假话：
   *   · `no-embed-model` 没配向量模型 ⇒ 去模型配置；
   *   · `no-vector-index` 本库还没建过索引 ⇒ 点「语义索引」；
   *   · `index-stale` 建过但换了嵌入模型 ⇒ 必须重建（且会再次出网）；
   *   · `embed-failed` 这次出网失败 ⇒ 重试或看网络，索引本身没问题。
   */
  degraded?: {
    reason: 'no-vector-index' | 'no-network' | 'no-key' | 'no-embed-model' | 'index-stale' | 'embed-failed'
    label: string
  }
  /** 请求无效的原因（如知识库标识缺失）。 */
  error?: string
  /** 库读不到（与「确实没有匹配」必须分开）。 */
  readError?: string
}

/**
 * Knowledge graph: note nodes plus `[[target]]` edges, **plus the document
 * entity layer** (registered files and the section headings inside them).
 *
 * The doc fields are required on purpose: an optional shape would let a caller
 * render a notes-only graph and silently keep files out of it, which is exactly
 * the gap this layer exists to close.
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
  /** Unresolved `[[target]]` values. */
  stubs: Array<{ key: string; label: string; refCount: number; referencedBy: number[] }>
  /** Registered files, one node each (`file:<id>`). Never per chunk — see `query/kb/entities.ts`. */
  docFiles: Array<{
    id: number
    label: string
    ext: string
    chunkCount: number
    charCount: number
    parseState: string
  }>
  /**
   * Section entities (`doc:<key>`), normalized and **merged across files**: the
   * same section title in three documents is one node, which is what makes
   * cross-document structure visible at all.
   */
  docSections: Array<{
    key: string
    label: string
    /** 出现过这一节的文件与**各自**的次数：containment 边的权重按它来定。 */
    files: Array<{ id: number; count: number }>
    occurrences: number
  }>
  /**
   * Model-extracted entities (`ent:<key>`) —— **推断层**，与上面两个观测层字段不同源。
   *
   * 它们来自 `query/kb/extract.ts`（让模型读一遍文件后说出的实体），
   * 可信度低于「文档里确实存在的章节」，所以：
   *   · 单独一个命名空间（`ent:`），不与 `doc:`（章节）混用；
   *   · 连到文件的边 kind 是 `suggest`，画布上画**虚线**；
   *   · 带着是哪个模型、什么时候抽的 —— 换模型后用户要能看出这批不是当前模型给的。
   * 同一 label 在多个文件里被抽出 ⇒ 合成一个节点，`files` 记各自的权重。
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
  /**
   * `note:<id>` → `note:<id>` (wiki) · `note:<id>` → `kb:<key>` (stub) ·
   * `file:<id>` → `doc:<key>` (contain: the section really is in that file) ·
   * `note:<id>` → `file:<id>` (mention: the note's title occurs in the file text) ·
   * `file:<id>` → `ent:<key>` (suggest: **模型推断**的实体，不是文档里观测到的).
   */
  edges: Array<{
    source: string
    target: string
    weight: number
    kind: 'wiki' | 'stub' | 'contain' | 'mention' | 'suggest'
  }>
  /** Source chat usernames → display names (labels for the note's source-chat entry). */
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
