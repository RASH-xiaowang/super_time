/**
 * 变异登记 · 同步的 **WAL 实时推送**（2026-10-13，M500 起）。
 *
 * 这一批守的是「微信一写 WAL，后端立刻拍一次同步节拍，而不是等下一个 10s 轮询拍」
 * （用户要求：WAL 实时推送更新，而不是定时轮询）。坏形状都是**静默**的：
 *   · 触发接线被摘掉 ⇒ 监听器还挂着、事件还进来，但一次 tick 都不拍 ——
 *     实时性悄悄回到 10s 级，没有任何报错；
 *   · 防抖归零 ⇒ 一个写入簇触发一串节拍，把单线程 worker 打成风暴
 *     （每个节拍是 42 stat + 一次 WAL 补丁 + 一次全前端推送）；
 *   · 限频被绕过 ⇒ 活跃会话期间节拍无上界（最坏每秒几十次推送风暴）。
 *
 * 每条都把「坏形状」注回去，要求指定 spec 的用例**当场变红**。
 *
 * @module mutations-registry/batch3k
 */
export const MUTATIONS_BATCH3K = [
  {
    id: 'M500-sync-watch-trigger-unwired',
    why: '监听触发不再接到 tick 上 ⇒ WAL 事件进来只走防抖/限频却一次同步都不拍，实时性悄悄退回 10s 轮询级，没有任何报错。判据：sync-watch.spec.ts 的「同步循环接上监听器」源码锚点。',
    file: 'src/backend/wechat-data/src/query/sync.ts',
    from: 'onTrigger: () => { void tick() }',
    to: 'onTrigger: () => { /* 摘掉触发 */ }',
    spec: 'src/backend/wechat-data/tests/sync-watch.spec.ts',
  },
  {
    id: 'M501-sync-watch-debounce-zeroed',
    why: '防抖窗口归零 ⇒ 一个写入簇（一条消息触发多库多次写）变成一串即时触发，节拍风暴把单线程 worker 打成拥堵（P2-4 记过的那场全面板风暴的同族）。判据：sync-watch.spec.ts 的「一个写入簇经 400ms 防抖合并成一次触发」。',
    file: 'src/backend/wechat-data/src/query/sync-watch.ts',
    from: 'export const WATCH_DEBOUNCE_MS = 400',
    to: 'export const WATCH_DEBOUNCE_MS = 0',
    spec: 'src/backend/wechat-data/tests/sync-watch.spec.ts',
  },
  {
    id: 'M502-sync-watch-rate-limit-bypassed',
    why: '1.5s 限频被绕过 ⇒ 活跃会话期间每次写入簇都拍一拍（最坏每秒数十次全前端推送），防抖只能合并单簇、拦不住持续高频。判据：sync-watch.spec.ts 的「1.5s 内的第二次触发被限频跳过」。',
    file: 'src/backend/wechat-data/src/query/sync-watch.ts',
    from: 'if (at - lastTriggerAt < WATCH_MIN_GAP_MS) return',
    to: 'if (false) return',
    spec: 'src/backend/wechat-data/tests/sync-watch.spec.ts',
  },
]
