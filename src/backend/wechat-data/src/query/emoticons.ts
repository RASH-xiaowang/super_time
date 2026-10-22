/**
 * Emoticon queries over emoticon.db, mirroring the Rust modules/emoticons.rs:
 * custom emoticons from kNonStoreEmoticonTable and store packages from
 * kStoreEmoticonPackageTable (+ per-package file counts). Static bundled
 * emoticons have no DSH counterpart (source ships them in public/wechat/).
 *
 * 展示顺序（第 36 轮修正）
 * ----------------------
 * `kNonStoreEmoticonTable` 的**内置行序不是**用户在微信里看到的顺序。
 * 真正的顺序在 `kFavEmoticonOrderTable`（只有 `md5` 一列，行序即排列顺序）。
 * 实测本机：两张表恰好是同一组 30 个 md5（交集 30/30、无重复），但逐位比较
 * **只有 1/30 相同** —— 也就是说修复前面板展示的顺序基本是错的。
 * （同库的 `kCustomEmoticonOrderTable` 与 `kExpressRecentUseEemoticonTable` 均为 0 行，
 *   故 `kFavEmoticonOrderTable` 是唯一的排序来源。）
 * 排序在 SQL 侧完成，所以 LIMIT/OFFSET 分页仍然正确；不在顺序表里的表情排在最后，
 * 并保持内置行序，保证结果**确定**（原来的查询没有 ORDER BY，顺序其实是不确定的）。
 */
import { DatabaseSync } from './db-open.ts'
import { cachedBySig, fileSigOf } from './meta.ts'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decompress } from 'fzstd'
import { emoticonIndexFor, findEmoticonDats } from './emoticon-index.ts'
import type { EmoticonsSnapshot, EmoticonItem } from '../types.ts'

/** zstd 帧头魔数（消息分片里的 `message_content` 可能是压缩的）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

/**
 * 把消息分片里的 `message_content` 单元格解成文本。
 *
 * 与 `asset-insights.ts` 的同名逻辑一致：微信把部分消息体用 zstd 压缩后存成 BLOB，
 * 不解压就抽不到 `<emoji md5="…">`。
 * @param v - 数据库单元格。
 * @returns UTF-8 文本；无法解码时返回空串。
 */
function decodeCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  const raw = Buffer.from(v instanceof Uint8Array ? v : [])
  const decompressed = raw.length >= 4 && raw.subarray(0, 4).equals(ZSTD_MAGIC)
    ? (() => { try { return Buffer.from(decompress(raw)) } catch { return raw } })()
    : raw
  try { return new TextDecoder('utf-8', { fatal: false }).decode(decompressed) } catch { return '' }
}

