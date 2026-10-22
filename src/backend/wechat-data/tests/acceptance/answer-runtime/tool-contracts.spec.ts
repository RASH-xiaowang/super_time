// @vitest-environment node
/**
 * 工具层黑盒契约。
 *
 * 这些断言只依赖已经稳定存在的 `registry.ts` / `profiles.ts` / `answer-runtime`
 * 导出，不假设主运行时已经接好。重点是区分三种最容易被混淆的状态：
 *   · 正常执行但没有数据（empty）；
 *   · 数据源不可用/工具失败（error）；
 *   · 越权或被 profile 阻断（blocked）。
 */
import { afterAll, describe, expect, it } from 'vitest'
import {
  allTools,
  buildProfileTools,
  enforceProfileScope,
  findTool,
  getAnswerProfile,
  isToolAllowed,
  runProfileTool,
  runTool,
  toolSchemas,
} from '../../../src/query/tools/index.ts'
import type { RetrievalTool, ToolResult } from '../../../src/query/tools/types.ts'
import { runRetrievalPipeline } from '../../../src/query/retrieval/pipeline.ts'
import { defaultRetrievalConfig } from '../../../src/query/retrieval/config.ts'
import {
  CONTEXT_CENTER_DAY,
  CONTEXT_CENTER_ID,
  CONTEXT_INSIDE_ID,
  CONTEXT_OUTSIDE_ID,
  LISI,
  WANG,
  cleanupAcceptanceScratch,
  makeMissingToolDataDir,
  makeScopedRetrievalFixture,
  makeStubTool,
  makeToolDataDir,
} from './helpers.ts'
import { loadArgumentsRuntime, loadErrorRuntime } from './runtime-adapter.ts'

afterAll(() => cleanupAcceptanceScratch())

describe('Agent 工具 schema 清单', () => {
  it('名称唯一、description 非空、parameters 是 object schema', () => {
    const names = allTools.map(tool => tool.name)
    expect(new Set(names).size).toBe(names.length)
    expect(toolSchemas().map(schema => schema.name)).toEqual(names)

    for (const schema of toolSchemas()) {
      expect(schema.name.trim(), '工具名为空').not.toBe('')
      expect(schema.description.trim(), `${schema.name} 的 description 为空`).not.toBe('')
      expect(schema.parameters['type'], `${schema.name} 不是 object schema`).toBe('object')
      const properties = schema.parameters['properties']
      expect(properties, `${schema.name} 缺少 properties`).toBeTruthy()
      expect(typeof properties).toBe('object')
      expect(Array.isArray(properties), `${schema.name} 的 properties 不能是数组`).toBe(false)
    }
  })
})

describe('工具执行：空结果、失败与越权必须可区分', () => {
  it('未知工具返回 ok:false 与空 hits，而不是抛错', async () => {
    const result = await runTool(allTools, 'no_such_tool', {}, { decryptedDir: '/nope' })
    expect(result.ok).toBe(false)
    expect(result.hits).toEqual([])
    expect(result.error).toBeTruthy()
  })

  it('工具内部抛错由注册表兜住，且不会变成成功空结果', async () => {
    const boom = makeStubTool('search_messages', () => {
      throw new Error('boom-contract')
    })
    const result = await runTool([boom], 'search_messages', {}, { decryptedDir: '/nope' })
    expect(result.ok).toBe(false)
    expect(result.hits).toEqual([])
    expect(result.error).toContain('boom-contract')
  })

  it('“成功但缺少 hits 数组”的畸形结果收敛为 upstream_failure', async () => {
    const malformed = makeStubTool(
      'search_messages',
      () => ({ tool: 'search_messages', ok: true } as unknown as ToolResult),
    )
    const result = await runTool([malformed], 'search_messages', {}, { decryptedDir: '/nope' })
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('upstream_failure')
    expect(result.hits).toEqual([])
    expect(result.error).toContain('畸形结果')
  })

  it('必填参数缺失时失败，而不是静默查空', async () => {
    const decryptedDir = makeToolDataDir()
    for (const args of [{}, { keywords: null }, { keywords: 123 }]) {
      const result = await runTool(allTools, 'search_messages', args as Record<string, unknown>, { decryptedDir })
      expect(result.ok, `参数 ${JSON.stringify(args)} 不应成功`).toBe(false)
      expect(result.error).toBeTruthy()
      expect(result.hits).toEqual([])
    }
  })

  it('“正常无数据”与“数据源不可用”状态不同，调用方不会把两者混为一谈', async () => {
    const missing = makeMissingToolDataDir()
    const empty = await runTool(allTools, 'search_messages', { keywords: ['合同'] }, { decryptedDir: missing })
    const unavailable = await runTool(allTools, 'list_sessions', {}, { decryptedDir: missing })

    expect(empty.ok).toBe(true)
    expect(empty.hits).toEqual([])
    expect(unavailable.ok).toBe(false)
    expect(unavailable.hits).toEqual([])
    expect(unavailable.error).toBeTruthy()
  })
})

