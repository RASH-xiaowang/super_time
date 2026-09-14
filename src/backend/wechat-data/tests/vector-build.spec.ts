/**
 * M10：向量索引构建的**去重扇出**与**有界并发**。
 *
 * 背景（立项时的实测）：真实搜索索引里 `message_meta.text` 有 **56.5% 是重复的**
 * （152446 行 → 66270 个不同文本），而原实现是一批 16 条、逐批串行 `await`
 * （`maxDocsPerBuild: 40000` ⇒ 单次建库 2500 次往返，全程被网络延迟支配）。
 * 所以两件事：① 同一文本只请求一次、向量扇出到该组所有行；② 请求有界并发。
 *
 * 顺带记录一条**证伪**：条目里「simhash 同步 O(64·dim) 阻塞」在本机不成立 ——
 * 实测 0.037ms/篇（dim=768、64 平面，且 `getPlanes` 有缓存），每批 16 篇仅 ≈0.6ms。
 * 仍然每批让出一次事件循环，但那只是廉价保险，不是「修好了一个复现出来的卡顿」。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { buildVectorIndex, vectorIndexStatus } from '../src/query/retrieval/embedding.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-m10-'))
  scratch.push(dir)
  return dir
}

/** 造一个只有 message_meta 的稀疏索引 + 一个解密目录。 */
function makeFixture(texts: string[]): { dec: string; root: string } {
  const root = tempRoot()
  const dec = join(root, 'decrypted')
  mkdirSync(dec, { recursive: true })
  const db = new DatabaseSync(join(root, 'wechat_search.db'))
  db.exec('CREATE TABLE message_meta (rowid INTEGER PRIMARY KEY, text TEXT, username TEXT, local_id INTEGER, create_time INTEGER)')
  const ins = db.prepare('INSERT INTO message_meta VALUES (?,?,?,?,?)')
  texts.forEach((t, i) => ins.run(i + 1, t, 'wxid_a', i + 1, 1700000000 + i))
  db.close()
  return { dec, root }
}

/** 桩 embedding：记录每次收到的文本批次，并按文本给确定性向量。 */
function trackingEmbed(opts: { delayMs?: number } = {}): {
  embed: (texts: string[]) => Promise<number[][]>
  calls: string[][]
  maxInFlight: () => number
} {
  const calls: string[][] = []
  let inFlight = 0
  let peak = 0
  const vecOf = (t: string): number[] => {
    const v = [0, 0, 0, 0, 0, 0, 0, 0]
    for (let i = 0; i < t.length; i += 1) v[i % 8] += t.charCodeAt(i) % 7
    return v.every((x) => x === 0) ? [1, 0, 0, 0, 0, 0, 0, 0] : v
  }
  return {
    calls,
    maxInFlight: () => peak,
    embed: async (texts: string[]) => {
      calls.push([...texts])
      inFlight += 1
      peak = Math.max(peak, inFlight)
      try {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
        return texts.map(vecOf)
      } finally {
        inFlight -= 1
      }
    },
  }
}

const OPTS = { model: 'stub', batchSize: 4, maxCharsPerDoc: 200, maxDocsPerBuild: 1000 }

