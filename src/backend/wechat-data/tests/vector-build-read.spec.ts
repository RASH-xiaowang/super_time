/**
 * N8：向量索引构建的**读取侧**不得全表物化。
 *
 * 改前（`embedding.ts` 的构建入口）是：
 *   `SELECT … FROM message_meta ORDER BY rowid` → `.all()`（整张表进数组）
 *   → `filter(done)` → `slice(0, maxDocsPerBuild)`
 * 即：物化发生在**截断之前**。实测 20 万行 / 单条 478 字符：**1876ms、RSS 峰值 +271.7MB**，
 * 而真正要用的只有前几万条。现在改成游标边读边判，读到够数就 `break`。
 *
 * 本文件守两件事（都不依赖机器性能）：
 *   ① **命中集合不变** —— 与「改前算法」的 oracle 逐项对照（差分测试）；
 *   ② **行的截断语义**（含把非法上限归一成 0 这一步有意分叉）。
 * 「RSS 峰值」那类机器相关的数字在 `vector-build-read.measure.spec.ts`（默认跳过）里量。
 *
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'

import { buildVectorIndex } from '../src/query/retrieval/embedding.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

function makeFixture(texts: string[]): { dec: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'wx-n8-'))
  scratch.push(root)
  const dec = join(root, 'decrypted')
  mkdirSync(dec, { recursive: true })
  const db = new DatabaseSync(join(root, 'wechat_search.db'))
  db.exec('CREATE TABLE message_meta (rowid INTEGER PRIMARY KEY, text TEXT, username TEXT, local_id INTEGER, create_time INTEGER)')
  const ins = db.prepare('INSERT INTO message_meta VALUES (?,?,?,?,?)')
  texts.forEach((t, i) => ins.run(i + 1, t, 'wxid_a', i + 1, 1700000000 + i))
  db.close()
  return { dec, root }
}

/** 读向量库里的 fts_rowid 集合（升序）。 */
function vectorRowIds(dec: string): number[] {
  const db = new DatabaseSync(join(dirname(dec), 'wechat_rag_vectors.db'), { readOnly: true })
  const rows = (db.prepare('SELECT fts_rowid FROM vectors ORDER BY fts_rowid').all() as Array<{ fts_rowid: number }>)
    .map((r) => Number(r.fts_rowid))
  db.close()
  return rows
}

/**
 * 「改前算法」的 oracle：整表读出 → 过滤已有 → 截断前 n 条。
 *
 * 刻意**不复用**被测代码的任何 helper —— 差分测试的 oracle 一旦与被测同源就不再能失败
 * （M9 的教训：`popcount32` 必须独立对照）。
 * @param dec - 解密目录。
 * @param cap - 单次上限。
 * @returns 应当被算向量的 rowid（升序）。
 */
function oraclePending(dec: string, cap: number): number[] {
  const db = new DatabaseSync(join(dirname(dec), 'wechat_search.db'), { readOnly: true })
  const all = (db.prepare('SELECT rowid AS rid FROM message_meta ORDER BY rowid').all() as Array<{ rid: number }>)
    .map((r) => Number(r.rid))
  db.close()
  const doneSet = new Set<number>()
  const vectorsFile = join(dirname(dec), 'wechat_rag_vectors.db')
  // 向量库可能还不存在（首轮构建前）：此时视为「没有任何已入库行」
  if (existsSync(vectorsFile)) {
    const vdb = new DatabaseSync(vectorsFile, { readOnly: true })
    try {
      for (const r of vdb.prepare('SELECT fts_rowid FROM vectors').all() as Array<{ fts_rowid: number }>) {
        doneSet.add(Number(r.fts_rowid))
      }
    } catch { /* 表还没建：同样视为空 */ }
    vdb.close()
  }
  return all.filter((rid) => !doneSet.has(rid)).slice(0, cap)
}

const OPTS = { model: 'stub', batchSize: 128, maxCharsPerDoc: 200, maxDocsPerBuild: 1000 }

