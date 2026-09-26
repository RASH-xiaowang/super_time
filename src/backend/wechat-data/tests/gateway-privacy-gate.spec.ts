/**
 * 隐私闸（#20 第一个协作者）的判据。
 *
 * 为什么这一份不是"给搬走的代码补测"：改前这三件事住在 986 行的 `GatewayCore` 里，
 * 想断「库读不动时方向对不对」就必须起一个真网关 —— 本仓对它的覆盖全是
 * `outbound-gates.spec.ts` 那种"起整个网关"级别的用例，于是**判断本身**的四态
 * （开 / 关 / 读不动 / 两次读之间坏掉）一直没人逐钉。搬成以目录为参数的函数之后，
 * 四态可以各喂一次。
 *
 * 三条失败方向必须全部偏保守：这是权限判断，出错的方向只能是"少发数据"。
 * @module gateway-privacy-gate
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const audit = vi.hoisted(() => ({
  readPrivacySettings: vi.fn(),
  recordPrivacyAudit: vi.fn(),
  redactSensitiveText: vi.fn((t: string) => t.replace(/\d{11}/g, '[手机号]')),
}))
vi.mock('../src/query/privacy-audit.ts', () => audit)

const { DEFAULT_OUTBOUND_DETAIL, outboundBlockedAt, privacyBlockedAt, privacyGateAt } = await import('../src/gateway-privacy.ts')
const { privacyStoreUnreadable } = await import('../src/gateway-support.ts')

const DIR = '/tmp/does-not-matter-decrypted'
const OFF = { redactSensitive: false, blockOutbound: false, blockMapTiles: false }
const ON = { redactSensitive: false, blockOutbound: true, blockMapTiles: false }

beforeEach(() => {
  audit.readPrivacySettings.mockReset()
  audit.recordPrivacyAudit.mockReset()
  audit.redactSensitiveText.mockReset()
  audit.redactSensitiveText.mockImplementation((t: string) => t.replace(/\d{11}/g, '[手机号]'))
})

describe('outboundBlockedAt：只回答一个是非问题', () => {
  it('开关关着 ⇒ 不拦', () => {
    audit.readPrivacySettings.mockReturnValue(OFF)
    expect(outboundBlockedAt(DIR)).toBe(false)
  })

  it('开关开着 ⇒ 拦', () => {
    audit.readPrivacySettings.mockReturnValue(ON)
    expect(outboundBlockedAt(DIR)).toBe(true)
  })

  it('库读不动 ⇒ **按拦下处理**（这条是权限判断，静默放行是最糟的结果）', () => {
    audit.readPrivacySettings.mockImplementation(() => { throw new Error('database is locked') })
    expect(outboundBlockedAt(DIR), '读不到就放行 ⇒ 开着拦截的用户在库被锁那一刻把数据发了出去').toBe(true)
  })
})

describe('privacyBlockedAt：给用户看的文案', () => {
  it('未开启 ⇒ null（放行）', () => {
    audit.readPrivacySettings.mockReturnValue(OFF)
    expect(privacyBlockedAt(DIR, '每日总结')).toBeNull()
  })

  it('开启 ⇒ 文案点名功能与这条出网在做什么', () => {
    audit.readPrivacySettings.mockReturnValue(ON)
    const msg = privacyBlockedAt(DIR, '每日总结', '把聊天内容交给模型') ?? ''
    expect(msg).toContain('出站拦截')
    expect(msg).toContain('每日总结')
    expect(msg).toContain('把聊天内容交给模型')
  })

  it('没说做什么 ⇒ 用默认那句（三处调用点共用同一字面量，别再各写一份）', () => {
    audit.readPrivacySettings.mockReturnValue(ON)
    expect(privacyBlockedAt(DIR, '问答') ?? '').toContain(DEFAULT_OUTBOUND_DETAIL)
  })

  it('库读不动 ⇒ 不是 null 也不是放行，而是「读不到所以拦住」的专门文案', () => {
    audit.readPrivacySettings.mockImplementation(() => { throw new Error('no such table') })
    const msg = privacyBlockedAt(DIR, '问答') ?? ''
    expect(msg).toBe(privacyStoreUnreadable('问答', DEFAULT_OUTBOUND_DETAIL))
    expect(msg).not.toContain('已开启')
  })
})

describe('privacyGateAt：出站前的最后一道', () => {
  const stats = { sessions: 3, messages: 42 }

  it('放行时原文照发，并把审计按**原文**长度记下来', () => {
    audit.readPrivacySettings.mockReturnValue(OFF)
    const r = privacyGateAt(DIR, 'ask_wechat', stats, ['今天聊了三条'])
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.ok === true && r.texts).toEqual(['今天聊了三条'])
    expect(audit.recordPrivacyAudit).toHaveBeenCalledWith(DIR, 'ask_wechat', '今天聊了三条'.length, 3, 42)
  })

  it('开了脱敏 ⇒ 发出去的是脱敏副本，审计记的也是**副本**的字符数', () => {
    audit.readPrivacySettings.mockReturnValue({ ...OFF, redactSensitive: true })
    const raw = '联系 13800138000 处理'
    const r = privacyGateAt(DIR, 'daily_summary', stats, [raw])
    expect(r.ok === true && r.texts).toEqual(['联系 [手机号] 处理'])
    const chars = (audit.recordPrivacyAudit.mock.calls[0]?.[2] ?? -1) as number
    expect(chars, '审计记了原文长度 ⇒ 事后看账本以为发了更多敏感内容').toBe('联系 [手机号] 处理'.length)
    expect(chars).not.toBe(raw.length)
  })

  it('被拦截 ⇒ 一条审计都不记（拦下来的东西不该进"已出站"的账）', () => {
    audit.readPrivacySettings.mockReturnValue(ON)
    const r = privacyGateAt(DIR, 'summary_task', stats, ['a'])
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('出站拦截')
    expect(audit.recordPrivacyAudit).not.toHaveBeenCalled()
  })

  it('两次读之间库坏掉（竞态）⇒ 仍然拦下，且不带着「默认不脱敏」把原文发出去', () => {
    audit.readPrivacySettings.mockReturnValueOnce(OFF).mockImplementationOnce(() => { throw new Error('库被删了') })
    const r = privacyGateAt(DIR, 'period_summary', stats, ['原文'])
    expect(r.ok, '第二次读失败当成"设置读不到就算没开" ⇒ 直接放行原文').toBe(false)
    expect(r.ok === false && r.error).toBe(privacyStoreUnreadable('period_summary', DEFAULT_OUTBOUND_DETAIL))
  })

  it('空文本列表也要过闸（记一次零字符的审计，而不是跳过）', () => {
    audit.readPrivacySettings.mockReturnValue(OFF)
    const r = privacyGateAt(DIR, 'ask_wechat', { sessions: 0, messages: 0 }, [])
    expect(r.ok).toBe(true)
    expect(audit.recordPrivacyAudit).toHaveBeenCalledWith(DIR, 'ask_wechat', 0, 0, 0)
  })
})

describe('唯一出处：不许再绕过闸直接读开关', () => {
  it('除 `gateway-privacy.ts` 与 settings 自己的读写处之外，没人再读 `readPrivacySettings(...).blockOutbound`', async () => {
    // 这条是本次搬迁的防回归点：判断搬出来了，但**下一个人还可以就地再读一次**，
    // 那就又回到「同一个开关三处各自解释」的样子（第 59 轮那批漏闸正是这么来的）。
    const { readdirSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    // Windows 下 `new URL(...).pathname` 会变成 `/D:/...`，node 的 fs 不认（工具记忆：路径要用 fileURLToPath）
    const srcDir = fileURLToPath(new URL('../src', import.meta.url))
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.ts')) files.push(p)
      }
    }
    walk(srcDir)
    const offenders = files
      .filter((p) => !/[\\/]gateway-privacy\.ts$/.test(p) && !/[\\/]query[\\/]privacy-audit\.ts$/.test(p))
      .filter((p) => readFileSync(p, 'utf8').includes('readPrivacySettings('))
    expect(offenders.map((p) => p.replace(srcDir, 'src')), '这些地方又直接读隐私设置了 ⇒ 闸被绕过：'
      + offenders.join(', ')).toEqual([])
  })
})
