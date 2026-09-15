/**
 * L8：`EchartsGraphCanvas.tsx` 的 `finished` 接线守卫（逐帧重算 → 静默期合并）。
 *
 * 为什么需要源码级守卫：`timers.spec.ts` 只证明「可重启定时器」这个原语是对的，
 * 证明不了组件**接上了**它 —— 把 `chart.on('finished', () => { settle.restart() })`
 * 退回 `() => { drawMinimap(); capturePositions() }` 时，原语的用例会全绿（M13 复审
 * 实测过这一步：整文件退回改动前，全量用例零变红）。
 *
 * 匹配花括号用 `[^}]` 限制在同一层：`[\s\S]*?` 会跨过内层 `}`，对**正确**代码也误报红。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(HERE, 'EchartsGraphCanvas.tsx'), 'utf8')
// 去掉注释：注释里会提到旧写法（例如 SETTLE_MS 的说明），别让它影响断言
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n')

describe('L8 接线：finished 不再逐帧重算小地图 / 写 localStorage', () => {
  it('用可重启定时器把 finished 合并到静默期之后执行', () => {
    expect(code).toContain("import { createRestartableTimer } from './timers.ts'")
    expect(code).toContain('const SETTLE_MS = 300')
    expect(code).toMatch(/createRestartableTimer\(\{ delayMs: SETTLE_MS, run: \(\) => \{[^}]*drawMinimap\(\)[^}]*capturePositions\(\)/)
    expect(code).toContain("chart.on('finished', () => { settle.restart() })")
  })

  it('旧写法（finished 里直接重算/持久化）必须已经不在', () => {
    // `[^}]` 限制在同一层花括号内
    expect(code).not.toMatch(/chart\.on\('finished', \(\) => \{[^}]*drawMinimap\(\)/)
    expect(code).not.toMatch(/chart\.on\('finished', \(\) => \{[^}]*capturePositions\(\)/)
    expect(code).not.toContain("chart.on('finished', () => { drawMinimap(); capturePositions() })")
  })

  it('卸载前兜住待落定的一笔，再销毁图表', () => {
    const cleanupStart = code.indexOf('const settle = createRestartableTimer(')
    expect(cleanupStart).toBeGreaterThan(-1)
    const cleanup = code.slice(code.indexOf('return () => {', cleanupStart))
    expect(cleanup).toMatch(/if \(settle\.pending\(\)\) \{[^}]*settle\.cancel\(\)[^}]*capturePositions\(\)/)
    // 兜底必须发生在 dispose 之前：dispose 之后 layout 读不到坐标
    expect(cleanup.indexOf('settle.pending()')).toBeLessThan(cleanup.indexOf('chartRef.current?.dispose()'))
  })

  it('防空转：被断言的两个函数真的还在文件里', () => {
    expect(code).toContain('const drawMinimap = (): void => {')
    expect(code).toContain('const capturePositions = (): void => {')
    expect(code).toContain('savePositions(map)')
  })
})
