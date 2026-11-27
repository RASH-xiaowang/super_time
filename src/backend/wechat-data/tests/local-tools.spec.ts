/**
 * 「本地工具」清单的守卫（2026-11-24）。
 *
 * 这一页最容易出的问题不是样式，而是**清单与真源脱钩**：
 *   · 有人加了工具但页面没跟上（清单写死在某处）；
 *   · 或者反过来，页面上列着一个已经不存在的工具。
 *
 * 所以这里从注册表**现算**期望值，再和 `queryLocalTools` 的输出比对：
 * 问答检索 / AI 回复 / RPA 厂商三组都必须逐个对上。本机能力是静态登记，
 * 只钉「关键能力在、状态不撒谎」。
 * @vitest-environment node
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildTools } from '../src/query/tools/registry.ts'
import { REPLY_TOOL_SCHEMAS } from '../src/query/reply-tools/registry.ts'
import { listVendorDescriptors } from '../src/query/rpa/registry.ts'
import { paramSummaries, queryLocalTools } from '../src/query/local-tools.ts'

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 造一个只有 config.json 的数据根（回复工具的就绪状态读它）。 */
function dataRoot(config: Record<string, unknown> | null): string {
  const root = mkdtempSync(join(tmpdir(), 'wx-local-tools-'))
  scratch.push(root)
  const decrypted = join(root, 'wechat-data', 'decrypted')
  mkdirSync(decrypted, { recursive: true })
  if (config !== null) writeFileSync(join(root, 'wechat-data', 'config.json'), JSON.stringify(config), 'utf8')
  return decrypted
}

describe('本地工具清单与注册表一致', () => {
  it('问答检索工具逐个对上（数量、调用名、参数）', () => {
    const snapshot = queryLocalTools(dataRoot(null))
    const items = snapshot.items.filter((item) => item.group === 'retrieval')
    const tools = buildTools()
    expect(items.map((item) => item.callName)).toEqual(tools.map((tool) => tool.name))
    for (const tool of tools) {
      const item = items.find((row) => row.callName === tool.name)
      expect(item, `${tool.name} 没有出现在清单里`).toBeDefined()
      expect(item?.description).toBe(tool.description)
      expect(item?.params.length, `${tool.name} 的参数没投影出来`).toBe(
        paramSummaries(tool.parameters).length,
      )
    }
  })

  it('AI 回复工具逐个对上', () => {
    const snapshot = queryLocalTools(dataRoot(null))
    const items = snapshot.items.filter((item) => item.group === 'reply')
    expect(items.map((item) => item.callName)).toEqual(REPLY_TOOL_SCHEMAS.map((schema) => schema.name))
    for (const schema of REPLY_TOOL_SCHEMAS) {
      expect(items.find((row) => row.callName === schema.name)?.description).toBe(schema.description)
    }
  })

  it('出网触发通道逐个对上（含内置 webhook）', () => {
    const snapshot = queryLocalTools(dataRoot(null))
    const items = snapshot.items.filter((item) => item.group === 'rpa')
    expect(items.map((item) => item.callName)).toEqual(listVendorDescriptors().map((descriptor) => descriptor.id))
    expect(items.every((item) => item.online)).toBe(true)
  })

  it('本机能力包含关键几项，且都标 ready（不猜运行时就绪）', () => {
    const snapshot = queryLocalTools(dataRoot(null))
    const items = snapshot.items.filter((item) => item.group === 'local')
    const names = items.map((item) => item.name)
    for (const expected of ['语音转写', '图片文字识别', '全文检索索引', '聊天记录导出', '备份与恢复']) {
      expect(names.some((name) => name.includes(expected)), `缺少本机能力：${expected}`).toBe(true)
    }
    expect(items.every((item) => item.status === 'ready')).toBe(true)
    expect(items.every((item) => item.source !== '')).toBe(true)
  })

  it('四组都在，且组顺序固定', () => {
    const snapshot = queryLocalTools(dataRoot(null))
    expect(snapshot.groups.map((group) => group.id)).toEqual(['retrieval', 'reply', 'rpa', 'local'])
    expect(snapshot.items.length).toBeGreaterThan(30)
    // id 唯一：前端用它做 React key。
    expect(new Set(snapshot.items.map((item) => item.id)).size).toBe(snapshot.items.length)
  })
})

describe('回复工具的就绪状态跟着本机配置走', () => {
  it('未配置 ⇒ 天气与网页搜索标 needs-config 并写清缺什么', () => {
    const snapshot = queryLocalTools(dataRoot(null))
    const weather = snapshot.items.find((item) => item.callName === 'weather')
    const search = snapshot.items.find((item) => item.callName === 'search_web')
    expect(weather?.status).toBe('needs-config')
    expect(weather?.statusNote ?? '').toContain('天气')
    expect(search?.status).toBe('needs-config')
    expect(search?.statusNote ?? '').toContain('搜索')
  })

  it('配置齐全 ⇒ 两者都是 ready；其余回复工具一直是 ready', () => {
    const snapshot = queryLocalTools(dataRoot({
      reply_weather_provider: 'open-meteo',
      reply_weather_access: 'noncommercial',
      reply_search_provider: 'brave',
    }))
    // 搜索 Key 只存在 secrets.json / 环境变量里：这个夹具没有它 ⇒ 仍应是 needs-config。
    const search = snapshot.items.find((item) => item.callName === 'search_web')
    expect(search?.status).toBe('needs-config')
    expect(search?.statusNote ?? '').toContain('Key')
    const weather = snapshot.items.find((item) => item.callName === 'weather')
    expect(weather?.status).toBe('ready')
    for (const name of ['current_datetime', 'resolve_date', 'calculate', 'convert_units', 'read_public_url']) {
      expect(snapshot.items.find((item) => item.callName === name)?.status).toBe('ready')
    }
  })
})

describe('参数摘要', () => {
  it('按声明顺序、标出必填，并把枚举/范围写成短说明', () => {
    const params = paramSummaries({
      type: 'object',
      properties: {
        city: { type: 'string', maxLength: 40 },
        mode: { type: 'string', enum: ['current', 'forecast'] },
        offsetDays: { type: 'integer', minimum: -36500, maximum: 36500 },
      },
      required: ['city'],
    })
    expect(params.map((param) => param.name)).toEqual(['city', 'mode', 'offsetDays'])
    expect(params[0]).toMatchObject({ required: true, type: 'string', note: '≤ 40 字' })
    expect(params[1]).toMatchObject({ required: false, note: 'current / forecast' })
    expect(params[2]?.note).toContain('~')
  })

  it('没有 properties 时返回空数组（不伪造参数）', () => {
    expect(paramSummaries(undefined)).toEqual([])
    expect(paramSummaries({ type: 'object' })).toEqual([])
  })
})
