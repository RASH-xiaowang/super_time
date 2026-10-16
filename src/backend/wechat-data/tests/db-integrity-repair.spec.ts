/**
 * 损坏库修复链路（W3-11.7）：体检 → 只重解密损坏的那几个 → 复检。
 *
 * 为什么必须是**真库真加密**的用例：`sync-wal.spec.ts` 那套合成页只能证明
 * 「页被搬对了」，证明不了「解出来的东西 SQLite 认」。本用例用真的
 * `node:sqlite` 建一个库、按 SQLCipher-4 布局逐页加密（`encryptPage`），
 * 跑真实 `decryptAllDbs` 出快照，再**真的写坏它** —— 链路里每个环节
 * （体检判坏、repair 只解坏的那几个、复检转绿）都因此是真的在执行。
 *
 * 钉住的四件事：
 *   ① 好库体检零误报（否则「修复」按钮会常态出现，用户以为库天天坏）；
 *   ② 页内损坏 → 体检报坏 → 修复 → 复检全绿且数据读得出来；
 *   ③ 头部就坏（打开即 NOTADB）也算「损坏」（它同样能靠重解密修好）；
 *   ④ 原始库没了的修不了 —— 如实进 `unrepairable`，不假装修过。
 * @vitest-environment node
 */
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { checkDecryptedIntegrity } from '../src/query/db-health.ts'
import { repairCorruptDbs } from '../src/query/db-repair.ts'
import { decryptAllDbs } from '../src/query/decrypt-all.ts'
import { plantPoisonedPair, makeSupersededWal, verdictOf } from './superseded-wal-fixture.ts'

const PAGE_SZ = 4096
const SALT_SZ = 16
const RESERVE_SZ = 80
const RAW_KEY_HEX = '4304020f3020400d967181c0f2f68a45ae9eb6e806f442a2a96c470e7fb62e34'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

/**
 * 把一个普通库改造成 **SQLCipher 布局**（reserved=80，内容不落进每页最后 80B）。
 *
 * 为什么非改不可：`sync.ts#decryptPage` 对每页只解出前 4016B，尾部 80B 在产物里
 * 必然是零（那截在密文里是 IV/HMAC）。这不是缺陷 —— 真微信库就是这样：页头
 * offset 20 写着 reserved=80，SQLite 核心永远不碰那截（`plausibleSqliteHeader`
 * 的注释也点了这件事）。而 `node:sqlite` 建出来的普通库 reserved=0、cell 从页尾
 * 往回 packing，schema 文本恰好躺在最后 80B 里 —— 原样加密再解出来会是
 * "malformed database schema - incomplete input"。
 *
 * 做法：页头声明 reserved=80，再把每页的内容区整体左移 80B（含 cell 指针与
 * content-start 字段同步 -80）。移动后文件仍是合法库（integrity ok、行读得出来，
 * 本文件的用例本身就是判据），且与真库同形。
 * ⚠️ 只适用于无 freeblock、无 overflow 页的库（本用例的夹具就是这个形状）。
 */
function toReservedLayout(plain: Buffer): Buffer {
  const buf = Buffer.from(plain)
  buf[20] = 80
  for (let base = 0; base + PAGE_SZ <= buf.length; base += PAGE_SZ) {
    const hdr = base + (base === 0 ? 100 : 0)
    const nCells = buf.readUInt16BE(hdr + 3)
    const cs = buf.readUInt16BE(hdr + 5)
    if (cs === 0) continue // 空页：没有内容区可移
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

/**
 * 按 SQLCipher-4 布局加密一个真库：
 *   page 1: [16B salt][4016B enc][16B IV][64B reserved]
 *   page n: [4016B enc][16B IV][64B reserved]
 * 页 1 明文的头 16 字节（SQLite 魔数）被盐顶掉，解密时贴回 —— 与
 * `sync.ts#decryptPage` 的布局逐字段对齐。
 * @param plainPath - 普通库路径（内容随意，只是被加密的素材）。
 * @param plainBytes - 要加密的字节（默认读 plainPath；调用方可先改布局）。
 */
function encryptSqliteFile(plainPath: string, plainBytes?: Buffer): Buffer {
  const plain = plainBytes ?? readFileSync(plainPath)
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

/** 造一份数据根：raw 侧一个加密库（真库内容），decrypted 侧 config.json（db_dir + 密钥）。 */
function makeFixture(): { root: string; rawDbDir: string; decryptedDir: string; decFile: string; rawFile: string; rows: number } {
  const root = mkdtempSync(join(tmpdir(), 'dbrepair-'))
  scratch.push(root)
  const rawDbDir = join(root, 'db_storage')
  const decryptedDir = join(root, 'decrypted')
  mkdirSync(join(rawDbDir, 'message'), { recursive: true })
  mkdirSync(decryptedDir, { recursive: true })

  const plainPath = join(root, 'plain.db')
  const rows = 100
  const db = new DatabaseSync(plainPath)
  db.exec('CREATE TABLE Msg_wxid_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa (create_time INTEGER, local_type INTEGER, message_content TEXT)')
  const ins = db.prepare('INSERT INTO Msg_wxid_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa VALUES (?, ?, ?)')
  for (let i = 0; i < rows; i += 1) ins.run(1700000000 + i, 1, `消息 ${i}`)
  db.close()

  const rawFile = join(rawDbDir, 'message', 'message_0.db')
  writeFileSync(rawFile, encryptSqliteFile(plainPath, toReservedLayout(readFileSync(plainPath))))
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    db_dir: rawDbDir, db_enc_key: RAW_KEY_HEX, key_format: 'wx_key_v4.1',
  }))
  return { root, rawDbDir, decryptedDir, decFile: join(decryptedDir, 'message', 'message_0.db'), rawFile, rows }
}

