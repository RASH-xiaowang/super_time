/**
 * L6：快照监听者退订必须连键一起删（Map 泄漏）+ 退订语义守卫。
 *
 * 为什么是**源码级**守卫：泄漏是纯内部的 —— `_snapshotListeners` 是模块私有 Map，
 * 空集合留在里面不影响任何可观测行为（`cachedGet` 读它当空集合用、`invalidateSnapshotCache`
 * 遍历空集合也不做事），所以「少删一个键」在公开 API 上没有任何信号，行为用例写不出来。
 * 仓库对这类「静默回归」的既定做法就是形状守卫（`use-ask.wiring.spec.ts` / `meta.spec.ts`）。
 *
 * 匹配花括号时用 `[^}]` 限制在同一层：`[\s\S]*?` 会跨过内层 `}`，对**正确**代码也会误报
 * （M13 复审踩过的坑，沿用 `use-ask.wiring.spec.ts` 的写法）。
 *
 * M21 之后这段代码住在 `cache.ts`（从 `api.ts` 纯搬移出去），所以这里改读那个文件；
 * `api.ts` 继续转发 `subscribeSnapshot`，面板调用方不用改。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(HERE, 'cache.ts'), 'utf8')
// 去掉注释：否则注释里提到的旧写法会让断言误判
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n')

/** 取出顶层函数的函数体（本文件风格：函数体以行首 `}` 结束）。 */
function bodyOf(source: string, header: string): string {
  const start = source.indexOf(header)
  expect(start, `${header} 必须仍在源码里`).toBeGreaterThan(-1)
  const end = source.indexOf('\n}', start)
  expect(end, `${header} 的函数体必须仍以顶层 '}' 结束`).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('L6 快照监听者：退订要连键一起删', () => {
  const body = bodyOf(code, 'export function subscribeSnapshot(')

  it('空集合被删键，并且不会误删同键的新一轮订阅', () => {
    expect(body).toMatch(/return \(\) => \{[^}]*set\.delete\(fn\)[^}]*_snapshotListeners\.delete\(key\)/)
    expect(body).toMatch(/_snapshotListeners\.get\(key\) === set/)
  })

  it('旧写法（只删成员、留空集合）必须已经不在', () => {
    // 这两条是**旧写法**：回来就说明泄漏回来了
    expect(body).not.toContain('return () => { set.delete(fn) }')
    expect(body).not.toMatch(/return \(\) => \{[^}]*set\.delete\(fn\)\s*\}/)
  })

  it('注册路径仍写入 Map（防空转：断言的对象真的存在）', () => {
    expect(body).toContain('_snapshotListeners.set(key, set)')
    expect(body).toContain('set.add(fn)')
  })
})
