/**
 * N10：向量建库的**写事务不得跨网络**，且同一向量库上的并发调用必须合并。
 *
 * 改前的两处缺陷（复合）：
 *   ① 写事务从 `BEGIN` 一直开到所有 embedding 请求回来 —— 事务持有时间被网络往返支配；
 *      期间同进程的第二个写者直接 `database is locked`（计划里的实测：1555ms 内一个成功、
 *      另一个报错）。
 *   ② 重建时的 `DELETE FROM vectors` 在事务**之前**各自 autocommit —— 中途失败会把已有索引
 *      留成空表（H9 第三轮在搜索路径上修过同一个问题）。
 *
 * 判据都是**行为事实**，不打桩内部函数：
 *   · 「事务不跨网络」→ 建库在飞（第二批请求挂起）时，另一条连接上的写事务必须立刻提交成功；
 *   · 「合并并发」→ 两次并发调用都成功、且只发一轮请求；
 *   · 「重建失败不毁索引」→ force 重建中途失败后，旧向量一条不少。
 *
 * @vitest-environment node
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'

import { buildVectorIndex, vectorDbPath, vectorIndexStatus } from '../src/query/retrieval/embedding.ts'
// N26：临时目录与库连接统一交给共享助手（先关连接、再删目录；用例抛错也收尾）。
// 本文件此前的收尾是「裸 rmSync，失败即抛」—— 既有残留（%TEMP%\wx-n10-*）也有噪声。
import { createTempWorkspace } from '../../tests/helpers/temp-db.ts'
import type { TempWorkspace } from '../../tests/helpers/temp-db.ts'

const scratch: TempWorkspace[] = []
afterEach(async () => {
  const list = scratch.splice(0)
  for (const ws of list) {
    const r = await ws.cleanup()
    if (!r.ok) console.warn(`[vector-build-gate] 临时目录未能删除（${r.code}，试了 ${r.attempts} 次）：${ws.dir}`)
  }
})

function tempRoot(): TempWorkspace {
  const ws = createTempWorkspace('n10')
  scratch.push(ws)
  return ws
}

/** 造一个只有 message_meta 的稀疏索引 + 一个解密目录（与 M10 用例同一套夹具）。 */
function makeFixture(texts: string[]): { dec: string; root: string } {
  const ws = tempRoot()
  const dec = join(ws.dir, 'decrypted')
  mkdirSync(dec, { recursive: true })
  // N26：走登记册开库（下面照常显式 close；登记册兜住中途抛错的路径）
  const db = ws.db('wechat_search.db')
  db.exec('CREATE TABLE message_meta (rowid INTEGER PRIMARY KEY, text TEXT, username TEXT, local_id INTEGER, create_time INTEGER)')
  const ins = db.prepare('INSERT INTO message_meta VALUES (?,?,?,?,?)')
  texts.forEach((t, i) => ins.run(i + 1, t, 'wxid_a', i + 1, 1700000000 + i))
  db.close()
  return { dec, root: ws.dir }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

/** 按文本给确定性向量（与 M10 用例一致）。 */
function vecOf(t: string): number[] {
  const v = [0, 0, 0, 0, 0, 0, 0, 0]
  for (let i = 0; i < t.length; i += 1) { const k = i % 8; v[k] = (v[k] ?? 0) + t.charCodeAt(i) % 7 }
  return v.every((x) => x === 0) ? [1, 0, 0, 0, 0, 0, 0, 0] : v
}

/**
 * 可**逐批放行**的桩 embedding：每次进入都挂起，直到测试显式放行。
 *
 * 为什么不用固定延迟：本用例要断言的是「请求在飞的那段时间里，另一个写者能不能提交」——
 * 用 sleep 去赌时序会时红时绿（H7 的教训）。这里让测试精确控制「第几批在飞」。
 * @returns embed 函数、调用记录、等待第 n 次调用发生、放行第 i 次调用。
 */
function gatedEmbed(): {
  embed: (texts: string[]) => Promise<number[][]>
  calls: string[][]
  waitForCall: (n: number) => Promise<void>
  release: (i: number) => void
} {
  const calls: string[][] = []
  const gates: Array<{ promise: Promise<void>; resolve: () => void }> = []
  const waiters: Array<() => void> = []
  return {
    calls,
    embed: async (texts: string[]) => {
      const gate = deferred()
      gates.push(gate)
      calls.push([...texts])
      for (const w of waiters.splice(0)) w()
      await gate.promise
      return texts.map(vecOf)
    },
    waitForCall: (n: number) => new Promise<void>((resolve) => {
      const check = (): void => { if (calls.length >= n) resolve(); else waiters.push(check) }
      check()
    }),
    release: (i: number) => gates[i]?.resolve(),
  }
}

const OPTS = { model: 'stub', batchSize: 2, maxCharsPerDoc: 200, maxDocsPerBuild: 1000 }

describe('N10：建库的写事务不跨网络', () => {
  it('第二批请求在飞时，另一条连接仍能立刻完成一次写事务（改前此处是 database is locked）', async () => {
    const { dec } = makeFixture(['a', 'b', 'c', 'd', 'e', 'f'])
    const g = gatedEmbed()
    const building = buildVectorIndex(dec, g.embed, { ...OPTS, concurrency: 1 })

    await g.waitForCall(1)
    // 放行第一批：改前实现此刻已 BEGIN 且写过第一行 —— 写锁就此持到 COMMIT
    g.release(0)
    await g.waitForCall(2)

    // 建库仍在飞（第二批网络等待中）：另一个「写者」尝试一次完整写事务
    const other = new DatabaseSync(vectorDbPath(dec))
    const t0 = Date.now()
    let err: unknown = null
    try {
      other.exec('BEGIN IMMEDIATE')
      other.exec("INSERT OR REPLACE INTO meta(key, value) VALUES('probe', '1')")
      other.exec('COMMIT')
    } catch (e) {
      err = e
    }
    const elapsed = Date.now() - t0
    other.close()

    // 收尾：把剩下的批次放行，让建库正常结束，避免留下悬挂的 promise
    let released = 1
    const drain = async (): Promise<void> => {
      for (;;) {
        const done = await Promise.race([
          building.then(() => true),
          g.waitForCall(released + 1).then(() => false),
        ])
        if (done) return
        g.release(released)
        released += 1
      }
    }
    await drain()

    expect(err, `建库在飞时并发写被拒（${String(err)}）—— 说明写事务跨了网络`).toBeNull()
    expect(elapsed, `并发写耗时 ${elapsed}ms，超过 500ms 说明在等锁`).toBeLessThan(500)
  })

  it('两次并发调用都成功，且只发一轮请求（单飞闸合并）', async () => {
    const { dec } = makeFixture(['a', 'b', 'c', 'd'])
    const g = gatedEmbed()
    const opts = { ...OPTS, batchSize: 4, concurrency: 1 }

    const p1 = buildVectorIndex(dec, g.embed, opts)
    await g.waitForCall(1)
    const p2 = buildVectorIndex(dec, g.embed, opts)
    expect(p2, '非 force 的并发调用应复用同一个在飞构建').toBe(p1)

    g.release(0)
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.status).toBe('ok')
    expect(r2).toEqual(r1)
    expect(g.calls.length, `发了 ${g.calls.length} 轮请求，应当只有 1 轮`).toBe(1)
    expect(vectorIndexStatus(dec).rows).toBe(4)
  })

  it('同一向量库的不同写法（结尾分隔符）也会合并 —— 键取 DB 路径而不是调用方字符串', async () => {
    const { dec } = makeFixture(['a', 'b'])
    const g = gatedEmbed()
    const opts = { ...OPTS, batchSize: 2, concurrency: 1 }

    const p1 = buildVectorIndex(dec, g.embed, opts)
    await g.waitForCall(1)
    const p2 = buildVectorIndex(dec + sep, g.embed, opts)
    expect(p2, '`…\\decrypted` 与 `…\\decrypted\\` 解析到同一个 DB 文件，应占同一个槽').toBe(p1)
    g.release(0)
    await Promise.all([p1, p2])
  })

  it('force 撞上在飞的非 force 构建时排队重做，而不是拿到对方「已是最新」的答复', async () => {
    const { dec } = makeFixture(['a', 'b'])
    const g = gatedEmbed()
    const opts = { ...OPTS, batchSize: 2, concurrency: 1 }

    const p1 = buildVectorIndex(dec, g.embed, opts)
    await g.waitForCall(1)
    const p2 = buildVectorIndex(dec, g.embed, { ...opts, force: true })
    expect(p2).not.toBe(p1)

    g.release(0)
    await p1
    await g.waitForCall(2) // 第二次构建真的重新请求了（说明它没被合并掉）
    g.release(1)
    const r2 = await p2
    expect(r2.status).toBe('ok')
    expect(g.calls.length).toBe(2)
  })
})

