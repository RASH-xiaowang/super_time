/**
 * 变异登记 · 同步主库**尾部增量解密**（2026-10-13，M511 起）。
 *
 * 用户报「会话列表和消息窗口的新消息加载还是很慢」。真机 90 秒观察：轻负载下一次
 * 整库重解也要 ~192ms（82MB 量级），活跃聊天时检查点密集 + 6s 冷却叠加 ⇒ 新消息最坏
 * 滞后 6 秒多。尾部增量（SQLite WAL 检查点只追加页、不重写既有页）把这一步压到毫秒级。
 * 这一批钉三处**最容易静默回退**的形状：
 *   · quick_check 安全网被拆 ⇒ 「只追加不重写」前提不成立时（某微信版本不守 WAL 语义）
 *     坏快照直接发出去，界面表现为库损坏而不是「慢一点」；
 *   · 尾部计划被绕过 ⇒ 每次都整库重解，时延优化静默消失（功能不坏、只是又慢了）；
 *   · 尾页上限归 1 ⇒ 正常检查点（通常长几页到几十页）全部退回全量，同上。
 *
 * 每条都把「坏形状」注回去，要求指定 spec 的用例**当场变红**。
 *
 * @module mutations-registry/batch3n
 */
export const MUTATIONS_BATCH3N = [
  {
    id: 'M511-sync-tail-quick-check-bypassed',
    why: 'quick_check 闸被拆 ⇒ 尾部路径不再校验拼好的快照：坏计划/前提不成立的追加会把损坏的快照发出去（宁可慢不可错的安全网被拆；变异的靶子必须是 sync.ts 的**闸**本身——只改助手内部是等价变异，withDb 打开损坏库时自己会抛错兜住）。判据：sync-tail-patch.spec.ts 的「坏计划（偏移错页）⇒ quick_check 拦下并退回整库重解」。',
    file: 'src/backend/wechat-data/src/query/sync.ts',
    from: "if (!tailQuickCheckOk(stagingDb)) throw new Error(kind + ' patch quick_check failed for ' + file)",
    to: "if (false) throw new Error(kind + ' patch quick_check failed for ' + file)",
    spec: 'src/backend/wechat-data/tests/sync-tail-patch.spec.ts',
  },
  {
    id: 'M512-sync-tail-plan-bypassed',
    why: '尾部计划被绕过（恒 null）⇒ 主库每次检查点都整库重解：时延优化静默消失，新消息又回到 6s 冷却 + 全量重解的旧形态，而所有行为用例照绿。判据：sync-tail-patch.spec.ts 的「尾部计划必须真参与判定」源码锚点。',
    file: 'src/backend/wechat-data/src/query/sync.ts',
    from: 'tailAppendPlan(prev.main, sig.main)',
    to: 'null',
    spec: 'src/backend/wechat-data/tests/sync-tail-patch.spec.ts',
  },
  {
    id: 'M513-sync-tail-max-pages-collapsed',
    why: '尾页上限归 1 ⇒ 正常检查点（一次长几页到几十页）全部判为不可行、退回全量：尾部路径形同虚设。判据：sync-tail-patch.spec.ts 的「尾部增量计划 tailAppendPlan」象限用例（3 页增长必须有计划）。',
    file: 'src/backend/wechat-data/src/query/sync-tail-patch.ts',
    from: 'export const TAIL_MAX_PAGES = 2048',
    to: 'export const TAIL_MAX_PAGES = 1',
    spec: 'src/backend/wechat-data/tests/sync-tail-patch.spec.ts',
  },
]
