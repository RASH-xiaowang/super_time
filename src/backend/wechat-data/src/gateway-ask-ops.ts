/**
 * WechatDataGateway 方法面 · AI 与知识链路的转发（问答 / 知识库 / 图谱 / 检索 / 总结）（M21 结构刀自 gateway.ts 拆出）。
 *
 * 这一层只有 `@Remote` 壳（装饰器 + 签名 + 一行转发）；装饰器标记会落到**最派生原型**上，
 * 因此协议层枚举到的方法面与拆分前逐名相同（守卫：`gateway-remote-surface.spec.ts`）。
 */

import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountsSnapshot, AnnualReport, AnnualSnapshot, AskHistoryClearResult, AskHistoryDeleteResult, AskHistoryQuery, AskHistorySnapshot, AskOptimizeResult, AskResult, AutoDbKeyResult, AutoImageKeyResult, AvatarResult, BackupMutationResult, BackupPreviewSnapshot, BackupSnapshot, CalendarSnapshot, CallsSnapshot, ChatHistoryResolveResult, ConfigSnapshot, ContactsSnapshot, DailySummaryResult, DbStatusSnapshot, DecryptAllResult, DecryptImagesResult, DecryptStatus, DeleteFavoriteResult, DraftClearResult, DraftsClearResult, EditMutationResult, EditedListSnapshot, EmoticonsSnapshot, ExportResult, ExportStatus, ExportHistoryDeleteResult, ExportHistoryQuery, ExportHistorySnapshot, ExportHistoryPruneOptions, FavoritesSnapshot, FilesSnapshot, GenerateKeysResult, GraphSnapshot, GroupInfoSnapshot, ImageDataUrlResult, KeysInfoResult, MemberSearchSnapshot, MessagesSnapshot, MomentsSnapshot, OverviewInsights, OverviewSnapshot, PaymentStatus, PrivacySnapshot, RecordsSnapshot, RevokedSnapshot, SearchBuildResult, SearchIndexStatus, SearchSnapshot, SessionsSnapshot, SimpleResult, StorageSnapshot, SummaryRecord, SummaryRecordSnapshot, SummaryTask, SummaryTaskInput, SummaryTaskMutationResult, SummaryTaskRunResult, SummaryTaskSnapshot, VerifyImageKeyResult, VerifyKeyResult, VideoInfoResult, VoiceDataUrlResult, VoiceInfoResult, VoiceTranscriptResult, VoiceTranscribeOneResult, VoiceTranscribeResult, WechatAccount, WechatConfigFull, WechatConfigPatch, WhisperDownloadProgress, WhisperDownloadResult, WhisperStatus, WhisperTranscribing, AssetInsightsSnapshot, BackupRestoreResult, Contact360Snapshot, DbHealthSnapshot, GroupInsightsSnapshot, HandoffRemindsSnapshot, LedgerSnapshot, MediaAssetsSnapshot, MomentsInsightsSnapshot, MomentsMonthlyRow, OfficialAssetsSnapshot, OperationCategory, OperationLogClearResult, OperationLogQuery, OperationLogSnapshot, OperationStatus, PeriodSummaryResult, PrivacyAuditClearResult, PrivacyAuditRow, PrivacyStateSnapshot, RegionMapSnapshot, TaskMutationResult, TasksSnapshot, UnifiedSearchSnapshot, KnowledgeSnapshot, NotesSnapshot, NoteMutationResult, KbDeleteAction, KbListSnapshot, KbMeta, KbMutationResult } from './types.ts'
import { buildSearchIndex, ensureSearchIndex, getSearchIndexStatus, knownEntityNames, searchIndexMessages, searchIndexMessagesCancellable } from './query/search.ts'
import type { KbFileAddResult, KbFileChunkPage, KbFileListSnapshot, KbFileMutationResult, KbFileRegisterResult, KbSearchResult, KbSummaryResult } from './types.ts'
import { buildKbVectorIndex, kbVectorIndexStatus, searchKbDense } from './query/kb-vectors.ts'
import type { KbVectorBuildResult, KbVectorIndexStatus } from './query/kb-vectors.ts'
import type { KbModelRole, KbModelSettings, ResolvedModel } from './query/kb/model-config.ts'
import { extractFileEntities, kbEntitySummary, mergeDocEntities, readDocEntities, type KbEntitySummary } from './query/kb/extract.ts'
import type { FeedbackRecord, IntentKind, RerankWeights } from './query/retrieval/types.ts'
import type { ReplySuggestResult } from './types.ts'
import type { KnowledgeSnapshotRead } from './query/notes.ts'
import { GatewayRead } from './gateway-read.ts'

