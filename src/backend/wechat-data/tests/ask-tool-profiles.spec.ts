/**
 * 检索工具 profile 与 `search_hybrid` 的判据（2026-10-22 新增）。
 *
 * ## 为什么要单独钉住这一层
 *
 * 这两个能力最容易「看起来接上了、实际边界没生效」：
 *   · profile 只过滤 schema ⇒ 模型仍可凭工具名直接调用越界工具；
 *   · 会话锁定只在提示词里声明 ⇒ 一次参数填错就把别人的聊天带进上下文；
 *   · `search_hybrid` 复制一份检索算法 ⇒ 与问答流水线慢慢分叉。
 *
 * 因此这里用**假执行器**验证参数与范围，用**真实装配**验证执行器确实复用了
 * 问答检索；另加一条源码依赖检查，防止工具层反向 import 装配层形成循环。
 *
 * @vitest-environment node
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  ANSWER_PROFILES,
  TOOL_NAMES,
  buildProfileTools,
  buildTools,
  enforceProfileScope,
  findTool,
  getAnswerProfile,
  isToolAllowed,
  makeSearchHybridTool,
  runProfileTool,
  runTool,
  type HybridSearchExecution,
  type HybridSearchRequest,
  type RetrievalTool,
  type ToolContext,
  type ToolName,
  type ToolResult,
} from '../src/query/tools/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLS_DIR = resolve(HERE, '..', 'src', 'query', 'tools')

/** 一个只记录调用的假工具。 */
function fakeTool(
  name: ToolName,
  run = vi.fn((): ToolResult => ({ tool: name, ok: true, hits: [] })),
): RetrievalTool {
  return {
    name,
    category: 'message',
    description: `${name} 的测试替身（说明长度足够让 schema 判据通过）`,
    parameters: { type: 'object', properties: {} },
    run,
  }
}

/** 一组固定的引用，覆盖消息/知识库/聚合三种来源。 */
function citationsFixture(): HybridSearchExecution {
  return {
    citations: [
      {
        name: '项目群',
        time: '2026-10-20 10:00',
        snippet: '合同尾款下周付',
        username: '123@chatroom',
        local_id: 11,
        sender: '李四',
        source: 'msg',
      },
      {
        name: '项目群',
        time: '2026-10-20 10:00',
        snippet: '合同尾款下周付（重复）',
        username: '123@chatroom',
        local_id: 11,
        sender: '李四',
        source: 'msg',
      },
      {
        name: '蓝鲸合同.pdf',
        time: '',
        snippet: '验收款 30%',
        username: 'kb:7:88',
        local_id: 0,
        source: 'kb',
        kb: {
          kbId: 7,
          fileId: 3,
          fileName: '蓝鲸合同.pdf',
          fileExt: 'pdf',
          chunkId: 88,
          ordinal: 2,
          page: 5,
          heading: '付款条款',
        },
      },
      {
        name: '按关键词统计消息条数',
        time: '',
        snippet: '含「转账」：282 条',
        username: '',
        local_id: 0,
        source: 'agg',
      },
    ],
    terms: ['合同', '尾款'],
    facts: [{ title: '按关键词统计消息条数', body: '含「转账」：282 条' }],
  }
}

