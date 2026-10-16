/**
 * ClawBot 接入会话视图（M-B）。
 *
 * 数据流：后端 `clawbot_message`（`listClawbotMessages`，服务端过滤 + 分页）→
 * `usePagedList` 增量挂载；实时靠 `dsh-clawbot-message` 事件（`ui-entry.tsx` 转发的
 * `clawbot/message`，载荷只带 `{ lastId, delta }`）**非破坏性刷新**（`pager.refresh()`
 * 保留已加载条数与滚动位置）。
 *
 * 布局（B1 三区化）：筛选条（工具 + 导出 + 统计同条）→ 消息列表（唯一滚动容器）→
 * 底部发送坞（输入永在视口内；未绑定时内嵌「去绑定微信」）。几何由 clawbot-layout.spec.ts 守。
 *
 * 三条纪律与操作日志同源：
 * 1. 关键词**服务端过滤**（客户端过滤等于只搜已加载的那几页）；
 * 2. 读失败（`readError`）与「还没有会话」分开显示；
 * 3. 打码只在**展示层**（`maskSensitiveText`），库里与导出文件里都是原文。
 *
 * @module panels/clawbot-chat
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClawbotBindingSnapshot, ClawbotMessage, ClawbotMessageQuery } from '@deepseek-ai/dsh-wechat-data/types'
import { apiGetPrivacyState, apiListClawbotMessages, apiSendClawbotMessage } from '../api.ts'
import { desktopActionProps } from '../ui/desktop-only.tsx'
import { Badge, Card, DataTable, DateRangeField, Dialog, EmptyState, SearchInput, Segmented, useDebouncedValue } from '../ui/kit.tsx'
import type { DataColumn } from '../ui/kit.tsx'
import { ListSentinel, useLazySentinel, usePagedList, useTransientNotice } from './hooks.tsx'
import { maskSensitiveText } from './clawbot-mask.ts'
import { ClawbotThread, MediaCell, useClawbotMediaAccess, useConversationScroll } from './clawbot-thread.tsx'
import css from './clawbot.module.css'

const PAGE_SIZE = 100

/** 距底这个像素数内算「贴在底部」（贴底语义的判定带）。 */
const DIR_FILTERS: ReadonlyArray<{ value: '' | 'in' | 'out', label: string }> = [
  { value: '', label: '全部' },
  { value: 'in', label: '收' },
  { value: 'out', label: '发' },
]

