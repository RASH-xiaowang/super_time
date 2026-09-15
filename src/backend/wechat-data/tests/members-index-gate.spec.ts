/**
 * N12：`members.ts` 是 `wechat_search.db` 的**第二个写者**（写 `contact_fts`），它的写必须
 * 统一到 `search.ts` 的那把索引库写闸上。
 *
 * 背景（条目原文的实测）：改前 `members.ts` 以读写方式打开索引库，并**无条件**执行
 * `CREATE TABLE IF NOT EXISTS …` —— 即便表已存在，DDL 也要拿写锁。于是 40k 行 force 构建
 * 在飞时，**155/155 次** `searchMembers` 都撞上写锁被拒、错误被外层 `catch` 吞掉，静默退化
 * 成 `source:'like'`；构建一结束立刻恢复 `source:'fts'`。
 *
 * 验收标准（条目原文）：构建在飞时成员搜索不再出现「尝试写→被拒→静默降级」的路径。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSearchIndex, searchIndexPath, withIndexWrite } from '../src/query/search.ts'
import { searchMembers } from '../src/query/members.ts'

/** 夹具里的会话/消息归属。 */
const USER = 'wxid_a'
/** 联系人检索词（拉丁串：FTS5 的 unicode61 切词无歧义）。 */
const TERM = 'alice'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
  vi.restoreAllMocks()
})

/**
 * 造一个数据根：会话 + 消息分片（用于建索引）+ contact.db（3 个联系人）。
 * @param messages - 消息分片行数（要 >2×2000 才能让构建中途让出、形成在飞窗口）。
 * @returns decrypted 目录（索引库是它的兄弟：`<root>/wechat_search.db`）。
 */
function makeRoot(messages: number): string {
  const root = mkdtempSync(join(tmpdir(), 'members-gate-'))
  scratch.push(root)
  const decrypted = join(root, 'decrypted')
  mkdirSync(join(decrypted, 'session'), { recursive: true })
  mkdirSync(join(decrypted, 'message'), { recursive: true })
  mkdirSync(join(decrypted, 'contact'), { recursive: true })

  const sdb = new DatabaseSync(join(decrypted, 'session', 'session.db'))
  sdb.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
  sdb.prepare("INSERT INTO SessionTable (username, display_name, last_timestamp, sort_timestamp, unread_count, last_msg_type, last_msg_sender) VALUES (?, ?, 1700000000, 1700000000, 0, 1, '')").run(USER, USER)
  sdb.close()

  const mdb = new DatabaseSync(join(decrypted, 'message', 'message_0.db'))
  const table = 'Msg_' + createHash('md5').update(USER, 'utf8').digest('hex')
  mdb.exec(`CREATE TABLE "${table}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER, compress_content TEXT)`)
  const ins = mdb.prepare(`INSERT INTO "${table}" VALUES (?,?,?,?,?,?,?,?,?)`)
  mdb.exec('BEGIN')
  for (let i = 1; i <= messages; i += 1) ins.run(i, i, 1, i % 2, 1700000000 + i, 1, `普通消息 ${i}`, `srv${i}`, '')
  mdb.exec('COMMIT')
  mdb.close()

  const cdb = new DatabaseSync(join(decrypted, 'contact', 'contact.db'))
  cdb.exec('CREATE TABLE contact (id INTEGER PRIMARY KEY, username TEXT, remark TEXT, nick_name TEXT, alias TEXT, quan_pin TEXT, small_head_url TEXT, big_head_url TEXT)')
  const cins = cdb.prepare('INSERT INTO contact (username, remark, nick_name, alias, quan_pin, small_head_url, big_head_url) VALUES (?,?,?,?,?,?,?)')
  cins.run('wxid_alice', 'Alice Wang', 'Alice', 'ali', 'alicewang', 'head-a.jpg', '')
  cins.run('wxid_bob', 'Bob Li', 'Bob', 'bob', 'bobli', '', 'head-b.jpg')
  cins.run('wxid_carol', 'Carol', 'Carol', '', '', '', '')
  cdb.close()
  return decrypted
}

/** 索引库里是否已经有 contact_fts 表（只读，不建任何东西）。 */
function contactFtsExists(decrypted: string): boolean {
  const p = searchIndexPath(decrypted)
  if (!existsSync(p)) return false
  const db = new DatabaseSync(p, { readOnly: true })
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contact_fts'").get() !== undefined
  } finally {
    db.close()
  }
}

/** 写闸此刻是否取不到（= 有构建在飞）。用闸本身探测「这次调用确实落在窗口内」。 */
function gateBusy(decrypted: string): boolean {
  return !withIndexWrite(decrypted, () => 0).ok
}

/** 取 console.warn 的文本。 */
function warnTexts(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map(call => String(call[0]))
}

