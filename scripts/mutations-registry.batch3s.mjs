/**
 * 变异登记 · **局域网远程访问（手机端）的 HTTP 服务**（2026-10-14，M527 起）。
 *
 * 这是本仓第一个**入站**网络面：本机开始监听端口，局域网里别的设备持令牌就能读到微信数据。
 * 它的失效方式几乎全是静默的 —— 令牌比对口径松一格、白名单判定挪到调用之后、
 * 许可校验抛异常时变成放行、并发上限写大、事件转发那一行被摘掉（手机上数据不再实时刷新，
 * 而界面看起来完全正常）—— 每一种都不报错、不崩、功能照跑，只是**暴露面悄悄变大**或
 * **实时性悄悄失效**。所以这一批的靶子全部选在「静默变坏」的那一行上。
 *
 * 九条各咬一处，都是**单行锚点**：
 *   M527 定长比对退回普通比较（令牌可被计时侧信道逐字符猜）；
 *   M528 空令牌允许匹配（「还没启用」变成「谁都进得来」）；
 *   M529 许可校验抛异常时改成放行（2026-09 修过的洞，HTTP 那条路会把它带回来）；
 *   M530 白名单判定失效（所有 194 个方法都对远程开放，含 API Key 与备份还原）；
 *   M531 启动条件少掉「令牌非空」（老配置遗留的 api_enabled:true 会把端口静默打开）；
 *   M532 并发上限抬高（手机能把单线程 worker 占满，桌面端界面被饿死）；
 *   M533 主进程不再把后端事件转发给 SSE（手机上 WAL 实时刷新链断在主进程这一环）；
 *   M534 SSE 的 payload 形状改了（渲染层那套「事件名 → CustomEvent」的分发全部失配）；
 *   M587 Host 头校验短路（域名型 Host 也能拿到静态页与 /api/auth，DNS rebinding 门户重开）。
 *
 * @module mutations-registry/batch3s
 */
