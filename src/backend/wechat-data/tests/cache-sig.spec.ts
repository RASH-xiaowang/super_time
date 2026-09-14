/**
 * M8：进程内缓存的**签名必须覆盖 loader 真正读了的东西**。
 *
 * 背景：这些条目原先都靠「每次同步事件整体清空 entries」兜住（`gateway.ts` 的
 * `invalidateWechatMeta()`）。M8 把那次整体清空换成了「按文件签名自失效 + 数据世代签名」
 * 之后，签名漏掉某个输入 = 那个输入变了却仍然返回旧快照，**而且没有任何兜底**。
 * 这份用例锁住补进去的那几处签名（本次补了 8 处，这里挑热路径上的会话列表做代表）。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { invalidateWechatMeta } from '../src/query/meta.ts'
import { querySessions } from '../src/query/sessions.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

const scratch: string[] = []
afterEach(() => {
  invalidateWechatMeta()
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-cache-sig-'))
  scratch.push(dir)
  return dir
}

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try { create(db) } finally { db.close() }
}

function bumpMtime(path: string): void {
  const t = new Date(Date.now() + 1000)
  utimesSync(path, t, t)
}

describe('会话列表的签名覆盖（M8）', () => {
  it('消息分片变了 → 会话快照必须重算，不能返回旧对象', () => {
    const root = tempRoot()
    // 会话行带上 unread_first_msg_srv_id：真实微信 4.x 都有这一列，它会触发按 server_id
    // 回查消息分片（msgCreateTimeByServerId → shardCatalog），所以分片是这份快照的真实输入。
    makeDb(join(root, 'session', 'session.db'), (db) => {
      db.exec('CREATE TABLE SessionTable (username TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_first_msg_srv_id TEXT)')
      db.prepare('INSERT INTO SessionTable VALUES (?,?,?,?)').run('wxid_a', 1700000000, 1700000000, '12345')
    })
    const shard = join(root, 'message', 'message_0.db')
    makeDb(shard, (db) => { db.exec('CREATE TABLE Msg_a (server_id TEXT, create_time INTEGER)') })

    const first = querySessions(root)
    expect(querySessions(root)).toBe(first) // 无变更：命中同一对象

    // 同步写了一个分片（原子替换只改 mtime/size，内容不变 —— 这里只改 mtime）
    bumpMtime(shard)

    expect(querySessions(root)).not.toBe(first)
  })
})

describe('TTL 不得放宽（M8 复审 minor）', () => {
  it('storage-file-names 保持 10s 上限', () => {
    // 它的签名是「root + 各月份子目录的 mtime/size」，**看不到**同名文件原地改 size
    // （NTFS 下目录的 mtime/size 不随内容变化）—— 所以 TTL 就是这段陈旧期的唯一上界，
    // 而 10s 正是改造前那层「事件后整体清空」给的实效上界。放宽 = 让陈旧期变长。
    // 这条按仓库既有做法用字面量守卫（行为级需要伪造时间 + 造 msg/file 夹具，收益不成比例）。
    const src = readFileSync(join(HERE, '..', 'src', 'query', 'storage.ts'), 'utf8')
    expect(src).toContain('}, 10_000)')
  })
})
