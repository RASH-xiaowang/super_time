/** Webhook 路由规则列表：按会话名和触发对象匹配下游地址。 */
import type { MessageListRule } from '@deepseek-ai/dsh-wechat-data/types'
import { Badge, Button, EmptyState, ErrorState, LoadingState } from '../ui/kit.tsx'
import { desktopActionProps } from '../ui/desktop-only.tsx'
import { ruleScope } from './message-list-view.ts'
import css from './message-list.module.css'

export function MessageListRules(props: {
  rules: MessageListRule[]
  total: number
  loading: boolean
  readError: string
  canWrite: boolean
  busyId: number | null
  onRefresh: () => void
  onAdd: () => void
  onEdit: (rule: MessageListRule) => void
  onToggle: (rule: MessageListRule) => void
  onDelete: (rule: MessageListRule) => void
}): React.JSX.Element {
  return (
    <section className={css.rulesPane}>
      <div className={css.rulesHead}>
        <div>
          <h3 className={css.rulesTitle}>Webhook 路由 · {props.total}</h3>
          <p className={css.rulesDesc}>
            每条规则决定消息队列发往哪个地址。匹配顺序为会话名 + 触发对象精确匹配 → 同会话任意对象 → 任意会话指定对象 → 全局规则。
          </p>
        </div>
        <Button
          size="sm"
          variant="primary"
          disabled={!props.canWrite}
          onClick={props.onAdd}
          {...desktopActionProps()}
        >
          新增规则
        </Button>
      </div>
      {props.readError ? (
        <ErrorState
          message="规则读取失败"
          detail={props.readError}
          onRetry={props.onRefresh}
        />
      ) : props.loading && props.rules.length === 0 ? (
        <LoadingState label="加载规则…" />
      ) : props.rules.length === 0 ? (
        <EmptyState
          icon="↗"
          title="还没有 Webhook 规则"
          action={(
            <Button
              size="sm"
              variant="primary"
              disabled={!props.canWrite}
              onClick={props.onAdd}
              {...desktopActionProps()}
            >
              新增第一条规则
            </Button>
          )}
        />
      ) : (
        <div className={css.ruleList}>
          {props.rules.map((rule) => {
            const busy = props.busyId === rule.id
            return (
              <article key={rule.id} className={css.ruleRow} data-disabled={!rule.enabled || undefined}>
                <div className={css.ruleMain}>
                  <div className={css.ruleScope} title={ruleScope(rule)}>{ruleScope(rule)}</div>
                  <code className={css.ruleUrl} title={rule.webhookUrl}>{rule.webhookUrl}</code>
                  <div className={css.ruleMeta}>
                    {rule.note && (
                      <span className={css.ruleNote} title={rule.note}>备注：{rule.note}</span>
                    )}
                  </div>
                </div>
                <div className={css.ruleActions}>
                  {rule.appInstanceId !== '' && (
                    <Badge
                      tone="cyan"
                      title={'地址由托管应用实例提供；实例重启换了端口会自动同步到这条规则'}
                    >
                      托管应用
                    </Badge>
                  )}
                  <Badge tone={rule.enabled ? 'green' : 'default'}>{rule.enabled ? '启用' : '停用'}</Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!props.canWrite || busy}
                    onClick={() => { props.onToggle(rule) }}
                    {...desktopActionProps()}
                  >
                    {busy ? '处理中…' : rule.enabled ? '停用' : '启用'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!props.canWrite || busy}
                    onClick={() => { props.onEdit(rule) }}
                    {...desktopActionProps()}
                  >
                    编辑
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={!props.canWrite || busy}
                    onClick={() => { props.onDelete(rule) }}
                    {...desktopActionProps()}
                  >
                    删除
                  </Button>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
