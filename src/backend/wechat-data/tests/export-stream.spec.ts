/**
 * M3：xlsx 流式（分块写 XML 到 zip 条目）+ 导出/备份的进度与取消（不留半成品）。
 *
 * 关键命题三条：
 *   ① 流式条目的**内容**必须与「整块 addFile」完全一致（归档格式不同 → 压缩块边界不同，
 *      但解出来的字节、CRC、条目名必须一模一样，否则 xlsx 会在 Excel 里坏掉）；
 *   ② 10 万行 xlsx 不再把整份 sheet 攒在内存里（RSS 实测见本文件的 gated 用例与报告）；
 *   ③ 取消/失败**不留半成品**：目标文件不存在，目录里也没有 `.partial-` / `.entry-` 残留。
 *
 * 内存实测为什么要门控：RSS 受 GC 时机、并行 worker、机器负载影响，放进 CI 只会变成
 * 随机红灯（与 export-memory.measure.spec.ts 同一套理由）。用 MEASURE_XLSX_STREAM=1 跑。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { CancelledError, ZipFileWriter, crc32, zipFiles } from '../src/query/zip.ts'
import { exportAllSessions, exportMoments, exportSessionMessages, exportSessionMessagesStreamed, writeXlsxStream } from '../src/query/export.ts'
import { createEncryptedBackup, listBackups, restoreEncryptedBackup } from '../src/query/backup.ts'

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

/** 目录（递归）里所有名字含 marker 的文件。 */
function findResidue(root: string, markers: string[]): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const name of readdirSafe(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (markers.some(m => name.includes(m))) out.push(p)
    }
  }
  walk(root)
  return out
}

interface ZipEntryRead {
  name: string
  method: number
  crc: number
  data: Buffer
}

/**
 * 最小 ZIP 读取器（只服务于断言）。
 * 为什么自己写：测试要同时校验「条目内容」和「本地头里的真实长度/CRC」，
 * 用现成解压库反而看不到这些字段。
 */
function unzip(buf: Buffer): ZipEntryRead[] {
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  expect(eocd).toBeGreaterThanOrEqual(0)
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const out: ZipEntryRead[] = []
  for (let i = 0; i < count; i += 1) {
    expect(buf.readUInt32LE(off)).toBe(0x02014b50)
    const method = buf.readUInt16LE(off + 10)
    const crc = buf.readUInt32LE(off + 16)
    const csize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8')
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28)
    const raw = buf.subarray(dataStart, dataStart + csize)
    out.push({ name, method, crc, data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw) })
    off += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** 取归档里某个条目的内容（字符串）。 */
function entryText(buf: Buffer, name: string): string {
  const e = unzip(buf).find(x => x.name === name)
  expect(e, '归档里缺少条目 ' + name).toBeTruthy()
  return (e as ZipEntryRead).data.toString('utf8')
}

/** 走流式写入器产出一个归档并读回字节。 */
async function viaStream(entries: Array<{ name: string; chunks: Buffer[] }>): Promise<Buffer> {
  const dir = tempDir('zip-stream-')
  const p = join(dir, 'out.zip')
  const w = await ZipFileWriter.create(p)
  for (const e of entries) await w.addStream(e.name, e.chunks)
  await w.close()
  return readFileSync(p)
}

function randomBytesBuffer(n: number, seed: number): Buffer {
  const b = Buffer.allocUnsafe(n)
  let x = Math.imul(seed + 1, 2654435761) >>> 0
  for (let i = 0; i < n; i += 1) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    b[i] = (x >>> 16) & 0xff
  }
  return b
}

/** 切块：展示「输入分块的边界」不应该影响输出内容。 */
function splitEvery(data: Buffer, size: number): Buffer[] {
  const out: Buffer[] = []
  for (let i = 0; i < data.length; i += size) out.push(data.subarray(i, i + size))
  return out
}

