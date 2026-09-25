/**
 * 批量取原图：把全库里**带免登录预签名直链**（`tphdurl` / `tpurl`）的图片原图一次取回本机。
 *
 * ## 为什么需要「批量」这一条
 *
 * 单条「取原图」早就有了，但它只有两个入口：用户在会话里**逐条**点（一条一次 RPC），
 * 或者前端预取链路顺手带一次。而本机实测（`working/probe-original-coverage.ts`）：
 * **51,983 条图片消息里 8,469 条带 `tphdurl`（16.3%）、135 条带 `tpurl`**，
 * 也就是说有几千条「本该能拿到的原图」要靠用户一条条点 —— 实际上没人会点。
 * 批量入口把这批一次做完，并且**幂等可续跑**（见下面的索引）。
 *
 * ## 三条途径与各自的约束（这是产品边界，不是实现细节）
 *
 * | 途径 | 本机覆盖率 | 能不能取 | 约束 |
 * |---|---|---|---|
 * | 本机 `.dat` 档（`_h`，含 wxgf 转码） | 971 个 `_h` | ✅ 离线 | 用户得先在微信里点开过大图 |
 * | 消息 XML 的 `tphdurl`/`tpurl` | 16.5% 有指针 | ⚠ **本机实测取不到** | 见下 |
 * | 消息 XML 的 `cdnbigimgurl`/`cdnmidimgurl` | 81.6% | ❌ **不做** | 要微信**登录态凭据** + 私有媒体 RPC |
 *
 * **第二行的实测结论（2026-09-26，`working/probe-wecom-403.ts`）**：本机 8,604 条带直链的图片
 * 消息**全部**指向企业微信的 `wwfile.work.weixin.qq.com/cgi-bin/download?f=…&t=…&p=1`，
 * 匿名 GET **一律 403**，且与消息新旧（20 分钟前的新消息同样 403）、请求头（裸 UA / 加
 * `Referer: work.weixin.qq.com` / 加图片 `Accept`）**都无关**；URL 里只有 `f`/`t`/`p` 三个参数，
 * **没有** `tpauthkey` 那类签名参数。⇒ 它不是免登录预签名直链，而是**需要企业微信登录态的服务端
 * 令牌端点**，与本应用「不登录」的边界同样冲突。所以它按「需要登录态」计，**不进候选清单**
 * （否则一次点击会白发几千个必然 403 的请求）。
 *
 * 保留这条通路的意义：**个人微信**账号的 `tpurl` 真带 `tpauthkey`（那类 GET 即明文图），
 * 换一个账号它就有产出；本机（这份数据）产出为 0，如实报出而不是假装能取。
 *
 * 后两行都不是「还没做」，是**明确的边界**：那已经不是「读本机已有的密钥」，而是「以你的身份向
 * 微信服务器发请求」，与本应用「不登录、不连微信服务器同步」的承诺冲突（口径写在
 * `query/image-original.ts` 的模块注释与 `docs/PRIVACY.md`）。所以这两类的兜底只能是
 * **让用户回微信里点开一次**（点开之后 attach 里就多出 `_h.dat`，再点「升级为原图」即可收进来）。
 *
 * ## 幂等与续跑：一份 sidecar 索引
 *
 * `<decoded>/.originals-index.json` 记「哪些 md5 已经联网取回过」。没有它的话，取回的原图与
 * 本机解码出的原图**写在同一个槽位**（`<md5>.<ext>`），下一轮批量就分不清「这张是取回来的」
 * 还是「本机解出来的」，只能重下 —— 几千张重下是几 GB 的浪费。索引只在成功落盘后写，
 * 并且批量路径**每 25 条合写一次**（每条都写会退化成 O(n²) 次 JSON 序列化）。
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { decompress } from 'fzstd'
import { collectImageDatFiles } from './decrypt-images.ts'
import { CDN_DISABLED_MESSAGE, cdnFetchAllowed } from './cdn-policy.ts'
import { isWecomFileEndpoint } from './cdn-hosts.ts'
import { fetchImageOriginalToCache, type ImageOriginalLink } from './image-original.ts'
import { extractMd5FromPacked } from './media-image.ts'

/** zstd magic（4.x 的 `message_content` 是压缩的）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 续跑索引的文件名（点开头，避免与 `<md5>.<ext>` 的解码缓存条目撞名）。 */
const INDEX_FILE = '.originals-index.json'

/** 索引落盘节流：每成功这么多条合写一次（不是每条都写）。 */
const INDEX_FLUSH_EVERY = 25

