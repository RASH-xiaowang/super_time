/**
 * W2-10.2 观测基线 · 头像「逐张 RPC」与「一次批量」的差距。**不是回归用例**，靠
 * `MEASURE_AVATAR_BATCH=1` 门控。
 *
 * ## 它要回答的问题
 *
 * 10.2 说「avatar/emoticon 逐张 RPC → 复用 image-batch 窗口（需新批量 Remote）」。
 * 查下来两件事都已经不是当初那个样子：
 *   · **emoticon 早就在攒批**了（E1, 2026-09-28：`emoticonQueue` → `getEmoticonDataUrls`）；
 *   · **批量的 avatar Remote 也早就有**（M23 的 `getAvatarsLocal`）。
 * 剩下没批的是**组件那一侧**：`Avatar` 缓存未命中时仍然一张一张发 `apiGetAvatar`。
 *
 * 所以先量：逐张 N 次 vs 批量 1 次，到底差多少。
 *
 * 运行：
 *   MEASURE_AVATAR_BATCH=1 node node_modules/vitest/vitest.mjs run src/backend/wechat-data/tests/avatar-batch-cost.measure.spec.ts
 *   规模用 AV_N（默认 200）。
 *
 * 档位：quick（登记在 `scripts/run-measures.mjs`；本行由 measures-registry 逐条核对，
 *   改了 runner 里的 tier 而不同步这里 ⇒ 红）。
 *   选档依据是**实测耗时**，不是「哪个更重要」：本条实测秒级（远低于单测时长，可进 PR 门禁）。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveAvatar, resolveAvatarsLocal } from '../src/query/avatar.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

/** 造一个 `head_image.db`（N 个头像，每人一段随机字节，模拟真机图片缓冲）。 */
function seedHeads(decrypted: string, n: number): string[] {
  const dir = join(decrypted, 'head_image')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'head_image.db'))
  db.exec('CREATE TABLE head_image (username TEXT, image_buffer BLOB, update_time INTEGER)')
  db.exec('BEGIN')
  const ins = db.prepare('INSERT INTO head_image (username, image_buffer, update_time) VALUES (?, ?, ?)')
  const names: string[] = []
  for (let i = 0; i < n; i += 1) {
    const u = 'wxid_avatar_' + String(i).padStart(5, '0')
    names.push(u)
    // PNG 魔数 + 512 字节噪声：够 `sniffImageFormat` 认出格式。
    const buf = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(512, i % 251)])
    ins.run(u, buf, 1700000000 + i)
  }
  db.exec('COMMIT')
  db.close()
  return names
}

describe.skipIf(process.env.MEASURE_AVATAR_BATCH !== '1')('W2：头像逐张 vs 批量', () => {
  it('量一次差距', { timeout: 300_000 }, () => {
    const N = Math.max(10, Number(process.env.AV_N ?? '200'))
    const root = mkdtempSync(join(tmpdir(), 'wx-avatar-bench-'))
    scratch.push(root)
    const decrypted = join(root, 'decrypted')
    mkdirSync(decrypted, { recursive: true })
    const names = seedHeads(decrypted, N)
    expect(names.length).toBe(N)

    const time = (fn: () => unknown): number => {
      const t = Number(process.hrtime.bigint()) / 1e6
      fn()
      return Number(process.hrtime.bigint()) / 1e6 - t
    }

    // 逐张：N 次（先跑一遍预热磁盘页缓存，再量 —— 否则量的是磁盘，不是这条路径）。
    for (const u of names) resolveAvatar(decrypted, u)
    const one = time(() => { for (const u of names) resolveAvatar(decrypted, u) })

    // 批量：1 次
    resolveAvatarsLocal(decrypted, names)
    const batch = time(() => { resolveAvatarsLocal(decrypted, names) })

    console.log([
      '',
      '[AVATAR-BATCH] 头像 ' + String(N) + ' 个（全部命中 head_image.db）',
      '  逐张 ' + String(N) + ' 次 getAvatar      : ' + one.toFixed(2) + 'ms（' + (one / N).toFixed(3) + 'ms/个）',
      '  批量 1 次 getAvatarsLocal  : ' + batch.toFixed(2) + 'ms',
      '  倍数                      : ' + (one / Math.max(batch, 0.001)).toFixed(1) + '×',
      '  一屏 200 个头像省下         : ' + (one - batch).toFixed(2) + 'ms + ' + String(N - 1) + ' 次 IPC 往返',
      '',
    ].join('\n'))

    // 命中数自检：两条路径都得拿满 N，否则下面的倍数没有意义。
    expect(Object.keys(resolveAvatarsLocal(decrypted, names)).length, '批量没拿满 ⇒ 夹具形状不对').toBe(N)
    expect(resolveAvatar(decrypted, names[0] ?? '').kind, '单张没命中 ⇒ 夹具形状不对').toBe('data')
    expect(batch).toBeGreaterThan(0)
  })
})