describe('AnswerProfile：白名单与边界', () => {
  it('wechat-ask 覆盖完整工具集（现有 13 个 + search_hybrid）', () => {
    const profile = ANSWER_PROFILES['wechat-ask']
    expect(profile.allowedTools.length).toBe(TOOL_NAMES.length)
    for (const name of TOOL_NAMES) expect(isToolAllowed(profile, name), `缺少 ${name}`).toBe(true)
    expect(profile.allowedTools).toContain('search_hybrid')
  })

  it('session-ask 只保留消息检索/上下文/聚合/混合兜底', () => {
    const profile = ANSWER_PROFILES['session-ask']
    expect([...profile.allowedTools].sort()).toEqual([
      'aggregate_messages',
      'get_message_context',
      'get_session_messages',
      'search_hybrid',
      'search_messages',
      'search_semantic',
    ].sort())
    // 联系人/朋友圈/收藏/文件/知识库/会话列表都不该出现在会话内问答里
    for (const name of ['search_kb', 'list_sessions', 'search_contacts', 'search_moments', 'search_favorites', 'search_files', 'search_records']) {
      expect(isToolAllowed(profile, name), `${name} 不该被允许`).toBe(false)
    }
  })

  it('clawbot-auto 只能用 search_kb（任何本机微信工具都被拒）', () => {
    const profile = ANSWER_PROFILES['clawbot-auto']
    expect(profile.allowedTools).toEqual(['search_kb'])
    expect(profile.kbOnly).toBe(true)
    expect(profile.allowWechatData).toBe(false)
    for (const name of TOOL_NAMES) {
      // search_kb 是唯一例外；其余（含 search_hybrid）都不能被自动回复调用
      expect(isToolAllowed(profile, name), `${name} 不该被允许`).toBe(name === 'search_kb')
    }
  })

  it('未知 profile 回退到权限最小的 clawbot-auto（不是全量权限）', () => {
    expect(getAnswerProfile('no-such-profile').id).toBe('clawbot-auto')
  })

  it('buildProfileTools 过滤后的清单与白名单一致', () => {
    const tools = buildTools()
    expect(buildProfileTools('clawbot-auto', tools).map(t => t.name)).toEqual(['search_kb'])
    expect(buildProfileTools('session-ask', tools).map(t => t.name).sort())
      .toEqual([...ANSWER_PROFILES['session-ask'].allowedTools].sort())
  })
})

