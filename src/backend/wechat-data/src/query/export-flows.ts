/**
 * `query/export.ts` 的「导出流程：会话/朋友圈/全量导出、年度报告、聊天记录媒体」部分（M21 拆分）。
 *
 * 从 `export.ts` 原样搬出，**行为逐字节不变**；`export.ts` 继续以 `export *` 转发
 * ⇒ 所有 `from './export.ts'` 的导入一行都不用改。
 *
 * @module export-flows
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ZipFileWriter, zipFiles, partialPath, reportProgress, throwIfCancelled } from './zip.ts'
import type { StreamControl } from './zip.ts'
import type { MomentItem, WechatMessage } from '../types.ts'
import { queryContacts } from './contacts.ts'
import { queryFavorites } from './favorites.ts'
import { queryRecords } from './records.ts'
import { queryMoments } from './moments.ts'
import { resolveSnsImageDataUrl } from './sns-image.ts'
import { resolveSnsVideoDataUrl } from './sns-video.ts'
import { queryPrivacyScan } from './privacy.ts'
import { queryAnnualReport } from './annual-report.ts'
import { querySessions } from './sessions.ts'
import { MAX_MOMENT_MEDIA, dataUrlToBuffer, exportMediaCtx, writeFileAtomicSync, writeZipAtomic } from './export-io.ts'
import { buildCsv, collectMessages, csvCell, formatCsv, formatHtml, formatJson, formatMarkdown, formatSql, formatTxt, formatXlsx, htmlEscape, messageRows, writeXlsxStream } from './export-format.ts'

/** Collect merged chat-log media metadata for the ZIP manifest. */
export function collectChatlogMedia(msgs: WechatMessage[]): Array<Record<string, unknown>> {
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
export function filterMessages(msgs: WechatMessage[], types?: number[], richTypes?: string[]): WechatMessage[] {
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
 * @param from - optional start timestamp (inclusive).
 * @param to - optional end timestamp (inclusive).
 * @param filename - optional output file basename.
 * @param zip - 把结果再包一层 zip（附 record_media.json）。
 * @param ctrl - 可选的进度/取消（收集阶段逐页检查取消；取消后不写任何文件）。
 * @returns the written file path, filename and message count.
 */
/** Sanitize a user-supplied file basename (no separators / invalid chars). */
export function sanitizeBasename(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 100)
}

/** 单会话导出的「计划」：收集 + 过滤 + 算出所有输出名（同步/流式两条入口共用）。 */
export interface SessionExportPlan {
  msgs: WechatMessage[]
  format: string
  isXlsx: boolean
  /** 内容本体用的扩展名（zip 时是内层文件的后缀）。 */
  ext: string
  innerName: string
  filenameOut: string
  outPath: string
  now: string
}

/**
 * 算出一次单会话导出要做什么（收集消息、过滤、命名）。
 *
 * 抽出来是为了让同步入口（`exportSessionMessages`，现有 RPC 的同步返回不能动）
 * 与流式入口（`exportSessionMessagesStreamed`）**不会各自漂移出不同的文件名/条数**。
 */
export function planSessionExport(
  decryptedDir: string,
  username: string,
  format: string,
  count: number | undefined,
  dir: string | undefined,
  types: number[] | undefined,
  richTypes: string[] | undefined,
  from: number | undefined,
  to: number | undefined,
  filename: string | undefined,
  zip: boolean | undefined,
  ctrl?: StreamControl,
): SessionExportPlan {
  const all = collectMessages(decryptedDir, username, count ?? 0, ctrl)
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
  const exportDir = (dir && dir.trim()) ? dir.trim() : join(dirname(decryptedDir), 'exports')
  mkdirSync(exportDir, { recursive: true })
  const sanitized = username.replace(/@chatroom$/, '').replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 24)
  const autoBase = sanitized + '_' + now + '_' + ((count ?? 0) === 0 ? 'all' : String(count))
  const userBase = filename && filename.trim() ? sanitizeBasename(filename.trim()) : ''
  const base = userBase || autoBase
  const outExt = zip ? 'zip' : ext
  const innerName = (base.toLowerCase().endsWith('.' + ext) ? base : base + '.' + ext)
  const filenameOut = (base.toLowerCase().endsWith('.' + outExt) ? base : base + '.' + outExt)
  return { msgs, format, isXlsx, ext, innerName, filenameOut, outPath: join(exportDir, filenameOut), now }
}

