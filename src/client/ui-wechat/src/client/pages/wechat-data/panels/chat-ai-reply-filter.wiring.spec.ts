/**
 * 「AI 回复」会话徽标与筛选的接线守卫。
 *
 * 批量索引、事件回源、行内徽标和筛选按钮分别在四份文件里；任一处漏接，
 * 界面都只会安静地少一个标志或筛不出结果，因此在这里一起钉住。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
const read = (file: string): string => readFileSync(join(HERE, file), 'utf8')

describe('AI 回复会话标志与筛选', () => {
  it('批量 Remote 和消息列表事件回源都已接上', () => {
    expect(read('../api-chat-ai-reply.ts')).toContain('remote().listEnabledChatAiReplyStates()')
    const hook = read('use-chat-ai-reply-enabled.ts')
    expect(hook).toContain('window.addEventListener(MESSAGE_LIST_UPDATED_EVENT, onUpdated)')
    expect(hook).toContain('markEnabled')
  })

  it('开关成功后即时更新索引，列表只筛单聊', () => {
    const controls = read('use-chats-ai-reply-controls.ts')
    expect(controls).toContain('onEnabledChanged: enabledIndex.markEnabled')
    expect(controls).toMatch(/session\.type === 'private'\s+&& enabledIndex\.enabledUsernames\.has\(session\.username\)/)
    // 2026-11-13：会话行渲染抽成 makeChatsSessionRowRenderer 后，索引经参数传入；
    // 判据不变 —— 行内徽标必须按当前会话的 username 查同一份 enabledUsernames。
    const panel = read('Chats.tsx')
    expect(panel).toContain('aiReplyEnabledUsernames: aiReplyControls.enabledUsernames')
    expect(panel).toContain('aiReplyEnabled={aiReplyEnabledUsernames.has(session.username)}')
  })

  it('会话行徽标、筛选状态和专用空态都存在', () => {
    expect(read('chats-session-row.tsx')).toContain('data-ai-reply="enabled"')
    const view = read('chats-view.tsx')
    expect(view).toContain('aria-pressed={aiReplyFilter.aiOnly}')
    expect(view).toContain("aiReplyFilter.aiOnly && view === 'chats'")
    expect(view).toContain("'暂无开启 AI 回复的会话'")
  })

  it('AI 回复控件沿用统一字体、选中态和禁用态', () => {
    const cards = read('chats-cards.module.css')
    expect(cards).toContain('font-family: var(--nm-font-sans);')
    expect(cards).toContain(".msgHeaderMoreItem[data-active='true']")
    expect(cards).toMatch(/\.aiFilter:disabled\s*\{[^}]*opacity:\s*0\.5;/)
  })
})
