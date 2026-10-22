/**
 * 在问答输入框上方选择检索范围。
 *
 * 会话与时间放在同一个浮层里：会话是高频入口，时间范围是同一件事的另一半。
 * 选择会话后立刻生效；时间范围由现有 `DateRangeField` 管理，调整完点「完成」收起。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import { DateRangeField, Segmented, useEscapeToClose } from '../ui/kit.tsx'
import { describeRange, type RangePresetKey } from '../utils/date-range.ts'
import { Avatar } from './chats-support.tsx'
import css from './ask-scope-picker.module.css'

const PRESETS: readonly RangePresetKey[] = ['today', 'week', 'month', 'last-7', 'last-30']

/**
 * 判断会话是否命中搜索词。
 * @param session - 待检查会话。
 * @param query - 已转小写并去空白的搜索词。
 * @returns 是否命中会话名或 username。
 */
function matchesSession(session: WechatSession, query: string): boolean {
  if (!query) return true
  return session.displayName.toLowerCase().includes(query) || session.username.toLowerCase().includes(query)
}

/**
 * 检索范围浮层。
 * @param props.open - 是否展开。
 * @param props.sessions - 可检索会话。
 * @param props.sessionsLoaded - 会话是否已加载过一轮。
 * @param props.scopeUsername - 当前选中的会话 username（空串表示全部会话）。
 * @param props.from - 起始日期。
 * @param props.to - 结束日期。
 * @param props.onReloadSessions - 展开时刷新会话列表。
 * @param props.onClose - 关闭回调；`restoreFocus` 表示焦点应回到输入框。
 * @param props.onPickSession - 选中会话（空串表示全部会话）。
 * @param props.onFrom - 写入起始日期。
 * @param props.onTo - 写入结束日期。
 * @param props.onClearTime - 清除时间范围。
 * @returns 范围选择浮层。
 */
