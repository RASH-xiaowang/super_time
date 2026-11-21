/**
 * 定时总结的 prompt 装配（2026-11-18 起与每日/周期共用 `buildSummaryPrompt`）。
 *
 * 要守的两件事：
 *   ① 定时任务**不再自带一份格式表** —— 那份表里写着「3-5 句话以内」「控制在 10 条以内」，
 *      是「字数限制」的主要来源之一；两份表还会互相漂。
 *   ② 共用之后**作用域不能丢** —— 定时任务是按群跑的，prompt 里必须出现群名；
 *      自定义格式的 `{group}` / `{targets}` 也必须落成真实群名与成员，而不是「全部会话」。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { buildSummaryPrompt } from '../src/query/summary-prompt.ts'

const lines = ['【某个群】张三：明天几点碰？', '【某个群】李四：十点吧']

describe('定时任务的 prompt 作用域', () => {
  it('prompt 里带群名，而不是「全部会话」', () => {
    const prompt = buildSummaryPrompt({
      from: '2026-11-17',
      to: '2026-11-17',
      lines,
      stats: { total: 2, sessions: 1, messages: 2 },
      format: 'brief',
      scope: '某个群',
    })
    expect(prompt).toContain('某个群 2026-11-17')
    expect(prompt).not.toContain('全部会话')
  })

  it('自定义格式的 {group} / {targets} 落成真实值', () => {
    const prompt = buildSummaryPrompt({
      from: '2026-11-17',
      to: '2026-11-17',
      lines,
      stats: { total: 2, sessions: 1, messages: 2 },
      format: 'custom',
      customPrompt: '只看 {group} 里 {targets} 说了什么',
      scope: '某个群',
      targets: '张三、李四',
    })
    expect(prompt).toContain('只看 某个群 里 张三、李四 说了什么')
    expect(prompt).not.toContain('{group}')
    expect(prompt).not.toContain('{targets}')
  })

  it('没有作用域时退回「全部会话 / 全部成员」（每日/周期用）', () => {
    const prompt = buildSummaryPrompt({
      from: '2026-11-10',
      to: '2026-11-17',
      lines,
      stats: { total: 2, sessions: 3, messages: 2 },
      format: 'custom',
      // 自定义模板是「用户说什么就是什么」，只做占位符替换 —— 所以日期要用 {date} 取。
      customPrompt: '{date} · {group} 的 {targets}',
    })
    expect(prompt).toContain('2026-11-10 至 2026-11-17')
    expect(prompt).toContain('全部会话 的 全部成员')
  })

})
