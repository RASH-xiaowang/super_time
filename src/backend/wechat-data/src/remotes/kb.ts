
/**
 * 知识库域的 @Remote 处理器（M21 第 38 刀自 `gateway.ts` 搬出）。
 *
 * 为什么这么切：`gateway.ts` 是 161 个 `@Remote` 方法的巨型类，而 KB 域是**一口气自洽的一族**
 * （建库 / 文件 / 检索 / 向量索引 / 模型配置）。类里保留 Remote 装饰器与签名 —— 协议层要按名字
 * 枚举 —— 方法体改成一行转发；真正的逻辑搬到这里，依赖由 `ctx` 显式给出（原来靠 `this` 拿）。
 */
import { countKbFilesByKb, deleteKbFile as deleteKbFileRow, getKbFile, kbFilesOnKbDelete, listKbFileChunks, listKbFiles, registerKbFile, setKbFileRagFlag, setKbFileSummary } from '../query/kb-files.ts'
import { drainKbQueue } from '../query/kb-queue.ts'
import { searchKb as searchKbRows } from '../query/kb-search.ts'
import { KbVectorBuildResult, KbVectorIndexStatus, buildKbVectorIndex, kbVectorIndexStatus, searchKbDense } from '../query/kb-vectors.ts'
import { KbEntitySummary, extractFileEntities, kbEntitySummary, readDocEntities } from '../query/kb/extract.ts'
import { KbModelRole, KbModelSettings, ResolvedModel, kbModelOverrideCounts, kbModelsOnKbDelete, readKbModelSettings, touchKbEntitiesAt, writeKbModelSettings } from '../query/kb/model-config.ts'
import { SUGGEST_POOL_MAX, rankLinkCandidates } from '../query/kb/suggest.ts'
import { createKb as createKbRow, deleteKb as deleteKbRow, listKbs, listNotes, renameKb as renameKbRow } from '../query/notes.ts'
import { loadRetrievalConfig } from '../query/retrieval/config.ts'
import { EmbedFn } from '../query/retrieval/embedding.ts'
import { fuseKbHits } from '../query/retrieval/kb-channel.ts'
import { KbDeleteAction, KbFileAddResult, KbFileChunkPage, KbFileListSnapshot, KbFileMutationResult, KbFileRegisterResult, KbListSnapshot, KbMutationResult, KbSearchResult, KbSummaryResult, OperationCategory, OperationStatus } from '../types.ts'
import { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, GenerateOptions, createUserMessage } from '@deepseek-ai/dsh-llm'

/** 处理器需要的宿主能力（由 `WechatDataGateway` 组装；getter 形式保证读到最新目录）。 */
export interface KbRemoteCtx {
  dirs: () => { decrypted: string }
  ctx: Context
  kbIndexJobs: Map<number, { done: number; total: number; startedAt: number; error: string }>
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  privacyBlocked: (feature: string, detail?: string) => string | null
  privacyGate: (feature: string, stats: { sessions: number; messages: number }, texts: string[]) => { ok: true; texts: string[] } | { ok: false; error: string }
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
const SUMMARY_INPUT_CHARS = 8000

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
      const ctx = rc.ctx
      const kbId = Number(options?.kbId)
      const id = Number(options?.id)

      const blocked = rc.privacyBlocked('kb_file_summary')
      if (blocked !== null) {
        rc.op('task', 'kb_file_summary', 'skip', '', blocked)
        return { ok: false, error: blocked }
      }

      const file = getKbFile(rc.dirs().decrypted, kbId, id)
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
        const chunk = listKbFileChunks(rc.dirs().decrypted, kbId, id, { limit: 200, offset })
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
      const gate = rc.privacyGate('kb_file_summary', { sessions: 0, messages: 0 }, [prompt])
      if (!gate.ok) {
        rc.op('task', 'kb_file_summary', 'skip', `id=${id}`, gate.error)
        return { ok: false, error: gate.error }
      }

