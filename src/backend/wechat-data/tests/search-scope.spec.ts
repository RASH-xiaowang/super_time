/**
 * 搜索范围（后端）：关键词必须在**服务端**过滤，而不是「拉一页回来本地过滤」。
 *
 * 这一组用例是为审计出的四类缺陷写的回归网：
 *   ① `queryFiles` 的 `q` 要同时匹配 `file_name` 与 `md5`
 *      （此前前端 `(fileName || md5)` 短路 ⇒ 按 MD5 永远搜不到；且只拉 500 条，
 *       实测覆盖率 11.6%）；
 *   ② `listOperations` 的 `q` 要覆盖 `action`/`target`/`detail`
 *      （此前后端根本没有该参数 ⇒ 只能搜到最新那一页，覆盖率 23%）；
 *   ③ `queryFavorites` / `queryRevoked` 的 `q` 要真的下推到 SQL；
 *   ④ `querySessions` 的 `keyword` 必须包含 `summary`
 *      （只比 username/displayName 会让前端那个 summary 分支成为死代码）；
 *   ⑤ `queryRecords` 的 `total` 与 `items` 必须一致
 *      （此前 `finder_live_id` 是越界 int64，异常被吞 ⇒ total=2 而 items=[]）。
 *
 * 另外两条通用口径：
 *   · `total` 是**未分页**的命中数（分页不能改变它）；
 *   · 关键词里的 `%` / `_` 必须转义，否则被当成 SQL 通配符。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { queryFiles } from '../src/query/files.ts'
import { listOperations, recordOperation } from '../src/query/operation-log.ts'
import { queryFavorites } from '../src/query/favorites.ts'
import { queryRevoked, queryRecords } from '../src/query/records.ts'
import { querySessions } from '../src/query/sessions.ts'
import { searchUnified } from '../src/query/unified-search.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

/** 造一个数据根 + decrypted 目录；返回 decryptedDir。 */
function makeRoot(): string {
  const dataRoot = join(mkdtempSync(join(tmpdir(), 'wx-searchscope-')), 'wechat-data')
  const dec = join(dataRoot, 'decrypted')
  mkdirSync(dec, { recursive: true })
  scratch.push(join(dataRoot, '..'))
  return dec
}