describe('N8：游标读取的截断语义与命中集合', () => {
  it('按 rowid 顺序取前 cap 条待处理行，与改前算法的 oracle 一致', async () => {
    const texts = Array.from({ length: 40 }, (_, i) => '文本 ' + String(i))
    const { dec } = makeFixture(texts)

    const first = await buildVectorIndex(dec, async (t) => t.map(() => [1, 0, 0, 0]), { ...OPTS, maxDocsPerBuild: 7 })
    expect(first.status).toBe('ok')
    expect(first.embedded, '上限 7 就该只处理 7 行').toBe(7)
    expect(vectorRowIds(dec)).toEqual([1, 2, 3, 4, 5, 6, 7])

    // 再来一轮：应当在**已有**基础上继续取接下来的 cap 条（而不是从头重算）
    const second = await buildVectorIndex(dec, async (t) => t.map(() => [1, 0, 0, 0]), { ...OPTS, maxDocsPerBuild: 5 })
    expect(second.embedded).toBe(5)
    expect(vectorRowIds(dec)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  it('cap 足够大时一次补齐全部行（命中集合与 oracle 相同）', async () => {
    const texts = Array.from({ length: 25 }, (_, i) => '行 ' + String(i))
    const { dec } = makeFixture(texts)
    const expect_ = oraclePending(dec, 1000)
    const r = await buildVectorIndex(dec, async (t) => t.map(() => [0, 1, 0, 0]), { ...OPTS, maxDocsPerBuild: 1000 })
    expect(r.status).toBe('ok')
    expect(r.embedded).toBe(25)
    expect(vectorRowIds(dec)).toEqual(expect_)
    expect(vectorRowIds(dec)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1))
  })

  it('非法上限（0 / NaN / 负数）一律按 0 处理：不构建、报 up-to-date', async () => {
    const { dec } = makeFixture(['a', 'b', 'c'])
    for (const bad of [0, Number.NaN, -5]) {
      const r = await buildVectorIndex(dec, async (t) => t.map(() => [1, 0]), { ...OPTS, maxDocsPerBuild: bad })
      expect(r.status, `maxDocsPerBuild=${String(bad)} 不该走构建`).toBe('up-to-date')
      expect(r.embedded).toBe(0)
    }
    expect(vectorRowIds(dec)).toEqual([])
    // 说明：改前对负数会走 `slice(0, -5)`（去掉末尾 5 条）这种笔误语义；现在按 0 收口（有意分叉）
  })

  it('增量：已入库的行不会被重算（done 集合仍然生效）', async () => {
    const texts = ['a', 'b', 'c', 'd']
    const { dec } = makeFixture(texts)
    await buildVectorIndex(dec, async (t) => t.map(() => [1, 0]), { ...OPTS, maxDocsPerBuild: 2 })
    let calls = 0
    const r = await buildVectorIndex(dec, async (t) => { calls += 1; return t.map(() => [1, 0]) }, { ...OPTS, maxDocsPerBuild: 10 })
    expect(r.embedded, '第二轮只该补剩下的 2 行').toBe(2)
    expect(calls).toBe(1)
    expect(vectorRowIds(dec)).toEqual([1, 2, 3, 4])
  })
})

describe('N8：读取侧的结构守卫（源码级）', () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'query', 'retrieval', 'embedding.ts')

  it('构建函数体内没有 .all()，且对 message_meta 用的是游标', () => {
    const src = readFileSync(file, 'utf8')
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    // 取 runBuildVectorIndex 的函数体（用 AST，注释里写「.all()」不算）
    let target: ts.Node | null = null
    const findFn = (node: ts.Node): void => {
      if (target) return
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'runBuildVectorIndex' && node.body) {
        target = node.body
        return
      }
      node.forEachChild(findFn)
    }
    findFn(sf)
    expect(target, '找不到 runBuildVectorIndex 的函数体').toBeTruthy()

    const allCalls: string[] = []
    const iterateCalls: string[] = []
    const sqlTexts: string[] = []
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if (ts.isPropertyAccessExpression(node.expression)) {
          const method = node.expression.name.text
          // 只关心**语句**上的 .all()（`db.prepare(...).all()`），别把 `Promise.all` 也算进来
          const isStmtAll = method === 'all' && /\.prepare\(/.test(node.expression.getText(sf))
          if (isStmtAll) allCalls.push(node.getText(sf).slice(0, 120))
          if (method === 'iterate') iterateCalls.push(node.getText(sf).slice(0, 120))
        }
        const arg = node.arguments[0]
        if (arg && ts.isStringLiteralLike(arg) && arg.text.includes('message_meta')) sqlTexts.push(arg.text.slice(0, 60))
      }
      // 变量形式的 SQL（`const sql = '…message_meta…'`，含字符串拼接）也收进来
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const text = node.initializer.getText(sf)
        if (text.includes('message_meta')) sqlTexts.push(text.slice(0, 400))
      }
      node.forEachChild(walk)
    }
    walk(target as ts.Node)

    expect(allCalls, `构建路径里仍有 .all()（全表物化）：${allCalls.join(' | ')}`).toEqual([])
    expect(iterateCalls.length, '构建路径里没有游标读取（解析可能失效）').toBeGreaterThan(0)
    expect(sqlTexts.join(' | '), '没有读到 message_meta 的 SQL（守卫可能已失效）').toContain('message_meta')
    expect(src.slice(src.indexOf('const sql = '), src.indexOf('const sql = ') + 400), '游标循环里没有 break').toContain('break')
  })
})
