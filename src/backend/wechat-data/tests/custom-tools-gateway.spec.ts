/**
 * 自定义工具的**整条链路**：从 Remote 走进注册表，再被问答链路取到并执行。
 *
 * 单测各段都对、合起来不能用，是这一族最典型的故障形态（0.7 版实测踩过两种）：
 *  ① 界面新建时没带 `name` ⇒ 后端只回「工具名需为…」，用户无从下手；
 *  ② 建出来之后 `custom: true` 没带上 ⇒ 会被 profile 白名单过滤掉，工具在清单里看得见、
 *     模型却永远拿不到它。
 *
 * 所以这里不拆开验，而是走真实的网关方法：建 → 查清单 → 装配成工具集 → 真跑一次 → 删。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { WechatDataGateway } from '../src/gateway.ts'
import { buildCustomTools } from '../src/query/custom-tools.ts'
import { readToolConfig } from '../src/query/tool-config-store.ts'
import { buildProfileTools } from '../src/query/tools/profiles.ts'
import { runTool } from '../src/query/tools/registry.ts'
import type { ToolContext } from '../src/query/tools/types.ts'

const scratch: string[] = []
let disposers: Array<() => void> = []

afterEach(() => {
  for (const d of disposers.splice(0)) d()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 与其它网关 spec 同款的最小 Cordis Context 面。 */
function fakeCtx(): Context {
  const effects: Array<() => void> = []
  disposers = effects
  return {
    reflect: { provide: () => {} },
    effect: (fn: () => undefined | (() => void)) => {
      const d = fn()
      if (typeof d === 'function') effects.push(d)
      return d
    },
    emit: () => {},
  } as unknown as Context
}

/** 起一个真网关（临时数据根，不碰真实微信数据）。 */
function gateway(): { gw: WechatDataGateway; decrypted: string } {
  const root = mkdtempSync(join(tmpdir(), 'wx-custom-gateway-'))
  scratch.push(root)
  const decrypted = join(root, 'wechat-data', 'decrypted')
  const decoded = join(root, 'wechat-data', 'decoded_images')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(decoded, { recursive: true })
  process.env['DSH_WECHAT_DECRYPTED_DIR'] = decrypted
  process.env['DSH_WECHAT_DECODED_DIR'] = decoded
  return { gw: new WechatDataGateway(fakeCtx()), decrypted }
}

