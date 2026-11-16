/**
 * `decryptAllDbs` 的两个发布安全缺口（2026-11-16）：
 *
 *   ① **源 WAL 合并**：修复/全量解密原先只读原始主库。微信的实时写入可能还没 checkpoint
 *      到主库、只躺在旁边的 `-wal` 里；不合并就会静默丢掉最新消息，而源主库签名没变，
 *      实时同步之后也不会再补。口径必须与 `sync.ts` 的整库路径一致：
 *      主库副本 + WAL 副本 + 帧补丁。
 *   ② **发布前三态完整性校验**：`looksDecrypted` 只看 24 字节头（而 `decryptPage` 又给
 *      页 1 无条件贴魔数），「头合法、页 2 起损坏」的产物会一路发布，复检才发现。
 *      现在 `assertPublishable` 用 `PRAGMA quick_check` 扫整库；corrupt ⇒ 拒绝发布并保留
 *      旧目标，uncheckable（本机没有 FTS 分词器）⇒ 告警放行。
 *
 * 夹具是**真 SQLite 库 + 合成 SQLCipher4 页/WAL 帧**：只有真库才能让 quick_check 有意义
 * （合成页会被正确地判成损坏 —— 那正是闸门该做的事）。不碰真实微信文件。
 * @vitest-environment node
 */
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decryptAllDbs } from '../src/query/decrypt-all.ts'
import { assertPublishable, verifySnapshot } from '../src/query/snapshot-verify.ts'

const PAGE_SZ = 4096
const RESERVE_SZ = 80
const SALT_SZ = 16
const WAL_HEADER_SZ = 32
const WAL_FRAME_HEADER_SZ = 24
const RAW_KEY = '4304020f3020400d967181c0f2f68a45ae9eb6e806f442a2a96c470e7fb62e34'

const scratch: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

/** wx_key_v4.1 的密钥派生（与 sync.ts / decrypt-all.ts 同口径：PBKDF2-HMAC-SHA512, 256000）。 */
function derive(rawKeyHex: string, salt: Buffer): Buffer {
  return pbkdf2Sync(Buffer.from(rawKeyHex, 'hex'), salt, 256_000, 32, 'sha512')
}

/** 把一页明文改成 SQLCipher 的 reserved=80 布局（内容区整体左移 80B）。 */
function toReservedPage(page: Buffer, pgno: number): Buffer {
  const buf = Buffer.from(page)
  if (pgno === 1) buf[20] = RESERVE_SZ
  const hdr = pgno === 1 ? 100 : 0
  const nCells = buf.readUInt16BE(hdr + 3)
  const cs = buf.readUInt16BE(hdr + 5)
  if (cs === 0) return buf
  const ptr = hdr + 8
  for (let i = 0; i < nCells; i += 1) {
    buf.writeUInt16BE(buf.readUInt16BE(ptr + i * 2) - RESERVE_SZ, ptr + i * 2)
  }
  buf.writeUInt16BE(cs - RESERVE_SZ, hdr + 5)
  buf.copy(buf, cs - RESERVE_SZ, cs, PAGE_SZ)
  buf.fill(0, PAGE_SZ - RESERVE_SZ, PAGE_SZ)
  return buf
}

/** 整库改成 reserved=80：第 1 页的页头在偏移 100，其余页在偏移 0。 */
function toReservedLayout(plain: Buffer): Buffer {
  const buf = Buffer.from(plain)
  for (let base = 0; base + PAGE_SZ <= buf.length; base += PAGE_SZ) {
    toReservedPage(buf.subarray(base, base + PAGE_SZ), base === 0 ? 1 : 2).copy(buf, base)
  }
  return buf
}

