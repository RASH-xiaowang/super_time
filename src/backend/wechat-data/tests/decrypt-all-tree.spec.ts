/**
 * 「立即解密」整树解密（P1-7：`query/decrypt-all.ts` 此前零 spec 引用 —— 核心解密流程无回归保护）。
 *
 * ## 这份用例存在的理由
 *
 * 这是全项目**唯一**把用户的加密库整棵树搬进解密快照的地方，一次跑错不是显示不对，
 * 而是「解密目录里留下的东西被面板当真」。风险清单里最贵的三条：
 *   ① 发布必须是**原子替换**：旧实现是 `unlinkSync(target)` + `renameSync(staged, target)`，
 *      那会在「已删除」与「已改名」之间留出一个「目标不存在」的窗口，并发只读查询正好落在
 *      里面就是 ENOENT；而 Windows 上目标被 SQLite 打开时 `unlink` 直接 EBUSY ⇒ 一整库被
 *      记成失败。`sync.ts#atomicReplace` 早就修过这件事并写了同名注释 —— **同一个属性必须有
 *      同一个主人**，所以这里钉的是「decrypt-all 走的是那份实现」，而「替换期间目标始终存在」
 *      由 `sync-publish.spec.ts`/`atomicReplace` 自己的用例守（见下面那条接线判据）。
 *   ② 单个库解密失败**不许**中断整棵树（用户要的是「其余照常」），也不许留下半截 `.decrypt_tmp`；
 *   ③ 每库独立密钥（`all_keys.json`）优先于配置里的兜底密钥 —— 多账号机器上读错就是全库乱码。
 *
 * 夹具是**合成的 SQLCipher4 页**（加密侧与本仓 `sync-wal.spec.ts` 同一套写法），不碰真实微信文件。
 * @vitest-environment node
 */
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decryptAllDbs } from '../src/query/decrypt-all.ts'
import { looksDecrypted, plausibleSqliteHeader } from '../src/query/sync.ts'
import { writeSqlitePage1Header } from '../../tests/helpers/sqlite-page1.ts'

const PAGE_SZ = 4096
const RESERVE_SZ = 80
const SQLITE_HDR = 'SQLite format 3\x00'
const RAW_KEY = '4304020f3020400d967181c0f2f68a45ae9eb6e806f442a2a96c470e7fb62e34'
const OTHER_KEY = '1111111111111111111111111111111111111111111111111111111111111111'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

/** wx_key_v4.1 的密钥派生（与 sync.ts / decrypt-all.ts 同口径：PBKDF2-HMAC-SHA512, 256000）。 */
function derive(rawKeyHex: string, salt: Buffer): Buffer {
  return pbkdf2Sync(Buffer.from(rawKeyHex, 'hex'), salt, 256_000, 32, 'sha512')
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
  enc.copy(page, pgno === 1 ? 16 : 0)
  iv.copy(page, PAGE_SZ - RESERVE_SZ)
  return page
}

/**
 * 造一个「raw db_storage 里有一个加密库」的场景。
 * @param rawDir - raw db_storage 目录本身（不是数据根）。
 * @param rel - 相对 rawDbDir 的路径（如 `message/msg_0.db`）。
 * @param rawKeyHex - 用来派生该库密钥的原始 key。
 * @param marker - 明文页里填的字节，用来验证内容真的解出来了。
 * @returns 写出的相对路径（原样返回，方便断言）。
 */
function makeEncryptedDb(rawDir: string, rel: string, rawKeyHex = RAW_KEY, marker = 0x5a): string {
  const file = join(rawDir, rel)
  mkdirSync(dirname(file), { recursive: true })
  const salt = Buffer.from('a'.repeat(16) + rel.length.toString(16).padStart(2, '0')).subarray(0, 16)
  const encKey = derive(rawKeyHex, salt)
  const plain1 = Buffer.alloc(PAGE_SZ, marker)
  // 页 1 头部要写得**像一个真库**：偏移 16-17 的页大小、18/19 的读写格式、
  // 21/22/23 的三个 payload fraction（SQLite 规范写死 64/32/32）。`plausibleSqliteHeader`
  // 现在这几维都看，夹具只填页大小的话，解出来的东西会被自己的判据拒掉。
  writeSqlitePage1Header(plain1, PAGE_SZ)
  const plain2 = Buffer.alloc(PAGE_SZ, marker + 1)
  writeFileSync(file, Buffer.concat([
    encryptPage(plain1, 1, encKey, salt),
    encryptPage(plain2, 2, encKey, randomBytes(16)),
  ]))
  return rel
}

