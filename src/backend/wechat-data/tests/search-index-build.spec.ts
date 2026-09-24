/**
 * 索引构建让出事件循环、并发与失败回滚、以及重建窗口内读侧不被降级（N9 / N10 / N15）。
 *
  * 与 `search-cursor.spec.ts` 同一次拆分（理由写在那份文件头上）：本文件管构建这一侧的九个命题 ——
 * 让出、WAL、不可读分片跳过、写入失败整体回滚、读取侧损坏只跳过分片、空分片清单不清空、
 * 并发构建不撞锁、不同数据根互不串、force 不吃在飞构建的答复，以及重建窗口内读侧仍看到旧索引。
 * 
 * 夹具来自 `search-spec-fixtures.ts`（两个文件共用一份实现）。
 * @vitest-environment node
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { openTrackedDb } from '../../tests/helpers/temp-db.ts'
import { buildSearchIndex, getSearchIndexStatus, searchIndexMessages, searchIndexPath } from '../src/query/search.ts'
import { TERM, USER, appendMessages, assertHighEntropy, cjkRows, makeFixture, makeRawFixture, trackScratch } from './search-spec-fixtures.ts'

/**
 * 本文件是「重夹具」文件：建真索引 + FTS 写 CJK，CI 的 runner 比本机慢约 24 倍
 * （2026-09-20 实测：整批用例耗时 2658s vs 本机 109s），全局 180s 档位装不下它 ——
 * 4 条夹具最大的用例在 runner 上超时。这里单独抬到 420s（作业级预算见 ci.yml）。
 */
vi.setConfig({ testTimeout: 420_000, hookTimeout: 420_000 })

trackScratch('search-index-build')

