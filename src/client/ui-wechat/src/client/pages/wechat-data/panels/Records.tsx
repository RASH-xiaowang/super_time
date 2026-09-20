/**
 * 记录面板 — 仪表盘重设计版：6 种记录类型 + Hero 头 + 类型页签 + 筛选工具栏
 * + 卡片化表格（粘性表头/斑马 hover/状态徽章）+ 分页加载 + CSV 导出 + 跳转定位。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {ListSkeleton, useTransientNotice, useWechatDataUpdated } from './hooks.tsx'
import { apiExportCsv, apiGetRecords, readRenderCache, writeRenderCache } from '../api.ts'
import { Badge, Card, DateRangeField, PanelHeader, SearchInput, Segmented, Toolbar } from '../ui/kit.tsx'
import css from './records.module.css'
import { fmtDateTimeSec } from '../utils/format.ts'
import kitCss from '../ui/kit.module.css'

type Kind = 'revokes' | 'transfers' | 'redpackets' | 'finder' | 'miniprograms' | 'friendverifications'

const KIND_META: Record<Kind, { label: string; desc: string; icon: string }> = {
  revokes: { label: '撤回消息', desc: '本地撤回缓存记录，点击会话可跳转定位', icon: '↩️' },
  transfers: { label: '转账记录', desc: '微信转账明细，点击会话可跳转', icon: '💳' },
  redpackets: { label: '红包记录', desc: '微信红包明细，点击会话可跳转', icon: '🧧' },
  finder: { label: '视频号', desc: '视频号直播 / 用户页记录', icon: '📺' },
  miniprograms: { label: '小程序', desc: '已使用的小程序联系人', icon: '🧩' },
  friendverifications: { label: '好友验证', desc: '新朋友 / 好友验证消息', icon: '👥' },
}

const KINDS: ReadonlyArray<Kind> = ['revokes', 'transfers', 'redpackets', 'finder', 'miniprograms', 'friendverifications']

/**
 * 后端会**故意忽略**的类型词（见 `query/records.ts` 的 `isRecordTypeStopword`）：
 * 它们是「数据源的名字」而不是记录内容，若拿去当关键词会把结果清空。
 *
 * 为什么要在本端再列一份：用户看到的现象是「输了「转账」却没有任何筛选」，
 * 不解释就会被当成搜索坏了。这里给出明确说明。两份清单由
 * `records-stopword.wiring.spec.ts` 守着，改一处忘另一处会转红。
 */
const TYPE_STOPWORDS: readonly string[] = [
  '红包', '转账', '转帐', '收款', '付款', '收红包', '发红包', '红包记录', '转账记录',
  'redpacket', 'red_packet', 'transfer', '转账明细', '红包明细',
]

const TIME_KINDS: Record<Kind, boolean> = {
  revokes: true, transfers: true, redpackets: false, finder: false, miniprograms: true, friendverifications: true,
}

interface RecordItem { [key: string]: string | number | boolean | null | undefined }
interface RecordsEnvelope { items?: RecordItem[]; total?: number }

function shortUser(u: string | number | boolean | null | undefined): string {
  const s = String(u ?? '').trim()
  if (!s) return '—'
  return s.length > 32 ? s.slice(0, 30) + '…' : s
}

function dateToTs(v: string, endOfDay: 0 | 1): number {
  if (!v) return 0
  const d = new Date(v + (endOfDay ? 'T23:59:59' : 'T00:00:00'))
  return Number.isNaN(d.getTime()) ? 0 : Math.floor(d.getTime() / 1000)
}

