/**
 * 任务信息双栏的列表视图（2026-10-20）。
 *
 * 从 `TaskCenter.tsx` 抽出：面板容器已达到仓库 1000 行硬上限，而任务行 / 触发记录行 /
 * 两栏搜索与批量选择是可以独立测试的纯展示层。这里不取数、不弹确认框，所有写动作仍由
 * `TaskCenterView` 通过 props 注入；保持原可访问性名称和 DOM 结构不变，SSR 与 E2E 无需迁移。
 *
 * 2026-10-21：编辑入口从「左栏行内展开表单」改成「右侧抽屉」后，本文件的任务行**只负责
 * 打开抽屉**（`actions.onToggleEdit`），不再渲染 `<TaskEditForm>` —— 抽屉外壳与表单都在
 * `TaskCenter.tsx` / `task-center-edit-form.tsx`。行内保留触发方式摘要，用户不打开抽屉也能
 * 一眼看出这条任务往哪投递：摘要由 `taskTriggerSummary(task, descriptor)` 按**厂商描述符**
 * 生成（Webhook 主机名 / 厂商 `summary` 字段）；目录没加载出来时内置 Webhook 仍显示旧文案。
 *
 * @module task-center-panes
 */
import type {
  RpaVendorDescriptor,
  TaskInfo,
  TaskTriggerRecord,
} from '@deepseek-ai/dsh-wechat-data/types'
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LinkButton,
  LoadingState,
  SearchInput,
} from '../ui/kit.tsx'
import { desktopActionProps } from '../ui/desktop-only.tsx'
import { TaskDeleteButton } from './task-delete-button.tsx'
import {
  callbackStatusMeta,
  exceedsBatchLimit,
  filterTasksBySearch,
  findVendorDescriptor,
  lastTriggeredLabel,
  photoLimitLabel,
  plainText,
  recordImageCountLabel,
  recordSummary,
  selectAllIds,
  selectionCountText,
  taskCounts,
  taskScopeLabel,
  taskStatusMeta,
  taskTriggerSummary,
  triggerCountLabel,
  triggerPaneTitle,
  triggerTimeText,
  TASK_BATCH_DELETE_MAX,
  visibleKeywords,
} from './task-center.ts'
import type { TaskCenterActions } from './TaskCenter.tsx'
import css from './task-center.module.css'
import kitCss from '../ui/kit.module.css'

/**
 * 左栏一行：任务名 / 状态 / 会话与目标 / 关键词 chips / 触发方式与照片 / 触发统计 + 编辑按钮。
 *
 * 行本身是键盘可达的 `role="button"`（Enter / 空格选中），但**不用 `clickableKey`**：
 * 行内有「编辑 / 删除」两个按钮，`clickableKey` 的 keydown 会冒泡到行上一起触发选中。
 * 所以这里手动判 `e.target === e.currentTarget`，并让点击事件跳过按钮里的交互。
 * 「编辑」只打开右侧抽屉（`onToggleEdit`），**不会**顺带改变右栏筛选（那是点行身的语义）。
 */
