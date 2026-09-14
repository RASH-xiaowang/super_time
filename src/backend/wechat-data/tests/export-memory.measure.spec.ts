/**
 * H8 的内存峰值实测（默认跳过，靠环境变量开启）。
 *
 * 为什么门控：RSS 采样受 GC 时机与并行 worker 影响，在 CI 上会飘；
 * 但它正是这条改造的核心指标（验收标准要求「记录实测峰值」，而不是只声称变小了），
 * 因此保留为可手动执行的测量，结果记在 docs/RELEASE-PLAN.md。
 *
 * 运行：MEASURE_EXPORT_MEMORY=1 node node_modules/vitest/vitest.mjs run src/backend/wechat-data/tests/export-memory.measure.spec.ts
 * @vitest-environment node
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ZipFileWriter, zipFiles } from '../src/query/zip.ts'

const ENABLED = process.env.MEASURE_EXPORT_MEMORY === '1'
const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

/** 条目数与单条大小：默认 60 × 4MB = 240MB 输入，足以拉开两条路径的差距。 */
const ENTRY_COUNT = Number(process.env.MEASURE_ENTRIES ?? '60')
const ENTRY_BYTES = Number(process.env.MEASURE_ENTRY_BYTES ?? String(4 * 1024 * 1024))

/** 造一块**高熵**数据：压缩不了才反映真实导出的量级（聊天文本可压缩，媒体近似随机）。 */
function makePayload(seed: number, bytes: number): Buffer {
  const b = Buffer.allocUnsafe(bytes)
  let x = Math.imul(seed + 1, 2654435761) >>> 0
  for (let i = 0; i < bytes; i += 1) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    b[i] = (x >>> 16) & 0xff
  }
  return b
}

/** 采样 RSS 峰值，返回 stop() 与峰值读取。 */
function startRssSampler(): { stop: () => number } {
  const base = process.memoryUsage().rss
  let peak = base
  const t = setInterval(() => {
    const v = process.memoryUsage().rss
    if (v > peak) peak = v
  }, 20)
  if (t.unref) t.unref()
  return {
    stop: () => {
      clearInterval(t)
      const v = process.memoryUsage().rss
      if (v > peak) peak = v
      return peak - base
    },
  }
}

const MB = (n: number): string => (n / 1024 / 1024).toFixed(1) + 'MB'

describe.skipIf(!ENABLED)('导出内存峰值实测', () => {
  it('逐条目流式写盘的峰值增量显著低于「全部攒内存」', async () => {
    const totalInput = ENTRY_COUNT * ENTRY_BYTES

    // ── 老做法：所有条目先留在内存，再一次性 concat ──
    const before = startRssSampler()
    const entries: Array<{ name: string; data: Uint8Array }> = []
    for (let i = 0; i < ENTRY_COUNT; i += 1) entries.push({ name: 'e' + String(i) + '.bin', data: makePayload(i, ENTRY_BYTES) })
    const memory = zipFiles(entries)
    const memoryPeak = before.stop()
    entries.length = 0

    // ── 新做法：逐条目产出、写盘、即可被回收 ──
    const dir = mkdtempSync(join(tmpdir(), 'mem-'))
    scratch.push(dir)
    const p = join(dir, 'out.zip')
    const after = startRssSampler()
    const w = await ZipFileWriter.create(p)
    for (let i = 0; i < ENTRY_COUNT; i += 1) {
      await w.addFile('e' + String(i) + '.bin', makePayload(i, ENTRY_BYTES))
    }
    await w.close()
    const streamPeak = after.stop()

    console.log(`\n输入总量 ${MB(totalInput)}（${ENTRY_COUNT} × ${MB(ENTRY_BYTES)}）`)
    console.log(`  攒内存路径：RSS 峰值增量 ${MB(memoryPeak)}`)
    console.log(`  流式路径：  RSS 峰值增量 ${MB(streamPeak)}`)
    console.log(`  产物大小：内存路径 ${MB(memory.length)} / 流式路径 ${MB(statSync(p).size)}`)

    // 产物必须一致（不是「变小了但内容变了」）
    expect(statSync(p).size).toBe(memory.length)
    expect(readFileSync(p).equals(memory)).toBe(true)
    // 结构性断言（宽松）：流式路径不该按输入总量线性增长。
    expect(streamPeak).toBeLessThan(totalInput / 2)
  }, 300_000)
})
