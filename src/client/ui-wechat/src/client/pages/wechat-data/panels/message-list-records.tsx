/** 消息记录：筛选、统计与完整台账表格。 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import type {
  MessageListRecord,
  MessageListSource,
  MessageListStatus,
} from '@deepseek-ai/dsh-wechat-data/types'
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  SearchInput,
  Segmented,
} from '../ui/kit.tsx'
import { desktopActionProps } from '../ui/desktop-only.tsx'
import {
  SOURCE_FILTERS,
  SOURCE_LABEL,
  STATUS_FILTERS,
  batchDeleteEligibility,
  isAiReplyWaitingForWebhook,
  localImageKey,
  messageListRecordStatusLabel,
  sourceTone,
  statusTone,
  timeText,
} from './message-list-view.ts'
import { useMessageListBatch } from './use-message-list-batch.ts'
import { withEnterprise } from './enterprise-identity.ts'
import { IdentityName } from './identity.tsx'
import {
  messageListRowsForRender,
  useMessageListRowVirtualizer,
} from './message-list-virtual.ts'
import css from './message-list.module.css'

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

interface MessageListRecordsProps {
  records: MessageListRecord[]
  total: number
  stats: { success: number; failed: number; pending: number; queued: number; running: number }
  loading: boolean
  readError: string
  search: string
  status: '' | MessageListStatus
  source: '' | MessageListSource
  thumbs: Record<string, string>
  canWrite: boolean
  hasMore?: boolean
  loadingMore?: boolean
  loadMoreError?: string
  windowCapped?: boolean
  truncated?: boolean
  resendingId: number | null
  batchBusy: boolean
  probeBusyId: number | null
  jobBusyId: number | null
  onSearchChange: (value: string) => void
  onStatusChange: (value: '' | MessageListStatus) => void
  onSourceChange: (value: '' | MessageListSource) => void
  onRefresh: () => void
  onLoadMore?: () => void
  onResend: (record: MessageListRecord) => void
  onBatchResend: (records: MessageListRecord[]) => Promise<boolean>
  onBatchProbe: (records: MessageListRecord[]) => Promise<boolean>
  onBatchDelete: (records: MessageListRecord[]) => Promise<boolean>
  onProbe: (record: MessageListRecord) => void
  onQueryJob: (record: MessageListRecord) => void
  /** 打开规则配置；AI 记录缺投递地址时直接给出下一步。 */
  onConfigureRule: () => void
  /** 为单条未配置记录打开规则表单，并带入会话名与触发对象。 */
  onConfigureRecordRule: (record: MessageListRecord) => void
}

function recordIdentity(name: string, enterpriseName?: string): string {
  return name ? withEnterprise(name, enterpriseName) : '—'
}

type MessageListBatchState = ReturnType<typeof useMessageListBatch>