/** 从消息 XML 里抽表情 md5（`<emoji md5="…">` / `<msg><emoji …>`）。 */
const EMOJI_MD5_RE = /md5\s*=\s*["']([A-Fa-f0-9]{16,})["']/

/**
 * 从消息 XML 里抽表情的 CDN 地址（`<emoji cdnurl="…">`，回退 `thumburl`）。
 *
 * 为什么需要（2026-10-18 用户：「其他表情包查到一个就永久保存一个」）：
 * 消息里 99.3% 的表情都带 `cdnurl`（见 `parse.ts` 的 type-47 普查），
 * 而本地 `.dat` 缓存会被微信定期清掉。有了 `cdnurl` 就能远端取图并落进
 * `decodedDir`（`fetchEmoticonRemote` 已经 `writeFileSync`），**取到一次就永久保存**。
 */
const EMOJI_CDN_RE = /(?:cdnurl|thumburl)\s*=\s*["']([^"']+)["']/

/** 把 XML 实体还原（`&amp;` → `&`），CDN 地址里常见。 */
function unescapeXml(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&#x26;/gi, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

/**
 * 扫消息库，收集**不在 `exclude` 里**的表情 md5、出现次数与 CDN 地址。
 *
 * 口径：遍历 `message/message_*.db` 的每张 `Msg_*` 表，取
 * `(local_type & 0xFFFFFFFF) = 47`（表情）的行，从 `message_content` 抽 md5 + cdnurl。
 * 这些是**群聊或他人发送**的表情 —— 用户自己收藏过的（`kNonStoreEmoticonTable`）
 * 已经在 `exclude` 里，不重复计入。
 *
 * ## 为什么不再过滤「本地没有文件」的表情（2026-10-18 改）
 *
 * 上一版只留本地还有 `.dat` 的，结果本机 1,822 个记录里只剩 0 个 ——
 * 微信把表情缓存清得很干净，`.dat` 几乎全没了（真机验证）。
 * 但消息 XML 里 99.3% 带 `cdnurl`，**有它就能远端取图**。
 * 所以现在：本地有文件 → 直接解码；没有 → 用 `cdnurl` 下载并落盘（永久保存）。
 * 两者都没有的才丢弃（那种确实无图可看）。
 *
 * 为什么要 `& 0xFFFFFFFF`：微信把 `local_type` 的高 32 位当子类型用，
 * 直接 `= 47` 会漏掉带子类型的表情消息（见 `asset-insights.ts` 同一处注释）。
 * @param decryptedDir - 解密后的数据根目录（消息库在这里）。
 * @param wechatBaseDir - 原始微信目录（`msg/attach` 在这里）；缺省时只能靠 `cdnurl`。
 * @param exclude - 要排除的 md5 集合（用户自己的表情）。
 * @returns 按出现次数降序的表情列表（带 `cdnUrl` 的可以远端取图）。
 */
function collectOtherEmoticons(
  decryptedDir: string,
  wechatBaseDir: string | undefined,
  exclude: ReadonlySet<string>,
): EmoticonItem[] {
  /*
   * ⚠️ 两个目录**不是同一个**（2026-10-17 实测）：
   *   · 消息库 `message/message_*.db` 在**解密目录**（`decryptedDir`）下；
   *   · 表情文件 `msg/attach/<hash>/<月>/Img/<md5>.dat` 在**原始微信目录**（`wechatBaseDir`）下。
   */
  const dir = join(decryptedDir, 'message')
  if (!existsSync(dir)) return []
  const attachRoot = wechatBaseDir === undefined ? null : join(wechatBaseDir, 'msg', 'attach')
  const index = attachRoot !== null && existsSync(attachRoot) ? emoticonIndexFor(attachRoot) : null
  /** md5 → { 次数, CDN 地址 }。同一个表情多次出现时保留第一个非空 cdnurl。 */
  const found = new Map<string, { count: number; cdnUrl: string }>()
  for (const f of readdirSync(dir)) {
    if (!/^(biz_)?message_\d+\.db$/.test(f)) continue
    let db: DatabaseSync
    try { db = new DatabaseSync(join(dir, f), { readOnly: true }) } catch { continue }
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").all() as Array<{ name: string }>).map(r => r.name)
      for (const table of tables) {
        const cols = tableColumns(db, table)
        if (!cols.has('local_type') || !cols.has('message_content')) continue
        try {
          const sql = `SELECT message_content FROM "${table}" WHERE (local_type & 4294967295) = 47`
          for (const r of db.prepare(sql).iterate() as Iterable<Record<string, unknown>>) {
            const xml = decodeCell(r['message_content'])
            const m = EMOJI_MD5_RE.exec(xml)
            const md5 = m ? (m[1] ?? '').toLowerCase() : ''
            if (!md5 || exclude.has(md5)) continue
            const cur = found.get(md5)
            const cdn = EMOJI_CDN_RE.exec(xml)
            const cdnUrl = cdn ? unescapeXml(cdn[1] ?? '') : ''
            if (cur) {
              cur.count += 1
              if (cur.cdnUrl === '' && cdnUrl !== '') cur.cdnUrl = cdnUrl
            } else {
              found.set(md5, { count: 1, cdnUrl })
            }
          }
        } catch { /* 单表失败不影响其它表 */ }
      }
    } finally { db.close() }
  }
  /*
   * 只留「本地有文件」或「有 cdnurl」的：
   *   · 本地有 → `decodeEmoticonDataUrl` 直接解码，快；
   *   · 只有 cdnurl → 前端批量取图时走远端下载并落盘（永久保存）。
   * 两者都没有的确实无图可看，丢弃。
   */
  return [...found.entries()]
    .filter(([md5, v]) => v.cdnUrl !== '' || (index !== null && findEmoticonDats(index, md5).length > 0))
    .sort((a, b) => b[1].count - a[1].count)
    .map(([md5, v]) => {
      const item: EmoticonItem = { md5, item_type: 0, caption: `${String(v.count)} 次` }
      if (v.cdnUrl !== '') item.cdnUrl = v.cdnUrl
      return item
    })
}

/** Coerce a DB cell to a string (null -> '', else String()). */
function cellStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return new Set(rows.map(r => r.name))
  } catch { return new Set() }
}

