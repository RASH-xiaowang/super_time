/**
 * W1 观测基线 · SNS 取图「未命中」的真实成本（合成数据）。**不是回归用例**，靠 `MEASURE_SNS_MISS=1` 门控。
 *
 * ## 为什么需要它（它推翻了优化计划里的一条假设）
 *
 * 计划条目 4.1 原文写的是「`getSnsImageDataUrl` 未命中时会退化成对整个
 * `cache/<月>/Sns/Img` 乃至 `msg/attach` 做全量『读取 + AES 解密 + MD5』扫描，实测 12–21 秒」。
 * 那个数字是 **2026-09-29 性能修复之前**的：`sns-image.ts` 现在已经改成
 * 「按月增量索引 + 单次预算 40 个文件 + 进度跨调用累积」，旧的「未命中就全量重扫」分支
 * 只保留在 `indexDead`（索引指向的文件解不开）这一条路上（见该文件 2026-09-29 的实测修正注释）。
 *
 * 所以这里要量的不是「还差不差」，而是**新口径下未命中的成本落在哪**：
 *   ① 冷启动第一次调用的成本（此时索引是空的）；
 *   ② 索引推进期间每次调用的成本（预算 40 个/次）；
 *   ③ 索引扫完之后再未命中的成本（这才是稳态——绝大多数未命中都发生在这一步）；
 *   ④ 命中已入索引的文件时的成本（对照项）。
 * 这四个数决定「还要不要给 SNS 索引做后台预热」这类后续优化，而不是照着旧数字做。
 *
 * 2026-10-11 实跑一遍（`MEASURE_SNS_MISS=1`，N=600，21 个月目录）：
 *   冷启动第一次调用        24.2ms
 *   索引推进（预算 40/次）  0.1~0.2ms
 *   稳态未命中              0.2ms   ← 这就是计划里「12–21 秒」那个数字的**现口径**
 *   稳态命中                0.10~0.11ms
 * 整份基准 141ms。计划条目 4.2 的前提（未命中会退化成 12–21 秒全量扫描）**不成立**：
 * 那个量级属于 2026-09-29 修复之前的旧分支，现在只留在 `indexDead` 一条路上。
 * 所以 4.2 该结案的方式是「量完确认无需优化」，而不是照着旧数字去做优化。
 *
 * 运行：
 *   MEASURE_SNS_MISS=1 node node_modules/vitest/vitest.mjs run src/backend/wechat-data/tests/sns-miss-cost.measure.spec.ts
 *   文件数用 SNS_MISS_N 覆盖（默认 600）。
 *
 * 档位：quick（登记在 `scripts/run-measures.mjs`；本行由 measures-registry 逐条核对，
 *   改了 runner 里的 tier 而不同步这里 ⇒ 红）。
 *   选档依据是**实测耗时**，不是「哪个更重要」：本条实测秒级（远低于单测时长，可进 PR 门禁）。
 * @vitest-environment node
 */
import { createCipheriv, createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSnsImageDataUrl } from '../src/query/sns-image.ts'

const AES_KEY = '0123456789abcdef'
const XOR_KEY = 0x60
const JPEG_HEADER = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48])

/** 写一个 V2 加密块（与 sns-media.spec.ts 同款夹具：magic + aes size + xor size + AES 块）。 */
function writeV2(path: string, plaintext: Buffer): void {
  const padded = Buffer.concat([plaintext, Buffer.alloc(16, 0x10)])
  const cipher = createCipheriv('aes-128-ecb', AES_KEY, null)
  cipher.setAutoPadding(false)
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()])
  const buf = Buffer.alloc(15 + encrypted.length)
  buf.set(Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]), 0)
  buf.writeUInt32LE(plaintext.length, 6)
  buf.writeUInt32LE(0, 10)
  encrypted.copy(buf, 15)
  writeFileSync(path, buf)
}

/** 每个文件的明文必须唯一（否则第一个被解出的就命中，量到的是「缓存命中」而不是未命中成本）。 */
function uniqueJpeg(i: number): Buffer {
  return Buffer.concat([JPEG_HEADER, Buffer.from(String(i).padStart(16, '0'))])
}

