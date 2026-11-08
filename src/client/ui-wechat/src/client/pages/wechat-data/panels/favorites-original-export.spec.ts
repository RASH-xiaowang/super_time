// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FavItemPart } from '@deepseek-ai/dsh-wechat-data/types'

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  image: vi.fn(),
  video: vi.fn(),
  file: vi.fn(),
}))

vi.mock('../api.ts', () => ({
  apiSaveFileDialog: mocks.save,
  apiExportFavoriteImage: mocks.image,
  apiExportFavoriteVideo: mocks.video,
  apiExportFavoriteFile: mocks.file,
}))

vi.mock('../ui/desktop-only.tsx', () => ({
  desktopAction: () => false,
  DESKTOP_ACTION_WHY: '桌面端专用',
}))

const {
  saveFavoriteFileOriginal,
  saveFavoriteImageOriginal,
  saveFavoriteVideoOriginal,
} = await import('./favorites-original-export.ts')

const fullMd5 = 'a'.repeat(32)
const part = (over: Partial<FavItemPart> = {}): FavItemPart => ({
  kind: 'image',
  fullMd5,
  md5: 'b'.repeat(32),
  thumbMd5: 'c'.repeat(32),
  ...over,
})

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset()
  mocks.save.mockResolvedValue({ canceled: false, path: 'D:\\exports\\chosen.jpg' })
})

describe('收藏原文件导出', () => {
  it('图片只把完整内容 MD5 交给后端，并使用源图扩展名作为默认名', async () => {
    mocks.image.mockResolvedValue({ ok: true, path: 'D:\\exports\\chosen.png', format: 'png' })
    const saved = await saveFavoriteImageOriginal(part(), 'data:image/png;base64,AAAA', 'favorite-image-job')

    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      defaultName: '收藏图片-aaaaaaaa.png',
    }))
    expect(mocks.image).toHaveBeenCalledWith({
      fullMd5,
      md5: 'b'.repeat(32),
      thumbMd5: 'c'.repeat(32),
      kind: 'image',
      dest: 'D:\\exports\\chosen.jpg',
      jobId: 'favorite-image-job',
    })
    expect(saved).toMatchObject({ ok: true, format: 'png' })
  })

  it('视频只按完整内容 MD5 保存原片', async () => {
    mocks.video.mockResolvedValue({ ok: true, path: 'D:\\exports\\chosen.mov', format: 'mov' })
    const saved = await saveFavoriteVideoOriginal(part({ kind: 'video', format: 'MOV' }), 'favorite-video-job')

    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      defaultName: '收藏视频-aaaaaaaa.mov',
    }))
    expect(mocks.video).toHaveBeenCalledWith({
      fullMd5,
      md5: 'b'.repeat(32),
      thumbMd5: 'c'.repeat(32),
      kind: 'video',
      dest: 'D:\\exports\\chosen.jpg',
      jobId: 'favorite-video-job',
    })
    expect(saved).toMatchObject({ ok: true, format: 'mov' })
  })

  it('缺少完整 MD5 时在选路径之前拒绝，避免保存收藏封面', async () => {
    await expect(saveFavoriteImageOriginal(part({ kind: 'image', fullMd5: undefined })))
      .rejects.toThrow('缺少原图 MD5')
    await expect(saveFavoriteVideoOriginal(part({ kind: 'video', fullMd5: '' })))
      .rejects.toThrow('缺少原视频 MD5')
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.image).not.toHaveBeenCalled()
    expect(mocks.video).not.toHaveBeenCalled()
  })

  it('收藏文件走 business/favorite 专用 RPC，不会误搜 msg/file', async () => {
    mocks.file.mockResolvedValue({ ok: true, path: 'D:\\exports\\chosen.docx', format: 'docx' })
    const saved = await saveFavoriteFileOriginal(part({
      kind: 'file',
      name: '报价单',
      ext: 'docx',
    }), 'favorite-file-job')

    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      defaultName: '报价单.docx',
    }))
    expect(mocks.file).toHaveBeenCalledWith({
      fullMd5,
      kind: 'file',
      dest: 'D:\\exports\\chosen.jpg',
      jobId: 'favorite-file-job',
    })
    expect(saved).toMatchObject({ ok: true, path: 'D:\\exports\\chosen.docx' })
  })

  it('收藏文件缺少完整 MD5 时在选路径前拒绝', async () => {
    await expect(saveFavoriteFileOriginal(part({ kind: 'file', name: '报价单.pdf', fullMd5: undefined })))
      .rejects.toThrow('缺少原文件 MD5')
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.file).not.toHaveBeenCalled()
  })
})
