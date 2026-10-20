/**
 * 远程访问的**令牌与会话**判据。
 *
 * ## 为什么这些细节值得单独立用例
 *
 * 这一层是整个局域网暴露面上**唯一**的访问控制（没有 TLS、没有第二因子）。
 * 它的失效方式全是静默的：
 *   · 空令牌匹配成功 ⇒ 「还没在桌面端启用」变成「谁都进得来」；
 *   · 用 `===` 而不是定长比对 ⇒ 令牌可被计时侧信道逐字符猜（局域网里尤其现实）；
 *   · 会话不过期 / 轮换令牌不作废旧会话 ⇒ 一部丢了的手机永久有效；
 *   · Cookie 少了 `HttpOnly` ⇒ 面板里任何一处 XSS 就能偷走会话。
 * 每一种都不会让功能坏掉，所以只能靠判据钉住。
 *
 * 「用了 `timingSafeEqual`」这一条刻意走 **AST** 而不是文本搜索：
 * 文本搜索会被注释里的一句「这里要用 timingSafeEqual」骗过（本仓已踩过三次同类坑，
 * 见 `docs/RELEASE-PLAN.md` 的教训①）。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const AUTH_PATH = join(ROOT, 'src', 'backend', 'http-auth.js')
const require = createRequire(import.meta.url)

/** 被测模块的形状（`http-auth.js` 是主进程的 CJS，没有 .d.ts，所以在这里显式声明）。 */
interface AuthModule {
  SESSION_TTL_MS: number
  SESSION_COOKIE: string
  PAIRING_TTL_MS: number
  PAIRING_MAX_ATTEMPTS: number
  PAIRING_MAX_PENDING: number
  generateAccessToken: () => string
  generatePairingCode: () => string
  safeEquals: (provided: unknown, expected: unknown) => boolean
  maskToken: (token: string) => string
  parseCookies: (header: string | undefined) => Record<string, string>
  sessionCookie: (id: string, maxAgeSec: number) => string
  createSessionStore: (opts?: { ttlMs?: number, now?: () => number }) => {
    create: (meta?: { fullAccess?: boolean }) => { id: string, cookie: string }
    verify: (id: unknown) => boolean
    isFull: (id: unknown) => boolean
    revokeAll: () => void
    count: () => number
    expireCookie: () => string
  }
  createPairingStore: (opts?: {
    ttlMs?: number
    maxAttempts?: number
    maxPending?: number
    now?: () => number
  }) => {
    issue: (meta?: { fullAccess?: boolean }) => string
    verify: (provided: unknown) => { ok: boolean, attemptsLeft: number, fullAccess?: boolean }
    revokeAll: () => void
    count: () => number
  }
}

const auth = require(AUTH_PATH) as AuthModule

/** 收集源码里**真实**的调用表达式名（`a.b(…)` → `a.b`，`f(…)` → `f`）。注释与字符串里的都不算。 */
function callNames(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const t = node.expression
      if (ts.isIdentifier(t)) out.push(t.text)
      else if (ts.isPropertyAccessExpression(t)) out.push(t.getText(sf))
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return out
}

