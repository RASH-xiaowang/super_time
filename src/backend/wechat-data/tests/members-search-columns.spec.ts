/**
 * 成员搜索的**可检索列**守卫（第 4 个幻影引用的现场）。
 *
 * ## 为什么这一份不是"补个测试"
 *
 * `gateway-read.ts` 与 `query/members.ts` 的注释都写着「由 `scripts/check-members-search.js`
 * 对着真实库把关」—— 而**那个脚本不存在**（`scripts/` 里没有、全仓也没有）。
 * 更糟的是查一遍发现：它声称把关的那件事**根本没有被把关**。
 *
 * `contact_fts` 建表时只有 `name` 是可检索列（`username/remark/alias/quanpin` 全是 UNINDEXED），
 * 而 `name` 装的是 `remark ‖ nick_name ‖ username`。于是「按备注全拼 / 别名搜群成员」
 * 在**索引健康时永远搜不到**，只有降级走 LIKE 才搜得到 —— 第 96 轮那次修复只补到了
 * 两条 LIKE SQL 上，FTS 这条一直没补。同一句查询因索引在不在给出不同结果，
 * 比"两边都搜不到"更难查：用户偶尔搜得到、偶尔搜不到，而日志一切正常。
 *
 * ## 判据的形状
 *
 * 三组各钉一次：**全拼 / 别名 / 备注** 在 FTS 路径命中，并且 **FTS 与 LIKE 给出同一批人**
 * （这一条才是"结果不随索引状态漂移"的硬要求）。再加一条**旧索引必须被认出来并重建** ——
 * 不然修好了建表逻辑，存量用户的索引库还是 v1，问题照旧。
 *
 * 反向也要钉：FTS 是整词匹配，**半截词命中为空时必须让 LIKE 兜住** —— 否则装了索引反而搜得更少。
 * @module members-search-columns
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { searchIndexPath } from '../src/query/search.ts'
import { searchMembers } from '../src/query/members.ts'

const scratch: string[] = []

/**
 * 造一个最小数据根：`contact.db` 里三个人，各自只在某一列上能被搜到。
 * @returns decrypted 目录（索引库是它的兄弟 `<root>/wechat_search.db`）。
 */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'members-cols-'))
  scratch.push(root)
  const decrypted = join(root, 'decrypted')
  mkdirSync(join(decrypted, 'contact'), { recursive: true })
  const cdb = new DatabaseSync(join(decrypted, 'contact', 'contact.db'))
  cdb.exec('CREATE TABLE contact (id INTEGER PRIMARY KEY, username TEXT, remark TEXT, nick_name TEXT, alias TEXT, quan_pin TEXT, small_head_url TEXT, big_head_url TEXT)')
  const ins = cdb.prepare('INSERT INTO contact (username, remark, nick_name, alias, quan_pin, small_head_url, big_head_url) VALUES (?,?,?,?,?,?,?)')
  // 只有备注全拼能命中（备注与昵称里都没有这串）
  ins.run('wxid_pin', '王小明', 'Xiao', '', 'wangxiaoming', '', '')
  // 只有别名能命中
  ins.run('wxid_alias', '李雷', 'Li Lei', 'lilei-alias', 'lilei', '', '')
  // 只有备注能命中（v1 时代唯一可搜的一列）
  ins.run('wxid_remark', 'Han Mei', 'HMM', '', 'hanmei', '', '')
  cdb.close()
  return decrypted
}

/**
 * 造出「索引库已存在、但 `contact_fts` 还没建」的状态 —— 这正是 `searchGlobalMembers`
 * 会去建表并走 FTS 的前提（索引库文件不存在时它压根不试，直接 LIKE）。
 */
function touchIndex(decrypted: string): void {
  const db = new DatabaseSync(searchIndexPath(decrypted))
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.close()
}

/** 手工建一个 **v1 形状**的索引库（alias/quanpin 都 UNINDEXED），模拟存量用户。 */
function seedV1Index(decrypted: string): void {
  const db = new DatabaseSync(searchIndexPath(decrypted))
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.exec("CREATE VIRTUAL TABLE contact_fts USING fts5(name, username UNINDEXED, remark UNINDEXED, alias UNINDEXED, quanpin UNINDEXED, local_type UNINDEXED, tokenize='unicode61')")
  db.exec('BEGIN')
  const ins = db.prepare('INSERT INTO contact_fts(name, username, remark, alias, quanpin, local_type) VALUES(?,?,?,?,?,0)')
  ins.run('王小明', 'wxid_pin', '王小明', '', 'wangxiaoming')
  ins.run('李雷', 'wxid_alias', '李雷', 'lilei-alias', 'lilei')
  ins.run('Han Mei', 'wxid_remark', 'Han Mei', '', 'hanmei')
  db.exec('COMMIT')
  db.prepare("INSERT INTO meta(key, value) VALUES('contact_rows', '3')").run()
  db.close()
}

/** 索引库里 `alias` 列现在可不可检索（不可检索 ⇒ hidden=0 之外的口径，这里用一次查询直接验）。 */
function aliasSearchable(decrypted: string): boolean {
  const db = new DatabaseSync(searchIndexPath(decrypted), { readOnly: true })
  try {
    return db.prepare("SELECT username FROM contact_fts WHERE contact_fts MATCH 'alias:\"lilei-alias\"'").get() !== undefined
  } finally {
    db.close()
  }
}

afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

const usernames = (q: string, decrypted: string): string[] => searchMembers(decrypted, q).items.map((h) => h.username)