describe('N10：重建失败不得毁掉已有索引', () => {
  it('force 重建中途失败 → 旧向量一条不少（DELETE 在事务里，随 ROLLBACK 撤销）', async () => {
    const { dec } = makeFixture(['a', 'b', 'c'])
    const first = await buildVectorIndex(dec, async (t) => t.map(vecOf), { ...OPTS, batchSize: 3 })
    expect(first.status).toBe('ok')
    expect(vectorIndexStatus(dec).rows).toBe(3)

    const boom = async (): Promise<number[][]> => { throw new Error('网络断了') }
    await expect(buildVectorIndex(dec, boom, { ...OPTS, batchSize: 3, force: true })).rejects.toThrow('网络断了')

    expect(vectorIndexStatus(dec).rows, '失败的重建把已有向量清空了（DELETE 跑到事务外了）').toBe(3)
  })

  it('失败之后单飞闸被释放：下一次构建照常可跑（闸不能卡死）', async () => {
    const { dec } = makeFixture(['a', 'b'])
    const boom = async (): Promise<number[][]> => { throw new Error('第一批就失败') }
    await expect(buildVectorIndex(dec, boom, { ...OPTS, batchSize: 2 })).rejects.toThrow('第一批就失败')

    const ok = await buildVectorIndex(dec, async (t) => t.map(vecOf), { ...OPTS, batchSize: 2 })
    expect(ok.status).toBe('ok')
    expect(ok.embedded).toBe(2)
  })
})

