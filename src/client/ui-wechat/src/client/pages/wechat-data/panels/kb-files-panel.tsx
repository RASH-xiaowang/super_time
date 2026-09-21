/**
 * `KbFiles.tsx` 的「面板本体：KbFilesPanel 的取数、变更、轮询与渲染」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module kb-files-panel
 */

import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiAddKbFiles, apiBuildKbVectorIndex, apiDeleteKbFile, apiGetKbFileChunks, apiGetKbFiles, apiGetKbVectorIndex, apiOpenFileDialog, apiSearchKb, apiSetKbFileRag, apiSummarizeKbFile, writeRenderCache } from '../api.ts'
import type { KbFileMeta, KbSearchResult, KbVectorIndexView } from '../types.ts'
import { KB_ACCEPTED_EXTS } from '../types.ts'
import { Badge, Button, Card, EmptyState, PanelHeader, SearchInput, Toolbar, useDebouncedValue } from '../ui/kit.tsx'
import { useConfirm } from '../ui/confirm.tsx'
import { ListSkeleton, useTransientNotice } from './hooks.tsx'
import { formatRelative } from './kb-model.ts'
import { kbCacheKey, useKbScope } from './kb-scope.ts'
import { KbFileDetailPane, type KbFileReaderState } from './kb-files-detail.tsx'
import css from './kbfiles.module.css'
import kitCss from '../ui/kit.module.css'
import { AddReport, CHUNK_PAGE, FILTERS, PARSE_LOOK, PARSE_POLL_MAX_MS, PARSE_POLL_MS, SnippetText, StateFilter, baseName, cachedFiles, formatBytes, indexLabel, reasonText } from './kb-files-support.tsx'

/**
 * 知识库文件面板。
 * @param props.focusFileId - 要就地选中的文件（问答引用点「知识库文件」时带过来）。
 * @param props.focusNonce - 同一条引用连点两次也要能重新定位：只靠 `fileId` 变化，
 *   第二次点击不会触发任何 effect（值没变），界面看起来就是「点了没反应」。
 * @returns 文件书架的元素树。
 */