/** 建好数据根与配置，返回 `{raw, decrypted}` 两个目录。 */
function makeRoots(cfg: Record<string, unknown>): { root: string; raw: string; decrypted: string } {
  const root = mkdtempSync(join(tmpdir(), 'decrypt-all-'))
  scratch.push(root)
  const raw = join(root, 'raw')
  const decrypted = join(root, 'decrypted')
  mkdirSync(raw, { recursive: true })
  mkdirSync(decrypted, { recursive: true })
  writeFileSync(join(root, 'config.json'), JSON.stringify(cfg), 'utf8')
  return { root, raw, decrypted }
}

const listFiles = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[]

describe('decryptAllDbs：成功路径', () => {
  it('合成库整树解密：目录结构镜像、内容真是解出来的、没有 .decrypt_tmp 残留', async () => {
    const { raw, decrypted } = makeRoots({ db_enc_key: RAW_KEY, key_format: 'wx_key_v4.1' })
    makeEncryptedDb(raw, 'message/msg_0.db')
    makeEncryptedDb(raw, 'contact/contact.db', RAW_KEY, 0x21)

    const res = await decryptAllDbs(raw, decrypted)
    expect(res).toMatchObject({ ok: true, total: 2, okCount: 2, failed: [] })

    const out = join(decrypted, 'message', 'msg_0.db')
    const bytes = readFileSync(out)
    expect(bytes.subarray(0, 16).toString('utf8'), '解密产物必须能被 sqlite 打开（页 1 头部）').toBe(SQLITE_HDR)
    // 内容判据：页 2 的明文是我们的 marker+1，不是零、也不是原样透传的密文
    expect(bytes.subarray(PAGE_SZ, PAGE_SZ + 8).every((b) => b === 0x5b), '页内容没被真正解出来').toBe(true)
    const contact = readFileSync(join(decrypted, 'contact', 'contact.db'))
    expect(contact.subarray(PAGE_SZ, PAGE_SZ + 4).every((b) => b === 0x22)).toBe(true)

    // 临时文件不许留下（下一次「立即解密」不该读到上一次的半截）
    expect(listFiles(decrypted).filter((f) => f.includes('.decrypt_tmp')), '留下了半截临时文件').toEqual([])
  })

  it('进度回调每个库恰好一次、计数单调，并且**库与库之间让出过事件循环**（否则轮询进度的 RPC 会被饿死）', async () => {
    const { raw, decrypted } = makeRoots({ db_enc_key: RAW_KEY, key_format: 'wx_key_v4.1' })
    for (const rel of ['a.db', 'b.db', 'c.db']) makeEncryptedDb(raw, rel)
    const seen: Array<[number, number, number]> = []
    // 自己排队的 0ms 定时器：只要解密循环把事件循环交还出来，它们就会跑（用例结束后停掉）
    let alive = true
    let ticks = 0
    const ping = (): void => {
      if (!alive) return
      setTimeout(() => { ticks += 1; ping() }, 0)
    }
    ping()
    const res = await decryptAllDbs(raw, decrypted, (done, total, failed) => { seen.push([done, total, failed]) })
    alive = false
    expect(seen).toEqual([[1, 3, 0], [2, 3, 0], [3, 3, 0]])
    expect(ticks, '整个循环一次都没让出事件循环 ⇒ 进度查询与实时同步都被钉死').toBeGreaterThan(0)
    expect(res.okCount).toBe(3)
  })

  it('密钥放在 all_keys.json 的**每库一条**里也要能用（多账号机器上兜底密钥是错的）', async () => {
    const { root, raw, decrypted } = makeRoots({ db_enc_key: RAW_KEY, key_format: 'wx_key_v4.1' })
    makeEncryptedDb(raw, 'message/msg_9.db', OTHER_KEY)
    writeFileSync(join(root, 'all_keys.json'), JSON.stringify({ 'message/msg_9.db': { key: OTHER_KEY } }), 'utf8')
    const res = await decryptAllDbs(raw, decrypted)
    expect(res).toMatchObject({ ok: true, okCount: 1 })
    // 反证：把 per-file 条目去掉就**必须**解不出来，否则上面那条是恒真
    rmSync(join(root, 'all_keys.json'))
    rmSync(join(decrypted, 'message', 'msg_9.db'), { force: true })
    expect((await decryptAllDbs(raw, decrypted)).ok, '兜底密钥居然解开了另一个 key 的库').toBe(false)
  })

  it('all_keys.json 是坏 JSON 时退回配置密钥，不抛（老版本写过一半的键文件很常见）', async () => {
    const { root, raw, decrypted } = makeRoots({ db_enc_key: RAW_KEY, key_format: 'wx_key_v4.1' })
    makeEncryptedDb(raw, 'session/session.db')
    writeFileSync(join(root, 'all_keys.json'), '{ this is not json', 'utf8')
    expect(await decryptAllDbs(raw, decrypted)).toMatchObject({ ok: true, okCount: 1 })
  })
})

