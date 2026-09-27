/**
 * 朋友圈时间线的行算术与灯箱动作（#22 虚拟化时从面板里搬出来的那两族纯函数）。
 *
 * 值得钉的两件事：
 *  ① 摊平成行之后"日期标签也算一行" —— 组内顺序、空组、以及按 tid 找下标都不能错，
 *     错的症状是"滚到某天，那天的标题不见了"；
 *  ② 灯箱的**保存图片**与**复制链接**对同一个"当前这张图"要取不同的源
 *     （本机 data URL vs CDN 原链）。取反不会报错，只会存下打不开的图或复制出一串 base64。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { MomentItem } from '@deepseek-ai/dsh-wechat-data/types'
import { buildMomentRows, momentRowIndex, momentsEmptyText } from './moments-rows.ts'
import { imageDownloadName, pickImageSrc, toggleInSet } from './moments-actions.ts'

const m = (tid: string | number): MomentItem => ({ tid, createTime: 1700000000 } as unknown as MomentItem)

describe('buildMomentRows', () => {
  it('一天 = 一条日期行 + 该天每条动态各一行，顺序保持', () => {
    const rows = buildMomentRows([
      { day: '2026-09-01', items: [m(1), m(2)] },
      { day: '2026-08-31', items: [m(3)] },
    ])
    expect(rows.map((r) => (r.kind === 'day' ? 'D:' + r.day : 'M:' + String(r.m.tid)))).toEqual([
      'D:2026-09-01', 'M:1', 'M:2', 'D:2026-08-31', 'M:3',
    ])
  })

  it('空组一行都不产出（否则界面上会出现一个只有日期、下面什么都没有的悬空标题）', () => {
    expect(buildMomentRows([{ day: '2026-09-01', items: [] }])).toEqual([])
    expect(buildMomentRows([])).toEqual([])
  })

  it('按 tid 找行下标：找到的是那条动态的行号；tid 为空或 0 一律 -1（不许把所有"没 tid"的都命中第一行）', () => {
    const rows = buildMomentRows([{ day: 'd', items: [m(7), m(8)] }])
    expect(momentRowIndex(rows, 8)).toBe(2)
    expect(momentRowIndex(rows, '7')).toBe(1)
    expect(momentRowIndex(rows, 0)).toBe(-1)
    expect(momentRowIndex(rows, '')).toBe(-1)
    expect(momentRowIndex(rows, 999)).toBe(-1)
  })
})

describe('momentsEmptyText（口径必须与搬出前面板里那个 IIFE 一致）', () => {
  const base = { search: '', mediaFilter: 'all', monthFilter: null, mineFilter: 'all', authorFilter: null, dateFrom: '', dateTo: '', loaded: 0, total: 0 }
  it('什么都没筛 ⇒ 「暂无朋友圈动态」', () => {
    expect(momentsEmptyText(base)).toBe('暂无朋友圈动态')
  })
  it('只搜索且只加载了一部分 ⇒ 说清"已加载范围无匹配"（否则用户以为动态不存在）', () => {
    expect(momentsEmptyText({ ...base, search: '张三', loaded: 60, total: 900 }))
      .toBe('已加载范围无匹配（共 900 条，当前只加载了 60 条）')
  })
  it('搜索但已经全量加载 ⇒ 「无匹配动态」', () => {
    expect(momentsEmptyText({ ...base, search: '张三', loaded: 900, total: 900 })).toBe('无匹配动态')
  })
  it('搜索 + 还带别的筛选 ⇒ 不再提"已加载范围"（原口径如此，别自作主张改）', () => {
    expect(momentsEmptyText({ ...base, search: '张三', mediaFilter: 'image', loaded: 60, total: 900 })).toBe('无匹配动态')
  })
  it('没搜索但有筛选 ⇒ 「当前筛选无匹配动态」，日期区间也算筛选', () => {
    expect(momentsEmptyText({ ...base, monthFilter: '2026-09' })).toBe('当前筛选无匹配动态')
    expect(momentsEmptyText({ ...base, dateFrom: '2026-09-01' })).toBe('当前筛选无匹配动态')
    expect(momentsEmptyText({ ...base, authorFilter: 'wxid_a' })).toBe('当前筛选无匹配动态')
  })
})

describe('灯箱动作', () => {
  it('保存图片取本机解码那份、复制链接取 CDN 原链 —— 两个方向各自优先，另一个兜底', () => {
    expect(pickImageSrc('data:image/png;base64,AA', 'https://cdn/x.jpg', 'local')).toBe('data:image/png;base64,AA')
    expect(pickImageSrc('data:image/png;base64,AA', 'https://cdn/x.jpg', 'remote')).toBe('https://cdn/x.jpg')
    expect(pickImageSrc('', 'https://cdn/x.jpg', 'local')).toBe('https://cdn/x.jpg')
    expect(pickImageSrc('data:,', '', 'remote')).toBe('data:,')
    expect(pickImageSrc('', '', 'local')).toBe('')
  })

  it('下载文件名带序号与扩展名；序号为负/非数字退回 0（不给 NaN 那种文件名）', () => {
    expect(imageDownloadName(3, 'jpg')).toBe('moments-3.jpg')
    expect(imageDownloadName(0, 'png')).toBe('moments-0.png')
    expect(imageDownloadName(-2, 'jpg')).toBe('moments-0.jpg')
    expect(imageDownloadName(Number.NaN, 'jpg')).toBe('moments-0.jpg')
  })

  it('展开态翻转：没有就加、有就去掉，且不改原集合（React 拿同一份 Set 不会重渲染）', () => {
    const start = new Set(['a'])
    const added = toggleInSet(start, 'b')
    expect([...added].sort()).toEqual(['a', 'b'])
    expect([...start]).toEqual(['a'])
    const removed = toggleInSet(added, 'a')
    expect([...removed]).toEqual(['b'])
    expect(toggleInSet(removed, 'b').size).toBe(0)
  })
})
