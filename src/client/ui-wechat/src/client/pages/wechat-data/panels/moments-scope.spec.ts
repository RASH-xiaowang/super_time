// @vitest-environment jsdom
/**
 * `moments-scope.ts` 的行为与契约守卫（CODE-AUDIT-2026-09-26 第三批 #18）。
 *
 * ## 为什么这一份不是「拆完顺手补的测试」
 *
 * 拆之前那七段 memo 里有一个**真缺陷**：`scoped` 的函数体读 `dateScoped`，
 * 依赖数组却写 `[monthFiltered, sortOrder]` ⇒ 只改日期范围时列表**不动**
 * （`moments-panel.tsx:371`，改前）。没有任何用例覆盖过日期筛选，本仓又没装 eslint，
 * 所以这类「依赖数组漏一项」在这里没有自动防线。
 *
 * 三层各管一段：
 *  · **纯函数表**：八个条件逐个钉正反例（含「搜索命中的九个入口」与日期边界）；
 *  · **钩子行为**（jsdom 真渲染）：只改 `dateFrom` 必须换结果 —— 直接打在那个缺陷上；
 *    同时反向钉「值没变、只是对象换了身份」不许重算，否则「每项都进依赖」会被
 *    用「干脆不 memo」来骗过；
 *  · **AST 契约**：`MomentsCriteria` 每加一个字段，`scopeMoments` 那次 `useMemo`
 *    的依赖里就必须出现 `criteria.<字段>` —— 漏了当场红，不等人眼读。
 * @module moments-scope-spec
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MomentItem, MomentsMonthlySnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import {
  insightCounts,
  monthKeyOfSec,
  monthlyRows,
  scopeMoments,
  topAuthorRows,
  useMomentsScope,
  type MomentsCriteria,
} from './moments-scope.ts'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), 'moments-scope.ts')

/** 2026-09 那个月的三个时刻（秒级，与后端同单位）。 */
const T_SEP_EARLY = Math.floor(new Date('2026-09-03T08:00:00').getTime() / 1000)
const T_SEP_LATE = Math.floor(new Date('2026-09-21T20:30:00').getTime() / 1000)
const T_AUG = Math.floor(new Date('2026-08-15T12:00:00').getTime() / 1000)

function mk(over: Partial<MomentItem> & { tid: string }): MomentItem {
  return {
    username: 'wxid_' + over.tid,
    author: '张三',
    text: '',
    ts: T_SEP_EARLY,
    time: '',
    media_count: 0,
    media_desc: '',
    images: [],
    videos: [],
    location: '',
    link_title: '',
    is_self: false,
    likes: [],
    comments: [],
    ...over,
  }
}

/** 八个条件的「什么都不筛」基线。 */
const OPEN: MomentsCriteria = {
  search: '', media: 'all', author: null, mine: 'all', month: null,
  dateFrom: '', dateTo: '', order: 'desc',
}

const LIST: MomentItem[] = [
  mk({ tid: 'a', ts: T_SEP_EARLY, text: '今天去了南宁', location: '南宁青秀山' }),
  mk({
    tid: 'b',
    ts: T_SEP_LATE,
    author: '李四',
    link_title: '一篇关于湖的文章',
    link_url: 'https://example.com/pond',
    sourceNickName: '湖畔公众号',
    publicUserName: 'mp-hu-pan',
    images: [{ thumb: 't', url: 'u', key: 'k', md5: 'm' }],
    likes: [{ username: 'wxid_like', nickname: '爱点赞的人' }],
    comments: [{
      username: 'wxid_c',
      nickname: '评论者',
      to_username: '',
      to_nickname: '',
      content: '写得真好',
      ts: T_SEP_LATE,
    }],
  }),
  mk({
    tid: 'c',
    ts: T_AUG,
    author: '王五',
    is_self: true,
    videos: [{ url: 'v', thumb: 't', key: 'k', md5: 'm', duration: 3 }],
  }),
  mk({ tid: 'd', ts: T_AUG, contentType: 28, link_title: '一条视频号' }),
]

const tids = (rows: readonly MomentItem[]): string[] => rows.map((m) => m.tid)