function ymd(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function msgTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 导出文件的下载（与操作日志同款：客户端拼装 + Blob）。 */
function download(name: string, mime: string, content: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/**
 * 导出当前**已加载**的会话（模块级：让 `ClawbotChatView` 留在 250 行棘轮线内）。
 *
 * 只导出列表里已有的行（不是全库）—— 与界面上的「已加载 N 条」同一口径，
 * 免得用户以为导出的是全部。返回提示文案，由调用方 flash（本函数不碰 UI 状态）。
 * @param rows - 当前列表里的行（已按筛选与排序显示的那些）。
 * @param kind - txt（制表符分隔）或 csv（带 BOM，Excel 不乱码）。
 * @returns 给用户看的提示。
 */
function exportMessages(rows: readonly ClawbotMessage[], kind: 'txt' | 'csv'): string {
  const headerCols = ['时间', '方向', '类型', '正文']
  const lines = rows.map(r => [msgTime(r.ts), r.direction === 'in' ? '收到' : '发出', r.msgType ?? 'text', r.content])
  if (kind === 'txt') {
    const body = [headerCols.join('\t')].concat(lines.map(l => l.join('\t'))).join('\n')
    download(`ClawBot接入会话_${stamp()}.txt`, 'text/plain;charset=utf-8', 'ClawBot 接入会话（本机导出）\n' + body)
  } else {
    const body = [headerCols.join(',')].concat(lines.map(l => l.map(c => csvCell(c)).join(','))).join('\n')
    // CSV 带 BOM：Excel 打开不乱码（与操作日志同款）。
    download(`ClawBot接入会话_${stamp()}.csv`, 'text/csv;charset=utf-8', '\ufeff' + body)
  }
  return `✓ 已导出当前已加载的 ${String(rows.length)} 条`
}

/**
 * 五列定义（B1 列宽口径；模块级：同上，让组件本体不越棘轮线）。
 *
 * 时间 14 字符 ≈ 92 + 24 = 116 → 120；方向徽标 ≈ 40 + 24 = 64；
 * 类型 5 字符 ≈ 33 + 24 = 57 → 76；字数 3 位 + 24 → 56。
 * **正文列不设宽度**：table-layout: fixed 下未指定的列平分剩余宽度，
 * 它是唯一未指定列 ⇒ 吃掉全部余量（修 P3「五列均分、正文仅 1/5」）。
 * C0（2026-10-13）：五列在所有档位全显，不再分档隐藏 —— 旧机制用 display:none 藏单元格，
 * 却移除不了 colgroup 的 col 宽度，真机实测把正文列压到 52px（见 clawbot.module.css 的反转记录）；
 * 窄面板下整表经 .detailWrap 横滚（G8）。
 * @param show - 展示层打码（库里与导出仍是原文）。
 * @param media - 附件取数句柄（点开才取）。
 * @returns DataTable 的列定义。
 */
function buildColumns(
  show: (text: string) => string,
  media: ReturnType<typeof useClawbotMediaAccess>,
): ReadonlyArray<DataColumn<ClawbotMessage>> {
  return [
    {
      id: 'time',
      header: '时间',
      className: css.tdTime,
      width: 120,
      cell: r => <span className={css.tdTime}>{msgTime(r.ts)}</span>,
      sortValue: r => r.ts,
    },
    {
      id: 'direction',
      header: '方向',
      className: css.tdDir,
      width: 64,
      cell: r => (r.direction === 'in' ? <Badge tone="default">收到</Badge> : <Badge tone="cyan">发出</Badge>),
      sortValue: r => r.direction,
    },
    {
      id: 'type',
      header: '类型',
      className: css.tdType,
      width: 76,
      cell: r => <span className={css.mono}>{r.msgType ?? 'text'}</span>,
      sortValue: r => r.msgType ?? 'text',
    },
    {
      id: 'content',
      header: '正文',
      cell: (r) => (r.media === null
        ? <span className={css.textBody} title={show(r.content)}>{show(r.content)}</span>
        : <MediaCell row={r} media={media} text={show(r.content)} />),
      sortValue: r => r.content,
    },
    {
      id: 'chars',
      header: '字数',
      className: css.tdChars,
      width: 56,
      cell: r => <span className={css.mono}>{r.content.length > 0 ? r.content.length : '—'}</span>,
      sortValue: r => r.content.length,
    },
  ]
}

function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function ClawbotChatView({ snapshot, slot, onGoSettings }: {
  /** 当前实例的绑定卡片快照（未绑定/未选实例时为 null）。 */
  snapshot: ClawbotBindingSnapshot | null
  /** 当前实例编号（多实例）：查询、发送与实时事件都按它分。 */
  slot: number | null
  onGoSettings: () => void
}): React.JSX.Element {
  const notice = useTransientNotice()

  /** 默认只看最近 7 天（D-13）：大实例首屏不把全部历史拉回来。 */
  const [from, setFrom] = useState(() => ymd(new Date(Date.now() - 6 * 86_400_000)))
  const [to, setTo] = useState(() => ymd(new Date()))
  const [dir, setDir] = useState<'' | 'in' | 'out'>('')
  const [search, setSearch] = useState('')
  const [readError, setReadError] = useState('')
  /** 「敏感字段打码」开关（仅影响展示层；库里与导出文件都是原文）。 */
  const [redact, setRedact] = useState(false)
  /** 发送框（可发可收：正文 = 你写的原文，逐条主动触发）。 */
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  /** 附件取数（点开才取；结果按行 id 缓存）—— 状态与回调收在 hook 里。 */
  const media = useClawbotMediaAccess(notice)
  /** 读法：对话（默认，气泡时间线）| 明细（表格，服务检索/排序/审计）。 */
  const [reading, setReading] = useState<'thread' | 'detail'>('thread')

  const kw = useDebouncedValue(search, 250).trim()

  useEffect(() => {
    // 取一次打码开关。面板重挂载会重新取；在别的面板改了开关、这里不实时跟（D-10 只要求展示层打码生效）。
    void apiGetPrivacyState().then(s => { setRedact(s.redactSensitive) }).catch(() => { /* 取不到就按不打码显示 */ })
  }, [])

  const buildQuery = useCallback((offset: number, limit: number): ClawbotMessageQuery => {
    const q: ClawbotMessageQuery = { limit, offset }
    if (from !== '') q.from = new Date(`${from}T00:00:00`).getTime()
    if (to !== '') q.to = new Date(`${to}T23:59:59`).getTime()
    if (dir !== '') q.direction = dir
    if (kw !== '') q.q = kw
    // 会话按实例分家：漏了 slot 就会读到「缺省实例」的会话（多实例下这是最隐蔽的错位）。
    if (slot !== null) q.slot = slot
    return q
  }, [from, to, dir, kw, slot])

  const pager = usePagedList<ClawbotMessage>({
    pageSize: PAGE_SIZE,
    fetchPage: async (offset, limit) => {
      const snap = await apiListClawbotMessages(buildQuery(offset, limit))
      // 读失败 ≠ 没有会话：把 readError 透传到界面上方的错误条（W3-11.4 同款纪律）。
      setReadError(snap.readError ?? '')
      if (snap.maxId > 0) {
        try { localStorage.setItem('clawbot.lastId', String(snap.maxId)) } catch { /* 存储不可用只是丢续传位置 */ }
      }
      return { items: snap.items, total: snap.total }
    },
  })

  // 筛选条件变化 ⇒ 从头拉（reset 会把列表置空、回到顶部；那是对的：筛选变了就该回去）。
  useEffect(() => {
    pager.reset()
  }, [buildQuery, pager.reset])

  // 实时：事件只当幂等提示（载荷不含正文），收到后非破坏性刷新 ——
  // refresh() 按**已加载条数**重取且不清空列表，新增消息出现在顶部、滚动位置不被弹回。
  useEffect(() => {
    const on = (e: Event): void => {
      // 载荷带 slot（多实例判别位）：别的实例来消息时**不动**当前列表。
      const d = (e as CustomEvent<{ slot?: number } | null>).detail
      if (slot !== null && d !== null && typeof d.slot === 'number' && d.slot !== slot) return
      pager.refresh()
    }
    window.addEventListener('dsh-clawbot-message', on)
    return () => { window.removeEventListener('dsh-clawbot-message', on) }
  }, [pager.refresh, slot])

  const rows = pager.items
  const scroll = useConversationScroll(rows.length)

  const loadMoreRef = useLazySentinel(
    () => {
      if (!pager.hasMore || pager.loadingMore) return
      // 对话读法下更旧的页追加在**顶部**：记住当前高度，行集落地后补回 scrollTop。
      scroll.beginLoadMore()
      pager.loadMore()
    },
    '600px 0px',
    () => scroll.scrollRef.current,
    pager.items.length,
  )

  const notBound = (snapshot?.binding.status ?? 'unbound') !== 'bound'

  /**
   * 发送一条消息到微信（可发可收的唯一入口）。
   *
   * 正文按原文发送（打码只是展示层开关，不改发出去的字节）；失败时**保留草稿**
   * 并把后端给出的可读原因提示出来（未绑定 / 还没有会话令牌 / 服务端拒绝 / 网络错）。
   */
  const send = useCallback(async (): Promise<void> => {
    const text = draft.trim()
    if (text === '' || sending) return
    setSending(true)
    try {
      // 从**当前实例**发（多实例下漏掉 slot 会把消息发到缺省那个号上）。
      const r = await apiSendClawbotMessage(slot === null ? { text } : { text, slot })
      if (!r.ok) {
        notice.flash('✗ ' + (r.error ?? '发送失败'))
        return
      }
      setDraft('')
      pager.refresh()
    } catch (e) {
      notice.flash('✗ 发送失败：' + (e as Error).message)
    } finally {
      setSending(false)
    }
  }, [draft, sending, notice, pager, slot])

  const show = useCallback((text: string): string => (redact ? maskSensitiveText(text) : text), [redact])

  const exportRows = useCallback((kind: 'txt' | 'csv'): void => {
    notice.flash(exportMessages(rows, kind))
  }, [rows, notice])

  const cols: ReadonlyArray<DataColumn<ClawbotMessage>> = useMemo(() => buildColumns(show, media), [show, media])

  return (
    <>
      <Card className={css.card}>
        <div className={css.filterRow}>
          <div className={css.filterLeft}>
            <DateRangeField
              from={from}
              to={to}
              onFrom={setFrom}
              onTo={setTo}
              onClear={() => { setFrom(''); setTo('') }}
              presets={['today', 'week', 'month', 'last-7', 'last-30']}
              ariaLabel="接入会话时间筛选"
            />
            <Segmented
              options={DIR_FILTERS.map(f => ({ value: f.value, label: f.label }))}
              value={dir}
              onChange={(v) => { setDir(v as '' | 'in' | 'out') }}
              ariaLabel="收 / 发筛选"
            />
            <SearchInput className={css.searchFlex} value={search} onChange={setSearch} placeholder="搜索消息正文…" ariaLabel="搜索接入会话" />
          </div>
          <div className={css.filterRight}>
            <Segmented
              options={[{ value: 'thread', label: '对话' }, { value: 'detail', label: '明细' }]}
              value={reading}
              onChange={(v) => { setReading(v === 'detail' ? 'detail' : 'thread') }}
              ariaLabel="会话读法（对话 / 明细）"
            />
            <Button size="sm" variant="outline" onClick={() => { exportRows('txt') }} disabled={rows.length === 0}>导出 TXT</Button>
            <Button size="sm" variant="outline" onClick={() => { exportRows('csv') }} disabled={rows.length === 0}>导出 CSV</Button>
            <span className={css.stats}>共 {pager.total} 条 · 已加载 {rows.length} 条</span>
            <span className={css.live}>● 实时</span>
          </div>
        </div>
        {notice.notice && <div className={css.noticeOk}>{notice.notice}</div>}
      </Card>

      {readError !== '' && <div className={css.noticeErr} role="alert">⚠️ {readError}</div>}

      <Card className={css.tableCard} flush>
        <div ref={scroll.scrollRef} className={css.msgList} onScroll={scroll.onScroll}>
          {/* 对话读法下更旧的页在顶部 ⇒ 哨兵摆最前；明细读法（倒序表）更旧的在底部 ⇒ 摆最后。 */}
          {reading === 'thread' && pager.hasMore && <ListSentinel refFn={loadMoreRef} />}
          <div ref={scroll.contentRef}>
            {reading === 'thread'
              ? (rows.length === 0
                ? (
                  <EmptyState
                    title={pager.loading ? '加载中…' : readError !== '' ? '接入会话读不出来' : '还没有接入会话'}
                    desc={readError !== '' ? undefined : (notBound ? '在「集成设置」完成微信绑定后，用微信发一条消息试试。' : '用微信给 Super Time 发一条消息试试。')}
                  />
                  )
                : <ClawbotThread rows={rows} show={show} media={media} />)
              : (
                <DataTable
                  columns={cols}
                  rows={rows}
                  getRowId={r => String(r.id)}
                  scroll={false}
                  loading={pager.loading && rows.length === 0}
                  emptyTitle={pager.loading ? '加载中…' : readError !== '' ? '接入会话读不出来' : '还没有接入会话'}
                  emptyDesc={readError !== '' ? undefined : (notBound ? '在「集成设置」完成微信绑定后，用微信发一条消息试试。' : '用微信给 Super Time 发一条消息试试。')}
                />
                )}
          </div>
          {reading === 'detail' && pager.hasMore && <ListSentinel refFn={loadMoreRef} />}
          {scroll.pendingNew > 0 && (
            <button
              type="button"
              className={css.newFloat}
              onClick={() => { scroll.scrollToEnd(); scroll.clearPending() }}
            >
              {scroll.pendingNew} 条新消息 ↓
            </button>
          )}
        </div>
      </Card>

      <Card className={css.card}>
        <div className={css.composerCol}>
          <div className={css.composerRow}>
            {/* P9：多实例下发送坞必须明说「以哪个号发送」，否则用户可能以为在 A 号回复、实际发到 B 号。 */}
            <span className={css.dockSlot} title="当前实例（消息以它的名义发送）">实例 {slot ?? '—'}</span>
            <input
              className={css.composerInput}
              value={draft}
              onChange={(e) => { setDraft(e.target.value) }}
              onKeyDown={(e) => {
                // 中文输入法组字期间的回车只确认候选，不发送。
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void send() }
              }}
              placeholder={notBound ? '完成绑定后可以从这里回复微信' : '给微信发一条消息（回车发送）…'}
              disabled={notBound || sending} {...desktopActionProps()}
              aria-label="发送到微信的消息"
            />
            <Button size="sm" variant="primary" disabled={notBound || sending || draft.trim() === ''} onClick={() => { void send() }} {...desktopActionProps()}>
              {sending ? '发送中…' : '发送'}
            </Button>
            {notBound && <Button size="sm" variant="outline" className={css.dockAction} onClick={onGoSettings}>去绑定微信</Button>}
          </div>
          <span className={css.muted}>发送经腾讯服务中转；需先在微信里给它发过消息</span>
        </div>
      </Card>

      {media.zoom !== null && (
        <Dialog open onClose={() => { media.setZoom(null) }} title={media.zoom.name ?? '图片预览'} className={css.mediaZoomDialog}>
          <img className={css.mediaZoom} src={media.zoom.src} alt="附件大图" />
        </Dialog>
      )}
    </>
  )
}
