/**
 * 变异登记 · 主库**页级差分**增量（2026-10-13，M518 起，参考 WeChatDataAnalysis）。
 *
 * 检查点除追加页外还会**原地重写**部分页（主库大小不变、mtime 变）——尾部增量覆盖不了。
 * 页级差分用「指纹列表 + 只解变化页」把这一步从整库重解（82MB ≈ 200ms–1s）压到
 * 哈希扫描（≈ 80–150ms）+ 几页补丁。坏形状都是**静默**的：
 *   · 指纹与源签名脱钩 ⇒ 拿过期指纹比对，把「变了」判成「没变」（数据永久漏同步）；
 *   · 差异下标/补丁入口被绕过 ⇒ 差分退化成摆设，每次检查点又回到整库重解（只是又慢了）；
 *   · 变化页占比上限被拿掉 ⇒ 哈希扫描 + 大量补丁比全量更贵（反向优化）。
 *
 * 每条都把「坏形状」注回去，要求指定 spec 的用例**当场变红**。
 *
 * @module mutations-registry/batch3p
 */
export const MUTATIONS_BATCH3P = [
  {
    id: 'M518-page-diff-stale-fingerprints-used',
    why: '指纹列表不再与源签名绑定（恒真）⇒ 过期指纹参与比对：主库变了而指纹说没变，那一轮静默跳过、数据漏同步，且没有报错。判据：sync-page-diff.spec.ts 的「指纹必须与源签名绑定」。',
    file: 'src/backend/wechat-data/src/query/sync.ts',
    from: 'if (hashEntry !== undefined && hashEntry.sig === prevMain) {',
    to: 'if (hashEntry !== undefined) {',
    spec: 'src/backend/wechat-data/tests/sync-page-diff.spec.ts',
  },
  {
    id: 'M519-page-diff-plan-bypassed',
    why: '差异下标计算被绕过（恒 [0]）⇒ 每次原地重写的检查点都只补丁第 0 页：quick_check 兜底回全量，每一轮都白做一次哈希扫描 + 补丁（比直接全量更慢，且正确性依赖兜底）。判据：sync-page-diff.spec.ts 的「指纹比对必须真参与判定」。',
    file: 'src/backend/wechat-data/src/query/sync.ts',
    from: 'const diff = diffPageIndexes(hashEntry.hashes, curHashes)',
    to: 'const diff = [0]',
    spec: 'src/backend/wechat-data/tests/sync-page-diff.spec.ts',
  },
  {
    id: 'M520-page-diff-ratio-collapsed',
    why: '变化页占比上限归 0 ⇒ 差分永远不被采用（任何变化都退全量）：原地重写检查点的整库重解又回来了，时延优化静默消失。判据：sync-page-diff.spec.ts 的「变化页占比上限必须参与判定」+ 纯判定用例。',
    file: 'src/backend/wechat-data/src/query/sync-page-diff.ts',
    from: 'export const DIFF_MAX_CHANGED_RATIO = 0.2',
    to: 'export const DIFF_MAX_CHANGED_RATIO = 0',
    spec: 'src/backend/wechat-data/tests/sync-page-diff.spec.ts',
  },
]
