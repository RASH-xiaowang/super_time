// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiGetRemoteImageUrl } from '../api-media.ts'
import { imageToDataUrl } from './overview-export.ts'

vi.mock('../api-media.ts', () => ({
  apiGetRemoteImageUrl: vi.fn(),
}))

const mockedProxy = vi.mocked(apiGetRemoteImageUrl)

function image(src: string, loaded = false): HTMLImageElement {
  const el = document.createElement('img')
  el.setAttribute('src', src)
  Object.defineProperty(el, 'complete', { configurable: true, value: loaded })
  Object.defineProperty(el, 'naturalWidth', { configurable: true, value: loaded ? 10 : 0 })
  Object.defineProperty(el, 'naturalHeight', { configurable: true, value: loaded ? 10 : 0 })
  return el
}

describe('imageToDataUrl 的导出网络边界', () => {
  beforeEach(() => {
    mockedProxy.mockReset()
  })

  it('http(s) 图片只走后端白名单代理，不直接 fetch 外站', async () => {
    mockedProxy.mockResolvedValue('data:image/png;base64,proxied')
    const fetchSpy = vi.fn(() => Promise.reject(new Error('renderer must not fetch https directly')))
    vi.stubGlobal('fetch', fetchSpy)
    try {
      await expect(imageToDataUrl(image('https://cdn.example.test/avatar.png'))).resolves
        .toBe('data:image/png;base64,proxied')
      expect(mockedProxy).toHaveBeenCalledWith('https://cdn.example.test/avatar.png')
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('非本机、非 http(s) 的 scheme 返回 null，不产生网络调用', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    try {
      await expect(imageToDataUrl(image('ftp://example.test/image.png'))).resolves.toBeNull()
      expect(mockedProxy).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
