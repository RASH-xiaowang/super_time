/**
 * 引用角标与详情面板的判据（2026-10-16 新增）。
 *
 * ## 为什么这些判据重要
 *
 * 用户的原话：「不要将引用内容显示在这个界面，以内容中右上角标出来即可，
 * 点击后然后精准跳转到详细信息窗口即可，聊条信息默认保留在窗口中充当上下文」。
 * 这条需求有三处**容易做错且不会报错**的地方：
 *   · 角标编号与来源下标**对不上**（模型写 `[3]`，点开却是第 2 条）——
 *     用户会以为「模型引错了」，而实际是界面错位；
 *   · 模型标了**不存在的编号**（`[99]`）—— 静默渲染成可点角标会让用户点了个空；
 *   · 详情面板**离开问答**（跳走）—— 那就丢了「聊天记录当上下文」这个前提。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { splitCiteMarks } from './AnswerBody.tsx'
import { citeTarget } from './cite-target.ts'

describe('正文引用角标：切分', () => {
  it('把 `[n]` 切成独立角标，其余是文本', () => {
    expect(splitCiteMarks('收到 240 笔[1]，另有[2]条')).toEqual([
      { kind: 'text', text: '收到 240 笔' },
      { kind: 'cite', n: 1 },
      { kind: 'text', text: '，另有' },
      { kind: 'cite', n: 2 },
      { kind: 'text', text: '条' },
    ])
  })

  it('连续角标切成多个（每个都要能单独点，合并成一个会让用户没法只点其中一个）', () => {
    expect(splitCiteMarks('[1][2][3]')).toEqual([
      { kind: 'cite', n: 1 },
      { kind: 'cite', n: 2 },
      { kind: 'cite', n: 3 },
    ])
  })

  it('没有角标时整段是文本', () => {
    expect(splitCiteMarks('没有引用')).toEqual([{ kind: 'text', text: '没有引用' }])
  })

  it('非数字方括号**不**当角标（猜错会把正文里的方括号变成假链接）', () => {
    expect(splitCiteMarks('见 [附录] 与 [abc]')).toEqual([{ kind: 'text', text: '见 [附录] 与 [abc]' }])
    // 逗号分隔的多引用也不认（模型被提示词约束成 `[n]` 单编号）
    expect(splitCiteMarks('[1,2]')).toEqual([{ kind: 'text', text: '[1,2]' }])
  })

  it('空串返回空数组（不产生空文本片段）', () => {
    expect(splitCiteMarks('')).toEqual([])
  })

  it('角标在开头/结尾都能切（不留空片段）', () => {
    expect(splitCiteMarks('[1]开头')).toEqual([{ kind: 'cite', n: 1 }, { kind: 'text', text: '开头' }])
    expect(splitCiteMarks('结尾[2]')).toEqual([{ kind: 'text', text: '结尾' }, { kind: 'cite', n: 2 }])
  })
})

describe('引用角标：编号与来源下标对齐', () => {
  it('`[n]` 对应 citations[n-1]（编号是 1 起，数组是 0 起）', () => {
    const citations = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]
    const pieces = splitCiteMarks('看[2]和[3]')
    const cites = pieces.filter(p => p.kind === 'cite')
    expect(cites.map(p => (p.kind === 'cite' ? citations[p.n - 1]?.name : null))).toEqual(['b', 'c'])
  })

  it('超出来源数的编号判为无效（渲染成不可点，而不是隐藏）', () => {
    const total = 2
    const pieces = splitCiteMarks('看[1]和[99]')
    const cites = pieces.filter(p => p.kind === 'cite')
    const valid = cites.map(p => (p.kind === 'cite' ? p.n >= 1 && p.n <= total : false))
    expect(valid).toEqual([true, false])
  })
})

describe('聚合来源不可跳转（它没有会话、没有发生时间）', () => {
  it('`source: agg` 返回 null（渲染成只读块，不骗点击）', () => {
    expect(citeTarget({ source: 'agg', username: '', local_id: 0 })).toBeNull()
    // 即使带了看似可用的 username 也不跳 —— 聚合事实不是某条原文
    expect(citeTarget({ source: 'agg', username: 'wxid_a', local_id: 5 })).toBeNull()
  })

  it('消息与知识库来源照常可跳（回归：加 agg 分支没影响这两类）', () => {
    expect(citeTarget({ source: 'msg', username: 'wxid_a', local_id: 5 }))
      .toEqual({ kind: 'msg', username: 'wxid_a', localId: 5 })
    expect(citeTarget({ source: 'kb', kb: { kbId: 1, fileId: 2 } }))
      .toEqual({ kind: 'kb', kbId: 1, fileId: 2 })
  })
})