describe('N12：成员搜索的索引写走同一把闸', () => {
  it('contact_fts 已建好时构建在飞仍走 FTS：只读路径不进闸、也不被牵连降级', async () => {
    // 这条钉的是**设计取舍**，不是改前的缺陷：改前那两句 DDL 在表已存在时是纯读操作
    // （实测：另一连接持 BEGIN IMMEDIATE 时 `CREATE TABLE IF NOT EXISTS` 不报错，只有
    // 真正新建表才报 `database is locked`），所以这个场景改前也返回 'fts'。
    // 它守的是「别过度修」：若把只读路径也塞进闸、或构建在飞就一律回退 LIKE，这里会红。
    const decrypted = makeRoot(4200)
    await buildSearchIndex(decrypted, true)
    // 先空闲建好 contact_fts：此后这条路径只需**读**，读不需要写锁
    expect(searchMembers(decrypted, TERM).source).toBe('fts')
    expect(contactFtsExists(decrypted)).toBe(true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sources: string[] = []
    let busyProbes = 0
    let done = false
    const probe = (): void => {
      if (done) return
      // 先用闸确认这次探测真的落在构建窗口内；否则本用例会变成「构建早跑完了」的假绿
      if (gateBusy(decrypted)) busyProbes += 1
      sources.push(searchMembers(decrypted, TERM).source)
      setImmediate(probe)
    }
    setImmediate(probe)
    const rebuilt = buildSearchIndex(decrypted, true)
    await rebuilt
    done = true
    const warnings = warnTexts(warn)
    warn.mockRestore()

    expect(busyProbes, '没有一次探测落在构建窗口内：这条用例没测到要测的东西').toBeGreaterThan(0)
    expect(sources.length).toBeGreaterThan(0)
    // 窗口内每一次探测都必须是 FTS（没有任何一次跌到 LIKE）
    expect(sources.filter(s => s !== 'fts')).toEqual([])
    // 因为只走读路径，连降级日志都不该有
    expect(warnings.filter(m => m.includes('构建在飞'))).toEqual([])
  })

  it('contact_fts 还没建 + 闸在飞时不尝试写（表不会被建出来），并且显式留痕', async () => {
    const decrypted = makeRoot(200)
    await buildSearchIndex(decrypted, true)
    // 索引库存在，但 contact_fts 还没建
    expect(contactFtsExists(decrypted)).toBe(false)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 非 force 且索引已存在：这次构建会走 'exists' 快路径，但它**同步**占住了闸（.then 还没跑），
    // 而此刻没有任何人持写锁 —— 这正是「有没有尝试写」的判别点：
    // 改前那句 DDL 会**成功**把 contact_fts 建出来（写被拒只在构建真的持锁时发生）。
    const light = buildSearchIndex(decrypted, false)
    const snap = searchMembers(decrypted, TERM)
    const builtWhileGated = contactFtsExists(decrypted)
    const warnings = warnTexts(warn)
    await light
    const after = searchMembers(decrypted, TERM)
    warn.mockRestore()

    expect(builtWhileGated, '闸在飞时仍然写了索引库（contact_fts 被建出来了）').toBe(false)
    expect(warnings.filter(m => m.includes('构建在飞')).length).toBeGreaterThan(0)
    expect(snap.source).toBe('like')
    // 读取可用性无损：LIKE 兜底照样能搜到
    expect(snap.items.map(i => i.username)).toContain('wxid_alice')
    // 闸释放后立刻恢复（降级是「构建在飞」造成的，不是永久坏掉）
    expect(after.source).toBe('fts')
    expect(contactFtsExists(decrypted)).toBe(true)
  })

  it('闸管不到的写失败（跨连接写锁）也不再静默：留痕 + 回退 LIKE', async () => {
    const decrypted = makeRoot(200)
    await buildSearchIndex(decrypted, true)
    const holder = new DatabaseSync(searchIndexPath(decrypted))
    holder.exec('BEGIN IMMEDIATE') // 占住写锁，但闸是空的（跨进程/跨连接争用闸管不到）
    expect(gateBusy(decrypted)).toBe(false)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const snap = searchMembers(decrypted, TERM)
    const warnings = warnTexts(warn)
    holder.exec('ROLLBACK')
    holder.close()
    warn.mockRestore()

    expect(warnings.filter(m => m.includes('contact_fts 构建失败')).length).toBeGreaterThan(0)
    expect(snap.source).toBe('like')
    expect(snap.items.length).toBeGreaterThan(0)
    expect(searchMembers(decrypted, TERM).source).toBe('fts')
  })
})

describe('N12：写入闸的结构守卫（源码级）', () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'query', 'members.ts')

  it('contact_fts 的写入被 withIndexWrite() 包住，且 DDL 只出现在被包住的构建函数里', () => {
    const src = readFileSync(file, 'utf8')
    // 接线：写路径必须经过闸（拿不到闸就走显式降级，而不是去撞写锁）
    expect(src).toContain('withIndexWrite(decryptedDir, () => buildContactFts(')
    // DDL 只能待在 buildContactFts 的函数体里；函数体边界取「下一个顶层 function」
    const bodyStart = src.indexOf('function buildContactFts(')
    expect(bodyStart).toBeGreaterThan(-1)
    const next = src.indexOf('\nfunction ', bodyStart + 1)
    const body = src.slice(bodyStart, next === -1 ? undefined : next)
    for (const ddl of ['CREATE TABLE IF NOT EXISTS meta (key', 'CREATE VIRTUAL TABLE IF NOT EXISTS contact_fts USING fts5(']) {
      expect(body, `${ddl} 不在被闸包住的构建函数里`).toContain(ddl)
      expect(src.split(ddl).length - 1, `${ddl} 在文件里出现了多次（闸外又写了一次？）`).toBe(1)
    }
  })
})