/** 方法面的一层：继承链上的一环，不单独实例化（abstract：`runSummaryTask` 由更下面那层实现）。 */
export abstract class GatewayAskOps extends GatewayRead {
  /**
   * Knowledge graph: note nodes, `[[…]]` edges, unresolved stubs, **plus the
   * document entity layer** (registered files and their normalized sections).
   *
   * 与 `getGraph` 分开而不是合并：社交图谱的节点口径（联系人/群/我）和知识图谱
   * （笔记/未解析目标）是两套语义，合并会让两个面板都变脆。
   * 两份快照**不在前端拼**：知识图谱的节点必须只来自知识库，人/群是通讯录数据，
   * 因此曾经的「融合视图」已删除（见前端 panels/graph-model.ts 的文件头约束）。
   *
   * **一库一图**：`kbId` 必填且没有默认值可给 —— 改前这张图是全库合并的，
   * 多库之后会把两个库里同名的笔记并成一个节点，`[[链接]]` 也会指错库。
   *
   * 文档实体在这里合流，而不是在 `notes.ts` 里：笔记库与文件库是**两个 db 文件**，
   * `notes.ts` 那一层物理上看不见文件（它自己的注释就写着 `fileCount` 恒为 0）。
   * 与 `getKbs` 的 fileCount 合流是同一个理由、同一个位置。
   * 文件库读不到时图谱照常返回笔记部分，但把原因并进 `readError` ——
   * 「这个库没登记过文件」与「文件库打不开」必须是两句话（N1）。
   * @param kbId - the knowledge base to build from.
   * @returns KnowledgeSnapshot（含运行期可能带上的 `readError`，见 `KnowledgeSnapshotRead`）。
   */
  @Remote('getKnowledgeGraph')
  getKnowledgeGraph(kbId: number): KnowledgeSnapshotRead {
    return this.graphSearchRemotes().getKnowledgeGraph(kbId)
  }

  /**
   * 让模型读一遍本库的文件，抽出实体（推断层）。
   *
   * 三条纪律：
   *   ① `privacyBlocked('kb_extract')` 判在任何模型调用之前；
   *   ② 只处理 `include_in_rag = 1` 的文件 —— 关掉出网开关的文件连一次抽取都不该被发出去
   *      （条件在 SQL 里，见 `extract.ts` 的 `readDigestForExtract`）；
   *   ③ 按文件、不按 chunk，且**整批替换**上一次结果（重跑不是追加）。
   * @param options - `kbId`；`fileIds` 限定范围（默认整库）；`limit` 单次最多几个文件。
   * @returns 逐文件结果 + 汇总（失败的逐个带原因，不因一个失败就整批失败）。
   */
  @Remote('extractKbEntities')
  async extractKbEntities(options: { kbId: number; fileIds?: number[]; limit?: number }): Promise<{
    ok: boolean
    error?: string
    files: number
    saved: number
    failed: Array<{ id: number; error: string }>
    model: string
  }> {
  return this.kbRemotes().extractKbEntities(options)
  }

  /**
   * 笔记编辑器里的「模型建议的链接」—— 返回候选，**不写任何东西**。
   *
   * 三条纪律（V6 的全部内容）：
   *   ① `privacyBlocked('kb_link_suggest')` 判在所有早退之前 —— 「没配嵌入模型」不能
   *      盖掉「用户明确说过不要出网」，否则审计里看不到那次被拦下的尝试；
   *   ② 出去的是**正文 + 候选标题**，所以 gate 的 texts 必须一次带上两边
   *      （`makeEmbedFn` 内部对整批文本过一次闸，漏一半就等于漏的那半没脱敏）；
   *   ③ 本方法**没有任何写路径**：连一行正文都不碰。边只在用户点芯片之后由
   *      `parseWikiLinks` 从正文里派生 —— 模型判断错的代价因此是「没人点」，
   *      而不是「图谱里多了一条用户没写过的边」。
   * @param options - `kbId`、正在编辑的 `text`、可选 `topK` 与自身标题 `excludeTitle`。
   * @returns 候选（按相似度降序）+ 参与排序的池大小 + 说明。
   */
  @Remote('suggestKbLinks')
  async suggestKbLinks(options: { kbId: number; text?: string; topK?: number; excludeTitle?: string }): Promise<{
    ok: boolean
    error?: string
    candidates: Array<{ label: string; kind: 'note' | 'entity'; score: number }>
    pool: number
    model: string
    note?: string
  }> {
  return this.kbRemotes().suggestKbLinks(options)
  }

