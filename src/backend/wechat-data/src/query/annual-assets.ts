/**
 * 年度报告 · 收藏 / 文件总量盘点。
 *
 * ## ⚠️ 口径：**总量盘点，不是按年**
 *
 * 收藏表与文件表**都没有一条可靠的「按年」时间列**，所以本模块只能给「至今总量」：
 *
 * | 数据 | 表 | 为什么不能按年 |
 * | --- | --- | --- |
 * | 收藏条数 | `favorite/favorite.db` 的 `fav_db_item` | 该表的 `update_time` 是「**这条收藏最后一次被改动**」的时间，不是「收进收藏夹」的时间：改一次标题/备注，时间就跳到当年。按它分年会把 2019 年收的东西算进 2026 年（`asset-insights.ts` 确实按它出过 `byYear`，那是**变动年份**的口径，不能当"某年收藏了几条"用）。 |
 * | 文件条数 / 总大小 | 消息分片 `Msg_*` 里 `local_type = 49` 的文件类 appmsg | 消息本体**有** `create_time`，但「文件资产」的落盘清单在 `hardlink/hardlink.db` 的 `file_hardlink_info_v4` 里，那张表只有 `modify_time`（**文件落盘时间**，不是收到/发出的时间），而实际数量对不上：本机 hardlink 的 file 表 579 行，聊天里的文件消息是另一个量级 —— 两者是"下载过的"与"聊过的"两个集合，口径不同不能互相补年。 |
 *
 * 所以界面文案必须是「总量盘点」（调用方已确认这么写）；本模块的字段名刻意保留
 * `favorites` / `files` / `bytes` 这几个**不带 year 前缀**的名字，避免将来有人顺手
 * 给它们加一个 `year` 参数就把口径悄悄改了。
 *
 * ## 文件大小取不到就不计入 `bytes`
 *
 * 大小取自已有的 `parseFileAttach`（消息 XML 的 `<appattach><totallen>`，拿不到时退回
 * `<filesize>` 属性）。**读不到大小的那条消息不计入 `bytes`，也不当成 0**：
 * 用 0 冒充的后果是「文件 300 个，共 12 MB」这种明显偏小的数字被当成真值展示。
 * 因此 `bytes` 与 `files` 的差值是"有大小信息的那些"与"全部文件消息"的差，
 * 界面若要显示均值必须自己扣掉这个缺口（本模块不提供均值）。
 *
 * 同理，`bytes` **只统计文件类消息**，不把图片/视频的 hardlink 体积并进来：
 * 那两张表的行是「本机缓存过的图片/视频」，与"收发的文件"不是一个集合，混在一起
 * 会让卡片上的数字既不是文件也不是媒体库，读者无法解释。
 *
 * ## 出错一律降级，不抛给调用方
 *
 * 库不存在 / 表不存在 / 库损坏 / 列名对不上 —— 全部收成 `available: false`，计数保持 0。
 * 年度看板是一屏卡片，盘点读不出来不该带走整份年报。
 *
 * @module query/annual-assets
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { withDb } from './db-open.ts'
import { cachedBySigAsync, fileSigOf, shardCatalogDirs, shardCatalogSig } from './meta.ts'
import { YIELD_EVERY_ROWS, yieldToLoop } from './search-build.ts'
import { stripCdata } from './parse-xml.ts'

/** 收藏 / 文件总量盘点结果。 */
export interface AnnualAssets {
  /** 收藏条数（**总量，不是按年** —— 收藏表没有时间列，界面上必须写清）。 */
  favorites: number
  /** 收发的文件类消息条数（总量）。 */
  files: number
  /** 文件总大小（字节，总量）。 */
  bytes: number
  /** 我发出的文件条数（总量）。 */
  sentFiles: number
  /** 数据来源是否可用。 */
  available: boolean
}

/** 文件类 appmsg 的子类型：`6` = 文件，`74` = 新版文件（`parseAppmsg` 里两者同处理）。 */
const FILE_APP_TYPES: ReadonlySet<number> = new Set([6, 74])

/** 单元格 → 字符串（与 `annual-review.ts#decodeCell` 的文本路径同形，这里只处理文本场景）。 */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (v instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: false }).decode(v)
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

/** `<appattach>` 里的子标签文本（**不**剥 CDATA 就取不到文件名/大小时会误判成"没有"）。 */
function tagText(xml: string, tag: string): string {
  const open = '<' + tag + '>'
  const start = xml.indexOf(open)
  if (start < 0) return ''
  const end = xml.indexOf('</' + tag + '>', start + open.length)
  if (end < 0) return ''
  return stripCdata(xml.slice(start + open.length, end)).trim()
}

