// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExportProgressStatus, exportPhaseLabel, exportProgressDetail, exportProgressPercent } from './ExportProgressStatus.tsx'
import type { ExportTaskState } from './export-task.ts'

const IDLE: ExportTaskState = {
  status: 'idle', label: '', progress: null, message: '', canceling: false, cancelable: false,
}
let host: HTMLDivElement
let root: Root

function show(state: ExportTaskState, onCancel?: () => void): void {
  act(() => { root.render(createElement(ExportProgressStatus, { state, ...(onCancel ? { onCancel } : {}) })) })
}

const q = (selector: string): Element | null => host.querySelector(selector)
const click = (el: Element | null): void => {
  expect(el).not.toBeNull()
  act(() => { el?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('ExportProgressStatus', () => {
  it('阶段、百分比、完成数一起显示；未知阶段原样保留', () => {
    show({
      ...IDLE,
      status: 'running',
      label: '导出聊天记录',
      progress: { phase: 'write', done: 3, total: 12 },
      cancelable: true,
    })
    expect(q('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('25')
    expect(host.textContent).toContain('正在写入文件')
    expect(host.textContent).toContain('3 / 12 个文件')
    expect(exportPhaseLabel('packing')).toBe('packing')
    expect(exportPhaseLabel('')).toBe('导出中')
  })

  it('总量未知走不定量态，不伪造 0%', () => {
    show({
      ...IDLE,
      status: 'running',
      label: '导出朋友圈',
      progress: { phase: 'collect', done: 7, total: 0 },
      cancelable: true,
    })
    expect(q('[role="progressbar"]')?.hasAttribute('data-indeterminate')).toBe(true)
    expect(q('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false)
    expect(exportProgressPercent({ phase: 'collect', done: 7, total: 0 })).toBeNull()
    expect(exportProgressDetail({ phase: 'collect', done: 7, total: 0 })).toContain('7 条')
  })

  it('进度到总量后标题显示正在收尾', () => {
    show({
      ...IDLE,
      status: 'running',
      label: '导出文件清单',
      progress: { phase: 'write', done: 8, total: 8 },
      cancelable: true,
    })
    expect(q('[data-export-status]')?.textContent).toContain('正在收尾')
    expect(q('[data-export-status]')?.textContent).toContain('100%')
  })

  it('取消按钮只在运行中且 cancelable 时出现，并显示取消中', () => {
    const onCancel = vi.fn()
    show({
      ...IDLE,
      status: 'running',
      label: '导出',
      progress: { phase: 'collect', done: 1, total: 2 },
      cancelable: true,
    }, onCancel)
    click(q('button'))
    expect(onCancel).toHaveBeenCalledTimes(1)

    show({
      ...IDLE,
      status: 'running',
      label: '导出',
      progress: { phase: 'collect', done: 1, total: 2 },
      cancelable: true,
      canceling: true,
    }, onCancel)
    expect(q('button')?.textContent).toContain('正在取消')
    expect(q('button')?.hasAttribute('disabled')).toBe(true)
  })

  it.each([
    ['success', '导出完成'],
    ['error', '导出失败'],
    ['canceled', '已取消'],
  ] as const)('%s 终态沿用状态卡并显示回执', (status, title) => {
    show({ ...IDLE, status, label: '导出任务', message: '具体结果' })
    expect(q(`[data-export-status="${status}"]`)).not.toBeNull()
    expect(host.textContent).toContain(title)
    expect(host.textContent).toContain('具体结果')
    expect(q('[role="progressbar"]')).toBeNull()
  })
})
