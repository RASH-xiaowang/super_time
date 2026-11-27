// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KbFileAddResult } from '../types.ts'
const mocks = vi.hoisted(() => ({ apiAddKbFiles: vi.fn(), apiOpenFileDialog: vi.fn() }))
vi.mock('../api.ts', () => mocks)
import { KbUploadDropzone, KbUploadReceipt, droppedCandidates } from './kb-upload-dropzone.tsx'
import { kbUploadManager, useKbUpload } from './use-kb-upload.ts'
const success = (): KbFileAddResult => ({ ok: true, added: 1, failed: 0, results: [{ ok: true }] })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
let host: HTMLDivElement, root: Root
let mounted = false
let latest: ReturnType<typeof useKbUpload>
let refresh: ReturnType<typeof vi.fn>
function Probe({ kbId = 1, active = true }: { kbId?: number; active?: boolean }) {
  latest = useKbUpload(kbId, refresh, active)
  return createElement(KbUploadDropzone, { kbId, busy: latest.busy, children: createElement('div', { id: 'child' }, 'child') },
    createElement('div', { id: 'child' }, 'child'),
    createElement('button', { disabled: latest.busy, onClick: () => { void latest.pick() } }, '选择'),
    createElement(KbUploadReceipt, { kbId, batch: latest.batch, busy: latest.busy, ownBusy: latest.ownBusy }))
}
const render = (kbId = 1, active = true) => act(() => root.render(createElement(Probe, { kbId, active })))
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
function transfer(files: File[] = [], items?: unknown[], types = ['Files']): DataTransfer {
  return { files, items: items ?? [], types, dropEffect: 'none' } as unknown as DataTransfer
}
function fire(type: string, data: DataTransfer, node: Element = host.firstElementChild!) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: data })
  act(() => { node.dispatchEvent(event) })
  return event
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  mocks.apiAddKbFiles.mockReset().mockResolvedValue(success())
  mocks.apiOpenFileDialog.mockReset().mockResolvedValue({ canceled: true, files: [] })
  for (const kbId of kbUploadManager.getSnapshot().batches.keys()) kbUploadManager.dismiss(kbId)
  window.electronAPI = { kbFiles: { getPathForFile: (file: File) => 'C:/' + file.name } } as NonNullable<Window['electronAPI']>
  refresh = vi.fn().mockResolvedValue(undefined)
  host = document.createElement('div'); document.body.append(host)
  root = createRoot(host); mounted = true
  render()
})
afterEach(async () => {
  if (mounted) act(() => root.unmount())
  await flush()
  host.remove()
  delete window.electronAPI
})

describe('knowledge file drag/drop DOM', () => {
  it('nested enter/leave does not flicker; leaving before drop does not register', () => {
    const data = transfer([new File(['text'], 'a.txt')])
    const zone = host.firstElementChild!
    fire('dragenter', data); fire('dragenter', data, host.querySelector('#child')!)
    fire('dragleave', data, host.querySelector('#child')!)
    expect(zone.getAttribute('data-dragging')).toBe('true')
    fire('dragleave', data)
    expect(zone.hasAttribute('data-dragging')).toBe(false)
    expect(mocks.apiAddKbFiles).not.toHaveBeenCalled()
  })
  it('prevents browser navigation on drop and dragover, ignores non-file text/URLs', () => {
    const data = transfer([], [], ['text/uri-list'])
    fire('dragenter', data)
    expect(host.firstElementChild?.hasAttribute('data-dragging')).toBe(false)
    expect(fire('dragover', data).defaultPrevented).toBe(true)
    expect(fire('drop', data).defaultPrevented).toBe(true)
    expect(mocks.apiAddKbFiles).not.toHaveBeenCalled()
  })
  it('handles mixed files independently, accepts extension despite generic MIME, never reads bytes', async () => {
    const data = transfer([new File(['ok'], 'a.TXT', { type: 'application/octet-stream' }), new File(['no'], 'b.exe'), new File([], 'empty.md')])
    fire('drop', data); await flush()
    expect(mocks.apiAddKbFiles.mock.calls.map(call => call[1])).toEqual([['C:/a.TXT'], ['C:/empty.md']])
    expect(host.textContent).toContain('b.exe')
    expect(host.textContent).toContain('不支持的文件类型')
    expect(host.textContent).toContain('空文件')
    expect(refresh).toHaveBeenCalledTimes(1)
  })
  it('rejects directories and unreadable items without attempting recursive uploads', () => {
    const rows = droppedCandidates(transfer([], [
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true, name: 'folder' }) },
      { kind: 'string' },
      { kind: 'file', getAsFile: () => null },
      { kind: 'file', webkitGetAsEntry: () => { throw new Error('metadata unavailable') } },
    ]), () => 'unused')
    expect(rows).toHaveLength(3)
    expect(rows[0]?.error).toContain('文件夹')
    expect(rows[1]?.error).toContain('无法读取')
    expect(rows[2]?.error).toContain('读取拖拽项目失败')
  })
  it('reports native path resolution errors or absent desktop support without an RPC', async () => {
    window.electronAPI = undefined
    render()
    fire('drop', transfer([new File(['a'], 'a.txt')])); await flush()
    expect(host.textContent).toContain('无法读取本机路径')
    expect(mocks.apiAddKbFiles).not.toHaveBeenCalled()
    expect(droppedCandidates(transfer([new File(['a'], 'a.txt')]), () => { throw new Error('not File') })[0]?.error).toContain('路径失败')
  })
  it('drop metadata over the backend bound is rejected before registration', async () => {
    const file = new File(['a'], 'large.txt'); Object.defineProperty(file, 'size', { value: 32 * 1024 * 1024 + 1 })
    fire('drop', transfer([file])); await flush()
    expect(mocks.apiAddKbFiles).not.toHaveBeenCalled()
    expect(host.textContent).toContain('32 MiB')
  })
  it('blocks repeated drop and picker invocation during an in-flight request, with truthful stop UI', async () => {
    const pending = deferred<KbFileAddResult>()
    mocks.apiAddKbFiles.mockReturnValueOnce(pending.promise)
    fire('drop', transfer([new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]))
    fire('drop', transfer([new File(['a'], 'a.txt')]))
    act(() => { host.querySelector('button')!.click() })
    expect(mocks.apiAddKbFiles).toHaveBeenCalledTimes(1)
    expect(mocks.apiOpenFileDialog).not.toHaveBeenCalled()
    const stop = Array.from(host.querySelectorAll('button')).find(button => button.textContent === '停止后续文件')!
    act(() => stop.click())
    expect(host.textContent).toContain('当前请求仍会完成')
    await act(async () => { pending.resolve(success()); await pending.promise })
    expect(mocks.apiAddKbFiles).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('未开始，可重试')
    expect(latest.busy).toBe(false)
  })
  it('resets drag feedback on Escape, dragend, external drop, blur, or KB switch', () => {
    const data = transfer([new File(['a'], 'a.txt')])
    for (const reset of [
      () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
      () => document.dispatchEvent(new Event('dragend')),
      () => document.dispatchEvent(new Event('drop')),
      () => window.dispatchEvent(new Event('blur')),
    ]) {
      fire('dragenter', data); act(reset)
      expect(host.firstElementChild?.hasAttribute('data-dragging')).toBe(false)
    }
    fire('dragenter', data); render(2)
    expect(host.firstElementChild?.hasAttribute('data-dragging')).toBe(false)
  })
})

