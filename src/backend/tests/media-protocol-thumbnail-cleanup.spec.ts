/**
 * 缩略图落盘的失败路径必须回收 `.tmp`，否则取消/磁盘错误会持续污染 decoded 目录。
 *
 * @vitest-environment node
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  nativeImage: {
    createFromPath: () => ({
      isEmpty: () => false,
      resize: () => ({
        isEmpty: () => false,
        toJPEG: () => Buffer.from('thumbnail')
      })
    })
  }
}))

const require = createRequire(import.meta.url)
const nodeFs = require('node:fs') as typeof import('node:fs')
const { ensureThumb } = require('../media-protocol.js') as {
  ensureThumb: (abs: string, width: number) => string | null
}

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('ensureThumb 失败清理', () => {
  it('rename 失败会删除固定路径的临时文件并回退原图', () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-thumb-cleanup-'))
    scratch.push(root)
    const source = join(root, 'a.jpg')
    writeFileSync(source, 'source')
    const thumb = source + '.w320.jpg'
    const tmp = thumb + '.tmp'
    vi.spyOn(nodeFs, 'renameSync').mockImplementation(() => {
      throw new Error('rename failed')
    })

    expect(ensureThumb(source, 320)).toBeNull()
    expect(existsSync(tmp), '失败后不应留下半成品 .tmp').toBe(false)
    expect(existsSync(thumb)).toBe(false)
  })
})