function TaskRow({ task, active, editing, batchMode, checked, vendorCatalog, actions, onToggleSelection }: {
  task: TaskInfo
  active: boolean
  editing: boolean
  batchMode: boolean
  checked: boolean
  vendorCatalog: readonly RpaVendorDescriptor[]
  actions: TaskCenterActions
  onToggleSelection: () => void
}): React.JSX.Element {
  const status = taskStatusMeta(task.status)
  const keywords = visibleKeywords(task.keywords)
  const descriptor = findVendorDescriptor(vendorCatalog, task.triggerMethod)
  const summary = taskTriggerSummary(task, descriptor)
  const summaryTitle = descriptor === null
    ? (task.triggerMethod === 'webhook' ? undefined : '当前版本没有该厂商描述符（厂商已下线）')
    : `${descriptor.name}：${descriptor.summary}`
  const activate = (): void => {
    if (batchMode) {
      onToggleSelection()
      return
    }
    actions.onSelectTask(task.id)
  }
  return (
    <div
      className={css.taskRow}
      role={batchMode ? 'checkbox' : 'button'}
      tabIndex={0}
      aria-checked={batchMode ? checked : undefined}
      aria-pressed={batchMode ? undefined : active}
      aria-label={batchMode ? `选择任务「${task.name}」` : undefined}
      data-active={active || checked || undefined}
      data-expanded={editing || undefined}
      onClick={(e) => {
        // 行内有按钮：那些点击不该顺带切选中（尤其「编辑」只开抽屉、不改变右栏过滤）。
        if (e.target instanceof Element && e.target.closest('button, input, form') !== null) return
        activate()
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault()
          activate()
        }
      }}
    >
      <div className={css.taskTop}>
        {batchMode && (
          <input
            type="checkbox"
            className={css.batchCheck}
            checked={checked}
            aria-label={`选择任务「${task.name}」`}
            onChange={() => { onToggleSelection() }}
            onClick={(e) => { e.stopPropagation() }}
          />
        )}
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
        {/* 触发方式摘要（2026-10-21）：按厂商描述符生成（八爪鱼 RPA · FlowId / Webhook <host>）。
            未知厂商（已下线）显示「触发方式不可用（厂商已下线）」。 */}
        <span className={css.triggerSummary} title={summaryTitle} data-trigger-method={task.triggerMethod}>
          {summary}
        </span>
        {task.mentionMeOnly && <span className={css.kwMore}>仅匹配 @我</span>}
      </div>

      {!batchMode && <div className={css.taskActions}>
        <span className={css.taskActionGroup}>
          <Button
            size="sm"
            variant="outline"
            aria-expanded={editing}
            aria-label={`编辑「${task.name}」`}
            onClick={() => { actions.onToggleEdit(task.id) }}
          >
            编辑
          </Button>
          <TaskDeleteButton
            taskName={task.name}
            onDelete={() => actions.onDeleteTask(task.id)}
            onNotice={actions.onNotice}
          />
        </span>
        <span className={kitCss.textMeta}>{task.chatType === 'group' ? '群聊任务' : '单聊任务'}</span>
      </div>}
    </div>
  )
}