/** 把一页明文封成 SQLCipher4 的磁盘形态（HMAC 尾巴填零：解密侧不校验它）。 */
function encryptPage(plain: Buffer, pgno: number, encKey: Buffer, salt: Buffer): Buffer {
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', encKey, iv)
  cipher.setAutoPadding(false)
  const payload = pgno === 1 ? plain.subarray(16, PAGE_SZ - RESERVE_SZ) : plain.subarray(0, PAGE_SZ - RESERVE_SZ)
  const enc = Buffer.concat([cipher.update(payload), cipher.final()])
  const page = Buffer.alloc(PAGE_SZ)
  if (pgno === 1) salt.copy(page, 0)
  enc.copy(page, pgno === 1 ? SALT_SZ : 0)
  iv.copy(page, PAGE_SZ - RESERVE_SZ)
  return page
}

/** 用给定密钥/盐加密整库（页数不变，产物与明文等长）。 */
function encryptPlainDbWithKey(plain: Buffer, encKey: Buffer, salt: Buffer): Buffer {
  const pages = Math.ceil(plain.length / PAGE_SZ)
  const out = Buffer.alloc(pages * PAGE_SZ)
  for (let pgno = 1; pgno <= pages; pgno += 1) {
    const base = (pgno - 1) * PAGE_SZ
    const page = Buffer.alloc(PAGE_SZ)
    plain.copy(page, 0, base, Math.min(base + PAGE_SZ, plain.length))
    encryptPage(page, pgno, encKey, salt).copy(out, base)
  }
  return out
}

/**
 * 把「真 SQLite WAL」重封成 SQLCipher 形态：帧头只保留 pgno 与同一套 salt，
 * 帧里的页按 reserved=80 布局 + 主库盐派生的密钥加密（与 `decryptWalPatch` 的口径对齐）。
 * 真 WAL 的页布局是 reserved=0，必须逐页左移 80B，否则补丁会把指针区清掉。
 */
function encryptWalWith(plainWal: Buffer, encKey: Buffer, salt: Buffer): Buffer {
  const frameSize = WAL_FRAME_HEADER_SZ + PAGE_SZ
  const salt1 = randomBytes(4).readUInt32BE(0)
  const salt2 = randomBytes(4).readUInt32BE(0)
  const header = Buffer.alloc(WAL_HEADER_SZ)
  header.writeUInt32BE(0x377f0682, 0)
  header.writeUInt32BE(3_007_000, 4)
  header.writeUInt32BE(PAGE_SZ, 8)
  header.writeUInt32BE(1, 12)
  header.writeUInt32BE(salt1, 16)
  header.writeUInt32BE(salt2, 20)
  const parts: Buffer[] = [header]
  for (let offset = WAL_HEADER_SZ; offset + frameSize <= plainWal.length; offset += frameSize) {
    const pgno = plainWal.readUInt32BE(offset)
    if (pgno === 0 || pgno > 1_000_000) continue
    const page = plainWal.subarray(offset + WAL_FRAME_HEADER_SZ, offset + frameSize)
    const enc = encryptPage(toReservedPage(page, pgno), pgno, encKey, salt)
    const frameHeader = Buffer.alloc(WAL_FRAME_HEADER_SZ)
    frameHeader.writeUInt32BE(pgno, 0)
    frameHeader.writeUInt32BE(0, 4) // commit 大小：decryptWalPatch 不读，置 0 即可
    frameHeader.writeUInt32BE(salt1, 8)
    frameHeader.writeUInt32BE(salt2, 12)
    parts.push(frameHeader, enc)
  }
  return Buffer.concat(parts)
}

/** 用 node:sqlite 建一个 2 页的真库（100 行小整数，实测恰好 2 页）。 */
function createPlainDb(file: string): void {
  rmSync(file, { force: true })
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE Row (id INTEGER PRIMARY KEY, marker INTEGER)')
  const ins = db.prepare('INSERT INTO Row VALUES (?, ?)')
  for (let i = 0; i < 100; i += 1) ins.run(i, 0x5a)
  db.close()
}

/** 建好数据根与配置，返回 `{raw, decrypted}` 两个目录。 */
function makeRoots(cfg: Record<string, unknown>): { root: string; raw: string; decrypted: string } {
  const root = tempDir('decrypt-publish-')
  const raw = join(root, 'raw')
  const decrypted = join(root, 'decrypted')
  mkdirSync(raw, { recursive: true })
  mkdirSync(decrypted, { recursive: true })
  writeFileSync(join(root, 'config.json'), JSON.stringify(cfg), 'utf8')
  return { root, raw, decrypted }
}