describe('自定义工具：建 → 查 → 跑 → 停 → 删', () => {
  it('新建固定文本工具后：清单有它、问答工具集能拿到、执行能返回正文', async () => {
    const { gw, decrypted } = gateway()
    const saved = gw.saveLocalTool({
      name: 'glossary',
      isNew: true,
      title: '术语表',
      description: '本团队对「回款」的定义；问到这个词时先看它。',
      kind: 'answer',
      answer: '回款：客户已付款、但我们还没收到银行到账。',
    })
    expect(saved.ok, saved.error).toBe(true)
    expect(saved.item?.callName).toBe('glossary')
    expect(saved.item?.builtin).toBe(false)

    // ① 卡片清单里能看到（用户在界面上确认「建成了」的唯一依据）
    const card = gw.getLocalTools().items.find((item) => item.callName === 'glossary')
    expect(card, '新建的工具没有出现在清单里').toBeDefined()
    expect(card?.enabled).toBe(true)
    expect(card?.group).toBe('retrieval')

    // ② 装配成工具集：必须带 custom 标记，否则会被 profile 白名单滤掉
    const tools = buildCustomTools(readToolConfig(decrypted).custom)
    expect(tools).toHaveLength(1)
    expect(tools[0]?.custom).toBe(true)
    expect(buildProfileTools('wechat-ask', tools)).toHaveLength(1)

    // ③ 真跑一次（走注册表的统一入口，带异常兜底）
    const result = await runTool(tools, 'glossary', {}, {} as unknown as ToolContext)
    expect(result.ok, result.error).toBe(true)
    expect(result.hits[0]?.snippet).toContain('客户已付款')
  })

  it('预设封装：固定参数从 schema 里消失，模型只看到剩下的', () => {
    const { gw } = gateway()
    const saved = gw.saveLocalTool({
      name: 'recent_records',
      isNew: true,
      title: '最近转账',
      description: '查最近的转账明细；时间范围已固定，不要再传 from/to。',
      kind: 'alias',
      target: 'search_records',
      fixed: { from: '2026-08-01' },
    })
    expect(saved.ok, saved.error).toBe(true)
    const card = gw.getLocalTools().items.find((item) => item.callName === 'recent_records')
    expect(card?.kind).toBe('alias')
    expect(card?.target).toBe('search_records')
    expect(card?.params.map((param) => param.name), '固定住的参数仍然暴露给模型').not.toContain('from')
  })

  it('同名新建被拒；编辑同名允许（不能静默覆盖）', () => {
    const { gw } = gateway()
    const first = { name: 'glossary', title: '术语表', description: '定义', kind: 'answer' as const, answer: '甲' }
    expect(gw.saveLocalTool({ ...first, isNew: true }).ok).toBe(true)
    const dup = gw.saveLocalTool({ ...first, isNew: true, title: '又一个术语表' })
    expect(dup.ok).toBe(false)
    expect(dup.error).toContain('已经有一个')
    expect(gw.saveLocalTool({ ...first, title: '术语表（改）' }).ok).toBe(true)
    expect(gw.getLocalTools().items.find((item) => item.callName === 'glossary')?.name).toBe('术语表（改）')
  })

  it('停用后从工具集里消失，启用后回来；内置工具不能删', async () => {
    const { gw, decrypted } = gateway()
    gw.saveLocalTool({ name: 'glossary', isNew: true, title: '术语表', description: '定义', kind: 'answer', answer: '甲' })
    expect(gw.setLocalToolEnabled({ name: 'glossary', enabled: false }).ok).toBe(true)
    expect(buildCustomTools(readToolConfig(decrypted).custom)).toHaveLength(0)
    expect(gw.getLocalTools().items.find((item) => item.callName === 'glossary')?.enabled).toBe(false)

    expect(gw.setLocalToolEnabled({ name: 'glossary', enabled: true }).ok).toBe(true)
    expect(buildCustomTools(readToolConfig(decrypted).custom)).toHaveLength(1)

    // 内置工具：删除必须被拒（结构上它们不在表里，删不掉）
    const rejected = gw.deleteLocalTool({ name: 'search_messages' })
    expect(rejected.ok).toBe(false)
    expect(rejected.error).toContain('默认工具')
    expect(gw.getLocalTools().items.some((item) => item.callName === 'search_messages')).toBe(true)
  })

  it('删除自定义工具后清单与工具集都干净', () => {
    const { gw, decrypted } = gateway()
    gw.saveLocalTool({ name: 'glossary', isNew: true, title: '术语表', description: '定义', kind: 'answer', answer: '甲' })
    expect(gw.deleteLocalTool({ name: 'glossary' }).ok).toBe(true)
    expect(gw.getLocalTools().items.some((item) => item.callName === 'glossary')).toBe(false)
    expect(readToolConfig(decrypted).custom).toEqual([])
    // 再删一次要如实说「不存在」，不能假装成功
    expect(gw.deleteLocalTool({ name: 'glossary' }).ok).toBe(false)
  })

  it('不允许把问答工具全部停用（全停之后问答拿不到任何工具）', () => {
    const { gw } = gateway()
    const custom = { name: 'glossary', isNew: true, title: '术语表', description: '定义', kind: 'answer' as const, answer: '甲' }
    gw.saveLocalTool(custom)
    expect(gw.setLocalToolEnabled({ name: 'glossary', enabled: false }).ok, '还有内置工具时就该允许停用').toBe(true)
    // 现在停掉最后一个启用的内置工具：应当被安全阀拒绝
    const builtins = gw.getLocalTools().items.filter((item) => item.builtin && item.group === 'retrieval' && item.enabled)
    expect(builtins.length, '内置检索工具应当不止一个').toBeGreaterThan(1)
    for (const item of builtins.slice(0, -1)) {
      expect(gw.setLocalToolEnabled({ name: item.callName as string, enabled: false }).ok).toBe(true)
    }
    const last = builtins.at(-1)!
    const denied = gw.setLocalToolEnabled({ name: last.callName as string, enabled: false })
    expect(denied.ok).toBe(false)
    expect(denied.error).toContain('至少')
  })
})
