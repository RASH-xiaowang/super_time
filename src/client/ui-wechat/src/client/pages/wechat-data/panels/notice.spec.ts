/**
 * 主动提醒条的判定口径。
 *
 * 守的是「该说的时候一定说、不该说的时候一个字都别乱说」：
 * 更新只在已下载/下载中提示（available 不单列，autoDownload 恒真会立刻转 downloading）；
 * 许可证在 ≤30 天 / ≤7 天 / 已过期三档各有不同强度的文案，永久证一个字都不提。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { buildNotices, noticeForLicense, noticeForUpdate } from './notice.ts'

describe('新版本提示', () => {
  it('已下载 → 提醒重启安装，带回执动作', () => {
    const n = noticeForUpdate({ phase: 'downloaded', version: '1.4.0' })
    expect(n?.tone).toBe('warn')
    expect(n?.title).toContain('v1.4.0')
    expect(n?.actions).toEqual(['install'])
  })

  it('下载中 → 只报进度，不给动作', () => {
    const n = noticeForUpdate({ phase: 'downloading', version: '1.4.0', progress: { percent: 37.4 } })
    expect(n?.tone).toBe('info')
    expect(n?.detail).toContain('37%')
    expect(n?.actions).toEqual([])
  })

  it('进度取整是四舍五入（.6 进位）', () => {
    expect(noticeForUpdate({ phase: 'downloading', progress: { percent: 37.6 } })?.detail).toContain('38%')
  })

  it('进度缺失时按 0% 报，不出现 NaN', () => {
    const n = noticeForUpdate({ phase: 'downloading' })
    expect(n?.detail).toContain('0%')
    expect(n?.detail).not.toContain('NaN')
  })

  it('其余阶段一律不提醒', () => {
    for (const phase of ['idle', 'unsupported', 'checking', 'available', 'up-to-date', 'error']) {
      expect(noticeForUpdate({ phase }), `phase=${phase} 不该提醒`).toBeNull()
    }
  })

  it('拿不到状态时不编造提醒', () => {
    expect(noticeForUpdate(null)).toBeNull()
  })

  it('版本号缺失时文案不留空档', () => {
    const n = noticeForUpdate({ phase: 'downloaded' })
    expect(n?.title).toContain('新版本')
    expect(n?.title).not.toContain('v ')
  })
})

describe('许可证临期提示', () => {
  it('永久证（daysToExpiry 为 null）不提醒', () => {
    expect(noticeForLicense({ licensed: true, state: 'licensed', daysToExpiry: null })).toBeNull()
  })

  it('>30 天不提醒', () => {
    expect(noticeForLicense({ licensed: true, state: 'licensed', daysToExpiry: 31 })).toBeNull()
    expect(noticeForLicense({ licensed: true, state: 'licensed', daysToExpiry: 365 })).toBeNull()
  })

  it('30 天起浅提醒（含边界）', () => {
    const n = noticeForLicense({ licensed: true, state: 'licensed', daysToExpiry: 30 })
    expect(n?.tone).toBe('warn')
    expect(n?.title).toContain('30 天')
    expect(n?.actions).toEqual(['export-request', 'open-license'])
  })

  it('7 天起转强提醒（含边界）', () => {
    expect(noticeForLicense({ licensed: true, state: 'licensed', daysToExpiry: 7 })?.tone).toBe('danger')
    expect(noticeForLicense({ licensed: true, state: 'licensed', daysToExpiry: 8 })?.tone).toBe('warn')
  })

  it('还剩 0 天仍是强提醒，但文案不说「已过期」', () => {
    const n = noticeForLicense({ licensed: true, state: 'licensed', daysToExpiry: 0 })
    expect(n?.tone).toBe('danger')
    expect(n?.title).toContain('只剩 0 天')
  })

  it('已过期（负数或 state=expired）说清楚「重启就进不去」', () => {
    const byDays = noticeForLicense({ licensed: true, state: 'licensed', daysToExpiry: -3 })
    expect(byDays?.id).toBe('license:expired')
    expect(byDays?.detail).toContain('重启后')
    const byState = noticeForLicense({ licensed: true, state: 'expired', daysToExpiry: 99 })
    expect(byState?.id).toBe('license:expired')
  })

  it('未授权不属于主界面的提醒（门禁会拦）', () => {
    expect(noticeForLicense({ licensed: false, state: 'unlicensed', daysToExpiry: 3 })).toBeNull()
  })
})

describe('汇总与关闭', () => {
  it('更新在前、授权在后', () => {
    const list = buildNotices({
      update: { phase: 'downloaded', version: '1.4.0' },
      license: { licensed: true, state: 'licensed', daysToExpiry: 5 },
    })
    expect(list.map((n) => n.id)).toEqual(['update:downloaded:1.4.0', 'license:urgent:5'])
  })

  it('已关闭的提醒不再出现，其余的照常', () => {
    const facts = {
      update: { phase: 'downloaded', version: '1.4.0' },
      license: { licensed: true, state: 'licensed', daysToExpiry: 5 },
    }
    const list = buildNotices(facts, new Set(['update:downloaded:1.4.0']))
    expect(list.map((n) => n.id)).toEqual(['license:urgent:5'])
  })

  it('都没有时返回空列表（而不是 undefined）', () => {
    expect(buildNotices({})).toEqual([])
  })

  it('提醒 id 随剩余天数变化，跨天后会重新提醒', () => {
    const day5 = noticeForLicense({ licensed: true, state: 'licensed', daysToExpiry: 5 })
    const day4 = noticeForLicense({ licensed: true, state: 'licensed', daysToExpiry: 4 })
    expect(day5?.id).not.toBe(day4?.id)
  })
})
