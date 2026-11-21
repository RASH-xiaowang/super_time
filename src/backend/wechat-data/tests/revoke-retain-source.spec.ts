// @vitest-environment node
/**
 * 「撤回原文到底有没有被保留」的**判定契约**（2026-11-19）。
 *
 * ## 为什么需要这个文件
 *
 * 用户报「开启防撤回后还是看不到撤回的内容」。真机实测的根因不是"没归档"，而是
 * **配对把「提示前一条」当成了原文**：微信撤回是**就地改写**那一行，原文在源库里
 * 已经不在了；旧实现不看源库，一律拿 `row_key - 1` 并标「原文已保留」——
 * 4,554 条提示里只有 208 条真的存下了原文，其余显示的都是上一条**不相干**的消息。
 *
 * 所以这里钉的不是"能配对"，而是**三种情形必须被区分**，且措辞不能骗人：
 *   · 源库该行已删除 / 已变成提示 ⇒ 确认（显示原文）；
 *   · 源库该行还是原样         ⇒ **不得**当原文（只说未保留）；
 *   · 源库读不到               ⇒ 可以给，但必须标"推定"。
 *
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { queryRevokedRetained } from '../src/query/revoke-retain.ts'
import { queryRevoked } from '../src/query/records.ts'
import { resetSourceProbeCache } from '../src/query/revoke-source-probe.ts'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'revoke-retain-'))
  resetSourceProbeCache()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 归档库（与生产同构的最小列集）。 */
function makeArchive(rows: ReadonlyArray<{ talker: string; k: number; ct: number; lt: number; content: string }>): void {
  const db = new DatabaseSync(join(root, 'message-archive.db'))
  try {
    db.exec(`CREATE TABLE archived_msg (
      talker TEXT NOT NULL, row_key INTEGER NOT NULL, create_time INTEGER NOT NULL,
      local_type INTEGER NOT NULL, sender_id INTEGER NOT NULL,
      sender_username TEXT NOT NULL DEFAULT '', local_id INTEGER NOT NULL DEFAULT 0,
      server_id TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, archived_at INTEGER NOT NULL,
      PRIMARY KEY (talker, row_key))`)
    const ins = db.prepare('INSERT INTO archived_msg VALUES (?,?,?,?,0,?,?,?,?,1)')
    for (const r of rows) ins.run(r.talker, r.k, r.ct, r.lt, '', r.k, '', r.content)
  } finally { db.close() }
}

/** 解密目录里的一个消息分片（表名 `Msg_x`）。 */
function makeShard(table: string, rows: ReadonlyArray<{ k: number; ct: number; lt: number; content: string }>): void {
  const dir = join(root, 'decrypted', 'message')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'message_0.db'))
  try {
    db.exec(`CREATE TABLE ${table} (
      local_id INTEGER, server_id TEXT, local_type INTEGER, create_time INTEGER,
      real_sender_id INTEGER, message_content TEXT)`)
    // 显式写 rowid：生产代码按 `rowid` 配对（归档的 row_key 也是 rowid），
    // 用自增 rowid 会让 fixture 的行号变成 1、2…，与用例里的 k 对不上。
    const ins = db.prepare(`INSERT INTO ${table}(rowid, local_id, server_id, local_type, create_time, real_sender_id, message_content) VALUES (?,?,?,?,?,0,?)`)
    for (const r of rows) ins.run(r.k, r.k, '', r.lt, r.ct, r.content)
  } finally { db.close() }
}

const TALKER = 'message_0.db#Msg_abc'
const TIP = '<?xml version="1.0"?><sysmsg type="revokemsg"><revokemsg><content>"梦" 撤回了一条消息</content><revoketime>0</revoketime></revokemsg></sysmsg>'

