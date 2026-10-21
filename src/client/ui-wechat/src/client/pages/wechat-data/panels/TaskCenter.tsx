/**
 * 「任务信息 · 任务触发记录」双栏面板（2026-10-19）。
 *
 * ── 这一页在做什么 ──────────────────────────────────────────────────────
 * 左栏是用户建的**触发式任务**（会话 + 触发对象 + 关键词 + 照片数量 + Webhook 地址），
 * 右栏是这些任务**命中关键词后留下的触发记录**；点记录看完整内容（触发时间 / 群聊 /
 * 对象 / 图片 / 文本），点任务把右栏筛到该任务，行内「编辑」展开配置表单。
 *
 * ── 分工（按 `docs/CONTRIBUTING.md` §6）────────────────────────────────
 * · 纯逻辑（文案/校验/过滤/选中项推导）在 `task-center.ts`（不 import React，有 spec）；
 * · 表单在 `task-center-edit-form.tsx`，记录弹窗在 `task-center-record-modal.tsx`；
 * · 本文件 = **数据容器**（`TaskCenterPanel`：取数、事件联动、写动作接线、选中一致性）
 *   + **纯展示视图**（`TaskCenterView`，SSR 冒烟直接渲染它，不依赖后端）。
 *
 * ── 状态联动（四条通路，缺一条就会出现「左栏变了右栏没变」）─────────────
 *  ① 打开页签：`useFreshData` 打开即查（不预填缓存）；读失败才回退并标注；
 *  ② 写操作：`api-task-center.ts` 的写入口成功后广播 `TASK_CENTER_UPDATED_EVENT`，
 *     本面板订阅后**两栏一起**回源（任务里改了关键词，右栏的过滤/标题也要跟着变）；
 *  ③ 宿主 WAL 推送（`dsh-wechat-data-updated`，约 10 秒一次）：`useFreshData` 的
 *     `liveRefresh` 已做静默重查；这里再挂一条显式回源（防抖 800ms），保证两栏在**任一**
 *     事件后都同源刷新 —— 多一次轻查询换一致性，值；
 *  ④ 本面板内的动作（刷新 / 立即检查 / 保存 / 标记状态 / 删除 / 重投）：
 *     直接静默 `reloadSilent()` 两栏并原位替换快照，不依赖事件是否恰好被自己收到。
 *
 * 选中一致性（`nextSelectedTaskId` / `nextExpandedTaskId`）：任务列表刷新后若选中/展开的
 * 任务已不存在，立即回落到 null（右栏回「全部记录」、表单收起）并给一条可见提示 ——
 * 不这么做的话右栏会一直空着，用户看不出是「没有记录」还是「选了一个已删除的任务」。
 *
 * @module TaskCenter
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  TaskCallbackDispatchResult,
  TaskBatchMutationResult,
  TaskInfo,
  TaskInfoInput,
  TaskInfoMutationResult,
  TaskInfoStatus,
  TaskTriggerRecord,
} from '@deepseek-ai/dsh-wechat-data/types'
import {
  apiDeleteTaskInfos,
  apiDeleteTaskInfo,
  apiDeleteTaskTriggers,
  apiDispatchTaskCallback,
  apiListTaskInfos,
  apiSaveTaskInfo,
  apiScanTaskTriggers,
  apiSetTaskInfoStatus,
} from '../api-task-center.ts'
import { TASK_CENTER_UPDATED_EVENT } from '../task-center-events.ts'
import { useTransientNotice, useWechatDataUpdated } from './hooks.tsx'
import { useFreshData } from './use-fresh-data.ts'
import {
  Button,
  PanelHeader,
  Toolbar,
} from '../ui/kit.tsx'
import { useConfirm } from '../ui/confirm.tsx'
import { desktopAction, desktopActionProps } from '../ui/desktop-only.tsx'
import { TaskCenterRecordModal } from './task-center-record-modal.tsx'
import { TaskPane, TriggerPane } from './task-center-panes.tsx'
import { useTaskCenterTriggers } from './use-task-center-triggers.ts'
import {
  exceedsBatchLimit,
  filterTriggersByTask,
  retainSelectedIds,
  nextExpandedTaskId,
  nextSelectedTaskId,
  scanResultText,
  taskCounts,
  toggleSelectedId,
} from './task-center.ts'
import css from './task-center.module.css'
import kitCss from '../ui/kit.module.css'

/** 空列表常量：避免每次渲染都新建数组（依赖数组里更容易稳定）。 */
const NO_TASKS: readonly TaskInfo[] = []