describe('AnswerProfile：执行期范围强制', () => {
  const ctx = (username?: string): ToolContext => ({
    decryptedDir: '/tmp/test-profile',
    ...(username ? { scope: { username } } : {}),
  })

  it('会话内问答注入当前会话 username', () => {
    const d = enforceProfileScope('session-ask', 'search_messages', { keywords: ['合同'] }, ctx('123@chatroom'))
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.args['username']).toBe('123@chatroom')
    expect(d.ctx.scope?.username).toBe('123@chatroom')
  })

  it('会话内问答拒绝模型改写会话（不静默改写成当前会话）', () => {
    const d = enforceProfileScope('session-ask', 'search_messages', { keywords: ['合同'], username: 'other' }, ctx('123@chatroom'))
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.error.errorCode).toBe('scope_violation')
    expect(d.error.errorDetails).toMatchObject({ locked: '123@chatroom', requested: 'other' })
  })

  it('会话内问答缺少当前会话时拒绝执行（而不是全库检索）', () => {
    const d = enforceProfileScope('session-ask', 'search_messages', { keywords: ['合同'] }, ctx())
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.error.errorCode).toBe('scope_required')
  })

  it('固定时间范围会注入日期参数，模型日期偏差收敛且记录修复，倒序仍被拒绝', () => {
    const locked: ToolContext = {
      decryptedDir: '/tmp/test-profile',
      scope: { username: '123@chatroom', from: '2026-10-01', to: '2026-10-07' },
    }

    const injected = enforceProfileScope('session-ask', 'search_messages', { keywords: ['合同'] }, locked)
    expect(injected.ok).toBe(true)
    if (injected.ok) {
      expect(injected.args['from']).toBe('2026-10-01')
      expect(injected.args['to']).toBe('2026-10-07')
      expect(injected.ctx.scope).toMatchObject({ from: '2026-10-01', to: '2026-10-07' })
    }

    const changed = enforceProfileScope(
      'session-ask',
      'search_messages',
      { keywords: ['合同'], from: '2026-09-01' },
      locked,
    )
    expect(changed.ok).toBe(true)
    if (changed.ok) {
      expect(changed.args['from']).toBe('2026-10-01')
      expect(changed.args['to']).toBe('2026-10-07')
      expect(changed.adjustments).toContainEqual(expect.objectContaining({
        field: 'from',
        locked: '2026-10-01',
        requested: '2026-09-01',
      }))
    }

    const reversed = enforceProfileScope(
      'wechat-ask',
      'search_messages',
      { keywords: ['合同'], from: '2026-10-07', to: '2026-10-01' },
      ctx(),
    )
    expect(reversed.ok).toBe(false)
    if (!reversed.ok) expect(reversed.error.errorCode).toBe('invalid_arguments')

    const impossible = enforceProfileScope(
      'wechat-ask',
      'search_messages',
      { keywords: ['合同'], from: '2026-02-30' },
      ctx(),
    )
    expect(impossible.ok).toBe(false)
    if (!impossible.ok) expect(impossible.error.errorCode).toBe('invalid_arguments')
  })

  it('会话内问答的 get_session_messages 同时注入会话与日期', () => {
    const d = enforceProfileScope(
      'session-ask',
      'get_session_messages',
      {},
      {
        decryptedDir: '/tmp/test-profile',
        scope: { username: '123@chatroom', from: '2026-10-01', to: '2026-10-07' },
      },
    )
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.args).toMatchObject({
      username: '123@chatroom',
      from: '2026-10-01',
      to: '2026-10-07',
    })
  })

  it('所有声明日期的工具都会校验并注入锁定范围', () => {
    const locked: ToolContext = {
      decryptedDir: '/tmp/test-profile',
      scope: { username: '123@chatroom', from: '2026-10-01', to: '2026-10-07' },
    }
    const tools = [
      'search_messages',
      'search_semantic',
      'search_hybrid',
      'aggregate_messages',
      'get_session_messages',
      'search_moments',
      'search_favorites',
      'search_files',
      'search_records',
    ] as const
    // 防止实现里的 DATE_ARG_TOOLS 与真实 schema 漂移：新增带日期参数的工具时
    // 这条断言会先失败，而不是让新工具静默绕过范围锁。
    const declared = buildTools()
      .filter((tool) => {
        const properties = tool.parameters['properties'] as Record<string, unknown> | undefined
        return properties?.['from'] !== undefined || properties?.['to'] !== undefined
      })
      .map(tool => tool.name)
      .sort()
    expect(declared).toEqual([...tools].sort())

    const argsFor = (name: typeof tools[number], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      ...(name === 'search_messages' ? { keywords: ['合同'] } : {}),
      ...(name === 'aggregate_messages' ? { question: '多少条' } : {}),
      ...(name === 'search_moments' || name === 'search_favorites'
        || name === 'search_files' || name === 'search_records' ? { query: '合同' } : {}),
      ...(name === 'search_semantic' || name === 'search_hybrid' ? { query: '合同' } : {}),
      ...extra,
    })

    for (const name of tools) {
      const injected = enforceProfileScope('wechat-ask', name, argsFor(name), locked)
      expect(injected.ok, name).toBe(true)
      if (injected.ok) {
        expect(injected.args['from'], name).toBe('2026-10-01')
        expect(injected.args['to'], name).toBe('2026-10-07')
        expect(injected.ctx.scope, name).toMatchObject({ from: '2026-10-01', to: '2026-10-07' })
      }

      const conflict = enforceProfileScope('wechat-ask', name, argsFor(name, { from: '2026-09-01' }), locked)
      expect(conflict.ok, name).toBe(true)
      if (conflict.ok) {
        expect(conflict.args['from'], name).toBe('2026-10-01')
        expect(conflict.args['to'], name).toBe('2026-10-07')
        expect(conflict.adjustments, name).toContainEqual(expect.objectContaining({
          field: 'from',
          locked: '2026-10-01',
          requested: '2026-09-01',
        }))
      }

      const reversed = enforceProfileScope('wechat-ask', name, argsFor(name, {
        from: '2026-10-07',
        to: '2026-10-01',
      }), ctx())
      expect(reversed.ok, name).toBe(false)
      if (!reversed.ok) expect(reversed.error.errorCode, name).toBe('invalid_arguments')
    }
  })

  it('get_message_context 的 key 必须属于当前会话', () => {
    const bad = enforceProfileScope('session-ask', 'get_message_context', { key: 'other:1' }, ctx('123@chatroom'))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.errorCode).toBe('scope_violation')

    const good = enforceProfileScope('session-ask', 'get_message_context', { key: '123@chatroom:1' }, ctx('123@chatroom'))
    expect(good.ok).toBe(true)
  })

  it('wechat-ask 锁定会话后同样拒绝其他会话的上下文 key', () => {
    const bad = enforceProfileScope('wechat-ask', 'get_message_context', { key: 'other:1' }, ctx('wxid_a'))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.errorCode).toBe('scope_violation')
  })

  it('锁定会话或日期时 list_sessions 明确拒绝，而不是悄悄查全量', () => {
    const byUser = enforceProfileScope('wechat-ask', 'list_sessions', {}, ctx('wxid_a'))
    expect(byUser.ok).toBe(false)
    if (!byUser.ok) expect(byUser.error.errorCode).toBe('unsupported_scope')

    const byDate = enforceProfileScope('wechat-ask', 'list_sessions', {}, {
      decryptedDir: '/tmp/x',
      scope: { from: '2026-10-01', to: '2026-10-07' },
    })
    expect(byDate.ok).toBe(false)
    if (!byDate.ok) expect(byDate.error.errorCode).toBe('unsupported_scope')
  })

  it('search_hybrid 在会话内问答自动收敛为 messages 模式', () => {
    const d = enforceProfileScope('session-ask', 'search_hybrid', { query: '合同' }, ctx('123@chatroom'))
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.args['mode']).toBe('messages')
    expect(d.args['username']).toBe('123@chatroom')
  })

  it('search_hybrid 不接受会话内问答不允许的模式', () => {
    const d = enforceProfileScope('session-ask', 'search_hybrid', { query: '合同', mode: 'auto' }, ctx('123@chatroom'))
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.error.errorCode).toBe('scope_violation')
  })

  it('ClawBot 直接调用越界工具被执行层拒绝，且不会触发工具实现', async () => {
    const run = vi.fn((): ToolResult => ({ tool: 'search_messages', ok: true, hits: [] }))
    const tools = [fakeTool('search_messages', run)]
    const r = await runProfileTool('clawbot-auto', tools, 'search_messages', { keywords: ['合同'] }, ctx())
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('tool_not_allowed')
    expect(run).not.toHaveBeenCalled()

    // 未知工具名也走结构化错误，而不是抛错/静默
    const unknown = await runProfileTool('wechat-ask', tools, 'no_such_tool', {}, ctx())
    expect(unknown.ok).toBe(false)
    expect(unknown.errorCode).toBe('tool_not_allowed')
  })

  it('ClawBot 未选知识库时 search_kb 明确报错（不是去搜本机消息）', async () => {
    const tools = buildTools()
    const r = await runProfileTool('clawbot-auto', tools, 'search_kb', { query: '合同' }, ctx())
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('not_configured')
  })
})

