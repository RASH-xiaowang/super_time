// @vitest-environment node
/**
 * 会话级 AI 回复的配置与启用列表边界。
 *
 * 运行器流程、恢复行为和消息列表幂等分别位于
 * chat-ai-reply-runner-flow.spec.ts、chat-ai-reply-runner-recovery.spec.ts
 * 与 chat-ai-reply-message-list.spec.ts。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  listEnabledChatAiReplyStates,
  readChatAiReplyState,
  saveChatAiReplySetting,
} from '../src/query/ai-reply/config-store.ts'
import { createChatAiReplyRemotes } from '../src/remotes/chat-ai-reply.ts'
import { createChatAiReplyTestHarness } from './helpers/chat-ai-reply-fixture.ts'

const harness = createChatAiReplyTestHarness()
let root = ''
let decrypted = ''

beforeEach(() => {
  harness.reset()
  root = harness.root
  decrypted = harness.decrypted
})

afterEach(() => harness.dispose())

describe('会话级 AI 回复配置', () => {
  it('按账号+会话保存，revision 阻止旧请求覆盖新值', () => {
    const saved = saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
    })
    expect(saved.ok).toBe(true)
    expect(saved.state).toMatchObject({ enabled: true, revision: 1, stage: 'idle' })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer', '小王')).toMatchObject({
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      enabled: true,
      revision: 1,
    })

    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: false,
      provider: 'dsh-wechat-bridge',
      expectedRevision: 0,
    })).toMatchObject({ ok: false })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').enabled).toBe(true)
    expect(readChatAiReplyState(decrypted, 'wxid_other', 'wxid_peer').enabled).toBe(false)
  })

  it('群聊可开启；缺失账号仍 fail-closed', () => {
    // 2026-11-18 起群聊也能开启（只有 @我 的消息会触发，判定在扫描边界完成）。
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'room@chatroom',
      chatName: '群',
      enabled: true,
      provider: 'dsh-wechat-bridge',
    })).toMatchObject({ ok: true })
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: '',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
    })).toMatchObject({ ok: false })
  })
})

describe('会话级 AI 回复已开启列表', () => {
  function remotesFor(accountKey = 'wxid_self') {
    return createChatAiReplyRemotes({
      dirs: () => ({ decrypted, decoded: join(root, 'data', 'decoded') }),
      selfUsername: () => accountKey,
      op: () => {},
      gate: (_feature, _stats, texts) => texts,
      generate: async () => ({ ok: true, text: '不应生成' }),
      dispatch: async () => ({ ok: true }),
      changed: () => {},
    })
  }

  it('只返回当前账号已开启的会话摘要', () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
    }).ok).toBe(true)
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_closed',
      chatName: '已关闭',
      enabled: false,
      provider: 'dsh-wechat-bridge',
    }).ok).toBe(true)
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_other',
      chatUsername: 'wxid_other_peer',
      chatName: '其它账号',
      enabled: true,
      provider: 'dsh-wechat-bridge',
    }).ok).toBe(true)

    const remotes = remotesFor()
    expect(remotes.listEnabled()).toMatchObject({
      ok: true,
      chats: [{
        chatUsername: 'wxid_peer',
        chatName: '小王',
      }],
    })
    remotes.dispose()
  })

  it('已开启的群聊也出现在摘要里（会话徽标与筛选要用）', () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'room@chatroom',
      chatName: '测试群',
      enabled: true,
      provider: 'dsh-wechat-bridge',
    }).ok).toBe(true)
    const remotes = remotesFor()
    expect(remotes.listEnabled()).toMatchObject({
      ok: true,
      chats: [{ chatUsername: 'room@chatroom', chatName: '测试群' }],
    })
    remotes.dispose()
  })

  it('任务库读取失败时返回 ok:false，而不是空列表', () => {
    mkdirSync(join(root, 'data', 'wechat_task_center.db'), { recursive: true })
    const remotes = remotesFor()
    expect(remotes.listEnabled()).toMatchObject({
      ok: false,
      error: expect.stringContaining('AI 回复设置读取失败'),
    })
    remotes.dispose()
  })
})
