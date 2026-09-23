/**
 * N14：`vectorIndexStatus` 是**每次提问至少命中两次**的热路径
 * （`searchDense` 内 + `pipeline.ts:140`，另有 gateway 的建库前置判断），
 * 而改前每次都要「新开一个连接 + `SELECT COUNT(*) FROM vectors` + 4 次 meta 读」。
 * 本机实测（合成 13.5 万行）`COUNT(*)` 1.25ms、覆盖索引 1.07ms —— 一次提问付两遍。
 *
 * 改法（两条一起做，缺一条都不达标）：
 *   ① 行数与 `built_at` 同事务写进 meta ⇒ 读侧不必 COUNT(*)；
 *   ② 状态按文件指纹（`statSig`）缓存 ⇒ 一次提问的连接数从 2 降到 ≤1（命中缓存时是 0）。
 *
 * 本文件守四件事（都不依赖机器性能）：
 *   ① **差分等价** —— 把改前的实现整段重写成 oracle，逐个字段对照各种库形态
 *      （新库 / 老库无 `rows` 键 / meta 缺失 / vectors 表缺失 / 版本不符 / 空库），
 *      唯一有意分叉单列一条用例（见下）；
 *   ② **调用计数** —— 用 `vi.mock` 把 `DatabaseSync` 包一层，直接数「开连接」与「COUNT 语句」，
 *      而不是拿耗时当证据（耗时留在 `vector-status.measure.spec.ts` 里量）；
 *   ③ **缓存不会陈旧** —— 重建、以及**另一个连接**改库之后，状态必须跟着变；
 *   ④ **老库不被误伤** —— 缺 `rows` 键的库必须退回一次 COUNT（而不是被当成 0 行、关掉稠密通道），
 *      并且下一次构建会把它「治愈」成不再 COUNT。
 *
 * 为什么要数连接而不是只测耗时：验收标准写的就是「从 2 次连接 + 2 次 COUNT 降到 ≤1 次连接且无
 * COUNT」，计数是确定性的，耗时不是。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
// 只为类型注解（`vi.mock` 之下运行时拿到的是被包装过的类，见下方 mock 工厂）
import type { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildVectorIndex, vectorDbPath, vectorIndexStatus } from '../src/query/retrieval/embedding.ts'
// N26：临时目录与库连接统一交给共享助手 —— 它保证「先关连接、再删目录」，并且用例抛错也收尾。
import { createTempWorkspace, openTrackedDb } from '../../tests/helpers/temp-db.ts'
import type { TempWorkspace } from '../../tests/helpers/temp-db.ts'

/** 连接/COUNT 计数（`vi.mock` 工厂在 hoist 之后才跑，所以计数器本身要先 hoist）。 */
const probe = vi.hoisted(() => ({
  opens: [] as string[],
  counts: 0,
  reset(): void { this.opens.length = 0; this.counts = 0 },
}))

vi.mock('node:sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:sqlite')>()
  type RealDb = InstanceType<typeof actual.DatabaseSync>
  class CountingDatabaseSync extends actual.DatabaseSync {
    constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
      super(...args)
      probe.opens.push(String(args[0]))
    }
    // `prepare(sql)` 在 `node:sqlite` 里只有一个入参，原来的 `...rest` + `as any` 转调是多余的
    override prepare(sql: string): ReturnType<RealDb['prepare']> {
      // 只数 COUNT 族语句（改前的关键开销）；其它 SQL 不参与判据
      if (/count\s*\(/i.test(sql)) probe.counts += 1
      return super.prepare(sql)
    }
  }
  return { ...actual, DatabaseSync: CountingDatabaseSync }
})