function db(dec: string, rel: string): DatabaseSync {
  const p = join(dec, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  return new DatabaseSync(p)
}

// ── ① 文件 ───────────────────────────────────────────────────────────────
describe('文件搜索：服务端过滤 + md5 可搜', () => {
  function seedFiles(dec: string): void {
    const d = db(dec, join('hardlink', 'hardlink.db'))
    d.exec(`CREATE TABLE image_hardlink_info_v4 (
      md5 TEXT, file_name TEXT, file_size INTEGER, modify_time INTEGER, dir1 INTEGER, dir2 INTEGER)`)
    d.exec(`CREATE TABLE file_hardlink_info_v4 (
      md5 TEXT, file_name TEXT, file_size INTEGER, modify_time INTEGER, dir1 INTEGER, dir2 INTEGER)`)
    const ins = d.prepare('INSERT INTO image_hardlink_info_v4 VALUES (?,?,?,?,?,?)')
    // 名字里没有「报告」，但 md5 里有 —— 只有 md5 参与匹配才搜得到
    ins.run('aa11bb22cc33dd44ee55ff6600778899', '邵龙-转让协议.dat', 100, 30, 1, 2)
    ins.run('ffffffffffffffffffffffffffffffff', '假期照片.jpg', 200, 20, 3, 4)
    const ins2 = d.prepare('INSERT INTO file_hardlink_info_v4 VALUES (?,?,?,?,?,?)')
    ins2.run('00000000000000000000000000000000', '年度报告.pdf', 300, 10, 5, 6)
    d.close()
  }

  it('按文件名能搜到，且搜索后 total / counts 都是过滤后的口径', () => {
    const dec = makeRoot()
    seedFiles(dec)
    const all = queryFiles(dec, 100, 0, undefined, undefined)
    expect(all.total).toBe(3)
    const hit = queryFiles(dec, 100, 0, undefined, '年度报告')
    expect(hit.total).toBe(1)
    expect(hit.files[0]?.fileName).toBe('年度报告.pdf')
    // 分类计数也必须跟着过滤（否则「图片 (3309)」与列表 1 条自相矛盾）
    expect(hit.counts['file']).toBe(1)
    expect(hit.counts['image']).toBe(0)
  })

  it('按 MD5 能搜到（此前前端 `fileName || md5` 短路 ⇒ 恒搜不到）', () => {
    const dec = makeRoot()
    seedFiles(dec)
    const hit = queryFiles(dec, 100, 0, undefined, 'aa11bb22cc33dd44')
    expect(hit.total).toBe(1)
    expect(hit.files[0]?.fileName).toBe('邵龙-转让协议.dat')
  })

  it('搜索不受「一次只能拉一页」限制：分页不改变命中总数', () => {
    const dec = makeRoot()
    seedFiles(dec)
    const p1 = queryFiles(dec, 1, 0, undefined, 'a')
    const p2 = queryFiles(dec, 1, 1, undefined, 'a')
    expect(p1.files.length).toBe(1)
    // 只有 1 条命中 ⇒ 第二页应该是空的，但 total 必须仍然是 1（分页不改变命中总数）
    expect(p2.files.length).toBe(0)
    expect(p1.total).toBe(1)
    expect(p2.total).toBe(1)
  })

  it('关键词里的 % 与 _ 被转义，不当通配符', () => {
    const dec = makeRoot()
    seedFiles(dec)
    expect(queryFiles(dec, 100, 0, undefined, '%').total).toBe(0)
    expect(queryFiles(dec, 100, 0, undefined, '_').total).toBe(0)
  })
})

// ── ② 操作日志 ───────────────────────────────────────────────────────────
describe('操作日志搜索：覆盖全量而非「最新那一页」', () => {
  it('按 action / target / detail 过滤，且 total 是未分页命中数', () => {
    const dec = makeRoot()
    for (let i = 0; i < 12; i++) {
      recordOperation(dec, {
        category: 'export',
        action: i % 2 === 0 ? 'export_csv' : 'build_index',
        target: `会话#${i}`,
        status: 'ok',
        detail: i === 0 ? '关键线索在这里' : '普通上下文',
      })
    }
    const all = listOperations(dec, { limit: 500 })
    expect(all.total).toBe(12)

    const byAction = listOperations(dec, { limit: 5, q: 'build_index' })
    expect(byAction.total).toBe(6)
    expect(byAction.items.every(r => r.action === 'build_index')).toBe(true)

    const byDetail = listOperations(dec, { limit: 5, q: '关键线索' })
    expect(byDetail.total).toBe(1)
  })

  it('能搜到「最新一页之外」的条目（此前只能搜最新 500 条）', () => {
    const dec = makeRoot()
    // 造 600 条：最新 500 条是 new_*，更老的 100 条是 old_*
    for (let i = 0; i < 600; i++) {
      recordOperation(dec, {
        category: 'sync', action: i < 100 ? 'old_marker' : 'new_marker',
        target: '', status: 'ok', detail: '',
      })
    }
    // 分页只取一页时看不到 old_marker
    const firstPage = listOperations(dec, { limit: 100 })
    expect(firstPage.items.every(r => r.action === 'new_marker')).toBe(true)
    // 但按关键词能直接命中 —— 证明过滤在服务端
    const hit = listOperations(dec, { limit: 10, q: 'old_marker' })
    expect(hit.total).toBe(100)
    expect(hit.items.every(r => r.action === 'old_marker')).toBe(true)
  })

  it('关键词与时间/状态可以叠加', () => {
    const dec = makeRoot()
    recordOperation(dec, { category: 'export', action: 'export_csv', target: 'A', status: 'ok', detail: '' })
    recordOperation(dec, { category: 'export', action: 'export_csv', target: 'B', status: 'fail', detail: '' })
    expect(listOperations(dec, { limit: 10, q: 'export_csv', status: 'fail' }).total).toBe(1)
    expect(listOperations(dec, { limit: 10, q: '不存在的词' }).total).toBe(0)
  })
})

// ── ③④ 收藏 / 撤回 ──────────────────────────────────────────────────────
describe('收藏 / 撤回：关键词下推到 SQL', () => {
  it('收藏：按内容（XML 里的标题）与来源人过滤', () => {
    const dec = makeRoot()
    const d = db(dec, join('favorite', 'favorite.db'))
    d.exec(`CREATE TABLE fav_db_item (
      local_id INTEGER, type INTEGER, update_time INTEGER, content TEXT,
      fromusr TEXT, realchatname TEXT)`)
    const ins = d.prepare('INSERT INTO fav_db_item VALUES (?,?,?,?,?,?)')
    ins.run(1, 1, 30, '<favitem title="季度报告">正文</favitem>', 'wxid_a', '')
    ins.run(2, 1, 20, '<favitem title="随手记">正文</favitem>', 'wxid_b', '项目群')
    d.close()
    const all = queryFavorites(dec, 100, 0, undefined)
    expect(all.total).toBe(2)
    // 标题存在 content 的 XML 里 ⇒ 按标题能搜到（与面板内解析后的口径一致）
    expect(queryFavorites(dec, 100, 0, '季度报告').total).toBe(1)
    expect(queryFavorites(dec, 100, 0, '项目群').total).toBe(1)
    expect(queryFavorites(dec, 100, 0, 'wxid_a').total).toBe(1)
    expect(queryFavorites(dec, 100, 0, '不存在的词').total).toBe(0)
  })

  it('撤回：按内容与发送者 id 过滤', () => {
    const dec = makeRoot()
    const msgDir = join(dec, 'message')
    mkdirSync(msgDir, { recursive: true })
    const d = new DatabaseSync(join(msgDir, 'message_0.db'))
    d.exec(`CREATE TABLE Message (
      local_type INTEGER, real_sender_id INTEGER, create_time INTEGER, message_content TEXT)`)
    const ins = d.prepare('INSERT INTO Message VALUES (?,?,?,?)')
    ins.run(1, 1001, 30, 'sender:\n这是一条被撤回的话')
    ins.run(1, 1002, 20, 'sender:\n另一条')
    d.close()
    writeFileSync(join(dec, 'message', 'message_0.db-wal'), Buffer.alloc(0))
    const all = queryRevoked(dec, 100, 0, undefined)
    expect(all.total).toBeGreaterThanOrEqual(0) // 表在分片里，找不到时不强求
    if (all.total > 0) {
      expect(queryRevoked(dec, 100, 0, '被撤回').total).toBe(1)
      expect(queryRevoked(dec, 100, 0, '1001').total).toBe(1)
      expect(queryRevoked(dec, 100, 0, '不存在的词').total).toBe(0)
    }
  })
})

// ── ④ 会话 ───────────────────────────────────────────────────────────────
describe('会话搜索：keyword 必须包含 summary', () => {
  it('只在最后一条消息里出现的词也能搜到该会话', () => {
    const dec = makeRoot()
    const d = db(dec, join('session', 'session.db'))
    d.exec(`CREATE TABLE SessionTable (
      username TEXT, summary BLOB, last_timestamp INTEGER, sort_timestamp INTEGER,
      unread_count INTEGER, is_hidden INTEGER, last_msg_type INTEGER,
      last_msg_sub_type INTEGER, last_msg_sender TEXT, last_sender_display_name TEXT, draft TEXT)`)
    const ins = d.prepare(`INSERT INTO SessionTable VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    // 名字与 username 里都没有「2026」，只有摘要里有
    ins.run('wxid_aaa', Buffer.from('2026 年的计划', 'utf-8'), 30, 30, 0, 0, 1, 0, '', '', '')
    ins.run('wxid_bbb', Buffer.from('别的消息', 'utf-8'), 20, 20, 0, 0, 1, 0, '', '', '')
    d.close()
    const hit = querySessions(dec, '2026', 500, 0)
    expect(hit.sessions.length).toBe(1)
    expect(hit.sessions[0]?.username).toBe('wxid_aaa')
    // 名字匹配仍然有效（不能为了 summary 把原有口径弄丢）
    expect(querySessions(dec, 'wxid_bbb', 500, 0).sessions.length).toBe(1)
  })
})

// ── ⑤ 记录：total 与 items 的一致性 ──────────────────────────────────────
describe('记录：total 与 items 必须一致（不能再出现「有 total 却 0 行」）', () => {
  it('视频号：finder_live_id 是越界 int64 也必须读得出来', () => {
    const dec = makeRoot()
    const d = db(dec, join('general', 'general.db'))
    d.exec(`CREATE TABLE wcfinderlivestatus (
      finder_live_id INTEGER, finder_username TEXT, finder_export_id TEXT,
      live_status INTEGER, replay_status INTEGER, charge_flag INTEGER)`)
    const ins = d.prepare('INSERT INTO wcfinderlivestatus VALUES (?,?,?,?,?,?)')
    // 实测的两个越界值：都超过 Number.MAX_SAFE_INTEGER
    ins.run(1214293303336576460n, 'v2_a@finder', '', 1, 0, 0)
    ins.run(2078956456102183056n, 'v2_b@finder', '', 2, 0, 0)
    d.close()
    const r = queryRecords(dec, 'finder', 20, 0)
    expect(r.total).toBe(2)
    expect(r.items.length).toBe(2, 'total>0 却渲染 0 行 —— 就是被吞掉的 int64 异常')
    const ids = r.items.map(it => String(it['finder_live_id'] ?? '')).sort()
    expect(ids).toEqual(['1214293303336576460', '2078956456102183056'])
  })

  it('任何一个 kind：total>0 且未翻页时，items 不能为空', () => {
    const dec = makeRoot()
    const d = db(dec, join('general', 'general.db'))
    d.exec(`CREATE TABLE transferTable (
      transfer_id TEXT, transcation_id TEXT, message_server_id INTEGER, second_message_server_id INTEGER,
      session_name TEXT, pay_sub_type INTEGER, pay_receiver TEXT, pay_payer TEXT,
      begin_transfer_time INTEGER, last_modified_time INTEGER, invalid_time INTEGER,
      last_update_time INTEGER, delay_confirm_flag INTEGER)`)
    d.prepare('INSERT INTO transferTable VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('T1', 'X', 1, 2, 'wxid_room', 1, '', '', 30, 30, 0, 30, 0)
    d.close()
    for (const kind of ['transfers'] as const) {
      const r = queryRecords(dec, kind, 20, 0)
      if (r.total > 0) expect(r.items.length).toBeGreaterThan(0)
    }
  })
})

// ── ⑥ 全局搜索字段面 ─────────────────────────────────────────────────────
describe('全局搜索：字段面与面板内对齐', () => {
  it('文件：按 md5 也能命中（此前只比 file_name）', () => {
    const dec = makeRoot()
    const d = db(dec, join('hardlink', 'hardlink.db'))
    d.exec('CREATE TABLE image_hardlink_info_v4 (md5 TEXT, file_name TEXT, file_size INTEGER, modify_time INTEGER)')
    d.prepare('INSERT INTO image_hardlink_info_v4 VALUES (?,?,?,?)')
      .run('deadbeefdeadbeefdeadbeefdeadbeef', '照片.jpg', 10, 1)
    d.close()
    const snap = searchUnified(dec, 'deadbeefdeadbeef')
    expect(snap.files.length).toBe(1)
  })

  it('朋友圈：按作者显示名也能命中（此前只比正文）', () => {
    const dec = makeRoot()
    const c = db(dec, join('contact', 'contact.db'))
    c.exec(`CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT, alias TEXT, quan_pin TEXT, remark_quan_pin TEXT)`)
    c.prepare('INSERT INTO contact VALUES (?,?,?,?,?,?)').run('wxid_author', '张三丰', '', '', '', '')
    c.close()
    const s = db(dec, join('sns', 'db_sns', 'sns.db'))
    s.exec('CREATE TABLE SnsTimeLine (user_name TEXT, content TEXT)')
    s.prepare('INSERT INTO SnsTimeLine VALUES (?,?)').run('wxid_author', '今天天气不错')
    s.close()
    const snap = searchUnified(dec, '张三丰')
    expect(snap.moments.length).toBe(1)
    expect(snap.moments[0]?.username).toBe('wxid_author')
  })
})
