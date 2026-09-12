/**
 * Media assets over a minimal hardlink fixture: category counts and duplicates.
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { queryMediaAssets } from '../src/query/media-assets.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-media-'))
  scratch.push(dir)
  return dir
}

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try { create(db) } finally { db.close() }
}

describe('queryMediaAssets', () => {
  it('counts media categories and duplicate md5s', () => {
    const root = tempRoot()
    makeDb(join(root, 'hardlink', 'hardlink.db'), (db) => {
      db.exec('CREATE TABLE image_hardlink_info_v4 (file_name TEXT, md5 TEXT, file_size INTEGER)')
      db.prepare('INSERT INTO image_hardlink_info_v4 VALUES (?, ?, ?)').run('a.png', 'dup1', 100)
      db.prepare('INSERT INTO image_hardlink_info_v4 VALUES (?, ?, ?)').run('b.png', 'dup1', 100)
      db.prepare('INSERT INTO image_hardlink_info_v4 VALUES (?, ?, ?)').run('c.png', 'unique', 50)
      db.exec('CREATE TABLE file_hardlink_info_v4 (file_name TEXT, md5 TEXT, file_size INTEGER)')
      db.prepare('INSERT INTO file_hardlink_info_v4 VALUES (?, ?, ?)').run('doc.pdf', 'f1', 200)
    })

    const snap = queryMediaAssets(root)
    expect(snap.categories.find(c => c.category === '图片')?.count).toBe(3)
    expect(snap.categories.find(c => c.category === '文件')?.count).toBe(1)
    expect(snap.totalFiles).toBe(4)
    expect(snap.totalBytes).toBe(450)
    expect(snap.duplicates.find(d => d.md5 === 'dup1')?.count).toBe(2)
    expect(snap.duplicates.find(d => d.md5 === 'dup1')?.size).toBe(200)
    expect(snap.duplicates.find(d => d.md5 === 'dup1')?.reclaimBytes).toBe(100)
    expect(snap.duplicateFiles).toBe(2)
    expect(snap.reclaimBytes).toBe(100)
  })
})