const scratch: TempWorkspace[] = []
afterEach(async () => {
  const list = scratch.splice(0)
  for (const ws of list) {
    /**
     * N26：收尾交给共享助手（`../../tests/helpers/temp-db.ts`）—— 它先关闭**所有登记过的连接**
     * 再删目录，并对 `EPERM/EBUSY` 做有界退避重试。
     *
     * 原先这里是自己写的「重试 5 次 × 20ms 然后容忍失败」，注释里的诊断（node:sqlite 的
     * close_v2 语义、语句句柄要等 GC）经实测**不成立**：`close()` 会 finalize 语句，
     * 而只要有**一条连接没关**，`rmSync` 就确定性报 EPERM 且重试无效。本文件实测到的漏法
     * 就在下面的 `oracleStatus` 里（vectors 表缺失时走 catch 直接 return，`db.close()` 到不了），
     * 残留目录就是 `%TEMP%\wx-n14-11-*`。改用登记册后，漏掉的连接在收尾时仍会被关掉。
     */
    const r = await ws.cleanup()
    // 不再「容忍失败」：残留必须留下痕迹，否则下一个人还是只能靠翻 %TEMP% 发现问题
    if (!r.ok) console.warn(`[vector-status] 临时目录未能删除（${r.code}，试了 ${r.attempts} 次）：${ws.dir}`)
  }
})

let seq = 0
function tempRoot(): string {
  seq += 1
  const ws = createTempWorkspace('n14-' + String(seq))
  scratch.push(ws)
  return ws.dir
}

/** 造一个只有 message_meta 的稀疏索引 + 解密目录（与 M10/N8 的用例同一套夹具）。 */
function makeSearchFixture(texts: string[]): { dec: string; root: string } {
  const root = tempRoot()
  const dec = join(root, 'decrypted')
  mkdirSync(dec, { recursive: true })
  // N26：夹具连接也走登记册（照常显式 close；登记册兜住中途抛错）
  const db = openTrackedDb(join(root, 'wechat_search.db'))
  db.exec('CREATE TABLE message_meta (rowid INTEGER PRIMARY KEY, text TEXT, username TEXT, local_id INTEGER, create_time INTEGER)')
  const ins = db.prepare('INSERT INTO message_meta VALUES (?,?,?,?,?)')
  texts.forEach((t, i) => ins.run(i + 1, t, 'wxid_a', i + 1, 1700000000 + i))
  db.close()
  return { dec, root }
}

/** 直接写一个向量库文件（用于造老库/损坏等形态），返回解密目录。 */
function writeVectorsFile(root: string, init: {
  rows?: number
  meta?: Record<string, string>
  metaTable?: boolean
  vectorsTable?: boolean
}): string {
  const dec = join(root, 'decrypted')
  mkdirSync(dec, { recursive: true })
  // N26：走登记册开库（下面照常显式 close；登记册兜住「中途抛错跳过 close」的路径）
  const db = openTrackedDb(vectorDbPath(dec))
  if (init.metaTable !== false) db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  if (init.vectorsTable !== false) {
    db.exec('CREATE TABLE vectors (fts_rowid INTEGER PRIMARY KEY, doc_key TEXT NOT NULL, username TEXT NOT NULL, local_id INTEGER NOT NULL, create_time INTEGER NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL, hash_lo INTEGER NOT NULL, hash_hi INTEGER NOT NULL)')
    db.exec('CREATE INDEX idx_vectors_doc ON vectors(doc_key)')
  }
  for (const [k, v] of Object.entries(init.meta ?? {})) {
    db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(k, v)
  }
  const n = init.rows ?? 0
  if (init.vectorsTable !== false && n > 0) {
    const ins = db.prepare('INSERT INTO vectors VALUES (?,?,?,?,?,?,?,?,?)')
    for (let i = 0; i < n; i += 1) {
      ins.run(i + 1, 'wxid_a:' + String(i + 1), 'wxid_a', i + 1, 1700000000 + i, 4, new Uint8Array(16), 1, 2)
    }
  }
  db.close()
  return dec
}

interface Status {
  exists: boolean
  rows: number
  dim: number
  model: string
  built_at: string | null
  ready: boolean
}

