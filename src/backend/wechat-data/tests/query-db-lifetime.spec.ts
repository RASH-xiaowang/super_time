/**
 * P0-1「DB 连接在 catch 分支泄漏」的守卫（CODE-AUDIT-2026-09-26 第一批 #1）。
 *
 * ## 要守的事实
 *
 * `query/**` 原先各处自己写「try 内 `new DatabaseSync` → 成功路径 `db.close()` → catch 吞掉」。
 * 那个形状**在异常路径上必然漏 close**：`db` 是 try 块内的 `const`，catch 里拿不到它。
 * 本机（Node 24 / win32）实测：同一进程只要还有一条连接开着，
 * `unlinkSync` 就报 **EBUSY**（`rmSync` 报 EPERM）且重试无效 —— 见
 * `src/backend/tests/helpers/temp-db.ts` 的病因记录。所以「漏 close」不是抽象的资源问题，
 * 而是「解密目录 / 备份再也替换不掉」。
 *
 * ## 三层判据
 *
 * 1. **行为**：`withDb` 成功/抛错两条路径都把连接关掉 —— 用「跑完之后库文件立刻可删」来量，
 *    而不是数源码里有没有 `close`。生产入口同样这么量（`indexReady` 那几条会真的抛错）。
 * 2. **棘轮**：AST 扫全仓 `new DatabaseSync(`，把「close 只在成功路径上」的站点数出来，
 *    与允许清单**逐文件逐个**对齐 ⇒ 新增一处就红，改好一处也必须把清单改小（不许腐烂）。
 * 3. **反脆弱**：审查报告点名的 6 个文件不许回到清单里。
 *
 * AST 而不是正则：注释里也写着 `from './xxx.ts'`、`db.close()` 这类字样，本仓有过误报前例。
 * @vitest-environment node
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { getSearchIndexFreshness, getSearchIndexStatus, indexReady } from '../src/query/search-scaffold.ts'
import { searchUnified } from '../src/query/unified-search.ts'
import { usernameByChatId } from '../src/query/voice.ts'
import { withDb } from '../src/query/db-open.ts'
import { resolveAvatar, resolveAvatarsLocal } from '../src/query/avatar.ts'
import { queryContact360 } from '../src/query/contact360.ts'
import { queryOverview } from '../src/query/overview.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_ROOT = join(HERE, '..', 'src')

/** 审查报告点名的文件（已改造完，回到清单里就是回退）。 */
const AUDIT_FIXED = [
  'query/unified-search.ts',
  'query/voice.ts',
  'query/search-scaffold.ts',
  'query/graph.ts',
  'query/privacy.ts',
  // P1-7 补测时收口的两份：payments 本来就是「finally 里关一次」的正确形状，改成 withDb 是为了
  // 让「谁拥有连接」只有一个答案；calendar 是**真漏**——存在性检查写在 try 之外，
  // 坏分片既漏句柄又把异常抛给整月（`calendar-daily-counts.spec.ts` 钉住），
  // 而它的 AST 判据抓不到（finally 里确实有一次 close），是「判据形状覆盖不到的一种漏法」。
  'query/payments.ts',
  'query/calendar.ts',
]

/**
 * 已知仍待改造的站点（按文件计）—— 棘轮：**只能变小**。
 * 口径：`new DatabaseSync` 之后 close 只出现在成功路径上（catch / finally 里没有）。
 * 这些点同一份 AST 判据会稳定报出来，红的时候把 file:line 一起打印。
 */
const KNOWN_UNFIXED: Record<string, number> = {
  'query/annual-report.ts': 1,
  'query/asset-insights.ts': 2,
  'query/contact360.ts': 1,
  'query/daily-summary.ts': 1,
  'query/edit.ts': 3,
  'query/favorites.ts': 1,
  'query/group-info.ts': 1,
  'query/group-insights.ts': 2,
  'query/handoff.ts': 1,
  'query/media-assets.ts': 1,
  'query/media-voice.ts': 1,
  'query/messages.ts': 1,
  'query/moments-insights.ts': 1,
  'query/official-assets.ts': 2,
  'query/overview-insights.ts': 1,
  'query/overview.ts': 2,
  'query/records.ts': 1,
  'query/retrieval/embedding.ts': 1,
  'query/search-build.ts': 1,
  'query/search-query.ts': 1,
}