      const assembler = new BlockAssembler()
      const opts: GenerateOptions = {
        provider: sel.provider,
        model: chatModel,
        messages: [createUserMessage({
          content: [{ type: 'text', text: gate.texts[0] ?? prompt }],
          source: { kind: 'plugin', plugin: 'dsh-wechat-data' },
        })],
        system: '你是文档摘要器。用中文把给定正文概括成不超过 5 条要点，每条一行、以「· 」开头，'
          + '只写正文里确有的事实，不要推测、不要评价。若正文被截断，最后一行注明「以上仅覆盖给出的部分」。',
        maxTokens: 400,
      }
      let text = ''
      try {
        for await (const c of ctx.llm.stream(opts)) assembler.push(c)
        text = assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim()
      } catch (e) {
        rc.op('task', 'kb_file_summary', 'fail', `id=${id}`, (e as Error).message)
        return { ok: false, error: '模型调用失败：' + (e as Error).message }
      }
      if (text === '') return { ok: false, error: '模型没有返回内容，未写入摘要。' }

      // 落库的是**实际发出去的那个模型名**（含库级覆盖），不是全局那条 ——
      // 否则换了库级模型之后，界面上的「由 X 生成」会指着一条其实没参与过的模型。
      const model = `${sel.provider}/${chatModel}`
      const saved = setKbFileSummary(rc.dirs().decrypted, kbId, id, text, model, covered)
      if (!saved.ok) return { ok: false, error: '摘要已生成但保存失败：' + (saved.error ?? '未知原因') }
      rc.op('task', 'kb_file_summary', 'ok', `id=${id}`, `${model} · 覆盖 ${covered}/${file.charCount} 字`)
      return { ok: true, summary: text, model, at: Date.now(), coveredChars: covered, totalChars: file.charCount }
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
        return {
          ...res,
          hits: fused.map(f => f.hit),
          // 两路都跑成了 ⇒ 不再给任何降级说明。
          degraded: undefined,
        }
      } catch (e) {
        return { ...res, degraded: { reason: 'embed-failed', label: '仅关键词（语义检索失败：' + (e as Error).message + '）' } }
      }
    },

    getKbModelConfig(options: { kbId: number }): {
      kbId: number
      settings: KbModelSettings
      global: Record<KbModelRole, string>
      resolved: Record<KbModelRole, ResolvedModel>
      entities: KbEntitySummary
    } {
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

    setKbModelConfig(options: { kbId: number; chatRef?: string; embedRef?: string; rerankRef?: string }):
      { ok: true; settings: KbModelSettings } | { ok: false; error: string } {
      const kbId = Number(options?.kbId)
      const r = writeKbModelSettings(rc.dirs().decrypted, kbId, {
        ...(options?.chatRef === undefined ? {} : { chatRef: options.chatRef }),
        ...(options?.embedRef === undefined ? {} : { embedRef: options.embedRef }),
        ...(options?.rerankRef === undefined ? {} : { rerankRef: options.rerankRef }),
      })
      rc.op('edit', 'set_kb_model', r.ok ? 'ok' : 'fail', `kb=${kbId}`, r.ok ? '' : r.error)
      return r
    },

    getKbVectorIndex(options: { kbId: number }): {
      kbId: number
      model: string
      source: 'inherit' | 'inline'
      configured: boolean
      status: KbVectorIndexStatus
      job: { done: number; total: number; startedAt: number; error: string } | null
    } {
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

    async buildKbVectorIndex(options: { kbId: number; force?: boolean }): Promise<KbVectorBuildResult & { ok: boolean; error?: string }> {
      const dir = rc.dirs().decrypted
      const kbId = Number(options?.kbId)
      if (!Number.isFinite(kbId) || kbId <= 0) return { ok: false, error: '没有指定知识库', status: 'bad-kb', rows: 0, embedded: 0, embed_calls: 0, elapsed_ms: 0 }
      const blocked = rc.privacyBlocked('kb_embed', '把文件正文发送给向量模型')
      if (blocked !== null) {
        rc.op('task', 'kb_embed', 'skip', `kb=${kbId}`, blocked)
        return { ok: false, error: blocked, status: 'blocked', rows: 0, embedded: 0, embed_calls: 0, elapsed_ms: 0 }
      }
      const cfg = loadRetrievalConfig(dir)
      // 按库解析：这个按钮建的**就是这个库**的索引，模型名也要跟着这个库的覆盖走。
      const model = rc.kbModel(kbId, 'embed').model
      const embed = model === '' ? undefined : rc.makeEmbedFn(model, 'kb_embed')
      if (!embed) {
        const msg = '未配置向量模型（在「数据配置 → AI 大模型」里填写向量模型名与端点）'
        rc.op('task', 'kb_embed', 'fail', `kb=${kbId}`, msg)
        return { ok: false, error: msg, status: 'no-embedder', rows: 0, embedded: 0, embed_calls: 0, elapsed_ms: 0 }
      }
      const job = { done: 0, total: 0, startedAt: Date.now(), error: '' }
      rc.kbIndexJobs.set(kbId, job)
      try {
        const built = await buildKbVectorIndex(dir, kbId, embed, {
          model,
          batchSize: cfg.embedding.batchSize,
          concurrency: cfg.embedding.concurrency,
          maxCharsPerDoc: cfg.embedding.maxCharsPerDoc,
          maxDocsPerBuild: cfg.embedding.maxDocsPerBuild,
          force: Boolean(options?.force),
          onProgress: (done, total) => { job.done = done; job.total = total },
        })
        rc.op('task', 'kb_embed', 'ok', `kb=${kbId}`, `${built.status} · ${built.rows} 条（本次 ${built.embedded}）· ${built.elapsed_ms}ms · ${model}`)
        return { ...built, ok: true }
      } catch (e) {
        job.error = (e as Error).message
        rc.op('task', 'kb_embed', 'fail', `kb=${kbId}`, job.error)
        return { ok: false, error: job.error, status: 'failed', rows: 0, embedded: 0, embed_calls: 0, elapsed_ms: Date.now() - job.startedAt }
      } finally {
        // 进度槽留一小会儿再清：界面轮询间隔内还要能看见「刚跑完」的结果，直接删会让按钮闪回常态。
        const t = setTimeout(() => { if (rc.kbIndexJobs.get(kbId) === job) rc.kbIndexJobs.delete(kbId) }, 3000)
        if (typeof t.unref === 'function') t.unref()
      }
    },

    async extractKbEntities(options: { kbId: number; fileIds?: number[]; limit?: number }): Promise<{
      ok: boolean
      error?: string
      files: number
      saved: number
      failed: Array<{ id: number; error: string }>
      model: string
    }> {
      const dir = rc.dirs().decrypted
      const kbId = Number(options?.kbId)
      if (!Number.isFinite(kbId) || kbId <= 0) return { ok: false, error: '没有指定知识库', files: 0, saved: 0, failed: [], model: '' }
      const blocked = rc.privacyBlocked('kb_extract', '把文件正文发送给模型抽取实体')
      if (blocked !== null) {
        rc.op('task', 'kb_extract', 'skip', `kb=${kbId}`, blocked)
        return { ok: false, error: blocked, files: 0, saved: 0, failed: [], model: '' }
      }
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
      for (const f of batch) {
        const r = await extractFileEntities(dir, kbId, f.id, ask, model)
        if (r.ok) saved += r.saved ?? 0
        else failed.push({ id: f.id, error: r.error ?? '未知原因' })
      }
      touchKbEntitiesAt(dir, kbId, Date.now())
      rc.op('task', 'kb_extract', failed.length === batch.length && batch.length > 0 ? 'fail' : 'ok',
        `kb=${kbId}`, `${batch.length} 个文件 · 写入 ${saved} 条实体 · ${model}`)
      return { ok: failed.length < batch.length, files: batch.length, saved, failed, model }
    },

    async suggestKbLinks(options: { kbId: number; text?: string; topK?: number; excludeTitle?: string }): Promise<{
      ok: boolean
      error?: string
      candidates: Array<{ label: string; kind: 'note' | 'entity'; score: number }>
      pool: number
      model: string
      note?: string
    }> {
      const dir = rc.dirs().decrypted
      const kbId = Number(options?.kbId)
      const text = String(options?.text ?? '')
      const bad = kbId > 0 ? null : '没有指定知识库'
      // 拦截判在最前：早退顺序错了会让「被拦」在界面上显示成「没配模型」（同 §6.1 C3）
      const blocked = rc.privacyBlocked('kb_link_suggest', '把笔记正文与候选标题发送给模型')
      const model = rc.kbModel(kbId, 'embed').model
      if (bad !== null) return { ok: false, error: bad, candidates: [], pool: 0, model }
      if (blocked !== null) {
        rc.op('task', 'kb_link_suggest', 'skip', `kb=${kbId}`, blocked)
        return { ok: false, error: blocked, candidates: [], pool: 0, model }
      }
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
