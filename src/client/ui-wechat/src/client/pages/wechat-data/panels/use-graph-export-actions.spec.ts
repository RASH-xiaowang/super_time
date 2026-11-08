// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphCanvasHandle } from './GraphCanvas.tsx'

const { useGraphExportActions } = await import('./use-graph-export-actions.ts')
type Actions = ReturnType<typeof useGraphExportActions>

let actions: Actions | null = null
let host: HTMLDivElement
let root: Root
let click: ReturnType<typeof vi.spyOn>

const canvasRef: { current: GraphCanvasHandle | null } = {
  current: {
    fitView: vi.fn(),
    centerOn: vi.fn(),
    runAnimation: vi.fn(),
    relayout: vi.fn(),
    exportSvg: vi.fn(),
    exportPng: vi.fn(),
    renderPoster: vi.fn(),
  },
}

function Harness(): React.JSX.Element {
  const value = useGraphExportActions({ canvasRef, posterStyle: 'dark', posterRatio: '1:1' })
  actions = value
  const state = value.exportState
  const progress = state.progress
  return createElement('div', {
    'data-status': state.status,
    'data-label': state.label,
    'data-message': state.message,
    'data-cancelable': String(state.cancelable),
    'data-progress': progress ? `${progress.phase}:${progress.done}/${progress.total}` : 'none',
    'data-exporting': String(value.exporting),
  })
}

const attr = (name: string): string | null => host.firstElementChild?.getAttribute(name) ?? null

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  canvasRef.current = {
    fitView: vi.fn(),
    centerOn: vi.fn(),
    runAnimation: vi.fn(),
    relayout: vi.fn(),
    exportSvg: vi.fn(),
    exportPng: vi.fn(),
    renderPoster: vi.fn(),
  }
  click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:graph-export'),
    revokeObjectURL: vi.fn(),
  })
  actions = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => { root.render(createElement(Harness)) })
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  click.mockRestore()
  vi.unstubAllGlobals()
})

describe('useGraphExportActions：本地导出状态', () => {
  it('SVG 使用不定量进度，成功后给出文件名终态', async () => {
    let resolve!: (svg: string) => void
    vi.mocked(canvasRef.current!.exportSvg).mockImplementation(() => new Promise((done) => { resolve = done }))

    let running!: Promise<void>
    await act(async () => {
      running = actions?.exportSvg() ?? Promise.resolve()
      await Promise.resolve()
    })
    expect(attr('data-status')).toBe('running')
    expect(attr('data-exporting')).toBe('true')
    expect(attr('data-progress'), '本地导出不能伪造百分比').toBe('local:0/0')
    expect(attr('data-cancelable')).toBe('false')

    await act(async () => {
      resolve('<svg />')
      await running
    })
    expect(attr('data-status')).toBe('success')
    expect(attr('data-message')).toBe('已导出 社交关系图谱.svg')
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('空 SVG 进入失败终态，而不是只写 console', async () => {
    vi.mocked(canvasRef.current!.exportSvg).mockResolvedValue('')
    await act(async () => { await actions?.exportSvg() })
    expect(attr('data-status')).toBe('error')
    expect(attr('data-message')).toBe('画布尚未就绪，无法导出 SVG')
    expect(click).not.toHaveBeenCalled()
  })

  it('PNG 与海报都走同一任务并透传当前风格/比例', async () => {
    vi.mocked(canvasRef.current!.exportPng).mockResolvedValue('data:image/png;base64,AAAA')
    await act(async () => { await actions?.exportPng() })
    expect(canvasRef.current!.exportPng).toHaveBeenCalledWith('1:1', 'dark')
    expect(attr('data-status')).toBe('success')
    expect(attr('data-message')).toContain('.png')

    vi.mocked(canvasRef.current!.renderPoster).mockResolvedValue('data:image/jpeg;base64,BBBB')
    await act(async () => { await actions?.exportPoster() })
    expect(canvasRef.current!.renderPoster).toHaveBeenCalledWith('1:1', 'dark')
    expect(attr('data-status')).toBe('success')
    expect(attr('data-message')).toContain('.jpg')
  })
})