describe('ZipFileWriter.addStream：流式条目与整块条目内容等价', () => {
  it('同一组条目解出来的内容、CRC、条目名完全一致', async () => {
    const text = '第一行 中文🙂\n' + 'repeat '.repeat(30000)
    const payloads: Array<{ name: string; raw: Buffer }> = [
      { name: 'small.txt', raw: Buffer.from('hello 世界', 'utf8') },
      { name: 'big.txt', raw: Buffer.from(text, 'utf8') },
      { name: 'random.bin', raw: randomBytesBuffer(300000, 7) },
      { name: 'empty.txt', raw: Buffer.alloc(0) },
    ]
    const memory = zipFiles(payloads.map(p => ({ name: p.name, data: p.raw })))
    const streamed = await viaStream(payloads.map(p => ({ name: p.name, chunks: splitEvery(p.raw, 8192) })))

    const a = unzip(memory)
    const b = unzip(streamed)
    expect(b.map(e => e.name)).toEqual(a.map(e => e.name))
    for (const entry of a) {
      const s = b.find(e => e.name === entry.name) as ZipEntryRead
      expect(s.data.equals(entry.data), entry.name + ' 内容不一致').toBe(true)
      // 本地头/中央目录里的 CRC 必须真的等于内容 CRC（流式是分块累计出来的）。
      expect(s.crc).toBe(crc32(s.data))
      expect(s.crc).toBe(entry.crc)
    }
    // 流式条目无条件走 DEFLATE（不用比较压缩后长度，那样得要原始字节）。
    expect(b.every(e => e.method === 8)).toBe(true)
    // 整块路径对小内容会判 STORE —— 两条路的压缩选择本就允许不同。
    expect(a.find(e => e.name === 'small.txt')?.method).toBe(0)
  })

  it('按单字符切块（多字节 UTF-8 / emoji 跨界）也不改变内容', async () => {
    const text = '中文🙂emoji 混排 ab\u0000'
    const chunks: Buffer[] = []
    for (const ch of text) chunks.push(Buffer.from(ch, 'utf8'))
    const streamed = await viaStream([{ name: 'u.txt', chunks }])
    expect(entryText(streamed, 'u.txt')).toBe(text)
  })

  it('同名条目被跳过（与 zipFiles/addFile 行为一致）', async () => {
    const dir = tempDir('zip-dup-stream-')
    const p = join(dir, 'dup.zip')
    const w = await ZipFileWriter.create(p)
    expect(await w.addStream('a.txt', ['first'])).toBe(true)
    expect(await w.addStream('a.txt', ['second'])).toBe(false)
    await w.close()
    const entries = unzip(readFileSync(p))
    expect(entries.length).toBe(1)
    expect(entries[0]?.data.toString('utf8')).toBe('first')
  })
})

describe('ZipFileWriter.addStream：失败与取消不留临时文件', () => {
  it('分块源抛错 → reject，且条目临时文件被清掉', async () => {
    const dir = tempDir('zip-src-error-')
    const p = join(dir, 'out.zip')
    const w = await ZipFileWriter.create(p)
    async function* bad(): AsyncGenerator<Buffer> {
      yield Buffer.from('first chunk', 'utf8')
      throw new Error('源炸了')
    }
    await expect(w.addStream('a.txt', bad())).rejects.toThrow('源炸了')
    // 压缩临时文件（`<zip>.entry-N`）如果留在这里，就会出现在用户的导出目录里。
    expect(findResidue(dir, ['.entry-'])).toEqual([])
    await w.abort()
    expect(existsSync(p)).toBe(false)
  })

  it('取消（AbortSignal）→ 以 AbortError 中止，且不写归档', async () => {
    const dir = tempDir('zip-cancel-')
    const p = join(dir, 'out.zip')
    const w = await ZipFileWriter.create(p)
    const ac = new AbortController()
    async function* source(): AsyncGenerator<Buffer> {
      for (let i = 0; i < 1000; i += 1) {
        if (i === 5) ac.abort()
        yield Buffer.from('chunk ' + String(i) + '\n'.repeat(64), 'utf8')
      }
    }
    const err = await w.addStream('a.txt', source(), { signal: ac.signal }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CancelledError)
    expect((err as Error).name).toBe('AbortError')
    expect(findResidue(dir, ['.entry-'])).toEqual([])
    await w.abort()
    expect(existsSync(p)).toBe(false)
  })
})

