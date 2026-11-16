// @vitest-environment node
/**
 * 内容类工具的参数/结果契约（2026-11）：
 *   · `query` 可空 = 最近条目（不再要求必填）；
 *   · 记录返回金额/收支方向/状态，支持 kind/direction/order/金额区间；
 *   · 朋友圈/收藏/文件支持时间排序与类型/大类/体积过滤，limit 上限 60；
 *   · 缺库返回 `not_configured`，不能说成「没有记录」。
 *
 * 金额来自支付卡片 XML（`wcpayinfo.feedesc`）——记录表本身没有金额列，
 * 因此夹具同时造 general.db 与消息分片，钉住「表 + 卡片」的合并口径。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { allTools, runTool } from '../src/query/tools/index.ts'
import type { ToolContext, ToolName, ToolResult } from '../src/query/tools/types.ts'

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  vi.unstubAllEnvs()
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'content-params-'))
  scratch.push(dir)
  return dir
}

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try { create(db) } finally { db.close() }
}

async function run(
  name: ToolName,
  args: Record<string, unknown>,
  decryptedDir: string,
  scope?: ToolContext['scope'],
): Promise<ToolResult> {
  return runTool(allTools, name, args, {
    decryptedDir,
    ...(scope !== undefined ? { scope } : {}),
  })
}

function dayStart(year: number, month: number, day: number): number {
  return Math.floor(new Date(year, month - 1, day, 0, 0, 0).getTime() / 1000)
}

/* ───────────────────────── 记录夹具 ───────────────────────── */

const TRANSFER_XML = (amount: string): string =>
  `<msg><appmsg><type>2000</type><wcpayinfo><paysubtype>3</paysubtype><feedesc>${amount}</feedesc></wcpayinfo></appmsg></msg>`
const REDPACKET_XML = (amount: string): string =>
  `<msg><appmsg><type>2001</type><wcpayinfo><feedesc>${amount}</feedesc></wcpayinfo></appmsg></msg>`

