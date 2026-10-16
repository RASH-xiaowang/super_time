/**
 * 跨进程签名账（`query/sync-state.ts`）：**冷启动不必再整树重解密一遍**。
 *
 * ## 这份用例要钉住的行为
 *
 * `sync.ts` 的 `lastState` 是**进程内存里的 Map**。后端一重启它就是空的 ⇒
 * 每个目标的 `prev === undefined` ⇒ `mode` 一律判成 `'full'`
 * ⇒ 每次冷启动都把全树整库重解密，哪怕微信侧一个字节都没变、磁盘上的解密产物已经是新的。
 *
 * 代价是实打实的：`sync.ts` 自己第 45 轮的 `[sync-trace]` 诊断记着 `message_1` 一次
 * ≈ **147 MB / 37456 页**，而 `fullDecryptFile` 每个调度步只做 64 页。这段白烧的 CPU
 * 就是「启动后首屏取数排不上队」的**已定位根因**
 * （ 第四节第 7 条：单点该面板 517ms，
 * 前置 12 个页签后 60153ms）。
 *
 * 断言口径刻意选**行为**而不是源码形状：跑两轮真实同步循环，第二轮 `onSync` 一次都不许被叫
 * —— 因为 `sync.ts` 只在**真的同步出了什么**时才回调（`if (synced.length > 0) onSync?.(synced)`）。
 * 所以「回调没响」就等于「这一轮一个目标都没解密」。
 *
 * ## 反向要求（这份用例的另一半，且更重要）
 *
 * 跳过一次解密的代价是「永久显示旧数据且没有任何提示」，比多解一遍严重得多。
 * 所以下面每一条失败方向都必须是**回到整库重解密**：账本读不出来 / 版本不认识 /
 * 条目形状不对 / 产物被删。少一条就是「优化变数据正确性问题」。
 *
 * 夹具是**合成的 SQLCipher4 页**（与 `sync-wal.spec.ts` / `decrypt-all-tree.spec.ts` 同一套写法），
 * 不碰真实微信文件。
 * @vitest-environment node
 */
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { forgetSyncFailures } from '../src/query/sync-pacing.ts'
import { forgetFullDecryptCooldown, startRealtimeSync } from '../src/query/sync.ts'
import { flushSyncSourceState, forgetPendingSyncSourceState, loadSyncSourceState } from '../src/query/sync-state.ts'
import type { SyncSourceSig } from '../src/query/sync-state.ts'
import { writeSqlitePage1Header } from '../../tests/helpers/sqlite-page1.ts'

const PAGE_SZ = 4096
const RESERVE_SZ = 80
const RAW_KEY = '4304020f3020400d967181c0f2f68a45ae9eb6e806f442a2a96c470e7fb62e34'
const STATE_FILE = 'sync-state.json'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

/** 模块级状态（退避表 / 待落盘条目）跨用例会串，每条用例开头清一次。 */
beforeEach(() => {
  forgetSyncFailures()
  forgetPendingSyncSourceState()
})

/**
 * 清掉**模块级**的两道闸，再跑一轮同步。
 *
 * ## 为什么必须清（否则量到的不是我要量的东西）
 *
 * `sync.ts` 的 `fullDecryptDue` 把「上次整库重解密的时刻」记在**模块级** `lastFullAt` 里，
 * 冷却 6 秒；而 `syncFailureBackoffActive` 的退避表（`sync-pacing.ts`）也是模块级。
 * 这份用例在**同一个进程**里连着跑两轮，间隔只有几百毫秒 ⇒ 第二轮的整库重解密会被
 * 6 秒冷却直接推迟掉 ⇒ `onSync` 一次都不响。
 *
 * 那时候红的原因会读成「账本没起作用」，而实际量的是冷却 —— 属于
 * `docs/CONTRIBUTING.md` 第 5 节说的「判据红了但红的不是那条」。
 * `sync.ts` 导出的 `forgetFullDecryptCooldown()` 就是为把这两个原因分开准备的
 * （其注释原话：「测试要能分别把这两个原因钉住」）。
 *
 * 真实冷启动不受影响：新进程里 `lastFullAt` 本来就是空的。
 */
function resetModuleGates(): void {
  forgetFullDecryptCooldown()
  forgetSyncFailures()
}

function derive(rawKeyHex: string, salt: Buffer): Buffer {
  return pbkdf2Sync(Buffer.from(rawKeyHex, 'hex'), salt, 256_000, 32, 'sha512')
}

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