describe('scopeMoments：八个条件逐个钉', () => {
  it('不设条件 ⇒ 原样全给，默认最新在前', () => {
    expect(tids(scopeMoments(LIST, OPEN))).toEqual(['b', 'a', 'c', 'd'])
    // c 与 d 同为 8-15：同 ts 保持原相对次序（V8 的 sort 稳定），这条把「稳定」钉成约定
    expect(tids(scopeMoments(LIST, { ...OPEN, order: 'asc' }))).toEqual(['c', 'd', 'a', 'b'])
  })

  it('order 只反转「时间不同」的那部分；时间相同的两个方向都保持原次序（sort 稳定）', () => {
    const desc = tids(scopeMoments(LIST, OPEN))
    const asc = tids(scopeMoments(LIST, { ...OPEN, order: 'asc' }))
    expect(desc).toEqual(['b', 'a', 'c', 'd'])
    expect(asc).toEqual(['c', 'd', 'a', 'b'])
    // c 与 d 同一天：稳定排序 ⇒ 两个方向都是 c 在 d 前（不是「完全倒过来」）
    expect(asc.indexOf('c')).toBeLessThan(asc.indexOf('d'))
    expect(desc.indexOf('c')).toBeLessThan(desc.indexOf('d'))
    // 非并列的那三对必须严格反序
    for (const [x, y] of [['b', 'a'], ['b', 'c'], ['a', 'c']] as Array<[string, string]>) {
      expect(desc.indexOf(x) < desc.indexOf(y), `${x} 比 ${y} 晚，降序里应在前面`).toBe(true)
      expect(asc.indexOf(x) > asc.indexOf(y), `${x} 比 ${y} 晚，升序里应在后面`).toBe(true)
    }
  })

  it('搜索的九个入口都通（链接标题/URL/公众号/点赞人/评论内容…）', () => {
    const hits: Array<[string, string]> = [
      ['张三', '作者'],
      ['南宁', '正文/地点'],
      ['湖的文章', '链接标题'],
      ['pond', '链接 URL'],
      ['湖畔公众号', 'sourceNickName'],
      ['mp-hu-pan', 'publicUserName'],
      ['评论者', '评论人 nickname'],
      ['写得真好', '评论内容'],
      ['爱点赞', '点赞人 nickname'],
    ]
    for (const [q, why] of hits) {
      expect(scopeMoments(LIST, { ...OPEN, search: q }).length, `${why} 应该能被搜到（关键词 ${q}）`)
        .toBeGreaterThan(0)
    }
  })

  it('点赞人/评论人只显示名时，username 是搜不到的（`nickname || username` 的短路口径）', () => {
    // 这条不是「顺便测一下」：它把既有的宽松边界钉住 —— 有人以后改成两个都试，这里会红，
    // 而那次改动必须同时说清为什么（否则搜索结果会突然多出按 wxid 命中的条目）。
    expect(scopeMoments(LIST, { ...OPEN, search: 'wxid_like' })).toHaveLength(0)
    expect(scopeMoments(LIST, { ...OPEN, search: 'wxid_c' })).toHaveLength(0)
  })

  it('搜不到就是空表（而不是「什么都不筛」）', () => {
    expect(scopeMoments(LIST, { ...OPEN, search: '这个词一定不存在zzz' })).toEqual([])
  })

  it('媒体那一档五种取值互不重叠', () => {
    expect(tids(scopeMoments(LIST, { ...OPEN, media: 'image' }))).toEqual(['b'])
    expect(tids(scopeMoments(LIST, { ...OPEN, media: 'video' }))).toEqual(['c'])
    expect(tids(scopeMoments(LIST, { ...OPEN, media: 'link' }))).toEqual(['b', 'd'])
    expect(tids(scopeMoments(LIST, { ...OPEN, media: 'location' }))).toEqual(['a'])
    expect(tids(scopeMoments(LIST, { ...OPEN, media: 'text' }))).toEqual(['a'])
    expect(tids(scopeMoments(LIST, { ...OPEN, media: 'all' }))).toHaveLength(4)
  })

  it('contentType=3 也算链接（报告口径里那两种都认）', () => {
    const only = [mk({ tid: 'ct3', contentType: 3, ts: T_SEP_EARLY })]
    expect(tids(scopeMoments(only, { ...OPEN, media: 'link' }))).toEqual(['ct3'])
  })

  it('作者精确匹配、只看我/只看他人互补', () => {
    expect(tids(scopeMoments(LIST, { ...OPEN, author: '李四' }))).toEqual(['b'])
    expect(tids(scopeMoments(LIST, { ...OPEN, author: '不存在的作者' }))).toEqual([])
    const mine = tids(scopeMoments(LIST, { ...OPEN, mine: 'mine' }))
    const others = tids(scopeMoments(LIST, { ...OPEN, mine: 'others' }))
    expect(mine).toEqual(['c'])
    expect([...mine, ...others].sort()).toEqual(tids(LIST).sort())
  })

  it('月份筛的是 YYYY-MM 键；ts=0 的条目在月份筛选下必须被排除', () => {
    expect(tids(scopeMoments(LIST, { ...OPEN, month: '2026-08' })).sort()).toEqual(['c', 'd'])
    const withZero = [...LIST, mk({ tid: 'zero', ts: 0 })]
    expect(tids(scopeMoments(withZero, { ...OPEN, month: '2026-09' }))).not.toContain('zero')
    // 不设月份时它仍然在（不许把「没有月份」当成「没有这条」）
    expect(tids(scopeMoments(withZero, OPEN))).toContain('zero')
  })

  it('日期范围两端都是闭区间，且界按本地时区的当天 00:00 / 23:59', () => {
    // a 是 9-03 08:00：`dateTo=9-03` 要到当天 23:59 才算完，所以它必须在
    expect(tids(scopeMoments(LIST, { ...OPEN, dateTo: '2026-09-03' })).sort()).toEqual(['a', 'c', 'd'])
    expect(tids(scopeMoments(LIST, { ...OPEN, dateTo: '2026-09-02' }).sort())).toEqual(['c', 'd'])
    expect(tids(scopeMoments(LIST, { ...OPEN, dateFrom: '2026-09-03' }))).toEqual(['b', 'a'])
    expect(tids(scopeMoments(LIST, { ...OPEN, dateFrom: '2026-09-04' }))).toEqual(['b'])
    const both = scopeMoments(LIST, { ...OPEN, dateFrom: '2026-08-15', dateTo: '2026-09-03' })
    expect(tids(both).sort()).toEqual(['a', 'c', 'd'])
    // 两端都不设 ⇒ 一条不筛（空串是「没有界」，不是「0 秒」）
    expect(scopeMoments(LIST, { ...OPEN, dateFrom: '', dateTo: '' })).toHaveLength(4)
  })

  it('只改日期范围也要改变结果（这一条就是改前那个缺陷）', () => {
    const before = tids(scopeMoments(LIST, OPEN))
    const after = tids(scopeMoments(LIST, { ...OPEN, dateFrom: '2026-09-20' }))
    expect(after).toEqual(['b'])
    expect(after).not.toEqual(before)
  })

  it('不改入参：条件里没写排序也可能触发 sort，必须是在拷贝上排', () => {
    const snapshot = tids(LIST)
    scopeMoments(LIST, { ...OPEN, order: 'asc' })
    expect(tids(LIST)).toEqual(snapshot)
  })

  it('八个条件同时生效 ⇒ 交集（不是最后一个说话）', () => {
    const r = scopeMoments(LIST, {
      search: '湖', media: 'link', author: null, mine: 'all', month: '2026-09',
      dateFrom: '', dateTo: '', order: 'desc',
    })
    expect(tids(r)).toEqual(['b'])
  })
})