/**
 * **改前实现**的 oracle（逐行照抄 N14 改动前的 `vectorIndexStatus`）。
 *
 * 刻意不复用被测代码的任何 helper：差分测试的 oracle 一旦与被测同源就不再能失败
 * （M9 的教训）。schema 版本这里写死 `'1'`（它就是改前比较的那个字面量）。
 * @param dec - 解密目录。
 * @returns 状态快照。
 */
function oracleStatus(dec: string): Status {
  const p = vectorDbPath(dec)
  if (!existsSync(p)) return { exists: false, rows: 0, dim: 0, model: '', built_at: null, ready: false }
  const readMeta = (db: InstanceType<typeof DatabaseSync>, key: string): string => {
    try {
      const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value?: string } | undefined
      return row?.value ?? ''
    } catch { return '' }
  }
  try {
    /**
     * N26：这条连接就是 %TEMP% 里 `wx-n14-11-*` 残留的来源 —— 「vectors 表缺失」那个形态下
     * 下面第一句 `prepare('SELECT COUNT(*) FROM vectors')` 会抛，直接落到 catch 返回，
     * 原来的 `db.close()`（在 try 尾部）根本执行不到，只读句柄就留在进程里。
     * Windows 上未关闭的句柄会让 `rmSync` 报 EPERM，**重试也救不回来**（实测）。
     * 改走登记册后，即使这条路径提前返回，收尾时也会被关掉。
     */
    const db = openTrackedDb(p, { readOnly: true })
    const rows = (db.prepare('SELECT COUNT(*) AS c FROM vectors').get() as { c: number }).c
    const dim = Number(readMeta(db, 'dim') || 0)
    const model = readMeta(db, 'model')
    const built = readMeta(db, 'built_at') || null
    const ver = readMeta(db, 'schema_version')
    db.close()
    return { exists: true, rows, dim, model, built_at: built, ready: rows > 0 && dim > 0 && ver === '1' }
  } catch {
    return { exists: true, rows: 0, dim: 0, model: '', built_at: null, ready: false }
  }
}

const OK_META = { schema_version: '1', dim: '8', model: 'stub', built_at: '2026-09-15 10:00:00', rows: '3' }

/**
 * 数一次「一次提问」里的状态查询：重置计数 → 连查 3 次（gateway + pipeline + searchDense）。
 * @param dec - 解密目录。
 * @returns 连接数/COUNT 数与三次结果。
 */
function askOnce(dec: string): { opens: number; counts: number; first: Status; second: Status; third: Status } {
  probe.reset()
  const first = vectorIndexStatus(dec) as Status
  const opensCold = probe.opens.length
  const second = vectorIndexStatus(dec) as Status
  const third = vectorIndexStatus(dec) as Status
  const out = { opens: probe.opens.length, counts: probe.counts, first, second, third }
  expect(opensCold, '冷路径开了不止一个连接').toBeLessThanOrEqual(1)
  return out
}

