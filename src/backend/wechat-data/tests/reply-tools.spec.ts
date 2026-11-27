// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { executeReplyTool, REPLY_TOOL_SCHEMAS, validateReplyToolArgs } from '../src/query/reply-tools/registry.ts'
import { calculateReplyExpression, convertReplyUnits, replyDate } from '../src/query/reply-tools/local.ts'
import { DISABLED_REPLY_TOOLS_CONFIG } from '../src/query/reply-tools/types.ts'
import type { ReplyToolContext } from '../src/query/reply-tools/types.ts'
import { resolveReplyPublicUrl } from '../src/query/reply-tools/public-http.ts'
import { runReplyWithTools, REPLY_TOOL_INPUT_LIMIT, replyToolInputCost } from '../src/query/reply-tools/runtime.ts'
import { createDefaultChatAiReplyGenerator } from '../src/query/ai-reply/generator.ts'
const now = new Date('2026-11-22T16:30:00+08:00')
const config = { ...DISABLED_REPLY_TOOLS_CONFIG, weatherProvider: 'open-meteo', weatherAccess: 'noncommercial' }
const context = (patch: Partial<ReplyToolContext> = {}): ReplyToolContext => ({ publicText: '明天南宁会下雨吗？', config, signal: new AbortController().signal, now: () => now, ...patch })
const geo = { results: [{ name: '南宁', latitude: 22.82, longitude: 108.32, country_code: 'CN', timezone: 'Asia/Shanghai', admin1: '广西' }] }
const forecast = { timezone: 'Asia/Shanghai', daily: { time: ['2026-11-22', '2026-11-23'], precipitation_probability_max: [10, 70], precipitation_sum: [0, 2.4], temperature_2m_max: [26, 25], temperature_2m_min: [18, 19], weather_code: [1, 61] } }
const weatherRead = vi.fn(async (url: string) => ({ contentType: 'application/json', text: JSON.stringify(url.includes('/search') ? geo : forecast) }))
async function* blocks(items: Array<{ name: string; arguments: string; id?: string }> | string): AsyncGenerator<StreamChunk> {
  if (typeof items === 'string') {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: items }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: items } }
    yield { type: 'finish', reason: { kind: 'stop' } }; return
  }
  for (const [index, call] of items.entries()) {
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'block-end', index, block: { type: 'tool-call', ...call, id: (call.id ?? 'call-' + index) as ToolCallId } }
  }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
const options = (signal?: AbortSignal): GenerateOptions => ({ provider: 'test', model: 'test', system: '只返回JSON候选', maxTokens: 320,
  messages: [createUserMessage({ content: [{ type: 'text', text: '明天南宁会下雨吗？' }], source: { kind: 'user' } })], ...(signal ? { signal } : {}) })
