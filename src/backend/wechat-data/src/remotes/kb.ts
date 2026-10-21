
/**
 * 知识库域的 @Remote 处理器（M21 第 38 刀自 `gateway.ts` 搬出）。
 *
 * 为什么这么切：`gateway.ts` 是 217 个 `@Remote` 方法的巨型类，而 KB 域是**一口气自洽的一族**
 * （建库 / 文件 / 检索 / 向量索引 / 模型配置）。类里保留 Remote 装饰器与签名 —— 协议层要按名字
 * 枚举 —— 方法体改成一行转发；真正的逻辑搬到这里，依赖由 `ctx` 显式给出（原来靠 `this` 拿）。
 */
import { countKbFilesByKb, deleteKbFile as deleteKbFileRow, getKbFile, kbFilesOnKbDelete, listKbFileChunks, listKbFiles, registerKbFile, setKbFileRagFlag, setKbFileSummary } from '../query/kb-files.ts'
import { drainKbQueue } from '../query/kb-queue.ts'
import { searchKb as searchKbRows } from '../query/kb-search.ts'
import { kbBuildIndexIn } from './kb.kbindex.ts'
import { buildKbVectorIndex, kbVectorIndexStatus, searchKbDense } from '../query/kb-vectors.ts'
import { extractFileEntities, kbEntitySummary, readDocEntities } from '../query/kb/extract.ts'
import { KbModelRole, ResolvedModel, kbModelOverrideCounts, kbModelsOnKbDelete, readKbModelSettings, touchKbEntitiesAt, writeKbModelSettings } from '../query/kb/model-config.ts'
import { SUGGEST_POOL_MAX, rankLinkCandidates } from '../query/kb/suggest.ts'
import { createKb as createKbRow, deleteKb as deleteKbRow, listKbs, listNotes, renameKb as renameKbRow } from '../query/notes.ts'
import { loadRetrievalConfig } from '../query/retrieval/config.ts'
import { EmbedFn } from '../query/retrieval/embedding.ts'
import { FusedKbHit, fuseKbHits } from '../query/retrieval/kb-channel.ts'
import { KbDeleteAction, KbFileAddResult, KbFileChunkPage, KbFileListSnapshot, KbFileMutationResult, KbFileRegisterResult, KbListSnapshot, KbMutationResult, KbSearchResult, KbSummaryResult, OperationCategory, OperationStatus } from '../types.ts'
import { KbExtractResult, KbLinkSuggestResult, KbModelConfigResult, KbModelConfigView, KbVectorBuildWireResult, KbVectorIndexView } from '../types-kb-wire.ts'
import { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, GenerateOptions, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PrivacyGateFn } from '../gateway-privacy.ts'

/** 处理器需要的宿主能力（由 `WechatDataGateway` 组装；getter 形式保证读到最新目录）。 */
export interface KbRemoteCtx {
  dirs: () => { decrypted: string }
  ctx: Context
  kbIndexJobs: Map<number, { done: number; total: number; startedAt: number; error: string }>
  /** W3-11.5：本库向量构建的取消槽（与消息域的构建各占一格，互相不会打断）。 */
  kbIndexSignal: (jobId?: string) => { signal: AbortSignal; done: () => void } | undefined
  /** W3-11.5：取消本库向量构建（与上面成对）。 */
  cancelKbIndexJob: (jobId?: string) => boolean
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  privacyGate: PrivacyGateFn
  makeEmbedFn: (model: string, feature?: 'ask_embed' | 'kb_embed' | 'kb_link_suggest') => EmbedFn | undefined
  globalModelName: (role: KbModelRole) => string
  kbModel: (kbId: number, role: KbModelRole) => ResolvedModel
  makeChatAsker: (kbId: number, feature: string) => ((prompt: string) => Promise<string>) | undefined
}

