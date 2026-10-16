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
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { getSearchIndexFreshness, getSearchIndexStatus, indexReady, INDEX_SCHEMA_VERSION, searchIndexPath } from '../src/query/search-scaffold.ts'
import { searchUnified } from '../src/query/unified-search.ts'
import { usernameByChatId } from '../src/query/voice.ts'
import { withDb, withWritableDb } from '../src/query/db-open.ts'
import { listEditedMessages, resetEditedMessage } from '../src/query/edit.ts'
import { deleteFavoriteItems } from '../src/query/favorites.ts'
import { resolveAvatar, resolveAvatarsLocal } from '../src/query/avatar.ts'
import { queryContact360 } from '../src/query/contact360.ts'
import { queryOverview } from '../src/query/overview.ts'
import { queryGroupInsights } from '../src/query/group-insights.ts'
import { listHandoffReminds } from '../src/query/handoff.ts'
import { queryMediaAssets } from '../src/query/media-assets.ts'
import { resolveVoiceInfo } from '../src/query/media-voice.ts'
import { queryOfficialAssets } from '../src/query/official-assets.ts'
import { searchWechatFts } from '../src/query/search-query.ts'
import { queryRevoked } from '../src/query/records.ts'
import { queryMomentsInsights } from '../src/query/moments-insights.ts'
import { queryOverviewInsights } from '../src/query/overview-insights.ts'
import { listMessagesInRange } from '../src/query/search-build.ts'
import { msgCreateTimeByServerId } from '../src/query/messages.ts'
import { vectorDbPath, __internals as embeddingInternals } from '../src/query/retrieval/embedding.ts'

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
 * 第四批 #11（2026-09-26 合批）清账的文件：清单里不该再有它们。
 *
 * 它们**不参加**「withDb 是唯一打开方式」那条：`edit.ts` 的 `openEditStore` / `findShard`
 * 是把连接**交给调用方**的工厂（谁拿到谁关，是另一种形状，不该被这条误伤）。
 * 所以这份名单只参加「不许回到清单」那一条。
 */
const BATCH4_FIXED = [
  'query/avatar.ts',
  'query/contact360.ts',
  'query/edit.ts',
  'query/overview.ts',
  'query/annual-report.ts',
  'query/asset-insights.ts',
  'query/daily-summary.ts',
  'query/favorites.ts',
  'query/group-info.ts',
  // 第五刀（同日合批）：洞察 / 提醒 / 媒体 / 撤回 / 全文检索 / 构建 / 向量粗筛
  'query/group-insights.ts',
  'query/handoff.ts',
  'query/media-assets.ts',
  'query/media-voice.ts',
  'query/official-assets.ts',
  'query/records.ts',
  'query/search-query.ts',
  'query/moments-insights.ts',
  'query/overview-insights.ts',
  'query/search-build.ts',
  'query/retrieval/embedding.ts',
]

/**
 * 已经**一个裸 open 都不剩**的文件：连接只能经 withDb/withWritableDb 拿。
 *
 * 与 `BATCH4_FIXED` 的区别：那批里多数还留着「逐分片扫」的循环（open 在 try 外、
 * close 在 `finally` 里），形状本身安全，只是「谁拥有连接」有第二个答案；
 * 这两份连那种残留都清掉了，所以可以按最严的口径钉死 —— 再写一句 `new DatabaseSync(` 就红。
 */
const NO_RAW_OPEN = [
  'query/handoff.ts',
  'query/media-assets.ts',
  'query/notes.ts',
]

/**
 * 已知仍待改造的站点（按文件计）—— 棘轮：**只能变小**。
 * 口径：`new DatabaseSync` 之后 close 只出现在成功路径上（catch / finally 里没有）。
 *
 * 当前清单已清空：`messages.ts` 已改为经 `withShards` 打开，所有句柄由 helper
 * 的 `finally` 统一关闭。helper 内的 `db.close()` 必须保留为直接调用，AST 棘轮才能
 * 识别到关闭动作。
 */
