/**
 * M3 的内存实测（**不是回归用例**，因此靠环境变量门控跳过）。
 *
 * 为什么单独成文件、且单独跑：RSS/heapUsed 既有 GC 时机噪声，也会被同一进程里先跑过的
 * 其它用例抬高基线（第一版把实测放在 export-stream.spec.ts 里，流式那条测出「+0.0MB」，
 * 因为进程早被前面的用例撑大了 —— 数字不可信）。这里保持一个进程只跑这一个用例，
 * 顺序先流式（基线最干净）后攒内存做对照。
 *
 * 运行：
 *   MEASURE_XLSX_STREAM=1 npx vitest run src/backend/wechat-data/tests/xlsx-stream.measure.spec.ts
 *
 * 对照是什么：改造前的 `formatXlsx` 会先把所有行变成 `rows` 数组、再 `parts.join('')`
 * 拼出整份 sheet、最后整块 deflate。这里用同样的形状复刻那条路径（行数组 + join + 整块压）
 * 作为「攒内存」参照，而不是去调一个已经删掉的实现。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { zipFiles } from '../src/query/zip.ts'
import { exportSessionMessages, exportSessionMessagesStreamed, writeXlsxStream } from '../src/query/export.ts'

const scratch: string[] = []

const MB = (n: number): string => (n / 1024 / 1024).toFixed(1) + 'MB'

/** 采样 RSS 与 heapUsed 的峰值（增量）。 */
function peak(): { stop: () => { rss: number; heap: number } } {
  const base = process.memoryUsage()
  let rss = base.rss
  let heap = base.heapUsed
  const t = setInterval(() => {
    const v = process.memoryUsage()
    if (v.rss > rss) rss = v.rss
    if (v.heapUsed > heap) heap = v.heapUsed
  }, 10)
  if (t.unref) t.unref()
  return {
    stop: () => {
      clearInterval(t)
      const v = process.memoryUsage()
      if (v.rss > rss) rss = v.rss
      if (v.heapUsed > heap) heap = v.heapUsed
      return { rss: rss - base.rss, heap: heap - base.heapUsed }
    },
  }
}

/** 10 万行（含表头）的合成行源：每次现产一行，不预先生成数组。 */
function* rows(total: number): Generator<string[]> {
  yield ['时间', '发送者', '类型', '内容', 'localId']
  for (let i = 1; i <= total; i += 1) yield ['2024-01-01 00:00', '我', '文本', '第 ' + String(i) + ' 行内容', String(i)]
}

/** 改造前的形状：行数组 + join 出整份 sheet + 整块 deflate。 */
function legacyBuffered(total: number): number {
  const parts: string[] = []
  for (const row of rows(total)) parts.push('<row>' + row.map(c => '<c t="inlineStr"><is><t>' + c + '</t></is></c>').join('') + '</row>')
  const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet><sheetData>' + parts.join('') + '</sheetData></worksheet>'
  return zipFiles([{ name: 'sheet1.xml', data: sheet }]).length
}

