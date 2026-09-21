/**
 * `api.ts` 的「笔记与知识库：笔记增删改、库与文件、摘要与检索、实体抽取与链接建议，以及三处缓存失效」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module api-kb
 */

import {
  cachedFetch,
  cachedGet,
  invalidateSnapshotCache,
  invalidateWechatCache,
  readRenderCache,
  snapshotDelete,
  subscribeSnapshot,
  writeRenderCache,
} from './cache.ts'
import { notifyKbsUpdated, notifyNotesUpdated } from './notes-events.ts'
import type {
  KbDeleteAction,
  KbFileAddResult,
  KbFileChunkPage,
  KbFileListSnapshot,
  KbFileMeta,
  KbFileMutationResult,
  KbFileRegisterResult,
  KbListSnapshot,
  KbMutationResult,
  KbSearchResult,
  KbSummaryResult,
  KbVectorBuildResult,
  KbVectorIndexView,
  KbModelConfigResult,
  KbModelConfigView,
  KbExtractResult,
  KbLinkSuggestResult,
  KnowledgeSnapshot,
  NoteMutationResult,
  NotesSnapshot,
} from './types.ts'
import { KB_LIST_CACHE_KEY, kbCacheKey } from './kb-scope-keys.ts'
import { KbListSnapshotRead, NotesSnapshotRead, remote, unwrap } from './api-core.ts'
import { apiSaveFileDialog } from './api-media.ts'

/**
 * List knowledge notes.
 *
 * 刻意**不走缓存**：笔记是本地 sqlite 的直读，代价可忽略，而搜索框每敲一个字都
 * 需要最新结果 —— 挂上 30s 快照缓存只会让用户看到过期列表。
 * @param options - Optional search query and row cap.
 * @returns NotesSnapshot（读不到库时带 `readError`，与「确无笔记」可区分）。
 */
export async function apiGetNotes(kbId: number, options?: { query?: string; limit?: number }): Promise<NotesSnapshotRead> {
  return unwrap(await remote().getNotes(kbId, options))
}

/**
 * Create or update one note. Invalidates the knowledge caches so the graph
 * panel reflects the change without waiting out the snapshot TTL.
 * @param input - Note fields; omit `id` to create.
 * @returns NoteMutationResult.
 */
export async function apiSaveNote(kbId: number, input: {
  id?: number
  title: string
  body?: string
  tags?: string[] | string
  sourceKind?: 'manual' | 'ask'
  sourceUsername?: string
  sourceQuestion?: string
}): Promise<NoteMutationResult> {
  const result = unwrap(await remote().saveNote(kbId, input))
  invalidateKnowledgeCaches()
  return result
}

/** Delete one note (links pointing at it become stubs). */
export async function apiDeleteNote(kbId: number, id: number): Promise<NoteMutationResult> {
  const result = unwrap(await remote().deleteNote(kbId, { id }))
  invalidateKnowledgeCaches()
  return result
}

/**
 * 库列表（含每库笔记条数）。
 *
 * 走快照缓存：切换器、笔记面板、图谱面板各挂一次 `useKbScope()`，不缓存就是同一张几张行的
 * 小表被 RPC 三遍。它的键**刻意不叫 `kb-list`**：`kb-` 那一族是「某个库的内容」，
 * 而库登记表是另一类东西 —— 笔记内容变了不该动它，库表变了才动它（两条失效路径因此分开）。
 * @returns KbListSnapshot.
 */
export async function apiGetKbs(): Promise<KbListSnapshotRead> {
  return cachedGet(KB_LIST_CACHE_KEY, async () => unwrap(await remote().getKbs()))
}

/**
 * 新建一个知识库。
 * @param name - 库名（后端去空白 + 归一化后按库判重）。
 * @returns KbMutationResult.
 */
export async function apiCreateKb(name: string): Promise<KbMutationResult> {
  const result = unwrap(await remote().createKb({ name }))
  invalidateKbCaches()
  return result
}

