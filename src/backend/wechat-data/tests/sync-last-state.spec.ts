/**
 * 发布失败**不许记账**：一次失败的整库重解必须能在下一拍重试，而不是被
 * 「签名没变 + 目标存在」永久跳过。
 *
 * 旧实现（2026-11-16 之前的 `sync.ts`）在动手前就 `lastState.set(f, sig)`，
 * 失败那条路又保留签名 ⇒ 退避到期后仍命中「签名没变 + 目标存在」提前 return；
 * 同一份新数据再也进不来，且下一轮 WAL 补丁会打在没换代成功的旧主库上。
 *
 * 用例用真 SQLite + 真 SQLCipher 布局（与 `db-integrity-repair.spec.ts` 同一夹具口径），
 * 在目标快照被读连接占用时让 `atomicReplace` 的 8 次重试全部失败，再释放读连接重跑，
 * 断言第二次真的发布成功、且读得到新增的行。
 * @vitest-environment node
 */
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { forgetFullDecryptCooldown, syncChangedShards } from '../src/query/sync.ts'
import { forgetSyncFailures } from '../src/query/sync-pacing.ts'
import { statSigStr } from '../src/query/sync-signatures.ts'

const PAGE_SZ = 4096
const SALT_SZ = 16
const RESERVE_SZ = 80
const RAW_KEY_HEX = '4304020f3020400d967181c0f2f68a45ae9eb6e806f442a2a96c470e7fb62e34'
const SHARD = 'message_0.db'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  forgetSyncFailures()
  forgetFullDecryptCooldown()
})

/** 与 `db-integrity-repair.spec.ts` 同口径：把普通库改成 reserved=80 的真机形状。 */
function toReservedLayout(plain: Buffer): Buffer {
  const buf = Buffer.from(plain)
  buf[20] = 80
  for (let base = 0; base + PAGE_SZ <= buf.length; base += PAGE_SZ) {
    const hdr = base + (base === 0 ? 100 : 0)
    const nCells = buf.readUInt16BE(hdr + 3)
    const cs = buf.readUInt16BE(hdr + 5)
    if (cs === 0) continue
    const ptr = hdr + 8
    for (let i = 0; i < nCells; i += 1) {
      buf.writeUInt16BE(buf.readUInt16BE(ptr + i * 2) - RESERVE_SZ, ptr + i * 2)
    }
    buf.writeUInt16BE(cs - RESERVE_SZ, hdr + 5)
    buf.copy(buf, base + cs - RESERVE_SZ, base + cs, base + PAGE_SZ)
    buf.fill(0, base + PAGE_SZ - RESERVE_SZ, base + PAGE_SZ)
  }
  return buf
}

/** 按 SQLCipher-4 布局加密一个真库（布局与 `sync.ts#decryptPage` 逐字段对齐）。 */
function encryptSqliteFile(plain: Buffer): Buffer {
  const pages = Math.ceil(plain.length / PAGE_SZ)
  const out = Buffer.alloc(pages * PAGE_SZ)
  plain.copy(out, 0)
  const salt = randomBytes(SALT_SZ)
  salt.copy(out, 0)
  const encKey = pbkdf2Sync(Buffer.from(RAW_KEY_HEX, 'hex'), salt, 256000, 32, 'sha512')
  for (let pgno = 1; pgno <= pages; pgno += 1) {
    const base = (pgno - 1) * PAGE_SZ
    const iv = randomBytes(16)
    const from = base + (pgno === 1 ? SALT_SZ : 0)
    const to = base + PAGE_SZ - RESERVE_SZ
    const cipher = createCipheriv('aes-256-cbc', encKey, iv)
    cipher.setAutoPadding(false)
    const enc = Buffer.concat([cipher.update(out.subarray(from, to)), cipher.final()])
    out.subarray(from, to).set(enc)
    out.set(iv, to)
  }
  return out
}

