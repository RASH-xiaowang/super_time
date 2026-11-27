/** AI 回复人格从菜单、状态对象到 Remote 的接线守卫。 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
const read = (file: string): string => readFileSync(join(HERE, file), 'utf8')
/** 去掉注释：注释里提到 `onToggle` 不等于代码还在调用它。 */
const source = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

describe('AI 回复人格配置接线', () => {
  it('头部入口与本地弹窗已接上', () => {
    const actions = read('chats-head-actions.tsx')
    // 2026-11-18：开关与设置从「更多」搬到头部（紧跟 AI 问答）。
    expect(actions).toContain('<ChatAiReplyHeaderButtons')
    expect(actions).toContain('<ChatAiReplyMenu')
    const menu = read('chat-ai-reply-menu.tsx')
    expect(menu).toContain('aria-label="AI回复设置"')
    expect(menu).toContain('onOpenSettings')
    expect(menu).toContain('<ChatAiReplySettingsDialog')
    const settings = read('chat-ai-reply-settings-dialog.tsx')
    expect(settings).toContain('<Drawer')
    expect(settings).not.toContain('<Dialog')
    expect(menu).toContain('chatUsername={curSession.username}')
    expect(menu).toContain('initialPrompt={aiReply.personaPrompt}')
    expect(menu).toContain('initialSplitReply={aiReply.splitReply}')
    expect(menu).toContain('initialKbEnabled={aiReply.kbEnabled}')
    expect(menu).toContain('initialKbId={aiReply.kbId}')
    expect(actions).toContain('<ChatAiReplySettingsHost')
  })

  it('AI 回复的开关与设置住在头部动作排、紧跟「AI 问答」之后', () => {
    const actions = read('chats-head-actions.tsx')
    // 顺序判据：AI 问答按钮的收尾 → AI 回复入口 → 「更多」。用 `indexOf` 钉住相对次序，
    // 防止以后有人「顺手」把它们挪回菜单（那会让用户按旧路径找不到开关）。
    const aiAsk = actions.indexOf('AI 问答</span>')
    const aiReply = actions.indexOf('<ChatAiReplyHeaderButtons')
    const more = actions.indexOf('msgHeaderMoreWrap')
    expect(aiAsk, '头部没有「AI 问答」按钮').toBeGreaterThan(-1)
    expect(aiReply, '头部没有 AI 回复入口').toBeGreaterThan(-1)
    expect(aiAsk < aiReply, 'AI 回复入口没有排在「AI 问答」之后').toBe(true)
    expect(aiReply < more, 'AI 回复入口排到了「更多」之后').toBe(true)

    const menu = read('chat-ai-reply-menu.tsx')
    // 菜单里**只剩**「立即检查」：开关与设置必须已经搬走，否则会出现两个入口。
    // 只看 `ChatAiReplyMenu` 的函数体 —— 同一文件里的头部按钮本来就会调用 onToggle。
    const menuFn = menu.slice(menu.indexOf('export function ChatAiReplyMenu'))
      .split('\n}\n')[0] ?? ''
    expect(source(menuFn)).toContain('立即检查 AI 回复')
    expect(source(menuFn)).not.toContain('AI回复设置')
    expect(source(menuFn), '开关搬走后菜单里不该再有 onToggle 调用').not.toContain('onToggle')
  })

  it('「AI回复设置」只在开关已开启时渲染（没开之前没有可配置的对象）', () => {
    const menu = read('chat-ai-reply-menu.tsx')
    const header = menu.slice(menu.indexOf('export function ChatAiReplyHeaderButtons'))
      .split('\nexport function')[0] ?? ''
    const body = source(header)
    // 设置按钮必须包在 `aiReply.enabled && (` 里；直接平铺就会在未开启时也出现。
    expect(body, '设置按钮没有按开启态收敛').toMatch(
      /\{aiReply\.enabled && \(\s*<button[\s\S]{0,900}?aria-label="AI回复设置"/,
    )
    // 开关按钮自己**不能**被这个条件包住（否则关掉之后就没有任何入口能再打开）。
    const offBranch = body.slice(0, body.indexOf('{aiReply.enabled && ('))
    expect(offBranch, '开关按钮也被开启态包住了 ⇒ 关掉后再无入口').toContain('onToggle()')
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
    // 未勾选知识库时必须把 kbId 归零，不能把上次选的库悄悄带上。
    expect(dialog).toContain('kbId: kbEnabled ? kbId : 0')
  })

  it('上下文时间窗：会话级下拉、随草稿一起保存', () => {
    const dialog = read('chat-ai-reply-settings-dialog.tsx')
    expect(dialog).toContain('上下文时间窗')
    expect(dialog).toContain('CONTEXT_WINDOW_OPTIONS')
    expect(dialog).toContain('contextWindowHours')
    expect(dialog).toContain('aria-label="安全红线"')
    expect(dialog).toContain('查无资料时的回复')
    // 弹窗要能收到当前值，否则每次打开都显示「不限」并把它写回去。
    const menu = read('chat-ai-reply-menu.tsx')
    expect(menu).toContain('initialContextWindowHours={aiReply.contextWindowHours}')
    expect(menu).toContain('initialHandoff={aiReply.safetyHandoff}')
    const controls = read('use-chats-ai-reply-controls.ts')
    expect(controls).toContain('contextWindowHours: chatAiReply.state?.contextWindowHours ?? 0')
    expect(controls).toContain('safetyHandoff: chatAiReply.state?.safetyHandoff ?? \'\'')
  })

  it('预设人格：弹窗渲染选择器，点选只填草稿、不写库', () => {
    const dialog = read('chat-ai-reply-settings-dialog.tsx')
    expect(dialog).toContain("from './chat-ai-reply-persona-presets.tsx'")
    expect(dialog).toContain('<PersonaPresetPicker')
    // 点选只能改草稿：出现任何 Remote 调用就说明预设偷偷写库了。
    const presets = read('chat-ai-reply-persona-presets.tsx')
    expect(presets).toContain('export const CHAT_AI_REPLY_PERSONA_PRESETS')
    expect(presets).not.toContain('apiSetChatAiReplyPersona')
    expect(presets).not.toContain('remote()')
    // 至少四套，且每套都要同时给名称与风格（只填一半等于没填）。
    const presetCount = (presets.match(/^    id: '/gm) ?? []).length
    expect(presetCount).toBeGreaterThanOrEqual(4)
    expect(presets).toContain('name: ')
    expect(presets).toContain('prompt: [')
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
