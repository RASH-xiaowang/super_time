/**
 * Data health snapshot over a minimal root: decrypted SQLite walk + store sizes.
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { checkDecryptedIntegrity, queryDbHealth } from '../src/query/db-health.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

describe('queryDbHealth', () => {
  it('walks the decrypted tree and reports plugin stores', () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-health-'))
    scratch.push(root)
    const dec = join(root, 'decrypted')
    mkdirSync(join(dec, 'session'), { recursive: true })
    mkdirSync(join(root, 'decoded_images'), { recursive: true })
    writeFileSync(join(dec, 'session', 'session.db'), 'x'.repeat(100))
    writeFileSync(join(root, 'decoded_images', 'a.png'), 'img')
    writeFileSync(join(root, 'wechat_tasks.db'), 'taskdb')

    const snap = queryDbHealth(dec)
    expect(snap.dbFiles).toBe(1)
    expect(snap.dbBytes).toBe(100)
    expect(snap.stores.some(s => s.name === 'wechat_tasks.db' && s.size > 0)).toBe(true)
    expect(snap.decodedImagesCount).toBe(1)
  })
})

/**
 * 第三类结论「本机体检不了」：微信的 `*_fts.db` 用的是编在微信里的分词器
 * （`MMFtsTokenizer`），本机 SQLite 装不上它，而 `PRAGMA integrity_check` 要实例化虚拟表
 * ⇒ 必然抛 SQLITE_ERROR（`SQL logic error`）。2026-10-13 真机三个 `*_fts.db` 因此被判成
 * 「多半被微信独占」，面板劝用户退微信 —— 退多少次都不会变。
 */
describe('checkDecryptedIntegrity · 本机体检不了的分词器', () => {
  /**
   * 造一个含 FTS5 虚拟表的库；`tokenizer` 是**真机上写在 DDL 里**的那个名字。
   *
   * 本机建不出 `MMFtsTokenizer` 的表（那正是这条用例要说的事），`node:sqlite` 也不许改
   * `sqlite_master`（`PRAGMA writable_schema` 在它这儿不生效，实测恒为 0），所以走
   * **等长字节替换**：建表时把分词器名字后面垫够空格，DDL 里那段引号文本与目标名字**一样长**，
   * 直接在文件里换掉。垫的空格是 FTS5 的合法分隔符（多余空白不产生参数）。
   */
  function makeFtsDb(dir: string, tokenizer: string): string {
    const p = join(dir, 'message', 'message_fts.db')
    mkdirSync(join(dir, 'message'), { recursive: true })
    // 目标名字比 `unicode61` 长的部分，先用空格垫在引号里 —— 这样文件里那段引号文本
    // 与目标名字**一样长**，可以原地替换。FTS5 按空白切分词器参数，多余空白只是分隔符。
    const pad = ' '.repeat(Math.max(0, tokenizer.length - 'unicode61'.length))
    const db = new DatabaseSync(p)
    try {
      db.exec(`CREATE VIRTUAL TABLE message_fts_v4_0 USING fts5(a, tokenize='unicode61${pad}')`)
      db.exec("INSERT INTO message_fts_v4_0 VALUES('hello world')")
    } finally {
      db.close()
    }
    if (tokenizer === 'unicode61') return p
    const from = Buffer.from(`'unicode61${pad}'`, 'utf8')
    const to = Buffer.from(`'${tokenizer}'`, 'utf8')
    if (to.length !== from.length) {
      throw new Error(`夹具要求分词器名字与 unicode61 等长（9 字节），收到 ${tokenizer}`)
    }
    const bytes = readFileSync(p)
    const at = bytes.indexOf(from)
    if (at < 0) throw new Error('夹具里没找到 DDL 中的分词器名字')
    to.copy(bytes, at)
    writeFileSync(p, bytes)
    return p
  }

  it('内置分词器的 FTS 库照常体检（先证明这条用例不是靠「FTS 一律检不了」蒙对的）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-fts-'))
    scratch.push(root)
    const dec = join(root, 'decrypted')
    makeFtsDb(dec, 'unicode61')
    const g = await checkDecryptedIntegrity(dec)
    expect(g).toMatchObject({ checked: 1, corrupted: [], unreadable: [], uncheckable: [] })
  })

  it('微信自带分词器 ⇒ 归 uncheckable，且说清是哪个分词器（不是损坏、不是占用）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-fts-'))
    scratch.push(root)
    const dec = join(root, 'decrypted')
    const file = makeFtsDb(dec, 'MMFtsTokenizer')
    // 先把真症状钉住：`PRAGMA integrity_check` 对这样的库**必然抛**（真机就是 `SQL logic error`）。
    const raw = new DatabaseSync(file, { readOnly: true })
    let threw = ''
    try { raw.prepare('PRAGMA integrity_check').all() } catch (e) { threw = (e as Error).message }
    raw.close()
    expect(threw).not.toBe('')
    // 而结论必须是「本机体检不了」，不是损坏、不是被占用。
    const g = await checkDecryptedIntegrity(dec)
    expect(g.corrupted).toEqual([])
    expect(g.unreadable).toEqual([])
    expect(g.uncheckable.map((x) => x.file)).toEqual(['message/message_fts.db'])
    expect(g.uncheckable[0]?.error).toContain('MMFtsTokenizer')
  })
})
