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
      // 每张图带**各自不同的尾部字节**：原本 30 张写的是同一份常量，于是批量与逐张的答案 base64
      // 天生一样，「合并时把 localId 关联错了」这类缺陷在答案层面比不出来（只能被算料守卫抓到代价）。
      // 头部仍是 PNG 魔数（`decodeDatBytes` 靠它认格式），多出来的字节只让每张的内容互不相同。
      writeFileSync(p, Buffer.concat([PNG, Buffer.from([i & 0xff, (i >> 8) & 0xff])]))
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

/**
 * 数 prepare 过的 SQL：既能数「按 md5 找 .dat」那条，也能数任意片段。
 * 一个 spy 就够（两条判据读同一份调用记录），免得在同一个原型方法上叠两层包装。
 */
function sqlCounter(): { md5Queries: () => number, matching: (fragment: string) => number } {
  const spy = vi.spyOn(DatabaseSync.prototype, 'prepare')
  const all = (): string[] => spy.mock.calls.map(([sql]) => String(sql))
  return {
    md5Queries: () => all().filter(sql => sql.includes('lower(md5)')).length,
    matching: (fragment) => all().filter(sql => sql.includes(fragment)).length,
  }
}

/**
 * 数「真正开合过几次 sqlite 句柄」。
 *
 * 为什么数 `close` 而不是构造：单张入口每解析一张图就 `new DatabaseSync(shard, readOnly)` 再在
 * `finally` 里关掉它 —— 一次 open 恰好配一次 close，而构造函数没法在原型上 spy。
 * 为什么把数字**打进 stdout**：这个文件在 CI 上跑 46 秒、本机 0.3 秒（147 倍），而**算料只有本机能数、
 * 秒数只有 CI 有** —— 两边留着同一份计数，下一次看那条 41730ms 的人才有可能归因，而不是再猜一轮
 * （同一份运行里量到 106ms 与 77ms 每次开合，见 RELEASE-PLAN 的 N36）。
 * 上界只防回涨：谁把剩下的那份单张复用也省掉，计数会掉下来，那时请把这里的常量一起改小
 * （批量入口的 md5 已经合并成一条 IN；剩下的每图一次是**刻意保留**的单张复用，理由写在
 * `gateway-data-ops.ts` 的「诚实边界」里）。
 */
function openCounter(): { since: () => number, report: (label: string, n: number, ceiling: number) => void } {
  const spy = vi.spyOn(DatabaseSync.prototype, 'close')
  const base = spy.mock.calls.length
  return {
    since: () => spy.mock.calls.length - base,
    report: (label, n, ceiling) => {
      console.log(`[算料] gateway-image-batch ${label}：句柄开合 ${String(n)} 次`)
      expect(n, `${label}：句柄开合从 ${String(ceiling)} 涨到 ${String(n)} —— 入口的合并被改坏了？`).toBeLessThanOrEqual(ceiling)
    },
  }
}

