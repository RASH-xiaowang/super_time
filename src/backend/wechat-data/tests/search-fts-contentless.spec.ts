/**
 * `message_fts` 是 FTS5 的**无内容表**（`content=''`）—— 这个口径要靠两侧钉住。
 *
 * ## 为什么值得单独一个文件
 *
 * 2026-09-24 为 N36 ①（单文件时长）查「建索引还能不能再省」时量到：同一份夹具
 * （700 行 × 21000 汉字 = 14MB 正文 / 42MB tokens 串）插入 2268ms → 1829ms、
 * 索引文件 **372MB → 175MB**。省下来的全是白抄的那份内容列 —— 因为**这两列从来没人读回去**：
 * 取原文一律 `JOIN message_meta`，高亮是应用层自己算的（`kb-search.ts` 里同样的理由写着为什么
 * 不能用 `snippet()`）。
 *
 * ## 但无内容表有两个「静默」的坑，所以要有这个文件
 *
 * ① **读列不报错、返回 `null`**（实测 `SELECT tokens FROM message_fts` ⇒ `{tokens: null}`）。
 *    这比抛异常坏：症状是「搜到了却没有正文」，而且只有真实数据才会踩到 ⇒ 这里用**源码守卫**拦，
 *    不用运行时断言（运行时根本不会响）。
 * ② 不能对它的 rowid 增量取值 —— 以及 `DELETE`/`UPDATE` 直接抛
 *    （实测 `cannot DELETE from contentless fts5 table`）。重建走的是事务里的 `DROP TABLE` + 重建，
 *    本来就不是 DELETE ⇒ 这条只是把「别改成 DELETE」钉住。
 *
 * ③ 物理布局变了 ⇒ 存量 v4 索引必须重建，不能与新代码混用。这里用「把 meta 里的版本改回 4，
 *    再叫一次构建，它必须重建」来验，而不是只验那个常量。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { closeAllTrackedDbs, openTrackedDb, removeDirWithRetry } from '../../tests/helpers/temp-db.ts'

import { INDEX_SCHEMA_VERSION, searchIndexPath } from '../src/query/search-scaffold.ts'
import { buildSearchIndex, searchIndexBatch } from '../src/query/search.ts'

const USER = 'wxid_fts_cl'
const scratch: string[] = []

afterEach(async () => {
  closeAllTrackedDbs()
  const list = scratch.splice(0)
  for (const d of list) {
    const r = await removeDirWithRetry(d)
    if (!r.ok) console.warn(`[search-fts-contentless] 临时目录未能删除（${r.code}）：${d}`)
  }
})

/** 一小份能读的数据根：一个会话、两条含关键词、两条不含。 */
function makeFixture (): string {
  const root = mkdtempSync(join(tmpdir(), 'fts-cl-'))
  scratch.push(root)
  const decrypted = join(root, 'decrypted')
  mkdirSync(join(decrypted, 'session'), { recursive: true })
  mkdirSync(join(decrypted, 'message'), { recursive: true })

  const sdb = openTrackedDb(join(decrypted, 'session', 'session.db'))
  sdb.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
  sdb.prepare('INSERT INTO SessionTable (username, display_name, last_timestamp, sort_timestamp, unread_count, last_msg_type, last_msg_sender) VALUES (?, ?, 1700000000, 1700000000, 0, 1, \'\')')
    .run(USER, '转账测试会话')
  sdb.close()

  const mdb = openTrackedDb(join(decrypted, 'message', 'message_0.db'))
  const t = 'Msg_' + createHash('md5').update(USER, 'utf8').digest('hex')
  mdb.exec(`CREATE TABLE "${t}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER, compress_content TEXT)`)
  const ins = mdb.prepare(`INSERT INTO "${t}" VALUES (?,?,?,?,?,?,?,?,?)`)
  const bodies = ['微信转账给你 100 元', '普通消息一条', '还有一笔微信转账', '再见']
  mdb.exec('BEGIN')
  bodies.forEach((b, i) => ins.run(i + 1, i + 1, 1, i % 2, 1700000000 + i, 1, b, 1000 + i, ''))
  mdb.exec('COMMIT')
  mdb.close()
  return decrypted
}

/** 读索引里 `message_fts` 的建表语句（sqlite_master 才是权威，不是源码字符串）。 */
function ftsDdl (decrypted: string): string {
  const db = openTrackedDb(searchIndexPath(decrypted), { readOnly: true })
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'message_fts'").get() as { sql?: string } | undefined
    return row?.sql ?? ''
  } finally {
    db.close()
  }
}

