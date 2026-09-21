/**
 * `query/export.ts` 的「格式化器：文本/CSV/HTML/Markdown/SQL/JSON 与 xlsx 流式写出」部分（M21 拆分）。
 *
 * 从 `export.ts` 原样搬出，**行为逐字节不变**；`export.ts` 继续以 `export *` 转发
 * ⇒ 所有 `from './export.ts'` 的导入一行都不用改。
 *
 * @module export-format
 */

import { basename, dirname, join } from 'node:path'
import { ZipFileWriter, zipFiles, partialPath, reportProgress, throwIfCancelled } from './zip.ts'
import type { StreamControl } from './zip.ts'
import type { MomentItem, WechatMessage } from '../types.ts'
import { queryMessages } from './messages.ts'
import { writeZipAtomic } from './export-io.ts'
import { exportCsv } from './export-flows.ts'

/** Format a unix timestamp as YYYY-MM-DD HH:MM. */
export function fmtFull(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * Collect a conversation messages chronologically (oldest first).
 * @param decryptedDir - decrypted data root.
 * @param username - conversation username.
 * @param count - 0 = all (max 50000), else up to count.
 * @param ctrl - 可选的进度/取消（每页检查一次取消）。
 */
export function collectMessages(decryptedDir: string, username: string, count: number, ctrl?: StreamControl): WechatMessage[] {
  const target = count === 0 ? 50000 : Math.max(1, Math.min(count, 50000))
  const pages: WechatMessage[] = []
  let cursor: number | undefined
  let cursorLocalId: number | undefined
  let guard = 0
  while (pages.length < target && guard < 600) {
    // 分页收集是最长的同步循环之一（最多 500 轮），取消要在这里能生效。
    throwIfCancelled(ctrl?.signal)
    // 传复合游标，避免 sort_seq 重复处分页丢消息（导出必须一条不漏）。
    const env = queryMessages(decryptedDir, username, 100, cursor, undefined, cursorLocalId)
    if (env.messages.length === 0) break
    pages.push(...env.messages)
    // count=0（导全部）时总量未知，报 0 让调用方显示不定量进度，而不是永远停在 0%（目标上限是 5 万）。
    reportProgress(ctrl, 'collect', pages.length, count === 0 ? 0 : target)
    if (!env.hasMore) break
    cursor = env.cursor
    cursorLocalId = env.cursorLocalId
    guard += 1
  }
  // newest-first pages -> chronological (oldest first)
  const all = pages.slice(0, target).reverse()
  return all
}

/** Escape a CSV cell (wrap in quotes, double inner quotes). */
export function csvCell(v: string): string {
  return '"' + v.replace(/"/g, '""') + '"'
}

/**
 * UTF-8 BOM。**所有 CSV 都必须带上它**。
 *
 * 不带的后果（用户实测报障）：文件内容确实是 UTF-8，但 **Excel 在中文 Windows 上
 * 不会自动识别无 BOM 的 UTF-8**，会按系统 ANSI（GBK）去解码，于是中文整片乱码
 * （「用户名」变成「鐢ㄦ埛鍚」这类）。BOM 是 Office 认 UTF-8 的唯一可靠信号，
 * 也是官方推荐做法；记事本/VS Code/`Import-Csv` 都能正确跳过它。
 */
export const UTF8_BOM = '\uFEFF'

/**
 * 由「表头 + 数据行」构造 CSV 正文（带 UTF-8 BOM）。
 *
 * 所有 CSV 出口都走这里，避免再出现「某个出口忘了加 BOM」——此前 `formatCsv`
 * 与 `exportCsv` 各写一份、两份都没 BOM，就是这个问题的来源。
 *
 * @param header - 表头各列。
 * @param rows - 数据行（每行长度应与表头一致）。
 * @returns 可直接写盘的完整 CSV 文本（含 BOM）。
 */
export function buildCsv(header: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const lines = [header.map(csvCell).join(',')]
  for (const r of rows) lines.push(r.map(c => csvCell(c ?? '')).join(','))
  // CRLF：Excel 与 RFC 4180 的规范行结束符（LF 也能读，但 CRLF 兼容性最好）。
  return UTF8_BOM + lines.join('\r\n') + '\r\n'
}

/** HTML-escape a string. */
export function htmlEscape(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** Render one message row to export columns. */
export function rowOf(m: WechatMessage, username: string): { time: string; sender: string; typeLabel: string; text: string } {
  const sender = m.isSender === 1 ? '我' : (m.sender || username)
  const typeLabel = m.type === 1 ? '文本' : (m.typeLabel || String(m.type))
  // 导出同样只信 displayText：原始内容对表情/图片/视频是 XML 或 base64，
  // 导成 CSV/TXT 只会得到一堆属性串（与聊天界面此前的显示问题同源）。
  return { time: fmtFull(m.createTime), sender, typeLabel, text: m.displayText || '' }
}

/** txt export body. */
export function formatTxt(msgs: WechatMessage[], username: string): string {
  const lines = [`消息导出 (${msgs.length})`]
  lines.push('='.repeat(48))
  lines.push('')
  for (const m of msgs) {
    const r = rowOf(m, username)
    lines.push(r.time + ' ' + r.sender)
    lines.push(r.typeLabel + ': ' + r.text)
    lines.push('')
  }
  return lines.join('\n')
}

/** csv export body. */
export function formatCsv(msgs: WechatMessage[], username: string): string {
  const rows = msgs.map((m) => {
    const r = rowOf(m, username)
    return [r.time, r.sender, r.typeLabel, r.text]
  })
  return buildCsv(['时间', '发送者', '类型', '内容'], rows)
}

/** html chat-log export body (date dividers + bubbles). */
export function formatHtml(msgs: WechatMessage[], username: string, now: string): string {
  let body = ''
  let lastDay = ''
  for (const m of msgs) {
    const r = rowOf(m, username)
    const day = r.time.split(' ')[0] || ''
    if (day !== lastDay) {
      lastDay = day
      body += '<div class="date-divider"><span>' + htmlEscape(day) + '</span></div>'
    }
    const side = m.isSender === 1 ? 'right' : 'left'
    const content = m.type === 3 ? '<span class="muted">[图片]</span>' : htmlEscape(r.text)
    body += '<div class="row ' + side + '"><div class="bubble"><div class="sender">' + htmlEscape(r.sender) + '</div><div class="content">' + content + '</div><div class="time">' + htmlEscape(r.time) + '</div></div></div>'
  }
  return '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8"><title>微信聊天记录导出</title><style>body{font-family:-apple-system,Segoe UI,Microsoft YaHei,sans-serif;background:#ededed;margin:0;padding:24px 12px;color:#1f1f1f}.wrap{max-width:760px;margin:0 auto}.hd{text-align:center;padding:16px 0 8px}.hd h1{font-size:18px;margin:0 0 4px}.hd p{font-size:12px;color:#888;margin:0}.date-divider{text-align:center;margin:18px 0 10px}.date-divider span{background:#c8c8c8;color:#fff;font-size:11px;padding:2px 12px;border-radius:999px}.row{display:flex;margin:10px 0}.row.right{justify-content:flex-end}.bubble{max-width:72%;padding:9px 12px;border-radius:8px;background:#fff;position:relative;box-shadow:0 1px 2px rgba(0,0,0,.08)}.row.right .bubble{background:#95ec69}.sender{font-size:11px;color:#576b95;margin-bottom:3px}.content{font-size:14px;line-height:1.5;word-break:break-word}.time{font-size:10px;color:#aaa;margin-top:4px;text-align:right}.muted{color:#999;font-size:12px}</style></head><body><div class="wrap"><div class="hd"><h1>微信聊天记录</h1><p>共 ' + String(msgs.length) + ' 条消息 · 导出时间 ' + htmlEscape(now) + '</p></div>' + body + '</div></body></html>'
}

/** markdown chat-log export body (date dividers + bullets). */
export function formatMarkdown(msgs: WechatMessage[], username: string): string {
  const lines = ['# 微信聊天记录导出', '', '> 共 ' + String(msgs.length) + ' 条消息 · 导出时间 ' + new Date().toLocaleString(), '']
  let lastDay = ''
  for (const m of msgs) {
    const r = rowOf(m, username)
    const day = r.time.split(' ')[0] || ''
    if (day !== lastDay) {
      lastDay = day
      lines.push('## ' + day, '')
    }
    lines.push('**' + r.time + ' ' + r.sender + '**  ', r.typeLabel + '：' + r.text.replace(/\r?\n/g, '  '), '')
  }
  return lines.join('\n')
}

/** SQL export body (CREATE TABLE + INSERTs). */
export function formatSql(msgs: WechatMessage[], username: string): string {
  const q = (v: string): string => "'" + v.replace(/'/g, "''") + "'"
  const lines = [
    'CREATE TABLE IF NOT EXISTS chat_messages (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  chatroom TEXT NOT NULL,',
    '  create_time TEXT,',
    '  sender TEXT,',
    '  type_label TEXT,',
    '  content TEXT,',
    '  local_id INTEGER',
    ');',
    '',
  ]
  for (const m of msgs) {
    const r = rowOf(m, username)
    lines.push('INSERT INTO chat_messages (chatroom, create_time, sender, type_label, content, local_id) VALUES (' + q(username) + ', ' + q(r.time) + ', ' + q(r.sender) + ', ' + q(r.typeLabel) + ', ' + q(r.text) + ', ' + String(m.localId) + ');')
  }
  return lines.join('\n')
}

/** JSON export body. */
export function formatJson(msgs: WechatMessage[], username: string): string {
  const items = msgs.map((m) => {
    const r = rowOf(m, username)
    const item: Record<string, unknown> = {
      localId: m.localId,
      sortSeq: m.sortSeq ?? 0,
      time: r.time,
      sender: r.sender,
      type: m.type,
      typeLabel: r.typeLabel,
      content: r.text,
    }
    if (m.rich) item.rich = m.rich
    return item
  })
  return JSON.stringify(items, null, 2)
}

/** XML-escape a value for OOXML. */
export function xmlEsc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** sheet 的头部（`<sheetData>` 之前）—— 内存/流式两条路径必须拼出完全相同的字符串。 */
export const XLSX_SHEET_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
/** sheet 的尾部（`</sheetData>` 之后）。 */
export const XLSX_SHEET_TAIL = '</sheetData></worksheet>'

/**
 * 一块里放多少行。
 *
 * 块越大压缩率越好、内存上界越大：200 行 ≈ 24KB，10 万行的峰值也就几十 KB 级别，
 * 相对于「整份 sheet（10MB+）」差三个数量级。
 */
export const XLSX_CHUNK_ROWS = 200

/** xlsx 除 sheet1.xml 之外的固定部件（顺序与流式路径一致，避免两条路产物不同）。 */
export function xlsxStaticParts(): Array<{ name: string; data: string }> {
  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="聊天记录" sheetId="1" r:id="rId1"/></sheets></workbook>'
  const wbRel = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
  const rootRel = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '</Types>'
  return [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRel },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRel },
  ]
}

/** 一行 `<row>` 的 XML（表格内容为空时也保持与改造前一致的结构）。 */
export function xlsxRowXml(row: string[]): string {
  return '<row>' + row.map(c => '<c t="inlineStr"><is><t>' + xmlEsc(c) + '</t></is></c>').join('') + '</row>'
}

/**
 * 分块规则：按 `XLSX_CHUNK_ROWS` 行攒一块。
 *
 * 抽出来是为了让「内存版」和「流式版」用同一套规则 —— 否则两条路的产物一旦漂移，
 * 同一份数据经过两个入口导出的 xlsx 就不同了。
 */
export function makeXlsxChunker(ctrl: StreamControl | undefined, total: number): {
  push: (row: string[]) => string | null
  finish: () => string[]
} {
  let buf = ''
  let done = 0
  return {
    push: (row) => {
      throwIfCancelled(ctrl?.signal)
      buf += xlsxRowXml(row)
      done += 1
      if (done % XLSX_CHUNK_ROWS !== 0) return null
      const out = buf
      buf = ''
      reportProgress(ctrl, 'format', done, total)
      return out
    },
    finish: () => {
      const out: string[] = []
      if (buf) out.push(buf)
      reportProgress(ctrl, 'format', done, total)
      out.push(XLSX_SHEET_TAIL)
      return out
    },
  }
}

/**
 * sheetData 的分块源（同步行源）：内存版走这条，逐块 join 出与改造前相同的字符串。
 * @param rows - 行源（含表头）。
 * @param ctrl - 进度/取消。
 * @param total - 已知总行数（未知传 0，只影响进度展示）。
 */
export function* xlsxSheetChunks(
  rows: Iterable<string[]>,
  ctrl?: StreamControl,
  total = 0,
): Generator<string> {
  yield XLSX_SHEET_HEAD
  const chunker = makeXlsxChunker(ctrl, total)
  for (const row of rows) {
    const chunk = chunker.push(row)
    if (chunk !== null) yield chunk
  }
  yield* chunker.finish()
}

/**
 * sheetData 的分块源（同步/异步行源都可）：流式版走这条。
 *
 * 这是「xlsx 不再随行数涨内存」的关键——改造前是先把所有行变成 `rows` 数组、
 * 再由 `parts.join('')` 拼出整份 sheet，峰值与行数线性（10 万行时同时存在
 * 整份 XML 与所有行数组）。
 */
export async function* xlsxSheetChunksAsync(
  rows: Iterable<string[]> | AsyncIterable<string[]>,
  ctrl?: StreamControl,
  total = 0,
): AsyncGenerator<string> {
  yield XLSX_SHEET_HEAD
  const chunker = makeXlsxChunker(ctrl, total)
  for await (const row of rows) {
    const chunk = chunker.push(row)
    if (chunk !== null) yield chunk
  }
  for (const chunk of chunker.finish()) yield chunk
}

/** 消息 → xlsx 行（含表头）。 */
export function* messageRows(msgs: WechatMessage[], username: string): Generator<string[]> {
  yield ['时间', '发送者', '类型', '内容', 'localId']
  for (const m of msgs) {
    const r = rowOf(m, username)
    yield [r.time, r.sender, r.typeLabel, r.text, String(m.localId)]
  }
}

/** 内存版 sheet XML（与流式路径同一套分块规则，保证解出来的字节一致）。 */
export function xlsxSheetXml(rows: Iterable<string[]>, ctrl?: StreamControl): string {
  return Array.from(xlsxSheetChunks(rows, ctrl)).join('')
}

/**
 * Minimal real .xlsx (OOXML single sheet, no deps) —— 内存版，保持既有调用点行为不变。
 *
 * 行数不可控（整账号/大会话）时走 `writeXlsxStream`：那才是峰值与行数无关的路径。
 */
export function formatXlsx(msgs: WechatMessage[], username: string, ctrl?: StreamControl): Uint8Array {
  return zipFiles([
    ...xlsxStaticParts(),
    { name: 'xl/worksheets/sheet1.xml', data: xlsxSheetXml(messageRows(msgs, username), ctrl) },
  ])
}

/**
 * 把「一行一条记录」的流写成 .xlsx 文件（流式，峰值与行数无关）。
 *
 * 供大数据量导出使用：sheet XML 逐块产出 → `ZipFileWriter.addStream` 流式 deflate
 * → temp + rename 原子落地。取消/失败都不留半成品。
 *
 * @param filePath - 目标路径。
 * @param rows - 行源（含表头；同步或异步迭代器）。
 * @param ctrl - 可选的进度/取消。
 */
export async function writeXlsxStream(
  filePath: string,
  rows: Iterable<string[]> | AsyncIterable<string[]>,
  ctrl?: StreamControl,
): Promise<void> {
  await writeZipAtomic(filePath, async (zip) => {
    for (const part of xlsxStaticParts()) await zip.addFile(part.name, part.data)
    await zip.addStream('xl/worksheets/sheet1.xml', xlsxSheetChunksAsync(rows, ctrl), ctrl)
  })
}