  /**
   * Knowledge base list — the scope selector's data source.
   *
   * 两个库文件在这里**合流**：笔记数来自笔记库（`listKbs`），文件数来自文件库
   * （`countKbFilesByKb`，一次 GROUP BY）。合并只能写在这一层 —— `notes.ts` 看不到文件库。
   *
   * 少了这次合并，界面上的 `fileCount` 会恒为 0，于是删库弹层对一个「0 条笔记 / 5 个文件」
   * 的库说「这个库是空的」（真机探针实测）。文件库读失败时 `countKbFilesByKb` 返回空表 ⇒
   * 退化成 0，与本次改动前的行为一致，不是新增风险。
   * @returns KbListSnapshot: every kb with its note count **and** file count. An
   *   unreadable note store yields an empty list **plus** `readError`; callers must
   *   not read that as "there is no kb at all" and create one over the top.
   */
  @Remote('getKbs')
  getKbs(): KbListSnapshot {
  return this.kbRemotes().getKbs()
  }

  /**
   * Create one knowledge base.
   * @param options - `name`: required, normalized-unique, at most `KB_NAME_MAX` chars.
   * @returns KbMutationResult: `{ ok, id }`, or `{ ok: false, error }`.
   */
  @Remote('createKb')
  createKb(options: { name: string }): KbMutationResult {
  return this.kbRemotes().createKb(options)
  }

  /**
   * Rename one knowledge base.
   *
   * 笔记**不动**：归属存在 `kb_id` 上，库名只是显示名。用库名当外键的话，
   * 「改名」会退化成「迁移全部笔记」，还要处理迁移到一半崩掉。
   * @param options - `id` plus the new `name`.
   * @returns KbMutationResult.
   */
  @Remote('renameKb')
  renameKb(options: { id: number; name: string }): KbMutationResult {
  return this.kbRemotes().renameKb(options)
  }

  /**
   * Delete one knowledge base.
   *
   * `action` **必填、无默认值**：库里的笔记是「搬到别的库」还是「一起删掉」只有调用方
   * 能决定，而这里最危险的默认值恰好是「一起删」—— 一次「我以为只是删个空壳库」的点击
   * 会直接把几十条笔记带走。默认库本身也不可删（它是迁移兜底）。
   * @param options - `id` plus `action` (`{kind:'reassign',targetKbId}` or `{kind:'purge'}`).
   * @returns KbMutationResult carrying `movedNotes` / `removedNotes`.
   */
  @Remote('deleteKb')
  deleteKb(options: { id: number; action: KbDeleteAction }): KbMutationResult {
  return this.kbRemotes().deleteKb(options)
  }

  /**
   * 一个知识库里的文件列表（新上传的在前）。
   *
   * 与 `getNotes` 同口径，`kbId` 必填：文件、分块、检索全部按库划作用域，
   * **没有**「所有库的文件」这种视图 —— 那正是多库之后最容易出现的串数据。
   * @param kbId - the knowledge base to read; required, there is no "all kbs" mode.
   * @param options - Pagination (limit/offset).
   * @returns KbFileListSnapshot. 库读不到时给 `readError` 而不是空列表，
   *   好让面板说「读不到」而不是「还没有文件」。
   */
  @Remote('getKbFiles')
  getKbFiles(kbId: number, options?: { limit?: number; offset?: number }): KbFileListSnapshot {
  return this.kbRemotes().getKbFiles(kbId, options)
  }

  /**
   * 读某个文件解析出来的正文（分页）。界面上「就地展开看内容」走这一条。
   *
   * 与 `getKbFiles` 同样：`kbId` 必填、没有「所有库」模式，而且这一条**还多一道**
   * `fileId` 必须属于该库的确认 —— 它返回的是内容而不是计数，跨库串起来的后果重得多。
   * 返回的是解析文本，不是原文件排版（表格 / 图片 / 页眉页脚在解析阶段已丢），
   * 界面上必须这样标注，别让人以为在看原稿。
   * @param kbId - 目标库（必填）。
   * @param fileId - 目标文件。
   * @param options - 分页（limit 上限 200 块）。
   * @returns KbFileChunkPage。
   */
  @Remote('getKbFileChunks')
  getKbFileChunks(kbId: number, fileId: number, options?: { limit?: number; offset?: number }): KbFileChunkPage {
  return this.kbRemotes().getKbFileChunks(kbId, fileId, options)
  }

