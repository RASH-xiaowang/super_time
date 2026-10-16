/**
 * `sync-tail-patch.ts` 的行为守卫（2026-10-13，主库尾部增量解密）。
 *
 * 这一族决定「微信检查点把帧追加进主库后，能不能只解新增的那几页而不是整库重解」——
 * 真机实测一次整库重解 ~192ms（82MB 量级）+ 6s 冷却 ⇒ 活跃聊天时新消息最坏滞后 6 秒多，
 * 尾部增量把这一步压到毫秒级。坏形状都是**静默**的：
 *  · 计划判定放水（非整页增长也放行）⇒ 拼出半个页的快照；
 *  · 追加偏移/页数算错 ⇒ 快照结构损坏；
 *  · quick_check 被拿掉 ⇒ 上面两种坏快照直接**发出去**（宁可慢不可错的安全网被拆）。
 *
 * ## 夹具的边界（如实记）
 *
 * node:sqlite 建的库**没有原生预留字节**（SQLite 会把单元指针区放进页尾 80 字节），
 * 而解密端对页尾补零 ⇒ 这类夹具上拼好的快照**过不了 quick_check**（指针被清零）。
 * 真实微信库是 SQLCipher 创建的、每页原生预留 80 字节，页尾本就只放 IV+HMAC ⇒
 * 生产快照零尾是安全的、quick_check 是有效的安全网（真机探针观察 `tail(Np/wM)` 日志行
 * 即为「成功路径在真库上走通」的现场证据）。因此本文件：
 *  · 字节级正确性用**零尾归一对比**（`zeroTail(原文) == 追加结果`）；
 *  · quick_check 的门本身用「真库 ok / 垃圾 false」钉住；
 *  · 集成用**坏计划**验证安全网：quick_check 拦下 → 退回整库重解 → 结果仍正确。
 * @vitest-environment node
 */
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { syncMessageShard } from '../src/query/sync.ts'
import { TAIL_MAX_PAGES, decryptTailAppend, tailAppendPlan, tailQuickCheckOk } from '../src/query/sync-tail-patch.ts'

const PAGE_SZ = 4096
const RESERVE_SZ = 80
const RAW_KEY = Buffer.alloc(32, 7)
const RAW_KEY_HEX = RAW_KEY.toString('hex')

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `wx-tail-${tag}-`))
  scratch.push(dir)
  return dir
}

/** 建一个真 SQLite 库：一张表 + 若干 256B 行。 */
function makePlainDb(dir: string, name: string, rows: number): string {
  const p = join(dir, name)
  const db = new DatabaseSync(p)
  try {
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT)')
    const stmt = db.prepare('INSERT INTO t (id, blob) VALUES (?, ?)')
    for (let i = 0; i < rows; i += 1) stmt.run(i, 'x'.repeat(256))
  } finally {
    db.close()
  }
  return p
}

/** 解密端输出的等价形状：每页内容 4016B + 页尾 80B 补零。 */
function zeroTail(buf: Buffer): Buffer {
  const out = Buffer.from(buf)
  for (let pg = 0; pg * PAGE_SZ < out.length; pg += 1) {
    out.fill(0, pg * PAGE_SZ + PAGE_SZ - RESERVE_SZ, Math.min((pg + 1) * PAGE_SZ, out.length))
  }
  return out
}

/**
 * 把真库逐页加密成 SQLCipher-4 形状（与 sync.ts 的页布局同口径）：
 * 每页磁盘上只存 `PAGE_SZ - RESERVE_SZ` = 4016 字节内容（页 1 再让出 16B 盐），
 * 尾部 80 字节是 IV+HMAC 预留、不属于内容 —— 解密端对它们补零。
 */
function encryptDb(plainPath: string, outPath: string): { salt: Buffer; encKey: Buffer } {
  const plain = readFileSync(plainPath)
  const salt = randomBytes(16)
  const encKey = pbkdf2Sync(RAW_KEY, salt, 256000, 32, 'sha512')
  const pages = plain.length / PAGE_SZ
  const out = Buffer.alloc(plain.length)
  for (let pgno = 1; pgno <= pages; pgno += 1) {
    const iv = randomBytes(16)
    const cipher = createCipheriv('aes-256-cbc', encKey, iv)
    cipher.setAutoPadding(false)
    const src = plain.subarray((pgno - 1) * PAGE_SZ, pgno * PAGE_SZ)
    const from = pgno === 1 ? 16 : 0
    const encrypted = cipher.update(src.subarray(from, PAGE_SZ - RESERVE_SZ))
    const page = Buffer.alloc(PAGE_SZ)
    if (pgno === 1) salt.copy(page, 0)
    encrypted.copy(page, from)
    iv.copy(page, PAGE_SZ - RESERVE_SZ)
    page.copy(out, (pgno - 1) * PAGE_SZ)
  }
  writeFileSync(outPath, out)
  return { salt, encKey }
}

describe('尾部增量计划 tailAppendPlan（纯判定）', () => {
  it('整页增长 ⇒ 给偏移与页数；否则一律 null（走全量）', () => {
    expect(tailAppendPlan('0:40960', '0:45056')).toEqual({ offset: 40960, pages: 1 })
    expect(tailAppendPlan('0:40960', '0:53248')).toEqual({ offset: 40960, pages: 3 })
    expect(tailAppendPlan('0:45056', '0:40960'), '变小不是追加').toBeNull()
    expect(tailAppendPlan('0:40960', '0:45000'), '非整页增长').toBeNull()
    expect(tailAppendPlan('0:40960', `0:${40960 + (TAIL_MAX_PAGES + 1) * PAGE_SZ}`), '超上限').toBeNull()
    expect(tailAppendPlan('0:40960', '0:122880'), '翻倍式暴涨（疑似 rebuild）').toBeNull()
    expect(tailAppendPlan('bad', '0:45056'), '签名解析不了').toBeNull()
  })
})