/** 一条可联网取回的原图候选。 */
export interface ImageOriginalCandidate {
  /** 图片内容 md5（`packed_info_data` 那份，**不是** XML 的 `md5=`）。 */
  md5: string
  /** 会话 username（拿不到时为空串；只用于报告，取回路径用不上）。 */
  username: string
  /** 消息 local_id（报告/排障用）。 */
  localId: number
  /** 免登录预签名直链（`tphdurl` 优先，其次 `tpurl`）。 */
  url: string
  /** 是否带独立的高清档（有 `tphdurl`）。 */
  hasHdLink: boolean
  /** XML 声明的原图字节数（`hdlength` → `length` → `tplength`），拿不到时 0。 */
  declaredBytes: number
}

/**
 * 一次「能不能取到原图」的盘点结果。
 *
 * **除 `messages` 外，所有计数都是「按 md5 去重后」的**：同一张图被转发/重复发送多次只算一张
 * （取回也是按 md5 命名落盘一次），而 `messages` 是扫到的消息行数。两个口径都写出来是为了
 * 报告能同时回答「有多少条消息」与「要下多少张」。
 */
export interface OriginalFetchPlan {
  /** 扫到的图片消息条数（**按行**，未去重）。 */
  messages: number
  /** 按 md5 去重后的图片张数。 */
  uniqueMd5: number
  /** 本机已有 `_h` 档（离线就拥有原图，不需要联网）。 */
  alreadyHd: number
  /** 已由本工具联网取回过（索引里），本次会跳过。 */
  alreadyFetched: number
  /** **本次可联网补齐**的条数（= 候选清单长度）。 */
  candidates: number
  /** 候选的 XML 声明字节数合计（预计下载量；缺声明的按 0 计，所以是下界）。 */
  declaredBytes: number
  /** 只有 `cdnbig/mid`（需微信登录态，本应用**不取**）的条数 —— 只能靠回微信里点开。 */
  loginRequired: number
  /**
   * `loginRequired` 里「**有直链、但那条直链是企业微信下载端点**」的那部分。
   *
   * 单列出来是为了让报告说得出「这几千张明明有 URL 却取不到」的原因：2026-09-26 实测
   * `wwfile.work.weixin.qq.com` 的链接匿名 GET 一律 403（与消息新旧、请求头都无关），
   * 它们是服务端令牌端点、不是免登录预签名直链（判据见 `cdn-hosts.ts` 的 `isWecomFileEndpoint`）。
   */
  wecomDirectLink: number
  /** 有 md5 但三种指针都没有的条数（实测本机为 0，留着便于将来发现新形态）。 */
  noPointer: number
}

/** 批量取回的结果。 */
export interface OriginalBatchResult {
  ok: boolean
  /** 扫出的候选总数（受 `limit` 截断前的）。 */
  candidates: number
  /** 本次实际尝试的条数（`limit` 之后）。 */
  attempted: number
  fetched: number
  failed: number
  /** 本次落盘的总字节数。 */
  bytes: number
  ms: number
  errors: Array<{ md5: string; username: string; error: string }>
  /** 因「总闸/开关」一张都没发请求时的说明（此时 `fetched`/`failed` 都是 0）。 */
  blocked?: string
  /** 还有多少候选没取（`limit` 截断后的剩余，下次点一下继续）。 */
  remaining: number
  /** 本轮之后，本机已有原图的张数（索引大小）—— 界面据此说「累计已补齐多少张」。 */
  indexed: number
}

/** 把 message_content 单元格解成文本（zstd → utf-8；解不开按原字节）。 */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  const b = Buffer.isBuffer(v) ? v : (v instanceof Uint8Array ? Buffer.from(v) : null)
  if (b === null) return String(v)
  let out = b
  if (b.length >= 4 && b.subarray(0, 4).equals(ZSTD_MAGIC)) {
    try { out = Buffer.from(decompress(b)) } catch { /* 按原字节试 */ }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(out)
}

/** 解 XML 里的 `&amp;` 等实体（直链被转义后直接用会 404，与 `image-original.ts` 同口径）。 */
function unescapeXml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

/** 消息库文件（`<decrypted>/message/**` 下的 `.db`）。 */
function messageDbFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) { messageDbFiles(full, out); continue }
    if (e.name.endsWith('.db')) out.push(full)
  }
  return out
}

/**
 * `Msg_<md5(username)>` 表名里的 hash → username 反查表。
 *
 * 为什么要反查：表名只有 hash，而报告与操作记录里写「哪个会话的哪张图」才有排障价值。
 * 来源是 `message_resource.db` 的 `ChatName2Id`（本机 175 行，代价可忽略）。
 * 找不到（如公众号的 `biz_message_*`）就留空串 —— 取回路径不依赖它。
 * @param decryptedDir - 解密数据根。
 * @returns `md5(username) → username`。
 */
