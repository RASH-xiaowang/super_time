/**
 * `fetchDbKey` 必须**先试已经知道的密钥**，而不是无条件扫 33 秒进程内存（2026-09-29 实测的 bug）。
 *
 * ## 为什么要锁住这条
 *
 * 真机复现：`all_keys.json` 里 10 个库写着同一把 `valid: true` 的密钥、实时同步正用它解库，
 * 而点一次「一键获取数据库密钥」仍然扫 33 秒内存，**这一次还失败了** —— 界面回
 * `✗ 候选密钥均未通过 SQLCipher 校验`，同一时刻后台却在刷 `[wechat-sync] updated: … full(…)`。
 * 用户会以为密钥坏了并去折腾，而系统其实完全正常。
 *
 * ## 判据口径（断言行为，不断言源码）
 *
 *   ① 已存的密钥能过页 1 校验时：**立即**返回它，`source` 指出它来自哪份存档；
 *   ② 已存的密钥过不了校验时：**不许**拿它冒充成功（否则就是"永远说好"）；
 *   ③ 耗时上界：内存扫描是 33 秒量级（真机实测 33345ms），所以"1 秒内返回"本身
 *      就是"没去扫内存"的行为证据 —— 比 spy 内部函数更抗重构。
 *
 * 夹具是**真的** SQLCipher 4 页 1（按 `db-key-verify.ts` 的公式反向构造：
 * PBKDF2 + HMAC-SHA512 + AES-CBC），不是桩 —— 桩测不出"校验到底认不认这把钥匙"。
 * @vitest-environment node
 */
import { createCipheriv, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { accountKeySlotFor, dbKeySlotFor, fetchDbKey } from '../src/keys/service.ts'
import { getAccountKeysFromStore, loadAccountKeysStore, upsertAccountKeysInStore } from '../src/keys/key-store.ts'
import { DECRYPTED_DIR_ENV } from '../src/dirs.ts'

const PAGE_SZ = 4096
const SALT_SZ = 16
const IV_SZ = 16
const HMAC_SZ = 64
const RESERVE_SZ = 80
const PBKDF2_ITERS = 256000

const scratch: string[] = []
const savedEnv = process.env[DECRYPTED_DIR_ENV]
const SELF_ENV = 'DSH_WECHAT_SELF_WXID'
const savedSelf = process.env[SELF_ENV]
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (savedEnv === undefined) delete process.env[DECRYPTED_DIR_ENV]
  else process.env[DECRYPTED_DIR_ENV] = savedEnv
  if (savedSelf === undefined) delete process.env[SELF_ENV]
  else process.env[SELF_ENV] = savedSelf
})
beforeEach(() => {
  delete process.env[DECRYPTED_DIR_ENV]
  delete process.env[SELF_ENV]
})

function tempRoot(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `wx-dbkey-${tag}-`))
  scratch.push(dir)
  return dir
}

/**
 * 反向构造一个**能通过 `verifyDbKey` 的** SQLCipher 4 页 1。
 *
 * 依据（逐条对着 `db-key-verify.ts:56-79` 抄）：
 *   · `derivedKey = PBKDF2(key, salt, 256k, 32, sha512)`；
 *   · HMAC 覆盖 `page[16 .. PAGE-80+16)` 再拼上 pgno=1 的 4 字节小端，写在页尾 64 字节；
 *   · AES 校验只看"用 `D(C0) XOR "SQLite format 3\0"` 当 IV、CBC 解出的前 16 字节"，
 *     所以第一块密文可以任选（这里用 `E_derivedKey(随机块)`，保证它有解）。
 * @param key - 32 字节库密钥。
 * @returns 4096 字节的加密页。
 */
function makeSqlcipherPage1 (key: Buffer): Buffer {
  const salt = randomBytes(SALT_SZ)
  const derived = pbkdf2Sync(key, salt, PBKDF2_ITERS, 32, 'sha512')
  const page = Buffer.alloc(PAGE_SZ)
  salt.copy(page, 0)
  // 第 1 块密文：随便一个可解的块（CBC 的 IV 由它反推，见上面注释）。
  const firstBlock = createCipheriv('aes-256-ecb', derived, null).update(randomBytes(16))
  firstBlock.copy(page, 16)
  randomBytes(PAGE_SZ - RESERVE_SZ - 16 - IV_SZ).copy(page, 32) // 其余密文体（只需长度对齐）
  const iv = randomBytes(IV_SZ)
  iv.copy(page, PAGE_SZ - RESERVE_SZ)
  // HMAC：与 verifyDbKey 的 hmacData / pgno 完全一致。
  const macSalt = Buffer.from(salt.map((b) => b ^ 0x3a))
  const macKey = pbkdf2Sync(derived, macSalt, 2, 32, 'sha512')
  const mac = createHmac('sha512', macKey)
  mac.update(page.subarray(16, PAGE_SZ - RESERVE_SZ + IV_SZ))
  const pgno = Buffer.alloc(4)
  pgno.writeUInt32LE(1, 0)
  mac.update(pgno)
  mac.digest().copy(page, PAGE_SZ - HMAC_SZ)
  return page
}