/**
 * 重命名一个知识库（默认库也在内：它是「不可删」，不是「不可改」）。
 * @param id - 库 id。
 * @param name - 新库名。
 * @returns KbMutationResult.
 */
export async function apiRenameKb(id: number, name: string): Promise<KbMutationResult> {
  const result = unwrap(await remote().renameKb({ id, name }))
  invalidateKbCaches()
  return result
}

/**
 * 删除一个知识库。`action` **必填**（见 `KbDeleteAction`）：删掉一个非空库是
 * 「笔记一起删」还是「移到别的库」必须由用户明说，后端不猜。
 *
 * 这里**刻意不广播 `NOTES_UPDATED_EVENT`**：删的是当前库时，面板手上那个 kbId 已经不存在了，
 * 一广播就会先闪一次「知识库不存在」。重取由作用域切换驱动 ——
 * `KBS_UPDATED_EVENT` → `useKbScope` 发现当前库不在列表里 → 退回一个存在的库 →
 * 面板的 effect 依赖 kbId，自然重取。删的是别的库时，当前库的笔记本就没变。
 * 缓存仍然要清（不广播不等于不清）：否则切回去时会读到已被删掉那个库的旧列表。
 * @param id - 库 id。
 * @param action - 库内笔记的处理方式。
 * @returns KbMutationResult.
 */
export async function apiDeleteKb(id: number, action: KbDeleteAction): Promise<KbMutationResult> {
  const result = unwrap(await remote().deleteKb({ id, action }))
  dropKnowledgeCaches()
  invalidateKbCaches()
  return result
}

// ── 知识库文件（KB-RAG 计划的 T2） ─────────────────────────────────────────
// 文件是知识库的**第三类内容**（笔记 / 图谱 / 文件），作用域同样由 kbId 划。
// 后端落在独立的 `wechat_kb_files.db`（不是 notes 库里的几张表）：这样「文件功能整体
// 回退」= 删一个库文件 + 摘掉这几个 Remote 注册，不会在 notes 库里留下半张表。

/**
 * 一个知识库里的文件列表（新上传的在前）。
 *
 * `kbId` 必填、**没有**「所有库的文件」这种视图 —— 与 `apiGetNotes` 同口径：
 * 文件、分块、检索全部按库划作用域，漏传就会「切了库但文件列表没变」。
 *
 * 刻意**不走快照缓存**（同 `apiGetNotes` 的理由）：列表是本地 sqlite 的直读，
 * 代价可忽略，而上传 / 删除之后要求立刻看到最新结果 —— 挂 TTL 只会让用户对着
 * 旧列表怀疑「根本没传上去」。首帧的即时感由面板侧的渲染缓存（`kb-files:<id>`）负责。
 * @param kbId - 知识库 id（必填位置参数）。
 * @param options - 分页。
 * @returns 文件列表快照；读不到库时带 `readError`（与「还没有文件」可区分）。
 */
export async function apiGetKbFiles(kbId: number, options?: { limit?: number; offset?: number }): Promise<KbFileListSnapshot> {
  return unwrap(await remote().getKbFiles(kbId, options))
}

/**
 * 读某个文件解析出来的正文（分页）。界面上「就地展开看内容」走这一条。
 *
 * **不走快照缓存**（同 `apiGetKbFiles`）：一次是一页、最多 200 块，本地 sqlite 直读的
 * 代价可忽略；而缓存它要额外回答「什么时候算旧」—— 重新解析、改库、删文件都得记得清，
 * 漏一处就是「明明重解析了，展开看到的还是旧正文」。
 *
 * ⚠ `kbId` 与 `fileId` 都要传：后端会确认这个文件确实属于这个库，
 * 否则只凭 fileId 就能读到别的库的内容，而这条返回的是**正文**不是计数。
 * @param kbId - 知识库 id（必填）。
 * @param fileId - 目标文件。
 * @param options - 分页。
 * @returns KbFileChunkPage；`readError` 非空时 `items` 为空。
 */