describe('N14：与改前实现逐字段等价（差分测试）', () => {
  it('各种库形态下 vectorIndexStatus 与 oracle 完全一致', () => {
    const cases: Array<{ name: string; dec: string }> = []
    // ① 文件不存在
    {
      const root = tempRoot()
      const dec = join(root, 'decrypted')
      mkdirSync(dec, { recursive: true })
      cases.push({ name: '文件不存在', dec })
    }
    // ② 新库（meta 里有 rows，dim/version 齐备 ⇒ ready）
    {
      const root = tempRoot()
      cases.push({ name: '新库·就绪', dec: writeVectorsFile(root, { rows: 3, meta: OK_META }) })
    }
    // ③ 老库（没有 rows 键 ⇒ 必须退回 COUNT，且不能被判成未就绪）
    {
      const root = tempRoot()
      const { rows: _r, ...legacy } = OK_META
      cases.push({ name: '老库·无 rows 键', dec: writeVectorsFile(root, { rows: 3, meta: legacy }) })
    }
    // ④ rows 值不可信（空串 / 空白 / 非数值）⇒ 同样退回 COUNT
    for (const [i, bad] of ['', '   ', 'abc'].entries()) {
      const root = tempRoot()
      cases.push({ name: `rows 值不可信(${i})`, dec: writeVectorsFile(root, { rows: 2, meta: { ...OK_META, rows: bad } }) })
    }
    // ⑤ 空库（0 行 ⇒ not ready）
    {
      const root = tempRoot()
      cases.push({ name: '空库', dec: writeVectorsFile(root, { rows: 0, meta: { ...OK_META, rows: '0' } }) })
    }
    // ⑥ schema 版本不符
    {
      const root = tempRoot()
      cases.push({ name: '版本不符', dec: writeVectorsFile(root, { rows: 3, meta: { ...OK_META, schema_version: '0' } }) })
    }
    // ⑦ dim 缺失
    {
      const root = tempRoot()
      cases.push({ name: 'dim 缺失', dec: writeVectorsFile(root, { rows: 3, meta: { ...OK_META, dim: '' } }) })
    }
    // ⑧ meta 表整个缺失（改前 readMeta 逐键兜底成空串、COUNT 仍然可用）
    {
      const root = tempRoot()
      cases.push({ name: 'meta 表缺失', dec: writeVectorsFile(root, { rows: 2, metaTable: false }) })
    }
    // ⑨ vectors 表整个缺失（改前 COUNT 抛错 ⇒ 落到 catch）
    {
      const root = tempRoot()
      cases.push({ name: 'vectors 表缺失', dec: writeVectorsFile(root, { meta: OK_META, vectorsTable: false }) })
    }

    for (const c of cases) {
      expect(vectorIndexStatus(c.dec), `${c.name}：与改前实现不一致`).toEqual(oracleStatus(c.dec))
    }
  })

  it('**有意分叉**：meta.rows 是权威（与 built_at 同事务写入），手工改坏的 meta 会被如实反映', () => {
    // 这条是唯一的差别：meta 说 0 行、表里却有 3 行时，新实现信 meta（rows=0 / not ready），
    // 改前实现信 COUNT（rows=3 / ready）。生产**不可达** —— rows 与 built_at 在同一个事务里写，
    // 不存在「写了一半」的中间态；真被手工改坏时方向也是安全的：状态判成未就绪 ⇒ 提问时触发
    // 一次构建 ⇒ 顺手写回真实行数。写成显式用例，免得「差分测试全绿」被读成「逐位一致」（同 M9）。
    const root = tempRoot()
    const dec = writeVectorsFile(root, { rows: 3, meta: { ...OK_META, rows: '0' } })
    expect(vectorIndexStatus(dec).rows).toBe(0)
    expect(vectorIndexStatus(dec).ready).toBe(false)
    expect(oracleStatus(dec).rows).toBe(3)
  })

  it('构建出来的库：新实现与 oracle 一致（rows 来自 meta 而不是 COUNT）', async () => {
    const { dec } = makeSearchFixture(['a', 'b', 'c', 'd'])
    await buildVectorIndex(dec, async (t) => t.map(() => [1, 0, 0, 0]), {
      model: 'stub', batchSize: 4, maxCharsPerDoc: 200, maxDocsPerBuild: 100,
    })
    expect(vectorIndexStatus(dec)).toEqual(oracleStatus(dec))
    expect(vectorIndexStatus(dec).rows).toBe(4)
    expect(vectorIndexStatus(dec).ready).toBe(true)
  })

  it('返回的是副本：调用方改自己拿到的对象不会污染缓存', async () => {
    const { dec } = makeSearchFixture(['a'])
    await buildVectorIndex(dec, async (t) => t.map(() => [1, 0]), {
      model: 'stub', batchSize: 1, maxCharsPerDoc: 200, maxDocsPerBuild: 10,
    })
    const first = vectorIndexStatus(dec)
    first.rows = 999
    first.ready = false
    const again = vectorIndexStatus(dec)
    expect(again.rows).toBe(1)
    expect(again.ready).toBe(true)
  })
})