function MessageListRecordsHeader(
  props: MessageListRecordsProps & { batch: MessageListBatchState },
): React.JSX.Element {
  const unrouted = props.records.filter((record) => (
    record.status === 'pending' && record.webhookUrl === ''
  )).length
  const aiWaitingConfig = props.records.filter(isAiReplyWaitingForWebhook).length
  return (
    <>
      <div className={css.statStrip}>
        <span><b>{props.records.length}</b> / {props.total} 已加载</span>
        <span className={css.statPending}>
          <b>{props.stats.pending}</b> 待执行
          {aiWaitingConfig > 0 ? ` / ${String(aiWaitingConfig)} 待配置` : ''} · 当前窗口
        </span>
        <span className={css.statPending}>
          <b>{props.stats.queued + props.stats.running}</b> 下游处理中 · 当前窗口
        </span>
        <span className={css.statSuccess}><b>{props.stats.success}</b> 成功 · 当前窗口</span>
        <span className={css.statFailed}><b>{props.stats.failed}</b> 失败 · 当前窗口</span>
      </div>
      <div className={css.filters}>
        <SearchInput
          value={props.search}
          onChange={props.onSearchChange}
          placeholder="搜索回复 id / 会话 / 对象 / 文本 / 备注"
          ariaLabel="搜索消息记录"
          className={css.search}
        />
        <Segmented
          options={STATUS_FILTERS}
          value={props.status}
          onChange={(value) => { props.onStatusChange(value as '' | MessageListStatus) }}
          ariaLabel="状态筛选"
        />
        <Segmented
          options={SOURCE_FILTERS}
          value={props.source}
          onChange={(value) => { props.onSourceChange(value as '' | MessageListSource) }}
          ariaLabel="来源筛选"
        />
        {props.canWrite && (
          <Button
            size="sm"
            variant={props.batch.active ? 'primary' : 'ghost'}
            disabled={props.batchBusy}
            onClick={props.batch.toggleMode}
            {...desktopActionProps()}
          >
            {props.batch.active ? '退出批量' : '批量处理'}
          </Button>
        )}
      </div>
      {props.batch.active && (
        <BatchToolbar
          busy={props.batchBusy}
          selectableCount={props.batch.selectableCount}
          selectedCount={props.batch.selectedCount}
          resendableCount={props.batch.resendableCount}
          probeableCount={props.batch.probeableCount}
          deletableCount={props.batch.deletableCount}
          allSelected={props.batch.allSelected}
          onToggleAll={props.batch.toggleAll}
          onClear={props.batch.clear}
          onResend={() => { void props.batch.runResend() }}
          onProbe={() => { void props.batch.runProbe() }}
          onDelete={() => { void props.batch.runDelete() }}
        />
      )}
      {unrouted > 0 && (
        <div className={`${css.inlineNotice} ${css.noticeWarn}`} role="status">
          <span>
            当前已加载记录中有 {String(unrouted)} 条待执行记录还没有投递地址。
            正文已保存在消息列表，但需要先配置 Webhook 规则才能发送。
          </span>
          <Button
            size="sm"
            variant="primary"
            disabled={!props.canWrite}
            onClick={props.onConfigureRule}
            {...desktopActionProps()}
          >
            去配置规则
          </Button>
        </div>
      )}
    </>
  )
}

function MessageListTableHead(props: {
  batch: MessageListBatchState
  batchBusy: boolean
}): React.JSX.Element {
  return (
    <thead>
      <tr>
        <th>
          <div className={css.numCellInner}>
            {props.batch.active && (
              <input
                type="checkbox"
                className={css.rowCheckbox}
                checked={props.batch.allSelected}
                disabled={props.batchBusy || props.batch.selectableCount === 0}
                aria-label="全选当前可处理记录"
                onChange={props.batch.toggleAll}
              />
            )}
            <span>序号</span>
          </div>
        </th>
        <th>会话名</th>
        <th>状态</th>
        <th className={css.noteCellHead}>备注</th>
        <th>操作</th>
        <th>触发对象</th>
        <th className={css.textCellHead}>触发文本</th>
        <th>来源</th>
        <th>触发时间</th>
        <th>触发附件</th>
        <th>回复 ID</th>
      </tr>
    </thead>
  )
}

