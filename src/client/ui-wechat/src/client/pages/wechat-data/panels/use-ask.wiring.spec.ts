/**
 * M13：`use-ask.ts` 的**接线**守卫。
 *
 * 为什么需要源码级守卫：`ask-gate.spec.ts` 只测闸门模块本身。复审实测把 `use-ask.ts`
 * 整体退回改动前（`git diff --no-index` 校验逐字节相同）后，**全量 365 个用例仍 0 红** ——
 * 也就是说「把闭包 `asking` 当闸门」这个缺陷可以静默回来。仓库对同类风险已有既定做法
 * （`tests/meta.spec.ts` / `tests/result-cache.spec.ts` / `retrieval.spec.ts` 的源码级守卫）。
 *
 * **写这类守卫的坑（复审踩过）**：不要用 `/finally \{[\s\S]*?setAsking/` —— `[\s\S]*?`
 * 会跨过内层的 `}`，对**正确**的代码也会误报红。用 `[^}]` 把匹配限制在同一层花括号内。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(HERE, 'use-ask.ts'), 'utf8')
// 去掉块注释与行注释：否则注释里提到旧写法会让断言误判
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n')

describe('M13 接线：ask 必须走 ref 单飞闸', () => {
  it('用 useRef 持有闸门，并在调用点取用', () => {
    expect(code).toContain('gateRef.current')
    expect(code).toContain('createAskGate()')
  })

  it('用闸门而不是闭包里的 asking 做早退', () => {
    expect(code).toContain('const streamId = gate.tryStart()')
    expect(code).toContain('if (!streamId) return')
    // 这两条是**旧写法**：回来就说明缺陷回来了
    expect(code).not.toContain('if (!q || asking) return')
    expect(code).not.toContain('[asking, key, setTurnList]')
  })

  it('finally 里只有当前轮才收尾（不是无条件 setAsking(false)）', () => {
    // `[^}]` 把匹配限制在同一层花括号内 —— 用 `[\s\S]*?` 会跨过内层 `}` 而误报
    expect(code).toMatch(/finally \{[^}]*if \(gate\.finish\(streamId\)\)/)
  })
})
