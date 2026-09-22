/**
 * 知识库面板 —— 「联系人与社交」组下的独立导航项（tab: `kb`）。
 *
 * 与「知识图谱」（tab: `knowledge`）是**同一批数据的两种看法**，共用后端笔记库：
 *   · 知识图谱：把笔记当**图**看 —— 力导向画布、`[[链接]]` 边、待补节点，
 *     用来发现结构与断链；
 *   · 知识库（本文件）：把笔记当**文档**看 —— 列表 + 详情 + 新建/编辑 + 标签 + 关键词搜索。
 * 图上的每个节点只有一段摘要，读不到、也改不了正文；而日常使用里「读一篇、改一篇」
 * 远比「看整张网」频繁。所以缺的正是这个书架视图 —— 两个入口不是重复，是互补。
 *
 * 数据层**零新增**：`wechat_notes.db`（`notes` 表）与 `@Remote` 方法
 * （`getNotes` / `saveNote` / `deleteNote`）都是既有的（见
 * `src/backend/wechat-data/src/query/notes.ts`）；本文件只做呈现与交互。
 * 也因此这里**没有**「后台仍在同步微信数据」那类提示 —— 笔记是纯本地资产，
 * 与解密同步无关（`EmptyMaybeSyncing` 用在这里会说假话）。
 */
import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiDeleteNote, apiGetNotes, readRenderCache, writeRenderCache } from '../api.ts'
import type { KnowledgeNote } from '../types.ts'
import { Badge, Button, Card, EmptyState, PanelHeader, SearchInput, Toolbar, useDebouncedValue } from '../ui/kit.tsx'
import { useConfirm } from '../ui/confirm.tsx'
import { NOTES_UPDATED_EVENT } from '../notes-events.ts'
import { useWechatDataUpdated } from './hooks.tsx'
import { KnowledgeNoteEditor } from './KnowledgeNoteEditor.tsx'
import { ListSkeleton, useTransientNotice } from './hooks.tsx'
import { collectTags, countText, excerptOf, filterByTag, formatDate, formatRelative, indexByTitle, linkRefs, normalizeTitleKey, segmentBody } from './kb-model.ts'
import { kbCacheKey, useKbScope } from './kb-scope.ts'
import css from './knowledge-base.module.css'
import kitCss from '../ui/kit.module.css'

/** 首帧渲染缓存：上次成功读到的那份列表（冷启动时先出内容，再由请求结果校正）。 */
interface KbCache {
  items: KnowledgeNote[]
  total: number
}

/**
 * 读渲染缓存。
 *
 * 键有两个约束，缺一不可：
 *   · 必须带 `kb-` 前缀 —— `api.ts` 的 `saveNote` / `deleteNote` 靠
 *     `invalidateWechatCache('kb-')` 清这一层；换个前缀会出现「图谱刷新了、
 *     列表还是旧的」这种半刷新状态（两套缓存互不相通，只清一层最危险）；
 *   · 必须带库 id（`kbCacheKey`）—— 否则切库后的首帧画的是**上一个库**的列表：
 *     首帧是同步读缓存渲染的，真数据要等一次 RPC 才到，那一段空窗里用户看到的
 *     正是别的库的笔记。拼法只有 `kbCacheKey` 一处，别在这里手写 `kb-list:`。
 * @param kbId - 知识库 id。
 * @returns 上次成功渲染的那份列表缓存。
 */
function cachedKb(kbId: number): KbCache | null {
  return readRenderCache<KbCache>(kbCacheKey('kb-list', kbId))
}

/**
 * 把正文渲染成「纯文本 + 可点击的 `[[链接]]`」。
 *
 * 链接分两种，与知识图谱里实线边 / 虚线 stub 一一对应：
 *   · 命中已有条目 → 点击在右侧切过去（不跳页，主从视图的「就地打开」）；
 *   · 未命中 → 「待补笔记」，点击直接用该目标作标题开新建框
 *     ——「先把链接写下来、之后再补那篇」是这套知识库的既定用法，不是错误。
 * @param body - 正文。
 * @param byTitle - 标题索引（`indexByTitle`）。
 * @param onOpen - 命中时切换选中。
 * @param onCreate - 未命中时带着目标名开新建。
 * @returns 可直接放进容器的节点数组。
 */
