/**
 * P2：搜索索引构建的取消竞态与 force 排队。
 *
 * 旧实现把调用方的 hooks（含 AbortSignal）直接交给共享的底层构建：两个调用方复用同一个
 * promise 时，**任何一个** abort 都会停掉整次构建 —— 例如界面点了「停止」，问答路径正在
 * 等待的那次构建也被一起取消。这里钉住新的引用计数语义：
 *   ① 两个并发构建（A 带 signal、B 不带）共享一次底层构建；A abort 只取消 A 的等待，
 *      B 继续跑完并把索引建好；
 *   ② 预取消的调用方不会影响已在飞构建；
 *   ③ force 撞上在飞的非 force 构建时排队重建（map 里的条目变成 force=true），
 *      两次调用都拿到 ok。
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { buildSearchIndex, getSearchIndexBuildStatus, getSearchIndexStatus } from '../src/query/search.ts'
import { createTempWorkspace, type TempWorkspace } from '../../tests/helpers/temp-db.ts'

const workspaces: TempWorkspace[] = []
afterEach(async () => {
  for (const w of workspaces.splice(0, workspaces.length)) await w.cleanup()
})

/** 造 `shards` 个消息分片、每个分片一条消息（构建必然经过多个进度点）。 */
function makeFixture(tag: string, shards = 3): { dec: string } {
  const w = createTempWorkspace(tag)
  workspaces.push(w)
  const dec = join(w.dir, 'decrypted')
  mkdirSync(join(dec, 'message'), { recursive: true })
  mkdirSync(join(dec, 'session'), { recursive: true })
  const sdb = new DatabaseSync(join(dec, 'session', 'session.db'))
  sdb.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
  for (let s = 0; s < shards; s += 1) {
    const talker = `wxid_ref${String(s)}`
    sdb.prepare('INSERT INTO SessionTable VALUES (?,?,?,?,0,1,\'\')').run(talker, talker, 1700000000 + s, 1700000000 + s)
    const db = new DatabaseSync(join(dec, 'message', `message_${String(s)}.db`))
    const table = 'Msg_' + createHash('md5').update(talker, 'utf8').digest('hex')
    db.exec(`CREATE TABLE "${table}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER, compress_content TEXT)`)
    db.prepare(`INSERT INTO "${table}" VALUES (?,?,1,0,?,1,?,'srv${String(s)}','')`)
      .run(1, 1, 1700000000 + s, `第 ${String(s)} 个分片的消息`)
    db.close()
  }
  sdb.close()
  return { dec }
}

describe('搜索索引构建：引用计数取消（P2）', () => {
  it('两个并发构建，一个取消，另一个继续并完成索引', async () => {
    const { dec } = makeFixture('idx-refcount')
    const ctl = new AbortController()
    const progressA: number[] = []
    const progressB: number[] = []
    const a = buildSearchIndex(dec, true, {
      signal: ctl.signal,
      onProgress: (done) => {
        progressA.push(done)
        if (done >= 1) ctl.abort()
      },
    })
    const b = buildSearchIndex(dec, true, { onProgress: (done) => { progressB.push(done) } })

    // 两次调用共享同一份底层构建：引用计数 = 2。
    const during = getSearchIndexBuildStatus(dec)
    expect(during.building).toBe(true)
    expect(during.force).toBe(true)
    expect(during.subscribers).toBe(2)

    const [ra, rb] = await Promise.all([a, b])

    // A 只取消自己；底层构建没有被 abort 掉。
    expect(ra.status).toBe('cancelled')
    expect(ra.message ?? '').toContain('旧索引')
    expect(rb.status).toBe('ok')
    expect(rb.rows).toBe(3)
    // 索引是完整的（不是半份，也没有被回滚）。
    expect(getSearchIndexStatus(dec).rows).toBe(3)
    expect(getSearchIndexBuildStatus(dec).building).toBe(false)

    // B 的进度一直走到最后一个分片；A 在 abort 后不再收到进度。
    expect(Math.max(...progressB)).toBe(3)
    expect(Math.max(...progressA)).toBeLessThan(3)
  })

  it('预取消的调用方不会影响已在飞的构建', async () => {
    const { dec } = makeFixture('idx-pre-abort')
    const running = buildSearchIndex(dec, true)
    const pre = new AbortController()
    pre.abort()
    const cancelled = await buildSearchIndex(dec, true, { signal: pre.signal })
    expect(cancelled.status).toBe('cancelled')
    // 预取消没有订阅（引用计数不应被它抬高/清零）。
    const built = await running
    expect(built.status).toBe('ok')
    expect(built.rows).toBe(3)
    expect(getSearchIndexStatus(dec).rows).toBe(3)
  })

  it('force 请求遇到在飞的非 force 构建时排队重建', async () => {
    const { dec } = makeFixture('idx-force-queue')
    // 索引不存在：非 force 调用会真的建一次。
    const light = buildSearchIndex(dec, false)
    const forced = buildSearchIndex(dec, true)
    // 队列里的条目已经是 force（后续 non-force 调用也不会把它降级）。
    expect(getSearchIndexBuildStatus(dec)).toMatchObject({ building: true, force: true })

    const [lightResult, forcedResult] = await Promise.all([light, forced])
    expect(lightResult.status).toBe('ok')
    expect(forcedResult.status).toBe('ok')
    expect(forcedResult.rows).toBe(3)
    expect(getSearchIndexBuildStatus(dec).building).toBe(false)
  })
})
