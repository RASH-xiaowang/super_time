/**
 * 「任务信息 · 任务触发记录」双栏面板（2026-10-19）。
 *
 * ── 这一页在做什么 ──────────────────────────────────────────────────────
 * 左栏是用户建的**触发式任务**（会话 + 触发对象 + 关键词 + 照片数量 + 回调地址），
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
 *     直接 `reload()` 两栏，不依赖事件是否恰好被自己收到。
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
  TaskInfo,
  TaskInfoInput,
  TaskInfoMutationResult,
  TaskInfoStatus,
  TaskTriggerRecord,
} from '@deepseek-ai/dsh-wechat-data/types'
import {
  apiDeleteTaskInfo,
  apiDispatchTaskCallback,
  apiListTaskInfos,
  apiListTaskTriggers,
  apiSaveTaskInfo,
  apiScanTaskTriggers,
  apiSetTaskInfoStatus,
} from '../api-task-center.ts'
import { TASK_CENTER_UPDATED_EVENT } from '../task-center-events.ts'
import { useTransientNotice, useWechatDataUpdated } from './hooks.tsx'
import { useFreshData } from './use-fresh-data.ts'
import { Badge, Button, EmptyState, ErrorState, LinkButton, LoadingState, PanelHeader, Toolbar } from '../ui/kit.tsx'
import { useConfirm } from '../ui/confirm.tsx'
import { clickableKey } from '../ui/kit.tsx'
import { desktopAction, desktopActionProps } from '../ui/desktop-only.tsx'
import { TaskEditForm } from './task-center-edit-form.tsx'
import { TaskCenterRecordModal } from './task-center-record-modal.tsx'
import {
  callbackStatusMeta,
  callbackUrlLabel,
  filterTriggersByTask,
  triggerTimeText,
  lastTriggeredLabel,
  nextExpandedTaskId,
  nextSelectedTaskId,
  photoLimitLabel,
  plainText,
  recordImageCountLabel,
  recordSummary,
  scanResultText,
  taskCounts,
  taskScopeLabel,
  taskStatusMeta,
  triggerCountLabel,
  triggerPaneTitle,
  visibleKeywords,
} from './task-center.ts'
import css from './task-center.module.css'
import kitCss from '../ui/kit.module.css'

/** 空列表常量：避免每次渲染都新建数组（依赖数组里更容易稳定）。 */
const NO_TASKS: readonly TaskInfo[] = []
const NO_TRIGGERS: readonly TaskTriggerRecord[] = []

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
  /** 手动刷新两栏。 */
  onRefresh: () => void
  /** 「立即检查」：按关键词扫描一次新消息。 */
  onScan: () => void
  /** 保存任务配置（入参已带 id）。 */
  onSaveTask: (task: TaskInfo, input: TaskInfoInput) => Promise<TaskInfoMutationResult>
  /** 切换任务状态（待完善 / 已完善）。 */
  onSetStatus: (id: number, status: TaskInfoStatus) => Promise<TaskInfoMutationResult>
  /** 删除任务。 */
  onDeleteTask: (id: number) => Promise<TaskInfoMutationResult>
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
  scanning: boolean
  notice: string | null
  actions: TaskCenterActions
}

/**
 * 左栏一行：任务名 / 状态 / 会话与目标 / 关键词 chips / 照片与回调 / 触发统计 + 编辑按钮。
 *
 * 行本身是键盘可达的 `role="button"`（Enter / 空格选中），但**不用 `clickableKey`**：
 * 展开后会嵌一个 `<form>`，`clickableKey` 的 keydown 会冒泡到行上，把输入框里的空格/回车
 * 一起吃掉（`preventDefault` 会阻止在关键词里打空格）。所以这里手动判 `e.target === e.currentTarget`，
 * 并让点击事件跳过表单/按钮里的交互。
 */