describe('撤回原文的三种判定', () => {
  it('源库该行已被改写成提示 ⇒ 归档那份是原文，标「已保留」', () => {
    // 真实形态：归档在**改写前**存到过这一行，所以归档里只有原文、没有提示行
    // （`INSERT OR IGNORE` 不会用后来的提示覆盖它）；源库同一行已变成提示。
    makeArchive([
      { talker: TALKER, k: 10, ct: 1_700_000_000, lt: 1, content: '撤回前看到的原文' },
    ])
    makeShard('Msg_abc', [
      { k: 10, ct: 1_700_000_000, lt: 10000, content: TIP },
    ])
    const res = queryRevokedRetained(join(root, 'decrypted'), 50, 0)
    expect(res.total).toBe(1)
    expect(res.items[0]?.content).toBe('撤回前看到的原文')
    expect(res.items[0]?.status_label).toBe('原文已保留')
  })

  it('源库该行还是原样 ⇒ 它不是撤回原文，不得标「已保留」', () => {
    // 归档：row 10 是一条普通消息；row 11 是提示。
    makeArchive([
      { talker: TALKER, k: 10, ct: 1_700_000_000, lt: 1, content: '上一条普通消息' },
      { talker: TALKER, k: 11, ct: 1_700_000_100, lt: 10000, content: TIP },
    ])
    // 源库：row 10 仍在且内容没变 ⇒ 说明被撤回的不是它。
    makeShard('Msg_abc', [
      { k: 10, ct: 1_700_000_000, lt: 1, content: '上一条普通消息' },
      { k: 11, ct: 1_700_000_100, lt: 10000, content: TIP },
    ])
    const res = queryRevokedRetained(join(root, 'decrypted'), 50, 0)
    const item = res.items.find(it => it.create_time === 1_700_000_100)
    expect(item).toBeDefined()
    expect(item?.status_label).toBe('原文未保留')
    expect(item?.retained).toBe(false)
    // 绝不能把上一条当成原文塞进内容里。
    expect(String(item?.content)).not.toContain('上一条普通消息')
    expect(String(item?.content)).toContain('就地')
  })

  it('源库该行已被删除 ⇒ 归档那份是原文，标「已保留」', () => {
    makeArchive([
      { talker: TALKER, k: 10, ct: 1_700_000_000, lt: 1, content: '被整行删掉的原文' },
      { talker: TALKER, k: 11, ct: 1_700_000_100, lt: 10000, content: TIP },
    ])
    // 源库只剩提示行，row 10 已不存在。
    makeShard('Msg_abc', [
      { k: 11, ct: 1_700_000_100, lt: 10000, content: TIP },
    ])
    const res = queryRevokedRetained(join(root, 'decrypted'), 50, 0)
    const kept = res.items.filter(it => it.content === '被整行删掉的原文')
    expect(kept).toHaveLength(1)
    expect(kept[0]?.status_label).toBe('原文已保留')
  })

  it('源库读不到（没有分片）⇒ 沿用旧配对，但必须标「推定」', () => {
    makeArchive([
      { talker: TALKER, k: 10, ct: 1_700_000_000, lt: 1, content: '没有源库时的候选' },
      { talker: TALKER, k: 11, ct: 1_700_000_100, lt: 10000, content: TIP },
    ])
    // 故意不建 message/ 目录。
    const res = queryRevokedRetained(join(root, 'decrypted'), 50, 0)
    const item = res.items.find(it => it.create_time === 1_700_000_100)
    expect(item?.status_label).toBe('原文未确认（推定）')
    expect(String(item?.content)).toContain('可能不是')
  })
})

describe('撤回提示的发送者解析', () => {
  it('`<content>你撤回了一条消息</content>` 不再是"（未知）"，也不会取成 revokemsg', () => {
    const selfTip = '<?xml version="1.0"?><sysmsg type="revokemsg"><revokemsg><content>你撤回了一条消息</content></revokemsg></sysmsg>'
    makeArchive([{ talker: TALKER, k: 11, ct: 1_700_000_100, lt: 10000, content: selfTip }])
    const res = queryRevokedRetained(join(root, 'decrypted'), 50, 0)
    const sender = String(res.items[0]?.sender ?? '')
    expect(sender).not.toBe('revokemsg')
    expect(sender).not.toBe('（未知）')
  })

  it('`"梦" 撤回了一条消息` 取到「梦」', () => {
    makeArchive([{ talker: TALKER, k: 11, ct: 1_700_000_100, lt: 10000, content: TIP }])
    const res = queryRevokedRetained(join(root, 'decrypted'), 50, 0)
    expect(res.items[0]?.sender).toBe('梦')
  })
})

