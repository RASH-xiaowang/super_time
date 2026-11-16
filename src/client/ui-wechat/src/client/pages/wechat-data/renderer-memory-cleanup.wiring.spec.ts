/**
 * 无法从公开 API 直接观察的资源释放守卫：
 *  · 导航栏 ResizeObserver 调度的 rAF 必须在 effect 清理时取消；
 *  · 朋友圈封面攒批的 md5 线索表必须在成功和失败两条路径都删除；
 *  · 文件缩略图与收藏缩略图的迟到回包不得写回卸载后的组件。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
const read = (name: string): string => readFileSync(join(HERE, name), 'utf8').replace(/\r\n/g, '\n')

describe('renderer 资源清理接线', () => {
  it('导航栏布局观察器的帧回调在卸载/重建时被取消', () => {
    const panel = read('WechatDataPanel.tsx')
    const start = panel.indexOf('const navRef = useRef')
    const end = panel.indexOf('}, [updateNavMore, navOpen])', start)
    const effect = panel.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(effect).toContain('frame = requestAnimationFrame')
    expect(effect).toContain('if (frame !== 0) cancelAnimationFrame(frame)')
  })

  it('朋友圈视频封面的 md5 线索在 enqueue 失败时也释放', () => {
    const api = read('api-media.ts')
    const start = api.indexOf('export async function apiGetSnsVideoCoverDataUrl')
    const end = api.indexOf('\n/**', start)
    const fn = api.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(fn).toContain('try {')
    expect(fn).toContain('} finally {')
    expect(fn).toContain('coverHints.delete(md5)')
  })

  it('文件缩略图的在飞回包带存活与 generation 双闸门，卸载时释放缓存', () => {
    const hook = read('panels/use-file-thumbs.ts')
    expect(hook).toContain('if (!alive.current || myGeneration !== generation.current) return')
    expect(hook).toContain('cache.current = emptyThumbCache()')
    expect(hook).toContain('queued.current.clear()')
  })

  it('收藏缩略图的迟到回包不再写 state，卸载时释放 ref 中的 data URL', () => {
    const panel = read('panels/Favorites.tsx')
    expect(panel).toContain('if (!alive.current) return')
    expect(panel).toContain('favThumbsRef.current = {}')
    expect(panel).toContain('favImgFetched.current.clear()')
  })

  it('朋友圈媒体键、封面尝试和失败重试表都有上界，卸载时清掉延迟 timer', () => {
    const hook = read('panels/moments-media.ts')
    expect(hook).toContain('new BoundedMediaSet(MOMENTS_MEDIA_KEY_CACHE_MAX, () => mediaActive.current)')
    expect(hook).toContain('new BoundedMediaMap(MOMENTS_COVER_ATTEMPT_MAX)')
    expect(hook).toMatch(/new BoundedMediaMap\(MOMENTS_MEDIA_KEY_CACHE_MAX\)/g)
    expect(hook).toContain('const mediaRetryCount = useRef<Map<string, number>>(new BoundedMediaMap(MOMENTS_MEDIA_KEY_CACHE_MAX))')
    expect(hook).toContain('queue.current.splice(MOMENTS_MEDIA_QUEUE_MAX)')
    expect(hook).toContain('queue.current.unshift(it)')
    expect(hook).toContain('if (cancelled) {')
    // 2026-11-13：封面尝试表改名为 `attempts`（仍有上界，见上面那条 BoundedMediaMap 断言）。
    expect(hook).toContain('attempts.current.set(url, (attempts.current.get(url) ?? 0) + 1)')
    expect(hook).toContain('}, [viewerRequestKey, viewerResolved])')
    expect(hook).toContain('for (const timer of mediaRetryTimers.current) window.clearTimeout(timer)')
  })
})
