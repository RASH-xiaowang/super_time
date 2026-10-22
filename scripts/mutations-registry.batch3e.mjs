/**
 * 变异登记 · 微信 ClawBot 集成（2026-10-12）。
 *
 * 这一批来自同一次功能落地（A 方案：一对一绑定 + 接入会话，见需求基线 / 功能表）。
 * 为什么值得逐条登记：这套功能的失效几乎全是**静默**的 ——
 *   · 一对一收敛被摘掉 ⇒ 两行 bound 谁也不报错，界面只显示最新那个；
 *   · LIKE 转义被摘掉 ⇒ 搜「%」返回全表，看起来像"搜索很宽松"；
 *   · readError 被吞掉 ⇒「库打不开」显示成「还没有数据」；
 *   · 通道就绪位被写死 true ⇒ 界面开始假装能扫码；
 *   · 解绑捎带 DELETE ⇒ 与 PRIVACY 声明「解绑不删除接入会话」直接相反。
 * 每一条都把「坏形状」注回去，要求指定的守卫**当场变红**。
 *
 * @module mutations-registry/batch3e
 */
export const MUTATIONS_BATCH3E = [
  // ── 数据层：绑定状态机 ────────────────────────────────────────────────────
  {
    id: "M444-clawbot-two-bound-rows",
    why: "去掉绑定时的「同一 wxid 收敛」（把挂在别的实例上的同一个微信号降为 unbound-by-user 并清空凭证）⇒ 手工编辑出的两行 bound 会一直留着：同一个号被两条通道同时长轮询（消息落两处、发送用旧凭证），界面各读各的那一行、看不出异常。判据：clawbot-binding.spec.ts 的「后绑的接管、前一个被收敛」。（2026-10-13 多实例：命题由「全局只许一行 bound」**收窄**为「同一 wxid 只许一行 bound」—— 两个不同的号同时绑定正是要支持的能力。）",
    file: "src/backend/wechat-data/src/query/clawbot/clawbot-binding.ts",
    from: '      WHERE slot <> ? AND wxid = ? AND status = \'bound\'`).run(now, now, slot, identity.wxid)',
    to: "      WHERE slot <> ? AND wxid = ? AND status = 'never'`).run(now, now, slot, identity.wxid)",
    spec: "src/backend/wechat-data/tests/clawbot-binding.spec.ts",
  },
  {
    id: "M448-clawbot-binding-read-error-dropped",
    why: "读路径把 readError 吞掉（只回默认未绑定行）⇒「库打不开」被显示成「未绑定」，用户以为从没绑过、去重新扫码。判据：clawbot-binding.spec.ts 的「库打不开 ⇒ readError」。",
    file: "src/backend/wechat-data/src/query/clawbot/clawbot-binding.ts",
    from: "    return { binding: defaultBinding(slot), readError: '绑定信息读取失败：' + message }",
    to: "    return { binding: defaultBinding(slot) }",
    spec: "src/backend/wechat-data/tests/clawbot-binding.spec.ts",
  },
  {
    id: "M457-clawbot-bind-keeps-qr-token",
    why: "绑定成功后不清 qr_token / qr_expires_at（写成自赋值）⇒ 凭证只在 binding 态有意义的约定被打破，过期的二维码数据会一直挂在一行已绑定的记录上。判据：clawbot-binding.spec.ts 的「绑定成功 ⇒ wxid 回写、凭证清空」。（锚点带上前一行 `bound_at = ?,`：unbindBinding 里也有同名两列的清空，不带就不唯一。）",
    file: "src/backend/wechat-data/src/query/clawbot/clawbot-binding.ts",
    from: "bound_at = ?,\n      qr_token = NULL, qr_expires_at = NULL,",
    to: "bound_at = ?,\n      qr_token = qr_token, qr_expires_at = qr_expires_at,",
    spec: "src/backend/wechat-data/tests/clawbot-binding.spec.ts",
  },
  {
    id: "M450-clawbot-unbind-clears-messages",
    why: "解绑时顺手把接入会话删了 ⇒ 与 PRIVACY.md 白纸黑字的「解绑不删除接入会话」直接相反，且不可恢复；这条在数据层没有别的守卫拦得住。判据：clawbot-binding.spec.ts 的「接入会话一行不丢」。",
    file: "src/backend/wechat-data/src/query/clawbot/clawbot-binding.ts",
    from: "      sync_buf = NULL, send_context_token = NULL, session_epoch = session_epoch + 1, updated_at = ?\n      WHERE slot = ?`).run(now, now, slot)",
    to: "      sync_buf = NULL, send_context_token = NULL, session_epoch = session_epoch + 1, updated_at = ?\n      WHERE slot = ?`).run(now, now, slot)\n    db.exec('DELETE FROM clawbot_message')",
    spec: "src/backend/wechat-data/tests/clawbot-binding.spec.ts",
  },

  // ── 数据层：接入会话检索 ──────────────────────────────────────────────────
  {
    id: "M445-clawbot-like-escape-removed",
    why: "去掉 LIKE 转义 ⇒ 用户输入「%」等于全表（搜什么都能搜到，看起来像「搜索很宽松」）。这是 operation-log 早修过一遍的同一族；判据：clawbot-message.spec.ts 的「输入 % 不许返回全表」。",
    file: "src/backend/wechat-data/src/query/clawbot/clawbot-message.ts",
    from: "    const like = '%' + kw.replace(/[\\\\%_]/g, (m) => '\\\\' + m) + '%'",
    to: "    const like = '%' + kw + '%'",
    spec: "src/backend/wechat-data/tests/clawbot-message.spec.ts",
  },
  {
    id: "M446-clawbot-afterid-order-flipped",
    why: "续传模式（afterId）改成按 id 倒序 ⇒ 前端拿增量时顺序反了，合并进列表要靠客户端再排一遍；而设计口径是「按 id 升序（不用 ts）」。判据：clawbot-message.spec.ts 的「续传按 id 升序」。",
    file: "src/backend/wechat-data/src/query/clawbot/clawbot-message.ts",
    from: "  const order = query.afterId !== undefined ? 'id ASC' : 'id DESC'",
    to: "  const order = query.afterId !== undefined ? 'id DESC' : 'id DESC'",
    spec: "src/backend/wechat-data/tests/clawbot-message.spec.ts",
  },
  {
    id: "M447-clawbot-message-read-error-dropped",
    why: "把 listClawbotMessages 的 readError 吞掉 ⇒「库打不开」显示成「还没有接入会话」，用户去微信里反复发消息也不会有任何提示。判据：clawbot-message.spec.ts 的「读失败 ⇒ readError 且 items 空」。",
    file: "src/backend/wechat-data/src/query/clawbot/clawbot-message.ts",
    from: "    return { items: [], total: 0, maxId: 0, readError: '接入会话读取失败：' + message }",
    to: "    return { items: [], total: 0, maxId: 0 }",
    spec: "src/backend/wechat-data/tests/clawbot-message.spec.ts",
  },

  // ── 出网边界与审计 ────────────────────────────────────────────────────────
  {
    id: "M449-clawbot-ilink-host-swapped",
    why: "把 iLink 主机换成一个没登记的地址 ⇒ 出网台账（主机写死）、隐私声明（第四节 G2）与守卫三处一起失真；clawbot-outbound.spec.ts 钉死主机串与「接缝内只有一个 https 目的地」。（本条原为「零出网期间的通道就绪位」，通道接入后按新事实重写。）",
    file: "src/backend/wechat-data/src/query/clawbot/clawbot-ilink.ts",
    from: "export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'",
    to: "export const ILINK_BASE_URL = 'https://ilink.example.com'",
    spec: "src/backend/wechat-data/tests/clawbot-outbound.spec.ts",
  },
  {
    id: "M451-clawbot-audit-category-dropped",
    why: "从 CATEGORIES 里摘掉 clawbot ⇒ 按类别筛会**静默退化成不筛**（返回全部而不是只返回 clawbot），操作日志面板里选了「ClawBot」看到的却是所有记录。判据：clawbot-audit.spec.ts 的行为断言。",
    file: "src/backend/wechat-data/src/query/operation-log.ts",
    from: "const CATEGORIES: readonly OperationCategory[] = ['settings', 'keys', 'sync', 'export', 'delete', 'backup', 'edit', 'task', 'error', 'clawbot']",
    to: "const CATEGORIES: readonly OperationCategory[] = ['settings', 'keys', 'sync', 'export', 'delete', 'backup', 'edit', 'task', 'error']",
    spec: "src/backend/wechat-data/tests/clawbot-audit.spec.ts",
  },
  {
    id: "M456-clawbot-unbind-skips-audit",
    why: "解绑不写审计行 ⇒ 绑定/解绑这对操作只剩一半记录，「谁在何时解绑」查不到。判据：clawbot-remotes.spec.ts 的「解绑必须留一行审计」。",
    file: "src/backend/wechat-data/src/remotes/clawbot.ts",
    from: "      rc.op('clawbot', 'clawbot_unbind', 'ok', before.wxid ?? '', `${detail}（实例 ${slot}）`)",
    to: "      // M456 变异：解绑不写审计",
    spec: "src/backend/wechat-data/tests/clawbot-remotes.spec.ts",
  },
  {
    id: "M452-clawbot-event-leaks-content",
    why: "把消息正文塞进事件载荷 ⇒ 事件是广播给渲染层的，正文会跟着进 DOM 层日志与调试器；设计口径是「事件只带 { lastId, delta }，正文由前端按 id 拉」。判据：clawbot-remotes.spec.ts 的事件载荷断言。",
    file: "src/backend/wechat-data/src/remotes/clawbot.ts",
    from: "    onMessages: (info) => { safeEmit(rc, { name: 'clawbot/message', args: { lastId: info.lastId, delta: info.delta, slot } }) },",
    to: "    onMessages: (info) => { safeEmit(rc, { name: 'clawbot/message', args: { lastId: info.lastId, delta: info.delta, content: '泄露正文' } }) },",
    spec: "src/backend/wechat-data/tests/clawbot-remotes.spec.ts",
  },

  // ── 前端接线与展示 ────────────────────────────────────────────────────────
  {
    id: "M453-clawbot-chat-not-subscribed",
    why: "会话视图不订阅实时事件（事件名拼错）⇒ 新消息到了界面永远不动，而没有任何报错（事件到了 DOM、没人听）。判据：clawbot-ui.wiring.spec.ts 的订阅断言。",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/panels/clawbot-chat.tsx",
    from: "    window.addEventListener('dsh-clawbot-message', on)",
    to: "    window.addEventListener('dsh-clawbot-message-x', on)",
    spec: "src/client/ui-wechat/src/client/pages/wechat-data/panels/clawbot-ui.wiring.spec.ts",
  },
  {
    id: "M454-clawbot-nav-icon-unfilled",
    why: "把导航图标的 filled() 包装去掉 ⇒ 外层 svg 的 fill:none / stroke:currentColor 生效到没有描边的 path 上，图标变成一块空白（静默失效，typecheck 与冒烟都看不见）。判据：clawbot-nav.wiring.spec.ts 的图标形态断言。",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/nav-config.ts",
    from: '      { tab: \'clawbot\', label: \'ClawBot集群\', icon: filled(\'<path fill-rule="evenodd" d="M5.2 3.4a2.2 2.2 0 1 1 0 4.4',
    to: '      { tab: \'clawbot\', label: \'ClawBot集群\', icon: (\'<path fill-rule="evenodd" d="M5.2 3.4a2.2 2.2 0 1 1 0 4.4',
    spec: "src/client/ui-wechat/src/client/pages/wechat-data/panels/clawbot-nav.wiring.spec.ts",
  },
  {
    id: "M455-clawbot-mask-phone-head",
    why: "把手机号的保留位数从「前 3」改成「前 2」⇒ 打码形态与口径（138****6721）漂移；单独看依然「打码了」，只有样例断言能发现。判据：clawbot-mask.spec.ts 的手机号样例。",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/panels/clawbot-mask.ts",
    from: "    .replace(PHONE, (m) => keepEnds(m, 3, 4))",
    to: "    .replace(PHONE, (m) => keepEnds(m, 2, 4))",
    spec: "src/client/ui-wechat/src/client/pages/wechat-data/panels/clawbot-mask.spec.ts",
  },
]
