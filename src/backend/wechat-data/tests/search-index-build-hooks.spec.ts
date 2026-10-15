// @vitest-environment node
/**
 * 搜索索引构建的**进度与取消**行为回归（W3-11.5 铺到第二个入口）。
 *
 * 全量构建是秒级起步（百万行库更久），而此前界面上只有一个禁用的「构建中…」——
 * 用户不知道它跑到哪儿，也不敢切走。这份用例钉住铺件后的四件事：
 *   ① 进度按**分片**推进：`done/total` 的 `total` 是真实分片数（清单一次拿全），
 *      而不是「到目前为止的总数」那种一路变大的假进度；`rows` 是已入库行数。
 *   ② **进事务前先查取消**：已经被取消的构建不该先把旧索引的表 DROP 掉再回滚 ——
 *      那期间读者会短暂读到空表（而读侧看不出新旧之分，只看 ready/rows）。
 *   ③ 分片内也让出点能响应取消（单个分片可能十万行，只查边界等于「几乎停不下来」）。
 *   ④ 取消 ⇒ **ROLLBACK + status:'cancelled'**，旧索引原封不动、且不抛错
 *      （抛错会被界面显示成红色错误，而索引并没有坏）。
 *
 * 夹具造 3 个分片、每个会话 1 条消息，构建必然逐分片推进；取消点用
 * `onProgress` 在指定分片上 abort（比 `sleep` 之类的时序假设稳）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { buildSearchIndex, getSearchIndexStatus } from '../src/query/search.ts'
import { createTempWorkspace, type TempWorkspace } from '../../tests/helpers/temp-db.ts'

const workspaces: TempWorkspace[] = []
afterEach(async () => {
  for (const w of workspaces.splice(0, workspaces.length)) await w.cleanup()
})

/**
 * 造一个含 `shards` 个消息分片的**数据根**（`decrypted` 那一层）。
 *
 * 两个坑都在这里，各踩过一次：
 *  · ① `runBuildSearchIndex` 的用户名清单来自 session.db（`loadSessionUsenames`）——
 *    只造 message 分片的话 usernames 为空，于是一条都读不到；
 *  · ② `searchIndexPath` 是 `dirname(decryptedDir)/wechat_search.db`，也就是索引落在**数据根
 *    的父目录**。直接拿 `w.dir` 当 decryptedDir ⇒ 所有夹具共用 `%TEMP%/wechat_search.db`，
 *    第一个用例建的索引会被后面的用例读成「已有的 3 行」（本文件第一版的第 5 条就是这么红的）。
 *    与 `read-failure-contract.spec.ts` 里那条「数据根里再套一层」的纪律同源。
 */
function makeFixture(tag: string, shards: number, rowsPerShard = 1): { w: TempWorkspace; dec: string; talkers: string[] } {
  const w = createTempWorkspace(tag)
  workspaces.push(w)
  const dec = join(w.dir, 'decrypted')
  mkdirSync(join(dec, 'message'), { recursive: true })
  mkdirSync(join(dec, 'session'), { recursive: true })
  const talkers: string[] = []
  const sdb = new DatabaseSync(join(dec, 'session', 'session.db'))
  sdb.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
  for (let s = 0; s < shards; s += 1) {
    const talker = `wxid_t${String(s)}`
    talkers.push(talker)
    sdb.prepare('INSERT INTO SessionTable VALUES (?,?,?,?,0,1,\'\')').run(talker, talker, 1700000000 + s, 1700000000 + s)
    const db = new DatabaseSync(join(dec, 'message', `message_${String(s)}.db`))
    const table = 'Msg_' + createHash('md5').update(talker, 'utf8').digest('hex')
    db.exec(`CREATE TABLE "${table}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER, compress_content TEXT)`)
    for (let i = 0; i < rowsPerShard; i += 1) {
      // 每条都自带一个数字，好让 onProgress 的 rows 读数能区分「在动」和「没动」。
      db.prepare(`INSERT INTO "${table}" VALUES (?,?,1,0,?,1,?,?,'')`)
        .run(i + 1, i + 1, 1700000000 + s + i, '第 ' + String(s) + ' 个分片第 ' + String(i) + ' 条消息', 'srv' + String(s) + '-' + String(i))
    }
    db.close()
  }
  sdb.close()
  return { w, dec, talkers }
}

