/**
 * Storage stats over message_resource.db, mirroring handlers/data/storage.rs:
 * total / categories (extension-priority + type-domain fallback) / chat &
 * sender rankings via MessageResourceInfo + name2id rowid maps / large files
 * with protobuf-parsed packed_info names.
 */
import { createHash } from 'node:crypto'
import { DatabaseSync } from './db-open.ts'
import { raiseAnalyticsCache } from '../sqlite-connection.ts'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decompress } from 'fzstd'
import { cachedBySigAsync, contactMeta, fileSigOf, shardCatalogDirs } from './meta.ts'
import { yieldToLoop } from './search-build.ts'
import { classifyPacked, classifyType, parsePackedName } from './resource-classify.ts'

/** Storage category aggregate (label + count + size). */
export interface StorageCategory { label: string; count: number; size: number }
/** Storage rank entry (chat or sender: username + display name + count + size). */
export interface StorageRank { username: string; name: string; count: number; size: number }
/** One large file entry (name + owning session + size). */
export interface LargeFile { name: string; username: string; sessionName: string; create_time: number; size: number }

const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

/**
 * `getStorageStats` 的分段打点（`SUPERTIME_STORAGE_TRACE=1` 才生效，默认零开销）。
 *
 * 为什么需要：它是首屏「数据总览」最贵的单个查询（本机实测慢调用日志 676ms，
 * 见 docs/perf/09-RESULT.md）。但 676ms 到底花在 SQL 聚合、联系人表、还是
 * `msg/file` 名称树的逐文件 stat 上，光看代码判断不了 —— 本机只读复刻实测 SQL
 * 合计仅 157ms、contact.db 15ms，说明大头在应用内某个别的段。这里只打时间戳，
 * 不做任何业务动作，是定位而不是优化。
 */
const STORAGE_TRACE = process.env.SUPERTIME_STORAGE_TRACE === '1'
let storageTraceT0 = 0
/**
 * 打一条存储分段。
 * @param label - 阶段名（固定词表，便于日志侧解析）。
 * @param n - 可选计数（行数/条目数），用于判断「慢在量上还是常数开销」。
 */
function storageMark(label: string, n = 0): void {
  if (!STORAGE_TRACE) return
  try {
    console.log('[storage-trace] ' + label + ' t=' + String(Date.now() - storageTraceT0) + (n > 0 ? ' n=' + String(n) : ''))
  } catch { /* 打点失败绝不影响查询 */ }
}

function decodeMsgText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  const raw = Buffer.from(v instanceof Uint8Array ? v : [])
  const bytes = raw.length >= 4 && raw.subarray(0, 4).equals(ZSTD_MAGIC)
    ? (() => { try { return Buffer.from(decompress(raw)) } catch { return raw } })()
    : raw
  try { return new TextDecoder('utf-8', { fatal: false }).decode(bytes) } catch { return new TextDecoder('gbk', { fatal: false }).decode(bytes) }
}

function xmlTitle(xml: string): string {
  const m = xml.match(/<title>([^<]*)<\/title>/)
  return m ? (m[1] ?? '').trim() : ''
}

/** 找到包含指定会话消息表的 shard（db + table）。走共享分片目录缓存，不再逐库开句柄探测。 */
function findMsgShard(dec: string, username: string): { db: string; table: string } | null {
  const table = 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
  for (const sh of shardCatalogDirs(dec, ['message', 'bizchat'])) {
    if (sh.tables.has(table)) return { db: sh.file, table }
  }
  return null
}

/** 通过消息 server_id 反查 appmsg <title>（真实文件名来源之一）。 */
function resolveFileTitle(dec: string, username: string, svr: string): string {
  if (!svr) return ''
  const sh = findMsgShard(dec, username)
  if (!sh) return ''
  try {
    const db = new DatabaseSync(sh.db, { readOnly: true })
    try {
      const cols = new Set((db.prepare('PRAGMA table_info(' + sh.table + ')').all() as Array<{ name: string }>).map(r => r.name))
      if (!cols.has('server_id')) return ''
      const content = cols.has('message_content') ? 'message_content' : 'content'
      // 数字 server_id 先走整型等值（命中索引），文本/未命中再回退 CAST。
      let numeric: bigint | null = null
      if (/^\d+$/.test(svr)) {
        try { numeric = BigInt(svr) } catch { /* keep text path */ }
      }
      let row: { c?: unknown } | undefined
      if (numeric !== null) {
        row = db.prepare('SELECT ' + content + ' AS c FROM ' + sh.table + ' WHERE server_id = ? LIMIT 1').get(numeric)
      }
      if (!row) {
        row = db.prepare('SELECT ' + content + ' AS c FROM ' + sh.table + ' WHERE CAST(server_id AS TEXT) = ? LIMIT 1').get(svr)
      }
      return row ? xmlTitle(decodeMsgText(row.c)) : ''
    } finally {
      db.close()
    }
  } catch {
    return ''
  }
}
/**
 * `msg/file` 树的签名：根目录 + **每个月份子目录**的 mtime/size。
 *
 * 只签根目录是不够的（子目录里新增文件不会改根目录 mtime），而逐个文件 stat 又太贵 ——
 * 子目录自己的 mtime 会在其内容变化时更新，粒度刚好。
 * @param root - `msg/file` 目录。
 * @returns 签名串（读不到时为空串）。
 */
