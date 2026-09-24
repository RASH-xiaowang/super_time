/**
 * 搜索索引那批「重夹具」用例共用的造数据工具（从 `search-cursor.spec.ts` 原样搬出来）。
 *
 * 为什么要搬出来：2026-09-24 为 N36 ① 把 `search-cursor.spec.ts` 按场景拆成两份
 * （`search-cursor.spec.ts` 管「兜底搜索与让出预算」，`search-index-build.spec.ts` 管
 * 「构建的让出与重建窗口」）。拆的理由是**机制本身**：CI 那条假红的线是 vitest 里硬编码的
 * 60 秒 RPC 超时，而它数的是**单个文件**里那段同步不让出的时间 —— 两份各自建各的索引，
 * 单文件的累计就不再逼近那条线。
 *
 * 但拆文件最容易犯的错是把造数据的代码**复制两份**：那以后两份夹具会各自漂移
 * （一份改了熵断言、另一份没改 ⇒ 同一句「FTS 成本没被低估」有两种含义）。
 * 所以这里只有一份实现，两个 spec 都从这里拿。
 *
 * 搬移的等价性证据：函数体逐字未改，只有 `scratch` 从模块级数组改成导出的登记表
 * （两个 spec 各自 `afterEach` 时清自己那批目录）。
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach } from 'vitest'

import { closeAllTrackedDbs, openTrackedDb, removeDirWithRetry } from '../../tests/helpers/temp-db.ts'
import { buildSearchIndex } from '../src/query/search.ts'

export const USER = 'wxid_a'
export const TERM = 'needle'

/** 本模块造出来的临时目录（两个 spec 各自注册清理钩子，清理时按前缀分）。 */
const scratch: string[] = []

/**
 * 在每个 spec 的顶层调用一次：把「先关连接、再带退避删除」的清理挂到该文件的 `afterEach` 上。
 *
 * 顺序不能反：用例超时或断言失败会跳过它自己的 `close`，残留句柄让 Windows 上的删除确定性失败
 * （EBUSY/EPERM），重试也救不了 —— 这是本仓 spec 的统一做法（见 `temp-db.ts`）。
 * @param label - 日志里认得出的名字（哪个文件没清干净）。
 */
export function trackScratch (label: string): void {
  afterEach(async () => {
    closeAllTrackedDbs()
    const list = scratch.splice(0)
    for (const d of list) {
      const r = await removeDirWithRetry(d)
      if (!r.ok) console.warn(`[${label}] 临时目录未能删除（${r.code}，试了 ${r.attempts} 次）：${d}`)
    }
  })
}

/** 起一个空的 decrypted 数据根并注册清理。 */
function freshRoot (prefix: string): { root: string, decrypted: string } {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`))
  scratch.push(root)
  const decrypted = join(root, 'decrypted')
  mkdirSync(join(decrypted, 'session'), { recursive: true })
  mkdirSync(join(decrypted, 'message'), { recursive: true })
  return { root, decrypted }
}

function msgTable (): string {
  return 'Msg_' + createHash('md5').update(USER, 'utf8').digest('hex')
}

/**
 * 造一个会话 + 若干消息。`hitsTarget` 条含关键词，其余为干扰；
 * 中间的干扰条数决定「要不要跨过让出阈值」。
 */
export function makeFixture (totalMessages: number, hitsTarget: number, padBytes = 0): string {
  const { decrypted } = freshRoot('search-cursor')

  const sdb = openTrackedDb(join(decrypted, 'session', 'session.db'))
  sdb.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
  sdb.prepare('INSERT INTO SessionTable (username, display_name, last_timestamp, sort_timestamp, unread_count, last_msg_type, last_msg_sender) VALUES (?, ?, 1700000000, 1700000000, 0, 1, \'\')').run(USER, USER)
  sdb.close()

  const mdb = openTrackedDb(join(decrypted, 'message', 'message_0.db'))
  const t = msgTable()
  mdb.exec(`CREATE TABLE "${t}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER, compress_content TEXT)`)
  const ins = mdb.prepare(`INSERT INTO "${t}" VALUES (?,?,?,?,?,?,?,?,?)`)
  // 关键词只落在前 hitsTarget 条；其余是普通文本（不命中）。
  // padBytes 用来把单条消息撑到接近真实聊天长度 —— 否则全是 20 字节的短行，
  // 「物化 vs 游标」的内存差会被噪声淹没（实测过：10 万短行只差 0.1MB）。
  // 一条事务里插完：**不要**逐行独立提交 —— 那样每行一次 fsync，本机实测 1ms/行，
  // 6000 行的夹具要 6 秒，而在 CI runner（共享 2 核 + 实时扫描）上放大到近百秒，
  // 成为 worker 里一整段无法应答 RPC 的同步阻塞 —— vitest 会因此报
  // `[vitest-worker]: Timeout calling "onTaskUpdate"`（用例本身全过，却把退出码弄成 1，
  // 2026-09-20 实测 3 条）。`appendMessages` 早就是这么写的，这里跟上。
  mdb.exec('BEGIN')
  const pad = padBytes > 0 ? 'x'.repeat(padBytes) : ''
  for (let i = 1; i <= totalMessages; i += 1) {
    const isHit = i <= hitsTarget
    const body = isHit ? `${TERM} 第 ${i} 条` : `普通消息 ${i}`
    ins.run(i, i, 1, i % 2, 1700000000 + i, 1, body + pad, `srv${i}`, '')
  }
  mdb.exec('COMMIT')
  mdb.close()
  return decrypted
}

