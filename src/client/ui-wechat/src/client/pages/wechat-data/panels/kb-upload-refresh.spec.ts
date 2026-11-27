// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ apiGetKbFiles: vi.fn(), writeRenderCache: vi.fn() }))
vi.mock('../api.ts', () => mocks)
vi.mock('./kb-files-support.tsx', () => ({ cachedFiles: () => null }))
vi.mock('./kb-scope.ts', () => ({ kbCacheKey: (key: string, id: number) => key + ':' + id }))
import { useKbFilesSnapshot } from './use-kb-files-snapshot.ts'
let root: Root, host: HTMLDivElement, latest: ReturnType<typeof useKbFilesSnapshot>, mounted = false
function Probe({ kbId }: { kbId: number }) { latest = useKbFilesSnapshot(kbId); return null }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j }); return { promise, resolve, reject } }
const page = (id: number) => ({ items: [{ id }], total: 1 })
const render = (kbId: number) => act(() => root.render(createElement(Probe, { kbId })))
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  mocks.apiGetKbFiles.mockReset(); mocks.writeRenderCache.mockReset()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); mounted = true
})
afterEach(() => { if (mounted) act(() => root.unmount()); host.remove() })
it('an upload refresh cannot paint its old KB after switching', async () => {
  mocks.apiGetKbFiles.mockResolvedValueOnce(page(1)); render(1); await flush()
  const old = deferred<ReturnType<typeof page>>()
  mocks.apiGetKbFiles.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page(2))
  let refresh!: Promise<void>
  act(() => { refresh = latest.load({ silent: true }) })
  render(2); await flush()
  await act(async () => { old.resolve(page(100)); await refresh })
  expect(latest.snapshot.items[0]?.id).toBe(2)
  expect(mocks.writeRenderCache).not.toHaveBeenCalledWith('kb-files:1', page(100))
})
it('late upload read failure does not overwrite the new KB error/loading state', async () => {
  const old = deferred<ReturnType<typeof page>>()
  mocks.apiGetKbFiles.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page(2))
  render(1); render(2); await flush()
  await act(async () => { old.reject(new Error('old failure')); await Promise.resolve() })
  expect(latest.error).toBeNull()
  expect(latest.loading).toBe(false)
  expect(latest.snapshot.items[0]?.id).toBe(2)
})
it('a stale response cannot return after A to B to A', async () => {
  const old = deferred<ReturnType<typeof page>>()
  mocks.apiGetKbFiles.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page(2)).mockResolvedValueOnce(page(3))
  render(1); render(2); render(1); await flush()
  await act(async () => { old.resolve(page(100)); await old.promise })
  expect(latest.snapshot.items[0]?.id).toBe(3)
})
it('unmount prevents a registration refresh from updating caches', async () => {
  const old = deferred<ReturnType<typeof page>>()
  mocks.apiGetKbFiles.mockReturnValueOnce(old.promise)
  render(1)
  act(() => root.unmount()); mounted = false
  await act(async () => { old.resolve(page(100)); await old.promise })
  expect(mocks.writeRenderCache).not.toHaveBeenCalled()
})
it('the newest read wins when a polling read overlaps registration refresh', async () => {
  const old = deferred<ReturnType<typeof page>>()
  mocks.apiGetKbFiles.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page(2))
  render(1)
  await act(async () => { await latest.load({ silent: true }) })
  await act(async () => { old.resolve(page(100)); await old.promise })
  expect(latest.snapshot.items[0]?.id).toBe(2)
  expect(latest.loading).toBe(false)
})

it('a departed scope callback cannot initiate a read for the new scope', async () => {
  mocks.apiGetKbFiles.mockResolvedValueOnce(page(1)).mockResolvedValueOnce(page(2))
  render(1); await flush()
  const departedLoad = latest.load
  render(2); await flush()
  await act(async () => { await departedLoad({ silent: true }) })
  expect(mocks.apiGetKbFiles).toHaveBeenCalledTimes(2)
  expect(latest.snapshot.items[0]?.id).toBe(2)
})
