// @vitest-environment node
/**
 * W3-1.3 / W3-3.4：启动后的低优先级预热。
 *
 * ## 为什么值得单立一条
 *
 * 两件事此前都是「第一次用到时当场算」：
 *   · 分片目录：逐张消息分片开库、枚举 `Msg_*` 表、读列（`sessions.ts` 的诊断显示
 *     单次 78ms 里有 41 次开库）—— 冷启动后第一次进会话列表就付这笔钱；
 *   · `contact_fts`：成员搜索的 FTS 表。**第一次搜索**时才发现没建，那一次搜索
 *     要等整份 contact.db 灌进去（大账号上就是「点了搜索转好久圈」）。
 *
 * ## 四条口径
 *
 *   ① 预热后**真的能命中**：分片目录解析出分片、contact_fts 状态变成 `ready`。
 *      这是防空转哨兵 —— 夹具没搭对时下面几条全是空断言。
 *   ② **索引库不存在时什么都不建**：那会让启动多一次全量建索引的写入，
 *      而用户可能只是想让窗口赶紧出来。返回 `no-index-db`，不碰盘。
 *   ③ **分片目录失败只留痕、不抛**：数据根还没配（首启）是常态。
 *   ④ 预热结果本身可判「值不值得留痕」（`prewarmIsNotable`），
 *      否则每 60s 一行无意义日志。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { prewarmAfterInit, prewarmIsNotable } from '../src/query/startup-prewarm.ts'
import { searchIndexPath } from '../src/query/search-scaffold.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch.splice(0, scratch.length)) rmSync(d, { recursive: true, force: true })
})

/** 造一个「有 N 张消息分片 + 一个联系人」的数据根，索引库**已存在**。 */
function makeTree(shards: number, contacts: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'prewarm-'))
  scratch.push(dir)
  const dec = join(dir, 'decrypted')
  mkdirSync(join(dec, 'message'), { recursive: true })
  mkdirSync(join(dec, 'contact'), { recursive: true })
  for (let s = 0; s < shards; s += 1) {
    const db = new DatabaseSync(join(dec, 'message', `message_${String(s)}.db`))
    db.exec('CREATE TABLE Msg_wxid_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa (local_id INTEGER, sort_seq INTEGER, message_content TEXT)')
    db.prepare('INSERT INTO Msg_wxid_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa VALUES (?,?,?)').run(1, 1, '正文')
    db.close()
  }
  const cdb = new DatabaseSync(join(dec, 'contact', 'contact.db'))
    // `alias` / `quan_pin` 必须给：`buildContactFts` 的 SELECT 里点了这两列，
  // 缺了会抛 no such column → 被 catch 成 'unavailable'（夹具第一版就这样白跑的）。
cdb.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT, alias TEXT, quan_pin TEXT, flag INTEGER)')
  const ins = cdb.prepare('INSERT INTO contact VALUES (?,?,?,?,?,0)')
  for (let c = 0; c < contacts; c += 1) ins.run('wxid_c' + String(c), '备注' + String(c), '昵称' + String(c), '别名' + String(c), 'quanpin' + String(c))
  cdb.close()
  // 索引库：建在 decryptedDir 的父目录（`searchIndexPath` 的口径）。
  const sdb = new DatabaseSync(searchIndexPath(dec))
  sdb.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  sdb.close()
  return dec
}

describe('W3-1.3/3.4：启动预热', () => {
  it('① 预热后真的能命中：分片解析出来、contact_fts 建成', () => {
    const dec = makeTree(2, 3)
    const r = prewarmAfterInit(dec)
    expect(r.shards, '防空转：夹具没解析出分片 ⇒ 下面几条全是空断言').toBe(2)
    expect(r.fts, '预热后 contact_fts 必须是 ready（否则 3.4 白做）').toBe('ready')
    // 第二次预热：已经 ready ⇒ 仍是 ready（幂等，且不该再撞写闸）。
    expect(prewarmAfterInit(dec).fts).toBe('ready')
  })

  it('② 索引库不存在时什么都不建（启动不该多一次全量写入）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prewarm-noidx-'))
    scratch.push(dir)
    const dec = join(dir, 'decrypted')
    mkdirSync(join(dec, 'message'), { recursive: true })
    const db = new DatabaseSync(join(dec, 'message', 'message_0.db'))
    db.exec('CREATE TABLE Msg_wxid_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa (local_id INTEGER, sort_seq INTEGER, message_content TEXT)')
    db.close()
    const r = prewarmAfterInit(dec)
    expect(r.fts, '没有索引库时必须直接跳过，而不是顺手建一个').toBe('no-index-db')
    expect(prewarmIsNotable(r), '有一张分片就值得留痕').toBe(true)
  })

  it('③ 分片目录失败只留痕、不抛（首启没配数据根是常态）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prewarm-empty-'))
    scratch.push(dir)
    const dec = join(dir, 'decrypted')
    mkdirSync(dec, { recursive: true })
    // message 目录整个没有 ⇒ shardCatalog 读不到东西（返回 0，不抛）。
    const r = prewarmAfterInit(dec)
    expect(r.shards).toBe(0)
    expect(r.fts).toBe('no-index-db')
    // 分片为 0、无异常 ⇒ 不值得留痕。
    expect(prewarmIsNotable(r)).toBe(false)
  })

  it('④ prewarmIsNotable：有事才留痕（没内容又没异常 = 噪声）', () => {
    expect(prewarmIsNotable({ shards: 0, fts: 'no-index-db', ftsError: '' })).toBe(false)
    expect(prewarmIsNotable({ shards: 3, fts: 'ready', ftsError: '' })).toBe(true)
    expect(prewarmIsNotable({ shards: 0, fts: 'skipped', ftsError: '' })).toBe(false)
    expect(prewarmIsNotable({ shards: 0, fts: 'busy', ftsError: '' }), 'busy 要留痕：说明写闸被占了').toBe(true)
    expect(prewarmIsNotable({ shards: 0, fts: 'unavailable', ftsError: '库坏' })).toBe(true)
  })
})