describe('search_hybrid：参数与结果映射', () => {
  it('未传 query / 日期格式错 / from 晚于 to / mode 非法时都给 invalid_arguments', async () => {
    const executor = vi.fn((): HybridSearchExecution => ({ citations: [] }))
    const tool = makeSearchHybridTool(executor)
    const base = { decryptedDir: '/tmp/hybrid' }

    for (const args of [
      {},
      { query: '', from: '2026-01-01' },
      { query: '合同', from: '2026/01/01' },
      { query: '合同', from: '2026-02-30' },
      { query: '合同', from: '2026-02-01', to: '2026-01-01' },
      { query: '合同', mode: 'everything' },
      { query: '合同', from: 20260101 },
      { query: '合同', username: 123 },
    ]) {
      const r = await runTool([tool], 'search_hybrid', args, base)
      expect(r.ok, `${JSON.stringify(args)} 不该成功`).toBe(false)
      expect(r.errorCode).toBe('invalid_arguments')
    }
    expect(executor).not.toHaveBeenCalled()
  })

  it('username 与固定范围冲突时明确报错（不静默改用其中一个）', async () => {
    const executor = vi.fn((): HybridSearchExecution => ({ citations: [] }))
    const tool = makeSearchHybridTool(executor)
    const r = await runTool([tool], 'search_hybrid', { query: '合同', username: 'other' }, {
      decryptedDir: '/tmp/hybrid',
      scope: { username: 'locked' },
    })
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('scope_violation')
    expect(executor).not.toHaveBeenCalled()
  })

  it('日期偏离固定范围时收敛到锁定区间并记录修复，不阻断整轮检索', async () => {
    const executor = vi.fn((req: HybridSearchRequest): HybridSearchExecution => {
      expect(req.scope).toMatchObject({
        from: '2026-09-16',
        to: '2026-10-16',
      })
      return citationsFixture()
    })
    const r = await runTool([makeSearchHybridTool(executor)], 'search_hybrid', {
      query: '王国路 项目',
      from: '2026-09-01',
      to: '2026-09-30',
    }, {
      decryptedDir: '/tmp/hybrid',
      scope: { from: '2026-09-16', to: '2026-10-16' },
    })

    expect(r.ok).toBe(true)
    expect(r.errorCode).toBeUndefined()
    expect(r.note).toContain('已按本轮固定范围收敛为 2026-09-16')
    expect(r.note).toContain('已按本轮固定范围收敛为 2026-10-16')
    expect(executor).toHaveBeenCalledOnce()
  })

  it('auto 模式不要求知识库；显式 kb 模式没有 kbId 时明确报 not_configured', async () => {
    const executor = vi.fn((req: HybridSearchRequest): HybridSearchExecution => {
      if (req.mode === 'auto') return citationsFixture()
      return { citations: [] }
    })
    const tool = makeSearchHybridTool(executor)
    const auto = await runTool([tool], 'search_hybrid', { query: '合同' }, { decryptedDir: '/tmp/hybrid' })
    expect(auto.ok).toBe(true)
    expect(executor).toHaveBeenCalledOnce()

    const kb = await runTool([tool], 'search_hybrid', { query: '合同', mode: 'kb' }, { decryptedDir: '/tmp/hybrid' })
    expect(kb.ok).toBe(false)
    expect(kb.errorCode).toBe('not_configured')
  })

  it('把引用规范成带 key/时间/发送者/溯源信息的 hits，聚合只进 facts', async () => {
    const executor = (): HybridSearchExecution => citationsFixture()
    const r = await runTool([makeSearchHybridTool(executor)], 'search_hybrid', {
      query: '合同', limit: 10,
    }, { decryptedDir: '/tmp/hybrid' })

    expect(r.ok).toBe(true)
    // 消息重复项按 key 去重；聚合引用不混进 hits
    expect(r.hits.map(h => h.key)).toEqual(['123@chatroom:11', 'kb:7:88'])
    expect(r.hits[0]).toMatchObject({
      name: '项目群', time: '2026-10-20 10:00', sender: '李四', source: 'msg',
      trace: { kind: 'msg', username: '123@chatroom', localId: 11 },
    })
    expect(r.hits[1]).toMatchObject({
      name: '蓝鲸合同.pdf', source: 'kb',
      trace: { kind: 'kb', kbId: 7, fileId: 3, chunkId: 88, page: 5, heading: '付款条款' },
    })
    // 混合检索已经排好序；名次必须落成显式分数，否则证据层会按时间重排。
    expect(r.hits[0]?.score).toBeGreaterThan(r.hits[1]?.score ?? 0)
    expect(r.facts).toEqual([{ title: '按关键词统计消息条数', body: '含「转账」：282 条' }])
    expect(r.note).toContain('2 条证据')
  })

  it('执行器只给聚合 chunks 时也能收敛为 facts', async () => {
    const r = await runTool([makeSearchHybridTool(() => ({
      citations: [],
      chunks: [{
        name: '统计',
        anchor: {
          name: '按会话统计消息数', time: '', snippet: '项目群 100 条',
          username: '', local_id: 0, source: 'agg',
        },
        lines: [{ time: '', sender: '', text: '项目群 100 条' }],
      }],
    }))], 'search_hybrid', { query: '统计一下' }, { decryptedDir: '/tmp/hybrid' })
    expect(r.ok).toBe(true)
    expect(r.hits).toEqual([])
    expect(r.facts).toEqual([{ title: '按会话统计消息数', body: '项目群 100 条' }])
  })

  it('limit 会传给执行器并被钳制到 60；结果超出时再截断', async () => {
    const seen: number[] = []
    const executor = (req: HybridSearchRequest): HybridSearchExecution => {
      seen.push(req.limit)
      return {
        citations: Array.from({ length: 5 }, (_, i) => ({
          name: '群', time: '', snippet: String(i), username: 'u', local_id: i, source: 'msg' as const,
        })),
      }
    }
    const tool = makeSearchHybridTool(executor)
    await runTool([tool], 'search_hybrid', { query: '合同', limit: 999 }, { decryptedDir: '/tmp/hybrid' })
    const r = await runTool([tool], 'search_hybrid', { query: '合同', limit: 2 }, { decryptedDir: '/tmp/hybrid' })
    expect(seen).toEqual([60, 2])
    expect(r.hits).toHaveLength(2)
  })

  it('执行器返回的结构化错误与异常都被如实转成 ToolResult', async () => {
    const blocked = await runTool([makeSearchHybridTool(() => ({
      citations: [],
      error: { code: 'data_scope_blocked', message: '不允许访问本机数据' },
    }))], 'search_hybrid', { query: '合同' }, { decryptedDir: '/tmp/hybrid' })
    expect(blocked.ok).toBe(false)
    expect(blocked.errorCode).toBe('data_scope_blocked')
    expect(blocked.hits).toEqual([])

    const thrown = await runTool([makeSearchHybridTool(() => { throw new Error('boom-hybrid') })],
      'search_hybrid', { query: '合同' }, { decryptedDir: '/tmp/hybrid' })
    expect(thrown.ok).toBe(false)
    expect(thrown.errorCode).toBe('upstream_failure')
    expect(thrown.error).toContain('boom-hybrid')
  })

  it('未注入执行器时工具仍在清单里，执行时如实报 not_configured', async () => {
    const tools = buildTools()
    expect(findTool(tools, 'search_hybrid')).toBeTruthy()
    const r = await runTool(tools, 'search_hybrid', { query: '合同' }, { decryptedDir: '/tmp/hybrid' })
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('not_configured')
  })

  it('ctx.wechatDataEnabled=false 时，messages/auto 与聚合都被拒绝（只有 kb 模式除外）', async () => {
    const executor = vi.fn((): HybridSearchExecution => ({ citations: [] }))
    const tool = makeSearchHybridTool(executor)
    const blockedCtx: ToolContext = { decryptedDir: '/tmp/hybrid', wechatDataEnabled: false }

    for (const args of [
      { query: '合同' },
      { query: '合同', mode: 'messages' },
      { query: '合同', mode: 'auto', aggregate: true },
    ]) {
      const r = await runTool([tool], 'search_hybrid', args, blockedCtx)
      expect(r.ok, `${JSON.stringify(args)} 在 kb-only 下不该成功`).toBe(false)
      expect(r.errorCode).toBe('data_scope_blocked')
    }
    expect(executor).not.toHaveBeenCalled()

    // 知识库模式不碰本机消息，允许执行（前提是有 kbId）
    const allowed = await runTool([tool], 'search_hybrid', { query: '合同', mode: 'kb' }, {
      ...blockedCtx, kbId: 7,
    })
    expect(allowed.ok).toBe(true)
  })
})