/** 造一个数据根：`decrypted/message/probe.db` 用 `key` 加密，另按需写 config/all_keys。 */
function makeRoot (key: Buffer, opts: { allKeysKey?: string; configKey?: string } = {}): { decrypted: string; probe: string } {
  const root = tempRoot('root')
  const decrypted = join(root, 'decrypted')
  mkdirSync(join(decrypted, 'message'), { recursive: true })
  const probe = join(decrypted, 'message', 'probe.db')
  writeFileSync(probe, makeSqlcipherPage1(key))
  if (opts.allKeysKey !== undefined) {
    writeFileSync(join(root, 'all_keys.json'), JSON.stringify({
      _key_format: 'wx_key_v4.1',
      _db_dir: join(root, 'db_storage'),
      'message/probe.db': { key: opts.allKeysKey, valid: true },
    }, null, 2))
  }
  if (opts.configKey !== undefined) {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ db_dir: join(root, 'db_storage'), db_enc_key: opts.configKey }, null, 2))
  }
  return { decrypted, probe }
}

describe('fetchDbKey：已存的密钥可用时不许再扫内存', () => {
  it('all_keys.json 里的密钥能过页 1 校验 ⇒ 直接返回它，且 1 秒内完成（没扫内存）', async () => {
    const key = randomBytes(32)
    const { decrypted, probe } = makeRoot(key, { allKeysKey: key.toString('hex') })
    process.env[DECRYPTED_DIR_ENV] = decrypted

    const t0 = Date.now()
    const r = await fetchDbKey({ dbPath: probe })
    const ms = Date.now() - t0
    expect(r.ok, r.error).toBe(true)
    expect(r.key).toBe(key.toString('hex'))
    expect(r.source).toBe('saved_all_keys')
    // 内存扫描是 33 秒量级；1 秒内返回 = 走了快路径（比 spy 内部实现更抗重构）。
    expect(ms, `用了 ${String(ms)}ms ⇒ 疑似又去扫内存了`).toBeLessThan(1000)
  })

  it('配置里的 db_enc_key 优先，且坏密钥不会被当成功（逐个真校验）', async () => {
    const key = randomBytes(32)
    const wrong = randomBytes(32).toString('hex')
    // all_keys 里放一把**错的**，config 里放对的 ⇒ 必须跳过错的、用对的。
    const { decrypted, probe } = makeRoot(key, { allKeysKey: wrong, configKey: key.toString('hex') })
    process.env[DECRYPTED_DIR_ENV] = decrypted

    const r = await fetchDbKey({ dbPath: probe })
    expect(r.ok, r.error).toBe(true)
    expect(r.key).toBe(key.toString('hex'))
    expect(r.source).toBe('saved_config')
  })

  it('第一个候选是坏的就必须跳过它（证明校验是真的，不是"拿第一个就返回"）', async () => {
    // ⚠️ 这里**故意不做**"所有候选都坏 ⇒ 应该 ok:false"的用例：
    // 那条路径会落到 33 秒的进程内存扫描上（测试机上微信可能正开着），
    // 一个单测不该为此花半分钟。它要证明的性质（坏密钥不许冒充成功）由本用例覆盖：
    // 若实现是"取第一个候选直接返回"，`source` 会是 `saved_all_keys` 且 key 是那把坏的。
    const key = randomBytes(32)
    const wrong = randomBytes(32).toString('hex')
    const { decrypted, probe } = makeRoot(key, { allKeysKey: wrong, configKey: key.toString('hex') })
    process.env[DECRYPTED_DIR_ENV] = decrypted

    const r = await fetchDbKey({ dbPath: probe })
    expect(r.key).not.toBe(wrong)
    expect(r.key).toBe(key.toString('hex'))
    expect(r.source).toBe('saved_config')
  })
})

/**
 * W2-2.2 的 db_key 侧：数据库密钥同样按账号分槽，否则一台机器两个账号会互相覆盖。
 * 与图片密钥共用「归属明确才判、没证据放行」的口径；老库仍从全局槽读。
 */
