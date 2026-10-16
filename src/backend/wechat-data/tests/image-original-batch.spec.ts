/**
 * 批量取原图（免登录直链）的行为与接线守卫。
 *
 * 这条链上最容易坏、又坏得静默的四件事：
 *   ① **断点续跑失效**：取回的原图与本机解码出的原图**写同一个槽位**（`<md5>.<ext>`），
 *      没有索引就分不清「取回过没有」，第二次点会重下几千张；
 *   ② **一条失败带走整批**：直链过期是常态（预签名 URL 有有效期），必须逐条记错继续；
 *   ③ **白名单绕过**：消息 XML 是可被离线改写的文件，直链又带完整凭据参数 ⇒ 打请求前必须过主机白名单；
 *   ④ **计数口径对不上**：界面上的「可补 N 张」与批量实际尝试的条数必须来自**同一次扫描**。
 *
 * 2026-09-30：「自动获取原图（CDN）」开关已删除，这里不再有「关掉就一次请求都不发」的判据。
 *
 * 用例全在临时目录里造，绝不往仓库写东西。
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchOriginalImagesBatch,
  readFetchedOriginals,
  recordFetchedOriginals,
  scanImageOriginalPlan,
} from '../src/query/image-original-batch.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }) } catch { /* 已删 */ } }
  vi.unstubAllGlobals()
})

const TALKER = 'wxid_unittest'
const HOST = 'mmwebwx.weixin.qq.com'

/** 把 md5 包成 `packed_info_data` 的形状（`extractMd5FromPacked` 认这个 marker）。 */
function packed(md5: string): Buffer {
  return Buffer.concat([Buffer.from([0x12, 0x22, 0x0a, 0x20]), Buffer.from(md5, 'ascii')])
}

/** 一条图片消息的 XML（`tphdurl`/`tpurl`/`cdnbigimgurl` 按需给）。 */
function imgXml(md5: string, opts: { hd?: string; tp?: string; cdn?: string; bytes?: number } = {}): string {
  const at: string[] = [`md5="${md5}"`]
  if (opts.hd !== undefined) at.push(`tphdurl="${opts.hd}"`)
  if (opts.tp !== undefined) at.push(`tpurl="${opts.tp}"`)
  if (opts.cdn !== undefined) at.push(`cdnbigimgurl="${opts.cdn}"`)
  at.push(`length="${String(opts.bytes ?? 100)}"`, `hdlength="${String(opts.bytes ?? 100)}"`)
  return `<msg><img ${at.join(' ')}/></msg>`
}

/**
 * 造一份最小可用的「解密目录 + 微信原始目录 + 解码缓存目录」。
 * @param rows - 写进 `Msg_<md5(talker)>` 的行（localId / XML / packed 的 md5）。
 * @param hdMd5s - 要在 attach 里造出 `<md5>_h.dat` 的 md5（= 本机已有原图）。
 */
function fixture(rows: Array<{ localId: number; xml: string; md5: string }>, hdMd5s: string[] = []): {
  decrypted: string; rawRoot: string; decoded: string
} {
  const root = mkdtempSync(join(tmpdir(), 'origbatch-'))
  dirs.push(root)
  const decrypted = join(root, 'decrypted')
  const msgDir = join(decrypted, 'message')
  mkdirSync(msgDir, { recursive: true })
  const table = 'Msg_' + createHash('md5').update(TALKER, 'utf8').digest('hex')
  const db = new DatabaseSync(join(msgDir, 'message_0.db'))
  db.exec(`CREATE TABLE "${table}" (local_id INTEGER, local_type INTEGER, message_content TEXT, packed_info_data BLOB)`)
  for (const r of rows) {
    db.prepare(`INSERT INTO "${table}" VALUES (?,?,?,?)`).run(r.localId, 3, r.xml, packed(r.md5))
  }
  db.close()
  // `ChatName2Id` 是「表名 hash → 会话名」的唯一来源（真实库里在 message_resource.db，本机 175 行）
  const res = new DatabaseSync(join(msgDir, 'message_resource.db'))
  res.exec('CREATE TABLE ChatName2Id (user_name TEXT)')
  res.prepare('INSERT INTO ChatName2Id VALUES (?)').run(TALKER)
  res.close()
  const rawRoot = join(root, 'raw')
  const img = join(rawRoot, 'msg', 'attach', 'd0f5b6b1c8a94f0e9b7c3a1d2e4f6a8b', '2026-03', 'Img')
  mkdirSync(img, { recursive: true })
  for (const md5 of hdMd5s) writeFileSync(join(img, md5 + '_h.dat'), Buffer.alloc(64, 1))
  const decoded = join(root, 'decoded')
  mkdirSync(decoded, { recursive: true })
  return { decrypted, rawRoot, decoded }
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 9])

