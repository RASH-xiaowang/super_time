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
import * as zlib from 'node:zlib'
import { dirname, join } from 'node:path'
import { DatabaseSync } from './db-open.ts'
import { withDb, withWritableDb } from './db-open.ts'
import { decodeBlobText, msgTypeLabel, normalizeMsgType } from './messages.ts'
import { classifyRender, parseMessageContent, RENDER_LABEL, richPlaceholder, type RenderKind } from './parse.ts'
import { contactMeta } from './meta.ts'
import { resolveSelfUsername } from '../config/resolve.ts'
import { MD5_SEGMENT } from '../md5.ts'
import { probeRowStates, scanSourceTips, stateKey } from './revoke-source-probe.ts'
import type { MessageRich, RevokedItem, RevokedMedia, RevokedMediaKind } from '../types.ts'
import { displayNameForUsername, messageIdentityIndex } from './message-identity.ts'

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
 *
 * 2 → 3：修正 `sender_username` 的归属。v2 无条件把 Name2Id 的空名行当成登录账号，
 * 真机上那个空名行其实是**另一位群成员** —— 他/她发的消息被记成了「我发的」。
 * 判据改成「先找显式账号行，找不到才退回空行」（与 `messages.ts` 同一口径）；
 * 已写错的旧行需要重扫才会被纠正，因此同样要 bump 版本。
 */
