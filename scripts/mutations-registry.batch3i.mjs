/**
 * 变异登记 · **快照旁文件纪律**（2026-10-13，M492 起）。
 *
 * 这一批守的是「解密快照换了一代，上一代的 `-wal` 不许还在」这条不变量，
 * 以及它的两个下游动作（发布时清干净 / 修复时先清本地）。真机故障见
 * `src/backend/wechat-data/src/query/snapshot-sidecars.ts` 的模块头：
 * `message/message_0.db` 主文件完好，旁边一份 795 帧的上一代 WAL 让它读成
 * `database disk image is malformed`；而当时的「修复」只会重解密主文件 ⇒ 修不好。
 *
 * 每条都要求指定 spec 的用例**当场变红** —— 尤其 M494：它把「先清本地」删掉之后，
 * 那条用例会立刻落到 `unrepairable`（因为现场那个库在原始 db_storage 里根本不存在），
 * 也就是说它证明的是「这条路**不是**靠重解密蒙对的」。
 *
 * **没登记的那一条，与它的理由**：「清不掉就不发布」（`snapshot-sidecars.ts` 里
 * `if (strayWalBlocks(target)) return true`）单独拿不出来验：要让它可观测，得造出
 * 「`-wal` 不可删、而主文件仍可 rename」的状态，而 Windows 上这两件事由**同一个** SQLite
 * 连接持有（只读连接照样 EPERM 挡住 rename，实测），本仓的单测造不出这个状态。
 * 按本仓规矩（没打红过一次就不许声称有判别力），它不进表 —— 而不是塞一条永远咬不住的。
 * @module mutations-registry/batch3i
 */
export const MUTATIONS_BATCH3I = [
  {
    id: 'M492-publish-keeps-superseded-wal',
    why: '发布换代时不再丢掉上一代的 -wal ⇒ 新主文件被旧 WAL 的页盖住，整个库读成 `database disk image is malformed`（2026-10-13 真机现场）。判据：sync-wal.spec.ts 的「同一份 WAL 叠在另一代主文件上」。',
    file: 'src/backend/wechat-data/src/query/sync.ts',
    from: '    if (await discardSupersededWal(target)) {',
    to: '    if (false) {',
    spec: 'src/backend/wechat-data/tests/sync-wal.spec.ts',
  },
  {
    id: 'M494-repair-skips-local-sidecar-cleanup',
    why: '修复不再先清本地残留旁文件 ⇒ 那一类「主文件完好、只是旁边躺着上一代 WAL」又变成修不好（要去重解密一个其实完好的文件、还要读微信目录里 80MB+ 的原始分片）。判据：db-integrity-repair.spec.ts 的「上一代残留的 WAL（主文件完好）」。',
    file: 'src/backend/wechat-data/src/query/db-repair.ts',
    from: '    if (strayWalBlocks(abs)) {',
    to: '    if (false) {',
    spec: 'src/backend/wechat-data/tests/db-integrity-repair.spec.ts',
  },
  {
    id: 'M495-health-fts-misclassified-as-broken',
    why: '「本机装不上这个 FTS 分词器」不再单独成一类 ⇒ 三个好端端的 `*_fts.db` 又被说成「多半被微信独占」，面板劝用户退微信（退出微信永远不会有变化）。判据：db-health.spec.ts 的「微信自带分词器 ⇒ 归 uncheckable」。',
    file: 'src/backend/wechat-data/src/query/db-health.ts',
    from: '    if (reason !== null) {',
    to: '    if (false) {',
    spec: 'src/backend/wechat-data/tests/db-health.spec.ts',
  },
]