describe.skipIf(process.env.MEASURE_XLSX_STREAM !== '1')('M3 实测：10 万行 xlsx', () => {
  it('流式峰值远低于攒内存路径', async () => {
    const TOTAL = Number(process.env.MEASURE_XLSX_ROWS ?? '100000')
    const dir = mkdtempSync(join(tmpdir(), 'measure-xlsx-'))
    scratch.push(dir)
    const out = join(dir, 'stream.xlsx')

    const stream = peak()
    await writeXlsxStream(out, rows(TOTAL))
    const streamPeak = stream.stop()

    const legacy = peak()
    const legacyBytes = legacyBuffered(TOTAL)
    const legacyPeak = legacy.stop()

    console.log('\nM3 实测（' + String(TOTAL) + ' 行 xlsx，含表头 ' + String(TOTAL + 1) + ' 行）')
    console.log('   流式路径     RSS 峰值增量 ' + MB(streamPeak.rss) + ' · heapUsed 峰值增量 ' + MB(streamPeak.heap) + ' · 产物 ' + MB(statSync(out).size))
    console.log('   攒内存路径   RSS 峰值增量 ' + MB(legacyPeak.rss) + ' · heapUsed 峰值增量 ' + MB(legacyPeak.heap) + ' · 压缩后 ' + MB(legacyBytes))
    console.log('   比值（攒内存/流式，按 RSS）：' + String(streamPeak.rss > 0 ? (legacyPeak.rss / streamPeak.rss).toFixed(1) : '∞'))

    expect(existsSync(out)).toBe(true)
    // 可失败的判据：流式峰值必须有上界，且明显低于攒内存路径（回退成攒内存即转红）。
    expect(streamPeak.rss).toBeLessThan(200 * 1024 * 1024)
    expect(legacyPeak.rss).toBeGreaterThan(streamPeak.rss)
  }, 600_000)

  it('真实链路：5 万条会话导出（同步内存版 vs 流式版）', async () => {
    // 单会话上限 5 万条（collectMessages），所以真实链路能到的最坏情形就是这里。
    const MSGS = Number(process.env.MEASURE_XLSX_SESSION_MSGS ?? '50000')
    const base = mkdtempSync(join(tmpdir(), 'measure-xlsx-session-'))
    scratch.push(base)
    const decrypted = join(base, 'decrypted')
    mkdirSync(join(decrypted, 'session'), { recursive: true })
    mkdirSync(join(decrypted, 'message'), { recursive: true })
    const sdb = new DatabaseSync(join(decrypted, 'session', 'session.db'))
    sdb.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
    sdb.prepare('INSERT INTO SessionTable VALUES (?, ?, 1700000000, 1700000000, 0, 1, \'\')').run('wxid_big', '大会话')
    sdb.close()
    const mdb = new DatabaseSync(join(decrypted, 'message', 'message_0.db'))
    const table = 'Msg_' + createHash('md5').update('wxid_big', 'utf8').digest('hex')
    mdb.exec(`CREATE TABLE "${table}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER)`)
    const ins = mdb.prepare(`INSERT INTO "${table}" VALUES (?,?,1,?,1700000000,1,?,?)`)
    mdb.exec('BEGIN')
    for (let i = 1; i <= MSGS; i += 1) ins.run(i, i, i % 2, '第 ' + String(i) + ' 条消息内容 xxxxxxxx', 'srv' + String(i))
    mdb.exec('COMMIT')
    mdb.close()

    const outDir = mkdtempSync(join(tmpdir(), 'measure-xlsx-out-'))
    scratch.push(outDir)

    const stream = peak()
    const streamed = await exportSessionMessagesStreamed(decrypted, { username: 'wxid_big', format: 'excel', count: 0, dir: outDir, filename: 'streamed' })
    const streamPeak = stream.stop()

    const legacy = peak()
    const legacyOut = exportSessionMessages(decrypted, 'wxid_big', 'excel', 0, outDir, undefined, undefined, undefined, undefined, 'legacy')
    const legacyPeak = legacy.stop()

    console.log('\nM3 实测（真实链路：' + String(MSGS) + ' 条会话 → xlsx）')
    console.log('   流式入口   RSS 峰值增量 ' + MB(streamPeak.rss) + ' · heapUsed ' + MB(streamPeak.heap) + ' · 产物 ' + MB(statSync(streamed.path).size))
    console.log('   同步内存版 RSS 峰值增量 ' + MB(legacyPeak.rss) + ' · heapUsed ' + MB(legacyPeak.heap) + ' · 产物 ' + MB(statSync(legacyOut.path).size))

    expect(streamed.count).toBe(MSGS)
    expect(legacyOut.count).toBe(MSGS)
    expect(existsSync(streamed.path)).toBe(true)
    // 同一个数据集、两个入口：条数一致（内容等价由 export-stream.spec.ts 逐字节断言）。
    expect(streamPeak.rss).toBeLessThan(300 * 1024 * 1024)
  }, 900_000)
})
