/**
 * 撤回原文**保留**闭环：全量归档 → 识别撤回提示 → 配对原文（2026-09-29 用户选 C：全量归档）。
 *
 * ## 为什么要这么做（真机实测结论）
 *
 * · 应用内「撤回消息」原先唯一的数据源是第三方反撤回插件留下的表
 *   `*_weflow_anti_revoke_deleted_cache` —— 真机上**这张表不存在** ⇒ 面板恒为空；
 * · 微信自己**留下了撤回痕迹**：`local_type=10000` 的系统消息里有
 *   `"某某" 撤回了一条消息`（实测全库 3,233 条这样的系统消息）；
 * · 但**提示里没有原文、也没有 msgid**（全库 0 处 `revokemsg` 标记、无 revoke 表），
 *   而且原文那一行在撤回后已经不在库里 ⇒ **事后读库不可能拿到原文**。
 *
 * ⇒ 唯一可行路径：**自己持续把消息内容存下来**，等提示出现时按"同一会话里紧挨在它之前的那条"
 * 配对。本模块就是这个闭环：
 *   ① {@link archiveMessages} 全量/增量归档（`INSERT OR IGNORE`，**只增不改** ⇒ 原文不会被覆盖）；
 *   ② {@link queryRevokedRetained} 扫提示 + 配对 + 关键帧过滤，产出与旧接口同形状的列表。
 *
 * ## 保留语义（关键）
 *
 * 主键 `(talker, row_key)` + `INSERT OR IGNORE`：同一条消息**首次入库的内容永久保留**——
 * 之后微信把它改成"撤回提示"、或删掉整行，我们库里那份**原文仍在**。这正是"不让撤回成功"。
 *
 * @module query/revoke-retain
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import * as zlib from 'node:zlib'
import { dirname, join } from 'node:path'
import { DatabaseSync } from './db-open.ts'
import { withDb, withWritableDb } from './db-open.ts'
import { decodeBlobText, msgTypeLabel, normalizeMsgType } from './messages.ts'
import { classifyRender, parseMessageContent, RENDER_LABEL, richPlaceholder, type RenderKind } from './parse.ts'
import { contactMeta } from './meta.ts'
import { resolveSelfUsername } from '../config/resolve.ts'
import { MD5_SEGMENT } from '../md5.ts'
import type { MessageRich, RevokedItem, RevokedMedia, RevokedMediaKind } from '../types.ts'

/** 归档库路径：数据根下（与 `decoded_images` 同级，不进解密目录以免被同步覆盖）。 */
export function messageArchivePath (decryptedDir: string): string {
  return join(decryptedDir, '..', 'message-archive.db')
}

const DDL = [
  'CREATE TABLE IF NOT EXISTS archived_msg (',
  '  talker TEXT NOT NULL,',
  '  row_key INTEGER NOT NULL,',
  '  create_time INTEGER NOT NULL,',
  '  local_type INTEGER NOT NULL,',
  '  sender_id INTEGER NOT NULL,',
  '  sender_username TEXT NOT NULL DEFAULT \'\',',
  '  local_id INTEGER NOT NULL DEFAULT 0,',
  '  server_id TEXT NOT NULL DEFAULT \'\',',
  '  content TEXT NOT NULL,',
  '  archived_at INTEGER NOT NULL,',
  '  PRIMARY KEY (talker, row_key)',
  ')',
].join('\n')

/**
 * 归档结构版本。
 *
 * 1 → 2：新增 `local_id` / `server_id`（媒体实体定位键）。旧归档的行已经存在，
 * 只靠 `INSERT OR IGNORE` 永远不会补这两列；而源库签名可能早就不变了，
 * 所以必须把版本也写进 `archived_source`，让旧记录强制重扫一次。
 */
const ARCHIVE_VERSION = 2

/** 单条内容上限：超过则只留前 1MB（极端的二进制/压缩块不该把归档库撑爆）。 */
const MAX_CONTENT_CHARS = 1_048_576

/**
 * 二进制/压缩内容的**占位标记**前缀（2026-09-29 用户委托决策）。
 *
 * 依据：全量归档 19 万条实测 **219MB**，而其中真正可读、也正是"撤回原文"要看的是文本与 XML；
 * 二进制块（图片/语音载荷、压缩片段）存了也读不出来。所以这类内容只记
 * `标记 + local_type + 字节数`：**该行仍然入库**（"这条消息存在过"与类型信息永久保留），
 * 但不再保存原始字节。既有档案不受影响（`INSERT OR IGNORE` 只增不改）。
 */
export const BIN_PREFIX = '\u0001BIN:'