function MessageListTable(
  props: MessageListRecordsProps & { batch: MessageListBatchState },
): React.JSX.Element {
  const tableScrollRef = useRef<HTMLDivElement | null>(null)
  const rowVirtualizer = useMessageListRowVirtualizer(props.records, tableScrollRef)
  const renderedRows = messageListRowsForRender(rowVirtualizer, props.records)
  const filterKey = props.search + '\u0000' + props.status + '\u0000' + props.source
  const scrollAnchorRef = useRef<{
    filterKey: string
    recordId: number
    offset: number
  } | null>(null)

  useIsomorphicLayoutEffect(() => {
    scrollAnchorRef.current = null
    tableScrollRef.current?.scrollTo?.({ top: 0 })
  }, [filterKey])

  useIsomorphicLayoutEffect(() => {
    const anchor = scrollAnchorRef.current
    const scroller = tableScrollRef.current
    if (anchor === null || scroller === null || anchor.filterKey !== filterKey) return
    const index = props.records.findIndex((record) => record.id === anchor.recordId)
    if (index < 0) {
      scrollAnchorRef.current = null
      return
    }
    const offsetInfo = rowVirtualizer.getOffsetForIndex(index, 'start')
    if (offsetInfo === undefined) return
    const top = offsetInfo[0] + anchor.offset
    if (Math.abs(top - scroller.scrollTop) > 0.5) {
      rowVirtualizer.scrollToOffset(top, { align: 'start' })
    }
  }, [filterKey, props.records, rowVirtualizer])

  const captureScrollAnchor = (): void => {
    const scroller = tableScrollRef.current
    if (scroller === null) return
    const item = rowVirtualizer.getVirtualItems()
      .find((candidate) => candidate.end > scroller.scrollTop)
    const record = item === undefined ? undefined : props.records[item.index]
    if (item === undefined || record === undefined) {
      scrollAnchorRef.current = null
      return
    }
    scrollAnchorRef.current = {
      filterKey,
      recordId: record.id,
      offset: Math.max(0, scroller.scrollTop - item.start),
    }
  }

  const hasFilter = props.search.trim() !== '' || props.status !== '' || props.source !== ''
  return (
    props.loading && props.records.length === 0 ? (
      <LoadingState label="加载消息记录…" />
    ) : props.records.length === 0 ? (
      <EmptyState
        icon="✉"
        title={hasFilter ? '没有匹配的记录' : '还没有消息记录'}
        desc="任务命中、外部 Webhook 或手动新增后，会在这里看到每次回复的状态。"
        action={(
          <Button
            size="sm"
            variant={hasFilter ? 'outline' : 'primary'}
            onClick={() => {
              if (hasFilter) {
                props.onSearchChange('')
                props.onStatusChange('')
                props.onSourceChange('')
              } else {
                props.onRefresh()
              }
            }}
          >
            {hasFilter ? '清除筛选' : '刷新记录'}
          </Button>
        )}
      />
    ) : (
      <div
        className={css.tableScroll}
        ref={tableScrollRef}
        data-message-list-scroll=""
        style={{ overflowAnchor: 'none' }}
        onScroll={captureScrollAnchor}
      >
        <table className={css.table}>
          <MessageListTableHead batch={props.batch} batchBusy={props.batchBusy} />
          <tbody>
            {renderedRows.pads.top > 0 && (
              <tr aria-hidden="true">
                <td
                  colSpan={11}
                  className={css.virtualPad}
                  style={{ height: String(renderedRows.pads.top) + 'px' }}
                />
              </tr>
            )}
            {renderedRows.rows.map(({ record, index }) => {
              const deleteEligibility = batchDeleteEligibility(record)
              const selectable = deleteEligibility.eligible
              const missingWebhook = record.webhookUrl === ''
              const waitingConfig = isAiReplyWaitingForWebhook(record)
              const downstreamActive = record.status === 'queued' || record.status === 'running'
              return (
              <tr
                key={record.id}
                className={css.recordRow}
                data-index={index}
                data-record-id={record.id}
                ref={rowVirtualizer.measureElement}
              >
                <td className={css.numCell}>
                  <div className={css.numCellInner}>
                    {props.batch.active && (
                      <input
                        type="checkbox"
                        className={css.rowCheckbox}
                        checked={props.batch.selectedIds.has(record.id)}
                        disabled={props.batchBusy || !selectable}
                        title={selectable ? '选择这条记录' : deleteEligibility.reason}
                        aria-label={'选择记录 #' + String(record.id)}
                        onChange={() => { props.batch.toggle(record.id) }}
                      />
                    )}
                    <span title="按当前列表连续编号，删除后自动重算">{String(index + 1)}</span>
                  </div>
                </td>
                <td className={css.nameCell} title={recordIdentity(record.chatName, record.chatEnterpriseName)}>
                  <IdentityName name={record.chatName || '未知会话'} username={record.chatUsername} size={20}>
                    {recordIdentity(record.chatName, record.chatEnterpriseName)}
                  </IdentityName>
                </td>
                <td className={css.statusCell}>
                  <Badge
                    tone={statusTone(record.status)}
                    title={record.error || (waitingConfig
                      ? 'AI 回复正文已保存到消息列表，配置 Webhook 规则后即可投递'
                      : undefined)}
                  >
                    {messageListRecordStatusLabel(record)}
                  </Badge>
                  {record.attempts > 0 && <span className={css.attempts}>第 {record.attempts} 次</span>}
                </td>
                <td className={css.noteCell}>
                  <span
                    className={css.noteLine}
                    data-error={record.error ? 'true' : undefined}
                    title={record.error || record.note}
                  >
                    <span className={css.noteText}>
                      {record.error || record.note || '—'}
                    </span>
                  </span>
                </td>
                <td>
                  <div className={css.rowActions}>
                    {missingWebhook && (
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={!props.canWrite || props.batchBusy}
                        data-configure-rule={record.id}
                        aria-label={'为记录 #' + String(record.id) + ' 配置 Webhook 规则'}
                        title={'带入「' + (record.chatName || '任意会话') + ' × '
                          + (record.targetName || '任意对象') + '」配置规则'}
                        onClick={() => { props.onConfigureRecordRule(record) }}
                        {...desktopActionProps()}
                      >
                        配置规则
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!props.canWrite
                        || props.batchBusy
                        || props.resendingId === record.id
                        || downstreamActive
                        || record.status === 'pending' && missingWebhook}
                      onClick={() => { props.onResend(record) }}
                      {...desktopActionProps()}
                      title={record.status === 'pending' && missingWebhook
                        ? '请先在规则配置中设置会话或全局 Webhook'
                        : downstreamActive
                          ? '下游异步任务尚未结束，禁止重复发送'
                        : record.status === 'sent_unconfirmed'
                          ? '远端可能已发送；请先核对，再在弹出的确认框中确认重发'
                          : '重新投递这条记录'}
                    >
                      {props.resendingId === record.id
                        ? '重发中…'
                        : record.status === 'sent_unconfirmed' ? '核对后重发' : '重发'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!props.canWrite || props.batchBusy || props.probeBusyId === record.id || record.webhookUrl === ''}
                      title="对记录保存的下游地址发 GET 健康检查"
                      onClick={() => { props.onProbe(record) }}
                      {...desktopActionProps()}
                    >
                      {props.probeBusyId === record.id ? '探测中…' : '探测'}
                    </Button>
                    {record.jobId !== undefined && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!props.canWrite || props.batchBusy || props.jobBusyId === record.id}
                        title={'查询下游任务 ' + record.jobId}
                        onClick={() => { props.onQueryJob(record) }}
                        {...desktopActionProps()}
                      >
                        {props.jobBusyId === record.id ? '查询中…' : '查任务'}
                      </Button>
                    )}
                  </div>
                </td>
                <td className={css.nameCell} title={recordIdentity(record.targetName, record.targetEnterpriseName)}>
                  <IdentityName name={record.targetName || '未知对象'} username={record.targetUsername} size={20}>
                    {recordIdentity(record.targetName, record.targetEnterpriseName)}
                  </IdentityName>
                </td>
                <td className={css.textCell}><span title={record.text}>{record.text || '—'}</span></td>
                <td><Badge tone={sourceTone(record.source)}>{SOURCE_LABEL[record.source]}</Badge></td>
                <td className={css.timeCell}>{timeText(record.triggeredAt)}</td>
                <td><RecordImages record={record} thumbs={props.thumbs} /></td>
                <td><code className={css.replyId} title={record.replyId}>{record.replyId}</code></td>
              </tr>
              )
            })}
            {renderedRows.pads.bottom > 0 && (
              <tr aria-hidden="true">
                <td
                  colSpan={11}
                  className={css.virtualPad}
                  style={{ height: String(renderedRows.pads.bottom) + 'px' }}
                />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    )
  )
}

function MessageListLoadBar(props: MessageListRecordsProps): React.JSX.Element | null {
  const loadMoreError = props.loadMoreError ?? ''
  const show = props.loadingMore === true
    || props.hasMore === true
    || props.windowCapped === true
    || props.truncated === true
    || loadMoreError !== ''
  if (!show || props.records.length === 0) return null
  return (
    <div className={css.loadBar} role="status" aria-live="polite">
      <span>
        已加载 <b>{String(props.records.length)}</b> / {String(props.total)} 条
      </span>
      {loadMoreError !== '' && (
        <span className={css.loadError}>{loadMoreError}</span>
      )}
      {props.truncated === true && (
        <span className={css.loadHint}>服务端单页上限已生效，可继续分页加载</span>
      )}
      {props.windowCapped === true && (
        <span className={css.loadHint}>
          已达到 {String(props.records.length)} 条窗口上限，请用搜索或筛选定位更早记录
        </span>
      )}
      {props.loadingMore === true && <span className={css.loadHint}>正在加载更早记录…</span>}
      {props.hasMore === true && props.windowCapped !== true && (
        <Button
          size="sm"
          variant="outline"
          disabled={props.loadingMore === true}
          onClick={() => { props.onLoadMore?.() }}
        >
          {props.loadingMore === true ? '加载中…' : '加载更多'}
        </Button>
      )}
    </div>
  )
}

export function MessageListRecords(props: MessageListRecordsProps): React.JSX.Element {
  const batch = useMessageListBatch({
    records: props.records,
    busy: props.batchBusy,
    onResend: props.onBatchResend,
    onProbe: props.onBatchProbe,
    onDelete: props.onBatchDelete,
  })
  return (
    <>
      <MessageListRecordsHeader {...props} batch={batch} />
      {props.readError && (
        <ErrorState
          message="消息记录读取失败"
          detail={props.readError}
          onRetry={props.onRefresh}
        />
      )}
      <div className={css.tableShell}>
        <MessageListTable {...props} batch={batch} />
        <MessageListLoadBar {...props} />
      </div>
    </>
  )
}

function BatchToolbar(props: {
  busy: boolean
  selectableCount: number
  selectedCount: number
  resendableCount: number
  probeableCount: number
  deletableCount: number
  allSelected: boolean
  onToggleAll: () => void
  onClear: () => void
  onResend: () => void
  onProbe: () => void
  onDelete: () => void
}): React.JSX.Element {
  return (
    <div className={css.batchBar} role="region" aria-label="消息批量处理">
      <div className={css.batchSummary}>
        <b>已选 {String(props.selectedCount)} 条</b>
        <span>{String(props.resendableCount)} 条可重发</span>
        <span>{String(props.probeableCount)} 条可探测</span>
        <span>{String(props.deletableCount)} 条可删除</span>
        <span>当前已加载 {String(props.selectableCount)} 条可选</span>
      </div>
      <div className={css.batchActions}>
        <Button
          size="sm"
          variant="ghost"
          disabled={props.busy || props.selectableCount === 0}
          onClick={props.onToggleAll}
        >
          {props.allSelected ? '取消全选' : '全选已加载'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={props.busy || props.selectedCount === 0}
          onClick={props.onClear}
        >
          清空选择
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={props.busy || props.probeableCount === 0}
          onClick={props.onProbe}
          {...desktopActionProps()}
        >
          {props.busy ? '处理中…' : '批量探测 · ' + String(props.probeableCount)}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={props.busy || props.resendableCount === 0}
          onClick={props.onResend}
          {...desktopActionProps()}
        >
          {props.busy ? '处理中…' : '批量重发 · ' + String(props.resendableCount)}
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={props.busy || props.deletableCount === 0}
          onClick={props.onDelete}
          {...desktopActionProps()}
        >
          {props.busy ? '处理中…' : '批量删除 · ' + String(props.deletableCount)}
        </Button>
      </div>
    </div>
  )
}

function RecordImages(props: {
  record: MessageListRecord
  thumbs: Record<string, string>
}): React.JSX.Element {
  if (props.record.images.length === 0) return <span className={css.muted}>—</span>
  const shown = props.record.images.slice(0, 3)
  return (
    <div className={css.imageStack} title={String(props.record.images.length) + ' 个附件'}>
      {shown.map((image, index) => {
        if (image.stagedId !== undefined) {
          return <span key={index} className={css.imageChip} title={image.name}>{image.name ?? '附件'}</span>
        }
        const src = image.dataUrl
          ?? (image.localId === undefined
            ? undefined
            : props.thumbs[localImageKey(props.record.chatUsername, image.localId)])
        if (src) {
          return <img key={index} className={css.thumb} src={src} alt={'触发图片 ' + String(index + 1)} />
        }
        return <span key={index} className={css.imageChip}>{image.url ? '外链' : '待解码'}</span>
      })}
      {props.record.images.length > shown.length && (
        <span className={css.imageMore}>+{props.record.images.length - shown.length}</span>
      )}
    </div>
  )
}
