/**
 * ClawBot 隐私口径守卫（当前事实；2026-10-13 起含「多实例 + AI 自动回复」）。
 *
 * 与 `privacy-statement.spec.ts` 的分工：那条守「声明版本与出网点」的通用口径，
 * 这条守 ClawBot 这一节的**具体事实**——它们都改过一轮（2026-10-11 官方文档核实后，
 * 「不出网」的旧表述与「解绑即删除」的旧设计都不成立），所以每条都留了反向断言，
 * 防止哪天又抄回过期结论。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const doc = readFileSync(join(ROOT, 'docs', 'PRIVACY.md'), 'utf8')
const consent = readFileSync(join(ROOT, 'src', 'client', 'ui-app', 'privacy', 'consent.ts'), 'utf8')

describe('ClawBot 隐私声明', () => {
  it('声明里写明 clawbot.db、永久保留、解绑不删会话', () => {
    expect(doc).toContain('clawbot.db')
    expect(doc).toMatch(/永久保留/)
    expect(doc, '解绑不删除会话的口径必须在声明里（D-4）').toContain('解绑不删除接入会话')
    // 反向：旧的「解绑即删」结论不许再出现（那与实现相反）
    expect(doc, '声明里还留着「解绑即删除」的过期结论').not.toContain('解绑即删除')
  })

  it('如实现已接入 iLink 通道：声明要写清出网点、控制面、发送与附件自动取回口径（v11）', () => {
    expect(doc).toMatch(/iLink/)
    expect(doc, '出网点必须点名到主机（privacy-statement.spec.ts 同名断言）').toContain('ilinkai.weixin.qq.com')
    expect(doc, '接收侧要写清发的是控制面信息').toMatch(/控制面/)
    expect(doc, '要写清已可发可收').toContain('可发可收')
    expect(doc, '发送必须写明由你逐条主动触发').toMatch(/逐条主动触发/)
    // 2026-10-13 **反转记录**：原断言守「没有自动回复、没有定时发送」。M3 上线了
    // **按实例开关的 AI 自动回复**（默认关），旧命题不再成立 ⇒ 按纪律改写而不是删除，
    // 且新的判据比旧的更严：旧的是「这件事不存在」，新的是「存在、但必须写明默认关闭、
    // 且只在开关打开时发生」。定时发送仍然不存在，这半句保持不变。
    expect(doc, '声明必须写明 AI 自动回复（它是一处无人值守的出网）').toMatch(/自动回复/)
    expect(doc, '自动回复必须写明**默认关闭**（否则读者会以为绑上就开始自动应答）').toMatch(/默认关闭|默认关/)
    expect(doc, '声明里不许再留着「没有自动回复」的过期结论').not.toContain('没有自动回复')
    expect(doc, '定时发送仍然不存在，这半句不许被一起删掉').toMatch(/没有定时发送/)
    expect(doc, '自动回复的模型调用要写明走 AI 审计（哪一类数据出了网）').toContain('ask_wechat')
    expect(doc, '附件取数要点名 CDN 主机与缓存目录').toContain('novac2c.cdn.weixin.qq.com')
    expect(doc, '附件要写清「自动取回」（含无人值守与只下载不上传）').toMatch(/自动取回|自动从腾讯 CDN/)
    expect(doc, '要写清无人值守（换句话说：不是靠你记着去点）').toContain('无人值守')
    expect(doc).toContain('clawbot-media')
    // 反向：v10 的「没有自动下载」已被 v11 改写，不许抄回来。
    expect(doc, '声明里还留着「没有自动下载」的过期结论').not.toContain('没有自动下载')
    // 反向：v8 的「仅接收」状态不许被抄回成当前事实（历史段用「仅接收、不发送」表述）。
    expect(doc, '声明里还留着「只收不发」的过期结论').not.toContain('只收不发')
    // 反向：v8 之前的「尚未接入」更不许回来（否则读者会以为绑定按钮是假的）。
    expect(doc, '声明里还留着「尚未接入」的过期结论').not.toContain('尚未接入')
    // 反向：不许再写「ClawBot 完全不出网」这类绝对化表述（链路的出网点已登记）
    expect(doc).not.toMatch(/ClawBot[^。]*不发起任何网络请求/)
  })

  it('声明版本不低于 v12（多实例 + AI 自动回复是又一次材料性变更）', () => {
    const version = Number(/PRIVACY_VERSION\s*=\s*(\d+)/.exec(consent)?.[1] ?? 0)
    expect(version).toBeGreaterThanOrEqual(12)
    expect(doc).toMatch(new RegExp(`生效版本[：:]\\s*\\*{0,2}v${String(version)}\\*{0,2}`))
  })
})
