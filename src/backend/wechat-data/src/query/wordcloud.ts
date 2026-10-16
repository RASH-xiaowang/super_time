
/**
 * 词云词频统计（2026-09-25，界面优化阶段 4）。
 *
 * 口径：CJK bigram 计数（与 annual-report 的 top_phrases 同一套生产先例），外加两道过滤——
 * 逐条正文的**实体遮罩 + 停用词过滤 + bigram 统计**都在 `word-match.ts`
 * （本文件只负责取数与组装：分片遍历、zstd 解码、剥 XML、排序取前 N）。
 * 实体保护：contactMeta 的昵称/备注名单（2-8 字）在 bigram 之前整词计数并从文本中遮罩，
 * 人名/群名不会被切成碎片、也不与 bigram 重复上榜。
 *
 * 三种 scope：global（全部消息，可带年份）/ chat（单会话）/ moments（朋友圈帖子正文）。
 * 本地计算、零出网、不落库（按数据指纹缓存 30 秒；词频统计的热路径在 `word-match.ts`）。
 */
import { DatabaseSync } from './db-open.ts'
import { decompress } from 'fzstd'
import { existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { cachedBySigAsync, fileSigOf, shardCatalogSig } from './meta.ts'
import { buildEntityMatcher, countText, entityNamesOf, pruneFragmentWords, type EntityMatcher } from './word-match.ts'
import { YIELD_EVERY_CHARS, YIELD_EVERY_ROWS, yieldToLoop } from './search-build.ts'

export interface WordCloudOptions {
  scope?: 'global' | 'chat' | 'moments'
  username?: string
  year?: number
  limit?: number
}

export interface WordCloudWord {
  text: string
  count: number
}

export interface WordCloudResult {
  words: WordCloudWord[]
  scanned: number
  /**
   * 这次是**被取消**的（`scanned` 只覆盖扫完的那一部分）—— W2-9.4。
   *
   * 取消不抛错：用户是自己切换了年份/会话，不该看到一句红色报错。
   * 界面据此**不写**这份结果（它是半成品），而调用方拿它去比缓存时也据此拒写。
   */
  canceled?: boolean
}

/** Msg_<md5(username)> table name（与 annual-report 同式）。 */
function msgTableName(username: string): string {
  return 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decodeCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  const raw = Buffer.from(v instanceof Uint8Array ? v : [])
  if (raw.length >= 4 && raw.subarray(0, 4).equals(ZSTD_MAGIC)) {
    try { return Buffer.from(decompress(raw)).toString('utf8') } catch { return '' }
  }
  return raw.toString('utf8')
}

function stripXml(x: string): string {
  return x.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * 分片级计词缓存：分片路径（含表选择）→ 该分片上次的词频与耗时。
 *
 * ## 为什么加它
 *
 * 外层缓存（{@link queryWordCloud} 的 `cachedBySigAsync`）是**整目录**签名：任何一个分片
 * mtime/size 变了，整个 global 词云就重算一遍。而微信在持续往 message_0/1 写 ——
 * 真机实测（`working/probe-wordcloud-scan.ts`）4 个分片 205 MB、12 万行正文，
 * 一次重算里"取行 + 解码"就 260 ms，计词再占大头；其中**没变的那些分片完全是白扫**。
 *
 * 这里按**分片自身签名**缓存它的词频：签名没变就直接把上次的词频并进总数，
 * 解库/取行/计词全省掉。语义不变（同一份数据算出来的还是同一份词频），
 * 只是不再重复做已经做过的部分。
 *
 * 只在**不带年份过滤**时启用：带年份时取的行集合不同，同一个分片会算出不同的词频，
 * 用同一个键会串味。年份过滤那条路本来就只扫一个子集，代价小得多。
 */
const shardScanCache = new Map<string, { sig: string, counts: Map<string, number>, scanned: number }>()

/**
 * 最多缓存多少个分片，超出按插入顺序淘汰最早的。
 *
 * 本机只有 4 个分片；但代码注释里记着别的机器上 "一次 global 要开 300+ 个库" ——
 * 那种规模下无上限缓存会把内存撑起来（每个分片几万词条），所以给个硬上限。
 * 淘汰最旧的而不是拒收新的：新分片才是接下来最可能被命中的。
 */
const SHARD_CACHE_MAX = 64

/** 把一个分片的词频并进总数。 */
function mergeCounts (into: Map<string, number>, from: Map<string, number>): void {
  for (const [k, v] of from) into.set(k, (into.get(k) ?? 0) + v)
}

/** 消息扫描（file-first，一次开一个分片；scope='chat' 时只扫目标表）。 */
async function scanMessages(decryptedDir: string, opts: { username?: string; year?: number }, counts: Map<string, number>, matcher: EntityMatcher, isCancelled: () => boolean = () => false): Promise<{ scanned: number; canceled: boolean }> {
  const msgDir = join(decryptedDir, 'message')
  if (!existsSync(msgDir)) return { scanned: 0, canceled: false }
  const start = opts.year ? Math.floor(new Date(opts.year, 0, 1).getTime() / 1000) : 0
  const end = opts.year ? Math.floor(new Date(opts.year + 1, 0, 1).getTime() / 1000) : Number.MAX_SAFE_INTEGER
  const wanted = opts.username ? msgTableName(opts.username) : null
  const files = readdirSync(msgDir).filter(f =>
    f.endsWith('.db') && !f.includes('_shm') && !f.includes('_wal') && !f.includes('monitor_cache')
    && !f.includes('media') && !f.includes('resource') && !f.includes('fts'))
  let scanned = 0
  let sinceYieldRows = 0
  let sinceYieldChars = 0
  /** 与生产同一套口径：`local_type` 两种写法（是否有 2^32 前缀位）都算纯文本。 */
  const TEXT_TYPE_SQL = 'local_type IN (1, 4294967297)'
  for (const file of files) {
    // W2-9.4：**分片边界**是取消的第一个检查点（另一个是下面的让出边界）。
    // 为什么不是每行都查一次 `isCancelled()`：那是一次闭包调用，摊到每一行上
    // 并不便宜，而一张会话表实测常有十万量级的行。
    if (isCancelled()) return { scanned, canceled: true }
    const path = join(msgDir, file)
    // 分片签名命中 ⇒ 直接复用上次词频。
    //
    // **年份也进键**（2026-09-29）：扫描时 SQL 带着 `create_time >= ? AND < ?` 的时间窗
    // （见下面的 `rows`），所以缓存里那份词频是**该年份口径**的 —— 不同年份必须分开存，
    // 否则会把"这一年的词频"当成"那一年的"。
    // 之前这条缓存只在"全时段"路上开（`opts.year === undefined`），于是**按年筛选**的
    // 请求每次都全量重扫所有分片（真机巡检里 `getWordCloud` 单次最大 1921ms，是最大单点）；
    // 加上年份进键后，同一个年份在"别的分片被写入"之后只需重扫**变动过的分片**。
    const cacheKey = path + '#' + (wanted ?? '*') + (opts.year === undefined ? '' : '#' + String(opts.year))
    const useShardCache = true
    if (useShardCache) {
      const hit = shardScanCache.get(cacheKey)
      if (hit !== undefined && hit.sig === fileSigOf(path)) {
        mergeCounts(counts, hit.counts)
        scanned += hit.scanned
        continue
      }
    }
    /** 这个分片自己的词频；扫完再决定要不要进缓存。 */
    const local = useShardCache ? new Map<string, number>() : counts
    const target = useShardCache ? local : counts
    let localScanned = 0
    let db: DatabaseSync | null = null
    try { db = new DatabaseSync(path, { readOnly: true }) } catch { continue }
    try {
      let names: string[]
      if (wanted) {
        const hit = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(wanted) as { name: string } | undefined
        names = hit ? [hit.name] : []
      } else {
        names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").all() as Array<{ name: string }>).map(r => r.name)
      }
      for (const table of names) {
        try {
          // 过滤**下推到 SQL**（2026-09-29）：原先把全部行取回来再在 JS 里 `local_type !== 1 → continue`。
          // 实测 message_1 只有 64.7% 是纯文本、message_0 68.5%、biz_message_0 仅 **4.7%** ——
          // 那些行被取回、解码、再丢掉纯属白花（该分片因此快了 4.5 倍）。
          const rows = db.prepare('SELECT local_type, message_content FROM "' + table + '" WHERE create_time >= ? AND create_time < ? AND ' + TEXT_TYPE_SQL).all(start, end) as Array<Record<string, unknown>>
          for (const r of rows) {
            const text = stripXml(decodeCell(r['message_content']))
            if (!text || /^[0-9,]+$/.test(text.slice(0, 80))) continue
            scanned += 1
            localScanned += 1
            countText(text, target, matcher)
            sinceYieldRows += 1
            sinceYieldChars += text.length
            // 行级 / 字符级双阈值让出（同 `scanMoments` 的说明）：一张会话表可以有十万条正文，
            // 整表扫完再让出等于把事件循环钉死；而"多少行"不足以衡量代价 —— 长消息更贵。
            if (sinceYieldRows >= YIELD_EVERY_ROWS || sinceYieldChars >= YIELD_EVERY_CHARS) {
              sinceYieldRows = 0
              sinceYieldChars = 0
              await yieldToLoop()
              // W2-9.4：让出点就是第二个检查点 —— 分片**内部**也能停，
              // 不必等整张会话表（十万行）扫完才认得出「这次已经不要了」。
              if (isCancelled()) return { scanned, canceled: true }
            }
          }
        } catch { /* skip table */ }
      }
    } finally { db.close() }
    if (useShardCache) {
      mergeCounts(counts, local)
      if (shardScanCache.size >= SHARD_CACHE_MAX) {
        const oldest = shardScanCache.keys().next().value
        if (oldest !== undefined) shardScanCache.delete(oldest)
      }
      shardScanCache.set(cacheKey, { sig: fileSigOf(path), counts: local, scanned: localScanned })
    }
    // 分片级让出：一次 global 要开 300+ 个库，库与库之间必须交还控制权。
    await yieldToLoop()
  }
  return { scanned, canceled: false }
}

/** 朋友圈 db 的候选路径（与 {@link scanMoments} 同一份清单，缓存签名要用）。 */
const MOMENTS_DB_PATHS = ['sns/db_sns/sns.db', 'sns/sns.db'] as const

/** 朋友圈扫描：sns.db 的 SnsTimeLine.content（帖子正文，剥 XML 后计词）。 */
async function scanMoments(decryptedDir: string, counts: Map<string, number>, matcher: EntityMatcher, isCancelled: () => boolean = () => false): Promise<{ scanned: number; canceled: boolean }> {
  let scanned = 0
  for (const rel of MOMENTS_DB_PATHS) {
    if (isCancelled()) return { scanned, canceled: true }
    const p = join(decryptedDir, ...rel.split('/'))
    if (!existsSync(p)) continue
    let db: DatabaseSync | null = null
    try { db = new DatabaseSync(p, { readOnly: true }) } catch { continue }
    try {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() === undefined) return { scanned, canceled: false }
      const cols = new Set((db.prepare('PRAGMA table_info(SnsTimeLine)').all() as Array<{ name: string }>).map(r => r.name))
      const contentCol = cols.has('content') ? 'content' : (cols.has('Content') ? 'Content' : null)
      if (!contentCol) return { scanned, canceled: false }
      let sinceYieldRows = 0
      let sinceYieldChars = 0
      for (const r of db.prepare(`SELECT ${contentCol} AS c FROM SnsTimeLine`).iterate() as Iterable<{ c: unknown }>) {
        const text = stripXml(decodeCell(r.c))
        if (!text) continue
        scanned += 1
        countText(text, counts, matcher)
        sinceYieldRows += 1
        sinceYieldChars += text.length
        // 行级 / 字符级**双阈值**让出（2026-09-28 实测后补）：
        // 朋友圈正文是**长文本** —— 本机真实数据实测 `wordcloud(moments)` 的最长独占
        // 是 **111ms**，而同一轮里 `global` 只有 41ms。原因就是"每 2000 行让出一次"
        // 这个只按行数的阈值：2000 条长正文和 2000 条短消息完全不是一个量级。
        // `search-build.ts:276` 早就为此立了 `YIELD_EVERY_CHARS`，这里对齐同一条口径：
        // 行多但都短、行少但都很长，两种形状都要让出。
        if (sinceYieldRows >= YIELD_EVERY_ROWS || sinceYieldChars >= YIELD_EVERY_CHARS) {
          sinceYieldRows = 0
          sinceYieldChars = 0
          await yieldToLoop()
          // W2-9.4：让出点就是检查点 —— 单个 sns.db 也能中途停，不必等它整张扫完。
          if (isCancelled()) return { scanned, canceled: true }
        }
      }
      return { scanned, canceled: false }
    } finally { db.close() }
  }
  return { scanned, canceled: false }
}

/** 缓存里保留的词数上界（大到远超前端的 limit，小到不会把内存撑起来）。 */
const MAX_CACHED_WORDS = 2000

/** 真正算一遍（不缓存）。`words` 是**全量排序后的前 MAX_CACHED_WORDS**，由调用方按 limit 切片。 */
async function computeWordCloud(decryptedDir: string, scope: 'global' | 'chat' | 'moments', username: string, year: number | undefined, isCancelled: () => boolean = () => false): Promise<WordCloudResult> {
  const counts = new Map<string, number>()
  // 实体名表本身要开 contact 库读全部昵称（几百到几千条），让出一次再进主扫描。
  await yieldToLoop()
  const matcher = buildEntityMatcher(entityNamesOf(decryptedDir))
  let scanned = 0
  let canceled = false
  //
  // W2-9.4：取消**不抛错**，返回已经算完的那一部分 —— 与本仓其它取消通道同一口径
  //（「停止生成」「取消 whisper 下载」都是这么做的）。抛错的话前端只能当成失败提示，
  // 而用户明明是自己切换了年份/会话，不该看到一句红色报错。
  if (scope === 'moments') {
    const r = await scanMoments(decryptedDir, counts, matcher, isCancelled)
    scanned = r.scanned
    canceled = r.canceled
  } else {
    const r = await scanMessages(decryptedDir, { username: username || undefined, year }, counts, matcher, isCancelled)
    scanned = r.scanned
    canceled = r.canceled
  }
  // 碎片剪枝（2026-09-30）：词表原来混着「级别最高 → 别最」这类二元切片，用户看到的是
  // 「念不出来的词条」。判据与边界写在 `word-match.ts` 的 `pruneFragmentWords` 上。
  // 这一趟是 O(不同二元组数) 的收尾计算，量级远小于扫描；让出一次再进，与上面的纪律一致。
  await yieldToLoop()
  pruneFragmentWords(counts, matcher)
  const words = Array.from(counts.entries())
    .filter(([, n]) => n >= 2) // 只出现 1 次的词对词云没有统计意义
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_CACHED_WORDS)
  return { words, scanned, canceled }
}