// ---------------------------------------------------------------- 行为层夹具

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 下一条用例会自己报泄漏 */ }
  }
  scratch.length = 0
})

function tempRoot(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `wx-db-life-${tag}-`))
  scratch.push(dir)
  return dir
}

/** 建一个真实的库（写完立刻关，留给只读打开用）。 */
function makeDb(file: string, exec: (db: DatabaseSync) => void): string {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  try { exec(db) } finally { db.close() }
  return file
}

/**
 * 泄漏探针：目录树里每个 `.db` 都必须**当场可删**。
 * 只要还有一条连接没关，Windows 就给 EBUSY/EPERM ⇒ 这就是「catch 分支漏 close」的实测形状。
 */
function leakedFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.(db|sqlite)$/.test(e.name)) continue
      try { unlinkSync(p) } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? ''
        if (code === 'EBUSY' || code === 'EPERM') out.push(relative(root, p).split(sep).join('/') + ` (${code})`)
        else throw err
      }
    }
  }
  walk(root)
  return out
}

// ---------------------------------------------------------------- 行为层用例

describe('withDb：一次性的只读连接', () => {
  function fixture(tag: string): string {
    const root = tempRoot(tag)
    return makeDb(join(root, 'x.db'), (db) => {
      db.exec('CREATE TABLE t (a TEXT)')
      db.prepare('INSERT INTO t VALUES (?)').run('hello')
    })
  }

  it('成功路径把连接关掉（跑完之后库文件立刻可删）', () => {
    const file = fixture('ok')
    const row = withDb(file, (db) => db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number })
    expect(Number(row.c)).toBe(1)
    expect(leakedFiles(dirname(file))).toEqual([])
  })

  it('回调抛错也把连接关掉，并且错误原样上抛（不静默降级）', () => {
    const file = fixture('throw')
    expect(() => withDb(file, () => { throw new Error('库损坏') })).toThrow('库损坏')
    expect(leakedFiles(dirname(file))).toEqual([])
  })

  it('回调提前 return 也关掉（早退是这个仓库最常见的漏法）', () => {
    const file = fixture('early')
    const n = withDb(file, (db) => {
      db.prepare('SELECT 1').get()
      return 7
    })
    expect(n).toBe(7)
    expect(leakedFiles(dirname(file))).toEqual([])
  })

  it('只读：写不进去（误用成写库要当场响）', () => {
    const file = fixture('ro')
    expect(() => withDb(file, (db) => db.exec("INSERT INTO t VALUES ('x')"))).toThrow()
    expect(leakedFiles(dirname(file))).toEqual([])
  })

  it('反例哨兵：真的漏 close 时探针会红（不然上面几条是恒真）', () => {
    const root = tempRoot('sentinel')
    const file = makeDb(join(root, 'y.db'), (db) => { db.exec('CREATE TABLE t (a TEXT)') })
    const leaked = new DatabaseSync(file, { readOnly: true })
    leaked.prepare('SELECT * FROM t').all()
    // 故意不 close —— 这就是 P0-1 修之前每一处 catch 分支留下的状态
    expect(leakedFiles(root)).not.toEqual([])
    leaked.close()
    expect(leakedFiles(root)).toEqual([])
  })
})

