/**
 * M1：bootstrap 导入清单必须带上 `secrets.json` / `keys.json`。
 *
 * 为什么要单独锁住：密钥搬出 `config.json` 之后，**导入流程**（用 `DSH_WECHAT_SOURCE_DIR`
 * 从另一个 DSH 根搬数据）如果只复制 `config.json`，而那份 `config.json` 里已经没有密钥，
 * 结果就是「配置搬过来了、密钥整体静默丢失」—— 用户看不到任何报错，只在之后解密/API
 * 调用失败时才发现。复审实测：把白名单里的 `secrets.json` 去掉，全仓库**没有一条用例变红**。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapWechatData } from '../wechat-data/src/dirs.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

function tempDir(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `wx-dirs-${tag}-`))
  scratch.push(d)
  return d
}

const KEY = 'a'.repeat(64)

/** 造一个「旧根」：里面有解密库、密钥文件与各类运行时产物。 */
function makeSource(): string {
  const src = tempDir('src')
  mkdirSync(join(src, 'decrypted'), { recursive: true })
  writeFileSync(join(src, 'decrypted', 'session.db'), 'db', 'utf8')
  writeFileSync(join(src, 'decrypted', 'session.db-wal'), 'wal', 'utf8') // 运行时产物：不该被复制
  writeFileSync(join(src, 'decrypted', 'session.db-shm'), 'shm', 'utf8')
  writeFileSync(join(src, 'config.json'), '{"db_dir":"D:\\\\wx"}', 'utf8')
  writeFileSync(join(src, 'secrets.json'), JSON.stringify({ db_enc_key: KEY }), 'utf8')
  writeFileSync(join(src, 'keys.json'), '{"db_key":"k"}', 'utf8')
  writeFileSync(join(src, 'all_keys.json'), '{"_key_format":"wx_key_v4.1"}', 'utf8')
  writeFileSync(join(src, 'message_edits.db'), 'edits', 'utf8')
  return src
}

describe('bootstrap 导入清单', () => {
  it('把 secrets.json / keys.json 一起导入（否则跨根导入会静默丢密钥）', () => {
    const src = makeSource()
    const root = join(tempDir('dst'), 'wechat-data')
    const r = bootstrapWechatData({ DSH_WECHAT_DATA_DIR: root, DSH_WECHAT_SOURCE_DIR: src })
    expect(r.skipped).toBe(false)
    expect(r.copied).toContain('secrets.json')
    expect(r.copied).toContain('keys.json')
    // 内容也要真搬过来（只断言文件名会漏掉「复制了空文件」这类退化）
    expect(JSON.parse(readFileSync(join(root, 'secrets.json'), 'utf8'))['db_enc_key']).toBe(KEY)
    expect(existsSync(join(root, 'keys.json'))).toBe(true)
    expect(existsSync(join(root, 'config.json'))).toBe(true)
    expect(existsSync(join(root, 'all_keys.json'))).toBe(true)
    expect(existsSync(join(root, 'message_edits.db'))).toBe(true)
  })

  it('SQLite 运行时产物（-wal / -shm）不复制', () => {
    const src = makeSource()
    const root = join(tempDir('dst'), 'wechat-data')
    bootstrapWechatData({ DSH_WECHAT_DATA_DIR: root, DSH_WECHAT_SOURCE_DIR: src })
    expect(existsSync(join(root, 'decrypted', 'session.db'))).toBe(true)
    expect(existsSync(join(root, 'decrypted', 'session.db-wal'))).toBe(false)
    expect(existsSync(join(root, 'decrypted', 'session.db-shm'))).toBe(false)
  })

  it('目标根已有 decrypted 时跳过（一次性导入语义）', () => {
    const src = makeSource()
    const root = join(tempDir('dst'), 'wechat-data')
    mkdirSync(join(root, 'decrypted'), { recursive: true })
    const r = bootstrapWechatData({ DSH_WECHAT_DATA_DIR: root, DSH_WECHAT_SOURCE_DIR: src })
    expect(r.skipped).toBe(true)
    expect(existsSync(join(root, 'secrets.json'))).toBe(false)
  })

  it('没有源目录时不动目标（不抛）', () => {
    const root = join(tempDir('dst'), 'wechat-data')
    expect(() => bootstrapWechatData({ DSH_WECHAT_DATA_DIR: root })).not.toThrow()
    expect(bootstrapWechatData({ DSH_WECHAT_DATA_DIR: root }).skipped).toBe(true)
  })
})
