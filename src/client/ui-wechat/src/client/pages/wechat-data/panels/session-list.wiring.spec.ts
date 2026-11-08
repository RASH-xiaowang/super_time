import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
const read = (file: string): string => readFileSync(join(HERE, file), 'utf8')

describe('会话列表预览与企业微信徽标接线', () => {
  it('会话行使用统一预览函数，不再只读可能为空的 summary', () => {
    const row = read('chats-session-row.tsx')
    expect(row).toContain('sessionPreviewText(session, selfWxid)')
    expect(row).toContain('<span className={css.sessionSummary} title={preview}>{preview}</span>')
    expect(row).not.toContain('title={session.summary ||')
  })

  it('列表与会话标题都通过同一判据隐藏企业微信群聊徽标', () => {
    const chats = read('chats-session-row.tsx')
    const view = read('chats-view.tsx')
    expect(chats).toContain('shouldShowEnterpriseBadge(session, isEnterpriseChat(session.username))')
    expect(view).toContain('shouldShowEnterpriseBadge(session, isEnterpriseChat(session.username))')
  })
})
