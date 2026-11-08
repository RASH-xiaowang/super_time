/**
 * 消息列表：任务首次触发、局域网 Webhook 与手动回复的统一台账。
 *
 * 页面分「消息记录 / 规则配置」两段。记录表包含序号、回复 id、会话名、触发对象、
 * 文本、图片、时间、来源、状态、重发与备注；规则按「会话名 + 触发对象」匹配下游地址。
 * 写操作只允许桌面端，手机端保留只读 API，但不把该入口放进手机导航。
 */
import { useState } from 'react'
import clsx from 'clsx'
import { Button, PanelHeader, Segmented } from '../ui/kit.tsx'
import { desktopAction, desktopActionProps } from '../ui/desktop-only.tsx'
import { MessageListRecords } from './message-list-records.tsx'
import { MessageListRules } from './message-list-rules.tsx'
import { MessageListWebhookCard } from './message-list-webhook-card.tsx'
import { RecordFormDialog, RuleFormDialog } from './message-list-dialogs.tsx'
import { useMessageListActions } from './use-message-list-actions.ts'
import { useMessageListData } from './use-message-list-data.ts'
import { findExactRuleForRecord, type MessageListView } from './message-list-view.ts'
import type { MessageListRecord } from '@deepseek-ai/dsh-wechat-data/types'
import css from './message-list.module.css'

export function MessageListPanel(): React.JSX.Element {
  const canWrite = !desktopAction()
  const [view, setView] = useState<MessageListView>('records')
  const data = useMessageListData(canWrite)
  const actions = useMessageListActions({
    refreshRecords: data.refreshRecords,
    refreshRules: data.refreshRules,
    refreshWebhookInfo: data.refreshWebhookInfo,
  })

  const refreshing = data.loadingRecords || data.loadingRules
  const refresh = (): void => { void data.refreshAll() }
  const configureRecordRule = (record: MessageListRecord): void => {
    setView('rules')
    actions.openRuleFormForRecord(record, findExactRuleForRecord(data.rules, record))
  }
  const noticeClass = actions.notice === null
    ? ''
    : actions.notice.kind === 'ok'
      ? css.noticeOk
      : actions.notice.kind === 'warn'
        ? css.noticeWarn
        : css.noticeErr

  return (
    <section className={css.root}>
      <PanelHeader
        title="消息列表"
        desc="任务首次触发、局域网 Webhook 与手动回复的统一投递台账"
        actions={(
          <div className={css.headActions}>
            <Button size="sm" variant="outline" onClick={refresh} disabled={refreshing}>
              {refreshing ? '刷新中…' : '刷新'}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!canWrite || view !== 'records'}
              title={view !== 'records' ? '切回「消息记录」后可手动新增' : undefined}
              onClick={actions.openRecordForm}
              {...desktopActionProps()}
            >
              手动新增
            </Button>
          </div>
        )}
      />

      <div className={css.switchRow}>
        <Segmented
          options={[
            { value: 'records', label: '消息记录 · ' + String(data.recordTotal) },
            { value: 'rules', label: '规则配置 · ' + String(data.rulesTotal) },
          ]}
          value={view}
          onChange={(value) => { setView(value as MessageListView) }}
          ariaLabel="消息列表视图"
        />
        <span className={css.tinyHint}>
          {view === 'records' ? '重发优先使用记录里的地址快照' : '精确匹配优先于通配规则'}
        </span>
      </div>

      {actions.notice && (
        <div
          className={clsx(css.noticeToast, noticeClass)}
          role={actions.notice.kind === 'err' ? 'alert' : 'status'}
          aria-live={actions.notice.kind === 'err' ? 'assertive' : 'polite'}
          aria-atomic="true"
        >
          {actions.notice.text}
        </div>
      )}

      {view === 'records' ? (
        <MessageListRecords
          records={data.records}
          total={data.recordTotal}
          stats={data.stats}
          loading={data.loadingRecords}
          readError={data.readError}
          search={data.search}
          status={data.status}
          source={data.source}
          thumbs={data.thumbs}
          canWrite={canWrite}
          hasMore={data.hasMore}
          loadingMore={data.loadingMore}
          loadMoreError={data.loadMoreError}
          windowCapped={data.windowCapped}
          truncated={data.truncated}
          resendingId={actions.resendingId}
          batchBusy={actions.batchBusy}
          probeBusyId={actions.probeBusyId}
          jobBusyId={actions.jobBusyId}
          onSearchChange={data.setSearch}
          onStatusChange={data.setStatus}
          onSourceChange={data.setSource}
          onRefresh={refresh}
          onLoadMore={data.loadMore}
          onResend={(record) => { void actions.resend(record) }}
          onBatchResend={actions.batchResend}
          onBatchProbe={actions.batchProbe}
          onBatchDelete={actions.batchDelete}
          onProbe={(record) => { void actions.probeRecord(record) }}
          onQueryJob={(record) => { void actions.queryJob(record) }}
          onConfigureRule={() => { setView('rules') }}
          onConfigureRecordRule={configureRecordRule}
        />
      ) : (
        <MessageListRules
          rules={data.rules}
          total={data.rulesTotal}
          loading={data.loadingRules}
          readError={data.rulesReadError}
          canWrite={canWrite}
          busyId={actions.ruleBusyId}
          onRefresh={refresh}
          onAdd={() => { actions.openRuleForm() }}
          onEdit={actions.openRuleForm}
          onToggle={(rule) => { void actions.toggleRule(rule) }}
          onDelete={(rule) => { void actions.removeRule(rule) }}
        />
      )}

      {canWrite && (
        <MessageListWebhookCard
          info={data.webhookInfo}
          busy={actions.listeningBusy}
          onCopy={() => { void actions.copyWebhook(data.webhookInfo) }}
          onToggleListening={(enabled) => { void actions.toggleListening(enabled) }}
        />
      )}

      <RecordFormDialog
        form={actions.recordForm}
        saving={actions.saving}
        onChange={actions.setRecordForm}
        onChooseAttachments={() => { void actions.chooseAttachments() }}
        onRemoveAttachment={actions.removeStagedAttachment}
        onClose={() => { actions.setRecordForm(null) }}
        onSubmit={() => { void actions.submitRecord() }}
      />
      <RuleFormDialog
        form={actions.ruleForm}
        saving={actions.saving}
        onChange={actions.setRuleForm}
        onClose={() => { actions.setRuleForm(null) }}
        onSubmit={() => { void actions.submitRule() }}
      />
    </section>
  )
}
