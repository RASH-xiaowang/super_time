/**
 * Session message export (txt/csv/excel/html), rewritten from st_control
 * handlers/session/export.rs. Writes files under <decrypted>.parent()/exports
 * and returns the path + count. Chronological order (oldest first).
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ZipFileWriter, zipFiles } from './zip.ts'
import type { MomentItem, WechatMessage } from '../types.ts'
import { queryMessages } from './messages.ts'
import { queryContacts } from './contacts.ts'
import { queryFavorites } from './favorites.ts'
import { queryRecords } from './records.ts'
import { queryMoments } from './moments.ts'
import { getConfig } from './config.ts'
import { resolveSnsImageDataUrl } from './sns-image.ts'
import { resolveSnsVideoDataUrl } from './sns-video.ts'

/** Decode a base64 data URL to bytes (returns null when not a base64 data URL). */
/**
 * moments 打包的媒体条目上限。
 *
 * 与改造前保持一致：旧代码是「push 之后判断 `entries.length > 5000` 才 break」，
 * 而 entries 里第一个是 moments.json，所以媒体最多 5000 条。
 * 初版流式改造写成 `>= 4999`，饱和时会少导一条（评审复刻两循环实测出来的 off-by-one）。
 */
const MAX_MOMENT_MEDIA = 5000

/**
 * 原子落地用的临时文件名。
 *
 * 带进程内自增序号，不只是 pid：改成 async 之后同一进程里两个同名导出可以并发交错，
 * 只用 pid 的话两次导出会抢同一个临时文件、互相写坏。
 */
let partialSeq = 0
function partialPath(filePath: string): string {
  partialSeq += 1
  return filePath + '.partial-' + String(process.pid) + '-' + String(partialSeq)
}

/**
 * 原子写：先写同目录下的临时文件，再 rename 覆盖目标。
 *
 * 直接 writeFileSync 到目标路径时，中途失败（磁盘满、进程被杀、超时被掐）会留下一个
 * **看起来正常、实际截断**的导出文件 —— 比没有产出更糟，因为用户会以为导出成功了。
 * 同目录 rename 在 Windows 上同样是原子的（同一卷内不发生拷贝）。
 */
function writeFileAtomicSync(filePath: string, data: string | Uint8Array): void {
  const tmp = partialPath(filePath)
  try {
    writeFileSync(tmp, data)
    renameSync(tmp, filePath)
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 清理失败不掩盖原错误 */
    }
    throw e
  }
}

/**
 * 流式产出一个 ZIP 并原子落地。
 *
 * 与单文件版同理，但内容由 `produce` 现场逐条写入 —— 峰值内存只与**单个条目**相关，
 * 而不是所有条目之和（整账号归档最多 1000 个会话，原先会把全部文本堆在内存里）。
 * 每条写入都会 await 背压，因此也把事件循环让给同进程里的其它查询。
 *
 * @param filePath - 最终目标路径。
 * @param produce - 往写入器里添加条目的回调。
 */
async function writeZipAtomic(
  filePath: string,
  produce: (zip: ZipFileWriter) => Promise<void>,
): Promise<void> {
  const tmp = partialPath(filePath)
  let zip: ZipFileWriter | null = null
  try {
    // create 也放在 try 里：打开失败同样可能已经留下一个 0 字节的临时文件。
    zip = await ZipFileWriter.create(tmp)
    await produce(zip)
    await zip.close()
    renameSync(tmp, filePath)
  } catch (e) {
    // 失败必须删掉半成品：一个截断的 .zip 看起来是有效归档，打开才发现坏。
    if (zip) await zip.abort()
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 已删除 */
    }
    throw e
  }
}

function dataUrlToBuffer(url: string): Buffer | null {  const m = url.match(/^data:[^;,]+;base64,(.*)$/)
  if (!m || !m[1]) return null
  try { return Buffer.from(m[1], 'base64') } catch { return null }
}

/** Media-resolution context (raw base dir + image AES/xor keys) from config. */
function exportMediaCtx(decrypted: string): { base: string | undefined; aesKey: string | undefined; xorKey: number } {
  const cfg = getConfig(decrypted)
  const dbDir = typeof cfg['db_dir'] === 'string' ? cfg['db_dir'] : ''
  let base = ''
  if (dbDir) {
    const parts = dbDir.replace(/[\\/]+$/, '').split(/[\\/]/)
    base = (parts[parts.length - 1] ?? '') === 'db_storage' ? parts.slice(0, -1).join('/') : ''
  }
  const aesKey = typeof cfg['image_aes_key'] === 'string' && cfg['image_aes_key'].length > 0 ? cfg['image_aes_key'] : undefined
  const xorKey = Number(cfg['image_xor_key'] ?? 0xff)
  return { base: base || undefined, aesKey, xorKey }
}
import { queryPrivacyScan } from './privacy.ts'
import { queryAnnualReport } from './annual-report.ts'
import { querySessions } from './sessions.ts'

