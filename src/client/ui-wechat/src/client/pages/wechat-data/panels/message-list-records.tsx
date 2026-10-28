/** 消息记录：筛选、统计与完整台账表格。 */
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
  STATUS_LABEL,
  localImageKey,
  sourceTone,
  statusTone,
  timeText,
} from './message-list-view.ts'
import { withEnterprise } from './enterprise-identity.ts'
import { IdentityName } from './identity.tsx'
import css from './message-list.module.css'

interface MessageListRecordsProps {
  records: MessageListRecord[]
  total: number
  stats: { success: number; failed: number; pending: number }
  loading: boolean
  readError: string
  search: string
  status: '' | MessageListStatus
  source: '' | MessageListSource
  thumbs: Record<string, string>
  canWrite: boolean
  resendingId: number | null
  onSearchChange: (value: string) => void
  onStatusChange: (value: '' | MessageListStatus) => void
  onSourceChange: (value: '' | MessageListSource) => void
  onRefresh: () => void
  onResend: (record: MessageListRecord) => void
}

function recordIdentity(name: string, enterpriseName?: string): string {
  return name ? withEnterprise(name, enterpriseName) : '—'
}

export function MessageListRecords(props: MessageListRecordsProps): React.JSX.Element {
  const hasFilter = props.search.trim() !== '' || props.status !== '' || props.source !== ''
  return (
    <>
      <div className={css.statStrip}>
        <span><b>{props.total}</b> 当前记录</span>
        <span className={css.statPending}><b>{props.stats.pending}</b> 待执行</span>
        <span className={css.statSuccess}><b>{props.stats.success}</b> 成功</span>
        <span className={css.statFailed}><b>{props.stats.failed}</b> 失败</span>
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
      </div>

      {props.readError && (
        <ErrorState
          message="消息记录读取失败"
          detail={props.readError}
          onRetry={props.onRefresh}
        />
      )}
      <div className={css.tableShell}>
        {props.loading && props.records.length === 0 ? (
          <LoadingState label="加载消息记录…" />
        ) : props.records.length === 0 ? (
          <EmptyState
            icon="✉"
            title={hasFilter ? '没有匹配的记录' : '还没有消息记录'}
            desc="任务命中、外部 Webhook 或手动新增后，会在这里看到每次回复的状态。"
          />
        ) : (
          <div className={css.tableScroll}>
            <table className={css.table}>
              <thead>
                <tr>
                  <th>序号</th>
                  <th>回复 ID</th>
                  <th>会话名</th>
                  <th>触发对象</th>
                  <th className={css.textCellHead}>触发文本</th>
                  <th>触发图片</th>
                  <th>触发时间</th>
                  <th>来源</th>
                  <th>状态</th>
                  <th>操作</th>
                  <th className={css.noteCellHead}>备注</th>
                </tr>
              </thead>
              <tbody>
                {props.records.map((record) => (
                  <tr key={record.id}>
                    <td className={css.numCell}>#{record.id}</td>
                    <td><code className={css.replyId} title={record.replyId}>{record.replyId}</code></td>
                    <td className={css.nameCell} title={recordIdentity(record.chatName, record.chatEnterpriseName)}>
                      <IdentityName name={record.chatName || '未知会话'} username={record.chatUsername} size={20}>
                        {recordIdentity(record.chatName, record.chatEnterpriseName)}
                      </IdentityName>
                    </td>
                    <td className={css.nameCell} title={recordIdentity(record.targetName, record.targetEnterpriseName)}>
                      <IdentityName name={record.targetName || '未知对象'} username={record.targetUsername} size={20}>
                        {recordIdentity(record.targetName, record.targetEnterpriseName)}
                      </IdentityName>
                    </td>
                    <td className={css.textCell}><span title={record.text}>{record.text || '—'}</span></td>
                    <td><RecordImages record={record} thumbs={props.thumbs} /></td>
                    <td className={css.timeCell}>{timeText(record.triggeredAt)}</td>
                    <td><Badge tone={sourceTone(record.source)}>{SOURCE_LABEL[record.source]}</Badge></td>
                    <td>
                      <Badge tone={statusTone(record.status)} title={record.error || undefined}>
                        {STATUS_LABEL[record.status]}
                      </Badge>
                      {record.attempts > 0 && <span className={css.attempts}>第 {record.attempts} 次</span>}
                    </td>
                    <td>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!props.canWrite || props.resendingId === record.id}
                        onClick={() => { props.onResend(record) }}
                        {...desktopActionProps()}
                      >
                        {props.resendingId === record.id ? '重发中…' : '重发'}
                      </Button>
                    </td>
                    <td className={css.noteCell}>
                      <span title={record.error || record.note}>
                        {record.error
                          ? <span className={css.rowError}>{record.error}</span>
                          : (record.note || '—')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

function RecordImages(props: {
  record: MessageListRecord
  thumbs: Record<string, string>
}): React.JSX.Element {
  if (props.record.images.length === 0) return <span className={css.muted}>—</span>
  const shown = props.record.images.slice(0, 3)
  return (
    <div className={css.imageStack} title={String(props.record.images.length) + ' 张图片'}>
      {shown.map((image, index) => {
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