/** 摘要输入的字符上限（随 KB 处理器一起搬来：只有这一域在用）。 */
/**
 * 文件摘要一次喂给模型的字符上限。
 *
 * 为什么是 8000：一份文件最多两万块、约一千万字（`kb/chunk.ts` 的
 * `CHUNK_MAX_CHARS × MAX_CHUNKS_PER_FILE`），全量根本进不了 prompt。8000 字与
 * 问答侧的上下文预算（`compress.maxChars` 6000）同一量级，够概括一份中等文档，
 * 又不至于让一次摘要吃掉整条上下文。截断是**必须被说出来**的 ——
 * 覆盖了多少字要落库并回给界面（见 `summarizeKbFile`）。
 */
/**
 * W3-6.6：实体抽取的并发上限。
 *
 * 与 `gateway-scheduler.ts` 的 `DUE_SUMMARY_CONCURRENCY` 同一份模式
 * （共享 next 下标原子认领 + 单任务失败不连坐）。
 * 上限小心地写小：每个工作者都是一次 LLM 请求，放开上限会
 * 把厂商的速率限制撞穻（而且反而更慢）。
 */
export const KB_EXTRACT_CONCURRENCY = 3

/**
 * W3-6.6：有界并发地跑一批文件抽取（从 createKbRemotes 里搪出）。
 *
 * 搪家原因与 `askRetrievalCompat` 同族：工厂受函数体椚轮管着（只许变小）。
 *
 * 两条口径：
 *  · **共享 next 下标原子认领**（模式与 `gateway-scheduler.ts` 的
 *    `DUE_SUMMARY_CONCURRENCY` 完全一致），而不是把批次切成固定分片———
 *    切片的话，最后一片只剩一个工作者在跑，其余全空闲。
 *  · **不做任何中断**：单个失败由调用方的 `one()` 接着（那里有
 *    try/catch，补的正是 `extractFileEntities` 开库抛异常的那个漏洞）。
 */
/**
 * W3-6.6：**一个文件**的实体抽取（从 createKbRemotes 里搪出）。
 *
 * 为什么要自己包 try：`extractFileEntities` 里那个
 * `new DatabaseSync(kbFilesDbPath(...))` 在 try **之外**。库被占用/损坏时它直接抛，
 * 而这一抛会跟着循环一起退出（真连块）：剩下的文件一个都不跑，
 * 而 RPC 直接 reject，调用方**连失败汇总都拿不到**。
 * 接住它：一个文件出问题就记一条 failed，其余继续。
 */
async function kbExtractOne(
  o: {
    dir: string
    kbId: number
    ask: (prompt: string) => Promise<string>
    model: string
  },
  id: number,
  sink: {
    onSaved: (n: number) => void
    onFailed: (error: string) => void
  },
): Promise<void> {
  try {
    const r = await extractFileEntities(o.dir, o.kbId, id, o.ask, o.model)
    if (r.ok) sink.onSaved(r.saved ?? 0)
    else sink.onFailed(r.error ?? '未知原囩')
  } catch (e) {
    sink.onFailed((e as Error).message ?? '抽取失败')
  }
}

async function runKbExtractBatch(o: {
  batch: ReadonlyArray<{ id: number }>,
  extract: (id: number) => Promise<void>,
  concurrency: number,
}): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next
      next += 1
      if (i >= o.batch.length) return
      const f = o.batch[i]
      if (f === undefined) continue
      await o.extract(f.id)
    }
  }
  const n = Math.max(1, Math.min(o.concurrency, o.batch.length))
  await Promise.all(Array.from({ length: n }, () => worker()))
}

const SUMMARY_INPUT_CHARS = 8000

/**
 * 两路都跑成时的结果：融合后的列表 + **两路各自**的命中数（W2-7.4）。
 *
 * 口径要说准：`channels[].count` 是**融合前**各路自己的命中数，不是融合后的条数 ——
 * 融合按 RRF 去重（同一块两路都命中只留一条），所以两路之和 ≥ 总条数；
 * 拿总数冒充任一路，用户会以为另一路白跑了。
 *
 * 稠密跑完但一条都没命中时 `denseCount` 是 0，**照样记 `active: true`** ——
 * 「跑了、没命中」与「压根没跑」是两件事，界面上也该分开说。
 *
 * 模块级：它是纯拼装（不碰 IO、不读配置），放进 `createKbRemotes` 只会让那个
 * 已经四百多行的函数更长。
 * @param res - 稀疏那一路的结果（字段是它的基底）。
 * @param denseCount - 稠密那一路的命中条数。
 * @param fused - RRF 融合后的有序命中。
 * @returns 交回界面的结果（不带任何降级说明）。
 */