/** 在 raw 树里写一个加密的真库（2 页，reserved=80）；同时返回明文供断言夹具形状。 */
function makeEncryptedDb(rawDir: string, rel: string): { file: string; plain: Buffer } {
  const file = join(rawDir, rel)
  mkdirSync(dirname(file), { recursive: true })
  const plainPath = file + '.plain'
  createPlainDb(plainPath)
  const plain = toReservedLayout(readFileSync(plainPath))
  rmSync(plainPath, { force: true })
  if (plain.length !== PAGE_SZ * 2) throw new Error(`夹具应为 2 页，实际 ${String(plain.length / PAGE_SZ)} 页`)
  const salt = randomBytes(SALT_SZ)
  writeFileSync(file, encryptPlainDbWithKey(plain, derive(RAW_KEY, salt), salt))
  return { file, plain }
}

/**
 * 造「主库存 gen1、gen2 还在未 checkpoint 的 WAL 里」的现场，并加密成 raw 库 + raw WAL。
 * 快照必须在 `db.close()` 之前读：SQLite 关最后一个连接时会 checkpoint 并删掉 WAL。
 */
function makeWalFixture(rawDir: string, rel: string): void {
  const file = join(rawDir, rel)
  mkdirSync(dirname(file), { recursive: true })
  const livePath = file + '.plain'
  rmSync(livePath, { force: true })
  const db = new DatabaseSync(livePath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA wal_autocheckpoint = 0')
  db.exec('CREATE TABLE marker (id INTEGER PRIMARY KEY, tag TEXT)')
  db.prepare('INSERT INTO marker VALUES (?, ?)').run(1, 'gen1')
  db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all()
  db.prepare('INSERT INTO marker VALUES (?, ?)').run(2, 'gen2')
  const mainSnap = readFileSync(livePath)
  const walSnap = readFileSync(livePath + '-wal')
  db.close()
  rmSync(livePath, { force: true })
  rmSync(livePath + '-wal', { force: true })
  rmSync(livePath + '-shm', { force: true })
  expect(walSnap.length, '夹具 WAL 必须真的带帧，否则测不到「合并源 WAL」').toBeGreaterThanOrEqual(WAL_HEADER_SZ + WAL_FRAME_HEADER_SZ + PAGE_SZ)
  // 反证（防止用例恒真）：只打开主库快照（不带 WAL）时只能看到 gen1 ——
  // 后面目标里出现 gen2 就**只可能**来自 WAL 帧补丁。
  const mainOnlyPath = livePath + '.mainonly'
  writeFileSync(mainOnlyPath, mainSnap)
  const mainOnly = new DatabaseSync(mainOnlyPath, { readOnly: true })
  try {
    const tags = mainOnly.prepare('SELECT tag FROM marker ORDER BY id').all() as Array<{ tag: string }>
    expect(tags.map((r) => r.tag), '主库快照里已经有 gen2，WAL 合并用例就失去意义了').toEqual(['gen1'])
  } finally { mainOnly.close() }
  rmSync(mainOnlyPath, { force: true })
  const salt = randomBytes(SALT_SZ)
  const encKey = derive(RAW_KEY, salt)
  writeFileSync(file, encryptPlainDbWithKey(toReservedLayout(mainSnap), encKey, salt))
  writeFileSync(file + '-wal', encryptWalWith(walSnap, encKey, salt))
}

/** 解密目录里残留的三种临时文件（成功失败都不许留）。 */
function tempFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[])
    .filter((f) => /\.decrypt_(tmp|src|wal)$/.test(f))
}