describe('工具层依赖方向', () => {
  /** 读取 `query/tools` 下全部源码。 */
  function toolSources(): Array<{ file: string; text: string }> {
    return readdirSync(TOOLS_DIR)
      .filter(name => name.endsWith('.ts'))
      .map(name => ({ file: name, text: readFileSync(join(TOOLS_DIR, name), 'utf8') }))
  }

  /** 取相对 import 的模块说明符（只用于本目录内的依赖图）。 */
  function relativeImports(text: string): string[] {
    return [...text.matchAll(/(?:from\s+|import\s*\()\s*['"](\.\/[^'"]+)['"]/g)]
      .map(m => m[1] ?? '')
      .filter(Boolean)
  }

  it('工具层不反向 import remotes / answer-runtime（避免环）', () => {
    const offenders: string[] = []
    for (const { file, text } of toolSources()) {
      for (const spec of relativeImports(text)) {
        if (spec.includes('/remotes/') || spec.includes('answer-runtime')) offenders.push(`${file} -> ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('工具层内部相对依赖无环', () => {
    const graph = new Map<string, string[]>()
    const files = new Set(toolSources().map(s => s.file))
    for (const { file, text } of toolSources()) {
      const deps = relativeImports(text)
        .map(spec => spec.replace(/^\.\//, '').replace(/\.ts$/, '') + '.ts')
        .filter(dep => files.has(dep))
      graph.set(file, deps)
    }
    const visiting = new Set<string>()
    const done = new Set<string>()
    const stack: string[] = []
    const cycles: string[] = []
    const visit = (file: string): void => {
      if (done.has(file)) return
      if (visiting.has(file)) {
        const at = stack.indexOf(file)
        cycles.push([...stack.slice(at), file].join(' -> '))
        return
      }
      visiting.add(file)
      stack.push(file)
      for (const dep of graph.get(file) ?? []) visit(dep)
      stack.pop()
      visiting.delete(file)
      done.add(file)
    }
    for (const file of graph.keys()) visit(file)
    expect(cycles).toEqual([])
  })
})
