// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  desktop: false,
  saveDialog: vi.fn(),
  exportFile: vi.fn(),
  exportChatFile: vi.fn(),
}))

vi.mock('../api.ts', () => ({
  apiGetAvatar: vi.fn(),
  apiGetAvatarBatched: vi.fn(),
  apiSaveFileDialog: mocks.saveDialog,
  apiExportFileAttachment: mocks.exportFile,
  apiExportChatFile: mocks.exportChatFile,
}))

vi.mock('../ui/desktop-only.tsx', () => ({
  desktopAction: () => mocks.desktop,
}))

const { downloadMessageFile } = await import('./chats-support.tsx')

beforeEach(() => {
  mocks.desktop = false
  mocks.saveDialog.mockReset()
  mocks.saveDialog.mockResolvedValue({ canceled: false, path: 'D:\\exports\\report.pdf' })
  mocks.exportFile.mockReset()
  mocks.exportFile.mockResolvedValue({ ok: true, path: 'D:\\exports\\report.pdf' })
  mocks.exportChatFile.mockReset()
  mocks.exportChatFile.mockResolvedValue({ ok: true, path: 'D:\\exports\\report.pdf' })
})

describe('聊天原文件保存', () => {
  it('有会话与消息 id 时走消息级原文件 RPC，不信任卡片上的文件线索', async () => {
    const result = await downloadMessageFile('report.pdf', {
      username: 'wxid_room',
      localId: 42,
      size: 2048,
      createTime: 1_790_000_000,
      fileMd5: 'a'.repeat(32),
      jobId: 'chat-file-job',
    })

    expect(mocks.exportChatFile).toHaveBeenCalledWith({
      username: 'wxid_room',
      localId: 42,
      dest: 'D:\\exports\\report.pdf',
      jobId: 'chat-file-job',
    })
    expect(mocks.exportFile).not.toHaveBeenCalled()
    expect(result).toEqual({ path: 'D:\\exports\\report.pdf' })
  })

  it('把消息归属线索交给后端原文件 RPC，而不是生成 data URL 下载', async () => {
    const result = await downloadMessageFile('report.pdf', {
      size: 2048,
      createTime: 1_790_000_000,
      fileMd5: 'a'.repeat(32),
      jobId: 'attachment-file-job',
    })

    expect(mocks.saveDialog).toHaveBeenCalledWith(expect.objectContaining({
      defaultName: 'report.pdf',
      title: '保存微信原文件',
    }))
    expect(mocks.exportFile).toHaveBeenCalledWith({
      fileName: 'report.pdf',
      size: 2048,
      createTime: 1_790_000_000,
      md5: 'a'.repeat(32),
      dest: 'D:\\exports\\report.pdf',
      jobId: 'attachment-file-job',
    })
    expect(mocks.exportChatFile).not.toHaveBeenCalled()
    expect(result).toEqual({ path: 'D:\\exports\\report.pdf' })
  })

  it('消息定位信息不完整时在弹保存框前失败', async () => {
    await expect(downloadMessageFile('report.pdf', { username: 'wxid_room', localId: 0 })).resolves.toEqual({
      error: '缺少消息定位信息，无法确认原文件归属',
    })
    expect(mocks.saveDialog).not.toHaveBeenCalled()
    expect(mocks.exportChatFile).not.toHaveBeenCalled()
  })

  it('用户取消保存时不调用后端写盘', async () => {
    mocks.saveDialog.mockResolvedValue({ canceled: true })
    await expect(downloadMessageFile('report.pdf')).resolves.toEqual({})
    expect(mocks.exportFile).not.toHaveBeenCalled()
  })

  it('后端拒绝歧义文件时把原因交还界面', async () => {
    mocks.exportFile.mockResolvedValue({
      ok: false,
      error: '找到多个同名同大小文件，缺少 MD5，无法确认原文件；已停止猜测',
    })
    await expect(downloadMessageFile('report.pdf', { size: 2048 })).resolves.toEqual({
      error: '找到多个同名同大小文件，缺少 MD5，无法确认原文件；已停止猜测',
    })
  })

  it('移动端不弹保存框', async () => {
    mocks.desktop = true
    await expect(downloadMessageFile('report.pdf')).resolves.toEqual({
      error: '原文件保存仅支持电脑端',
    })
    expect(mocks.saveDialog).not.toHaveBeenCalled()
  })
})