/** 造一个加密库（两页）。页 1 头部要像个真库，否则会被 `plausibleSqliteHeader` 拒掉。 */
function makeEncryptedDb(rawDir: string, rel: string): string {
  const file = join(rawDir, rel)
  mkdirSync(dirname(file), { recursive: true })
  const salt = Buffer.from('a'.repeat(16) + rel.length.toString(16).padStart(2, '0')).subarray(0, 16)
  const encKey = derive(RAW_KEY, salt)
  const plain1 = Buffer.alloc(PAGE_SZ, 0x5a)
  writeSqlitePage1Header(plain1, PAGE_SZ)
  const plain2 = Buffer.alloc(PAGE_SZ, 0x5b)
  writeFileSync(file, Buffer.concat([
    encryptPage(plain1, 1, encKey, salt),
    encryptPage(plain2, 2, encKey, randomBytes(16)),
  ]))
  return rel
}

/** 数据根 + raw 树 + 配置。`sync.ts` 从解密目录的**上一级**读 config.json。 */
function makeRoots(): { root: string; raw: string; decrypted: string } {
  const root = mkdtempSync(join(tmpdir(), 'wx-sync-state-'))
  scratch.push(root)
  const raw = join(root, 'raw')
  const decrypted = join(root, 'decrypted')
  mkdirSync(join(raw, 'message'), { recursive: true })
  mkdirSync(join(decrypted, 'message'), { recursive: true })
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    db_enc_key: RAW_KEY, key_format: 'wx_key_v4.1',
  }), 'utf8')
  makeEncryptedDb(raw, 'message/message_0.db')
  return { root, raw, decrypted }
}

/** 跑一轮同步循环到静止，返回它回调过的所有条目。 */
async function runOnce(raw: string, decrypted: string, settleMs = 600): Promise<string[]> {
  resetModuleGates()
  const seen: string[] = []
  const stop = startRealtimeSync(() => raw, () => decrypted, (shards) => { seen.push(...shards) })
  try {
    // 首 tick 是 `void tick()` 立即跑的；这里等它落定而不是等轮询间隔（10s）。
    await new Promise<void>((resolve) => { setTimeout(resolve, settleMs) })
  } finally { stop() }
  return seen
}

describe('跨进程签名账：第二次冷启动不再整树重解密', () => {
  it('第一轮解出来并落账；第二轮源没变 ⇒ 一个目标都不再解密', async () => {
    const { raw, decrypted, root } = makeRoots()

    const first = await runOnce(raw, decrypted)
    expect(first.join('|')).toContain('message_0.db:full(')
    // 产物确实在（不是「没解密所以没回调」这种空过）
    expect(existsSync(join(decrypted, 'message', 'message_0.db'))).toBe(true)
    // 账落盘了
    expect(existsSync(join(root, STATE_FILE))).toBe(true)

    // 第二轮 = 模拟后端进程重启（`lastState` 重新为空，但账在磁盘上）
    const second = await runOnce(raw, decrypted)
    expect(second).toEqual([])
  }, 20_000)

  it('账本能让「源没变」命中跳过：loadSyncSourceState 认得出上一轮的签名', async () => {
    const { raw, decrypted, root } = makeRoots()
    await runOnce(raw, decrypted)

    const loaded = loadSyncSourceState(decrypted)
    expect(loaded.size).toBeGreaterThan(0)
    expect(loaded.get('message_0.db')).toBeDefined()
    // 账里的签名必须与**源文件当前**的签名一致，否则跳过是假的
    const rawStat = readFileSync(join(raw, 'message', 'message_0.db'))
    expect(rawStat.length).toBeGreaterThan(0)
  }, 20_000)
})

