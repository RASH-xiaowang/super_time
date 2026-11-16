/** AI 回复人格从菜单、状态对象到 Remote 的接线守卫。 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
const read = (file: string): string => readFileSync(join(HERE, file), 'utf8')

describe('AI 回复人格配置接线', () => {
  it('菜单入口与本地弹窗已接上', () => {
    const actions = read('chats-head-actions.tsx')
    expect(actions).toContain('<ChatAiReplyMenu')
    const menu = read('chat-ai-reply-menu.tsx')
    expect(menu).toContain('AI回复设置…')
    expect(menu).toContain('onOpenSettings()')
    expect(menu).toContain('<ChatAiReplySettingsDialog')
    expect(menu).toContain('chatUsername={curSession.username}')
    expect(menu).toContain('initialPrompt={aiReply.personaPrompt}')
    expect(menu).toContain('initialSplitReply={aiReply.splitReply}')
    expect(menu).toContain('initialKbEnabled={aiReply.kbEnabled}')
    expect(menu).toContain('initialKbId={aiReply.kbId}')
    expect(actions).toContain('<ChatAiReplySettingsHost')
  })

  it('persona 字段从状态对象贯穿到 ChatsView', () => {
    const controls = read('use-chats-ai-reply-controls.ts')
    expect(controls).toContain('personaName: chatAiReply.state?.personaName')
    expect(controls).toContain('personaPrompt: chatAiReply.state?.personaPrompt')
    expect(controls).toContain('splitReply: chatAiReply.state?.splitReply !== false')
    expect(controls).toContain('kbEnabled: chatAiReply.state?.kbEnabled === true')
    expect(controls).toContain('kbId: chatAiReply.state?.kbId ?? 0')
    expect(controls).toContain('onSavePersona')
    const view = read('chats-view.tsx')
    expect(view).toContain('personaName: string')
    expect(view).toContain('splitReply: boolean')
    expect(view).toContain('kbEnabled: boolean')
    expect(view).toContain('onSavePersona:')
  })

  it('保存使用 revision 和会话身份校验，Remote 仅在桌面端可写', () => {
    const hook = read('use-chat-ai-reply.ts')
    expect(hook).toContain('saveChatAiReplyPersona')
    const action = read('chat-ai-reply-persona-action.ts')
    expect(action).toContain('expectedRevision: context.state.revision')
    expect(action).toContain('splitReply: draft.splitReply')
    expect(action).toContain('kbEnabled: draft.kbEnabled')
    expect(action).toContain('kbId: draft.kbId')
    expect(action).toContain("Symbol('chat-ai-reply-persona-save')")
    expect(action).toContain('sameChatAiReplyIdentity(stateIdentity, latest)')
    expect(read('../api-chat-ai-reply.ts')).toContain('remote().setChatAiReplyPersona(options)')
  })

  it('知识库参与回复：弹窗勾选、库列表来自当前作用域、保存时校验', () => {
    const dialog = read('chat-ai-reply-settings-dialog.tsx')
    expect(dialog).toContain('useKbScope()')
    expect(dialog).toContain('知识库参与回复')
    expect(dialog).toContain('请选择参与回复的知识库')
    expect(dialog).toContain('kbEnabled, kbId: kbEnabled ? kbId : 0')
  })

  it('默认 Webhook 读取与保存始终携带当前会话作用域', () => {
    const api = read('../api-chat-ai-reply.ts')
    expect(api).toContain('const result = await get.call(client, options)')
    expect(api).toContain('const result = await save.call(client, options)')
    const dialog = read('chat-ai-reply-settings-dialog.tsx')
    expect(dialog).toContain('apiGetChatAiReplyDefaultWebhook(scope)')
    expect(dialog).toContain('apiSaveChatAiReplyDefaultWebhook({ ...scope, webhookUrl })')
  })
})
