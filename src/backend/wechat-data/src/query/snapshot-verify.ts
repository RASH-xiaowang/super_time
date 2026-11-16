/**
 * 解密产物的**发布前完整性判定**（三态）。
 *
 * ## 为什么不能只看 `looksDecrypted`
 *
 * `sync.ts#decryptPage` 给页 1 **无条件**贴上 `SQLite format 3\0` 魔数，所以
 * `looksDecrypted`（24 字节头 + 页大小/格式/payload fraction）只能证明「页 1 像那么回事」。
 * 只要页 2 起有损坏 —— 撕裂缝合、错密钥恰好撞过头部判据、WAL 帧补错代 —— 产物依旧会
 * 通过头部判据并被 `atomicReplace` 发布出去，直到下一次「数据库体检」才被发现。
 * 因此发布前必须让 SQLite 自己把整库结构读一遍：`PRAGMA quick_check`。
 *
 * ## 三态而不是布尔
 *
 *   · `ok`：quick_check 的每一行都是 `ok`，可以发布；
 *   · `corrupt`：quick_check 报出非 `ok` 判词，或打开/查询抛错且不是「缺模块」类，
 *     调用方必须**拒绝发布**（旧目标保留）；
 *   · `uncheckable`：本机 SQLite 装不上这个库需要的模块/分词器。微信的 `*_fts.db`
 *     用 `tokenize='MMFtsTokenizer …'`（编在微信里），`quick_check` 一实例化虚拟表就抛
 *     一句没信息量的 `SQL logic error` —— 那是「本机检不了」，不是「库坏了」。
 *     这一态**不能**判成 corrupt：全量解密/修复路径会因此把一个完全正常的快照拒掉。
 *
 * ## FTS 分词器口径
 *
 * 先用 `db-health.ts#uncheckableReason` 看 `sqlite_master` 里的虚拟表 DDL（判据只看
 * DDL 里的 tokenizer 名字，不看错误文案）；DDL 没写出来、错误原文却是
 * `no such module/tokenizer/function` 或 `not authorized` 的，再由 `MISSING_MODULE_RE`
 * 兜第二层。两层用的是**同一份**判据，避免「体检说检不了、发布说坏了」。
 *
 * @module query/snapshot-verify
 */
import { withDb } from './db-open.ts'
import { MISSING_MODULE_RE, uncheckableReason } from './db-health.ts'

/** 发布前完整性判定：可发布 / 损坏 / 本机检不了（不是损坏）。 */
export type SnapshotVerdict =
  | { state: 'ok' }
  | { state: 'corrupt'; detail: string }
  | { state: 'uncheckable'; detail: string }

/**
 * 用一个只读连接跑 `PRAGMA quick_check`，把结果分成三态。
 *
 * `quick_check` 与 `integrity_check` 的口径差在「不逐条校验索引与 UNIQUE 约束」，
 * 但对本路径关心的页结构/表树损坏足够，且快得多；发布前每次全量解密都要跑，不能选重的。
 * @param file - 待判定的解密产物（staging 文件）路径。
 * @returns 三态结论；`corrupt.detail` 为前 3 条 SQLite 判词（或错误原文）。
 */
export function verifySnapshot(file: string): SnapshotVerdict {
  // 必须先判「本机能不能体检」：FTS 分词器缺失时 quick_check 只会抛通用错误，
  // 先看 DDL 才能把「检不了」从「坏了」里分出来（口径与 db-health 同一份实现）。
  const reason = uncheckableReason(file)
  if (reason !== null) return { state: 'uncheckable', detail: reason }
  try {
    const rows = withDb(file, (db) => db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>)
    const bad = rows
      .map((row) => String(Object.values(row)[0] ?? ''))
      .filter((verdict) => verdict !== 'ok')
    if (bad.length === 0) return { state: 'ok' }
    return { state: 'corrupt', detail: bad.slice(0, 3).join('；') }
  } catch (e) {
    // 打开/查询阶段的错误同样分两类：缺模块类走 uncheckable（DDL 没写出来时的兜底），
    // 其余（NOTADB / malformed / 截断）一律是损坏 —— 发布它比这一轮失败糟得多。
    const detail = e instanceof Error ? e.message : String(e)
    if (MISSING_MODULE_RE.test(detail)) return { state: 'uncheckable', detail }
    return { state: 'corrupt', detail }
  }
}

/**
 * 发布闸门：`corrupt` 抛错阻止 `atomicReplace`；`uncheckable` 告警后放行；`ok` 放行。
 *
 * 抛错文案是调用方（修复链路）能直接展示给用户的约定句子，不要在调用点再包一层。
 * @param file - 待发布的解密产物（staging 文件）路径。
 * @throws `corrupt` 时抛出 `解密结果完整性校验未通过：<detail>`。
 */
export function assertPublishable(file: string): void {
  const verdict = verifySnapshot(file)
  if (verdict.state === 'corrupt') {
    throw new Error('解密结果完整性校验未通过：' + verdict.detail)
  }
  if (verdict.state === 'uncheckable') {
    console.warn('[wechat-decrypt] 快照本机体检不了，按可发布处理（不是损坏）：' + verdict.detail)
  }
}