function talkerByTableHash(decryptedDir: string): Map<string, string> {
  const out = new Map<string, string>()
  const dbPath = join(decryptedDir, 'message', 'message_resource.db')
  if (!existsSync(dbPath)) return out
  let db: DatabaseSync | null = null
  try { db = new DatabaseSync(dbPath, { readOnly: true }) } catch { return out }
  try {
    for (const r of db.prepare('SELECT user_name FROM ChatName2Id').all() as Array<{ user_name: unknown }>) {
      const name = cellText(r.user_name).trim().replace(/^"|"$/g, '')
      if (name !== '') out.set(createHash('md5').update(name, 'utf8').digest('hex'), name)
    }
  } catch { /* 读不动就没有名字，不影响取回 */ } finally {
    try { db.close() } catch { /* 已关 */ }
  }
  return out
}

/** 本机已有 `_h` 档（原图）的 md5 集合 —— 这些**不需要联网**。 */
function localOriginalMd5s(rawRoot: string): Set<string> {
  const out = new Set<string>()
  for (const f of collectImageDatFiles(rawRoot)) {
    const name = f.split(/[\\/]/).pop() ?? ''
    if (name.toLowerCase().endsWith('_h.dat')) out.add(name.slice(0, 32).toLowerCase())
  }
  return out
}

/** 读续跑索引（坏文件一律当空，不让它阻断批量）。 */
export function readFetchedOriginals(decodedDir: string): Set<string> {
  const p = join(decodedDir, INDEX_FILE)
  if (!existsSync(p)) return new Set()
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as { fetched?: Record<string, unknown> }
    return new Set(Object.keys(j.fetched ?? {}).map(k => k.toLowerCase()))
  } catch { return new Set() }
}

/**
 * 记一批「已联网取回过」（**一次**读-改-写）。
 *
 * 写成批而不是写单条，是因为批量路径会连着成功几百上千条：每条都读整个文件再序列化回去，
 * 会退化成 O(n²) 的写放大。批量驱动按 {@link INDEX_FLUSH_EVERY} 条合写一次。
 * @param decodedDir - 解码缓存根。
 * @param md5s - 本次成功取回的 md5（非 32 位十六进制的会被忽略）。
 */
export function recordFetchedOriginals(decodedDir: string, md5s: readonly string[]): void {
  const valid = md5s.map(m => m.toLowerCase()).filter(m => /^[0-9a-f]{32}$/.test(m))
  if (valid.length === 0) return
  const p = join(decodedDir, INDEX_FILE)
  let fetched: Record<string, number> = {}
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as { fetched?: unknown }
    if (j.fetched !== null && typeof j.fetched === 'object') fetched = j.fetched as Record<string, number>
  } catch { /* 没有/坏了都从头建 */ }
  const now = Date.now()
  for (const m of valid) fetched[m] = now
  try { writeFileSync(p, JSON.stringify({ version: 1, fetched }), 'utf8') } catch { /* best-effort：写不进去下次重下 */ }
}

/**
 * 记一条「已联网取回过」（单张路径用；内部走批量写）。
 * @param decodedDir - 解码缓存根。
 * @param md5 - 图片 md5。
 */
export function recordFetchedOriginal(decodedDir: string, md5: string): void {
  recordFetchedOriginals(decodedDir, [md5])
}

/**
 * 扫全库，盘点「每条图片消息的原图能不能拿到」。
 *
 * 一次扫描同时产出「候选（可联网补齐）」与「只能靠微信点开」两个数 —— 界面上的覆盖率报告
 * 与批量的执行清单是**同一份数据**，不会出现「报 8000 张、实际取 7000 张」这种对不上的情况。
 *
 * 计数口径：除 `messages` 外都按 md5 去重（见 {@link OriginalFetchPlan}）。
 * @param decryptedDir - 解密数据根。
 * @param rawRoot - 微信账号原始根（用来判「本机已有 `_h`」）。
 * @param decodedDir - 解码缓存根（读续跑索引）。
 * @returns 盘点结果 + 候选清单。
 */