/** Format a unix timestamp as YYYY-MM-DD HH:MM. */
function fmtFull(ts: number): string {
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
 */
function collectMessages(decryptedDir: string, username: string, count: number): WechatMessage[] {
  const target = count === 0 ? 50000 : Math.max(1, Math.min(count, 50000))
  const pages: WechatMessage[] = []
  let cursor: number | undefined
  let cursorLocalId: number | undefined
  let guard = 0
  while (pages.length < target && guard < 600) {
    // 传复合游标，避免 sort_seq 重复处分页丢消息（导出必须一条不漏）。
    const env = queryMessages(decryptedDir, username, 100, cursor, undefined, cursorLocalId)
    if (env.messages.length === 0) break
    pages.push(...env.messages)
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
function csvCell(v: string): string {
  return '"' + v.replace(/"/g, '""') + '"'
}

/** HTML-escape a string. */
function htmlEscape(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** Render one message row to export columns. */
function rowOf(m: WechatMessage, username: string): { time: string; sender: string; typeLabel: string; text: string } {
  const sender = m.isSender === 1 ? '我' : (m.sender || username)
  const typeLabel = m.type === 1 ? '文本' : (m.typeLabel || String(m.type))
  // 导出同样只信 displayText：原始内容对表情/图片/视频是 XML 或 base64，
  // 导成 CSV/TXT 只会得到一堆属性串（与聊天界面此前的显示问题同源）。
  return { time: fmtFull(m.createTime), sender, typeLabel, text: m.displayText || '' }
}

/** txt export body. */
function formatTxt(msgs: WechatMessage[], username: string): string {
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
function formatCsv(msgs: WechatMessage[], username: string): string {
  const lines = ['时间,发送者,类型,内容']
  for (const m of msgs) {
    const r = rowOf(m, username)
    lines.push(csvCell(r.time) + ',' + csvCell(r.sender) + ',' + csvCell(r.typeLabel) + ',' + csvCell(r.text))
  }
  return lines.join('\n')
}

/** html chat-log export body (date dividers + bubbles). */
function formatHtml(msgs: WechatMessage[], username: string, now: string): string {
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
function formatMarkdown(msgs: WechatMessage[], username: string): string {
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
function formatSql(msgs: WechatMessage[], username: string): string {
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
function formatJson(msgs: WechatMessage[], username: string): string {
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
function xmlEsc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Minimal real .xlsx (OOXML single sheet, no deps). */
function formatXlsx(msgs: WechatMessage[], username: string): Uint8Array {
  const rows = [['时间', '发送者', '类型', '内容', 'localId']]
  for (const m of msgs) {
    const r = rowOf(m, username)
    rows.push([r.time, r.sender, r.typeLabel, r.text, String(m.localId)])
  }
  // 用数组拼接而不是 `cells +=`：后者在 10 万行时会产生大量中间字符串，
  // 而这里只需要一次 join 的一次性分配。
  const parts: string[] = []
  for (const row of rows) {
    parts.push('<row>' + row.map(c => '<c t="inlineStr"><is><t>' + xmlEsc(c) + '</t></is></c>').join('') + '</row>')
  }
  const cells = parts.join('')
  const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + cells + '</sheetData></worksheet>'
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
  return zipFiles([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRel },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRel },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ])
}

/** Collect merged chat-log media metadata for the ZIP manifest. */
function collectChatlogMedia(msgs: WechatMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const m of msgs) {
    const rich = m.rich
    if (!rich || rich.type !== 'chatlog' || !Array.isArray(rich.records)) continue
    for (const rec of rich.records) {
      const item: Record<string, unknown> = {
        name: rec.name,
        time: rec.time,
        text: rec.text,
        renderType: rec.renderType ?? (rec.isImage ? 'image' : 'text'),
      }
      if (rec.datatype) item.datatype = rec.datatype
      if (rec.fullmd5) item.fullmd5 = rec.fullmd5
      if (rec.thumbfullmd5) item.thumbfullmd5 = rec.thumbfullmd5
      if (rec.md5) item.md5 = rec.md5
      if (rec.cdnurlstring) item.cdnurlstring = rec.cdnurlstring
      if (rec.encrypturlstring) item.encrypturlstring = rec.encrypturlstring
      if (rec.link) item.link = rec.link
      if (rec.fromnewmsgid) item.fromnewmsgid = rec.fromnewmsgid
      out.push(item)
    }
  }
  return out
}

/** Filter by message types and/or rich sub-types (empty lists = keep all). */
function filterMessages(msgs: WechatMessage[], types?: number[], richTypes?: string[]): WechatMessage[] {
  const matchTypes = types !== undefined && types.length > 0
  const matchRich = richTypes !== undefined && richTypes.length > 0
  if (!matchTypes && !matchRich) return msgs
  const tList = matchTypes ? types : []
  const rList = matchRich ? richTypes : []
  return msgs.filter((m) => {
    if (matchTypes && matchRich) {
      return tList.includes(m.type) || (m.rich?.type ? rList.includes(m.rich.type) : false)
    }
    if (matchTypes) return tList.includes(m.type)
    return m.rich?.type ? rList.includes(m.rich.type) : false
  })
}

/**
 * Export a conversation messages to a file under the exports dir (or dir).
 * @param decryptedDir - decrypted data root.
 * @param username - conversation username.
 * @param format - txt | csv | excel | html | md | sql | json.
 * @param count - 0 = all (max 50000), else up to count.
 * @param dir - optional output directory (default <decrypted>.parent()/exports).
 * @param types - optional message type numbers filter (empty = keep all).
 * @param richTypes - optional rich sub-type filter (appmsg link/transfer/...).
 * @returns the written file path, filename and message count.
 */
/** Sanitize a user-supplied file basename (no separators / invalid chars). */
function sanitizeBasename(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 100)
}

export function exportSessionMessages(
  decryptedDir: string,
  username: string,
  format: string,
  count?: number,
  dir?: string,
  types?: number[],
  richTypes?: string[],
  from?: number,
  to?: number,
  filename?: string,
  zip?: boolean,
): { path: string; filename: string; count: number } {
  const all = collectMessages(decryptedDir, username, count ?? 0)
  const msgs = filterMessages(all, types, richTypes).filter((m) => {
    if (from && from > 0 && m.createTime < from) return false
    if (to && to > 0 && m.createTime > to) return false
    return true
  })
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/[-:]/g, '')
  const isXlsx = format === 'excel' || format === 'xls' || format === 'xlsx'
  const ext = isXlsx ? 'xlsx'
    : format === 'html' ? 'html'
      : format === 'csv' ? 'csv'
        : format === 'md' ? 'md'
          : format === 'sql' ? 'sql'
            : format === 'json' ? 'json' : 'txt'
  let content: string | Uint8Array = ''
  if (format === 'csv') content = formatCsv(msgs, username)
  else if (isXlsx) content = formatXlsx(msgs, username)
  else if (format === 'html') content = formatHtml(msgs, username, now)
  else if (format === 'md') content = formatMarkdown(msgs, username)
  else if (format === 'sql') content = formatSql(msgs, username)
  else if (format === 'json') content = formatJson(msgs, username)
  else content = formatTxt(msgs, username)
  const exportDir = (dir && dir.trim()) ? dir.trim() : join(dirname(decryptedDir), 'exports')
  mkdirSync(exportDir, { recursive: true })
  const sanitized = username.replace(/@chatroom$/, '').replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 24)
  const autoBase = sanitized + '_' + now + '_' + ((count ?? 0) === 0 ? 'all' : String(count))
  const userBase = filename && filename.trim() ? sanitizeBasename(filename.trim()) : ''
  const base = userBase || autoBase
  const outExt = zip ? 'zip' : ext
  const innerName = (base.toLowerCase().endsWith('.' + ext) ? base : base + '.' + ext)
  const filenameOut = (base.toLowerCase().endsWith('.' + outExt) ? base : base + '.' + outExt)
  const filepath = join(exportDir, filenameOut)
  if (zip) {
    const payload = zipFiles([
      { name: innerName, data: content },
      { name: 'record_media.json', data: JSON.stringify({ username, exportedAt: now, total: msgs.length, media: collectChatlogMedia(msgs) }, null, 2) },
    ])
    writeFileAtomicSync(filepath, payload)
  } else {
    writeFileAtomicSync(filepath, content)
  }
  return { path: filepath, filename: filenameOut, count: msgs.length }
}
/**
 * Export a data category to CSV under the exports dir.
 * @param decryptedDir - decrypted data root.
 * @param kind - contacts | favorites | records | moments.
 * @param recordsKind - record category when kind=records.
 * @returns the written file path, filename and row count.
 */
export function exportCsv(decryptedDir: string, kind: string, recordsKind?: string): { path: string; filename: string; count: number } {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/[-:]/g, '')
  const exportDir = join(dirname(decryptedDir), 'exports')
  mkdirSync(exportDir, { recursive: true })
  let rows: string[][] = []
  if (kind === 'contacts') {
    rows = [['用户名', '昵称', '备注', '类型']]
    const env = queryContacts(decryptedDir)
    for (const c of env.contacts) {
      rows.push([c.username, c.nickName, c.remark, c.category ?? ''])
    }
  } else if (kind === 'favorites') {
    rows = [['localId', '类型', '更新时间', '内容', '来源']]
    const env = queryFavorites(decryptedDir, 5000)
    for (const f of env.favorites) {
      rows.push([String(f.localId), String(f.type), String(f.updateTime), f.content, f.fromUsr])
    }
  } else if (kind === 'records') {
    rows = [['字段']]
    const env = queryRecords(decryptedDir, recordsKind ?? 'revokes', 5000)
    for (const it of env.items) {
      rows.push(Object.values(it).map(v => String(v)))
    }
  } else if (kind === 'moments') {
    rows = [['tid', '用户名', '作者', '时间', '内容', '媒体']]
    const env = queryMoments(decryptedDir, 0, 5000)
    for (const m of env.moments) {
      rows.push([m.tid, m.username, m.author, m.time, m.text, m.media_desc])
    }
  } else if (kind === 'privacy') {
    rows = [['类别', '会话', '联系人', '时间', '片段']]
    const env = queryPrivacyScan(decryptedDir)
    for (const c of env.categories) {
      for (const s of c.samples) {
        rows.push([c.label, s.username, s.name, s.time, s.snippet])
      }
    }
  } else {
    throw new Error('未知导出类型: ' + kind)
  }
  const lines = rows.map(r => r.map(c => csvCell(c)).join(','))
  const filename = kind + '_' + now + '.csv'
  const filepath = join(exportDir, filename)
  writeFileAtomicSync(filepath, lines.join('\n'))
  return { path: filepath, filename, count: Math.max(0, rows.length - 1) }
}

/** 安全字符串化。 */
function strOf(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  return ''
}

/** 百分比字符串。 */
function pctOf(v: unknown): string {
  const n = Number(v)
  return Number.isFinite(n) ? String(Math.round(n * 100)) + '%' : ''
}

/** 取榜单数组的前 N 项（转成简单对象）。 */
function topOf(arr: unknown, limit = 12): Array<{ username: string; name: string; count: number }> {
  if (!Array.isArray(arr)) return []
  return arr.slice(0, limit).map((it) => {
    const o = it as Record<string, unknown>
    const username = strOf(o['username'])
    return {
      username,
      name: strOf(o['name']) || username,
      count: Number(o['count'] ?? 0),
    }
  })
}

/**
 * Export the annual report as markdown / html / json.
 * @param decryptedDir - decrypted data root.
 * @param year - report year.
 * @param format - md | html | json.
 * @param dir - optional target directory (default exports dir).
 * @param filename - optional file name (without extension).
 * @returns written file path + filename + message count.
 */
export function exportAnnualReport(
  decryptedDir: string,
  year: number,
  format: string,
  dir?: string,
  filename?: string,
): { path: string; filename: string; count: number } {
  const report = queryAnnualReport(decryptedDir, year)
  const ext = format === 'html' ? 'html' : format === 'json' ? 'json' : 'md'
  const base = (dir && dir.trim()) ? dir.trim() : join(dirname(decryptedDir), 'exports')
  const safeName = (filename && filename.trim()) ? filename.trim().replace(/\.(md|html|json)$/i, '') + '.' + ext : 'wechat_annual_' + String(year) + '.' + ext
  mkdirSync(base, { recursive: true })
  let content = ''
  const total = Number(report['total'] ?? 0)
  const activeDays = Number(report['active_days'] ?? 0)
  const textChars = Number(report['text_chars'] ?? 0)
  const dailyAvg = Number(report['daily_avg'] ?? 0)
  const tags = Array.isArray(report['persona_tags']) ? report['persona_tags'].map(t => strOf(t)).join(' ') : ''
  const kinds = report['kind_counts'] as Record<string, unknown> | undefined
  const kindLine = kinds ? Object.entries(kinds).map(([k, v]) => k + ' ' + strOf(v)).join(' · ') : ''
  const phrases = Array.isArray(report['top_phrases'])
    ? report['top_phrases'].slice(0, 12).map((p) => {
      const o = p as Record<string, unknown>
      return strOf(o['phrase']) + '(' + strOf(o['count']) + ')'
    }).join(' · ')
    : ''
  const emoji = Array.isArray(report['top_emoji'])
    ? report['top_emoji'].slice(0, 8).map((e) => {
      const o = e as Record<string, unknown>
      return strOf(o['emoji']) + '×' + strOf(o['count'])
    }).join(' ')
    : ''
  const contacts = topOf(report['top_contacts'])
  const groups = topOf(report['top_groups'])
  const firstRaw = report['first_message']
  const lastRaw = report['last_message']
  const first = firstRaw == null ? '—' : strOf(firstRaw) || '—'
  const last = lastRaw == null ? '—' : strOf(lastRaw) || '—'
  if (ext === 'html') {
    const items: string[] = []
    items.push('<style>body{background:#0b0e13;color:#e6ebf2;font-family:sans-serif;max-width:760px;margin:40px auto;padding:0 18px}h1{color:#22d3ee}h2{border-left:4px solid #22d3ee;padding-left:8px;color:#fff}li{line-height:1.8}</style>')
    items.push('<h1>' + String(year) + ' 年，你说了 ' + String(total) + ' 条消息</h1>')
    items.push('<p>活跃 ' + String(activeDays) + ' 天 · 文字 ' + String(textChars) + ' 字 · 日均 ' + String(dailyAvg) + ' 条 · 人物标签: ' + (tags || '—') + '</p>')
    items.push('<p>类型占比: 文字 ' + pctOf(report['text_share']) + ' · 深夜 ' + pctOf(report['night_share']) + ' · 清晨 ' + pctOf(report['morning_share']) + ' · 周末 ' + pctOf(report['weekend_share']) + ' · 群聊 ' + pctOf(report['group_share']) + '</p>')
    if (kindLine) items.push('<h2>消息类型</h2><p>' + kindLine + '</p>')
    if (phrases) items.push('<h2>高频短语</h2><p>' + phrases + '</p>')
    if (emoji) items.push('<h2>表情宇宙</h2><p>' + emoji + '</p>')
    if (contacts.length > 0) {
      items.push('<h2>聊得最多的人</h2><ul>' + contacts.map(c => '<li>' + c.name + ' — ' + String(c.count) + ' 条</li>').join('') + '</ul>')
    }
    if (groups.length > 0) {
      items.push('<h2>最活跃的群聊</h2><ul>' + groups.map(c => '<li>' + c.name + ' — ' + String(c.count) + ' 条</li>').join('') + '</ul>')
    }
    items.push('<h2>首句与末句</h2><p><b>首句：</b>' + first + '</p><p><b>末句：</b>' + last + '</p>')
    content = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>微信年度总结 ' + String(year) + '</title>' + items.join('') + '</body></html>'
  } else if (ext === 'json') {
    content = JSON.stringify(report, null, 2)
  } else {
    const md: string[] = []
    md.push('# 微信年度总结 ' + String(year))
    md.push('')
    md.push('总消息 ' + String(total) + ' 条 · 活跃 ' + String(activeDays) + ' 天 · 文字 ' + String(textChars) + ' 字 · 日均 ' + String(dailyAvg) + ' 条')
    if (tags) md.push('人物标签: ' + tags)
    md.push('类型占比: 文字 ' + pctOf(report['text_share']) + ' · 深夜 ' + pctOf(report['night_share']) + ' · 清晨 ' + pctOf(report['morning_share']) + ' · 周末 ' + pctOf(report['weekend_share']) + ' · 群聊 ' + pctOf(report['group_share']))
    if (kindLine) md.push('消息类型: ' + kindLine)
    if (phrases) md.push('高频短语: ' + phrases)
    if (emoji) md.push('表情宇宙: ' + emoji)
    if (contacts.length > 0) {
      md.push('聊得最多的人:')
      contacts.forEach((c, i) => md.push(String(i + 1) + '. ' + c.name + ' — ' + String(c.count) + ' 条'))
    }
    if (groups.length > 0) {
      md.push('最活跃的群聊:')
      groups.forEach((c, i) => md.push(String(i + 1) + '. ' + c.name + ' — ' + String(c.count) + ' 条'))
    }
    md.push('首句: ' + first)
    md.push('末句: ' + last)
    content = md.join('\n')
  }
  const path = join(base, safeName)
  writeFileAtomicSync(path, content)
  return { path, filename: safeName, count: total }
}
/**
 * Export moments (朋友圈) as txt / html / json / csv with optional
 * author + time-range filters.
 * @param decryptedDir - decrypted data root.
 * @param opts - format/username/from/to/dir/filename.
 * @returns written file path + filename + count.
 */
export async function exportMoments(
  decryptedDir: string,
  opts?: {
    format?: string
    username?: string
    authorName?: string
    q?: string
    images?: boolean
    media?: string
    month?: string
    mine?: string
    zip?: boolean
    from?: number
    to?: number
    dir?: string
    filename?: string
  },
): Promise<{ path: string; filename: string; count: number }> {
  const format = opts?.format === 'html' ? 'html' : opts?.format === 'json' ? 'json' : opts?.format === 'csv' ? 'csv' : 'txt'
  const NL = String.fromCharCode(10)
  const items: MomentItem[] = []
  let offset = 0
  for (;;) {
    const env = queryMoments(decryptedDir, offset, 500, opts?.username)
    items.push(...env.moments)
    offset += env.moments.length
    if (env.moments.length < 500) break
    if (items.length > 10000) break
  }
  const from = opts?.from ?? 0
  const to = opts?.to ?? 0
  const q = (opts?.q ?? '').trim().toLowerCase()
  const authorName = (opts?.authorName ?? '').trim()
  const media = opts?.media
  const month = opts?.month
  const mine = opts?.mine
  const mediaCtx = (opts?.images && format === 'html') ? exportMediaCtx(decryptedDir) : undefined
  const filtered = items.filter((m) => {
    // 作者显示名（作者牌）精确匹配；username 是微信用户名（user_name，深链），由 queryMoments 在库级过滤。
    if (authorName && m.author !== authorName) return false
    // 媒体类型（与列表类型筛选一致）。
    if (media && media !== 'all') {
      if (media === 'image' && m.images.length === 0) return false
      if (media === 'video' && m.videos.length === 0) return false
      if (media === 'link' && !(m.link_title || m.contentType === 3 || m.contentType === 28)) return false
      if (media === 'location' && !m.location) return false
      if (media === 'text' && !(m.images.length === 0 && m.videos.length === 0 && !m.link_title)) return false
    }
    // 范围（我/他人）。
    if (mine === 'mine' && !m.is_self) return false
    if (mine === 'others' && m.is_self) return false
    // 月份（YYYY-MM）。
    if (month && m.ts) {
      const d = new Date(m.ts * 1000)
      const k = String(d.getFullYear()) + '-' + String(d.getMonth() + 1).padStart(2, '0')
      if (k !== month) return false
    }
    if (from > 0 && m.ts < from) return false
    if (to > 0 && m.ts > to) return false
    if (!q) return true
    return m.author.toLowerCase().includes(q)
      || m.text.toLowerCase().includes(q)
      || m.location.toLowerCase().includes(q)
      || m.link_title.toLowerCase().includes(q)
      || (m.link_url ?? '').toLowerCase().includes(q)
      || (m.sourceNickName ?? '').toLowerCase().includes(q)
      || (m.publicUserName ?? '').toLowerCase().includes(q)
      || m.likes.some(l => (l.nickname || l.username).toLowerCase().includes(q))
      || m.comments.some(c => (c.nickname || c.username).toLowerCase().includes(q) || c.content.toLowerCase().includes(q))
  })
  const base = (opts?.dir && opts.dir.trim()) ? opts.dir.trim() : join(dirname(decryptedDir), 'exports')
  mkdirSync(base, { recursive: true })
  // ZIP：JSON 数据 + 离线媒体（图片/视频），做成可归档的媒体包。
  if (opts?.zip) {
    const mediaCtx = exportMediaCtx(decryptedDir)
    const rawName = (opts.filename ?? '').trim()
    const zipBase = rawName ? rawName.replace(/\.zip$/i, '') : ''
    const zipName = zipBase ? zipBase + '.zip' : 'wechat_moments_' + String(Date.now()) + '.zip'
    const zipPath = join(base, zipName)
    // 媒体逐条写入：原先最多把 5000 个图片/视频 buffer 攒在 entries 里再一次性压缩，
    // 单条视频几十 MB 时峰值很容易上到 GB 级。上限语义（含 moments.json 在内 ≤5000 条）
    // 保持不变，只是改成边产出边写。
    let mediaCount = 0
    await writeZipAtomic(zipPath, async (zip) => {
      await zip.addFile('moments.json', JSON.stringify(filtered, null, 2))
      let idx = 0
      for (const m of filtered) {
        if (mediaCount >= MAX_MOMENT_MEDIA) break
        for (const im of m.images) {
          if (mediaCount >= MAX_MOMENT_MEDIA) break
          const r = im.md5 ? resolveSnsImageDataUrl(mediaCtx.base, mediaCtx.aesKey, mediaCtx.xorKey, im.md5, im.timelineId, im.id) : { error: '' }
          if (r.url) {
            const buf = dataUrlToBuffer(r.url)
            if (buf) { await zip.addFile('media/images/img_' + String(idx++) + '.jpg', buf); mediaCount += 1 }
          }
        }
        if (mediaCount >= MAX_MOMENT_MEDIA) break
        for (const v of m.videos) {
          if (mediaCount >= MAX_MOMENT_MEDIA) break
          const r = resolveSnsVideoDataUrl(mediaCtx.base, v.md5, v.timelineId, v.id)
          if (r.url) {
            const buf = dataUrlToBuffer(r.url)
            if (buf) { await zip.addFile('media/videos/vid_' + String(idx++) + '.mp4', buf); mediaCount += 1 }
          }
        }
      }
    })
    return { path: zipPath, filename: zipName, count: filtered.length }
  }
  const ext = format
  const name = (opts?.filename && opts.filename.trim())
    ? opts.filename.trim().replace(/\.(txt|html|json|csv)$/i, '') + '.' + ext
    : 'wechat_moments_' + String(Date.now()) + '.' + ext
  let content = ''
  if (ext === 'json') {
    content = JSON.stringify(filtered, null, 2)
  } else if (ext === 'csv') {
    const lines = ['时间,作者,内容,图片数,视频数,位置,链接标题,链接URL']
    for (const m of filtered) {
      lines.push(csvCell(m.time) + ',' + csvCell(m.author) + ',' + csvCell(m.text) + ',' + String(m.images.length) + ',' + String(m.videos.length) + ',' + csvCell(m.location) + ',' + csvCell(m.link_title) + ',' + csvCell(m.link_url ?? ''))
    }
    content = lines.join(NL)
  } else if (ext === 'html') {
    const parts: string[] = []
    parts.push('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>微信朋友圈导出</title>')
    parts.push('<style>body{background:#f2f2f2;font-family:sans-serif;margin:0;padding:24px 12px;color:#222}.wrap{max-width:680px;margin:0 auto}.hd{text-align:center;margin-bottom:18px}.card{background:#fff;border-radius:12px;padding:14px 16px;margin:12px 0;box-shadow:0 1px 3px rgba(0,0,0,.08)}.meta{color:#888;font-size:12px;margin-bottom:6px}.content{font-size:14px;line-height:1.6;white-space:pre-wrap}.tag{color:#576b95;font-size:12px;margin-top:6px}.divider{text-align:center;color:#bbb;font-size:12px;margin:14px 0}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px}.grid img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:6px;display:block}.grid.single{grid-template-columns:1fr;max-width:240px}</style></head><body><div class="wrap"><div class="hd"><h1>微信朋友圈</h1><p>共 ' + String(filtered.length) + ' 条动态</p></div>')
    for (const m of filtered) {
      parts.push('<div class="card"><div class="meta">' + htmlEscape(m.author) + ' · ' + htmlEscape(m.time) + '</div>')
      if (m.text) parts.push('<div class="content">' + htmlEscape(m.text) + '</div>')
      if (m.images.length > 0) {
        const single = m.images.length === 1 ? ' single' : ''
        const imgs = m.images.map((im) => {
          let src = im.url || im.thumb || ''
          if (mediaCtx && im.md5) {
            const r = resolveSnsImageDataUrl(mediaCtx.base, mediaCtx.aesKey, mediaCtx.xorKey, im.md5, im.timelineId, im.id)
            if (r.url) src = r.url
          }
          return '<img src="' + htmlEscape(src) + '" loading="lazy" />'
        }).join('')
        parts.push('<div class="grid' + single + '">' + imgs + '</div>')
      }
      if (m.videos.length > 0) {
        // 视频本体不内嵌，仅封面（CDN 缩略图）作为占位。
        const cover = (m.videos[0] && (m.videos[0].thumb || ''))
        parts.push('<div class="tag">视频×' + String(m.videos.length) + (cover ? ' <img src="' + htmlEscape(cover) + '" style="width:36px;height:36px;object-fit:cover;border-radius:4px;vertical-align:middle;margin-left:4px" />' : '') + '</div>')
      }
      if (m.location) parts.push('<div class="tag">📍' + htmlEscape(m.location) + '</div>')
      if (m.link_title) {
        const link = m.link_url ? ' href="' + htmlEscape(m.link_url) + '" target="_blank" rel="noopener"' : ''
        parts.push('<div class="tag"><a' + link + '>🔗' + htmlEscape(m.link_title) + '</a></div>')
      }
      if (m.likes.length > 0) parts.push('<div class="tag">❤ ' + htmlEscape(m.likes.map(l => l.nickname || l.username || '').join('、')) + '</div>')
      if (m.comments.length > 0) {
        parts.push('<div class="tag">💬 ' + String(m.comments.length) + ' 条评论</div>')
        for (const c of m.comments) {
          parts.push('<div class="tag" style="color:#555">' + htmlEscape((c.nickname || c.username) + (c.content ? '：' + c.content : '')) + '</div>')
        }
      }
      parts.push('</div>')
    }
    parts.push('</div></body></html>')
    content = parts.join('')
  } else {
    const lines: string[] = []
    for (const m of filtered) {
      lines.push(m.time + ' ' + m.author)
      if (m.text) lines.push(m.text)
      const tags: string[] = []
      if (m.images.length > 0) tags.push('图片×' + String(m.images.length))
      if (m.videos.length > 0) tags.push('视频×' + String(m.videos.length))
      if (m.location) tags.push('📍' + m.location)
      if (m.link_title) tags.push('🔗' + m.link_title + (m.link_url ? ' ' + m.link_url : ''))
      if (tags.length > 0) lines.push(tags.join('  '))
      lines.push('---')
    }
    content = lines.join(NL)
  }
  const path = join(base, name)
  writeFileAtomicSync(path, content)
  return { path, filename: name, count: filtered.length }
}
/**
 * Export ALL sessions as a single txt ZIP archive (账号归档).
 * @param decryptedDir - decrypted data root.
 * @param opts - optional dir/filename.
 * @returns written zip path + filename + total messages.
 */
export async function exportAllSessions(
  decryptedDir: string,
  opts?: { dir?: string; filename?: string },
): Promise<{ path: string; filename: string; count: number }> {
  const env = querySessions(decryptedDir)
  const sessions = env.sessions.slice(0, 1000)
  const base = (opts?.dir && opts.dir.trim()) ? opts.dir.trim() : join(dirname(decryptedDir), 'exports')
  mkdirSync(base, { recursive: true })
  const filename = (opts?.filename && opts.filename.trim()) ? (opts.filename.trim().endsWith('.zip') ? opts.filename.trim() : opts.filename.trim() + '.zip') : 'wechat_all_sessions_' + String(Date.now()) + '.zip'
  const path = join(base, filename)
  const seen = new Set<string>()
  let total = 0
  // 逐会话产出并写盘：峰值内存与「单个会话」相关，而不是 1000 个会话之和。
  // 原先每个会话的文本都先 push 进 entries、最后一次性 concat + 压缩，
  // 最坏情形常驻数 GB 且全程同步。
  await writeZipAtomic(path, async (zip) => {
    for (const s of sessions) {
      const msgs = collectMessages(decryptedDir, s.username, 0)
      const safeName = (s.displayName || s.username).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 40)
      const uid = s.username.replace(/[^A-Za-z0-9@._-]/g, '_')
      let name = safeName + '_' + uid + '.txt'
      let n = 2
      while (seen.has(name)) {
        name = safeName + '_' + uid + '_' + String(n) + '.txt'
        n += 1
      }
      seen.add(name)
      if (msgs.length === 0) {
        await zip.addFile(name, '（无消息）\n')
        continue
      }
      await zip.addFile(name, formatTxt(msgs, s.username))
      total += msgs.length
    }
  })
  return { path, filename, count: total }
}
