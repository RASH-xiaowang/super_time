/**
 * 变异登记 · **浏览器态（手机端）Remote 与事件中继**（2026-10-14，M535 起）。
 *
 * 这一批的靶子全在「手机与桌面必须表现一致」这条前提上。它的失效方式**只在一条传输路上
 * 复现**（桌面好、手机坏，或反过来），而且界面看起来完全正常 —— 只是数据不动、
 * 或者停在「一屏加载失败」。这正是本项目最难现场定位的一类问题（上一轮 WAL 实时性
 * 事故就是这个形状），所以每条都必须有判据当场咬住。
 *
 *   M535 事件映射改一个字母 ⇒ 转发了但没人听（面板订阅的是旧名字）；
 *   M536 切回前台不再补刷新 ⇒ 手机后台期间 SSE 被挂起、事件全丢，回来后停在旧数据；
 *   M537 401 不再通知界面 ⇒ 会话 12 小时到期后用户看到「一屏加载失败」而不是「该重新扫码」；
 *   M538 令牌门不再包住应用 ⇒ 未授权时 WechatApp 直接挂载、发一串 401 请求；
 *   M539 SSE 缺省派发器不再走共用映射表 ⇒ 手机收到的帧翻译不成面板在听的 DOM 事件。
 *
 * @module mutations-registry/batch3t
 */
export const MUTATIONS_BATCH3T = [
  {
    id: 'M535-event-map-name-drift',
    why: '映射表里 wechat-data/updated 对应的 DOM 事件名改了一个字母 ⇒ 事件照样转发，但订阅 `dsh-wechat-data-updated` 的面板一个都收不到（WAL 实时刷新静默失效）。判据：wechat-events.spec.ts 的「每条的 DOM 事件名与带不带 detail 都对得上」+「表里每个 DOM 事件名都真的有面板在订阅」。',
    file: 'src/client/ui-app/wechat-events.ts',
    from: "  { from: 'wechat-data/updated', to: 'dsh-wechat-data-updated' },",
    to: "  { from: 'wechat-data/updated', to: 'dsh-wechat-updated' },",
    spec: 'src/client/ui-app/wechat-events.spec.ts',
  },
  {
    id: 'M536-visibility-resync-removed',
    why: '切回前台不再补一次刷新 ⇒ 手机切到后台时浏览器会挂起 EventSource，期间的事件全丢，回到前台界面还停在旧数据上（与上一轮「界面正常但数据不动」事故同款症状）。判据：http-remote.spec.ts 的「切回前台补一次刷新」。',
    file: 'src/client/ui-app/http-remote.ts',
    from: "    dispatch({ name: 'wechat-data/updated', args: [] })",
    to: '    void 0',
    spec: 'src/client/ui-app/http-remote.spec.ts',
  },
  {
    id: 'M537-session-lost-not-signalled',
    why: '401 不再派发「会话失效」事件 ⇒ 会话 12 小时到期（或桌面端轮换了令牌）之后，用户看到的是一屏「加载失败」，而真实原因是「该重新扫码了」。判据：http-remote.spec.ts 的「401 → 派发会话失效事件」。',
    file: 'src/client/ui-app/http-remote.ts',
    from: '    if (res.status === 401) {',
    to: '    if (res.status === 401 && false) {',
    spec: 'src/client/ui-app/http-remote.spec.ts',
  },
  {
    id: 'M538-browser-gate-bypassed',
    why: '令牌门不再包住应用 ⇒ 未授权时 WechatApp 直接挂载并发出一串请求，全部拿到 401，界面表现为「一屏加载失败」，用户看不出原因是「还没输入令牌」。判据：browser-session.wiring.spec.ts 的「根组件在浏览器态用 BrowserSession 包住 WechatApp」。',
    file: 'src/client/ui-app/ui-entry.tsx',
    from: '  if (capabilities.isBrowser) return <BrowserSession><WechatApp /></BrowserSession>',
    to: '  if (capabilities.isBrowser) return <WechatApp />',
    spec: 'src/backend/tests/browser-session.wiring.spec.ts',
  },
  {
    id: 'M539-sse-default-dispatcher-detached',
    why: 'SSE 的缺省派发器不再走共用映射表 ⇒ 手机收到的帧翻译不成面板订阅的 DOM 事件，而注入式测试（各自传了自己的 dispatch）看不出差别 —— 只有「不注入」那一条能抓到。判据：http-remote.spec.ts 的「缺省派发器就是共用的映射表」。',
    file: 'src/client/ui-app/http-remote.ts',
    from: '  const dispatch = opts.dispatch ?? ((ev: BackendEvent) => dispatchWechatEvent(ev))',
    to: '  const dispatch = opts.dispatch ?? ((_ev: BackendEvent) => null)',
    spec: 'src/client/ui-app/http-remote.spec.ts',
  },
]