describe('M10 向量建库：同文本只请求一次、向量扇出到所有行', () => {
  it('重复文本被合并成一次请求，但每一行都要有自己的向量', async () => {
    // 12 行 / 3 个不同文本（各重复 4 次）
    const texts = ['重复一句话', '同一段引用', '第三条'].flatMap((t) => [t, t, t, t])
    const { dec } = makeFixture(texts)
    const stub = trackingEmbed()
    const r = await buildVectorIndex(dec, stub.embed, { ...OPTS, concurrency: 1 })

    expect(r.status).toBe('ok')
    expect(r.embedded).toBe(12) // 每一行都写进去了（扇出）
    expect(r.embed_calls).toBe(1) // 3 个唯一文本 ≤ batchSize=4 ⇒ 只需要 1 次请求
    const sent = stub.calls.flat()
    expect(new Set(sent).size).toBe(3)
    expect(sent.length).toBe(3) // 每个唯一文本只被送进去一次（没有重复请求）

    // 同组各行的向量与哈希必须一致
    const db = new DatabaseSync(join(dec, '..', 'wechat_rag_vectors.db'), { readOnly: true })
    const rows = db.prepare('SELECT fts_rowid, vec, hash_lo, hash_hi FROM vectors ORDER BY fts_rowid').all() as Array<{ fts_rowid: number; vec: Uint8Array; hash_lo: number; hash_hi: number }>
    db.close()
    expect(rows.length).toBe(12)
    const key = (x: { vec: Uint8Array; hash_lo: number; hash_hi: number }): string =>
      String(x.hash_lo) + ':' + String(x.hash_hi) + ':' + Buffer.from(x.vec).toString('hex')
    for (let g = 0; g < 3; g += 1) {
      const four = rows.slice(g * 4, g * 4 + 4)
      expect(new Set(four.map(key)).size).toBe(1)
    }
    expect(new Set(rows.map(key)).size).toBe(3) // 不同文本得到不同向量
  })

  it('去重按**截断后**的文本判定（那才是送进模型的输入）', async () => {
    // 两个文本在前 8 字符相同、之后不同；maxCharsPerDoc=8 ⇒ 归为同一组
    const texts = ['ABCDEFGH' + '甲甲甲', 'ABCDEFGH' + '乙乙乙', 'ZZZZZZZZ' + '丙丙丙']
    const { dec } = makeFixture(texts)
    const stub = trackingEmbed()
    const r = await buildVectorIndex(dec, stub.embed, { ...OPTS, maxCharsPerDoc: 8, concurrency: 1 })
    expect(r.embed_calls).toBe(1)
    expect(stub.calls.flat()).toEqual(['ABCDEFGH', 'ZZZZZZZZ'])
    expect(r.embedded).toBe(3)
  })

  it('无重复文本时行为不变（每行各自一个向量）', async () => {
    const texts = ['a1', 'b2', 'c3', 'd4', 'e5']
    const { dec } = makeFixture(texts)
    const stub = trackingEmbed()
    const r = await buildVectorIndex(dec, stub.embed, { ...OPTS, batchSize: 2, concurrency: 1 })
    expect(r.embed_calls).toBe(3) // ceil(5/2)
    expect(r.embedded).toBe(5)
    expect(new Set(stub.calls.flat()).size).toBe(5)
  })

  it('扇出共享的 blob **视图**不会让同组多行在库里别名（改一行的向量不影响其它行）', () => {
    // 这条专门盯我引入的一处风险：`vecToBlob` 返回的是 `Float32Array` 的**视图**（不拷贝），
    // 而扇出时我把它算一次、绑给同组所有行 —— 若 sqlite 延迟读取该视图，同组各行就会共享
    // 同一块内存。上面那条「同组字节相同」在别名下**也会通过**，所以不够：必须是
    // 「改一行，看别的行是否跟着变」。
    const texts = ['同一条复读文本', '独立的另一条', '同一条复读文本']
    const { dec } = makeFixture(texts)
    const stub = trackingEmbed()
    return buildVectorIndex(dec, stub.embed, { ...OPTS, concurrency: 1 }).then(() => {
      const p = join(dec, '..', 'wechat_rag_vectors.db')
      const db = new DatabaseSync(p)
      try {
        const before = db.prepare('SELECT fts_rowid, vec FROM vectors ORDER BY fts_rowid').all() as Array<{ fts_rowid: number; vec: Uint8Array }>
        expect(before.length).toBe(3)
        const row1 = before[0]
        const row3 = before[2]
        // 同组（1 与 3）字节相同；不同组不同
        expect(Buffer.from(row3.vec).equals(Buffer.from(row1.vec))).toBe(true)
        expect(Buffer.from(before[1].vec).equals(Buffer.from(row1.vec))).toBe(false)

        // 改第 3 行的向量 → 第 1 行必须原封不动
        const mutated = new Uint8Array(row3.vec)
        mutated[0] = (mutated[0] + 1) & 0xff
        db.prepare('UPDATE vectors SET vec = ? WHERE fts_rowid = 3').run(mutated)
        const after1 = db.prepare('SELECT vec FROM vectors WHERE fts_rowid = 1').get() as { vec: Uint8Array }
        expect(Buffer.from(after1.vec).equals(Buffer.from(row1.vec))).toBe(true)
      } finally {
        db.close()
      }
    })
  })
})

