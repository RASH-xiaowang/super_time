/**
 * 自定义工具「调用名」的生成与校验（2026-11-24）。
 *
 * 这一族的错法是**静默**的：生成的调用名不合法 ⇒ 保存时后端拒绝，但用户以为是自己没填对；
 * 生成的名字与已有工具撞车 ⇒ 覆盖掉别人。所以逐格喂：中文标题、纯数字、超长、重复。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { isValidToolName, suggestToolName, toolNameHint } from './local-tool-name.ts'

describe('suggestToolName：任何标题都要产出一个合法且不重复的名字', () => {
  it('英文标题直接转下划线形式', () => {
    expect(suggestToolName('Recent Transfers')).toBe('recent_transfers')
    expect(suggestToolName('recent--transfers!!')).toBe('recent_transfers')
  })

  it('中文标题退化成 tool_<哈希>（确定性、合法）', () => {
    const name = suggestToolName('最近三个月转账')
    expect(name).toMatch(/^tool_[0-9a-f]{4}$/)
    expect(isValidToolName(name)).toBe(true)
    // 同一个标题每次生成同一个名字（避免用户改一行标题就换一个标识）
    expect(suggestToolName('最近三个月转账')).toBe(name)
    // 不同标题几乎不会相撞
    expect(suggestToolName('最近的转账')).not.toBe(name)
  })

  it('以数字开头 / 太短 / 空白都补成合法名', () => {
    for (const title of ['2026 报告', 'a', '', '   ', '中文']) {
      const name = suggestToolName(title)
      expect(isValidToolName(name), `${title} ⇒ ${name}`).toBe(true)
    }
  })

  it('长度封顶在 49 位以内（后端 NAME_RE 的上限）', () => {
    const name = suggestToolName('a'.repeat(200))
    expect(name.length).toBeLessThanOrEqual(49)
    expect(isValidToolName(name)).toBe(true)
  })

  it('与已被占用的名字冲突时自动加后缀', () => {
    const taken = new Set(['recent_transfers', 'recent_transfers_2'])
    const name = suggestToolName('recent transfers', taken)
    expect(name).toBe('recent_transfers_3')
    expect(taken.has(name)).toBe(false)
  })
})

describe('toolNameHint：把后端的拒绝理由提前到输入框下面', () => {
  it('合法名字没有意见', () => {
    expect(toolNameHint('recent_transfers')).toBe('')
  })

  it('各类不合法都给出可操作的原因', () => {
    expect(toolNameHint('')).toContain('自动生成')
    expect(toolNameHint('ab')).toContain('至少 3')
    expect(toolNameHint('1abc')).toContain('小写字母开头')
    expect(toolNameHint('recent transfers')).toContain('小写字母')
    expect(toolNameHint('recent-transfer')).toContain('小写字母')
    expect(toolNameHint('a'.repeat(50))).toContain('49')
  })

  it('与 isValidToolName 口径一致（合法 ⇔ 没有提示）', () => {
    for (const name of ['abc', 'a_b_c', 'A_b_c', '', 'ab', 'ok_name_1', 'a'.repeat(50)]) {
      expect(toolNameHint(name) === '').toBe(isValidToolName(name))
    }
  })
})
