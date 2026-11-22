/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ get: vi.fn(), desktop: false, equivalent: false }))
vi.mock('../api.ts', () => ({ apiGetHandoffReminds: mocks.get, runtimeCapabilities: () => ({ isDesktop: mocks.desktop, desktopEquivalent: mocks.equivalent }) }))
import { HandoffRemindList } from './tasks-handoff.tsx'
afterEach(() => { vi.clearAllMocks(); mocks.desktop = false; mocks.equivalent = false })
describe('native handoff reminder capability gate', () => {
  it.each([[false, false, false], [true, false, true], [false, true, true]])('desktop=%s equivalent=%s makes an RPC only when supported=%s', async (desktop, equivalent, supported) => {
    mocks.desktop = desktop; mocks.equivalent = equivalent
    mocks.get.mockResolvedValue({ items: [{ id: 1, title: 'synthetic reminder', time: null }] })
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => { root.render(createElement(HandoffRemindList)); await Promise.resolve() })
      if (supported) { expect(mocks.get).toHaveBeenCalledTimes(1); expect(host.textContent).toContain('synthetic reminder') }
      else { expect(mocks.get).not.toHaveBeenCalled(); expect(host.textContent).toContain('仅电脑端可用') }
    } finally { await act(async () => root.unmount()); host.remove() }
  })
})