function fusedKbResult(res: KbSearchResult, denseCount: number, fused: readonly FusedKbHit[]): KbSearchResult {
  return {
    ...res,
    hits: fused.map(f => f.hit),
    stats: {
      ...res.stats,
      channels: [...res.stats.channels, { channel: 'dense', count: denseCount, active: true }],
    },
    degraded: undefined,
  }
}

/**
 * 生成一份文件的摘要（从 `createKbRemotes` 里搪出：工厂受函数体行数棘轮管着）。
 *
 * ## 三道前置闸门，顺序不能换
 *
 * ① 文件存在 → ② `includeInRag`（关掉就等于「内容不得离开本机」）→ ③ 有可用正文块。
 * ②在③前面：一个关掉出网的文件，说「还没有正文块」是误导 —— 用户会去等解析，
 * 而真正的原因是那个开关。
 *
 * ## 为什么 `maxTokens` 是 1024（2026-10-17 实测）
 *
 * 改前是 400，**必然返回空**：推理型模型先吐一大段 reasoning 再吐正文，
 * 400 token 常常在 reasoning 阶段就耗尽 —— 流正常结束、`text` 是空串。
 * 同目录 `summary.ts` 用 1024、`annual-narr.ts` 用 600 都能跑通。
 * 空结果时把 reasoning 的长度说出来，用户才知道该调预算还是换模型。
 * @param rc - 处理器依赖。
 * @param kbId - 知识库 id。
 * @param id - 文件 id。
 * @returns 摘要结果（含覆盖字数与模型名）。
 */
