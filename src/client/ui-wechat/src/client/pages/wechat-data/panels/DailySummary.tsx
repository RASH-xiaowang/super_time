/**
 * 每日总结面板 — React 版，忠实迁移 DailySummary + DailySummaryForm：
 * 按日期生成总结 + 定时任务 CRUD（群聊选择/关注成员/分析格式/自定义提示词/
 * 定时时间/启停/复制为新任务）+ 总结阅览查看/复制/删除。走 Remote，无 HTTP。
 * 每个按钮都提供结果反馈：全局 toast（成功/失败/提示）+ 逐动作 loading 态。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  apiDeleteSummaryRecord,
  apiDeleteSummaryTask,
  apiGenerateDailySummary,
  apiGetContacts,
  apiGetLlmConfig,
  apiGetSessions,
  apiListSummaryRecords,
  apiListSummaryTasks,
  apiRunSummaryTask,
  apiSaveSummaryTask,
  apiToggleSummaryTask,
  readRenderCache,
  writeRenderCache,
} from '../api.ts'
import type { SummaryRecord, SummaryTask } from '@deepseek-ai/dsh-wechat-data/types'
import { Badge, DateField, PanelHeader, TimeField, useEscapeToClose, useDialogFocus } from '../ui/kit.tsx'
import { useConfirm } from '../ui/confirm.tsx'
import css from './daily-summary.module.css'
import { fmtLocaleMs } from '../utils/format.ts'
import kitCss from '../ui/kit.module.css'

const FORMATS: ReadonlyArray<{ key: string; label: string; desc: string }> = [
  { key: 'brief', label: '简洁总结', desc: '3–5 句话概括当天聊天的重点内容' },
  { key: 'detailed', label: '详细总结', desc: '按主题分点，包含关键事件、话题与结论' },
  { key: 'bullets', label: '要点列表', desc: '用要点列表提炼当天核心信息' },
  { key: 'story', label: '叙事总结', desc: '以第三人称叙述当天交流的来龙去脉' },
  { key: 'custom', label: '自定义格式', desc: '使用自定义提示词模板（支持 {date} {group} {targets}）' },
]

interface FormState {
  id?: number
  groupUsername: string
  groupName: string
  targetAll: boolean
  targetUsers: string[]
  format: string
  customPrompt: string
  scheduleTime: string
  enabled: boolean
}

const EMPTY_FORM: FormState = { groupUsername: '', groupName: '', targetAll: true, targetUsers: [], format: 'brief', customPrompt: '', scheduleTime: '08:00', enabled: true }

type ToastKind = 'ok' | 'err' | 'info'
interface Toast { id: number; kind: ToastKind; text: string }

interface DailyStats {
  total: number
  types: Record<string, number>
  hourly: number[]
  topSessions: Array<{ username: string; count: number }>
  sessions: number
}

/**
 * Render the daily-summary panel.
 * @returns the daily-summary element tree.
 */
