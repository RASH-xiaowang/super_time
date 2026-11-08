// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaSaveTask } from './media-save-task.ts'

const mocks = vi.hoisted(() => ({
  cancelExportJob: vi.fn(),
}))

vi.mock('../api.ts', () => ({
  apiCancelExportJob: mocks.cancelExportJob,
}))

const { useMediaSaveTask } = await import('./media-save-task.ts')

let host: HTMLDivElement
let root: Root
let task: MediaSaveTask | null = null

function Harness(): React.JSX.Element {
  task = useMediaSaveTask()
  return createElement('div', {
    'data-status': task.state.status,
    'data-message': task.state.message,
  })
}

const status = (): string => host.firstElementChild?.getAttribute('data-status') ?? ''
const message = (): string => host.firstElementChild?.getAttribute('data-message') ?? ''
const flush = async (): Promise<void> => {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.cancelExportJob.mockReset()
  mocks.cancelExportJob.mockResolvedValue({ ok: true })
  task = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(createElement(Harness)))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('useMediaSaveTask', () => {
  it('为单文件保存生成 jobId，并把成功结果收敛成统一终态', async () => {
    let seenJobId = ''
    let outcome: Awaited<ReturnType<MediaSaveTask['save']>> | null = null
    await act(async () => {
      outcome = await task?.save<{ path: string }>({
        idPrefix: 'test-media',
        label: '保存测试视频',
        successMessage: (result) => `已保存 ${result.path}`,
        run: async (jobId) => {
          seenJobId = jobId
          return { path: 'D:\\out\\video.mp4' }
        },
      }) ?? null
    })
    expect(seenJobId).toMatch(/^test-media-/)
    expect(outcome).toMatchObject({ ok: true, result: { path: 'D:\\out\\video.mp4' } })
    expect(status()).toBe('success')
    expect(message()).toContain('D:\\out\\video.mp4')
  })

  it('保存对话框返回 null 时进入取消态，不伪装成功', async () => {
    await act(async () => {
      await task?.save({
        idPrefix: 'test-cancel',
        label: '保存测试文件',
        successMessage: () => '不应出现',
        run: async () => null,
      })
    })
    expect(status()).toBe('canceled')
    expect(message()).toBe('任务已停止')
  })

  it('取消按钮用当前后台 jobId 发取消 RPC，保留取消终态', async () => {
    let seenJobId = ''
    let rejectRun: ((error: Error) => void) | null = null
    act(() => {
      void task?.save({
        idPrefix: 'test-active',
        label: '保存大附件',
        successMessage: () => '不应出现',
        run: async (jobId) => {
          seenJobId = jobId
          await new Promise<void>((_resolve, reject) => { rejectRun = reject })
          return null
        },
      })
    })
    await flush()
    expect(status()).toBe('running')
    await act(async () => { await task?.cancel() })
    expect(mocks.cancelExportJob).toHaveBeenCalledWith(seenJobId)
    await act(async () => {
      rejectRun?.(new Error('已取消'))
      await Promise.resolve()
    })
    await flush()
    expect(status()).toBe('canceled')
  })
})
