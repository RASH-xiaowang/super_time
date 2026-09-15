// @vitest-environment node
/**
 * N16 接线验收：批量取图 RPC 真的把「N 张图扫 N 次路径表」合并成**一次**。
 *
 * 判据是**查询条数**（探针挂在 `DatabaseSync.prototype.prepare` 上，只数含 `lower(md5)`
 * 的那条 SQL）：这是「合并没有」唯一不靠计时的判据 —— 计时在 CI 上会抖，而「30 张图查了
 * 几次路径表」是确定的。改前该语句是 `WHERE lower(md5) = ?` 全表扫（实测 20 万行
 * 17.27ms/次，30 张 ≈518ms），批量入口是一条 `IN (...)`。
 *
 * 同时钉住「批量答案 == 逐张答案」：批量的收益只有在结果不变的前提下才算收益。
 *
 * 诚实边界（写在用例里而不是藏在实现里）：
 *   ① 单张的 md5 仍各查一次消息分片（`resolveImageResourceHint`，`WHERE local_id = ?`）——
 *      那不是 N16 指的那条全表扫，也没有批量入口可用（`media-image.ts` 不在本轮写集内）；
 *   ② 这里造的是「解码缓存为空」的最坏情形：真实机器上多半直接命中 `decoded_images/`。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { WechatDataGateway } from '../src/gateway.ts'

const TALKER = 'wxid_n16_talker'
/** 一屏图片的数量（与 RELEASE-PLAN 里 30 张的实测口径一致）。 */
const IMAGE_COUNT = 30

let scratch = ''
let decrypted = ''
let decoded = ''
let base = ''
let disposers: Array<() => void> = []

/** Minimal Cordis Context surface the gateway touches (与 gateway-operation-log.spec.ts 同款)。 */
function fakeCtx(): Context {
  const effects: Array<() => void> = []
  disposers = effects
  return {
    reflect: { provide: () => {} },
    effect: (fn: () => undefined | (() => void)) => {
      const d = fn()
      if (typeof d === 'function') effects.push(d)
      return d
    },
    emit: () => {},
  } as unknown as Context
}

/** `Msg_<md5(username)>` 表名。 */
const tableName = (talker: string): string => 'Msg_' + createHash('md5').update(talker, 'utf8').digest('hex')

/** 第 i 张图的 md5（32 位十六进制）。 */
const md5Of = (i: number): string => String(i).padStart(32, 'a')
/** 2×2 的纯色 PNG（8 字节魔数够 `decodeDatBytes` 认成 png）。 */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

/**
 * 造一份最小可用夹具：消息分片（带 packed_info_data）+ hardlink.db + 真实 .dat 文件。
 *
 * 为什么三样都必要：md5 只能从消息里拿（`resolveImageResourceHint`）、路径只能从
 * hardlink 表拿（`resolveImageFilePathsByMd5`）、而两处都要求「行存在 + 磁盘上真有文件」。
 * @param count - 图片张数（local_id 从 1 连续编号）。
 */
function makeFixture(count: number): void {
  scratch = mkdtempSync(join(tmpdir(), 'n16-gateway-'))
  decrypted = join(scratch, 'decrypted')
  decoded = join(scratch, 'decoded')
  base = join(scratch, 'wechat-base')
  mkdirSync(join(decrypted, 'hardlink'), { recursive: true })
  mkdirSync(join(decrypted, 'message'), { recursive: true })
  mkdirSync(decoded, { recursive: true })

  // 消息分片：packed_info_data 里塞 protobuf 标记 + 32 位十六进制 md5（extractMd5FromPacked 的形态）。
  const shard = new DatabaseSync(join(decrypted, 'message', 'message_0.db'))
  try {
    shard.exec(`CREATE TABLE "${tableName(TALKER)}" (local_id INTEGER PRIMARY KEY, local_type INTEGER, packed_info_data BLOB)`)
    const ins = shard.prepare(`INSERT INTO "${tableName(TALKER)}" VALUES (?,?,?)`)
    for (let i = 0; i < count; i += 1) {
      const packed = Buffer.concat([Buffer.from([0x12, 0x22, 0x0a, 0x20]), Buffer.from(md5Of(i), 'utf8')])
      ins.run(i + 1, 3, packed)
    }
  } finally {
    shard.close()
  }

  // 路径表：行存 md5，file_name 指向真实的 .dat。
  const hl = new DatabaseSync(join(decrypted, 'hardlink', 'hardlink.db'))
  try {
    hl.exec('CREATE TABLE dir2id (username TEXT)')
    const d1 = Number(hl.prepare('INSERT INTO dir2id (username) VALUES (?)').run('dirA').lastInsertRowid)
    const d2 = Number(hl.prepare('INSERT INTO dir2id (username) VALUES (?)').run('dirB').lastInsertRowid)
    hl.exec('CREATE TABLE image_hardlink_info_v4 (md5 TEXT, md5_hash TEXT, file_name TEXT, dir1 INTEGER, dir2 INTEGER, modify_time INTEGER)')
    const ins = hl.prepare('INSERT INTO image_hardlink_info_v4 (md5, md5_hash, file_name, dir1, dir2, modify_time) VALUES (?,?,?,?,?,?)')
    for (let i = 0; i < count; i += 1) {
      const file = `img_${i}.dat`
      ins.run(md5Of(i), 'hash-' + md5Of(i), file, d1, d2, 1000 + i)
      const p = join(base, 'msg', 'attach', 'dirA', 'dirB', 'Img', file)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, PNG)
    }
  } finally {
    hl.close()
  }
}