/**
 * 直接指定每行正文的夹具（用于「无可读文本的行」「超长行」这类形态）。
 * 关键词 `needle` 落在前 5 行，其余为给定正文。
 */
export function makeRawFixture (bodies: string[]): string {
  const { decrypted } = freshRoot('search-cursor')

  const sdb = openTrackedDb(join(decrypted, 'session', 'session.db'))
  sdb.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
  sdb.prepare('INSERT INTO SessionTable (username, display_name, last_timestamp, sort_timestamp, unread_count, last_msg_type, last_msg_sender) VALUES (?, ?, 1700000000, 1700000000, 0, 1, \'\')').run(USER, USER)
  sdb.close()

  const mdb = openTrackedDb(join(decrypted, 'message', 'message_0.db'))
  const t = msgTable()
  mdb.exec(`CREATE TABLE "${t}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER, compress_content TEXT)`)
  const ins = mdb.prepare(`INSERT INTO "${t}" VALUES (?,?,?,?,?,?,?,?,?)`)
  // 同 `makeFixture`：一条事务插完（逐行提交在 CI 上是几十秒级的同步阻塞，会拖出 RPC 超时）。
  mdb.exec('BEGIN')
  bodies.forEach((body, i) => {
    const id = i + 1
    ins.run(id, id, 1, id % 2, 1700000000 + id, 1, body, `srv${id}`, '')
  })
  mdb.exec('COMMIT')
  mdb.close()
  return decrypted
}

/** 往既有夹具里追加消息（用于让「重建结果」与「旧索引」不同）。 */
export function appendMessages (decrypted: string, from: number, to: number): void {
  const t = msgTable()
  const mdb = openTrackedDb(join(decrypted, 'message', 'message_0.db'))
  const ins = mdb.prepare(`INSERT INTO "${t}" VALUES (?,?,?,?,?,?,?,?,?)`)
  mdb.exec('BEGIN')
  for (let i = from; i <= to; i += 1) {
    ins.run(i, i, 1, i % 2, 1700000000 + i, 1, `普通消息 ${i}`, `srv${i}`, '')
  }
  mdb.exec('COMMIT')
  mdb.close()
}

/** 130 个高频汉字。理论上 bigram 上限是 130² ≈ 1.69 万种，**但实测到不了**（见 {@link assertHighEntropy} 那段）。 */
const CJK_CHARS = '的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感'

/** 逐字符 LCG 拼一串高熵中文（重复字符会让 bigram 只剩几种，FTS 成本会被严重低估）。 */
function variedCjk (len: number, seed: number): string {
  let out = ''
  let s = seed % 2147483647
  for (let i = 0; i < len; i += 1) {
    s = (s * 1103515245 + 12345) % 2147483648
    out += CJK_CHARS[s % CJK_CHARS.length]
  }
  return out
}