const KNOWN_UNFIXED: Record<string, number> = {}

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
    expect(resolveAvatarsLocal(dec, ['wxid_a', 'wxid_b'], {})).toEqual({})
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
  it('queryOverview：坏库上如实抛错，但一棵树仍然都可删', async () => {
    const { root, dec } = allTablesMissing('overview')
    // 2026-09-28：`queryOverview` 改 async 之后失败形态是 **rejected promise** ——
    // `expect(() => fn()).toThrow()` 抓不到它（那条会恒真地"通过"，反而掩盖回归）。
    await expect(queryOverview(dec)).rejects.toThrow()
    expect(leakedFiles(root)).toEqual([])
  })
})

describe('withWritableDb：写路径也要无论成败都关', () => {
  function emptyDb(tag: string): string {
    const dir = tempRoot(tag)
    const file = join(dir, 'w.db')
    mkdirSync(dirname(file), { recursive: true })
    // 这一颗是"可写"的用例，建库也得可写（withDb 是只读的，写不进 schema）
    const db = new DatabaseSync(file)
    try { db.exec('CREATE TABLE t (a TEXT)') } finally { db.close() }
    return file
  }

  it('写得进去（这正是它与 withDb 的分别 —— 混用会当场抛，不会被静默降级）', () => {
    const file = emptyDb('w-ok')
    withWritableDb(file, (db) => { db.prepare(`INSERT INTO t VALUES ('x')`).run() })
    const got = withDb(file, (db) => (db.prepare(`SELECT a FROM t`).get() as { a: string }).a)
    expect(got).toBe('x')
    expect(leakedFiles(dirname(file))).toEqual([])
  })

  it('回调抛错也把连接关掉（写一半失败是之前漏得最多的一种）', () => {
    const file = emptyDb('w-throw')
    expect(() => { withWritableDb(file, () => { throw new Error('写失败') }) }).toThrow('写失败')
    expect(leakedFiles(dirname(file))).toEqual([])
  })

  it('withDb 写不进去：只读那颗 helper 覆盖不到写路径，所以必须有第二颗', () => {
    const file = emptyDb('w-ro')
    expect(() => { withDb(file, (db) => { db.prepare(`INSERT INTO t VALUES ('nope')`).run() }) }).toThrow()
    expect(leakedFiles(dirname(file))).toEqual([])
  })
})

/**
 * `edit.ts` 那三处（读列表、读原快照、删记录）是全仓唯一混了写路径的一组：
 * 前两条走只读的 `withDb`，删除那条走 `withWritableDb`。两头都验：
 * 坏库上如实降级且不留句柄；好库上真的改回原文、删掉记录，并且也不留句柄。
 */
