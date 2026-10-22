// @vitest-environment node
/**
 * answer-runtime 基础层的离线判据。
 *
 * 这三个模块的错误形态都是「不报错、只是结果不对」：
 *   · 参数没归一化 → 工具静默查空；
 *   · 错误分类错 → 不该重试的重复执行，或该重试的直接失败；
 *   · 证据没收敛 → 重复片段撑爆上下文、引用与原文对不上。
 */
import { describe, expect, it } from 'vitest'
import {
  normalizeToolArguments,
  parseDateExpression,
  repairToolArguments,
  type ArgumentNormalizationContext,
} from '../src/query/answer-runtime/arguments.ts'
import {
  classifyToolError,
  classifyToolErrorDetailed,
} from '../src/query/answer-runtime/errors.ts'
import {
  buildEvidenceBundle,
  type EvidenceItem,
} from '../src/query/answer-runtime/evidence.ts'
import type { ToolResult } from '../src/query/tools/types.ts'

const NOW = new Date(2026, 9, 22, 10, 30, 0)

describe('arguments：日期解析', () => {
  it('支持今天/昨天、周范围与月范围', () => {
    expect(parseDateExpression('今天', NOW)).toMatchObject({
      from: '2026-10-22',
      to: '2026-10-22',
    })
    expect(parseDateExpression('昨天', NOW)).toMatchObject({
      from: '2026-10-21',
      to: '2026-10-21',
    })
    // 2026-10-22 是周四；本周从周一 10-19 到今天，上周是完整一周。
    expect(parseDateExpression('本周', NOW)).toMatchObject({
      from: '2026-10-19',
      to: '2026-10-22',
    })
    expect(parseDateExpression('上周', NOW)).toMatchObject({
      from: '2026-10-12',
      to: '2026-10-18',
    })
    expect(parseDateExpression('上个月', NOW)).toMatchObject({
      from: '2026-09-01',
      to: '2026-09-30',
    })
  })

  it('支持绝对日期、中文日期与「上周三」', () => {
    expect(parseDateExpression('2026-10-03', NOW)).toMatchObject({
      from: '2026-10-03',
      to: '2026-10-03',
    })
    expect(parseDateExpression('2026年10月3日', NOW)).toMatchObject({
      from: '2026-10-03',
    })
    expect(parseDateExpression('二〇二六年十月三日', NOW)).toMatchObject({
      from: '2026-10-03',
    })
    expect(parseDateExpression('10月3日', NOW)).toMatchObject({
      from: '2026-10-03',
    })
    expect(parseDateExpression('上周三', NOW)).toMatchObject({
      from: '2026-10-14',
      to: '2026-10-14',
    })
  })

  it('不存在的日期不会被规范化成一个看似合法的日期', () => {
    expect(parseDateExpression('2026-02-30', NOW)).toBeUndefined()
    expect(parseDateExpression('星期一', NOW)).toBeUndefined()
  })
})