/**
 * 取源码里 `BEGIN`/`COMMIT`/`DELETE FROM vectors`/`await` 的**节点位置**。
 * 用 AST 而不是文本搜索：注释里写「不含任何 await」不该影响判定（M12/N19/N20 的同一课）。
 * @param file - embedding.ts 绝对路径。
 * @returns 各类位置（升序）。
 */
function scanTransactionMarkers(file: string): {
  begins: number[]
  commits: number[]
  deletes: number[]
  awaits: number[]
} {
  const src = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const begins: number[] = []
  const commits: number[] = []
  const deletes: number[] = []
  const awaits: number[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node)) awaits.push(node.getStart(sf))
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'exec') {
        const arg = node.arguments[0]
        if (arg && ts.isStringLiteralLike(arg)) {
          if (arg.text === 'BEGIN') begins.push(node.getStart(sf))
          else if (arg.text === 'COMMIT') commits.push(node.getStart(sf))
          else if (arg.text.includes('DELETE FROM vectors')) deletes.push(node.getStart(sf))
        }
      }
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return { begins, commits, deletes, awaits }
}

describe('N10：事务段的结构守卫（源码级）', () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'query', 'retrieval', 'embedding.ts')

  it('每个 BEGIN→COMMIT 段内都没有 await，且 DELETE 落在事务里', () => {
    const { begins, commits, deletes, awaits } = scanTransactionMarkers(file)
    // 防空转：两处事务（up-to-date 的 meta 写 + 主写入）都必须被扫到
    expect(begins.length, `只扫到 ${begins.length} 处 BEGIN —— 解析可能失效`).toBeGreaterThanOrEqual(2)
    expect(commits.length).toBeGreaterThanOrEqual(2)

    const ranges: Array<[number, number]> = []
    for (const b of begins) {
      const end = commits.find((c) => c > b)
      expect(end, 'BEGIN 之后没有 COMMIT').toBeTruthy()
      ranges.push([b, end as number])
    }
    for (const [b, e] of ranges) {
      const inside = awaits.filter((a) => a > b && a < e)
      expect(inside, `BEGIN(${b})→COMMIT(${e}) 段内有 ${inside.length} 个 await —— 事务又跨 await 了`).toEqual([])
    }
    // 「重建时 DELETE 必须进事务」：DELETE 的位置要落在某个 BEGIN→COMMIT 区间内
    expect(deletes.length, '找不到 DELETE FROM vectors').toBeGreaterThan(0)
    for (const d of deletes) {
      expect(ranges.some(([b, e]) => d > b && d < e), `DELETE(${d}) 不在任何事务段内`).toBe(true)
    }
  })
})