describe('message_fts 是无内容表：布局、版本与「不许读列」', () => {
  it('建出来的表 DDL 里确实带 content=\'\'（sqlite_master 为准）', async () => {
    const decrypted = makeFixture()
    const built = await buildSearchIndex(decrypted, true)
    expect(built.status, `构建没成功：${JSON.stringify(built)}`).toBe('ok')
    const ddl = ftsDdl(decrypted)
    expect(ddl, 'DDL 是空的说明读错了表名或库').not.toBe('')
    expect(ddl).toContain("content=''")
  })

  it('搜得到、原文来自 message_meta（无内容表不影响这两件事）', async () => {
    const decrypted = makeFixture()
    await buildSearchIndex(decrypted, true)
    const { hits, ranked } = searchIndexBatch(decrypted, ['微信转账'])
    expect(hits.length, '一条都没搜到 ⇒ MATCH 在无内容表上不工作了').toBeGreaterThan(0)
    expect(ranked, 'BM25 排序也要还在（rank 走的是索引，不是内容列）').toBe(true)
    expect(hits.some((h) => h.text.includes('微信转账')), '原文必须是真文本，而不是 null/空').toBe(true)
  })

  it('存量 v4 索引不会被当成"已经是新布局"（把 meta 里的版本改回 4，下一次构建必须重建）', async () => {
    const decrypted = makeFixture()
    await buildSearchIndex(decrypted, true)
    const db = openTrackedDb(searchIndexPath(decrypted))
    db.prepare("UPDATE meta SET value = '4' WHERE key = 'schema_version'").run()
    db.close()
    const again = await buildSearchIndex(decrypted, false)
    expect(again.status, '版本对不上却回了 exists ⇒ 老索引会带着内容列继续用').not.toBe('exists')
    expect(ftsDdl(decrypted)).toContain("content=''")
  })

  it('INDEX_SCHEMA_VERSION 已经不是 4（内容列的存在与否就靠这一次性开关区分）', () => {
    expect(INDEX_SCHEMA_VERSION).not.toBe('4')
    expect(/^\d+$/.test(INDEX_SCHEMA_VERSION), '版本号写法要和以前一致（纯数字字符串）').toBe(true)
  })
})

describe('源码守卫：没有任何路径去读 message_fts 的列（读它不报错、只返回 null）', () => {
  const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const QUERY_DIR = join(HERE, '..', 'src', 'query')

  /**
   * 去注释 —— 必须先去：`search-build.ts` 的建表注释里就写着「不许 `SELECT tokens/who FROM message_fts`」，
   * 不去注释的话守卫会把自己的**说明书**当成违规（第一版就是红在这里）。
   * @param t - 文件原文。
   * @returns 只剩代码的文本。
   */
  const stripComments = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')

  const files = ['search-scaffold.ts', 'search-build.ts', 'search-query.ts']
    .map((f) => ({ name: f, text: stripComments(readFileSync(join(QUERY_DIR, f), 'utf8')) }))

  /** 会拿到 null 的写法：从 message_fts 里 SELECT 列、或对它发 UPDATE/DELETE。 */
  const FORBIDDEN: Array<{ what: string, re: RegExp }> = [
    { what: '读 FTS 的列', re: /SELECT[^;]*\b(tokens|who)\b[^;]*FROM\s+message_fts/s },
    { what: '用 snippet()/highlight()', re: /\b(snippet|highlight)\s*\(\s*message_fts/ },
    { what: '对无内容表发 DELETE', re: /DELETE\s+FROM\s+message_fts/ },
    { what: '对无内容表发 UPDATE', re: /UPDATE\s+message_fts/ },
  ]

  it('三份查询模块里都不出现这些写法', () => {
    const bad: string[] = []
    for (const f of files) {
      expect(f.text.length, `${f.name} 没读到内容 —— 守卫要读的是真文件`).toBeGreaterThan(200)
      for (const { what, re } of FORBIDDEN) if (re.test(f.text)) bad.push(`${f.name}：${what}`)
    }
    expect(bad.join('\n'), '无内容表读列不报错、只返回 null ⇒ 必须先让这种写法进不来').toBe('')
  })

  it('这四条正则自己得有判别力（合成一段违规源码，必须每条都响）', () => {
    const evil = [
      "const a = db.prepare('SELECT tokens, who FROM message_fts').all()",
      "const b = db.prepare(\"SELECT snippet(message_fts, 0, '<b>', '</b>', '…', 8) FROM message_fts\").all()",
      "db.exec('DELETE FROM message_fts WHERE rowid = 1')",
      "db.exec(\"UPDATE message_fts SET who = 'x'\")",
    ].join('\n')
    const hit = FORBIDDEN.filter(({ re }) => re.test(evil))
    expect(hit.length, '四条违规写法应该四条全响').toBe(FORBIDDEN.length)
    // 反向：真·正确写法不许误报（走 message_meta 取原文、走 DROP 重建）
    const good = "SELECT m.text FROM message_fts JOIN message_meta m ON m.rowid = message_fts.rowid WHERE message_fts MATCH ?"
      + "\ndb.exec('DROP TABLE IF EXISTS message_fts')"
    for (const { what, re } of FORBIDDEN) expect(re.test(good), `误报：${what}`).toBe(false)
  })
})