describe('arguments：不可信输入与 schema 纠偏', () => {
  it('null / 数字 / 数组根参数返回结构化错误而不是抛错', () => {
    const nil = repairToolArguments('search_messages', null, { now: NOW })
    expect(nil.ok).toBe(false)
    expect(nil.field).toBe('keywords')
    expect(nil.error).toContain('keywords')

    for (const bad of [123, ['转账'], '转账']) {
      const r = repairToolArguments('search_messages', bad, { now: NOW })
      expect(r.ok, JSON.stringify(bad)).toBe(false)
      expect(r.field).toBe('$')
      expect(r.error).toContain('对象')
    }
  })

  it('对象参数可执行；对象形式的 keywords 不会被隐式转换成合法数组', () => {
    const ok = repairToolArguments('search_messages', { keywords: ['转账'] }, { now: NOW })
    expect(ok.ok).toBe(true)
    expect(ok.args['keywords']).toEqual(['转账'])

    const bad = repairToolArguments(
      'search_messages',
      { keywords: { value: '转账' } },
      { now: NOW },
    )
    expect(bad.ok).toBe(false)
    expect(bad.field).toBe('keywords')
  })

  it('枚举别名会纠正为 schema 值并留下可读说明', () => {
    const r = repairToolArguments(
      'list_sessions',
      { orderBy: '按消息数', kind: '群聊', limit: 999 },
      { now: NOW },
    )
    expect(r.ok).toBe(true)
    expect(r.args['orderBy']).toBe('count')
    expect(r.args['kind']).toBe('group')
    expect(r.args['limit']).toBe(100)
    expect(r.repairs.join('\n')).toContain('orderBy')
    expect(r.repairs.join('\n')).toContain('上限')

    const bad = repairToolArguments('list_sessions', { kind: '朋友圈' }, { now: NOW })
    expect(bad.ok).toBe(false)
    expect(bad.field).toBe('kind')
  })

  it('limit 会被钳制，数字字符串与小数会被修复', () => {
    const r = repairToolArguments(
      'get_message_context',
      { key: 'wxid_a:123', spanMinutes: '45.9', maxMessages: 0 },
      { now: NOW },
    )
    expect(r.ok).toBe(true)
    expect(r.args['spanMinutes']).toBe(45)
    expect(r.args['maxMessages']).toBe(1)
    expect(r.repairs.join('\n')).toContain('取整')
    expect(r.repairs.join('\n')).toContain('下限')
  })

  it('相对日期会展开成 from/to；起止颠倒会交换', () => {
    const relative = repairToolArguments(
      'search_messages',
      { keywords: ['转账'], from: '上周' },
      { now: NOW },
    )
    expect(relative.ok).toBe(true)
    expect(relative.args['from']).toBe('2026-10-12')
    expect(relative.args['to']).toBe('2026-10-18')

    const swapped = repairToolArguments(
      'search_messages',
      { keywords: ['合同'], from: '2026-10-20', to: '2026-10-01' },
      { now: NOW },
    )
    expect(swapped.ok).toBe(true)
    expect(swapped.args['from']).toBe('2026-10-01')
    expect(swapped.args['to']).toBe('2026-10-20')
    expect(swapped.repairs.join('\n')).toContain('交换')
  })

  it('forcedScope 无条件覆盖模型给的会话，并可用于补齐缺失参数', () => {
    const overridden = repairToolArguments(
      'get_session_messages',
      { username: 'wxid_other' },
      { now: NOW, forcedScope: { username: '123@chatroom' } },
    )
    expect(overridden.ok).toBe(true)
    expect(overridden.args['username']).toBe('123@chatroom')
    expect(overridden.repairs.join('\n')).toContain('强制')

    const filled = repairToolArguments(
      'get_session_messages',
      null,
      { now: NOW, forcedScope: { username: '123@chatroom' } },
    )
    expect(filled.ok).toBe(true)
    expect(filled.args['username']).toBe('123@chatroom')
  })

  it('显式 resolver 可以把显示名解析成 username', () => {
    const context: ArgumentNormalizationContext = {
      decryptedDir: '',
      now: NOW,
      resolveArgumentEntity: (value, kind) => (
        value === '项目组' && kind === 'session'
          ? { status: 'resolved', entity: { username: '123@chatroom', name: '项目组' } }
          : { status: 'not_found' }
      ),
    }
    const r = normalizeToolArguments(
      {
        name: 'get_session_messages',
        parameters: {
          type: 'object',
          properties: { username: { type: 'string' } },
          required: ['username'],
        },
      },
      { username: '项目组' },
      context,
      { now: NOW },
    )
    expect(r.ok).toBe(true)
    expect(r.args['username']).toBe('123@chatroom')
    expect(r.fixes.some(fix => fix.code === 'entity_resolved')).toBe(true)
  })

  it('包裹引号的会话显示名通过结构化目录映射到真实 username', () => {
    const r = repairToolArguments(
      'get_session_messages',
      { username: '「z_卖酒」' },
      {
        now: NOW,
        knownSessionCatalog: [
          { username: 'wxid_sellwine', name: 'z_卖酒' },
        ],
      },
    )

    expect(r.ok).toBe(true)
    expect(r.args['username']).toBe('wxid_sellwine')
    const repairs = r.repairs.join('\n')
    expect(repairs).toContain('已去除包裹引号')
    expect(repairs).toContain('会话名「z_卖酒」→ wxid_sellwine')
  })

  it('未知字段保持原样，避免误删 runtime 注入的内部字段', () => {
    const r = repairToolArguments(
      'search_messages',
      { keywords: ['转账'], requestId: 'trace-1' },
      { now: NOW },
    )
    expect(r.ok).toBe(true)
    expect(r.args['requestId']).toBe('trace-1')
  })
})