function transferSubType(v: string | number | boolean | null | undefined): { label: string; tone: 'info' | 'success' | 'muted' } {
  const map: Record<string, { label: string; tone: 'info' | 'success' | 'muted' }> = {
    '1': { label: '微信支付', tone: 'info' }, '2': { label: '群收款', tone: 'muted' }, '3': { label: '转账', tone: 'success' },
    '4': { label: '二维码收款', tone: 'info' }, '5': { label: '收款', tone: 'success' }, '6': { label: 'AA收款', tone: 'muted' },
    '7': { label: '面对面', tone: 'muted' }, '8': { label: '公众号支付', tone: 'info' },
  }
  return map[String(v)] ?? { label: `类型 ${String(v)}`, tone: 'muted' }
}

function hbStatus(v: string | number | boolean | null | undefined): { label: string; tone: 'success' | 'warn' | 'danger' | 'muted' } {
  const map: Record<string, { label: string; tone: 'success' | 'warn' | 'danger' | 'muted' }> = {
    '0': { label: '未知', tone: 'muted' }, '1': { label: '正常', tone: 'success' }, '2': { label: '已退回', tone: 'danger' }, '3': { label: '已领完', tone: 'warn' },
  }
  return map[String(v)] ?? { label: `状态 ${String(v)}`, tone: 'muted' }
}

function liveStatus(v: string | number | boolean | null | undefined): { label: string; tone: 'success' | 'muted' | 'info' } {
  const map: Record<string, { label: string; tone: 'success' | 'muted' | 'info' }> = {
    '1': { label: '直播中', tone: 'success' }, '2': { label: '已结束', tone: 'muted' }, '3': { label: '预告', tone: 'info' },
  }
  return map[String(v)] ?? { label: `状态 ${String(v)}`, tone: 'muted' }
}

const toneClass = (tone: string): string => `badge${tone.charAt(0).toUpperCase()}${tone.slice(1)}`