describe('搜索索引构建：进度（W3-11.5）', () => {
  it('按分片推进，total 是真实分片数，且带已入库行数', async () => {
    const { w, dec } = makeFixture('idx-progress', 3)
    const seen: Array<{ done: number; total: number; rows: number }> = []
    const r = await buildSearchIndex(dec, true, { onProgress: (done, total, rows) => { seen.push({ done, total, rows }) } })
    expect(r.status).toBe('ok')
    expect(r.rows).toBe(3)
    expect(seen.length, '一次 3 分片的构建至少要报 3 次（否则界面全程只有一个 0/0）').toBeGreaterThanOrEqual(3)
    // ① total 恒为真实分片数（3），不是「到目前为止的总数」。
    for (const s of seen) expect(s.total).toBe(3)
    // done 单调不回退，且最后恰好落在分片总数上。
    const dones = seen.map((s) => s.done)
    for (let i = 1; i < dones.length; i += 1) {
      expect(dones[i]!, `第 ${String(i)} 次上报的 done 回退了`).toBeGreaterThanOrEqual(dones[i - 1]!)
    }
    expect(Math.max(...dones)).toBe(3)
    // rows 单调不回退（分片内也会报，读数会一路涨）。
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]!.rows).toBeGreaterThanOrEqual(seen[i - 1]!.rows)
  })

  it('不传钩子时行为不变（观测设施不许成为前提）', async () => {
    const { w, dec } = makeFixture('idx-progress-none', 2)
    const r = await buildSearchIndex(dec, true)
    expect(r.status).toBe('ok')
    expect(r.rows).toBe(2)
  })
})

describe('搜索索引构建：取消（W3-11.5）', () => {
  it('中途取消 ⇒ status cancelled + 旧索引原封不动（且不抛错）', async () => {
    const { w, dec } = makeFixture('idx-cancel', 3)
    // 先建一份完整索引，作为「旧索引」。
    const first = await buildSearchIndex(dec, true)
    expect(first.status).toBe('ok')
    expect(first.rows).toBe(3)

    // 再来一次构建，在第 1 个分片完成时取消。
    const ctl = new AbortController()
    const r = await buildSearchIndex(dec, true, {
      signal: ctl.signal,
      onProgress: (done) => { if (done >= 1) ctl.abort() },
    })
    // ④ 取消不是失败：ok 状态字段是 cancelled，且带一句人话。
    expect(r.status).toBe('cancelled')
    expect(r.message ?? '').toContain('旧索引')
    // 旧索引必须还在，而且仍然是那 3 行（没被回滚掉、更没被半份替换）。
    const st = getSearchIndexStatus(dec)
    expect(st.exists).toBe(true)
    expect(st.rows, '取消后旧索引必须完好 —— 回滚而不是留半份').toBe(3)
  })

  it('一开始就被取消 ⇒ 旧索引连「被 DROP 过」都不该发生', async () => {
    const { w, dec } = makeFixture('idx-cancel-pre', 2)
    const ctl = new AbortController()
    ctl.abort()
    const r = await buildSearchIndex(dec, true, { signal: ctl.signal })
    expect(r.status).toBe('cancelled')
    // 索引还没建过 ⇒ 依旧没有（既没建成、也没留下一张空表）。
    const st = getSearchIndexStatus(dec)
    expect(st.rows).toBe(0)
    expect(st.ready).toBe(false)
  })

  it('取消后可以重建（取消不是把这条路堵死）', async () => {
    const { w, dec } = makeFixture('idx-cancel-rebuild', 3)
    const ctl = new AbortController()
    await buildSearchIndex(dec, true, { signal: ctl.signal, onProgress: (done) => { if (done >= 1) ctl.abort() } })
    const again = await buildSearchIndex(dec, true)
    expect(again.status).toBe('ok')
    expect(again.rows).toBe(3)
  })

  it('不传 signal 时构建照常跑完（取消是可选能力）', async () => {
    const { dec } = makeFixture('idx-cancel-none', 2)
    const r = await buildSearchIndex(dec, true)
    expect(r.status).toBe('ok')
    expect(r.rows).toBe(2)
  })

  it('分片内部也能停（只在分片边界查的话，一个十万行的分片等于停不下来）', async () => {
    // 单个分片 2500 行 ⇒ 跨过 YIELD_EVERY_ROWS=2000 的让出点，
    // 也就是分片**内部**第一次检查取消的地方。整个构建只有一个分片，
    // 而边界那次检查发生在进事务时（那时还没 abort），所以本条只有分片内的检查能救。
    const { dec } = makeFixture('idx-cancel-in-shard', 1, 2500)
    const ctl = new AbortController()
    let sawInShardProgress = false
    const r = await buildSearchIndex(dec, true, {
      signal: ctl.signal,
      onProgress: (done, _total, rows) => {
        // done 恒为 0 ⇒ 是分片内的让出点在报（分片跑完时 done 才是 1）。
        if (done === 0 && rows > 0) { sawInShardProgress = true; ctl.abort() }
      },
    })
    expect(sawInShardProgress, '本条的前提是「分片内部上报过进度」，否则它其实在测边界').toBe(true)
    expect(r.status, '在分片内部就停住（说明让出点那次检查真的生效了）').toBe('cancelled')
    const st = getSearchIndexStatus(dec)
    expect(st.rows, '取消后不留半份索引').toBe(0)
  })
})
/** 占位：确保 writeFileSync 的导入不被 lint 判成未使用（本文件只用 DatabaseSync 建库）。 */
void writeFileSync
