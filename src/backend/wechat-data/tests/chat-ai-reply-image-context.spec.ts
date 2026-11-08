// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const decodeMock = vi.hoisted(() => vi.fn())
const decodeEmoticonMock = vi.hoisted(() => vi.fn())
const fetchEmoticonRemoteMock = vi.hoisted(() => vi.fn())
const queryAtOrBeforeMock = vi.hoisted(() => vi.fn())

vi.mock('../src/query/media-image-async.ts', () => ({
  decodeImageDataUrlAsync: decodeMock,
  decodeEmoticonDataUrlAsync: decodeEmoticonMock,
}))

vi.mock('../src/query/media-image.ts', () => ({
  fetchEmoticonRemote: fetchEmoticonRemoteMock,
}))

vi.mock('../src/query/messages.ts', () => ({
  queryMessages: vi.fn(),
  queryMessagesAtOrBefore: queryAtOrBeforeMock,
}))

import { decodeChatAiReplyImages } from '../src/query/ai-reply/context.ts'
import { collectReplyContext } from '../src/query/reply-suggest.ts'

describe('AI 回复视觉上下文', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('只解码最近有限张图片，按时间正序返回并遵守字节预算', async () => {
    decodeMock.mockImplementation(async (_decrypted, _decoded, _talker, localId: number) => ({
      url: `data:image/png;base64,${Buffer.from(String(localId)).toString('base64')}`,
      format: 'png',
    }))

    const images = await decodeChatAiReplyImages(
      'decrypted',
      'decoded',
      'wxid_peer',
      [{ localId: 10 }, { localId: 20 }, { localId: 30 }, { localId: 40 }],
      { maxImages: 2, maxBytes: 1024 },
    )

    expect(images.map((image) => image.localId)).toEqual([30, 40])
    expect(decodeMock).toHaveBeenCalledTimes(2)
    expect(images.every((image) => image.dataUrl.startsWith('data:image/png;base64,'))).toBe(true)
    expect(images.every((image) => !image.dataUrl.includes('decrypted'))).toBe(true)
  })

  it('坏图和超预算图片会被跳过，不阻断其余图片', async () => {
    decodeMock.mockImplementation(async (_decrypted, _decoded, _talker, localId: number) => {
      if (localId === 2) return { error: 'decode failed' }
      return {
        url: localId === 3
          ? 'data:image/png;base64,' + 'A'.repeat(512)
          : 'data:image/png;base64,YQ==',
        format: 'png',
      }
    })

    const images = await decodeChatAiReplyImages(
      'decrypted',
      'decoded',
      'wxid_peer',
      [{ localId: 1 }, { localId: 2 }, { localId: 3 }],
      { maxImages: 3, maxBytes: 64 },
    )

    expect(images.map((image) => image.localId)).toEqual([1])
  })

  it('旧格式 type=3 且没有展示文本的图片仍会进入上下文与图片候选', () => {
    queryAtOrBeforeMock.mockReturnValue({
      found: true,
      messages: [{
        localId: 7,
        createTime: 1_700_000_000,
        isSender: 0,
        type: 3,
      }],
    })

    const context = collectReplyContext(
      'decrypted',
      'wxid_peer',
      'wxid_self',
      20,
      7,
    )

    expect(context.lines).toEqual(['对方：[图片]'])
    expect(context.imageCandidates).toEqual([{ localId: 7 }])
    expect(context.latestPeer).toBe('[图片]')
  })

  it('表情会进入上下文，并携带本地 md5 与 CDN 兜底地址', () => {
    queryAtOrBeforeMock.mockReturnValue({
      found: true,
      messages: [{
        localId: 8,
        createTime: 1_700_000_000,
        isSender: 0,
        type: 47,
        renderType: 'emoji',
        rich: {
          type: 'emoji',
          md5: '0123456789abcdef0123456789abcdef',
          emojiUrl: 'https://mmbiz.qpic.cn/example.gif',
        },
      }],
    })

    const context = collectReplyContext('decrypted', 'wxid_peer', 'wxid_self', 20, 8)

    expect(context.lines).toEqual(['对方：[表情]'])
    expect(context.imageCandidates).toEqual([{
      localId: 8,
      kind: 'sticker',
      md5: '0123456789abcdef0123456789abcdef',
      emojiUrl: 'https://mmbiz.qpic.cn/example.gif',
    }])
    expect(context.latestPeer).toBe('[表情]')
  })

  it('表情优先走本地解码，本地没有图片时使用 CDN 兜底', async () => {
    decodeEmoticonMock.mockResolvedValueOnce({ error: '未找到表情文件' })
    fetchEmoticonRemoteMock.mockResolvedValueOnce({
      url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
      format: 'gif',
    })

    const images = await decodeChatAiReplyImages(
      'decrypted',
      'decoded',
      'wxid_peer',
      [{
        localId: 8,
        kind: 'sticker',
        md5: '0123456789abcdef0123456789abcdef',
        emojiUrl: 'https://mmbiz.qpic.cn/example.gif',
      }],
      { wechatBaseDir: 'C:/wechat' },
    )

    expect(decodeEmoticonMock).toHaveBeenCalledTimes(1)
    expect(decodeMock).not.toHaveBeenCalled()
    expect(fetchEmoticonRemoteMock).toHaveBeenCalledWith(
      'https://mmbiz.qpic.cn/example.gif',
      'decoded',
      '0123456789abcdef0123456789abcdef',
      { wechatBaseDir: 'C:/wechat' },
    )
    expect(images).toEqual([expect.objectContaining({ localId: 8, mediaType: 'image/gif' })])
  })

  it('表情解码失败时跳过视觉内容，但不抛错阻断文本回复', async () => {
    decodeEmoticonMock.mockResolvedValueOnce({ error: 'bad sticker' })

    await expect(decodeChatAiReplyImages(
      'decrypted',
      'decoded',
      'wxid_peer',
      [{
        localId: 8,
        kind: 'sticker',
        md5: '0123456789abcdef0123456789abcdef',
      }],
    )).resolves.toEqual([])
  })
})