describe('生产读路径不再在异常分支泄漏句柄', () => {
  /** 一个「有库、但库里没有它要的表」的数据根 —— 每次 prepare 都抛「no such table」。 */
  function brokenRoot(tag: string): { root: string; dec: string } {
    const root = tempRoot(tag)
    const dec = join(root, 'decrypted')
    // 索引库在 decrypted 的**同级**（searchIndexPath 的口径）
    makeDb(join(root, 'wechat_search.db'), (db) => { db.exec('CREATE TABLE unrelated (a TEXT)') })
    makeDb(join(dec, 'message', 'media_0.db'), (db) => { db.exec('CREATE TABLE unrelated (a TEXT)') })
    mkdirSync(join(dec, 'message'), { recursive: true })
    return { root, dec }
  }

  it('indexReady：库里没有 message_meta 时返回 false，且不留句柄', () => {
    const { root, dec } = brokenRoot('index-ready')
    expect(indexReady(dec)).toBe(false)
    expect(leakedFiles(root)).toEqual([])
  })

  it('getSearchIndexStatus / getSearchIndexFreshness：抛错降级后同样不留句柄', () => {
    const { root, dec } = brokenRoot('index-status')
    expect(indexReady(dec)).toBe(false)
    const st = getSearchIndexStatus(dec)
    expect(st.exists).toBe(true)
    expect(st.ready).toBe(false)
    const fresh = getSearchIndexFreshness(dec)
    expect(fresh.refreshedMs).toBe(0)
    expect(leakedFiles(root)).toEqual([])
  })

  it('usernameByChatId：media_0.db 缺 Name2Id 时返回空串，且不留句柄', () => {
    const { root, dec } = brokenRoot('username')
    expect(usernameByChatId(dec, '1')).toBe('')
    expect(leakedFiles(root)).toEqual([])
  })

  it('searchUnified：只有坏库的数据根也能跑完，整棵树都不留句柄', () => {
    const { root, dec } = brokenRoot('unified')
    makeDb(join(dec, 'contact', 'contact.db'), (db) => { db.exec('CREATE TABLE unrelated (a TEXT)') })
    makeDb(join(dec, 'favorite', 'favorite.db'), (db) => { db.exec('CREATE TABLE unrelated (a TEXT)') })
    makeDb(join(dec, 'hardlink', 'hardlink.db'), (db) => { db.exec('CREATE TABLE unrelated (a TEXT)') })
    makeDb(join(dec, 'general', 'general.db'), (db) => { db.exec('CREATE TABLE unrelated (a TEXT)') })
    makeDb(join(dec, 'sns', 'db_sns', 'sns.db'), (db) => { db.exec('CREATE TABLE unrelated (a TEXT)') })
    const snap = searchUnified(dec, '张三')
    expect(snap.query).toBe('张三')
    expect(leakedFiles(root)).toEqual([])
  })

  it('好数据仍然查得到（改造只动句柄生命周期，不动结果）', () => {
    const root = tempRoot('good')
    const dec = join(root, 'decrypted')
    makeDb(join(dec, 'contact', 'contact.db'), (db) => {
      db.exec('CREATE TABLE contact (username TEXT, remark TEXT)')
      db.prepare('INSERT INTO contact VALUES (?, ?)').run('wxid_a', '张三')
    })
    const snap = searchUnified(dec, '张三')
    expect(snap.contacts.map(c => c.name)).toEqual(['张三'])
    expect(leakedFiles(root)).toEqual([])
  })
})

// ------------------------------------------- 行为层（第四批 #11：头像 / 360° / 总览）

/**
 * 这三条钉的是同一件事：`query/avatar.ts`、`query/contact360.ts`、`query/overview.ts` 里
 * 那批「打开 → prepare（表不在就抛）→ close 写在成功路径上」的读函数。
 * 探针用**整个数据根都可删**来判：只要还有一条连接没关，Windows 上就是 EBUSY。
 *
 * 为什么挑这三条：它们全是「降级成空结果」的路径 —— 界面上看到的就是"这个人没有头像 /
 * 这个联系人没有数据"，所以漏句柄在功能上完全隐形，只有删目录/换数据根的那一刻才暴露。
 * 每条对应的坏法（把 withDb 换回裸 open + 成功路径 close）由变异 M256–M258 自证。
 */