/**
 * 压缩存储前缀（2026-09-29 用户委托决策：压体积）。
 *
 * 依据：全量归档 19 万条实测 **219MB**（≈1.2KB/条，基本都是文本/XML，不是二进制胖）。
 * 文本/XML 用 zstd 通常能压 4–8×，是**唯一**能显著缩小体积的无损手段。
 *
 * ⚠️ 运行时能力探测 + 回退：后端跑在 **Electron 的 Node** 上，`node:zlib.zstdCompressSync`
 * 不一定存在（Node 24 有、更老的没有）。所以：
 *   · 有 ⇒ 压；没有 ⇒ **原样存**（行为与之前完全一致，绝不会写坏数据）；
 *   · 读取侧两种形态都能吃（见到前缀才解压）⇒ 同一份归档库跨版本可读。
 */
const ZSTD_PREFIX = '\u0001ZSTD:'

/** `node:zlib` 上的 zstd 能力（动态探测，避免依赖具体 node 版本的类型定义）。 */
const zstdApi = zlib as unknown as {
  zstdCompressSync?: (b: Buffer) => Buffer
  zstdDecompressSync?: (b: Buffer) => Buffer
}

/**
 * 入库前压缩（不可用或太短就原样返回）。
 * @param s - 已解码的文本内容。
 * @returns 可入库的字符串。
 */
function compressForStore (s: string): string {
  if (s.length < 256 || typeof zstdApi.zstdCompressSync !== 'function') return s
  try {
    return ZSTD_PREFIX + Buffer.from(zstdApi.zstdCompressSync(Buffer.from(s, 'utf8'))).toString('base64')
  } catch {
    return s
  }
}

/**
 * 读出时解压（不是压缩存储就原样返回）。
 * @param s - 库里的字符串。
 * @returns 原始文本。
 */
function decodeStored (s: string): string {
  if (!s.startsWith(ZSTD_PREFIX)) return s
  if (typeof zstdApi.zstdDecompressSync !== 'function') return '（此条为压缩存储，当前运行时无法解压）'
  try {
    return zstdApi.zstdDecompressSync(Buffer.from(s.slice(ZSTD_PREFIX.length), 'base64')).toString('utf8')
  } catch {
    return '（压缩内容解压失败）'
  }
}

/** 撤回提示的文本特征（真机实测：`"某某" 撤回了一条消息`）。 */
const REVOKE_TIP = '撤回了一条消息'

/** 一条归档消息。 */
export interface ArchivedMessage {
  /** 会话标识：`WechatSession.username` 的等价物（本模块用「文件#表名」表示，见 `talkerOfTable`）。 */
  talker: string
  rowKey: number
  createTime: number
  localType: number
  senderId: number
  /** 源分片 Name2Id 解析出的真实 wxid（空串表示该行是「自己」的占位或解析不到）。 */
  senderUsername: string
  /** 源消息的真实 local_id（微信 4.x 实测等于 rowid；老分片缺列时回退 rowid）。 */
  localId: number
  /** 源消息的 server_id（字符串；可能超过 2^53）。 */
  serverId: string
  content: string
}

/** 打开（必要时创建）归档库。 */
function ensureArchive (decryptedDir: string): string {
  const p = messageArchivePath(decryptedDir)
  const dir = dirname(p)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  withWritableDb(p, (db) => {
    db.exec(DDL)
    // 旧归档库是 version 1（没有这两列）。`ALTER TABLE ADD COLUMN` 幂等性靠列探测，
    // 不用 try/catch 猜错误码（不同 SQLite 版本的报错文案不一致）。
    const cols = new Set((db.prepare('PRAGMA table_info(archived_msg)').all() as Array<{ name: string }>).map((r) => r.name))
    if (!cols.has('sender_username')) db.exec('ALTER TABLE archived_msg ADD COLUMN sender_username TEXT NOT NULL DEFAULT \'\'')
    if (!cols.has('local_id')) db.exec('ALTER TABLE archived_msg ADD COLUMN local_id INTEGER NOT NULL DEFAULT 0')
    if (!cols.has('server_id')) db.exec('ALTER TABLE archived_msg ADD COLUMN server_id TEXT NOT NULL DEFAULT \'\'')
  })
  return p
}

/** 把一行的 message_content 安全转成字符串（**先解 zstd/GBK**，否则存进去就是乱码字节）。 */
function toText (v: unknown): string {
  return decodeBlobText(v)
}

/** `Msg_<md5>` 表名 → 会话标识（表名后缀就是 md5，保留原样即可，稳定且无需反查联系人）。 */
function talkerOfTable (table: string): string {
  return table.startsWith('Msg_') ? table.slice(4) : table
}

/** 列出某个库里的 `Msg_` 表名。 */
function msgTables (db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg\\_%' ESCAPE '\\'").all() as Array<{ name: string }>)
    .map((r) => String(r.name))
}

/** 上次归档时各源库的签名（用于"没变就整库跳过"，见下）。 */
const SRC_DDL = 'CREATE TABLE IF NOT EXISTS archived_source (file TEXT PRIMARY KEY, sig TEXT NOT NULL, rows INTEGER NOT NULL, at INTEGER NOT NULL, ver INTEGER NOT NULL DEFAULT 1)'

