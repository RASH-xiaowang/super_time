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
import { DatabaseSync } from 'node:sqlite'
import { withDb, withWritableDb } from './db-open.ts'
import { decodeBlobText } from './messages.ts'

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
  '  content TEXT NOT NULL,',
  '  archived_at INTEGER NOT NULL,',
  '  PRIMARY KEY (talker, row_key)',
  ')',
].join('\n')

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
const BIN_PREFIX = '\u0001BIN:'

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
  content: string
}

/** 打开（必要时创建）归档库。 */
function ensureArchive (decryptedDir: string): string {
  const p = messageArchivePath(decryptedDir)
  const dir = dirname(p)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  withWritableDb(p, (db) => { db.exec(DDL) })
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
const SRC_DDL = 'CREATE TABLE IF NOT EXISTS archived_source (file TEXT PRIMARY KEY, sig TEXT NOT NULL, rows INTEGER NOT NULL, at INTEGER NOT NULL)'

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
    adb.exec(SRC_DDL)
    const ins = adb.prepare('INSERT OR IGNORE INTO archived_msg (talker, row_key, create_time, local_type, sender_id, content, archived_at) VALUES (?,?,?,?,?,?,?)')
    const getSrc = adb.prepare('SELECT sig FROM archived_source WHERE file = ?')
    const setSrc = adb.prepare('INSERT OR REPLACE INTO archived_source (file, sig, rows, at) VALUES (?,?,?,?)')
    const now = Math.floor(Date.now() / 1000)
    let added = 0
    let tables = 0
    let scanned = 0
    let skipped = 0
    for (const file of files) {
      const srcFile = join(msgDir, file)
      const sig = srcSig(srcFile)
      const known = getSrc.get(file) as { sig?: string } | undefined
      // 签名没变 ⇒ 这个库里不可能有新消息，整库跳过（这是"空闲零开销"的来源）
      if (sig !== '' && known?.sig === sig) { skipped += 1; continue }
      let rows: Array<{ tk: string; k: number; ct: number; lt: number; sid: number; mc: unknown }> = []
      try {
        rows = withDb(srcFile, (db) => {
          const out: Array<{ tk: string; k: number; ct: number; lt: number; sid: number; mc: unknown }> = []
          for (const table of msgTables(db)) {
            const cols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name))
            if (!cols.has('message_content')) continue
            const ct = cols.has('create_time') ? 'create_time' : '0'
            const lt = cols.has('local_type') ? 'local_type' : '0'
            const sid = cols.has('real_sender_id') ? 'real_sender_id' : '0'
            tables += 1
            /**
             * `tk` 是**会话级标识**（`文件#表名`）——必须与"行号"分开：
             * 配对要在**同一会话**里找"紧挨提示之前的那条"，若把行号并进会话标识，
             * `WHERE talker = ? AND row_key < ?` 永远匹配不到（自测时发现的坑）。
             */
            const tk = file + '#' + table
            const got = db.prepare(`SELECT rowid AS k, ${ct} AS ct, ${lt} AS lt, ${sid} AS sid, message_content AS mc FROM ${table}`).all() as Array<{ k: number; ct: number; lt: number; sid: number; mc: unknown }>
            for (const g of got) out.push({ tk, k: Number(g.k), ct: Number(g.ct ?? 0), lt: Number(g.lt ?? 0), sid: Number(g.sid ?? 0), mc: g.mc })
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
          const res = ins.run(r.tk, r.k, r.ct, r.lt, r.sid, compressForStore(content), now)
          added += Number((res as { changes?: number }).changes ?? 0)
        }
        adb.exec('COMMIT')
      } catch (e) {
        try { adb.exec('ROLLBACK') } catch { /* 回滚失败不掩盖原错误 */ }
        throw e
      }
      setSrc.run(file, sig, rows.length, now)
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

/**
 * 把"原文"描述成一句人话。
 *
 * 实测撤回原文里大量是 XML（`<msg><img …`、`<msg><emoji …`）：直接铺出来既长又看不懂，
 * 所以按根子标签映射成类型；**原文本身仍完整留在归档库里**（这里只改展示）。
 * @param raw - 已解码的原文。
 * @param lt - 原文的 `local_type`（XML 里认不出来时兜底）。
 * @returns 展示用的一句话。
 */
function describeOriginal (raw: string, lt: number | undefined): string {
  // 归档时对二进制/压缩内容存的是标记（见 BIN_PREFIX）——这里按"类型 + 字节数"如实说明
  if (raw.startsWith(BIN_PREFIX)) {
    const parts = raw.split(':')
    const tag = Number(parts[1] ?? 0)
    const bytes = Number(parts[2] ?? 0)
    return '（' + typeLabelOf(tag) + '，原文为二进制/压缩内容（' + String(bytes) + ' 字节），已按类型记账）'
  }
  const body = stripGroupPrefix(raw).trim()
  if (body === '') return '（原文已保留，但内容为空）'
  if (body.startsWith('<')) {
    const tag = /<msg>\s*<([a-z0-9_]+)/i.exec(body.replace(/\s+/g, ' '))?.[1]?.toLowerCase() ?? ''
    const byTag: Record<string, string> = {
      img: '图片', emoji: '表情', video: '视频', voicemsg: '语音', appmsg: '链接/文件/引用',
      location: '位置', sysmsg: '系统消息', card: '名片', game: '小程序', weapp: '小程序',
    }
    const label = byTag[tag] ?? typeLabelOf(lt)
    return '（' + label + '，原文已保留；不在此展开 XML）'
  }
  if (looksBinary(body)) return '（' + typeLabelOf(lt) + '，原文已保留但为二进制/压缩内容，不在此展开）'
  return brief(body)
}

/** 列表项（与旧的插件来源同形状，面板不需要改）。 */
export interface RetainedRevokeItem { sender: string; type_label: string; content: string; create_time: number }

/** 从撤回提示里取发送者名：`"某某" 撤回了一条消息` ⇒ 某某。 */
function senderFromTip (tip: string): string {
  const m = /^[“"']?([^”"']{1,40})[”"']?\s*撤回了一条消息/.exec(tip.trim())
  return m?.[1]?.trim() ?? ''
}

/** 原文摘要：压平空白、截断，便于列表里一眼看到"撤回前说了什么"。 */
function brief (content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  return flat.length > 160 ? flat.slice(0, 160) + '…' : flat
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
): { items: RetainedRevokeItem[]; total: number } {
  const p = messageArchivePath(decryptedDir)
  if (!existsSync(p)) return { items: [], total: 0 }
  return withDb(p, (db) => {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='archived_msg'").get()
    if (has === undefined) return { items: [], total: 0 }
    const kw = (q ?? '').trim().toLowerCase()
    const tips = db.prepare(
      'SELECT talker, row_key AS k, create_time AS ct, content FROM archived_msg WHERE local_type = 10000 AND content LIKE ? ORDER BY create_time DESC, row_key DESC',
    ).all('%' + REVOKE_TIP + '%') as Array<{ talker: string; k: number; ct: number; content: string }>
    /**
     * 配对：同一会话里、rowid 紧挨在提示之前的**非系统**消息（`local_type <> 10000`）。
     * 为什么排除系统消息：提示前一条本身也可能是"撤回了一条消息""拍了拍"等系统行，
     * 直接取会配错原文（自测发现）。
     */
    const prevStmt = db.prepare(
      'SELECT local_type, sender_id, content FROM archived_msg WHERE talker = ? AND row_key < ? AND local_type <> 10000 ORDER BY row_key DESC LIMIT 1',
    )
    const items: RetainedRevokeItem[] = []
    for (const t of tips) {
      const tip = decodeStored(toText(t.content))
      const tipClean = stripGroupPrefix(tip).trim()
      const sender = senderFromTip(tipClean) || senderFromXmlTip(tipClean) || quotedName(tip) || '（未知）'
      const prev = prevStmt.get(t.talker, Number(t.k)) as { local_type?: number; content?: string } | undefined
      const original = prev?.content === undefined ? '' : decodeStored(toText(prev.content))
      /**
       * 展示口径：文本给摘要；XML 按类型说明；二进制不硬啃。原文**始终完整留在库里**。
       */
      const content = original === ''
        ? '（原文未保留：撤回发生在归档开始之前）'
        : describeOriginal(original, prev?.local_type)
      const item: RetainedRevokeItem = { sender, type_label: prev === undefined ? '撤回（原文缺失）' : '撤回（原文已保留）', content, create_time: Number(t.ct) }
      if (kw !== '' && !(item.sender.toLowerCase().includes(kw) || content.toLowerCase().includes(kw) || tip.toLowerCase().includes(kw))) continue
      items.push(item)
    }
    return { items: items.slice(offset, offset + limit), total: items.length }
  })
}