export const MUTATIONS_BATCH3S = [
  {
    id: 'M527-remote-token-compare-not-constant-time',
    why: '令牌比对退回普通 buffer 比较 ⇒ 不再是定长比对，局域网里可用计时侧信道逐字符猜令牌（这一层是整个入站面上唯一的访问控制）。判据：http-auth.spec.ts 的「AST：确实用了 crypto.timingSafeEqual」。',
    file: 'src/backend/http-auth.js',
    from: '  return crypto.timingSafeEqual(a, b)',
    to: '  return a.equals(b)',
    spec: 'src/backend/tests/http-auth.spec.ts',
  },
  {
    id: 'M528-remote-empty-token-matches',
    why: '空串守卫被拿掉 ⇒ 「还没在桌面端生成令牌」的状态变成「谁都进得来」（空 vs 空会匹配成功）。判据：http-auth.spec.ts 的「空串一律不匹配」。',
    file: 'src/backend/http-auth.js',
    from: "  if (provided === '' || expected === '') return false;",
    to: '  if (false) return false;',
    spec: 'src/backend/tests/http-auth.spec.ts',
  },
  {
    id: 'M529-remote-license-exception-allows',
    why: '许可校验自身抛异常时改成**放行**（许可 JSON 损坏 / 读盘失败 / 指纹采集异常都会走到那个 catch）—— 这正是 2026-09 修掉的洞：闸门一旦出异常就完全失效。抽出共用实现后，HTTP 那条路少抄这个分支洞就回来了。判据：call-gates.spec.ts 的「校验自身抛异常 → 拒绝，不是放行」。',
    file: 'src/backend/call-gates.js',
    from: '  } catch (e) {',
    to: '  } catch (e) { if (true) return getWechatBackend().call(method, args);',
    spec: 'src/backend/tests/call-gates.spec.ts',
  },
  {
    id: 'M530-remote-whitelist-bypassed',
    why: '白名单判定失效 ⇒ 194 个 @Remote 方法全部对远程开放，含模型 API Key、许可证、备份还原、配置写入与「以用户身份给联系人发消息」。判据：http-server.spec.ts 的「白名单外的方法 → METHOD_NOT_ALLOWED_REMOTE，且根本没进后端」。',
    file: 'src/backend/http-server.js',
    from: '    if (!isRemoteSafe(method)) {',
    to: '    if (false) {',
    spec: 'src/backend/tests/http-server.spec.ts',
  },
  {
    id: 'M531-remote-listens-without-token',
    why: '启动条件少掉「令牌非空」这一半 ⇒ N24（2026-09-15）之前界面还暴露 api_enabled 时写下的那条遗留 `"api_enabled": true` 会让端口**在用户从未点过任何新开关的情况下**静默打开。判据：http-server.spec.ts 的「api_enabled=true 但没有令牌 → 不监听」。',
    file: 'src/backend/http-server.js',
    from: "    if (!cfg.enabled || cfg.token === '') {",
    to: '    if (!cfg.enabled) {',
    spec: 'src/backend/tests/http-server.spec.ts',
  },
  {
    id: 'M532-remote-concurrency-cap-raised',
    why: '并发上限从 2 抬到 16 ⇒ 手机与桌面共用同一个单线程 worker，几个 10 分钟档的长调用就能把桌面界面饿死（本机踩过同款：同步 whisper 把 getSessions 顶到 2202ms）。判据：http-queue.spec.ts 的「缺省上限是 2」。',
    file: 'src/backend/http-queue.js',
    from: 'const REMOTE_CALL_CONCURRENCY = 2;',
    to: 'const REMOTE_CALL_CONCURRENCY = 16;',
    spec: 'src/backend/tests/http-queue.spec.ts',
  },
  {
    id: 'M533-remote-sse-forward-unwired',
    why: '主进程不再把后端事件转发给 SSE 客户端 ⇒ 手机上所有面板都不会实时刷新（WAL 推送链断在主进程这一环），而界面看起来完全正常、只是「数据不动」—— 与上一轮实时性事故同款症状，最难现场排查。判据：http-server.wiring.spec.ts 的「后端事件同时转发给 SSE 客户端」。',
    file: 'main.js',
    from: '  if (remoteAccess) remoteAccess.pushEvent(name, args);',
    to: '  void 0;',
    spec: 'src/backend/tests/http-server.wiring.spec.ts',
  },
  {
    id: 'M534-remote-sse-payload-shape-changed',
    why: 'SSE 的 payload 从 `{ name, args }` 改成别的形状 ⇒ 与 IPC 的 `wechat:event` 不再同形，渲染层那套「事件名 → DOM CustomEvent」的分发全部失配（7 个事件一个都收不到），而这正是「手机与桌面共用同一份渲染层」的前提。判据：http-server.spec.ts 的「SSE 事件流：形状必须与 IPC 的 wechat:event 一致」。',
    file: 'src/backend/http-server.js',
    from: '    for (const res of ctx.sseClients) writeSse(ctx.sseClients, res, { name, args });',
    to: '    for (const res of ctx.sseClients) writeSse(ctx.sseClients, res, { event: name, payload: args });',
    spec: 'src/backend/tests/http-server.spec.ts',
  },
  {
    id: 'M587-remote-host-check-bypassed',
    why: 'Host 校验被短路 ⇒ attacker.example 这类域名也能拿到静态页面并登录 /api/auth，DNS rebinding 门户重新打开。判据：http-server.spec.ts 的「带别的域名 Host 的静态与 /api/auth 请求都在路由前拒绝」。',
    file: 'src/backend/http-server.js',
    from: '    if (!isHostAllowed(req.headers.host, ctx.state.address, ctx.state.port)) {',
    to: '    if (true) {',
    spec: 'src/backend/tests/http-server.spec.ts',
  },
]