/** 右栏一行：触发时间 / 会话与对象 / 命中关键词 / 文本摘要 / 图片数 / 回调徽标。 */
function TriggerRow({ record, batchMode, checked, onActivate, onToggleSelection }: {
  record: TaskTriggerRecord
  batchMode: boolean
  checked: boolean
  onActivate: (id: number) => void
  onToggleSelection: () => void
}): React.JSX.Element {
  const callback = callbackStatusMeta(record.callbackStatus)
  const full = plainText(record.text)
  return (
    <div
      className={css.triggerRow}
      role={batchMode ? 'checkbox' : 'button'}
      tabIndex={0}
      aria-label={batchMode
        ? `选择 ${triggerTimeText(record.triggeredAt)} 的触发记录`
        : `查看 ${triggerTimeText(record.triggeredAt)} 的触发记录`}
      aria-checked={batchMode ? checked : undefined}
      data-active={checked || undefined}
      onClick={() => { if (batchMode) onToggleSelection(); else onActivate(record.id) }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return
        e.preventDefault()
        if (batchMode) onToggleSelection()
        else onActivate(record.id)
      }}
    >
      <div className={css.triggerTop}>
        {batchMode && (
          <input
            type="checkbox"
            className={css.batchCheck}
            checked={checked}
            aria-label={`选择 ${triggerTimeText(record.triggeredAt)} 的触发记录`}
            onChange={() => { onToggleSelection() }}
            onClick={(e) => { e.stopPropagation() }}
          />
        )}
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

/** 两栏共用的批量操作条：全选 / 清空 / 选中计数 / 删除所选。 */
function BatchActionBar({ ariaLabel, selectedCount, selectAllDisabled, onSelectAll, onClear, onDelete }: {
  ariaLabel: string
  selectedCount: number
  selectAllDisabled: boolean
  onSelectAll: () => void
  onClear: () => void
  onDelete: () => void
}): React.JSX.Element {
  return (
    <div className={css.batchBar} role="group" aria-label={ariaLabel}>
      <Button type="button" size="sm" variant="outline" onClick={onSelectAll} disabled={selectAllDisabled}>
        全选
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={onClear} disabled={selectedCount === 0}>
        清空
      </Button>
      <span className={kitCss.textMeta}>{selectionCountText(selectedCount)}</span>
      {exceedsBatchLimit(selectedCount) && (
        <span className={css.batchLimit} role="alert">
          一次最多删除 {TASK_BATCH_DELETE_MAX} 条，请分批操作
        </span>
      )}
      <Button
        type="button"
        size="sm"
        variant="danger"
        onClick={onDelete}
        disabled={selectedCount === 0 || exceedsBatchLimit(selectedCount)}
        {...desktopActionProps()}
      >
        删除所选 ({selectedCount})
      </Button>
    </div>
  )
}

/** 左栏：任务搜索、批量选择与任务行。 */
export function TaskPane({
  tasks,
  loading,
  error,
  readError,
  stale,
  search,
  onSearchChange,
  selectedTaskId,
  expandedTaskId,
  vendorCatalog,
  batchMode,
  selectedIds,
  onBatchModeChange,
  onToggleSelection,
  onDeleteSelected,
  actions,
}: {
  tasks: readonly TaskInfo[]
  loading: boolean
  error: string | null
  readError: string | null
  stale: boolean
  search: string
  onSearchChange: (search: string) => void
  selectedTaskId: number | null
  expandedTaskId: number | null
  /** 触发方式目录（任务行摘要按描述符生成；空 = 目录未加载/读取失败）。 */
  vendorCatalog: readonly RpaVendorDescriptor[]
  batchMode: boolean
  selectedIds: ReadonlySet<number>
  onBatchModeChange: (mode: boolean) => void
  onToggleSelection: (id: number) => void
  onDeleteSelected: () => void
  actions: TaskCenterActions
}): React.JSX.Element {
  const counts = taskCounts(tasks)
  const visibleTasks = filterTasksBySearch(tasks, search)
  const visibleIds = visibleTasks.map((task) => task.id)
  /**
   * 已有快照时的刷新/搜索回源不能把当前列表换成空态：
   * `loading` 只服务首屏，内容是否存在由 `tasks` 决定。
   */
  const empty = !loading && tasks.length === 0 && error === null && readError === null
  const noMatch = tasks.length > 0 && visibleTasks.length === 0 && error === null && readError === null
  return (
    <section className={css.pane} aria-label="任务信息">
      <div className={css.paneHd}>
        <span className={css.paneTitle}>任务信息</span>
        {stale && <Badge tone="amber" title="查询失败，当前显示的是本地缓存，可能不是最新">缓存数据</Badge>}
        <SearchInput
          value={search}
          onChange={onSearchChange}
          placeholder="搜索任务名 / 关键词 / 会话"
          ariaLabel="搜索任务"
          className={css.paneSearch}
        />
        <Button
          size="sm"
          variant={batchMode ? 'outline' : 'pill'}
          onClick={() => { onBatchModeChange(!batchMode) }}
          {...desktopActionProps()}
        >
          {batchMode ? '退出批量' : '批量'}
        </Button>
        <span className={css.paneMeta}>
          {search.trim() === '' ? `${counts.total} 个任务` : `${visibleTasks.length} / ${counts.total} 个任务`}
        </span>
      </div>
      {batchMode && (
        <BatchActionBar
          ariaLabel="任务批量操作"
          selectedCount={selectedIds.size}
          selectAllDisabled={visibleIds.length === 0}
          onSelectAll={() => {
            for (const id of selectAllIds(visibleIds)) {
              if (!selectedIds.has(id)) onToggleSelection(id)
            }
          }}
          onClear={() => {
            for (const id of selectedIds) onToggleSelection(id)
          }}
          onDelete={onDeleteSelected}
        />
      )}
      <div className={css.paneBody}>
        {readError !== null && <ErrorState message={`任务库读取失败（不是「没有任务」）：${readError}`} />}
        {error !== null && <ErrorState message={`任务列表加载失败：${error}`} />}
        {loading && tasks.length === 0 && <LoadingState variant="compact" label="加载任务信息…" />}
        {empty && (
          <EmptyState
            icon="🗂️"
            title="还没有任务信息"
            desc="在聊天会话 / 聊天信息里点「新建任务」创建：选会话与触发对象、填关键词；配好 Webhook 地址并标记「已完善」后，命中关键词的新消息会出现在右栏。"
          />
        )}
        {noMatch && (
          <EmptyState
            icon="🔍"
            title="没有匹配的任务"
            desc="换个任务名、关键词、会话或对象再试；清空搜索框可看全部任务。"
          />
        )}
        {visibleTasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            active={task.id === selectedTaskId}
            editing={task.id === expandedTaskId}
            batchMode={batchMode}
            checked={selectedIds.has(task.id)}
            vendorCatalog={vendorCatalog}
            actions={actions}
            onToggleSelection={() => { onToggleSelection(task.id) }}
          />
        ))}
      </div>
    </section>
  )
}