/** 旧 `archived_source` 没有 `ver` 列时补上（已有记录默认 1 ⇒ 会强制重扫一次）。 */
function ensureSourceSchema (db: DatabaseSync): void {
  db.exec(SRC_DDL)
  const cols = new Set((db.prepare('PRAGMA table_info(archived_source)').all() as Array<{ name: string }>).map((r) => r.name))
  if (!cols.has('ver')) db.exec('ALTER TABLE archived_source ADD COLUMN ver INTEGER NOT NULL DEFAULT 1')
}

/**
 * 源库签名：**纳秒 + 大小**（与缓存层 `meta.ts` 的 `fileSig` 同口径）。
 * 用纳秒而不是毫秒：同一毫秒内的写入才看得见。
 * @param p - 文件路径。
 * @returns 签名；读不到返回空串（调用方会退化成"每次都扫"）。
 */
function srcSig (p: string): string {
  try {
    const st = statSync(p, { bigint: true })
    return String(st.mtimeNs) + ':' + String(st.size)
  } catch {
    return ''
  }
}

/**
 * **全量/增量归档**：把每个 `Msg_` 表里的消息内容落进我们自己的库。
 *
 * 幂等：`INSERT OR IGNORE` + 主键 `(talker, row_key)` ⇒ 重复调用只补新行，
 * **已归档的原文永不被后来的"撤回提示/空内容"覆盖**。
 *
 * 性能：按**源库签名**整库跳过 —— 首次要把全部历史归档一遍（19 万行约 2.4s），
 * 之后只要某个 `message_*.db` 的签名没变，那**整个库直接跳过**（只剩一次 stat），
 * 于是空闲时开销接近 0，可以安全地放进同步 tick / 读路径。
 *
 * @param decryptedDir - 解密数据根。
 * @returns 本次新归档条数、扫描表数/行数、跳过的库数。
 */
