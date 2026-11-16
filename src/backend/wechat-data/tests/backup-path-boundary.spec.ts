/**
 * P1-08 / P1-09 / P2-03 / P3-03：备份与恢复的文件系统边界。
 *
 * ## 守的是什么
 *
 * ① `.wcb` 头里的 `f.name` 是**不可信输入**：旧实现直接 `join(target, f.name)`，
 *    `../` / 绝对路径 / 盘符都能把明文写到恢复目录之外；
 * ② `headerLen` 与单文件 `size` 在 MAC 校验之前就用于 `readExactFd` 分配 —— 一个几字节的
 *    恶意文件就能要求分配任意大的 Buffer（header）/ 在认证后立刻申请巨大 Buffer（size）；
 * ③ `deleteBackup` 用裸 `startsWith(dir)` 判断，`../backups-old` 这种名字也满足字符串前缀；
 * ④ 明文备份整目录 `cpSync` 会把 `-wal/-shm/-journal` 一起带走，恢复后可能回放陈旧 WAL；
 * ⑤ 恢复失败会在 `.restored` 留下半截明文，且该目录会被 `listBackups` 当成备份列出。
 *
 * 夹具用固定 salt 现造合法 HMAC 的 `.wcb` —— 只有密码持有者才能造出这种头，
 * 所以这些用例模拟的正是「共享密码 / 恶意备份文件」场景。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCipheriv, createHmac, scryptSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createBackup, deleteBackup, listBackups, restoreEncryptedBackup } from '../src/query/backup.ts'

const MAGIC = Buffer.from('DSHWCB1\n', 'utf8')
const SALT = Buffer.alloc(16, 5)

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

interface Root { base: string; dec: string; backups: string }

function makeRoot(): Root {
  const base = mkdtempSync(join(tmpdir(), 'wx-bk-boundary-'))
  scratch.push(base)
  const dec = join(base, 'decrypted')
  mkdirSync(dec, { recursive: true })
  return { base, dec, backups: join(base, 'backups') }
}

interface WcbEntry {
  name: string
  data: Buffer
  /** 头里声明的 size（默认 = data.length）；用于伪造负数/超大/超实际文件的大小。 */
  declaredSize?: number
  /** 故意改坏 GCM tag，模拟「头合法但文件体损坏」。 */
  tamperTag?: boolean
}

/**
 * 造一个头合法、HMAC 正确的 `.wcb`。
 * @param backups - backups 目录。
 * @param fileName - 备份文件名。
 * @param password - 口令。
 * @param entries - 分片清单（name 与数据）。
 * @returns 备份文件名。
 */
function writeWcb(backups: string, fileName: string, password: string, entries: WcbEntry[]): string {
  const key = scryptSync(password, SALT, 32)
  const ivs = entries.map((_, i) => Buffer.alloc(12, i + 1))
  const headerBuf = Buffer.from(JSON.stringify({
    version: 1,
    files: entries.map((e, i) => ({
      name: e.name,
      size: e.declaredSize ?? e.data.length,
      iv: ivs[i]!.toString('base64'),
    })),
  }), 'utf8')
  const mac = createHmac('sha256', key).update(headerBuf).digest()
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(headerBuf.length)
  const body: Buffer[] = []
  entries.forEach((e, i) => {
    const cipher = createCipheriv('aes-256-gcm', key, ivs[i]!)
    body.push(cipher.update(e.data), cipher.final())
    const tag = cipher.getAuthTag()
    if (e.tamperTag) tag[0] = tag[0]! ^ 0xff
    body.push(tag)
  })
  mkdirSync(backups, { recursive: true })
  writeFileSync(join(backups, fileName), Buffer.concat([MAGIC, SALT, lenBuf, headerBuf, mac, ...body]))
  return fileName
}

/** 本次恢复是否留下了 `.restored` / `.partial-` 临时目录。 */
function leftoverRestoreDirs(backups: string): string[] {
  if (!existsSync(backups)) return []
  return readdirSync(backups).filter(n => n.includes('.restored') || n.includes('.partial-'))
}

