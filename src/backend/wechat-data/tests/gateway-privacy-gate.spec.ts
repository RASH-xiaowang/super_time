/**
 * 隐私闸（#20 第一个协作者）的判据。
 *
 * **2026-09-30：出网拦截已彻底移除。** 那时这个文件断言的是「开关开着 ⇒ 拦下」与
 * 「库读不动 ⇒ 翻成拦下」—— 现在闸门只做两件事：按用户设置脱敏、把放行的调用记进审计。
 * 于是判据换成两条：
 *   ① 脱敏开/关两种状态下**发出去的是什么**、审计记的是哪一个长度；
 *   ② 读不到设置时**不拦也不假装**（按默认值继续发原文）—— 这里已不是权限判断。
 * 末尾再加一条「开关不许回来」的守卫：`cdn-policy.ts` 必须不存在、`gateway-privacy.ts`
 * 的导出必须只剩 `privacyGateAt`、设置快照类型里不许再有那两个位。
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

const { privacyGateAt } = await import('../src/gateway-privacy.ts')

const DIR = '/tmp/does-not-matter-decrypted'
const OFF = { redactSensitive: false }
const ON = { redactSensitive: true }
const stats = { sessions: 3, messages: 42 }

beforeEach(() => {
  audit.readPrivacySettings.mockReset()
  audit.recordPrivacyAudit.mockReset()
  audit.redactSensitiveText.mockReset()
  audit.redactSensitiveText.mockImplementation((t: string) => t.replace(/\d{11}/g, '[手机号]'))
})

describe('privacyGateAt：出站前的脱敏 + 审计，永不拦截', () => {
  it('没开脱敏 ⇒ 原文照发，审计按原文长度记', () => {
    audit.readPrivacySettings.mockReturnValue(OFF)
    const out = privacyGateAt(DIR, 'ask_wechat', stats, ['今天聊了三条'])
    expect(out).toEqual(['今天聊了三条'])
    expect(audit.recordPrivacyAudit).toHaveBeenCalledWith(DIR, 'ask_wechat', '今天聊了三条'.length, 3, 42)
  })

  it('开了脱敏 ⇒ 发出去的是脱敏副本，审计记的也是**副本**的字符数', () => {
    audit.readPrivacySettings.mockReturnValue(ON)
    const raw = '联系 13800138000 处理'
    const out = privacyGateAt(DIR, 'daily_summary', stats, [raw])
    expect(out).toEqual(['联系 [手机号] 处理'])
    const chars = (audit.recordPrivacyAudit.mock.calls[0]?.[2] ?? -1) as number
    expect(chars, '审计记了原文长度 ⇒ 事后看账本以为发了更多敏感内容').toBe('联系 [手机号] 处理'.length)
    expect(chars).not.toBe(raw.length)
  })

  it('多条文本逐条脱敏（一次调用里不许只处理第一条）', () => {
    audit.readPrivacySettings.mockReturnValue(ON)
    const out = privacyGateAt(DIR, 'ask_rerank', stats, ['13800138000', '没事', '13900139000'])
    expect(out).toEqual(['[手机号]', '没事', '[手机号]'])
  })

  it('库读不动 ⇒ **放行原文**（这里已不是权限判断，不该因为库读不动就改变出网行为）', () => {
    audit.readPrivacySettings.mockImplementation(() => { throw new Error('database is locked') })
    const out = privacyGateAt(DIR, 'period_summary', stats, ['原文'])
    expect(out, '读不到设置时既不该拦下、也不该凭空脱敏').toEqual(['原文'])
  })

  it('空文本列表也要过闸（记一次零字符的审计，而不是跳过）', () => {
    audit.readPrivacySettings.mockReturnValue(OFF)
    const out = privacyGateAt(DIR, 'ask_wechat', { sessions: 0, messages: 0 }, [])
    expect(out).toEqual([])
    expect(audit.recordPrivacyAudit).toHaveBeenCalledWith(DIR, 'ask_wechat', 0, 0, 0)
  })
})

describe('开关不许回来（2026-09-30 移除的守卫）', () => {
  it('`cdn-policy.ts` 必须不存在（它是那两个 CDN 开关的判定处）', async () => {
    const { existsSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const p = fileURLToPath(new URL('../src/query/cdn-policy.ts', import.meta.url))
    expect(existsSync(p), '出网开关的判定模块又回来了').toBe(false)
  })

  it('`gateway-privacy.ts` 的运行期导出只有隐私闸与脱敏口径读取（W3-6.2 加了后者）', async () => {
    const mod = await import('../src/gateway-privacy.ts')
    // `redactModeAt` 是 W3-6.2 加的：embedding 缓存要在**命中**时判断口径，
    // 而 `privacyGateAt` 每次都写审计，命中时不该调它。两者读同一份设置，
    // 所以口径判断必须也住在协作者里（类里不许出现 `readPrivacySettings(`）。
    // 除了这两个，其余导出仍然是「开关回来了」的信号。
    expect(Object.keys(mod).sort()).toEqual(['privacyGateAt', 'redactModeAt'])
  })

  it('隐私设置的读写处与快照类型里不再有出网开关的字段', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
      // 剥注释：文件头的历史说明里正当会写「这两个开关已删除」，只有活代码里出现才算回归。
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    const store = read('../src/query/privacy-audit.ts')
    const ops = read('../src/remotes/opslog.ts')
    const types = read('../src/types-ops.ts')
    for (const [name, src] of [['privacy-audit.ts', store], ['remotes/opslog.ts', ops], ['types-ops.ts', types]] as const) {
      for (const key of ['blockOutbound', 'blockMapTiles']) {
        expect(src.includes(key), `${name} 里又出现了 ${key}`).toBe(false)
      }
    }
  })
})
