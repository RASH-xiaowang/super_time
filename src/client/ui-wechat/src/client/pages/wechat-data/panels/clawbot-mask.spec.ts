/**
 * 展示层打码（`clawbot-mask.ts`）的样例守卫。
 *
 * 五类模式各留一条正例 + 一条「不该被误伤」的反例；样例形态与需求基线 D-10
 * 的验收样一致（`138****6721`）。这一层只影响界面显示，库里与导出都是原文 ——
 * 那条口径由 `clawbot-remotes.spec.ts`（落库原文）与 PRIVACY.md 双向守着。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { maskSensitiveText } from './clawbot-mask.ts'

describe('展示层打码', () => {
  it('手机号：保留前 3 后 4（D-10 的样例形态）', () => {
    expect(maskSensitiveText('我的手机号是 13812346721')).toBe('我的手机号是 138****6721')
  })

  it('身份证：保留前 6 后 4', () => {
    expect(maskSensitiveText('身份证 110101199001011234 已登记')).toBe('身份证 110101********1234 已登记')
  })

  it('银行卡：62 开头与 4/5 开头、16–19 位都认；保留前 4 后 4', () => {
    expect(maskSensitiveText('卡号 6222020202020202')).toBe('卡号 6222********0202')
    expect(maskSensitiveText('卡号 4111111111111111')).toBe('卡号 4111********1111')
    // 19 位：中段 11 个星号
    expect(maskSensitiveText('卡号 6222020202020202020')).toBe('卡号 6222***********2020')
  })

  it('邮箱：本地部分只留首字符', () => {
    expect(maskSensitiveText('联系 alice@example.com')).toBe('联系 a***@example.com')
  })

  it('口令：连值一起遮', () => {
    expect(maskSensitiveText('密码: hunter2 请记住')).toBe('密码: ****** 请记住')
    expect(maskSensitiveText('password=abc12345')).toBe('password=******')
  })

  it('不该被误伤：短数字、普通文本原样返回', () => {
    expect(maskSensitiveText('订单 12345 已发货')).toBe('订单 12345 已发货')
    expect(maskSensitiveText('这是一句普通消息，没有任何敏感字段。')).toBe('这是一句普通消息，没有任何敏感字段。')
    // 13 位数字不是手机号（11 位）也不是身份证/银行卡，不动它
    expect(maskSensitiveText('编号 1234567890123')).toBe('编号 1234567890123')
  })

  it('一段文本里的多个模式可以同时命中', () => {
    const out = maskSensitiveText('电话 13912345678，邮箱 bob@test.cn，密码: qwerty12')
    expect(out).toBe('电话 139****5678，邮箱 b***@test.cn，密码: ******')
  })
})