describe('P1-08 .wcb 恢复头：路径穿越', () => {
  it('拒绝 ../、反斜杠穿越、绝对路径、盘符与 UNC，且目标目录外不落文件', () => {
    const { base, dec, backups } = makeRoot()
    const bad = [
      '../evil.txt',
      '..\\evil.txt',
      '/evil.txt',
      '\\\\server\\share\\evil.txt',
      'C:/evil.txt',
      'C:\\evil.txt',
      'session/../../evil.txt',
    ]
    bad.forEach((name, i) => {
      const file = writeWcb(backups, 'evil-' + String(i) + '.wcb', 'pw', [{ name, data: Buffer.alloc(0) }])
      const r = restoreEncryptedBackup(dec, file, 'pw')
      expect(r.ok, `${name} 竟然恢复成功了`).toBe(false)
      expect(r.error, `${name} 没有按「备份头异常」拒绝`).toContain('备份头异常')
      expect(existsSync(join(base, 'evil.txt')), `${name} 把文件写到了恢复目录外`).toBe(false)
      expect(leftoverRestoreDirs(backups), `${name} 失败后留下了半截恢复目录`).toEqual([])
    })
  })

  it('合法的嵌套相对路径仍能恢复（安全校验不能误伤正常备份）', () => {
    const { dec, backups } = makeRoot()
    const file = writeWcb(backups, 'ok.wcb', 'pw', [{ name: 'session/session.db', data: Buffer.from('hello') }])
    const r = restoreEncryptedBackup(dec, file, 'pw')
    expect(r.ok).toBe(true)
    expect(readFileSync(join(r.path as string, 'session', 'session.db'), 'utf8')).toBe('hello')
  })
})

describe('P1-08 .wcb 恢复头：认证前大分配', () => {
  it('headerLen 超过上限直接报备份头异常，而不是尝试读取/分配', () => {
    const { dec, backups } = makeRoot()
    mkdirSync(backups, { recursive: true })
    const lenBuf = Buffer.alloc(4)
    lenBuf.writeUInt32BE(9 * 1024 * 1024)
    const file = 'huge-header.wcb'
    writeFileSync(join(backups, file), Buffer.concat([MAGIC, SALT, lenBuf, Buffer.alloc(64)]))
    const r = restoreEncryptedBackup(dec, file, 'pw')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('备份头异常')
    expect(r.error, '说明校验发生在 readExactFd 分配之前').not.toContain('截断')
  })

  it('headerLen 为 0 也算头异常', () => {
    const { dec, backups } = makeRoot()
    mkdirSync(backups, { recursive: true })
    const lenBuf = Buffer.alloc(4)
    const file = 'zero-header.wcb'
    writeFileSync(join(backups, file), Buffer.concat([MAGIC, SALT, lenBuf, Buffer.alloc(64)]))
    expect(restoreEncryptedBackup(dec, file, 'pw').error).toContain('备份头异常')
  })

  it('负数 / 小数 / 超过安全整数 / 超上限的单文件 size 一律拒绝', () => {
    const { dec, backups } = makeRoot()
    const badSizes = [-1, 1.5, Number.MAX_SAFE_INTEGER + 2, 3 * 1024 * 1024 * 1024]
    badSizes.forEach((size, i) => {
      const file = writeWcb(backups, 'bad-size-' + String(i) + '.wcb', 'pw', [
        { name: 'session/session.db', data: Buffer.alloc(0), declaredSize: size },
      ])
      const r = restoreEncryptedBackup(dec, file, 'pw')
      expect(r.ok, `size=${String(size)} 被放行了`).toBe(false)
      expect(r.error, `size=${String(size)} 没有按头异常拒绝`).toContain('备份头异常')
    })
  })

  it('声明 size 超出备份实际剩余字节 ⇒ 头异常，不进入解密/写盘', () => {
    const { dec, backups } = makeRoot()
    const file = writeWcb(backups, 'oversize.wcb', 'pw', [
      { name: 'session/session.db', data: Buffer.alloc(0), declaredSize: 1024 * 1024 },
    ])
    const r = restoreEncryptedBackup(dec, file, 'pw')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('备份头异常')
    expect(leftoverRestoreDirs(backups)).toEqual([])
  })
})

