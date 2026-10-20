/**
 * 变异登记 · **远程访问的控制面与设置卡片**（2026-10-14，M540 起）。
 *
 * 这一批守的是「用户唯一能改这个入站暴露面的入口」。七条靶子都朝**危险方向**失效，
 * 而且都不会报错：
 *   M540 轮换令牌时不再停服务 ⇒ 旧令牌换来的会话在 12 小时内仍然有效，
 *        而「轮换」的唯一现实理由恰恰是「旧令牌可能已经泄漏」（手机丢了、二维码被拍过）；
 *   M541 轮换时忘了同时打开开关 ⇒ 用户点了「启用并生成令牌」、拿到一个二维码，
 *        扫了却连不上（服务因为 api_enabled 仍是 false 而没有监听）；
 *   M542 卡片在浏览器态也渲染 ⇒ 手机上出现一屏「配置电脑怎么被手机访问」的死控件；
 *   M543 关掉开关后二维码还留在界面上 ⇒ 服务已经不监听了，却还摆着一个能扫的码，
 *        用户会以为仍然开着（这正是 N24「界面比没有界面更容易误导」的同一类问题）。
 *   M584–M586 守住 v14 的一次性配对码：成功消费必须删除、停服必须作废、
 *        一次成功登录不得给其他 IP 的限速窗口洗白。
 *
 * @module mutations-registry/batch3u
 */
export const MUTATIONS_BATCH3U = [
  {
    id: 'M540-rotate-keeps-old-sessions',
    why: '轮换令牌时不再先停服务 ⇒ 内存里的会话表没被清（stop() 内部才 revokeAll()），只 syncWithConfig 的话服务「已经在跑」时不会重启，旧令牌换来的会话在 TTL 内照样能进 —— 轮换就只是换了个字符串。判据：http-control.spec.ts 的「必须先 stop 再 sync」。',
    file: 'src/backend/http-control.js',
    from: '        await deps.remoteAccess.stop();',
    to: '        await Promise.resolve();',
    spec: 'src/backend/tests/http-control.spec.ts',
  },
  {
    id: 'M541-rotate-forgets-to-enable',
    why: '轮换时只写令牌、不同时打开开关 ⇒ 第一次启用的用户拿到二维码却连不上（服务因 api_enabled 仍为 false 而不监听），而界面上看不出任何异常。判据：http-control.spec.ts 的「按存配置→停服务→对齐的顺序走」里那条 patch 断言。',
    file: 'src/backend/http-control.js',
    from: '      const saved = await savePatch(deps, { api_token: token, api_enabled: true });',
    to: '      const saved = await savePatch(deps, { api_token: token });',
    spec: 'src/backend/tests/http-control.spec.ts',
  },
  {
    id: 'M584-pairing-code-reusable-after-success',
    why: '配对码登录成功后仍留在内存表里 ⇒ 被截图/嗅探过的同一张二维码可以反复换会话，而「一次性配对码」的全部价值就是压缩可重放窗口。判据：http-auth.spec.ts 的「配对码只许成功消费一次」。',
    file: 'src/backend/http-auth.js',
    from: '      entries.delete(hit.code);\n      return {',
    to: '      return { ok: true, attemptsLeft: 0 };',
    spec: 'src/backend/tests/http-auth.spec.ts',
  },
  {
    id: 'M585-stop-keeps-pairing-codes',
    why: 'stop() 不再作废未消费配对码 ⇒ 用户关闭/轮换后那张旧二维码在重开服务时仍能登录，而界面上说它已失效。判据：http-server.spec.ts 的「stop() 作废未消费的配对码」。',
    file: 'src/backend/http-server.js',
    from: '    ctx.pairings.revokeAll();',
    to: '',
    spec: 'src/backend/tests/http-server.spec.ts',
  },
  {
    id: 'M586-auth-success-resets-all-ips',
    why: '一次登录成功清掉所有来源 IP 的失败窗口 ⇒ 攻击者可从受控 IP 成功登录，再给其他 IP 重置限速计数，让脚本乱撞的限速失去意义。判据：http-server.spec.ts 的「成功只清当前 IP」。',
    file: 'src/backend/http-server.js',
    from: '    ctx.limiter.succeed(ip);',
    to: '    ctx.limiter.reset();',
    spec: 'src/backend/tests/http-server.spec.ts',
  },
]