describe('errors：分类与安全重试', () => {
  it('参数错误 / 找不到 / 未授权 / 范围越界都不可重试', () => {
    for (const [input, cls] of [
      ['缺少 keywords', 'invalid_arguments'],
      ['没有这个工具：no_such_tool', 'not_found'],
      ['当前没有选中知识库', 'not_found'],
      ['未授权访问', 'unauthorized'],
      ['kb-only 已阻止访问本机微信数据', 'scope_blocked'],
      ['文件检索不支持按会话过滤（无法应用范围）', 'scope_blocked'],
    ] as const) {
      const r = classifyToolError(input, 'search_messages')
      expect(r.cls).toBe(cls)
      expect(r.retryable).toBe(false)
      expect(r.maxAttempts).toBe(1)
    }
  })

  it('超时/限流/瞬时故障允许有界重试', () => {
    const timeout = classifyToolError(new Error('ETIMEDOUT'), 'search_kb')
    expect(timeout).toMatchObject({ cls: 'timeout', retryable: true, maxAttempts: 2 })

    const limited = classifyToolError({ status: 429, message: 'too many requests' }, 'search_kb')
    expect(limited).toMatchObject({ cls: 'rate_limited', retryable: true, maxAttempts: 2 })

    const transient = classifyToolError({ code: 'SQLITE_BUSY', message: 'database is locked' }, 'search_messages')
    expect(transient).toMatchObject({ cls: 'transient', retryable: true, maxAttempts: 3 })
  })

  it('有副作用的工具即使错误可重试也不自动重放', () => {
    const r = classifyToolError('timeout', {
      tool: 'send_message',
      sideEffect: true,
    })
    expect(r.cls).toBe('timeout')
    expect(r.retryable).toBe(false)
    expect(r.maxAttempts).toBe(1)
  })

  it('未知错误收敛为 internal，且保留 Retry-After 诊断', () => {
    const r = classifyToolErrorDetailed(
      { message: 'boom', retryAfterSec: 3 },
      { tool: 'search_messages' },
    )
    expect(r.cls).toBe('internal')
    expect(r.retryable).toBe(false)
    expect(r.maxAttempts).toBe(1)
    expect(r.retryAfterMs).toBe(3000)
  })
})