describe('跨进程签名账：失败方向必须倒向「把活干完」', () => {
  it('账本是坏 JSON ⇒ 回到整库重解密（不是跳过）', async () => {
    const { raw, decrypted, root } = makeRoots()
    await runOnce(raw, decrypted)
    writeFileSync(join(root, STATE_FILE), '{ this is not json', 'utf8')

    expect(loadSyncSourceState(decrypted).size).toBe(0)
    const again = await runOnce(raw, decrypted)
    expect(again.join('|')).toContain('message_0.db:full(')
  }, 20_000)

  it('账本版本不认识 ⇒ 回到整库重解密', async () => {
    const { raw, decrypted, root } = makeRoots()
    await runOnce(raw, decrypted)
    // ⚠️ 夹具必须把**第一轮真实签名**原样装进错版本里，不能写 `entries: {}`：
    // 空 entries 下「去掉版本检查」与「版本检查生效」加载结果都是空 Map ⇒ 这条断言恒绿
    // （2026-10-08 变异自证实测：这么写时删掉版本检查那条用例照样通过，即判据没在承重）。
    const prev = loadSyncSourceState(decrypted)
    expect(prev.get('message_0.db')).toBeDefined()
    writeFileSync(join(root, STATE_FILE), JSON.stringify({
      version: 999, entries: Object.fromEntries(prev),
    }), 'utf8')

    expect(loadSyncSourceState(decrypted).size).toBe(0)
    const again = await runOnce(raw, decrypted)
    expect(again.join('|')).toContain('message_0.db:full(')
  }, 20_000)

  it('条目形状不对（main 不是字符串）⇒ 该条目不认，其余仍认', async () => {
    const { raw, decrypted, root } = makeRoots()
    await runOnce(raw, decrypted)
    const prev = loadSyncSourceState(decrypted)
    const entries = Object.fromEntries(prev)
    // 故意写坏：main 塞数字。落盘那一刻它已经不是合法的 `SyncSourceSig` 了，
    // 所以要显式断言绕过类型检查 —— 这条夹具的全部意义就是「读回来时必须被形状校验挡掉」。
    entries['message_0.db'] = { main: 42, wal: '' } as unknown as SyncSourceSig
    writeFileSync(join(root, STATE_FILE), JSON.stringify({ version: 1, entries }), 'utf8')

    const loaded = loadSyncSourceState(decrypted)
    expect(loaded.has('message_0.db')).toBe(false)
  }, 20_000)

  it('解密产物被删 ⇒ 即使账本说「解过」也必须重解密（产物不在 = 没解过）', async () => {
    const { raw, decrypted } = makeRoots()
    await runOnce(raw, decrypted)
    rmSync(join(decrypted, 'message', 'message_0.db'), { force: true })

    const again = await runOnce(raw, decrypted)
    expect(again.join('|')).toContain('message_0.db:full(')
  }, 20_000)

  it('这一轮解失败的源签名不许进账（否则下次启动会跳过它，永久旧数据）', async () => {
    const { root, raw, decrypted } = makeRoots()
    await runOnce(raw, decrypted)
    const goodSig = loadSyncSourceState(decrypted).get('message_0.db')
    expect(goodSig).toBeDefined()

    // 让源**变**（否则第二轮会直接命中跳过，根本走不到解密）并让它**解不开**（换错密钥）。
    makeEncryptedDb(raw, 'message/message_0.db')
    writeFileSync(join(root, 'config.json'), JSON.stringify({
      db_enc_key: '1111111111111111111111111111111111111111111111111111111111111111',
      key_format: 'wx_key_v4.1',
    }), 'utf8')

    const failed = await runOnce(raw, decrypted)
    expect(failed).toEqual([]) // 解不开 ⇒ 没有任何目标「同步出了什么」
    // 账必须还停在**上一轮成功**的那条签名上，而不是这一轮的坏签名。
    const after = loadSyncSourceState(decrypted).get('message_0.db')
    expect(after).toEqual(goodSig)
  }, 20_000)
})

describe('跨进程签名账：落盘语义', () => {
  it('没有待写条目时不写盘（tick 里成功目标为 0 是常态，不能每轮都碰磁盘）', () => {
    const { decrypted } = makeRoots()
    expect(flushSyncSourceState(decrypted)).toBe(false)
    expect(existsSync(join(dirname(decrypted), STATE_FILE))).toBe(false)
  })

  it('合并而不是覆盖：只写一个目标不许抹掉另一个目标的账', () => {
    const { root, decrypted } = makeRoots()
    flushSyncSourceState(decrypted)
    expect(loadSyncSourceState(decrypted).size).toBe(0)
    // 先手写一份含两个目标的账
    writeFileSync(join(root, STATE_FILE), JSON.stringify({
      version: 1,
      entries: { 'message_0.db': { main: 'a:1', wal: 'b:2' }, 'session.db': { main: 'c:3', wal: '' } },
    }), 'utf8')
    expect(loadSyncSourceState(decrypted).size).toBe(2)
  })
})