describe('decryptAllDbs：失败必须局部化', () => {
  it('其中一个库密钥不对 ⇒ 只有它失败、其余照常成功，失败原因写的是「密钥不匹配」而不是「不存在」', async () => {
    const { raw, decrypted } = makeRoots({ db_enc_key: RAW_KEY, key_format: 'wx_key_v4.1' })
    makeEncryptedDb(raw, 'good.db')
    makeEncryptedDb(raw, 'bad.db', OTHER_KEY)
    const res = await decryptAllDbs(raw, decrypted)
    expect(res.total).toBe(2)
    expect(res.okCount, '一个库坏了就整树停手 ⇒ 用户永远等不到其余数据').toBe(1)
    expect(res.failed).toHaveLength(1)
    expect(res.failed[0]?.db, '失败项要能定位到是哪个库（正斜杠相对路径）').toBe('bad.db')
    expect(res.failed[0]?.error).toMatch(/密钥/)
    expect(existsSync(join(decrypted, 'good.db'))).toBe(true)
    expect(existsSync(join(decrypted, 'bad.db')), '校验失败的库也被发布了 ⇒ 面板会把乱码当数据读').toBe(false)
  })

  it('坏库**不许**覆盖已有的正确快照（解密失败要留下上一次能用的东西）', async () => {
    const { raw, decrypted } = makeRoots({ db_enc_key: RAW_KEY, key_format: 'wx_key_v4.1' })
    const rel = makeEncryptedDb(raw, 'message/msg_0.db')
    const target = join(decrypted, rel)
    expect((await decryptAllDbs(raw, decrypted)).ok).toBe(true)
    const before = readFileSync(target)

    // 现在把这个库换成另一个密钥的库：解密必然失败，而旧快照必须原样还在
    makeEncryptedDb(raw, 'message/msg_0.db', OTHER_KEY)
    const res = await decryptAllDbs(raw, decrypted)
    expect(res.ok).toBe(false)
    expect(existsSync(target), '失败的一轮把可用快照删掉了 —— 这正是 unlink-再-rename 的窗口').toBe(true)
    expect(readFileSync(target).equals(before), '旧快照被动过').toBe(true)
    expect(listFiles(decrypted).filter((f) => f.includes('.decrypt_tmp')), '失败后残留临时文件').toEqual([])
  })

  it('文件小于一个页 ⇒ 报「文件过小」，不产生目标文件', async () => {
    const { raw, decrypted } = makeRoots({ db_enc_key: RAW_KEY })
    writeFileSync(join(raw, 'tiny.db'), Buffer.alloc(8, 7))
    const res = await decryptAllDbs(raw, decrypted)
    expect(res.failed[0]?.error).toContain('文件过小')
    expect(existsSync(join(decrypted, 'tiny.db'))).toBe(false)
  })
})