export function scanImageOriginalPlan(
  decryptedDir: string,
  rawRoot: string,
  decodedDir: string,
): { plan: OriginalFetchPlan; candidates: ImageOriginalCandidate[] } {
  const hasHd = localOriginalMd5s(rawRoot)
  const fetched = readFetchedOriginals(decodedDir)
  const names = talkerByTableHash(decryptedDir)

  let messages = 0
  let loginRequired = 0
  let wecomDirectLink = 0
  let noPointer = 0
  let alreadyHd = 0
  let alreadyFetched = 0
  const seen = new Set<string>()
  const candidates: ImageOriginalCandidate[] = []

  for (const file of messageDbFiles(join(decryptedDir, 'message'))) {
    let db: DatabaseSync | null = null
    try { db = new DatabaseSync(file, { readOnly: true }) } catch { continue }
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg\\_%' ESCAPE '\\'").all() as Array<{ name: unknown }>)
        .map(r => String(r.name))
      for (const table of tables) {
        let cols: string[] = []
        try {
          cols = (db.prepare('PRAGMA table_info("' + table + '")').all() as Array<{ name: unknown }>).map(r => String(r.name))
        } catch { continue }
        const contentCol = cols.find(c => c.toLowerCase() === 'message_content')
        if (contentCol === undefined) continue
        const packedCol = cols.find(c => c.toLowerCase() === 'packed_info_data')
        let rows: Array<Record<string, unknown>> = []
        try {
          rows = db.prepare('SELECT local_id, "' + contentCol + '" AS content'
            + (packedCol === undefined ? '' : ', "' + packedCol + '" AS packed')
            + ' FROM "' + table + '" WHERE (local_type & 4294967295) = 3').all() as Array<Record<string, unknown>>
        } catch { continue }
        const username = names.get(table.replace(/^Msg_/, '').toLowerCase()) ?? ''
        for (const row of rows) {
          messages += 1
          const md5 = extractMd5FromPacked(row['packed'])
          // 拿不到 md5 的消息既不是候选、也无从「遗漏」：本机实测 51,983/51,983 都拿得到，
          // 所以这里直接跳过（不并进 noPointer —— 那个字段说的是「有 md5 但没指针」）。
          if (md5 === null) continue
          const key = md5.toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          if (hasHd.has(key)) { alreadyHd += 1; continue }
          if (fetched.has(key)) { alreadyFetched += 1; continue }
          const xml = cellText(row['content'])
          const m = /<img\b([^>]*)>/i.exec(xml)
          if (m === null) { noPointer += 1; continue }
          const at: Record<string, string> = {}
          for (const q of (m[1] ?? '').matchAll(/([A-Za-z_][\w:-]*)\s*=\s*"([^"]*)"/g)) at[(q[1] ?? '').toLowerCase()] = unescapeXml(q[2] ?? '')
          const tphd = at['tphdurl'] ?? ''
          const url = tphd !== '' ? tphd : (at['tpurl'] ?? '')
          if (url === '' || !/^https?:\/\//i.test(url)) {
            // 只剩 `cdnbigimgurl`/`cdnmidimgurl` 这一类：要登录态，本应用不取
            if ((at['cdnbigimgurl'] ?? '') !== '' || (at['cdnmidimgurl'] ?? '') !== '') loginRequired += 1
            else noPointer += 1
            continue
          }
          // 有直链 ≠ 能取：企业微信的 `wwfile.work.weixin.qq.com` 是**服务端令牌端点**，
          // 实测匿名 GET 一律 403（含 20 分钟前的新消息；三种请求头变体都试过）。
          // 把它们算进候选只会让一次点击白发几千个必然失败的请求，所以按「需要登录态」处理。
          if (isWecomFileEndpoint(url)) {
            loginRequired += 1
            wecomDirectLink += 1
            continue
          }
          const num = (s: string | undefined): number => {
            const x = Number(String(s ?? '').trim())
            return Number.isFinite(x) && x > 0 ? x : 0
          }
          candidates.push({
            md5: key,
            username,
            localId: Number(row['local_id']) || 0,
            url,
            hasHdLink: tphd !== '',
            declaredBytes: Math.max(num(at['hdlength']), num(at['length']), num(at['tplength'])),
          })
        }
      }
    } catch { /* 这个分片读不动就跳过 */ } finally {
      try { db.close() } catch { /* 已关 */ }
    }
  }

  const plan: OriginalFetchPlan = {
    messages,
    uniqueMd5: seen.size,
    alreadyHd,
    alreadyFetched,
    candidates: candidates.length,
    declaredBytes: candidates.reduce((n, c) => n + c.declaredBytes, 0),
    loginRequired,
    wecomDirectLink,
    noPointer,
  }
  return { plan, candidates }
}