function fileNamesSig(root: string): string {
  const parts: string[] = [fileSigOf(root)]
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      parts.push(`${e.name}:${fileSigOf(join(root, e.name))}`)
    }
  } catch { /* 读不到就只用根目录签名 */ }
  return parts.join('|')
}

/** 扫描 msg/file 各月份子目录，建立 size -> 原文件名 映射（还原大文件真实文件名）。 */
async function loadFileNamesBySize(wechatBaseDir: string | undefined): Promise<Map<number, string>> {
  if (!wechatBaseDir) return new Map<number, string>()
  const root = join(wechatBaseDir, 'msg', 'file')
  if (!existsSync(root)) return new Map<number, string>()
  // 全树 stat 较重：按进程内缓存。签名必须覆盖**各月份子目录**而不只是 root：
  // 新文件是落到 `msg/file/<月>/` 里的，root 自身的 mtime 并不随子目录内容变化 ——
  // 原先只签 root，实际靠「事件后整表清空」兜住（M8 去掉那层兜底后补齐）。
  //
  // TTL 保持 10s（不是这里的默认 30s）：目录签名看不到「同名文件原地改 size」这类
  // 子目录内部变更（NTFS 下目录的 mtime/size 不会因此变化），而改动前那次「事件后清空」
  // 给的实效上界就是 ~10s（同步活跃期事件间隔）。别把上界放宽。
  return cachedBySigAsync('storage-file-names:' + root, fileNamesSig(root), async () => {
    const map = new Map<number, string>()
    try {
      for (const e of readdirSync(root, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        // P1-2：`msg/file/<月份>/` 是微信收到的原始文件，月份目录之间各让一次
        // （整树要 stat 上万个文件，是这一页最重的一段）。
        await yieldToLoop()
        const sub = join(root, e.name)
        for (const f of readdirSync(sub, { withFileTypes: true })) {
          if (f.isDirectory()) continue
          const p = join(sub, f.name)
          try {
            const st = statSync(p)
            if (st.isFile()) map.set(st.size, f.name)
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    return map
  }, 10_000)
}

/**
 * Aggregate storage stats (source collect_stats).
 * @param decryptedDir - decrypted data root.
 * @param wechatBaseDir - raw WeChat install root (msg/file 原文件名还原).
 * @returns the storage snapshot.
 */
export async function queryStorageStats(
  decryptedDir: string,
  wechatBaseDir?: string,
): Promise<{
  total_size: number
  total_count: number
  categories: StorageCategory[]
  chats: StorageRank[]
  senders: StorageRank[]
  large_files: LargeFile[]
}> {
  const path = join(decryptedDir, 'message', 'message_resource.db')
  // 整体签名缓存（F1，2026-09-28 性能修复）：此前只有 `loadFileNamesBySize` 的文件名扫描有缓存，
  // 而下面三段重查询每次都要跑 —— `GROUP BY type` 全表聚合 + 两个
  // `JOIN … GROUP BY … ORDER BY SUM(size) LIMIT 50` 排行 + `ORDER BY size DESC LIMIT 100`
  // 大文件表（后者逐条 `resolveFileTitle` 会开分片库）。实测冷跑 92~106ms 且**冷热同值**
  // ⇒ 无缓存。签名覆盖三处变更来源：resource 库本身、`msg/file` 目录树（文件名还原）、
  // contacts 库（`contactMeta` 的昵称）。
  const sig = [
    fileSigOf(path),
    fileNamesSig(wechatBaseDir ? join(wechatBaseDir, 'msg', 'file') : ''),
  ].join('|')
  return cachedBySigAsync('storage-stats:' + decryptedDir, sig, () => computeStorageStats(decryptedDir, wechatBaseDir))
}

/** `queryStorageStats` 的实际计算体（签名缓存包一层；为了装配/测试可直接单测它）。 */
async function computeStorageStats(
  decryptedDir: string,
  wechatBaseDir?: string,
): Promise<{
  total_size: number
  total_count: number
  categories: StorageCategory[]
  chats: StorageRank[]
  senders: StorageRank[]
  large_files: LargeFile[]
}> {
  const path = join(decryptedDir, 'message', 'message_resource.db')
  if (!existsSync(path)) return { total_size: 0, total_count: 0, categories: [], chats: [], senders: [], large_files: [] }
  storageTraceT0 = Date.now()
  const db = new DatabaseSync(path, { readOnly: true })
  // 分析型查询：全局读缓存只有 256KB（短读连接口径），这条查询会把 JOIN 打穿。
  // 只给本连接临时抬高（实测 chats+senders 233ms → 64ms），查询结束连接即关闭。
  raiseAnalyticsCache(db)
  try {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='MessageResourceDetail'").get() !== undefined
    if (!has) return { total_size: 0, total_count: 0, categories: [], chats: [], senders: [], large_files: [] }
    storageMark('open')

    const agg = db.prepare('SELECT COALESCE(SUM(size), 0) AS s, COUNT(*) AS n FROM MessageResourceDetail').get() as { s: number; n: number }
    storageMark('agg')

    // categories: group by type, sample packed_info per type for the label
    const typeRows = db.prepare('SELECT type, COUNT(*) AS c, SUM(size) AS s FROM MessageResourceDetail GROUP BY type').all() as Array<{ type: number; c: number; s: number }>
    const catMap = new Map<string, { count: number; size: number }>()
    for (const r of typeRows) {
      const sample = db.prepare('SELECT packed_info FROM MessageResourceDetail WHERE type = ? LIMIT 1').get(r.type) as { packed_info?: Uint8Array | null } | undefined
      const label = classifyPacked(r.type, sample?.packed_info)
      const cur = catMap.get(label) ?? { count: 0, size: 0 }
      cur.count += r.c
      cur.size += r.s
      catMap.set(label, cur)
    }
    const categories: StorageCategory[] = Array.from(catMap.entries()).map(([label, v]) => ({ label, count: v.count, size: v.size }))
    storageMark('types', typeRows.length)

    const names = contactMeta(decryptedDir).names
    storageMark('contacts', names.size)

    // chat ranking: join detail -> info -> ChatName2Id (chat_id is a rowid)
    const chatRows = db.prepare(`
      SELECT COALESCE(c.user_name, '(未知会话)') AS u, COUNT(*) AS n, SUM(d.size) AS s
      FROM MessageResourceDetail d
      JOIN MessageResourceInfo i ON d.message_id = i.message_id
      LEFT JOIN ChatName2Id c ON c.rowid = i.chat_id
      GROUP BY i.chat_id ORDER BY SUM(d.size) DESC LIMIT 50`).all() as Array<{ u: string; n: number; s: number }>
    const chats: StorageRank[] = chatRows.map(r => ({ username: r.u, name: names.get(r.u) ?? '', count: r.n, size: r.s }))
    storageMark('chats', chatRows.length)

    // sender ranking
    const senderRows = db.prepare(`
      SELECT COALESCE(s.user_name, '(未知发送者)') AS u, COUNT(*) AS n, SUM(d.size) AS s
      FROM MessageResourceDetail d
      JOIN MessageResourceInfo i ON d.message_id = i.message_id
      LEFT JOIN SenderName2Id s ON s.rowid = i.sender_id
      GROUP BY i.sender_id ORDER BY SUM(d.size) DESC LIMIT 50`).all() as Array<{ u: string; n: number; s: number }>
    const senders: StorageRank[] = senderRows.map(r => ({ username: r.u, name: names.get(r.u) ?? '', count: r.n, size: r.s }))
    storageMark('senders', senderRows.length)

    // large files (top 100, real names + owning session)
    const bigRows = db.prepare(`
      SELECT d.size AS s, d.type AS ty, d.data_index AS di, d.packed_info AS p, d.create_time AS ct, COALESCE(c.user_name, '') AS u,
             CAST(i.message_svr_id AS TEXT) AS svr
      FROM MessageResourceDetail d
      JOIN MessageResourceInfo i ON d.message_id = i.message_id
      LEFT JOIN ChatName2Id c ON c.rowid = i.chat_id
      ORDER BY d.size DESC LIMIT 100`).all() as Array<{ s: number; ty: number; di: string; p?: Uint8Array | null; ct: number; u: string; svr: string }>
    storageMark('big-rows', bigRows.length)
    const sizeToName = await loadFileNamesBySize(wechatBaseDir)
    storageMark('file-names', sizeToName.size)
    const large_files: LargeFile[] = []
    for (const r of bigRows) {
      // P1-2：每条大文件都可能触发 `resolveFileTitle`，而它会**逐个消息分片**开库去找那条消息
      // （最多 100 条 × 全部分片）—— 这一段是本页最贵的，逐条让出。
      await yieldToLoop()
      const packedName = parsePackedName(r.p ?? null)
      const cat = classifyType(r.ty, packedName)
      let name = packedName || sizeToName.get(r.s) || resolveFileTitle(decryptedDir, r.u, r.svr) || ''
      if (!name) {
        if (cat === '图片' || cat === '视频' || cat === '音频' || cat === '表情') name = '[' + cat + ']'
        else if (r.di && r.di !== '0') name = r.di + '.dat'
        else name = '(未知文件名)'
      }
      large_files.push({ name, username: r.u, sessionName: names.get(r.u) ?? '', create_time: r.ct, size: r.s })
    }
    storageMark('large-files', large_files.length)

    return { total_size: agg.s, total_count: agg.n, categories, chats, senders, large_files }
  } finally {
    db.close()
  }
}
