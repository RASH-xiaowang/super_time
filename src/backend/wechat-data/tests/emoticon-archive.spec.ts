/**
 * 其他表情档案按 md5 去重，次数取较大值，原有 CDN 地址不被空值盖掉。
 * @vitest-environment node
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readArchivedOthers, upsertArchivedOthers } from '../src/query/emoticon-archive.ts'

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

describe('表情档案去重', () => {
  it('同一个 md5 只留一行，并保留已经拿到的 CDN 地址', () => {
    const decoded = mkdtempSync(join(tmpdir(), 'wx-emo-archive-'))
    scratch.push(decoded)
    upsertArchivedOthers(decoded, [
      { md5: 'aa', item_type: 0, caption: '2 次', cdnUrl: 'https://cdn.example/a' },
      { md5: 'AA', item_type: 0, caption: '9 次' },
      { md5: 'bb', item_type: 0, caption: '1 次', cdnUrl: 'https://cdn.example/b' },
    ])
    const rows = readArchivedOthers(decoded)
    expect(rows.map((row) => row.md5)).toEqual(['aa', 'bb'])
    expect(rows[0]?.caption).toBe('9 次')
    expect(rows[0]?.cdnUrl).toBe('https://cdn.example/a')
    expect(rows[1]?.cdnUrl).toBe('https://cdn.example/b')
  })
})
