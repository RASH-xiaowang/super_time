// @vitest-environment node
/**
 * 工具结果的严格归一。
 *
 * 工具运行在不可信边界上：模型参数、旧插件、异常分支都可能返回「ok:true 但形状
 * 不对」的结果。这里的判据是：畸形条目逐条拒绝、整包如实降级；有可用证据时
 * 保留证据但标记 degraded，没有可用证据时直接 failed。
 */
import { describe, expect, it } from 'vitest'
import {
  buildEvidenceBundle,
  type EvidenceItem,
} from '../src/query/answer-runtime/evidence.ts'

const MESSAGE = {
  key: 'wxid_a:1',
  name: '项目组',
  time: '2026-10-20 10:00',
  snippet: '合同已经确认',
  source: 'msg',
}

describe('malformed hits', () => {
  it('缺 key / snippet 或 name / time 类型非法的命中全部拒绝', () => {
    const bundle = buildEvidenceBundle([{
      tool: 'search_messages',
      ok: true,
      hits: [
        { name: '缺少 key 与 snippet' },
        { key: '   ', name: '空白 key', time: '', snippet: '内容' },
        { key: 'wxid_a:2', name: '缺 snippet', time: '' },
        { key: 'wxid_a:3', name: 42, time: '', snippet: '内容' },
        { key: 'wxid_a:4', name: '非法时间', time: null, snippet: '内容' },
        'not-an-object',
      ],
      facts: [],
    }])

    expect(bundle.items).toEqual([])
    expect(bundle.facts).toEqual([])
    expect(bundle.status).toBe('failed')
    expect(bundle.assessment.sufficient).toBe(false)
    expect(bundle.stats.malformedHits).toBe(6)
    expect(bundle.stats.malformedResults).toBe(1)
    expect(bundle.stats.normalizationWarnings?.length).toBeGreaterThanOrEqual(6)
  })

  it('name / time 缺省补空串，非法 source 归一为 msg 并保留诊断', () => {
    const bundle = buildEvidenceBundle([{
      tool: 'search_messages',
      ok: true,
      hits: [{ key: 'wxid_a:1', snippet: '合同已经确认无误', source: 'unknown' }],
      facts: [],
    }])

    expect(bundle.items).toHaveLength(1)
    expect(bundle.items[0]).toMatchObject({ name: '', time: '', source: 'msg' })
    expect(bundle.status).toBe('ok')
    expect(bundle.stats.malformedHits).toBe(0)
    expect(bundle.stats.normalizationWarnings?.join('\n')).toContain('source')
  })
})

describe('malformed facts 与根字段', () => {
  it('facts 非数组、标题/正文类型非法或正文为空都拒绝', () => {
    const bundle = buildEvidenceBundle([{
      tool: 'aggregate_messages',
      ok: true,
      hits: [],
      facts: [
        { title: '正常', body: '统计可消费' },
        { title: '缺正文', body: '   ' },
        { title: 1, body: '标题类型错' },
        { title: '缺正文', body: null },
        'not-an-object',
      ],
    }, {
      tool: 'search_messages',
      ok: true,
      hits: [],
      facts: 'not-an-array',
    }])

    expect(bundle.facts).toEqual([{ title: '正常', body: '统计可消费' }])
    expect(bundle.status).toBe('degraded')
    expect(bundle.stats.malformedFacts).toBe(4)
    expect(bundle.stats.malformedResults).toBe(2)
  })

  it('缺 tool / ok、非对象结果不会被当成成功', () => {
    const bundle = buildEvidenceBundle([
      { ok: true, hits: [MESSAGE] },
      { tool: 'search_messages', hits: [MESSAGE] },
      { ok: 'true', tool: 'search_messages', hits: [MESSAGE] },
      null,
      'not-an-object',
    ])

    expect(bundle.items).toEqual([])
    expect(bundle.status).toBe('failed')
    expect(bundle.stats.malformedResults).toBe(5)
    expect(bundle.stats.successfulTools).toBe(0)
  })

  it('ok:true 但 hits/facts 容器缺失或类型错误视为畸形', () => {
    const bundle = buildEvidenceBundle([
      { tool: 'search_messages', ok: true, facts: [] },
      { tool: 'aggregate_messages', ok: true, hits: [], facts: {} },
    ])

    expect(bundle.items).toEqual([])
    expect(bundle.status).toBe('failed')
    expect(bundle.stats.malformedResults).toBe(2)
  })
})