/** 容器注入给视图的全部动作（SSR 冒烟传 noop 即可）。 */
export interface TaskCenterActions {
  /** 选中一个任务（null = 全部记录 / 解除筛选）。 */
  onSelectTask: (id: number | null) => void
  /** 展开/收起某任务的行内编辑表单。 */
  onToggleEdit: (id: number) => void
  /** 打开一条触发记录的完整内容弹窗。 */
  onOpenRecord: (id: number) => void
  /** 关闭记录弹窗。 */
  onCloseRecord: () => void
  /** 手动刷新两栏（有内容时静默原位替换，不清空列表）。 */
  onRefresh: () => void
  /** 「立即检查」：按关键词扫描一次新消息。 */
  onScan: () => void
  /** 保存任务配置（入参已带 id）。 */
  onSaveTask: (task: TaskInfo, input: TaskInfoInput) => Promise<TaskInfoMutationResult>
  /** 切换任务状态（待完善 / 已完善）。 */
  onSetStatus: (id: number, status: TaskInfoStatus) => Promise<TaskInfoMutationResult>
  /** 删除任务。 */
  onDeleteTask: (id: number) => Promise<TaskInfoMutationResult>
  /** 批量删除任务配置（触发记录保留）。 */
  onDeleteTasks: (ids: number[]) => Promise<TaskBatchMutationResult>
  /** 批量删除触发记录（后端重算任务统计）。 */
  onDeleteTriggers: (ids: number[]) => Promise<TaskBatchMutationResult>
  /** 手动重投一条触发记录的回调。 */
  onDispatch: (triggerId: number) => Promise<TaskCallbackDispatchResult>
  /** 成功提示（编辑表单保存/改状态后用）。 */
  onNotice: (text: string) => void
}

/** 纯展示视图的入参（容器与 SSR 冒烟共用；**不含任何取数/副作用**）。 */
export interface TaskCenterViewProps {
  tasks: readonly TaskInfo[]
  triggers: readonly TaskTriggerRecord[]
  selectedTaskId: number | null
  expandedTaskId: number | null
  openRecordId: number | null
  openRecord: TaskTriggerRecord | null
  tasksLoading: boolean
  triggersLoading: boolean
  tasksError: string | null
  triggersError: string | null
  tasksReadError: string | null
  triggersReadError: string | null
  tasksStale?: boolean
  triggersStale?: boolean
  triggersTotal?: number
  triggersHasMore?: boolean
  triggersLoadingMore?: boolean
  triggersLoadMoreError?: string | null
  /** 继续加载当前筛选下的下一页触发记录。 */
  onLoadMoreTriggers: () => void
  scanning: boolean
  /** 两栏刷新在途（轻量状态，不替换当前内容）。 */
  refreshing?: boolean
  notice: string | null
  /** 左栏任务搜索框原文（客户端过滤全部已加载任务）。 */
  taskSearch?: string
  /** 更新左栏搜索词；缺省时视图仍可在本地输入。 */
  onTaskSearchChange?: (search: string) => void
  /** 已应用在右栏快照上的服务端搜索词（容器防抖后传入）。 */
  triggerSearch?: string
  /** 搜索框原始输入；不受防抖限制，保证受控输入不吞字。 */
  triggerSearchDraft?: string
  /** 搜索框原始输入变化（容器负责 250ms 防抖后再查第一页）。 */
  onTriggerSearchDraftChange?: (search: string) => void
  /** 左栏是否处于批量选择模式。 */
  taskBatchMode?: boolean
  /** 当前选中的任务 id。 */
  selectedTaskIds?: ReadonlySet<number>
  /** 切换左栏批量模式。 */
  onTaskBatchModeChange?: (mode: boolean) => void
  /** 选中/取消一个任务。 */
  onToggleTaskSelection?: (id: number) => void
  /** 右栏是否处于批量选择模式。 */
  triggerBatchMode?: boolean
  /** 当前选中的触发记录 id。 */
  selectedTriggerIds?: ReadonlySet<number>
  /** 切换右栏批量模式。 */
  onTriggerBatchModeChange?: (mode: boolean) => void
  /** 选中/取消一条触发记录。 */
  onToggleTriggerSelection?: (id: number) => void
  actions: TaskCenterActions
}

