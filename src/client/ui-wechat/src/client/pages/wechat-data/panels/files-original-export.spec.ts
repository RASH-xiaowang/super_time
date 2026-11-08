// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileItem } from '@deepseek-ai/dsh-wechat-data/types'

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  image: vi.fn(),
  video: vi.fn(),
  file: vi.fn(),
}))

vi.mock('../api.ts', () => ({
  apiSaveFileDialog: mocks.save,
  apiExportFileImage: mocks.image,
  apiExportFileVideo: mocks.video,
  apiExportFileAttachment: mocks.file,
  runtimeCapabilities: () => ({ isBrowser: false, desktopEquivalent: false }),
}))

const { saveFileOriginal } = await import('./files-original-export.ts')

const item = (category: string, over: Partial<FileItem> = {}): FileItem => ({
  md5: 'a'.repeat(32),
  fileName: 'a'.repeat(32) + '.dat',
  fileSize: 12,
  modifyTime: 1,
  category,
  ...over,
})

beforeEach(() => {
  for (const fn of Object.values(mocks)) {
    fn.mockReset()
  }
  mocks.save.mockResolvedValue({ canceled: false, path: 'D:\\exports\\chosen.jpg' })
})

describe('文件库单条原文件导出', () => {
  it('图片以解码 key 调用后端并按真实格式保存', async () => {
    mocks.image.mockResolvedValue({ ok: true, path: 'D:\\exports\\chosen.png', format: 'png' })
    const saved = await saveFileOriginal(item('image', {
      fileName: 'b'.repeat(32) + '_h.dat',
    }), { jobId: 'file-image-job' })
    expect(mocks.image).toHaveBeenCalledWith({
      md5: 'b'.repeat(32),
      dest: 'D:\\exports\\chosen.jpg',
      jobId: 'file-image-job',
    })
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      defaultName: '图片-aaaaaaaa',
    }))
    expect(saved).toMatchObject({ ok: true, format: 'png' })
  })

  it('视频与普通文件分别走原视频、原附件 RPC', async () => {
    mocks.video.mockResolvedValue({ ok: true, path: 'D:\\exports\\chosen.mp4' })
    mocks.file.mockResolvedValue({ ok: true, path: 'D:\\exports\\chosen.pdf' })

    await saveFileOriginal(item('video'), { jobId: 'file-video-job' })
    expect(mocks.video).toHaveBeenCalledWith({
      md5: 'a'.repeat(32),
      dest: 'D:\\exports\\chosen.jpg',
      jobId: 'file-video-job',
    })
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      defaultName: '视频-aaaaaaaa',
    }))

    await saveFileOriginal(item('file', { fileName: '报价单.pdf' }), { jobId: 'file-attachment-job' })
    expect(mocks.file).toHaveBeenCalledWith({
      fileName: '报价单.pdf',
      size: 12,
      md5: 'a'.repeat(32),
      dest: 'D:\\exports\\chosen.jpg',
      jobId: 'file-attachment-job',
    })
  })

  it('取消保存时不调用任何导出 RPC', async () => {
    mocks.save.mockResolvedValue({ canceled: true, path: null })
    expect(await saveFileOriginal(item('image'))).toBeNull()
    expect(mocks.image).not.toHaveBeenCalled()
  })
})