/** 计数用的 fetch 替身。 */
function stubFetch(make: () => Response | Promise<Response>): () => number {
  let calls = 0
  vi.stubGlobal('fetch', async () => { calls += 1; return make() })
  return () => calls
}

const ok = (bytes: Uint8Array = PNG): Response =>
  ({ ok: true, status: 200, arrayBuffer: async () => bytes.slice().buffer }) as unknown as Response

const MD5_A = 'a'.repeat(32)
const MD5_B = 'b'.repeat(32)
const MD5_C = 'c'.repeat(32)
const MD5_D = 'd'.repeat(32)

describe('盘点：三种途径分开报（这是界面那句「为什么没有原图」的唯一依据）', () => {
  it('① 按指针分类：tphdurl / tpurl / 只有 cdnbig / 什么都没有，四类不混', () => {
    const f = fixture([
      { localId: 1, xml: imgXml(MD5_A, { hd: `https://${HOST}/hd`, bytes: 2000 }), md5: MD5_A },
      { localId: 2, xml: imgXml(MD5_B, { tp: `https://${HOST}/tp`, bytes: 300 }), md5: MD5_B },
      { localId: 3, xml: imgXml(MD5_C, { cdn: '305702010004' }), md5: MD5_C },
      { localId: 4, xml: '<msg><img md5="x" length="1"/></msg>', md5: MD5_D },
    ])
    const { plan, candidates } = scanImageOriginalPlan(f.decrypted, f.rawRoot, f.decoded)
    expect(plan.messages).toBe(4)
    expect(plan.uniqueMd5).toBe(4)
    expect(plan.candidates, '带免登录直链的两条才是候选').toBe(2)
    expect(plan.loginRequired, '只有 cdnbigimgurl 的那条要登录态').toBe(1)
    expect(plan.noPointer, '一条指针都没有的算 noPointer').toBe(1)
    expect(plan.declaredBytes, '预计下载量取 XML 声明的 hdlength').toBe(2300)
    expect(candidates.map(c => c.md5)).toEqual([MD5_A, MD5_B])
    expect(candidates[0]?.hasHdLink, 'tphdurl 是「带独立高清档」').toBe(true)
    expect(candidates[1]?.hasHdLink, 'tpurl 不带独立高清档').toBe(false)
    expect(candidates[0]?.username, '表名要能反查回会话名（排障用）').toBe(TALKER)
  })

  it('①b 企业微信的 `wwfile.work.weixin.qq.com` 链接**不进候选**（实测匿名 403：有链接 ≠ 能取）', () => {
    const wecom = 'https://wwfile.work.weixin.qq.com/cgi-bin/download?f=306a02&t=61DF15&p=1'
    const f = fixture([
      { localId: 1, xml: imgXml(MD5_A, { hd: wecom, bytes: 999 }), md5: MD5_A },
      { localId: 2, xml: imgXml(MD5_B, { hd: `https://${HOST}/hd` }), md5: MD5_B },
    ])
    const { plan, candidates } = scanImageOriginalPlan(f.decrypted, f.rawRoot, f.decoded)
    expect(candidates.map(c => c.md5), '只有真·免登录那条进候选').toEqual([MD5_B])
    expect(plan.candidates).toBe(1)
    expect(plan.loginRequired, '企业微信那条算「需要登录态」').toBe(1)
    expect(plan.wecomDirectLink, '并且单列出来，报告才说得出「有链接却取不到」的原因').toBe(1)
  })

  it('①c 企业微信主机判定要覆盖子域，且不许误伤 lookalike', () => {
    const wecom = 'https://wwfile.work.weixin.qq.com/cgi-bin/download?f=1'
    const f = fixture([
      { localId: 1, xml: imgXml(MD5_A, { hd: wecom }), md5: MD5_A },
      { localId: 2, xml: imgXml(MD5_B, { hd: 'https://evil-work.weixin.qq.com.evil.com/x' }), md5: MD5_B },
    ])
    const { plan } = scanImageOriginalPlan(f.decrypted, f.rawRoot, f.decoded)
    expect(plan.wecomDirectLink).toBe(1)
    // lookalike 不是企业微信端点 ⇒ 算候选（随后会被主机白名单拒掉，这是另一道闸）
    expect(plan.candidates).toBe(1)
  })

  it('② 本机已有 `_h` 的不算候选（离线就拥有原图，不该联网）', () => {
    const f = fixture([
      { localId: 1, xml: imgXml(MD5_A, { hd: `https://${HOST}/hd` }), md5: MD5_A },
      { localId: 2, xml: imgXml(MD5_B, { hd: `https://${HOST}/hd` }), md5: MD5_B },
    ], [MD5_B])
    const { plan } = scanImageOriginalPlan(f.decrypted, f.rawRoot, f.decoded)
    expect(plan.alreadyHd).toBe(1)
    expect(plan.candidates).toBe(1)
  })

  it('③ 同一张图被发多次只算一张（取回也是按 md5 落盘一次）', () => {
    const f = fixture([
      { localId: 1, xml: imgXml(MD5_A, { hd: `https://${HOST}/hd` }), md5: MD5_A },
      { localId: 2, xml: imgXml(MD5_A, { hd: `https://${HOST}/hd` }), md5: MD5_A },
      { localId: 3, xml: imgXml(MD5_A, { hd: `https://${HOST}/hd` }), md5: MD5_A },
    ])
    const { plan, candidates } = scanImageOriginalPlan(f.decrypted, f.rawRoot, f.decoded)
    expect(plan.messages, '消息条数按行算').toBe(3)
    expect(plan.uniqueMd5).toBe(1)
    expect(candidates.length).toBe(1)
  })

  it('④ 已在续跑索引里的算「已取回过」，不再算候选', () => {
    const f = fixture([{ localId: 1, xml: imgXml(MD5_A, { hd: `https://${HOST}/hd` }), md5: MD5_A }])
    recordFetchedOriginals(f.decoded, [MD5_A])
    const { plan, candidates } = scanImageOriginalPlan(f.decrypted, f.rawRoot, f.decoded)
    expect(plan.alreadyFetched).toBe(1)
    expect(plan.candidates).toBe(0)
    expect(candidates.length).toBe(0)
  })

  it('⑤ 索引文件坏了就当空（不让它把整个批量堵死）', () => {
    const f = fixture([{ localId: 1, xml: imgXml(MD5_A, { hd: `https://${HOST}/hd` }), md5: MD5_A }])
    writeFileSync(join(f.decoded, '.originals-index.json'), '{ 这不是 JSON')
    expect(readFetchedOriginals(f.decoded).size).toBe(0)
    expect(scanImageOriginalPlan(f.decrypted, f.rawRoot, f.decoded).plan.candidates).toBe(1)
  })
})