/**
 * 双栏纯展示视图（容器与 SSR 冒烟共用）。
 * @param props - 两栏快照、选中/展开/弹窗状态与动作集合（见 {@link TaskCenterViewProps}）。
 * @returns 面板元素。
 */
export function TaskCenterView(props: TaskCenterViewProps): React.JSX.Element {
  const { actions } = props
  const confirm = useConfirm()
  const [localTaskSearch, setLocalTaskSearch] = useState('')
  const taskSearch = props.taskSearch ?? localTaskSearch
  const setTaskSearch = props.onTaskSearchChange ?? setLocalTaskSearch
  const taskBatchMode = props.taskBatchMode === true
  const triggerBatchMode = props.triggerBatchMode === true
  const selectedTaskIds = props.selectedTaskIds ?? new Set<number>()
  const selectedTriggerIds = props.selectedTriggerIds ?? new Set<number>()
  const counts = taskCounts(props.tasks)
  const triggersTotal = props.triggersTotal ?? props.triggers.length
  const selectedTask = props.tasks.find((t) => t.id === props.selectedTaskId) ?? null
  // 右栏**始终**按选中项过一遍：服务端已按 taskId 查过，这里兜住「切换瞬间两栏不同源」。
  const records = filterTriggersByTask(props.triggers, props.selectedTaskId)
  /** 首屏仍在查时也锁住刷新，避免重构后把两次回源叠在一起。 */
  const refreshBusy = props.refreshing === true || props.tasksLoading || props.triggersLoading

  const confirmDeleteTasks = async (): Promise<void> => {
    const ids = [...selectedTaskIds]
    if (ids.length === 0 || exceedsBatchLimit(ids.length)) return
    const ok = await confirm({
      title: `删除所选 ${String(ids.length)} 个任务？`,
      message: '任务配置会被删除，之后不再触发；已产生的触发记录会保留（它们是历史事实，仍可在右栏回看）。',
      tone: 'danger',
      confirmText: '批量删除',
    })
    if (!ok) return
    try {
      const result = await actions.onDeleteTasks(ids)
      if (!result.ok) {
        actions.onNotice('批量删除任务失败：' + (result.error ?? '未知错误'))
        return
      }
      props.onTaskBatchModeChange?.(false)
      actions.onNotice('已删除 ' + String(result.removed) + ' 个任务')
    } catch (e) {
      actions.onNotice('批量删除任务失败：' + (e as Error).message)
    }
  }

  const confirmDeleteTriggers = async (): Promise<void> => {
    const ids = [...selectedTriggerIds]
    if (ids.length === 0 || exceedsBatchLimit(ids.length)) return
    const ok = await confirm({
      title: `删除所选 ${String(ids.length)} 条触发记录？`,
      message: '删除后不可恢复；不会删除微信里的原始消息，所属任务的触发次数与最近触发时间会按剩余记录重算。',
      tone: 'danger',
      confirmText: '批量删除',
    })
    if (!ok) return
    try {
      const result = await actions.onDeleteTriggers(ids)
      if (!result.ok) {
        actions.onNotice('批量删除触发记录失败：' + (result.error ?? '未知错误'))
        return
      }
      props.onTriggerBatchModeChange?.(false)
      actions.onNotice('已删除 ' + String(result.removed) + ' 条触发记录')
    } catch (e) {
      actions.onNotice('批量删除触发记录失败：' + (e as Error).message)
    }
  }

  return (
    <div className={css.root}>
      <PanelHeader
        title="任务信息"
        desc="命中关键词后记录触发内容并投递 Webhook；仅「已完善」的任务参与触发与投递"
        actions={(
          <>
            <Button
              size="sm"
              variant="pill"
              aria-label="刷新任务信息"
              aria-busy={refreshBusy}
              onClick={actions.onRefresh}
              disabled={refreshBusy}
            >
              刷新
            </Button>
            {/* 「立即检查」会写库（扫描新消息），后端把它归为「仅桌面」：手机/浏览器态禁用。
                微信化：写操作加一次二次确认，避免与「刷新」并排时误点。 */}
            <Button
              size="sm"
              variant="pill"
              onClick={() => {
                void (async () => {
                  const ok = await confirm({
                    title: '立即检查？',
                    message: '会按关键词扫描一次新消息，把命中项写入触发记录并按 Webhook 地址投递。',
                    confirmText: '立即检查',
                  })
                  if (ok) actions.onScan()
                })()
              }}
              disabled={props.scanning}
              {...desktopActionProps()}
            >
              {props.scanning ? '检查中…' : '立即检查'}
            </Button>
          </>
        )}
      />

      <Toolbar
        left={(
          <span className={kitCss.textMeta}>
            左栏点任务可把右栏筛到该任务
            {selectedTask !== null ? `（当前：${selectedTask.name}）` : ''}
            {desktopAction() ? ' · 手机端只读' : ''}
          </span>
        )}
        right={(
          <span className={kitCss.textMeta}>
            任务 {counts.total} · 待完善 {counts.incomplete} · 已完善 {counts.ready} · 触发记录 {triggersTotal}
          </span>
        )}
      />

      {props.notice !== null && <div className={css.notice} role="status">{props.notice}</div>}

      <div className={css.board}>
        <TaskPane
          tasks={props.tasks}
          loading={props.tasksLoading}
          error={props.tasksError}
          readError={props.tasksReadError}
          stale={props.tasksStale === true}
          search={taskSearch}
          onSearchChange={setTaskSearch}
          selectedTaskId={props.selectedTaskId}
          expandedTaskId={props.expandedTaskId}
          batchMode={taskBatchMode}
          selectedIds={selectedTaskIds}
          onBatchModeChange={(mode) => { props.onTaskBatchModeChange?.(mode) }}
          onToggleSelection={(id) => { props.onToggleTaskSelection?.(id) }}
          onDeleteSelected={() => { void confirmDeleteTasks() }}
          actions={actions}
        />

        <TriggerPane
          records={records}
          selectedTask={selectedTask}
          loading={props.triggersLoading}
          error={props.triggersError}
          readError={props.triggersReadError}
          stale={props.triggersStale === true}
          search={props.triggerSearch ?? ''}
          searchDraft={props.triggerSearchDraft ?? props.triggerSearch ?? ''}
          onSearchDraftChange={(value) => { props.onTriggerSearchDraftChange?.(value) }}
          total={triggersTotal}
          hasMore={props.triggersHasMore === true}
          loadingMore={props.triggersLoadingMore === true}
          loadMoreError={props.triggersLoadMoreError ?? null}
          onLoadMore={props.onLoadMoreTriggers}
          batchMode={triggerBatchMode}
          selectedIds={selectedTriggerIds}
          onBatchModeChange={(mode) => { props.onTriggerBatchModeChange?.(mode) }}
          onToggleSelection={(id) => { props.onToggleTriggerSelection?.(id) }}
          onDeleteSelected={() => { void confirmDeleteTriggers() }}
          actions={actions}
        />
      </div>

      {props.openRecordId !== null && (
        <TaskCenterRecordModal
          triggerId={props.openRecordId}
          record={props.openRecord}
          onClose={actions.onCloseRecord}
          onDispatch={actions.onDispatch}
        />
      )}
    </div>
  )
}