export async function apiGetKbFileChunks(
  kbId: number, fileId: number, options?: { limit?: number; offset?: number },
): Promise<KbFileChunkPage> {
  return unwrap(await remote().getKbFileChunks(kbId, fileId, options))
}

/**
 * 登记一批文件（原生对话框多选的结果）。
 *
 * 逐项回执：**部分成功是常态**（一次选 10 个、3 个重复、1 个类型不支持），
 * 所以返回 `added` / `failed` / `results`，由调用方逐条说清哪几个为什么没进来 ——
 * 一句笼统的「添加失败」会让用户把没问题的文件也重选一遍。
 * @param kbId - 知识库 id。
 * @param paths - 用户电脑上的绝对路径（后端只登记，**不写不删原件**）。
 * @param includeInRag - 是否参与向量化（出网）；不给按后端缺省（参与）。
 * @returns KbFileAddResult。
 */
export async function apiAddKbFiles(kbId: number, paths: string[], includeInRag?: boolean): Promise<KbFileAddResult> {
  const result = unwrap(await remote().addKbFiles({ kbId, paths, ...(includeInRag === undefined ? {} : { includeInRag }) }))
  invalidateKbFileCaches(kbId)
  return result
}

/**
 * 从知识库里删掉一个文件（连带分块 / 关键词索引 / 向量 / blob 副本）。
 *
 * **不碰用户电脑上的原文件** —— 删的是知识库里的这一份，那份原文件仍在他的盘上。
 * `kbId` 是**守卫**：文件 id 全局自增，拿甲库的 id 调乙库会删掉甲库那一条，
 * 而删除是物理的、没有撤销。
 * @param kbId - 知识库 id（守卫）。
 * @param id - 文件行 id。
 * @returns KbFileMutationResult（回执带连带清掉的分块数）。
 */
export async function apiDeleteKbFile(kbId: number, id: number): Promise<KbFileMutationResult> {
  const result = unwrap(await remote().deleteKbFile({ kbId, id }))
  invalidateKbFileCaches(kbId)
  return result
}

/**
 * 切换一个文件是否参与向量化（出网）。
 *
 * 关掉之后该文件**完全不出网**，但仍留在关键词索引里可被搜到 —— 这正是
 * 「库里有合同，但我还想搜到它」的实现方式。全局「禁止 AI 出网」仍是同一道闸门，
 * 一起拦下。
 * @param kbId - 知识库 id（守卫）。
 * @param id - 文件行 id。
 * @param includeInRag - 是否参与。
 * @returns KbFileMutationResult。
 */
export async function apiSetKbFileRag(kbId: number, id: number, includeInRag: boolean): Promise<KbFileMutationResult> {
  const result = unwrap(await remote().setKbFileRag({ kbId, id, includeInRag }))
  invalidateKbFileCaches(kbId)
  return result
}

/**
 * 用模型给某个知识库文件生成摘要。**这是一条出网调用**（发的是那份文件的前若干字正文）。
 *
 * 后端会按顺序过三道闸：「禁止 AI 出网」→ 该文件的「参与语义检索（会出网）」→ 敏感字段
 * 打码 + 审计。任何一道拦下都返回 `{ ok: false, error }`，不会静默降级。
 *
 * 成功后**必须清本库的文件列表缓存**：摘要写进了 `kb_files` 行，而列表是渲染缓存的 ——
 * 不清的话生成完界面还是空的，用户会以为没成功再点一次，又发一遍正文出去。
 * @param kbId - 知识库 id（守卫）。
 * @param id - 文件行 id。
 * @returns KbSummaryResult（含 `coveredChars` / `totalChars`，界面用它标注覆盖范围）。
 */
export async function apiSummarizeKbFile(kbId: number, id: number): Promise<KbSummaryResult> {
  const result: KbSummaryResult = unwrap(await remote().summarizeKbFile({ kbId, id }))
  if (result.ok) invalidateKbFileCaches(kbId)
  return result
}

