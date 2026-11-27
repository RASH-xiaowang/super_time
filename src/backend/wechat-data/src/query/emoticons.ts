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
import { cachedBySigAsync, fileSigOf } from './meta.ts'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decompress } from 'fzstd'
import { emoticonIndexFor, findEmoticonDats } from './emoticon-index.ts'
import { YIELD_EVERY_ROWS, yieldToLoop } from './search-build.ts'
import { listMessageShardSigs, readArchivedOthers, rememberMessageShards, staleMessageShards, upsertArchivedOthers, withSavedEmoticonFiles } from './emoticon-archive.ts'
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
 * @param onlyShards - 只扫这些消息分片文件名；不传则扫全部。
 * @returns 按出现次数降序的表情列表（带 `cdnUrl` 的可以远端取图）。
 */
async function collectOtherEmoticons(
  decryptedDir: string,
  wechatBaseDir: string | undefined,
  exclude: ReadonlySet<string>,
  onlyShards?: ReadonlySet<string>,
): Promise<EmoticonItem[]> {
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
    if (onlyShards !== undefined && !onlyShards.has(f)) continue
    let db: DatabaseSync
    try { db = new DatabaseSync(join(dir, f), { readOnly: true }) } catch { continue }
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").all() as Array<{ name: string }>).map(r => r.name)
      for (const table of tables) {
        const cols = tableColumns(db, table)
        if (!cols.has('local_type') || !cols.has('message_content')) continue
        try {
          const sql = `SELECT message_content FROM "${table}" WHERE (local_type & 4294967295) = 47`
          let sinceYield = 0
          for (const r of db.prepare(sql).iterate() as Iterable<Record<string, unknown>>) {
            sinceYield += 1
            if (sinceYield >= YIELD_EVERY_ROWS) {
              sinceYield = 0
              await yieldToLoop()
            }
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
    await yieldToLoop()
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

/** 表情包文件数一次聚合，避免每个包再跑一条 COUNT。 */
function packageFileCounts(db: DatabaseSync): Map<string, number> {
  const out = new Map<string, number>()
  const fcols = tableColumns(db, 'kStoreEmoticonFilesTable')
  const fpid = col(fcols, ['package_id_', 'package_id', 'product_id_', 'product_id'])
  if (!fpid) return out
  try {
    const rows = db.prepare(`SELECT ${fpid} AS pid, COUNT(*) AS n FROM kStoreEmoticonFilesTable GROUP BY ${fpid}`).all() as Array<{ pid?: unknown; n?: unknown }>
    for (const r of rows) {
      const pid = cellStr(r.pid ?? '').trim()
      if (pid) out.set(pid, Number(r.n ?? 0))
    }
  } catch { /* 文件表读失败时包内数量记 0 */ }
  return out
}

/** 自己收藏的全部表情 md5。排除集不能只用当前页，否则翻页或只要「其他」时会把个人表情算进去。 */
function ownEmoticonMd5s(db: DatabaseSync, cols: Set<string>): Set<string> {
  const own = new Set<string>()
  const md5Col = col(cols, ['md5', 'MD5', 'md5_'])
  if (!md5Col) return own
  try {
    const rows = db.prepare(`SELECT ${md5Col} AS md5 FROM kNonStoreEmoticonTable`).all() as Array<{ md5?: unknown }>
    for (const r of rows) {
      const md5 = cellStr(r.md5 ?? '').trim().toLowerCase()
      if (md5) own.add(md5)
    }
  } catch { /* 排除集拿不到时调用方仍可用当前页 */ }
  return own
}

/**
 * Read custom emoticons + store packages.
 * @param decryptedDir - decrypted data root.
 * @param limit - max custom rows.
 * @param offset - pagination offset.
 * @param wechatBaseDir - 原始微信目录（找 `msg/attach` 下的表情 `.dat` 用）。
 *   不传时「其他表情包」为空 —— 没有它就无法判断哪些表情本地还有图。
 * @param includeOthers - 传 `false` 时不扫消息库。个人表情页用这个先出列表；
 *   不传时仍在第一页附带「其他表情」，和原来的调用兼容。
 * @param decodedDir - `decoded_images` 目录。给了它才把其他表情清单和图片落到硬盘。
 * @returns the emoticons snapshot.
 */
export function queryEmoticons(
  decryptedDir: string,
  limit?: number,
  offset: number = 0,
  wechatBaseDir?: string,
  includeOthers?: boolean,
  decodedDir?: string,
): Promise<EmoticonsSnapshot> {
  // Cache keyed on emoticon.db's signature; recomputed when the realtime sync
  // rewrites it, otherwise served from the 5s bounded cache.
  const othersKey = includeOthers === false ? 'no-others' : 'others'
  return cachedBySigAsync(
    'emoticons:' + decryptedDir + ':' + String(limit ?? '') + ':' + String(offset) + ':' + (wechatBaseDir ?? '') + ':' + othersKey + ':' + (decodedDir ?? ''),
    fileSigOf(join(decryptedDir, 'emoticon', 'emoticon.db')),
    () => computeEmoticons(decryptedDir, limit, offset, wechatBaseDir, includeOthers, decodedDir),
  )
}

async function computeEmoticons(
  decryptedDir: string,
  limit?: number,
  offset: number = 0,
  wechatBaseDir?: string,
  includeOthers?: boolean,
  decodedDir?: string,
): Promise<EmoticonsSnapshot> {
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
        const counts = packageFileCounts(db)
        for (const r of rows) {
          const pid = cellStr(r.pid ?? '').trim()
          const name = cellStr(r.name ?? '').trim() || pid || '未命名表情包'
          packages.push({ name, count: pid ? (counts.get(pid) ?? 0) : 0 })
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
     * 只在**第一页**且调用方没有明确拒绝时算。个人表情页传 `includeOthers: false`，
     * 打开面板不再为了还没点开的「其他」去扫全部分片。
     */
    let others: EmoticonItem[] | undefined
    let othersTotal: number | undefined
    if (offset === 0 && includeOthers !== false) {
      const own = ownEmoticonMd5s(db, cCols)
      if (own.size === 0) {
        for (const item of custom) own.add(item.md5.toLowerCase())
      }
      const archived = decodedDir
        ? readArchivedOthers(decodedDir).filter((item) => !own.has(item.md5.toLowerCase()))
        : []
      if (archived.length > 0 && decodedDir) {
        others = archived
        othersTotal = archived.length
        scheduleOthersRefresh({ decodedDir, decryptedDir, wechatBaseDir, exclude: own })
      } else {
        /*
         * 第一次没有档案：扫完写进硬盘。之后打开直接读档案，只对签名变了的分片补新表情。
         */
        const all = await collectOtherEmoticons(decryptedDir, wechatBaseDir, own)
        othersTotal = all.length
        others = all
        if (decodedDir) {
          try {
            upsertArchivedOthers(decodedDir, all)
            rememberMessageShards(decodedDir, decryptedDir, listMessageShardSigs(decryptedDir).map((shard) => shard.name))
          } catch { /* 档案写失败时这次仍返回刚扫到的列表 */ }
        }
      }
    }

    const stampedCustom = decodedDir ? withSavedEmoticonFiles(decodedDir, custom) : custom
    const stampedOthers = decodedDir && others ? withSavedEmoticonFiles(decodedDir, others) : others
    return { custom: stampedCustom, static: [], packages, total, orderedBy: customOrderedBy, others: stampedOthers, othersTotal }
  } finally {
    db.close()
  }
}

let othersRefresh: Promise<void> | null = null

/** 档案已经能画列表。变过的消息分片在后台补进新 md5，缺图的继续落盘。 */
function scheduleOthersRefresh(args: {
  decodedDir: string
  decryptedDir: string
  wechatBaseDir?: string
  exclude: ReadonlySet<string>
}): void {
  const stale = staleMessageShards(args.decodedDir, args.decryptedDir)
  if (stale.length === 0 || othersRefresh !== null) return
  const shards = new Set(stale)
  othersRefresh = (async () => {
    try {
      const found = await collectOtherEmoticons(args.decryptedDir, args.wechatBaseDir, args.exclude, shards)
      upsertArchivedOthers(args.decodedDir, found)
      rememberMessageShards(args.decodedDir, args.decryptedDir, stale)
    } catch { /* 分片补扫失败留到下次打开 */ }
  })().finally(() => { othersRefresh = null })
}
