// @vitest-environment node
/**
 * W3-11.7：许可证到期前该不该出声、怎么说。
 *
 * 四条判据（含两条反向哨兵）全是纯数值判断，所以不需要渲染组件：
 *   ① 快到期（0 < 剩余 < 30 天）要出声，且**天数要说出来**；
 *   ② **永久证永不出声** —— 本应用允许永久证，给永久证弹「将到期」是纯噪音；
 *   ③ **已过期不出声** —— 那一档归 `state==='expired'` 的标题，两边都报会让用户看到
 *      两份互相矛盾的过期提示；
 *   ④ 解析不了的日期**不出声**：把坏日期说成「今天到期」比不说更糟。
 */
import { describe, expect, it } from 'vitest'
import {
  LICENSE_EXPIRY_WARN_DAYS, licenseExpiryWarning, missingLicenseFeatures,
} from './license-expiry.ts'

const NOW = Date.parse('2026-10-10T00:00:00Z')
const DAY = 86_400_000

describe('W3-11.7：许可证到期提示', () => {
  it('快到期时出声，且把剩余天数说出来', () => {
    const r = licenseExpiryWarning(new Date(NOW + 7 * DAY).toISOString(), NOW)
    expect(r, '还剩 7 天必须出声').not.toBeNull()
    expect(r?.daysLeft).toBe(7)
    expect(r?.text, '文案里要点明还剩几天').toContain('7')
    expect(r?.text).toContain('续签')
  })

  it('反向哨兵：永久证（没有到期日）永不出声', () => {
    expect(licenseExpiryWarning(null, NOW)).toBeNull()
    expect(licenseExpiryWarning(undefined, NOW)).toBeNull()
    expect(licenseExpiryWarning('', NOW)).toBeNull()
  })

  it('反向哨兵：已过期归「已过期」那一档，这里不再报一遍', () => {
    expect(licenseExpiryWarning(new Date(NOW - DAY).toISOString(), NOW)).toBeNull()
    // 恰好此刻到期也不报（0 天那档只用于「今天内到期」的正向情形，见下一条）
    expect(licenseExpiryWarning(NOW - 1, NOW)).toBeNull()
  })

  it('今天内到期要出声，并且说清是今天', () => {
    const r = licenseExpiryWarning(NOW + 3600_000, NOW)
    expect(r, '今天内到期必须出声').not.toBeNull()
    expect(r?.daysLeft).toBe(0)
    expect(r?.text).toContain('今天到期')
  })

  it('离到期还早（>= 阈值）不出声', () => {
    expect(licenseExpiryWarning(new Date(NOW + LICENSE_EXPIRY_WARN_DAYS * DAY).toISOString(), NOW)).toBeNull()
    expect(licenseExpiryWarning(new Date(NOW + 400 * DAY).toISOString(), NOW)).toBeNull()
  })

  it('坏日期按「未知」处理，不假装今天到期', () => {
    expect(licenseExpiryWarning('不是日期', NOW)).toBeNull()
    expect(licenseExpiryWarning('2026-13-45', NOW)).toBeNull()
  })

  it('缺失能力清单：按差集算，没门禁时是空', () => {
    expect(missingLicenseFeatures(['vector'], ['vector', 'export'])).toEqual([])
    expect(missingLicenseFeatures(['vector', 'rag'], ['vector'])).toEqual(['rag'])
    expect(missingLicenseFeatures([], undefined)).toEqual([])
  })
})