/**
 * 变异登记 · 会话/消息列表的**实时更新收口**（2026-10-13，M503 起）。
 *
 * 用户报障「会话列表和消息列表还是没有实时更新」。真机 75 秒观察（sync-live-observe 探针）
 * 抓到两个真实的滞后源，这一批各钉一条反回归：
 *   · 会话列表完全靠推送驱动、没有轮询兜底，而数据事件驱动的后台刷新被
 *     **30s 全局节流**压着 ⇒ 最坏滞后 30 秒；
 *   · staging 拷贝撞 EBUSY（解密快照正被在途查询的连接握着，毫秒级握手竞争）
 *     立即退避 10s ⇒ 一次毫秒级竞争赔上 10 秒新鲜度（75 秒内实测两次）。
 *
 * 每条都把「坏形状」注回去，要求指定 spec 的用例**当场变红**。
 *
 * @module mutations-registry/batch3l
 */
export const MUTATIONS_BATCH3L = [
  {
    id: 'M503-chats-sessions-refresh-throttle-restored',
    why: '会话列表的节流降级（3s）被拿掉 ⇒ 退回 30s 全局默认：它完全靠推送驱动、没有轮询兜底，新消息进来最坏 30 秒才在侧栏出现（用户报障的一半根因）。判据：paged-list.spec.ts 的「刷新节流间隔可被面板覆盖」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/Chats.tsx',
    from: 'refreshMinIntervalMs: SESSIONS_REFRESH_MIN_INTERVAL_MS,',
    to: '',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/paged-list.spec.ts',
  },
  {
    id: 'M504-paged-list-ignores-panel-interval',
    why: '面板传的节流间隔被忽略（闸门钉死全局默认）⇒ 传了等于没传，会话列表又回到 30s 滞后，而且没有任何报错。判据：paged-list.spec.ts 的同一用例（hooks 那半锚点）。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/hooks.tsx',
    from: 'minIntervalMs: refreshMinIntervalMs ?? REFRESH_MIN_INTERVAL_MS,',
    to: 'minIntervalMs: REFRESH_MIN_INTERVAL_MS,',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/paged-list.spec.ts',
  },
  {
    id: 'M505-staging-copy-retry-single-attempt',
    why: '重试次数退成 1 ⇒ 一次毫秒级 EBUSY 竞争立刻进 10s 退避（重试存在与否在界面上就是「实时」与「10 秒起步的滞后」的差别）。判据：snapshot-sidecars.spec.ts 的「EBUSY 两次后成功 ⇒ 重试满 3 次」。',
    file: 'src/backend/wechat-data/src/query/snapshot-sidecars.ts',
    from: 'export const STAGE_COPY_ATTEMPTS = 3',
    to: 'export const STAGE_COPY_ATTEMPTS = 1',
    spec: 'src/backend/wechat-data/tests/snapshot-sidecars.spec.ts',
  },
  {
    id: 'M506-sync-staging-copy-bypasses-retry',
    why: '九处 staging 拷贝有一处退回直用 copyFile ⇒ 那一处撞 EBUSY 又回到「立刻退避 10s」的旧形态，而其余八处照旧（只坏一路，最难发现）。判据：snapshot-sidecars.spec.ts 的「九处 staging 拷贝全部走 stageCopyRetry」。',
    file: 'src/backend/wechat-data/src/query/sync.ts',
    from: 'await stageCopyRetry(rawWal, stagingWal)',
    to: 'await copyFile(rawWal, stagingWal)',
    spec: 'src/backend/wechat-data/tests/snapshot-sidecars.spec.ts',
  },
  {
    id: 'M507-sync-staging-open-bypasses-retry',
    why: '三处 staging 打开有一处退回直用 open ⇒ 那一路撞瞬时独占（真机实测 `open stage_wal r+` EBUSY）又回到 10s 退避（copy 重试救不了它：独占发生在打开刚写好的 staging 文件那一刻）。判据：snapshot-sidecars.spec.ts 的「三处 staging 打开全部走 stageOpenRetry」。',
    file: 'src/backend/wechat-data/src/query/sqlcipher-wal.ts',
    from: "await stageOpenRetry(outPath, 'r+')",
    to: "await open(outPath, 'r+')",
    spec: 'src/backend/wechat-data/tests/snapshot-sidecars.spec.ts',
  },
]