describe('编辑副本那三条读/写路径不留句柄', () => {
  it('listEditedMessages：编辑记录库表不在 ⇒ 空列表且不留句柄', () => {
    const { root, dec } = brokenEdits('edit-list')
    expect(listEditedMessages(dec, 'wxid_a')).toEqual({ items: [], total: 0 })
    expect(leakedFiles(root)).toEqual([])
  })

  it('resetEditedMessage：读不到原快照时如实报错，不留句柄', () => {
    const { root, dec } = brokenEdits('edit-reset')
    const r = resetEditedMessage(dec, 'wxid_a', 1)
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
    expect(leakedFiles(root)).toEqual([])
  })

  it('resetEditedMessage：好库上真把原文改回去、删掉记录，且不留句柄', () => {
    const root = tempRoot('edit-reset-good')
    const dec = join(root, 'decrypted')
    const table = 'Msg_' + createHash('md5').update('wxid_a', 'utf8').digest('hex')
    makeDb(join(dec, 'message', 'media_0.db'), (db) => {
      db.exec(`CREATE TABLE "${table}" (local_id INTEGER PRIMARY KEY, message_content TEXT)`)
      db.prepare(`INSERT INTO "${table}" VALUES (1, '改过的内容')`).run()
    })
    makeDb(join(root, 'message_edits.db'), (db) => {
      db.exec('CREATE TABLE message_edits (account TEXT, session_id TEXT, db TEXT, table_name TEXT, local_id INTEGER, first_edited_at INTEGER, last_edited_at INTEGER, edit_count INTEGER, original_msg_json TEXT, edited_cols_json TEXT)')
      db.prepare('INSERT INTO message_edits VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        'wxid_a', 'wxid_a', 'message', table, 1, 0, 1, 1, JSON.stringify({ message_content: '原文' }), `['${table}']`,
      )
    })
    expect(resetEditedMessage(dec, 'wxid_a', 1)).toEqual({ ok: true })
    const back = withDb(join(dec, 'message', 'media_0.db'), (db) =>
      (db.prepare(`SELECT message_content AS c FROM "${table}" WHERE local_id = 1`).get() as { c: string }).c)
    expect(back).toBe('原文')
    const left = withDb(join(root, 'message_edits.db'), (db) => (db.prepare('SELECT COUNT(*) AS n FROM message_edits').get() as { n: number }).n)
    expect(Number(left)).toBe(0)
    expect(leakedFiles(root)).toEqual([])
  })

  /** 编辑记录库与解密目录是同级（editDbPath 的口径），所以探针要覆盖到 root 整棵树。 */
  function brokenEdits(tag: string): { root: string; dec: string } {
    const root = tempRoot(tag)
    const dec = join(root, 'decrypted')
    mkdirSync(dec, { recursive: true })
    makeDb(join(root, 'message_edits.db'), (db) => { db.exec('CREATE TABLE unrelated (a TEXT)') })
    return { root, dec }
  }
})
describe('删除收藏那两条路径不留句柄', () => {
  const favDb = (dir: string): string => {
    const p = join(dir, 'favorite', 'favorite.db')
    mkdirSync(join(dir, 'favorite'), { recursive: true })
    return p
  }

  it('fav_db_item 表不在 ⇒ 如实报错，且连接已关（Windows 上库文件仍可删）', () => {
    const root = tempRoot('fav-no-table')
    const dec = join(root, 'decrypted')
    makeDb(favDb(dec), (db) => { db.exec('CREATE TABLE unrelated (a TEXT)') })
    const r = deleteFavoriteItems(dec, [1])
    expect(r.ok).toBe(false)
    expect(r.error).toBe('fav_db_item 表不存在')
    expect(leakedFiles(root)).toEqual([])
  })

  it('真删掉两条：结果、库里剩下的行数、以及句柄都检查', () => {
    const root = tempRoot('fav-delete-ok')
    const dec = join(root, 'decrypted')
    const file = favDb(dec)
    makeDb(file, (db) => {
      db.exec('CREATE TABLE fav_db_item (local_id INTEGER PRIMARY KEY, title TEXT)')
      for (const id of [1, 2, 3]) db.prepare('INSERT INTO fav_db_item VALUES (?, ?)').run(id, 'x')
    })
    // 只读那颗 helper 写不进去，所以这一步必须走 withWritableDb —— 用错就是"报错但什么都没删"
    expect(deleteFavoriteItems(dec, [1, 3])).toEqual({ ok: true, deleted: 2 })
    const left = withDb(file, (db) => (db.prepare('SELECT COUNT(*) AS n FROM fav_db_item').get() as { n: number }).n)
    expect(Number(left)).toBe(1)
    expect(leakedFiles(root)).toEqual([])
  })
})

/**
 * 第五刀（#11 同日合批）改造的九处站点，跑在同一个「每个库都在、每个表都不对」的数据根上。
 *
 * 挑这些入口的理由和上一刀一样：它们走的都是**降级成空结果**的路径 —— 界面上看到的就是
 * 「没有提醒 / 没有群洞察 / 没有媒体统计」，漏句柄在功能上完全隐形，只有在换数据根或
 * 备份那一刻才暴露。每条对应的坏法（把 withDb 换回裸 open + 成功路径 close）由 M262–M270 自证。
 */
