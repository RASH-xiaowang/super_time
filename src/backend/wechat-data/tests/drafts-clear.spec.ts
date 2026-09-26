/**
 * 草稿清除（P1-7：`query/drafts.ts` 此前零 spec 引用）。
 *
 * 这份用例真正逼出来的是一个**已经在发的缺陷**：两个导出函数都在
 * 「表不存在」的早退分支里自己 `db.close()`，而末尾的 `finally` 又 close 一次 ——
 * `node:sqlite` 对已关闭的连接再 close 会抛 `ERR_INVALID_STATE`，于是
 * **在 finally 里抛出**，函数返回的那条人话错误（`SessionTable 不存在`）被顶替成
 * 「database is not open」，面板把它原样渲染进 `role="alert"`：用户看到的是一句
 * 与真实原因无关的英文。所以本文件的第一条用例不是「功能对不对」，而是
 * 「失败时用户看到的到底是不是失败的原因」。
 * @vitest-environment node
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearAllSessionDrafts, clearSessionDraft } from '../src/query/drafts.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

/**
 * 造一个最小解密根。
 * @param rows - 会话行（`[username, draft]`）。
 * @param opts - `withoutTable` 时只建一张别的表（模拟「不是微信那种 session.db」）。
 * @returns 解密根目录。
 */
function makeRoot(rows: Array<[string, string]>, opts: { withoutTable?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'drafts-'))
  scratch.push(root)
  const sessionDir = join(root, 'session')
  mkdirSync(sessionDir, { recursive: true })
  const db = new DatabaseSync(join(sessionDir, 'session.db'))
  if (!opts.withoutTable) {
    db.exec('CREATE TABLE SessionTable (username TEXT, draft TEXT, timestamp INTEGER)')
    const ins = db.prepare('INSERT INTO SessionTable (username, draft, timestamp) VALUES (?,?,1700000000)')
    for (const [username, draft] of rows) ins.run(username, draft)
  } else {
    db.exec('CREATE TABLE SomethingElse (x INTEGER)')
  }
  db.close()
  return root
}

/** 读回某会话的草稿（直接开库，不经被测模块）。 */
function draftOf(root: string, username: string): string | undefined {
  const db = new DatabaseSync(join(root, 'session', 'session.db'), { readOnly: true })
  try {
    const row = db.prepare('SELECT draft FROM SessionTable WHERE username = ?').get(username) as { draft?: string } | undefined
    return row?.draft
  } finally { db.close() }
}

describe('clearSessionDraft', () => {
  it('清掉指定会话的草稿，别的会话不动（**不许**顺手全清）', () => {
    const root = makeRoot([['wxid_a', '要清掉的'], ['wxid_b', '别碰我']])
    const res = clearSessionDraft(root, 'wxid_a')
    expect(res).toEqual({ ok: true, updated: 1 })
    expect(draftOf(root, 'wxid_a')).toBe('')
    expect(draftOf(root, 'wxid_b'), '按 username 清除却动了别人 ⇒ 资金/隐私级别的范围错误').toBe('别碰我')
  })

  it('查无此人：ok 但 updated=0（不许把「没匹配」报成失败）', () => {
    const root = makeRoot([['wxid_a', 'x']])
    expect(clearSessionDraft(root, 'wxid_zzz')).toEqual({ ok: true, updated: 0 })
    expect(draftOf(root, 'wxid_a')).toBe('x')
  })

  it('session.db 不存在 ⇒ 报「不存在」这一条，而不是抛异常或假称成功', () => {
    const root = mkdtempSync(join(tmpdir(), 'drafts-empty-'))
    scratch.push(root)
    const res = clearSessionDraft(root, 'wxid_a')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('session.db')
  })

  it('库存在但没有 SessionTable ⇒ 错误文案是「SessionTable 不存在」，不是 close 抛出的 ERR_INVALID_STATE', () => {
    // 这就是本文件存在的首要理由：旧实现在这条路径上抛「database is not open」，
    // 因为早退分支 close 了一次、finally 又 close 一次。
    const root = makeRoot([], { withoutTable: true })
    const res = clearSessionDraft(root, 'wxid_a')
    expect(res.ok).toBe(false)
    expect(res.error, '用户看到的该是真实原因').toContain('SessionTable')
    expect(res.error ?? '').not.toMatch(/not open|ERR_INVALID_STATE/i)
  })
})

describe('clearAllSessionDrafts', () => {
  it('返回被清掉的草稿清单，并真的把它们清空', () => {
    const root = makeRoot([['wxid_a', '第一条'], ['wxid_b', ''], ['wxid_c', null as unknown as string], ['wxid_d', '第四条']])
    const res = clearAllSessionDrafts(root)
    expect(res.ok).toBe(true)
    // 空串与 NULL 都算「没有草稿」，不许混进清单（清单是给「撤销」用的，多一条就等于多一次误撤销）
    expect(res.cleared.map((c) => c.username).sort()).toEqual(['wxid_a', 'wxid_d'])
    expect(res.count).toBe(2)
    expect(draftOf(root, 'wxid_a')).toBe('')
    expect(draftOf(root, 'wxid_d')).toBe('')
  })

  it('第二次调用是空的：清完不留下「还有草稿」的假象', () => {
    const root = makeRoot([['wxid_a', 'x'], ['wxid_b', 'y']])
    expect(clearAllSessionDrafts(root).count).toBe(2)
    expect(clearAllSessionDrafts(root)).toEqual({ ok: true, cleared: [], count: 0 })
  })

  it('没有 SessionTable 时同样给出人话原因（与单条清除同一个坑）', () => {
    const root = makeRoot([], { withoutTable: true })
    const res = clearAllSessionDrafts(root)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('SessionTable')
    expect(res.error ?? '').not.toMatch(/not open|ERR_INVALID_STATE/i)
  })

  it('BLOB 形态的草稿解码成文本而不是 [object Object]（微信老库把 draft 存成二进制）', () => {
    const root = mkdtempSync(join(tmpdir(), 'drafts-blob-'))
    scratch.push(root)
    mkdirSync(join(root, 'session'), { recursive: true })
    const db = new DatabaseSync(join(root, 'session', 'session.db'))
    db.exec('CREATE TABLE SessionTable (username TEXT, draft BLOB, timestamp INTEGER)')
    db.prepare('INSERT INTO SessionTable VALUES (?,?,1700000000)').run('wxid_a', Buffer.from('中文草稿', 'utf8'))
    db.close()
    const res = clearAllSessionDrafts(root)
    expect(res.cleared).toEqual([{ username: 'wxid_a', draft: '中文草稿' }])
  })
})