/** 非 xlsx 格式的文本主体（同步/流式入口共用）。 */
export function formatTextBody(format: string, msgs: WechatMessage[], username: string, now: string): string {
  if (format === 'csv') return formatCsv(msgs, username)
  if (format === 'html') return formatHtml(msgs, username, now)
  if (format === 'md') return formatMarkdown(msgs, username)
  if (format === 'sql') return formatSql(msgs, username)
  if (format === 'json') return formatJson(msgs, username)
  return formatTxt(msgs, username)
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
  ctrl?: StreamControl,
): { path: string; filename: string; count: number } {
  const plan = planSessionExport(decryptedDir, username, format, count, dir, types, richTypes, from, to, filename, zip, ctrl)
  const { msgs } = plan
  // xlsx 走内存版（本入口必须同步返回）；行数可能很大时用 exportSessionMessagesStreamed，
  // 它把 sheet 逐块写进 zip 条目、峰值与行数无关。
  const content: string | Uint8Array = plan.isXlsx
    ? formatXlsx(msgs, username, ctrl)
    : formatTextBody(plan.format, msgs, username, plan.now)
  if (zip) {
    const payload = zipFiles([
      { name: plan.innerName, data: content },
      { name: 'record_media.json', data: JSON.stringify({ username, exportedAt: plan.now, total: msgs.length, media: collectChatlogMedia(msgs) }, null, 2) },
    ])
    writeFileAtomicSync(plan.outPath, payload)
  } else {
    writeFileAtomicSync(plan.outPath, content)
  }
  return { path: plan.outPath, filename: plan.filenameOut, count: msgs.length }
}

/**
 * `exportSessionMessages` 的流式版：同一份输入产出**同样内容**的文件，但
 * ① xlsx 的 sheet 逐块流式压缩（峰值与行数无关）；② 带进度/取消。
 *
 * 为什么不直接改同步版：`gateway.exportSessionMessages` 是同步返回的现有 RPC 契约
 * （`gateway.ts:747` 直接 `return r`），改成 async 会连带改网关；所以这里另开一个
 * 异步入口，由网关侧（下一步）显式切换。
 *
 * @param decryptedDir - decrypted data root.
 * @param options - 与同步入口同样的字段 + `onProgress`/`signal`。
 * @returns 目标路径、文件名与条数。
 */
export async function exportSessionMessagesStreamed(
  decryptedDir: string,
  options: {
    username: string
    format: string
    count?: number
    dir?: string
    types?: number[]
    richTypes?: string[]
    from?: number
    to?: number
    filename?: string
    zip?: boolean
  } & StreamControl,
): Promise<{ path: string; filename: string; count: number }> {
  const ctrl: StreamControl = { onProgress: options.onProgress, signal: options.signal }
  const plan = planSessionExport(
    decryptedDir, options.username, options.format, options.count, options.dir,
    options.types, options.richTypes, options.from, options.to, options.filename, options.zip, ctrl,
  )
  const { msgs } = plan
  if (plan.isXlsx && !options.zip) {
    // 大行数的正路：sheet 逐块产出 → 流式 deflate → temp+rename。
    // 行数此刻已经知道（消息都已收集），把它报给流式层 ⇒ 'format' 阶段才有 done/total，
    // 进度条才真能按百分比填（不传就一路 total=0，界面只能显示「数字在涨」）。
    await writeXlsxStream(plan.outPath, messageRows(msgs, options.username), ctrl, msgs.length + 1)
  } else if (plan.isXlsx) {
    // zip 包裹时内层必须是完整的 xlsx 字节：仍走内存版（多一层流式需要再落一次临时文件，
    // 而单会话上限 5 万条、内层 xlsx 本身是压缩数据，收益不抵复杂度）。
    const content = formatXlsx(msgs, options.username, ctrl)
    await writeZipAtomic(plan.outPath, async (zip) => {
      await zip.addFile(plan.innerName, content)
      await zip.addFile('record_media.json', JSON.stringify({ username: options.username, exportedAt: plan.now, total: msgs.length, media: collectChatlogMedia(msgs) }, null, 2))
    })
  } else {
    const content = formatTextBody(plan.format, msgs, options.username, plan.now)
    if (options.zip) {
      await writeZipAtomic(plan.outPath, async (zip) => {
        await zip.addFile(plan.innerName, content)
        await zip.addFile('record_media.json', JSON.stringify({ username: options.username, exportedAt: plan.now, total: msgs.length, media: collectChatlogMedia(msgs) }, null, 2))
      })
    } else {
      writeFileAtomicSync(plan.outPath, content)
    }
  }
  return { path: plan.outPath, filename: plan.filenameOut, count: msgs.length }
}
/**
 * Export a data category to CSV under the exports dir.
 * @param decryptedDir - decrypted data root.
 * @param kind - contacts | favorites | records | moments | privacy.
 * @param recordsKind - record category when kind=records.
 * @param dest - 用户在保存对话框里选定的**完整目标路径**。给定时直接写到那里；
 *   未给（例如自动化/旧调用方）则回退到 `<数据根>/exports/<kind>_<时间>.csv`。
 * @param category - kind=contacts 时只导出该分类（与界面页签口径一致）。
 * @returns the written file path, filename and row count.
 */
