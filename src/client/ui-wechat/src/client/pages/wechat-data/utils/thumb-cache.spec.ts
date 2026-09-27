/**
 * 缩略图有界缓存（收藏与文件两处共用）的行为判据（#22 虚拟化的配套）。
 *
 * 核心只有一件事：**淘汰一条缩略图时，"这个 md5 已经请求过"的标记必须一起清掉**。
 * 少清一半的表现不是报错，而是「把列表滚远再滚回来，那几张图永远是个占位图标」——
 * 行卸载时值没了，重新挂载时因为标记还在而不再请求，于是再没有第二次机会。
 * 所以本文件除了正判据，还带一格「只清值不清标记」的退化实现自证（证明这条判据真的在承重）。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { THUMB_CACHE_LIMIT, rememberThumb, type ThumbCache } from './thumb-cache.ts'

const empty = (): ThumbCache => ({ thumbs: {}, order: [], fetched: new Set<string>() })
const url = (md5: string): string => 'data:image/png;base64,' + md5
/** 走一遍面板那边的真实顺序：先登记"已请求"，异步回来再写值。 */
const add = (s: ThumbCache, md5: string): ThumbCache => rememberThumb({ ...s, fetched: new Set([...s.fetched, md5]) }, md5, url(md5))

describe('rememberThumb', () => {
  it('写一条：值进 thumbs、顺序进 order 末尾、已请求标记保留', () => {
    const s = add(empty(), 'a')
    expect(s.thumbs.a).toBe(url('a'))
    expect(s.order).toEqual(['a'])
    expect(s.fetched.has('a')).toBe(true)
  })

  it('超过上界淘汰最旧的那条 —— 并且淘汰时把它的请求标记一起清掉（不成对就是"滚回来永远占位"）', () => {
    let s = empty()
    for (const m of ['a', 'b', 'c', 'd']) s = add(s, m)
    const capped = rememberThumb({ ...s, fetched: new Set([...s.fetched, 'e']) }, 'e', url('e'), 2)
    expect(Object.keys(capped.thumbs).sort()).toEqual(['d', 'e'])
    expect(capped.order).toEqual(['d', 'e'])
    // 被丢掉的两条必须能重新请求
    expect(capped.fetched.has('a'), '值清了但标记没清：这一行再挂载也拿不到图').toBe(false)
    expect(capped.fetched.has('b')).toBe(false)
    expect(capped.fetched.has('c')).toBe(false)
    expect(capped.fetched.has('e')).toBe(true)
  })

  it('刚写入的那条永不淘汰（哪怕上界是 1）', () => {
    const s = add(add(empty(), 'a'), 'b')
    const one = rememberThumb(s, 'c', url('c'), 1)
    expect(one.thumbs.c).toBe(url('c'))
    expect(one.order).toEqual(['c'])
  })

  it('重复写同一条把它挪到最新，order 里不留重复项（否则一次重复就把上界吃掉一格）', () => {
    let s = add(add(empty(), 'a'), 'b')
    s = rememberThumb(s, 'a', url('a'))
    expect(s.order).toEqual(['b', 'a'])
    expect(s.order.filter((k) => k === 'a')).toHaveLength(1)
  })

  it('md5 或 url 为空 ⇒ 原样返回（不写空缩略项，也不误清别人的标记）', () => {
    const s = add(empty(), 'a')
    expect(rememberThumb(s, '', url('x'))).toBe(s)
    expect(rememberThumb(s, 'b', '')).toBe(s)
  })

  it('默认上界够一屏来回滚不闪图（太小会边滚边丢）', () => {
    expect(THUMB_CACHE_LIMIT).toBeGreaterThanOrEqual(20)
  })

  it('反例自证：只清值不清标记的退化实现会让"滚回来重新请求"这条路断掉', () => {
    // 这就是把 rememberThumb 改坏一半之后的形状（`delete thumbs[old]` 留着、`fetched.delete(old)` 去掉）。
    const broken = (s: ThumbCache, md5: string, limit: number): ThumbCache => {
      const thumbs = { ...s.thumbs, [md5]: url(md5) }
      const order = [...s.order.filter((k) => k !== md5), md5]
      const fetched = new Set(s.fetched)
      while (order.length > limit) {
        const old = order.shift()
        if (!old || old === md5) continue
        delete thumbs[old]
      }
      return { thumbs, order, fetched }
    }
    const b = broken({ ...empty(), fetched: new Set(['a']) }, 'a', 1)
    const evicted = broken({ ...b, fetched: new Set([...b.fetched, 'b']) }, 'b', 1)
    expect(evicted.thumbs.a, '前提：a 的值确实被淘汰了').toBeUndefined()
    // 面板里的闸门是 `if (fetched.has(md5)) return` —— 标记还在就永远不会再发请求
    expect(evicted.fetched.has('a'), '退化实现把 a 的标记留下了（正判据要能分辨出这一类）').toBe(true)
    // 同一份输入喂给真实现：标记被一起清掉，于是那一行重新挂载时会再取一次
    const good = rememberThumb({ ...b, fetched: new Set([...b.fetched, 'b']) }, 'b', url('b'), 1)
    expect(good.thumbs.a).toBeUndefined()
    expect(good.fetched.has('a')).toBe(false)
  })
})
