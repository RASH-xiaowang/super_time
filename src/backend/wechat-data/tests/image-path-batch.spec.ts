/**
 * N16：图片路径的真杠杆 —— `lower(md5) = ?` 是**全表扫**。
 *
 * `EXPLAIN QUERY PLAN` = `SCAN image_hardlink_info_v4 USING INDEX ..._MODIFY_TIME`（走
 * modify_time 索引再逐行过滤）。实测本机真实表 3309 行 0.30ms/次、合成 20 万行 17.27ms/次
 * —— 30 张图各查一次 ≈518ms。`md5_hash` 列虽然**有索引**，但那个哈希算法推不出映射
 * （M11 试了 6 种推导、真实样本 0/8 命中），所以只能从「查询次数」上下手。
 *
 * 判据是**查询条数**（探针挂在 `DatabaseSync.prototype.prepare` 上）：这是「到底合并成
 * 一次没有」唯一不靠计时的判据 —— 计时在 CI 上会抖，而「30 张图查了几次」是确定的。
 *
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveImageFilePath, resolveImageFilePathsByMd5 } from '../src/query/media-image.ts'

const scratch: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

interface Fixture {
  root: string
  base: string
}

/**
 * 造一份最小 hardlink.db：`dir2id`（行号 → 目录名）与 `image_hardlink_info_v4`
 * （file_name / dir1 / dir2 / md5 / modify_time），并把 .dat 真写到候选路径上。
 * @param rows - 每行 `[md5, file_name, dir1Name, dir2Name, modifyTime]`。
 * @returns 解密根与「微信原始目录」。
 */
function makeFixture(rows: Array<[string, string, string, string, number]>): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'n16-hardlink-'))
  const base = mkdtempSync(join(tmpdir(), 'n16-base-'))
  scratch.push(root, base)
  mkdirSync(join(root, 'hardlink'), { recursive: true })
  const db = new DatabaseSync(join(root, 'hardlink', 'hardlink.db'))
  try {
    db.exec('CREATE TABLE dir2id (username TEXT)')
    const dirNames = [...new Set(rows.flatMap(([, , n1, n2]) => [n1, n2]))]
    const idOf = new Map<string, number>()
    for (const name of dirNames) {
      const info = db.prepare('INSERT INTO dir2id (username) VALUES (?)').run(name)
      idOf.set(name, Number(info.lastInsertRowid))
    }
    db.exec('CREATE TABLE image_hardlink_info_v4 (md5 TEXT, md5_hash TEXT, file_name TEXT, dir1 INTEGER, dir2 INTEGER, modify_time INTEGER)')
    const insert = db.prepare('INSERT INTO image_hardlink_info_v4 (md5, md5_hash, file_name, dir1, dir2, modify_time) VALUES (?,?,?,?,?,?)')
    for (const [md5, fileName, n1, n2, t] of rows) {
      insert.run(md5, 'hash-' + md5, fileName, idOf.get(n1)!, idOf.get(n2)!, t)
      const p = join(base, 'msg', 'attach', n1, n2, 'Img', fileName)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, 'dat')
    }
  } finally {
    db.close()
  }
  return { root, base }
}

const md5Of = (n: number): string => String(n).padStart(32, 'a')

describe('N16：一次查询解析多张图', () => {
  it('批量结果与逐张调用一致（含大小写归一与「行在、文件不在」）', () => {
    const md5A = 'AA'.repeat(16).toLowerCase()
    const md5B = 'bb'.repeat(16)
    const missing = 'cc'.repeat(16)
    const { root, base } = makeFixture([
      [md5A.toUpperCase(), 'a.dat', 'dirA', 'dirB', 100], // 库里存了大写
      [md5B, 'b.dat', 'dirC', 'dirD', 200],
      [missing, 'gone.dat', 'dirC', 'dirD', 300],
    ])
    // 第三行的文件删掉：行存在但磁盘上没有 → 必须落到「未命中」
    rmSync(join(base, 'msg', 'attach', 'dirC', 'dirD', 'Img', 'gone.dat'), { force: true })

    const batch = resolveImageFilePathsByMd5(root, base, [md5A, md5B.toUpperCase(), missing, 'not-an-md5'])
    expect([...batch.keys()].sort()).toEqual([md5A, md5B].sort())
    for (const md5 of [md5A, md5B, missing]) {
      expect(batch.get(md5) ?? null).toBe(resolveImageFilePath(root, base, md5))
    }
    expect(batch.get(md5A)).toContain('a.dat')
  })

  it('30 张图只查一次 `lower(md5) IN (...)`（逐张则是 30 次）', () => {
    const rows: Array<[string, string, string, string, number]> = []
    for (let i = 0; i < 30; i += 1) rows.push([md5Of(i), `f${i}.dat`, 'dirA', 'dirB', 1000 + i])
    const { root, base } = makeFixture(rows)
    const md5s = rows.map(([m]) => m)

    const spy = vi.spyOn(DatabaseSync.prototype, 'prepare')
    // 单条实现现在也走批量入口（单元素 IN），所以两类都算「按 md5 找行」的查询
    const md5Lookups = (): number => spy.mock.calls
      .map(([sql]) => String(sql))
      .filter(sql => sql.includes('lower(md5)')).length

    const batch = resolveImageFilePathsByMd5(root, base, md5s)
    expect(batch.size).toBe(30)
    const afterBatch = md5Lookups()
    expect(afterBatch, '批量入口没有合并成一次 IN 查询').toBe(1)

    for (const md5 of md5s) resolveImageFilePath(root, base, md5)
    expect(md5Lookups() - afterBatch, '逐张调用应该是一张一次').toBe(30)
  })

  it('data_index（rowid 提示）这条兜底路径没被批量改造弄丢', () => {
    const md5 = 'dd'.repeat(16)
    const { root, base } = makeFixture([[md5, 'only-by-rowid.dat', 'dirA', 'dirB', 100]])
    const db = new DatabaseSync(join(root, 'hardlink', 'hardlink.db'), { readOnly: true })
    let rowid = 0
    try {
      rowid = Number((db.prepare('SELECT _rowid_ AS r FROM image_hardlink_info_v4 LIMIT 1').get() as { r: number }).r)
    } finally {
      db.close()
    }
    // 没有 md5（只有 data_index）时也要能定位
    expect(resolveImageFilePath(root, base, undefined, String(rowid))).toContain('only-by-rowid.dat')
    expect(resolveImageFilePath(root, base, 'ee'.repeat(16), String(rowid))).toContain('only-by-rowid.dat')
  })

  it('库里没有这张图 → null（不是随便给个路径）', () => {
    const { root, base } = makeFixture([['ff'.repeat(16), 'x.dat', 'dirA', 'dirB', 1]])
    expect(resolveImageFilePathsByMd5(root, base, ['11'.repeat(16)]).size).toBe(0)
    expect(resolveImageFilePath(root, base, '11'.repeat(16))).toBeNull()
    // 重复项只查一次，不会因为去重丢结果
    expect(resolveImageFilePathsByMd5(root, base, ['ff'.repeat(16), 'ff'.repeat(16)]).get('ff'.repeat(16))).toContain('x.dat')
  })
})