beforeEach(() => {
  disposers = []
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const d of disposers) d()
  disposers = []
  vi.unstubAllEnvs()
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = ''
})

/** 构造一个指向当前夹具的网关（每次调用都重新解析 env，所以 decoded 目录可以换）。 */
function gatewayFor(decodedDir: string): WechatDataGateway {
  vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', decrypted)
  vi.stubEnv('DSH_WECHAT_DECODED_DIR', decodedDir)
  vi.stubEnv('DSH_WECHAT_BASE_DIR', base)
  return new WechatDataGateway(fakeCtx())
}

/** 只数「按 md5 找 .dat」那条语句的 prepare 次数。 */
function md5QueryCounter(): () => number {
  const spy = vi.spyOn(DatabaseSync.prototype, 'prepare')
  return (): number => spy.mock.calls.map(([sql]) => String(sql)).filter(sql => sql.includes('lower(md5)')).length
}

describe('N16：批量取图 RPC 的查询次数与答案一致性', () => {
  it(`${IMAGE_COUNT} 张图只查一次路径表（逐张则是 ${IMAGE_COUNT} 次）`, () => {
    makeFixture(IMAGE_COUNT)
    const items = Array.from({ length: IMAGE_COUNT }, (_, i) => ({ username: TALKER, localId: i + 1 }))
    const count = md5QueryCounter()

    const gw = gatewayFor(decoded)
    const before = count()
    const r = gw.getImageDataUrlsBatch({ items })
    const batchQueries = count() - before

    expect(r.items.length).toBe(IMAGE_COUNT)
    expect(r.items.every(it => it.url?.startsWith('data:image/png;base64,'))).toBe(true)
    expect(batchQueries, '批量入口没有把 N 次路径查询合并成一次 IN').toBe(1)

    // 对照：同样的 N 张、空缓存下逐张调用 = 一张一次。
    const gwSingle = gatewayFor(join(scratch, 'decoded-single'))
    const beforeSingle = count()
    for (const it of items) gwSingle.getImageDataUrl(it)
    expect(count() - beforeSingle, '逐张调用本该一张一次（对照失效说明夹具或实现变了）').toBe(IMAGE_COUNT)
  })

  it('批量答案与逐张答案逐字相同（含「库里没有这张图」的报错）', () => {
    makeFixture(IMAGE_COUNT)
    const items = Array.from({ length: IMAGE_COUNT }, (_, i) => ({ username: TALKER, localId: i + 1 }))
    const batch = gatewayFor(decoded).getImageDataUrlsBatch({ items }).items
    const single = gatewayFor(join(scratch, 'decoded-single')).getImageDataUrl({ username: TALKER, localId: 1 })
    // 同一张图两条路径必须给同一个 data URL（批量走的是「预热缓存 + 单张入口」）
    expect(batch[0]?.url).toBe(single.url)
    expect(batch[0]?.format).toBe(single.format)
    // 未命中 / 无 md5 的条目仍是条目（不抛、不塌成 0 长度）
    const miss = gatewayFor(join(scratch, 'decoded-miss')).getImageDataUrlsBatch({ items: [{ username: TALKER, localId: 999 }, { username: 'wxid_other', localId: 1 }] })
    expect(miss.items.length).toBe(2)
    expect(miss.items[0]?.error).toBeTruthy()
    expect(miss.items[0]?.username).toBe(TALKER)
    expect(miss.items[1]?.localId).toBe(1)
  })

  it('空清单不查库、也不报错（边界不是「一次全表扫」）', () => {
    makeFixture(4)
    const count = md5QueryCounter()
    const gw = gatewayFor(decoded)
    const before = count()
    const r = gw.getImageDataUrlsBatch({ items: [] })
    expect(r.items).toEqual([])
    expect(count() - before).toBe(0)
  })
})
