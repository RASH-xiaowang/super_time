/**
 * H14：隐私同意判定与接线守卫。
 *
 * 要守住的不变量是「**未同意就不放行**」，而它的失败方向很危险：
 * 任何解析失败、版本比对写错、或者接线漏掉，都会让用户**没看到声明就进了主界面**。
 * 所以这里既测纯逻辑（含各种畸形输入），也用 AST 断言接线（注释里留个字符串骗不过去，
 * 见 M12 / N19 的教训）。
 *
 * 能守什么、守不住什么：
 *   · 守得住：判定逻辑、「ui-entry 里真的挂了闸门且自动进主界面的条件含 consented」；
 *   · 守不住：真实 Electron 里首次启动的观感（勾选框、按钮）—— 仓库没有组件测试环境。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import {
  PRIVACY_STORAGE_KEY,
  PRIVACY_VERSION,
  acceptConsent,
  loadConsentRecord,
  needsConsent,
  parseConsent,
  resetConsent,
} from './consent.ts'
import type { ConsentKv } from './consent.ts'

// 仓库根：spec 在 src/client/ui-app/privacy/ 下，要上溯 4 层才到仓库根
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const entrySrc = readFileSync(join(ROOT, 'src', 'client', 'ui-app', 'ui-entry.tsx'), 'utf8')

/** 内存版 KV，并记录调用（用来断言「真的写了」而不是「看起来写了」）。 */
function fakeKv(initial: Record<string, string> = {}): ConsentKv & { store: Map<string, string>; removed: string[] } {
  const store = new Map(Object.entries(initial))
  const removed: string[] = []
  return {
    store,
    removed,
    getItem: (k) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k, v) => { store.set(k, v) },
    removeItem: (k) => { store.delete(k); removed.push(k) },
  }
}

describe('H14：隐私同意状态', () => {
  it('parseConsent 对畸形输入一律返回 null（失败方向是「再问一次」）', () => {
    expect(parseConsent(null)).toBeNull()
    expect(parseConsent('')).toBeNull()
    expect(parseConsent('不是 JSON')).toBeNull()
    expect(parseConsent('{}')).toBeNull()
    expect(parseConsent('{"version":1}')).toBeNull()
    expect(parseConsent('{"acceptedAt":"2026-09-15T00:00:00.000Z"}')).toBeNull()
    expect(parseConsent('{"version":0,"acceptedAt":"x"}')).toBeNull()
    expect(parseConsent('{"version":-1,"acceptedAt":"x"}')).toBeNull()
    expect(parseConsent('{"version":1.5,"acceptedAt":"x"}')).toBeNull()
    expect(parseConsent('{"version":"1","acceptedAt":"x"}')).toBeNull()
    expect(parseConsent('{"version":1,"acceptedAt":""}')).toBeNull()
    expect(parseConsent('{"version":1,"acceptedAt":"2026-09-15T00:00:00.000Z"}'))
      .toEqual({ version: 1, acceptedAt: '2026-09-15T00:00:00.000Z' })
  })

  it('needsConsent：无记录要问、同版本不问、旧版本要重问、未来版本不问', () => {
    const rec = { version: PRIVACY_VERSION, acceptedAt: '2026-09-15T00:00:00.000Z' }
    expect(needsConsent(null)).toBe(true)
    expect(needsConsent(rec)).toBe(false)
    expect(needsConsent({ ...rec, version: PRIVACY_VERSION - 1 })).toBe(true)
    // 版本比当前高（例如用户降级安装）：已在更高版本上同意过，不重复打扰
    expect(needsConsent({ ...rec, version: PRIVACY_VERSION + 1 })).toBe(false)
    // 显式版本参数（将来提升 PRIVACY_VERSION 时，旧记录必须变成「需要重问」）
    expect(needsConsent({ ...rec, version: 1 }, 2)).toBe(true)
  })

  it('acceptConsent 写入版本与时间，并可被 loadConsentRecord 读回', () => {
    const kv = fakeKv()
    const at = new Date('2026-09-15T08:30:00.000Z')
    const rec = acceptConsent(() => at, kv)
    expect(rec).toEqual({ version: PRIVACY_VERSION, acceptedAt: '2026-09-15T08:30:00.000Z' })
    expect(kv.store.has(PRIVACY_STORAGE_KEY)).toBe(true)
    expect(loadConsentRecord(kv)).toEqual(rec)
    expect(needsConsent(loadConsentRecord(kv))).toBe(false)
  })

  it('resetConsent 清掉记录（清掉之后重新要求同意）', () => {
    const kv = fakeKv()
    acceptConsent(() => new Date('2026-09-15T08:30:00.000Z'), kv)
    resetConsent(kv)
    expect(kv.removed).toEqual([PRIVACY_STORAGE_KEY])
    expect(kv.store.has(PRIVACY_STORAGE_KEY)).toBe(false)
    expect(needsConsent(loadConsentRecord(kv))).toBe(true)
  })

  it('存储不可用/抛错时不抛，且当前会话仍视为已同意', () => {
    const boom: ConsentKv = {
      getItem: () => { throw new Error('no storage') },
      setItem: () => { throw new Error('quota') },
      removeItem: () => { throw new Error('no storage') },
    }
    expect(loadConsentRecord(boom)).toBeNull()
    expect(() => acceptConsent(() => new Date('2026-09-15T08:30:00.000Z'), boom)).not.toThrow()
    expect(acceptConsent(() => new Date('2026-09-15T08:30:00.000Z'), boom).version).toBe(PRIVACY_VERSION)
    expect(() => resetConsent(boom)).not.toThrow()
    // 读回仍然是 null（不落盘），所以下次启动会再问一次 —— 这是可接受的降级
    expect(loadConsentRecord(boom)).toBeNull()
  })
})

