/**
 * 变异登记 · iLink 绑定通道接入（2026-10-12，M458 起）。
 *
 * 与 batch3e（数据层 + 界面）同属 ClawBot 这一族，但主题是**出网与生命周期**：
 * 通道接入后最容易「看起来全对」的坏法都在这里 ——
 *   · 认证头 / 主机校验被摘掉 ⇒ 请求发得出去、服务端却不会认（或认错了目的地）；
 *   · 会话过期不清游标 ⇒ 每次重连都拿旧游标，服务端一直回 -14，通道卡死；
 *   · 退避被写死 0 ⇒ 服务器半开时热循环（本仓实测过一次：假 sleep + 凭证误判把
 *     事件循环饿死，测试挂死不报错）；
 *   · msg_id 去重被摘掉 ⇒ 会话过期重拉的历史在列表里出现两次；
 *   · confirmed 不落凭证 / 解绑不清凭证 / 启动钩子不拉通道 ⇒ 三种「收了收不收靠运气」；
 *   · 发送侧（可发可收，同日补）：失败也落库（假记录）、令牌没带上、收件人写成 bot 自己 ——
 *     三条都不报错，只会「对方没收到」。
 *
 * 每条都把「坏形状」注回去，要求指定的守卫**当场变红**。
 *
 * @module mutations-registry/batch3f
 */