describe('侧栏三张派生表', () => {
  it('insightCounts 走全量列表，不受筛选影响', () => {
    expect(insightCounts(LIST)).toEqual({ withImages: 1, withVideos: 1, withLocation: 1, withLink: 2 })
    expect(insightCounts([])).toEqual({ withImages: 0, withVideos: 0, withLocation: 0, withLink: 0 })
  })

  it('topAuthorRows：全量聚合优先，空/null 才退回已加载子集', () => {
    expect(topAuthorRows([{ name: '甲', count: 99 }], LIST)).toEqual([['甲', 99]])
    // 全量聚合说 99，已加载子集里根本没有这个人 ⇒ 说明用的是聚合口径而不是本地计数
    expect(topAuthorRows(null, LIST)).toEqual([['张三', 2], ['李四', 1], ['王五', 1]])
    expect(topAuthorRows([], LIST).length).toBe(3)
  })

  it('topAuthorRows 只给前 20，且按条数降序', () => {
    const many = Array.from({ length: 25 }, (_, i): MomentItem =>
      mk({ tid: 'x' + String(i), author: '作者' + String(i % 5), ts: T_SEP_EARLY }))
    const rows = topAuthorRows(null, many)
    expect(rows).toHaveLength(5)
    expect(rows.map((r) => r[1])).toEqual([...rows.map((r) => r[1])].sort((a, b) => b - a))
    expect(topAuthorRows(Array.from({ length: 30 }, (_, i) => ({ name: 'n' + String(i), count: 1 })), LIST))
      .toHaveLength(20)
  })

  it('monthlyRows：后端快照有值就用它（按月份升序），空了才自己数', () => {
    const snap: MomentsMonthlySnapshot = { months: [{ month: '2026-09', count: 7 }, { month: '2026-08', count: 3 }] }
    expect(monthlyRows(snap, null, LIST)).toEqual([
      { key: '2026-08', label: '2026-08', count: 3 },
      { key: '2026-09', label: '2026-09', count: 7 },
    ])
    // 回退口径也要认作者筛选：否则柱子与列表说的不是同一件事
    const fb = monthlyRows({ months: [] }, '李四', LIST)
    expect(fb).toEqual([{ key: '2026-09', label: '2026-09', count: 1 }])
    expect(monthlyRows({ months: [] }, null, LIST).map((r) => r.key)).toEqual(['2026-08', '2026-09'])
  })

  it('monthKeyOfSec 单位是秒（传毫秒会得到完全不同的年份，这条钉住不误用）', () => {
    expect(monthKeyOfSec(T_SEP_LATE)).toBe('2026-09')
    expect(monthKeyOfSec(T_SEP_LATE * 1000)).not.toBe('2026-09')
  })
})