export function archiveMessages (decryptedDir: string): { added: number; tables: number; scanned: number; skipped: number } {
  const msgDir = join(decryptedDir, 'message')
  if (!existsSync(msgDir)) return { added: 0, tables: 0, scanned: 0, skipped: 0 }
  const files = readdirSync(msgDir).filter((f) => f.endsWith('.db') && !f.includes('_shm') && !f.includes('_wal'))
  const archive = ensureArchive(decryptedDir)
  return withWritableDb(archive, (adb) => {
    ensureSourceSchema(adb)
    const selfUsername = resolveSelfUsername(decryptedDir)
    const ins = adb.prepare('INSERT OR IGNORE INTO archived_msg (talker, row_key, create_time, local_type, sender_id, sender_username, local_id, server_id, content, archived_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    // 旧行只补定位键，**绝不更新 content**：归档的保留语义是「首次入库的原文永久不变」。
    const updMeta = adb.prepare('UPDATE archived_msg SET create_time = ?, local_type = ?, sender_id = ?, sender_username = ?, local_id = ?, server_id = ? WHERE talker = ? AND row_key = ? AND (sender_username = \'\' OR local_id = 0 OR server_id = \'\')')
    const getSrc = adb.prepare('SELECT sig, ver FROM archived_source WHERE file = ?')
    const setSrc = adb.prepare('INSERT INTO archived_source (file, sig, rows, at, ver) VALUES (?,?,?,?,?) ON CONFLICT(file) DO UPDATE SET sig=excluded.sig, rows=excluded.rows, at=excluded.at, ver=excluded.ver')
    const now = Math.floor(Date.now() / 1000)
    let added = 0
    let tables = 0
    let scanned = 0
    let skipped = 0
    for (const file of files) {
      const srcFile = join(msgDir, file)
      const sig = srcSig(srcFile)
      const known = getSrc.get(file) as { sig?: string; ver?: number } | undefined
      // 签名没变 ⇒ 这个库里不可能有新消息，整库跳过（这是"空闲零开销"的来源）
      // 版本不同则**不能跳**：v1 归档缺 local_id/server_id，必须借这次重扫补齐。
      if (sig !== '' && known?.sig === sig && Number(known.ver ?? 1) >= ARCHIVE_VERSION) { skipped += 1; continue }
      let rows: Array<{ tk: string; k: number; ct: number; lt: number; sid: number; su: string; lid: number; srid: string; mc: unknown }> = []
      try {
        rows = withDb(srcFile, (db) => {
          const out: Array<{ tk: string; k: number; ct: number; lt: number; sid: number; su: string; lid: number; srid: string; mc: unknown }> = []
          // Name2Id：real_sender_id → wxid。空 user_name 是微信 4.x 对「登录账号自己」的标记。
          const name2Id = new Map<number, string>()
          let selfRowId: number | undefined
          for (const t of ['Name2Id', 'name2id']) {
            try {
              const got = db.prepare(`SELECT rowid AS id, user_name AS u FROM ${t}`).all() as Array<{ id: number; u: unknown }>
              for (const ng of got) {
                const id = Number(ng.id)
                const u = toText(ng.u).trim()
                name2Id.set(id, u)
                // 空 user_name 是登录账号自己的占位行；记下它，归档时写成真实 self wxid。
                if (u === '' && selfRowId === undefined) selfRowId = id
              }
              if (name2Id.size > 0) break
            } catch { /* 换另一个大小写 */ }
          }
          for (const table of msgTables(db)) {
            const cols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name))
            if (!cols.has('message_content')) continue
            const ct = cols.has('create_time') ? 'create_time' : '0'
            const lt = cols.has('local_type') ? 'local_type' : '0'
            const sid = cols.has('real_sender_id') ? 'real_sender_id' : '0'
            // local_id 与 rowid 在真机上相同；老分片没有该列时用 rowid 兜底，
            // 不能写死 0（否则媒体接口拿不到实体）。
            const lid = cols.has('local_id') ? 'local_id' : 'rowid'
            const srid = cols.has('server_id') ? 'CAST(server_id AS TEXT)' : "''"
            tables += 1
            /**
             * `tk` 是**会话级标识**（`文件#表名`）——必须与"行号"分开：
             * 配对要在**同一会话**里找"紧挨提示之前的那条"，若把行号并进会话标识，
             * `WHERE talker = ? AND row_key < ?` 永远匹配不到（自测时发现的坑）。
             */
            const tk = file + '#' + table
            const got = db.prepare(`SELECT rowid AS k, ${ct} AS ct, ${lt} AS lt, ${sid} AS sid, ${lid} AS lid, ${srid} AS srid, message_content AS mc FROM ${table}`).all() as Array<{ k: number; ct: number; lt: number; sid: number; lid: number; srid: string; mc: unknown }>
            for (const g of got) {
              const senderId = Number(g.sid ?? 0)
              const resolved = name2Id.get(senderId) ?? ''
              const senderUsername = resolved !== '' ? resolved : (selfRowId === senderId ? selfUsername : '')
              out.push({ tk, k: Number(g.k), ct: Number(g.ct ?? 0), lt: Number(g.lt ?? 0), sid: senderId, su: senderUsername, lid: Number(g.lid ?? g.k), srid: String(g.srid ?? ''), mc: g.mc })
            }
          }
          return out
        })
      } catch { continue /* 该库读不动就跳过 */ }
      adb.exec('BEGIN')
      try {
        for (const r of rows) {
          scanned += 1
          let content = toText(r.mc)
          if (content === '') continue
          if (content.length > MAX_CONTENT_CHARS) content = content.slice(0, MAX_CONTENT_CHARS)
          // 二进制/压缩块只记"类型 + 字节数"（见 BIN_PREFIX 的说明）——这是 219MB → 明显更小的关键
          if (looksBinary(content)) content = BIN_PREFIX + String(r.lt) + ':' + String(content.length)
          const res = ins.run(r.tk, r.k, r.ct, r.lt, r.sid, r.su, r.lid, r.srid, compressForStore(content), now)
          added += Number((res as { changes?: number }).changes ?? 0)
          // 已有行：只补/修正定位元数据。`content` 不在 SET 里是硬约束。
          updMeta.run(r.ct, r.lt, r.sid, r.su, r.lid, r.srid, r.tk, r.k)
        }
        adb.exec('COMMIT')
      } catch (e) {
        try { adb.exec('ROLLBACK') } catch { /* 回滚失败不掩盖原错误 */ }
        throw e
      }
      setSrc.run(file, sig, rows.length, now, ARCHIVE_VERSION)
    }
    return { added, tables, scanned, skipped }
  })
}

/** 归档库统计：总条数、撤回提示条数、已配到原文的条数。 */
export function archiveStats (decryptedDir: string): { total: number; tips: number } {
  const p = messageArchivePath(decryptedDir)
  if (!existsSync(p)) return { total: 0, tips: 0 }
  return withDb(p, (db) => {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='archived_msg'").get()
    if (has === undefined) return { total: 0, tips: 0 }
    const total = (db.prepare('SELECT COUNT(*) AS n FROM archived_msg').get() as { n?: number } | undefined)?.n ?? 0
    const tips = (db.prepare('SELECT COUNT(*) AS n FROM archived_msg WHERE local_type = 10000 AND content LIKE ?').get('%' + REVOKE_TIP + '%') as { n?: number } | undefined)?.n ?? 0
    return { total: Math.trunc(Number(total)), tips: Math.trunc(Number(tips)) }
  })
}

/**
 * 从**系统 XML** 形态的撤回提示里取发送者名（实测这类占多数）。
 *
 * 真机样例：这些提示不是 `"某某" 撤回了一条消息` 那种纯文本，而是
 * `<sysmsg type="revokemsg">…<replacemsg><![CDATA["某某" 撤回了一条消息]]></replacemsg>…`。
 * 旧实现只认纯文本 ⇒ 发送者一栏全变成"（未知）"。
 * @param tip - 已解码的提示内容。
 * @returns 发送者名；取不到返回空串。
 */