export function RecordsPanel({ onOpenChat, seedQuery }: {
  onOpenChat?: (username: string, localId?: number) => void
  seedQuery?: { q: string; nonce: number }
}): React.JSX.Element {
  /*
   * 默认子类目（第 76 轮）。
   *
   * 这个面板挂的是「转账红包」页签（`nav-config.ts`：`tab: 'records', label: '转账红包'`），
   * 但原来默认 `kind='revokes'` —— 点「转账红包」进来，页头写的是「↩️撤回消息」，
   * 页签名与内容对不上（第 76 轮页头普查实测）。
   * 现在：第一次打开默认到 `transfers`（与页签名一致），之后记住上次选的子类目。
   */
  const [kind, setKind] = useState<Kind>(() => {
    const remembered = readRenderCache<string>('records:kind')
    return (KINDS as readonly string[]).includes(remembered ?? '') ? (remembered as Kind) : 'transfers'
  })
  const [items, setItems] = useState<readonly RecordItem[]>([])
  const [total, setTotal] = useState(0)
  const [totals, setTotals] = useState<Partial<Record<Kind, number>>>({})
  const [keyword, setKeyword] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc')
  const lastQueryKeyRef = useRef('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [exporting, setExporting] = useState(false)
  // 提示语自动消失（L20）：原手写的 `setTimeout(…, 4000)` 已由 hook 统一管理。
  const { notice, flash } = useTransientNotice(4000)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const PAGE = 50
  const notify = (text: string): void => {
    flash(text)
  }

  /** 关键词恰好是类型词：后端会故意不做筛选，界面要说明，否则像「搜索坏了」。 */
  const stopwordHit = TYPE_STOPWORDS.includes(keyword.trim().toLowerCase())
  // 全局搜索的命中直接跳到本面板时，把关键词一起带过来。
  // 此前是「只切页签」—— 用户落到一份未筛选的列表上，必须把刚才输的词再打一遍。
  useEffect(() => {
    if (!seedQuery) return
    setKeyword(seedQuery.q)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedQuery?.nonce])


  const load = useCallback(async (reset: boolean): Promise<void> => {
    if (reset) setPage(0)
    setError(null)
    const cacheKey = 'records:' + kind + ':' + keyword.trim() + ':' + fromDate + ':' + toDate + ':' + direction
    if (reset) {
      const cached = readRenderCache<readonly RecordItem[]>(cacheKey)
      if (cached) {
        setItems(cached)
        setTotal(cached.length)
        setPage(0)
        setLoading(false)
      } else {
        setLoading(true)
      }
    }
    try {
      const nextPage = reset ? 0 : page + 1
      const opts: { kind: string; limit: number; offset: number; q?: string; from?: number; to?: number; direction?: 'asc' | 'desc' } = { kind, limit: PAGE, offset: nextPage * PAGE, direction }
      const term = keyword.trim()
      if (term) opts.q = term
      if (TIME_KINDS[kind]) {
        const fromTs = dateToTs(fromDate, 0)
        const toTs = dateToTs(toDate, 1)
        if (fromTs > 0) opts.from = fromTs
        if (toTs > 0) opts.to = toTs
      }
      const env = await apiGetRecords(opts)
      const list = (env as RecordsEnvelope).items ?? []
      setItems(prev => (reset ? list : [...prev, ...list]))
      const t = (env as RecordsEnvelope).total ?? list.length
      setTotal(t)
      setTotals(prev => ({ ...prev, [kind]: t }))
      setPage(nextPage)
      if (reset && list.length > 0) writeRenderCache(cacheKey, list)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [kind, page, keyword, fromDate, toDate, direction])

  const queryKey = keyword.trim() + '|' + fromDate + '|' + toDate + '|' + direction
  useEffect(() => {
    if (queryKey === lastQueryKeyRef.current) return
    lastQueryKeyRef.current = queryKey
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => { void load(true) }, 400)
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current) }
  }, [queryKey, load])

  const switchKind = (k: Kind): void => {
    if (k === kind) return
    setKind(k)
    // 记住上次看的子类目（下次打开「转账红包」页签回到这里）
    writeRenderCache('records:kind', k)
    setKeyword('')
    lastQueryKeyRef.current = ''
    setItems([])
    setTotal(0)
    setPage(0)
    void load(true)
  }

  useEffect(() => { void load(true) }, [kind])
  // 数据落地后重载：冷启动时后端同步要跑 2–3 分钟，期间首次请求可能返回空快照，
  // 页面会停在「0 / 暂无数据」而并非真的没有数据（实测该事件在同步期约每 10 秒一次）。
  // 仅在**当前还没有数据**时重载：面板一旦拿到数据就不再重复付费，
  // 也避免那几个「loading 时隐藏内容」的面板每约 10 秒白闪一次。
  useWechatDataUpdated(() => { if (items.length === 0) void load(true) })

  const doExport = async (): Promise<void> => {
    setExporting(true)
    try {
      const r = await apiExportCsv({ kind: 'records', recordsKind: kind })
      notify(`已导出 ${r.count} 条 → ${r.path}`)
    } catch (e) {
      notify('导出失败: ' + (e as Error).message)
    } finally {
      setExporting(false)
    }
  }

  const open = (username: string | number | boolean | null | undefined, localId?: string | number | boolean | null): void => {
    if (!username) return
    onOpenChat?.(String(username), localId != null ? Number(localId) : undefined)
  }

  const meta = KIND_META[kind]
  const td = (children: React.ReactNode, key: string, cls = ''): React.JSX.Element => (<td key={key} className={cls}>{children}</td>)
  const linkTd = (username: string | number | boolean | null | undefined, localId?: string | number | boolean | null, key = 's', label?: string | number | boolean | null): React.JSX.Element => (
    <td key={key}>{username ? <button type="button" className={css.link} onClick={() => { open(username, localId) }} title={String(username)}>{shortUser(label || username)}</button> : <span className={css.muted}>—</span>}</td>
  )
  const mono = (v: string | number | boolean | null | undefined, key = 'm'): React.JSX.Element => <td key={key} className={css.mono}>{v == null ? '—' : String(v)}</td>
  // 行数据来自未类型化的 DB 行，秒级时间戳可能是 number 也可能是字符串 → 统一数值化。
  // `Number(x) || null` 让 NaN/0/undefined 都走占位符，不会渲染出 Invalid Date。
  const timeTd = (ts: unknown, key = 't'): React.JSX.Element => <td key={key} className={css.muted}>{fmtDateTimeSec(Number(ts) || null)}</td>
  const badge = (label: string, tone: string, key = 'b', hint?: string): React.JSX.Element => {
    const cls = css[toneClass(tone)] ?? css.badgeMuted
    return <td key={key}><span className={`${css.badge} ${cls}`} title={hint}>{label}</span></td>
  }

  const head = (cols: string[]): React.JSX.Element => (
    <thead><tr>{cols.map(c => <th key={c}>{c}</th>)}</tr></thead>
  )

  const renderTable = (): React.JSX.Element => {
    switch (kind) {
      case 'revokes':
        return (
          <table className={css.table}>
            {head(['会话', '消息 ID', '批次 ID', '时间'])}
            <tbody>{items.map((it, i) => (<tr key={i}>{linkTd(it.session_name, it.msg_local_id, 's', it.session_display)}{mono(it.msg_local_id, 'm')}{mono(it.batch_id, 'b')}{timeTd(it.msg_create_time)}</tr>))}</tbody>
          </table>
        )
      case 'transfers':
        return (
          <table className={css.table}>
            {head(['会话', '类型', '收款方', '付款方', '时间'])}
            <tbody>{items.map((it, i) => { const st = transferSubType(it.pay_sub_type); return (<tr key={i}>{linkTd(it.session_name, undefined, 's', it.session_display)}{badge(st.label, st.tone, 'b', `pay_sub_type=${String(it.pay_sub_type)}（该 1–8 场景映射未经本机数据验证，见 docs/wechat-schema.md §B.31）`)}{td(<span className={css.muted}>{shortUser(it.receiver_display || it.pay_receiver)}</span>, 'r')}{td(<span className={css.muted}>{shortUser(it.payer_display || it.pay_payer)}</span>, 'p')}{timeTd(it.begin_transfer_time)}</tr>) })}</tbody>
          </table>
        )
      case 'redpackets':
        return (
          <table className={css.table}>
            {head(['会话', '发送者', '状态', '类型', '消息 ID'])}
            <tbody>{items.map((it, i) => { const st = hbStatus(it.hb_status); return (<tr key={i}>{linkTd(it.session_name, undefined, 's', it.session_display)}{td(<span className={css.muted}>{shortUser(it.sender_display || it.sender_user_name)}</span>, 'n')}{badge(st.label, st.tone, 'b')}{td(<span className={css.muted}>{Number(it.hb_type) === 0 ? '普通红包' : `类型 ${String(it.hb_type)}`}</span>, 't')}{mono(it.message_server_id, 'm')}</tr>) })}</tbody>
          </table>
        )
      case 'finder':
        return (
          <table className={css.table}>
            {head(['视频号', '直播状态', '回放', '直播 ID'])}
            <tbody>{items.map((it, i) => { const st = liveStatus(it.live_status); return (<tr key={i}>{td(<span className={css.muted}>{shortUser(it.username_display || it.finder_username)}</span>, 'n')}{badge(st.label, st.tone, 'b')}{td(<span className={css.muted}>{Number(it.replay_status) === 1 ? '有回放' : '—'}</span>, 'r')}{mono(it.finder_live_id, 'id')}</tr>) })}</tbody>
          </table>
        )
      case 'miniprograms':
        return (
          <table className={css.table}>
            {head(['名称', '用户名', 'AppID', '更新时间'])}
            <tbody>{items.map((it, i) => (<tr key={i}>{td(<span>{String(it.nickname ?? '') || '（未命名）'}</span>, 'n')}{td(<span className={css.muted}>{shortUser(it.user_name)}</span>, 'u')}{mono(it.app_id, 'a')}{timeTd(it.last_update_time)}</tr>))}</tbody>
          </table>
        )
      default:
        return (
          <table className={css.table}>
            {head(['用户', '备注', '验证消息', '类型', '时间'])}
            <tbody>{items.map((it, i) => { const mine = Number(it.is_sender_) === 1; return (<tr key={i}>{td(<span className={css.muted}>{shortUser(it.user_display || it.user_name_)}</span>, 'u')}{td(<span className={css.muted}>{String(it.remark_ ?? '') || '—'}</span>, 'r')}{td(<span className={css.ellipsis}>{String(it.content_ ?? '') || '—'}</span>, 'v')}{badge(mine ? '我发出的' : '收到的', mine ? 'info' : 'muted', 't')}{timeTd(it.timestamp_)}</tr>) })}</tbody>
          </table>
        )
    }
  }

  return (
    <div className={css.panel}>
      <PanelHeader
        title={<><span className={css.hdIcon}>{meta.icon}</span>{meta.label}</>}
        desc={meta.desc}
        actions={<Badge tone="cyan">共 {total.toLocaleString()} 条</Badge>}
      />

      <Toolbar
        left={(
          <Segmented
            options={KINDS.map(k => ({
              value: k,
              label: `${KIND_META[k].icon} ${KIND_META[k].label}${totals[k] != null && totals[k] > 0 ? ` (${totals[k]})` : ''}`,
            }))}
            value={kind}
            onChange={(v) => { switchKind(v as Kind) }}
            ariaLabel="记录分类"
          />
        )}
      />

      {stopwordHit && (
        <div className={css.stopwordHint} role="note">
          「{keyword.trim()}」是本类目的名称，不是记录内容 —— 已按原样列出全部记录。想筛内容请换一个词（如对方昵称）。
        </div>
      )}

      <Toolbar
        left={(
          <>
            <SearchInput value={keyword} onChange={(v) => { setKeyword(v) }} onEnter={() => { void load(true) }} placeholder="搜索会话 / 用户 / ID…" ariaLabel="搜索记录" />
            {TIME_KINDS[kind] && (
              <DateRangeField
                from={fromDate}
                to={toDate}
                onFrom={setFromDate}
                onTo={setToDate}
                onClear={() => { setFromDate(''); setToDate('') }}
                presets={['today', 'week', 'month', 'last-7', 'last-30']}
                ariaLabel="记录时间筛选"
              />
            )}
          </>
        )}
        right={(
          <>
            <Segmented
              options={[{ value: 'desc', label: '新→旧' }, { value: 'asc', label: '旧→新' }]}
              value={direction}
              onChange={(v) => { setDirection(v as 'asc' | 'desc') }}
              ariaLabel="排序方向"
            />
            <button type="button" className={css.btn} onClick={() => { void load(true) }} disabled={loading}>搜索</button>
            <button type="button" className={css.btn} onClick={() => { void doExport() }} disabled={exporting}>{exporting ? '导出中…' : '导出 CSV'}</button>
          </>
        )}
      />

      {notice && <div className={css.notice}>{notice}</div>}

      <Card flush>
        {error && <div className={kitCss.error} role="alert">⚠️ {error}</div>}
        {loading && items.length === 0 && <ListSkeleton rows={10} />}
        {!loading && !error && items.length === 0 && <div className={kitCss.emptyInline}>暂无{meta.label}记录</div>}
        {!loading && !error && items.length > 0 && (
          <div className={css.tableScroll}>{renderTable()}</div>
        )}
        {!loading && !error && items.length > 0 && items.length < total && (
          <div className={css.loadMoreWrap}>
            <button type="button" className={css.loadMore} onClick={() => { void load(false) }} disabled={loading}>
              {`加载更多（${items.length}/${total}）`}
            </button>
          </div>
        )}
      </Card>
    </div>
  )
}