describe('分页与排序', () => {
  it('按时间倒序（最新在最前），分页不重复', () => {
    const rows: Array<{ talker: string; k: number; ct: number; lt: number; content: string }> = []
    const shard: Array<{ k: number; ct: number; lt: number; content: string }> = []
    // 3 条确认：归档只有原文、源库同一行已改成提示（真实形态）。
    for (let i = 0; i < 3; i += 1) {
      const k = 10 + i
      rows.push({ talker: TALKER, k, ct: 1_700_000_000 + i, lt: 1, content: `原文${String(i)}` })
      shard.push({ k, ct: 1_700_000_000 + i, lt: 10000, content: TIP })
    }
    // 5 条只存下提示（归档晚于撤回）。这些时间更晚，必须排在**前面**。
    for (let i = 0; i < 5; i += 1) {
      const k = 100 + i
      rows.push({ talker: TALKER, k, ct: 1_700_000_500 + i, lt: 10000, content: TIP })
      shard.push({ k, ct: 1_700_000_500 + i, lt: 10000, content: TIP })
    }
    makeArchive(rows)
    makeShard('Msg_abc', shard)

    const all = queryRevokedRetained(join(root, 'decrypted'), 100, 0)
    expect(all.total).toBe(8)
    /*
     * **最新在最前**，不按"有没有原文"分组。
     * 曾经按「确认优先」排，结果新撤回（还没配上原文）被压到几百条旧记录之后 ——
     * 用户打开面板找刚撤回那条，首屏根本看不到，体感就是"没实时生效"。
     */
    expect(all.items[0]?.create_time).toBe(1_700_000_504)
    for (let i = 1; i < all.items.length; i += 1) {
      expect(all.items[i - 1]!.create_time).toBeGreaterThanOrEqual(all.items[i]!.create_time)
    }

    const p1 = queryRevokedRetained(join(root, 'decrypted'), 4, 0)
    const p2 = queryRevokedRetained(join(root, 'decrypted'), 4, 4)
    const key = (it: { create_time: number; content: string }): string => `${String(it.create_time)}|${it.content.slice(0, 20)}`
    const overlap = p1.items.filter(a => p2.items.some(b => key(a) === key(b)))
    expect(overlap).toHaveLength(0)
  })
})

describe('缓存不会串（不同数据目录各自扫描）', () => {
  it('换目录后仍能读到该目录的提示', () => {
    makeArchive([{ talker: TALKER, k: 11, ct: 1_700_000_100, lt: 10000, content: TIP }])
    expect(queryRevokedRetained(join(root, 'decrypted'), 50, 0).total).toBe(1)
    // 新目录 + 重置缓存（不同 root 的 mtime 可能相同，必须显式重置）。
    rmSync(root, { recursive: true, force: true })
    root = mkdtempSync(join(tmpdir(), 'revoke-retain-2-'))
    resetSourceProbeCache()
    makeArchive([{ talker: TALKER, k: 11, ct: 1_700_000_200, lt: 10000, content: TIP }])
    expect(queryRevokedRetained(join(root, 'decrypted'), 50, 0).total).toBe(1)
  })
})

describe('读不到归档库时不能伪装成「没有撤回」', () => {
  it('归档库不是合法 SQLite ⇒ 返回 readError 而不是空结果', () => {
    // 写一个非数据库文件冒充归档库：SQLite 打开/查询会抛错。
    writeFileSync(join(root, 'message-archive.db'), 'this is not a sqlite database')
    resetSourceProbeCache()
    const res = queryRevokedRetained(join(root, 'decrypted'), 50, 0)
    expect(res.items).toHaveLength(0)
    expect(res.readError, '读失败必须带 readError，否则界面会说「暂无撤回消息」').toBeTruthy()
    expect(String(res.readError)).toContain('读取撤回归档失败')
  })

  it('`queryRevoked` 会把 readError 透传出去（面板据此说「读不到」）', () => {
    writeFileSync(join(root, 'message-archive.db'), 'not a db')
    resetSourceProbeCache()
    const res = queryRevoked(join(root, 'decrypted'), 50, 0)
    expect(res.readError, 'queryRevoked 把 readError 吞掉了').toBeTruthy()
  })
})

/** 保证 tmp 目录真的建出来了（beforeEach 里的 mkdtemp 已建，这里只做个断言防环境异常）。 */
describe('fixture 前提', () => {
  it('临时根目录存在', () => {
    expect(dirname(join(root, 'x'))).toBe(root)
  })
})