  /**
   * 登记一批文件（原生对话框多选的结果）。
   *
   * 逐个登记、逐个回执：每个文件各自一个事务，中途某一个失败不影响已经进来的那些。
   * 于是一次多选的部分失败（重复 / 类型不支持 / 太大）是**可解释**的，
   * 而不是一句笼统的「添加失败」。
   * @param options - `kbId`、`paths`（绝对路径数组）、`includeInRag`（不给按 true）。
   * @returns KbFileAddResult：`ok` = 至少进来一个；逐项原因在 `results` 里。
   */
  @Remote('addKbFiles')
  addKbFiles(options: { kbId: number; paths: string[]; includeInRag?: boolean }): KbFileAddResult {
  return this.kbRemotes().addKbFiles(options)
  }

  /**
   * 删除一个文件（连带它的分块 / FTS 行 / 向量 / blob 副本）。
   *
   * **不碰用户电脑上的原文件** —— 删的是知识库里的这一份，那份原文件仍然在他的盘上。
   * `kbId` 是**守卫**：文件 id 全局自增，拿甲库的 id 调乙库会删掉甲库那一条，
   * 而删除是物理的、没有撤销（与 `deleteNote` 同一条纪律）。
   * @param options - `kbId` plus the file row id.
   * @returns KbFileMutationResult（回执里带连带清掉的分块数与副本是否被删）。
   */
  @Remote('deleteKbFile')
  deleteKbFile(options: { kbId: number; id: number }): KbFileMutationResult {
  return this.kbRemotes().deleteKbFile(options)
  }

  /**
   * 切换一个文件是否参与向量化（出网）。
   *
   * 关掉之后该文件**完全不出网**，但仍然留在 FTS 索引里可被关键词搜到 ——
   * 这正是「库里有合同，但我还想搜到它」的实现方式（设计稿 §9.2）。
   * 全局「禁止 AI 出网」仍然是同一道闸门，一起拦下。
   * @param options - `kbId`、文件 id、是否参与。
   * @returns KbFileMutationResult.
   */
  @Remote('setKbFileRag')
  setKbFileRag(options: { kbId: number; id: number; includeInRag: boolean }): KbFileMutationResult {
  return this.kbRemotes().setKbFileRag(options)
  }

  /**
   * 用模型给某个知识库文件生成摘要。**这是一条出网调用**，与问答同一套闸门。
   *
   * 顺序是硬性的（照 `optimizeAskQuestion` 的口径，理由写在它头上）：
   *   ① `privacyBlocked` 判在**最前面**，早于「未配置模型」那类早退 ——
   *      否则用户开了「禁止 AI 出网」又没配模型时，看到的是「未配置模型」，
   *      把「拦截真的生效了」这件事盖掉了。
   *   ② `include_in_rag = 0` 直接拒绝：那个开关的语义是「这份文件永不出网」，
   *      给它做摘要等于推翻用户已经做过的决定，不是「再确认一下」能补的。
   *   ③ 发出去之前过一次 `privacyGate`（脱敏 + 审计）。
   *
   * ⚠ 只喂得下前若干字：一份文件最多两万块、约一千万字，一次请求装不进去。
   *   所以按 `SUMMARY_INPUT_CHARS` 截断，并把**实际覆盖的字符数**一起返回并落库 ——
   *   界面必须据此标出「这只是前 N 字的摘要」。不标就是让一个局部摘要
   *   顶着「摘要」的名字被当成整份文件的概括读，那是界面在骗人。
   * @param options - `kbId`（守卫）与 `id`（目标文件）。
   * @returns KbSummaryResult。
   */
  @Remote('summarizeKbFile')
  async summarizeKbFile(options: { kbId: number; id: number }): Promise<KbSummaryResult> {
  return this.kbRemotes().summarizeKbFile(options)
  }