describe('M10 向量建库：并发边界', () => {
  it('并发数真的并行（达到上限）且不超过上限', async () => {
    const texts = Array.from({ length: 40 }, (_, i) => '独特文本' + String(i))
    const { dec } = makeFixture(texts)
    const stub = trackingEmbed({ delayMs: 20 })
    const r = await buildVectorIndex(dec, stub.embed, { ...OPTS, batchSize: 2, concurrency: 3 })
    expect(r.embed_calls).toBe(20) // 40 / 2
    expect(stub.maxInFlight()).toBe(3) // 真的并行到 3
  })

  it('concurrency=1 时严格串行', async () => {
    const texts = Array.from({ length: 10 }, (_, i) => 't' + String(i))
    const { dec } = makeFixture(texts)
    const stub = trackingEmbed({ delayMs: 5 })
    await buildVectorIndex(dec, stub.embed, { ...OPTS, batchSize: 2, concurrency: 1 })
    expect(stub.maxInFlight()).toBe(1)
  })

  it('非法/越界并发数被夹到 [1,16]（0 不能变成「什么都不做」）', async () => {
    const texts = Array.from({ length: 8 }, (_, i) => 'x' + String(i))
    for (const c of [0, -5, Number.NaN, 999]) {
      const { dec } = makeFixture(texts)
      const stub = trackingEmbed()
      const r = await buildVectorIndex(dec, stub.embed, { ...OPTS, concurrency: c as number })
      expect(r.embedded, 'concurrency=' + String(c)).toBe(8)
      // 越界值只能被**夹小**，不能变成「无 worker 静默不干活」
      expect(stub.maxInFlight(), 'concurrency=' + String(c)).toBeLessThanOrEqual(16)
    }
  })
})

describe('M10 向量建库：失败不半写', () => {
  it('某一批失败 → 抛错且整库回滚（不留半份索引），且没有未处理的拒绝', async () => {
    const texts = Array.from({ length: 20 }, (_, i) => 'doc' + String(i))
    const { dec } = makeFixture(texts)
    let n = 0
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown): void => { unhandled.push(e) }
    process.on('unhandledRejection', onUnhandled)
    const embed = async (ts: string[]): Promise<number[][]> => {
      n += 1
      if (n === 3) throw new Error('第 3 批炸了')
      await new Promise((r) => setTimeout(r, 5))
      return ts.map(() => [1, 0, 0, 0, 0, 0, 0, 0])
    }
    try {
      await expect(buildVectorIndex(dec, embed, { ...OPTS, batchSize: 2, concurrency: 3 }))
        .rejects.toThrow('第 3 批炸了')
      // 让在飞的请求有机会回来后尝试写库（回归点：写进已回滚/已关闭的连接会抛未处理拒绝）
      await new Promise((r) => setTimeout(r, 50))
      expect(unhandled).toEqual([])
      // 整库回滚：没有任何行，且状态仍未就绪（下次提问会重建）
      const db = new DatabaseSync(join(dec, '..', 'wechat_rag_vectors.db'), { readOnly: true })
      const c = (db.prepare('SELECT COUNT(*) AS c FROM vectors').get() as { c: number }).c
      db.close()
      expect(c).toBe(0)
      expect(vectorIndexStatus(dec).ready).toBe(false)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
