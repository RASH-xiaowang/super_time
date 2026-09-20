/**
 * 问答历史弹窗 —— 「微信问答」页签的**历史记录**入口。
 *
 * ── 数据从哪来 ──────────────────────────────────────────────
 * 全部由**后端**在每次回答产出的那一刻自动落库（`query/ask-history.ts` +
 * 网关的 `saveAskHistory`）。本组件只读、只删，不写入 —— 前端只持有当前线程的
 * turns（清空对话即丢、关窗即没），靠它存历史必然漏掉「问了、看了、关窗」这一整类场景。
 *
 * ── 这个弹窗要回答的三个问题 ────────────────────────────────
 *  ① 「我上次问了什么」—— 问题用最高对比度放在每条的主行位；
 *  ② 「当时答上了没有」—— 状态徽标区分「已回答 / 未检索到 / 未采用」，
 *     而不是让用户对着一堆同样的记录猜哪条是空的；
 *  ③ 「还能不能回到原文」—— 消息引用可点击跳转到会话（与问答面板同一条回调链路）；
 *     知识库文件引用在这里**只读**（本弹窗没有「切到知识库·文件」的出口，
 *     而把它当会话跳转会去开一个不存在的会话，且不报错），要点开请回问答面板。
 *
 * 两条刻意的取舍：
 *  · 引用在这里是**只读清单**（2 列小按钮），不复用问答面板那套带接地告警的 `CiteList`：
 *    历史不需要把当初的回答再审计一遍，需要的只是「能不能跳过去」。
 *  · 删除（单条 / 全部）都走应用内确认框；「清空全部」在记录量级较大时要求**逐字输入**
 *    确认文本（不可恢复 + 影响面大），量小时不设这道门槛（否则删 3 条也要打一遍字）。
 */
import { useCallback, useEffect, useState } from 'react'
import { ListSentinel, ListSkeleton, useLazySentinel, usePagedList, useTransientNotice } from './hooks.tsx'
import { apiClearAskHistory, apiDeleteAskHistory, apiGetAskHistory } from '../api.ts'
import type { AskHistoryEntry, AskHistoryQuery, AskHistoryStatus } from '@deepseek-ai/dsh-wechat-data/types'
import { citeTarget } from './cite-target.ts'
import { Badge, Dialog, EmptyState, SearchInput, Segmented, useDebouncedValue } from '../ui/kit.tsx'
import { useConfirm } from '../ui/confirm.tsx'
import css from './ask-history.module.css'

/** 状态 → 中文标签 + 色调 + 一句话解释（回看历史时最需要知道的就是「这条当时答上了没有」）。 */
const STATUS_META: Record<AskHistoryStatus, { label: string; tone: 'green' | 'amber' | 'purple' | 'red'; hint: string }> = {
  ok: { label: '已回答', tone: 'green', hint: '回答至少引用了一条原文' },
  insufficient: { label: '未检索到', tone: 'amber', hint: '本机记录里没有相关原文，未调用模型' },
  withheld: { label: '未采用', tone: 'purple', hint: '模型内容无法对应到任何原文，已不予采用' },
  fail: { label: '失败', tone: 'red', hint: '这次问答没能完成' },
}

/** 入口来源的中文名。未知来源原样显示（后端可能先于前端新增来源）。 */
const SRC_LABEL: Record<string, string> = { ask: '微信问答', session: '会话内问答' }

const STATUS_TABS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部' },
  { value: 'ok', label: '已回答' },
  { value: 'insufficient', label: '未检索到' },
  { value: 'withheld', label: '未采用' },
]

const SRC_TABS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部来源' },
  { value: 'ask', label: '微信问答' },
  { value: 'session', label: '会话内' },
]

/** 「清空全部」要求逐字确认的记录条数门槛：低于它只做普通二次确认。 */
const CLEAR_CONFIRM_THRESHOLD = 100
/** 逐字确认要输入的文本。 */
const CLEAR_CONFIRM_TEXT = '清空'

/** 时间显示：今天只给时钟（更易读），其余给完整本地时间。 */
function fmtTime(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return sameDay ? `今天 ${clock}` : d.toLocaleString('zh-CN', { hour12: false })
}