/* ── 钩子行为（真渲染，jsdom） ─────────────────────────────────────────── */

let host: HTMLDivElement
let root: Root
let last: ReturnType<typeof useMomentsScope> | null = null

function Harness(props: { criteria: MomentsCriteria }): React.JSX.Element {
  last = useMomentsScope({
    moments: LIST,
    criteria: props.criteria,
    fullAuthors: null,
    monthlySnap: { months: [] },
    monthlySnapForAuthor: { months: [] },
  })
  return createElement('div', { 'data-count': String(last.scoped.length) })
}

const render = (criteria: MomentsCriteria): void => {
  act(() => { root.render(createElement(Harness, { criteria })) })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  last = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  root.unmount()
  host.remove()
})

describe('useMomentsScope：漏依赖这一类缺陷必须被真渲染抓到', () => {
  it('渲染本身是有效的（否则下面两条是空转）', () => {
    render(OPEN)
    expect(last, '钩子没跑起来').not.toBeNull()
    expect(host.firstElementChild?.getAttribute('data-count')).toBe('4')
  })

  it('只改 dateFrom 就要重算（改前不会，这就是那个缺陷）', () => {
    render(OPEN)
    expect(last?.scoped.map((m) => m.tid)).toEqual(['b', 'a', 'c', 'd'])
    render({ ...OPEN, dateFrom: '2026-09-20' })
    expect(last?.scoped.map((m) => m.tid)).toEqual(['b'])
    render({ ...OPEN, dateFrom: '2026-08-01', dateTo: '2026-08-31' })
    expect(last?.scoped.map((m) => m.tid).sort()).toEqual(['c', 'd'])
  })

  it('值没变、只是 criteria 换了对象身份 ⇒ 不许重算（挡住「干脆不 memo」这条路）', () => {
    render(OPEN)
    const first = last?.scoped
    render({ ...OPEN })
    expect(last?.scoped, 'criteria 身份变了就重算 ⇒ 等于没有 memo').toBe(first)
    // 反面对照：值真的变了就必须是新数组
    render({ ...OPEN, dateFrom: '2026-09-20' })
    expect(last?.scoped).not.toBe(first)
  })
})

/* ── AST 契约：字段与依赖数组必须一一对应 ───────────────────────────────── */

/**
 * 从源码里抽出「`MomentsCriteria` 的字段清单」与「调用 `scopeMoments` 那次 `useMemo` 的依赖」。
 * @param code - 源码文本。
 * @param label - 报错时用的文件名。
 * @returns 字段名与依赖项；找不到形状时返回 null（由判据把它当失败，不当成通过）。
 */