/** 右栏：触发记录搜索、批量选择、列表与分页。 */
export function TriggerPane({
  records,
  selectedTask,
  loading,
  error,
  readError,
  stale,
  search,
  searchDraft,
  onSearchDraftChange,
  total,
  hasMore,
  loadingMore,
  loadMoreError,
  onLoadMore,
  batchMode,
  selectedIds,
  onBatchModeChange,
  onToggleSelection,
  onDeleteSelected,
  actions,
}: {
  records: readonly TaskTriggerRecord[]
  selectedTask: TaskInfo | null
  loading: boolean
  error: string | null
  readError: string | null
  stale: boolean
  search: string
  searchDraft: string
  onSearchDraftChange: (search: string) => void
  total: number
  hasMore: boolean
  loadingMore: boolean
  loadMoreError: string | null
  onLoadMore: () => void
  batchMode: boolean
  selectedIds: ReadonlySet<number>
  onBatchModeChange: (mode: boolean) => void
  onToggleSelection: (id: number) => void
  onDeleteSelected: () => void
  actions: TaskCenterActions
}): React.JSX.Element {
  const visibleIds = records.map((record) => record.id)
  /** 已有记录时刷新期间保留列表；`loading` 只控制首屏占位。 */
  const empty = !loading && records.length === 0 && error === null && readError === null
  const showMore = hasMore && records.length > 0
  return (
    <section className={css.pane} aria-label="任务触发记录">
      <div className={css.paneHd}>
        <span className={css.paneTitle}>{triggerPaneTitle(selectedTask)}</span>
        {stale && <Badge tone="amber" title="查询失败，当前显示的是本地缓存，可能不是最新">缓存数据</Badge>}
        {selectedTask !== null && <LinkButton onClick={() => { actions.onSelectTask(null) }}>全部记录</LinkButton>}
        <SearchInput
          value={searchDraft}
          onChange={onSearchDraftChange}
          placeholder="搜索正文 / 任务 / 会话 / 关键词"
          ariaLabel="搜索触发记录"
          className={css.paneSearch}
        />
        <Button
          size="sm"
          variant={batchMode ? 'outline' : 'pill'}
          onClick={() => { onBatchModeChange(!batchMode) }}
          {...desktopActionProps()}
        >
          {batchMode ? '退出批量' : '批量'}
        </Button>
        <span className={css.paneMeta}>{records.length} / {total} 条</span>
      </div>
      {batchMode && (
        <BatchActionBar
          ariaLabel="触发记录批量操作"
          selectedCount={selectedIds.size}
          selectAllDisabled={visibleIds.length === 0}
          onSelectAll={() => {
            for (const id of selectAllIds(visibleIds)) {
              if (!selectedIds.has(id)) onToggleSelection(id)
            }
          }}
          onClear={() => {
            for (const id of selectedIds) onToggleSelection(id)
          }}
          onDelete={onDeleteSelected}
        />
      )}
      <div className={css.paneBody}>
        {readError !== null && <ErrorState message={`触发记录读取失败（不是「没有记录」）：${readError}`} />}
        {error !== null && <ErrorState message={`触发记录加载失败：${error}`} />}
        {loading && records.length === 0 && <LoadingState variant="compact" label="加载触发记录…" />}
        {empty && search !== '' ? (
          <EmptyState
            icon="🔍"
            title="没有匹配的触发记录"
            desc={`当前搜索「${search}」没有命中；可换个词或清除搜索。`}
          />
        ) : empty && (selectedTask !== null ? (
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
          <TriggerRow
            key={record.id}
            record={record}
            batchMode={batchMode}
            checked={selectedIds.has(record.id)}
            onActivate={actions.onOpenRecord}
            onToggleSelection={() => { onToggleSelection(record.id) }}
          />
        ))}
        {(showMore || loadMoreError !== null) && (
          <div className={css.loadMore}>
            {showMore && (
              <Button size="sm" variant="outline" disabled={loadingMore} onClick={onLoadMore}>
                {loadingMore ? '加载中…' : `加载更多（已 ${records.length} / ${total}）`}
              </Button>
            )}
            {loadMoreError !== null && (
              <span className={kitCss.error} role="alert">加载更多失败：{loadMoreError}</span>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