/** 一池随机汉字；下面所有行都从它按窗口切（见 {@link cjkRows}）。 */
const CJK_POOL = variedCjk(1 << 18, 20260924)

/**
 * 造 `count` 条长度 `len` 的高熵正文（可给每行加一个前缀，用来放关键词）。
 *
 * 为什么不再逐字符拼 700 次：逐字符拼 1470 万个字符**本身就是这个文件里最长的一段
 * 不让出事件循环的同步块**（本机实测约 1.0 秒，比它要测的那段还长），而那纯粹是**造数据的开销**、
 * 与被测命题无关。改成「一次生成一池、各行按窗口切」之后同样的字节量只剩拷贝成本。
 * 行内 bigram 多样性才是「FTS 成本没被低估」的真正含义 —— 这条现在由 {@link assertHighEntropy}
 * 直接断言，不再只写在注释里。
 */
export function cjkRows (len: number, count: number, prefix?: (i: number) => string): string[] {
  if (len > CJK_POOL.length) {
    throw new Error(`单行要 ${String(len)} 个字符，比池子（${String(CJK_POOL.length)}）还长 —— 加大 CJK_POOL`)
  }
  const span = CJK_POOL.length - len
  const out: string[] = []
  for (let i = 0; i < count; i += 1) {
    const body = CJK_POOL.substr((i * 4096) % span, len)
    out.push(prefix === undefined ? body : prefix(i) + body)
  }
  return out
}

/** 一行里有多少种不同 bigram —— 高熵与否就看这个数。 */
export function distinctBigrams (s: string): number {
  const seen = new Set<string>()
  for (let i = 0; i + 1 < s.length; i += 1) seen.add(s.slice(i, i + 2))
  return seen.size
}

/**
 * 断言夹具正文的 bigram 多样性没有塌掉。
 *
 * 2026-09-24 第一次把这件事量出来（而不是写在注释里）：本生成器给出的**有效字符集只有
 * 62~67 个**（130 字的池 + 那个 LCG 的低周期 ⇒ 一半字符永远抽不到），于是
 * 21000 字符的行有 **1313~1368** 种 bigram、500 字符的行有 **405~406** 种；
 * 而 `'震'.repeat(21000)` 只有 **1** 种 —— 那才是这条断言要拦的东西。
 * 阈值取「行长的 50%」与 1000 的较小值：随机窗口以 1.3~1.6 倍余量通过，重复串差三个数量级。
 * （想让熵更高要改的是那个 LCG，但那会**同时抬高** FTS 成本、改变本文件所有时间读数 —— 别顺手做。）
 */
export function assertHighEntropy (row: string, label: string): void {
  if (row.length === 0) {
    throw new Error(`夹具正文（${label}）是空串 —— 这条断言本身就没有内容可查，别让它悄悄通过`)
  }
  const kinds = distinctBigrams(row)
  const floor = Math.min(1000, Math.ceil(row.length / 2))
  if (kinds < floor) {
    throw new Error(`夹具正文（${label}）只有 ${String(kinds)} 种 bigram，低于 ${String(floor)} 的下限 —— FTS 成本会被低估，这条用例的结论不成立`)
  }
}

/**
 * 跑一次构建，测「循环内单次同步块」的最大时长。
 *
 * 只取**两次 tick 之间**的空档：收尾的末次 flush + COMMIT 是单个不可分割的原子操作，
 * 不受循环内让出预算约束，混进来会淹没要测的信号（实测收尾 350ms 级、循环内 30ms 级）。
 */
export async function buildWithTickProbe (decrypted: string): Promise<{ ticks: number, maxGapMs: number, tailMs: number }> {
  const gaps: number[] = []
  let stop = false
  let last = Date.now()
  let maxGap = 0
  const tick = (): void => {
    if (stop) return
    const now = Date.now()
    const gap = now - last
    if (gap > maxGap) maxGap = gap
    gaps.push(gap)
    last = now
    setImmediate(tick)
  }
  setImmediate(tick)
  await buildSearchIndex(decrypted, true)
  const end = Date.now()
  stop = true
  return { ticks: gaps.length, maxGapMs: maxGap, tailMs: end - last }
}