describe('头像 / 360° / 总览的读路径不留句柄', () => {
  /** 一个「每个库都在、每个表都不对」的数据根：任何 prepare 都会抛。 */
  function allTablesMissing(tag: string): { root: string; dec: string } {
    const root = tempRoot(tag)
    const dec = join(root, 'decrypted')
    const junk = (rel: string): void => { makeDb(join(dec, rel), (db) => { db.exec('CREATE TABLE unrelated (a TEXT)') }) }
    junk(join('head_image', 'head_image.db'))
    junk(join('contact', 'contact.db'))
    junk(join('message', 'media_0.db'))
    junk(join('message', 'message_resource.db'))
    junk(join('general', 'general.db'))
    junk(join('sns', 'db_sns', 'sns.db'))
    return { root, dec }
  }

  it('resolveAvatar：三级来源全抛错 ⇒ kind=none，且一棵树都可删', () => {
    const { root, dec } = allTablesMissing('avatar-one')
    expect(resolveAvatar(dec, 'wxid_a', undefined, '张三')).toEqual({ kind: 'none' })
    expect(leakedFiles(root)).toEqual([])
  })

  it('resolveAvatarsLocal：批量那两路（head_image + contact）同样不漏', () => {
    const { root, dec } = allTablesMissing('avatar-batch')
    expect(resolveAvatarsLocal(dec, ['wxid_a', 'wxid_b'], { allowRemote: true })).toEqual({})
    expect(leakedFiles(root)).toEqual([])
  })

  it('queryContact360：分片 / 朋友圈 / 转账 / 共同群全缺 ⇒ 空档案且不留句柄', () => {
    const { root, dec } = allTablesMissing('contact360')
    const snap = queryContact360(dec, 'wxid_a')
    expect(snap.username).toBe('wxid_a')
    expect(snap.messages.count).toBe(0)
    expect(snap.moments.count).toBe(0)
    expect(snap.funds).toEqual({ transfers: 0, redpackets: 0 })
    expect(snap.commonGroups).toEqual([])
    expect(leakedFiles(root)).toEqual([])
  })

  /**
   * 这条**故意不假设**总览能算完整张表：`queryOverview` 会经 `queryContacts` 读 `contact` 表，
   * 表不在时它如实抛错（P1-1 的读失败契约：降级成空数据才是错的做法）。
   * 所以要钉的是"抛错这条路上也不留句柄"—— 那才是 countRows 这类降级分支的真实形状。
   */
  it('queryOverview：坏库上如实抛错，但一棵树仍然都可删', () => {
    const { root, dec } = allTablesMissing('overview')
    expect(() => { queryOverview(dec) }).toThrow()
    expect(leakedFiles(root)).toEqual([])
  })
})

// ---------------------------------------------------------------- 棘轮层

interface Suspect { file: string; line: number; name: string; shape: string }

/** 递归列出要扫的 .ts（不碰 deps/**：那是 vendored 上游代码）。 */
function listSources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'deps' || e.name === 'node_modules' || e.name === 'lib') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) listSources(p, out)
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/**
 * 扫出「打开之后 close 只出现在成功路径上」的站点。
 * 安全形状认三种：finally 里 close、catch 里 close、把句柄 return 给调用方（工厂函数）。
 */