describe.skipIf(process.env.MEASURE_SNS_MISS !== '1')('W1：SNS 取图未命中成本（合成数据）', () => {
  it('量冷启动 / 索引推进 / 稳态未命中 / 稳态命中四段成本', async () => {
    const N = Math.max(1, Number(process.env.SNS_MISS_N ?? '600'))
    const base = mkdtempSync(join(tmpdir(), 'wx-snsmiss-'))
    try {
      // 一个月、N 个文件，文件名与内容都随机 ⇒ 只能靠「解密算 md5」进索引。
      const monthRoot = join(base, 'cache', '2026-08', 'Sns', 'Img')
      const plaintextMd5s: string[] = []
      for (let i = 0; i < N; i += 1) {
        const name = createHash('md5').update('file-' + String(i)).digest('hex')
        const dir = join(monthRoot, name.slice(0, 2))
        mkdirSync(dir, { recursive: true })
        const jpeg = uniqueJpeg(i)
        writeV2(join(dir, name.slice(2)), jpeg)
        plaintextMd5s.push(createHash('md5').update(jpeg).digest('hex'))
      }
      const nobody = createHash('md5').update('definitely-not-here').digest('hex')

      const timed = async (fn: () => Promise<unknown>): Promise<number> => {
        const t0 = Number(process.hrtime.bigint()) / 1e6
        const r = await fn()
        const ms = Number(process.hrtime.bigint()) / 1e6 - t0
        expect(r, '返回值必须是对象').toBeTruthy()
        return ms
      }

      // ① 冷启动第一次（索引为空）：这次会把第一批 40 个文件解出来。
      const cold = await timed(() => resolveSnsImageDataUrl(base, AES_KEY, XOR_KEY, nobody))

      // ② 索引推进期：一直调到「未命中」的成本稳定下来（预算 40/次 ⇒ 约 N/40 次扫完）。
      const drain: number[] = []
      const calls = Math.ceil(N / 40) + 6
      for (let i = 0; i < calls; i += 1) {
        drain.push(await timed(() => resolveSnsImageDataUrl(base, AES_KEY, XOR_KEY, nobody)))
      }

      // ③ 稳态未命中（索引已扫完）：这才是绝大多数未命中的真实成本。
      const steadyMiss: number[] = []
      for (let i = 0; i < 8; i += 1) {
        steadyMiss.push(await timed(() => resolveSnsImageDataUrl(base, AES_KEY, XOR_KEY, nobody)))
      }

      // ④ 稳态命中（对照项）。
      const hit = await timed(() => resolveSnsImageDataUrl(base, AES_KEY, XOR_KEY, plaintextMd5s[0] ?? ''))
      // 索引完整性探针：查**最后一个**文件 —— 只有索引把 N 个都扫完了才命中。
      // 没有它，「推进期调用全是 0.1ms」可能被误读成「没在推进」，而真相需要这个读数才能分开。
      const lastMiss = await resolveSnsImageDataUrl(base, AES_KEY, XOR_KEY, plaintextMd5s[N - 1] ?? '')
      const indexComplete = typeof lastMiss.url === 'string' && lastMiss.url.length > 0

      const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1)
      const head = drain.slice(0, Math.min(5, drain.length))
      const tail = drain.slice(-5)
      console.log([
        '',
        `[SNS-MISS] 文件数 N=${N}，推进调用 ${String(calls)} 次`,
        `  ① 冷启动首次            ${cold.toFixed(1)}ms`,
        `  ② 推进期前 5 次均值      ${avg(head).toFixed(1)}ms（最慢 ${Math.max(...head).toFixed(1)}ms）`,
        `     推进期后 5 次均值      ${avg(tail).toFixed(1)}ms`,
        `     推进期合计            ${drain.reduce((a, b) => a + b, 0).toFixed(0)}ms`,
        `  ③ 稳态未命中均值        ${avg(steadyMiss).toFixed(2)}ms（${steadyMiss.length} 次）`,
        `  ④ 稳态命中（对照）      ${hit.toFixed(2)}ms`,
        `  索引完整性探针          ${indexComplete ? '已扫完全部 ' + String(N) + ' 个（推进期读数可信）' : '未扫完（推进期读数含义要重判）'}`,
        '',
      ].join('\n'))
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