/**
 * 同一 `scope` 下「在飞的那一次」的票号（W2-9.4）。
 *
 * ## 为什么按 scope 分桶、而不是全局一张
 *
 * 用户拖年份滑块 / 快速切会话时，新请求会连着发好几次全局统计 —— 实测一次冷算
 * `global` 约 2 秒（源码里那句「最大单点 1921ms」），于是旧的那几次白烧到结束。
 * 后来者把前一个作废，是这类「用户已经不需要了」的算力唯一能省的地方。
 *
 * 但**不同 scope 不互相作废**：总览页的全库热词与会话/朋友圈的小词云常同屏出现，
 * 让小的取消大的会让大的一直算不完。分桶之后，只有「同类里的后来者」才作废前一个。
 */
const WORDCLOUD_TICKETS = new Map<string, number>()

let wordcloudTicketSeq = 0

/**
 * 计算词云词频（带进程内缓存）。
 *
 * 实测（2026-09-26，本机 163,647 条正文 / 349 张会话表）：不加缓存时 global 一次 **15.3 秒**，
 * 且每次切回总览页都重算。它**原先同步返回** ⇒ 跑的这十几秒里后端 RPC 队列被整条堵住，
 * 同屏的「世界板块」（自身只要 13ms）实测被推迟到 **17,008ms** 才拿到数据 ——
 * 用户看到的就是「世界板块和全部热词都卡住」。
 *
 * 三道修：① 实体遮罩改 Aho-Corasick（见 `EntityMatcher`），把 15 秒压到 ~2 秒；
 * ② 按数据指纹缓存 30 秒，切回来 0ms；
 * ③ **让出事件循环**（2026-09-28 补）：即使压到 ~2 秒，一次冷算仍是**同步**占满整个
 * 后端 worker —— 实测被拖慢的不是词云自己，而是同屏其它请求。所以这里改成
 * `async` + `cachedBySigAsync`，并在分片之间 / 每 `YIELD_EVERY_ROWS` 行让出，
 * 与 `overview-insights.ts` / `storage.ts` 等九个模块同一条纪律
 * （判据：`tests/query-yield-discipline.spec.ts` 的 P1-2 清单）。
 *
 * 契约变化：返回值由 `WordCloudResult` 变为 `Promise<WordCloudResult>` ——
 * `remotes/wordcloud.ts` 与 `gateway-read.ts` 的转发层同步改成 async；
 * 渲染侧 `apiGetWordCloud` 本来就是 `await`，无需改动。
 * @param decryptedDir 解密数据根。
 * @param options scope/username/year/limit。
 */
