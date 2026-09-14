/**
 * 导出归档的流式改造（H8）验证。
 *
 * 关键命题：把「全部条目攒在内存再一次性 concat」换成「逐条目写盘」之后，
 * **归档格式必须一字不差**。这里用最直接的办法证明——
 * 对同一组条目分别走两条路径，逐字节比对。
 * @vitest-environment node
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ZipFileWriter, zipFiles } from '../src/query/zip.ts'
import { exportAllSessions } from '../src/query/export.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(d)
  return d
}

/** readdirSync 的容错包装（目录不存在时返回空）。 */
function readdirSafe(d: string): string[] {
  try {
    return readdirSync(d) as string[]
  } catch {
    return []
  }
}

/** 走流式写入器产出一个归档并读回字节。 */
async function viaWriter(entries: Array<{ name: string; data: string | Uint8Array }>): Promise<Buffer> {
  const dir = tempDir('zip-stream-')
  const p = join(dir, 'out.zip')
  const w = await ZipFileWriter.create(p)
  for (const e of entries) await w.addFile(e.name, e.data)
  await w.close()
  return readFileSync(p)
}

/** 一组覆盖各种形态的条目：可压缩文本 / 不可压缩字节 / 空 / 中文名 / 嵌套 / 反斜杠。 */
function sampleEntries(): Array<{ name: string; data: string | Uint8Array }> {
  const rnd = new Uint8Array(4096)
  for (let i = 0; i < rnd.length; i += 1) rnd[i] = (i * 7919 + 13) % 251
  return [
    { name: 'a.txt', data: 'hello 世界\n' + 'x'.repeat(5000) },
    { name: 'random.bin', data: rnd },
    { name: 'empty.txt', data: '' },
    { name: '中文 名称.txt', data: '中文内容\n' },
    { name: 'nested/dir/deep.txt', data: 'deep' },
    { name: 'back\\slash.txt', data: 'windows path' },
  ]
}

describe('ZipFileWriter 与 zipFiles 逐字节等价', () => {
  it('同一组条目两条路径产出完全相同的字节', async () => {
    const entries = sampleEntries()
    const memory = zipFiles(entries)
    const streamed = await viaWriter(entries)
    expect(streamed.equals(memory)).toBe(true)
  })

  it('同名条目都被跳过（行为一致）', async () => {
    const entries = [
      { name: 'dup.txt', data: 'first' },
      { name: 'dup.txt', data: 'second' },
    ]
    const memory = zipFiles(entries)
    const streamed = await viaWriter(entries)
    expect(streamed.equals(memory)).toBe(true)
  })

  it('压缩比不同的条目走同样的 STORE/DEFLATE 选择', async () => {
    // 可压缩 → method 8（deflate）；随机字节 → method 0（store）。
    // 两条路径必须做出相同选择，否则「字节等价」在混合输入上就会失效。
    const entries = [{ name: 'c.txt', data: Buffer.from('a'.repeat(20000), 'utf8') }]
    const memory = zipFiles(entries)
    const streamed = await viaWriter(entries)
    expect(streamed.equals(memory)).toBe(true)
    expect(memory.readUInt16LE(8)).toBe(8)
  })

  it('产出的归档结构自洽：本地头在开头、EOCD 在末尾、条目数正确', async () => {
    const entries = sampleEntries()
    const buf = await viaWriter(entries)
    expect(buf.readUInt32LE(0)).toBe(0x04034b50)
    const eocdOffset = buf.length - 22
    expect(buf.readUInt32LE(eocdOffset)).toBe(0x06054b50)
    expect(buf.readUInt16LE(eocdOffset + 10)).toBe(entries.length)
  })
})

describe('ZipFileWriter 的失败路径', () => {
  it('abort 会删掉半成品文件，不留下截断的归档', async () => {
    const dir = tempDir('zip-abort-')
    const p = join(dir, 'half.zip')
    const w = await ZipFileWriter.create(p)
    await w.addFile('a.txt', 'partial')
    expect(existsSync(p)).toBe(true)
    await w.abort()
    expect(existsSync(p)).toBe(false)
  })

  it('close 之后的 abort 是空操作：不能把一个已成功的归档删掉', async () => {
    // 评审实测过：原先 close() 后再 abort() 会把成品 DELETED ——
    // 而出错后的 catch 恰好最容易走到这条路径。
    const dir = tempDir('zip-close-abort-')
    const p = join(dir, 'done.zip')
    const w = await ZipFileWriter.create(p)
    await w.addFile('a.txt', 'ok')
    await w.close()
    expect(existsSync(p)).toBe(true)
    await w.abort()
    expect(existsSync(p)).toBe(true)
  })

  it('abort 之后再写入必须 reject，而不是永久挂起', async () => {
    // 这是 critical 的核心：写流被 destroy 后 write() 返回 false 且再不会 emit drain，
    // 若只等 drain 就会永久 HANG（用户看不到报错、RPC 等到超时、临时文件也不清理）。
    const dir = tempDir('zip-abort-write-')
    const p = join(dir, 'x.zip')
    const w = await ZipFileWriter.create(p)
    await w.abort()
    await expect(w.addFile('a.txt', 'after-abort')).rejects.toBeTruthy()
  })

  it('abort 之后再 close 会明确报错（而不是挂起）', async () => {
    const dir = tempDir('zip-abort-close-')
    const p = join(dir, 'y.zip')
    const w = await ZipFileWriter.create(p)
    await w.abort()
    await expect(w.close()).rejects.toThrow('已中止')
  })

  it('背压等待不累积监听器（原实现每次背压多留 2 个，1000 会话会到千级）', async () => {
    const dir = tempDir('zip-listeners-')
    const p = join(dir, 'big.zip')
    const w = await ZipFileWriter.create(p)
    const before = w.listenerCount
    for (let i = 0; i < 40; i += 1) {
      // 必须是**高熵**且大于写流默认 highWaterMark（16KB）的数据才会触发背压；
      // 用可压缩文本会因为压缩后 <16KB 而根本不进背压分支（假绿）。
      const big = Buffer.allocUnsafe(256 * 1024)
      let x = (i + 1) * 2654435761 >>> 0
      for (let j = 0; j < big.length; j += 1) {
        x = (Math.imul(x, 1103515245) + 12345) >>> 0
        big[j] = (x >>> 16) & 0xff
      }
      await w.addFile('b' + String(i) + '.bin', big)
    }
    const after = w.listenerCount
    await w.close()
    expect(after).toBeLessThanOrEqual(before + 1)
  })

  it('close 之后文件大小与内存路径的产出长度一致', async () => {
    const entries = sampleEntries()
    const dir = tempDir('zip-close-')
    const p = join(dir, 'out.zip')
    const w = await ZipFileWriter.create(p)
    for (const e of entries) await w.addFile(e.name, e.data)
    await w.close()
    expect(statSync(p).size).toBe(zipFiles(entries).length)
  })
})