function makeRecordsRoot(): string {
  vi.stubEnv('DSH_WECHAT_SELF_WXID', 'wxid_self')
  const root = tempRoot()
  const day = dayStart(2023, 11, 15)
  makeDb(join(root, 'contact', 'contact.db'), (db) => {
    db.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT)')
    const ins = db.prepare('INSERT INTO contact VALUES (?, ?, ?)')
    ins.run('wxid_friend', '张三', '')
    ins.run('wxid_self', '我', '')
  })
  makeDb(join(root, 'general', 'general.db'), (db) => {
    db.exec(`CREATE TABLE transferTable (
      transfer_id TEXT, message_server_id INTEGER, session_name TEXT,
      pay_sub_type INTEGER, pay_receiver TEXT, pay_payer TEXT,
      begin_transfer_time INTEGER, invalid_time INTEGER, delay_confirm_flag INTEGER
    )`)
    const t = db.prepare('INSERT INTO transferTable VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    t.run('transfer-1', 1001, 'wxid_friend', 3, 'wxid_friend', 'wxid_self', day + 3600, 0, 0)
    t.run('transfer-2', 1002, 'wxid_friend', 3, 'wxid_self', 'wxid_friend', day + 7200, 0, 0)
    t.run('transfer-3', 1003, 'wxid_friend', 3, 'wxid_self', 'wxid_friend', day + 10800, day + 12000, 0)
    db.exec(`CREATE TABLE redEnvelopeTable (
      message_server_id INTEGER, session_name TEXT, sender_user_name TEXT,
      hb_status INTEGER, hb_type INTEGER, receive_status INTEGER, send_id TEXT, last_update_time INTEGER
    )`)
    db.prepare('INSERT INTO redEnvelopeTable VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(2001, 'wxid_friend', 'wxid_friend', 2, 1, 1, 'send-1', day + 14400)
    db.exec(`CREATE TABLE revokebatchmessage (
      local_id INTEGER, batch_id INTEGER, msg_unique_id TEXT, session_name TEXT,
      msg_local_id INTEGER, msg_create_time INTEGER
    )`)
    db.prepare('INSERT INTO revokebatchmessage VALUES (?, ?, ?, ?, ?, ?)')
      .run(9, 1, 'rev-1', 'wxid_friend', 77, day + 18000)
  })
  const msgTable = 'Msg_' + createHash('md5').update('wxid_friend', 'utf8').digest('hex')
  makeDb(join(root, 'message', 'message_1.db'), (db) => {
    db.exec(`CREATE TABLE "${msgTable}" (local_id INTEGER, create_time INTEGER, local_type INTEGER, message_content TEXT, server_id INTEGER)`)
    const ins = db.prepare(`INSERT INTO "${msgTable}" VALUES (?, ?, ?, ?, ?)`)
    ins.run(1, day + 3600, 49, TRANSFER_XML('￥10.00'), 1001)
    ins.run(2, day + 7200, 49, TRANSFER_XML('￥20.50'), 1002)
    ins.run(3, day + 10800, 49, TRANSFER_XML('￥30.00'), 1003)
    ins.run(4, day + 14400, 49, REDPACKET_XML('￥8.88'), 2001)
  })
  return root
}

describe('search_records：空 query = 最近记录，带金额/方向/状态', () => {
  it('按时间倒序列出转账/红包/撤回，snippet 含金额、方向与状态', async () => {
    const result = await run('search_records', {}, makeRecordsRoot())
    expect(result.ok, result.error ?? '').toBe(true)
    expect(result.hits.map(hit => hit.key)).toEqual([
      'record:revokes:rev-1',
      'record:redpackets:2001',
      'record:transfers:transfer-3',
      'record:transfers:transfer-2',
      'record:transfers:transfer-1',
    ])
    const byKey = new Map(result.hits.map(hit => [hit.key, hit]))
    expect(byKey.get('record:transfers:transfer-1')?.snippet)
      .toBe('转账 · 支出 ¥10.00 · 状态：状态值 3')
    expect(byKey.get('record:transfers:transfer-2')?.snippet)
      .toBe('转账 · 收入 ¥20.50 · 状态：状态值 3')
    expect(byKey.get('record:transfers:transfer-3')?.snippet)
      .toContain('已失效')
    expect(byKey.get('record:redpackets:2001')?.snippet)
      .toBe('红包 · 收入 ¥8.88 · 状态：原始状态 2/1')
    expect(byKey.get('record:revokes:rev-1')?.snippet)
      .toBe('撤回记录 · 状态：已撤回')
    expect(byKey.get('record:transfers:transfer-1')?.trace?.resource).toMatchObject({
      resourceKind: 'record',
      stableKey: 'record:transfers:transfer-1',
      recordType: 'transfers',
      session: 'wxid_friend',
      sourceId: 'transfer-1',
      transferId: 'transfer-1',
      messageServerId: '1001',
    })
    expect(byKey.get('record:revokes:rev-1')?.trace?.resource?.recordType).toBe('revokes')
    expect(result.note ?? '').toContain('最近 5 条记录')
  })

  it('facts 只统计本次结果，金额来自支付卡片', async () => {
    const result = await run('search_records', {}, makeRecordsRoot())
    const fact = result.facts?.[0]
    expect(fact?.title).toBe('本次结果：5 条记录')
    expect(fact?.title).not.toContain('全部')
    expect(fact?.body).toContain('转账 3 笔')
    expect(fact?.body).toContain('红包 1 笔')
    expect(fact?.body).toContain('撤回 1 条')
    expect(fact?.body).toContain('收入 ¥59.38')
    expect(fact?.body).toContain('支出 ¥10.00')
    expect(fact?.body).toContain('金额未知 0 笔')
  })

  it('kind 过滤：transfer / redpacket / revoke', async () => {
    const root = makeRecordsRoot()
    const transfers = await run('search_records', { kind: 'transfer' }, root)
    expect(transfers.hits.map(hit => hit.key)).toEqual([
      'record:transfers:transfer-3',
      'record:transfers:transfer-2',
      'record:transfers:transfer-1',
    ])
    const redpackets = await run('search_records', { kind: 'redpacket' }, root)
    expect(redpackets.hits.map(hit => hit.key)).toEqual(['record:redpackets:2001'])
    const revokes = await run('search_records', { kind: 'revoke' }, root)
    expect(revokes.hits.map(hit => hit.key)).toEqual(['record:revokes:rev-1'])
  })

  it('direction 过滤收支；撤回记录没有方向', async () => {
    const root = makeRecordsRoot()
    const out = await run('search_records', { direction: 'out' }, root)
    expect(out.hits.map(hit => hit.key)).toEqual(['record:transfers:transfer-1'])
    const incoming = await run('search_records', { kind: 'transfer', direction: 'in' }, root)
    expect(incoming.hits.map(hit => hit.key)).toEqual([
      'record:transfers:transfer-3',
      'record:transfers:transfer-2',
    ])
    const invalid = await run('search_records', { kind: 'revoke', direction: 'in' }, root)
    expect(invalid.ok).toBe(false)
    expect(invalid.errorCode).toBe('unsupported_scope')
    expect(invalid.hits).toEqual([])
  })

  it('order 与 limit：oldest 最早在前，上限 60', async () => {
    const root = makeRecordsRoot()
    const oldest = await run('search_records', { order: 'oldest', limit: 2 }, root)
    expect(oldest.hits.map(hit => hit.key)).toEqual([
      'record:transfers:transfer-1',
      'record:transfers:transfer-2',
    ])
  })

  it('金额区间按元过滤，只作用于转账/红包', async () => {
    const root = makeRecordsRoot()
    const ranged = await run('search_records', { minAmount: 15, maxAmount: 25 }, root)
    expect(ranged.hits.map(hit => hit.key)).toEqual(['record:transfers:transfer-2'])
    const none = await run('search_records', { minAmount: 100 }, root)
    expect(none.ok, none.error ?? '').toBe(true)
    expect(none.hits).toEqual([])
  })

  it('ctx.scope 优先于模型参数', async () => {
    const root = makeRecordsRoot()
    const day = new Date((dayStart(2023, 11, 15) + 3600) * 1000)
    const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
    // 模型给的 2024 年范围必须被 ctx.scope 覆盖：当天的 5 条都该返回。
    const result = await run('search_records', { from: '2024-01-01', to: '2024-01-31' }, root, {
      from: iso,
      to: iso,
    })
    expect(result.ok, result.error ?? '').toBe(true)
    expect(result.hits).toHaveLength(5)
    // 反过来：只给模型参数（2024）时，2023 的记录不返回。
    const outside = await run('search_records', { from: '2024-01-01', to: '2024-01-31' }, root)
    expect(outside.ok, outside.error ?? '').toBe(true)
    expect(outside.hits).toEqual([])
  })
})

describe('search_moments：空 query = 最近动态', () => {
  function makeMomentsRoot(): string {
    const root = tempRoot()
    const day = dayStart(2023, 11, 15)
    makeDb(join(root, 'contact', 'contact.db'), (db) => {
      db.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT)')
      db.prepare('INSERT INTO contact VALUES (?, ?, ?)').run('wxid_m', '小明', '')
    })
    makeDb(join(root, 'sns', 'db_sns', 'sns.db'), (db) => {
      db.exec('CREATE TABLE SnsTimeLine (tid INTEGER, user_name TEXT, content TEXT, createTime INTEGER)')
      const ins = db.prepare('INSERT INTO SnsTimeLine VALUES (?, ?, ?, ?)')
      for (let i = 1; i <= 15; i += 1) {
        const text = i === 15 ? '长'.repeat(260) : `动态 ${i}`
        ins.run(i, 'wxid_m', `<TimelineObject><id>${i}</id><contentDesc><![CDATA[${text}]]></contentDesc></TimelineObject>`, day + i * 60)
      }
    })
    return root
  }

  it('默认最近在前；limit 上限 60；正文保留前 200 字', async () => {
    const root = makeMomentsRoot()
    const result = await run('search_moments', { limit: 60 }, root)
    expect(result.ok, result.error ?? '').toBe(true)
    expect(result.hits).toHaveLength(15)
    expect(result.hits[0]?.trace?.resource?.timelineId).toBe('15')
    expect(result.hits[0]?.snippet).toHaveLength(200)
    expect(result.hits[0]?.snippet.startsWith('长')).toBe(true)
    expect(result.note ?? '').toContain('最近 15 条朋友圈')

    const defaultLimit = await run('search_moments', {}, root)
    expect(defaultLimit.hits).toHaveLength(12)
  })

  it('order=oldest 与关键词检索', async () => {
    const root = makeMomentsRoot()
    const oldest = await run('search_moments', { order: 'oldest' }, root)
    expect(oldest.hits[0]?.trace?.resource?.timelineId).toBe('1')
    const empty = await run('search_moments', { query: '不存在的词' }, root)
    expect(empty.ok, empty.error ?? '').toBe(true)
    expect(empty.hits).toEqual([])
  })
})