describe('P3-03 恢复失败清理', () => {
  it('文件体损坏时清掉本次创建的半截目录，且保留上一次成功恢复的目录', () => {
    const { dec, backups } = makeRoot()
    // 上一次成功恢复出来的目录属于用户已有数据：失败路径不许删它。
    const previous = join(backups, 'broken.restored')
    mkdirSync(previous, { recursive: true })
    writeFileSync(join(previous, 'keep.txt'), 'keep')
    const file = writeWcb(backups, 'broken.wcb', 'pw', [
      { name: 'a/first.txt', data: Buffer.from('hello') },
      { name: 'b/second.txt', data: Buffer.from('world'), tamperTag: true },
    ])
    const r = restoreEncryptedBackup(dec, file, 'pw')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('解密校验失败')
    expect(readFileSync(join(previous, 'keep.txt'), 'utf8'), '把用户上次恢复的目录删了').toBe('keep')
    // 本次失败产生的临时目录必须清掉；`broken.restored` 是恢复前就存在的用户数据，
    // 不算残留（且内容没被动过）。
    expect(readdirSync(backups).filter(n => n.includes('.partial-')), '失败后留下了本次的半截临时目录').toEqual([])
    expect(readdirSync(previous)).toEqual(['keep.txt'])
    // `.restored` 不是备份（P3-03）：成功恢复物也不该出现在备份列表里。
    expect(listBackups(dec).items.filter(i => i.name.endsWith('.restored'))).toEqual([])
  })
})

describe('P1-09 deleteBackup 前缀逃逸', () => {
  it('../backups-old 等名字被拒，目录外内容不被删除', () => {
    const { base, dec } = makeRoot()
    const outside = join(base, 'backups-old')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'keep.txt'), 'keep')
    const names = ['../backups-old', '..\\backups-old', outside, '..']
    for (const name of names) {
      const r = deleteBackup(dec, name)
      expect(r.ok, `${name} 竟然删除了目录外内容`).toBe(false)
      expect(r.error).toBe('备份不存在')
    }
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('正常的单层备份名仍然可删除', () => {
    const { dec, backups } = makeRoot()
    const victim = join(backups, 'wechat_backup_20260101')
    mkdirSync(victim, { recursive: true })
    writeFileSync(join(victim, 'session.db'), 'x')
    expect(deleteBackup(dec, 'wechat_backup_20260101').ok).toBe(true)
    expect(existsSync(victim)).toBe(false)
  })
})

describe('P2-03 明文备份不夹带 SQLite sidecar', () => {
  it('cpSync 排除 -wal / -shm / -journal，源目录原样不动', async () => {
    const { dec } = makeRoot()
    const session = join(dec, 'session')
    mkdirSync(session, { recursive: true })
    writeFileSync(join(session, 'session.db'), 'db')
    for (const suffix of ['-wal', '-shm', '-journal']) {
      writeFileSync(join(session, 'session.db' + suffix), suffix)
    }
    const entry = await createBackup(dec)
    const names = readdirSync(join(entry.path, 'session'))
    expect(names).toContain('session.db')
    expect(names.filter(n => /-(wal|shm|journal)$/i.test(n)), '备份里夹带了 sidecar').toEqual([])
    // 源数据不受影响。
    for (const suffix of ['-wal', '-shm', '-journal']) {
      expect(existsSync(join(session, 'session.db' + suffix))).toBe(true)
    }
  })
})

describe('P3-03 listBackups 不把恢复临时目录当备份', () => {
  it('.restored 与 .partial-* 都不出现在备份列表里', () => {
    const { dec, backups } = makeRoot()
    mkdirSync(join(backups, 'wechat_backup_20260101.restored'), { recursive: true })
    mkdirSync(join(backups, 'wechat_backup_20260102.restored.partial-1-1'), { recursive: true })
    expect(listBackups(dec).items).toEqual([])
  })
})