export async function queryWordCloud(decryptedDir: string, options?: WordCloudOptions): Promise<WordCloudResult> {
  const scope = options?.scope ?? 'global'
  // 上限 200 → 400（2026-09-30）：全屏画布约 2350px 宽，按前端「宽度 / 9.7」要 ~243 个词才
  // 填得满，200 会在右边留一片空。缓存本来就有 `MAX_CACHED_WORDS` 个词，放宽只是多切一些。
  const limit = Math.max(1, Math.min(400, Math.floor(options?.limit ?? 60)))
  const username = (options?.username ?? '').trim()
  if (scope === 'chat' && username === '') {
    throw new Error('scope=chat 需要 username（会话的 talker）')
  }
  const year = options?.year
  // 缓存签名：消息侧用分片目录的 mtime+size（新消息落库即失效）；朋友圈用 sns.db。
  const sig = scope === 'moments'
    ? MOMENTS_DB_PATHS.map((rel) => rel + ':' + fileSigOf(join(decryptedDir, ...rel.split('/')))).join('|')
    : shardCatalogSig(decryptedDir, ['message'])
  const ticket = (wordcloudTicketSeq += 1)
  WORDCLOUD_TICKETS.set(scope, ticket)
  const isCancelled = (): boolean => {
    const now = WORDCLOUD_TICKETS.get(scope)
    return now !== ticket
  }
  const full = await cachedBySigAsync(
    `wordcloud:${scope}:${username}:${year ?? 'all'}:${decryptedDir}`,
    sig,
    () => computeWordCloud(decryptedDir, scope, username, year, isCancelled),
    30_000,
    // 半成品**不写缓存**：写进去就是 30 秒内一直返回那份扫了一半的词表，
    // 而且界面上没有任何东西告诉用户「这是半的」。不写不是丢数据 ——
    // 下一次请求会重算，而那时已经没人取消它了。
    (v) => v.canceled !== true,
  )
  return { words: full.words.slice(0, limit), scanned: full.scanned, canceled: full.canceled === true }
}
