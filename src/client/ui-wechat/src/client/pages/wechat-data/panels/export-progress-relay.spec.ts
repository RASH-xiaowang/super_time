// @vitest-environment jsdom
/**
 * W2-10.4：进度中继的「拉推结合」兜底。
 *
 * ## 这条在守什么
 *
 * 后端把导出进度**推**出来（`wechat-export/progress` → ui-entry 中继成 DOM 事件）。
 * 那条路任何一环断了，表现是**进度条永远停在 null**，而后台任务跑得好好的 ——
 * 不报错，用户看到的是「点了导出，什么都没有」。后端一直有 `getExportProgress`
 * 这条拉的路，但前端没有任何地方调它。
 *
 * ## 三条不许退化的性质
 *
 * ① **推断了必须拉得到**：静默超过阈值后，兜底要把进度取回来填上同一个 state。
 * ② **推通了不许拉**：拉只是兜底，不能变成常驻轮询 —— 否则每秒钟多一次 IPC，
 *    而且「进度条动了」也不再证明推送是通的。
 * ③ **没任务不许拉**：`jobRef.current` 为空时这个 interval 必须全程空转（零成本）。
 *
 * @vitest-environment jsdom
 */
import { act } from 'react-dom/test-utils'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「拉」必须 mock 成**顶层 hoisted**：被测模块是静态 `import` 它的，
 * 用例里的 `vi.doMock` 赶在模块加载之后，mocker 根本不会生效（第一版就这么写的，
 * 跑出来是「推断了却一次都没拉」—— 看着像功能没实现，其实是 mock 没接上）。
 */
const relay = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../api.ts', () => ({
  apiGetExportProgress: async () => {
    relay.calls += 1
    return { found: true, phase: 'sessions', done: 3, total: 10, finished: false }
  },
}))

const { RELAY_POLL_MS, RELAY_SILENT_MS, useExportProgressRelay } = await import('./export-progress-relay.ts')

/** 拉回来的进度样本（后端 `getExportProgress` 的口径）。 */
interface Sample { phase: string; done: number; total: number }

const samples: Sample[] = []

/** 一个小部件：把 hook 挂上，并把 `notePush` 挂到 window 供用例调用。 */
function Harness(props: {
  jobRef: React.MutableRefObject<string>
  onSample: (s: Sample) => void
}): React.JSX.Element {
  const note = useExportProgressRelay(props.jobRef, props.onSample)
  ;(window as unknown as { __note: () => void }).__note = note
  return createElement('div')
}

let root: Root | null = null
let container: HTMLDivElement | null = null
let jobRef: React.MutableRefObject<string>

beforeEach(() => {
  vi.useFakeTimers()
  relay.calls = 0
  samples.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  jobRef = { current: '' }
})

afterEach(() => {
  act(() => { root?.unmount() })
  root = null
  container?.remove()
  container = null
  vi.useRealTimers()
})

function mount(): void {
  act(() => {
    root = createRoot(container as HTMLDivElement)
    root.render(createElement(Harness, { jobRef, onSample: (s) => { samples.push(s) } }))
  })
}

/** 收到一条推送（调用方在 DOM 事件里做的事）。 */
function push(): void {
  act(() => { (window as unknown as { __note: () => void }).__note() })
}

describe('W2-10.4：推断了要能拉回来', () => {
  it('推送静默超过阈值 ⇒ 兜底把进度取回来', async () => {
    mount()
    act(() => { jobRef.current = 'job-a' })
    await act(async () => { await vi.advanceTimersByTimeAsync(RELAY_POLL_MS * 2) })
    // 前两拍在起算静默计时，还没到阈值 ⇒ 不该拉
    expect(relay.calls, '阈值都没到就拉 ⇒ 这不是兜底，是常驻轮询').toBe(0)

    await act(async () => { await vi.advanceTimersByTimeAsync(RELAY_SILENT_MS + RELAY_POLL_MS * 2) })
    expect(relay.calls, '推断了却一次都没拉 ⇒ 进度条会永远停在 null').toBeGreaterThan(0)
    expect(samples.length, '拉到了却没有回填进度').toBeGreaterThan(0)
    expect(samples[0]).toMatchObject({ phase: 'sessions', done: 3, total: 10 })
  })
})

describe('W2-10.4：推通了不许拉（成本承诺）', () => {
  it('推送一直在来 ⇒ 一次都不拉', async () => {
    mount()
    act(() => { jobRef.current = 'job-b' })
    for (let i = 0; i < 12; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RELAY_POLL_MS)
        push()
      })
    }
    expect(relay.calls, '推送明明是通的却还在拉 ⇒ 每秒多一次 IPC').toBe(0)
    expect(samples, '没拉的时候不该往 state 里写东西').toEqual([])
  })

  it('任务结束后不再拉（ref 清空 ⇒ interval 空转）', async () => {
    mount()
    act(() => { jobRef.current = 'job-c' })
    await act(async () => { await vi.advanceTimersByTimeAsync(RELAY_SILENT_MS + RELAY_POLL_MS * 2) })
    const afterFirst = relay.calls
    expect(afterFirst, '前提：刚才确实拉过').toBeGreaterThan(0)
    act(() => { jobRef.current = '' })
    await act(async () => { await vi.advanceTimersByTimeAsync(RELAY_SILENT_MS + RELAY_POLL_MS * 4) })
    expect(relay.calls, '任务都结束了还在拉 ⇒ 空闲期也在花 IPC').toBe(afterFirst)
  })

  it('从来没任务 ⇒ 一次都不拉', async () => {
    mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(RELAY_SILENT_MS + RELAY_POLL_MS * 6) })
    expect(relay.calls, '没有任务在飞却开始拉').toBe(0)
  })
})

describe('W2-10.4：反例自证（不是恒真）', () => {
  it('静默阈值与轮询间隔都是有意义的正数', () => {
    expect(RELAY_SILENT_MS, '阈值为 0 就等于「每条推送都算断」').toBeGreaterThan(1000)
    expect(RELAY_POLL_MS, '间隔为 0 会变成忙轮询').toBeGreaterThan(0)
    expect(RELAY_POLL_MS).toBeLessThan(RELAY_SILENT_MS)
  })
})