/**
 * P1-1 后端读失败契约：**「读不到」不许被压成「没有」**。
 *
 * 报告点名的两处（影响最大的 `sync.ts:47` 与全局搜索那四处）：
 *   · `cachedDirEntries` 的 `catch { return [] }` —— 原始目录读不动时，`syncChangedShards`
 *     看到的就是「一个分片都没有」= 「所有分片都没变」，实时同步**静默停摆**，
 *     界面上的表现是「新消息永远不出现」，成因完全查不到；
 *   · 全局搜索的五个域各自 `catch { return [] }` —— 库损坏时下拉里画的是「未找到相关结果」。
 *
 * 判据形状：怎么确定性地造出「读失败」而不是「空结果」？把 `contact.db` / `message`
 * 造成一个**目录**（`existsSync` 通过、只读开库报 SQLITE_CANTOPEN）与一个**空表库**
 * （读成功、确实零行）。两种输入走的是同一段代码，产出的形状必须不同 ——
 * 这正是「读失败 vs 没有数据」这个契约本身。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { searchUnified } from '../src/query/unified-search.ts'
import { syncChangedShards } from '../src/query/sync.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  scratch.length = 0
})

function tempRoot(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `wx-readerr-${tag}-`))
  scratch.push(dir)
  return dir
}

/** 建一个真的、有目标表但零行的库（= 「确实没有数据」那一侧）。 */
function emptyTableDb(file: string, table: string, cols: string): void {
  mkdirSync(join(file, '..'), { recursive: true })
  const db = new DatabaseSync(file)
  try { db.exec(`CREATE TABLE ${table} (${cols})`) } finally { db.close() }
}

describe('全局搜索：域读失败要带 readError，不与「零结果」混为一谈', () => {
  it('contact.db 是个目录（开不动）⇒ readError 说出「联系人」，且不是静默空结果', () => {
    const dec = join(tempRoot('unified'), 'decrypted')
    mkdirSync(join(dec, 'contact', 'contact.db'), { recursive: true })
    emptyTableDb(join(dec, 'favorite', 'favorite.db'), 'fav_db_item', 'local_id INTEGER, content TEXT')
    const snap = searchUnified(dec, '张三')
    expect(snap.contacts).toEqual([])
    expect(snap.readError ?? '', '读失败被当成「没有结果」了').toContain('联系人')
    // 收藏那条读成功了（零行）—— 不该被算进失败里
    expect(snap.readError ?? '', '把成功的域也报成失败：' + String(snap.readError)).not.toContain('收藏')
  })

  it('所有域都读成功但确实没有匹配 ⇒ readError 缺席（空集合就是空集合）', () => {
    const dec = join(tempRoot('unified-ok'), 'decrypted')
    emptyTableDb(join(dec, 'contact', 'contact.db'), 'contact', 'username TEXT, remark TEXT')
    emptyTableDb(join(dec, 'favorite', 'favorite.db'), 'fav_db_item', 'local_id INTEGER, content TEXT')
    emptyTableDb(join(dec, 'hardlink', 'hardlink.db'), 'file_hardlink_info_v4', 'file_name TEXT, md5 TEXT, file_size INTEGER')
    emptyTableDb(join(dec, 'general', 'general.db'), 'transferTable', 'session_name TEXT')
    emptyTableDb(join(dec, 'sns', 'db_sns', 'sns.db'), 'SnsTimeLine', 'tid INTEGER, user_name TEXT, content TEXT')
    const snap = searchUnified(dec, '不存在的人')
    expect(snap.readError, '全都读成功，不该有 readError：' + String(snap.readError)).toBeUndefined()
    expect(snap.contacts).toEqual([])
    expect(snap.favorites).toEqual([])
    expect(snap.moments).toEqual([])
  })

  it('有结果时也能同时带 readError（部分域失败要说出来，别只画半张脸）', () => {
    const dec = join(tempRoot('unified-partial'), 'decrypted')
    mkdirSync(join(dec, 'contact', 'contact.db'), { recursive: true })
    const fav = join(dec, 'favorite', 'favorite.db')
    mkdirSync(join(dec, 'favorite'), { recursive: true })
    const db = new DatabaseSync(fav)
    try {
      db.exec('CREATE TABLE fav_db_item (local_id INTEGER, content TEXT)')
      db.prepare('INSERT INTO fav_db_item VALUES (?, ?)').run(1, '<desc>张三 的收藏</desc>')
    } finally { db.close() }
    const snap = searchUnified(dec, '张三')
    expect(snap.favorites.length).toBe(1)
    expect(snap.readError ?? '').toContain('联系人')
  })
})

describe('实时同步：目录读不动 ≠ 「所有分片都没变」', () => {
  it('message 目录不可读 ⇒ errors 非空（synced 为空不足以说明没事）', async () => {
    const root = tempRoot('sync')
    const raw = join(root, 'raw')
    const dec = join(root, 'decrypted')
    mkdirSync(dec, { recursive: true })
    // `message` 是个文件：existsSync 过、readdirSync 必抛 ENOTDIR
    mkdirSync(raw, { recursive: true })
    const db = new DatabaseSync(join(raw, 'message'))
    db.exec('CREATE TABLE t (a TEXT)')
    db.close()
    const r = await syncChangedShards(raw, dec, new Map())
    expect(r.synced, '不可读的目录不该被当成「同步完成」').toEqual([])
    expect(r.errors.length, '读失败没有上报 ⇒ 又是一次静默停摆').toBeGreaterThan(0)
    expect(r.errors.join(' ')).toContain('目录不可读')
  })

  it('目录真的为空 ⇒ synced 空且 errors 空（两者必须能区分）', async () => {
    const root = tempRoot('sync-empty')
    const raw = join(root, 'raw')
    const dec = join(root, 'decrypted')
    mkdirSync(join(raw, 'message'), { recursive: true })
    mkdirSync(dec, { recursive: true })
    const r = await syncChangedShards(raw, dec, new Map())
    expect(r.synced).toEqual([])
    expect(r.errors, '空目录被误报成读失败').toEqual([])
  })
})