/**
 * 造一个最小可用的已解密数据根（**decrypted 目录**）。
 * 列名必须与 messages.ts / sessions.ts 的读取口径对齐，缺列会直接抛 no such column。
 */
function makeDecryptedRoot(sessions: number, msgsPerSession: number): string {
  const root = tempDir('export-stream-root-')
  const decrypted = join(root, 'decrypted')
  mkdirSync(join(decrypted, 'session'), { recursive: true })
  mkdirSync(join(decrypted, 'message'), { recursive: true })

  const sdb = new DatabaseSync(join(decrypted, 'session', 'session.db'))
  sdb.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
  const insS = sdb.prepare('INSERT INTO SessionTable (username, display_name, last_timestamp, sort_timestamp, unread_count, last_msg_type, last_msg_sender) VALUES (?, ?, ?, ?, 0, 1, \'\')')
  const mdb = new DatabaseSync(join(decrypted, 'message', 'message_0.db'))
  let ts = 1700000000
  for (let s = 0; s < sessions; s += 1) {
    const u = 'wxid_s' + String(s)
    ts += 1
    insS.run(u, '会话 ' + String(s), ts, ts)
    const t = 'Msg_' + createHash('md5').update(u, 'utf8').digest('hex')
    mdb.exec(`CREATE TABLE "${t}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER)`)
    const ins = mdb.prepare(`INSERT INTO "${t}" VALUES (?,?,?,?,?,?,?,?)`)
    for (let i = 1; i <= msgsPerSession; i += 1) {
      ins.run(i, i, 1, i % 2, 1700000000 + i, 1, '第 ' + String(i) + ' 条消息 <含符号>&"\'', 'srv' + String(i))
    }
  }
  sdb.close()
  mdb.close()
  return decrypted
}

describe('xlsx 流式导出', () => {
  it('流式 xlsx 与内存版 xlsx 的 sheet 逐字节一致，且行数/条数正确', async () => {
    // 250 条 > XLSX_CHUNK_ROWS(200)，确保跨块边界；条数也要与返回的 count 对上。
    const decrypted = makeDecryptedRoot(1, 250)
    const dirA = tempDir('xlsx-sync-')
    const dirB = tempDir('xlsx-stream-')
    const a = exportSessionMessages(decrypted, 'wxid_s0', 'excel', 0, dirA, undefined, undefined, undefined, undefined, 'sync')
    const b = await exportSessionMessagesStreamed(decrypted, { username: 'wxid_s0', format: 'excel', count: 0, dir: dirB, filename: 'stream' })

    expect(a.count).toBe(250)
    expect(b.count).toBe(250)
    expect(a.filename).toBe('sync.xlsx')
    expect(b.filename).toBe('stream.xlsx')

    const sheetA = entryText(readFileSync(a.path), 'xl/worksheets/sheet1.xml')
    const sheetB = entryText(readFileSync(b.path), 'xl/worksheets/sheet1.xml')
    // 同一份数据两个入口：解出来的 sheet 必须一字不差（否则 Excel 里看到的内容会不同）。
    expect(sheetB).toBe(sheetA)
    expect((sheetA.match(/<row>/g) ?? []).length).toBe(251) // 表头 + 250 条
    expect(sheetA.includes('第 250 条消息 &lt;含符号&gt;&amp;&quot;')).toBe(true)
    // 其余部件也必须在（Excel 打开 xlsx 需要完整 OOXML 包）。
    for (const name of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels']) {
      entryText(readFileSync(b.path), name)
    }
  })

  it('10 万行 xlsx：边产出边落临时文件（不是攒完再压）', async () => {
    const dir = tempDir('xlsx-100k-')
    const out = join(dir, 'big.xlsx')
    const ac = new AbortController()
    let rows = 0
    let entryTempMidway = -1
    let entryTempBytes = -1
    const TOTAL = 100000
    function* gen(): Generator<string[]> {
      yield ['列1', '列2', '列3', '列4', '列5']
      for (let i = 1; i <= TOTAL; i += 1) {
        rows += 1
        // 到中段时看一次「有没有正在长大的条目临时文件」—— 这是「边产出边压缩」唯一的可观测面：
        // 若实现回退成「先把整份 sheet 拼成字符串再 addFile」，此刻不会有任何条目临时文件。
        if (i === 5000) {
          const temps = readdirSafe(dir).filter(f => f.includes('.entry-'))
          entryTempMidway = temps.length
          entryTempBytes = temps.length > 0 ? statSync(join(dir, temps[0] as string)).size : 0
        }
        yield ['2024-01-01 00:00', '我', '文本', '第 ' + String(i) + ' 行内容', String(i)]
      }
    }
    await writeXlsxStream(out, gen(), { signal: ac.signal })
    expect(rows).toBe(TOTAL)
    expect(entryTempMidway).toBe(1)
    // 中段时压缩结果已经落了一部分盘（不是「攒完再压」）。
    expect(entryTempBytes).toBeGreaterThan(0)
    expect(existsSync(out)).toBe(true)
    const sheet = entryText(readFileSync(out), 'xl/worksheets/sheet1.xml')
    expect((sheet.match(/<row>/g) ?? []).length).toBe(TOTAL + 1)
    expect(sheet.startsWith('<?xml')).toBe(true)
    expect(sheet.endsWith('</sheetData></worksheet>')).toBe(true)
    expect(sheet.includes('第 100000 行内容')).toBe(true)
    // 落地后目录里只剩成品。
    expect(findResidue(dir, ['.partial-', '.entry-'])).toEqual([])
  })
})