/**
 * 造一个「一条都没发请求」的结果。
 *
 * 供**闸门在更上层**时复用（隐私总闸 / 已有解密任务在跑）：那两处不该为了造一个空结果
 * 去 import 本模块的内部形状，也不该各自手抄一份字段（少一个字段就是界面上一处 `undefined`）。
 * @param reason - 直接显示给用户的原因。
 * @returns `fetched`/`failed` 全 0、`blocked` 为传入原因的结果。
 */
export function emptyOriginalBatchResult(reason: string): OriginalBatchResult {
  return {
    ok: false, candidates: 0, attempted: 0, fetched: 0, failed: 0,
    bytes: 0, ms: 0, errors: [], remaining: 0, indexed: 0, blocked: reason,
  }
}

/**
 * 批量取回原图（免登录直链）。
 *
 * 边界与开关：**关掉「自动获取原图（CDN）」时一条请求都不发**（与单张路径同一口径，见
 * `query/cdn-policy.ts`），并回 {@link CDN_DISABLED_MESSAGE}；真正发请求前还会过一次
 * 腾讯系主机白名单（在 `fetchImageOriginalToCache` 里，消息 XML 是可被离线改写的文件）。
 * 逐条失败**不中断**整批（列出原因），成功的写进续跑索引 ⇒ 下次点一下就接着走。
 * @param decryptedDir - 解密数据根。
 * @param rawRoot - 微信账号原始根。
 * @param decodedDir - 解码缓存根（原图落这里 + 写续跑索引）。
 * @param opts - `limit`（0/不传 = 不限）、`concurrency`（默认 4，封顶 8）、`cdnEnabled`、`onProgress`。
 * @returns 计数、字节数、耗时与逐条失败原因。
 */
export async function fetchOriginalImagesBatch(
  decryptedDir: string,
  rawRoot: string,
  decodedDir: string,
  opts: {
    limit?: number
    concurrency?: number
    cdnEnabled?: boolean
    onProgress?: (done: number, total: number, fetched: number, failed: number, message: string) => void
  } = {},
): Promise<OriginalBatchResult> {
  const t0 = Date.now()
  const blank = { candidates: 0, attempted: 0, fetched: 0, failed: 0, bytes: 0, errors: [], remaining: 0 }
  // 开关判在**扫描之前**：关掉时连「本机有哪些图」都不必算，用户看到的就是那句开关说明。
  if (!cdnFetchAllowed(opts)) {
    return { ok: false, ...blank, ms: Date.now() - t0, indexed: readFetchedOriginals(decodedDir).size, blocked: CDN_DISABLED_MESSAGE }
  }

  const { plan, candidates } = scanImageOriginalPlan(decryptedDir, rawRoot, decodedDir)
  const limit = Number.isFinite(opts.limit) && (opts.limit ?? 0) > 0 ? Math.floor(opts.limit as number) : candidates.length
  const work = candidates.slice(0, limit)
  const workers = Math.max(1, Math.min(Math.floor(opts.concurrency ?? 4) || 4, 8))

  let fetched = 0
  let failed = 0
  let bytes = 0
  let cursor = 0
  let done = 0
  /** 待合写进索引的 md5（按 {@link INDEX_FLUSH_EVERY} 条一批落盘）。 */
  const pending: string[] = []
  const errors: Array<{ md5: string; username: string; error: string }> = []
  const flush = (): void => {
    if (pending.length === 0) return
    recordFetchedOriginals(decodedDir, pending.splice(0, pending.length))
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = cursor
      cursor += 1
      if (idx >= work.length) return
      const c = work[idx]
      if (c === undefined) return
      const link: ImageOriginalLink = { md5: c.md5, url: c.url, hasHd: c.hasHdLink, declaredBytes: c.declaredBytes }
      const r = await fetchImageOriginalToCache(link, decodedDir, opts)
      if (r.bytes === undefined) {
        failed += 1
        errors.push({ md5: c.md5, username: c.username, error: r.error ?? '取回失败' })
      } else {
        fetched += 1
        bytes += r.bytes
        pending.push(c.md5)
        if (pending.length >= INDEX_FLUSH_EVERY) flush()
      }
      done += 1
      opts.onProgress?.(done, work.length, fetched, failed, c.username || c.md5)
    }
  }

  const pool: Promise<void>[] = []
  for (let i = 0; i < workers; i += 1) pool.push(worker())
  await Promise.all(pool)
  flush()

  return {
    ok: failed === 0,
    candidates: plan.candidates,
    attempted: work.length,
    fetched,
    failed,
    bytes,
    ms: Date.now() - t0,
    errors,
    remaining: Math.max(0, plan.candidates - work.length),
    indexed: readFetchedOriginals(decodedDir).size,
  }
}
