/**
 * 知识库面板纯逻辑（`kb-model.ts`）的单测。
 *
 * 这些函数的共同风险是「看起来对、只在特定数据上错」，而没有任何运行期观测面：
 *   · `[[链接]]` 的解析口径若与后端 `notes.ts` 不一致 → 保存时判为同名、界面却解析不到，
 *     只在「多空格 / 大小写不同」的数据上复现；
 *   · `WIKI_RE` 是**带 lastIndex 的全局正则**，忘了复位会让第二次调用从上次位置续扫
 *     （后端同款注释记着这个坑，这里用「连调两次结果一致」钉死）；
 *   · `formatRelative` 的档位边界（刚刚 / 分钟 / 小时 / 天 / 日期）算错不会报错，
 *     只会让时间显示得莫名其妙；
 *   · `collectTags` 的排序若不确定，筛选条每次重载都会重排，用户刚点的那枚标签会跳位置。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  collectTags,
  countText,
  excerptOf,
  filterByTag,
  flattenWiki,
  formatDate,
  formatRelative,
  indexByTitle,
  linkRefs,
  normalizeTitleKey,
  segmentBody,
} from './kb-model.ts'

describe('normalizeTitleKey：与后端 normalizeTitle 同一把尺子', () => {
  it('去首尾空白 + 折叠内部连续空白 + 转小写', () => {
    expect(normalizeTitleKey('  项目组  ')).toBe('项目组')
    expect(normalizeTitleKey('Project   Plan')).toBe('project plan')
    expect(normalizeTitleKey('项目\t组\n计划')).toBe('项目 组 计划')
    expect(normalizeTitleKey('ABC')).toBe('abc')
  })

  it('空白输入返回空串（调用方据此跳过，而不是拿空键去匹配）', () => {
    expect(normalizeTitleKey('')).toBe('')
    expect(normalizeTitleKey('   ')).toBe('')
    expect(normalizeTitleKey('\t \n')).toBe('')
  })

  it('归一化后相同的写法必须得到同一个键（否则标题唯一性会漏判）', () => {
    expect(normalizeTitleKey('项目组')).toBe(normalizeTitleKey(' 项目组 '))
    expect(normalizeTitleKey('Project Plan')).toBe(normalizeTitleKey('project  plan'))
  })
})

describe('segmentBody：把正文切成「文本 / 链接」交替的片段', () => {
  it('无链接时整段是文本', () => {
    expect(segmentBody('就是一段普通正文')).toEqual([{ kind: 'text', text: '就是一段普通正文', target: '' }])
  })

  it('空正文返回空数组（不是含一个空文本片段的数组）', () => {
    expect(segmentBody('')).toEqual([])
  })

  it('[[目标]] 的目标与显示文本都是目标本身', () => {
    const segs = segmentBody('见 [[项目组]]')
    expect(segs).toEqual([
      { kind: 'text', text: '见 ', target: '' },
      { kind: 'link', text: '项目组', target: '项目组' },
    ])
  })

  it('[[目标|显示文本]] 的目标是竖线之前、显示是之后', () => {
    const segs = segmentBody('见 [[项目组|我们的组]] 那篇')
    expect(segs[1]).toEqual({ kind: 'link', text: '我们的组', target: '项目组' })
    expect(segs[2]).toEqual({ kind: 'text', text: ' 那篇', target: '' })
  })

  it('正文开头的链接不产生空的前导文本片段', () => {
    const segs = segmentBody('[[A]] 后面')
    expect(segs[0]).toEqual({ kind: 'link', text: 'A', target: 'A' })
  })

  it('一句话里多个链接按出现顺序切分', () => {
    const segs = segmentBody('[[A]] 和 [[B|乙]]')
    expect(segs.map(s => s.kind)).toEqual(['link', 'text', 'link'])
    expect(segs.filter(s => s.kind === 'link').map(s => s.target)).toEqual(['A', 'B'])
  })

  it('空目标（[[|x]]、[[   ]]）被跳过 —— 与后端 parseWikiLinks 一致', () => {
    expect(segmentBody('a[[|x]]b').map(s => s.kind)).toEqual(['text', 'text'])
    expect(segmentBody('a[[ ]]b').map(s => s.kind)).toEqual(['text', 'text'])
  })

  it('跨行不算链接（正则排除 \\n），未闭合的 [[ 原样留在文本里', () => {
    expect(segmentBody('[[A\nB]]')).toEqual([{ kind: 'text', text: '[[A\nB]]', target: '' }])
    expect(segmentBody('只有 [[ 开头')).toEqual([{ kind: 'text', text: '只有 [[ 开头', target: '' }])
  })

  it('全局正则的 lastIndex 被复位：连调两次结果必须一致', () => {
    // 忘了复位的话，第二次会从上次结束位置续扫，返回残缺结果 —— 这是后端同款坑。
    const body = '[[A]] 中间 [[B]] 结尾 [[C]]'
    const first = segmentBody(body)
    const second = segmentBody(body)
    expect(second).toEqual(first)
    expect(first.filter(s => s.kind === 'link')).toHaveLength(3)
  })
})

describe('flattenWiki / excerptOf：列表行摘要', () => {
  it('把 [[目标|显示]] 摊平成显示文本，并折叠空白', () => {
    expect(flattenWiki('见 [[项目组|我们的组]]\n\n  下一段')).toBe('见 我们的组 下一段')
  })

  it('摘要超长时截断并追加省略号', () => {
    const long = 'x'.repeat(200)
    const out = excerptOf(long, 10)
    expect(out).toBe('x'.repeat(10) + '…')
  })

  it('刚好等于上限时不加省略号', () => {
    expect(excerptOf('x'.repeat(10), 10)).toBe('x'.repeat(10))
  })

  it('摘要里不残留 [[ 标记', () => {
    expect(excerptOf('见 [[项目组|我们的组]]', 100)).toBe('见 我们的组')
    expect(excerptOf('见 [[项目组|我们的组]]', 100)).not.toContain('[[')
  })
})

describe('collectTags：标签计数与排序', () => {
  const notes = [
    { tags: ['项目', '交付'] },
    { tags: ['项目'] },
    { tags: ['项目', '  交付  ', ''] },
  ]

  it('按出现次数降序，同次数按名称升序（排序必须确定，否则筛选条会跳位）', () => {
    expect(collectTags(notes)).toEqual([
      { tag: '项目', count: 3 },
      { tag: '交付', count: 2 },
    ])
  })

  it('标签先 trim，空标签被丢弃', () => {
    const r = collectTags([{ tags: ['  a  ', '   ', ''] }])
    expect(r).toEqual([{ tag: 'a', count: 1 }])
  })

  it('同次数时按名称升序（locale 比较）', () => {
    expect(collectTags([{ tags: ['b'] }, { tags: ['a'] }]).map(t => t.tag)).toEqual(['a', 'b'])
  })

  it('没有条目时返回空数组', () => {
    expect(collectTags([])).toEqual([])
  })
})

describe('indexByTitle：把 [[链接]] 解析成可点跳转的目标', () => {
  it('键是归一化后的标题', () => {
    const idx = indexByTitle([{ id: 1, title: ' 项目 组 ' }])
    expect(idx.get('项目 组')?.id).toBe(1)
  })

  it('历史重复标题时按 id 升序取第一条（与后端 findIdByTitleKey 顺序扫描一致）', () => {
    const idx = indexByTitle([
      { id: 9, title: '同名' },
      { id: 3, title: '同名' },
      { id: 7, title: '同名' },
    ])
    // 传入顺序打乱也必须取 id 最小的那条，否则界面会跳到另一篇、看着像跳错了
    expect(idx.get('同名')?.id).toBe(3)
  })

  it('空白标题不入索引（避免空串键把一堆笔记指向同一条）', () => {
    const idx = indexByTitle([{ id: 1, title: '   ' }])
    expect(idx.size).toBe(0)
    expect(idx.get('')).toBeUndefined()
  })
})

describe('filterByTag：标签筛选', () => {
  const notes = [{ tags: ['a'] }, { tags: ['b'] }, { tags: [] }]

  it('null 表示全部（不复制数组，原样返回）', () => {
    expect(filterByTag(notes, null)).toBe(notes)
  })

  it('按标签精确匹配（不做归一化 —— 库里标签已经 trim 过）', () => {
    expect(filterByTag(notes, 'a')).toHaveLength(1)
    expect(filterByTag(notes, 'A')).toHaveLength(0)
    expect(filterByTag(notes, 'z')).toHaveLength(0)
  })
})

describe('linkRefs：详情页的链接清单', () => {
  const byTitle = new Map([
    ['项目组', { id: 5 }],
    ['项目 组', { id: 5 }],
  ])

  it('命中已有条目标注 noteId，未命中留给「待补」', () => {
    const refs = linkRefs('见 [[项目组]] 与 [[还没写的那篇]]', byTitle)
    expect(refs).toEqual([
      { target: '项目组', display: '项目组', noteId: 5 },
      { target: '还没写的那篇', display: '还没写的那篇' },
    ])
  })

  it('按归一化键去重，保留第一次出现的原始写法与显示文本', () => {
    const refs = linkRefs('[[项目组]] 又见 [[ 项目组 |另一个说法]]', byTitle)
    expect(refs).toHaveLength(1)
    expect(refs[0]).toEqual({ target: '项目组', display: '项目组', noteId: 5 })
  })

  it('大小写 / 多空格在归一化后指向同一条，不会重复列出', () => {
    const idx = new Map([['project plan', { id: 2 }]])
    const refs = linkRefs('[[Project Plan]] 与 [[project  plan]]', idx)
    expect(refs).toHaveLength(1)
    expect(refs[0]?.noteId).toBe(2)
  })

  it('保持正文出现顺序', () => {
    const refs = linkRefs('[[乙]] [[甲]]', new Map())
    expect(refs.map(r => r.target)).toEqual(['乙', '甲'])
  })

  it('无链接时返回空数组', () => {
    expect(linkRefs('没有链接的正文', byTitle)).toEqual([])
    expect(linkRefs('', byTitle)).toEqual([])
  })
})

describe('formatDate / formatRelative：时间显示', () => {
  it('formatDate 用本地时区的 YYYY-MM-DD 且补零', () => {
    // 用本地构造的 Date，避免断言依赖运行机器的时区
    expect(formatDate(new Date(2026, 8, 7, 12, 0, 0).getTime())).toBe('2026-09-07')
  })

  it('相对时间的档位边界', () => {
    const now = new Date(2026, 8, 17, 12, 0, 0).getTime()
    const t = (msAgo: number): string => formatRelative(now - msAgo, now)
    expect(t(0)).toBe('刚刚')
    expect(t(59_999)).toBe('刚刚')
    expect(t(60_000)).toBe('1 分钟前')
    expect(t(59 * 60_000)).toBe('59 分钟前')
    expect(t(60 * 60_000)).toBe('1 小时前')
    expect(t(23 * 3600_000)).toBe('23 小时前')
    expect(t(24 * 3600_000)).toBe('1 天前')
    expect(t(29 * 86400_000)).toBe('29 天前')
  })

  it('超过 30 天直接给日期（「97 天前」不如具体日期有用）', () => {
    const now = new Date(2026, 8, 17, 12, 0, 0).getTime()
    expect(formatRelative(now - 30 * 86400_000, now)).toBe(formatDate(now - 30 * 86400_000))
  })

  it('未来时间（时钟回拨）不显示成负数', () => {
    const now = new Date(2026, 8, 17, 12, 0, 0).getTime()
    expect(formatRelative(now + 3600_000, now)).toBe('刚刚')
  })

  it('非法时间戳返回占位符（而不是 Invalid Date 字符串）', () => {
    expect(formatRelative(0, Date.now())).toBe('—')
    expect(formatRelative(Number.NaN, Date.now())).toBe('—')
  })
})

describe('countText：列表计数文案', () => {
  it('未筛选时只说总数', () => {
    expect(countText(7, 7)).toBe('共 7 条')
    expect(countText(0, 0)).toBe('共 0 条')
  })

  it('筛选时同时给出筛出数与总数', () => {
    expect(countText(2, 7)).toBe('筛出 2 条 · 共 7 条')
    expect(countText(0, 7)).toBe('筛出 0 条 · 共 7 条')
  })
})