  /**
   * 在某个知识库里做检索 —— 稀疏（FTS5 bm25）+ 稠密（向量余弦）两路，RRF 名次融合。
   *
   * 为什么稠密这一路要在网关做而不下沉进 `searchKbRows`：稠密要**出网**（把查询词送去
   * embedding），而隐私闸门与模型名解析都住在这一层；query 层保持「给什么函数用什么函数」，
   * 才能被问答管道与面板同时复用（`retrieval/kb-channel.ts` 走的就是同一个 `searchKbDense`）。
   *
   * `degraded` 现在说的是**本次真话**（原来是一句硬编码的「未建向量索引」）：
   * 未配模型 / 索引过期 / embedding 失败 / 稠密跑成功，四种情形的出路完全不同，
   * 混成一句会让用户以为「知识库里没有这个东西」。
   * @param options - `kbId`、查询词、可选条数（上限 `MAX_KB_TOP_K`）。
   * @returns KbSearchResult：命中 + 统计 + 降级说明。
   */
  @Remote('searchKb')
  async searchKb(options: { kbId: number; query?: string; topK?: number }): Promise<KbSearchResult> {
  return this.kbRemotes().searchKb(options)
  }

  /**
   * 某个知识库的**模型设置**（三个角色的引用 + 各自实际生效的名字）。
   *
   * 回包里同时给「引用串」和「解析结果」：下拉框要回填前者（用户改过什么），
   * 而界面要说的是后者（现在到底在用哪个模型）。只给一个就会出现
   * 「显示的是全局值、实际用的是覆盖值」这类看起来无害的错位。
   * @param options - `kbId`。
   * @returns 设置 + 三角色的解析结果 + 全局值（下拉里「继承全局：xxx」那半句要用）
   *   + 实体抽取的进度（同一个回包：弹层开一次要读三样，分开读会让首帧分三次跳）。
   */
  @Remote('getKbModelConfig')
  getKbModelConfig(options: { kbId: number }): {
    kbId: number
    settings: KbModelSettings
    global: Record<KbModelRole, string>
    resolved: Record<KbModelRole, ResolvedModel>
    entities: KbEntitySummary
  } {
  return this.kbRemotes().getKbModelConfig(options)
  }

  /**
   * 写某个知识库的模型覆盖（只改传进来的那几项；传空串 = 取消覆盖、回到继承）。
   *
   * 这一层**不写凭据**：引用串只能是「继承」或「m:<模型名>」，端点与 Key 永远只在 `llm.json`。
   * 为什么收窄到这样：一条 profile 是一套同厂商的连接参数，按库引用它就会把
   * 「A 家地址 + B 家 Key」这种 401 陷阱重新请回来（见 `model-config.ts` 头注）。
   * @param options - `kbId` 加可选的 `chatRef` / `embedRef` / `rerankRef`。
   * @returns 最新设置；引用串不合法时 `{ ok: false, error }`（不静默改成继承）。
   */
  @Remote('setKbModelConfig')
  setKbModelConfig(options: { kbId: number; chatRef?: string; embedRef?: string; rerankRef?: string }):
    { ok: true; settings: KbModelSettings } | { ok: false; error: string } {
  return this.kbRemotes().setKbModelConfig(options)
  }

  /**
   * 某个知识库的**向量索引状态**（面板的「语义索引」按钮与状态 chip 读这个）。
   *
   * 为什么要单独一个读接口：向量索引此前只有一个隐式入口 —— 提问时顺手补齐
   * （`askWechat` 里那段），于是界面上既**触发不了**它也**看不见**它：
   * 用户只知道「有时能语义搜到、有时搜不到」，而差别其实只是这个库建没建过。
   * @param options - `kbId`。
   * @returns 当前生效的模型名、是否配了通道、按库状态、以及本进程内的在飞构建进度。
   */
  @Remote('getKbVectorIndex')
  getKbVectorIndex(options: { kbId: number }): {
    kbId: number
    model: string
    source: 'inherit' | 'inline'
    configured: boolean
    status: KbVectorIndexStatus
    job: { done: number; total: number; startedAt: number; error: string } | null
  } {
  return this.kbRemotes().getKbVectorIndex(options)
  }