describe('索引构建会让出事件循环', () => {
  it('构建期间有其它宏任务被执行（不让出则一次都跑不到）', async () => {
    // 4200 行 > 2×YIELD_EVERY_ROWS(2000)，保证至少触发两次 yield。
    // 断言 ≥2 而不是 ≥1：把阈值调大到不触发（或只在收尾让出一次）就会只剩 0~1 次，
    // 这样判别式才真的依赖「周期性地让出」。
    const decrypted = makeFixture(4200, 10)

    const start = Date.now()
    const ticksInWindow: number[] = []
    let stop = false
    const tick = (): void => {
      if (stop) return
      ticksInWindow.push(Date.now())
      setImmediate(tick)
    }
    setImmediate(tick)

    const r = await buildSearchIndex(decrypted, true)
    const end = Date.now()
    stop = true

    expect(r.status).toBe('ok')
    expect(r.rows).toBe(4200)
    // 若构建全程同步不让出，JS 线程不会空出来，这段时间内不可能有 tick 落在窗口里。
    const during = ticksInWindow.filter(t => t >= start && t <= end)
    expect(during.length).toBeGreaterThanOrEqual(2)
  })

  it('长行也会触发让出：行数远不够时由字符上界兜住', async () => {
    // 夹具刻意卡在「只有字符上界能点亮」的区间：总量约 48 万字符 > YIELD_EVERY_CHARS(1<<17)，
    // 但既不到 YIELD_EVERY_ROWS(2000) 行，也**小于**旧值 1<<20 —— 所以把常量放宽回 1<<20
    // （或彻底去掉字符上界）都会让这条从「有让出」变成「0 次让出」。
    const decrypted = makeFixture(60, 10, 8000)

    const start = Date.now()
    const ticksInWindow: number[] = []
    let stop = false
    const tick = (): void => {
      if (stop) return
      ticksInWindow.push(Date.now())
      setImmediate(tick)
    }
    setImmediate(tick)

    const r = await buildSearchIndex(decrypted, true)
    const end = Date.now()
    stop = true

    expect(r.status).toBe('ok')
    expect(r.rows).toBe(60)
    const during = ticksInWindow.filter(t => t >= start && t <= end)
    // 约 48 万字符 / 131072 ≈ 3 次让出；要求 ≥2 就把常量钉在 ≤24 万字符
    // （放宽到 1<<18 只剩 1 次、到 1<<19 起为 0 次，都会被这条抓住）。
    expect(during.length).toBeGreaterThanOrEqual(2)
  })

  it('索引库处于 WAL 模式（重建窗口内读者不被写事务挡住的前提）', async () => {
    const decrypted = makeFixture(200, 3)
    await buildSearchIndex(decrypted, true)
    const db = openTrackedDb(searchIndexPath(decrypted), { readOnly: true })
    const mode = String(Object.values(db.prepare('PRAGMA journal_mode').get() as Record<string, unknown>)[0])
    db.close()
    expect(mode).toBe('wal')
  })

  it('不可读分片被跳过但记入结果（不再静默产出无法区分的残缺索引）', async () => {
    const decrypted = makeFixture(200, 3)
    // 在分片目录里塞一个不是 SQLite 的文件：shardCatalog 会把它当分片列出来。
    writeFileSync(join(decrypted, 'message', 'message_1.db'), 'this is not a sqlite database')
    const r = await buildSearchIndex(decrypted, true)
    expect(r.status).toBe('ok')
    expect(r.rows).toBe(200) // 好分片照常入库
    expect(r.message ?? '').toContain('已跳过')
  })

  it('索引写入失败必须整体回滚，旧索引原样保留（写错必须致命）', async () => {
    // 钉住第三轮的两件事：① 写侧失败不可被吞；② total/built_at/schema_version 与
    // 重建结果在同一次 COMMIT 里落地 —— 所以失败后旧索引（连 built_at）必须一个字节不变。
    // 关键设计：重建前先给夹具**加消息**，让「新索引行数」与「旧索引行数」不同，
    // 否则「COMMIT 提前」的旧实现也能蒙混过关（行数相同、built_at 也恰好没变）。
    const decrypted = makeFixture(300, 3)
    const first = await buildSearchIndex(decrypted, true)
    expect(first.status).toBe('ok')
    const before = getSearchIndexStatus(decrypted)
    appendMessages(decrypted, 301, 400)

    // meta 不会被重建（只有 message_meta / message_fts 会被 DROP），所以触发器能活到收尾
    const db = openTrackedDb(searchIndexPath(decrypted))
    db.exec("CREATE TRIGGER fail_meta BEFORE INSERT ON meta BEGIN SELECT RAISE(ABORT, 'injected meta write failure'); END")
    db.close()

    await expect(buildSearchIndex(decrypted, true)).rejects.toThrow(/构建搜索索引失败/)

    const after = getSearchIndexStatus(decrypted)
    expect(after.ready).toBe(true)
    // 旧索引没被换成「400 行的新索引」，也没被清空
    expect(after.rows).toBe(before.rows)
    expect(after.rows).toBe(300)
    expect(after.built_at).toBe(before.built_at)
    expect(searchIndexMessages(decrypted, TERM, 10).indexed).toBe(true)
  })

  it('分片读到一半损坏：只跳过该分片，其余照常入库（读取侧可跳过）', async () => {
    // 覆盖 #NEXT 分支（迭代中途报 malformed），与「非 SQLite 文件」走的 #PREP 不同。
    const decrypted = makeFixture(3000, 3, 900)
    const shard = join(decrypted, 'message', 'message_0.db')
    const buf = readFileSync(shard)
    buf.fill(0, 4096 * 40, 4096 * 41) // 清零第 40 页：文件仍是合法 sqlite，读到那页才报损坏
    writeFileSync(shard, buf)

    const r = await buildSearchIndex(decrypted, true)
    expect(r.status).toBe('ok')
    expect(r.message ?? '').toContain('已跳过')
    expect(r.rows).toBeLessThan(3000) // 损坏分片只入库了一部分（或 0），但没有整体失败
  })

  it('分片清单为空时不把现有索引清空（message 目录读不到 ≠ 用户删光了消息）', async () => {
    const decrypted = makeFixture(200, 3)
    await buildSearchIndex(decrypted, true)
    rmSync(join(decrypted, 'message'), { recursive: true, force: true })
    await expect(buildSearchIndex(decrypted, true)).rejects.toThrow(/分片清单为空/)
    // 旧索引仍在（构建被中止，没有 DROP）
    expect(getSearchIndexStatus(decrypted).rows).toBe(200)
  })

  it('构建完成后索引可用，且能查到关键词', async () => {
    const decrypted = makeFixture(300, 3)
    const r = await buildSearchIndex(decrypted, true)
    expect(r.status).toBe('ok')
    expect(r.rows).toBe(300)
    // 索引存在时走 BM25 通道（indexed=true）
    const found = searchIndexMessages(decrypted, TERM, 10)
    expect(found.indexed).toBe(true)
    expect(found.hits.length).toBeGreaterThan(0)
  })

  it('并发构建不会互相撞锁：两个调用都成功且复用同一次构建', async () => {
    // 转 async 之后写事务会跨 macrotask 保持开启，同一进程里第二个并发调用
    // 原本会直接撞 `database is locked`（改前同步执行不可能交错）。
    // 单飞闸让并发调用复用同一个 in-flight 构建。
    const decrypted = makeFixture(3000, 10)
    const [a, b] = await Promise.all([
      buildSearchIndex(decrypted, true),
      buildSearchIndex(decrypted, true),
    ])
    expect(a.status).toBe('ok')
    expect(b.status).toBe('ok')
    expect(a.rows).toBe(3000)
    // 同一个 in-flight 构建 → 两次拿到的是同一个结果对象
    expect(b).toBe(a)
  })

  it('不同数据根的并发构建互不串结果', async () => {
    // 单飞闸按 decryptedDir 分槽。若用一个全局槽，后者会拿到前者那次构建的结果
    // （行数是别人的），且永远不会为自己建索引。
    const a = makeFixture(300, 3)
    const b = makeFixture(700, 5)
    const [ra, rb] = await Promise.all([
      buildSearchIndex(a, true),
      buildSearchIndex(b, true),
    ])
    expect(ra.rows).toBe(300)
    expect(rb.rows).toBe(700)
  })

  it('force 调用不会把在飞的非 force 构建的「索引已存在」当答复', async () => {
    const decrypted = makeFixture(200, 3)
    await buildSearchIndex(decrypted, true)
    // 索引已存在且版本一致 → 非 force 调用走 'exists' 快路径，此时它仍在飞（.then 尚未执行）。
    const light = buildSearchIndex(decrypted, false)
    const forced = buildSearchIndex(decrypted, true)
    expect((await light).status).toBe('exists')
    const r = await forced
    // 显式要求重建就必须真的重建，而不是转发对方的 'exists'
    expect(r.status).toBe('ok')
    expect(r.rows).toBe(200)
  })

  it('已存在且版本一致时不再重建', async () => {
    const decrypted = makeFixture(100, 1)
    const first = await buildSearchIndex(decrypted, true)
    expect(first.status).toBe('ok')
    const second = await buildSearchIndex(decrypted, false)
    expect(second.status).toBe('exists')
  })
})