describe('导出入口的取消与进度', () => {
  it('exportAllSessions：上报逐会话进度；取消后不产出文件、不留残留', async () => {
    const decrypted = makeDecryptedRoot(20, 3)
    const outDir = tempDir('export-cancel-')
    const ac = new AbortController()
    const phases: string[] = []
    let sessionsTotal = 0
    let done = 0
    const err = await exportAllSessions(decrypted, {
      dir: outDir,
      filename: 'cancelled.zip',
      signal: ac.signal,
      onProgress: (p) => {
        phases.push(p.phase)
        if (p.phase === 'sessions') {
          sessionsTotal = p.total
          done = p.done
          // 第 3 个会话开始后取消：取消必须在下一次边界生效，而不是把整个归档写完。
          if (p.done >= 2) ac.abort()
        }
      },
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(CancelledError)
    expect(phases.includes('sessions')).toBe(true)
    expect(sessionsTotal).toBe(20)
    expect(done).toBeGreaterThanOrEqual(2)
    expect(existsSync(join(outDir, 'cancelled.zip'))).toBe(false)
    expect(findResidue(outDir, ['.partial-', '.entry-'])).toEqual([])
    expect(readdirSafe(outDir)).toEqual([])
  })

  it('exportSessionMessages（同步入口）：收集阶段可取消，且不写文件', () => {
    const decrypted = makeDecryptedRoot(1, 250)
    const outDir = tempDir('export-sync-cancel-')
    const ac = new AbortController()
    let cancels = 0
    const err = (() => {
      try {
        return exportSessionMessages(decrypted, 'wxid_s0', 'excel', 0, outDir, undefined, undefined, undefined, undefined, 'cancelled', false, {
          signal: ac.signal,
          onProgress: (p) => {
            if (p.phase === 'collect' && p.done >= 100) {
              cancels += 1
              ac.abort()
            }
          },
        })
      } catch (e) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(CancelledError)
    expect(cancels).toBe(1)
    expect(readdirSafe(outDir)).toEqual([])
  })

  it('exportMoments：新增的进度/取消管线不影响正常路径', async () => {
    // 朋友圈导出此前没有任何用例覆盖；这里至少保证加了 ctrl 之后普通路径照常出文件。
    const decrypted = makeDecryptedRoot(1, 3)
    const outDir = tempDir('export-moments-')
    const phases: string[] = []
    const r = await exportMoments(decrypted, { format: 'txt', dir: outDir, filename: 'm', onProgress: (p) => phases.push(p.phase) })
    expect(r.count).toBe(0) // 夹具里没有 sns 库 → 0 条动态（queryMoments 的行为）
    expect(existsSync(r.path)).toBe(true)
    expect(findResidue(outDir, ['.partial-'])).toEqual([])
    expect(phases.includes('collect')).toBe(true)
  })

  it('exportMoments：取消后不写文件', async () => {
    const decrypted = makeDecryptedRoot(1, 3)
    const outDir = tempDir('export-moments-cancel-')
    const ac = new AbortController()
    ac.abort()
    const err = await exportMoments(decrypted, { format: 'txt', dir: outDir, filename: 'm', signal: ac.signal }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CancelledError)
    expect(readdirSafe(outDir)).toEqual([])
  })

  it('exportSessionMessages（同步入口）：xlsx 拼装阶段可取消，且不写文件', () => {
    // 收集已经结束、正在拼 sheet 时取消 —— 这条路径上唯一能拦住它的是拼装循环自身的取消检查
    // （没有 addStream 的分块检查兜底），所以专门覆盖。
    const decrypted = makeDecryptedRoot(1, 250)
    const outDir = tempDir('export-sync-format-cancel-')
    const ac = new AbortController()
    let formatEvents = 0
    const err = (() => {
      try {
        return exportSessionMessages(decrypted, 'wxid_s0', 'excel', 0, outDir, undefined, undefined, undefined, undefined, 'cancelled', false, {
          signal: ac.signal,
          onProgress: (p) => {
            if (p.phase !== 'format') return
            formatEvents += 1
            if (p.done >= 200) ac.abort()
          },
        })
      } catch (e) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(CancelledError)
    expect(formatEvents).toBeGreaterThanOrEqual(1)
    expect(readdirSafe(outDir)).toEqual([])
  })
})

describe('加密备份（.wcb）的取消与原子落地', () => {
  function makeBackupRoot(): string {
    const base = tempDir('wx-bkwcb-')
    const dec = join(base, 'decrypted')
    mkdirSync(join(dec, 'session'), { recursive: true })
    mkdirSync(join(dec, 'message'), { recursive: true })
    const bytes = Buffer.alloc(300000, 7)
    for (let i = 0; i < 4; i += 1) {
      // 多个文件才能「做完第 1 个再取消」，验证取消点确实在文件边界。
      writeFileSync(join(dec, i % 2 === 0 ? 'session' : 'message', 'db' + String(i) + '.db'), bytes)
    }
    return dec
  }

  it('取消后不留 .wcb、也不留临时文件，且能列出空备份列表', async () => {
    const dec = makeBackupRoot()
    const ac = new AbortController()
    const filesProgress: number[] = []
    const err = await createEncryptedBackup(dec, 'pw123', {
      signal: ac.signal,
      onProgress: (p) => {
        if (p.phase === 'files') {
          filesProgress.push(p.done)
          if (p.done >= 1) ac.abort()
        }
      },
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(CancelledError)
    expect(filesProgress.length).toBeGreaterThanOrEqual(1)
    const backupsDir = join(dec, '..', 'backups')
    expect(findResidue(backupsDir, ['.wcb', '.partial-'])).toEqual([])
    expect(listBackups(dec).items).toEqual([])
  })

  it('正常路径仍是可恢复的完整备份（temp+rename 改动后的回归）', async () => {
    const dec = makeBackupRoot()
    const entry = await createEncryptedBackup(dec, 'pw123')
    expect(entry.kind).toBe('enc')
    expect(existsSync(entry.path)).toBe(true)
    expect(findResidue(join(entry.path, '..'), ['.partial-'])).toEqual([])
    const back = restoreEncryptedBackup(dec, entry.name, 'pw123')
    expect(back.ok).toBe(true)
    expect(statSync(join(back.path as string, 'session', 'db0.db')).size).toBe(300000)
  })
})

/**
 * RSS 实测放在单独的门控文件里（`xlsx-stream.measure.spec.ts`）：同一进程里先跑别的用例
 * 会把基线抬高，测出来的「增长」就不再是这件事的增量。
 */

