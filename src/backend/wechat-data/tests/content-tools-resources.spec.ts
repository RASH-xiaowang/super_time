// @vitest-environment node
/**
 * 四类独立资源工具的稳定定位契约。
 *
 * 资源没有消息的 `username/local_id`。如果工具只返回文件名或数组下标，
 * evidence 去重就会把不同资源合并、前端也无法判断该打开哪一种资源。
 * 这里用真实 unified-search 结果钉住稳定键、来源域与 trace 元信息。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { allTools, runTool } from '../src/query/tools/index.ts'
import type { ToolName, ToolResult } from '../src/query/tools/types.ts'
import { searchIndexPath } from '../src/query/search-scaffold.ts'

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    create(db)
  } finally {
    db.close()
  }
}

function makeResourceDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'resource-tools-'))
  scratch.push(root)

  makeDb(join(root, 'sns', 'db_sns', 'sns.db'), (db) => {
    db.exec('CREATE TABLE SnsTimeLine (tid INTEGER, user_name TEXT, content TEXT, createTime INTEGER)')
    db.prepare('INSERT INTO SnsTimeLine VALUES (?, ?, ?, ?)').run(
      123,
      'wxid_m',
      '<TimelineObject><id>123</id><createTime>1700000000</createTime>'
        + '<contentDesc><![CDATA[资源 朋友圈]]></contentDesc>'
        + '<media><id>img-9</id><url md5="moment-md5" token="moment-token" key="moment-seed">https://cdn/m.jpg</url></media>'
        + '</TimelineObject>',
      1700000000,
    )
  })

  makeDb(join(root, 'favorite', 'favorite.db'), (db) => {
    db.exec('CREATE TABLE fav_db_item (local_id INTEGER, type INTEGER, update_time INTEGER, server_id INTEGER, source_id INTEGER, content TEXT)')
    db.prepare('INSERT INTO fav_db_item VALUES (?, ?, ?, ?, ?, ?)').run(
      7,
      8,
      1700000100,
      9007199254740993n,
      9007199254740994n,
      '<favitem><desc><![CDATA[资源 收藏]]></desc><datalist>'
        + '<dataitem datatype="8" dataid="fav-full-md5"><datatitle>资源清单.pdf</datatitle>'
        + '<datafmt>pdf</datafmt><fullsize>2048</fullsize></dataitem></datalist></favitem>',
    )
  })

  makeDb(join(root, 'hardlink', 'hardlink.db'), (db) => {
    db.exec('CREATE TABLE file_hardlink_info_v4 (file_name TEXT, md5 TEXT, file_size INTEGER, modify_time INTEGER)')
    db.prepare('INSERT INTO file_hardlink_info_v4 VALUES (?, ?, ?, ?)').run(
      '资源合同.pdf', 'file-md5', 1536, 1700000200,
    )
  })

  makeDb(join(root, 'general', 'general.db'), (db) => {
    db.exec('CREATE TABLE transferTable (session_name TEXT, begin_transfer_time INTEGER, message_server_id INTEGER, transfer_id TEXT)')
    db.prepare('INSERT INTO transferTable VALUES (?, ?, ?, ?)').run(
      '资源项目群', 1700000300, 9007199254740995n, 'transfer-9',
    )
  })
  return root
}

async function run(decryptedDir: string, name: ToolName): Promise<ToolResult> {
  const result = await runTool(allTools, name, { query: '资源' }, { decryptedDir })
  expect(result.ok, `${name}: ${result.error ?? ''}`).toBe(true)
  expect(result.hits.length, `${name} 没有命中`).toBeGreaterThan(0)
  return result
}

describe('内容类工具：资源命中使用稳定键与结构化 trace', () => {
  it('朋友圈以 username+tid 定位，并保留媒体打开字段', async () => {
    const result = await run(makeResourceDir(), 'search_moments')
    expect(result.hits[0]).toMatchObject({
      key: 'moment:wxid_m:123',
      name: '朋友圈',
      source: 'resource',
      trace: {
        kind: 'resource',
        resource: {
          resourceKind: 'moment',
          stableKey: 'moment:wxid_m:123',
          username: 'wxid_m',
          timelineId: '123',
          mediaId: 'img-9',
          md5: 'moment-md5',
          url: 'https://cdn/m.jpg',
          token: 'moment-token',
          seed: 'moment-seed',
        },
      },
    })
  })

  it('收藏以 local_id 定位；媒体类型放在 mediaKind，不冒充 mediaId', async () => {
    const result = await run(makeResourceDir(), 'search_favorites')
    const hit = result.hits[0]
    expect(hit).toMatchObject({
      key: 'fav:7',
      name: '资源 收藏',
      source: 'resource',
      trace: {
        kind: 'resource',
        resource: {
          resourceKind: 'favorite',
          stableKey: 'fav:7',
          favoriteId: 7,
          serverId: '9007199254740993',
          sourceId: '9007199254740994',
          category: '文件',
          fileName: '资源清单.pdf',
          size: 2048,
          md5: 'fav-full-md5',
          mediaKind: 'file',
        },
      },
    })
    expect(hit?.trace?.resource?.mediaId).toBeUndefined()
  })

  it('文件优先用内容 MD5 作为稳定键，缺 MD5 时才退回文件名', async () => {
    const result = await run(makeResourceDir(), 'search_files')
    expect(result.hits[0]).toMatchObject({
      key: 'file:file-md5',
      name: '资源合同.pdf',
      source: 'resource',
      snippet: '文件 · 1.5 KB',
      trace: {
        kind: 'resource',
        resource: {
          resourceKind: 'file',
          stableKey: 'file:file-md5',
          fileName: '资源合同.pdf',
          size: 1536,
          category: 'file',
          md5: 'file-md5',
        },
      },
    })
  })

  it('转账记录优先用单号定位，并保留消息服务端 id', async () => {
    const result = await run(makeResourceDir(), 'search_records')
    expect(result.hits[0]).toMatchObject({
      key: 'record:transfers:transfer-9',
      name: '资源项目群',
      source: 'resource',
      trace: {
        kind: 'resource',
        resource: {
          resourceKind: 'record',
          stableKey: 'record:transfers:transfer-9',
          session: '资源项目群',
          sourceId: 'transfer-9',
          recordType: 'transfers',
          transferId: 'transfer-9',
          messageServerId: '9007199254740995',
        },
      },
    })
  })
})

describe('内容类工具：范围过滤与域失败契约', () => {
  it('日期范围是硬过滤：范围外资源不返回', async () => {
    const root = makeResourceDir()
    const day = new Date(1700000000 * 1000)
    const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
    const inRange = await runTool(allTools, 'search_moments', {
      query: '资源',
      from: iso,
      to: iso,
    }, { decryptedDir: root })
    expect(inRange.ok, inRange.error ?? '').toBe(true)
    expect(inRange.hits).toHaveLength(1)

    const outOfRange = await runTool(allTools, 'search_moments', {
      query: '资源',
      from: '2024-01-01',
      to: '2024-01-31',
    }, { decryptedDir: root })
    expect(outOfRange.ok, outOfRange.error ?? '').toBe(true)
    expect(outOfRange.hits).toEqual([])
  })

  it('文件检索无法执行会话范围时明确拒绝，而不是静默查全库', async () => {
    const root = makeResourceDir()
    const result = await runTool(allTools, 'search_files', {
      query: '资源',
      username: 'wxid_other',
    }, { decryptedDir: root })
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('unsupported_scope')
    expect(result.error ?? '').toContain('不支持按会话过滤')
    expect(result.hits).toEqual([])
  })

  it('库读取失败时返回 upstream_failure，而不是 0 命中', async () => {
    const root = makeResourceDir()
    const broken = join(root, 'favorite', 'favorite.db')
    rmSync(broken, { recursive: true, force: true })
    // 把收藏库换成目录：existsSync 仍为真，但 SQLite 打不开。
    mkdirSync(broken, { recursive: true })
    const result = await runTool(allTools, 'search_favorites', { query: '资源' }, { decryptedDir: root })
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('upstream_failure')
    expect(result.hits).toEqual([])
  })

  it('锁定日期从 ctx.scope 注入，资源工具按范围过滤', async () => {
    const root = makeResourceDir()
    const day = new Date(1700000300 * 1000)
    const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
    const result = await runTool(allTools, 'search_records', { query: '资源' }, {
      decryptedDir: root,
      scope: { from: iso, to: iso },
    })
    expect(result.ok, result.error ?? '').toBe(true)
    expect(result.hits).toHaveLength(1)

    const outside = await runTool(allTools, 'search_records', { query: '资源' }, {
      decryptedDir: root,
      scope: { from: '2024-01-01', to: '2024-01-31' },
    })
    expect(outside.ok, outside.error ?? '').toBe(true)
    expect(outside.hits).toEqual([])
  })

  it('部分命中时域失败不吞结果，note 明确标记可能不完整', async () => {
    const root = makeResourceDir()
    // 图片文件表没有时间列 ⇒ 该表无法执行日期范围；普通文件表仍可命中。
    rmSync(join(root, 'hardlink', 'hardlink.db'), { force: true })
    makeDb(join(root, 'hardlink', 'hardlink.db'), (db) => {
      db.exec('CREATE TABLE image_hardlink_info_v4 (file_name TEXT, md5 TEXT, file_size INTEGER)')
      db.prepare('INSERT INTO image_hardlink_info_v4 VALUES (?, ?, ?)').run('资源图片.jpg', 'image-md5', 512)
      db.exec('CREATE TABLE file_hardlink_info_v4 (file_name TEXT, md5 TEXT, file_size INTEGER, modify_time INTEGER)')
      db.prepare('INSERT INTO file_hardlink_info_v4 VALUES (?, ?, ?, ?)')
        .run('资源合同.pdf', 'file-md5', 1536, 1700000000)
    })
    const day = new Date(1700000000 * 1000)
    const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
    const result = await runTool(allTools, 'search_files', {
      query: '资源',
      from: iso,
      to: iso,
    }, { decryptedDir: root })
    expect(result.ok, result.error ?? '').toBe(true)
    expect(result.hits).toHaveLength(1)
    expect(result.note ?? '').toContain('结果可能不完整')
  })

  it('get_session_messages 漏填 from/to 时使用 ctx.scope，不能退化成查全历史', async () => {
    const base = mkdtempSync(join(tmpdir(), 'session-scope-'))
    scratch.push(base)
    const decryptedDir = join(base, 'data')
    mkdirSync(decryptedDir)
    const dayStart = Math.floor(new Date(2023, 10, 15, 0, 0, 0).getTime() / 1000)
    makeDb(searchIndexPath(decryptedDir), (db) => {
      db.exec('CREATE TABLE message_meta (rowid INTEGER PRIMARY KEY, text TEXT, username TEXT, local_id INTEGER, create_time INTEGER, sender TEXT)')
      const ins = db.prepare('INSERT INTO message_meta(text, username, local_id, create_time, sender) VALUES (?, ?, ?, ?, ?)')
      ins.run('范围外消息', 'wxid_m', 1, dayStart - 60, '')
      ins.run('范围内消息', 'wxid_m', 2, dayStart + 3600, '')
      ins.run('范围后消息', 'wxid_m', 3, dayStart + 86400 + 60, '')
    })

    const result = await runTool(allTools, 'get_session_messages', {}, {
      decryptedDir,
      scope: {
        username: 'wxid_m',
        from: '2023-11-15',
        to: '2023-11-15',
      },
    })
    expect(result.ok, result.error ?? '').toBe(true)
    expect(result.hits.map(hit => hit.key)).toEqual(['wxid_m:2'])
  })
})