interface Fixture {
  root: string
  rawDbDir: string
  decryptedDir: string
  rawFile: string
  decFile: string
}

/** 造一个数据根：raw 侧 `message/message_0.db` 是真库的加密副本，config.json 在 decrypted 的父目录。 */
function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'wx-sync-state-'))
  scratch.push(root)
  const rawDbDir = join(root, 'db_storage')
  const decryptedDir = join(root, 'decrypted')
  mkdirSync(join(rawDbDir, 'message'), { recursive: true })
  mkdirSync(decryptedDir, { recursive: true })
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    db_dir: rawDbDir, db_enc_key: RAW_KEY_HEX, key_format: 'wx_key_v4.1',
  }))
  const rawFile = join(rawDbDir, 'message', SHARD)
  writeRawShard(root, rawFile, 5)
  return { root, rawDbDir, decryptedDir, rawFile, decFile: join(decryptedDir, 'message', SHARD) }
}

/** 用真 SQLite 建 `rows` 行再加密成 raw 分片（每次重写整个文件，salt 也换新）。 */
function writeRawShard(root: string, rawFile: string, rows: number): void {
  const plainPath = join(root, 'plain.db')
  rmSync(plainPath, { force: true })
  const db = new DatabaseSync(plainPath)
  try {
    db.exec('CREATE TABLE Msg_wxid_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa (create_time INTEGER, local_type INTEGER, message_content TEXT)')
    const ins = db.prepare('INSERT INTO Msg_wxid_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa VALUES (?, ?, ?)')
    for (let i = 0; i < rows; i += 1) ins.run(1700000000 + i, 1, `消息 ${i}`)
  } finally {
    db.close()
  }
  mkdirSync(dirname(rawFile), { recursive: true })
  writeFileSync(rawFile, encryptSqliteFile(toReservedLayout(readFileSync(plainPath))))
}

/** 读快照里的消息行数（同时证明它不是 malformed）。 */
function rowCount(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM Msg_wxid_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').get() as { n: number }
    return Number(row.n)
  } finally {
    db.close()
  }
}

describe('同步状态只在发布成功后记账', () => {
  it('发布被读者挡住 ⇒ 不记账；释放后下一拍重试并读到新行', async () => {
    const f = makeFixture()
    const state = new Map<string, { main: string; wal: string }>()

    // 第一拍：正常发布，记账。
    await syncChangedShards(f.rawDbDir, f.decryptedDir, state)
    expect(existsSync(f.decFile)).toBe(true)
    expect(state.get(SHARD), '成功后必须记账').toBeDefined()
    expect(rowCount(f.decFile)).toBe(5)
    const before = state.get(SHARD)!

    // 源库换代（多 3 行）。
    writeRawShard(f.root, f.rawFile, 8)
    const newSig = statSigStr(f.rawFile)
    expect(newSig).not.toBe(before.main)

    // 目标被读连接占用 ⇒ atomicReplace 的 8 次重试全部失败。
    const hold = new DatabaseSync(f.decFile, { readOnly: true })
    try {
      forgetFullDecryptCooldown()
      const r = await syncChangedShards(f.rawDbDir, f.decryptedDir, state)
      expect(r.synced).toEqual([])
      expect(r.errors.length, '发布失败必须作为错误返回').toBeGreaterThan(0)
    } finally {
      hold.close()
    }
    expect(state.get(SHARD), '失败后不许把新签名记进 lastState（否则永远不再重试）').toEqual(before)
    expect(rowCount(f.decFile), '旧快照必须保持可用').toBe(5)

    // 下一拍：清掉退避与冷却，必须真的重试并发布。
    forgetSyncFailures()
    forgetFullDecryptCooldown()
    await syncChangedShards(f.rawDbDir, f.decryptedDir, state)
    expect(state.get(SHARD)?.main, '成功发布后才记录新签名').toBe(newSig)
    expect(rowCount(f.decFile), '新数据必须读得到').toBe(8)
  })
})