export function exportCsv(
  decryptedDir: string,
  kind: string,
  recordsKind?: string,
  dest?: string,
  category?: string,
): { path: string; filename: string; count: number } {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/[-:]/g, '')
  const stamp = now.slice(0, 8) + '_' + now.slice(9)
  let header: string[] = []
  let rows: string[][] = []
  if (kind === 'contacts') {
    // 列设计：以「能和微信界面对上」为准。
    //  显示名  = 备注 > 昵称 > 用户名（界面卡片上显示的就是它）
    //  备注/昵称 分开保留，便于在表格里按备注筛选
    //  首字母/全拼 保留，便于排序与做搜索表
    //  群成员数/群主/所在群 只有对应类目才有值，留空即可
    header = ['显示名', '备注', '昵称', '微信号', '别名', '类型', '首字母', '全拼', '群成员数', '群主', '所在群']
    const env = queryContacts(decryptedDir, category ? { category } : undefined)
    for (const c of env.contacts) {
      rows.push([
        c.displayName ?? '',
        c.remark ?? '',
        c.nickName ?? '',
        c.username ?? '',
        c.alias ?? '',
        c.localTypeLabel ?? c.category ?? '',
        c.initial ?? '',
        c.quanPin ?? '',
        c.memberCount != null ? String(c.memberCount) : '',
        c.owner ?? '',
        c.groupName ?? '',
      ])
    }
  } else if (kind === 'favorites') {
    header = ['localId', '类型', '更新时间', '内容', '来源']
    const env = queryFavorites(decryptedDir, 5000)
    for (const f of env.favorites) {
      rows.push([String(f.localId), String(f.type), String(f.updateTime), f.content, f.fromUsr])
    }
  } else if (kind === 'records') {
    header = ['字段']
    const env = queryRecords(decryptedDir, recordsKind ?? 'revokes', 5000)
    for (const it of env.items) {
      rows.push(Object.values(it).map(v => String(v)))
    }
  } else if (kind === 'moments') {
    header = ['tid', '用户名', '作者', '时间', '内容', '媒体']
    const env = queryMoments(decryptedDir, 0, 5000)
    for (const m of env.moments) {
      rows.push([m.tid, m.username, m.author, m.time, m.text, m.media_desc])
    }
  } else if (kind === 'privacy') {
    header = ['类别', '会话', '联系人', '时间', '片段']
    const env = queryPrivacyScan(decryptedDir)
    for (const c of env.categories) {
      for (const s of c.samples) {
        rows.push([c.label, s.username, s.name, s.time, s.snippet])
      }
    }
  } else {
    throw new Error('未知导出类型: ' + kind)
  }
  // 目标路径：用户选定优先；否则回退到数据根下的 exports/（保持旧行为可用）。
  const chosen = typeof dest === 'string' && dest.trim() !== '' ? dest.trim() : ''
  const filepath = chosen || join(join(dirname(decryptedDir), 'exports'), kind + '_' + stamp + '.csv')
  mkdirSync(dirname(filepath), { recursive: true })
  // buildCsv 会带 UTF-8 BOM（Excel 认 UTF-8 的唯一可靠信号，见其说明）。
  writeFileAtomicSync(filepath, buildCsv(header, rows))
  return { path: filepath, filename: basename(filepath), count: rows.length }
}