export function KbFilesPanel({ focusFileId, focusNonce }: {
  focusFileId?: number | null
  focusNonce?: number
} = {}): React.JSX.Element {
  // 「当前是哪个库」由分段条右侧的切换器决定，而切换器在合并外壳里 —— 不是本组件的父级，
  // 所以走订阅（`useKbScope`）而不是 props（与 KnowledgeBasePanel 同口径）。
  const { kbId, kbs } = useKbScope()
  /** 提示语里的库名。多库之后「文件列表读取失败」至少对应 N 个库，不说是哪个等于没说。 */
  const kbLabel = useMemo(() => {
    const name = kbs.find(k => k.id === kbId)?.name
    return name ? `「${name}」` : ''
  }, [kbs, kbId])

  const [snapshot, setSnapshot] = useState<{ items: readonly KbFileMeta[]; total: number }>(
    () => cachedFiles(kbId) ?? { items: [], total: 0 },
  )
  /**
   * 「文件库读不到」的原因（N1）。
   * 后端读失败时仍返回空列表（面板不该整块崩掉），但带上 `readError`：
   * 没有它，「库被占用 / 打不开」与「确实一个文件都没有」在界面上完全一样 ——
   * 用户会照「还没有文件」去排查，方向全错。
   */
  const [readError, setReadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const debounced = useDebouncedValue(query, 300)
  /** 去掉首尾空白后的关键词：空串表示「没有在搜」，是这一屏唯一的判据。 */
  const kw = debounced.trim()
  const [filter, setFilter] = useState<StateFilter>('all')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  /** 正文检索的结果 / 失败原因 / 是否在途。三态各有各的话要说，见结果区。 */
  const [search, setSearch] = useState<KbSearchResult | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  /** 相对时间的基准：随每次加载更新。用固定值而非逐帧 `Date.now()`，避免列表时间在滚动时抖动。 */
  const [now, setNow] = useState(() => Date.now())
  const [adding, setAdding] = useState(false)
  /** 正在被改的那一行（删除 / 开关）：期间禁用它的按钮，避免同一行并发两次变更。 */
  const [busyId, setBusyId] = useState<number | null>(null)
  /** 正在生成摘要的那个文件（与 `busyId` 分开：摘要慢得多，不该顺手禁用删除按钮）。 */
  const [busySummaryId, setBusySummaryId] = useState<number | null>(null)
  /** 摘要失败的原因（被隐私闸拦下 / 模型没配 / 该文件不许出网）。 */
  const [summaryError, setSummaryError] = useState<string | null>(null)
  /**
   * 本库的向量索引状态（`getKbVectorIndex`）。
   *
   * `null` 是「还没读到」，**不等于**「没有索引」—— 两者在界面上说的话不一样，
   * 混起来就是 N1 那条老毛病（读失败被显示成「确实没有」）。
   */
  const [indexView, setIndexView] = useState<KbVectorIndexView | null>(null)
  /** 本组件发起的那次建索引是否在途。 */
  const [indexing, setIndexing] = useState(false)
  /** 建索引失败的原因（出站拦截 / 未配向量模型 / 网络）。 */
  const [indexError, setIndexError] = useState<string | null>(null)
  const [report, setReport] = useState<AddReport | null>(null)
  const { notice, flash, hold } = useTransientNotice()
  const confirm = useConfirm()

  /**
   * 重新读取文件列表。
   * @param opts.silent - 后台读取（进度轮询用）：**不碰 `loading`**。前台读取要用它驱动
   *   骨架屏与「刷新」按钮上的「读取中…」，轮询若也去动它，那个按钮就会每 1.5 秒
   *   闪一次（看起来像卡住了）。
   */
  const load = useCallback(async (opts?: { silent?: boolean }): Promise<void> => {
    const silent = opts?.silent === true
    if (!silent) setLoading(true)
    try {
      const r = await apiGetKbFiles(kbId)
      setSnapshot({ items: r.items, total: r.total })
      setReadError(r.readError ?? null)
      setNow(Date.now())
      // 读失败时**不写**渲染缓存：把「读不到」的那份空列表存进去，下次打开会先渲染
      // 「还没有文件」，而缓存本身看不出来源 —— 正好复现 N1 要消除的那个假象。
      if (!r.readError) writeRenderCache(kbCacheKey('kb-files', kbId), { items: r.items, total: r.total })
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [kbId])

  useEffect(() => { void load() }, [load])

  /**
   * 正文检索。有关键词就跑一次，关键词变了就再跑（`debounced` 已做过 300ms 收敛）。
   *
   * `alive` 兜住「切库 / 连打两个词再退格」这类竞态：先发出的那次回来得晚，
   * 若直接落库就会覆盖后一次的结果 —— 界面显示上一个词的命中，而输入框里是新词。
   */
  useEffect(() => {
    if (kw === '') {
      setSearch(null)
      setSearchError(null)
      setSearching(false)
      return
    }
    let alive = true
    setSearching(true)
    setSearchError(null)
    void (async () => {
      try {
        const r = await apiSearchKb(kbId, kw)
        if (alive) setSearch(r)
      } catch (e) {
        // 走到这里只可能是传输层失败。库打不开那类**业务**失败由后端写在结果里
        // （`readError`），在结果区里说 —— 一次检索失败不该把整屏刷成红色报错。
        if (alive) setSearch(null)
        if (alive) setSearchError((e as Error).message)
      } finally {
        if (alive) setSearching(false)
      }
    })()
    return () => { alive = false }
  }, [kbId, kw])

  /** 手里这份结果是不是**当前关键词**的：切词 / 切库后在途的那一小段里，旧结果不展示。 */
  const searchStale = search === null || search.query !== kw
  const hits = search === null ? [] : search.hits

  /**
   * 正文命中过的文件 id：左侧列表据此把「正文里命中、文件名里没有」的文件也留下。
   *
   * 少了这一步，用户搜一个只出现在正文里的词，左侧会说「没有匹配的文件」，
   * 而上方结果区正列着命中 —— 同一屏里两句话互相打脸。
   */
  const contentFileIds = useMemo(() => {
    const ids = new Set<number>()
    for (const h of search?.hits ?? []) ids.add(h.fileId)
    return ids
  }, [search])

  /**
   * 结果区标题：`仅关键词（未建向量索引）· 5 条 · 用时 12ms`（设计稿 §8.4 的第 2 行）。
   *
   * 降级文案**整句取自后端** `degraded.label`：界面不复述「为什么只有关键词」——
   * 那句话有四种触发条件（没建向量 / 没有 Key / 断网 / 「禁止 AI 出网」被打开），
   * 前端自己猜一种，就会在其余三种下说错（§6.3：只说明现状，**不劝用户去开开关**）。
   *
   * T3 阶段这里也不会出现「建立索引」按钮：那是 T4 的稠密索引动作，
   * 现在放一个按不动的按钮，比不放更糟。
   */
  const searchTitle = useMemo(() => {
    if (search === null || searchStale) return '正在检索正文…'
    const base = search.degraded?.label ?? '关键词检索'
    return `${base} · ${search.hits.length} 条 · 用时 ${Math.round(search.stats.elapsedMs)}ms`
  }, [search, searchStale])

  /**
   * 「一条都没搜到」的原因要分开说（与 N1 同一条纪律）：
   * 「查询里没有可检索的字词」（纯标点）与「库里确实没有」是两件事，
   * 前者换一个词就有了，后者才说明库里没这个内容。
   */
  const emptySearchText = useMemo(() => {
    if (search?.stats.channels[0]?.note === '查询里没有可检索的字词') {
      return `「${kw}」里没有可检索的字词（试试中文词或字母数字）。`
    }
    return `正文里没有匹配「${kw}」的内容。结果区只搜正文，按文件名找请看下方的列表。`
  }, [search, kw])

  // 切库：先按新库的首帧缓存顶上去（有缓存就不闪骨架屏），再把「属于上一个库」的
  // 界面状态清干净 —— 选中的文件 id、关键词、状态筛选、上一次的添加回执。
  // 只重取数据而留着这几样，用户会在乙库里看到「高亮着甲库那个文件」；若那个 id
  // 恰好也存在，详情区显示的就是别的库的文件。真数据紧接着由上面的 `[load]` 取回。
  useEffect(() => {
    setSnapshot(cachedFiles(kbId) ?? { items: [], total: 0 })
    setSelectedId(null)
    setQuery('')
    setFilter('all')
    setReadError(null)
    setReport(null)
    // 检索结果也属于「上一个库」：留着它，切库后会在乙库的界面里看到甲库的命中。
    setSearch(null)
    setSearchError(null)
    setSearching(false)
  }, [kbId])

  const files = snapshot.items
  const total = snapshot.total

  /**
   * 「有没有还在解析的文件」的指纹（只有集合变了才变）。
   *
   * 用 id 拼串而不是数组本身：数组每次渲染都是新引用，直接进依赖会让下面那条 effect
   * 空转（每渲染一次就重建一个定时器）。指纹还带来一个想要的性质 ——
   * 解析**有进展**（集合变小）时预算重新开始，而卡住不动时会走到上限停下。
   */
  const pendingKey = useMemo(
    () => files.filter(f => PARSE_LOOK[f.parseState].pending).map(f => f.id).join(','),
    [files],
  )

  /**
   * 解析进度轮询（阶段 D · D2）。
   *
   * 为什么需要它：B 档（PDF / Word / Excel）登记之后**不是当场解完的** —— 后端只落一行
   * `parse_state='queued'`，由队列执行器随后推进（`queued → parsing → chunking → ready`）。
   * 没有这条 effect，用户点完「添加」看到的是一个不动的「排队中」，只能自己点「刷新」
   * 才看得到结果 —— 而那三个中间态本来就**是真的**，缺的只是让它自己刷新。
   *
   * 三处刻意的选择（任一处写错都会退化成「画假进度」）：
   *   · 只在真有 pending 文件时才建定时器；全是 `ready` 时一个都不建；
   *   · 走 `silent` 读取（理由见 `load`）；
   *   · **有上限**：执行器被强关时那一行会停在 `parsing` 而不再推进，没有上限就会
   *     永远每 1.5 秒查一次库。到点停下、留用户点「刷新」—— 停下比「悄悄一直查」
   *     诚实，也比显示一个假的「正在跑」好。
   */
  useEffect(() => {
    if (pendingKey === '') return
    let alive = true
    let ticks = 0
    const maxTicks = Math.ceil(PARSE_POLL_MAX_MS / PARSE_POLL_MS)
    const timer = setInterval(() => {
      ticks += 1
      if (ticks > maxTicks) { clearInterval(timer); return }
      if (alive) void load({ silent: true })
    }, PARSE_POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [pendingKey, load])

  /**
   * 读一次本库的向量索引状态。
   *
   * 失败**不显示成「没有索引」**：读不到就是读不到，按钮照旧可点，点了会拿到真错误。
   * 这条与 N1（读失败 vs 确无数据）同一个口径 —— 派生状态最容易在这里说谎。
   */
  const loadIndex = useCallback(async (): Promise<void> => {
    try { setIndexView(await apiGetKbVectorIndex(kbId)) } catch { /* 保留上一次的值，不把它清成「无」 */ }
  }, [kbId])

  // 换库 ⇒ 先清掉上一个库的状态再读。不清的话会短暂显示「甲库已建 1,240 块」，
  // 而用户此刻看的是乙库的文件列表 —— 这正是「切库没反应」那一类错觉的来源。
  useEffect(() => {
    setIndexView(null)
    setIndexError(null)
    void loadIndex()
  }, [loadIndex])

  /**
   * 建索引。`force` 时后端会先清空**本库**的向量再重算（别的库一行不动）。
   *
   * 出网范围只有本库、且只有 `include_in_rag = 1` 的文件 —— 这两条都在后端 SQL 里，
   * 界面不需要（也不该）自己再判一遍，但按钮的提示语要说清楚「会发送正文」。
   */
  const runIndex = useCallback(async (force: boolean): Promise<void> => {
    if (indexing) return
    setIndexing(true)
    setIndexError(null)
    try {
      const r = await apiBuildKbVectorIndex(kbId, force)
      if (!r.ok) setIndexError(r.error ?? '建索引失败')
      else flash(r.status === 'up-to-date'
        ? `索引已是最新（${r.rows} 块，本次未出网）`
        : `本库向量索引完成：${r.embedded} 块新算 · 共 ${r.rows} 块`)
    } catch (e) {
      setIndexError((e as Error).message)
    } finally {
      setIndexing(false)
      void loadIndex()
    }
  }, [indexing, kbId, flash, loadIndex])

  /**
   * 在飞建索引的轮询。
   *
   * 判据用**后端的 job**而不是本地的 `indexing`：建索引可能由另一个入口触发（或本组件
   * 卸载重挂过），只看本地状态会让按钮在「其实还在跑」时提前恢复可点。
   */
  const indexJobKey = indexView?.job ? `${indexView.kbId}:${indexView.job.done}` : ''
  useEffect(() => {
    if (indexJobKey === '') return
    const timer = setInterval(() => { void loadIndex() }, PARSE_POLL_MS)
    return () => { clearInterval(timer) }
  }, [indexJobKey, loadIndex])

  /**
   * 关键词**同时**过滤文件名与正文（设计稿 §8.4：用户不选模式，系统决定）。
   *
   * 两条路都要留：文件名里没有、但正文命中的文件也留下 —— 否则用户搜一个只出现在
   * 正文里的词，左侧会说「没有匹配的文件」而上方结果区正列着命中。
   * 反过来只有文件名命中、正文一条都没有也是正常情形（比如按扩展名找文件）。
   */
  const searched = useMemo(() => {
    const q = debounced.trim().toLowerCase()
    if (q === '') return files
    return files.filter(f =>
      f.name.toLowerCase().includes(q) || f.ext.toLowerCase().includes(q) || contentFileIds.has(f.id))
  }, [files, debounced, contentFileIds])

  const counts = useMemo(() => {
    let pending = 0
    let attention = 0
    let ready = 0
    for (const f of searched) {
      const look = PARSE_LOOK[f.parseState]
      if (look.pending) pending += 1
      else if (look.attention) attention += 1
      else ready += 1
    }
    return { all: searched.length, pending, attention, ready }
  }, [searched])

  const visible = useMemo(() => {
    if (filter === 'all') return searched
    return searched.filter((f) => {
      const look = PARSE_LOOK[f.parseState]
      if (filter === 'pending') return look.pending
      if (filter === 'attention') return look.attention
      return !look.pending && !look.attention
    })
  }, [searched, filter])

  const selected = useMemo(() => files.find(f => f.id === selectedId) ?? null, [files, selectedId])
  const firstVisibleId = visible.length > 0 ? visible[0]?.id ?? null : null
  /** 工具栏右侧那枚索引状态：文案与色调都由 `indexLabel` 决定（四种未就绪说法不同）。 */
  const idx = indexLabel(indexView)
  /** 在飞建索引的进度后缀：没有 job 时是空串，不占位。 */
  const idxJob = indexView?.job ?? null
  const idxText = idxJob && idxJob.total > 0
    ? `${idx.text} · 进行中 ${idxJob.done}/${idxJob.total}`
    : idx.text

  // 详情默认落在第一条：主从视图里右侧空着，用户得自己猜「要点一下左边」。
  // 只依赖两个原子值而不是 `visible` 数组，数组每次渲染都是新引用，会让 effect 空转。
  useEffect(() => {
    if (selectedId === null && firstVisibleId !== null) setSelectedId(firstVisibleId)
  }, [selectedId, firstVisibleId])

  // 从问答引用跳进来时**直接选中那个文件**：落到一个几百条的列表里让用户自己找，
  // 等于没跳 —— 而且用户并不知道要找的是哪一条。
  // 这条 effect 必须声明在上面 [kbId] 那条「清空上一个库的状态」**之后**：两者会在
  // 同一个 commit 里先后执行，顺序反了就会先选中再被清成 null，跳进来看到的是空的。
  // 清掉关键词与状态筛选同理：筛选条件会把这个文件挡在 `visible` 之外，
  // 那样选中行根本不在渲染出来的列表里。
  useEffect(() => {
    const id = Math.trunc(Number(focusFileId))
    if (!Number.isFinite(id) || id <= 0) return
    setSelectedId(id)
    setQuery('')
    setFilter('all')
  }, [focusFileId, focusNonce])

  /**
   * 选一个文件加入知识库。
   *
   * 走原生对话框**只取路径**：选中的可能是几十 MB 的文件，读盘与登记都由后端做
   * （与 `apiSaveFileDialog` 同口径）。`filters` 由这里传、不写死在主进程 ——
   * 写死就会与后端 `ACCEPTED_EXTS` 漂移成两份，症状是「选得进来但登记被拒」。
   *
   * 逐项回执：**部分成功是常态**（一次选 10 个、3 个重复、1 个类型不支持），
   * 所以这里把失败项逐条列出来，而不是压成一句「添加失败」。
   */
  const addFiles = useCallback(async (): Promise<void> => {
    const picked = await apiOpenFileDialog({
      title: '选择要加入知识库的文件',
      // 一个「全部支持的类型」分组：用户看不到不支持的扩展名，也就不会选进来再被拒。
      filters: [{ name: '支持的文件', extensions: [...KB_ACCEPTED_EXTS] }],
    })
    if (picked.error) { setError(picked.error); return }
    if (picked.canceled || picked.files.length === 0) return
    setAdding(true)
    try {
      const paths = picked.files
      const r = await apiAddKbFiles(kbId, paths)
      // `results` 与 `paths` 按下标对齐（后端对每个 path 依次 push 一条）。用它把
      // 失败项还原成「哪个文件、为什么」，否则界面只能说「有 4 个没进来」。
      const failures = r.results
        .map((res, i) => ({ res, path: paths[i] ?? '' }))
        .filter(x => !x.res.ok)
        .map(x => ({
          name: x.res.duplicateOf?.name || baseName(x.path) || '（未识别的文件）',
          reason: reasonText(x.res),
        }))
      setReport({ added: r.added, failed: r.failed, failures })
      if (r.added > 0) {
        flash(`已加入 ${r.added} 个文件`)
        await load()
      } else {
        setError(r.error ?? '这些文件都没有加入知识库')
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setAdding(false)
    }
  }, [flash, kbId, load])

  /**
   * 从知识库里删掉一个文件。
   *
   * **不碰用户电脑上的原文件** —— 这句必须写进确认框：不写的话用户不敢点，
   * 或者更糟，以为文件被删了而去回收站找。`kbId` 传进去当守卫。
   */
  const remove = useCallback(async (f: KbFileMeta): Promise<void> => {
    const ok = await confirm({
      title: `从知识库移除「${f.name}」？`,
      message: '会一并清掉它在库里解析出的文本块与向量（因此不再被检索到）。'
        + ' 你电脑上的原文件不会被删除或修改 —— 移除的只是知识库里的这一份。',
      tone: 'danger',
      confirmText: '移除',
    })
    if (!ok) return
    setBusyId(f.id)
    try {
      const r = await apiDeleteKbFile(kbId, f.id)
      if (!r.ok) { setError(r.error ?? '移除失败'); return }
      if (selectedId === f.id) setSelectedId(null)
      flash(r.removedChunks !== undefined ? `已移除，清掉 ${r.removedChunks} 个文本块` : '已移除')
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusyId(null)
    }
  }, [confirm, flash, kbId, load, selectedId])

  /**
   * 在资源管理器中定位原文件。走 preload 的 `showInFolder`（与「导出历史」同一个通道）。
   *
   * 为什么值得给这个按钮：本面板**只登记**用户电脑上的路径，从不持有文件 —— 用户想核对
   * 「我当初加的是哪一份」时，界面上唯一能给的答案就是这条路径，而一串 `D:\…` 文本
   * 既读不完也点不动。没有定位入口，路径就只是给人看的死字。
   * 后端不回报原文件是否还在（`KbFileMeta` 没有 exists 字段），所以这里不假装知道：
   * 定位失败（文件被移走 / 删掉）由 `showItemInFolder` 自己什么都不做来表达。
   * @param f - 要定位的那个文件。
   */
  const reveal = useCallback(async (f: KbFileMeta): Promise<void> => {
    if (!f.srcPath) { hold('这条记录没有原始路径（可能是早期迁移进来的）'); return }
    try {
      const api = (window as unknown as { electronAPI?: { showInFolder?: (p: string) => Promise<unknown> } }).electronAPI
      if (!api?.showInFolder) { hold('当前环境不支持「在文件夹中显示」'); return }
      await api.showInFolder(f.srcPath)
    } catch (e) {
      hold('定位失败：' + (e as Error).message)
    }
  }, [hold])

  /**
   * 就地展开的正文阅读器。`null` = 收起。
   *
   * 带着 `fileId` 而不是只存 items：一次取数在路上时用户可能已经点到别的文件、
   * 甚至切了库，回来时必须核对「这份结果是不是我现在要看的那个」—— 不核对的后果是
   * 甲文件的正文显示在乙文件的标题下面，而那看起来完全像是乙文件的内容。
   */
  const [reader, setReader] = useState<KbFileReaderState | null>(null)

  /**
   * 用模型生成这份文件的摘要。**这是一条出网调用**（发的是该文件前 8,000 字正文）。
   *
   * 三道闸都在后端按顺序过（禁止 AI 出网 → 本文件的 include_in_rag → 脱敏与审计），
   * 界面上不复制判断，只负责把被拒的原因原样说出来 —— 两处各判一套，迟早会不一致，
   * 而不一致的方向一定是界面比后端宽松。
   * @param f - 目标文件。
   */
  const runSummary = useCallback(async (f: KbFileMeta): Promise<void> => {
    setBusySummaryId(f.id)
    setSummaryError(null)
    try {
      const r = await apiSummarizeKbFile(kbId, f.id)
      if (!r.ok) { setSummaryError(r.error ?? '生成失败'); return }
      flash('已生成摘要')
      await load()
    } catch (e) {
      setSummaryError((e as Error).message)
    } finally {
      setBusySummaryId(null)
    }
  }, [flash, kbId, load])

  /**
   * 读某个文件正文的第一页。选中谁就读谁 —— **正文默认展开**，不用点。
   *
   * 收起后再点「查看正文」也走这一条：不缓存收起前那份，重读一次更诚实 ——
   * 期间这个文件可能刚被重新解析过。
   * @param fileId - 要读的那个文件。
   */
  const loadChunks = useCallback(async (fileId: number): Promise<void> => {
    setReader({ fileId, items: [], total: 0, totalChars: 0, loading: true, error: null })
    try {
      const r = await apiGetKbFileChunks(kbId, fileId, { limit: CHUNK_PAGE })
      // 只认「还是我现在要看的这个文件」的结果：一次取数在路上时用户可能已经点到
      // 别的文件、甚至切了库，不核对就会把甲的正文显示在乙的标题下面。
      setReader(prev => (prev && prev.fileId === fileId
        ? { ...prev, items: r.items, total: r.total, totalChars: r.totalChars, loading: false, error: r.readError ?? null }
        : prev))
    } catch (e) {
      setReader(prev => (prev && prev.fileId === fileId
        ? { ...prev, loading: false, error: (e as Error).message }
        : prev))
    }
  }, [kbId])

  // 默认展开：选中一变就读第一页。`loadChunks` 的身份只在 kbId 变化时变，
  // 所以切库也会自动重读。
  //
  // ⚠ 依赖里**只能放 `selectedId` 这个原子值，不能放 `selected`**：解析中的文件每
  // `PARSE_POLL_MS` 轮询一次，每次轮询都会重建整个 snapshot，于是 `selected` 每 1.5 秒
  // 就是一个新引用 —— 依赖它等于「每隔 1.5 秒把正文重读并闪一次加载态」，
  // 而它在代码评审里看起来完全正常。（笔记库那边的首帧 effect 踩过同一条，注释还留着。）
  useEffect(() => {
    if (selectedId === null) { setReader(null); return }
    // 上一次的失败原因不能跟着换文件残留下来 —— 否则乙文件好好地在，界面上却挂着
    // 一句甲文件的「该文件不能生成摘要」。
    setSummaryError(null)
    void loadChunks(selectedId)
  }, [selectedId, loadChunks])

  /** 追加下一页（`items.length` 就是 offset：一次一页一页往后读，不重头再取）。 */
  const loadMoreReader = useCallback(async (): Promise<void> => {
    if (reader === null || reader.loading) return
    const { fileId, items } = reader
    setReader(prev => (prev ? { ...prev, loading: true } : prev))
    try {
      const r = await apiGetKbFileChunks(kbId, fileId, { limit: CHUNK_PAGE, offset: items.length })
      setReader(prev => (prev && prev.fileId === fileId
        ? { ...prev, items: [...prev.items, ...r.items], total: r.total, totalChars: r.totalChars, loading: false, error: r.readError ?? null }
        : prev))
    } catch (e) {
      setReader(prev => (prev && prev.fileId === fileId
        ? { ...prev, loading: false, error: (e as Error).message }
        : prev))
    }
  }, [kbId, reader])

  /**
   * 切换一个文件是否参与向量化（出网）。
   *
   * 关掉之后该文件**完全不出网**，但仍留在关键词索引里可被搜到 ——
   * 这正是「库里有合同，但我还想搜到它」的实现方式。全局「禁止 AI 出网」是同一道闸门，
   * 一起拦下，所以这里不承诺「打开就一定出网」，只说「允许」。
   *
   * 成功后**就地改这一行**而不是整表重取：切一个开关让整个列表闪一次（时间戳全变）
   * 是没必要的动作，而且会把用户正在看的那一行滚动位置顶走。
   */
  const toggleRag = useCallback(async (f: KbFileMeta, next: boolean): Promise<void> => {
    setBusyId(f.id)
    try {
      const r = await apiSetKbFileRag(kbId, f.id, next)
      if (!r.ok) { setError(r.error ?? '切换失败'); return }
      const items = snapshot.items.map(x => (x.id === f.id ? { ...x, includeInRag: next } : x))
      const totalNow = snapshot.total
      setSnapshot({ items, total: totalNow })
      // 渲染缓存里那份也要跟着改：否则切走再切回来，首帧画的是开关改之前的状态。
      writeRenderCache(kbCacheKey('kb-files', kbId), { items, total: totalNow })
      flash(next ? '已允许该文件参与语义检索（会出网）' : '已停止该文件出网，仍可用关键词搜到')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusyId(null)
    }
  }, [flash, kbId, snapshot])

  const filtering = debounced !== '' || filter !== 'all'
  /** 列表为空时分三种说法：读不到 / 还没有文件 / 筛不出来。混成一句会让排查方向全错。 */
  const emptyNode = readError
    ? (
      <EmptyState
        icon="⚠️"
        title="读不到文件列表"
        desc={`${kbLabel || '这个库'}的文件索引打不开，所以这里列不出内容（不是「还没有文件」）。上面的报错里是原因，稍后点「刷新」重试。`}
      />
    )
    : filtering
      ? (
        <EmptyState
          icon="🔍"
          title="没有匹配的文件"
          desc={`当前条件：${[debounced ? `「${debounced}」（文件名或正文）` : '', filter !== 'all' ? `状态「${FILTERS.find(f => f.key === filter)?.label ?? ''}」` : ''].filter(Boolean).join(' · ')}。换个词，或清除筛选看全部。`}
          action={<Button variant="pill" onClick={() => { setQuery(''); setFilter('all') }}>清除筛选</Button>}
        />
      )
      : (
        <EmptyState
          icon="📄"
          title="还没有登记文件"
          desc="点右上角「添加文件」，把你电脑上的 txt / md / csv / json / html 等文件加进来。文件只被「读取」，不会被修改或删除；解析用的是库内的副本，所以原文件之后改名、移动都不影响。"
          action={<Button variant="pill" onClick={() => { void addFiles() }} disabled={adding}>添加文件</Button>}
        />
      )

  return (
    <div className={clsx(kitCss.panelShell, css.shell)}>
      {/* 页头与工具栏**吸顶**，与笔记库同一套骨架：三栏之后本面板高度由外壳给足，
          整块跟着滚会让「添加文件 / 搜索 / 状态筛选」滚出屏幕。 */}
      <div className={css.head}>
        <PanelHeader
          title="文件"
          desc="当前知识库里的本地文件：登记 / 解析状态 / 分块 / 是否参与语义检索 · 存储于 wechat_kb_files.db（kb_files 表）"
          actions={(
            <>
              <Button variant="primary" onClick={() => { void addFiles() }} disabled={adding}>
                {adding ? '添加中…' : '＋ 添加文件'}
              </Button>
              {/* 语义索引：把「提问时顺手建」这个隐式行为变成一个看得见、点得动的入口。
                  它会把本库 `include_in_rag=1` 文件的正文发给向量模型，所以提示语写明会出网。 */}
              <Button
                variant="ghost"
                onClick={() => { void runIndex(false) }}
                disabled={indexing}
                title="把本库参与语义检索的文件正文发给向量模型，建/补齐向量索引（会出网）"
              >
                {indexing ? '建索引中…' : '语义索引'}
              </Button>
              <Button variant="ghost" onClick={() => { void load() }} disabled={loading}>
                {loading ? '读取中…' : '刷新'}
              </Button>
            </>
          )}
        />

        <Toolbar
          left={(
            <>
              <SearchInput
                value={query}
                onChange={setQuery}
                placeholder="搜索文件名与正文…"
                ariaLabel="搜索知识库文件与正文"
              />
              <div className={css.stateBar} role="group" aria-label="按解析状态筛选">
                {FILTERS.map(f => (
                  <button
                    key={f.key}
                    type="button"
                    className={css.chip}
                    data-on={filter === f.key ? '1' : undefined}
                    aria-pressed={filter === f.key}
                    onClick={() => { setFilter(f.key) }}
                  >
                    {f.label}<span className={css.chipCount}>{counts[f.key]}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          right={(
            <span className={css.meta}>
              已登记 {visible.length} / {total} 个文件
              <span className={css.indexChip} data-tone={idx.tone} title="本库的向量索引状态；语义检索与问答的向量召回都依赖它">
                {idxText}
              </span>
            </span>
          )}
        />
      </div>

      {notice && <div className={css.notice}>{notice}</div>}
      {error && <div className={kitCss.error} role="alert">{error}</div>}
      {indexError && (
        <div className={kitCss.error} role="alert">语义索引没有建成：{indexError}</div>
      )}
      {/* 读失败与空库必须分开说（N1） */}
      {readError && (
        <div className={kitCss.error} role="alert">
          {kbLabel || '这个库'}的文件列表读取失败（不是「还没有文件」）：{readError}
        </div>
      )}

      {/* 滚动区：回执、检索结果与主从两栏一起滚（与改前「整块面板滚」的行为一致），
          被吸住的只有上面的页头与工具栏。 */}
      <div className={css.bodyWrap}>
        {/* 添加回执：成功数一句话，失败项逐条给原因。一个都没失败时不渲染这一段。 */}
        {report && report.failures.length > 0 && (
          <div className={css.report} role="status">
            <div className={css.reportHead}>
              <span className={css.reportTitle}>已加入 {report.added} 个，{report.failed} 个未加入</span>
              <Button size="sm" variant="outline" onClick={() => { setReport(null) }}>知道了</Button>
            </div>
            <ul className={css.reportList}>
              {report.failures.map((x, i) => (
                <li className={css.reportItem} key={`${x.name}-${i}`}>
                  <span className={css.reportName} title={x.name}>{x.name}</span>
                  <span className={css.reportReason}>{x.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 正文检索结果（设计稿 §8.4）。只在有关键词时出现：它不占独立视图，
            也不给「只用关键词 / 语义」这类模式开关 —— 走哪条通道由系统决定，
            标题行说明实际走了什么（§6.3：降级必须被看见）。 */}
        {kw !== '' && (
          <section className={css.results} aria-label="正文检索结果" aria-busy={searching}>
            <div className={css.resultsHead}>
              <span className={css.resultsTitle}>{searchTitle}</span>
              <span className={css.resultsHint}>按「{kw}」</span>
            </div>

            {searchError ? (
              <div className={kitCss.error} role="alert">正文检索没有完成：{searchError}</div>
            ) : search?.error ? (
              <div className={kitCss.error} role="alert">{search.error}</div>
            ) : search?.readError ? (
              <div className={kitCss.error} role="alert">
                正文索引读取失败（不是「没有匹配的内容」）：{search.readError}
              </div>
            ) : searchStale ? (
              <div className={css.resultsEmpty}>正在检索正文…</div>
            ) : hits.length === 0 ? (
              <div className={css.resultsEmpty}>{emptySearchText}</div>
            ) : (
              <ul className={css.hitList}>
                {hits.map(h => (
                  <li key={h.chunkId} className={css.hit}>
                    {/* 点一条结果 → 在左侧选中那个文件：检索是「找到文件」的入口，
                        状态 / 是否出网 / 原路径都在右栏，不该让用户自己再回去找。 */}
                    <button type="button" className={css.hitHead} onClick={() => { setSelectedId(h.fileId) }}>
                      <span className={css.hitFile} title={h.fileName}>{h.fileName}</span>
                      {h.page > 0 ? <span className={css.hitDot}>· 第 {h.page} 页</span> : null}
                      {h.heading ? <span className={css.hitCrumb} title={h.heading}>· {h.heading}</span> : null}
                    </button>
                    <p className={css.hitSnippet}><SnippetText text={h.snippet} marks={h.marks} /></p>
                    <div className={css.hitMeta}>
                      <span>得分 {h.score.toFixed(3)}</span>
                      <span>关键词 #{h.ranks.sparse ?? '—'}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <div className={css.body}>
          {/* 左：文件列表 */}
          <Card flush className={clsx(css.listPane, visible.length === 0 && css.listPaneWide)}>
            {loading && files.length === 0 ? (
              <ListSkeleton rows={6} />
            ) : visible.length === 0 ? emptyNode : (
              <div className={css.list}>
                {visible.map((f) => {
                  const look = PARSE_LOOK[f.parseState]
                  return (
                    <button
                      key={f.id}
                      type="button"
                      className={css.row}
                      data-on={f.id === selectedId ? '1' : undefined}
                      aria-current={f.id === selectedId ? 'true' : undefined}
                      onClick={() => { setSelectedId(f.id) }}
                    >
                      <span className={css.rowMain}>
                        <span className={css.rowTitle}>
                          <span className={css.rowName} title={f.name}>{f.name}</span>
                          <Badge tone={look.tone}>{look.label}</Badge>
                        </span>
                        <span className={css.rowSub}>
                          <span>{f.ext ? f.ext.toUpperCase() : '无扩展名'}</span>
                          <span>{formatBytes(f.sizeBytes)}</span>
                          <span>{f.chunkCount} 块</span>
                          <span>{formatRelative(f.createdAt, now)}</span>
                        </span>
                      </span>
                      <span className={css.rowSide}>
                        {f.includeInRag ? null : <span className={css.offlineMark}>不出网</span>}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </Card>

          <KbFileDetailPane
            hidden={visible.length === 0}
            loading={loading}
            selected={selected}
            busyId={busyId}
            busySummaryId={busySummaryId}
            summaryError={summaryError}
            reader={reader}
            now={now}
            onSummarize={runSummary}
            onChunks={loadChunks}
            onCloseReader={() => { setReader(null) }}
            onReveal={reveal}
            onRemove={remove}
            onMoreReader={loadMoreReader}
            onToggleRag={toggleRag}
          />
        </div>
      </div>
    </div>
  )
}
