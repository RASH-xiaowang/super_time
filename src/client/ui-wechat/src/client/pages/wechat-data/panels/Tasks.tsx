/**
 * 待办提取面板 — 从最近聊天中提取待办/提醒（DSH LLM 生成 JSON），本地持久化到
 * wechat_tasks.db；支持手动添加、完成/重开、删除、跳转来源会话。
 */
import { useCallback, useState } from 'react'
import { apiAddTask, apiDeleteTask, apiExtractTasks, apiListTasks, apiSetTaskStatus, apiSyncHandoffTasks } from '../api.ts'
import { useFreshData } from './use-fresh-data.ts'
import type { WechatTask } from '@deepseek-ai/dsh-wechat-data/types'
import { Button, Card, EmptyState, LinkButton, LoadingState, PanelHeader, Toolbar } from '../ui/kit.tsx'
import { useTransientNotice } from './hooks.tsx'
import css from './tasks.module.css'
import { desktopActionProps } from '../ui/desktop-only.tsx'
import kitCss from '../ui/kit.module.css'
import { useConfirm } from '../ui/confirm.tsx'
import { useMenuDismiss } from './use-menu-dismiss.ts'
import { HandoffRemindList } from './tasks-handoff.tsx'

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
  /* 2026-10-03 推广批次 2：改用共用 useFreshData —— 打开即查最新（不再预填缓存）；
     `shouldCache` 保证**读失败的结果不进缓存**（N1：把"读不到"的空列表写进缓存，
     下次打开会先渲染「暂无待办」，而缓存看不出是读失败还是确实没有）。 */
  const fetchTasks = useCallback(() => apiListTasks(), [])
  const { data: taskData, reload, loading: tasksLoading } = useFreshData<Awaited<ReturnType<typeof apiListTasks>>>('tasks', fetchTasks, { shouldCache: (d) => !d.readError, liveRefresh: true })
  const tasks = taskData?.items ?? []
  const readError = taskData?.readError ?? null
  /** 原 `load` 的调用点（新增/提取/同步/删除后重查）全部保留语义：它就是 hook 的 reload。 */
  const load = reload
  /**
   * 「待办库读不到」的原因（N1）。
   *
   * 后端在读失败时仍返回空列表（面板不该整块崩掉），但同时带上 `readError`：
   * 没有它，「库被占用/损坏」与「确实一条待办都没有」在界面上完全一样 ——
   * 用户会照「暂无待办」去排查，方向全错（那正是 N1 要修的那件事）。
   */
  const [manualTitle, setManualTitle] = useState('')
  const [extracting, setExtracting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [addingManual, setAddingManual] = useState(false)
  const [busyTaskId, setBusyTaskId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const confirm = useConfirm()
  // 提示语自动消失（L20）：原手写的 `window.setTimeout(…, 3000)` 已由 hook 统一管理。
  const { notice, flash } = useTransientNotice()
  const closeMore = useCallback((): void => { setMoreOpen(false) }, [])
  const { rootRef: moreRootRef, triggerRef: moreTriggerRef } = useMenuDismiss(moreOpen, closeMore)

  const notify = (text: string): void => {
    flash(text)
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
    if (!title) {
      notify('请输入待办内容')
      return
    }
    setAddingManual(true)
    setError(null)
    try {
      await apiAddTask({ title })
      setManualTitle('')
      notify('已添加待办')
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setAddingManual(false)
    }
  }, [manualTitle, load, notify])

  const toggle = useCallback(async (t: WechatTask): Promise<void> => {
    const next = t.status === 'open' ? 'done' : 'open'
    setBusyTaskId(t.id)
    setError(null)
    try {
      await apiSetTaskStatus({ id: t.id, status: next })
      notify(next === 'done' ? '已标记完成' : '已重新打开')
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusyTaskId(null)
    }
  }, [load, notify])

  const remove = useCallback(async (id: number): Promise<void> => {
    const ok = await confirm({
      title: '删除这条待办？',
      message: '删除后不可恢复；不会删除来源会话里的原始消息。',
      tone: 'danger',
      confirmText: '删除',
    })
    if (!ok) return
    setBusyTaskId(id)
    setError(null)
    try {
      await apiDeleteTask({ id })
      notify('已删除待办')
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusyTaskId(null)
    }
  }, [confirm, load, notify])

  return (
    <div className={kitCss.panelShell}>
      <PanelHeader
        title="待办日程"
        desc="从最近 7 天聊天提取待办（本地关键词匹配，不调用模型）"
        actions={(
          <>
            <Button variant="primary" onClick={() => { void extract() }} disabled={extracting}>
              {extracting ? '提取中…' : '提取待办'}
            </Button>
            <div className={css.more} ref={moreRootRef}>
              <button
                ref={moreTriggerRef}
                type="button"
                className={css.moreSummary}
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                onClick={() => { setMoreOpen(value => !value) }}
              >
                更多
              </button>
              {moreOpen && (
              <div className={css.moreMenu} role="menu" aria-label="待办更多操作">
                <button
                  type="button"
                  role="menuitem"
                  className={css.moreItem}
                  disabled={syncing}
                  onClick={() => { closeMore(); void syncHandoff() }}
                  {...desktopActionProps()}
                >
                  {syncing ? '导入中…' : '导入微信原生提醒'}
                </button>
              </div>
              )}
            </div>
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
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                if (manualTitle.trim()) void addManual()
                else notify('请输入待办内容')
              }}
              aria-label="手动添加待办"
            />
            <Button
              variant="pill"
              onClick={() => { void addManual() }}
              disabled={!manualTitle.trim() || addingManual}
              title={!manualTitle.trim() ? '请先输入待办内容' : undefined}
            >
              {addingManual ? '添加中…' : '添加'}
            </Button>
          </>
        )}
      />

      {notice && <div className={css.notice}>{notice}</div>}
      {error && <div className={kitCss.error} role="alert">{error}</div>}
      {/* 「读取失败」必须与「空列表」分开说（N1）：这不是「暂无待办」。 */}
      {readError && (
        <div className={kitCss.error} role="alert">
          待办库读取失败（不是「暂无待办」）：{readError}
        </div>
      )}
      {tasksLoading && <LoadingState variant="compact" label="加载中…" />}

      {/* 卡片撑满面板剩余高度（2026-10-18「其他面板的卡片要撑满屏幕」）：
          空态也放进卡里，不再让页面下半截裸空。 */}
      <HandoffRemindList />
      <div className={css.fill}>
        <Card flush>
          {!tasksLoading && tasks.length === 0 && !error && !readError && <EmptyState title="暂无待办" desc="点右上角「提取待办」从最近 7 天聊天里找，或在上方输入框手动添加一条" />}
          <div className={css.list}>
            {tasks.map(t => (
              <div key={t.id} className={css.taskRow} data-status={t.status}>
                <button
                  type="button"
                  className={css.check}
                  data-checked={t.status === 'done' ? '1' : undefined}
                  aria-label={t.status === 'open' ? `完成待办：${t.title}` : `重新打开待办：${t.title}`}
                  title={t.status === 'open' ? '标记完成' : '重新打开'}
                  disabled={busyTaskId === t.id}
                  onClick={() => { void toggle(t) }}
                >
                  {busyTaskId === t.id ? <span className={css.checkSpin} /> : (
                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                      <path d="M3.5 8.3l2.7 2.7 6.3-6.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
                <div className={css.taskInfo}>
                  <div className={css.taskTitle}>{t.title}</div>
                  <div className={css.taskMeta}>
                    {fmtDue(t.dueAt) ? `到期 ${fmtDue(t.dueAt)}` : '未设置到期'}
                    {t.sourceUsername ? (
                      <LinkButton onClick={() => { onOpenChat?.(t.sourceUsername ?? '', t.sourceLocalId) }}>来源会话</LinkButton>
                    ) : null}
                  </div>
                </div>
                <div className={css.taskActions}>
                  <button
                    type="button"
                    className={css.deleteBtn}
                    disabled={busyTaskId === t.id}
                    onClick={() => { void remove(t.id) }}
                    aria-label={`删除待办：${t.title}`}
                    title="删除待办"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