describe('W2-2.2：db_key 按账号分槽，且老库继续可读', () => {
  const SELF = 'wxid_current'
  const OTHER = 'wxid_previous'

  it('自己槽里的库密钥优先于 all_keys，且能通过真实页 1 校验', async () => {
    const key = randomBytes(32)
    const wrong = randomBytes(32).toString('hex')
    const { decrypted, probe } = makeRoot(key, { configKey: wrong })
    const root = dirname(decrypted)
    process.env[SELF_ENV] = SELF
    process.env[DECRYPTED_DIR_ENV] = decrypted
    upsertAccountKeysInStore(SELF, {
      db_key: key.toString('hex'),
      db_key_source_wxid_dir: SELF,
    }, root)

    const r = await fetchDbKey({ dbPath: probe })
    expect(r.ok, r.error).toBe(true)
    expect(r.key).toBe(key.toString('hex'))
    expect(r.source).toBe('saved_store')
  })

  it('全局槽里明确属于别的账号的 db_key 不拿来硬解', async () => {
    const key = randomBytes(32)
    const { decrypted, probe } = makeRoot(key, { allKeysKey: key.toString('hex') })
    const root = dirname(decrypted)
    process.env[SELF_ENV] = SELF
    process.env[DECRYPTED_DIR_ENV] = decrypted
    upsertAccountKeysInStore('default', {
      // 这把库密钥本身对当前库是**可用的**：只有归属校验会拒绝它。
      // 若实现是「全局槽来者不拒」，这里就会直接返回它并报 saved_store。
      db_key: key.toString('hex'),
      db_key_source_wxid_dir: OTHER,
    }, root)

    const r = await fetchDbKey({ dbPath: probe })
    expect(r.ok, r.error).toBe(true)
    expect(r.key).toBe(key.toString('hex'))
    // 跳过了别人家的全局槽，落到 all_keys；硬拿别人的密钥是这里要防的病。
    expect(r.source).toBe('saved_all_keys')
  })

  it('老库：db_key 只在全局槽且没有归属信息 => 继续可读（升级不要求重新取钥）', async () => {
    const key = randomBytes(32)
    const { decrypted, probe } = makeRoot(key)
    const root = dirname(decrypted)
    process.env[SELF_ENV] = SELF
    process.env[DECRYPTED_DIR_ENV] = decrypted
    upsertAccountKeysInStore('default', { db_key: key.toString('hex') }, root)

    const r = await fetchDbKey({ dbPath: probe })
    expect(r.ok, r.error).toBe(true)
    expect(r.key).toBe(key.toString('hex'))
    expect(r.source).toBe('saved_store')
  })

  it('自动取到的 db_key 写进当前账号槽，不再覆盖全局槽', async () => {
    const key = randomBytes(32)
    const { decrypted, probe } = makeRoot(key, { allKeysKey: key.toString('hex') })
    const root = dirname(decrypted)
    process.env[SELF_ENV] = SELF
    process.env[DECRYPTED_DIR_ENV] = decrypted

    const r = await fetchDbKey({ dbPath: probe })
    expect(r.ok, r.error).toBe(true)
    expect(getAccountKeysFromStore(SELF, root).db_key).toBe(key.toString('hex'))
    expect(loadAccountKeysStore(root)['default']).toBeUndefined()
  })
})

/** 写入侧槽名选择：与 imageKeySlotFor 同口径。 */
describe('W2-2.2：dbKeySlotFor 选槽', () => {
  it('wxid 形状（含目录后缀）归一化到自己槽', () => {
    expect(accountKeySlotFor('wxid_alpha000_abcd')).toBe('wxid_alpha000')
  })

  it('别名目录或空值退回全局槽', () => {
    expect(accountKeySlotFor('alice_2024')).toBe('default')
    expect(accountKeySlotFor(undefined)).toBe('default')
  })

  it('dbKeySlotFor 把当前账号接进选槽（这里用 env 固定，不依赖测试机账号）', () => {
    process.env[SELF_ENV] = 'wxid_alpha000'
    expect(dbKeySlotFor('unused-decrypted')).toBe('wxid_alpha000')
  })
})

/** 接线判据：service.ts 里 db_key 的 upsert 不能写回固定全局槽。 */
describe('W2-2.2 接线：db_key 写入点都按账号分槽', () => {
  const service = readFileSync(new URL('../src/keys/service.ts', import.meta.url), 'utf8')

  function bareDbKeyWrites(src: string): string[] {
    const noComment = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    const out: string[] = []
    for (const part of noComment.split('upsertAccountKeysInStore(').slice(1)) {
      const call = part ?? ''
      if (!/db_key\b/.test(call)) continue
      out.push(call.trim().slice(0, 60))
    }
    return out
  }

  it('没有裸写 db_key 到固定槽的调用', () => {
    const fixed = bareDbKeyWrites(service).filter((call) => call.startsWith("'default'"))
    expect(fixed, '这些 db_key 写入点还在写固定全局槽 ⇒ 同机多账号会互相覆盖').toEqual([])
  })

  it('把分槽变量换回默认槽这条判据会红（不是恒真）', () => {
    const fake = service.replace(/upsertAccountKeysInStore\(slot,/g, "upsertAccountKeysInStore('default',")
    expect(bareDbKeyWrites(fake).filter((call) => call.startsWith("'default'")).length,
      '把 slot 换回固定全局槽居然没抓到 ⇒ 这条判据是空转的').toBeGreaterThan(0)
  })
})
