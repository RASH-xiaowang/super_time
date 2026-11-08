// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveChatAiReplySetting } from '../src/query/ai-reply/config-store.ts'
import { createChatAiReplyRunner } from '../src/query/ai-reply/runner.ts'
import type { ChatAiReplyScanDeps } from '../src/query/ai-reply/types.ts'

let root = ''
let decrypted = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chat-ai-reply-images-'))
  decrypted = join(root, 'data', 'decrypted')
  mkdirSync(decrypted, { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('AI 回复图片/表情触发', () => {
  it('图片也能作为触发锚点，解码后的图片会进入生成请求', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '图片联系人',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: '999:0',
    }).ok).toBe(true)

    let status: 'pending' | 'success' = 'pending'
    let text = ''
    const generate = vi.fn(async (input: Parameters<ChatAiReplyScanDeps['generate']>[0]) => {
      expect(input.images).toEqual([expect.objectContaining({
        localId: 2,
        mediaType: 'image/png',
      })])
      expect(input.prompt).toContain('随请求附带 1 张最近的图片或表情')
      return { ok: true, text: '图片收到了' }
    })
    const deps: ChatAiReplyScanDeps = {
      decryptedDir: () => decrypted,
      selfUsername: () => 'wxid_self',
      listMessages: async () => [{
        localId: 2,
        sortSeq: 200,
        createTime: 2000,
        isSender: 0,
        type: 3,
        renderType: 'image',
        displayText: '[图片]',
      }],
      collectContext: () => ({
        lines: ['对方：[图片]'],
        imageCandidates: [{ localId: 2 }],
        latestPeer: '[图片]',
        count: 1,
        prompt: '对方：[图片]',
      }),
      decodeImages: async () => [{
        localId: 2,
        dataUrl: 'data:image/png;base64,aGVsbG8=',
        mediaType: 'image/png',
        bytes: 5,
      }],
      generate,
      gate: (_feature, _stats, texts) => texts,
      reserveReply: async () => ({ ok: true, id: 1, created: true, status: 'pending', text: '' }),
      completeReply: async (input) => {
        text = input.text
        return { ok: true, id: 1, status: 'pending', text }
      },
      failReply: async (input) => ({ ok: false, id: 1, error: input.error }),
      getReply: async () => ({ found: true, status, text }),
      dispatchReply: async () => {
        status = 'success'
        return { ok: true }
      },
      op: () => {},
    }

    const runner = createChatAiReplyRunner(deps)
    await runner.scan()
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(runner.pending()).toBe(0))
    runner.dispose()
  })

  it('表情可作为触发锚点；视觉解码失败时仍降级生成纯文本回复', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '表情联系人',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: '999:0',
    }).ok).toBe(true)

    let status: 'pending' | 'success' = 'pending'
    let text = ''
    const generate = vi.fn(async (input: Parameters<ChatAiReplyScanDeps['generate']>[0]) => {
      expect(input.images).toBeUndefined()
      expect(input.prompt).toContain('对方：[表情]')
      return { ok: true, text: '这个表情挺可爱' }
    })
    const deps: ChatAiReplyScanDeps = {
      decryptedDir: () => decrypted,
      selfUsername: () => 'wxid_self',
      listMessages: async () => [{
        localId: 3,
        sortSeq: 300,
        createTime: 3000,
        isSender: 0,
        type: 47,
        renderType: 'emoji',
        displayText: '[表情]',
      }],
      collectContext: () => ({
        lines: ['对方：[表情]'],
        imageCandidates: [{
          localId: 3,
          kind: 'sticker',
          md5: '0123456789abcdef0123456789abcdef',
        }],
        latestPeer: '[表情]',
        count: 1,
        prompt: '对方：[表情]',
      }),
      decodeImages: async () => {
        throw new Error('sticker decode failed')
      },
      generate,
      gate: (_feature, _stats, texts) => texts,
      reserveReply: async () => ({ ok: true, id: 1, created: true, status: 'pending', text: '' }),
      completeReply: async (input) => {
        text = input.text
        return { ok: true, id: 1, status: 'pending', text }
      },
      failReply: async (input) => ({ ok: false, id: 1, error: input.error }),
      getReply: async () => ({ found: true, status, text }),
      dispatchReply: async () => {
        status = 'success'
        return { ok: true }
      },
      op: () => {},
    }

    const runner = createChatAiReplyRunner(deps)
    await runner.scan()
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(runner.pending()).toBe(0))
    runner.dispose()
  })
})
