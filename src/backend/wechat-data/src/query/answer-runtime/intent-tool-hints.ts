/**
 * 意图到工具优先级的纯映射。
 *
 * @module query/answer-runtime/intent-tool-hints
 */
import type { AnswerIntentKind } from './intent.ts'

/** 联系人属性问法；意图层也用它判断“是在问某人的资料”。 */
export const ENTITY_ATTR_RE = /(电话|手机|号码|微信|微信号|地址|住址|生日|邮箱|身份证|银行卡|老家|公司|单位|职位|职务|联系人)/

export interface ToolHintContext {
  q: string
  hasMessageRef: boolean
  hasTime: boolean
  hasMedia: boolean
  hasContact: boolean
  hasSession: boolean
  hasAggregate: boolean
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

export function toolHintsFor(kind: AnswerIntentKind, ctx: ToolHintContext): string[] {
  switch (kind) {
    case 'lookup': {
      const out = ['search_messages', 'search_semantic']
      if (ctx.hasMessageRef) out.unshift('get_message_context')
      if (ENTITY_ATTR_RE.test(ctx.q) || /联系人|好友|微信号/.test(ctx.q)) out.unshift('search_contacts')
      return unique(out)
    }
    case 'aggregate':
      return ['aggregate_messages', 'search_messages']
    case 'relation':
      return unique([
        'search_contacts',
        'aggregate_messages',
        'search_messages',
        ...(ctx.hasSession ? ['get_session_messages'] : []),
      ])
    case 'timeline':
      return unique([
        ...(ctx.hasSession ? ['get_session_messages'] : ['list_sessions']),
        'search_messages',
        ...(ctx.hasTime ? ['aggregate_messages'] : []),
      ])
    case 'content_media':
      return unique([
        'get_message_context',
        'search_messages',
        ...(/文件|文档|附件/.test(ctx.q) ? ['search_files'] : []),
        ...(/收藏/.test(ctx.q) ? ['search_favorites'] : []),
      ])
    case 'open_qa':
      return ['search_kb', 'search_semantic']
    case 'clarify':
      return []
  }
}