describe('N16：批量取图 RPC 的查询次数与答案一致性', () => {
  it(`${IMAGE_COUNT} 张图只查一次路径表（逐张则是 ${IMAGE_COUNT} 次）`, () => {
    makeFixture(IMAGE_COUNT)
    const items = Array.from({ length: IMAGE_COUNT }, (_, i) => ({ username: TALKER, localId: i + 1 }))
    const sql = sqlCounter()

    const gw = gatewayFor(decoded)
    const h = openCounter()
    const before = sql.md5Queries()
    const beforeIn = sql.matching('local_id IN (')
    const beforeEq = sql.matching('local_id = ?')
    const r = gw.getImageDataUrlsBatch({ items })
    const batchQueries = sql.md5Queries() - before
    h.report(`${IMAGE_COUNT} 张走批量入口`, h.since(), 33)
    const batchIn = sql.matching('local_id IN (') - beforeIn
    const batchEq = sql.matching('local_id = ?') - beforeEq
    console.log(`[算料] gateway-image-batch 批量段 SQL：合并查询 ${String(batchIn)} 次、逐张 local_id = ? ${String(batchEq)} 次`)
    // 批量入口自己那趟 md5 取数必须是一条 IN（被人改回逐张时，这句会红，而 33→62 的开合数也会红）
    expect(batchIn, '批量入口取 md5 该合并成一条 local_id IN (…) —— 没合并就等于每张图各开一次分片库').toBe(1)
    // 剩下的 30 次是**故意保留**的：批量预热之后每张图仍走一次单张入口（错误语义、data_index
    // 兜底、hevc 判定都从那里来，复制一份到批量路径就是多一份漂移）。见 gateway-data-ops.ts
    // 里「诚实边界」那条注释。将来真要把这 30 次也省掉，改的是这个复用方式，不是这里的数字。
    expect(batchEq, '批量段里逐张 local_id = ? 不该超过每张一次；掉下来说明那份复用被去掉了，请连注释与 N36 一起改').toBeLessThanOrEqual(IMAGE_COUNT)

    expect(r.items.length).toBe(IMAGE_COUNT)
    expect(r.items.every(it => it.url?.startsWith('data:image/png;base64,'))).toBe(true)
    expect(batchQueries, '批量入口没有把 N 次路径查询合并成一次 IN').toBe(1)

    // 对照：同样的 N 张、空缓存下逐张调用 = 一张一次。
    const gwSingle = gatewayFor(join(scratch, 'decoded-single'))
    const beforeSingle = sql.md5Queries()
    const baseSingle = h.since()
    for (const it of items) gwSingle.getImageDataUrl(it)
    h.report(`${IMAGE_COUNT} 张走单张入口（对照）`, h.since() - baseSingle, 60)
    expect(sql.md5Queries() - beforeSingle, '逐张调用本该一张一次（对照失效说明夹具或实现变了）').toBe(IMAGE_COUNT)
  })

  it('批量答案与逐张答案逐字相同（含「库里没有这张图」的报错）', () => {
    makeFixture(IMAGE_COUNT)
    const items = Array.from({ length: IMAGE_COUNT }, (_, i) => ({ username: TALKER, localId: i + 1 }))
    const h2 = openCounter()
    const t2a = h2.since()
    const batch = gatewayFor(decoded).getImageDataUrlsBatch({ items }).items
    const t2b = h2.since()
    h2.report(`第 2 次同样 ${IMAGE_COUNT} 张走批量入口`, t2b - t2a, 35)
    // 逐张入口当**参考答案**，并且**整批比对**：批量入口现在合并了 md5 的取法（一次
    // `local_id IN (…)` 而不是每张开一次库），只抽一张会漏掉「某个 localId 落在别的分片」
    // 「md5 大小写」「走 resource.db 兜底」这类单点差异 —— 那些恰好是最容易只错一条的形态。
    const gwRef = gatewayFor(join(scratch, 'decoded-single'))
    const refBase = h2.since()
    for (let i = 0; i < IMAGE_COUNT; i += 1) {
      const it = items[i]
      if (!it) continue
      const one = gwRef.getImageDataUrl(it)
      expect(batch[i]?.url, `第 ${String(i + 1)} 张：批量与逐张必须给同一个 data URL`).toBe(one.url)
      expect(batch[i]?.format, `第 ${String(i + 1)} 张：两条路径的格式判定必须一致`).toBe(one.format)
    }
    h2.report(`${IMAGE_COUNT} 张走逐张入口（第 2 次，参考答案）`, h2.since() - refBase, 60)
    // 未命中 / 无 md5 的条目仍是条目（不抛、不塌成 0 长度）
    const miss = gatewayFor(join(scratch, 'decoded-miss')).getImageDataUrlsBatch({ items: [{ username: TALKER, localId: 999 }, { username: 'wxid_other', localId: 1 }] })
    expect(miss.items.length).toBe(2)
    expect(miss.items[0]?.error).toBeTruthy()
    expect(miss.items[0]?.username).toBe(TALKER)
    expect(miss.items[1]?.localId).toBe(1)
  })

  it('空清单不查库、也不报错（边界不是「一次全表扫」）', () => {
    makeFixture(4)
    const sql = sqlCounter()
    const gw = gatewayFor(decoded)
    const before = sql.md5Queries()
    const r = gw.getImageDataUrlsBatch({ items: [] })
    expect(r.items).toEqual([])
    expect(sql.md5Queries() - before).toBe(0)
  })
})
