// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  saveDialog: vi.fn(),
  exportImage: vi.fn(),
}))

vi.mock('../api.ts', () => ({
  apiSaveFileDialog: mocks.saveDialog,
  apiExportSnsImage: mocks.exportImage,
}))

vi.mock('../ui/desktop-only.tsx', () => ({
  desktopAction: () => false,
}))

const { saveMomentImageOriginal } = await import('./moments-original-export.ts')

beforeEach(() => {
  mocks.saveDialog.mockReset()
  mocks.exportImage.mockReset()
  mocks.saveDialog.mockResolvedValue({ canceled: false, path: 'D:\\out\\moment.webp' })
  mocks.exportImage.mockResolvedValue({ ok: true, bytes: 4096, format: 'webp', source: 'cdn' })
})

describe('朋友圈原图保存', () => {
  it('把灯箱定位字段与 jobId 完整交给后端', async () => {
    await expect(saveMomentImageOriginal({
      md5: 'a'.repeat(32),
      timelineId: 'timeline-1',
      id: 'media-1',
      url: 'https://example.test/image',
      token: 'token-1',
      seed: 'seed-1',
      key: 'key-1',
      originalWidth: 1440,
      originalHeight: 1920,
      originalBytes: 212083,
      uhdUrl: 'https://example.test/image/2000',
      uhdToken: 'uhd-token-1',
      uhdSeed: 'uhd-seed-1',
    }, 'data:image/webp;base64,AAAA', 'moment-image-job', 2)).resolves.toMatchObject({
      ok: true,
      path: 'D:\\out\\moment.webp',
      bytes: 4096,
      format: 'webp',
    })
    expect(mocks.exportImage).toHaveBeenCalledWith(expect.objectContaining({
      md5: 'a'.repeat(32),
      timelineId: 'timeline-1',
      mediaId: 'media-1',
      url: 'https://example.test/image',
      token: 'token-1',
      seed: 'seed-1',
      key: 'key-1',
      originalWidth: 1440,
      originalHeight: 1920,
      originalBytes: 212083,
      uhdUrl: 'https://example.test/image/2000',
      uhdToken: 'uhd-token-1',
      uhdSeed: 'uhd-seed-1',
      dest: 'D:\\out\\moment.webp',
      jobId: 'moment-image-job',
    }))
  })

  it('用户关闭保存对话框时不创建后端任务', async () => {
    mocks.saveDialog.mockResolvedValue({ canceled: true })
    await expect(saveMomentImageOriginal(
      { md5: 'a'.repeat(32) },
      'https://example.test/image.jpg',
      'moment-image-cancel',
      0,
    )).resolves.toBeNull()
    expect(mocks.exportImage).not.toHaveBeenCalled()
  })
})