describe('重建窗口内读侧不被降级', () => {
  it('force 重建期间，状态与检索仍读到旧索引（而不是 ready:false / 退化成 LIKE）', async () => {
    // 夹具必须大到让写事务溢出页缓存（默认 2MB）：delete/journal 模式下写事务一旦溢出就
    // 持 EXCLUSIVE 到 COMMIT，读者整段被拒 —— 实测溢出点约 1.75MB。夹具太小时（例如
    // 8000 行 × 90 字节 ≈ 720KB）根本不溢出，这条用例会变成「WAL 有没有都绿」的假绿。
    const bodies = cjkRows(500, 6000, (i) => (i < 5 ? `needle 第 ${i + 1} 条 ` : `普通消息 ${i + 1} `))
    assertHighEntropy(bodies[0] ?? '', '含关键词的首行')
    assertHighEntropy(bodies[bodies.length - 1] ?? '', '末行')
    const decrypted = makeRawFixture(bodies)

    // 先建好旧索引
    const first = await buildSearchIndex(decrypted, true)
    expect(first.status).toBe('ok')
    expect(first.rows).toBe(6000)

    // 再 force 重建，并在**整个窗口内反复探测**（只探一次会落在写事务溢出页缓存之前，
    // 那时 delete 模式也读得到旧快照，测不出区别）。
    const rebuilding = buildSearchIndex(decrypted, true)
    const seen: Array<{ ready: boolean; rows: number; indexed: boolean }> = []
    let done = false
    const probe = (): void => {
      if (done) return
      const st = getSearchIndexStatus(decrypted)
      const hit = searchIndexMessages(decrypted, 'needle', 10)
      seen.push({ ready: st.ready, rows: st.rows, indexed: hit.indexed })
      setImmediate(probe)
    }
    setImmediate(probe)
    await rebuilding
    done = true

    // 先断言「没有降级」再断言「探测次数够」：两个命题互不遮蔽。
    // （反过来的话，探测次数不足会先失败，而 degraded 的结论根本没被求值。）
    const degraded = seen.filter(o => !o.ready || o.rows !== 6000 || !o.indexed)
    expect(degraded).toEqual([])
    expect(seen.length).toBeGreaterThan(3)
  })
})