function TaskRow({ task, active, expanded, actions }: {
  task: TaskInfo
  active: boolean
  expanded: boolean
  actions: TaskCenterActions
}): React.JSX.Element {
  const status = taskStatusMeta(task.status)
  const keywords = visibleKeywords(task.keywords)
  const select = (): void => { actions.onSelectTask(task.id) }
  return (
    <div
      className={css.taskRow}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      data-active={active || undefined}
      data-expanded={expanded || undefined}
      onClick={(e) => {
        // 行内有表单/按钮：那些点击不该顺带切选中（尤其「编辑」只展开、不改变右栏过滤）。
        if (e.target instanceof Element && e.target.closest('button, input, form') !== null) return
        select()
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault()
          select()
        }
      }}
    >
      <div className={css.taskTop}>
        <span className={css.taskName} title={task.name}>{task.name}</span>
        <span className={css.taskTags}>
          <Badge tone={status.tone} title={status.hint}>{status.label}</Badge>
        </span>
      </div>

      <div className={css.taskMeta}>
        <span className={css.taskScope} title={taskScopeLabel(task)}>{taskScopeLabel(task)}</span>
        <span className={css.taskStat}>{triggerCountLabel(task.triggerCount)}</span>
        <span className={css.taskStat}>{lastTriggeredLabel(task.lastTriggeredAt)}</span>
      </div>

      <div className={css.kwRow}>
        {keywords.shown.map((keyword) => (
          <span key={keyword} className={css.kwChip} title={keyword}>{keyword}</span>
        ))}
        {keywords.hidden > 0 && <span className={css.kwMore}>+{String(keywords.hidden)}</span>}
        <span className={css.kwMore}>{photoLimitLabel(task.photoLimit)}</span>
        <span className={css.kwMore} title={task.callbackUrl !== '' ? task.callbackUrl : undefined}>回调 {callbackUrlLabel(task.callbackUrl)}</span>
      </div>

      <div className={css.taskActions}>
        <Button
          size="sm"
          variant="outline"
          aria-expanded={expanded}
          aria-label={`${expanded ? '收起' : '展开'}「${task.name}」的配置表单`}
          onClick={() => { actions.onToggleEdit(task.id) }}
        >
          {expanded ? '收起' : '编辑'}
        </Button>
        <span className={kitCss.textMeta}>{task.chatType === 'group' ? '群聊任务' : '单聊任务'}</span>
      </div>

      {expanded && (
        <TaskEditForm
          task={task}
          onSave={(input) => actions.onSaveTask(task, input)}
          onSetStatus={(status) => actions.onSetStatus(task.id, status)}
          onDelete={() => actions.onDeleteTask(task.id)}
          onNotice={actions.onNotice}
        />
      )}
    </div>
  )
}

/** 右栏一行：触发时间 / 会话与对象 / 命中关键词 / 文本摘要 / 图片数 / 回调徽标。 */
function TriggerRow({ record, onOpen }: {
  record: TaskTriggerRecord
  onOpen: (id: number) => void
}): React.JSX.Element {
  const callback = callbackStatusMeta(record.callbackStatus)
  const full = plainText(record.text)
  return (
    <div
      className={css.triggerRow}
      {...clickableKey(() => { onOpen(record.id) }, { label: `查看 ${triggerTimeText(record.triggeredAt)} 的触发记录` })}
    >
      <div className={css.triggerTop}>
        <span className={css.triggerTime}>{triggerTimeText(record.triggeredAt)}</span>
        <span className={css.triggerTaskName} title={record.taskName}>{record.taskName}</span>
        <Badge tone={callback.tone} title={callback.hint}>{callback.label}</Badge>
      </div>
      <div className={css.triggerPeople} title={`${record.chatName} / ${record.targetName}`}>
        {record.chatName || '未知会话'} / {record.targetName || '未知对象'}
      </div>
      <div className={css.triggerFoot}>
        <span className={css.triggerKw}>命中「{record.keyword}」</span>
        <span>{recordImageCountLabel(record.images.length)}</span>
      </div>
      <div className={css.triggerText} title={full === '' ? '（无文本）' : full}>{recordSummary(record.text)}</div>
    </div>
  )
}

/**
 * 双栏纯展示视图（容器与 SSR 冒烟共用）。
 * @param props - 两栏快照、选中/展开/弹窗状态与动作集合（见 {@link TaskCenterViewProps}）。
 * @returns 面板元素。
 */
