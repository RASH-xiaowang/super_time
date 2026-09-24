/**
 * `tests/helpers/ci-unit-retry.ts` 的应用例 —— 判定「能不能重跑」这件事不能靠读代码确认。
 *
 * 判错方向的代价不对称：把真失败判成可重跑 = 让红悄悄变绿（本项目最不能接受的一种错）；
 * 把可重跑判成失败 = 只是又拦一次合并。所以下面每一条都盯着"往哪个方向错"。
 * 夹具是 2026-09-24 两份真实 CI 日志的形状（运行 425 与 419 的那两次假红）。
 *
 * @module tests/ci-unit-retry
 */
import { describe, expect, it } from 'vitest'

import { classifyRun, fakeRedRecord, summarizeRun, type RunResult } from './helpers/ci-unit-retry.ts'

/** 真红：全部通过、只有 RPC 超时、退出码 1（运行 425 的形状，榜首 76.1 秒）。 */
const FAKE_RED: RunResult = {
  exitCode: 1,
  output: [
    '⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯',
    'Error: [vitest-worker]: Timeout calling "onTaskUpdate"',
    ' Test Files  223 passed | 10 skipped (233)',
    '      Tests  2372 passed | 17 skipped (2389)',
    '     Errors  1 error',
    '[耗时榜] 233 个测试文件，最慢的前 10 名：',
    '  1.   76.1s   ⚠ 已越过 60 秒线（历史上每次假红都有一个这样的文件）  src/backend/wechat-data/tests/gateway-export-stream-progress.spec.ts',
    '  2.   26.5s   距线 2.27×  src/backend/wechat-data/tests/kb-vectors.spec.ts',
  ].join('\n'),
}

/** 同一次运行的 ANSI + 时间戳版本（Actions 原始日志就是这个形状）。 */
const FAKE_RED_RAW: RunResult = {
  exitCode: 1,
  output: FAKE_RED.output.split('\n')
    .map(l => `2026-09-24T04:18:40.1234567Z \x1b[31m${l}\x1b[39m`).join('\n'),
}

/** 真失败：既超时了也有红用例 —— 决不允许重跑。 */
const REAL_FAILURE: RunResult = {
  exitCode: 1,
  output: [
    ' FAIL  src/backend/wechat-data/tests/x.spec.ts > 某条',
    'AssertionError: expected 1 to be 2',
    'Error: [vitest-worker]: Timeout calling "onTaskUpdate"',
    ' Test Files  1 failed | 222 passed (233)',
    '      Tests  1 failed | 2371 passed (2389)',
  ].join('\n'),
}

describe('单测步能不能重跑：三条边界与两种失败方向', () => {
  it('退出码 0 ⇒ pass（哪怕日志里出现过那句话 —— 例如有人把征兆写在注释里）', () => {
    expect(classifyRun({ exitCode: 0, output: FAKE_RED.output })).toBe('pass')
  })

  it('全过 + 只有 RPC 超时 + 退出码 1 ⇒ retryable-fake-red（ANSI 与时间戳都不影响）', () => {
    expect(classifyRun(FAKE_RED)).toBe('retryable-fake-red')
    expect(classifyRun(FAKE_RED_RAW), '去 ANSI/时间戳是这一步的事，不去就永远判不出来').toBe('retryable-fake-red')
  })

  it('有真失败用例时绝不重跑，即使同一次运行也超时了', () => {
    expect(classifyRun(REAL_FAILURE)).toBe('failure')
  })

  it('退出码非 0 但没有那条征兆 ⇒ failure（那不是这一族，别自动处理）', () => {
    expect(classifyRun({
      exitCode: 1,
      output: ' Test Files  223 passed (233)\n      Tests  2372 passed (2389)\nSome other crash\n',
    })).toBe('failure')
  })

  it('征兆有、可汇总行没有 ⇒ failure —— 看不清就不猜', () => {
    expect(classifyRun({ exitCode: 1, output: 'Error: [vitest-worker]: Timeout calling "onTaskUpdate"\n' }))
      .toBe('failure')
    // 「failed」缺省为 0，但 passed 必须数得出来；只有 `Errors 1 error` 那种不算数。
    expect(classifyRun({ exitCode: 1, output: 'Error: [vitest-worker]: x\n     Errors  1 error\n' }))
      .toBe('failure')
  })

  it('记录文案要引用得出第一次运行的读数与那一次的榜首', () => {
    const text = summarizeRun(FAKE_RED)
    expect(text).toContain('2372 passed')
    expect(text, '榜首必须被点名 —— 这是"留记录"的全部意义').toContain('gateway-export-stream-progress.spec.ts')
    expect(text).toContain('76.1s')
    expect(summarizeRun(REAL_FAILURE)).toContain('222 passed')
    expect(summarizeRun({ exitCode: 1, output: 'nothing here' }))
      .toContain('没找到汇总行')
  })

  it('重跑仍非 0 ⇒ 记录里直说这一步就是红的；政策只给一次', () => {
    const stillRed = fakeRedRecord(FAKE_RED, { exitCode: 1, output: REAL_FAILURE.output })
    expect(stillRed).toContain('这一步就是红的')
    expect(stillRed).toContain('没有第二次')
    const green = fakeRedRecord(FAKE_RED, { exitCode: 0, output: FAKE_RED.output.replace(' 1 error', ' 0 error') })
    expect(green).toContain('重跑结果：退出码 0')
    expect(green).not.toContain('这一步就是红的')
    expect(green, '政策出处与三条判据要写在记录里，不能只写"重跑过"').toContain('2026-09-24')
    expect(green).toContain('Timeout calling "onTaskUpdate"')
  })
})
