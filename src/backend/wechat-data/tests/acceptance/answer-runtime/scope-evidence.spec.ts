// @vitest-environment node
/**
 * 证据键与异常状态的契约。
 *
 * 稳定 key 是“可溯源”的唯一支点：消息必须是 `username:local_id`，知识库必须是
 * `kb:<kbId>:<chunkId>`。这里调用生产代码里的唯一产出点 `citationDocKey()`，
 * 不在测试里手拼格式。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { citationDocKey } from '../../../src/query/retrieval/kb-channel.ts'
import { stripCitationMarkers } from '../../../src/query/grounding.ts'
import { loadEvidenceRuntime } from './runtime-adapter.ts'
import { cleanupAcceptanceScratch } from './helpers.ts'

afterAll(() => cleanupAcceptanceScratch())

describe('引用 evidence 的稳定 key', () => {
  it('消息引用映射为 username:local_id', () => {
    expect(citationDocKey({
      source: 'msg',
      username: 'wxid_a',
      local_id: 42,
    })).toBe('wxid_a:42')
  })

  it('知识库引用映射为 kb:<kbId>:<chunkId>，缺明细时返回空串而不是错配', () => {
    expect(citationDocKey({
      source: 'kb',
      username: 'kb:1:7',
      local_id: 0,
      kb: { kbId: 1, chunkId: 99 },
    })).toBe('kb:1:99')
    expect(citationDocKey({ source: 'kb', username: 'kb:1:7', local_id: 0 })).toBe('')
  })
})

describe('ClawBot 回复不携带 [n] 角标', () => {
  it('确定性清理覆盖单词、连续与带空格角标', () => {
    expect(stripCitationMarkers('收到 13.00 元 [1][2]，明天到账。'))
      .toBe('收到 13.00 元，明天到账。')
    expect(stripCitationMarkers('合同在 [7] 附件里。'))
      .toBe('合同在 附件里。')
    expect(stripCitationMarkers('没有角标的自然回复')).toBe('没有角标的自然回复')
  })
})

describe('证据包状态：空结果与失败不能伪装成成功', () => {
  it('空结果收敛为 insufficient/missing，且没有证据条目', async () => {
    const runtime = await loadEvidenceRuntime()
    expect(runtime, '缺少 answer-runtime/evidence.ts#buildEvidenceBundle').toBeDefined()
    if (!runtime) return

    const bundle = runtime.buildEvidenceBundle([
      { tool: 'search_messages', ok: true, hits: [], facts: [] },
    ])
    expect(bundle.items).toEqual([])
    expect(bundle.assessment.status).toBe('missing')
    expect(bundle.status).toBe('insufficient')
    expect(bundle.status).not.toBe('ok')
  })

  it('失败结果进入 failedTools/missing，不会变成空成功', async () => {
    const runtime = await loadEvidenceRuntime()
    if (!runtime) return

    const bundle = runtime.buildEvidenceBundle([
      { tool: 'search_messages', ok: false, error: '检索索引不存在', hits: [] },
      { tool: 'search_kb', ok: true, hits: [], facts: [] },
    ])
    expect(bundle.items).toEqual([])
    expect(bundle.stats.failedTools).toContain('search_messages')
    expect(bundle.missing).toContain('search_messages')
    expect(bundle.status).not.toBe('ok')
  })

  it('消息与知识库命中生成稳定 evidenceId，重复键会合并', async () => {
    const runtime = await loadEvidenceRuntime()
    if (!runtime) return

    const messageHit = {
      key: 'wxid_lisi:42',
      name: '李四',
      time: '2026-10-20 10:00',
      snippet: '合同已经确认',
      source: 'msg' as const,
    }
    const kbHit = {
      key: 'kb:1:99',
      name: '蓝鲸合同.md',
      time: '',
      snippet: '验收款 12000 元',
      source: 'kb' as const,
    }
    const bundle = runtime.buildEvidenceBundle([
      { tool: 'search_messages', ok: true, hits: [messageHit] },
      { tool: 'search_messages', ok: true, hits: [messageHit] },
      { tool: 'search_kb', ok: true, hits: [kbHit] },
    ])

    const ids = bundle.items.map(item => item.evidenceId)
    expect(ids).toContain('msg:wxid_lisi:42')
    expect(ids).toContain('kb:1:99')
    expect(new Set(ids).size).toBe(ids.length)

    const message = bundle.items.find(item => item.evidenceId === 'msg:wxid_lisi:42')
    expect(message?.locator).toMatchObject({
      type: 'message',
      username: 'wxid_lisi',
      localId: 42,
      key: 'wxid_lisi:42',
    })

    const kb = bundle.items.find(item => item.evidenceId === 'kb:1:99')
    expect(kb?.locator).toMatchObject({
      type: 'kb',
      kbId: 1,
      chunkId: 99,
      key: 'kb:1:99',
    })
  })

  it('畸形成功结果不得成为可引用证据，且整包判为 failed', async () => {
    const runtime = await loadEvidenceRuntime()
    if (!runtime) return

    const bundle = runtime.buildEvidenceBundle([
      {
        tool: 'search_messages',
        ok: true,
        hits: [{ name: '缺少 key 与 snippet' }],
        facts: 'not-an-array',
      },
    ])
    expect(bundle.items).toEqual([])
    expect(bundle.facts).toEqual([])
    expect(bundle.assessment.sufficient).toBe(false)
    expect(bundle.status).toBe('failed')
    const stats = bundle.stats as unknown as Record<string, unknown>
    expect(Number(stats['malformedHits'] ?? 0)).toBeGreaterThanOrEqual(1)
  })

  it('聚合事实使用与 index 无关的稳定键，不同内容不会互相覆盖', async () => {
    const runtime = await loadEvidenceRuntime()
    if (!runtime) return

    const facts = [
      { title: '按会话统计', body: '项目组：3 条' },
      { title: '按会话统计', body: '家人群：2 条' },
      { title: '按关键词统计', body: '含「转账」：5 条' },
    ]
    const first = runtime.buildEvidenceBundle([
      { tool: 'aggregate_messages', ok: true, hits: [], facts },
    ])
    const reversed = runtime.buildEvidenceBundle([
      { tool: 'aggregate_messages', ok: true, hits: [], facts: [...facts].reverse() },
    ])

    const ids = (bundle: typeof first): string[] => (
      bundle.items.filter(item => item.kind === 'fact').map(item => item.evidenceId).sort()
    )
    expect(ids(first)).toHaveLength(3)
    expect(ids(first)).not.toContain('agg:aggregate_messages:0')
    expect(ids(first)).not.toContain('agg:aggregate_messages:1')
    expect(ids(first)).not.toContain('agg:aggregate_messages:2')
    expect(ids(first)).toEqual(ids(reversed))
    expect(ids(first).every(id => id.startsWith('agg:aggregate_messages:'))).toBe(true)

    const byTitle = first.items.filter(item => item.kind === 'fact')
    expect(byTitle.map(item => item.key).sort()).toEqual(
      reversed.items.filter(item => item.kind === 'fact').map(item => item.key).sort(),
    )
    expect(byTitle[0]?.locator).toMatchObject({
      type: 'fact',
      tool: 'aggregate_messages',
    })
  })
})