const ARCHIVE_VERSION = 3

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
  /** 会话标识：`WechatSession.username` 的等价物（本模块用「文件#表名」表示）。 */
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
    /*
     * 撤回列表要按 `local_type = 10000` 筛系统消息（52 万行里约 8 千行），
     * 没有索引时每次打开面板都要全表扫一遍（真机实测 ~400ms）。
     * 这条索引与内容无关、只加速筛选，`CREATE INDEX IF NOT EXISTS` 幂等。
     *
     * ⚠️ 必须 best-effort：在 364MB 表上建索引会短暂持有写锁，
     * 若此刻另一个连接正在读归档（打开撤回面板），这里会 `database is locked`。
     * 建索引失败不影响归档本身 —— 索引只是优化，下次启动会再试。
     */
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_archived_msg_lt ON archived_msg(local_type)')
    } catch { /* 建不了就算了，查询仍可用（只是慢） */ }
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
    // 旧行只补定位键与发送者，**绝不更新 content**：归档的保留语义是「首次入库的原文永久不变」。
    // 谓词里的 `sender_username = ?self` 只为修正 v2 的误归属（空名行被当成登录账号）；
    // 它由 `name2IdOk` 兜底 —— Name2Id 读失败时宁可不动，也不能把整片发送者清空。
    const updMeta = adb.prepare(
      'UPDATE archived_msg SET create_time = ?, local_type = ?, sender_id = ?, sender_username = ?, '
      + 'local_id = ?, server_id = ? WHERE talker = ? AND row_key = ? '
      + 'AND (sender_username = \'\' OR local_id = 0 OR server_id = \'\' OR (? = 1 AND sender_username = ?))',
    )
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
      let name2IdOk = false
      try {
        rows = withDb(srcFile, (db) => {
          const out: Array<{ tk: string; k: number; ct: number; lt: number; sid: number; su: string; lid: number; srid: string; mc: unknown }> = []
          // Name2Id：real_sender_id → wxid。
          // ⚠️ 空 user_name **不是**无条件代表登录账号：真机的同一分片里登录账号有
          // 显式 wxid 行（`message_5.db` rowid 2），空名行是**另一位群成员** ——
          // 它的行里全是「"郭亮" 撤回了一条消息」这类别人的撤回提示。把空名行当
          // 自己，会把这个人所有消息的发送者写成「我」（与 `messages.ts#isSelf`
          // 同一类误归属）。判据与 `messages.ts#shardMarksSelfWithEmptyRow`、
          // `calls.ts#findSelfRowId` 一致：先找显式账号行，找不到才沿旧约定退回空行。
          const name2Id = new Map<number, string>()
          let emptyRowId: number | undefined
          let explicitSelfId: number | undefined
          for (const t of ['Name2Id', 'name2id']) {
            try {
              const got = db.prepare(`SELECT rowid AS id, user_name AS u FROM ${t}`).all() as Array<{ id: number; u: unknown }>
              for (const ng of got) {
                const id = Number(ng.id)
                const u = toText(ng.u).trim()
                name2Id.set(id, u)
                if (u === '') {
                  if (emptyRowId === undefined) emptyRowId = id
                } else if (selfUsername !== '' && u === selfUsername && explicitSelfId === undefined) {
                  explicitSelfId = id
                }
              }
              if (name2Id.size > 0) break
            } catch { /* 换另一个大小写 */ }
          }
          const selfRowId = explicitSelfId ?? emptyRowId
          // Name2Id 一个都没读出来（库损坏/权限）时，`su` 会整片是空串；这种情况下
          // 绝不能用它去覆盖归档里已有的发送者（见 updMeta 的谓词）。
          name2IdOk = name2Id.size > 0
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
          // 已有行：只补/修正定位与发送者元数据。`content` 不在 SET 里是硬约束。
          // 最后的两个参数用于纠正 v2 误归属（见 updMeta 注释）。
          updMeta.run(r.ct, r.lt, r.sid, r.su, r.lid, r.srid, r.tk, r.k, name2IdOk ? 1 : 0, selfUsername)
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
  if (/^[0-9.]+$/.test(name)) return ''
  /*
   * **绝不能取 XML 属性值**（2026-11-19 真机回归）：
   * 微信 4.x 的提示是 `<sysmsg type="revokemsg"><revokemsg><content>你撤回了一条消息</content>…`，
   * `type="revokemsg"` 与 `撤回了一条消息` 之间只隔了 24 个字符以内 —— 上面那条正则
   * 就把发送者取成了 **`revokemsg`**（真机列表里第一行的显示值）。
   * 属性值一定带 `=`/`<`/`>` 的邻居，或本身是标签名，一律排除。
   */
  if (/[=<>]/.test(name) || /^(revokemsg|sysmsg|xml|version)$/i.test(name)) return ''
  return name
}

/**
 * 撤回提示里的**正文**（`<revokemsg><content>…</content>`）。
 *
 * 4.x 的提示不带 `<replacemsg>`，只有这个 `<content>`；发送者名就藏在里面
 * （`"梦" 撤回了一条消息` / `你撤回了一条消息`）。
 * @param tip - 已解码的提示内容。
 * @returns `<content>` 的文本；没有该标签时返回空串。
 */
function tipContentOf (tip: string): string {
  const m = /<content>\s*(?:<!\[CDATA\[)?([\s\S]{0,200}?)(?:\]\]>)?\s*<\/content>/i.exec(tip)
  return m?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim() ?? ''
}

/**
 * 从提示里取发送者（三层兜底，顺序有讲究）。
 *
 * 1. `<content>` 里的正文（4.x 主流形态，最可靠）；
 * 2. 纯文本 `"某某" 撤回了一条消息`；
 * 3. XML 的 `<replacemsg>` / `<fromusername>`；最后才是任意位置的引号名。
 *
 * 「你/我 撤回了一条消息」= 自己撤回的，返回本人的显示名 —— 旧实现会把它当成"（未知）"，
 * 用户就不知道这条是自己撤的。
 * @param tip - 已解码的提示内容（可能带群前缀）。
 * @param selfName - 本人的显示名（取不到时用「我」）。
 * @returns 发送者显示名。
 */
function senderFromTipAny (tip: string, selfName: string): string {
  const stripped = stripGroupPrefix(tip).trim()
  const inner = tipContentOf(stripped) || tipContentOf(tip) || stripped
  if (/^(你|我)\s*撤回了一条消息/.test(inner)) return selfName !== '' ? selfName : '我'
  return senderFromTip(inner) || senderFromXmlTip(inner) || quotedName(stripped) || '（未知）'
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

/**
 * 显示名 → username：仅当显示名**唯一**时成立（同名歧义时宁可不给头像）。
 * 表 hash → username 由统一身份索引提供，旧群即使已从通讯录消失也能解析。
 * @param names - `contactMeta().names`。
 */
function displayNameLookups (names: Map<string, string>): Map<string, string> {
  const displayToUser = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const [u, name] of names) {
    const key = name.trim()
    if (key === '') continue
    if (displayToUser.has(key)) ambiguous.add(key)
    else displayToUser.set(key, u)
  }
  for (const key of ambiguous) displayToUser.delete(key)
  return displayToUser
}

/** 归档 talker（`file#Msg_<md5>`）→ 会话 username。 */
function sessionUsernameOfTalker (talker: string, hashToUsername: ReadonlyMap<string, string>): string {
  const m = new RegExp('#Msg_(' + MD5_SEGMENT + ')$', 'i').exec(talker)
  return m?.[1] === undefined ? '' : (hashToUsername.get(m[1].toLowerCase()) ?? '')
}

/** 撤回提示 XML 里的 `<fromusername>`（群消息提示常直接带真实 wxid）。 */
function usernameFromXmlTip (tip: string): string {
  const from = /<fromusername>\s*(?:<!\[CDATA\[)?([^<\]]{1,64})/i.exec(tip)
  return from?.[1]?.trim() ?? ''
}

/** 列表项的一条「候选」：只记「哪里有撤回 + 时间」，内容与配对结果留到构造当前页时解析。 */
interface RevokeCandidate {
  /** 会话标识，等价于 `WechatSession.username`（形如 `message_0.db#Msg_<md5>`）。 */
  talker: string
  rowKey: number
  /** 提示正文（已解码）。只有源库侧候选在这里就有值，归档侧留到按页解析。 */
  tip: string
  createTime: number
  /** 来自「源库已改写成提示、归档仍是原文」这条路（真正防撤回成功的那些）。 */
  fromSource: boolean
}

/**
 * 产出「撤回消息」列表：**识别提示 + 配对原文**，数据来自我们自己的归档库，
 * 并用**源库当前状态**校验配对是否成立（2026-11-19 重做）。
 *
 * ## 为什么必须校验（真机实测的根因）
 *
 * 微信撤回是**就地改写**那一行：原文不再以任何形式留在库里。所以只有「在改写前存下过」
 * 才能拿到原文。旧实现不管有没有存下，一律把「提示前一条」当作原文并标成"原文已保留" ——
 * 真机 4,554 条提示里只有 208 条确实存到了原文，其余 4,346 条显示的都是**上一条不相干的消息**，
 * 用户因此"看不到撤回的内容是啥"（内容根本不是被撤回的那条）。
 *
 * 现在按源库状态分三类：
 *   · 源库该行已删除 / 已变成提示 ⇒ 归档里那份就是原文（**确认**）；
 *   · 源库该行还是原样 ⇒ 它不是撤回原文，标为"原文未保留"（**不再冒充**）；
 *   · 源库读不到 ⇒ 沿用旧配对，但标为「推定」，让用户自己判断。
 *
 * ## 另一类原文（旧实现完全漏掉）
 *
 * 「归档留着原文、源库已被改写成提示」的行——它们**不在**归档的提示行集合里
 * （归档那行的内容还是原文），所以旧实现永远看不到它们。现在以**源库的提示行**为锚点
 * 反查归档，把这类真正防撤回成功的记录也列出来。
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
  /*
   * 打开/读取失败要与「没有撤回」分开报：上次异常退出会在库旁留未 checkpoint 的 `-wal`，
   * 只读打开需要写 wal 索引 ⇒ 抛 `attempt to write a readonly database`。
   * 旧代码让它冒泡、被上层 catch 吞成空列表，面板显示「暂无撤回消息」，用户以为防撤回失效。
   */
  try {
    return readArchive(p, decryptedDir, limit, offset, q)
  } catch (e) {
    return {
      items: [],
      total: 0,
      readError: '读取撤回归档失败（与「没有撤回消息」不同）：' + ((e as Error)?.message ?? String(e))
        + '。常见原因是上次异常退出留下了未合并的 -wal；重启应用后再试即可。',
    }
  }
}

/** 真正读归档库（拆出来只为让上面那层能统一兜错）。 */
function readArchive (
  p: string, decryptedDir: string, limit: number, offset: number, q?: string,
): { items: RetainedRevokeItem[]; total: number; readError?: string } {
  return withDb(p, (db) => {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='archived_msg'").get()
    if (has === undefined) return { items: [], total: 0, readError: '归档库缺少 archived_msg 表（可能解密不完整）：重新解密该库后即可' }
    const cols = new Set((db.prepare('PRAGMA table_info(archived_msg)').all() as Array<{ name: string }>).map((r) => r.name))
    const hasMeta = cols.has('sender_username') && cols.has('local_id') && cols.has('server_id')
    const metaSel = hasMeta
      ? 'sender_username, local_id, server_id'
      : "'' AS sender_username, 0 AS local_id, '' AS server_id"
    const kw = (q ?? '').trim().toLowerCase()
    const meta = contactMeta(decryptedDir)
    const { names, enterpriseNames } = meta
    const displayToUser = displayNameLookups(names)
    const hashToUsername = messageIdentityIndex(decryptedDir).hashToUsername
    const selfUsername = resolveSelfUsername(decryptedDir)
    const selfName = selfUsername === '' ? '' : displayNameForUsername(selfUsername, names)

    /*
     * 提示行**只取元数据**：content 留到构造当前页时再读。
     *
     * 真机实测：4,186 条提示逐条读 content + 逐条查"前一条" + 逐条查归档同一行，
     * 合计 ~270ms，而分页每次刷新都要重算一遍。只取 talker/row_key/create_time
     * 时这条查询 15ms —— 剩下的全是可以用「只对当前页做」来省掉的。
     */
    const archiveTips = db.prepare(
      `SELECT talker, row_key AS k, create_time AS ct FROM archived_msg WHERE local_type = 10000 AND content LIKE ?`,
    ).all('%' + REVOKE_TIP + '%') as Array<{ talker: string; k: number; ct: number }>
    const archiveTipKeys = new Set(archiveTips.map(t => stateKey(t.talker, Number(t.k))))
    /* 配对：同一会话里紧挨在提示之前的**非系统**消息（提示前一条也可能是系统行）。 */
    const prevStmt = db.prepare(
      `SELECT row_key AS rk, local_type, content, ${metaSel} FROM archived_msg WHERE talker = ? AND row_key < ? AND local_type <> 10000 ORDER BY row_key DESC LIMIT 1`,
    )
    /* ① 源库这一行现在是撤回提示、而归档里**没有**这条提示 ⇒ 归档那份是改写前的原文。 */
    const archivedAt = db.prepare(
      `SELECT local_type, content, ${metaSel} FROM archived_msg WHERE talker = ? AND row_key = ?`,
    )
    const sourceTips = scanSourceTips(decryptedDir)
    const candidates: RevokeCandidate[] = []
    for (const [talker, tipMap] of sourceTips) {
      for (const [k, info] of tipMap) {
        // 归档也是提示 ⇒ 归档晚于撤回，交给 ② 如实说明（否则同一条会被记两次）。
        if (archiveTipKeys.has(stateKey(talker, k))) continue
        candidates.push({ talker, rowKey: k, tip: info.text, createTime: info.ct, fromSource: true })
      }
    }
    /** ② 归档里的提示行。 */
    for (const t of archiveTips) {
      candidates.push({ talker: t.talker, rowKey: Number(t.k), tip: '', createTime: Number(t.ct), fromSource: false })
    }

    /*
     * 排序：**一律按时间倒序（最新在最前）**。
     *
     * ⚠️ 2026-11-19 修：一度改成「源库确认有原文的排最前面」，结果是新发生的撤回
     * （还没配上原文）被压到 200 多条旧记录之后 —— 用户打开面板找刚撤回的那条，
     * 翻遍首屏也看不到，体感就是"防撤回没实时生效"。撤回面板的第一语义是**时间线**，
     * 不是"原文大全"；有原文的那些由 `status_label` 标明，扫一眼就能分辨。
     */
    candidates.sort((a, b) => b.createTime - a.createTime)
    /**
     * 没有关键词时只构造**当前页**；带关键词时必须全量匹配（用户主动搜索，慢一点可接受）。
     */
    const pageOnly = kw === ''
    const toBuild = pageOnly ? candidates.slice(offset, offset + limit) : candidates

    /*
     * 只对**这一页**查「提示前一条」与「源库是否仍原样」。
     * 4 千多条逐条查曾占 200ms 以上，而结果只影响当前页的措辞。
     */
    type Row = { local_type?: number; rk?: number; content?: unknown; sender_username?: string; local_id?: number; server_id?: string }
    const prevOf = new Map<string, Row | undefined>()
    const verifyWanted = new Map<string, Set<number>>()
    for (const c of toBuild) {
      if (c.fromSource) continue
      const prev = prevStmt.get(c.talker, c.rowKey) as Row | undefined
      prevOf.set(stateKey(c.talker, c.rowKey), prev)
      if (prev?.rk === undefined) continue
      const set = verifyWanted.get(c.talker) ?? new Set<number>()
      set.add(Number(prev.rk))
      verifyWanted.set(c.talker, set)
    }
    const pageStates = probeRowStates(decryptedDir, verifyWanted)

    const items: RetainedRevokeItem[] = []
    for (const c of toBuild) {
      const key = stateKey(c.talker, c.rowKey)
      const row = archivedAt.get(c.talker, c.rowKey) as Row | undefined
      let tip = c.tip
      let origin: { raw: string; localType: number; senderUsername: string; localId: number; serverId: string; rowKey: number } | undefined
      let confirmed = false
      if (c.fromSource) {
        /* ① 归档这一行留着原文（源库已把它改写成提示）。 */
        const raw = row === undefined ? '' : decodeStored(toText(row.content))
        if (Number(row?.local_type ?? 0) !== 10000 && raw !== '' && !raw.includes(REVOKE_TIP)) {
          confirmed = true
          origin = {
            raw,
            localType: Number(row?.local_type ?? 0),
            senderUsername: String(row?.sender_username ?? ''),
            localId: Number(row?.local_id ?? 0),
            serverId: String(row?.server_id ?? ''),
            rowKey: c.rowKey,
          }
        }
      } else {
        /* ② 归档里的提示：正文来自同一行，再由源库状态决定「前一条」算不算原文。 */
        tip = row === undefined ? '' : decodeStored(toText(row.content))
        const prev = prevOf.get(key)
        const raw = prev?.content === undefined ? '' : decodeStored(toText(prev.content))
        if (prev?.rk !== undefined && raw !== '') {
          const st = pageStates.get(stateKey(c.talker, Number(prev.rk))) ?? 'unknown'
          /*
           * · 已删除 ⇒ 确认（就是被撤掉的那行）；
           * · 已变成提示 ⇒ **这里不认**：原文由 ① 产出，再认一次会同一条记两次；
           * · 仍原样 ⇒ 它不是原文，宁可不显示也不冒充；
           * · 读不到 ⇒ 保留内容但标"推定"。
           */
          if (st === 'deleted') {
            confirmed = true
            origin = {
              raw,
              localType: Number(prev.local_type ?? 0),
              senderUsername: String(prev.sender_username ?? ''),
              localId: Number(prev.local_id ?? 0),
              serverId: String(prev.server_id ?? ''),
              rowKey: Number(prev.rk),
            }
          } else if (st === 'unknown') {
            origin = {
              raw,
              localType: Number(prev.local_type ?? 0),
              senderUsername: String(prev.sender_username ?? ''),
              localId: Number(prev.local_id ?? 0),
              serverId: String(prev.server_id ?? ''),
              rowKey: Number(prev.rk),
            }
          }
        }
      }
      const sessionUsername = sessionUsernameOfTalker(c.talker, hashToUsername)
      const sessionName = sessionUsername === '' ? '' : displayNameForUsername(sessionUsername, names)
      const enterpriseName = sessionUsername === '' ? undefined : enterpriseNames.get(sessionUsername)
      const isGroup = sessionUsername.endsWith('@chatroom') || stripGroupPrefix(tip) !== tip
      const tipClean = stripGroupPrefix(tip).trim()
      const sender = senderFromTipAny(tipClean, selfName)
      const rawPrefixUser = origin === undefined ? '' : senderFromBody(origin.raw)
      const tipUser = usernameFromXmlTip(tip)
      const byName = displayToUser.get(sender) ?? ''
      const senderUsername = rawPrefixUser
        || (origin?.senderUsername ?? '')
        || tipUser
        || byName
        || (!isGroup && sender === sessionName ? sessionUsername : '')
        || (!isGroup && sender === selfName && selfName !== '' ? selfUsername : '')
      const described = origin === undefined ? undefined : describeRevokedOriginal(origin.raw, origin.localType, isGroup)
      /*
       * 三种措辞必须能一眼分开，否则用户又会以为"防撤回没用"：
       *   · 确认 ⇒ 直接给原文；
       *   · 推定 ⇒ 给候选内容但**明说是推定**；
       *   · 无原文 ⇒ 说清原因（微信就地改写，我们没赶上）。
       */
      const content = described === undefined
        ? '（原文未保留：微信撤回时会**就地把这条消息改写成提示**，我们没能在改写之前把原文存下来）'
        : confirmed
          ? described.content
          : `（以下是给「提示」配对到的前一条消息，**可能不是**被撤回的那条）\n${described.content}`
      const statusLabel = described === undefined
        ? '原文未保留'
        : confirmed ? described.statusLabel : '原文未确认（推定）'
      const senderEnterpriseName = senderUsername === '' ? undefined : enterpriseNames.get(senderUsername)
      const item: RetainedRevokeItem = {
        sender,
        type_label: described?.typeLabel ?? '原文缺失',
        content,
        create_time: c.createTime,
        ...(senderUsername !== '' ? { sender_username: senderUsername } : {}),
        ...(sessionUsername !== '' ? { session_username: sessionUsername } : {}),
        ...(sessionName !== '' ? { session_name: sessionName } : {}),
        ...(enterpriseName !== undefined && enterpriseName.trim() !== '' ? { enterpriseName } : {}),
        ...(senderEnterpriseName !== undefined && senderEnterpriseName.trim() !== '' ? { senderEnterpriseName } : {}),
        session_is_group: isGroup,
        ...(origin === undefined ? {} : {
          // v1 归档没有 local_id：真机上 local_id === rowid，回退 row_key。
          local_id: origin.localId > 0 ? origin.localId : origin.rowKey,
          server_id: origin.serverId,
          raw_local_type: origin.localType,
        }),
        retained: described !== undefined,
        status_label: statusLabel,
        ...(described?.media ? { media: described.media } : {}),
      }
      const searchable = [
        item.sender,
        content,
        tip,
        enterpriseName ?? '',
        senderEnterpriseName ?? '',
      ].join('\n').toLowerCase()
      if (kw !== '' && !searchable.includes(kw)) continue
      items.push(item)
    }
    if (pageOnly) return { items, total: candidates.length }
    return { items: items.slice(offset, offset + limit), total: items.length }
  })
}