export function AskScopePicker({
  open,
  sessions,
  sessionsLoaded,
  scopeUsername,
  from,
  to,
  onReloadSessions,
  onClose,
  onPickSession,
  onFrom,
  onTo,
  onClearTime,
}: {
  open: boolean
  sessions: readonly WechatSession[]
  sessionsLoaded: boolean
  scopeUsername: string
  from: string
  to: string
  onReloadSessions: () => void
  onClose: (restoreFocus: boolean) => void
  onPickSession: (username: string) => void
  onFrom: (value: string) => void
  onTo: (value: string) => void
  onClearTime: () => void
}): React.JSX.Element | null {
  const [tab, setTab] = useState<'sessions' | 'time'>('sessions')
  const [filter, setFilter] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const reloadRef = useRef(onReloadSessions)

  useEffect(() => { reloadRef.current = onReloadSessions }, [onReloadSessions])

  useEffect(() => {
    if (!open) return
    setTab('sessions')
    setFilter('')
    reloadRef.current()
  }, [open])

  useEscapeToClose(open, () => { onClose(true) })

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current
      if (!root || !(event.target instanceof Node) || root.contains(event.target)) return
      onClose(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true) }
  }, [open, onClose])

  const query = filter.trim().toLowerCase()
  const visibleSessions = useMemo(() => sessions.filter(s => matchesSession(s, query)), [sessions, query])
  if (!open) return null

  const sessionName = scopeUsername
    ? (sessions.find(s => s.username === scopeUsername)?.displayName || scopeUsername)
    : '全部会话'
  const rangeName = describeRange(from, to)

  return (
    <div
      ref={rootRef}
      className={css.panel}
      role="dialog"
      aria-label="选择检索范围"
      data-ask-scope-picker=""
    >
      <div className={css.head}>
        <div className={css.headText}>
          <div className={css.title}>检索范围</div>
          <div className={css.summary}>{sessionName} · {rangeName}</div>
        </div>
        <button type="button" className={css.close} onClick={() => { onClose(true) }} aria-label="关闭检索范围">×</button>
      </div>

      <div className={css.tabs}>
        <Segmented
          value={tab}
          onChange={(value) => { setTab(value === 'time' ? 'time' : 'sessions') }}
          ariaLabel="检索范围类型"
          options={[
            { value: 'sessions', label: '会话' },
            { value: 'time', label: '时间' },
          ]}
        />
      </div>

      <div className={css.body}>
        {tab === 'sessions' ? (
          <>
            <div className={css.search}>
              <svg className={css.searchIcon} viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-4-4" />
              </svg>
              <input
                className={css.searchInput}
                value={filter}
                onChange={(event) => { setFilter(event.target.value) }}
                placeholder="搜索会话名或微信号"
                aria-label="搜索会话"
              />
            </div>
            <div className={css.sectionHint}>
              {query ? `找到 ${visibleSessions.length} 个会话` : `共 ${sessions.length} 个会话可检索`}
            </div>
            <button
              type="button"
              className={css.row}
              data-active={scopeUsername === '' ? '' : undefined}
              onClick={() => { onPickSession('') }}
            >
              <span className={css.rowIcon} aria-hidden="true">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3 2 8l10 5 10-5-10-5Z" />
                  <path d="m2 16 10 5 10-5" />
                  <path d="m2 12 10 5 10-5" />
                </svg>
              </span>
              <span className={css.rowText}>
                <span className={css.rowName}>全部会话</span>
                <span className={css.rowMeta}>不限定会话，搜索全部本机聊天记录</span>
              </span>
              {scopeUsername === '' && <CheckMark />}
            </button>

            {!sessionsLoaded && <div className={css.loading} role="status">正在读取会话…</div>}
            {sessionsLoaded && visibleSessions.length === 0 && (
              <div className={css.empty}>{query ? '没有匹配的会话' : '暂无可检索会话'}</div>
            )}
            {visibleSessions.map(session => (
              <button
                key={session.username}
                type="button"
                className={css.row}
                data-active={scopeUsername === session.username ? '' : undefined}
                onClick={() => { onPickSession(session.username) }}
              >
                <Avatar name={session.displayName || session.username} username={session.username} size={28} />
                <span className={css.rowText}>
                  <span className={css.rowName}>{session.displayName || session.username}</span>
                  <span className={css.rowMeta}>{session.type === 'group' ? '群聊会话' : '单聊会话'}</span>
                </span>
                <span className={css.kind} data-kind={session.type}>{session.type === 'group' ? '群聊' : '单聊'}</span>
                {scopeUsername === session.username && <CheckMark />}
              </button>
            ))}
          </>
        ) : (
          <div className={css.timeBody}>
            <button
              type="button"
              className={css.row}
              data-active={!from && !to ? '' : undefined}
              onClick={() => { onClearTime(); onClose(true) }}
            >
              <span className={css.rowIcon} aria-hidden="true">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3 2" />
                </svg>
              </span>
              <span className={css.rowText}>
                <span className={css.rowName}>全部时间</span>
                <span className={css.rowMeta}>不限时间范围</span>
              </span>
              {!from && !to && <CheckMark />}
            </button>
            <DateRangeField
              from={from}
              to={to}
              onFrom={onFrom}
              onTo={onTo}
              onClear={onClearTime}
              presets={PRESETS}
              ariaLabel="检索时间范围"
              idFrom="ask-scope-from"
              idTo="ask-scope-to"
            />
          </div>
        )}
      </div>

      <div className={css.foot}>
        <span className={css.footHint}>条件即时生效，后续提问会按当前范围检索</span>
        <button type="button" className={css.done} onClick={() => { onClose(true) }}>完成</button>
      </div>
    </div>
  )
}

/** 当前选中行的勾选标记。 */
function CheckMark(): React.JSX.Element {
  return (
    <svg className={css.check} viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12 4 4L19 6" />
    </svg>
  )
}
