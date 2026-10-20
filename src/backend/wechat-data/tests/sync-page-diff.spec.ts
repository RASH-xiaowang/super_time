/**
 * `sync-page-diff.ts` 的行为守卫（2026-10-13，主库页级差分增量）。
 *
 * 参考 WeChatDataAnalysis 的合并语义：检查点除追加页外还会**原地重写**部分页
 * （主库大小不变、mtime 变）。这一族决定「能不能只解真正变化的那几页」——
 * 旧路径对任何主库变化都整库重解（82MB ≈ 200ms–1s）。坏形状都是**静默**的：
 *  · 指纹列表与源签名脱钩 ⇒ 拿过期指纹比对，把「变了」判成「没变」（数据漏同步）；
 *  · 差异下标算错 ⇒ 补丁打错页（quick_check 安全网兜底回全量，但每一轮都白做）；
 *  · 变化页占比上限被拿掉 ⇒ 哈希扫描 + 大量补丁比全量更贵。
 *
 * 集成沿用 sync-tail-patch.spec 的夹具口径（零尾归一；node:sqlite 无原生预留字节 ⇒
 * 差分拼好的快照过不了 quick_check，集成断言的是「坏形状 → 安全网兜住 → 结果正确」）。
 * @vitest-environment node
 */
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { syncMessageShard } from '../src/query/sync.ts'
import { DIFF_MAX_CHANGED_RATIO, diffPageIndexes, pageHashesOf, pageHashesRange, patchChangedPages } from '../src/query/sync-page-diff.ts'

const PAGE_SZ = 4096
const RESERVE_SZ = 80
const RAW_KEY = Buffer.alloc(32, 7)
const RAW_KEY_HEX = RAW_KEY.toString('hex')

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `wx-pagediff-${tag}-`))
  scratch.push(dir)
  return dir
}

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

function zeroTail(buf: Buffer): Buffer {
  const out = Buffer.from(buf)
  for (let pg = 0; pg * PAGE_SZ < out.length; pg += 1) {
    out.fill(0, pg * PAGE_SZ + PAGE_SZ - RESERVE_SZ, Math.min((pg + 1) * PAGE_SZ, out.length))
  }
  return out
}

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

const h = (n: number): Buffer => Buffer.alloc(32, n)

describe('差异页下标 diffPageIndexes（纯判定）', () => {
  it('新增/变化/相同三种页都判得对；上限常量是比例', () => {
    expect(diffPageIndexes([h(1), h(2)], [h(1), h(2)])).toEqual([])
    expect(diffPageIndexes([h(1), h(2)], [h(1), h(9)])).toEqual([1])
    expect(diffPageIndexes([h(1)], [h(1), h(2)])).toEqual([1])
    expect(diffPageIndexes([h(1), h(2)], [h(1)])).toEqual([1])
    expect(DIFF_MAX_CHANGED_RATIO, '占比上限必须是正的（归零 = 差分永不被采用）').toBeGreaterThan(0)
    expect(DIFF_MAX_CHANGED_RATIO).toBeLessThan(1)
  })
})

describe('指纹扫描与按页补丁（真 SQLCipher 夹具）', () => {
  it('指纹列表稳定；范围扫描与全量扫描对齐', async () => {
    const dir = tempDir('hash')
    const plain = makePlainDb(dir, 'full.db', 300)
    const encrypt = encryptDb(plain, join(dir, 'raw.db'))
    void encrypt
    const all = await pageHashesOf(join(dir, 'raw.db'))
    expect(all.length).toBe(readFileSync(plain).length / PAGE_SZ)
    const tail = await pageHashesRange(join(dir, 'raw.db'), 10, 5)
    expect(tail).toEqual(all.slice(10, 15))
  })

  it('按页补丁：只重解指定页，其余页原样保留', async () => {
    const dir = tempDir('patch')
    const plain = makePlainDb(dir, 'full.db', 300)
    const plainBytes = readFileSync(plain)
    const { encKey } = encryptDb(plain, join(dir, 'raw.db'))
    const staging = join(dir, 'staging.db')
    writeFileSync(staging, zeroTail(plainBytes))
    // 破坏 staging 的第 7 页（0 起），再让补丁从 raw 里把它修回来
    const broken = zeroTail(plainBytes)
    broken.fill(0xaa, 7 * PAGE_SZ, 8 * PAGE_SZ)
    writeFileSync(staging, broken)
    const written = await patchChangedPages(join(dir, 'raw.db'), staging, [7], encKey)
    expect(written).toBe(1)
    expect(readFileSync(staging).equals(zeroTail(plainBytes)), '补丁后必须恢复成零尾归一形状').toBe(true)
  })
})

describe('syncMessageShard 的差分路径（集成 + 安全网）', () => {
  it('差分补丁坏形状（错页下标）⇒ quick_check 拦下退回全量，结果仍正确', async () => {
    const root = tempDir('sync')
    const rawMsg = join(root, 'raw', 'message')
    const decMsg = join(root, 'decrypted', 'message')
    mkdirSync(rawMsg, { recursive: true })
    mkdirSync(decMsg, { recursive: true })
    writeFileSync(join(root, 'config.json'), JSON.stringify({ db_enc_key: RAW_KEY_HEX, key_format: 'wx_key_v4.1' }), 'utf8')
    const plain = makePlainDb(root, 'full.db', 300)
    const fullBytes = readFileSync(plain)
    encryptDb(plain, join(rawMsg, 'message_0.db'))
    writeFileSync(join(decMsg, 'message_0.db'), zeroTail(fullBytes).subarray(0, 20 * PAGE_SZ))
    const bad = [3, 99]
    const r = await syncMessageShard(rawMsg, decMsg, 'message_0.db', RAW_KEY_HEX, 'wx_key_v4.1', 'full', undefined, bad)
    const target = readFileSync(join(decMsg, 'message_0.db'))
    expect(target.equals(zeroTail(fullBytes)), '安全网必须兜住：最终快照完整').toBe(true)
    expect(r.fullPages).toBe(fullBytes.length / PAGE_SZ)
    // 2026-10-18：被拒时要如实报出是哪条增量路径（sync.ts 用它做自适应止损 + 诊断日志）。
    expect(r.rejected, '差分被拒必须标记回退来源').toBe('page-diff')
    expect(r.rejectReason, '拒绝原因要带页/WAL 帧诊断，否则线上只能看到整库重解').toContain('patched=')
  })
})

describe('sync.ts 的差分接线（源码锚点）', () => {
  const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/query/sync.ts'), 'utf8')

  it('哨兵：sync.ts 真的读到了（读空 ⇒ 下面的断言全恒真）', () => {
    expect(SRC.length).toBeGreaterThan(500)
  })

  it('差分必须真参与判定：指纹比对、占比上限、坏形状回退都接在同步循环里', () => {
    expect(SRC, '指纹比对被摘掉（差分退化成摆设）').toContain('diffPageIndexes(hashEntry.hashes, curHashes)')
    expect(SRC, '指纹必须与源签名绑定（过期指纹会把变了判成没变）').toContain('hashEntry.sig === prevMain')
    expect(SRC, '变化页占比上限必须参与判定').toContain('DIFF_MAX_CHANGED_RATIO')
    expect(SRC, '差分路径必须过 quick_check 才发布').toContain('kind + \' patch quick_check failed for \' + file')
    expect(SRC, '成功路径必须按实际走的路径记账（回退到全量时不许谎报 diff）').toContain('const label = r.via')
  })
})