describe('N14：一次提问的连接数与 COUNT 数', () => {
  it('新库：一次提问 ≤1 次连接、0 次 COUNT（改前是 3 次连接 + 3 次 COUNT）', async () => {
    const { dec } = makeSearchFixture(['a', 'b', 'c'])
    await buildVectorIndex(dec, async (t) => t.map(() => [1, 0, 0, 0]), {
      model: 'stub', batchSize: 3, maxCharsPerDoc: 200, maxDocsPerBuild: 100,
    })

    const r = askOnce(dec)
    expect(r.opens, `一次提问开了 ${r.opens} 个连接（验收要求 ≤1）`).toBeLessThanOrEqual(1)
    expect(r.counts, `一次提问做了 ${r.counts} 次 COUNT（验收要求 0 次）`).toBe(0)
    expect(r.first).toEqual(r.second)
    expect(r.second).toEqual(r.third)
    expect(r.first.rows).toBe(3)

    // 冷/热分离：第 2 次「提问」必须**完全不碰数据库**（缓存命中）
    const warm = askOnce(dec)
    expect(warm.opens, '缓存没命中：每次都要重开连接').toBe(0)
    expect(warm.counts).toBe(0)
  })

  it('老库（无 rows 键）：只付一次 COUNT，之后同样走缓存', () => {
    const root = tempRoot()
    const { rows: _r, ...legacy } = OK_META
    const dec = writeVectorsFile(root, { rows: 5, meta: legacy })

    const cold = askOnce(dec)
    expect(cold.counts, '老库首次判定必须现算 COUNT（否则会把有行的索引误判成未就绪）').toBe(1)
    expect(cold.opens).toBeLessThanOrEqual(1)
    expect(cold.first.rows).toBe(5)
    expect(cold.first.ready).toBe(true)

    const warm = askOnce(dec)
    expect(warm.opens, '老库第二次仍在开连接：缓存没生效').toBe(0)
    expect(warm.counts, '老库第二次仍在 COUNT').toBe(0)
  })

  it('老库被下一次构建「治愈」：补上 rows 之后不再 COUNT', async () => {
    // 老库（无 rows 键）只要版本/维度都对，状态就是「就绪」，gateway 不会去建库 —— 所以
    // 补键的时机是「下一次因为别的原因走进构建」（例如 force 或换了模型）。这里直接调构建。
    const { dec, root } = makeSearchFixture(['a', 'b', 'c'])
    const { rows: _r, ...legacy } = OK_META
    writeVectorsFile(root, { rows: 3, meta: legacy })
    expect(askOnce(dec).counts).toBe(1)

    const built = await buildVectorIndex(dec, async (t) => t.map(() => [1, 0, 0, 0]), {
      model: 'stub', batchSize: 3, maxCharsPerDoc: 200, maxDocsPerBuild: 100,
    })
    expect(built.status, '三行都已入库 ⇒ 走 up-to-date 分支').toBe('up-to-date')
    const after = askOnce(dec)
    expect(after.counts, 'up-to-date 分支没把 rows 写回 meta，于是状态查询还得永远 COUNT').toBe(0)
    expect(after.first.rows).toBe(3)
  })
})