describe('部分可用证据时的降级口径', () => {
  it('合法命中保留，畸形命中与畸形 fact 使整包 degraded', () => {
    const bundle = buildEvidenceBundle([{
      tool: 'search_messages',
      ok: true,
      hits: [MESSAGE, { key: '', snippet: '' }],
      facts: [{ title: '统计', body: '' }],
    }])

    expect(bundle.items.map(item => item.evidenceId)).toEqual(['msg:wxid_a:1'])
    expect(bundle.facts).toEqual([])
    expect(bundle.status).toBe('degraded')
    expect(bundle.assessment.sufficient).toBe(true)
    expect(bundle.stats.malformedHits).toBe(1)
    expect(bundle.stats.malformedFacts).toBe(1)
  })

  it('畸形结果叠加工具失败仍保留可用证据，失败来源进入 missing', () => {
    const bundle = buildEvidenceBundle([
      { tool: 'search_kb', ok: false, hits: [] },
      { tool: 'search_messages', ok: true, hits: [MESSAGE, null], facts: [] },
    ])

    expect(bundle.status).toBe('degraded')
    expect(bundle.items).toHaveLength(1)
    expect(bundle.missing).toContain('search_kb')
    expect(bundle.stats.failedTools).toEqual(['search_kb'])
    expect(bundle.stats.malformedHits).toBe(1)
  })
})

describe('聚合事实稳定键', () => {
  it('相同标题/正文合并，逆序输入得到相同 evidenceId', () => {
    const factA = { title: '按关键词统计', body: '含「转账」：5 条' }
    const factB = { title: '按会话统计', body: '项目组：3 条' }
    const forward = buildEvidenceBundle([
      { tool: 'aggregate_messages', ok: true, hits: [], facts: [factA, factB, factA] },
    ])
    const reverse = buildEvidenceBundle([
      { tool: 'aggregate_messages', ok: true, hits: [], facts: [factB, factA] },
    ])

    const ids = (items: readonly EvidenceItem[]): string[] => (
      items.filter(item => item.kind === 'fact').map(item => item.evidenceId).sort()
    )
    expect(ids(forward.items)).toHaveLength(2)
    expect(ids(forward.items)).toEqual(ids(reverse.items))
    expect(ids(forward.items)).toEqual([
      'agg:aggregate_messages:按会话统计',
      'agg:aggregate_messages:按关键词统计',
    ])
    expect(forward.stats.duplicateCount).toBe(1)
    expect(forward.facts).toHaveLength(2)
  })

  it('同标题不同正文获得不同且可复算的键，不依赖数组下标', () => {
    const facts = [
      { title: '按会话统计', body: '项目组：3 条' },
      { title: '按会话统计', body: '家人群：2 条' },
    ]
    const forward = buildEvidenceBundle([
      { tool: 'aggregate_messages', ok: true, hits: [], facts },
    ])
    const reverse = buildEvidenceBundle([
      { tool: 'aggregate_messages', ok: true, hits: [], facts: [...facts].reverse() },
    ])

    const keys = (bundle: typeof forward): string[] => (
      bundle.items.filter(item => item.kind === 'fact').map(item => item.key).sort()
    )
    expect(keys(forward)).toHaveLength(2)
    expect(keys(forward)).toEqual(keys(reverse))
    expect(keys(forward)[0]).toMatch(/^fact:aggregate_messages:按会话统计-[0-9a-f]{8}$/)
    expect(keys(forward)).not.toContain('fact:aggregate_messages:0')

    const locator = forward.items.find(item => item.kind === 'fact')?.locator
    expect(locator).toMatchObject({ type: 'fact', tool: 'aggregate_messages' })
    if (locator?.type === 'fact') {
      expect(locator.title).toBe('按会话统计')
      expect(locator.bodyDigest).toMatch(/^[0-9a-f]{8}$/)
      expect(locator.key).toBeTruthy()
    }
  })

  it('标题为空时退化为正文 slug，正文相同仍可合并', () => {
    const forward = buildEvidenceBundle([{
      tool: 'aggregate_messages',
      ok: true,
      hits: [],
      facts: [
        { title: '', body: 'Total: 5 items' },
        { title: '   ', body: 'Total: 5 items' },
      ],
    }])

    expect(forward.items).toHaveLength(1)
    expect(forward.items[0]?.evidenceId).toBe('agg:aggregate_messages:total-5-items')
    expect(forward.stats.duplicateCount).toBe(1)
  })
})
