/**
 * 变异登记 · ClawBot **AI 自动回复**（2026-10-13，M478 起）。
 *
 * 这一批守的是本仓第一处**无人值守的模型调用**：
 *   · 开关判定被摘掉 ⇒ 绑定即自动应答（用户没同意就出网）；
 *   · 「一批只回一条」退化成回第一条 ⇒ 连发几句时回的是最旧那句（答非所问），
 *     而「刚绑定拉回历史」也会挑中一条莫名其妙的旧消息；
 *   · 失败也往发送路径走 ⇒ 把「未配置默认模型」这类错误当内容发出去；
 *   · 入站判定被放宽 ⇒ 本机自己发出的消息也变成可回复对象（自己回自己的回显循环）。
 *
 * 每条都把「坏形状」注回去，要求 `clawbot-auto-reply.spec.ts` 指定用例**当场变红**。
 *
 * @module mutations-registry/batch3g
 */
export const MUTATIONS_BATCH3G = [
  {
    id: 'M478-clawbot-auto-reply-switch-ignored',
    why: '摘掉「实例开关关着就不回」的判定 ⇒ 绑上就开始自动应答：这是本仓唯一一处**无需用户点击**的模型出网，开关是它唯一的闸门。判据：clawbot-auto-reply.spec.ts 的「开关关着：一个字节都不出去」。',
    file: 'src/backend/wechat-data/src/query/clawbot/clawbot-auto-reply.ts',
    from: "  if (!cfg.autoReply) return { should: false, reason: '实例未开启自动回复', kbId: null }",
    to: "  if (false) return { should: false, reason: '实例未开启自动回复', kbId: null }",
    spec: 'src/backend/wechat-data/tests/clawbot-auto-reply.spec.ts',
  },
  {
    id: 'M479-clawbot-auto-reply-first-not-last',
    why: '「一批只回最后一条」退化成回第一条 ⇒ 用户连发几句时回的是最旧那句（答非所问）；刚绑定时拉回的历史也会挑中最早那条。服务端不给消息时间，这条是本模块压住刷屏上界的唯一手段。判据：clawbot-auto-reply.spec.ts 的「一批多条只取最后一条」。',
    file: 'src/backend/wechat-data/src/query/clawbot/clawbot-auto-reply.ts',
    from: '  const target = ok.at(-1)',
    to: '  const target = ok[0]',
    spec: 'src/backend/wechat-data/tests/clawbot-auto-reply.spec.ts',
  },
  {
    id: 'M480-clawbot-auto-reply-sends-on-failure',
    why: 'ask 失败也继续往发送路径走（不再 return）⇒ 把「未配置默认模型 / 上游 500」这类失败当成有答案去发，最坏情况是发出一段错误文案或空消息。判据：clawbot-auto-reply.spec.ts 的「ask 抛错 / 返回失败 / 空答案 ⇒ 不发送」。',
    file: 'src/backend/wechat-data/src/query/clawbot/clawbot-auto-reply.ts',
    from: "    if (!r.ok) {\n      deps.op('clawbot', 'clawbot_auto_reply', 'fail', tag, '自动回复失败：' + (r.error ?? '未知原因'))\n      return\n    }",
    to: "    if (false) {\n      return\n    }",
    spec: 'src/backend/wechat-data/tests/clawbot-auto-reply.spec.ts',
  },
  {
    id: 'M481-clawbot-auto-reply-accepts-outbound',
    why: '放宽「只回入站文本」的判断（不再看 direction）⇒ 本机自己发出的消息也成了可回复对象，最坏情况是「自动回复触发自动回复」的回显循环。判据：clawbot-auto-reply.spec.ts 的「只认入站文本」。',
    file: 'src/backend/wechat-data/src/query/clawbot/clawbot-auto-reply.ts',
    from: "  return msg.direction === 'in' && msg.msgType === 'text' && msg.content.trim() !== ''",
    to: "  return msg.msgType === 'text' && msg.content.trim() !== ''",
    spec: 'src/backend/wechat-data/tests/clawbot-auto-reply.spec.ts',
  },
  {
    id: 'M482-clawbot-chat-query-drops-slot',
    why: '会话检索丢掉当前实例（不带 slot）⇒ 多实例下面板显示的是**缺省那个号**的会话。这是最隐蔽的一类错位：界面有内容、也能发送，只是内容与消息都属于别的号。判据：clawbot-ui.wiring.spec.ts 的多实例接线断言。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/clawbot-chat.tsx',
    from: '    if (slot !== null) q.slot = slot',
    to: '    // M482 变异：会话查询不带 slot',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/clawbot-ui.wiring.spec.ts',
  },
  {
    id: 'M483-clawbot-message-event-drops-slot',
    why: '消息事件丢掉 slot ⇒ 前端无法判断「这条实时提示属于哪个实例」，只能盲目刷新：A 号来一条消息会去刷 B 号的列表（分页位置与 lastId 一起被搅）。判据：clawbot-remotes.spec.ts 的事件载荷断言。',
    file: 'src/backend/wechat-data/src/remotes/clawbot.ts',
    from: "      onMessages: (info) => { safeEmit(rc, { name: 'clawbot/message', args: { lastId: info.lastId, delta: info.delta, slot } }) },",
    to: "      onMessages: (info) => { safeEmit(rc, { name: 'clawbot/message', args: { lastId: info.lastId, delta: info.delta } }) },",
    spec: 'src/backend/wechat-data/tests/clawbot-remotes.spec.ts',
  },
]