describe('错误分类与重试边界', () => {
  it('超时可重试但有界；参数/越权不重试；有副作用不重试', async () => {
    const runtime = await loadErrorRuntime()
    expect(runtime, '缺少 answer-runtime/errors.ts#classifyToolErrorDetailed').toBeDefined()
    if (!runtime) return

    const timeout = runtime.classifyToolErrorDetailed(new Error('请求超时'), { tool: 'search_messages' })
    expect(timeout.cls).toBe('timeout')
    expect(timeout.retryable).toBe(true)
    expect(timeout.maxAttempts).toBe(2)

    const invalid = runtime.classifyToolErrorDetailed(new Error('缺少必填参数 keywords'))
    expect(invalid.cls).toBe('invalid_arguments')
    expect(invalid.retryable).toBe(false)
    expect(invalid.maxAttempts).toBe(1)

    const blocked = runtime.classifyToolErrorDetailed(new Error('超出允许的数据范围'))
    expect(blocked.cls).toBe('scope_blocked')
    expect(blocked.retryable).toBe(false)

    const sideEffect = runtime.classifyToolErrorDetailed(new Error('timeout'), { sideEffect: true })
    expect(sideEffect.cls).toBe('timeout')
    expect(sideEffect.retryable).toBe(false)
    expect(sideEffect.maxAttempts).toBe(1)
  })
})

describe('参数构造与修复', () => {
  it('数字字符串与强制会话范围可自动修复；缺必填项不会被吞掉', async () => {
    const runtime = await loadArgumentsRuntime()
    expect(runtime, '缺少 answer-runtime/arguments.ts#repairToolArguments').toBeDefined()
    if (!runtime) return

    const repaired = runtime.repairToolArguments(
      'search_messages',
      { keywords: ['合同'], limit: '5' },
      { forcedScope: { username: LISI } },
    )
    expect(repaired.ok).toBe(true)
    expect(repaired.args['limit']).toBe(5)
    expect(repaired.args['username']).toBe(LISI)
    expect(repaired.repairs.some(message => message.includes('强制会话范围'))).toBe(true)

    const missing = runtime.repairToolArguments('search_messages', { limit: 5 })
    expect(missing.ok).toBe(false)
    expect(missing.error).toBeTruthy()
    expect(missing.field).toBe('keywords')
  })
})

