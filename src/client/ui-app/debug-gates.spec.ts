/**
 * 渲染层那道「首启闸门豁免」判定的行为守卫（N2 的第二层，P3-17 从 `src/backend/tests/debug-gates.spec.ts` 搬到这里）。
 *
 * ## 为什么它原先在宿主层的测试里
 *
 * 因为 N2 的三层判据（判定函数 / 主进程接线 / 渲染层接线）当初是一次性写成的，
 * 于是宿主层的 spec 直接 `import { shouldSkipGates } from '../../client/ui-app/debug-gates.ts'`
 * —— 这是**后端依赖前端源码**的反向依赖（审查报告 P3-17 点名的两处之一）。
 * 方向对了才有意义：`shouldSkipGates` 是渲染层自己的纯逻辑（它守的是「主进程给的事实形状不对时不许放行」），
 * 判定与调用它的 `ui-entry.tsx` 住在同一层，测试也该在同一层。
 * 宿主层那份 spec 继续守**接线**（读 `ui-entry.tsx` 的源码文本，断言它确实调用了一次、实参是 IPC 事实）——
 * 读文本做断言与 import 值是两回事，前者是守卫的常规手段，后者才是跨层耦合。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { shouldSkipGates } from './debug-gates.ts'

describe('N2：渲染层判定的纯函数（第二道校验）', () => {
  it('只有 packaged === false 且 skipGates === true 才豁免', () => {
    expect(shouldSkipGates({ packaged: false, skipGates: true })).toBe(true)
    // 主进程以后改了返回值形状 / 字段名拼错 / 老主进程不带 packaged ⇒ 一律不放行
    for (const fact of [null, undefined, {}, { skipGates: true }, { packaged: true, skipGates: true },
      { packaged: false }, { packaged: 'false', skipGates: true }, { packaged: false, skipGates: 'true' },
      { skipOnboarding: true }]) {
      expect(shouldSkipGates(fact), `fact=${JSON.stringify(fact)} 不应放行`).toBe(false)
    }
  })

  it('失败方向是「拦住」，不是「照常放行」——事实为真但打包态字段被改名的情形也不能漏', () => {
    // 主进程把字段名换成 isPackaged（真实会犯的错）：渲染层读不到 packaged ⇒ 不许豁免
    expect(shouldSkipGates({ isPackaged: false, skipGates: true })).toBe(false)
    // 只给 packaged=false（skipGates 缺省）⇒ 不许豁免
    expect(shouldSkipGates({ packaged: false })).toBe(false)
  })

  it('非对象的事实（字符串 / 数组 / 函数）一律不放行，也不许抛', () => {
    for (const weird of ['false', 0, 1, [], () => true, Symbol('x')] as unknown[]) {
      expect(() => shouldSkipGates(weird), `事实=${String(weird)} 不该抛错`).not.toThrow()
      expect(shouldSkipGates(weird), `事实=${String(weird)} 不应放行`).toBe(false)
    }
  })
})