/** `<appmsg>` 直系子节点的 `<type>`（**不能**直接找第一个 `<type>`：`<refermsg>` 里也有）。 */
function appmsgType(xml: string): number {
  const m = /<appmsg\b[^>]*>([\s\S]*?)<\/appmsg>/i.exec(xml)
  const inner = (m ? (m[1] ?? '') : xml)
    .replace(/<refermsg\b[^>]*>[\s\S]*?<\/refermsg>/gi, '')
    .replace(/<recorditem\b[^>]*>[\s\S]*?<\/recorditem>/gi, '')
  return Number(tagText(inner, 'type')) || 0
}

/**
 * 从文件消息 XML 里取字节数。
 *
 * 判据顺序与 `parse-rich.ts#parseFileAttach` 一致：`<appattach><totallen>` 优先，
 * 拿不到再退回 `<filesize>` **子标签**（两种形态在不同微信版本/不同消息里都出现过）。
 *
 * ⚠️ 这里**刻意不认**把 `filesize` 当**属性**写的形态（`<appattach filesize="…">`）：
 * `parseFileAttach` 里的 `xmlTagOrAttr` 虽然号称两种都认，但它只会去找**同名标签**的开始位置，
 * 属性形态在它那里同样取不到值。本模块跟既有口径保持一致 —— 多认一种**没人证实存在过**的形态，
 * 只会让这段逻辑的判据与实际数据脱节。
 * @param xml - 整条消息 XML。
 * @returns 字节数；**取不到（缺字段、非数字、<= 0）时返回 null** —— 调用方据此不计入总量。
 */
