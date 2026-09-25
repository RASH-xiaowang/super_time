/**
 * 图片内存缓存的语义守卫。
 *
 * 为什么单测这层而不只测组件：缓存的「淘汰顺序」「按字节还是按条数」「失败结果进不进」
 * 都是**看不见的行为**——搞错了在界面上表现为「偶尔要重新加载一下」，很难归因。
 * 这里用注入的小容量把边界压到几条数据上，直接钉死。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { createImageCache, imageCacheKey } from './image-cache.ts'

/** 造一条指定「字节数」的假 data URL（`url.length` 就是缓存记账用的量）。 */
function fake(size: number, thumb = false): { url: string; thumb: boolean } {
  return { url: 'd'.repeat(size), thumb }
}

describe('图片内存缓存', () => {
  it('① 未命中返回 undefined；写入后可命中，且 thumb 标记保真', () => {
    const c = createImageCache({ maxBytes: 1000, maxEntryBytes: 500 })
    expect(c.get('wxid_a', 1)).toBeUndefined()
    c.set('wxid_a', 1, fake(10, true))
    expect(c.get('wxid_a', 1)).toEqual({ url: 'd'.repeat(10), thumb: true })
    // 同一个 localId 在不同会话下是两条（localId 只在会话内唯一）
    expect(c.get('wxid_b', 1)).toBeUndefined()
  })

  it('② 会话之间不串味：key 必须同时含 username 与 localId', () => {
    const c = createImageCache()
    expect(imageCacheKey('wxid_a', 7)).toBe('wxid_a:7')
    expect(imageCacheKey('wxid_b', 7)).not.toBe(imageCacheKey('wxid_a', 7))
    c.set('wxid_a', 7, fake(5))
    c.set('wxid_b', 7, fake(6))
    expect(c.get('wxid_a', 7)?.url.length).toBe(5)
    expect(c.get('wxid_b', 7)?.url.length).toBe(6)
  })

  it('③ LRU（不是 FIFO）：访问过的条目在淘汰时保住，最久未用的先走', () => {
    const c = createImageCache({ maxBytes: 30, maxEntryBytes: 100 })
    c.set('u', 1, fake(10))
    c.set('u', 2, fake(10))
    c.set('u', 3, fake(10)) // 满
    expect(c.get('u', 1), '访问 1，让它变成最近使用').toBeDefined()
    c.set('u', 4, fake(10)) // 淘汰最久未用的
    expect(c.get('u', 2), '最久未用的是 2，应当被淘汰').toBeUndefined()
    expect(c.get('u', 1), '刚访问过的 1 必须还在').toBeDefined()
    expect(c.get('u', 3)).toBeDefined()
    expect(c.get('u', 4)).toBeDefined()
    expect(c.stats()).toEqual({ count: 3, bytes: 30 })
  })

  it('④ 按字节而不是按条数淘汰（同样条数、体量差别巨大）', () => {
    const c = createImageCache({ maxBytes: 100, maxEntryBytes: 90 })
    c.set('u', 1, fake(60))
    c.set('u', 2, fake(60)) // 60+60 > 100 ⇒ 淘汰 1
    expect(c.get('u', 1)).toBeUndefined()
    expect(c.stats()).toEqual({ count: 1, bytes: 60 })
  })

  it('⑤ 单条过大不缓存 —— 一张原图不该把一整屏缩略图挤掉', () => {
    const c = createImageCache({ maxBytes: 100, maxEntryBytes: 50 })
    c.set('u', 1, fake(20))
    c.set('u', 2, fake(80)) // 超过单条上限
    expect(c.get('u', 2)).toBeUndefined()
    expect(c.get('u', 1), '已有的缩略图必须原样留着').toBeDefined()
    expect(c.stats()).toEqual({ count: 1, bytes: 20 })
  })

  it('⑥ 空 url 不进缓存（「这次没取到」不该被当成已缓存）', () => {
    const c = createImageCache()
    c.set('u', 1, { url: '', thumb: false })
    expect(c.get('u', 1)).toBeUndefined()
    expect(c.stats().count).toBe(0)
  })

  it('⑦ 重复写入同一条：只留一份，字节数不重复计', () => {
    const c = createImageCache()
    c.set('u', 1, fake(30))
    c.set('u', 1, fake(40))
    expect(c.get('u', 1)?.url.length).toBe(40)
    expect(c.stats()).toEqual({ count: 1, bytes: 40 })
  })

  it('⑧ clear 归零（供测试与「清空缓存」入口用）', () => {
    const c = createImageCache()
    c.set('u', 1, fake(10))
    c.clear()
    expect(c.get('u', 1)).toBeUndefined()
    expect(c.stats()).toEqual({ count: 0, bytes: 0 })
  })
})