/** Pick the first present column among candidates; null when none exist. */
function col(cols: Set<string>, cands: string[]): string | null {
  for (const c of cands) if (cols.has(c)) return c
  return null
}

/**
 * Read custom emoticons + store packages.
 * @param decryptedDir - decrypted data root.
 * @param limit - max custom rows.
 * @param offset - pagination offset.
 * @param wechatBaseDir - 原始微信目录（找 `msg/attach` 下的表情 `.dat` 用）。
 *   不传时「其他表情包」为空 —— 没有它就无法判断哪些表情本地还有图。
 * @returns the emoticons snapshot.
 */
export function queryEmoticons(
  decryptedDir: string,
  limit?: number,
  offset: number = 0,
  wechatBaseDir?: string,
): EmoticonsSnapshot {
  // Cache keyed on emoticon.db's signature; recomputed when the realtime sync
  // rewrites it, otherwise served from the 5s bounded cache.
  return cachedBySig(
    'emoticons:' + decryptedDir + ':' + String(limit ?? '') + ':' + String(offset) + ':' + (wechatBaseDir ?? ''),
    fileSigOf(join(decryptedDir, 'emoticon', 'emoticon.db')),
    () => computeEmoticons(decryptedDir, limit, offset, wechatBaseDir),
  )
}

