import { beforeEach, describe, expect, it } from 'vitest'
import { snsImageUrlCacheHandles } from '../src/query/sns-image.ts'

describe('sns-image：data URL 缓存预算', () => {
  beforeEach(() => {
    snsImageUrlCacheHandles().clear()
  })

  it('超过 32MB 总字符预算时逐出旧条目', () => {
    const h = snsImageUrlCacheHandles()
    const dataUrl = 'data:image/jpeg;base64,' + 'x'.repeat(1536 * 1024)
    for (let i = 0; i < 40; i += 1) h.putForTest(`md5-${String(i)}`, dataUrl)

    const stats = h.stats()
    expect(stats.total).toBeLessThanOrEqual(32 * 1024 * 1024)
    expect(stats.count).toBeGreaterThan(0)
    expect(stats.count).toBeLessThan(40)
  })

  it('单条超过 8MB 时不入缓存', () => {
    const h = snsImageUrlCacheHandles()
    h.putForTest('oversized', 'data:image/jpeg;base64,' + 'x'.repeat(8 * 1024 * 1024))

    expect(h.stats()).toEqual({ count: 0, total: 0 })
  })
})
