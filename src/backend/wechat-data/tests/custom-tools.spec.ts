/**
 * 自定义工具：校验、执行模板与注册表落库（2026-11-24）。
 *
 * 这一族最容易出的问题不是样式，而是**配得出来但跑不起来**：
 * 名字撞了内置工具、封装的参数根本不存在、或者固定完参数后模型已无可填项。
 * 这些错误如果只在模型调用时才暴露，用户看到的是「问了没反应」，排查成本极高。
 * 所以这里逐个钉住「保存时就该拒绝」的形状，以及「保存后能真跑」的那两条路径。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCustomTools, keepCustomToolsForDataBoundary, validateCustomTool } from '../src/query/custom-tools.ts'
import { deleteCustomTool, readToolConfig, upsertCustomTool, upsertToolOverride } from '../src/query/tool-config-store.ts'
import { queryLocalTools } from '../src/query/local-tools.ts'
import { filterToolsForProfile, buildProfileTools } from '../src/query/tools/profiles.ts'
import { allTools, buildTools } from '../src/query/tools/registry.ts'
import type { ToolContext } from '../src/query/tools/types.ts'

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 造一个解密数据根（库文件由写入时自动创建）。 */
function dataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wx-custom-tools-'))
  scratch.push(root)
  const decrypted = join(root, 'wechat-data', 'decrypted')
  mkdirSync(decrypted, { recursive: true })
  return decrypted
}

/** 一个合法的 alias 输入（可覆写）。 */
function aliasInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: '最近三个月转账',
    description: '查最近三个月的转账明细，时间范围已固定，不要再传 from/to。',
    kind: 'alias',
    target: 'search_records',
    fixed: { from: '2026-08-01' },
    ...overrides,
  }
}

describe('保存时的校验：配得出来就必须跑得起来', () => {
  it('名字形状与内置工具重名都会被拒（默认工具不可被覆盖）', () => {
    expect(validateCustomTool({ ...aliasInput() } as never).record?.name).toBeUndefined()
    expect(validateCustomTool({ ...aliasInput({ name: 'Bad-Name' }) } as never).error).toContain('工具名')
    expect(validateCustomTool({ ...aliasInput({ name: 'ab' }) } as never).error).toContain('工具名')
    expect(validateCustomTool({ ...aliasInput({ name: 'search_messages' }) } as never).error).toContain('内置工具')
  })

  it('名称与说明不能为空；说明过长会被拒', () => {
    expect(validateCustomTool({ ...aliasInput({ name: 'recent_transfers', title: ' ' }) } as never).error).toContain('名称')
    expect(validateCustomTool({ ...aliasInput({ name: 'recent_transfers', description: '' }) } as never).error).toContain('说明')
    expect(validateCustomTool({ ...aliasInput({ name: 'recent_transfers', description: 'x'.repeat(401) }) } as never).error)
      .toContain('400')
  })

  it('alias：目标必须存在、固定参数必须在目标 schema 里、至少固定一个、不能固定到无可填参数', () => {
    expect(validateCustomTool({ ...aliasInput({ name: 'a_tool', target: 'no_such_tool' }) } as never).error).toContain('不存在')
    expect(validateCustomTool({ ...aliasInput({ name: 'a_tool', fixed: { nope: 'x' } }) } as never).error).toContain('nope')
    expect(validateCustomTool({ ...aliasInput({ name: 'a_tool', fixed: {} }) } as never).error).toContain('固定一个')
    // 把目标工具的**所有**参数都固定住 ⇒ 模型没有可填项，等价于一个固定调用
    const target = buildTools().find((tool) => {
      const props = tool.parameters['properties']
      return typeof props === 'object' && props !== null && Object.keys(props as object).length >= 2
    })
    expect(target, '找不到参数 ≥2 的内置工具，这条判据失去意义').toBeDefined()
    const rules = (target!.parameters['properties'] ?? {}) as Record<string, Record<string, unknown>>
    // 值必须按各自类型给，否则会先被类型校验拦下来，测不到「固定参数过多」这一支
    const fixed = Object.fromEntries(Object.entries(rules).map(([name, rule]) => {
      const type = typeof rule['type'] === 'string' ? rule['type'] : 'string'
      if (type === 'boolean') return [name, 'true']
      if (type === 'number' || type === 'integer') return [name, '1']
      if (type === 'array') return [name, 'a']
      return [name, 'x']
    }))
    const over = validateCustomTool({ ...aliasInput({ name: 'a_tool', target: target!.name, fixed }) } as never)
    expect(over.ok).toBe(false)
    expect(over.error).toContain('固定参数过多')
  })

  it('answer：固定回答不能为空、不能超过 2000 字', () => {
    const base = { name: 'glossary', title: '术语表', description: '本团队口径', kind: 'answer', answer: '' }
    expect(validateCustomTool(base as never).error).toContain('固定回答')
    expect(validateCustomTool({ ...base, answer: 'x'.repeat(2001) } as never).error).toContain('2000')
    expect(validateCustomTool({ ...base, answer: '回款=已付款未到账' } as never).ok).toBe(true)
  })
})

