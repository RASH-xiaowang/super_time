// @vitest-environment jsdom
/** DataTable 列宽拖拽：只改目标列、拖拽结束清理全局状态、双击恢复自适应。 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DataTable } from './kit-table.tsx'
import { adjustColumnWidths, clampColumnWidth, COLUMN_MAX_WIDTH, COLUMN_MIN_WIDTH } from './table-column-resize.ts'

interface Row {
  id: string
  name: string
}

const rows: Row[] = [{ id: '1', name: '测试记录' }]
const columns = [
  { id: 'name', header: '名称', cell: (row: Row) => row.name, width: 120 },
  { id: 'note', header: '备注', cell: () => '内容', width: 240 },
]

let root: Root | null = null
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  if (root) {
    act(() => { root?.unmount() })
    root = null
  }
  host.remove()
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
})

function mount(resizable = true): void {
  root = createRoot(host)
  act(() => {
    root?.render(createElement(DataTable<Row>, {
      columns,
      rows,
      getRowId: row => row.id,
      resizable,
    }))
  })
}

function stubHeaderWidths(widths: readonly number[]): void {
  const headers = [...host.querySelectorAll<HTMLTableCellElement>('thead th')]
  headers.forEach((header, index) => {
    header.getBoundingClientRect = () => ({
      width: widths[index] ?? COLUMN_MIN_WIDTH,
    }) as DOMRect
  })
}

describe('DataTable 列宽拖拽', () => {
  it('宽度计算受最小值和最大值约束', () => {
    expect(clampColumnWidth(20)).toBe(COLUMN_MIN_WIDTH)
    expect(clampColumnWidth(2000)).toBe(COLUMN_MAX_WIDTH)
    expect(adjustColumnWidths({ name: 120 }, 'name', 180)).toEqual({ name: 180 })
  })

  it('拖动手柄只放宽目标列，并在松开后恢复页面光标', () => {
    mount()
    stubHeaderWidths([120, 240])
    const handle = host.querySelector<HTMLElement>('[role="separator"]')
    expect(handle).not.toBeNull()

    act(() => {
      handle?.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 100,
      }))
    })
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 150 }))
    })
    expect(document.body.style.cursor).toBe('col-resize')

    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    })
    const cols = [...host.querySelectorAll<HTMLTableColElement>('col')]
    expect(cols[0]?.style.width).toBe('170px')
    expect(cols[1]?.style.width).toBe('240px')
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
  })

  it('键盘可调整列宽，双击手柄恢复自动宽度', () => {
    mount()
    stubHeaderWidths([120, 240])
    const handle = host.querySelector<HTMLElement>('[role="separator"]')
    expect(handle).not.toBeNull()

    act(() => {
      handle?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(host.querySelector<HTMLTableColElement>('col')?.style.width).toBe('136px')

    act(() => {
      handle?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    })
    expect(host.querySelector<HTMLTableColElement>('col')?.style.width).toBe('120px')
    expect(host.querySelector<HTMLTableElement>('table')?.style.width).toBe('')
  })

  it('未开启 resizable 时不渲染拖拽手柄', () => {
    mount(false)
    expect(host.querySelector('[role="separator"]')).toBeNull()
  })

  it('拖动中直接更新 DOM，不逐帧重渲染表格', async () => {
    let cellRenders = 0
    const trackedColumns = [
      { id: 'name', header: '名称', width: 120, cell: (row: Row) => { cellRenders++; return row.name } },
      { id: 'note', header: '备注', width: 240, cell: () => '内容' },
    ]
    root = createRoot(host)
    act(() => {
      root?.render(createElement(DataTable<Row>, {
        columns: trackedColumns,
        rows,
        getRowId: row => row.id,
        resizable: true,
      }))
    })
    stubHeaderWidths([120, 240])
    const rendersAfterMount = cellRenders
    const handle = host.querySelector<HTMLElement>('[role="separator"]')

    act(() => {
      handle?.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 100,
      }))
      window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 150 }))
    })
    await vi.waitFor(() => {
      expect(host.querySelector<HTMLTableColElement>('col')?.style.width).toBe('170px')
    })
    expect(cellRenders).toBe(rendersAfterMount)

    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    })
    expect(cellRenders).toBeGreaterThan(rendersAfterMount)
  })
})
