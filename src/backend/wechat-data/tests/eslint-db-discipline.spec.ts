/**
 * #24：那条 ESLint 的 DB 闸门必须**真的会咬**（CODE-AUDIT-2026-09-26 §七 #24）。
 *
 * ## 这份文件量的是三件事，顺序不能省
 *
 * 1. **配置被 ESLint 自己加载得动，且作用域非空** —— 一个没人能加载的配置文件比没有配置更糟：
 *    `npm run lint:db` 报错没人跑，编辑器安静地什么都不标。所以先看真实生产树被匹配到多少文件。
 * 2. **正面咬、反面不咬** —— 两条选择器各配一份坏写法（必须报错），再配一份**好**写法
 *    （必须零误伤）。反面那一条不是走过场：`eslint.config.mjs` 的头注里记着，按报告原话
 *    写出来的直觉版本（「try 块里不许出现 new DatabaseSync」）会把 **32 处推荐写法**判成缺陷，
 *    那 32 处的形状是 `try { const db = new …; try { …干活… } finally { db.close() } } catch { … }`
 *    —— 外层保证「打开失败就不进来」，内层保证「进来了就一定关」。这份夹具就是照它写的。
 * 3. **分工没被忘掉** —— 闸门装上来路是「保存时就响」，而账本（谁拥有连接、还剩几处待改造）
 *    仍然在 `query-db-lifetime.spec.ts`。那条 spec 做的是「close 出现在哪条路径上」的作用域分析，
 *    语法工具做不了；所以这里断言它还在、还在守那份只能变小的清单，免得有人以为 ESLint 替掉了它。
 *
 * 为什么不直接在这里 import `eslint.config.mjs`：那样测的是「我照着 import 的那份对象」，
 * 而 CI 与编辑器用的是「ESLint 从磁盘加载的那份」。所以两头都走真 API（`overrideConfigFile`），
 * 结构哨兵则读配置文件文本。
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..', '..')
const CONFIG = join(ROOT, 'eslint.config.mjs')

/** 生产树内的探针路径（不必真存在：`lintText` 只用它做配置匹配）。 */
const INSIDE = 'src/backend/wechat-data/src/query/__db_discipline_probe__.ts'
/** 配置刻意**不**覆盖的位置：同一份坏写法落在这里必须零报错，否则 `files` 那条 glob 是摆设。 */
const OUTSIDE = 'src/backend/wechat-data/tests/__db_discipline_probe__.ts'
const PRODUCTION_GLOB = 'src/backend/wechat-data/src/**/*.ts'

const eslint = (): ESLint => new ESLint({ cwd: ROOT, overrideConfigFile: CONFIG })

const lintText = async (code: string, filePath: string): Promise<string[]> => {
  const [r] = await eslint().lintText(code, { filePath })
  // 只数 `no-restricted-syntax`：解析错误之类的问题由下面第一条用例单独管，别混在这里。
  return (r?.messages ?? []).filter(m => m.ruleId === 'no-restricted-syntax').map(m => String(m.message))
}

/** R1：进了 withDb 的回调又自己开一条 —— 同一次读两个所有者。 */
const BAD_DOUBLE_OPEN = `import { withDb } from './db-open.ts'
export function f(p: string): number {
  return withDb(p, (db) => {
    const other = new DatabaseSync(p)
    return other.prepare('SELECT 1').all().length + db.prepare('SELECT 2').all().length
  })
}
`
/** R2：把 async 回调交给同步版 withDb —— 连接会在第一次让出时被关掉。两种写法都要咬。 */
const BAD_ASYNC_ARROW = `import { withDb } from './db-open.ts'
export function g(p: string): Promise<number> {
  return Promise.resolve(withDb(p, async (db) => (await db.prepare('SELECT 1').all()).length))
}
`
const BAD_ASYNC_FNEXPR = `import { withWritableDb } from './db-open.ts'
export function h(p: string): number {
  return withWritableDb(p, async function (db) { return (await db.prepare('SELECT 1').all()).length })
}
`
/**
 * 本项目**推荐**的几种形状，一条都不许误伤：
 * 嵌套 try（外层管打开失败、内层 finally 管一定关）、`withDbAsync` 配 async 回调、
 * 普通同步 `withDb` 回调、以及独立函数里 open-outside-try + finally close。
 */