/**
 * H9 的内存实测（默认跳过，靠 MEASURE_SEARCH_MEMORY=1 开启）。
 *
 * 与 H8 同一取舍：RSS 受 GC 时机影响，放进 CI 会变成随机红灯，但它正是验收标准
 * 要求的「记录实测峰值」，所以保留为可手动执行的测量，结果记在 docs/RELEASE-PLAN.md。
 *
 * 运行：MEASURE_SEARCH_MEMORY=1 node node_modules/vitest/vitest.mjs run \
 *        src/backend/wechat-data/tests/search-cursor.spec.ts
 */
describe.skipIf(process.env.MEASURE_SEARCH_MEMORY !== '1')('H9 内存实测', () => {
  it('兜底搜索：iterate 的 RSS 峰值低于 all() 物化同一张表', () => {
    const TOTAL = Number(process.env.MEASURE_SEARCH_ROWS ?? '200000')
    // 单条约 500 字节，接近真实聊天消息量级（这才是内存差距的来源）。
    const PAD = Number(process.env.MEASURE_SEARCH_PAD ?? '480')
    const decrypted = makeFixture(TOTAL, 5, PAD)
    const shard = join(decrypted, 'message', 'message_0.db')
    const table = 'Msg_' + createHash('md5').update(USER, 'utf8').digest('hex')

    const MB = (n: number): string => (n / 1024 / 1024).toFixed(1) + 'MB'
    const sample = (label: string, fn: () => void): number => {
      const base = process.memoryUsage().rss
      let peak = base
      const t = setInterval(() => {
        const v = process.memoryUsage().rss
        if (v > peak) peak = v
      }, 5)
      fn()
      clearInterval(t)
      const v = process.memoryUsage().rss
      if (v > peak) peak = v
      const delta = peak - base
      console.log(`   ${label}：RSS 峰值增量 ${MB(delta)}`)
      return delta
    }

    // 旧做法：一次 .all() 把整张表物化成数组
    const allPeak = sample('all() 物化整表', () => {
      const db = openTrackedDb(shard, { readOnly: true })
      const rows = db.prepare(`SELECT local_id, create_time, message_content FROM "${table}" WHERE local_type=1`).all() as unknown[]
      void rows.length
      db.close()
    })
    // 新做法：走真实兜底搜索（内部 iterate）
    const iterPeak = sample('iterate 兜底搜索', () => {
      const r = searchIndexMessages(decrypted, TERM, 100)
      void r.hits.length
    })

    console.log(`\nH9 实测：${TOTAL} 行 · all() ${MB(allPeak)} vs iterate ${MB(iterPeak)}`)
    expect(iterPeak).toBeLessThan(allPeak)
  }, 900_000)
})

