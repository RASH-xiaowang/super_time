// @vitest-environment node
/**
 * W3-6.5：「排序已按你的 N 次反馈调整」—— N 必须是**数字**，不是一句机械的「已记录」。
 *
 * ## 为什么值得单立一条
 *
 * 用户点完赞/踩，最想知道的是「我这么多次点评到底改变了什么」。只回一句「检索权重已更新」，
 * 他看不出累计，也就无从判断自己的点评有没有用。后端其实早就有这个数
 * （`listFeedback` 的 `all.length`，`getRetrievalStatus` 里的 `feedback.total`），
 * 只是 `submitAskFeedback` 没往外带 —— 界面想显示也拿不到。
 *
 * ## 判据三侧
 *
 *   ① 后端返回体里有 `feedbackTotal`，且值取自「写完这一条之后的总数」（含刚写的这条）；
 *   ② 前端包装把它透出来（否则 props 到不了面板）；
 *   ③ 面板文案真的出现 N —— 且**只在有权重更新时**才说「已按你的 N 次反馈调整」
 *     （没有 `adaptedWeights` 说明反馈闭环在配置里被关了，那时说「已调整」是假话）。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (p: string): string => readFileSync(p, 'utf8')
const REMOTE = 'src/backend/wechat-data/src/remotes/ask.ts'
const API = 'src/client/ui-wechat/src/client/pages/wechat-data/api-config.ts'
const ASK = 'src/client/ui-wechat/src/client/pages/wechat-data/panels/Ask.tsx'

describe('W3-6.5：累计反馈次数要说到位', () => {
  it('① 后端返回 feedbackTotal，且是写入后的总数', () => {
    const r = read(REMOTE)
    expect(r, '返回类型里没有 feedbackTotal').toMatch(/feedbackTotal\?: number/)
    expect(r, '没把写入后的总数返回去').toMatch(/feedbackTotal: all\.length/)
  })

  it('② 前端包装透出它', () => {
    const a = read(API)
    expect(a, 'apiSubmitAskFeedback 的返回类型里没有 feedbackTotal')
      .toMatch(/features\?: string\[\]; feedbackTotal\?: number/)
  })

  it('③ 面板文案出现 N，且只在有权重更新时才说「已按…调整」', () => {
    const k = read(ASK)
    expect(k, '没有读 feedbackTotal').toMatch(/typeof r\.feedbackTotal === 'number'/)
    expect(k, '文案里没有 N').toMatch(/排序已按你的 \$\{n\} 次反馈调整/)
    // 没有 adaptedWeights 时不能说「已调整」：那是假话（反馈闭环被关了）。
    expect(k).toMatch(/r\.adaptedWeights && n !== null && n > 0/)
    // 兼容分支仍要存在（老后端 / 未配权重时）。
    expect(k).toContain("'已记录 · 检索权重已更新'")
  })
})