/**
 * 在当前知识库里做关键词（FTS5 稀疏通道）检索。
 *
 * 设计稿 §8.4「不给模式开关」：用户只输入一个词，走哪条通道由系统决定、
 * 结果区标题说明实际走了什么。所以这里**没有** `mode` 参数 ——
 * 加一个「只用关键词」的开关，就等于把一个本不该由用户决定的实现细节变成他的配置。
 *
 * **不走快照缓存**（同 `apiGetKbFiles`）：检索是本地 sqlite 的直读，代价可忽略；
 * 挂 TTL 只会让用户输入新词之后仍看到上一次的结果。
 * @param kbId - 知识库 id（必填位置参数，漏传就会串库）。
 * @param query - 用户输入（可为多词，空格分隔）。
 * @param topK - 最多返回多少条；不给按后端默认。
 * @returns 命中（按相关度）+ 统计 + 降级说明；`error` / `readError` 是两种不同的没搜成。
 */
export async function apiSearchKb(kbId: number, query: string, topK?: number): Promise<KbSearchResult> {
  return unwrap(await remote().searchKb({ kbId, query, ...(topK === undefined ? {} : { topK }) }))
}

/**
 * 本库的向量索引状态（多少块、哪个模型算的、与当前绑定是否一致、有没有在飞构建）。
 *
 * **不挂缓存**：这是要被轮询的瞬时态（建索引期间进度在动），缓存它等于让按钮卡在旧进度上。
 * @param kbId - 知识库 id。
 * @returns 状态视图。
 */
export async function apiGetKbVectorIndex(kbId: number): Promise<KbVectorIndexView> {
  return unwrap(await remote().getKbVectorIndex({ kbId }))
}

/**
 * 为**本库**构建 / 增量更新向量索引（会出网：把文件正文送去 embedding）。
 *
 * **不清任何缓存**：建索引只写 `wechat_kb_vectors.db`，`kb_files` 一行都没变 ——
 * 清文件列表缓存等于白取一次数。界面要刷新的是索引状态，那是轮询 `apiGetKbVectorIndex` 拿的。
 * @param kbId - 知识库 id。
 * @param force - 清空本库重算。
 * @returns 构建结果（`ok` 为假时带 `error`）。
 */
export async function apiBuildKbVectorIndex(kbId: number, force = false): Promise<KbVectorBuildResult> {
  return unwrap(await remote().buildKbVectorIndex({ kbId, force }))
}

/**
 * 读本库的模型设置（三个角色的引用与实际生效值）。
 *
 * 按 `kbCacheKey('kb-model', kbId)` 缓存：打开弹层时读一次就够，
 * 而键**必须带库 id** —— 不带就会出现「甲库的覆盖显示在乙库头上」那种串味。
 * @param kbId - 知识库 id。
 * @returns 设置视图。
 */
export async function apiGetKbModelConfig(kbId: number): Promise<KbModelConfigView> {
  return cachedFetch(kbCacheKey('kb-model', kbId), async () => unwrap(await remote().getKbModelConfig({ kbId })))
}

/**
 * 写本库的模型覆盖（空串 = 取消覆盖、回到继承）。
 *
 * 两层都要失效，理由各不相同：
 *   · `kb-model:<id>` —— 刚写的引用串，弹层下次打开要看到新值；
 *   · 库列表那一族 —— `modelOverrides`（芯片上的「N 项自定义」）是 `getKbs` 合流出来的
 *     **派生值**，它确实变了，所以走完整的 `invalidateKbCaches()`（清快照 + 清渲染缓存 + 广播）。
 *     这里不省那一次广播：省了芯片就会一直停在旧数字上，而芯片正是这个操作的结果显示。
 * @param kbId - 知识库 id。
 * @param patch - 要改的引用串（未传的字段保持原值）。
 * @returns 后端结果（引用串不合法时 `ok:false` + 原因）。
 */
export async function apiSetKbModelConfig(kbId: number, patch: { chatRef?: string; embedRef?: string; rerankRef?: string }): Promise<KbModelConfigResult> {
  const result: KbModelConfigResult = unwrap(await remote().setKbModelConfig({ kbId, ...patch }))
  invalidateWechatCache(kbCacheKey('kb-model', kbId))
  if (result.ok) invalidateKbCaches()
  return result
}