describe('FTS 路径要能按全拼与别名搜到人（改前只有 LIKE 能）', () => {
  it('建好索引后（不降级）三种列都命中', () => {
    const d = makeRoot()
    touchIndex(d)
    const byPin = searchMembers(d, 'wangxiaoming')
    expect(byPin.source, '又静默降级成 LIKE 了（那会掩盖问题）').toBe('fts')
    expect(byPin.items.map((h) => h.username)).toContain('wxid_pin')

    const byAlias = searchMembers(d, 'lilei-alias')
    expect(byAlias.source).toBe('fts')
    expect(byAlias.items.map((h) => h.username)).toContain('wxid_alias')

    const byRemark = searchMembers(d, 'Han Mei')
    expect(byRemark.source).toBe('fts')
    expect(byRemark.items.map((h) => h.username)).toContain('wxid_remark')
  })

  it('FTS 与 LIKE 给出同一批人（结果不许因索引在不在而变）', () => {
    const d = makeRoot()
    touchIndex(d)
    const withFts = usernames('wangxiaoming', d)
    expect(searchMembers(d, 'wangxiaoming').source).toBe('fts')
    expect(withFts.length, 'FTS 路径本身就搜不到，后面的对照没有意义').toBeGreaterThan(0)
    // 拆掉索引库 ⇒ 同一句查询走 LIKE
    rmSync(searchIndexPath(d), { force: true })
    const like = usernames('wangxiaoming', d)
    expect(like.sort()).toEqual([...withFts].sort())
    expect(searchMembers(d, 'lilei-alias').source).toBe('like')
    expect(usernames('lilei-alias', d)).toEqual(['wxid_alias'])
  })

  it('FTS 语法特殊字符不炸；命中为空时 LIKE 兜住「前缀词」', () => {
    const d = makeRoot()
    touchIndex(d)
    expect(usernames('不存在的人', d)).toEqual([])
    expect(() => { usernames('a"b:c*', d) }).not.toThrow()
    expect(usernames('a"b:c*', d)).toEqual([])
    // FTS5 是**整词**匹配：`wangxiaomi` 这种半截全拼在索引里命中不了，此时必须回退 LIKE。
    // 不兜住的话"装了索引"反而比没装搜得更少 —— 那又是同一句查询因索引在不在给出不同结果。
    expect(usernames('wangxiaomi', d), '前缀词被 FTS 的空命中挡住 ⇒ 装了索引反而搜不到').toEqual(['wxid_pin'])
    expect(usernames('lilei', d), '别名前缀同理').toEqual(['wxid_alias'])
  })
})

describe('存量 v1 索引必须被认出来并重建', () => {
  it('v1 形状下 alias 搜不到；一次搜索之后重建为可检索', () => {
    const d = makeRoot()
    seedV1Index(d)
    expect(aliasSearchable(d), '夹具没造出 v1 形状（alias 应当不可检索）').toBe(false)
    // 第一次调用要把它认成过期并重建
    const hits = usernames('lilei-alias', d)
    expect(hits, '旧索引没被重建 ⇒ 存量用户仍然搜不到别名').toEqual(['wxid_alias'])
    expect(aliasSearchable(d)).toBe(true)
  })

  it('重建不丢行：三个人重建后仍然都在（行数与 schema 版本一起对上）', () => {
    const d = makeRoot()
    seedV1Index(d)
    expect(usernames('wangxiaoming', d)).toContain('wxid_pin')
    expect(usernames('Han Mei', d)).toContain('wxid_remark')
    expect(usernames('lilei-alias', d)).toContain('wxid_alias')
    const db = new DatabaseSync(searchIndexPath(d), { readOnly: true })
    try {
      const n = db.prepare('SELECT COUNT(*) AS c FROM contact_fts').get() as { c: number }
      expect(n.c).toBe(3)
      // 版本号没落进 meta ⇒ 下一次运行又会把这张表当成旧 schema 反复丢掉重建
      const meta = db.prepare("SELECT value FROM meta WHERE key='contact_fts_schema'").get() as { value?: string } | undefined
      expect(meta?.value, 'schema 版本没写进 meta').toBe('2')
    } finally {
      db.close()
    }
  })

  it('索引库里从来没有 contact_fts ⇒ 现建，结果与重建那条一致', () => {
    const d = makeRoot()
    touchIndex(d)
    expect(usernames('lilei-alias', d)).toEqual(['wxid_alias'])
  })

  it('索引库文件不存在 ⇒ 走 LIKE，但同一批人一个不少（结果不随索引状态漂移）', () => {
    const d = makeRoot()
    expect(existsSync(searchIndexPath(d))).toBe(false)
    expect(searchMembers(d, 'lilei-alias').source).toBe('like')
    expect(usernames('lilei-alias', d)).toEqual(['wxid_alias'])
  })
})

describe('幻影引用：不许再把不存在的脚本写成把关者', () => {
  it('`scripts/check-members-search.js` 这个说法已从源码注释里消失', () => {
    // 这条不是洁癖：一个不存在的"把关者"比没有把关者更坏 —— 它会让人以为已经防住了。
    const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
    for (const p of ['src/backend/wechat-data/src/query/members.ts', 'src/backend/wechat-data/src/gateway-read.ts']) {
      expect(readFileSync(join(ROOT, p), 'utf8'), `${p} 还在把一个不存在的脚本当守卫`)
        .not.toContain('check-members-search')
    }
  })
})
