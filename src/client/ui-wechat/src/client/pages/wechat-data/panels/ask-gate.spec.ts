/**
 * M13：流式问答单飞闸的并发语义。
 *
 * 验收（`docs/RELEASE-PLAN.md` M13 行）：快速连点两次提问**只产生一轮**；
 * 后进行中先返回**不截断**仍在生成的轮次。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { createAskGate } from './ask-gate.ts'

/** 固定 id 的闸门，便于断言。 */
function gateWithIds(...ids: string[]) {
  let i = 0
  return createAskGate(() => ids[i++] ?? ('id-' + String(i)))
}

describe('M13 单飞闸', () => {
  it('已在跑时第二次 tryStart 返回 null（快速连点只产生一轮）', () => {
    const g = gateWithIds('a', 'b')
    expect(g.tryStart()).toBe('a')
    expect(g.running()).toBe(true)
    expect(g.tryStart()).toBeNull() // ← 连点第二次
    expect(g.tryStart()).toBeNull() // ← 连点第三次
  })

  it('本轮结束后才能开下一轮', () => {
    const g = gateWithIds('a', 'b')
    expect(g.tryStart()).toBe('a')
    expect(g.finish('a')).toBe(true)
    expect(g.running()).toBe(false)
    expect(g.tryStart()).toBe('b')
  })

  it('过期轮次 finish 不释放闸门、也不被认作当前轮（先返回者不截断仍在生成的那轮）', () => {
    const g = gateWithIds('a', 'b')
    const a = g.tryStart()
    expect(a).toBe('a')
    // 模拟「旧轮的迟到回调」：它已经过期，不该动任何状态
    expect(g.isCurrent('stale')).toBe(false)
    expect(g.finish('stale')).toBe(false)
    expect(g.running()).toBe(true) // 当前轮仍在跑
    expect(g.isCurrent('a')).toBe(true)

    // 当前轮结束后再开新轮，旧轮的回调依旧无效
    expect(g.finish('a')).toBe(true)
    const b = g.tryStart()
    expect(b).toBe('b')
    expect(g.finish('a')).toBe(false) // 旧轮迟到的 finally
    expect(g.running()).toBe(true) // 新轮不受影响
    expect(g.isCurrent('b')).toBe(true)
  })

  it('同一轮 finish 两次：第二次不生效（幂等且不误伤）', () => {
    const g = gateWithIds('a', 'b')
    expect(g.tryStart()).toBe('a')
    expect(g.finish('a')).toBe(true)
    expect(g.finish('a')).toBe(false)
    expect(g.running()).toBe(false)
    expect(g.tryStart()).toBe('b') // 仍能正常开新轮
  })

  it('默认 id 生成器每次不同（后端按 id 过滤增量，不能撞）', () => {
    const g = createAskGate()
    const a = g.tryStart()
    expect(a).toBeTruthy()
    g.finish(a as string)
    const b = g.tryStart()
    expect(b).toBeTruthy()
    expect(b).not.toBe(a)
  })

  it('初始状态没有在跑的轮次', () => {
    const g = createAskGate()
    expect(g.running()).toBe(false)
    expect(g.isCurrent('anything')).toBe(false)
    expect(g.finish('anything')).toBe(false)
  })
})
