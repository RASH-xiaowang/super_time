/**
 * M15：轮询登记表的语义 —— 尤其是「卸载后不再回调」。
 *
 * 验收（`docs/RELEASE-PLAN.md` M15 行）：下载/转写**中途切走面板**，IPC 调用停止。
 * 这里用假时钟把「切走」模拟成 `stopAll()`，断言回调真的不再触发。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPollRegistry } from './poll-registry.ts'

afterEach(() => { vi.useRealTimers() })

describe('M15 轮询登记表', () => {
  it('按周期触发，stopAll 之后一次都不再触发（卸载即停）', () => {
    vi.useFakeTimers()
    const reg = createPollRegistry()
    let hits = 0
    reg.start(() => { hits += 1 }, 500)
    vi.advanceTimersByTime(1600)
    expect(hits).toBe(3) // 500/1000/1500
    expect(reg.size()).toBe(1)

    reg.stopAll() // ← 组件卸载
    vi.advanceTimersByTime(5000)
    expect(hits).toBe(3) // 不再增长
    expect(reg.size()).toBe(0)
  })

  it('逐个停止只影响自己（下载完成时停那一个，别的轮询继续）', () => {
    vi.useFakeTimers()
    const reg = createPollRegistry()
    let a = 0
    let b = 0
    const stopA = reg.start(() => { a += 1 }, 400)
    reg.start(() => { b += 1 }, 400)
    vi.advanceTimersByTime(1200)
    expect([a, b]).toEqual([3, 3])

    stopA()
    vi.advanceTimersByTime(1200)
    expect(a).toBe(3) // 停掉的不再增长
    expect(b).toBe(6) // 另一个照常
    expect(reg.size()).toBe(1)
  })

  it('停止函数幂等，且 stopAll 之后再调它不会误清别的 id', () => {
    vi.useFakeTimers()
    const reg = createPollRegistry()
    let hits = 0
    const stop = reg.start(() => { hits += 1 }, 100)
    stop()
    stop() // 重复停止不抛
    expect(reg.size()).toBe(0)

    reg.stopAll()
    stop() // stopAll 之后再调：内部已 delete，不该去 clear 一个可能被复用的 id
    let later = 0
    reg.start(() => { later += 1 }, 100)
    vi.advanceTimersByTime(300)
    expect(later).toBe(3) // 新轮询正常
    expect(hits).toBe(0)
  })

  it('stopAll 幂等（卸载后又触发一次也不会抛）', () => {
    vi.useFakeTimers()
    const reg = createPollRegistry()
    reg.start(() => { /* noop */ }, 100)
    expect(() => { reg.stopAll(); reg.stopAll() }).not.toThrow()
    expect(reg.size()).toBe(0)
  })

  it('没有轮询时 stopAll 是空操作', () => {
    const reg = createPollRegistry()
    expect(reg.size()).toBe(0)
    expect(() => reg.stopAll()).not.toThrow()
  })
})

/**
 * 接线守卫（M13 的教训：改完要问「退回旧写法会不会有人发现」）。
 *
 * 这条守的是 `Settings.tsx`：
 *   ① 四处轮询都必须走登记表（文件里不能再有裸 `setInterval(`）；
 *   ② 必须有卸载清理（`pollsRef.current?.stopAll()` 在 `useEffect` 的返回值里）。
 * 少了任一条，那个「切走面板后还在每 500ms 打 IPC」的泄漏就会静默回来 ——
 * 模块级用例测不到接线。
 */
describe('M15 接线：Settings 的轮询必须登记 + 卸载清理', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Settings.tsx'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n')

  it('文件里没有裸 setInterval（全部经登记表）', () => {
    expect(code).not.toContain('setInterval(')
    expect(code).not.toContain('clearInterval(')
  })

  it('四处轮询都走 polls().start', () => {
    expect((code.match(/polls\(\)\.start\(/g) || []).length).toBe(4)
  })

  it('挂了卸载清理（useEffect 的返回值里 stopAll）', () => {
    expect(code).toMatch(/useEffect\(\(\) => \(\) => \{ pollsRef\.current\?\.stopAll\(\) \}, \[\]\)/)
  })
})