describe('洞察 / 提醒 / 媒体 / 撤回 / 检索的读路径不留句柄（第五刀）', () => {
  /** 每个库都在、每个表都不对的数据根。 */
  function junkRoot(tag: string): { root: string; dec: string } {
    const root = tempRoot(tag)
    const dec = join(root, 'decrypted')
    const junk = (rel: string): void => { makeDb(join(dec, rel), (db) => { db.exec('CREATE TABLE unrelated (a TEXT)') }) }
    junk(join('contact', 'contact.db'))
    junk(join('general', 'general.db'))
    junk(join('head_image', 'head_image.db'))
    junk(join('hardlink', 'hardlink.db'))
    junk(join('session', 'session.db'))
    junk(join('message', 'media_0.db'))
    junk(join('message', 'message_1.db'))
    junk(join('message', 'message_fts.db'))
    junk(join('sns', 'db_sns', 'sns.db'))
    return { root, dec }
  }

  it('queryGroupInsights：成员数/公告都探不到 ⇒ 全 0 且一棵树都可删（两处早退）', () => {
    const { root, dec } = junkRoot('gi-junk')
    const snap = queryGroupInsights(dec, 'room@chatroom')
    expect(snap.memberCount).toBe(0)
    expect(snap.total).toBe(0)
    expect(snap.announcement).toBe('')
    expect(snap.topMembers).toEqual([])
    expect(leakedFiles(root)).toEqual([])
  })

  it('listHandoffReminds：handoff_remind_v0 不在 ⇒ 空清单且不留句柄', () => {
    const { root, dec } = junkRoot('handoff-junk')
    expect(listHandoffReminds(dec)).toEqual({ items: [], total: 0 })
    expect(leakedFiles(root)).toEqual([])
  })

  it('queryMediaAssets：三类 hardlink 表都不在 ⇒ 全 0 且不留句柄', () => {
    const { root, dec } = junkRoot('media-assets-junk')
    const snap = queryMediaAssets(dec)
    expect(snap.categories).toEqual([])
    expect(snap.totalFiles).toBe(0)
    expect(snap.duplicates).toEqual([])
    expect(leakedFiles(root)).toEqual([])
  })

  it('resolveVoiceInfo：VoiceInfo 表不在 ⇒ 如实报「表不存在」，且那条连接已关', () => {
    const { root, dec } = junkRoot('voice-junk')
    const r = resolveVoiceInfo(dec, 'wxid_a', 1)
    expect(r.available).toBe(false)
    expect(r.error).toBe('VoiceInfo 表不存在')
    expect(leakedFiles(root)).toEqual([])
  })

  // 2026-09-28：`queryOfficialAssets` 改 async（逐张消息分片数条数要让出）⇒ 跟着 await。
  it('queryOfficialAssets：session/contact 两路都探空 ⇒ rows 为空且一棵树都可删', async () => {
    const { root, dec } = junkRoot('official-junk')
    const snap = await queryOfficialAssets(dec)
    expect(snap.rows).toEqual([])
    expect(snap.total).toBe(0)
    expect(leakedFiles(root)).toEqual([])
  })

  it('searchWechatFts：四个 FTS 表都不在 ⇒ 空命中且不留句柄', () => {
    const { root, dec } = junkRoot('fts-junk')
    expect(searchWechatFts(dec, '关键词', 10, new Map())).toEqual({ hits: [] })
    expect(leakedFiles(root)).toEqual([])
  })

  it('queryMomentsInsights：SnsTimeLine 表不在 ⇒ 交出空洞察（早退那条也不留句柄）', async () => {
    const { root, dec } = junkRoot('moments-junk')
    // 2026-09-28：`queryMomentsInsights` 改 async（游标让出需要），这里跟着 await。
    const snap = await queryMomentsInsights(dec)
    expect(snap.posts).toBe(0)
    // topItems 在类型上是可选的（noUncheckedIndexedAccess 会拦 `!.rows`）：
    // 缺字段时按 -1 处理，免得「根本没算出来」被当成「算出来是 0」放过去。
    expect(snap.topItems?.rows ?? -1).toBe(0)
    expect(leakedFiles(root)).toEqual([])
  })

  it('queryRevoked：撤回缓存表不在 ⇒ 空结果；表在时真查得出来，两条连接都不留', () => {
    const miss = junkRoot('revoked-miss')
    expect(queryRevoked(miss.dec)).toEqual({ items: [], total: 0 })
    expect(leakedFiles(miss.root)).toEqual([])

    const root = tempRoot('revoked-hit')
    const dec = join(root, 'decrypted')
    makeDb(join(dec, 'message', 'message_1.db'), (db) => {
      db.exec('CREATE TABLE x_weflow_anti_revoke_deleted_cache (local_type INTEGER, real_sender_id INTEGER, create_time INTEGER, message_content TEXT)')
      db.prepare('INSERT INTO x_weflow_anti_revoke_deleted_cache VALUES (1, 7, 1700000000, ?)').run('wxid_a:\n你好')
    })
    const r = queryRevoked(dec)
    expect(r.total).toBe(1)
    expect(r.items[0]?.sender).toBe('wxid_a')
    expect(r.items[0]?.content).toBe('你好')
    expect(leakedFiles(root)).toEqual([])
  })

  /**
   * 这一条量的不是句柄，而是「命中即 return」那个早退：`findShards` 会把**所有**含该表的
   * 分片一次性全开，旧写法轮到哪条关哪条 ⇒ 第二个分片之后再命中，第一个之后的连接没人关。
   * 两个分片各有一条同 server_id 的消息，命中落在第一片 ⇒ 第二片必须还能删。
   */
  it('msgCreateTimeByServerId：命中就 return 时，其余分片的连接也已关掉', () => {
    const root = tempRoot('msg-shards')
    const dec = join(root, 'decrypted')
    const table = 'Msg_' + createHash('md5').update('wxid_a', 'utf8').digest('hex')
    for (const n of [1, 2]) {
      makeDb(join(dec, 'message', `message_${n}.db`), (db) => {
        db.exec(`CREATE TABLE "${table}" (server_id INTEGER, create_time INTEGER)`)
        db.prepare(`INSERT INTO "${table}" VALUES (?, ?)`).run(12345, 1700000000 + n)
      })
    }
    expect(msgCreateTimeByServerId(dec, 'wxid_a', '12345')).toBe(1700000001)
    expect(leakedFiles(root)).toEqual([])
  })

  /**
   * `queryOverviewInsights` 内部用 `countRows` 逐库数行数，而 `countRows` 的形状正是
   * 「表不在 ⇒ 早退 0」—— 改造前那条早退没人关连接。这里不校验洞察的每个数字
   * （它依赖十几张表），只钉两件事：**跑完了**，且整棵树可删。
   */
  it('queryOverviewInsights：满库都是错表 ⇒ 算得出降级快照且不留句柄', async () => {
    const { root, dec } = junkRoot('overview-insights')
    const snap = await queryOverviewInsights(dec)
    expect(snap.messages.total).toBe(0)
    expect(snap.relations.top).toEqual([])
    expect(leakedFiles(root)).toEqual([])
  })

  /**
   * 这一条要**索引就绪但表结构不对**：`indexReady` 只看 `message_meta` 有没有行 +
   * `meta.schema_version`，所以建一张只有无关列的 `message_meta` 就能让探测通过、
   * 让真正的 `SELECT text, username, ...` 抛错 —— 那正是"开库成功、查询炸掉"的形状。
   */
  it('listMessagesInRange：索引假装就绪、列不全 ⇒ ready=false 且不留句柄', () => {
    const root = tempRoot('list-range')
    const dec = join(root, 'decrypted')
    mkdirSync(dec, { recursive: true })
    // searchIndexPath 落在数据根的**上一层**，所以库建在 root 而不是 root/decrypted 里
    makeDb(searchIndexPath(dec), (db) => {
      db.exec('CREATE TABLE message_meta (junk TEXT)')
      db.exec('CREATE TABLE meta (key TEXT, value TEXT)')
      db.prepare('INSERT INTO message_meta VALUES (?)').run('x')
      db.prepare('INSERT INTO meta VALUES (?, ?)').run('schema_version', INDEX_SCHEMA_VERSION)
    })
    // 先把夹具自证：indexReady 真的认这个库（否则下面那条断言是恒真）
    expect(indexReady(dec)).toBe(true)
    expect(listMessagesInRange(dec, 1, 2)).toEqual({ hits: [], ready: false })
    expect(leakedFiles(root)).toEqual([])
  })

  /**
   * SimHash 粗筛表：改造前那一条**根本没有 try**，`SELECT ... FROM vectors` 一抛
   * 就把连接留在进程里（向量库越大越容易撞）。这里两面都钉：表不在要如实抛，
   * 表在要读得出行，且两种结局之后库文件都可删。
   */
  it('loadHashRows：vectors 表不在 ⇒ 如实抛错且不留句柄；表在 ⇒ 读得出行', () => {
    const miss = tempRoot('hash-miss')
    const missDec = join(miss, 'decrypted')
    mkdirSync(join(missDec), { recursive: true })
    makeDb(vectorDbPath(missDec), (db) => { db.exec('CREATE TABLE unrelated (a TEXT)') })
    expect(() => { embeddingInternals.loadHashRows(missDec) }).toThrow()
    expect(leakedFiles(miss)).toEqual([])

    const hit = tempRoot('hash-hit')
    const hitDec = join(hit, 'decrypted')
    mkdirSync(join(hitDec), { recursive: true })
    makeDb(vectorDbPath(hitDec), (db) => {
      db.exec('CREATE TABLE vectors (fts_rowid INTEGER, hash_lo INTEGER, hash_hi INTEGER, username TEXT)')
      db.prepare('INSERT INTO vectors VALUES (?,?,?,?)').run(1, 2, 3, 'wxid_a')
      db.prepare('INSERT INTO vectors VALUES (?,?,?,?)').run(2, 4, 5, 'wxid_b')
    })
    const rows = embeddingInternals.loadHashRows(hitDec)
    expect(rows.map(r => r.rowid)).toEqual([1, 2])
    expect(leakedFiles(hit)).toEqual([])
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

  it('待改造清单必须是普通对象字面量（盲化成 Object.create(null) 会让棘轮假装已清空）', () => {
    expect(Object.getPrototypeOf(KNOWN_UNFIXED)).toBe(Object.prototype)
    // 单看运行时原型还挡不住 Object.create(Object.prototype) 这类写法，所以同时钉住声明形状。
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    // 把结尾拆开写，避免守卫字符串与真正声明重复，令变异登记表的唯一锚点失效。
    expect(self).toContain('const KNOWN_UNFIXED: Record<string, number> = ' + '{}')
  })

  it('审查报告点名的文件与第四批清账的文件都不许回到清单', () => {
    for (const f of [...AUDIT_FIXED, ...BATCH4_FIXED]) {
      expect(KNOWN_UNFIXED[f], `${f} 不该再有待改造站点`).toBeUndefined()
      expect(byFile.get(f) ?? 0, `${f} 实测仍有泄漏形状`).toBe(0)
    }
  })

  it('withDb 是这些文件唯一的打开方式（不许绕过去手写 close）', () => {
    for (const f of [...AUDIT_FIXED, ...NO_RAW_OPEN]) {
      const src = readFileSync(join(SRC_ROOT, f), 'utf8')
      // 允许带泛型实参的写法（`withDb<PaymentStatus>(...)`）：只认字面 `withDb(` 会把
      // 「显式标注返回值」这种**更好**的写法判成绕过。
      expect(src, `${f} 必须经 withDb / withWritableDb 拿连接`).toMatch(/\bwith(?:Writable)?Db[<(]/)
      expect(src, `${f} 又出现了裸 new DatabaseSync(`).not.toContain('new DatabaseSync(')
    }
  })
})
