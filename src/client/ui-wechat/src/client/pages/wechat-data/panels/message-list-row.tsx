/** 消息列表单行：状态/备注/操作与来源信息。 */
import type { MessageListRecord } from '@deepseek-ai/dsh-wechat-data/types'
import { Badge, Button } from '../ui/kit.tsx'
import { desktopActionProps } from '../ui/desktop-only.tsx'
import {
  SOURCE_LABEL,
  aiReplyAnyDeleteEligibility,
  aiReplyPhase,
  aiReplyRegenerateEligibility,
  batchDeleteEligibility,
  isMissingWebhookError,
  localImageKey,
  messageListFailureCopy,
  messageListRecordStatusHint,
  messageListRecordStatusLabel,
  sourceTone,
  statusTone,
  timeText,
} from './message-list-view.ts'
import { withEnterprise } from './enterprise-identity.ts'
import { IdentityName } from './identity.tsx'
import detailCss from './message-list-detail.module.css'
import css from './message-list.module.css'

export interface MessageListRowProps {
  record: MessageListRecord
  index: number
  /** 本批渲染共用的时间基准，保证同一屏的生成/停滞判定一致。 */
  now: number
  rowRef: (node: HTMLTableRowElement | null) => void
  batchActive: boolean
  batchBusy: boolean
  selected: boolean
  canWrite: boolean
  resendingId: number | null
  probeBusyId: number | null
  jobBusyId: number | null
  thumbs: Record<string, string>
  /** 当前规则表里是否已有覆盖这条记录的规则（地址快照之外的事实）。 */
  hasRule: boolean
  onToggle: (id: number) => void
  onResend: (record: MessageListRecord) => void
  onProbe: (record: MessageListRecord) => void
  onQueryJob: (record: MessageListRecord) => void
  onConfigureRecordRule: (record: MessageListRecord) => void
  /** 打开只读详情；入口是状态徽标与回复 ID，整行不可点。 */
  onOpenDetail: (id: number) => void
  regeneratingId: number | null
  deletingAiReplyId: number | null
  onRegenerateAiReply: (record: MessageListRecord) => void
  onDeleteAiReplyRecord: (record: MessageListRecord) => void
}

function RegenerateIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-2.34 5.66" />
      <path d="M20 4v7h-7" />
    </svg>
  )
}

function TrashIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
    </svg>
  )
}

function recordIdentity(name: string, enterpriseName?: string): string {
  return name ? withEnterprise(name, enterpriseName) : '—'
}

export function MessageListRow(props: MessageListRowProps): React.JSX.Element {
  const { record } = props
  const deleteEligibility = batchDeleteEligibility(record)
  const selectable = deleteEligibility.eligible
  const phase = aiReplyPhase(record, props.now, props.hasRule)
  const waitingConfig = phase === 'waiting_config'
  const queuedSend = phase === 'queued_send'
  const failedGeneration = phase === 'failed_generation'
  const downstreamActive = record.status === 'queued' || record.status === 'running'
  const failure = messageListFailureCopy(record)
  // 规则已匹配时，记录上残留的「没配地址」是旧结论；地址会在投递认领时写入。
  const staleAddressError = queuedSend && isMissingWebhookError(record.error)
  const showFailure = record.status === 'failed'
    || record.status === 'sent_unconfirmed'
    || (record.error.trim() !== '' && !staleAddressError)
  const regenerateEligibility = aiReplyRegenerateEligibility(record, props.now)
  const aiReplyDelete = aiReplyAnyDeleteEligibility(record, props.now)
  // 备注列只显示分层标题；完整原文/建议放悬停属性，留给后续详情抽屉。
  const noteTitle = showFailure
    ? [failure.title, failure.detail, failure.hint]
      .filter((line) => line !== '')
      .join('\n')
    : record.note
  return (
    <tr
      className={css.recordRow}
      data-index={props.index}
      data-record-id={record.id}
      ref={props.rowRef}
    >
      <td className={css.numCell}>
        <div className={css.numCellInner}>
          {props.batchActive && (
            <input
              type="checkbox"
              className={css.rowCheckbox}
              checked={props.selected}
              disabled={props.batchBusy || !selectable}
              title={selectable ? '选择这条记录' : deleteEligibility.reason}
              aria-label={'选择记录 #' + String(record.id)}
              onChange={() => { props.onToggle(record.id) }}
            />
          )}
          <span title="按当前列表连续编号，删除后自动重算">{String(props.index + 1)}</span>
        </div>
      </td>
      <td className={css.nameCell} title={recordIdentity(record.chatName, record.chatEnterpriseName)}>
        <IdentityName name={record.chatName || '未知会话'} username={record.chatUsername} size={20}>
          {recordIdentity(record.chatName, record.chatEnterpriseName)}
        </IdentityName>
      </td>
      <td className={css.statusCell}>
        <button
          type="button"
          className={detailCss.detailTrigger}
          aria-label={'查看记录 #' + String(record.id) + ' 详情'}
          onClick={() => { props.onOpenDetail(record.id) }}
        >
          <Badge
            tone={statusTone(record.status)}
            title={messageListRecordStatusHint(record, props.now, props.hasRule) || undefined}
          >
            {messageListRecordStatusLabel(record, props.now, props.hasRule)}
          </Badge>
        </button>
        {record.attempts > 0 && <span className={css.attempts}>第 {record.attempts} 次</span>}
      </td>
      <td className={css.noteCell}>
        <span
          className={css.noteLine}
          data-error={showFailure ? 'true' : undefined}
          title={noteTitle}
        >
          <span className={css.noteText}>
            {showFailure ? failure.title : (record.note || '—')}
          </span>
        </span>
      </td>
      <td>
        <div className={css.rowActions}>
          {waitingConfig && (
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
              || failedGeneration
              || waitingConfig}
            onClick={() => { props.onResend(record) }}
            {...desktopActionProps()}
            title={failedGeneration
              ? '没有正文，重发不会发送任何内容'
              : waitingConfig
                ? '请先在规则配置中设置会话或全局 Webhook'
                : queuedSend
                  ? '规则已匹配，会自动按序投递；如需立即重试可手动重发'
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
          {regenerateEligibility.eligible && (
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={<RegenerateIcon />}
              disabled={!props.canWrite || props.batchBusy || props.regeneratingId === record.id}
              aria-label={'重新生成记录 #' + String(record.id) + ' 的 AI 回复'}
              title={props.regeneratingId === record.id
                ? '重新生成中…'
                : '重新生成（会再调用一次已配置的 AI 模型）'}
              data-regenerate-ai-reply={record.id}
              onClick={() => { props.onRegenerateAiReply(record) }}
              {...desktopActionProps()}
            />
          )}
          {aiReplyDelete.eligible && (
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={<TrashIcon />}
              disabled={!props.canWrite || props.batchBusy || props.deletingAiReplyId === record.id}
              aria-label={'删除 AI 回复记录 #' + String(record.id)}
              title="删除这条 AI 回复记录（只清本机台账，不会撤回已发出的消息；生成中或投递中的会被拒绝）"
              data-delete-ai-reply={record.id}
              onClick={() => { props.onDeleteAiReplyRecord(record) }}
              {...desktopActionProps()}
            />
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
      <td>
        <button
          type="button"
          className={detailCss.replyIdButton}
          aria-label={'查看记录 #' + String(record.id) + ' 详情'}
          onClick={() => { props.onOpenDetail(record.id) }}
        >
          <code className={css.replyId} title={record.replyId}>{record.replyId}</code>
        </button>
      </td>
    </tr>
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