describe('upload scope and lifecycle', () => {
  it('switching KB stops pending files, retains old receipt, does not refresh new KB with old results', async () => {
    const pending = deferred<KbFileAddResult>()
    mocks.apiAddKbFiles.mockReturnValueOnce(pending.promise)
    fire('drop', transfer([new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]))
    render(2)
    expect(host.textContent).toContain('另一知识库')
    await act(async () => { pending.resolve(success()); await pending.promise })
    expect(refresh).not.toHaveBeenCalled()
    expect(mocks.apiAddKbFiles).toHaveBeenCalledTimes(1)
    expect(host.textContent).not.toContain('a.txt')
    render(1); await flush()
    expect(host.textContent).toContain('a.txt')
    expect(host.textContent).toContain('未开始，可重试')
    expect(refresh).toHaveBeenCalledTimes(1)
  })
  it('unmount retains current result, stops remaining work and never refreshes departed UI', async () => {
    const pending = deferred<KbFileAddResult>()
    mocks.apiAddKbFiles.mockReturnValueOnce(pending.promise)
    fire('drop', transfer([new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]))
    act(() => root.unmount()); mounted = false
    await act(async () => { pending.resolve(success()); await pending.promise })
    expect(refresh).not.toHaveBeenCalled()
    expect(kbUploadManager.getSnapshot().batches.get(1)?.items.map(item => item.status)).toEqual(['added', 'cancelled'])
    expect(mocks.apiAddKbFiles).toHaveBeenCalledTimes(1)
  })
  it('keep-alive deactivation also stops pending work and refresh waits until reactivation', async () => {
    const pending = deferred<KbFileAddResult>()
    mocks.apiAddKbFiles.mockReturnValueOnce(pending.promise)
    fire('drop', transfer([new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]))
    render(1, false)
    await act(async () => { pending.resolve(success()); await pending.promise })
    expect(refresh).not.toHaveBeenCalled()
    render(1, true); await flush()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(mocks.apiAddKbFiles).toHaveBeenCalledTimes(1)
  })
  it('native keyboard-accessible picker supports multi-select and closes cleanly on cancel', async () => {
    mocks.apiOpenFileDialog.mockResolvedValueOnce({ canceled: false, files: ['C:/a.txt', 'C:/b.md'] })
    act(() => host.querySelector('button')!.click()); await flush()
    expect(mocks.apiAddKbFiles).toHaveBeenCalledTimes(2)
    expect(latest.busy).toBe(false)
    act(() => host.querySelector('button')!.click()); await flush()
    expect(latest.busy).toBe(false)
    expect(mocks.apiAddKbFiles).toHaveBeenCalledTimes(2)
  })
})

it('failed registration can be retried from its receipt without re-registering successful files', async () => {
  mocks.apiAddKbFiles.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(success())
  fire('drop', transfer([new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]))
  await flush()
  expect(host.textContent).toContain('登记结果未确认')
  expect(latest.busy).toBe(false)
  const retry = Array.from(host.querySelectorAll('button')).find(button => button.textContent === '重试未完成项')!
  expect(retry.disabled).toBe(false)
  act(() => retry.click()); await flush()
  expect(mocks.apiAddKbFiles.mock.calls.map(call => call[1])).toEqual([['C:/a.txt'], ['C:/b.txt'], ['C:/a.txt']])
  expect(latest.busy).toBe(false)
})

it('a picker error is visible and does not leave the add button locked', async () => {
  mocks.apiOpenFileDialog.mockRejectedValueOnce(new Error('无法打开选择窗口'))
  act(() => host.querySelector('button')!.click()); await flush()
  expect(host.textContent).toContain('无法打开选择窗口')
  expect(host.querySelector('button')!.disabled).toBe(false)
  expect(mocks.apiAddKbFiles).not.toHaveBeenCalled()
})
