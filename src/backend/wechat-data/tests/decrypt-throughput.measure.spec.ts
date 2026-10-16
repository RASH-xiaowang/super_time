/**
 * W1 观测基线 · SQLCipher 全量解密吞吐：串行 vs 并发（合成数据）。**不是回归用例**，靠 `MEASURE_DECRYPT=1` 门控。
 *
 * ## 它要证伪/证实的计划假设
 *
 * 计划条目 2.1 写的是「全量解密并发化（有界 2–4 库），预期 message_1 ≈147MB 解密墙钟下降 30–50%」。
 * 这个预期有一个**没被检查的前提**：后端 worker 是**单线程**的，而 `fullDecryptFile` 的解密循环
 * 是同步 CPU 段（每 64 页让出一次，见 `sync.ts` 的 `setImmediate`）。如果解密是 CPU 主导的，
 * 那么并发多个库只会让让出更频繁，**总墙钟不会下降**——所谓「提速」可能根本不存在。
 *
 * 这里用合成加密库把两件事量出来：
 *   ① 单库解密吞吐（页/秒、MB/秒）——用于把合成数外推到真实库的规模；
 *   ② 同批数据库「串行」与「Promise.all 并发」的总墙钟 —— 直接判定 2.1 值不值得做。
 * 顺带量 PBKDF2（每库一次的固定成本，代码注释记 ~70ms/库）。
 *
 * 运行：
 *   MEASURE_DECRYPT=1 node node_modules/vitest/vitest.mjs run src/backend/wechat-data/tests/decrypt-throughput.measure.spec.ts
 *   库数 DECRYPT_DBS（默认 4）/ 每库页数 DECRYPT_PAGES（默认 1500，≈6MB/库）。
 *
 * 档位：quick（登记在 `scripts/run-measures.mjs`；本行由 measures-registry 逐条核对，
 *   改了 runner 里的 tier 而不同步这里 ⇒ 红）。
 *   选档依据是**实测耗时**，不是「哪个更重要」：本条实测秒级（远低于单测时长，可进 PR 门禁）。
 * @vitest-environment node
 */
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fullDecryptFile, looksDecrypted, plausibleSqliteHeader } from '../src/query/sync.ts'

const PAGE_SZ = 4096
const IV_SZ = 16
const RESERVE_SZ = 80
const SALT_SZ = 16
const SQLITE_HDR = Buffer.from('SQLite format 3\x00')
const PBKDF2_ITERS = 256000

/** 一个「像真库」的明文页 1（头部字段必须过 plausibleSqliteHeader）。 */
function plainPage1(): Buffer {
  const p = Buffer.alloc(PAGE_SZ)
  SQLITE_HDR.copy(p, 0)
  p.writeUInt16BE(PAGE_SZ, 16)
  p[18] = 1
  p[19] = 1
  p[21] = 64
  p[22] = 32
  p[23] = 32
  for (let i = 24; i < PAGE_SZ; i += 1) p[i] = (i * 31) & 0xff
  return p
}

/** 其余明文页：内容无所谓（解密只关心结构），用便宜的可复现图案填充。 */
function plainPage(pgno: number): Buffer {
  const p = Buffer.alloc(PAGE_SZ)
  for (let i = 0; i < PAGE_SZ; i += 1) p[i] = (i + pgno) & 0xff
  return p
}

/** 把一个明文库按 st_control 的页布局加密成磁盘镜像。 */
function encryptDb(path: string, rawKey: Buffer, pages: number): Buffer {
  const salt = randomBytes(SALT_SZ)
  const encKey = pbkdf2Sync(rawKey, salt, PBKDF2_ITERS, 32, 'sha512')
  const out = Buffer.alloc(PAGE_SZ * pages)
  for (let pgno = 1; pgno <= pages; pgno += 1) {
    const plain = pgno === 1 ? plainPage1() : plainPage(pgno)
    const payload = pgno === 1 ? plain.subarray(SALT_SZ, PAGE_SZ - RESERVE_SZ) : plain.subarray(0, PAGE_SZ - RESERVE_SZ)
    const iv = randomBytes(IV_SZ)
    const cipher = createCipheriv('aes-256-cbc', encKey, iv)
    cipher.setAutoPadding(false)
    const ct = Buffer.concat([cipher.update(payload), cipher.final()])
    const page = Buffer.alloc(PAGE_SZ)
    if (pgno === 1) salt.copy(page, 0)
    ct.copy(page, pgno === 1 ? SALT_SZ : 0)
    iv.copy(page, PAGE_SZ - RESERVE_SZ)
    page.copy(out, (pgno - 1) * PAGE_SZ)
  }
  writeFileSync(path, out)
  // 自校验：夹具必须是「生产解密器能解、且解出来过得了他自己的头判据」。
  const probe = join(path + '.probe')
  const n = fullDecryptFileSync(path, probe, encKey)
  if (n !== pages) throw new Error('夹具自校验失败：解出的页数不对')
  if (!looksDecrypted(probe)) throw new Error('夹具自校验失败：头部不像真库')
  rmSync(probe, { force: true })
  return salt
}

