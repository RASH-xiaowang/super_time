/**
 * N17：`Ask.tsx` 反馈按钮的**接线**守卫（单飞闸必须真的接上）。
 *
 * 为什么需要源码级守卫：`ask-gate.spec.ts` 只测闸门模块本身，测不到「组件有没有用它」。
 * M13 复审实测过这一步的代价 —— 把 `use-ask.ts` 整体退回改动前（逐字节相同），全量
 * 365 个用例**零变红**。所以这里按 `use-ask.wiring.spec.ts` 的既定做法给接线加形状断言：
 * 只有「回到 ref 闸门 + 去掉旧写法」同时成立才算通过。
 *
 * **写这类守卫的坑（复审踩过）**：不要用 `/finally \{[\s\S]*?setBusy/` —— `[\s\S]*?`
 * 会跨过内层的 `}`，对**正确**的代码也会误报。用 `[^}]` 把匹配限制在同一层花括号内。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(HERE, 'Ask.tsx'), 'utf8')
// 去掉块注释与行注释：否则注释里提到旧写法会让断言误判
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n')

/** 只取反馈组件（AnswerFeedback）那一段，避免命中文件里别的 useRef/useCallback。 */
function feedbackSection(): string {
  const start = code.indexOf('export function AnswerFeedback(')
  expect(start, 'AnswerFeedback 必须仍在源码里').toBeGreaterThan(-1)
  const end = code.indexOf('export function AskPanel(', start)
  expect(end, 'AnswerFeedback 的结束位置（AskPanel 之前）').toBeGreaterThan(start)
  return code.slice(start, end)
}

describe('N17 接线：反馈提交必须走 ref 单飞闸', () => {
  const section = feedbackSection()

  it('用 useRef 持有闸门，并在调用点惰性创建', () => {
    expect(section).toContain('const gateRef = useRef<AskGate | null>(null)')
    expect(section).toContain('createAskGate()')
    expect(section).toContain('gate.tryStart()')
  })

  it('用闸门而不是闭包里的 busy 做早退', () => {
    expect(section).toContain('const ticket = gate.tryStart()')
    expect(section).toContain('if (!ticket) return')
    // 这两条是**旧写法**：回来就说明双击窗口又开了
    expect(section).not.toContain('if (busy) return')
    expect(section).not.toContain('[busy, turn.retrievalId')
  })

  it('finally 里只有当前轮才复位（不是无条件 setBusy(false)）', () => {
    // `[^}]` 把匹配限制在同一层花括号内 —— 用 `[\s\S]*?` 会跨过内层 `}` 而误报
    expect(section).toMatch(/finally \{[^}]*if \(gate\.finish\(ticket\)\) setBusy\(false\)/)
    expect(section).not.toMatch(/finally \{[^}]*\n\s*setBusy\(false\)/)
  })

  it('busy 仍只用于按钮禁用/文案（保留可读的「提交中…」）', () => {
    expect(section).toContain('disabled={busy}')
    expect(section).toContain("busy ? '提交中…' : '提交反馈'")
  })
})