describe('search_favorites：空 query = 最近收藏，支持类型/排序', () => {
  function makeFavoritesRoot(): string {
    const root = tempRoot()
    const day = dayStart(2023, 11, 15)
    makeDb(join(root, 'favorite', 'favorite.db'), (db) => {
      db.exec('CREATE TABLE fav_db_item (local_id INTEGER, type INTEGER, update_time INTEGER, fromusr TEXT, realchatname TEXT, content TEXT)')
      const ins = db.prepare('INSERT INTO fav_db_item VALUES (?, ?, ?, ?, ?, ?)')
      // 1 文本 / 2 图片 / 4 视频 / 8 文件 / 5 链接 / 3 语音（other）
      const types = [1, 2, 4, 8, 5, 3]
      for (let i = 1; i <= 15; i += 1) {
        const type = types[(i - 1) % types.length] ?? 1
        ins.run(i, type, day + i, '', '', `<favitem><desc><![CDATA[收藏 ${i}]]></desc></favitem>`)
      }
    })
    return root
  }

  it('默认最近在前；limit 60 不截断到 12 条', async () => {
    const result = await run('search_favorites', { limit: 60 }, makeFavoritesRoot())
    expect(result.ok, result.error ?? '').toBe(true)
    expect(result.hits).toHaveLength(15)
    expect(result.hits[0]?.key).toBe('fav:15')
    expect(result.note ?? '').toContain('最近 15 条收藏')

    const defaultLimit = await run('search_favorites', {}, makeFavoritesRoot())
    expect(defaultLimit.hits).toHaveLength(12)
  })

  it('type 过滤：text/image/link/other，未知类型归 other', async () => {
    const root = makeFavoritesRoot()
    const text = await run('search_favorites', { type: 'text', limit: 60 }, root)
    expect(text.hits).toHaveLength(3)
    expect(text.hits.every(hit => hit.trace?.resource?.category === '文本')).toBe(true)
    const images = await run('search_favorites', { type: 'image', limit: 60 }, root)
    expect(images.hits).toHaveLength(3)
    expect(images.hits.every(hit => hit.trace?.resource?.category === '图片')).toBe(true)
    const links = await run('search_favorites', { type: 'link', limit: 60 }, root)
    expect(links.hits).toHaveLength(2)
    const other = await run('search_favorites', { type: 'other', limit: 60 }, root)
    expect(other.hits).toHaveLength(2)
    expect(other.hits.every(hit => hit.trace?.resource?.category === '语音')).toBe(true)
  })

  it('order=oldest', async () => {
    const oldest = await run('search_favorites', { order: 'oldest' }, makeFavoritesRoot())
    expect(oldest.hits[0]?.key).toBe('fav:1')
  })
})