describe('批量取回：续跑、失败隔离', () => {
  it('⑦ 成功取回落进解码缓存根、并写进续跑索引；第二次跑一张都不再下', async () => {
    const f = fixture([
      { localId: 1, xml: imgXml(MD5_A, { hd: `https://${HOST}/hd` }), md5: MD5_A },
      { localId: 2, xml: imgXml(MD5_B, { hd: `https://${HOST}/hd` }), md5: MD5_B },
    ])
    const calls = stubFetch(() => ok())
    const first = await fetchOriginalImagesBatch(f.decrypted, f.rawRoot, f.decoded, {})
    expect(first.fetched).toBe(2)
    expect(first.failed).toBe(0)
    expect(first.bytes).toBe(PNG.length * 2)
    expect(calls()).toBe(2)
    expect(readFileSync(join(f.decoded, MD5_A + '.png')).length).toBe(PNG.length)
    expect(readFetchedOriginals(f.decoded).size).toBe(2)

    const second = await fetchOriginalImagesBatch(f.decrypted, f.rawRoot, f.decoded, {})
    expect(second.candidates, '索引说这两张已经取回过').toBe(0)
    expect(second.attempted).toBe(0)
    expect(calls(), '第二遍不许再发请求').toBe(2)
  })

  it('⑧ 一条失败不带走整批（直链过期是常态），失败原因逐条带回', async () => {
    const f = fixture([
      { localId: 1, xml: imgXml(MD5_A, { hd: `https://${HOST}/hd` }), md5: MD5_A },
      { localId: 2, xml: imgXml(MD5_B, { hd: `https://${HOST}/hd` }), md5: MD5_B },
    ])
    let n = 0
    const calls = stubFetch(() => {
      n += 1
      // 第一张 403（直链过期），第二张正常
      return n === 1
        ? ({ ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response)
        : ok()
    })
    const r = await fetchOriginalImagesBatch(f.decrypted, f.rawRoot, f.decoded, { concurrency: 1 })
    expect(calls()).toBe(2)
    expect(r.fetched).toBe(1)
    expect(r.failed).toBe(1)
    expect(r.errors[0]?.error, '失败原因要能直接显示给用户').toContain('403')
    expect(r.ok).toBe(false)
    expect(readFetchedOriginals(f.decoded).size, '只有成功的那张进索引').toBe(1)
  })

  it('⑨ 白名单外主机：拒绝请求并记为该条失败（XML 是可被改写的文件）', async () => {
    const f = fixture([{ localId: 1, xml: imgXml(MD5_A, { hd: 'https://attacker.example.org/x' }), md5: MD5_A }])
    const calls = stubFetch(() => ok())
    const r = await fetchOriginalImagesBatch(f.decrypted, f.rawRoot, f.decoded, {})
    expect(calls()).toBe(0)
    expect(r.failed).toBe(1)
    expect(r.errors[0]?.error).toContain('允许清单')
  })

  it('⑩ limit 截断：attempted 受限于 limit，remaining 报出还剩多少（下次点一下继续）', async () => {
    const f = fixture([
      { localId: 1, xml: imgXml(MD5_A, { hd: `https://${HOST}/hd` }), md5: MD5_A },
      { localId: 2, xml: imgXml(MD5_B, { hd: `https://${HOST}/hd` }), md5: MD5_B },
      { localId: 3, xml: imgXml(MD5_C, { hd: `https://${HOST}/hd` }), md5: MD5_C },
    ])
    stubFetch(() => ok())
    const r = await fetchOriginalImagesBatch(f.decrypted, f.rawRoot, f.decoded, { limit: 1, concurrency: 1 })
    expect(r.candidates).toBe(3)
    expect(r.attempted).toBe(1)
    expect(r.fetched).toBe(1)
    expect(r.remaining).toBe(2)
  })

  it('⑪ 进度回调：每条一次、总数正确（界面靠它显示进度条）', async () => {
    const f = fixture([
      { localId: 1, xml: imgXml(MD5_A, { hd: `https://${HOST}/hd` }), md5: MD5_A },
      { localId: 2, xml: imgXml(MD5_B, { hd: `https://${HOST}/hd` }), md5: MD5_B },
    ])
    stubFetch(() => ok())
    const seen: Array<{ done: number; total: number }> = []
    await fetchOriginalImagesBatch(f.decrypted, f.rawRoot, f.decoded, {
      concurrency: 1,
      onProgress: (done, total, fetched) => { seen.push({ done, total }); expect(fetched).toBeLessThanOrEqual(done) },
    })
    expect(seen.map(s => s.done)).toEqual([1, 2])
    expect(seen.every(s => s.total === 2)).toBe(true)
  })
})

describe('接线不变量（行为测试够不到的那几条）', () => {
  const here = import.meta.dirname
  const src = (rel: string): string => readFileSync(join(here, '..', 'src', rel), 'utf8')
  const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  it('⑫ 落盘复用单张那条链（不许自己再写一份下载/白名单/格式嗅探）', () => {
    const impl = strip(src('query/image-original-batch.ts'))
    expect(impl.includes('fetchImageOriginalToCache('), '必须复用单张的取回函数').toBe(true)
    expect(impl.includes('sniffImageFormat'), '不许在批量里再写一份格式嗅探').toBe(false)
    expect(impl.includes('wechatCdnHostAllowed'), '白名单只准有一处判据（在 image-original.ts）').toBe(false)
    expect(impl.includes('fetch('), '批量自己不许直接发请求').toBe(false)
  })

  it('⑬ 扫描只有一份实现（盘点的数字与实际尝试的条数必须同源）', () => {
    const impl = strip(src('query/image-original-batch.ts'))
    expect(/export function scanImageOriginalPlan/.test(impl)).toBe(true)
    expect((impl.match(/scanImageOriginalPlan\(/g) ?? []).length, '盘点与执行都走同一个扫描（定义 1 处 + 调用 1 处）').toBe(2)
  })

  it('⑭ 索引按批合写（每条都读改写会退化成 O(n²)）', () => {
    const impl = strip(src('query/image-original-batch.ts'))
    const at = impl.indexOf('export function recordFetchedOriginals')
    expect(at, '找不到 recordFetchedOriginals —— 改名时请同步本用例').toBeGreaterThan(-1)
    const body = impl.slice(at, impl.indexOf('\n}', at))
    expect(body.includes('readonly string[]'), '写入端收的是**一批** md5，不是单条').toBe(true)
    expect(body.includes('for (const m of valid)'), '一次读改写要写入整批').toBe(true)
    const batchAt = impl.indexOf('export async function fetchOriginalImagesBatch')
    expect(batchAt, '找不到 fetchOriginalImagesBatch').toBeGreaterThan(-1)
    const batch = impl.slice(batchAt)
    expect(batch.includes('INDEX_FLUSH_EVERY'), '批量驱动要有合写节流常量').toBe(true)
    expect(batch.includes('recordFetchedOriginals('), '批量必须走合写入口').toBe(true)
    expect(batch.includes('recordFetchedOriginal('), '批量不许逐条写（那是 O(n²) 的写放大）').toBe(false)
  })
})
