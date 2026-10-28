/** 局域网 Webhook 地址、连通性检查与 POST 示例。 */
import { useState } from 'react'
import clsx from 'clsx'
import type { MessageListWebhookInfo } from '@deepseek-ai/dsh-wechat-data/types'
import { Badge, Button, LoadingState } from '../ui/kit.tsx'
import css from './message-list.module.css'

export function MessageListWebhookCard(props: {
  info: MessageListWebhookInfo | null
  busy: boolean
  onCopy: () => void
  onToggleListening: (enabled: boolean) => void
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(true)
  const listening = props.info?.enabled ?? false
  return (
    <section
      className={clsx(css.webhookCard, collapsed && css.webhookCardCollapsed)}
      data-collapsed={collapsed}
    >
      <div className={css.webhookLead}>
        <span className={css.webhookMark} aria-hidden="true">↗</span>
        <div>
          <div className={css.webhookTitle}>局域网 Webhook</div>
          <div className={css.webhookDesc}>
            外部系统向此地址 POST JSON；地址包含访问令牌，仅桌面端可见。
          </div>
        </div>
        <div className={css.webhookLeadActions}>
          <Badge tone={props.info?.enabled ? 'green' : 'amber'}>
            {props.info?.enabled ? '监听中' : '未启用'}
          </Badge>
          <Button
            size="sm"
            variant="outline"
            disabled={props.busy || props.info === null}
            title="此开关同时控制外部 Webhook 与手机局域网访问"
            onClick={() => { props.onToggleListening(!listening) }}
          >
            {props.busy ? '处理中…' : listening ? '关闭监听' : '开启监听'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={!collapsed}
            aria-controls="message-list-webhook-body"
            onClick={() => { setCollapsed((value) => !value) }}
          >
            {collapsed ? '展开' : '折叠'}
            <span className={css.webhookChevron} aria-hidden="true">{collapsed ? '⌃' : '⌄'}</span>
          </Button>
        </div>
      </div>
      <div id="message-list-webhook-body" hidden={collapsed}>
        {props.info === null ? (
          <div className={css.webhookBody}>
            <LoadingState label="读取 Webhook 地址…" />
          </div>
        ) : (
          <div className={css.webhookBody}>
            {props.info.error && <div className={css.inlineWarn}>{props.info.error}</div>}
            <div className={css.urlLine}>
              <code className={css.urlCode}>{props.info.url || '暂无可用地址'}</code>
              <Button
                size="sm"
                variant="outline"
                disabled={props.info.url === ''}
                onClick={props.onCopy}
              >
                复制地址
              </Button>
            </div>
            {props.info.url !== '' && (
              <details className={css.examples}>
                <summary>查看 GET / POST 示例</summary>
                <div className={css.exampleGrid}>
                  <div>
                    <span className={css.exampleLabel}>连通性检查</span>
                    <code className={css.codeBlock}>{props.info.getExample}</code>
                  </div>
                  <div>
                    <span className={css.exampleLabel}>插入一条记录</span>
                    <code className={css.codeBlock}>{props.info.postExample}</code>
                  </div>
                </div>
                <p className={css.exampleHint}>
                  群聊可传 <code>{'{"chatName":"群名","target":"成员名","message":"你好"}'}</code>，
                  也兼容轻羽格式 <code>{'{"target":"群名","mention":"成员名","message":"你好"}'}</code>。
                </p>
              </details>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