describe('执行模板：alias 转发、answer 返回固定文本', () => {
  const alias = validateCustomTool({
    ...aliasInput({ name: 'recent_transfers', fixed: { from: '2026-08-01' } }),
  } as never)
  const answer = validateCustomTool({
    name: 'glossary', title: '术语表', description: '本团队口径', kind: 'answer', answer: '回款=已付款未到账',
  } as never)

  it('alias 的参数 schema 去掉固定项，并标 custom（否则 profile 白名单会把它滤掉）', () => {
    expect(alias.ok).toBe(true)
    const tools = buildCustomTools([alias.record!])
    expect(tools).toHaveLength(1)
    const tool = tools[0]!
    expect(tool.name).toBe('recent_transfers')
    expect(tool.custom).toBe(true)
    const props = tool.parameters['properties'] as Record<string, unknown>
    expect(Object.keys(props)).not.toContain('from')
    const required = tool.parameters['required'] as string[]
    expect(required).not.toContain('from')
  })

  it('alias 的固定会话与当前会话范围冲突时直接拒绝，不把请求转发出去', async () => {
    const locked = validateCustomTool({
      ...aliasInput({ name: 'in_chat_a', target: 'search_messages', fixed: { username: 'wxid_a' } }),
    } as never)
    const tool = buildCustomTools([locked.record!])[0]!
    const result = await tool.run({}, { scope: { username: 'wxid_b' } } as unknown as ToolContext)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('scope_violation')
    expect(result.hits).toEqual([])
  })

  it('alias 在锁定会话下：模型自己传别的会话也被拒，不传则注入锁定值', async () => {
    const target = allTools.find((item) => item.name === 'search_messages')!
    const spy = vi.spyOn(target, 'run').mockResolvedValue({ tool: 'search_messages', ok: true, hits: [] })
    const record = validateCustomTool({
      ...aliasInput({ name: 'recent_quote', target: 'search_messages', fixed: { order: 'recent' } }),
    } as never).record!
    const tool = buildCustomTools([record])[0]!
    const ctx = { scope: { username: 'wxid_a' } } as unknown as ToolContext

    const denied = await tool.run({ keywords: ['报价'], username: 'wxid_b' }, ctx)
    expect(denied.ok).toBe(false)
    expect(denied.errorCode).toBe('scope_violation')
    expect(spy, '被拒的调用不该转发给目标工具').not.toHaveBeenCalled()

    spy.mockClear()
    const allowed = await tool.run({ keywords: ['报价'] }, ctx)
    expect(allowed.ok).toBe(true)
    expect(allowed.tool, '结果里的工具名要换回自定义名').toBe('recent_quote')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ keywords: ['报价'], order: 'recent', username: 'wxid_a' })
    spy.mockRestore()
  })

  it('answer 返回一条命中，正文就是配置的固定回答（零 I/O）', async () => {
    const tool = buildCustomTools([answer.record!])[0]!
    const result = await tool.run({}, {} as unknown as ToolContext)
    expect(result.ok).toBe(true)
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.snippet).toBe('回款=已付款未到账')
    expect(result.tool).toBe('glossary')
  })

  it('停用的自定义工具不会进入工具集', () => {
    expect(buildCustomTools([{ ...alias.record!, enabled: false }])).toEqual([])
  })

  it('新建时用一个已存在的自定义名必须被拒（否则静默覆盖旧工具）', () => {
    const existing = validateCustomTool({ ...aliasInput({ name: 'recent_transfers' }) } as never).record!
    const overwrite = validateCustomTool({ ...aliasInput({ name: 'recent_transfers', isNew: true }) } as never, existing)
    expect(overwrite.ok).toBe(false)
    expect(overwrite.error).toContain('已经有一个')
    // 不带 isNew 的是「编辑」，允许改自己
    expect(validateCustomTool({ ...aliasInput({ name: 'recent_transfers' }) } as never, existing).ok).toBe(true)
  })

  it('名字不能占用回复工具与出网通道的调用名（日志里要能分清是哪个）', () => {
    for (const name of ['weather', 'search_web', 'webhook', 'bazhuayu']) {
      expect(validateCustomTool({ ...aliasInput({ name }) } as never).error, name).toContain('内置工具')
    }
  })

  it('自定义工具带 customKind，数据边界能据此裁掉可能读数据的 alias', () => {
    const customs = buildCustomTools([alias.record!, answer.record!])
    expect(customs.map((tool) => tool.customKind)).toEqual(['alias', 'answer'])
    expect(keepCustomToolsForDataBoundary(customs, true).map((tool) => tool.name))
      .toEqual(['recent_transfers', 'glossary'])
    expect(keepCustomToolsForDataBoundary(customs, false).map((tool) => tool.name))
      .toEqual(['glossary'])
  })

  it('固定参数按 schema 转换类型：布尔不能存成字符串（否则会被静默当成 false）', async () => {
    const record = validateCustomTool({
      ...aliasInput({ name: 'stats_with_geo', target: 'get_moments_stats', fixed: { includeGeo: 'true' } }),
    } as never)
    // get_moments_stats 只有一个可选布尔与若干日期/数字；固定布尔是合法组合
    expect(record.ok, record.error).toBe(true)
    expect(record.record?.fixed['includeGeo']).toBe(true)
    const tool = buildCustomTools([record.record!])[0]!
    const spy = vi.spyOn(allTools.find((item) => item.name === 'get_moments_stats')!, 'run')
      .mockResolvedValue({ tool: 'get_moments_stats', ok: true, hits: [] })
    await tool.run({}, {} as unknown as ToolContext)
    expect(spy.mock.calls[0]?.[0]?.['includeGeo'], '布尔被存成字符串时目标工具会当成 false').toBe(true)
    spy.mockRestore()
  })

  it('数组参数按逗号拆开；数字参数转成数字；非法值给出可读原因', () => {
    const keywords = validateCustomTool({
      ...aliasInput({ name: 'quote_msgs', target: 'search_messages', fixed: { keywords: '报价, 合同' } }),
    } as never)
    expect(keywords.ok, keywords.error).toBe(true)
    expect(keywords.record?.fixed['keywords']).toEqual(['报价', '合同'])

    const numeric = validateCustomTool({
      ...aliasInput({ name: 'top_msgs', target: 'search_messages', fixed: { limit: '30' } }),
    } as never)
    expect(numeric.record?.fixed['limit']).toBe(30)

    expect(validateCustomTool({
      ...aliasInput({ name: 'bad_bool', target: 'get_moments_stats', fixed: { includeGeo: '可以' } }),
    } as never).error).toContain('true')
    expect(validateCustomTool({
      ...aliasInput({ name: 'bad_num', target: 'search_messages', fixed: { limit: '很多' } }),
    } as never).error).toContain('不是数字')
    expect(validateCustomTool({
      ...aliasInput({ name: 'empty_arr', target: 'search_messages', fixed: { keywords: ' , ' } }),
    } as never).error).toContain('至少一个值')
  })

  it('profile 白名单放行「标了 custom」的工具，但不会顺带放行任意陌生名字', () => {
    const custom = buildCustomTools([answer.record!])[0]!
    const stranger = { ...custom, name: 'not_in_allowlist', custom: undefined }
    expect(filterToolsForProfile('wechat-ask', [custom, stranger as never]).map((tool) => tool.name)).toEqual(['glossary'])
    // 守卫路径也要放行，否则「出现在 schema 里、一调就被拒」
    const guarded = buildProfileTools('wechat-ask', [custom])
    expect(guarded).toHaveLength(1)
  })
})