function scanLeaks(files: string[]): { suspects: Suspect[]; opens: number } {
  const suspects: Suspect[] = []
  let opens = 0
  for (const f of files) {
    const sf = ts.createSourceFile(f, readFileSync(f, 'utf8').replace(/\r\n/g, '\n'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const parents = new Map<ts.Node, ts.Node>()
    const link = (node: ts.Node, parent?: ts.Node): void => {
      if (parent) parents.set(node, parent)
      ts.forEachChild(node, (c) => link(c, node))
    }
    link(sf)
    const ancestorsOf = (node: ts.Node): ts.Node[] => {
      const chain: ts.Node[] = []
      let cur = parents.get(node)
      while (cur) { chain.push(cur); cur = parents.get(cur) }
      return chain
    }
    const isInside = (outer: ts.Node, node: ts.Node): boolean => {
      let cur: ts.Node | undefined = node
      while (cur) { if (cur === outer) return true; cur = parents.get(cur) }
      return false
    }
    const isFnNode = (n: ts.Node): boolean => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)
      || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)

    const openSites: Array<{ name: string; node: ts.Node }> = []
    const closeSites: Array<{ target: string; node: ts.Node }> = []
    const seen = new Set<ts.Node>()
    const walk = (node: ts.Node): void => {
      // 去重：本仓踩过「同一子树被走两遍 ⇒ 计数翻倍」
      if (seen.has(node)) return
      seen.add(node)
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isNewExpression(node.initializer)
        && /(^|\.)DatabaseSync$/.test(node.initializer.expression.getText(sf))) {
        openSites.push({ name: node.name.getText(sf), node })
      }
      if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
        && ts.isPropertyAccessExpression(node.expression.expression)
        && node.expression.expression.name.text === 'close') {
        closeSites.push({ target: node.expression.expression.expression.getText(sf).trim(), node })
      }
      ts.forEachChild(node, walk)
    }
    walk(sf)
    opens += openSites.length

    for (const op of openSites) {
      const fn = ancestorsOf(op.node).find(isFnNode) ?? null
      const scoped = closeSites.filter((c) => c.target === op.name && (!fn || isInside(fn, c.node)))
      const closedInFinally = scoped.some((c) => {
        const t = ancestorsOf(c.node).find((a) => ts.isTryStatement(a) && !!a.finallyBlock && isInside(a.finallyBlock, c.node))
        return !!t && (!fn || isInside(fn, t))
      })
      const closedInCatch = scoped.some((c) => {
        const cl = ancestorsOf(c.node).find((a) => ts.isCatchClause(a))
        return !!cl && (!fn || isInside(fn, cl))
      })
      if (closedInFinally || closedInCatch) continue
      const returnsHandle = !!fn && (() => {
        let hit = false
        const seenInner = new Set<ts.Node>()
        const w = (n: ts.Node): void => {
          if (hit || seenInner.has(n)) return
          seenInner.add(n)
          if (n !== fn && isFnNode(n)) return
          if (ts.isReturnStatement(n) && n.expression && ts.isIdentifier(n.expression) && n.expression.text === op.name) hit = true
          ts.forEachChild(n, w)
        }
        w(fn)
        return hit
      })()
      if (returnsHandle) continue
      suspects.push({
        file: relative(SRC_ROOT, f).split(sep).join('/'),
        line: sf.getLineAndCharacterOfPosition(op.node.getStart(sf)).line + 1,
        name: op.name,
        shape: scoped.length === 0 ? '函数里根本没有 close' : 'close 只在成功路径上',
      })
    }
  }
  return { suspects, opens }
}

describe('query 层的连接纪律（棘轮）', () => {
  const files = listSources(SRC_ROOT)
  const { suspects, opens } = scanLeaks(files)
  const byFile = new Map<string, number>()
  for (const s of suspects) byFile.set(s.file, (byFile.get(s.file) ?? 0) + 1)

  it('扫描真的看到了足够多的打开点（防空转）', () => {
    expect(files.length).toBeGreaterThan(50)
    // 下界只用来防「扫描器坏了 ⇒ 集合为空 ⇒ 全部断言恒真」，不代表目标值：改造在推进，这个数只会往下走。
    expect(opens).toBeGreaterThanOrEqual(60)
  })

  it('待改造站点与清单逐个对齐（只能变小，不能变大）', () => {
    const actual: Record<string, number> = {}
    for (const [k, v] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) actual[k] = v
    const detail = suspects.map(s => `  ${s.file}:${s.line} [${s.name}] ${s.shape}`).join('\n')
    expect(actual, `新增/变多的泄漏点要修，不要往清单里加。当前实测：\n${detail}`).toEqual(KNOWN_UNFIXED)
  })

  it('审查报告点名的 6 个文件已经改完，不许回到清单', () => {
    for (const f of AUDIT_FIXED) {
      expect(KNOWN_UNFIXED[f], `${f} 不该再有待改造站点`).toBeUndefined()
      expect(byFile.get(f) ?? 0, `${f} 实测仍有泄漏形状`).toBe(0)
    }
  })

  it('withDb 是这些文件唯一的打开方式（不许绕过去手写 close）', () => {
    for (const f of AUDIT_FIXED) {
      const src = readFileSync(join(SRC_ROOT, f), 'utf8')
      // 允许带泛型实参的写法（`withDb<PaymentStatus>(...)`）：只认字面 `withDb(` 会把
      // 「显式标注返回值」这种**更好**的写法判成绕过。
      expect(src, `${f} 必须经 withDb 拿连接`).toMatch(/\bwithDb[<(]/)
      expect(src, `${f} 又出现了裸 new DatabaseSync(`).not.toContain('new DatabaseSync(')
    }
  })
})