const GOOD = `import { DatabaseSync } from 'node:sqlite'
import { withDb, withDbAsync } from './db-open.ts'
export function ok(p: string): number {
  try {
    const db = new DatabaseSync(p)
    try {
      return db.prepare('SELECT 1').all().length
    } finally {
      db.close()
    }
  } catch {
    return 0
  }
}
export function also(p: string): Promise<number> {
  return withDbAsync(p, async (db) => (await db.prepare('SELECT 1').all()).length)
}
export function plain(p: string): number {
  return withDb(p, (db) => db.prepare('SELECT 2').all().length)
}
`

describe('#24 的 DB 闸门：ESLint 配置必须真的会咬（且不误伤）', () => {
  it('配置加载得动，作用域非空，真实生产树零违规', async () => {
    expect(existsSync(CONFIG), 'eslint.config.mjs 不见了 —— #24 整条闸门就没了').toBe(true)
    const results = await eslint().lintFiles([PRODUCTION_GLOB])
    // 2026-09-27 实测该树 202 个 .ts；下界留一半余量，防「glob 漂了 ⇒ 零文件 ⇒ 全部断言恒真」。
    expect(results.length, '匹配到的生产文件数').toBeGreaterThanOrEqual(100)
    const fatal = results.flatMap(r => r.messages.filter(m => m.fatal).map(m => `${r.filePath}: ${m.message}`))
    expect(fatal.join('\n'), '有文件解析失败 ⇒ 后面所有断言都是假的').toBe('')
    const hits = results.flatMap(r => r.messages.filter(m => m.ruleId === 'no-restricted-syntax')
      .map(m => `${r.filePath.replace(ROOT, '')}:${String(m.line)} ${String(m.message)}`))
    expect(hits.join('\n'), '生产树上出现了违规（要么真写坏了形状，要么该按 spec 那边记账而不是放宽这里）').toBe('')
  })

  it('R1 咬得住「withDb 回调里再开一条连接」', async () => {
    const msgs = await lintText(BAD_DOUBLE_OPEN, INSIDE)
    expect(msgs.length, '这条坏写法没被报出来 ⇒ R1 是装饰').toBe(1)
    expect(msgs[0] ?? '', '报错信息要指路（该用什么），不要只说「不许」').toMatch(/withDb/)
  })

  it('R2 咬得住 async 回调，箭头与 function 两种写法都算', async () => {
    const arrow = await lintText(BAD_ASYNC_ARROW, INSIDE)
    const fnExpr = await lintText(BAD_ASYNC_FNEXPR, INSIDE)
    expect(arrow.length, 'async 箭头回调没被报 ⇒ R2 漏了最常见的写法').toBe(1)
    expect(fnExpr.length, 'async function 表达式没被报 ⇒ 选择器只认箭头函数（实测漏一半）').toBe(1)
    expect((arrow[0] ?? '').concat(fnExpr[0] ?? ''), '报错要提 withDbAsync 这条出路').toMatch(/withDbAsync/)
  })

  it('推荐形状零误伤（报告原话那一版就是在这里翻车的）', async () => {
    expect(await lintText(GOOD, INSIDE), '正确写法被判成缺陷 ⇒ 这条闸门只会被 no-verify 掉').toEqual([])
  })

  it('作用域只在生产源码：同一份坏写法落在测试树里不报', async () => {
    expect(await lintText(BAD_DOUBLE_OPEN, OUTSIDE),
      '测试树也被管住了 ⇒ `files` 那条 glob 没在起作用（夹具有正当理由开坏连接）').toEqual([])
    const cfgText = readFileSync(CONFIG, 'utf8').replace(/\r\n/g, '\n')
    expect(cfgText, '配置里找不到那条生产 glob ⇒ 上面「不报」可能只是巧合').toContain(PRODUCTION_GLOB)
    // 结构哨兵：两条选择器。少了任何一条，上面的正面用例就会退化成恒真。
    const selectors = cfgText.match(/selector:/g) ?? []
    expect(selectors.length, `配置里只剩 ${String(selectors.length)} 条选择器（应为 2 条）`).toBe(2)
  })

  it('账本没被顶掉：AST 棘轮那份 spec 还在守「还剩几处待改造」', () => {
    const ledger = join(HERE, 'query-db-lifetime.spec.ts')
    expect(existsSync(ledger), 'query-db-lifetime.spec.ts 不在了 ⇒ ESLint 成了唯一防线，而它判不了作用域').toBe(true)
    const text = readFileSync(ledger, 'utf8')
    expect(text, '那份 spec 不再持有只能变小的站点清单了').toContain('KNOWN_UNFIXED')
    expect(text).toContain('new DatabaseSync')
  })
})