export function TaskCenterView(props: TaskCenterViewProps): React.JSX.Element {
  const { actions } = props
  const confirm = useConfirm()
  const counts = taskCounts(props.tasks)
  const selectedTask = props.tasks.find((t) => t.id === props.selectedTaskId) ?? null
  // 右栏**始终**按选中项过一遍：服务端已按 taskId 查过，这里兜住「切换瞬间两栏不同源」。
  const records = filterTriggersByTask(props.triggers, props.selectedTaskId)
  const tasksEmpty = !props.tasksLoading && props.tasks.length === 0 && props.tasksError === null && props.tasksReadError === null
  const recordsEmpty = !props.triggersLoading && records.length === 0 && props.triggersError === null && props.triggersReadError === null

  return (
    <div className={css.root}>
      <PanelHeader
        title="任务信息"
        desc="命中关键词后记录触发内容并投递回调；仅「已完善」的任务参与触发与回调"
        actions={(
          <>
            <Button size="sm" variant="pill" onClick={actions.onRefresh} disabled={props.tasksLoading || props.triggersLoading}>
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
                    message: '会按关键词扫描一次新消息，把命中项写入触发记录并按回调地址投递。',
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
            任务 {counts.total} · 待完善 {counts.incomplete} · 已完善 {counts.ready} · 触发记录 {records.length}
          </span>
        )}
      />

      {props.notice !== null && <div className={css.notice} role="status">{props.notice}</div>}

      <div className={css.board}>
        <section className={css.pane} aria-label="任务信息">
          <div className={css.paneHd}>
            <span className={css.paneTitle}>任务信息</span>
            {props.tasksStale === true && <Badge tone="amber" title="查询失败，当前显示的是本地缓存，可能不是最新">缓存数据</Badge>}
            <span className={css.paneMeta}>{counts.total} 个任务</span>
          </div>
          <div className={css.paneBody}>
            {props.tasksReadError !== null && (
              <ErrorState message={`任务库读取失败（不是「没有任务」）：${props.tasksReadError}`} />
            )}
            {props.tasksError !== null && <ErrorState message={`任务列表加载失败：${props.tasksError}`} />}
            {props.tasksLoading && props.tasks.length === 0 && <LoadingState variant="compact" label="加载任务信息…" />}
            {tasksEmpty && (
              <EmptyState
                icon="🗂️"
                title="还没有任务信息"
                desc="在聊天会话 / 聊天信息里点「新建任务」创建：选会话与触发对象、填关键词；配好回调地址并标记「已完善」后，命中关键词的新消息会出现在右栏。"
              />
            )}
            {props.tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                active={task.id === props.selectedTaskId}
                expanded={task.id === props.expandedTaskId}
                actions={actions}
              />
            ))}
          </div>
        </section>

        <section className={css.pane} aria-label="任务触发记录">
          <div className={css.paneHd}>
            <span className={css.paneTitle}>{triggerPaneTitle(selectedTask)}</span>
            {props.triggersStale === true && <Badge tone="amber" title="查询失败，当前显示的是本地缓存，可能不是最新">缓存数据</Badge>}
            {selectedTask !== null && (
              <LinkButton onClick={() => { actions.onSelectTask(null) }}>全部记录</LinkButton>
            )}
            <span className={css.paneMeta}>{records.length} 条</span>
          </div>
          <div className={css.paneBody}>
            {props.triggersReadError !== null && (
              <ErrorState message={`触发记录读取失败（不是「没有记录」）：${props.triggersReadError}`} />
            )}
            {props.triggersError !== null && <ErrorState message={`触发记录加载失败：${props.triggersError}`} />}
            {props.triggersLoading && props.triggers.length === 0 && <LoadingState variant="compact" label="加载触发记录…" />}
            {recordsEmpty && (selectedTask !== null ? (
              <EmptyState
                icon="⚡"
                title="该任务还没有触发记录"
                desc="任务标记「已完善」后，命中关键词的新消息会记录在这里（也可以点上方「立即检查」马上扫一次）。"
              />
            ) : (
              <EmptyState
                icon="⚡"
                title="还没有任何触发记录"
                desc="创建任务并标记「已完善」后，命中关键词的新消息会出现在这里；点左栏的任务可以按任务筛选。"
              />
            ))}
            {records.map((record) => (
              <TriggerRow key={record.id} record={record} onOpen={actions.onOpenRecord} />
            ))}
          </div>
        </section>
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
  const [scanning, setScanning] = useState(false)
  const { notice, flash, hold } = useTransientNotice(4000)

  const taskState = useFreshData('taskCenter:tasks', fetchTasks, { shouldCache: (d) => !d.readError, liveRefresh: true })
  // 触发记录的缓存键带上选中任务：切换筛选 = 换一份数据，`useFreshData` 会先清空再取。
  const fetchTriggers = useCallback(
    () => apiListTaskTriggers(selectedTaskId !== null ? { taskId: selectedTaskId } : undefined),
    [selectedTaskId],
  )
  const triggerState = useFreshData(
    'taskCenter:triggers:' + (selectedTaskId === null ? 'all' : String(selectedTaskId)),
    fetchTriggers,
    { shouldCache: (d) => !d.readError, liveRefresh: true },
  )
  const reloadTasks = taskState.reload
  const reloadTriggers = triggerState.reload

  /** 两栏一起回源（写动作/事件/刷新/扫描后的统一出口）。 */
  const refreshBoth = useCallback(async (): Promise<void> => {
    await Promise.all([reloadTasks(), reloadTriggers()])
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
  const triggerItems = triggerState.data?.items ?? NO_TRIGGERS
  /** 弹窗内容按 id 从**最新**快照解析：找不到时传 null，弹窗显示「记录已不可用」。 */
  const openRecord = useMemo(
    () => (openRecordId === null ? null : (triggerItems.find((r) => r.id === openRecordId) ?? null)),
    [openRecordId, triggerItems],
  )

  const handleRefresh = useCallback((): void => {
    void refreshBoth().then(() => { flash('已刷新最新数据') })
  }, [flash, refreshBoth])

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
      }
      return result
    } catch (e) {
      const message = (e as Error).message
      hold(`删除任务失败：${message}`)
      return { ok: false, error: message }
    }
  }, [hold])

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
      triggersReadError={triggerState.data?.readError ?? null}
      tasksStale={taskState.stale}
      triggersStale={triggerState.stale}
      scanning={scanning}
      notice={notice}
      actions={actions}
    />
  )
}