function renderBody(
  body: string,
  byTitle: Map<string, KnowledgeNote>,
  onOpen: (id: number) => void,
  onCreate: (title: string) => void,
): React.ReactNode[] {
  return segmentBody(body).map((seg, i) => {
    if (seg.kind === 'text') return <span key={`t${i}`}>{seg.text}</span>
    const hit = byTitle.get(normalizeTitleKey(seg.target))
    if (hit) {
      return (
        <button
          key={`l${i}`}
          type="button"
          className={css.wiki}
          onClick={() => { onOpen(hit.id) }}
          title={`跳到「${hit.title}」`}
        >
          {seg.text}
        </button>
      )
    }
    return (
      <button
        key={`s${i}`}
        type="button"
        className={css.wikiStub}
        onClick={() => { onCreate(seg.target) }}
        title={`「${seg.target}」还没有对应条目，点此新建`}
      >
        {seg.text}<span aria-hidden="true">＋</span>
      </button>
    )
  })
}

/**
 * Knowledge base panel.
 * @param props.onOpenChat - 打开来源会话（问答沉淀的笔记才有来源）。
 * @returns the knowledge-base element tree.
 */
export function KnowledgeBasePanel({ onOpenChat }: { onOpenChat?: (username: string, localId?: number) => void } = {}): React.JSX.Element {
  // 「当前是哪个库」由分段条右侧的切换器决定，而切换器在合并外壳里 —— 不是本组件的父级，
  // 所以走订阅（`useKbScope`）而不是 props。
  const { kbId, kbs } = useKbScope()
  /**
   * 提示语里的库名。
   *
   * 单库时代「笔记库读取失败」「知识库还是空的」都只有一种解释；多库之后同一句话
   * 至少对应 N 个库，不说是哪个就等于没说。列表还没回来时退化为空串，
   * 由调用处给一个兜底说法。
   */
  const kbLabel = useMemo(() => {
    const name = kbs.find(k => k.id === kbId)?.name
    return name ? `「${name}」` : ''
  }, [kbs, kbId])
  const [snapshot, setSnapshot] = useState<{ items: readonly KnowledgeNote[]; total: number }>(
    () => cachedKb(kbId) ?? { items: [], total: 0 },
  )
  /**
   * 「笔记库读不到」的原因（N1）。
   * 后端读失败时仍返回空列表（面板不该整块崩掉），但带上 `readError`：
   * 没有它，「库被占用/损坏」与「确实一条笔记都没有」在界面上完全一样 ——
   * 用户会照「知识库还是空的」去排查，方向全错。
   */
  const [readError, setReadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const debounced = useDebouncedValue(query, 300)
  const [tag, setTag] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  /** 相对时间的基准：随每次加载更新。用固定值而非 `Date.now()` 逐帧重算，避免列表时间在滚动时抖动。 */
  const [now, setNow] = useState(() => Date.now())
  const [editor, setEditor] = useState<{ open: boolean; id?: number; title?: string; body?: string; tags?: string }>({ open: false })
  const { notice, flash } = useTransientNotice()
  const confirm = useConfirm()

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const r = await apiGetNotes(kbId, debounced ? { query: debounced } : undefined)
      setSnapshot({ items: r.items, total: r.total })
      setReadError(r.readError ?? null)
      setNow(Date.now())
      // 读失败时**不写**渲染缓存：把「读不到」的那份空列表存进去，下次打开会先渲染
      // 「知识库还是空的」，而缓存本身看不出来源 —— 正好复现 N1 要消除的那个假象。
      // 带关键词的结果同样不落缓存：那是筛选结果，回填到无筛选的首帧会显示成「库只有这几条」。
      if (!r.readError && !debounced) writeRenderCache(kbCacheKey('kb-list', kbId), { items: r.items, total: r.total })
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [debounced, kbId])

  useEffect(() => { void load() }, [load])

  // 切库：先按新库的首帧缓存顶上去（有缓存就不闪骨架屏），再把「属于上一个库」的
  // 界面状态清干净 —— 选中的条目 id、关键词、标签。只重取数据而留着这三样，用户会
  // 在乙库里看到「高亮着甲库那条」；若那条 id 恰好也存在，详情区显示的就是别的库的笔记。
  // 真数据紧接着由上面那个 `[load]` 副作用取回（`load` 依赖 kbId）。
  useEffect(() => {
    setSnapshot(cachedKb(kbId) ?? { items: [], total: 0 })
    setSelectedId(null)
    setQuery('')
    setTag(null)
    setReadError(null)
  }, [kbId])

  // 笔记在别处被改（典型：切到「知识图谱」分段，用右侧栏的编辑器新建/删除）时同步重载。
  // 两个分段共用同一个 notes 表，任何一侧写入都广播 NOTES_UPDATED_EVENT；
  // 不订阅就只能等下次挂载，而分段切换恰好会卸载重挂 —— 依赖那个巧合太脆。
  useWechatDataUpdated(() => { void load() }, NOTES_UPDATED_EVENT)

  const notes = snapshot.items
  const total = snapshot.total

  /** 标签统计取自**关键词过滤后**的集合：搜索时筛选条跟着收敛，不会点出空结果。 */
  const tagStats = useMemo(() => collectTags(notes), [notes])
  const visible = useMemo(() => filterByTag(notes, tag), [notes, tag])
  const byTitle = useMemo(() => indexByTitle(notes), [notes])
  const selected = useMemo(() => notes.find(n => n.id === selectedId) ?? null, [notes, selectedId])
  const links = useMemo(() => (selected ? linkRefs(selected.body, byTitle) : []), [selected, byTitle])

  const firstVisibleId = visible.at(0)?.id ?? null

  // 详情默认落在第一条：主从视图里右侧空着，用户得自己猜「要点一下左边」。
  // 只依赖两个原子值而不是 `visible` 数组，数组每次渲染都是新引用，会让 effect 空转。
  useEffect(() => {
    if (selectedId === null && firstVisibleId !== null) setSelectedId(firstVisibleId)
  }, [selectedId, firstVisibleId])

  // 当前标签在新结果里没了（改过标签、或搜索把它排除了）就退回「全部」，
  // 否则会停在一个筛不出任何东西、且筛选条上已经看不到选中态的标签上。
  useEffect(() => {
    if (tag !== null && !tagStats.some(t => t.tag === tag)) setTag(null)
  }, [tag, tagStats])

  const openCreate = useCallback((title?: string): void => {
    setEditor({ open: true, ...(title ? { title } : {}) })
  }, [])

  const openEdit = useCallback((n: KnowledgeNote): void => {
    setEditor({ open: true, id: n.id, title: n.title, body: n.body, tags: n.tags.join(', ') })
  }, [])

  const onSaved = useCallback((id?: number): void => {
    const created = editor.id === undefined
    setEditor({ open: false })
    // 新建后选中这条（列表按更新时间倒序，它就是第一条）；不这么做会停在上一篇笔记上，
    // 用户刚从编辑器里出来却看不到自己刚写的东西。详情区的空态有 `!loading` 那道闸，
    // 所以这里出现的短暂「未选中」不会闪出一句「选一条看正文」。
    if (typeof id === 'number') setSelectedId(id)
    flash(created ? '已新建条目' : '已保存修改')
    void load()
  }, [editor.id, flash, load])

  const remove = useCallback(async (n: KnowledgeNote): Promise<void> => {
    const ok = await confirm({
      title: `删除条目「${n.title}」？`,
      message: '正文与标签会一并删除，且不可撤销。指向它的 [[链接]] 不会被改写 —— 它们会变成「待补笔记」，可以在知识图谱里看到。',
      tone: 'danger',
      confirmText: '删除',
    })
    if (!ok) return
    try {
      const r = await apiDeleteNote(kbId, n.id)
      if (!r.ok) { setError(r.error ?? '删除失败'); return }
      if (selectedId === n.id) setSelectedId(null)
      flash('已删除条目')
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }, [confirm, flash, kbId, load, selectedId])

  const filtering = debounced !== '' || tag !== null
  const filterDesc = [
    debounced ? `关键词「${debounced}」` : '',
    tag ? `标签 #${tag}` : '',
  ].filter(Boolean).join(' · ')

  return (
    <div className={clsx(kitCss.panelShell, css.shell)}>
      {/* 页头与工具栏**吸顶**：三栏之后本面板的高度由外壳给足，若整块跟着滚，
          滚两屏之后「新建」「搜索」「标签」就都不在屏幕上，而右侧详情还长得滚不完。 */}
      <div className={css.head}>
        <PanelHeader
          title="笔记库"
          desc="本地知识条目：列表 / 详情 / 新建 / 编辑 / 标签 / 关键词搜索 · 存储于 wechat_notes.db（notes 表）"
          actions={(
            <>
              <Button variant="primary" onClick={() => { openCreate() }}>＋ 新建条目</Button>
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
                placeholder="搜索标题 / 正文 / 标签…"
                ariaLabel="搜索知识库条目"
              />
              {tagStats.length > 0 && (
                <div className={css.tagBar} role="group" aria-label="按标签筛选">
                  <button
                    type="button"
                    className={css.tagChip}
                    data-on={tag === null ? '1' : undefined}
                    aria-pressed={tag === null}
                    onClick={() => { setTag(null) }}
                  >
                    全部
                  </button>
                  {tagStats.map(t => (
                    <button
                      key={t.tag}
                      type="button"
                      className={css.tagChip}
                      data-on={tag === t.tag ? '1' : undefined}
                      aria-pressed={tag === t.tag}
                      onClick={() => { setTag(t.tag) }}
                    >
                      {t.tag}<span className={css.tagCount}>{t.count}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          right={<span className={css.meta}>{countText(visible.length, total)}</span>}
        />
      </div>

      {notice && <div className={css.notice} role="status">{notice}</div>}
      {error && <div className={kitCss.error} role="alert">{error}</div>}
      {/* 读失败与空库必须分开说（N1） */}
      {readError && (
        <div className={kitCss.error} role="alert">
          {kbLabel || '笔记库'}读取失败（不是「暂无条目」）：{readError}
        </div>
      )}

      <div className={css.bodyWrap}>
        <div className={css.body}>
          {/* 左：条目列表 */}
          <Card flush className={clsx(css.listPane, visible.length === 0 && css.listPaneWide)}>
            {loading && notes.length === 0 ? (
              <ListSkeleton rows={6} />
            ) : visible.length === 0 ? (
              <EmptyState
                icon={filtering ? '🔍' : '📚'}
                title={filtering ? '没有匹配的条目' : '知识库还是空的'}
                desc={filtering
                  ? `当前条件：${filterDesc}。换个词，或清除筛选看全部。`
                  : `${kbLabel || '这个库'}里还没有条目。手写笔记与「微信问答」的沉淀都进这个库，正文里可以用 [[目标]] 互相链接。`}
                action={filtering
                  ? <Button variant="pill" onClick={() => { setQuery(''); setTag(null) }}>清除筛选</Button>
                  : <Button variant="pill" onClick={() => { openCreate() }}>＋ 新建第一条</Button>}
              />
            ) : (
              <div className={css.list}>
                {visible.map(n => (
                  <button
                    key={n.id}
                    type="button"
                    className={css.row}
                    data-on={n.id === selectedId ? '1' : undefined}
                    aria-current={n.id === selectedId ? 'true' : undefined}
                    onClick={() => { setSelectedId(n.id) }}
                  >
                    <span className={css.rowMain}>
                      <span className={css.rowTitle} title={n.title}>{n.title}</span>
                      <span className={css.rowExcerpt}>{excerptOf(n.body, 110) || '（正文为空）'}</span>
                      {n.tags.length > 0 && (
                        <span className={css.rowTags}>
                          {n.tags.map(t => <Badge key={t} tone="purple">{t}</Badge>)}
                        </span>
                      )}
                    </span>
                    <span className={css.rowSide}>
                      <span className={css.rowTime}>{formatRelative(n.updatedAt, now)}</span>
                      {n.sourceKind === 'ask' ? <Badge tone="cyan">问答沉淀</Badge> : null}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Card>

          {/* 右：详情。列表为空时整块被 detailPaneHidden 隐藏（见样式表），
              所以这里还能渲染出来的空态只可能是「有列表但还没选中」。
              ⚠️ 别改用 `data-*` 标记：kit 的 Card 只接受 title/extra/footer/children/
              flush/className，**不会把额外 props 透传到 DOM**，写了会被静默丢掉。 */}
          <Card className={clsx(css.detailPane, visible.length === 0 && css.detailPaneHidden)}>
            {selected ? (
              <div className={css.detail}>
                <div className={css.detailHead}>
                  <h3 className={css.detailTitle}>{selected.title}</h3>
                  <div className={css.detailActions}>
                    <Button variant="pill" onClick={() => { openEdit(selected) }}>编辑</Button>
                    <Button variant="danger" onClick={() => { void remove(selected) }}>删除</Button>
                  </div>
                </div>

                <div className={css.detailMeta}>
                  <span>更新于 {formatRelative(selected.updatedAt, now)}</span>
                  <span>创建于 {formatDate(selected.createdAt)}</span>
                  <span>{selected.body.length} 字</span>
                  {links.length > 0 ? <span>{links.length} 条链接</span> : null}
                  {selected.sourceKind === 'ask' ? (
                    <span>
                      来自问答沉淀
                      {selected.sourceUsername && onOpenChat
                        ? (
                          <button
                            type="button"
                            className={css.linkBtn}
                            onClick={() => { onOpenChat(selected.sourceUsername ?? '') }}
                          >
                            · 查看来源会话
                          </button>
                        )
                        : null}
                    </span>
                  ) : null}
                </div>

                {selected.sourceQuestion ? (
                  <div className={css.textEmpty}>对应提问：{selected.sourceQuestion}</div>
                ) : null}

                {selected.tags.length > 0 && (
                  <>
                    <div className={css.sectionLabel}>标签（点击筛选）</div>
                    <div className={css.detailTags}>
                      {selected.tags.map(t => (
                        <button
                          key={t}
                          type="button"
                          className={css.tagChip}
                          data-on={tag === t ? '1' : undefined}
                          aria-pressed={tag === t}
                          onClick={() => { setTag(t) }}
                        >
                          #{t}
                        </button>
                      ))}
                    </div>
                  </>
                )}

                <div className={css.divider} />
                <div className={css.sectionLabel}>正文</div>
                {selected.body.trim()
                  ? (
                    <div className={css.text}>
                      {renderBody(selected.body, byTitle, setSelectedId, openCreate)}
                    </div>
                  )
                  : (
                    <div className={css.textEmpty}>
                      这条还没有正文。点「编辑」写点东西，或用 <code>[[目标]]</code> 链到别的条目。
                    </div>
                  )}

                {links.length > 0 && (
                  <>
                    <div className={css.sectionLabel}>链接（{links.length}）</div>
                    <div className={css.linkList}>
                      {links.map(l => (l.noteId !== undefined
                        ? (
                          <button
                            key={l.target}
                            type="button"
                            className={css.tagChip}
                            onClick={() => { setSelectedId(l.noteId as number) }}
                            title={`跳到「${l.display}」`}
                          >
                            → {l.display}
                          </button>
                        )
                        : (
                          <button
                            key={l.target}
                            type="button"
                            className={css.tagChip}
                            data-stub="1"
                            onClick={() => { openCreate(l.target) }}
                            title={`「${l.target}」还没有对应条目，点此新建`}
                          >
                            待补：{l.display}
                          </button>
                        )))}
                    </div>
                  </>
                )}
              </div>
            ) : loading ? null : (
              <EmptyState
                icon="🗒️"
                title="选一条看正文"
                desc="点左侧任意条目的标题，正文、标签与链接会显示在这里。"
              />
            )}
          </Card>
        </div>
      </div>

      <KnowledgeNoteEditor
        kbId={kbId}
        open={editor.open}
        {...(editor.id !== undefined ? { noteId: editor.id } : {})}
        initialTitle={editor.title ?? ''}
        initialBody={editor.body ?? ''}
        initialTags={editor.tags ?? ''}
        onClose={() => { setEditor({ open: false }) }}
        onSaved={onSaved}
      />
    </div>
  )
}
