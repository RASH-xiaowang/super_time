/**
 * 变异登记 · **远程访问的控制面与设置卡片**（2026-10-14，M540 起）。
 *
 * 这一批守的是「用户唯一能改这个入站暴露面的入口」。四条靶子都朝**危险方向**失效，
 * 而且都不会报错：
 *   M540 轮换令牌时不再停服务 ⇒ 旧令牌换来的会话在 12 小时内仍然有效，
 *        而「轮换」的唯一现实理由恰恰是「旧令牌可能已经泄漏」（手机丢了、二维码被拍过）；
 *   M541 轮换时忘了同时打开开关 ⇒ 用户点了「启用并生成令牌」、拿到一个二维码，
 *        扫了却连不上（服务因为 api_enabled 仍是 false 而没有监听）；
 *   M542 卡片在浏览器态也渲染 ⇒ 手机上出现一屏「配置电脑怎么被手机访问」的死控件；
 *   M543 关掉开关后二维码还留在界面上 ⇒ 服务已经不监听了，却还摆着一个能扫的码，
 *        用户会以为仍然开着（这正是 N24「界面比没有界面更容易误导」的同一类问题）。
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
    id: 'M542-remote-card-rendered-in-browser',
    why: '浏览器态也渲染这张卡片 ⇒ 手机上出现一屏「配置电脑怎么被手机访问」的死控件（桥不存在，每个按钮点了都没反应），而 N24 的教训正是「界面上的开关比没有开关更容易误导」。判据：settings-remote-access.wiring.spec.ts 的「浏览器态整块不渲染」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/settings-remote-access.tsx',
    from: '  if (!api) return <React.Fragment />',
    to: '  if (false) return <React.Fragment />',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/settings-remote-access.wiring.spec.ts',
  },
  {
    id: 'M543-qr-survives-disable',
    why: '关掉开关后二维码仍留在界面上 ⇒ 服务已经不监听端口了，却还摆着一个「看起来能扫」的码，用户会以为远程访问还开着（与 M542 同一类误导，只是方向相反）。判据：settings-remote-access.wiring.spec.ts 的「关掉开关时作废二维码」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/settings-remote-access.tsx',
    from: '      if (!next) setQr(null)',
    to: '      if (false) setQr(null)',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/settings-remote-access.wiring.spec.ts',
  },
]
