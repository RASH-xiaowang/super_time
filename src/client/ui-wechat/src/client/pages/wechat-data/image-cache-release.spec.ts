// @vitest-environment node
/**
 * W3-10.1：图片缓存的**条数上限**与**切页签释放**。
 *
 * ## 两条新口径各自的来历
 *
 * ① **条数上限**：改前只有字节上限（48MB）。原图 base64 常在 1–8MB，48MB 只够 6–48 张；
 *    来回切几个会话/页签之后，一屏缩略图就被原图挤干净，表现为「切回去全是空白块」。
 *    所以加一条 `MAX_ENTRIES`，与字节上限共用同一个 LRU 队列（Map 插入序），不需要新结构。
 *
 * ② **切页签只留目标会话**：这层缓存**跨面板不失效**（见 forgetAllImages 的注释，那是刻意的）。
 *    好处是不白取，代价是「上一个会话的槽还占着地方」。切页签时按 `username:` 前缀
 *    只保留目标会话，其余释放 —— 即「看不见的不占地方」。
 *
 * ## 判据怎么量
 *
 * 全部用**注入的小容量**把边界压到几条数据上；切页签那条直接操作单例再清回去，
 * 不依赖任何组件渲染。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_ENTRIES,
  createImageCache,
  forgetAllImages,
  imageCacheKey,
  keepOnlyImages,
  recallImage,
  rememberImage,
} from './image-cache.ts'

/** 造一条指定「字节数」的假 data URL（`url.length` 就是缓存记账用的量）。 */
function fake(size: number, thumb = false): { url: string; thumb: boolean } {
  return { url: 'd'.repeat(size), thumb }
}

describe('W3-10.1：条数上限', () => {
  it('⑥ 超过条数上限也淘汰（同等条数下字节没超也要走）', () => {
    // maxBytes 给得很大：确保触发淘汰的只能是条数。
    const c = createImageCache({ maxBytes: 10 * 1024 * 1024, maxEntryBytes: 1024, maxEntries: 3 })
    c.set('u', 1, fake(10))
    c.set('u', 2, fake(10))
    c.set('u', 3, fake(10)) // 满（3 条）
    c.set('u', 4, fake(10)) // 超一条 ⇒ 淘汰最久未用的 1
    expect(c.get('u', 1), '条数上限没生效').toBeUndefined()
    expect(c.get('u', 2)).toBeDefined()
    expect(c.stats()).toEqual({ count: 3, bytes: 30 })
  })

  it('⑦ 两个上限共用同一个 LRU 队列（超字节时先走最久未用的，与条数无关）', () => {
    const c = createImageCache({ maxBytes: 100, maxEntryBytes: 90, maxEntries: 100 })
    c.set('u', 1, fake(60))
    c.set('u', 2, fake(60)) // 60+60 > 100 ⇒ 走 1
    expect(c.get('u', 1)).toBeUndefined()
    expect(c.stats()).toEqual({ count: 1, bytes: 60 })
  })

  it('⑧ 默认条数上限够一屏缓存（不至于把缓存废掉）', () => {
    expect(MAX_ENTRIES).toBeGreaterThanOrEqual(64)
    expect(MAX_ENTRIES, '太大就没有约束意义了').toBeLessThanOrEqual(4096)
  })
})

describe('W3-10.1：切页签只留目标会话', () => {
  afterEach(() => { forgetAllImages() })

  it('⑨ 只保留目标会话的键，其余释放；返回真的释放了多少条', () => {
    rememberImage('wxid_a', 1, fake(5))
    rememberImage('wxid_a', 2, fake(5))
    rememberImage('wxid_b', 1, fake(5))
    rememberImage('wxid_b', 2, fake(5))
    expect(imageCacheKey('wxid_a', 1)).toBe('wxid_a:1')

    const dropped = keepOnlyImages('wxid_a')
    expect(dropped, '应当释放 wxid_b 那两条').toBe(2)
    expect(recallImage('wxid_a', 1), '目标会话的必须留着').toBeDefined()
    expect(recallImage('wxid_a', 2)).toBeDefined()
    expect(recallImage('wxid_b', 1), '别的会话必须释放').toBeUndefined()
    expect(recallImage('wxid_b', 2)).toBeUndefined()
  })

  it('⑩ 传空串 = 全部释放（切到不看图的页签）', () => {
    rememberImage('wxid_a', 1, fake(5))
    rememberImage('wxid_b', 1, fake(5))
    expect(keepOnlyImages('')).toBe(2)
    expect(recallImage('wxid_a', 1)).toBeUndefined()
  })

  it('⑪ 没有目标会话的槽时是空操作（不抛、返回 0）', () => {
    rememberImage('wxid_a', 1, fake(5))
    expect(keepOnlyImages('wxid_zzz')).toBe(1)
    expect(keepOnlyImages('wxid_zzz'), '第二次没有可释放的了').toBe(0)
  })
})