  /**
   * 为**某个库**构建 / 增量更新向量索引（面板上那个「语义索引」按钮）。
   *
   * 三条纪律：
   *   ① 出站拦截判在**任何 embedding 之前**（`privacyBlocked` 先于「未配置模型」那类早退）；
   *   ② 只建本库 —— 出网范围必须与用户此刻的意图一致，一次建全库会把别的库的正文也发出去；
   *   ③ 语料只取 `include_in_rag = 1` 的文件，且写在 SQL 里（见 `kb-vectors.ts` 头注）。
   * @param options - `kbId`；`force` 时清空本库重算。
   * @returns 构建结果（`ok` 为假时带 `error`）。
   */
  @Remote('buildKbVectorIndex')
  async buildKbVectorIndex(options: { kbId: number; force?: boolean }): Promise<KbVectorBuildResult & { ok: boolean; error?: string }> {
  return this.kbRemotes().buildKbVectorIndex(options)
  }

  /**
   * Build (or rebuild) the FTS5 message search index.
   * @param options - force: rebuild even when the index already exists.
   * @returns SearchBuildResult: build outcome with row counts.
   */
  @Remote('buildSearchIndex')
  async buildSearchIndex(options?: { force?: boolean }): Promise<SearchBuildResult> {
    return this.graphSearchRemotes().buildSearchIndex(options)
  }

  /**
   * Full-text search over text messages (index first, scan fallback).
   *
   * N9：可取消。渲染层每次搜索生成一个 `jobId`，切换面板/发起新搜索时用 `cancelSearch({ jobId })`
   * 打断上一次 —— 兜底扫描会在百毫秒内收尾并返回部分结果（见 `query/search.ts` 的 `SearchControl`）。
   * 不带 jobId 时行为与从前一致（跑完为止）。
   * @param options - query string, optional result limit and optional talker scope.
   * @returns SearchSnapshot: matched message items（被取消时带 `cancelled: true`）。
   */
  @Remote('searchMessages')
  async searchMessages(options: { query: string; limit?: number; username?: string; jobId?: string }): Promise<SearchSnapshot> {
    return this.graphSearchRemotes().searchMessages(options)
  }

  /**
   * AI Q&A over WeChat data: retrieve context + DSH LLM answer with citations.
   * @param options - question to ask over the WeChat data.
   * @returns AskResult: LLM answer with citations.
   */
  @Remote('askWechat')
  async askWechat(options: {
    question: string
    username?: string
    from?: string
    to?: string
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
    /** 客户端生成的流式标识：带上它才会推送 wechat-ask/delta 增量事件。 */
    streamId?: string
    /**
     * 入口来源，写进问答历史：`ask` = 「微信问答」页签，`session` = 会话内问答。
     * 缺省按 `ask` 处理 —— 旧客户端不带这个字段时也能正常落库。
     */
    source?: string
    /** 会话显示名：历史列表直接显示，省掉面板再查一次会话表。 */
    usernameName?: string
    /**
     * 当前知识库 id：本次提问会把该库的文件块一并纳入检索。
     *
     * 缺省不检索知识库（而不是「搜所有库」）—— 与其余知识库接口同一纪律：
     * `kbId` 是作用域，没有「所有库」这种模式；漏传应当表现为「没检索到文件」，
     * 而不是把别的库的内容也端上来。
     */
    kbId?: number
  }): Promise<AskResult> {
    return this.askDeepRemotes().askWechat(options)
  }

  /**
   * 提问优化：把用户问题改写为更利于本机检索的形式，并给出改进建议。
   * 供「微信问答」面板的「优化提问」按钮调用；出站前同样过隐私闸门。
   * @param options - question（必填）+ 可选 scope/history 作上下文。
   * @returns AskOptimizeResult: optimized + suggestions。
   */
  @Remote('optimizeAskQuestion')
  async optimizeAskQuestion(options: {
    question: string
    username?: string
    from?: string
    to?: string
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
  }): Promise<AskOptimizeResult> {
    return this.askDeepRemotes().optimizeAskQuestion(options)
  }

  /**
   * RAG 检索层状态：配置 + 向量库 + 反馈统计 + 当前调参权重 + 意图分类自评。
   * @returns 供「数据健康」面板与诊断脚本展示（原「检索设置」面板已于 2026-09-17 下线）。
   */
  @Remote('getRetrievalStatus')
  getRetrievalStatus(): {
    enabled: boolean
    config: unknown
    vector: { rows: number; dim: number; model: string }
    feedback: { total: number; up: number; down: number }
    weights: RerankWeights
    intentAccuracy: { correct: number; total: number; accuracy: number }
  } {
    return this.askRemotes().getRetrievalStatus()
  }