describe('令牌比对：定长、且空值永不匹配', () => {
  it('相同为真、不同为假', () => {
    expect(auth.safeEquals('abc', 'abc')).toBe(true)
    expect(auth.safeEquals('abc', 'abd')).toBe(false)
    // 长度不同也要能安全地判假（timingSafeEqual 在长度不同时会**抛**，
    // 所以实现必须先摘要 —— 这条就是钉住「不会因为长度不同而炸」）
    expect(auth.safeEquals('a', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false)
    expect(auth.safeEquals('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'a')).toBe(false)
  })

  it('空串一律不匹配：「还没生成令牌」绝不能变成「谁都进得来」', () => {
    expect(auth.safeEquals('', '')).toBe(false)
    expect(auth.safeEquals('', 'x')).toBe(false)
    expect(auth.safeEquals('x', '')).toBe(false)
  })

  it('非字符串一律不匹配（远程端的 body 是不可信输入）', () => {
    for (const bad of [undefined, null, 123, {}, [], true, () => 'abc']) {
      expect(auth.safeEquals(bad, 'abc'), `传入 ${typeof bad} 竟然匹配了`).toBe(false)
      expect(auth.safeEquals('abc', bad), `期望值是 ${typeof bad} 竟然匹配了`).toBe(false)
    }
  })

  it('AST：确实用了 crypto.timingSafeEqual（文本搜索会被注释骗过）', () => {
    const names = callNames(AUTH_PATH)
    expect(
      names.some((n) => n.endsWith('timingSafeEqual')),
      '比对不再是定长比对了 —— 令牌可被计时侧信道逐字符猜',
    ).toBe(true)
    // 摘要化是「长度不同不抛」的前提，两者要一起在场
    expect(names.some((n) => n.endsWith('createHash')), '没有先摘要就直接比，长度不同会抛').toBe(true)
  })
})

describe('令牌生成与掩码', () => {
  it('生成的令牌够长、是 base64url、且每次不同', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i += 1) {
      const t = auth.generateAccessToken()
      expect(t).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(t.length).toBeGreaterThanOrEqual(32)
      seen.add(t)
    }
    expect(seen.size, '200 次生成出现了重复').toBe(200)
  })

  it('掩码只留头尾，且不会把短令牌整个露出来', () => {
    expect(auth.maskToken('abcdefghijklmnop')).toBe('abcd…mnop')
    expect(auth.maskToken('12345678')).toBe('…')
    expect(auth.maskToken('1234567')).toBe('…')
    expect(auth.maskToken('')).toBe('')
    expect(auth.maskToken(undefined as unknown as string)).toBe('')
    // 掩码串里不该出现被掩掉的中间部分
    const token = auth.generateAccessToken()
    const masked = auth.maskToken(token)
    expect(masked).not.toContain(token.slice(6, -6))
  })
})

describe('Cookie：解析与属性', () => {
  it('解析多个、同名取第一个、坏值不掀桌', () => {
    expect(auth.parseCookies('a=1; b=2')).toEqual({ a: '1', b: '2' })
    expect(auth.parseCookies('a=1; a=2'), '同名应取第一个（与浏览器发送顺序一致）').toEqual({ a: '1' })
    expect(auth.parseCookies('st_sess=x%2Fy')).toEqual({ st_sess: 'x/y' })
    // 解不开的百分号转义按原文存，而不是抛
    expect(auth.parseCookies('bad=%E0%A4%A')).toEqual({ bad: '%E0%A4%A' })
    expect(auth.parseCookies('')).toEqual({})
    expect(auth.parseCookies(undefined)).toEqual({})
    expect(auth.parseCookies('=1; novalue; c=3')).toEqual({ c: '3' })
  })

  it('会话 Cookie 带 HttpOnly 与 SameSite，且**不带** Secure（明文 HTTP 下带不上）', () => {
    const c = auth.sessionCookie('sid-123', 3600)
    expect(c).toContain(`${auth.SESSION_COOKIE}=sid-123`)
    expect(c, '少了 HttpOnly：一处 XSS 就能偷走会话').toContain('HttpOnly')
    expect(c, '少了 SameSite：跨站请求会带上会话').toContain('SameSite=Lax')
    expect(c).toContain('Path=/')
    expect(c).toContain('Max-Age=3600')
    // Secure 需要 HTTPS，而这条链路是明文 HTTP —— 带上去 Cookie 根本不会被发送，
    // 于是「看起来更安全」实际是「功能坏掉」。这是已知代价，写进隐私声明第四节 H。
    expect(c, '明文 HTTP 下加了 Secure 会让 Cookie 完全不生效').not.toContain('Secure')
  })

  it('登出 Cookie 立刻过期', () => {
    const store = auth.createSessionStore()
    expect(store.expireCookie()).toContain('Max-Age=0')
  })
})

describe('会话表：有效期、作废、只在内存', () => {
  it('新建的会话能校验通过，未知 id 不通过', () => {
    const store = auth.createSessionStore()
    const { id } = store.create()
    expect(store.verify(id)).toBe(true)
    expect(store.verify('not-a-real-session')).toBe(false)
    expect(store.verify('')).toBe(false)
    expect(store.verify(undefined)).toBe(false)
    expect(store.verify(null)).toBe(false)
  })

  it('到期即失效（注入时钟，不等真的 12 小时）', () => {
    let t = 1_000_000
    const store = auth.createSessionStore({ ttlMs: 60_000, now: () => t })
    const { id } = store.create()
    expect(store.verify(id)).toBe(true)
    t += 59_999
    expect(store.verify(id), '还没到期就失效了').toBe(true)
    t += 2
    expect(store.verify(id), '过期了还能用 —— 会话必须有寿命').toBe(false)
  })

  it('默认 TTL 是 12 小时（手机锁屏过夜就该重新扫码）', () => {
    expect(auth.SESSION_TTL_MS).toBe(12 * 60 * 60 * 1000)
  })

  it('revokeAll 作废全部会话：轮换令牌后旧会话必须一起死', () => {
    const store = auth.createSessionStore()
    const a = store.create()
    const b = store.create()
    expect(store.count()).toBe(2)
    expect(store.verify(a.id)).toBe(true)
    store.revokeAll()
    expect(store.count()).toBe(0)
    expect(store.verify(a.id), '轮换令牌后旧会话仍然有效 —— 丢了的手机还是能进').toBe(false)
    expect(store.verify(b.id)).toBe(false)
  })

  it('每次创建的会话 id 都不同，且 count 只算有效的', () => {
    let t = 0
    const store = auth.createSessionStore({ ttlMs: 1000, now: () => t })
    const ids = new Set<string>()
    for (let i = 0; i < 50; i += 1) ids.add(store.create().id)
    expect(ids.size, '会话 id 出现了重复').toBe(50)
    expect(store.count()).toBe(50)
    t += 1001
    expect(store.count(), '过期会话没被清掉').toBe(0)
  })
})

describe('配对码：短命、唯一、一次性、可限次、只在内存', () => {
  it('生成的配对码是 base64url、短于长期令牌、且每次不同', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i += 1) {
      const code = auth.generatePairingCode()
      expect(code).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(code.length, '二维码里的短命凭据不该与长期令牌一样长').toBeLessThan(32)
      seen.add(code)
    }
    expect(seen.size, '200 次生成出现了重复').toBe(200)
  })

  it('配对码只许成功消费一次，且默认寿命是 5 分钟', () => {
    expect(auth.PAIRING_TTL_MS).toBe(5 * 60 * 1000)
    const store = auth.createPairingStore()
    const code = store.issue()
    expect(store.verify(code)).toEqual({ ok: true, attemptsLeft: 0 })
    expect(store.verify(code), '同一个配对码第二次登录必须失败').toEqual({ ok: false, attemptsLeft: 0 })
    expect(store.count()).toBe(0)
  })

  it('过期即失效（注入时钟，不等真的 5 分钟）', () => {
    let t = 10_000
    const store = auth.createPairingStore({ ttlMs: 60_000, now: () => t })
    const code = store.issue()
    t += 60_001
    expect(store.verify(code).ok, '过期的配对码仍能登录').toBe(false)
  })

  it('未知码与空/非字符串一律拒绝，且错误猜测会真实消耗剩余次数', () => {
    const store = auth.createPairingStore({ maxAttempts: 5 })
    const code = store.issue()
    expect(store.verify('not-the-code'), '第一次错误猜测应当消耗一个预算')
      .toEqual({ ok: false, attemptsLeft: 4 })
    expect(store.verify('').ok).toBe(false)
    expect(store.verify(undefined).ok).toBe(false)
    expect(store.verify('bad-2')).toEqual({ ok: false, attemptsLeft: 3 })
    expect(store.verify('bad-3')).toEqual({ ok: false, attemptsLeft: 2 })
    expect(store.verify('bad-4')).toEqual({ ok: false, attemptsLeft: 1 })
    const exhausted = store.verify('final-bad-guess')
    expect(exhausted, '试错预算耗尽后应作废这个码').toEqual({ ok: false, attemptsLeft: 0 })
    expect(store.verify(code), '预算耗尽的配对码还能登录').toEqual({ ok: false, attemptsLeft: 0 })
  })

  it('pending 上限：超过上限淘汰最旧，新码仍可用', () => {
    const store = auth.createPairingStore({ maxPending: 3, maxAttempts: 20 })
    const codes = Array.from({ length: 5 }, () => store.issue())
    expect(store.count()).toBe(3)
    expect(store.verify(codes[0]!).ok, '最旧的配对码应被淘汰').toBe(false)
    expect(store.verify(codes[4]!).ok, '最新配对码应仍可用').toBe(true)
  })

  it('revokeAll 作废全部配对码（停服/轮换后旧码必须死）', () => {
    const store = auth.createPairingStore()
    const a = store.issue()
    const b = store.issue()
    expect(store.count()).toBe(2)
    store.revokeAll()
    expect(store.count()).toBe(0)
    expect(store.verify(a).ok).toBe(false)
    expect(store.verify(b).ok).toBe(false)
  })
})

describe('「打开网页」交接码：只有它换来的会话拥有桌面同权限', () => {
  it('普通配对码不带 fullAccess；交接码成功时带', () => {
    const store = auth.createPairingStore()
    const normal = store.issue()
    expect(store.verify(normal)).toEqual({ ok: true, attemptsLeft: 0 })
    const full = store.issue({ fullAccess: true })
    expect(store.verify(full)).toEqual({ ok: true, attemptsLeft: 0, fullAccess: true })
  })

  it('会话表能区分 fullAccess（普通登录不放开桌面方法）', () => {
    const sessions = auth.createSessionStore()
    const normal = sessions.create()
    const full = sessions.create({ fullAccess: true })
    expect(sessions.verify(normal.id)).toBe(true)
    expect(sessions.isFull(normal.id)).toBe(false)
    expect(sessions.isFull(full.id)).toBe(true)
    // 过期后 isFull 也必须为 false（不能拿过期 id 继续越权）
    sessions.revokeAll()
    expect(sessions.isFull(full.id)).toBe(false)
  })
})