describe('evidence：统一 ID、去重与预算', () => {
  function result(
    tool: ToolResult['tool'],
    hits: ToolResult['hits'],
    facts?: ToolResult['facts'],
  ): ToolResult {
    return { tool, ok: true, hits, ...(facts ? { facts } : {}) }
  }

  it('消息 / 知识库 / 聚合事实使用稳定 evidenceId', () => {
    const bundle = buildEvidenceBundle([
      result('search_messages', [{
        key: 'wxid_a:12',
        name: '房东',
        time: '2026-10-20 10:00',
        snippet: '微信转账 3500 元',
        source: 'msg',
      }]),
      result('search_kb', [{
        key: 'kb:7:42',
        name: '合同.pdf',
        time: '',
        snippet: '付款周期为 30 天',
        source: 'kb',
        score: 0.8,
      }]),
      result('aggregate_messages', [], [{ title: '按关键词统计', body: '含「转账」：2 条' }]),
    ])

    expect(bundle.items.map(item => item.evidenceId)).toEqual(expect.arrayContaining([
      'msg:wxid_a:12',
      'kb:7:42',
      'agg:aggregate_messages:按关键词统计',
    ]))
    expect(bundle.status).toBe('ok')
    expect(bundle.stats).toMatchObject({ count: 3, messages: 1, kb: 1, sessions: 1 })
    expect(bundle.facts).toEqual([{ title: '按关键词统计', body: '含「转账」：2 条' }])

    const message = bundle.items.find(item => item.evidenceId === 'msg:wxid_a:12')
    expect(message).toMatchObject({
      key: 'wxid_a:12',
      locator: { type: 'message', username: 'wxid_a', localId: 12 },
    })
    expect(message?.citation).toMatchObject({ username: 'wxid_a', local_id: 12, source: 'msg' })
  })

  it('同一消息被多个工具召回时只保留一条，并合并工具与较长片段', () => {
    const bundle = buildEvidenceBundle([
      result('search_messages', [{
        key: '123@chatroom:9',
        name: '项目组',
        time: '2026-10-21 09:00',
        snippet: '合同模板我改好了',
        sender: '李四',
        source: 'msg',
      }]),
      result('search_semantic', [{
        key: '123@chatroom:9',
        name: '项目组',
        time: '2026-10-21 09:00',
        snippet: '合同模板我改好了，差额字段单独列出来',
        sender: '李四',
        source: 'msg',
        score: 0.9,
      }]),
    ])
    expect(bundle.items).toHaveLength(1)
    expect(bundle.items[0]).toMatchObject({
      evidenceId: 'msg:123@chatroom:9',
      snippet: '合同模板我改好了，差额字段单独列出来',
      tools: ['search_messages', 'search_semantic'],
      sender: '李四',
    })
    expect(bundle.stats.duplicateCount).toBe(1)
  })

  it('按条数预算截断时保留高分证据，其余计入 droppedByBudget', () => {
    const bundle = buildEvidenceBundle([
      result('search_semantic', [{
        key: 'wxid_a:1', name: 'A', time: '2026-10-01 10:00', snippet: '合同内容低分', source: 'msg', score: 0.1,
      }]),
      result('search_semantic', [{
        key: 'wxid_a:2', name: 'A', time: '2026-10-02 10:00', snippet: '合同内容高分', source: 'msg', score: 0.9,
      }]),
      result('search_semantic', [{
        key: 'wxid_a:3', name: 'A', time: '2026-10-03 10:00', snippet: '合同内容中分', source: 'msg', score: 0.5,
      }]),
    ], { maxItems: 2 })
    expect(bundle.items.map(item => item.evidenceId)).toEqual(['msg:wxid_a:2', 'msg:wxid_a:3'])
    expect(bundle.stats.droppedByBudget).toBe(1)
  })

  it('字符预算会截断片段而不是让整包超限', () => {
    const bundle = buildEvidenceBundle([
      result('search_messages', [{
        key: 'wxid_a:1',
        name: 'A',
        time: '2026-10-01 10:00',
        snippet: 'abcdefghij',
        source: 'msg',
      }]),
    ], { maxChars: 5 })
    expect(bundle.items[0]?.snippet).toBe('abcd…')
    expect(bundle.items[0]?.truncated).toBe(true)
    expect(bundle.stats.truncated).toBe(true)
    expect(bundle.stats.snippetChars).toBe(5)
  })

  it('空结果 / 全部失败 / 部分失败给出不同状态与 missing', () => {
    const empty = buildEvidenceBundle([])
    expect(empty.status).toBe('insufficient')
    expect(empty.missing).toEqual(['evidence'])

    const failed = buildEvidenceBundle([
      { tool: 'search_kb', ok: false, error: '索引不存在', hits: [] },
    ])
    expect(failed.status).toBe('failed')
    expect(failed.missing).toEqual(['evidence', 'search_kb'])

    const degraded = buildEvidenceBundle([
      result('search_messages', [{
        key: 'wxid_a:1', name: 'A', time: '2026-10-01 10:00', snippet: '合同已经确认', source: 'msg',
      }]),
      { tool: 'search_kb', ok: false, error: '索引不存在', hits: [] },
    ])
    expect(degraded.status).toBe('degraded')
    expect(degraded.missing).toEqual(['search_kb'])
  })

  it('证据 ID 不随工具结果顺序变化', () => {
    const a = result('search_messages', [{
      key: 'wxid_a:1', name: 'A', time: '', snippet: '完整消息片段', source: 'msg',
    }])
    const b = result('search_kb', [{
      key: 'kb:1:2', name: 'B', time: '', snippet: '完整知识库片段', source: 'kb',
    }])
    const ids = (rows: readonly unknown[]): string[] => (
      buildEvidenceBundle(rows).items.map((item: EvidenceItem) => item.evidenceId)
    )
    expect(ids([a, b])).toEqual(ids([b, a]))
  })

  it('search_hybrid 的消息命中仍计入 messages；资源单独计数且不伪造 AskCitation', () => {
    const bundle = buildEvidenceBundle([
      result('search_hybrid', [{
        key: 'wxid_b:5',
        name: '房东',
        time: '2026-10-21 10:00',
        snippet: '房租转你了',
        source: 'msg',
      }]),
      result('search_files', [{
        key: 'file:合同.pdf:0',
        name: '合同.pdf',
        time: '2026-10-20 09:00',
        snippet: '120 KB',
        source: 'resource',
      }]),
    ])
    expect(bundle.stats).toMatchObject({ messages: 1, sessions: 1, kb: 0 })
    expect(bundle.stats.sourceCounts).toEqual({ msg: 1, kb: 0, agg: 0, resource: 1 })
    const message = bundle.items.find(item => item.evidenceId === 'msg:wxid_b:5')
    expect(message?.citation).toBeTruthy()
    const resource = bundle.items.find(item => item.key === 'file:合同.pdf:0')
    expect(resource?.evidenceId).toBe('res:search_files:file:合同.pdf:0')
    expect(resource?.citation).toBeUndefined()
    expect(resource?.locator).toMatchObject({ type: 'resource', tool: 'search_files' })
  })

  it('工具成功但标记结果可能不完整时，证据状态降级而不是继续 ok', () => {
    const bundle = buildEvidenceBundle([{
      tool: 'search_files',
      ok: true,
      hits: [{
        key: 'file:a',
        name: '合同.pdf',
        time: '2026-10-20 09:00',
        snippet: '文件 · 1.5 KB',
        source: 'resource',
      }],
      note: '「合同」→ 1 个文件；文件库读取失败（结果可能不完整）',
    }])
    expect(bundle.status).toBe('degraded')
    expect(bundle.stats.partialResults).toBe(1)
    expect(bundle.stats.partialNotes?.[0]).toContain('可能不完整')
  })
})