function mockLlm(turns: Array<Parameters<typeof blocks>[0]>): { llm: Pick<Context['llm'], 'stream'>; seen: GenerateOptions[] } {
  const seen: GenerateOptions[] = []
  return { seen, llm: { stream: (o: GenerateOptions) => { seen.push(o); return blocks(turns[seen.length - 1] ?? '[]') } } }
}
describe('bounded reply-only public tools', () => {
  it('exposes exactly seven read-only names and strict schema validation', () => {
    expect(REPLY_TOOL_SCHEMAS.map(s => s.name)).toEqual(['weather', 'search_web', 'current_datetime', 'resolve_date', 'calculate', 'convert_units', 'read_public_url'])
    expect(validateReplyToolArgs('weather', { city: '南宁', date: 'tomorrow', send: true })).toBe(false)
    expect(validateReplyToolArgs('calculate', { expression: 3 })).toBe(false)
    expect(validateReplyToolArgs('convert_units', { value: Infinity, from: 'C', to: 'F' })).toBe(false)
    expect(validateReplyToolArgs('shell', {})).toBe(false)
  })
  it.each(['e1', '1e', 'process.exit()', '1/0', '1e999', '2**5', '(()', '1;2', '', '('.repeat(30) + '1' + ')'.repeat(30)])('rejects unsafe/invalid calculations %s', s => { expect(() => calculateReplyExpression(s)).toThrow() })
  it('supports bounded arithmetic and white-listed dimensions', () => {
    expect(calculateReplyExpression('(2+3)*4-50%')).toBe(19.5)
    expect(convertReplyUnits(32, 'F', 'C')).toBe(0)
    expect(convertReplyUnits(1, 'km', 'm')).toBe(1000)
    expect(() => convertReplyUnits(1, 'kg', 'm')).toThrow()
    expect(() => convertReplyUnits(-1, 'K', 'C')).toThrow()
  })
  it('uses the target city timezone across UTC day boundaries', async () => {
    expect(replyDate(new Date('2026-11-22T18:00:00Z'), 'Asia/Shanghai', 1)).toBe('2026-11-24')
    const r = await executeReplyTool('current_datetime', { offsetDays: 1 }, context())
    expect(r).toMatchObject({ ok: true, data: { date: '2026-11-23', timezone: 'Asia/Shanghai' } })
  })
  it('resolves relative dates written in the target message', async () => {
    const dated = context({ publicText: '下周三一起吃饭，明天也行' })
    const next = await executeReplyTool('resolve_date', { expression: '下周三' }, dated)
    expect(next).toMatchObject({ ok: true, data: { date: '2026-11-25', weekday: '星期三', weekend: false } })
    const tomorrow = await executeReplyTool('resolve_date', { expression: '明天' }, dated)
    expect(tomorrow).toMatchObject({ ok: true, data: { date: '2026-11-23', weekday: '星期一' } })
    expect(await executeReplyTool('resolve_date', { expression: '下周三' }, context({ publicText: '今天有空吗' }))).toMatchObject({ ok: false, code: 'date_not_in_target' })
    expect(await executeReplyTool('resolve_date', { expression: '随便哪天' }, context({ publicText: '随便哪天' }))).toMatchObject({ ok: false, code: 'invalid_date' })
  })
  it('requires an explicit provider/licence contract, not model API keys', async () => {
    const read = vi.fn()
    expect(await executeReplyTool('weather', { city: '南宁', date: 'tomorrow' }, context({ config: DISABLED_REPLY_TOOLS_CONFIG, read }))).toMatchObject({ ok: false, code: 'weather_provider_not_configured' })
    expect(await executeReplyTool('weather', { city: '南宁', date: 'tomorrow' }, context({ config: { ...config, weatherAccess: '' }, read }))).toMatchObject({ code: 'weather_license_mode_required' })
    expect(await executeReplyTool('weather', { city: '南宁', date: 'tomorrow' }, context({ config: { ...config, weatherAccess: 'commercial' }, read }))).toMatchObject({ code: 'weather_key_missing' })
    expect(read).not.toHaveBeenCalled()
  })
  it('returns dated, unit-labelled real-provider contract data and attribution', async () => {
    weatherRead.mockClear()
    const r = await executeReplyTool('weather', { city: '南宁', date: 'tomorrow', countryCode: 'CN' }, context({ read: weatherRead }))
    expect(r).toMatchObject({ ok: true, data: { kind: 'forecast', date: '2026-11-23', timezone: 'Asia/Shanghai', rainProbabilityPercent: 70, precipitationMm: 2.4, temperatureMinC: 19, providerIssuedAt: null }, sources: [{ title: expect.stringContaining('Open-Meteo'), date: '2026-11-23' }] })
    expect(weatherRead).toHaveBeenCalledTimes(2)
    expect(weatherRead.mock.calls.every(([u]) => !u.includes('明天') && !u.includes('对方'))).toBe(true)
  })
  it('does not leak commercial weather keys into public sources', async () => {
    const r = await executeReplyTool('weather', { city: '南宁', date: 'tomorrow' }, context({ read: weatherRead, config: { ...config, weatherAccess: 'commercial', weatherApiKey: 'synthetic-weather-secret' } }))
    expect(r.ok).toBe(true)
    expect(JSON.stringify(r)).not.toContain('synthetic-weather-secret')
  })
  it('handles city ambiguity, no results, missing dates and missing numeric data', async () => {
    const read = (body: unknown): ReplyToolContext['read'] => async () => ({ text: JSON.stringify(body), contentType: 'application/json' })
    expect(await executeReplyTool('weather', { city: '南宁', date: 'tomorrow' }, context({ read: read({ results: [...geo.results, ...geo.results] }) }))).toMatchObject({ code: 'weather_city_ambiguous' })
    expect(await executeReplyTool('weather', { city: '南宁', date: 'tomorrow' }, context({ read: read({ results: [] }) }))).toMatchObject({ code: 'weather_city_not_found' })
    expect(await executeReplyTool('weather', { city: '北京', date: 'tomorrow' }, context({ read: weatherRead }))).toMatchObject({ code: 'city_not_in_target' })
    expect(await executeReplyTool('weather', { city: '南宁', date: '2020-01-01' }, context({ read: weatherRead }))).toMatchObject({ code: 'weather_date_target_mismatch' })
    const incomplete = async (u: string) => ({ text: JSON.stringify(u.includes('/search') ? geo : { timezone: 'Asia/Shanghai', daily: { time: ['2026-11-22', '2026-11-23'], precipitation_probability_max: [null, null] } }), contentType: 'application/json' })
    expect(await executeReplyTool('weather', { city: '南宁', date: 'tomorrow' }, context({ read: incomplete }))).toMatchObject({ code: 'weather_forecast_incomplete' })
  })
  it('reports provider failures without leaking response secrets', async () => {
    const r = await executeReplyTool('weather', { city: '南宁', date: 'tomorrow' }, context({ read: async () => { throw new Error('HTTP response SECRET') } }))
    expect(r).toEqual({ ok: false, code: 'tool_unavailable' })
  })
  it('classifies DNS/connection failures as tool_network with a sanitized reason', async () => {
    // 真实现场：天气配好了却查不到，原因是 DNS 失败，而旧实现把它归成 tool_unavailable，
    // 界面上完全看不出该查网络还是改配置。
    const dns = await executeReplyTool('weather', { city: '南宁', date: 'tomorrow' }, context({
      read: async () => { throw Object.assign(new Error('getaddrinfo EAI_AGAIN geocoding-api.open-meteo.com'), { code: 'EAI_AGAIN' }) },
    }))
    expect(dns).toMatchObject({ ok: false, code: 'tool_network', data: { reason: 'EAI_AGAIN' } })
    // 脱敏：reason 只留系统错误码，绝不带主机名/URL/查询串
    expect(JSON.stringify(dns)).not.toContain('open-meteo')

    const refused = await executeReplyTool('search_web', { query: '南宁新闻' }, context({
      config: { ...config, searchProvider: 'brave', searchApiKey: 'k' },
      publicText: '南宁新闻',
      read: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) },
    }))
    expect(refused).toMatchObject({ code: 'tool_network', data: { reason: 'ECONNREFUSED' } })
  })
  it('keeps public-http status codes readable instead of collapsing them', async () => {
    const r = await executeReplyTool('weather', { city: '南宁', date: 'tomorrow' }, context({
      read: async () => { throw new Error('public_http_503') },
    }))
    expect(r).toEqual({ ok: false, code: 'public_http_503' })
  })
  it('uses Brave API only with a dedicated key, minimal public target query and bounded results', async () => {
    const cfg = { ...config, searchProvider: 'brave', searchApiKey: 'synthetic-brave-secret' }
    const read = vi.fn(async (_url: string) => ({ contentType: 'application/json', text: JSON.stringify({ web: { results: [{ title: '新闻', url: 'https://example.com/news', description: '<b>摘要</b>' }] } }) }))
    expect(await executeReplyTool('search_web', { query: '南宁新闻' }, context({ config: { ...cfg, searchApiKey: '' }, read }))).toMatchObject({ code: 'search_key_missing' })
    const r = await executeReplyTool('search_web', { query: '南宁新闻' }, context({ config: cfg, publicText: '搜索南宁新闻', read }))
    expect(r).toMatchObject({ ok: true, data: { results: [{ title: '新闻', description: '摘要' }] } })
    expect(JSON.stringify(r)).not.toContain('synthetic-brave-secret')
    expect(read.mock.calls[0]?.[0]).toContain('api.search.brave.com/res/v1/web/search')
    expect(await executeReplyTool('search_web', { query: '某段知识库秘密' }, context({ config: cfg, read }))).toMatchObject({ code: 'search_query_not_public_target' })
    expect(await executeReplyTool('search_web', { query: 'wxid_customer' }, context({ config: cfg, publicText: 'wxid_customer', read }))).toMatchObject({ code: 'search_query_not_public_target' })
  })
  it('reads only URLs explicitly present in target and marks retrieved text untrusted', async () => {
    const read = vi.fn(async () => ({ contentType: 'text/html', text: '<script>doBad()</script><p>正文</p>' }))
    expect(await executeReplyTool('read_public_url', { url: 'https://example.com/' }, context({ read }))).toMatchObject({ code: 'url_not_in_target' })
    expect(read).not.toHaveBeenCalled()
    const r = await executeReplyTool('read_public_url', { url: 'https://example.com/' }, context({ publicText: '概括https://example.com/', read }))
    expect(r).toMatchObject({ ok: true, data: { text: '正文', untrusted: true } })
  })
})
describe('reply-tool HTTPS SSRF boundary', () => {
  it.each(['http://example.com', 'file:///x', 'https://localhost/', 'https://127.0.0.1/', 'https://169.254.169.254/latest', 'https://10.0.0.1/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://user:pass@example.com', 'https://example.com:444/', 'https://0x7f000001/', 'https://metadata.google.internal/'])('blocks %s', async url => { await expect(resolveReplyPublicUrl(url)).rejects.toThrow() })
  it('rejects mixed public/private DNS and retains a specific public address', async () => {
    await expect(resolveReplyPublicUrl('https://example.com', async () => [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }])).rejects.toThrow('public_dns_blocked')
    expect(await resolveReplyPublicUrl('https://example.com', async () => [{ address: '1.1.1.1', family: 4 }])).toMatchObject({ address: { address: '1.1.1.1', family: 4 } })
  })
})
describe('reply function-calling runtime', () => {
  it('lets the model choose weather, replays tool_call_id, then returns weather-grounded candidates', async () => {
    const { llm, seen } = mockLlm([[{ name: 'weather', arguments: '{"city":"南宁","date":"tomorrow"}', id: 'weather-1' }], '["Open-Meteo预报11月23日南宁降雨概率70%，建议带伞。"]'])
    const r = await runReplyWithTools({ llm, options: options(), context: context({ read: weatherRead }), outputMode: 'candidates' })
    expect(r.text).toContain('70%'); expect(r.observations).toMatchObject([{ name: 'weather', ok: true }])
    expect(seen).toHaveLength(2)
    expect(seen[1]?.messages[2]?.content).toMatchObject([{ type: 'tool-result', toolCallId: 'weather-1' }])
    expect(seen.every(o => replyToolInputCost(o.system ?? '', o.messages, !!o.tools) <= REPLY_TOOL_INPUT_LIMIT)).toBe(true)
    expect(r.sources[0]?.date).toBe('2026-11-23')
  })
  it('supports multi-call provider responses with one result for every id', async () => {
    const { llm, seen } = mockLlm([[{ name: 'calculate', arguments: '{"expression":"1+1"}', id: 'a' }, { name: 'convert_units', arguments: '{"value":1,"from":"km","to":"m"}', id: 'b' }], '2;1000m'])
    const r = await runReplyWithTools({ llm, options: options(), context: context({ publicText: '计算1+1并把1km换成m' }), outputMode: 'reply' })
    expect(r.text).toBe('2;1000m')
    expect(seen[1]?.messages.slice(2).map(m => (m.content[0] as { toolCallId: string }).toolCallId)).toEqual(['a', 'b'])
  })
  it('runs tools from the same round together without swapping their result order', async () => {
    let active = 0
    let maxActive = 0
    const read = vi.fn(async (url: string) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 30))
      active -= 1
      if (url.includes('/search')) return { contentType: 'application/json', text: JSON.stringify(geo) }
      if (url.includes('example.com')) return { contentType: 'text/html', text: '<p>公开说明</p>' }
      return { contentType: 'application/json', text: JSON.stringify(forecast) }
    })
    const { llm } = mockLlm([[
      { name: 'weather', arguments: '{"city":"南宁","date":"tomorrow"}', id: 'w' },
      { name: 'read_public_url', arguments: '{"url":"https://example.com/a"}', id: 'u' },
    ], '一起查完'])
    const r = await runReplyWithTools({
      llm,
      options: options(),
      context: context({ publicText: '明天南宁会下雨吗？ https://example.com/a', read }),
      outputMode: 'reply',
    })
    expect(maxActive).toBeGreaterThan(1)
    expect(r.observations.map(item => item.name)).toEqual(['weather', 'read_public_url'])
    expect(r.text).toBe('一起查完')
  })
  it('keeps ordinary no-tool model text and handles unsupported-tools explicitly', async () => {
    const plain = mockLlm(['你好'])
    expect((await runReplyWithTools({ llm: plain.llm, options: options(), context: context({ publicText: '你好' }), outputMode: 'reply' })).text).toBe('你好')
    let calls = 0
    const seen: GenerateOptions[] = []
    const llm = { stream: (o: GenerateOptions) => { seen.push(o); if (++calls === 1) return (async function* (): AsyncGenerator<StreamChunk> { throw new Error('tools not supported') })(); return blocks('你好') } }
    const r = await runReplyWithTools({ llm, options: options(), context: context({ publicText: '你好' }), outputMode: 'reply' })
    expect(r).toMatchObject({ text: '你好', degraded: 'tools_not_supported' }); expect(seen[1]?.tools).toBeUndefined()
  })
  it('rejects invented weather if the model skips tools or tools are not configured', async () => {
    const { llm } = mockLlm(['["明天一定下雨99%"]'])
    const r = await runReplyWithTools({ llm, options: options(), context: context(), outputMode: 'candidates' })
    expect(r.text).not.toContain('99%'); expect(r.text).toContain('无法查到实时天气'); expect(r.modelText).toContain('99%')
  })
  it('returns structured tool errors to the model so it can recover with a valid call', async () => {
    const { llm } = mockLlm([[{ name: 'calculate', arguments: '{"expression":"1/0"}', id: 'bad-1' }], [{ name: 'calculate', arguments: '{"expression":"2+2"}', id: 'good-2' }], '4'])
    const r = await runReplyWithTools({ llm, options: options(), context: context({ publicText: '计算2+2' }), outputMode: 'reply' })
    expect(r.observations).toMatchObject([{ ok: false, code: 'divide_by_zero' }, { ok: true }]); expect(r.text).toBe('4')
  })
  it('limits rounds, argument size and schema errors', async () => {
    const loop = mockLlm(Array.from({ length: 5 }, (_, i) => [{ name: 'calculate', arguments: '{"expression":"1+1"}', id: 'round-' + i }]))
    await expect(runReplyWithTools({ llm: loop.llm, options: options(), context: context({ publicText: '计算' }), outputMode: 'reply' })).rejects.toThrow('上限')
    expect(loop.seen).toHaveLength(4)
    const invalid = mockLlm([[{ name: 'shell', arguments: '{"command":"bad"}' }], '不可用'])
    expect((await runReplyWithTools({ llm: invalid.llm, options: options(), context: context({ publicText: '计算' }), outputMode: 'reply' })).observations).toMatchObject([{ ok: false, code: 'invalid_tool_arguments' }])
  })
  it('counts tool descriptions/results in the same budget and does not increase it', async () => {
    const { llm, seen } = mockLlm(['完成'])
    const o = options(); o.system = '长'.repeat(REPLY_TOOL_INPUT_LIMIT + 1)
    await expect(runReplyWithTools({ llm, options: o, context: context(), outputMode: 'reply' })).rejects.toThrow('预算超限')
    expect(seen).toHaveLength(0)
  })
  it('times out tools, then permits a bounded model recovery without forging success', async () => {
    const { llm } = mockLlm([[{ name: 'weather', arguments: '{"city":"南宁","date":"tomorrow"}' }], '无法查到'])
    const r = await runReplyWithTools({ llm, options: options(), context: context({ read: async () => await new Promise(() => undefined) }), outputMode: 'candidates', limits: { toolMs: 10 } })
    expect(r.observations).toMatchObject([{ ok: false, code: 'tool_timeout' }]); expect(r.sources).toEqual([])
  })
  it('propagates cancellation without a second model/tool call', async () => {
    const controller = new AbortController(); const read = vi.fn(async () => { controller.abort(); return { text: JSON.stringify(geo), contentType: 'application/json' } })
    const { llm, seen } = mockLlm([[{ name: 'weather', arguments: '{"city":"南宁","date":"tomorrow"}' }], '不应生成'])
    await expect(runReplyWithTools({ llm, options: options(controller.signal), context: context({ read }), outputMode: 'reply' })).rejects.toThrow('取消')
    expect(read).toHaveBeenCalledTimes(1); expect(seen).toHaveLength(1)
  })
  it('routes automatic-reply generation through the SAME runtime with no dispatch APIs', async () => {
    const { llm, seen } = mockLlm([[{ name: 'calculate', arguments: '{"expression":"1+1"}' }], '等于2'])
    const ctx = { llm, agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) } } as unknown as Context
    const generate = createDefaultChatAiReplyGenerator({ ctx: () => ctx, toolConfig: () => config })
    const r = await generate({ system: '简短回复', prompt: '1+1?', publicText: '计算1+1', accountKey: 'synthetic', chatUsername: 'synthetic' })
    expect(r).toMatchObject({ ok: true, text: '等于2', toolCalls: [{ name: 'calculate', ok: true }] })
    expect(seen).toHaveLength(2)
  })
})