/** 把解密快照的第 N 页（0 基）整页写垃圾 —— 头部保持完好，坏在里面。 */
function trashPage(file: string, pageIndex: number): void {
  const fd = openSync(file, 'r+')
  try {
    writeSync(fd, Buffer.alloc(PAGE_SZ, 0x5a), 0, PAGE_SZ, pageIndex * PAGE_SZ)
  } finally {
    closeSync(fd)
  }
}

describe('checkDecryptedIntegrity', () => {
  it('好库零误报（修复按钮不该常态出现）', async () => {
    const fx = makeFixture()
    const r = await decryptAllDbs(fx.rawDbDir, fx.decryptedDir)
    expect(r.ok).toBe(true)
    const g = await checkDecryptedIntegrity(fx.decryptedDir)
    expect(g.checked).toBe(1)
    expect(g.corrupted).toEqual([])
    expect(g.unreadable).toEqual([])
  })

  it('页内写坏 ⇒ 报损坏，且带上 SQLite 的原始错误', async () => {
    const fx = makeFixture()
    await decryptAllDbs(fx.rawDbDir, fx.decryptedDir)
    trashPage(fx.decFile, 1) // page 2：表数据所在页
    const g = await checkDecryptedIntegrity(fx.decryptedDir)
    expect(g.corrupted.map((c) => c.file)).toEqual(['message/message_0.db'])
    expect(g.corrupted[0]?.error.length ?? 0).toBeGreaterThan(0)
  })

  it('头部就坏（打开即 NOTADB）也算损坏 —— 它同样能靠重解密修好', async () => {
    const fx = makeFixture()
    await decryptAllDbs(fx.rawDbDir, fx.decryptedDir)
    const fd = openSync(fx.decFile, 'r+')
    try { writeSync(fd, Buffer.alloc(16, 0x33), 0, 16, 0) } finally { closeSync(fd) }
    const g = await checkDecryptedIntegrity(fx.decryptedDir)
    expect(g.corrupted.map((c) => c.file)).toEqual(['message/message_0.db'])
    expect(g.unreadable).toEqual([])
  })
})

