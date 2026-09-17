/**
 * 「非破坏性重新取数」的分页循环（`load-page-range.ts`）。
 *
 * 守的是一个会**让用户被弹回列表顶部**的缺陷：后台刷新（实时同步活跃期约每 10 秒
 * 一次 `dsh-wechat-data-updated`）如果用 `reset()`，它会同步清空 items ⇒ 列表被换成
 * 骨架屏 ⇒ 容器高度塌陷 ⇒ 浏览器把 scrollTop 钳到 0。修法是不动当前列表、按**已加载
 * 条数**重新取一遍再原位替换；只重取第一页同样会让高度骤降，所以范围必须覆盖 `want`。
 *
 * 本仓库没有 hook/DOM 测试环境，所以循环抽成纯函数在这里钉住。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { collectPageRange } from './load-page-range.ts'

/** 造一个按 offset/limit 切片的假数据源。 */
function source(total: number, pageSize: number) {
  const all = Array.from({ length: total }, (_, i) => i)
  const calls: Array<{ offset: number; limit: number }> = []
  const fetchPage = async (offset: number, limit: number): Promise<{ items: number[]; total: number }> => {
    calls.push({ offset, limit })
    return { items: all.slice(offset, offset + limit), total }
  }
  return { fetchPage, calls, pageSize }
}

