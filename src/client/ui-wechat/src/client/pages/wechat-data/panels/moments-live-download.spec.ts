import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  apiSaveFileDialog: vi.fn(),
  apiExportSnsVideo: vi.fn(),
}))

vi.mock('../api.ts', () => ({
  apiSaveFileDialog: mocks.apiSaveFileDialog,
  apiExportSnsVideo: mocks.apiExportSnsVideo,
}))

const { saveMomentsLiveVideo } = await import('./moments-live-download.ts')

beforeEach(() => {
  mocks.apiSaveFileDialog.mockReset()
  mocks.apiExportSnsVideo.mockReset()
})

describe('保存实况原视频', () => {
  it('先选路径，再把 livePhoto 的全部定位字段交给后端写盘', async () => {
    mocks.apiSaveFileDialog.mockResolvedValue({ canceled: false, path: 'D:/out/live.mp4' })
    mocks.apiExportSnsVideo.mockResolvedValue({ ok: true, bytes: 12345 })

    await expect(saveMomentsLiveVideo({
      md5: '0123456789abcdef',
      timelineId: 'timeline-1',
      id: 'media-1',
      url: 'https://example.test/live',
      key: 'enc-key',
    }, 'moment-live-job')).resolves.toEqual({
      canceled: false,
      path: 'D:/out/live.mp4',
      bytes: 12345,
    })

    expect(mocks.apiSaveFileDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '保存实况原视频',
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
    }))
    expect(mocks.apiExportSnsVideo).toHaveBeenCalledWith({
      md5: '0123456789abcdef',
      timelineId: 'timeline-1',
      mediaId: 'media-1',
      url: 'https://example.test/live',
      key: 'enc-key',
      dest: 'D:/out/live.mp4',
      jobId: 'moment-live-job',
    })
  })

  it('用户取消保存对话框时不调用后端导出', async () => {
    mocks.apiSaveFileDialog.mockResolvedValue({ canceled: true, path: null })
    await expect(saveMomentsLiveVideo({ md5: 'abc', url: '', key: '' })).resolves.toEqual({ canceled: true })
    expect(mocks.apiExportSnsVideo).not.toHaveBeenCalled()
  })

  it('后端写盘失败时抛出可展示的原因', async () => {
    mocks.apiSaveFileDialog.mockResolvedValue({ canceled: false, path: 'D:/out/live.mp4' })
    mocks.apiExportSnsVideo.mockResolvedValue({ ok: false, error: '原视频已过期' })
    await expect(saveMomentsLiveVideo({ md5: 'abc', url: '', key: '' })).rejects.toThrow('原视频已过期')
  })
})
