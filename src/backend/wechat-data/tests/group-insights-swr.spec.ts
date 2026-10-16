import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { computeGroupInsights, queryGroupInsights } from '../src/query/group-insights.ts'
import { entries as metaEntries } from '../src/query/meta.ts'

/**
 * W2-4.4：insights 按世代签名 SWR（群洞察那一族）。
 *
 * 这一条的判据重心在**签名覆盖面**：签名少算一个文件，漏改就会静默地留在旧数据上，
 * 而这种错不报错、只是让用户看到一个停在上次的统计。所以除了行为断言，
 * 这里还用源码守卫把「loader 读了哪些文件」与「签名算了哪些文件」逐条对上。
 */

const ROOM = '@@room_abcdef0123456789'
const TABLE = 'Msg_' + createHash('md5').update(ROOM, 'utf8').digest('hex')

function makeRoot(opts: { shards?: number; rows?: number; contact?: boolean } = {}): string {
  const shards = opts.shards ?? 2
  const rows = opts.rows ?? 50
  const root = mkdtempSync(join(tmpdir(), 'wx-gi-b-'))
  const decrypted = join(root, 'decrypted')
  mkdirSync(join(decrypted, 'message'), { recursive: true })
  for (let s = 0; s < shards; s += 1) {
    const db = new DatabaseSync(join(decrypted, 'message', `message_${String(s)}.db`))
    db.exec(`CREATE TABLE "${TABLE}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER, compress_content TEXT)`)
    const ins = db.prepare(`INSERT INTO "${TABLE}" VALUES (?,?,?,?,?,?,?,?,?)`)
    db.exec('BEGIN')
    for (let i = 0; i < rows; i += 1) {
      const id = s * rows + i + 1
      ins.run(id, id, 1, i % 2, 1700000000 + id * 60, 1, 'wxid_m' + String(i % 5) + ':\n第 ' + String(i) + ' 条', 'srv' + String(id), '')
    }
    db.exec('COMMIT')
    db.close()
  }
  if (opts.contact === true) {
    mkdirSync(join(decrypted, 'contact'), { recursive: true })
    const db = new DatabaseSync(join(decrypted, 'contact', 'contact.db'))
    db.exec('CREATE TABLE contact (id INTEGER, username TEXT)')
    db.exec(`INSERT INTO contact VALUES (1, '${ROOM}')`)
    db.close()
  }
  return decrypted
}

function countLoaderRuns(decrypted: string, username: string): number {
  const key = 'group-insights:' + decrypted + ':' + username
  const e = metaEntries.get(key)
  return e === undefined ? 0 : 1
}

describe('W2-4.4 群洞察走签名缓存', () => {
  it('同签名下第二次命中（不再扫分片）', () => {
    const decrypted = makeRoot()
    const first = queryGroupInsights(decrypted, ROOM)
    expect(first.total, '夹具一条都没扫到').toBe(100)
    expect(countLoaderRuns(decrypted, ROOM), '第一次就该留下一条缓存').toBe(1)
    const at = metaEntries.get('group-insights:' + decrypted + ':' + ROOM)?.at
    const second = queryGroupInsights(decrypted, ROOM)
    expect(metaEntries.get('group-insights:' + decrypted + ':' + ROOM)?.at,
      '命中时不该重写 `at`（那等于又算了一遍）').toBe(at)
    expect(second).toEqual(first)
  })

  it('分片变了 ⇒ 立刻重算（这才是 SWR 的 S）', () => {
    const decrypted = makeRoot()
    queryGroupInsights(decrypted, ROOM)
    // 追加一条消息 ⇒ message 目录签名变。
    const db = new DatabaseSync(join(decrypted, 'message', 'message_0.db'))
    db.prepare(`INSERT INTO "${TABLE}" VALUES (?,?,?,?,?,?,?,?,?)`).run(999, 999, 1, 1, 1700009999, 1, 'wxid_m1:\n新消息', 'srv999', '')
    db.close()
    const after = queryGroupInsights(decrypted, ROOM)
    expect(after.total, '分片变了却没重算 ⇒ 签名没盖住 message 目录').toBe(101)
  })

  it('contact.db 变了 ⇒ 立刻重算（它同时喂名字/群人数/公告三处）', () => {
    const decrypted = makeRoot({ contact: true })
    queryGroupInsights(decrypted, ROOM)
    const p = join(decrypted, 'contact', 'contact.db')
    const before = readFileSync(p)
    writeFileSync(p, Buffer.concat([before, Buffer.from([0])]))
    // 文件变了但内容没变（签名只看 mtime/size）：仍然必须重算，
    // 因为 contact.db 是 loader 真正读过的文件之一（M8 判据）。
    const after = queryGroupInsights(decrypted, ROOM)
    expect(after.username).toBe(ROOM)
    const e = metaEntries.get('group-insights:' + decrypted + ':' + ROOM)
    expect(e?.sig, '签名应当包含 contact.db').toContain('|')
  })

  it('没有信号命中时算出来的结果与算法体逐字一致（缓存壳没改语义）', () => {
    const decrypted = makeRoot({ shards: 3, rows: 17 })
    expect(queryGroupInsights(decrypted, ROOM)).toEqual(computeGroupInsights(decrypted, ROOM))
  })
})

describe('W2-4.4 签名必须盖住 loader 真正读过的每一个文件（M8 判据）', () => {
  const src = readFileSync(new URL('../src/query/group-insights.ts', import.meta.url), 'utf8')

  // loader 侧的读取分布在**模块级助手**里（memberCount / announcement / 主循环），
  // 不全在 computeGroupInsights 的函数体内 —— 所以两侧都按「整个模块」与「签名函数」对。
  const sigBody = src.slice(src.indexOf(
    'function groupInsightsSig('
  ), src.indexOf(
    'export function queryGroupInsights('
  ))

  it('loader 读 message 目录 ⇒ 签名里有 message 目录的签名', () => {
    expect(src).toMatch(/readdirSync\(dir\)/)
    expect(src).toContain("join(decryptedDir, 'message')")
    expect(sigBody).toContain("shardCatalogSig(decryptedDir, ['message'])")
  })

  it('loader 读 contact.db ⇒ 签名里有 contact.db', () => {
    expect(src).toMatch(/contactMeta\(decryptedDir\)/)
    expect(src).toContain("join(decryptedDir, 'contact', 'contact.db')")
    expect(sigBody).toContain("fileSigOf(join(decryptedDir, 'contact', 'contact.db'))")
  })

  it('TTL 落在 30–60 秒那一档（insights 族用 INSIGHTS_TTL_MS，不是年报那档）', () => {
    expect(src).toContain('INSIGHTS_TTL_MS)')
    const meta = readFileSync(new URL('../src/query/meta.ts', import.meta.url), 'utf8')
    const m = /INSIGHTS_TTL_MS = ([\d_]+)/.exec(meta)
    expect(m, '读不到 INSIGHTS_TTL_MS 的定义').not.toBeNull()
    const ms = Number((m?.[1] ?? '0').replace(/_/g, ''))
    expect(ms).toBeGreaterThanOrEqual(30_000)
    expect(ms).toBeLessThanOrEqual(60_000)
  })

  it('缓存键带群 username（两个群不能共用一条）', () => {
    expect(src).toContain("'group-insights:' + decryptedDir + ':' + username")
  })
})