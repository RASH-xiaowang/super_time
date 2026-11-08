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
          <h3 className={css.rulesTitle}>首次触发文本与 Webhook 路由 · {props.total}</h3>
          <p className={css.rulesDesc}>
            每条规则同时决定任务首次触发时插入的文本和下游地址。不同触发对象可分别配置；
            匹配顺序为会话名 + 触发对象精确匹配 → 同会话任意对象 → 任意会话指定对象 → 全局规则。
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
          desc="先为会话名或触发对象配置一个下游地址；没有匹配规则的记录会保持“待执行”。"
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
                    <span className={css.ruleGreeting} title={rule.greetingText || '你好'}>
                      首次触发：{rule.greetingText || '你好'}
                    </span>
                    {rule.note && (
                      <span className={css.ruleNote} title={rule.note}>备注：{rule.note}</span>
                    )}
                  </div>
                </div>
                <div className={css.ruleActions}>
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