describe('search_files：空 query = 最近文件，支持大类/体积/排序', () => {
  function makeFilesRoot(): string {
    const root = tempRoot()
    const day = dayStart(2023, 11, 15)
    makeDb(join(root, 'hardlink', 'hardlink.db'), (db) => {
      db.exec('CREATE TABLE file_hardlink_info_v4 (file_name TEXT, md5 TEXT, file_size INTEGER, modify_time INTEGER)')
      db.exec('CREATE TABLE image_hardlink_info_v4 (file_name TEXT, md5 TEXT, file_size INTEGER, modify_time INTEGER)')
      db.exec('CREATE TABLE video_hardlink_info_v4 (file_name TEXT, md5 TEXT, file_size INTEGER, modify_time INTEGER)')
      for (let i = 1; i <= 5; i += 1) {
        db.prepare('INSERT INTO file_hardlink_info_v4 VALUES (?, ?, ?, ?)')
          .run(`file-${i}.pdf`, `md5-file-${i}`, i * 100, day + i)
        db.prepare('INSERT INTO image_hardlink_info_v4 VALUES (?, ?, ?, ?)')
          .run(`image-${i}.jpg`, `md5-image-${i}`, (i + 5) * 100, day + i + 5)
        db.prepare('INSERT INTO video_hardlink_info_v4 VALUES (?, ?, ?, ?)')
          .run(`video-${i}.mp4`, `md5-video-${i}`, (i + 10) * 100, day + i + 10)
      }
    })
    return root
  }

  it('默认按修改时间倒序；limit 60 返回全部 15 个', async () => {
    const result = await run('search_files', { limit: 60 }, makeFilesRoot())
    expect(result.ok, result.error ?? '').toBe(true)
    expect(result.hits).toHaveLength(15)
    expect(result.hits[0]?.name).toBe('video-5.mp4')
    expect(result.note ?? '').toContain('最近 15 个文件')

    const defaultLimit = await run('search_files', {}, makeFilesRoot())
    expect(defaultLimit.hits).toHaveLength(12)
  })

  it('category 过滤：file/image/video', async () => {
    const root = makeFilesRoot()
    const images = await run('search_files', { category: 'image', limit: 60 }, root)
    expect(images.hits).toHaveLength(5)
    expect(images.hits.every(hit => hit.snippet.startsWith('图片'))).toBe(true)
    const videos = await run('search_files', { category: 'video', limit: 60 }, root)
    expect(videos.hits).toHaveLength(5)
    expect(videos.hits.every(hit => hit.snippet.startsWith('视频'))).toBe(true)
    const files = await run('search_files', { category: 'file', limit: 60 }, root)
    expect(files.hits).toHaveLength(5)
    expect(files.hits.every(hit => hit.snippet.startsWith('文件'))).toBe(true)
  })

  it('order=size 按体积倒序；minSize/maxSize 过滤', async () => {
    const root = makeFilesRoot()
    const bySize = await run('search_files', { order: 'size', limit: 60 }, root)
    expect(bySize.hits[0]?.name).toBe('video-5.mp4')
    expect(bySize.hits.at(-1)?.name).toBe('file-1.pdf')
    const ranged = await run('search_files', { minSize: 500, maxSize: 800, limit: 60 }, root)
    expect(ranged.hits).toHaveLength(4)
    expect(ranged.hits.every(hit => (hit.trace?.resource?.size ?? 0) >= 500 && (hit.trace?.resource?.size ?? 0) <= 800)).toBe(true)
  })
})

describe('内容类工具：缺库返回 not_configured，而不是「没有记录」', () => {
  it.each([
    ['search_moments', 'sns.db'],
    ['search_favorites', 'favorite.db'],
    ['search_files', 'hardlink.db'],
    ['search_records', 'general.db'],
  ] as const)('%s 缺 %s', async (name, dbName) => {
    const result = await run(name, {}, tempRoot())
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('not_configured')
    expect(result.error ?? '').toContain(dbName)
    expect(result.error ?? '').toContain('不存在')
    expect(result.hits).toEqual([])
  })

  it('库已配置但确实零行 ⇒ ok:true 且空结果（与缺库不同）', async () => {
    const root = tempRoot()
    makeDb(join(root, 'favorite', 'favorite.db'), (db) => {
      db.exec('CREATE TABLE fav_db_item (local_id INTEGER, type INTEGER, update_time INTEGER, content TEXT)')
    })
    const result = await run('search_favorites', {}, root)
    expect(result.ok, result.error ?? '').toBe(true)
    expect(result.hits).toEqual([])
  })
})