export const MUTATIONS_BATCH3F = [
  {
    id: 'M458-clawbot-ilink-auth-header-dropped',
    why: '把消息长轮询的 Authorization 头摘掉 ⇒ 请求照发、服务端不认；症状是「绑定成功但一条消息都收不到」。判据：clawbot-ilink.spec.ts 的认证头形状断言。（锚点带上一行 body：sendmessage 也有同名头，不带 body 就不唯一。）',
    file: 'src/backend/wechat-data/src/query/clawbot/clawbot-ilink.ts',
    from: "      AuthorizationType: 'ilink_bot_token',\n      Authorization: 'Bearer ' + credentials.botToken,\n      'X-WECHAT-UIN': makeWechatUin(),\n    },\n    body: { get_updates_buf: buf, base_info: { channel_version: CHANNEL_VERSION } },",
    to: "      AuthorizationType: 'ilink_bot_token',\n      'X-WECHAT-UIN': makeWechatUin(),\n    },\n    body: { get_updates_buf: buf, base_info: { channel_version: CHANNEL_VERSION } },",
    spec: 'src/backend/wechat-data/tests/clawbot-ilink.spec.ts',
  },
  {
    id: 'M459-clawbot-session-expired-keeps-buf',
    why: '会话过期（-14）时不清同步游标 ⇒ 重连带的还是坏游标，服务端一直回 -14，通道再也收不到新消息（WeClaw 原版正是靠清游标自愈）。判据：clawbot-channel.spec.ts 的「-14 清游标重连」。',
    file: 'src/backend/wechat-data/src/query/clawbot/clawbot-channel.ts',
    from: "            buf = ''\n            deps.saveBuf('', batch?.sessionEpoch)",
    to: '          // M459 变异：游标不清了',
    spec: 'src/backend/wechat-data/tests/clawbot-channel.spec.ts',
  },
  {
    id: 'M460-clawbot-backoff-disabled',
    why: '把退避初值写成 0 ⇒ 失败重试变成热循环（网络断了会秒级刷满日志与连接）。判据：clawbot-channel.spec.ts 的退避序列断言。',
    file: 'src/backend/wechat-data/src/query/clawbot/clawbot-channel.ts',
    from: '  let d = INITIAL_BACKOFF_MS',
    to: '  let d = 0',
    spec: 'src/backend/wechat-data/tests/clawbot-channel.spec.ts',
  },
  {
    id: 'M461-clawbot-msgid-dedupe-removed',
    why: "把 `msg_id` 去重判断摘掉（照写不查）⇒ 会话过期重拉时同一句话落两次；这条没有别的守卫拦得住（写入照常成功）。判据：clawbot-message.spec.ts 的「同一 msgId 第二次插入返回 null」。（2026-10-13 多实例：去重范围由全局收窄为**同一 slot 内**。）",
    file: 'src/backend/wechat-data/src/query/clawbot/clawbot-message.ts',
    from: "  if (msgId !== null) {\n    // 去重按 **slot 内** 判：消息 id 由服务端按会话下发，跨实例复用同一个号段并不安全。\n    const dup = db.prepare('SELECT 1 AS x FROM clawbot_message WHERE msg_id = ? AND slot = ? LIMIT 1').get(msgId, slot)\n    if (dup) return null\n  }",
    to: '  // M461 变异：去重判断被摘掉',
    spec: 'src/backend/wechat-data/tests/clawbot-message.spec.ts',
  },
  {
    id: 'M462-clawbot-confirm-keeps-no-credentials',
    why: '扫码确认后不把凭证落库（只写身份）⇒ 绑定卡片显示「已绑定」，但通道拿不到凭证、永远收不到消息。判据：clawbot-remotes.spec.ts 的 confirmed 用例（凭证必须入库）。',
    file: 'src/backend/wechat-data/src/remotes/clawbot.ts',
    from: '      return { state: session.state, binding: bindClawbotWechat({ wxid, userName: null, avatar: null }, creds, session.slot) }',
    to: '      return { state: session.state, binding: bindClawbotWechat({ wxid, userName: null, avatar: null }) }',
    spec: 'src/backend/wechat-data/tests/clawbot-remotes.spec.ts',
  },
  {
    id: 'M463-clawbot-baseurl-host-check-dropped',
    why: '只判协议不判域 ⇒ 服务端回传的 baseurl 说去哪就去哪，「唯一主机」的台账与隐私承诺失真。判据：clawbot-ilink.spec.ts 的「越域 ⇒ 拒绝发送（零调用）」。',
    file: 'src/backend/wechat-data/src/query/clawbot/clawbot-ilink.ts',
    from: "  if (parsed.protocol !== 'https:' || !(host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com'))) {",
    to: "  if (parsed.protocol !== 'https:') {",
    spec: 'src/backend/wechat-data/tests/clawbot-ilink.spec.ts',
  },
  {
    id: 'M464-clawbot-unbind-keeps-credentials',
    why: '解绑不清凭证与游标 ⇒ 「解绑即停轮询」在存储侧失去保证（漏了停止位的循环还能发请求），且重新绑定时带的还是旧游标。判据：clawbot-binding.spec.ts 的「解绑：凭证与游标一并清空」。',
    file: 'src/backend/wechat-data/src/query/clawbot/clawbot-binding.ts',
    from: "      qr_expires_at = NULL, bot_token = NULL, ilink_bot_id = NULL, ilink_user_id = NULL, base_url = NULL,\n      sync_buf = NULL, send_context_token = NULL, session_epoch = session_epoch + 1, updated_at = ?\n      WHERE slot = ?`).run(now, now, slot)",
    to: "      qr_expires_at = NULL, session_epoch = session_epoch + 1, updated_at = ?\n      WHERE slot = ?`).run(now, now, slot)",
    spec: 'src/backend/wechat-data/tests/clawbot-binding.spec.ts',
  },
  {
    id: 'M465-clawbot-boot-hook-dropped',
    why: '网关启动钩子不再拉起通道 ⇒ 绑定过的用户在进程重启后**不会收消息**（直到他再打开面板或重新绑定）；收消息是宿主职责，不该靠界面提醒。判据：clawbot-remote-surface.spec.ts 的启动钩子接线断言。',
    file: 'src/backend/wechat-data/src/gateway-clawbot.ts',
    from: '  protected override bootClawbotChannel(): void {\n    this.clawbotRemotes().ensureClawbotChannel()\n  }',
    to: '  protected override bootClawbotChannel(): void { /* M465 变异：不拉通道 */ }',
    spec: 'src/backend/wechat-data/tests/clawbot-remote-surface.spec.ts',
  },
  {
    id: 'M466-clawbot-bind-state-dedupe-dropped',
    why: '状态轮询不再复用在途 promise ⇒ 界面并发的两次调用会打两次上游长轮询（40 秒一条，白白翻倍）。判据：clawbot-remotes.spec.ts 的「在途去重」用例。',
    file: 'src/backend/wechat-data/src/remotes/clawbot.ts',
    from: '      let pending = session.inFlight\n      if (pending === null) {',
    to: '      let pending: Promise<ClawbotBindStateSnapshot> | null = null\n      if (pending === null) {',
    spec: 'src/backend/wechat-data/tests/clawbot-remotes.spec.ts',
  },
  {
    id: 'M467-clawbot-stop-ignored-after-flight',
    why: '停通道后仍处理在飞响应（把 `if (!running) break` 摘掉）⇒ 解绑之后刚落地的消息还会被写进库并推事件（本该忽略）。判据：clawbot-channel.spec.ts 的「stop 后在飞请求的响应被忽略」。',
    file: 'src/backend/wechat-data/src/query/clawbot/clawbot-channel.ts',
    from: '      if (!running || signal.aborted) break\n\n      const stale = batch !== undefined && !batch.isCurrent()',
    to: '      // M467 变异：停止位不再拦在飞响应\n\n      const stale = batch !== undefined && !batch.isCurrent()',
    spec: 'src/backend/wechat-data/tests/clawbot-channel.spec.ts',
  },
  {
    id: 'M468-clawbot-send-records-rejected-text',
    why: '服务端拒绝（ret≠0）时也把正文落库（判据只拦 -999）⇒ 列表里出现「已发出」的假记录，用户以为对方看到了。判据：clawbot-remotes.spec.ts 的「拒绝不落库」。',
    file: 'src/backend/wechat-data/src/remotes/clawbot.ts',
    from: '  if (resp.ret !== 0) {\n    return { ok: false, id: null, error: `发送被服务端拒绝（ret=${String(resp.ret)}${resp.errMsg !== \'\' ? \'：\' + resp.errMsg : \'\'}）` }\n  }',
    to: '  if (resp.ret === -999) {\n    return { ok: false, id: null, error: `发送被服务端拒绝（ret=${String(resp.ret)}${resp.errMsg !== \'\' ? \'：\' + resp.errMsg : \'\'}）` }\n  }',
    spec: 'src/backend/wechat-data/tests/clawbot-remotes.spec.ts',
  },
  {
    id: 'M469-clawbot-send-drops-context-token',
    why: '发送帧不带上最近入站消息的会话令牌（写空串）⇒ 服务端收不到上下文，回复发不出去；字段在、值没了，肉眼很难发现。判据：clawbot-ilink.spec.ts 的发送帧形状逐字段断言。',
    file: 'src/backend/wechat-data/src/query/clawbot/clawbot-ilink.ts',
    from: '        context_token: out.contextToken,',
    to: "        context_token: '',",
    spec: 'src/backend/wechat-data/tests/clawbot-ilink.spec.ts',
  },
  {
    id: 'M470-clawbot-send-to-bot-instead-of-user',
    why: '把收件人写成 bot 自己（`to_user_id = ilinkBotId`）⇒ 消息发进了错误的会话；这条不会报错、只会「对方一直没收到」。判据：clawbot-ilink.spec.ts 的发送帧逐字段断言（to_user_id 必须是微信用户）。',
    file: 'src/backend/wechat-data/src/query/clawbot/clawbot-ilink.ts',
    from: '        to_user_id: out.toUserId,',
    to: '        to_user_id: credentials.ilinkBotId,',
    spec: 'src/backend/wechat-data/tests/clawbot-ilink.spec.ts',
  },
  {
    id: 'M471-clawbot-media-host-check-dropped',
    why: '图片自带的明文地址不再过主机白名单 ⇒ 消息内容（可被离线改写的文件）就能指定我们去哪台主机取字节，台账与隐私声明失真。判据：clawbot-media.spec.ts 的「越域地址拒发且零请求」。',
    file: 'src/backend/wechat-data/src/query/clawbot/clawbot-media.ts',
    from: '    if (!wechatCdnHostAllowed(media.ref)) {',
    to: '    if (media.ref === \'\') {',
    spec: 'src/backend/wechat-data/tests/clawbot-media.spec.ts',
  },
  {
    id: 'M472-clawbot-media-key-hex-step-dropped',
    why: '密钥解析少走一步（base64 出来直接当密钥）⇒ 所有加密附件都解不开，症状是「图片打不开、语音播不了」而请求一切正常。判据：clawbot-media.spec.ts 的 decryptMediaBytes 往返。',
    file: 'src/backend/wechat-data/src/query/clawbot/clawbot-media.ts',
    from: "  const keyHex = Buffer.from(keyBase64, 'base64').toString('utf8')",
    to: '  const keyHex = keyBase64',
    spec: 'src/backend/wechat-data/tests/clawbot-media.spec.ts',
  },
  {
    id: 'M473-clawbot-media-cache-never-hits',
    why: '缓存命中被写死成永不命中 ⇒ 每次点开都重新下载（同一张图看三遍 = 三倍流量与请求），而界面完全看不出来。判据：clawbot-media.spec.ts 的「第二次不再联网」。',
    file: 'src/backend/wechat-data/src/query/clawbot/clawbot-media.ts',
    from: "  const hit = names.find((f) => f.startsWith(prefix) && !f.endsWith('.part'))",
    to: '  const hit = names.find(() => false)',
    spec: 'src/backend/wechat-data/tests/clawbot-media.spec.ts',
  },
  {
    id: 'M474-clawbot-media-auto-enqueue-dropped',
    why: '收到附件消息后不再自动入队 ⇒ 附件永不自动取回，界面永远停在「等待取回…」（而消息照收、界面不报任何错）；用户要求「自行下载好」的核心正是这一步。判据：clawbot-remotes.spec.ts 的「附件消息落库后要自动排队取回」。',
    file: 'src/backend/wechat-data/src/remotes/clawbot.ts',
    from: '      if (inserted !== null && inserted.mediaIds.length > 0) mediaQueue.enqueue(inserted.mediaIds)',
    to: '      // M474 变异：不入队',
    spec: 'src/backend/wechat-data/tests/clawbot-remotes.spec.ts',
  },
  {
    id: 'M475-clawbot-media-boot-sweep-dropped',
    why: '启动补扫被摘掉 ⇒「上次没取完 / 当时断网」的附件再也没人补（持久性依赖它会修一次缺口）。判据：clawbot-remotes.spec.ts 的「启动补扫要把待取附件拉起来」。（2026-10-13：`ensureClawbotChannel` 搬进 `createBindFlow` 后改调注入的 `sweepMedia()`，锚点跟随实现。）',
    file: 'src/backend/wechat-data/src/remotes/clawbot.ts',
    from: '    if (started > 0) sweepMedia()',
    to: '      // M475 变异：不补扫',
    spec: 'src/backend/wechat-data/tests/clawbot-remotes.spec.ts',
  },
  {
    id: 'M476-clawbot-media-retry-cap-raised',
    why: '把可重试错误的上限从 3 抬到 99 ⇒ 断网时同一条附件连打 99 次请求（日志与连接都被刷爆）。判据：clawbot-media-queue.spec.ts 的「同一次运行最多试 MAX 次」。',
    file: 'src/backend/wechat-data/src/query/clawbot/clawbot-media-queue.ts',
    from: 'export const MAX_MEDIA_ATTEMPTS = 3',
    to: 'export const MAX_MEDIA_ATTEMPTS = 99',
    spec: 'src/backend/wechat-data/tests/clawbot-media-queue.spec.ts',
  },
  {
    id: 'M477-clawbot-media-permanent-retried',
    why: '把「永久失败不重试」写反 ⇒ 超限/解密坏的附件每次入队都再试一遍（白流量 + 日志噪音），而这正是分类存在的理由。判据：clawbot-media-queue.spec.ts 的「permanent 一次即计失败」。',
    file: 'src/backend/wechat-data/src/query/clawbot/clawbot-media-queue.ts',
    from: '      if (r.permanent === true) {',
    to: '      if (r.permanent === false) {',
    spec: 'src/backend/wechat-data/tests/clawbot-media-queue.spec.ts',
  },
]
