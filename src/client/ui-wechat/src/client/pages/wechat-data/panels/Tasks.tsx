/**
 * 待办提取面板 — 从最近聊天中提取待办/提醒（DSH LLM 生成 JSON），本地持久化到
 * wechat_tasks.db；支持手动添加、完成/重开、删除、跳转来源会话。
 */
import { useCallback, useEffect, useState } from 'react'
import { apiAddTask, apiDeleteTask, apiExtractTasks, apiListTasks, apiSetTaskStatus, apiSyncHandoffTasks, readRenderCache, writeRenderCache } from '../api.ts'
import type { WechatTask } from '@deepseek-ai/dsh-wechat-data/types'
import { Button, Badge, Card, EmptyState, PanelHeader, Toolbar } from '../ui/kit.tsx'
import css from './tasks.module.css'
import kitCss from '../ui/kit.module.css'

function fmtDue(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Render the task extraction panel.
 * @param props - optional chat navigation callback.
 * @returns the tasks element tree.
 */
export function TasksPanel({ onOpenChat }: { onOpenChat?: (username: string, localId?: number) => void } = {}): React.JSX.Element {
  const [tasks, setTasks] = useState<readonly WechatTask[]>(() => readRenderCache<readonly WechatTask[]>('tasks') ?? [])
  const [manualTitle, setManualTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const r = await apiListTasks()
      setTasks(r.items)
      writeRenderCache('tasks', r.items)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const notify = (text: string): void => {
    setNotice(text)
    window.setTimeout(() => { setNotice(null) }, 3000)
  }

  const extract = useCallback(async (): Promise<void> => {
    setExtracting(true)
    setError(null)
    try {
      const r = await apiExtractTasks({ days: 7 })
      notify(r.ok ? `已提取 ${r.added ?? 0} 条待办` : (r.error ?? '提取失败'))
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setExtracting(false)
    }
  }, [load, notify])

  const syncHandoff = useCallback(async (): Promise<void> => {
    setSyncing(true)
    setError(null)
    try {
      const r = await apiSyncHandoffTasks()
      notify(r.ok ? `已导入 ${r.added ?? 0} 条原生提醒` : (r.error ?? '导入失败'))
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSyncing(false)
    }
  }, [load, notify])

  const addManual = useCallback(async (): Promise<void> => {
    const title = manualTitle.trim()
    if (!title) return
    try {
      await apiAddTask({ title })
      setManualTitle('')
      notify('已添加待办')
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }, [manualTitle, load, notify])

  const toggle = useCallback(async (t: WechatTask): Promise<void> => {
    const next = t.status === 'open' ? 'done' : 'open'
    try {
      await apiSetTaskStatus({ id: t.id, status: next })
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }, [load])

  const remove = useCallback(async (id: number): Promise<void> => {
    try {
      await apiDeleteTask({ id })
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }, [load])

  return (
    <div className={kitCss.panelShell}>
      <PanelHeader
        title="待办提取"
        desc="最近 7 天聊天 → LLM 提取待办/提醒 · 本地存储"
        actions={(
          <>
            <Button variant="pill" onClick={() => { void extract() }} disabled={extracting}>
              {extracting ? '提取中…' : '提取最近 7 天待办'}
            </Button>
            <Button variant="pill" onClick={() => { void syncHandoff() }} disabled={syncing}>
              {syncing ? '导入中…' : '导入微信原生提醒'}
            </Button>
          </>
        )}
      />

      <Toolbar
        left={(
          <>
            <input
              type="text"
              className={css.input}
              placeholder="手动添加待办（回车确认）"
              value={manualTitle}
              onChange={(e) => { setManualTitle(e.target.value) }}
              onKeyDown={(e) => { if (e.key === 'Enter') void addManual() }}
              aria-label="手动添加待办"
            />
            <Button variant="pill" onClick={() => { void addManual() }} disabled={!manualTitle.trim()}>添加</Button>
          </>
        )}
      />

      {notice && <div className={css.notice}>{notice}</div>}
      {error && <div className={kitCss.error} role="alert">{error}</div>}
      {loading && <div className={kitCss.emptyInline}>加载中…</div>}

      {!loading && tasks.length === 0 && !error && <EmptyState icon="✅" title="暂无待办" desc="点击右上角「提取最近 7 天待办」自动生成" />}

      <Card flush>
        <div className={css.list}>
          {tasks.map(t => (
            <div key={t.id} className={css.taskRow} data-status={t.status}>
              <div className={css.taskInfo}>
                <div className={css.taskTitle}>{t.title}</div>
                <div className={css.taskMeta}>
                  {fmtDue(t.dueAt) ? `到期 ${fmtDue(t.dueAt)}` : '未设置到期'}
                  {t.sourceUsername ? (
                    <button type="button" className={css.linkBtn} onClick={() => { onOpenChat?.(t.sourceUsername ?? '', t.sourceLocalId) }}>来源会话</button>
                  ) : null}
                </div>
              </div>
              <div className={css.taskActions}>
                <Badge tone={t.status === 'open' ? 'cyan' : 'green'}>{t.status === 'open' ? '待办' : '已完成'}</Badge>
                <Button variant="pill" onClick={() => { void toggle(t) }}>{t.status === 'open' ? '完成' : '重开'}</Button>
                <Button variant="pill" onClick={() => { void remove(t.id) }}>删除</Button>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