describe('decryptAllDbs：合并源 WAL（修复不再丢掉未 checkpoint 的消息）', () => {
  it('WAL 里的 gen2 必须出现在目标快照里，目标 quick_check = ok，且无临时文件', async () => {
    const { raw, decrypted } = makeRoots({ db_enc_key: RAW_KEY, key_format: 'wx_key_v4.1' })
    const rel = 'message/message_0.db'
    makeWalFixture(raw, rel)
    // 反证夹具：raw 主库与 raw WAL 都在（主库只含 gen1，gen2 只在 WAL 里）。
    expect(existsSync(join(raw, rel))).toBe(true)
    expect(statSync(join(raw, rel) + '-wal').size).toBeGreaterThan(WAL_HEADER_SZ)

    const res = await decryptAllDbs(raw, decrypted)
    expect(res).toMatchObject({ ok: true, total: 1, okCount: 1, failed: [] })

    const target = join(decrypted, rel)
    const db = new DatabaseSync(target, { readOnly: true })
    try {
      const rows = db.prepare('SELECT id, tag FROM marker ORDER BY id').all() as Array<{ id: number; tag: string }>
      expect(rows, 'WAL 帧没被合并：gen2 不在快照里（修复静默丢最新消息）').toEqual([
        { id: 1, tag: 'gen1' },
        { id: 2, tag: 'gen2' },
      ])
      expect(db.prepare('PRAGMA quick_check').all(), '合并后的目标必须能被 SQLite 认作完好').toEqual([{ quick_check: 'ok' }])
    } finally { db.close() }
    expect(tempFiles(decrypted)).toEqual([])
  })
})

describe('decryptAllDbs：发布前拒绝「头合法、页 2 起损坏」的产物', () => {
  it('旧目标逐字节保留、failed 定位到该库、ok:false，且 .decrypt_src/.decrypt_wal/.decrypt_tmp 全清', async () => {
    const { raw, decrypted } = makeRoots({ db_enc_key: RAW_KEY, key_format: 'wx_key_v4.1' })
    const rel = 'message/message_0.db'
    const { file: rawFile, plain } = makeEncryptedDb(raw, rel)
    // 夹具形状就是真机口径：页大小 4096、reserved=80 —— quick_check 的结论才有意义。
    expect(plain.readUInt16BE(16)).toBe(PAGE_SZ)
    expect(plain[20]).toBe(RESERVE_SZ)
    expect(statSync(rawFile).size, '夹具必须是 2 页，页 2 才有东西可写坏').toBe(PAGE_SZ * 2)
    // 加密源页 2 写垃圾：解密后页 1 的魔数/页大小仍合法（looksDecrypted 会放行），
    // 只有 quick_check 能看见页 2 起的损坏。
    const fd = openSync(rawFile, 'r+')
    try { writeSync(fd, Buffer.alloc(PAGE_SZ, 0x5a), 0, PAGE_SZ, PAGE_SZ) } finally { closeSync(fd) }

    const target = join(decrypted, rel)
    mkdirSync(dirname(target), { recursive: true })
    const before = randomBytes(PAGE_SZ * 2)
    writeFileSync(target, before)

    const res = await decryptAllDbs(raw, decrypted, undefined, [rel])
    expect(res.ok).toBe(false)
    expect(res.total).toBe(1)
    expect(res.failed).toHaveLength(1)
    expect(res.failed[0]?.db).toBe(rel)
    expect(res.failed[0]?.error, '失败原因要能对上下一步（完整性校验），不能只说「失败」').toContain('解密结果完整性校验未通过：')
    expect(readFileSync(target).equals(before), '损坏产物把旧快照覆盖掉了').toBe(true)
    expect(tempFiles(decrypted), '失败后残留临时文件').toEqual([])
  })
})