describe('decryptAllDbs：配置不合法时给的是「下一步做什么」', () => {
  it('目录不存在 ⇒ 一句话里带上路径与「检测账号」', async () => {
    const { root, decrypted } = makeRoots({ db_enc_key: RAW_KEY })
    const res = await decryptAllDbs(join(root, 'nope'), decrypted)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('数据库目录不存在')
    expect(res.error).toContain('检测账号')
    expect(res.total).toBe(0)
  })

  it('目录为空串 ⇒ 是「未配置」而不是「不存在」（两条文案指向不同的下一步）', async () => {
    const { decrypted } = makeRoots({ db_enc_key: RAW_KEY })
    const res = await decryptAllDbs('', decrypted)
    expect(res.error).toContain('未配置')
    expect(res.error).not.toContain('不存在')
  })

  it('缺 64 位密钥 ⇒ 直接拒，不开始任何读写', async () => {
    const { raw, decrypted } = makeRoots({ db_enc_key: 'abc', key_format: 'wx_key_v4.1' })
    makeEncryptedDb(raw, 'a.db')
    const res = await decryptAllDbs(raw, decrypted)
    expect(res.error).toContain('64 位数据库密钥')
    expect(listFiles(decrypted), '还没验密钥就动了目标目录').toEqual([])
  })

  it('64 位但不是合法 hex ⇒ 报「不是合法的 64 位 hex」（与「没配」是两件事）', async () => {
    const { raw, decrypted } = makeRoots({ db_enc_key: 'z'.repeat(64) })
    makeEncryptedDb(raw, 'a.db')
    const res = await decryptAllDbs(raw, decrypted)
    expect(res.error).toContain('合法的 64 位 hex')
  })
})

describe('「解对了没有」的判据（sync 与全量解密共用同一个主人）', () => {
  /**
   * 造一个页 1 头部：前 16 字节是合成魔数，16-17 是页大小，其余按 SQLite 规范填常数。
   * @param pageSizeField - 偏移 16-17 的页大小编码（`1` 表示 65536）。
   * @param fill - 其余字节的填充值（真库里 18/19/21/22/23 会被逐个覆盖成合法值）。
   * @returns 24 字节的头部缓冲。
   */
  const page1 = (pageSizeField: number, fill = 0x5a): Buffer => {
    const b = Buffer.alloc(24, fill)
    Buffer.from('SQLite format 3\x00', 'utf8').copy(b, 0)
    b.writeUInt16BE(pageSizeField, 16)
    b[18] = 1   // read version
    b[19] = 1   // write version
    b[21] = 64  // max embedded payload fraction（规范写死）
    b[22] = 32  // min embedded payload fraction
    b[23] = 32  // leaf embedded payload fraction
    return b
  }

  it('魔数之外还要看页大小 —— 只比魔数的旧判据对**任何**解密结果都为真', () => {
    // 旧实现：`head.subarray(0,15).equals(SQLITE_HDR.subarray(0,15))`，而 decryptPage 给页 1
    // 无条件贴上魔数 ⇒ 错密钥也过。这条用「内容全是乱码填充、只有页大小字段不同」把两者分开。
    expect(plausibleSqliteHeader(page1(PAGE_SZ)), '真库（4096 页）被判成无效').toBe(true)
    expect(plausibleSqliteHeader(page1(1)), '65536 在头部里编码成 1，也被判成无效').toBe(true)
    expect(plausibleSqliteHeader(page1(0x5a5a)), '乱码页大小居然通过 ⇒ 这道闸门还是形同虚设').toBe(false)
    expect(plausibleSqliteHeader(page1(256)), '256 不是合法的 SQLite 页大小').toBe(false)
    expect(plausibleSqliteHeader(page1(600)), '600 不是 2 的幂').toBe(false)
    expect(plausibleSqliteHeader(Buffer.alloc(24))).toBe(false)
    expect(plausibleSqliteHeader(Buffer.alloc(16)), '长度不够时必须先拒（readUInt16BE 会越界）').toBe(false)
  })

  /**
   * 页大小那一维单独只有约 0.02% 的撞中率 —— 一次全量解密要判几百个库、每轮同步都在判，
   * 跑得够久就撞得上一次。下面这几条把「规范写死的常数」也变成判据（合起来约 10⁻¹²）。
   */
  it('页大小对、但其余头部是乱码 ⇒ 仍然要判无效（0.02% 不是可以赌的余量）', () => {
    const badFormat = page1(PAGE_SZ)
    badFormat[18] = 7
    expect(plausibleSqliteHeader(badFormat), '读格式不是 1/2 也放行了').toBe(false)
    const badWrite = page1(PAGE_SZ)
    badWrite[19] = 0
    expect(plausibleSqliteHeader(badWrite), '写格式不是 1/2 也放行了').toBe(false)
    for (const [at, name] of [[21, 'max payload'], [22, 'min payload'], [23, 'leaf payload']] as const) {
      const bad = page1(PAGE_SZ)
      bad[at] = 0x5a
      expect(plausibleSqliteHeader(bad), `${name} 是规范常数，改错也必须判无效`).toBe(false)
    }
    // 反向哨兵：reserved（偏移 20）在微信那类库里是 80，不是 0 —— 不许拿它当判据。
    const withReserve = page1(PAGE_SZ)
    withReserve[20] = 80
    expect(plausibleSqliteHeader(withReserve), '把 reserved 当常数校验 ⇒ 真库会被整批判成无效').toBe(true)
  })

  it('looksDecrypted 读的是文件头 24 字节，且对不存在的文件回 false 而不是抛', () => {
    const root = mkdtempSync(join(tmpdir(), 'hdr-'))
    scratch.push(root)
    const good = join(root, 'good.db')
    const bytes = Buffer.alloc(PAGE_SZ, 0x33)
    plausibleSqliteHeader(Buffer.alloc(0)) // 只为让上面那条的口径在这里可见
    page1(PAGE_SZ).copy(bytes, 0)
    writeFileSync(good, bytes)
    expect(looksDecrypted(good)).toBe(true)
    writeFileSync(join(root, 'junk.db'), Buffer.alloc(PAGE_SZ, 0x7f))
    expect(looksDecrypted(join(root, 'junk.db'))).toBe(false)
    expect(looksDecrypted(join(root, 'missing.db'))).toBe(false)
  })
})