/** 安全字符串化。 */
export function strOf(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  return ''
}

/** 百分比字符串。 */
export function pctOf(v: unknown): string {
  const n = Number(v)
  return Number.isFinite(n) ? String(Math.round(n * 100)) + '%' : ''
}

/** 取榜单数组的前 N 项（转成简单对象）。 */
export function topOf(arr: unknown, limit = 12): Array<{ username: string; name: string; count: number }> {
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
 * @param opts - format/username/from/to/dir/filename + 可选的 onProgress/signal。
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
  } & StreamControl,
): Promise<{ path: string; filename: string; count: number }> {
  const ctrl: StreamControl = { onProgress: opts?.onProgress, signal: opts?.signal }
  const format = opts?.format === 'html' ? 'html' : opts?.format === 'json' ? 'json' : opts?.format === 'csv' ? 'csv' : 'txt'
  const NL = String.fromCharCode(10)
  const items: MomentItem[] = []
  let offset = 0
  for (;;) {
    throwIfCancelled(ctrl.signal)
    const env = queryMoments(decryptedDir, offset, 500, opts?.username)
    items.push(...env.moments)
    offset += env.moments.length
    reportProgress(ctrl, 'collect', items.length, 0)
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
        // 媒体解析（解密/读盘）是这里最慢的环节，逐条响应取消并汇报已打包条数。
        throwIfCancelled(ctrl.signal)
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
        reportProgress(ctrl, 'media', mediaCount, MAX_MOMENT_MEDIA)
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
      throwIfCancelled(ctrl.signal)
      lines.push(csvCell(m.time) + ',' + csvCell(m.author) + ',' + csvCell(m.text) + ',' + String(m.images.length) + ',' + String(m.videos.length) + ',' + csvCell(m.location) + ',' + csvCell(m.link_title) + ',' + csvCell(m.link_url ?? ''))
    }
    content = lines.join(NL)
  } else if (ext === 'html') {
    const parts: string[] = []
    parts.push('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>微信朋友圈导出</title>')
    parts.push('<style>body{background:#f2f2f2;font-family:sans-serif;margin:0;padding:24px 12px;color:#222}.wrap{max-width:680px;margin:0 auto}.hd{text-align:center;margin-bottom:18px}.card{background:#fff;border-radius:12px;padding:14px 16px;margin:12px 0;box-shadow:0 1px 3px rgba(0,0,0,.08)}.meta{color:#888;font-size:12px;margin-bottom:6px}.content{font-size:14px;line-height:1.6;white-space:pre-wrap}.tag{color:#576b95;font-size:12px;margin-top:6px}.divider{text-align:center;color:#bbb;font-size:12px;margin:14px 0}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px}.grid img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:6px;display:block}.grid.single{grid-template-columns:1fr;max-width:240px}</style></head><body><div class="wrap"><div class="hd"><h1>微信朋友圈</h1><p>共 ' + String(filtered.length) + ' 条动态</p></div>')
    for (const m of filtered) {
      throwIfCancelled(ctrl.signal)
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
      throwIfCancelled(ctrl.signal)
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
 * @param opts - optional dir/filename + 可选的 onProgress/signal（逐会话上报、可取消）。
 * @returns written zip path + filename + total messages.
 */
export async function exportAllSessions(
  decryptedDir: string,
  opts?: { dir?: string; filename?: string } & StreamControl,
): Promise<{ path: string; filename: string; count: number }> {
  const ctrl: StreamControl = { onProgress: opts?.onProgress, signal: opts?.signal }
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
    for (let i = 0; i < sessions.length; i += 1) {
      const s = sessions[i]!
      // 会话边界是这块最自然的取消/进度点：每个会话最多 5 万条，卡在中途用户会等很久。
      throwIfCancelled(ctrl.signal)
      reportProgress(ctrl, 'sessions', i, sessions.length)
      const msgs = collectMessages(decryptedDir, s.username, 0, ctrl)
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
      } else {
        await zip.addFile(name, formatTxt(msgs, s.username))
        total += msgs.length
      }
      reportProgress(ctrl, 'sessions', i + 1, sessions.length)
    }
  })
  return { path, filename, count: total }
}
