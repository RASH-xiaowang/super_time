// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  apiCancelExportJob: vi.fn(),
  apiGetExportProgress: vi.fn(),
}))

vi.mock('../api.ts', () => mocks)

const { useExportTask } = await import('./export-task.ts')
type Task = ReturnType<typeof useExportTask>
type ExportTaskContext = import('./export-task.ts').ExportTaskContext

let task: Task | null = null
let host: HTMLDivElement
let root: Root

function Harness(): React.JSX.Element {
  task = useExportTask()
  const state = task.state
  const progress = state.progress
  return createElement('div', {
    'data-status': state.status,
    'data-label': state.label,
    'data-progress': progress ? `${progress.phase}:${progress.done}/${progress.total}` : 'none',
    'data-finishing': String(task.finishing),
    'data-canceling': String(state.canceling),
    'data-message': state.message,
  })
}

const attr = (name: string): string | null => host.firstElementChild?.getAttribute(name) ?? null

function emit(detail: { jobId: string; phase: string; done: number; total: number }): void {
  act(() => {
    window.dispatchEvent(new CustomEvent('dsh-wechat-export-progress', { detail }))
  })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.apiCancelExportJob.mockReset()
  mocks.apiGetExportProgress.mockReset()
  mocks.apiCancelExportJob.mockResolvedValue({ ok: true })
  task = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => { root.render(createElement(Harness)) })
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('useExportTask', () => {
  it('生成 jobId、只认领自己的事件，并在 Promise 收尾后清槽', async () => {
    let resolve!: (value: string) => void
    let jobId = ''
    let runPromise: ReturnType<Task['run']> | null = null
    await act(async () => {
      runPromise = task?.run((ctx) => {
        jobId = ctx.jobId
        return new Promise<string>((done) => { resolve = done })
      }, {
        idPrefix: 'unit-export',
        label: '单元导出',
        successMessage: (value) => `完成 ${value}`,
      }) ?? null
      await Promise.resolve()
    })

    expect(jobId).toMatch(/^unit-export-/)
    expect(attr('data-status')).toBe('running')
    emit({ jobId, phase: 'collect', done: 3, total: 10 })
    expect(attr('data-progress')).toBe('collect:3/10')
    expect(attr('data-finishing')).toBe('false')

    emit({ jobId: 'someone-else', phase: 'write', done: 9, total: 10 })
    expect(attr('data-progress'), '别人的 jobId 抢走了状态卡').toBe('collect:3/10')

    emit({ jobId, phase: 'write', done: 10, total: 10 })
    expect(attr('data-finishing'), '进度已满但按钮仍应显示完成中').toBe('true')

    await act(async () => { resolve('ok'); await runPromise })
    expect(attr('data-status')).toBe('success')
    expect(attr('data-message')).toBe('完成 ok')
    expect(attr('data-progress')).toBe('none')

    emit({ jobId, phase: 'write', done: 1, total: 2 })
    expect(attr('data-progress'), '收尾后旧 jobId 还能写状态').toBe('none')
  })

  it('取消只发信号；任务以取消异常收尾时进入 canceled 而不是 error', async () => {
    let reject!: (error: Error) => void
    let jobId = ''
    let runPromise: ReturnType<Task['run']> | null = null
    await act(async () => {
      runPromise = task?.run((ctx) => {
        jobId = ctx.jobId
        return new Promise((_resolve, fail) => { reject = fail })
      }, {
        idPrefix: 'cancel-export',
        label: '可取消导出',
        successMessage: () => '不会成功',
      }) ?? null
      await Promise.resolve()
    })

    act(() => { void task?.cancel() })
    expect(mocks.apiCancelExportJob).toHaveBeenCalledWith(jobId)
    expect(attr('data-status'), '取消信号发出后应等 RPC 收尾').toBe('running')

    await act(async () => {
      reject(new Error('操作已取消'))
      await runPromise
    })
    expect(attr('data-status')).toBe('canceled')
    expect(attr('data-message')).toBe('任务已停止')
  })

  it('真正失败保留原因，成功后允许启动下一条任务', async () => {
    await act(async () => {
      await task?.run(async () => { throw new Error('磁盘已满') }, {
        idPrefix: 'fail-export',
        label: '失败导出',
        successMessage: () => '不会成功',
      })
    })
    expect(attr('data-status')).toBe('error')
    expect(attr('data-message')).toBe('磁盘已满')

    await act(async () => {
      await task?.run(async () => 1, {
        idPrefix: 'next-export',
        label: '下一条导出',
        successMessage: () => '成功',
      })
    })
    expect(attr('data-status')).toBe('success')
    expect(attr('data-message')).toBe('成功')
  })

  it('取消失败后不把后续真实错误误报成已取消', async () => {
    let reject!: (error: Error) => void
    let runPromise: ReturnType<Task['run']> | null = null
    mocks.apiCancelExportJob.mockResolvedValue({ ok: false })
    await act(async () => {
      runPromise = task?.run(() => new Promise((_resolve, fail) => { reject = fail }), {
        idPrefix: 'cancel-failure-export',
        label: '取消失败导出',
        successMessage: () => '不会成功',
      }) ?? null
      await Promise.resolve()
    })

    await act(async () => { await task?.cancel() })
    await act(async () => {
      reject(new Error('磁盘已满'))
      await runPromise
    })
    expect(attr('data-status')).toBe('error')
    expect(attr('data-message')).toBe('磁盘已满')
  })

  it('多步任务只认当前子任务的事件，上一项迟到的事件不会覆盖新进度', async () => {
    let resolve!: (value: string) => void
    let context: ExportTaskContext | null = null
    let runPromise: ReturnType<Task['run']> | null = null
    await act(async () => {
      runPromise = task?.run((ctx) => {
        context = ctx
        return new Promise<string>((done) => { resolve = done })
      }, {
        idPrefix: 'multi-export',
        label: '多步导出',
        successMessage: () => '完成',
      }) ?? null
      await Promise.resolve()
    })

    const parentJob = context!.jobId
    const first = `${parentJob}-item-1`
    const second = `${parentJob}-item-2`
    context!.bindJobId(first)
    emit({ jobId: first, phase: 'collect', done: 3, total: 9 })
    expect(attr('data-progress')).toBe('collect:3/9')

    context!.bindJobId(second)
    emit({ jobId: first, phase: 'write', done: 9, total: 9 })
    expect(attr('data-progress'), '上一项的迟到事件被当前任务认领了').toBe('collect:3/9')
    emit({ jobId: second, phase: 'collect', done: 4, total: 20 })
    expect(attr('data-progress')).toBe('collect:4/20')

    await act(async () => { resolve('ok'); await runPromise })
  })

  it('协作式多步任务在子任务间隙取消时保留取消意图，由 worker 收尾', async () => {
    let reject!: (error: Error) => void
    let runPromise: ReturnType<Task['run']> | null = null
    mocks.apiCancelExportJob.mockResolvedValue({ ok: false, error: '该导出任务已结束' })
    await act(async () => {
      runPromise = task?.run((ctx) => {
        ctx.bindJobId(`${ctx.jobId}-item-1`)
        return new Promise((_resolve, fail) => { reject = fail })
      }, {
        idPrefix: 'cooperative-export',
        label: '批量导出',
        cooperativeCancel: true,
        successMessage: () => '不会成功',
      }) ?? null
      await Promise.resolve()
    })

    await act(async () => { await task?.cancel() })
    expect(attr('data-canceling'), '子任务已结束也不该丢掉整批任务的取消请求').toBe('true')
    await act(async () => {
      reject(new Error('任务已取消'))
      await runPromise
    })
    expect(attr('data-status')).toBe('canceled')
  })

  it('本地即时任务不显示取消，状态仍走 running/success', async () => {
    let resolve!: () => void
    let runPromise: ReturnType<Task['run']> | null = null
    await act(async () => {
      runPromise = task?.run(() => new Promise<void>((done) => { resolve = done }), {
        idPrefix: 'local-export',
        label: '本地导出',
        progress: { phase: 'local', done: 0, total: 0 },
        cancelable: false,
        successMessage: () => '本地完成',
      }) ?? null
      await Promise.resolve()
    })
    act(() => { void task?.cancel() })
    expect(mocks.apiCancelExportJob, '本地任务没有后端 job，取消不该打 RPC').not.toHaveBeenCalled()
    await act(async () => { resolve(); await runPromise })
    expect(attr('data-status')).toBe('success')
  })
})