/** 两个事件源共用的刷新调度窗（毫秒）：合并同一批变更，别让两个事件各打一轮。 */
const TASK_CENTER_DEBOUNCE_MS = 150
/** 宿主 WAL 推送的显式回源延迟：它本身约 10 秒一次，晚一点合并进同一轮即可。 */
const HOST_REFRESH_DEBOUNCE_MS = 800

/**
 * 数据容器：取数与事件联动，渲染 {@link TaskCenterView}。
 * @returns 任务信息面板。
 */
export function TaskCenterPanel(): React.JSX.Element {
  const fetchTasks = useCallback(() => apiListTaskInfos(), [])
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null)
  const [expandedTaskId, setExpandedTaskId] = useState<number | null>(null)
  const [openRecordId, setOpenRecordId] = useState<number | null>(null)
  const [taskSearch, setTaskSearch] = useState('')
  const [taskBatchMode, setTaskBatchMode] = useState(false)
  const [triggerBatchMode, setTriggerBatchMode] = useState(false)
  const [selectedTaskIds, setSelectedTaskIds] = useState<ReadonlySet<number>>(() => new Set())
  const [selectedTriggerIds, setSelectedTriggerIds] = useState<ReadonlySet<number>>(() => new Set())
  const [scanning, setScanning] = useState(false)
  const refreshingRef = useRef(false)
  /**
   * 刷新进行中又收到事件/写操作时，只记录一次尾随刷新；不能直接丢弃，
   * 否则最后一条变更可能要等下一次轮询才出现。
   */
  const refreshPendingRef = useRef(false)
  const { notice, flash, hold } = useTransientNotice(4000)

  const taskState = useFreshData('taskCenter:tasks', fetchTasks, { shouldCache: (d) => !d.readError, liveRefresh: true })
  const triggerState = useTaskCenterTriggers(selectedTaskId)
  const reloadTasks = taskState.reloadSilent
  const reloadTriggers = triggerState.reloadSilent
  const refreshing = taskState.refreshing || triggerState.refreshing

  /** 两栏一起静默回源（写动作/事件/刷新/扫描后的统一出口）。 */
  const refreshBoth = useCallback(async (): Promise<void> => {
    if (refreshingRef.current) {
      refreshPendingRef.current = true
      return
    }
    refreshingRef.current = true
    try {
      do {
        refreshPendingRef.current = false
        await Promise.all([reloadTasks(), reloadTriggers()])
      } while (refreshPendingRef.current)
    } finally {
      refreshingRef.current = false
    }
  }, [reloadTasks, reloadTriggers])

  /** 防抖后的统一回源：两个事件源都走它，避免同一批变更打两轮。 */
  const timerRef = useRef<number | undefined>(undefined)
  const scheduleRefresh = useCallback((delayMs: number): void => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined
      void refreshBoth()
    }, delayMs)
  }, [refreshBoth])
  useEffect(() => () => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
  }, [])

  // ② 任务中心写操作（新建/编辑/删除/扫描/重投）广播的事件：两栏一起回源。
  useEffect(() => {
    const onTaskCenterUpdated = (): void => { scheduleRefresh(TASK_CENTER_DEBOUNCE_MS) }
    window.addEventListener(TASK_CENTER_UPDATED_EVENT, onTaskCenterUpdated)
    return () => { window.removeEventListener(TASK_CENTER_UPDATED_EVENT, onTaskCenterUpdated) }
  }, [scheduleRefresh])
  // ③ 宿主 WAL 推送：`liveRefresh` 已静默重查一次；这条显式回源保证两栏一定同源刷新。
  useWechatDataUpdated(() => { scheduleRefresh(HOST_REFRESH_DEBOUNCE_MS) }, 'dsh-wechat-data-updated', 300)

  // 选中/展开项只在任务仍存在时有效：被删则回「全部记录」/收起表单，并提示一次。
  const taskData = taskState.data
  useEffect(() => {
    if (taskData === null) return
    const items = taskData.items
    const nextSelected = nextSelectedTaskId(items, selectedTaskId)
    if (nextSelected !== selectedTaskId) {
      setSelectedTaskId(nextSelected)
      if (selectedTaskId !== null) flash('选中的任务已不存在，右栏已切回「全部记录」', 5000)
    }
    const nextExpanded = nextExpandedTaskId(items, expandedTaskId)
    if (nextExpanded !== expandedTaskId) setExpandedTaskId(nextExpanded)
  }, [taskData, selectedTaskId, expandedTaskId, flash])

  const taskItems = taskData?.items ?? NO_TASKS
  const triggerItems = triggerState.items

  /** 刷新后只保留仍存在的 id；搜索/筛选变化时直接清空，避免删除当前看不到的记录。 */
  useEffect(() => {
    setSelectedTaskIds((current) => retainSelectedIds(current, taskItems.map((task) => task.id)))
  }, [taskItems])
  useEffect(() => {
    setSelectedTriggerIds((current) => retainSelectedIds(current, triggerItems.map((record) => record.id)))
  }, [triggerItems])
  useEffect(() => { setSelectedTaskIds(new Set()) }, [taskSearch])
  useEffect(() => {
    setSelectedTriggerIds(new Set())
  }, [selectedTaskId, triggerState.searchDraft])

  /** 弹窗内容按 id 从**最新**快照解析：找不到时传 null，弹窗显示「记录已不可用」。 */
  const openRecord = useMemo(
    () => (openRecordId === null ? null : (triggerItems.find((r) => r.id === openRecordId) ?? null)),
    [openRecordId, triggerItems],
  )

  const handleRefresh = useCallback((): void => {
    void refreshBoth()
  }, [refreshBoth])

  const handleScan = useCallback((): void => {
    if (scanning) return
    setScanning(true)
    void (async (): Promise<void> => {
      try {
        const result = await apiScanTaskTriggers()
        if (result.ok) flash(scanResultText(result), 6000)
        else hold(scanResultText(result))
        await refreshBoth()
      } catch (e) {
        hold(`扫描失败：${(e as Error).message}`)
      } finally {
        setScanning(false)
      }
    })()
  }, [flash, hold, refreshBoth, scanning])

  const handleSaveTask = useCallback(async (task: TaskInfo, input: TaskInfoInput): Promise<TaskInfoMutationResult> => {
    try {
      return await apiSaveTaskInfo({ ...input, id: task.id })
    } catch (e) {
      const message = (e as Error).message
      // 抛异常 = 连后端都没回话（表单的 apiError 只覆盖「返回 ok:false」那一档）。
      hold(`保存任务失败：${message}`)
      return { ok: false, error: message }
    }
  }, [hold])

  const handleSetStatus = useCallback(async (id: number, status: TaskInfoStatus): Promise<TaskInfoMutationResult> => {
    try {
      return await apiSetTaskInfoStatus({ id, status })
    } catch (e) {
      const message = (e as Error).message
      hold(`切换任务状态失败：${message}`)
      return { ok: false, error: message }
    }
  }, [hold])

  const handleDeleteTask = useCallback(async (id: number): Promise<TaskInfoMutationResult> => {
    try {
      const result = await apiDeleteTaskInfo({ id })
      if (result.ok) {
        setExpandedTaskId((cur) => (cur === id ? null : cur))
        setSelectedTaskId((cur) => (cur === id ? null : cur))
        await refreshBoth()
      }
      return result
    } catch (e) {
      const message = (e as Error).message
      hold(`删除任务失败：${message}`)
      return { ok: false, error: message }
    }
  }, [hold, refreshBoth])

  const handleDeleteTasks = useCallback(async (ids: number[]): Promise<TaskBatchMutationResult> => {
    const result = await apiDeleteTaskInfos({ ids })
    if (result.ok) {
      const removed = new Set(ids)
      setSelectedTaskIds((current) => new Set([...current].filter((id) => !removed.has(id))))
      setExpandedTaskId((cur) => (cur !== null && removed.has(cur) ? null : cur))
      setSelectedTaskId((cur) => (cur !== null && removed.has(cur) ? null : cur))
      await refreshBoth()
    }
    return result
  }, [refreshBoth])

  const handleDeleteTriggers = useCallback(async (ids: number[]): Promise<TaskBatchMutationResult> => {
    const result = await apiDeleteTaskTriggers({ ids })
    if (result.ok) {
      const removed = new Set(ids)
      setSelectedTriggerIds((current) => new Set([...current].filter((id) => !removed.has(id))))
      setOpenRecordId((cur) => (cur !== null && removed.has(cur) ? null : cur))
      await refreshBoth()
    }
    return result
  }, [refreshBoth])

  const handleDispatch = useCallback(async (triggerId: number): Promise<TaskCallbackDispatchResult> => {
    try {
      return await apiDispatchTaskCallback({ triggerId })
    } catch (e) {
      const message = (e as Error).message
      hold(`重新投递失败：${message}`)
      return { ok: false, status: 'failed', error: message }
    }
  }, [hold])

  const actions: TaskCenterActions = {
    onSelectTask: (id) => { setSelectedTaskId(id) },
    onToggleEdit: (id) => { setExpandedTaskId((cur) => (cur === id ? null : id)) },
    onOpenRecord: (id) => { setOpenRecordId(id) },
    onCloseRecord: () => { setOpenRecordId(null) },
    onRefresh: handleRefresh,
    onScan: handleScan,
    onSaveTask: handleSaveTask,
    onSetStatus: handleSetStatus,
    onDeleteTask: handleDeleteTask,
    onDeleteTasks: handleDeleteTasks,
    onDeleteTriggers: handleDeleteTriggers,
    onDispatch: handleDispatch,
    onNotice: flash,
  }

  return (
    <TaskCenterView
      tasks={taskItems}
      triggers={triggerItems}
      selectedTaskId={selectedTaskId}
      expandedTaskId={expandedTaskId}
      openRecordId={openRecordId}
      openRecord={openRecord}
      tasksLoading={taskState.loading}
      triggersLoading={triggerState.loading}
      tasksError={taskState.error}
      triggersError={triggerState.error}
      tasksReadError={taskData?.readError ?? null}
      triggersReadError={triggerState.readError}
      tasksStale={taskState.stale}
      triggersStale={triggerState.stale}
      triggersTotal={triggerState.total}
      triggersHasMore={triggerState.hasMore}
      triggersLoadingMore={triggerState.loadingMore}
      triggersLoadMoreError={triggerState.loadMoreError}
      onLoadMoreTriggers={triggerState.loadMore}
      scanning={scanning}
      refreshing={refreshing}
      notice={notice}
      taskSearch={taskSearch}
      onTaskSearchChange={setTaskSearch}
      triggerSearch={triggerState.search}
      triggerSearchDraft={triggerState.searchDraft}
      onTriggerSearchDraftChange={triggerState.setSearchDraft}
      taskBatchMode={taskBatchMode}
      selectedTaskIds={selectedTaskIds}
      onTaskBatchModeChange={(mode) => { setTaskBatchMode(mode); if (!mode) setSelectedTaskIds(new Set()) }}
      onToggleTaskSelection={(id) => { setSelectedTaskIds((current) => toggleSelectedId(current, id)) }}
      triggerBatchMode={triggerBatchMode}
      selectedTriggerIds={selectedTriggerIds}
      onTriggerBatchModeChange={(mode) => { setTriggerBatchMode(mode); if (!mode) setSelectedTriggerIds(new Set()) }}
      onToggleTriggerSelection={(id) => { setSelectedTriggerIds((current) => toggleSelectedId(current, id)) }}
      actions={actions}
    />
  )
}
