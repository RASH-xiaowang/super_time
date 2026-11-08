// @vitest-environment node
/**
 * 大文件内存写盘的进度与取消边界。
 *
 * `Readable.from([bytes])` 只产出一个块，取消检查要等整份文件已经同步写完才会执行；
 * 这里用多块 payload 钉住：写盘中途取消必须停止后续块、清掉临时文件，成功时最后一笔
 * 进度必须覆盖完整字节数。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeFileAtomicWithProgress } from '../src/query/export-io.ts'

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function outPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-export-io-'))
  scratch.push(dir)
  return join(dir, name)
}

describe('writeFileAtomicWithProgress', () => {
  it('分块写入完整字节并上报最终进度', async () => {
    const dest = outPath('ok.bin')
    const bytes = Buffer.alloc(800 * 1024 + 17, 9)
    const progress: Array<{ phase: string; done: number; total: number }> = []

    await writeFileAtomicWithProgress(dest, bytes, {
      onProgress: (p) => progress.push(p),
    })

    expect(readFileSync(dest).equals(bytes)).toBe(true)
    expect(progress.filter((p) => p.phase === 'write-bytes')).toContainEqual({
      phase: 'write-bytes',
      done: bytes.length,
      total: bytes.length,
    })
    expect(progress.filter((p) => p.phase === 'write-bytes').length).toBeGreaterThan(2)
  })

  it('写入中途取消会停止后续块并清理临时文件', async () => {
    const dest = outPath('cancel.bin')
    const bytes = Buffer.alloc(1024 * 1024, 11)
    const ac = new AbortController()
    let chunksSeen = 0

    await expect(writeFileAtomicWithProgress(dest, bytes, {
      signal: ac.signal,
      onProgress: (p) => {
        if (p.phase !== 'write-bytes' || p.done <= 0) return
        chunksSeen += 1
        ac.abort()
      },
    })).rejects.toThrow(/取消|cancel|abort/i)

    expect(chunksSeen).toBeGreaterThan(0)
    expect(existsSync(dest), '取消后不该出现最终文件').toBe(false)
    expect(readdirSync(join(dest, '..')).filter((name) => name.includes('.partial-'))).toEqual([])
  })
})
