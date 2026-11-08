import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setWechatRemote, type WechatRemote } from './api-core.ts'
import {
  apiExportChatFile,
  apiExportChatImage,
  apiExportChatVideo,
  apiExportFavoriteFile,
  apiExportFavoriteImage,
  apiExportFavoriteVideo,
  apiExportFileAttachment,
  apiExportFileImage,
  apiExportFileVideo,
  apiExportSnsImage,
  apiExportSnsVideo,
} from './api-media.ts'

function installRemote(overrides: Partial<WechatRemote>): void {
  setWechatRemote(overrides as unknown as WechatRemote)
}

describe('原图导出 API', () => {
  beforeEach(() => {
    setWechatRemote({
      exportSnsImage: vi.fn(),
      exportChatImage: vi.fn(),
      exportFavoriteFile: vi.fn(),
    } as unknown as WechatRemote)
  })

  it('朋友圈原图导出完整转发媒体定位信息，并返回后端字节结果', async () => {
    const options = {
      md5: '0123456789abcdef0123456789abcdef',
      timelineId: 'timeline-1',
      mediaId: 'media-1',
      url: 'https://wx.qlogo.cn/example/0',
      token: 'token-1',
      seed: 'seed-1',
      key: 'seed-1',
      dest: 'D:\\导出\\朋友圈原图.webp',
      jobId: 'media-moment-image',
    }
    const exportSnsImage = vi.fn().mockResolvedValue({
      ok: true,
      value: { ok: true, bytes: 2048, format: 'webp', source: 'cdn' },
    })
    installRemote({ exportSnsImage })

    await expect(apiExportSnsImage(options)).resolves.toEqual({
      ok: true,
      bytes: 2048,
      format: 'webp',
      source: 'cdn',
    })
    expect(exportSnsImage).toHaveBeenCalledWith(options)
  })

  it('聊天原图导出只传会话、消息 id 与目标路径', async () => {
    const options = { username: 'wxid_friend', localId: 42, dest: 'D:\\导出\\聊天原图.png', jobId: 'media-chat-image' }
    const exportChatImage = vi.fn().mockResolvedValue({
      ok: true,
      value: { ok: true, bytes: 4096, format: 'png', source: 'local' },
    })
    installRemote({ exportChatImage })

    await expect(apiExportChatImage(options)).resolves.toEqual({
      ok: true,
      bytes: 4096,
      format: 'png',
      source: 'local',
    })
    expect(exportChatImage).toHaveBeenCalledWith(options)
  })

  it('远程信封失败会转成带错误码的可读异常', async () => {
    installRemote({
      exportSnsImage: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'ORIGINAL_UNAVAILABLE', message: '本机只有缩略图' },
      }),
    })

    await expect(apiExportSnsImage({ md5: 'abc', dest: 'D:\\导出\\x.jpg' }))
      .rejects.toMatchObject({ message: '本机只有缩略图', code: 'ORIGINAL_UNAVAILABLE' })
  })

  it('收藏文件只转发完整内容 MD5 与目标路径', async () => {
    const exportFavoriteFile = vi.fn().mockResolvedValue({
      ok: true,
      value: { ok: true, path: 'D:\\导出\\合同.pdf', bytes: 10, source: 'local' },
    })
    installRemote({ exportFavoriteFile })
    const options = {
      fullMd5: 'f'.repeat(32),
      kind: 'file' as const,
      dest: 'D:\\导出\\合同.pdf',
      jobId: 'media-favorite-file',
    }

    await expect(apiExportFavoriteFile(options)).resolves.toMatchObject({
      ok: true,
      path: 'D:\\导出\\合同.pdf',
    })
    expect(exportFavoriteFile).toHaveBeenCalledWith(options)
  })

  it('11 个单文件媒体 RPC 都原样保留 jobId', async () => {
    const cases = [
      ['exportSnsVideo', () => apiExportSnsVideo({ md5: 'm', dest: 'D:\\out\\moment.mp4', jobId: 'media-1' })],
      ['exportSnsImage', () => apiExportSnsImage({ md5: 'm', dest: 'D:\\out\\moment.jpg', jobId: 'media-2' })],
      ['exportChatImage', () => apiExportChatImage({ username: 'u', localId: 1, dest: 'D:\\out\\chat.jpg', jobId: 'media-3' })],
      ['exportChatVideo', () => apiExportChatVideo({ username: 'u', localId: 2, dest: 'D:\\out\\chat.mp4', jobId: 'media-4' })],
      ['exportChatFile', () => apiExportChatFile({ username: 'u', localId: 3, dest: 'D:\\out\\chat.pdf', jobId: 'media-5' })],
      ['exportFileImage', () => apiExportFileImage({ md5: 'm', dest: 'D:\\out\\file.jpg', jobId: 'media-6' })],
      ['exportFileVideo', () => apiExportFileVideo({ md5: 'm', dest: 'D:\\out\\file.mp4', jobId: 'media-7' })],
      ['exportFileAttachment', () => apiExportFileAttachment({ fileName: 'a.pdf', dest: 'D:\\out\\file.pdf', jobId: 'media-8' })],
      ['exportFavoriteImage', () => apiExportFavoriteImage({ fullMd5: 'f', dest: 'D:\\out\\fav.jpg', jobId: 'media-9' })],
      ['exportFavoriteVideo', () => apiExportFavoriteVideo({ fullMd5: 'f', dest: 'D:\\out\\fav.mp4', jobId: 'media-10' })],
      ['exportFavoriteFile', () => apiExportFavoriteFile({ fullMd5: 'f', dest: 'D:\\out\\fav.pdf', jobId: 'media-11' })],
    ] as const
    for (const [method, invoke] of cases) {
      const rpc = vi.fn().mockResolvedValue({ ok: true, value: { ok: true } })
      installRemote({ [method]: rpc })
      await invoke()
      expect(rpc, method).toHaveBeenCalledWith(expect.objectContaining({
        jobId: expect.stringMatching(/^media-/),
      }))
    }
  })
})