function computeEmoticons(
  decryptedDir: string,
  limit?: number,
  offset: number = 0,
  wechatBaseDir?: string,
): EmoticonsSnapshot {
  const path = join(decryptedDir, 'emoticon', 'emoticon.db')
  if (!existsSync(path)) return { custom: [], static: [], packages: [], total: 0, orderedBy: 'builtin' }
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const custom: EmoticonItem[] = []
    let customOrderedBy: 'wechat' | 'builtin' = 'builtin'
    const cCols = tableColumns(db, 'kNonStoreEmoticonTable')
    if (cCols.size > 0) {
      const md5Col = col(cCols, ['md5', 'MD5', 'md5_'])
      const typeCol = col(cCols, ['type', 'Type', 'type_'])
      const captionCol = col(cCols, ['caption', 'Caption', 'caption_'])
      // CDN 地址：面板要显示真图，而本地表情缓存是**加密**文件（见 media-image.ts 的
      // fetchEmoticonRemote 注释），只能靠这几个 URL 取图。实测 30 行里 cdn_url 全覆盖。
      const cdnCol = col(cCols, ['cdn_url', 'cdnurl', 'cdn_Url'])
      const thumbCol = col(cCols, ['thumb_url', 'thumburl', 'tp_url'])
      if (md5Col) {
        const cap = Math.min(limit ?? 500, 2000)
        const sel = [
          `t.${md5Col} AS md5`,
          typeCol ? `t.${typeCol} AS item_type` : `0 AS item_type`,
          captionCol ? `t.${captionCol} AS caption` : `'' AS caption`,
          cdnCol ? `t.${cdnCol} AS cdn_url` : `'' AS cdn_url`,
          thumbCol ? `t.${thumbCol} AS thumb_url` : `'' AS thumb_url`,
        ].join(', ')
        const plain = `SELECT ${sel} FROM kNonStoreEmoticonTable t ORDER BY t.rowid LIMIT ? OFFSET ?`
        // 顺序表可用时按它排序；任何异常都退回确定性最弱的「内置行序」，不让面板整体失败。
        const hasOrder = tableColumns(db, 'kFavEmoticonOrderTable').has('md5')
        let rows: Array<{ md5?: unknown; item_type?: unknown; caption?: unknown; cdn_url?: unknown; thumb_url?: unknown }>
        let orderedBy: 'wechat' | 'builtin' = 'builtin'
        if (hasOrder) {
          const ordered = `SELECT ${sel} FROM kNonStoreEmoticonTable t
            LEFT JOIN (SELECT md5 AS omd5, MIN(rowid) AS ord FROM kFavEmoticonOrderTable GROUP BY md5) o
              ON o.omd5 = t.${md5Col}
            ORDER BY (o.ord IS NULL), o.ord, t.rowid LIMIT ? OFFSET ?`
          try { rows = db.prepare(ordered).all(cap, offset) as typeof rows; orderedBy = 'wechat' }
          catch { rows = db.prepare(plain).all(cap, offset) as typeof rows }
        } else {
          rows = db.prepare(plain).all(cap, offset) as typeof rows
        }
        customOrderedBy = orderedBy
        for (const r of rows) {
          const md5 = cellStr(r.md5 ?? '').trim()
          if (!md5) continue
          const item: EmoticonItem = { md5, item_type: Number(r.item_type ?? 0) }
          const caption = cellStr(r.caption ?? '').trim()
          if (caption) item.caption = caption
          // 取图用的 CDN 地址（cdn_url 优先，回退 thumb_url/tp_url）；值里可能带 XML 实体
          const cdnUrl = (cellStr(r.cdn_url ?? '').trim() || cellStr(r.thumb_url ?? '').trim())
            .replace(/&amp;/g, '&').replace(/&#x26;/gi, '&')
          if (cdnUrl) item.cdnUrl = cdnUrl
          custom.push(item)
        }
      }
    }

    const packages: EmoticonsSnapshot['packages'] = []
    const pCols = tableColumns(db, 'kStoreEmoticonPackageTable')
    if (pCols.size > 0) {
      const idCol = col(pCols, ['package_id_', 'package_id', 'product_id_', 'product_id', 'id_'])
      const nameCol = col(pCols, ['package_name_', 'name_', 'title_', 'name', 'title'])
      if (idCol && nameCol) {
        // 表情包本身带 sort_order_（真实列），按它排；无该列时退回确定性的 rowid 序。
        const sortCol = col(pCols, ['sort_order_', 'sort_order', 'order_', 'sort'])
        const orderBy = sortCol ? ` ORDER BY ${sortCol}, rowid` : ' ORDER BY rowid'
        const rows = db.prepare(`SELECT ${idCol} AS pid, ${nameCol} AS name FROM kStoreEmoticonPackageTable${orderBy} LIMIT 500`).all() as Array<{ pid?: unknown; name?: unknown }>
        for (const r of rows) {
          const pid = cellStr(r.pid ?? '').trim()
          const name = cellStr(r.name ?? '').trim() || pid || '未命名表情包'
          let count = 0
          if (pid) {
            try {
              const fcols = tableColumns(db, 'kStoreEmoticonFilesTable')
              if (fcols.size > 0) {
                const fpid = col(fcols, ['package_id_', 'package_id', 'product_id_', 'product_id'])
                if (fpid) {
                  count = (db.prepare(`SELECT COUNT(*) AS n FROM kStoreEmoticonFilesTable WHERE ${fpid} = ?`).get(pid) as { n: number }).n
                }
              }
            } catch { count = 0 }
          }
          packages.push({ name, count })
        }
      }
    }

    let total = custom.length
    if (cCols.size > 0) {
      try {
        total = (db.prepare('SELECT COUNT(*) AS n FROM kNonStoreEmoticonTable').get() as { n: number }).n
      } catch { /* keep batch count */ }
    }

    /*
     * 其他表情包（2026-10-17）：从消息库扫出「群聊/他人发送、但自己没收藏」的表情。
     *
     * 只在**第一页**（`offset === 0`）算：这个扫描要遍历全部消息分片（本机 146MB + 46MB + …），
     * 每翻一页都重扫一遍没有意义，而且 `others` 是「全部其他表情」的完整列表，
     * 不随 `custom` 的分页变化。
     */
    let others: EmoticonItem[] | undefined
    let othersTotal: number | undefined
    if (offset === 0) {
      const own = new Set(custom.map(c => c.md5.toLowerCase()))
      /*
       * 返回扫描到的**全部**结果，不再二次截断。
       *
       * 这里原来先按 2000 条收集，再取前 500 条返回；而 `othersTotal` 统计的是截断前
       * 的总数。真实数据里出现「其他 1924 · 下拉只有 500」的自相矛盾，用户会合理地
       * 以为表情丢了。扫描本来就已经遍历完所有消息分片并把去重结果放在内存里，
       * 去掉返回截断不增加扫描成本；前端用渐进列表渲染，也不会一次挂出上千个 DOM。
       */
      const all = collectOtherEmoticons(decryptedDir, wechatBaseDir, own)
      othersTotal = all.length
      others = all
    }

    return { custom, static: [], packages, total, orderedBy: customOrderedBy, others, othersTotal }
  } finally {
    db.close()
  }
}