/**
 * 造一个最小可用的已解密数据根，返回 **decrypted 目录**
 * （querySessions / collectMessages 要的就是它，不是数据根）。
 */
function makeDecryptedRoot(usernames: string[]): string {
  const root = tempDir('export-all-')
  const decrypted = join(root, 'decrypted')
  mkdirSync(join(decrypted, 'session'), { recursive: true })
  mkdirSync(join(decrypted, 'message'), { recursive: true })

  const sdb = new DatabaseSync(join(decrypted, 'session', 'session.db'))
  // 列名要与 sessions.ts 的读取口径对齐：它按 last_timestamp / sort_timestamp 排序，
  // 缺列会直接抛 no such column。
  sdb.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
  const insS = sdb.prepare('INSERT INTO SessionTable (username, display_name, last_timestamp, sort_timestamp, unread_count, last_msg_type, last_msg_sender) VALUES (?, ?, ?, ?, 0, 1, \'\')')
  let ts = 1700000000
  for (const u of usernames) {
    ts += 1
    insS.run(u, u, ts, ts)
  }
  sdb.close()

  const mdb = new DatabaseSync(join(decrypted, 'message', 'message_0.db'))
  for (const u of usernames) {
    const t = 'Msg_' + createHash('md5').update(u, 'utf8').digest('hex')
    mdb.exec(`CREATE TABLE "${t}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER)`)
    const ins = mdb.prepare(`INSERT INTO "${t}" VALUES (?,?,?,?,?,?,?,?)`)
    for (let i = 1; i <= 3; i += 1) {
      ins.run(i, i, 1, i % 2, 1700000000 + i, 1, '第 ' + String(i) + ' 条消息', 'srv' + String(i))
    }
  }
  mdb.close()
  return decrypted
}

describe('exportAllSessions 流式产出', () => {
  it('产出可用的归档，且条目数与消息总数正确', async () => {
    const decrypted = makeDecryptedRoot(['wxid_a', 'wxid_b'])
    const outDir = tempDir('export-out-')
    const r = await exportAllSessions(decrypted, { dir: outDir })
    expect(existsSync(r.path)).toBe(true)
    expect(r.filename.endsWith('.zip')).toBe(true)
    expect(r.count).toBe(6) // 两个会话 × 3 条

    const buf = readFileSync(r.path)
    expect(buf.readUInt32LE(0)).toBe(0x04034b50)
    expect(buf.readUInt32LE(buf.length - 22)).toBe(0x06054b50)
    expect(buf.readUInt16LE(buf.length - 22 + 10)).toBe(2) // 两个条目
    const asText = buf.toString('latin1')
    expect(asText.includes('wxid_a_')).toBe(true)
    expect(asText.includes('wxid_b_')).toBe(true)
  })

  it('重复导出同一数据集产出相同字节（确定性）', async () => {
    const decrypted = makeDecryptedRoot(['wxid_a'])
    const d1 = tempDir('export-det1-')
    const d2 = tempDir('export-det2-')
    const r1 = await exportAllSessions(decrypted, { dir: d1, filename: 'same.zip' })
    const r2 = await exportAllSessions(decrypted, { dir: d2, filename: 'same.zip' })
    expect(readFileSync(r2.path).equals(readFileSync(r1.path))).toBe(true)
  })

  it('导出失败不留半成品：目标目录里没有任何 .partial- 残留', async () => {
    const decrypted = makeDecryptedRoot(['wxid_a'])
    const outDir = tempDir('export-fail-')
    // 用 Windows 文件名不允许的 ':' 让写流在 open 阶段就失败：
    // 这条路径覆盖「打开失败」分支——连临时文件都不该留下。
    await expect(
      exportAllSessions(decrypted, { dir: outDir, filename: 'bad:name.zip' }),
    ).rejects.toBeTruthy()
    const leftovers: string[] = []
    const walk = (d: string): void => {
      for (const e of readdirSafe(d)) {
        const p = join(d, e)
        if (statSync(p).isDirectory()) walk(p)
        else if (e.includes('.partial-')) leftovers.push(p)
      }
    }
    walk(outDir)
    expect(leftovers).toEqual([])
  })
})