describe('注册表落库与清单合并', () => {
  it('写入后能读回；删除后消失；启停状态持久', () => {
    const dir = dataRoot()
    const checked = validateCustomTool({ ...aliasInput({ name: 'recent_transfers' }) } as never)
    upsertCustomTool(dir, checked.record!)
    expect(readToolConfig(dir).custom.map((item) => item.name)).toEqual(['recent_transfers'])

    const snapshot = queryLocalTools(dir)
    const card = snapshot.items.find((item) => item.callName === 'recent_transfers')
    expect(card, '自定义工具没有出现在清单里').toBeDefined()
    expect(card?.builtin).toBe(false)
    expect(card?.enabled).toBe(true)
    expect(card?.group).toBe('retrieval')

    expect(deleteCustomTool(dir, 'recent_transfers')).toBe(true)
    expect(readToolConfig(dir).custom).toEqual([])
    expect(queryLocalTools(dir).items.some((item) => item.callName === 'recent_transfers')).toBe(false)
  })

  it('内置工具的覆盖写在另一张表，只改说明与启停（删除自定义不会碰到它）', () => {
    const dir = dataRoot()
    upsertToolOverride(dir, 'search_messages', { title: '消息检索（定制）', description: '改过的说明', enabled: false })
    const card = queryLocalTools(dir).items.find((item) => item.callName === 'search_messages')
    expect(card?.name).toBe('消息检索（定制）')
    expect(card?.description).toBe('改过的说明')
    expect(card?.enabled).toBe(false)
    expect(card?.builtin, '内置工具的卡片必须标 builtin（界面据此不给删除按钮）').toBe(true)

    const checked = validateCustomTool({ name: 'glossary', title: '术语表', description: '本团队口径', kind: 'answer', answer: 'x' } as never)
    upsertCustomTool(dir, checked.record!)
    deleteCustomTool(dir, 'glossary')
    expect(queryLocalTools(dir).items.find((item) => item.callName === 'search_messages')?.enabled).toBe(false)
  })

  it('库还不存在时只读不建库（打开工具页不该凭空造出任务库）', () => {
    const dir = dataRoot()
    expect(readToolConfig(dir).custom).toEqual([])
    expect(queryLocalTools(dir).items.length).toBeGreaterThan(30)
  })
})