  /**
   * 保存检索参数（阈值/权重/容量）。
   * **界面已不再暴露该入口**（面板下线，参数固化为产品默认值）——仅供诊断与自动化测试参考使用。
   * @param options - 形如 `{ patch: {...} }`，或直接给字段子集。
   * @returns 落盘后的完整配置。
   */
  @Remote('saveRetrievalConfig')
  saveRetrievalConfig(options?: { patch?: unknown } | unknown): { ok: boolean; config: unknown } {
    return this.askRemotes().saveRetrievalConfig(options)
  }

  /**
   * 立即构建/增量更新稠密向量索引。
   * 界面已不暴露该入口：首次提问时网关会自动增量构建（失败则降级纯稀疏），
   * 本方法留给诊断与自动化测试使用。
   * @param options - force=true 时清空重建。
   * @returns 构建结果。
   */
  @Remote('buildRagVectorIndex')
  async buildRagVectorIndex(options?: { force?: boolean }): Promise<{ ok: boolean; status: string; rows: number; embedded: number; elapsed_ms: number; message?: string }> {
    return this.askDeepRemotes().buildRagVectorIndex(options)
  }

  /**
   * 提交问答反馈（目标 5 的闭环入口）。
   *
   * 反馈 → 特征归因 → 权重微调 → 落盘。权重**由全部历史反馈重算**（幂等、可重放），
   * 而不是在旧权重上累加 —— 累加会因为重复提交同一条反馈而漂移。
   *
   * N27：同一轮反馈在 10 秒窗口内的重复提交会被挡掉并返回可读的「已在处理」，
   * 不再产生第二条反馈记录 / 第二次权重适配（前端闸门只管同一个面板的连点，
   * 两个面板同时提交、旧版客户端重试、直接 RPC 调用都落到这里）。
   * @param options - retrievalId（AskResult 里回传）+ rating + 有用/无用引用序号。
   * @returns 调参后的权重；重复提交时 `ok:false` + `message`。
   */
  @Remote('submitAskFeedback')
  submitAskFeedback(options: {
    retrievalId?: string
    rating: 'up' | 'down'
    useful?: number[]
    useless?: number[]
    question?: string
    answer?: string
  }): { ok: boolean; adaptedWeights?: RerankWeights; features?: string[]; message?: string } {
    return this.askRemotes().submitAskFeedback(options)
  }

  /**
   * 列出最近的问答反馈 + 汇总统计。
   * @param options - limit。
   */
  @Remote('listRetrievalFeedback')
  listRetrievalFeedback(options?: { limit?: number }): {
    items: FeedbackRecord[]
    stats: { total: number; up: number; down: number }
  } {
    return this.askRemotes().listRetrievalFeedback(options)
  }

  /**
   * 跑离线召回评估（合成评测集），并给出「混合 vs 纯稀疏」的消融对比。
   *
   * 不依赖真实数据，因此可以随时直连调一次就看到当前算法的 P/R/MRR/NDCG
   * （界面无入口），也可以在 CI 里断言「混合不低于纯稀疏」防止退化。
   * @param options - k（截断位置，默认 10）。
   * @returns 可读报告 + 结构化指标。
   */
  @Remote('evaluateRetrieval')
  evaluateRetrieval(options?: { k?: number }): {
    report: string
    hybrid: { precision: number; recall: number; mrr: number; ndcg: number; map: number; cases: number; hits: number }
    sparseOnly: { precision: number; recall: number; mrr: number; ndcg: number; map: number; cases: number; hits: number }
    intentAccuracy: { correct: number; total: number; accuracy: number }
  } {
    return this.graphSearchRemotes().evaluateRetrieval(options)
  }

  /**
   * Generate a daily chat summary for one date via DSH LLM.
   * @param options - date (YYYY-MM-DD) to summarize.
   * @returns DailySummaryResult: summary text with session/message counts.
   */
  @Remote('generateDailySummary')
  async generateDailySummary(options: { date: string; provider?: string; model?: string }): Promise<DailySummaryResult> {
    return this.summaryRecordRemotes().generateDailySummary(options)
  }

  /**
   * Restore a message to its original content.
   * @param options - username and localId of the edited message.
   * @returns EditMutationResult: ok, or error on failure.
   */
  @Remote('resetEditedMessage')
  resetEditedMessage(options: { username: string; localId: number }): EditMutationResult {
    return this.graphSearchRemotes().resetEditedMessage(options)
  }