function fileBytes(xml: string): number | null {
  const raw = tagText(xml, 'totallen') || tagText(xml, 'filesize')
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * 收藏条数（**总量**，见文件头「口径」表）。
 * @param decryptedDir - 解密库根目录。
 * @returns 收藏条数；库/表不可用时为 null（调用方据此把 available 判成 false）。
 */
function favoriteCount(decryptedDir: string): number | null {
  const p = join(decryptedDir, 'favorite', 'favorite.db')
  if (!existsSync(p)) return null
  try {
    return withDb(p, (db) => {
      // 表名固定为 `fav_db_item`（`favorites.ts` / `asset-insights.ts` 两处都是这个名字）；
      // 缺表就是"这份数据源没解出来"，返回 null 而不是 0。
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fav_db_item'").get() !== undefined
      if (!has) return null
      const row = db.prepare('SELECT COUNT(*) AS n FROM fav_db_item').get() as { n: number } | undefined
      return row?.n ?? 0
    })
  } catch {
    return null
  }
}

/** 一次文件扫描的结果。`available: false` = 没有任何可读的消息分片。 */
interface FileScan {
  files: number
  bytes: number
  sentFiles: number
  available: boolean
}

/**
 * 扫描全部分片里的文件类消息（**总量**，不按年）。
 *
 * 归属判据与 `annual-review.ts` 的「我发出的」同一套：每个分片有自己的 `Name2Id` 空间，
 * 先用 `selfUsername` 在该分片的 `name2id` 里找到「我」的 rowid，再比 `real_sender_id`；
 * 分片里查不到显式 wxid 时按既有约定退回**空 user_name 那一行**（它就是登录账号自己）。
 *
 * 两种情况下一律不判归属、`sentFiles` 保持 0（对当次统计而言只会**少报**，不会凭空变大）：
 *   · 表里没有 `real_sender_id` 列（老版本分片）；
 *   · 调用方没传 `selfUsername`。
 * @param decryptedDir - 解密库根目录。
 * @param selfUsername - 登录账号 wxid（空串 = 不区分收发）。
 * @returns 文件条数 / 有大小信息的总字节 / 我发出的条数。
 */
async function scanFiles(decryptedDir: string, selfUsername: string): Promise<FileScan> {
  const out: FileScan = { files: 0, bytes: 0, sentFiles: 0, available: false }
  // 与年报主体同源的分片目录：message + bizchat（公众号会话里的文件也算"收发的文件"）。
  const shards = shardCatalogDirs(decryptedDir, ['message', 'bizchat'])
  for (const sh of shards) {
    let db: DatabaseSync | null = null
    try { db = new DatabaseSync(sh.file, { readOnly: true }) } catch { continue }
    try {
      if (sh.tables.size > 0) out.available = true
      for (const [table, meta] of sh.tables) {
        // ⚠️ 判据**必须**先看这张表有没有 `real_sender_id`，再去找「我」的 rowid。
        // 反过来的话，老版本分片（没有该列）里的文件会全部被当成"收到"而 `sentFiles` 恒为 0；
        // 更糟的是 `SELECT … real_sender_id` 会直接抛 `no such column`，被下面的 catch
        // 吞成"这张表没有文件"，于是 `files` 也是 0 —— 一条静默的错路径。
        // 同分片内 `Name2Id` 是共用的一份，从 meta 里取即可（不必每张表再查一次库）。
        let sid: number | undefined
        if (selfUsername && meta.cols.has('real_sender_id')) {
          for (const [id, name] of meta.name2id) if (name === selfUsername) { sid = id; break }
          // Name2Id 里**空 user_name 那行就是登录账号自己**（见 `meta.ts#loadShardMeta`）；
          // 分片里查不到显式 wxid 时按这条约定兜底，否则真机上「我发出的」会全塌成收到。
          if (sid === undefined) for (const [id, name] of meta.name2id) if (name === '') { sid = id; break }
        }
        // 别名与前缀不同名（`sid` 这个名字已被上面的「我的 rowid」占用），避免读错变量。
        const mine = sid === undefined ? '' : ', real_sender_id AS self_sid'
        try {
          // `local_type` 是 **32 位本地类型**（高位是别的信息），与 `annual-review.ts#normType`
          // 同一个取法：`local_type & 4294967295 = 49`。文件类 appmsg 因此能用 WHERE 先筛掉大头。
          const sql = `SELECT message_content${mine} FROM "${table}" WHERE (local_type & 4294967295) = 49`
          let sinceYield = 0
          for (const r of db.prepare(sql).iterate() as Iterable<Record<string, unknown>>) {
            sinceYield += 1
            if (sinceYield >= YIELD_EVERY_ROWS) { sinceYield = 0; await yieldToLoop() }
            const xml = cellText(r['message_content'])
            const t = appmsgType(xml)
            // 只认文件类（6 / 74）。链接、引用、小程序等同样是 local_type=49，不能算进"文件"。
            if (!FILE_APP_TYPES.has(t)) continue
            out.files += 1
            const size = fileBytes(xml)
            // 见文件头：取不到大小就**不计入** bytes，不用 0 冒充。
            if (size !== null) out.bytes += size
            if (sid !== undefined && Number(r['self_sid'] ?? -1) === sid) out.sentFiles += 1
          }
        } catch { /* 单表失败不影响整体（列名对不上、表损坏等） */ }
      }
    } finally {
      try { db.close() } catch { /* 连接已失效 */ }
    }
    // 分片级让出：一张几百 MB 的分片扫完不给别人机会，下一张就不用开了。
    await yieldToLoop()
  }
  return out
}

/**
 * 年度报告 · 收藏 / 文件总量盘点。
 *
 * ⚠️ 返回的是**至今总量**，不是"这一年的"：收藏表与文件表没有可靠的按年时间列
 * （为什么、以及哪一列不能用，见本文件头部「口径」表）。界面必须写「总量盘点」。
 * @param decryptedDir - 解密库根目录。
 * @param selfUsername - 登录账号 wxid（用于统计"我发出的文件"；不传则 `sentFiles` 恒为 0）。
 * @returns 收藏条数 / 文件条数 / 文件总字节 / 我发出的文件条数，以及数据源是否可用。
 */
export async function queryAnnualAssets(decryptedDir: string, selfUsername = ''): Promise<AnnualAssets> {
  const self = (selfUsername ?? '').trim()
  // 签名覆盖三处真正读了的东西：收藏库、文件消息所在的全部分片（message + bizchat）。
  // 与 `asset-insights.ts` 的 `cachedBySigAsync` 同一套失效口径，不另立缓存。
  const sig = [
    fileSigOf(join(decryptedDir, 'favorite', 'favorite.db')),
    shardCatalogSig(decryptedDir, ['message', 'bizchat']),
  ].join('|')
  try {
    return await cachedBySigAsync('annual-assets:' + decryptedDir + ':' + self, sig, async () => {
      const favorites = favoriteCount(decryptedDir)
      const scan = await scanFiles(decryptedDir, self)
      // 两处数据源**任意一处**可读就算 available：只有收藏库（没解出消息）、或只有消息分片
      // （没解出收藏）都是真实存在的情况，不该一律显示"未读取到数据"。
      const available = favorites !== null || scan.available
      return {
        favorites: favorites ?? 0,
        files: scan.files,
        bytes: scan.bytes,
        sentFiles: scan.sentFiles,
        available,
      }
    })
  } catch (e) {
    // 不静默吞错，但也不抛给调用方：年度看板是一屏卡片，盘点读不出来不该带走整份年报。
    console.warn('[annual-assets] 收藏/文件盘点失败，返回不可用:', (e as Error)?.message ?? e)
    return { favorites: 0, files: 0, bytes: 0, sentFiles: 0, available: false }
  }
}