describe('Profile 白名单与范围守卫', () => {
  it('ClawBot 白名单精确等于 search_kb，且 kb-only/requireKb 固定', () => {
    const clawbot = getAnswerProfile('clawbot-auto')
    expect(clawbot.allowedTools).toEqual(['search_kb'])
    expect(clawbot.kbOnly).toBe(true)
    expect(clawbot.requireKb).toBe(true)
    expect(clawbot.allowWechatData).toBe(false)
    expect(isToolAllowed(clawbot, 'search_kb')).toBe(true)
    for (const name of ['search_messages', 'search_hybrid', 'aggregate_messages', 'list_sessions']) {
      expect(isToolAllowed(clawbot, name), `${name} 不应出现在 ClawBot 白名单`).toBe(false)
    }
  })

  it('ClawBot 调用非白名单工具在执行前被阻断', async () => {
    let called = false
    const spy = makeStubTool('search_messages', (): ToolResult => {
      called = true
      return { tool: 'search_messages', ok: true, hits: [] }
    })
    const result = await runProfileTool(
      'clawbot-auto',
      [spy],
      'search_messages',
      { keywords: ['合同'] },
      { decryptedDir: '/nope', kbId: 1 },
    )
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('tool_not_allowed')
    expect(called).toBe(false)
  })

  it('SessionAsk 缺少锁定 username 时要求范围；冲突 username 与跨会话 key 均被拒绝', () => {
    const missing = enforceProfileScope(
      'session-ask',
      'search_messages',
      { keywords: ['合同'] },
      { decryptedDir: '/nope' },
    )
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.errorCode).toBe('scope_required')

    const conflict = enforceProfileScope(
      'session-ask',
      'search_messages',
      { keywords: ['合同'], username: WANG },
      { decryptedDir: '/nope', scope: { username: LISI } },
    )
    expect(conflict.ok).toBe(false)
    if (!conflict.ok) {
      expect(conflict.error.errorCode).toBe('scope_violation')
      expect(conflict.error.errorDetails?.['locked']).toBe(LISI)
    }

    const crossKey = enforceProfileScope(
      'session-ask',
      'get_message_context',
      { key: `${WANG}:1` },
      { decryptedDir: '/nope', scope: { username: LISI } },
    )
    expect(crossKey.ok).toBe(false)
    if (!crossKey.ok) expect(crossKey.error.errorCode).toBe('scope_violation')
  })

  it('SessionAsk 执行前注入当前 username，直调 .run 也绕不过守卫', async () => {
    const echo = makeStubTool('search_messages', (args): ToolResult => ({
      tool: 'search_messages',
      ok: true,
      hits: [],
      note: JSON.stringify(args),
    }))
    const scoped = buildProfileTools('session-ask', [echo])
    const tool = findTool(scoped, 'search_messages')
    expect(tool).toBeDefined()
    if (!tool) return

    const result = await tool.run({ keywords: ['合同'] }, { decryptedDir: '/nope', scope: { username: LISI } })
    expect(result.ok).toBe(true)
    expect(JSON.parse(result.note ?? '{}')).toMatchObject({ username: LISI })
  })

  it('list_sessions 经真实守卫装配后，固定 username 或日期范围都返回 unsupported_scope', async () => {
    const scopedTools = buildProfileTools('wechat-ask', allTools)
    const scopes = [
      { username: LISI },
      { from: CONTEXT_CENTER_DAY },
      { to: CONTEXT_CENTER_DAY },
    ]
    for (const scope of scopes) {
      const result = await runTool(scopedTools, 'list_sessions', {}, {
        decryptedDir: '/nope',
        scope,
      })
      expect(result.ok, `scope=${JSON.stringify(scope)} 应被拒绝`).toBe(false)
      expect(result.errorCode).toBe('unsupported_scope')
      expect(result.hits).toEqual([])
    }
  })
})

describe('真实检索范围（防止空转）', () => {
  it('未限定 scope 确实跨会话，限定后只剩当前 username', async () => {
    const decrypted = await makeScopedRetrievalFixture()
    const base = {
      decryptedDir: decrypted,
      question: '李四的合同',
      subQueries: ['合同'],
      entity: '李四',
      limit: 10,
      config: defaultRetrievalConfig(),
    }

    const all = await runRetrievalPipeline(base)
    const allUsers = new Set(all.citations.map(citation => citation.username))
    expect(allUsers.size, '夹具没有跨会话命中，隔离断言会空转').toBeGreaterThan(1)

    const scoped = await runRetrievalPipeline({
      ...base,
      scope: { username: LISI },
    })
    expect(scoped.citations.length).toBeGreaterThan(0)
    expect([...new Set(scoped.citations.map(citation => citation.username))]).toEqual([LISI])
    for (const chunk of scoped.chunks) expect(chunk.username).toBe(LISI)
  })

  it('get_message_context 锁定日期后过滤窗口内范围外的相邻消息', async () => {
    const decrypted = await makeScopedRetrievalFixture()
    const scopedTools = buildProfileTools('wechat-ask', allTools)
    const args = {
      key: `${LISI}:${String(CONTEXT_CENTER_ID)}`,
      spanMinutes: 15,
      maxMessages: 20,
    }

    const all = await runTool(scopedTools, 'get_message_context', args, {
      decryptedDir: decrypted,
      scope: { username: LISI },
    })
    expect(all.ok).toBe(true)
    expect(all.hits.map(hit => hit.key)).toEqual([
      `${LISI}:${String(CONTEXT_OUTSIDE_ID)}`,
      `${LISI}:${String(CONTEXT_CENTER_ID)}`,
      `${LISI}:${String(CONTEXT_INSIDE_ID)}`,
    ])

    const dated = await runTool(scopedTools, 'get_message_context', args, {
      decryptedDir: decrypted,
      scope: { username: LISI, from: CONTEXT_CENTER_DAY, to: CONTEXT_CENTER_DAY },
    })
    expect(dated.ok).toBe(true)
    expect(dated.hits.map(hit => hit.key)).toEqual([
      `${LISI}:${String(CONTEXT_CENTER_ID)}`,
      `${LISI}:${String(CONTEXT_INSIDE_ID)}`,
    ])
    expect(dated.hits.map(hit => hit.key)).not.toContain(`${LISI}:${String(CONTEXT_OUTSIDE_ID)}`)
  })
})
