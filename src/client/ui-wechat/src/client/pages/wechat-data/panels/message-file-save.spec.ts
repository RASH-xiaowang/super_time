// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import type { MessageFileSaveTask } from './message-file-save.ts'

const mocks = vi.hoisted(() => ({
  cancelExportJob: vi.fn(),
  downloadMessageFile: vi.fn(),
}))

vi.mock('../api.ts', () => ({
  apiCancelExportJob: mocks.cancelExportJob,
}))

vi.mock('./chats-support.tsx', () => ({
  downloadMessageFile: mocks.downloadMessageFile,
}))

const { useMessageFileSaveTask } = await import('./message-file-save.ts')

const message = {
  localId: 42,
  createTime: 1_790_000_000,
  rich: { fileSize: '2048' },
} as WechatMessage

let host: HTMLDivElement
let root: Root
let task: MessageFileSaveTask | null = null
let flash: ReturnType<typeof vi.fn<(text: string) => void>>

function Harness(): React.JSX.Element {
  task = useMessageFileSaveTask(flash, 'wxid_room')
  return createElement('div', {
    'data-status': task.state.status,
    'data-message': task.state.message,
  })
}

const status = (): string => host.firstElementChild?.getAttribute('data-status') ?? ''
const shownMessage = (): string => host.firstElementChild?.getAttribute('data-message') ?? ''
const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.cancelExportJob.mockReset()
  mocks.cancelExportJob.mockResolvedValue({ ok: true })
  mocks.downloadMessageFile.mockReset()
  flash = vi.fn<(text: string) => void>()
  task = null
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(createElement(Harness)))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('useMessageFileSaveTask', () => {
  it('把菜单入口接到统一保存任务，并透传完整归属信息与 jobId', async () => {
    mocks.downloadMessageFile.mockResolvedValue({ path: 'D:\\exports\\report.pdf' })
    act(() => task?.open('report.pdf', message))
    await flush()

    expect(mocks.downloadMessageFile).toHaveBeenCalledWith('report.pdf', expect.objectContaining({
      username: 'wxid_room',
      localId: 42,
      size: 2048,
      createTime: 1_790_000_000,
      jobId: expect.stringMatching(/^chat-file-menu-/),
    }))
    expect(status()).toBe('success')
    expect(shownMessage()).toBe('已保存原文件 → D:\\exports\\report.pdf')
    expect(flash).toHaveBeenCalledWith('已保存原文件 → D:\\exports\\report.pdf')
  })

  it('失败进入统一错误终态，并保留原来的“打开失败”回执', async () => {
    mocks.downloadMessageFile.mockResolvedValue({ error: '原文件缺失' })
    act(() => task?.open('report.pdf', message))
    await flush()

    expect(status()).toBe('error')
    expect(shownMessage()).toBe('原文件缺失')
    expect(flash).toHaveBeenCalledWith('打开失败：原文件缺失')
  })

  it('用户取消保存对话框时进入 canceled，不弹成功或失败回执', async () => {
    mocks.downloadMessageFile.mockResolvedValue({})
    act(() => task?.open('report.pdf', message))
    await flush()

    expect(status()).toBe('canceled')
    expect(flash).not.toHaveBeenCalled()
  })
})