export function DailySummaryPanel({ onOpenSettings }: { onOpenSettings?: (section?: string) => void } = {}): React.JSX.Element {
  /** 应用内确认框（替代原生 window.confirm）。 */
  const confirm = useConfirm()
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [result, setResult] = useState<string | null>(null)
  const [meta, setMeta] = useState('')
  const [error, setError] = useState<string | null>(null)

  const [tasks, setTasks] = useState<readonly SummaryTask[]>([])
  const [records, setRecords] = useState<readonly SummaryRecord[]>([])
  const [groups, setGroups] = useState<readonly { username: string; name: string }[]>([])
  const [members, setMembers] = useState<readonly { username: string; name: string }[]>([])
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [formOpen, setFormOpen] = useState(false)
  // 手写任务表单弹窗的 Esc 关闭
  useEscapeToClose(formOpen, () => { setFormOpen(false) })
  // 焦点管理：进入移入、Tab 循环、关闭还原
  useDialogFocus(formOpen, '[data-st-dialog="daily-form"]')
  const [previewId, setPreviewId] = useState<number | null>(null)
  const previewRef = useRef<HTMLDivElement | null>(null)
  const [view, setView] = useState<'tasks' | 'records' | 'generate'>('tasks')
  const [dailyStats, setDailyStats] = useState<DailyStats | null>(null)
  /**
   * 模型是否已配置：总结要靠模型生成，没配模型时"手动生成/定时任务"点了必然失败。
   * 空态里提前把这一步暴露出来（带一个直接去「设置 → AI 大模型」的入口），
   * 而不是等用户点了生成再报错。
   */
  const [llm, setLlm] = useState<{ provider: string; model: string } | null>(null)
  const modelReady = !!llm && llm.model.trim() !== ''

  // Toast + per-action busy feedback
  const [toasts, setToasts] = useState<readonly Toast[]>([])
  const toastSeq = useRef(0)
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set())
  const isBusy = useCallback((key: string): boolean => busyKeys.has(key), [busyKeys])
  const notify = useCallback((kind: ToastKind, text: string): void => {
    const id = ++toastSeq.current
    setToasts(prev => [...prev, { id, kind, text }])
    window.setTimeout(() => { setToasts(prev => prev.filter(t => t.id !== id)) }, 3200)
  }, [])
  const withBusy = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T> => {
    setBusyKeys((prev) => { const n = new Set(prev); n.add(key); return n })
    try { return await fn() } finally { setBusyKeys((prev) => { const n = new Set(prev); n.delete(key); return n }) }
  }, [])

  const showRecordPreview = useCallback((r: SummaryRecord): void => {
    setResult(r.summary)
    setMeta(`${r.groupUsername} / ${r.summaryDate} · ${r.messageCount} 条 · ${r.status}`)
    setPreviewId(r.id)
    setDailyStats(null)
    requestAnimationFrame(() => previewRef.current?.scrollIntoView({ block: 'start' }))
  }, [])
  const copyResult = useCallback((): void => {
    if (!result) { notify('info', '暂无可复制的总结内容'); return }
    void navigator.clipboard.writeText(result).then(() =>{  notify('ok', '已复制总结到剪贴板') }).catch(() =>{  notify('err', '复制失败') })
  }, [result, notify])

  const loadTasks = useCallback(async (): Promise<void> => {
    try {
      const t = await apiListSummaryTasks()
      setTasks(t.items)
      const r = await apiListSummaryRecords()
      setRecords(r.items)
    } catch { /* keep */ }
  }, [])

  const loadGroups = useCallback(async (): Promise<void> => {
    try {
      const cached = readRenderCache<readonly { username: string; name: string }[]>('daily-summary-groups')
      if (cached) setGroups(cached)
      const env = await apiGetSessions({ limit: 500 })
      const gs = env.sessions
        .filter(s => s.type === 'group' || s.username.endsWith('@chatroom'))
        .map(s => ({ username: s.username, name: s.displayName || s.username }))
      setGroups(gs)
      writeRenderCache('daily-summary-groups', gs)
    } catch { /* keep */ }
  }, [])

  useEffect(() => { void loadTasks() }, [loadTasks])

  // 读一次模型配置（读的是本机 llm.json，很轻）：空态要用它告诉用户"还差哪一步"。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const c = await apiGetLlmConfig()
        if (!cancelled) setLlm({ provider: c.provider, model: c.model })
      } catch {
        if (!cancelled) setLlm(null)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // 群聊列表只在使用到时才加载：打开任务表单时。
  // 模型选择已移除 —— 统一走「数据配置 → AI 大模型」里的全局默认模型。
  useEffect(() => { if (view === 'generate') void loadGroups() }, [view, loadGroups])

  const loadMembers = useCallback(async (groupUsername: string): Promise<void> => {
    setMembers([])
    if (!groupUsername) return
    try {
      const env = await apiGetContacts()
      const list = env.contacts
        .filter(c => c.category === 'member' && c.groupUsername === groupUsername)
        .map(c => ({ username: c.username, name: c.displayName || c.username }))
      setMembers(list)
    } catch { /* keep */ }
  }, [])

  const generate = async (): Promise<void> => {
    setError(null)
    await withBusy('generate', async () => {
      try {
        const res = await apiGenerateDailySummary({ date })
        setResult(res.summary)
        setMeta(`覆盖 ${res.sessions} 个会话 / ${res.messages} 条消息`)
        setDailyStats({ total: res.total, types: res.types, hourly: res.hourly, topSessions: res.topSessions, sessions: res.sessions })
        notify('ok', `总结已生成：覆盖 ${res.sessions} 个会话 / ${res.messages} 条消息`)
        requestAnimationFrame(() => previewRef.current?.scrollIntoView({ block: 'start' }))
      } catch (e) {
        setError((e as Error).message)
        notify('err', (e as Error).message || '生成失败')
      }
    })
  }

  const openNew = (): void => { setForm({ ...EMPTY_FORM }); setFormOpen(true); void loadGroups() }

  const formFromTask = (t: SummaryTask, withId: boolean): FormState => {
    const base: FormState = {
      groupUsername: t.groupUsername,
      groupName: t.groupName || t.groupUsername,
      targetAll: t.targetUsers.length === 0,
      targetUsers: t.targetUsers,
      format: t.format || 'brief',
      customPrompt: t.customPrompt || '',
      scheduleTime: t.scheduleTime || '08:00',
      enabled: t.enabled,
    }
    if (withId) base.id = t.id
    return base
  }

  const openEdit = (t: SummaryTask): void => {
    setForm(formFromTask(t, true))
    setFormOpen(true)
    void loadGroups()
    void loadMembers(t.groupUsername)
  }
  const duplicate = (t: SummaryTask): void => {
    setForm(formFromTask(t, false))
    setFormOpen(true)
    void loadGroups()
    void loadMembers(t.groupUsername)
  }

  const toggleTarget = (username: string): void => {
    setForm((f) => {
      const has = f.targetUsers.includes(username)
      return { ...f, targetUsers: has ? f.targetUsers.filter(u => u !== username) : [...f.targetUsers, username] }
    })
  }

  const saveTask = async (): Promise<void> => {
    if (!form.groupUsername.trim()) return
    await withBusy('save', async () => {
      setError(null)
      try {
        const task: Omit<SummaryTask, 'id' | 'createdAt' | 'updatedAt'> & { id?: number } = {
          groupUsername: form.groupUsername.trim(),
          groupName: form.groupName.trim() || form.groupUsername.trim(),
          targetUsers: form.targetAll ? [] : form.targetUsers,
          format: form.format,
          customPrompt: form.customPrompt.trim(),
          scheduleTime: form.scheduleTime,
          enabled: form.enabled,
          lastStatus: '',
          lastError: '',
        }
        if (form.id !== undefined) task.id = form.id
        const r = await apiSaveSummaryTask({ task })
        if (!r.ok) { notify('err', r.error ?? '保存失败'); setError(r.error ?? '保存失败') }
        else { setFormOpen(false); notify('ok', form.id ? '任务已更新' : '任务已创建'); await loadTasks() }
      } catch (e) { notify('err', (e as Error).message || '保存失败') }
    })
  }

  const runTask = async (id: number): Promise<void> => {
    await withBusy(`run:${id}`, async () => {
      try {
        const r = await apiRunSummaryTask({ id })
        if (!r.ok) notify('err', r.error ?? '运行失败')
        else notify('ok', r.messageCount != null ? `运行成功，生成 ${r.messageCount} 条消息总结` : '运行成功')
        await loadTasks()
      } catch (e) { notify('err', (e as Error).message || '运行失败') }
    })
  }

  const toggleTask = async (id: number, enabled: boolean): Promise<void> => {
    await withBusy(`toggle:${id}`, async () => {
      try {
        await apiToggleSummaryTask({ id, enabled })
        notify('ok', enabled ? '任务已启用' : '任务已停用')
        await loadTasks()
      } catch (e) { notify('err', (e as Error).message || '操作失败') }
    })
  }

  const copyRecord = async (r: SummaryRecord): Promise<void> => {
    await withBusy(`copy:${r.id}`, async () => {
      try {
        await navigator.clipboard.writeText(r.summary || '')
        notify('ok', '已复制总结到剪贴板')
      } catch { notify('err', '复制失败') }
    })
  }

  const deleteTask = async (id: number): Promise<void> => {
    const ok = await confirm({
      title: '删除该总结任务？',
      message: '删除后不会再自动生成总结，该操作不可撤销。',
      tone: 'danger',
    })
    if (!ok) return
    await withBusy(`del:${id}`, async () => {
      try {
        await apiDeleteSummaryTask({ id })
        notify('ok', '任务已删除')
        await loadTasks()
      } catch (e) { notify('err', (e as Error).message || '删除失败') }
    })
  }

  const deleteRecord = async (id: number): Promise<void> => {
    const ok = await confirm({
      title: '删除该总结记录？',
      message: '该操作不可撤销。',
      tone: 'danger',
    })
    if (!ok) return
    await withBusy(`delrec:${id}`, async () => {
      try {
        await apiDeleteSummaryRecord({ id })
        notify('ok', '记录已删除')
        if (previewId === id) { setResult(null); setPreviewId(null); setMeta('') }
        await loadTasks()
      } catch (e) { notify('err', (e as Error).message || '删除失败') }
    })
  }

  const avgLen = useMemo(() => (records.length > 0 ? Math.round(records.reduce((a, r) => a + (r.summary || '').length, 0) / records.length) : 0), [records])
  const isGenerating = isBusy('generate')

  const renderBusy = (key: string, idle: string, busy: string): React.ReactNode => (
    isBusy(key)
      ? <><span className={css.spin} />{busy}</>
      : idle
  )

  return (
    <div className={css.panel}>
      <PanelHeader
        title="每日总结"
        desc="定时总结任务 + 总结阅览（DSH LLM）"
        actions={(
          <>
            <Badge tone="cyan">{tasks.length} 任务</Badge>
            <Badge tone="purple">{records.length} 记录</Badge>
          </>
        )}
      />
      {error && <div className={css.errBanner}>⚠️ {error}</div>}
      {toasts.length > 0 && (
        <div className={css.toasts}>
          {toasts.map(t => (
            <div key={t.id} className={[css.toast, t.kind === 'ok' ? css.ok : t.kind === 'err' ? css.err : css.info].join(' ')}>
              <span className={css.toastDot} />
              <span>{t.text}</span>
            </div>
          ))}
        </div>
      )}
      <div className={css.tabBar}>
        <button type="button" className={css.tabBtn} data-active={view === 'tasks' || undefined} onClick={() => { setView('tasks') }}>总结任务栏</button>
        <button type="button" className={css.tabBtn} data-active={view === 'records' || undefined} onClick={() => { setView('records') }}>总结阅览</button>
        <button type="button" className={css.tabBtn} data-active={view === 'generate' || undefined} onClick={() => { setView('generate') }}>手动生成</button>
      </div>
      <div className={css.scroll}>
        {/* 全新用户（0 任务 0 记录）时，先把"怎么拿到第一份总结"讲清楚：
            总结要靠模型生成，没配模型时点生成必然失败 —— 这一步必须提前暴露。
            此前这里只有一张卡 + 一句"还没有定时任务"，下方 470px 全是空白。 */}
        {view === 'tasks' && tasks.length === 0 && records.length === 0 && (
          <div className={css.dsStart}>
            <div className={css.dsStartCard}>
              <div className={css.dsStartTitle}>三步拿到第一份总结</div>
              <ol className={css.dsSteps}>
                <li className={css.dsStep}>
                  <span className={css.dsStepNo}>1</span>
                  <div className={css.dsStepBody}>
                    <div className={css.dsStepName}>配置模型</div>
                    {modelReady
                      ? <div className={css.dsStepMeta}>已配置：{llm?.provider} · {llm?.model}</div>
                      : <div className={css.dsStepMeta}>尚未配置 —— 总结由模型生成，没配模型无法产出</div>}
                  </div>
                  <button type="button" className={css.catBtn} data-active={modelReady ? undefined : true} onClick={() => { onOpenSettings?.('ai') }}>
                    {modelReady ? '查看' : '去配置'}
                  </button>
                </li>
                <li className={css.dsStep}>
                  <span className={css.dsStepNo}>2</span>
                  <div className={css.dsStepBody}>
                    <div className={css.dsStepName}>手动生成一天</div>
                    <div className={css.dsStepMeta}>选日期 → 生成，结果自动存进「总结阅览」</div>
                  </div>
                  <button type="button" className={css.catBtn} onClick={() => { setView('generate') }}>去生成</button>
                </li>
                <li className={css.dsStep}>
                  <span className={css.dsStepNo}>3</span>
                  <div className={css.dsStepBody}>
                    <div className={css.dsStepName}>需要每天自动跑？</div>
                    <div className={css.dsStepMeta}>建一个定时任务：选群聊/成员、格式与时间，到点自动生成</div>
                  </div>
                  <button type="button" className={css.catBtn} onClick={openNew}>＋ 新建</button>
                </li>
              </ol>
            </div>
            <div className={css.dsStartCard}>
              <div className={css.dsStartTitle}>总结长什么样</div>
              <ul className={css.dsStartList}>
                <li><b>只读本机消息</b>：先把当天消息汇总成素材，再交给模型；素材不出本机（出网边界见「数据边界与出网」）。</li>
                <li><b>五种格式</b>：简洁 / 详细 / 要点 / 叙事 / 自定义提示词。</li>
                <li><b>结果留档</b>：每条总结进「总结阅览」（共 {records.length} 条），可复制、可删除。</li>
                <li><b>可回溯</b>：生成时会记录用了哪些会话与条数（阅览里显示）。</li>
              </ul>
            </div>
          </div>
        )}
        {view === 'tasks' && (
          <div className={css.sideCard}>
            <div className={css.cardTitle}>定时总结任务 <span className={css.cardCount}>共 {tasks.length} 个</span></div>
            <div className={css.sideList}>
              {tasks.length === 0 && <div className={kitCss.emptyInline}>还没有定时任务，点下方“新建任务”创建。</div>}
              {tasks.map(t => (
                <div key={t.id} className={css.taskRow}>
                  <div className={css.taskInfo}>
                    <div className={css.taskName}>{t.groupName || t.groupUsername}</div>
                    <div className={css.taskMeta}>⏰ {t.scheduleTime} · {FORMATS.find(f => f.key === t.format)?.label ?? t.format}</div>
                    <div className={css.taskChips}>
                      <span className={[css.statBadge, t.enabled ? css.on : css.off].join(' ')}>{t.enabled ? '启用' : '停用'}</span>
                      {t.lastStatus === 'done' && <span className={[css.statBadge, css.done].join(' ')}>上次运行成功</span>}
                      {t.lastStatus === 'error' && <span className={[css.statBadge, css.fail].join(' ')}>上次运行失败</span>}
                      {t.lastStatus && t.lastStatus !== 'done' && t.lastStatus !== 'error' && <span className={[css.statBadge, css.on].join(' ')}>上次 {t.lastStatus}</span>}
                      {t.lastRunAt && <span className={css.statBadge}>{fmtLocaleMs(t.lastRunAt)}</span>}
                    </div>
                  </div>
                  <div className={css.taskActions}>
                    <button type="button" className={css.catBtn} onClick={() => { void runTask(t.id) }} disabled={isBusy(`run:${t.id}`)}>{renderBusy(`run:${t.id}`, '运行', '运行中')}</button>
                    <button type="button" className={css.catBtn} onClick={() => { openEdit(t) }}>编辑</button>
                    <button type="button" className={css.catBtn} onClick={() => { duplicate(t) }}>复制</button>
                    <button type="button" className={css.catBtn} onClick={() => { void toggleTask(t.id, !t.enabled) }} disabled={isBusy(`toggle:${t.id}`)}>{renderBusy(`toggle:${t.id}`, t.enabled ? '停用' : '启用', t.enabled ? '停用中' : '启用中')}</button>
                    <button type="button" className={css.catBtn} onClick={() => { void deleteTask(t.id) }} disabled={isBusy(`del:${t.id}`)}>{renderBusy(`del:${t.id}`, '删除', '删除中')}</button>
                  </div>
                </div>
              ))}
              <button type="button" className={`${css.catBtn} ${css.dsNewBtn}`} data-active="true" onClick={openNew}>＋ 新建任务</button>
            </div>
          </div>
        )}
        {view === 'records' && (
          <div className={css.dsLayout}>
            <div className={css.dsMain}>
              <div className={css.sideCard}>
                <div className={css.cardTitle}>总结阅览 <span className={css.cardCount}>共 {records.length} 条 · 平均 {avgLen} 字</span></div>
                <div className={css.sideList}>
                  {records.length === 0 && (
                    <div className={css.dsEmptyRecords}>
                      <div className={kitCss.emptyInline}>还没有历史总结。定时任务运行或手动生成后会自动存入这里。</div>
                      <button type="button" className={css.catBtn} data-active="true" onClick={() => { setView('generate') }}>去手动生成一份</button>
                    </div>
                  )}
                  {records.map(r => (
                    <div key={r.id} className={css.taskRow}>
                      <div className={css.taskInfo}>
                        <div className={css.taskName}>{r.groupName || r.groupUsername} / {r.summaryDate}</div>
                        <div className={css.taskMeta}>{r.messageCount} 条 · {r.status}</div>
                        <div className={css.taskChips}>
                          <span className={[css.statBadge, r.status === 'done' ? css.done : r.status === 'error' ? css.fail : css.on].join(' ')}>{r.status === 'done' ? '已完成' : r.status === 'error' ? '失败' : r.status}</span>
                          {previewId === r.id && <span className={[css.statBadge, css.on].join(' ')}>正在预览</span>}
                        </div>
                      </div>
                      <div className={css.taskActions}>
                        <button type="button" className={css.catBtn} data-active={previewId === r.id || undefined} onClick={() => { showRecordPreview(r) }}>预览</button>
                        <button type="button" className={css.catBtn} onClick={() => { void copyRecord(r) }} disabled={isBusy(`copy:${r.id}`)}>{renderBusy(`copy:${r.id}`, '复制总结', '复制中')}</button>
                        <button type="button" className={css.catBtn} onClick={() => { void deleteRecord(r.id) }} disabled={isBusy(`delrec:${r.id}`)}>{renderBusy(`delrec:${r.id}`, '删除', '删除中')}</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className={css.dsSide}>
              {result ? (
                <div className={css.previewCard} ref={previewRef}>
                  <div className={css.previewHd}>
                    <span className={css.previewTitle}>总结内容</span>
                    {meta && <span className={css.previewMetaChip} title={meta}>{meta}</span>}
                  </div>
                  <div className={css.previewBody}><div className={css.summaryText}>{result}</div></div>
                  <div className={css.previewActions}><button type="button" className={css.catBtn} onClick={copyResult}>复制总结</button></div>
                </div>
              ) : (
                <div className={css.sideCard}>
                  <div className={css.cardTitle}>总结内容</div>
                  <div className={css.sideList}>
                    <div className={kitCss.emptyInline}>在左侧选择一条记录即可预览内容</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        {view === 'generate' && (
          <div className={`${css.dsLayout} ${css.dsLayoutSingle}`}>
            <div className={css.dsMain}>
              <div className={css.panelCard}>
                <div className={css.cardTitle}>手动生成</div>
                <div className={css.cardBody}>
                  <div className={`${css.searchWrap} ${css.dsSearchWrap}`}>
                    {/* 模型选择已移除：全应用统一在「数据配置 → AI 大模型」设置 */}
                    <span className={kitCss.textCaption}>使用「数据配置 → AI 大模型」中的默认模型</span>
                  </div>
                  <div className={css.searchWrap}>
                    <label className={css.fieldLabel}>日期</label>
                    <DateField value={date} onChange={setDate} ariaLabel="总结日期" />
                    <button type="button" className={css.catBtn} data-active="true" onClick={() => { void generate() }} disabled={isGenerating}>{renderBusy('generate', '生成总结', '生成中…')}</button>
                  </div>
                </div>
              </div>
              {dailyStats && (
                <div className={css.sideCard}>
                  <div className={css.cardTitle}>当日概览 <span className={css.cardCount}>共 {dailyStats.total} 条消息</span></div>
                  <div className={css.sideList}>
                    <div className={css.statChips}>
                      <span className={css.statChip}>消息 <b>{dailyStats.total}</b></span>
                      <span className={css.statChip}>会话 <b>{dailyStats.sessions}</b></span>
                      {(dailyStats.types['图片'] ?? 0) > 0 && (
                        <span className={css.statChip}>图片 <b>{dailyStats.types['图片']}</b></span>
                      )}
                      {(dailyStats.types['视频'] ?? 0) > 0 && <span className={css.statChip}>视频 <b>{dailyStats.types['视频']}</b></span>}
                      {(dailyStats.types['链接'] ?? 0) > 0 && <span className={css.statChip}>链接 <b>{dailyStats.types['链接']}</b></span>}
                    </div>
                    {dailyStats.topSessions.length > 0 && (
                      <>
                        <div className={css.subHd}>最活跃的会话</div>
                        {dailyStats.topSessions.slice(0, 5).map((ts, i) => {
                          const name = groups.find(g => g.username === ts.username)?.name ?? ts.username
                          const base = dailyStats.topSessions[0]?.count ?? 1
                          return (
                            <div key={ts.username} className={css.barRow}>
                              <span className={css.barLabel} title={name}>{i + 1}. {name}</span>
                              <div className={css.barTrack}>
                                <div className={css.barFill} style={{ width: `${(ts.count / base) * 100}%` }} />
                              </div>
                              <span className={css.barValue}>{ts.count} 条</span>
                            </div>
                          )
                        })}
                      </>
                    )}
                    <div className={css.subHd}>24 小时活跃分布</div>
                    <div className={css.dsHourBars}>
                      {dailyStats.hourly.map((n, h) => {
                        const max = Math.max(1, ...dailyStats.hourly)
                        return (
                          <div key={h} className={css.dsHourCol} title={`${h}:00 · ${n} 条`}>
                            <div className={css.dsHourFill} style={{ height: `${Math.max(3, (n / max) * 46)}px` }} />
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )}
              {isGenerating && <div className={kitCss.emptyInline}><span className={css.spin} />正在收集当日消息并生成总结…</div>}
              {!isGenerating && result && (
                <div className={css.previewCard} ref={previewRef}>
                  <div className={css.previewHd}>
                    <span className={css.previewTitle}>总结内容</span>
                    {meta && <span className={css.previewMetaChip} title={meta}>{meta}</span>}
                  </div>
                  <div className={css.previewBody}><div className={css.summaryText}>{result}</div></div>
                  <div className={css.previewActions}>
                    <button type="button" className={css.catBtn} onClick={copyResult}>复制总结</button>
                    <button type="button" className={css.catBtn} onClick={() => { void generate() }} disabled={isGenerating}>{renderBusy('generate', '重新生成', '生成中…')}</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      {/* 任务表单弹窗 */}
      {formOpen && (
        <div className={css.overlay} data-st-dialog="daily-form" onClick={() => { setFormOpen(false) }} role="dialog" aria-modal="true">
          <div className={css.formDialog} onClick={(e) => { e.stopPropagation() }}>
            <div className={css.formHd}>
              <span className={css.hdTitle}>{form.id ? '编辑任务' : '新建任务'}</span>
              <button type="button" className={css.catBtn} onClick={() => { setFormOpen(false) }} aria-label="关闭">×</button>
            </div>
            <div className={css.formBody}>
              <div className={css.formHd}><span className={kitCss.textMeta}>群聊</span></div>
              <select
                className={css.search}
                value={form.groupUsername}
                onChange={(e) => {
                  const v = e.target.value
                  setForm(f => ({ ...f, groupUsername: v, groupName: groups.find(g => g.username === v)?.name ?? v }))
                  void loadMembers(v)
                }}
              >
                <option value="">选择群聊…</option>
                {groups.map(g => <option key={g.username} value={g.username}>{g.name}</option>)}
              </select>

              <div className={`${css.formHd} ${css.dsFormHd}`}><span className={kitCss.textMeta}>关注成员</span></div>
              <label className={`${kitCss.textCaption} ${css.dsInlineLabel}`}>
                <input type="checkbox" checked={form.targetAll} onChange={(e) => { setForm(f => ({ ...f, targetAll: e.target.checked, targetUsers: e.target.checked ? [] : f.targetUsers })) }} />
                全部成员
              </label>
              {!form.targetAll && form.groupUsername && (
                <div className={css.dsMemberPick}>
                  {members.length === 0 && <span className={kitCss.textCaption}>未读取到群成员，可重新选择群聊重试</span>}
                  {members.map(m => (
                    <button key={m.username} type="button" className={css.catBtn} data-active={form.targetUsers.includes(m.username) || undefined}
                      onClick={() => { toggleTarget(m.username) }}>{m.name}</button>
                  ))}
                </div>
              )}
              {!form.targetAll && <div className={kitCss.textCaption}>已关注 {form.targetUsers.length} 位成员</div>}

              <div className={`${css.formHd} ${css.dsFormHd}`}><span className={kitCss.textMeta}>分析格式</span></div>
              <div className={css.dsFormatGrid}>
                {FORMATS.map(f => (
                  <label key={f.key} className={`${css.formatCard} ${css.dsFormatCardLocal}`} data-on={form.format === f.key || undefined}>
                    <input type="radio" name="ds-format" className={css.dsRadioHidden} checked={form.format === f.key} onChange={() => { setForm(x => ({ ...x, format: f.key })) }} />
                    <div className={css.fileName}>{f.label}</div>
                    <div className={kitCss.textCaption}>{f.desc}</div>
                  </label>
                ))}
              </div>

              {form.format === 'custom' && (
                <>
                  <div className={`${css.hd} ${css.dsHdTop}`}><span className={kitCss.textMeta}>自定义提示词模板</span></div>
                  <textarea
                    className={`${css.search} ${css.dsPrompt}`}
                    rows={4}
                    placeholder={'支持占位符：{date} {group} {targets}；例如：请用表格形式总结 {group} 在 {date} 的聊天，成员：{targets}'}
                    value={form.customPrompt}
                    onChange={(e) => { setForm(f => ({ ...f, customPrompt: e.target.value })) }}
                  />
                </>
              )}

              <div className={`${css.formHd} ${css.dsFormHd}`}><span className={kitCss.textMeta}>定时设置</span></div>
              <div className={css.dsScheduleRow}>
                <TimeField value={form.scheduleTime} onChange={(v) => { setForm(f => ({ ...f, scheduleTime: v })) }} ariaLabel="每日总结时刻" />
                <label className={`${kitCss.textCaption} ${css.dsInlineLabel}`}>
                  <input type="checkbox" checked={form.enabled} onChange={(e) => { setForm(f => ({ ...f, enabled: e.target.checked })) }} />
                  {form.enabled ? '已启用' : '已暂停'}
                </label>
              </div>

              <div className={`${css.searchWrap} ${css.dsToolbarTop}`}>
                <button type="button" className={css.catBtn} data-active="true" onClick={() => { void saveTask() }} disabled={isBusy('save') || !form.groupUsername.trim()}>
                  {renderBusy('save', form.id ? '保存修改' : '保存任务', '保存中…')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