/**
 * 对本库的文件跑一次「模型抽实体」（推断层）。
 *
 * 失效三层，缺一层的现场都不同：
 *   · `kb-model:<id>` —— 弹层里那一行「已存 N 条 / 还有 M 个没抽」就是这次操作的结果；
 *   · 快照 + `kb-` 渲染缓存 + `NOTES_UPDATED_EVENT` —— 实体是知识图谱的**节点来源**，
 *     抽完不广播的话，正在看图的人要切一次库才看得见新点（而他会以为「抽了个寂寞」）。
 * @param kbId - 知识库 id。
 * @param opts - 只抽指定文件（`fileIds`）与单轮上限（`limit`）。
 * @returns 后端结果（含逐文件的失败原因；被隐私闸拦下时 `ok:false` + 原因）。
 */
export async function apiExtractKbEntities(kbId: number, opts: { fileIds?: number[]; limit?: number } = {}): Promise<KbExtractResult> {
  const result: KbExtractResult = unwrap(await remote().extractKbEntities({ kbId, ...opts }))
  invalidateWechatCache(kbCacheKey('kb-model', kbId))
  if (result.saved > 0) invalidateKnowledgeCaches()
  return result
}

/**
 * 要一批「模型建议的链接」（笔记编辑器正文下方的芯片）。
 *
 * **刻意不缓存**：建议的对象是用户**正在敲**的那段正文，缓存层会把上一次的主题
 * 留在屏幕上，看起来像「建议不更新」；而它本身是一次 embedding 请求，不该被复用。
 * @param kbId - 知识库 id。
 * @param text - 当前正文（后端会截断）。
 * @param opts - `topK` 与要排除的标题（正在编辑的那篇）。
 * @returns 候选与说明。
 */
export async function apiSuggestKbLinks(kbId: number, text: string, opts: { topK?: number; excludeTitle?: string } = {}): Promise<KbLinkSuggestResult> {
  return unwrap(await remote().suggestKbLinks({ kbId, text, ...opts }))
}

/**
 * 弹出文件选择对话框（可多选）。**只取路径**：读盘与登记由后端做 ——
 * 选中的可能是几十 MB 的文件，不适合经 IPC 传字节（与 `apiSaveFileDialog` 同口径）。
 *
 * `filters` 由调用方传（知识库传后端白名单），不在主进程写死一份：
 * 写死就会与后端 `ACCEPTED_EXTS` 漂移成两份，症状是「对话框里看不到」或者更糟 ——
 * 「选得进来但登记被拒」。
 * @param opts - 对话框标题与扩展名过滤器。
 * @returns `{ canceled, files }`；环境不支持时给 `error` 而不是抛异常。
 */
export async function apiOpenFileDialog(opts?: {
  title?: string
  filters?: Array<{ name: string; extensions: string[] }>
}): Promise<{ canceled: boolean; files: string[]; error?: string }> {
  const api = (window as unknown as {
    electronAPI?: { openFile?: (o?: unknown) => Promise<{ canceled: boolean; files: string[]; error?: string }> }
  }).electronAPI
  if (!api?.openFile) return { canceled: true, files: [], error: '当前环境不支持文件选择' }
  return api.openFile(opts)
}