describe('collectPageRange：按已加载条数重新取数', () => {
  it('覆盖 want 条所需的全部页（列表不会缩水）', async () => {
    const { fetchPage, calls } = source(1000, 200)
    const r = await collectPageRange<number>({ want: 600, pageSize: 200, maxPages: 16, fetchPage })
    expect(r.items.length).toBe(600)
    expect(r.items[0]).toBe(0)
    expect(r.items[599]).toBe(599)
    expect(r.stopped).toBe('covered')
    // 3 页：0-199 / 200-399 / 400-599
    expect(calls).toEqual([
      { offset: 0, limit: 200 },
      { offset: 200, limit: 200 },
      { offset: 400, limit: 200 },
    ])
  })

  it('want 不是页大小整数倍时也取满（不丢尾部）', async () => {
    const { fetchPage } = source(1000, 200)
    const r = await collectPageRange<number>({ want: 450, pageSize: 200, maxPages: 16, fetchPage })
    // 0-199 / 200-399 / 400-599 —— 第 3 页会多带 150 条（与 reset 后 loadMore 的语义一致）
    expect(r.items.length).toBe(600)
  })

  it('want 为 0（列表还没加载）时不发请求', async () => {
    const { fetchPage, calls } = source(100, 200)
    const r = await collectPageRange<number>({ want: 0, pageSize: 200, maxPages: 16, fetchPage })
    expect(calls.length).toBe(0)
    expect(r.items).toEqual([])
    expect(r.stopped).toBe('done')
  })

  it('want 为负数/NaN 时按 0 处理（不沿用 slice(0,-n) 那种笔误语义）', async () => {
    const { fetchPage, calls } = source(100, 200)
    for (const want of [-5, Number.NaN, -1, Number.NEGATIVE_INFINITY]) {
      const r = await collectPageRange<number>({ want, pageSize: 200, maxPages: 16, fetchPage })
      expect(r.items).toEqual([])
      expect(r.stopped).toBe('done')
    }
    expect(calls.length).toBe(0)
  })

  it('上界生效：want 很大时也只发 maxPages 个请求', async () => {
    const { fetchPage, calls } = source(100000, 200)
    const r = await collectPageRange<number>({ want: 99999, pageSize: 200, maxPages: 3, fetchPage })
    expect(calls.length).toBe(3)
    expect(r.items.length).toBe(600)
    expect(r.stopped).toBe('max-pages')
  })

  it('数据被取空时立即收工（收齐 total 即停，不空转、不谎报条数）', async () => {
    const { fetchPage, calls } = source(250, 200)
    const r = await collectPageRange<number>({ want: 1000, pageSize: 200, maxPages: 16, fetchPage })
    // 0-199 / 200-249 → 已收齐 total=250，收工（不会为了「确认到底」再多发一次空请求）
    expect(calls.length).toBe(2)
    expect(r.items.length).toBe(250)
    expect(r.stopped).toBe('exhausted')
  })

  it('want 恰好等于 total 时收齐即停', async () => {
    const { fetchPage, calls } = source(400, 200)
    const r = await collectPageRange<number>({ want: 400, pageSize: 200, maxPages: 16, fetchPage })
    expect(r.items.length).toBe(400)
    expect(calls.length).toBe(2)
    expect(r.stopped).toBe('exhausted')
  })

  it('数据变少时以「收齐」为准，不谎报条数', async () => {
    const { fetchPage } = source(150, 200)
    const r = await collectPageRange<number>({ want: 600, pageSize: 200, maxPages: 16, fetchPage })
    expect(r.items.length).toBe(150)
    expect(r.stopped).toBe('exhausted')
  })

  it('后端报告 total 偏大且末页为空时，靠空页收敛', async () => {
    // total 谎报 1000，实际只有 200 条：第 2 页返回空 ⇒ 必须停，不能一直发下去
    const all = Array.from({ length: 200 }, (_, i) => i)
    const calls: number[] = []
    const fetchPage = async (offset: number, limit: number): Promise<{ items: number[]; total: number }> => {
      calls.push(offset)
      return { items: all.slice(offset, offset + limit), total: 1000 }
    }
    const r = await collectPageRange<number>({ want: 800, pageSize: 200, maxPages: 16, fetchPage })
    expect(calls).toEqual([0, 200])
    expect(r.items.length).toBe(200)
    expect(r.stopped).toBe('empty-page')
  })

  it('onPage 返回 false 表示本轮作废：立即停止且交回空集（调用方会丢弃）', async () => {
    const { fetchPage, calls } = source(1000, 200)
    const r = await collectPageRange<number>({
      want: 600,
      pageSize: 200,
      maxPages: 16,
      fetchPage,
      onPage: (info) => info.offset < 200, // 第二页时作废
    })
    expect(r.stopped).toBe('cancelled')
    expect(calls.length).toBe(2)
    // 作废的一轮必须能识别出来 —— 调用方据此丢弃 r.items
    expect(r.items.length).toBe(200)
  })

  it('onPage 每页都收到 total（界面据此更新总计）', async () => {
    const { fetchPage } = source(1000, 200)
    const totals: number[] = []
    await collectPageRange<number>({
      want: 400,
      pageSize: 200,
      maxPages: 16,
      fetchPage,
      onPage: (info) => { totals.push(info.total) },
    })
    expect(totals).toEqual([1000, 1000])
  })

  it('pageSize 或 maxPages 非法时按「无事可做」处理，不抛错', async () => {
    const { fetchPage, calls } = source(100, 200)
    for (const plan of [
      { pageSize: 0, maxPages: 16 },
      { pageSize: -1, maxPages: 16 },
      { pageSize: Number.NaN, maxPages: 16 },
      { pageSize: 200, maxPages: 0 },
      { pageSize: 200, maxPages: -3 },
    ]) {
      const r = await collectPageRange<number>({ want: 500, fetchPage, ...plan })
      expect(r.stopped).toBe('invalid')
      expect(r.items).toEqual([])
    }
    expect(calls.length).toBe(0)
  })

  it('取数抛错时向上传播（由调用方置 error，不静默吞掉）', async () => {
    const boom = async (): Promise<{ items: number[]; total: number }> => { throw new Error('backend down') }
    await expect(collectPageRange<number>({ want: 200, pageSize: 200, maxPages: 16, fetchPage: boom }))
      .rejects.toThrow('backend down')
  })

  it('顺序保持：拼接结果的顺序与 reset+loadMore 完全一致', async () => {
    const { fetchPage } = source(2150, 200)
    const r = await collectPageRange<number>({ want: 600, pageSize: 200, maxPages: 16, fetchPage })
    expect(r.items).toEqual(Array.from({ length: 600 }, (_, i) => i))
  })
})