async function summarizeKbFileIn(rc: KbRemoteCtx, kbId: number, id: number): Promise<KbSummaryResult> {
  const ctx = rc.ctx
  const dir = rc.dirs().decrypted

  const file = getKbFile(dir, kbId, id)
  if (file === null) return { ok: false, error: '文件不存在，或不属于当前知识库' }
  if (!file.includeInRag) {
    // 明确说「因为你关掉了那个开关」，否则用户只会看到一次失败的生成。
    const reason = '该文件已关闭「参与语义检索（会出网）」，按此设置它的内容不得离开本机，因此不能生成摘要。'
    rc.op('task', 'kb_file_summary', 'skip', `id=${id}`, reason)
    return { ok: false, error: reason }
  }
  if (file.parseState !== 'ready' || file.chunkCount === 0) {
    return { ok: false, error: '这个文件还没有可用的正文块（解析未成功或还在排队），无法摘要。' }
  }

  const sel = (ctx as unknown as {
    agentDefaultModel?: { currentSelection(): { provider: string; model: string; reasoningEffort?: string } }
  }).agentDefaultModel?.currentSelection()
  if (!sel || !sel.provider || !sel.model) {
    rc.op('task', 'kb_file_summary', 'fail', `id=${id}`, '未配置默认模型（agentDefaultModel）')
    return { ok: false, error: '未配置默认模型（agentDefaultModel），无法生成摘要' }
  }
  /**
   * 本库的语言模型覆盖（只换**模型名**，端点与凭据仍用当前生效的那一套）。
   * 空 ⇒ 用全局那条。落库的 `summary_model` 记的就是这个最终值 ——
   * 换模型之后用户要能看出这条摘要不是当前模型给的。
   */
  const chatModel = rc.kbModel(kbId, 'chat').model || sel.model

  // 按字符预算取前若干块：块本身就是文档原有顺序，截的是「开头」而不是随机片段。
  const parts: string[] = []
  let covered = 0
  let offset = 0
  for (let page = 0; page < 20 && covered < SUMMARY_INPUT_CHARS; page += 1) {
    const chunk = listKbFileChunks(dir, kbId, id, { limit: 200, offset })
    if (chunk.readError !== undefined) return { ok: false, error: '正文读取失败：' + chunk.readError }
    if (chunk.items.length === 0) break
    for (const c of chunk.items) {
      if (covered >= SUMMARY_INPUT_CHARS) break
      const take = c.text.slice(0, SUMMARY_INPUT_CHARS - covered)
      parts.push((c.heading !== '' ? `【${c.heading}】\n` : '') + take)
      covered += take.length
    }
    offset += chunk.items.length
    if (offset >= chunk.total) break
  }
  if (covered === 0) return { ok: false, error: '这个文件没有可摘要的正文。' }

  const body = parts.join('\n\n')
  // 截断与否要写进 prompt：模型若不知道正文被切过，会理直气壮地概括出一个「全文要点」。
  const scope = covered < file.charCount ? `前 ${covered} 字（全文 ${file.charCount} 字，已截断）` : `全文 ${file.charCount} 字`
  const prompt = `文件名：${file.name}\n\n正文（${scope}）：\n${body}`
  const [summaryGated] = rc.privacyGate('kb_file_summary', { sessions: 0, messages: 0 }, [prompt])

  const assembler = new BlockAssembler()
  const opts: GenerateOptions = {
    provider: sel.provider,
    model: chatModel,
    messages: [createUserMessage({
      content: [{ type: 'text', text: summaryGated ?? prompt }],
      source: { kind: 'plugin', plugin: 'dsh-wechat-data' },
    })],
    system: '你是文档摘要器。用中文把给定正文概括成不超过 5 条要点，每条一行、以「· 」开头，'
      + '只写正文里确有的事实，不要推测、不要评价。若正文被截断，最后一行注明「以上仅覆盖给出的部分」。',
    maxTokens: 1024,
  }
  let text = ''
  let reasoning = ''
  try {
    for await (const c of ctx.llm.stream(opts)) assembler.push(c)
    const blocks = assembler.blocks()
    text = blocks.map(b => (b.type === 'text' ? b.text : '')).join('').trim()
    reasoning = blocks.map(b => (b.type === 'reasoning' ? b.text : '')).join('').trim()
  } catch (e) {
    rc.op('task', 'kb_file_summary', 'fail', `id=${id}`, (e as Error).message)
    return { ok: false, error: '模型调用失败：' + (e as Error).message }
  }
  if (text === '') {
    // 区分「模型什么都没说」和「模型只在思考、预算被吃光」—— 后者是配置问题，
    // 让用户去调大预算或换个非推理模型，而不是反复点「生成摘要」。
    const why = reasoning !== ''
      ? `模型只输出了思考过程（${reasoning.length} 字）、没有给出正文，多半是 token 预算被思考吃光了。`
      : '模型没有返回内容，未写入摘要。'
    rc.op('task', 'kb_file_summary', 'fail', `id=${id}`, why)
    return { ok: false, error: why }
  }

  // 落库的是**实际发出去的那个模型名**（含库级覆盖），不是全局那条 ——
  // 否则换了库级模型之后，界面上的「由 X 生成」会指着一条其实没参与过的模型。
  const model = `${sel.provider}/${chatModel}`
  const saved = setKbFileSummary(dir, kbId, id, text, model, covered)
  if (!saved.ok) return { ok: false, error: '摘要已生成但保存失败：' + (saved.error ?? '未知原因') }
  rc.op('task', 'kb_file_summary', 'ok', `id=${id}`, `${model} · 覆盖 ${covered}/${file.charCount} 字`)
  return { ok: true, summary: text, model, at: Date.now(), coveredChars: covered, totalChars: file.charCount }
}