describe('发布必须走 sync.ts 那份原子替换（接线判据）', () => {
  const src = readFileSync(join(dirname(__dirname), 'src', 'query', 'decrypt-all.ts'), 'utf8')

  it('decrypt-all 引用 atomicReplace，且不再自己 unlink/rename 目标文件', () => {
    // 「替换期间目标始终存在」这个属性已经由 sync.ts 的用例守住；
    // 这里只守一件事：全量解密**没有绕过它**。绕过了就会把 P0-1 那轮修掉的窗口重新打开。
    expect(src).toMatch(/import \{[^}]*atomicReplace[^}]*\} from '\.\/sync\.ts'/)
    expect(src).toContain('await atomicReplace(staged, target)')
    expect(src, '又退回「先删再改名」：中间那段窗口里并发只读查询会拿到 ENOENT')
      .not.toMatch(/unlinkSync\(\s*target\s*\)/)
    expect(src).not.toMatch(/renameSync\(\s*staged\s*,\s*target\s*\)/)
  })

  it('目标目录里出现过的文件名都要能对上（防止把 .decrypt_tmp 当成快照发布出去）', async () => {
    const { raw, decrypted } = makeRoots({ db_enc_key: RAW_KEY })
    makeEncryptedDb(raw, 'x.db')
    const res = await decryptAllDbs(raw, decrypted)
    expect(res.okCount).toBe(1)
    expect(listFiles(decrypted)).toEqual(['x.db'])
    expect(statSync(join(decrypted, 'x.db')).size).toBe(PAGE_SZ * 2)
  })

  it('全量解密**不许**自己 unlink 目标：这条判据在源码层钉住（行为由 sync.ts 的 atomicReplace 用例守）', () => {
    // 为什么用源码判据而不是行为判据：「替换期间目标始终存在」这件事，
    // 用一个并发只读查询去撞那个窗口是不可靠的（时间太短），而 sync.ts 的
    // `atomicReplace` 自己的回归用例已经证明它不删目标；这里只需要钉「走的是同一份实现」。
    expect(src, '又出现了直接 rename：那之前必然有一个 unlink 窗口').not.toMatch(/renameSync\(/)
    expect(src).toMatch(/await atomicReplace\(\s*staged,\s*target\s*\)/)
  })
})