/** 在 TSX 里找某个 JSX 元素的节点（注释里的同名文本不算）。 */
function findJsxElement(src: string, tagName: string): boolean {
  const sf = ts.createSourceFile('ui-entry.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let hit = false
  const visit = (node: ts.Node): void => {
    if (hit) return
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (node.tagName.getText(sf) === tagName) { hit = true; return }
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return hit
}

/** 取出「函数体里调用了 openWechat() 的 if 语句」的条件源码文本（没有则返回 null）。 */
function autoOpenConditionText(src: string): string | null {
  const sf = ts.createSourceFile('ui-entry.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found: string | null = null
  const bodyCallsOpen = (node: ts.Node): boolean => {
    let yes = false
    const walk = (n: ts.Node): void => {
      if (yes) return
      if (ts.isCallExpression(n) && n.expression.getText(sf) === 'openWechat') { yes = true; return }
      n.forEachChild(walk)
    }
    node.forEachChild(walk)
    return yes
  }
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isIfStatement(node) && node.expression && bodyCallsOpen(node.thenStatement)) {
      found = node.expression.getText(sf)
      return
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return found
}

describe('H14：同意闸门的接线', () => {
  it('ui-entry 真的渲染 PrivacyConsentGate（注释里的同名文本不算）', () => {
    expect(findJsxElement(entrySrc, 'PrivacyConsentGate')).toBe(true)
    // 反向确认解析有效：故意找一个不存在的组件名必须是 false
    expect(findJsxElement(entrySrc, 'NoSuchGateXyz')).toBe(false)
  })

  it('自动进入主界面的条件里必须包含 consented（否则同意闸门形同虚设）', () => {
    const cond = autoOpenConditionText(entrySrc)
    expect(cond, 'ui-entry 里找不到调用 openWechat() 的 if 语句').toBeTruthy()
    expect(cond!).toMatch(/consented/)
    expect(cond!).toMatch(/onboardingDone/)
    expect(cond!).toMatch(/isLicenseUsable/)
  })

  it('同意状态在未放行的分支里被消费（渲染分支含 !consented）', () => {
    // 只断言「变量被用于条件」不够 —— 必须有一个以它为前提的渲染分支。
    // 判据放宽成「条件里含 !consented 的 if 分支」而不是钉死 `if (!consented) {`：
    // 后者会在任何新增条件时误报（N2 的豁免变量 `!skipGates && !consented` 就撞上了），
    // 而它要守的东西是「存在这样一个分支」，不是「这个分支长什么样」。
    expect(entrySrc).toMatch(/if \([^)]*!consented\b[^)]*\)\s*\{/)
  })
})