/**
 * 文件变了：清本库的文件缓存（`kb-files:<id>`），**并且**让库列表失效。
 *
 * 为什么必须连库列表一起清：`KbMeta.fileCount` 不是文件库自己的字段，而是 `getKbs`
 * 把两个库文件合流出来的**派生值**，它住在另外两套缓存里（`KB_LIST_CACHE_KEY` 快照层
 * 与 `kbs-` 渲染层）。只清 `kb-files:<id>` ⇒ 加完文件之后，切换器 / 管理弹层 /
 * **删库弹层**仍拿着旧的 `fileCount`。真机探针实测过一次：库里有 2 个文件，删库弹层
 * 却说「这个库里没有笔记也没有文件」，并且因为 `canMoveInstead` 判假而**不给「移到…」
 * 分支** —— 一个装了几百份资料、笔记一条没写的库，唯一出口只剩「一并删除」。
 *
 * 为什么光清缓存还不够、还要广播：清缓存只保证「下一次取数拿到新值」，不会叫醒
 * **已经挂载**的切换器（它手里是上一次的数组）。所以走 `invalidateKbCaches()` 这一个
 * 入口 —— 它一次做全三件事（清快照 + 清渲染缓存 + 广播）。
 * 广播的是 `KBS_UPDATED_EVENT`（库列表），**不是** `NOTES_UPDATED_EVENT`：笔记库 /
 * 知识图谱 / 问答并不读 `kb_files`，叫醒它们只会白重取一次。
 *
 * 键名由 `kbCacheKey` 拼，别处不许手写 `kb-files:` + id：带库 id 的键字面量散开
 * 就会出现「模型里有、图上看不到」那类只在切库后才现形的偏差。
 * （`invalidateWechatCache` 是**前缀**匹配，所以 `kb-files:3` 会顺带清掉
 *  `kb-files:30` 的渲染缓存 —— 只会多清一层缓存，不会少清，故可接受。）
 * @param kbId - 知识库 id。
 */
export function invalidateKbFileCaches(kbId: number): void {
  invalidateWechatCache(kbCacheKey('kb-files', kbId))
  // 同上：`KbMeta.fileCount` 是 getKbs 合流的派生值，与文件列表分属两套缓存。
  invalidateKbCaches()
}

/**
 * Drop every cache layer that can hold knowledge data, then broadcast the change.
 *
 * 笔记的写入**不会**触发 'dsh-wechat-data-updated'（那不是解密数据变更），所以这里
 * 必须自己失效：内存快照层（cachedGet 用的 _snapshotCache）与 localStorage 渲染层
 * （readRenderCache 的 'kb-' 前缀）是两套互不相通的缓存，只清一层会出现
 * 「图谱刷新了但列表还是旧的」这类半刷新状态。
 *
 * 但**清缓存 ≠ 刷新页面**：它只保证「下一次取数拿到新数据」，不会叫醒已经挂载的面板。
 * 所以末尾必须再广播一次（`NOTES_UPDATED_EVENT`），否则正在看知识图谱的人改完笔记
 * 仍停在旧图上 —— 这是「内容更新时图谱节点要同步刷新」里最容易漏掉的一半。
 * saveNote / deleteNote 是仅有的两个调用点，因此广播收在这一个入口。
 */
export function invalidateKnowledgeCaches(): void {
  dropKnowledgeCaches()
  notifyNotesUpdated()
}

/** 清掉一切可能装着知识数据的缓存层，但**不广播**（广播与否是两条不同路径，见调用点）。 */
export function dropKnowledgeCaches(): void {
  invalidateSnapshotCache()
  invalidateWechatCache('kb-')
}

/**
 * 库表变了（新建 / 改名 / 删除）：只让库列表那一条失效。
 *
 * 为什么不顺手 `invalidateSnapshotCache()`：建一个库、改一个名字，与聊天、朋友圈、
 * 待办等面板的快照毫无关系，清全部会让它们下次切页时全体重新取数。
 * 真正的**内容**变化由 `dropKnowledgeCaches()` 负责，两者在 `apiDeleteKb` 里同时出现 ——
 * 因为删库既动了库表又动了笔记（迁移或删除）。
 *
 * `invalidateWechatCache('kbs-')` 清的是渲染缓存层（`useKbScope` 用它做冷启动首帧），
 * 与上面那行提到的快照层是互不相通的两套 —— 只清一层会留下「切换器显示旧名字」。
 */
export function invalidateKbCaches(): void {
  snapshotDelete(KB_LIST_CACHE_KEY)
  invalidateWechatCache('kbs-')
  notifyKbsUpdated()
}