describe('N14：缓存不得陈旧', () => {
  it('重建之后状态立刻跟上（rows/model 不会留在旧值）', async () => {
    const { dec } = makeSearchFixture(['a', 'b', 'c'])
    const embed = async (t: string[]): Promise<number[][]> => t.map(() => [1, 0, 0, 0])
    const opts = { model: 'stub', batchSize: 3, maxCharsPerDoc: 200, maxDocsPerBuild: 100 }
    await buildVectorIndex(dec, embed, { ...opts, maxDocsPerBuild: 2 })
    expect(vectorIndexStatus(dec).rows).toBe(2) // 先让缓存热起来

    const forced = await buildVectorIndex(dec, embed, { ...opts, model: 'stub2', force: true })
    expect(forced.status).toBe('ok')
    const st = vectorIndexStatus(dec)
    expect(st.rows, '重建后 rows 是旧值 —— 缓存没被失效').toBe(3)
    expect(st.model, '重建后 model 是旧值').toBe('stub2')
  })

  it('**另一个连接**改库（跨进程形态）之后状态也要跟着变', () => {
    const root = tempRoot()
    const dec = writeVectorsFile(root, { rows: 2, meta: { ...OK_META, rows: '2' } })
    expect(vectorIndexStatus(dec).rows).toBe(2) // 缓存热起来

    // 模拟另一个进程：直接往库里写行并同步更新 meta（文件必然变大 ⇒ 指纹必变）
    const db = openTrackedDb(vectorDbPath(dec))
    const ins = db.prepare('INSERT INTO vectors VALUES (?,?,?,?,?,?,?,?,?)')
    db.exec('BEGIN')
    for (let i = 0; i < 200; i += 1) {
      ins.run(1000 + i, 'wxid_b:' + String(i), 'wxid_b', i, 1700000000 + i, 8, new Uint8Array(1024), 3, 4)
    }
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('rows','202')").run()
    db.exec('COMMIT')
    db.close()

    expect(vectorIndexStatus(dec).rows, '外部改库没被看见：缓存成了永久快照').toBe(202)
  })
})

describe('N14：meta.rows 与表内容同事务落地（源码级）', () => {
  /** 取构建路径里的 `BEGIN`/`COMMIT`/`writeMeta(..., 'rows', ...)` 节点位置（用 AST，注释不算）。 */
  it('runBuildVectorIndex 的两条写入路径都写了 rows，且都落在事务区间内', () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'query', 'retrieval', 'embedding.ts')
    const src = readFileSync(file, 'utf8')
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

    let target: ts.Node | null = null
    const findFn = (node: ts.Node): void => {
      if (target) return
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'runBuildVectorIndex' && node.body) { target = node.body; return }
      node.forEachChild(findFn)
    }
    findFn(sf)
    expect(target, '找不到 runBuildVectorIndex 的函数体').toBeTruthy()

    const begins: number[] = []
    const commits: number[] = []
    const rowsWrites: number[] = []
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'exec') {
          const arg = node.arguments[0]
          if (arg && ts.isStringLiteralLike(arg)) {
            if (arg.text === 'BEGIN') begins.push(node.getStart(sf))
            if (arg.text === 'COMMIT') commits.push(node.getStart(sf))
          }
        }
        if (ts.isIdentifier(callee) && callee.text === 'writeMeta') {
          const key = node.arguments[1]
          if (key && ts.isStringLiteralLike(key) && key.text === 'rows') rowsWrites.push(node.getStart(sf))
        }
      }
      node.forEachChild(walk)
    }
    // 上面那句 toBeTruthy 只负责报「找不到函数体」，不改变类型；这里显式窄化，
    // 免得改名以后 walk(null) 抛一个看不出原因的 TypeError。
    if (target === null) throw new Error('没拿到函数体，walk 需要非空的 ts.Node')
    walk(target)

    // 防空转：两条写入路径（主事务 + up-to-date 的 meta 事务）都要被扫到
    expect(begins.length, `只扫到 ${begins.length} 处 BEGIN`).toBeGreaterThanOrEqual(2)
    expect(rowsWrites.length, '构建路径没有写 meta.rows —— 读侧就只能永远退回 COUNT').toBeGreaterThanOrEqual(2)
    const ranges = begins.map((b) => {
      const end = commits.find((c) => c > b)
      expect(end, 'BEGIN 之后没有 COMMIT').toBeTruthy()
      return [b, end as number] as [number, number]
    })
    for (const w of rowsWrites) {
      expect(ranges.some(([b, e]) => w > b && w < e), `writeMeta('rows')(${w}) 不在任何事务区间内`).toBe(true)
    }
  })
})