/** 同步版解密（只给夹具自校验用；被测路径一律走生产的 async fullDecryptFile）。 */
function fullDecryptFileSync(src: string, dst: string, encKey: Buffer): number {
  const raw = readFileSync(src)
  const chunks: Buffer[] = []
  for (let pgno = 1; pgno <= raw.length / PAGE_SZ; pgno += 1) {
    const page = raw.subarray((pgno - 1) * PAGE_SZ, pgno * PAGE_SZ)
    const iv = page.subarray(PAGE_SZ - RESERVE_SZ, PAGE_SZ - RESERVE_SZ + IV_SZ)
    const payload = pgno === 1 ? page.subarray(SALT_SZ, PAGE_SZ - RESERVE_SZ) : page.subarray(0, PAGE_SZ - RESERVE_SZ)
    const d = createDecipheriv('aes-256-cbc', encKey, iv)
    d.setAutoPadding(false)
    const dec = Buffer.concat([d.update(payload), d.final()])
    const out = Buffer.alloc(PAGE_SZ)
    if (pgno === 1) SQLITE_HDR.copy(out, 0)
    dec.copy(out, pgno === 1 ? SQLITE_HDR.length : 0)
    chunks.push(out)
  }
  writeFileSync(dst, Buffer.concat(chunks))
  return chunks.length
}

describe.skipIf(process.env.MEASURE_DECRYPT !== '1')('W1：全量解密吞吐 串行 vs 并发（合成数据）', () => {
  it('判定「并发解密」到底有没有墙钟收益', { timeout: 300_000 }, async () => {
    const DBS = Math.max(1, Number(process.env.DECRYPT_DBS ?? '4'))
    const PAGES = Math.max(1, Number(process.env.DECRYPT_PAGES ?? '1500'))
    const base = mkdtempSync(join(tmpdir(), 'wx-decrypt-'))
    try {
      mkdirSync(base, { recursive: true })
      const rawKey = randomBytes(32)
      const salts: Buffer[] = []
      for (let i = 0; i < DBS; i += 1) {
        salts.push(encryptDb(join(base, 'db' + String(i) + '.db'), rawKey, PAGES))
      }
      // 夹具自带的 header 判据要单独确认一次（被测函数 output 由它校验）。
      expect(plausibleSqliteHeader(plainPage1().subarray(0, 24)), '页 1 前 24 字节要过判据').toBe(true)

      const deriveMs = (() => {
        const t0 = Number(process.hrtime.bigint()) / 1e6
        pbkdf2Sync(rawKey, salts[0] ?? Buffer.alloc(16), PBKDF2_ITERS, 32, 'sha512')
        return Number(process.hrtime.bigint()) / 1e6 - t0
      })()

      const run = async (conc: number): Promise<number> => {
        const t0 = Number(process.hrtime.bigint()) / 1e6
        let next = 0
        const workers: Array<Promise<void>> = []
        for (let w = 0; w < Math.min(conc, DBS); w += 1) {
          workers.push((async () => {
            for (;;) {
              const i = next
              next += 1
              if (i >= DBS) return
              const encKey = pbkdf2Sync(rawKey, salts[i] ?? Buffer.alloc(16), PBKDF2_ITERS, 32, 'sha512')
              const pages = await fullDecryptFile(join(base, 'db' + String(i) + '.db'), join(base, `out${String(i)}-${String(conc)}.db`), encKey)
              if (pages !== PAGES) throw new Error('解密出的页数不对')
              if (!looksDecrypted(join(base, `out${String(i)}-${String(conc)}.db`))) throw new Error('头部判据不过')
            }
          })())
        }
        await Promise.all(workers)
        return Number(process.hrtime.bigint()) / 1e6 - t0
      }

      const serial = await run(1)
      const parallel = await run(DBS)
      const mbTotal = (DBS * PAGES * PAGE_SZ) / (1024 * 1024)

      console.log([
        '',
        `[DECRYPT] ${String(DBS)} 库 × ${String(PAGES)} 页（合计 ${mbTotal.toFixed(1)}MB）`,
        `  PBKDF2 每库一次     ${deriveMs.toFixed(1)}ms ⇒ ${String(DBS)} 库固定成本 ${(deriveMs * DBS / 1000).toFixed(2)}s`,
        `  串行(conc=1)        ${serial.toFixed(0)}ms ⇒ ${(mbTotal / (serial / 1000)).toFixed(1)}MB/s`,
        `  并发(conc=${String(DBS)})      ${parallel.toFixed(0)}ms ⇒ ${(mbTotal / (parallel / 1000)).toFixed(1)}MB/s`,
        `  并发/串行           ${(parallel / serial).toFixed(2)}（<1 才是提速；≈1 说明 CPU 主导、并发无收益）`,
        '',
      ].join('\n'))
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