  /**
   * 读取问答历史（供「微信问答 → 历史记录」弹窗）。
   *
   * 与 `getExportHistory` 同样**不走**宿主的结果缓存：历史是「按当前事实」的数据，
   * 刚问完就打开列表必须能看到那一条，缓存住的旧结果会表现成「问答没被保存」。
   * @param options - 搜索 / 来源筛选 / 状态筛选 / 时间范围 / 排序 / 分页。
   * @returns 一页条目 + 命中总数 + 各聚合计数。
   */
  @Remote('getAskHistory')
  getAskHistory(options?: AskHistoryQuery): AskHistorySnapshot {
    return this.askRemotes().getAskHistory(options)
  }

  /**
   * List daily-summary tasks.
   * @returns SummaryTaskSnapshot: summary tasks (items + total).
   */
  @Remote('listSummaryTasks')
  listSummaryTasks(): SummaryTaskSnapshot {
    return this.summaryRemotes().listSummaryTasks()
  }

  /**
   * Save (insert/update) a daily-summary task.
   *
   * 入参里没有 `lastRunAt` / `lastStatus` / `lastError` —— 那是运行状态，只有 `runSummaryTask`
   * 那条路（`updateSummaryTaskRunState`）会写。理由见 `types-calls.ts` 的 `SummaryTaskInput`。
   * @param options - task payload (id present = update, absent = insert).
   * @returns SummaryTaskMutationResult: ok + id, or error.
   */
  @Remote('saveSummaryTask')
  saveSummaryTask(options: { task: SummaryTaskInput }): SummaryTaskMutationResult {
    return this.summaryRemotes().saveSummaryTask(options)
  }

  /**
   * Delete a daily-summary task.
   * @param options - id of the task to delete.
   * @returns SummaryTaskMutationResult: ok, or error on failure.
   */
  @Remote('deleteSummaryTask')
  deleteSummaryTask(options: { id: number }): SummaryTaskMutationResult {
    return this.summaryRemotes().deleteSummaryTask(options)
  }

  /**
   * Toggle a daily-summary task enabled state.
   * @param options - task id and the new enabled flag.
   * @returns SummaryTaskMutationResult: ok, or error on failure.
   */
  @Remote('toggleSummaryTask')
  toggleSummaryTask(options: { id: number; enabled: boolean }): SummaryTaskMutationResult {
    return this.summaryRemotes().toggleSummaryTask(options)
  }

  /**
   * Delete one generated summary record.
   * @param options - id of the record to delete.
   * @returns SummaryTaskMutationResult: ok, or error on failure.
   */
  @Remote('deleteSummaryRecord')
  deleteSummaryRecord(options: { id: number }): SummaryTaskMutationResult {
    return this.summaryRecordRemotes().deleteSummaryRecord(options)
  }

  @Remote('runSummaryTask')
  async runSummaryTask(options: { id: number }): Promise<SummaryTaskRunResult> {
    return this.summaryRemotes().runSummaryTask(options)
  }

  /**
   * 「推荐回复」：按**当前会话**的上下文（+ 用户选中的知识库）给出候选回复。
   *
   * 与问答的区别是**不检索全库**：上下文只取这个会话最近若干条，知识库片段也只在用户
   * 显式选了库时才取。会话级功能不该把别处的聊天悄悄端上来 —— 这正是「单聊里冒出别人
   * 消息」那类报障的教训。
   *
   * 出站顺序与当日总结一致：**拦截优先于「模型不可用」**，否则用户开了「禁止 AI 出网」
   * 却只看到一句「模型不可用」，会以为是配置问题而不是隐私设置生效。
   * @param options - `username` 会话；`kbId` 当前选中的库（可缺省）；`count` 想要几条（默认 3，上限 5）。
   * @returns 候选回复；被拦下或模型不可用时 `ok=false` 且 `error` 说明原因。
   */
  @Remote('suggestReplies')
  async suggestReplies(options: { username?: string; kbId?: number; count?: number }): Promise<ReplySuggestResult> {
    return this.summaryRecordRemotes().suggestReplies(options)
  }

  @Remote('generatePeriodSummary')
  async generatePeriodSummary(options: { from: string; to: string; provider?: string; model?: string }): Promise<PeriodSummaryResult> {
    return this.summaryRecordRemotes().generatePeriodSummary(options)
  }
}