function criteriaFieldsAndDeps(code: string, label: string): { fields: string[]; deps: string[] | null } | null {
  const sf = ts.createSourceFile(label, code.replace(/\r\n/g, '\n'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const fields: string[] = []
  let deps: string[] | null = null
  const walk = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'MomentsCriteria') {
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.name) fields.push(member.name.getText(sf))
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useMemo'
      && node.arguments.some((a) => a.getText(sf).includes('scopeMoments('))) {
      const arr = node.arguments[1]
      if (arr && ts.isArrayLiteralExpression(arr)) deps = arr.elements.map((e) => e.getText(sf))
    }
    ts.forEachChild(node, walk)
  }
  walk(sf)
  return fields.length > 0 ? { fields, deps } : null
}

describe('接线：面板必须走这一层，不许把筛选再内联回去', () => {
  const panel = readFileSync(join(dirname(SRC), 'moments-panel.tsx'), 'utf8')
  /**
   * 只属于**筛选**那一层的实现痕迹。
   * 刻意不放 `T00:00:00` 之类：导出日期范围也要它，那是另一件事（面板里合法存在）。
   */
  const TRACES = ['.toLowerCase().includes(', "padStart(2, '0')", "case 'image'"]

  it('面板真的在用 useMomentsScope（不是又写了一遍）', () => {
    expect(panel).toContain('useMomentsScope')
    for (const t of TRACES) {
      expect(panel, `筛选实现痕迹「${t}」又回到面板里了`).not.toContain(t)
      // 反例自证的对称面：这些痕迹确实属于本层（否则「面板里没有」是空话）
      expect(readFileSync(SRC, 'utf8'), `本层里也找不到「${t}」⇒ 上面那条判据的对象是编的`).toContain(t)
    }
  })

  it('面板里 criteria 八个字段一个都不能少', () => {
    const fields = criteriaFieldsAndDeps(readFileSync(SRC, 'utf8'), 'moments-scope.ts')?.fields ?? []
    expect(fields.length).toBeGreaterThanOrEqual(8)
    // 从 `criteria: {` 往后找收尾锚点：`fullAuthors` 也出现在上面的 state 声明里，
    // 从 0 开始找会得到一个**反向**区间（slice 出来是空串 ⇒ 八条断言全部空转）。
    const from = panel.indexOf('criteria: {')
    expect(from, '面板里找不到 criteria 块 ⇒ 这条判据在空转').toBeGreaterThan(0)
    const block = panel.slice(from, panel.indexOf('fullAuthors,', from))
    for (const f of fields) {
      // 显式 `字段: 值` 或同名简写都算接上了
      const wired = block.includes(f + ':') || new RegExp('^\\s*' + f + ',\\s*$', 'm').test(block)
      expect(wired, `criteria 少了 ${f} ⇒ 那个筛选条件在界面上已经失效`).toBe(true)
    }
  })
})

describe('契约：criteria 的每个字段都必须出现在 scopeMoments 的依赖里', () => {
  const shape = criteriaFieldsAndDeps(readFileSync(SRC, 'utf8'), 'moments-scope.ts')

  it('形状找得到（找不到 ⇒ 这条判据是恒真）', () => {
    expect(shape, '读不到 MomentsCriteria 字段清单 ⇒ 判据失明').not.toBeNull()
    expect(shape?.deps, '找不到调用 scopeMoments 的 useMemo ⇒ 判据失明').not.toBeNull()
    expect(shape?.fields.length).toBeGreaterThanOrEqual(8)
  })

  it('逐字段对齐', () => {
    const need = ['moments', ...(shape?.fields ?? []).map((f) => `criteria.${f}`)]
    expect([...(shape?.deps ?? [])].sort()).toEqual(need.sort())
  })

  it('反例自证：把 dateFrom 从依赖里抹掉，判据必须报出来', () => {
    const broken = readFileSync(SRC, 'utf8').replace('criteria.dateFrom,', '')
    const s = criteriaFieldsAndDeps(broken, 'broken.ts')
    expect(s).not.toBeNull()
    const need = ['moments', ...(s?.fields ?? []).map((f) => `criteria.${f}`)]
    expect(s?.deps ?? [], '抹掉一项还能对齐 ⇒ 上面那条是空转').not.toEqual(need)
  })
})