function senderFromXmlTip (tip: string): string {
  const repl = /<replacemsg>\s*(?:<!\[CDATA\[)?([\s\S]{0,240}?)(?:\]\]>)?\s*<\/replacemsg>/i.exec(tip)
  if (repl?.[1] !== undefined) {
    const inner = repl[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim()
    const m = /^[^\n]{0,40}?撤回了一条消息/.exec(inner)
    if (m !== null) return inner.slice(0, m.index).replace(/^[“"'\s]+|[”"'\s:：]+$/g, '').slice(0, 40)
  }
  const from = /<fromusername>\s*(?:<!\[CDATA\[)?([^<\]]{1,64})/i.exec(tip)
  return from?.[1]?.trim() ?? ''
}

/**
 * 兜底：从提示里**任意位置**取引号中的名字。
 *
 * 为什么需要：群聊的 `message_content` 前面还会带发送者前缀（实测形如
 * `wxid_xxx: "某某" 撤回了一条消息`），于是"锚在开头"的两条正则都失效 ⇒ 发送者显示"（未知）"。
 * @param s - 提示文本。
 * @returns 引号里的名字；没有则空串。
 */
function quotedName (s: string): string {
  // ⚠️ 必须要求引号里的名字**紧跟"撤回了一条消息"**：否则会从 XML 头 `version="1.0"` 里
  // 抓出 "1.0" 当成发送者（这是我踩过的回归）。
  const m = /[“"']([^”"'\n]{1,40})[”"'][^”"'\n]{0,24}?撤回了一条消息/.exec(s)
  const name = m?.[1]?.trim() ?? ''
  // 纯数字/版本号这类明显不是名字，直接放弃（宁可显示"（未知）"也不显示 "1.0"）
  return /^[0-9.]+$/.test(name) ? '' : name
}

/** 群聊消息前缀 `wxid_xxx: 正文` —— 展示时剥掉（对用户是噪声）。 */
function stripGroupPrefix (s: string): string {
  return s.replace(/^[A-Za-z0-9_@.\-]{3,64}:\s*/, '')
}

/** 群消息体里的发送者 wxid（`wxid_xxx:\n正文`）；私聊/无前缀返回空串。 */
function senderFromBody (raw: string): string {
  const m = /^([A-Za-z0-9_@.\-]{3,64}):\s*/.exec(raw)
  if (m === null) return ''
  const head = m[1] ?? ''
  // `https://…` 这类正文不能被误当成发送者（群前缀不含 `/`）。
  if (head.includes('/') || head.includes('<')) return ''
  return head
}

/** 把秒数格式化成 `0:12` / `1:02:03`。 */
function durationText (sec: number): string {
  const total = Math.max(0, Math.trunc(sec))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0
    ? `${String(h)}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m)}:${String(s).padStart(2, '0')}`
}

/** 表情/图片等媒体种类 → 列表里的一句话正文。 */
function mediaPlaceholder (kind: RevokedMediaKind, media: RevokedMedia): string {
  switch (kind) {
    case 'image': return '[图片]'
    case 'video': return media.durationSec !== undefined && media.durationSec > 0
      ? `[视频] ${durationText(media.durationSec)}`
      : '[视频]'
    case 'voice': {
      const sec = media.durationMs !== undefined && media.durationMs > 0 ? Math.max(1, Math.round(media.durationMs / 1000)) : 0
      return sec > 0 ? `[语音] ${String(sec)}″` : '[语音]'
    }
    case 'file': return media.name ? `[文件] ${media.name}` : '[文件]'
    case 'emoji': return '[表情]'
    case 'link': return media.title ? `[链接] ${media.title}` : '[链接]'
    case 'app': return media.title ? `[小程序] ${media.title}` : '[小程序]'
    case 'quote': return media.title ? media.title : '[引用消息]'
    case 'chatlog': return media.title ? `[聊天记录] ${media.title}` : '[聊天记录]'
    case 'location': return media.title ? `[位置] ${media.title}` : '[位置]'
    case 'contact': return media.name ? `[名片] ${media.name}` : '[名片]'
    case 'transfer': return '[转账]'
    case 'redpacket': return '[红包]'
    case 'system': return '[系统消息]'
    default: return ''
  }
}

/** rich.type → RevokedMediaKind（与界面渲染器同一套语义）。 */
function mediaKindOf (richType: string): RevokedMediaKind {
  switch (richType) {
    case 'image': return 'image'
    case 'video': return 'video'
    case 'voice': return 'voice'
    case 'file': return 'file'
    case 'emoji':
    case 'sticker': return 'emoji'
    case 'link':
    case 'newsfeed': return 'link'
    case 'miniapp': return 'app'
    case 'quote': return 'quote'
    case 'chatlog': return 'chatlog'
    case 'location': return 'location'
    case 'contact': return 'contact'
    case 'transfer': return 'transfer'
    case 'redpacket': return 'redpacket'
    case 'call': return 'voip'
    case 'system': return 'system'
    default: return 'unknown'
  }
}

/** 从 rich 里抽出前端取实体需要的字段（不塞整份 records/XML）。 */
function mediaFromRich (kind: RevokedMediaKind, rich: MessageRich): RevokedMedia {
  const media: RevokedMedia = { kind }
  if (rich.md5) media.md5 = rich.md5
  if (rich.fileMd5) media.fileMd5 = rich.fileMd5
  const name = rich.title || rich.nickname || rich.username || ''
  if (name) media.name = name
  if (rich.fileExt) media.ext = rich.fileExt.replace(/^\./, '').toLowerCase()
  const size = Number(rich.fileSize)
  if (Number.isFinite(size) && size > 0) media.size = size
  if (typeof rich.durationMs === 'number' && rich.durationMs > 0) media.durationMs = rich.durationMs
  if (typeof rich.durationSec === 'number' && rich.durationSec > 0) media.durationSec = rich.durationSec
  if (rich.title) media.title = rich.title
  if (rich.desc) media.desc = rich.desc
  if (rich.url) media.url = rich.url
  if (rich.emojiUrl) media.emojiUrl = rich.emojiUrl
  if (rich.referName) media.referName = rich.referName
  if (rich.referType) media.referType = rich.referType
  if (rich.referAppType) media.referAppType = rich.referAppType
  if (rich.records && rich.records.length > 0) media.recordCount = rich.records.length
  return media
}

/** 撤回原文的解析结果（纯函数，供测试与列表共用）。 */
export interface RevokedOriginal {
  typeLabel: string
  content: string
  retained: boolean
  statusLabel: string
  media?: RevokedMedia
  /** 群消息前缀里的真实发送者 wxid（没有则为空）。 */
  senderUsername: string
  /** 剥掉群前缀后的正文。 */
  body: string
}

/**
 * 把归档原文解析成**可直接展示**的类型、正文与媒体元信息。
 *
 * 旧实现只给「原文已保留」一句话，用户必须展开且仍看不到图片/文件/语音信息。
 * 这里复用消息链的同一套解析器（`normalizeMsgType` / `parseMessageContent` /
 * `classifyRender`），保证撤回面板与聊天面板对同一条 XML 的判断一致。
 * @param raw - 归档里的原文（可能带 `\u0001BIN:` 占位或群前缀）。
 * @param rawLocalType - 源消息的 raw `local_type`。
 * @param isGroup - 会话是否群聊（用于剥 `wxid:\n` 前缀与解析 @ 等）。
 * @returns 展示类型、完整正文、保留状态与媒体元信息。
 */
export function describeRevokedOriginal (
  raw: string,
  rawLocalType: number,
  isGroup: boolean,
): RevokedOriginal {
  const senderUsername = senderFromBody(raw)
  const body = stripGroupPrefix(raw).trim()
  if (raw.startsWith(BIN_PREFIX)) {
    const parts = raw.split(':')
    const tag = Number(parts[1] ?? 0)
    const bytes = Number(parts[2] ?? 0)
    const kind: RevokedMediaKind = normalizeMsgType(tag) === 3 ? 'image' : normalizeMsgType(tag) === 43 ? 'video' : normalizeMsgType(tag) === 34 ? 'voice' : 'unknown'
    return {
      typeLabel: msgTypeLabel(tag),
      content: `[${msgTypeLabel(tag)}] 原始内容为二进制/压缩数据（${String(bytes)} 字节），已保留类型记录`,
      retained: true,
      statusLabel: '原文已保留（二进制载荷）',
      media: { kind },
      senderUsername,
      body: '',
    }
  }
  if (body === '') {
    return { typeLabel: '文本', content: '（原文为空）', retained: true, statusLabel: '原文已保留', senderUsername, body }
  }

  const normType = normalizeMsgType(rawLocalType)
  const parsed = parseMessageContent(normType, body, isGroup)
  const rich = parsed.rich
  const render: RenderKind = classifyRender(normType, rich, parsed.sysKind)
  const typeLabel = render === 'text' ? '文本' : (RENDER_LABEL[render] ?? msgTypeLabel(rawLocalType))
  // 文本原文**完整返回**，不截断：撤回面板本来就该让人直接看到撤回了什么。
  const content = parsed.text || (rich ? richPlaceholder(rich) : '')
  const media = rich ? mediaFromRich(mediaKindOf(rich.type), rich) : undefined
  return {
    typeLabel,
    content: content || '（原文已保留，但没有可展示的文本）',
    retained: true,
    statusLabel: '原文已保留',
    ...(media ? { media } : {}),
    senderUsername,
    body,
  }
}

/**
 * 旧调用方兼容形状：`sender/type_label/content/create_time` 始终存在，
 * 新字段（头像 username / 会话 / 媒体）是可选的。
 */
export type RetainedRevokeItem = RevokedItem

/** 从撤回提示里取发送者名：`"某某" 撤回了一条消息` ⇒ 某某。 */
function senderFromTip (tip: string): string {
  const m = /^[“"']?([^”"']{1,40})[”"']?\s*撤回了一条消息/.exec(tip.trim())
  return m?.[1]?.trim() ?? ''
}

/**
 * 内容是不是**二进制/压缩块**（不能直接当文字显示）。
 *
 * 真机实测：部分 `message_content` 是压缩或二进制载荷，直接转字符串会得到 `(�/�\`…` 这种乱码。
 * 判定用"控制字符占比"而不是"是否含某个字节"——文本消息里偶尔也会有制表符/换行。
 * @param s - 已转成字符串的内容。
 * @returns 疑似二进制则为 true。
 */
function looksBinary (s: string): boolean {
  if (s === '') return false
  let bad = 0
  for (let i = 0; i < s.length && i < 512; i++) {
    const c = s.charCodeAt(i)
    // 控制字符（除 \t \n \r）与替换字符 U+FFFD 都算"不像文字"
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffd) bad += 1
  }
  const n = Math.min(s.length, 512)
  return bad / Math.max(1, n) > 0.02
}

/**
 * 把 WeChat 的 `local_type` 映射成中文标签（用于"原文是图片/语音/文件"这类说明）。
 * 只列常见类型；未知类型给 `类型 N`，不做猜测。
 * @param lt - `local_type` 原始值。
 * @returns 中文标签。
 */
function typeLabelOf (lt: number | undefined): string {
  const t = lt === undefined ? 0 : lt & 0xffffffff
  switch (t) {
    case 1: return '文本'
    case 3: return '图片'
    case 34: return '语音'
    case 43: return '视频'
    case 47: return '表情'
    case 48: return '位置'
    case 49: return '链接/文件/引用'
    case 50: return '通话'
    case 10000: return '系统消息'
    default: return t === 0 ? '未知类型' : '类型 ' + String(t)
  }
}

/** `Msg_<md5>` → 会话 username 的反查缓存（按 contact names 这份 Map 的身份失效）。 */
const talkerLookupCache = new WeakMap<Map<string, string>, {
  byMd5: Map<string, string>
  displayToUser: Map<string, string>
}>()

/**
 * 从通讯录建两套反查：
 *   · md5(username) → username：归档 talker 只有 `Msg_<md5>`；
 *   · 显示名 → username：仅当显示名**唯一**时成立（同名歧义时宁可不给头像）。
 * @param names - `contactMeta().names`。
 */
function talkerLookups (names: Map<string, string>): { byMd5: Map<string, string>; displayToUser: Map<string, string> } {
  const hit = talkerLookupCache.get(names)
  if (hit !== undefined) return hit
  const byMd5 = new Map<string, string>()
  const displayToUser = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const [u, name] of names) {
    byMd5.set(createHash('md5').update(u, 'utf8').digest('hex'), u)
    const key = name.trim()
    if (key === '') continue
    if (displayToUser.has(key)) ambiguous.add(key)
    else displayToUser.set(key, u)
  }
  for (const key of ambiguous) displayToUser.delete(key)
  const out = { byMd5, displayToUser }
  talkerLookupCache.set(names, out)
  return out
}

/** 归档 talker（`file#Msg_<md5>`）→ 会话 username。 */
function sessionUsernameOfTalker (talker: string, byMd5: Map<string, string>): string {
  const m = new RegExp('#Msg_(' + MD5_SEGMENT + ')$', 'i').exec(talker)
  return m?.[1] === undefined ? '' : (byMd5.get(m[1].toLowerCase()) ?? '')
}

/** 撤回提示 XML 里的 `<fromusername>`（群消息提示常直接带真实 wxid）。 */
function usernameFromXmlTip (tip: string): string {
  const from = /<fromusername>\s*(?:<!\[CDATA\[)?([^<\]]{1,64})/i.exec(tip)
  return from?.[1]?.trim() ?? ''
}

/**
 * 产出「撤回消息」列表：**识别提示 + 配对原文**，全部来自我们自己的归档库。
 *
 * 配对判据：同一 `talker` 下、`row_key` 小于提示行的**最靠后那条**（同会话里紧挨在提示之前）。
 * 配不到就如实标注"原文未保留（撤回发生在归档开始之前）"——不编造。
 *
 * @param decryptedDir - 解密数据根。
 * @param limit - 上限（调用方已裁剪）。
 * @param offset - 偏移。
 * @param q - 关键词（匹配提示文本、发送者、或配到的原文）。
 * @returns 列表项与总数。
 */
export function queryRevokedRetained (
  decryptedDir: string,
  limit: number,
  offset: number,
  q?: string,
): { items: RetainedRevokeItem[]; total: number; readError?: string } {
  const p = messageArchivePath(decryptedDir)
  // W3-11.4：归档库不存在 ≠ 没有撤回消息。归档由同步 tick 自动补，
  // 所以这里给出 readError（界面据此说「还没归档」，而不是「你没有撤回消息」）。
  if (!existsSync(p)) return { items: [], total: 0, readError: '撤回消息归档库还没建立（后台同步会自动补上）；若长时间为空，请检查「数据配置」是否完成解密' }
  return withDb(p, (db) => {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='archived_msg'").get()
    if (has === undefined) return { items: [], total: 0, readError: '归档库缺少 archived_msg 表（可能解密不完整）：重新解密该库后即可' }
    const cols = new Set((db.prepare('PRAGMA table_info(archived_msg)').all() as Array<{ name: string }>).map((r) => r.name))
    const hasMeta = cols.has('sender_username') && cols.has('local_id') && cols.has('server_id')
    const metaSel = hasMeta
      ? 'sender_username, local_id, server_id'
      : "'' AS sender_username, 0 AS local_id, '' AS server_id"
    const kw = (q ?? '').trim().toLowerCase()
    const names = contactMeta(decryptedDir).names
    const lookups = talkerLookups(names)
    const selfUsername = resolveSelfUsername(decryptedDir)
    const tips = db.prepare(
      `SELECT talker, row_key AS k, create_time AS ct, content FROM archived_msg WHERE local_type = 10000 AND content LIKE ? ORDER BY create_time DESC, row_key DESC`,
    ).all('%' + REVOKE_TIP + '%') as Array<{ talker: string; k: number; ct: number; content: string }>
    /**
     * 配对：同一会话里、rowid 紧挨在提示之前的**非系统**消息（`local_type <> 10000`）。
     * 为什么排除系统消息：提示前一条本身也可能是"撤回了一条消息""拍了拍"等系统行，
     * 直接取会配错原文（自测发现）。
     */
    const prevStmt = db.prepare(
      `SELECT row_key AS rk, local_type, sender_id, content, ${metaSel} FROM archived_msg WHERE talker = ? AND row_key < ? AND local_type <> 10000 ORDER BY row_key DESC LIMIT 1`,
    )
    const items: RetainedRevokeItem[] = []
    for (const t of tips) {
      const tip = decodeStored(toText(t.content))
      const tipClean = stripGroupPrefix(tip).trim()
      const sender = senderFromTip(tipClean) || senderFromXmlTip(tipClean) || quotedName(tip) || '（未知）'
      const prev = prevStmt.get(t.talker, Number(t.k)) as {
        local_type?: number
        sender_id?: number
        rk?: number
        content?: string
        sender_username?: string
        local_id?: number
        server_id?: string
      } | undefined
      const original = prev?.content === undefined ? '' : decodeStored(toText(prev.content))
      const sessionUsername = sessionUsernameOfTalker(t.talker, lookups.byMd5)
      const sessionName = sessionUsername === '' ? '' : (names.get(sessionUsername) ?? sessionUsername)
      const isGroup = sessionUsername.endsWith('@chatroom') || stripGroupPrefix(tip) !== tip
      // 发送者 username 的优先级：原文群前缀 → 归档 Name2Id → 提示里的 <fromusername>
      // → 撤回提示显示名唯一匹配 → 私聊会话本身 / 自己。
      const rawPrefixUser = original === '' ? '' : senderFromBody(original)
      const tipUser = usernameFromXmlTip(tip)
      const byName = lookups.displayToUser.get(sender) ?? ''
      const senderUsername = rawPrefixUser
        || (prev?.sender_username ?? '')
        || tipUser
        || byName
        || (!isGroup && sender === sessionName ? sessionUsername : '')
        || (!isGroup && sender === names.get(selfUsername) ? selfUsername : '')
      const described = original === '' ? undefined : describeRevokedOriginal(original, prev?.local_type ?? 0, isGroup)
      const content = described?.content ?? '（原文未保留：撤回发生在归档开始之前）'
      const item: RetainedRevokeItem = {
        sender,
        type_label: described?.typeLabel ?? '原文缺失',
        content,
        create_time: Number(t.ct),
        ...(senderUsername !== '' ? { sender_username: senderUsername } : {}),
        ...(sessionUsername !== '' ? { session_username: sessionUsername } : {}),
        ...(sessionName !== '' ? { session_name: sessionName } : {}),
        session_is_group: isGroup,
        ...(prev === undefined ? {} : {
          // v1 归档没有 local_id：真机上 local_id === rowid，回退 row_key。
          local_id: Number(prev.local_id ?? 0) > 0 ? Number(prev.local_id) : Number(prev.rk ?? 0),
          server_id: String(prev.server_id ?? ''),
          raw_local_type: Number(prev.local_type ?? 0),
        }),
        retained: described !== undefined,
        status_label: described?.statusLabel ?? '原文未保留',
        ...(described?.media ? { media: described.media } : {}),
      }
      if (kw !== '' && !(item.sender.toLowerCase().includes(kw) || content.toLowerCase().includes(kw) || tip.toLowerCase().includes(kw))) continue
      items.push(item)
    }
    return { items: items.slice(offset, offset + limit), total: items.length }
  })
}