describe('尾部追加的字节正确性与 quick_check 门', () => {
  it('旧快照 + 解密出的尾部页 = 完整库的零尾归一形状（页数、内容逐字节对得上）', async () => {
    const dir = tempDir('append')
    const plain = makePlainDb(dir, 'full.db', 1000)
    const plainBytes = readFileSync(plain)
    const { encKey } = encryptDb(plain, join(dir, 'raw.db'))
    const cutPages = 40
    const staging = join(dir, 'staging.db')
    // 生产快照的每页页尾都是解密端补的零 ⇒ 旧快照夹具也要用零尾归一形状。
    writeFileSync(staging, zeroTail(plainBytes).subarray(0, cutPages * PAGE_SZ))
    const tailPages = plainBytes.length / PAGE_SZ - cutPages
    const written = await decryptTailAppend(join(dir, 'raw.db'), staging, cutPages * PAGE_SZ, tailPages, encKey)
    expect(written).toBe(tailPages)
    expect(readFileSync(staging).length).toBe(plainBytes.length)
    expect(readFileSync(staging).equals(zeroTail(plainBytes)), '尾部追加结果必须等于完整库的零尾归一形状').toBe(true)
  })

  it('quick_check：真库 ok；垃圾文件 false（不抛）', () => {
    const dir = tempDir('qc')
    const plain = makePlainDb(dir, 'ok.db', 10)
    expect(tailQuickCheckOk(plain)).toBe(true)
    writeFileSync(join(dir, 'junk.db'), 'not a database at all')
    expect(tailQuickCheckOk(join(dir, 'junk.db'))).toBe(false)
  })
})

describe('sync.ts 的尾部接线（源码锚点）', () => {
  const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/query/sync.ts'), 'utf8')

  it('哨兵：sync.ts 真的读到了（读空 ⇒ 下面的断言全恒真）', () => {
    expect(SRC.length).toBeGreaterThan(500)
  })

  it('尾部计划必须真参与判定：可行才走 tail、不可行才吃冷却；quick_check 是发布前的安全网', () => {
    expect(SRC, '尾部计划计算被摘掉（退化成永远全量）').toContain('tailAppendPlan(prev.main, sig.main)')
    expect(SRC, '冷却闸必须只在无尾部计划、无差分计划时才关全量').toContain('tailPlan === null && diffIndexes === undefined && !fullDecryptDue(f)')
    expect(SRC, '尾部路径必须过 quick_check 才发布').toContain('tailQuickCheckOk(stagingDb)')
    expect(SRC, '增量路径失败必须退回整库重解').toContain('patch rejected, falling back to full decrypt')
  })
})

describe('syncMessageShard 的尾部路径（集成 + 安全网）', () => {
  function makeRoots(cutPages: number): { root: string; rawMsg: string; decMsg: string; fullBytes: Buffer; plan: { offset: number; pages: number } } {
    const root = tempDir('sync')
    const rawMsg = join(root, 'raw', 'message')
    const decMsg = join(root, 'decrypted', 'message')
    mkdirSync(rawMsg, { recursive: true })
    mkdirSync(decMsg, { recursive: true })
    writeFileSync(join(root, 'config.json'), JSON.stringify({ db_enc_key: RAW_KEY_HEX, key_format: 'wx_key_v4.1' }), 'utf8')
    const plain = makePlainDb(root, 'full.db', 1000)
    const fullBytes = readFileSync(plain)
    encryptDb(plain, join(rawMsg, 'message_0.db'))
    // 旧快照 = 前 cutPages 页的明文
    writeFileSync(join(decMsg, 'message_0.db'), fullBytes.subarray(0, cutPages * PAGE_SZ))
    const plan = tailAppendPlan(`0:${cutPages * PAGE_SZ}`, `0:${fullBytes.length}`)
    expect(plan, '夹具规模不对：库必须大于切页数').not.toBeNull()
    return { root, rawMsg, decMsg, fullBytes, plan: plan! }
  }

  it('坏计划（偏移错页）⇒ quick_check 拦下并**退回整库重解**，结果仍然正确（安全网真的会兜住）', async () => {
    const { rawMsg, decMsg, fullBytes, plan } = makeRoots(40)
    const bad = { offset: plan.offset + PAGE_SZ, pages: plan.pages - 1 }
    const r = await syncMessageShard(rawMsg, decMsg, 'message_0.db', RAW_KEY_HEX, 'wx_key_v4.1', 'full', bad)
    const target = join(decMsg, 'message_0.db')
    expect(readFileSync(target).equals(zeroTail(fullBytes)), '回退到整库重解后必须得到完整库（零尾归一）').toBe(true)
    expect(r.fullPages).toBe(fullBytes.length / PAGE_SZ)
  })

  it('坏计划下（页数 0 的输入形状）也能安全收场：不发坏快照、不崩', async () => {
    const { rawMsg, decMsg, fullBytes } = makeRoots(40)
    const zero = { offset: 0, pages: 0 }
    const r = await syncMessageShard(rawMsg, decMsg, 'message_0.db', RAW_KEY_HEX, 'wx_key_v4.1', 'full', zero)
    const target = join(decMsg, 'message_0.db')
    expect(readFileSync(target).equals(zeroTail(fullBytes)), '无论走哪条路，最终快照必须完整').toBe(true)
    expect(r.fullPages).toBeGreaterThan(0)
  })
})