describe('repairCorruptDbs', () => {
  it('一个都没坏 ⇒ 不写任何文件，found: 0', async () => {
    const fx = makeFixture()
    await decryptAllDbs(fx.rawDbDir, fx.decryptedDir)
    const before = readFileSync(fx.decFile)
    const r = await repairCorruptDbs(fx.rawDbDir, fx.decryptedDir)
    expect(r).toMatchObject({ ok: true, found: 0, repaired: 0 })
    expect(r.stillCorrupted).toEqual([])
    expect(r.unrepairable).toEqual([])
    expect(readFileSync(fx.decFile).equals(before)).toBe(true)
  })

  it('页内损坏 ⇒ 只重解密坏的那几个，复检转绿且数据读得出来', async () => {
    const fx = makeFixture()
    await decryptAllDbs(fx.rawDbDir, fx.decryptedDir)
    trashPage(fx.decFile, 1)
    const r = await repairCorruptDbs(fx.rawDbDir, fx.decryptedDir)
    expect(r.ok).toBe(true)
    expect(r.found).toBe(1)
    expect(r.repaired).toBe(1)
    expect(r.stillCorrupted).toEqual([])
    expect(r.failed).toEqual([])
    expect(r.unrepairable).toEqual([])
    // 复检独立再跑一次：修完必须真的是好的
    const g = await checkDecryptedIntegrity(fx.decryptedDir)
    expect(g.corrupted).toEqual([])
    // 数据本身读得出来（不是「文件能打开」而已）
    const db = new DatabaseSync(fx.decFile, { readOnly: true })
    const got = db.prepare('SELECT COUNT(*) AS n FROM Msg_wxid_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').get() as { n: number }
    db.close()
    expect(got.n).toBe(fx.rows)
  })

  it('头部就坏（NOTADB）同样修得好', async () => {
    const fx = makeFixture()
    await decryptAllDbs(fx.rawDbDir, fx.decryptedDir)
    const fd = openSync(fx.decFile, 'r+')
    try { writeSync(fd, Buffer.alloc(16, 0x33), 0, 16, 0) } finally { closeSync(fd) }
    const r = await repairCorruptDbs(fx.rawDbDir, fx.decryptedDir)
    expect(r).toMatchObject({ ok: true, found: 1, repaired: 1 })
    const g = await checkDecryptedIntegrity(fx.decryptedDir)
    expect(g.corrupted).toEqual([])
  })

  it('原始库没了 ⇒ 进 unrepairable，不假装修过', async () => {
    const fx = makeFixture()
    await decryptAllDbs(fx.rawDbDir, fx.decryptedDir)
    trashPage(fx.decFile, 1)
    unlinkSync(fx.rawFile)
    const r = await repairCorruptDbs(fx.rawDbDir, fx.decryptedDir)
    expect(r.ok).toBe(false)
    expect(r.found).toBe(1)
    expect(r.repaired).toBe(0)
    expect(r.stillCorrupted).toEqual([])
    expect(r.unrepairable.map((u) => u.file)).toEqual(['message/message_0.db'])
    expect(r.unrepairable[0]?.reason).toContain('原始')
  })

  /**
   * 2026-10-13 真机那条 `message/message_0.db` 的病灶：**主文件完好，旁边躺着上一代残留的
   * `-wal`**（795 帧 / 3.2MB）。它读起来是 `database disk image is malformed`，
   * 但它既不需要、也不该去重解密（重解密只换主文件，旁文件还在；还要读微信目录里那个
   * 80MB+ 的原始分片）。所以这里把现场摆进快照目录，并**让它没有原始库对应**
   * —— 一旦代码退回「重解密」这条路，`unrepairable` 立刻会非空，这条用例就红。
   */
  it('上一代残留的 WAL（主文件完好）⇒ 本地清旁文件就修好，既不读原始库、也不动别的库', async () => {
    const fx = makeFixture()
    await decryptAllDbs(fx.rawDbDir, fx.decryptedDir)
    const realBefore = readFileSync(fx.decFile)

    // 现场：快照目录里多出一个「另一代主文件 + 上一代 WAL」的库（原始 db_storage 里没有它）。
    const scratchDir = join(fx.root, 'poison-src')
    mkdirSync(scratchDir, { recursive: true })
    const poisoned = plantPoisonedPair(scratchDir, 'message_9.db', makeSupersededWal(scratchDir).wal)
    const planted = join(fx.decryptedDir, 'message', 'message_9.db')
    copyFileSync(poisoned, planted)
    copyFileSync(poisoned + '-wal', planted + '-wal')

    const g0 = await checkDecryptedIntegrity(fx.decryptedDir)
    expect(g0.corrupted.map((c) => c.file)).toEqual(['message/message_9.db'])

    const r = await repairCorruptDbs(fx.rawDbDir, fx.decryptedDir)
    expect(r).toMatchObject({ ok: true, found: 1, repaired: 1 })
    expect(r.failed).toEqual([])
    expect(r.stillCorrupted).toEqual([])
    // 原始 db_storage 里没有 message_9.db ⇒ 走的一定是「本地清残留」，不是重解密。
    expect(r.unrepairable).toEqual([])
    expect(existsSync(planted + '-wal')).toBe(false)
    expect(verdictOf(planted)).toBe('ok')
    // 别的库（连同原始 db_storage）一个字节都没动。
    expect(readFileSync(fx.decFile).equals(realBefore)).toBe(true)
  })
})

describe('decryptAllDbs · onlyRel 过滤', () => {
  it('只解密列出的那几个（修复的弹药口径：total 随范围走）', async () => {
    const fx = makeFixture()
    // 再造第二个加密库，验证它不被顺手解出来
    const plainPath = join(fx.root, 'plain2.db')
    const db = new DatabaseSync(plainPath)
    db.exec('CREATE TABLE T (a INTEGER)')
    db.prepare('INSERT INTO T VALUES (?)').run(1)
    db.close()
    writeFileSync(join(fx.rawDbDir, 'message', 'message_1.db'), encryptSqliteFile(plainPath, toReservedLayout(readFileSync(plainPath))))

    const seen: number[] = []
    const r = await decryptAllDbs(fx.rawDbDir, fx.decryptedDir, (done, total) => { seen.push(total) }, ['message/message_0.db'])
    expect(r).toMatchObject({ ok: true, total: 1, okCount: 1 })
    expect(seen).toEqual([1])
    expect(existsSync(fx.decFile)).toBe(true)
    expect(existsSync(join(fx.decryptedDir, 'message', 'message_1.db'))).toBe(false)
    // 全量口径没变：一个字节都没提 onlyRel 时还是全解
    const r2 = await decryptAllDbs(fx.rawDbDir, fx.decryptedDir)
    expect(r2.total).toBe(2)
    expect(existsSync(join(fx.decryptedDir, 'message', 'message_1.db'))).toBe(true)
  })
})