describe('verifySnapshot / assertPublishable', () => {
  it('好库 ok；页 2 写垃圾 ⇒ corrupt，detail 是 SQLite 判词', () => {
    const dir = tempDir('verify-')
    const good = join(dir, 'good.db')
    createPlainDb(good)
    expect(verifySnapshot(good)).toEqual({ state: 'ok' })

    const bad = join(dir, 'bad.db')
    writeFileSync(bad, readFileSync(good))
    const fd = openSync(bad, 'r+')
    try { writeSync(fd, Buffer.alloc(PAGE_SZ, 0x5a), 0, PAGE_SZ, PAGE_SZ) } finally { closeSync(fd) }
    const verdict = verifySnapshot(bad)
    expect(verdict.state, '页 2 损坏必须判 corrupt（发布闸门不能只看页 1 头）').toBe('corrupt')
    if (verdict.state === 'corrupt') expect(verdict.detail.length).toBeGreaterThan(0)
  })

  it('真 FTS5 + 本机没有的分词器 ⇒ uncheckable（检不了 ≠ 坏了）', () => {
    const dir = tempDir('verify-fts-')
    const file = join(dir, 'fts.db')
    makeFtsWithUnknownTokenizer(file)
    const verdict = verifySnapshot(file)
    expect(verdict.state, 'quick_check 只会抛通用错误；必须先按 DDL 判「本机检不了」').toBe('uncheckable')
    if (verdict.state === 'uncheckable') expect(verdict.detail).toContain('MMFtsXx')

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* 断言用 */ })
    expect(() => assertPublishable(file), 'uncheckable 被当成 corrupt 会拒掉一个正常的 FTS 快照').not.toThrow()
    expect(warn, 'uncheckable 放行时必须留下告警').toHaveBeenCalled()
  })

  it('查询阶段抛「no such module」⇒ uncheckable（MISSING_MODULE_RE 兜底）', () => {
    const dir = tempDir('verify-missing-')
    const file = join(dir, 'good.db')
    createPlainDb(file)
    // 测试注入：只替换 quick_check 这一条 prepare，模拟「DDL 没写出来、错误原文缺模块」。
    // 不改生产接口，也不依赖本机真的缺 FTS5。
    const proto = DatabaseSync.prototype
    const original = proto.prepare
    proto.prepare = function (this: DatabaseSync, sql: string) {
      if (sql.includes('quick_check')) throw new Error('no such module: fts5')
      return original.call(this, sql)
    }
    try {
      expect(verifySnapshot(file)).toEqual({ state: 'uncheckable', detail: 'no such module: fts5' })
    } finally {
      proto.prepare = original
    }
  })

  it('assertPublishable：corrupt 抛约定文案', () => {
    const dir = tempDir('verify-assert-')
    const file = join(dir, 'bad.db')
    createPlainDb(file)
    const fd = openSync(file, 'r+')
    try { writeSync(fd, Buffer.alloc(PAGE_SZ, 0x5a), 0, PAGE_SZ, PAGE_SZ) } finally { closeSync(fd) }
    expect(() => assertPublishable(file)).toThrow(/^解密结果完整性校验未通过：/)
  })
})

/**
 * 造一个**真 FTS5 库**，再把 `sqlite_master` 里的 DDL 改成分词器 `MMFtsXx`
 * （微信那种编在宿主里的分词器）。这是本机能造出的最接近真机的「本机检不了」现场：
 * 影子表真实存在，quick_check 会实例化虚拟表并抛通用错误，只有 DDL 能说明原因。
 *
 * 做法是**等长原地替换**：用合法的 `trigram` 建表，再把文件里的 ASCII 字节改成同长度的
 * `MMFtsXx`。记录长度与页布局都没变，因此不需要 `writable_schema`（Node 22 的
 * node:sqlite 没有 `enableDefensive`，那条路在 CI 上不可用）。
 */
function makeFtsWithUnknownTokenizer(file: string): void {
  rmSync(file, { force: true })
  const db = new DatabaseSync(file)
  db.exec("CREATE VIRTUAL TABLE fts USING fts5(content, tokenize='trigram')")
  db.prepare('INSERT INTO fts VALUES (?)').run('hello')
  db.close()
  const bytes = readFileSync(file)
  const needle = Buffer.from('trigram')
  const replacement = Buffer.from('MMFtsXx')
  if (needle.length !== replacement.length) throw new Error('替换名必须与 trigram 等长')
  const at = bytes.indexOf(needle)
  if (at < 0 || bytes.indexOf(needle, at + 1) >= 0) throw new Error('夹具 DDL 里应恰好出现一次 trigram')
  replacement.copy(bytes, at)
  writeFileSync(file, bytes)
}