export function createKbRemotes(rc: KbRemoteCtx) {
  return {
    getKbs(): KbListSnapshot {
      const snap = listKbs(rc.dirs().decrypted)
      if (snap.items.length === 0) return snap
      const files = countKbFilesByKb(rc.dirs().decrypted)
      // 第三个合流源：这个库有没有自定义模型（rail 的「模型」芯片要说「继承全局」还是「N 项自定义」）。
      // 只带计数不带引用串 —— 引用串由 `getKbModelConfig` 按需读，列表里塞三个字符串没人用。
      const models = kbModelOverrideCounts(rc.dirs().decrypted)
      return {
        ...snap,
        items: snap.items.map(k => ({ ...k, fileCount: files.get(k.id) ?? 0, modelOverrides: models.get(k.id) ?? 0 })),
      }
    },

    createKb(options: { name: string }): KbMutationResult {
      const r = createKbRow(rc.dirs().decrypted, options?.name ?? '')
      rc.op('edit', 'create_kb', r.ok ? 'ok' : 'fail', options?.name ?? '', r.error ?? `id=${r.id ?? ''}`)
      return r
    },

    renameKb(options: { id: number; name: string }): KbMutationResult {
      const r = renameKbRow(rc.dirs().decrypted, options?.id, options?.name ?? '')
      rc.op('edit', 'rename_kb', r.ok ? 'ok' : 'fail', `id=${options?.id ?? ''}`, r.error ?? (options?.name ?? ''))
      return r
    },

    deleteKb(options: { id: number; action: KbDeleteAction }): KbMutationResult {
      const r = deleteKbRow(rc.dirs().decrypted, options?.id, options?.action)
      // 文件侧必须在**库行删成功之后**才动：`deleteKbRow` 还会做一串前置校验
      // （默认库不可删 / 目标库必须存在 / 目标库同名笔记会让它整体拒绝）。
      // 反过来先迁文件的话，一次**被拒绝**的删库已经把用户的文件搬走了，而库还在。
      //
      // 两个库文件之间没有跨库事务，所以这一步是 best-effort：失败只留痕，并把
      // `movedFiles` / `removedFiles` 留成 undefined（≠ 0）让界面能分开说两句话。
      let files: { movedFiles: number; removedFiles: number } | undefined
      if (r.ok) {
        const target = options?.action?.kind === 'reassign' ? options.action.targetKbId : undefined
        const report = kbFilesOnKbDelete(rc.dirs().decrypted, options?.id, target)
        if (report.ok) files = { movedFiles: report.movedFiles, removedFiles: report.removedFiles }
        else console.warn('[kb-files] 删库时清点文件失败（库已删除）：' + (report.error ?? '未知原因'))
        // 模型设置跟着删：库已经不在了，留一行「kb_id=3 用 m:xxx」既没人读，
        // 又会在将来出现同一个 id 的新库**继承上一个库的模型覆盖**（SQLite 的
        // INTEGER PRIMARY KEY 会复用已释放的 rowid，这不是假设）。
        // 搬到别的库的那种情况也一样删：目标是它自己的设置，不该把源库的覆盖带过去。
        if (kbModelsOnKbDelete(rc.dirs().decrypted, options?.id)) {
          rc.op('delete', 'kb_model_settings', 'ok', `kb=${options?.id ?? ''}`, '随库删除')
        }
      }
      const merged: KbMutationResult = files === undefined ? r : { ...r, ...files }
      const fileNote = files === undefined ? 'files=未清点' : `files=${files.movedFiles}moved/${files.removedFiles}removed`
      rc.op(
        'delete',
        'delete_kb',
        r.ok ? 'ok' : 'fail',
        `id=${options?.id ?? ''}`,
        r.error ?? `moved=${r.movedNotes ?? 0} removed=${r.removedNotes ?? 0} ${fileNote}`,
      )
      return merged
    },

    getKbFiles(kbId: number, options?: { limit?: number; offset?: number }): KbFileListSnapshot {
      return listKbFiles(rc.dirs().decrypted, kbId, options)
    },

    getKbFileChunks(kbId: number, fileId: number, options?: { limit?: number; offset?: number }): KbFileChunkPage {
      return listKbFileChunks(rc.dirs().decrypted, kbId, fileId, options)
    },

    addKbFiles(options: { kbId: number; paths: string[]; includeInRag?: boolean }): KbFileAddResult {
      const raw = Array.isArray(options?.paths) ? options.paths : []
      const paths = raw.filter((p) => typeof p === 'string' && p.trim() !== '')
      if (paths.length === 0) return { ok: false, added: 0, failed: 0, results: [], error: '没有选择文件' }
      const results: KbFileRegisterResult[] = []
      for (const srcPath of paths) {
        results.push(registerKbFile(rc.dirs().decrypted, {
          kbId: Number(options?.kbId),
          srcPath,
          includeInRag: options?.includeInRag,
        }))
      }
      const added = results.filter((x) => x.ok).length
      rc.op('edit', 'add_kb_files', added > 0 ? 'ok' : 'fail', 'count=' + paths.length, 'added=' + added)
      /**
       * B 档（pdf / docx / xlsx / xls）的文件在这里才排进队列。
       *
       * `registerKbFile` 只落一行 `queued`、**不**触发执行 —— 存储层不反向依赖队列，
       * 「谁在什么时候启动后台活」全部收在本文件里，一眼看得全。
       *
       * `void` 不等待：回执要立刻给出去（H4）。判据是「结果里真的出现了 `queued` 行」
       * 而不是「added > 0」—— 纯文本上传不该白开一次库去发现队列是空的。
       */
      if (results.some((x) => x.ok && x.file?.parseState === 'queued')) {
        void drainKbQueue(rc.dirs().decrypted).catch((e: unknown) => {
          console.warn('[kb-queue] 解析队列启动异常：' + (e instanceof Error ? e.message : String(e)))
        })
      }
      return { ok: added > 0, added, failed: results.length - added, results }
    },

    deleteKbFile(options: { kbId: number; id: number }): KbFileMutationResult {
      const r = deleteKbFileRow(rc.dirs().decrypted, options?.kbId, options?.id)
      rc.op('delete', 'delete_kb_file', r.ok ? 'ok' : 'fail', `id=${options?.id ?? ''}`, r.error ?? `chunks=${r.removedChunks ?? 0}`)
      return r
    },

    setKbFileRag(options: { kbId: number; id: number; includeInRag: boolean }): KbFileMutationResult {
      return setKbFileRagFlag(rc.dirs().decrypted, options?.kbId, options?.id, options?.includeInRag !== false)
    },

    async summarizeKbFile(options: { kbId: number; id: number }): Promise<KbSummaryResult> {
      return summarizeKbFileIn(rc, Number(options?.kbId), Number(options?.id))
    },

    async searchKb(options: { kbId: number; query?: string; topK?: number }): Promise<KbSearchResult> {
      const dir = rc.dirs().decrypted
      const res = searchKbRows(dir, options?.kbId, { query: options?.query, topK: options?.topK })
      const q = (options?.query ?? '').trim()
      // 稀疏这一路自己就没跑成（无效请求 / 库打不开）或压根没查询词 ⇒ 不叠加稠密，原样返回。
      // ⚠ **不能**因为「稀疏 0 命中」就提前返回：那正是稠密唯一有价值的场景
      //（逐字搜不到、换个说法能搜到），提前返回等于把这条通道的意义删掉。
      if (res.error !== undefined || res.readError !== undefined || q === '') {
        return res
      }
      const cfg = loadRetrievalConfig(dir)
      const embedModel = rc.kbModel(Number(options?.kbId), 'embed').model
      if (!cfg.embedding.enabled || embedModel === '') {
        return { ...res, degraded: { reason: 'no-embed-model', label: '仅关键词（未配置向量模型）' } }
      }
      const kbId = Number(options?.kbId)
      const st = kbVectorIndexStatus(dir, kbId, embedModel)
      if (!st.ready) {
        // 未就绪的四种原因分开说：`no-index` 是「还没建」，`model-mismatch` 是「建过但换了模型」，
        // 前者点一下按钮就能建，后者必须先让用户知道要重算一遍（会再次出网）。
        const label = st.staleReason === 'no-index'
          ? '仅关键词（本库还没有向量索引）'
          : st.staleReason === 'model-mismatch'
            ? '仅关键词（本库索引由别的模型生成，需重建才能语义检索）'
            : '仅关键词（向量索引不可用）'
        return { ...res, degraded: { reason: st.staleReason === 'model-mismatch' ? 'index-stale' : 'no-vector-index', label } }
      }
      const embed = rc.makeEmbedFn(embedModel, 'kb_embed')
      if (!embed) return { ...res, degraded: { reason: 'no-embed-model', label: '仅关键词（未配置向量模型）' } }
      try {
        const dense = await searchKbDense(dir, kbId, q, embed, {
          topK: Math.max(res.hits.length, 1),
          minSimilarity: cfg.channels.dense.minSimilarity,
          candidatePool: cfg.channels.dense.candidatePool,
          model: embedModel,
        })
        if (dense.note !== undefined) {
          return { ...res, degraded: { reason: 'embed-failed', label: '仅关键词（语义检索这次没跑成：' + dense.note + '）' } }
        }
        const fused = fuseKbHits(res.hits, dense.hits, { k: cfg.fusion.k })
        // 两路都跑成 ⇒ 交回融合后的列表 + 两路各自的命中数（W2-7.4）。
        return fusedKbResult(res, dense.hits.length, fused)
      } catch (e) {
        return { ...res, degraded: { reason: 'embed-failed', label: '仅关键词（语义检索失败：' + (e as Error).message + '）' } }
      }
    },

    getKbModelConfig(options: { kbId: number }): KbModelConfigView {
      const kbId = Number(options?.kbId)
      return {
        kbId,
        settings: readKbModelSettings(rc.dirs().decrypted, kbId),
        global: {
          chat: rc.globalModelName('chat'),
          embed: rc.globalModelName('embed'),
          rerank: rc.globalModelName('rerank'),
        },
        resolved: {
          chat: rc.kbModel(kbId, 'chat'),
          embed: rc.kbModel(kbId, 'embed'),
          rerank: rc.kbModel(kbId, 'rerank'),
        },
        entities: kbEntitySummary(rc.dirs().decrypted, kbId),
      }
    },

    setKbModelConfig(options: { kbId: number; chatRef?: string; embedRef?: string; rerankRef?: string }): KbModelConfigResult {
      const kbId = Number(options?.kbId)
      const r = writeKbModelSettings(rc.dirs().decrypted, kbId, {
        ...(options?.chatRef === undefined ? {} : { chatRef: options.chatRef }),
        ...(options?.embedRef === undefined ? {} : { embedRef: options.embedRef }),
        ...(options?.rerankRef === undefined ? {} : { rerankRef: options.rerankRef }),
      })
      rc.op('edit', 'set_kb_model', r.ok ? 'ok' : 'fail', `kb=${kbId}`, r.ok ? '' : r.error)
      return r
    },

    getKbVectorIndex(options: { kbId: number }): KbVectorIndexView {
      const dir = rc.dirs().decrypted
      const cfg = loadRetrievalConfig(dir)
      const kbId = Number(options?.kbId)
      const resolved = rc.kbModel(kbId, 'embed')
      const model = resolved.model
      return {
        kbId,
        model,
        // 来源回给界面：芯片要能说清「这个库跟着全局走」还是「本库指定了模型」，
        // 只回一个模型名，用户看不出它从哪来。
        source: resolved.source,
        configured: cfg.embedding.enabled && model !== '' && Boolean(rc.makeEmbedFn(model, 'kb_embed')),
        status: kbVectorIndexStatus(dir, kbId, model),
        job: rc.kbIndexJobs.get(kbId) ?? null,
      }
    },

    async buildKbVectorIndex(options: { kbId: number; force?: boolean; jobId?: string }): Promise<KbVectorBuildWireResult> {
      return kbBuildIndexIn(rc, options)
    },

    /**
     * 停止本库正在跑的向量构建（W3-11.5）。
     *
     * 取消在〔认领下一批〕之前生效；两阶段构建的阶段二在全部批次之后，所以取消 ⇒
     * 一行都没写 ⇒ 旧索引原样。停不上的原因如实返回（已算完 / 标识不认识）。
     */
    cancelKbIndexBuild(options: { jobId?: string }): { ok: boolean; message?: string } {
      const id = typeof options?.jobId === 'string' ? options.jobId.trim() : ''
      if (id === '') return { ok: false, message: '缺少任务标识' }
      return rc.cancelKbIndexJob(id)
        ? { ok: true }
        : { ok: false, message: '这次构建已经结束了（或标识不认识），无需停止' }
    },

    async extractKbEntities(options: { kbId: number; fileIds?: number[]; limit?: number }): Promise<KbExtractResult> {
      const dir = rc.dirs().decrypted
      const kbId = Number(options?.kbId)
      if (!Number.isFinite(kbId) || kbId <= 0) return { ok: false, error: '没有指定知识库', files: 0, saved: 0, failed: [], model: '' }
      const model = rc.kbModel(kbId, 'chat').model
      if (model === '') {
        const msg = '未配置默认模型（agentDefaultModel），无法抽取实体'
        rc.op('task', 'kb_extract', 'fail', `kb=${kbId}`, msg)
        return { ok: false, error: msg, files: 0, saved: 0, failed: [], model: '' }
      }
      const ask = rc.makeChatAsker(kbId, 'kb_extract')
      if (ask === undefined) return { ok: false, error: '模型通道不可用', files: 0, saved: 0, failed: [], model }
      const all = listKbFiles(dir, kbId, { limit: 5000 }).items.filter(f => f.includeInRag)
      const wanted = Array.isArray(options?.fileIds) && options.fileIds.length > 0
        ? all.filter(f => (options.fileIds as number[]).includes(f.id))
        : all
      const cap = Math.max(1, Math.min(Number(options?.limit) || 20, 50))
      const batch = wanted.slice(0, cap)
      const failed: Array<{ id: number; error: string }> = []
      let saved = 0
      // W3-6.6：有界并发 + 逐文件不连块（动作全在模块级，工厂受椚轮管）。
      const sink = { onSaved: (n: number) => { saved += n }, onFailed: (error: string) => { failed.push({ id: sinkId, error }) } }
      let sinkId = 0
      await runKbExtractBatch({ batch, concurrency: KB_EXTRACT_CONCURRENCY, extract: (id) => { sinkId = id; return kbExtractOne({ dir, kbId, ask, model }, id, sink) } })
      touchKbEntitiesAt(dir, kbId, Date.now())
      rc.op('task', 'kb_extract', failed.length === batch.length && batch.length > 0 ? 'fail' : 'ok',
        `kb=${kbId}`, `${batch.length} 个文件 · 写入 ${saved} 条实体 · ${model}`)
      return { ok: failed.length < batch.length, files: batch.length, saved, failed, model }
    },

    async suggestKbLinks(options: { kbId: number; text?: string; topK?: number; excludeTitle?: string }): Promise<KbLinkSuggestResult> {
      const dir = rc.dirs().decrypted
      const kbId = Number(options?.kbId)
      const text = String(options?.text ?? '')
      const bad = kbId > 0 ? null : '没有指定知识库'
      const model = rc.kbModel(kbId, 'embed').model
      if (bad !== null) return { ok: false, error: bad, candidates: [], pool: 0, model }
      if (text.trim().length < 8) return { ok: false, error: '正文太短，先写几句再要建议', candidates: [], pool: 0, model }
      if (model === '') return { ok: false, error: '未配置嵌入模型（本库或全局），无法给语义建议', candidates: [], pool: 0, model }
      const embed = rc.makeEmbedFn(model, 'kb_link_suggest')
      if (embed === undefined) return { ok: false, error: '模型通道不可用', candidates: [], pool: 0, model }
      const exclude = (options?.excludeTitle ?? '').trim().toLowerCase()
      const notes = listNotes(dir, kbId, { limit: SUGGEST_POOL_MAX }).items
        .filter(n => n.title.trim().toLowerCase() !== exclude)
        .map(n => ({ label: n.title, kind: 'note' as const }))
      const ents = readDocEntities(dir, kbId).items
        .filter(e => e.label.trim().toLowerCase() !== exclude)
        .map(e => ({ label: e.label, kind: 'entity' as const }))
      const r = await rankLinkCandidates(text, [...notes, ...ents], embed, { topK: options?.topK })
      rc.op('task', 'kb_link_suggest', r.ranked.length > 0 ? 'ok' : 'skip', `kb=${kbId}`,
        `${r.pool} 个候选 → ${r.ranked.length} 条建议 · ${model}${r.note ? ' · ' + r.note : ''}`)
      return {
        ok: true,
        candidates: r.ranked.map(c => ({ label: c.label, kind: c.kind, score: Math.round(c.score * 1000) / 1000 })),
        pool: r.pool,
        model,
        ...(r.note ? { note: r.note } : {}),
      }
    },

  }
}