/** 展开区的元信息行：模型 / 意图 / 检索词 / 耗时。 */
function metaOf(it: AskHistoryEntry): string {
  const parts: string[] = []
  if (it.model) parts.push(`模型 ${it.model}`)
  if (it.intent) parts.push(`意图 ${it.intent}`)
  if (it.terms.length > 0) parts.push(`检索词 ${it.terms.join(' / ')}`)
  if (it.elapsedMs > 0) parts.push(`耗时 ${it.elapsedMs} ms`)
  return parts.join(' · ')
}

/**
 * 问答历史弹窗。
 * @param props.open - 是否显示。
 * @param props.onClose - 关闭回调。
 * @param props.onOpenCitation - 点击引用跳转原文（与问答面板同一条链路）。
 * @param props.onAskAgain - 把某条历史的问题交回面板（面板负责填入输入框，**不**自动发送）。
 * @returns 弹窗元素。
 */
export function AskHistoryDialog({ open, onClose, onOpenCitation, onAskAgain }: {
  open: boolean
  onClose: () => void
  onOpenCitation?: (username: string, localId?: number) => void
  onAskAgain?: (question: string) => void
}): React.JSX.Element {
  const [rawQ, setRawQ] = useState('')
  const q = useDebouncedValue(rawQ, 250)
  const [status, setStatus] = useState('')
  const [source, setSource] = useState('')
  /** 当前展开的记录 id（同时只展开一条：展开态是「看细节」，不是「多选」）。 */
  const [openId, setOpenId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const { notice, flash, hold, clear } = useTransientNotice<{ text: string; error?: boolean }>(4000)
  const confirm = useConfirm()
  const [counts, setCounts] = useState<{ total: number; status: Record<string, number>; source: Record<string, number> }>({
    total: 0, status: {}, source: {},
  })

  /**
   * 关闭后复位筛选。
   *
   * 为什么不放在「打开时」复位：那会在 q/status/source 的依赖 effect 之外再触发一轮
   * 状态变化，打开一次要打两次请求（先按旧筛选取、再按空筛选取）。放在关闭时复位，
   * 下次打开时 deps 已经是最新值，只打一次。
   */
  useEffect(() => {
    if (open) return
    setRawQ(''); setStatus(''); setSource(''); setOpenId(null); clear()
  }, [open, clear])

  const buildQuery = useCallback((offset: number, limit: number): AskHistoryQuery => {
    const query: AskHistoryQuery = { limit, offset, sort: 'ts', order: 'desc' }
    if (q.trim() !== '') query.q = q.trim()
    if (status !== '') query.status = status as AskHistoryStatus
    if (source !== '') query.sources = [source]
    return query
  }, [q, status, source])

  const { items, total, loading, loadingMore, error, hasMore, loadMore, reset } = usePagedList<AskHistoryEntry>({
    pageSize: 50,
    fetchPage: async (offset, limit) => {
      const snap = await apiGetAskHistory(buildQuery(offset, limit))
      // 聚合计数每次都用**当前筛选**的结果刷新（后端按未分页的命中集合算），
      // 否则页签上的数字会随翻页变化。
      setCounts({ total: snap.total, status: snap.statusCounts, source: snap.sourceCounts })
      return { items: snap.items, total: snap.total }
    },
  })

  // 打开或筛选变化 → 回到第一页重取（并收起展开态：跨筛选保留展开会让用户对着
  // 一条已经不在当前结果里的记录读细节）。
  useEffect(() => {
    if (!open) return
    setOpenId(null)
    reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, q, status, source])

  const loadMoreRef = useLazySentinel(() => { if (hasMore && !loadingMore) loadMore() }, '400px 0px')

  const toggleOpen = useCallback((id: number): void => {
    setOpenId(cur => (cur === id ? null : id))
  }, [])

  /** 删除单条：只删本机这条历史，不动聊天数据 —— 文案里必须说清，否则用户不敢点。 */
  const removeOne = useCallback(async (id: number): Promise<void> => {
    if (busy) return
    const ok = await confirm({
      title: '删除这条问答记录？',
      message: '只删除本机保存的这条历史记录，不会影响聊天数据与已生成的内容。',
      tone: 'danger',
      confirmText: '删除',
    })
    if (!ok) return
    setBusy(true)
    try {
      const r = await apiDeleteAskHistory({ ids: [id] })
      setOpenId(null)
      flash({ text: `已删除 ${r.removed} 条记录` })
      reset()
    } catch (e) {
      hold({ text: '删除失败：' + (e as Error).message, error: true })
    } finally {
      setBusy(false)
    }
  }, [busy, confirm, flash, hold, reset])

  /** 清空全部：不可恢复的动作，量级大时要求逐字输入确认文本。 */
  const clearAll = useCallback(async (): Promise<void> => {
    if (busy) return
    const heavy = total >= CLEAR_CONFIRM_THRESHOLD
    const ok = await confirm({
      title: '清空全部问答历史？',
      message: heavy
        ? `将删除本机保存的全部 ${total} 条问答记录，且不可恢复（不影响聊天数据）。请逐字输入「${CLEAR_CONFIRM_TEXT}」以确认。`
        : `将删除本机保存的全部 ${total} 条问答记录，且不可恢复（不影响聊天数据）。`,
      tone: 'danger',
      confirmText: '清空',
      ...(heavy ? { requireText: CLEAR_CONFIRM_TEXT } : {}),
    })
    if (!ok) return
    setBusy(true)
    try {
      const r = await apiClearAskHistory()
      setOpenId(null)
      flash({ text: `已清空 ${r.removed} 条记录` })
      reset()
    } catch (e) {
      hold({ text: '清空失败：' + (e as Error).message, error: true })
    } finally {
      setBusy(false)
    }
  }, [busy, confirm, flash, hold, reset, total])

  const filtered = q.trim() !== '' || status !== '' || source !== ''
  const scopeCount = counts.status['ok'] ?? 0

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="问答历史记录"
      className={css.dialogWide}
      footer={(
        <div className={css.listFoot}>
          每次问答都会自动保存到本机 · 记录只在本机，不随导出或分享外发
        </div>
      )}
    >
      <div className={css.head}>
        <div className={css.headRow}>
          <SearchInput
            className={css.searchHost}
            value={rawQ}
            onChange={setRawQ}
            placeholder="搜索问题或回答…"
            ariaLabel="搜索问答历史"
          />
          <Segmented options={STATUS_TABS} value={status} onChange={setStatus} ariaLabel="按状态筛选" />
          <Segmented options={SRC_TABS} value={source} onChange={setSource} ariaLabel="按来源筛选" />
        </div>
        <div className={css.metaRow}>
          <span className={css.metaCount}>
            {loading && items.length === 0 ? '读取中…' : `共 ${total} 条`}
            {filtered && items.length > 0 ? `（当前筛选，已回答 ${scopeCount} 条）` : ''}
          </span>
          <button
            type="button"
            className={css.dangerBtn}
            data-clear-ask-history=""
            disabled={busy || total === 0}
            onClick={() => { void clearAll() }}
            title="删除本机保存的全部问答历史（不可恢复）"
          >
            清空全部
          </button>
        </div>
        {notice && <div className={css.notice} data-error={notice.error ? '' : undefined}>{notice.text}</div>}
        {error && <div className={css.notice} data-error="">读取失败：{error}</div>}
      </div>

      {loading && items.length === 0 ? (
        <ListSkeleton rows={4} />
      ) : items.length === 0 ? (
        <div className={css.empty}>
          <EmptyState
            icon="🕘"
            title={filtered ? '没有匹配的问答记录' : '还没有问答记录'}
            desc={filtered
              ? '换个关键词，或把状态/来源筛选切回「全部」再试。'
              : '在「微信问答」里提问后，每一次问答都会自动保存在这里。'}
          />
        </div>
      ) : (
        <div className={css.list}>
          {items.map((it) => {
            const meta = STATUS_META[it.status] ?? STATUS_META.ok
            const expanded = openId === it.id
            const cites = Array.isArray(it.citations) ? it.citations : []
            const citedSet = new Set(it.citedIndexes)
            const metaText = metaOf(it)
            return (
              <div key={it.id} className={css.item} data-open={expanded || undefined}>
                <div className={css.itemTop}>
                  <span className={css.time}>{fmtTime(it.ts)}</span>
                  <Badge tone={meta.tone} title={meta.hint}>{meta.label}</Badge>
                  <span className={css.srcTag} data-src={it.source}>{SRC_LABEL[it.source] ?? it.source}</span>
                  {it.usernameName && <span className={css.scopeTag}>范围：{it.usernameName}</span>}
                  {(it.from || it.to) && (
                    <span className={css.scopeTag}>时间：{it.from || '…'} → {it.to || '…'}</span>
                  )}
                  {cites.length > 0 && (
                    <span className={css.scopeTag}>引用 {it.citedIndexes.length}/{cites.length}</span>
                  )}
                  <span className={css.itemActs}>
                    {it.question.trim() !== '' && onAskAgain && (
                      <button
                        type="button"
                        className={css.ghostBtn}
                        onClick={() => { onAskAgain(it.question) }}
                        title="把这句问填回输入框（不会自动发送，你可以先改措辞）"
                      >
                        ↗ 再问一次
                      </button>
                    )}
                    <button
                      type="button"
                      className={css.ghostBtn}
                      aria-expanded={expanded}
                      onClick={() => { toggleOpen(it.id) }}
                    >
                      {expanded ? '收起' : '展开'}
                    </button>
                    <button
                      type="button"
                      className={css.ghostBtn}
                      data-danger=""
                      disabled={busy}
                      onClick={() => { void removeOne(it.id) }}
                      title="删除这条历史记录"
                    >
                      删除
                    </button>
                  </span>
                </div>
                <div className={css.question}>{it.question.trim() !== '' ? it.question : '（未记录问题）'}</div>
                {it.answer.trim() !== ''
                  ? (expanded
                    ? <div className={css.answerFull}>{it.answer}</div>
                    : <div className={css.answer}>{it.answer}</div>)
                  : <div className={css.answer}>（这次没有产生回答）</div>}
                {expanded && it.basis && <div className={css.basis}>📄 {it.basis}</div>}
                {expanded && cites.length > 0 && (
                  <div className={css.cites}>
                    {cites.map((c, ci) => {
                      const citedMark = citedSet.has(ci + 1) || undefined
                      // 「点了去哪」与问答面板共用同一份判定（cite-target.ts），
                      // 免得两处对「什么算文件来源」的理解漂开。
                      const target = citeTarget(c)
                      if (target?.kind === 'kb') {
                        const kb = c.kb
                        const crumb = kb
                          ? [kb.page > 0 ? `第 ${kb.page} 页` : '', kb.heading].filter(Boolean).join(' · ')
                          : ''
                        return (
                          <div
                            key={`kb:${target.kbId}:${target.fileId}:${ci}`}
                            className={css.citeBtn}
                            data-src="kb"
                            data-cited={citedMark}
                            title={`知识库文件《${kb?.fileName ?? c.name}》${crumb ? ' · ' + crumb : ''} · ${c.snippet}（在「知识库 · 文件」里查看）`}
                          >
                            <span className={css.citeIdx}>[{ci + 1}]</span>
                            <span className={css.citeName} title={kb?.fileName ?? c.name}>{kb?.fileName ?? c.name}</span>
                            <span className={css.citeTime}>{kb?.fileExt ? kb.fileExt.toUpperCase() : '文件'}</span>
                            <span className={css.citeSnippet}>{crumb || c.snippet}</span>
                          </div>
                        )
                      }
                      return (
                        <button
                          key={`${c.username ?? ''}:${c.local_id ?? 0}:${ci}`}
                          type="button"
                          className={css.citeBtn}
                          data-cited={citedMark}
                          data-src={target === null ? 'unknown' : undefined}
                          onClick={() => { if (target?.kind === 'msg') onOpenCitation?.(target.username, target.localId) }}
                          title={`${c.sender ? `${c.name} · ${c.sender}` : c.name} · ${c.time} · ${c.snippet}`}
                        >
                          <span className={css.citeIdx}>[{ci + 1}]</span>
                          <span className={css.citeName}>{c.sender ? `${c.name} · ${c.sender}` : c.name}</span>
                          <span className={css.citeTime}>{c.time}</span>
                          <span className={css.citeSnippet}>{c.snippet}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
                {expanded && metaText && <div className={css.metaLine}>{metaText}</div>}
              </div>
            )
          })}
          <ListSentinel refFn={loadMoreRef} />
        </div>
      )}
    </Dialog>
  )
}
