/**
 * 变异登记 · **远程动作门控台账（M10）**（2026-10-14，M571 起）。
 *
 * M10 交付的是「白名单审计矩阵」，而矩阵一旦只躺在文档里就会腐烂 —— 这一批钉的就是
 * 让文档与台账脱钩的那几种改法：
 *
 *   M571 把 `getPaymentStatus` 退回 A 类凭据：手机上聊天里的转账/红包卡片读不出状态，
 *        而它读的数据 `getRecords` / `getMessages` 本来就允许远程读（挡不住任何秘密）。
 *   M572 手机上自动发起「建索引」的那道判断被删 ⇒ 每次搜索都打一次十分钟档的重活并被拒。
 *   M573 知识库「添加文件」的降级写法被删 ⇒ 手机上出现一个只能吃闭门按钮。
 *   M574 台账里记的**覆盖点**被改掉（聊天页导出菜单项的禁用写法换了形状）⇒ 那条台账变成谎报，
 *        被它覆盖的 `chats-export.tsx` 实际已经没人挡了。
 *   M575 台账键名被改 ⇒ 等于把那条免检牌悄悄删掉。
 *
 * @module mutations-registry/batch3za
 */
export const MUTATIONS_BATCH3ZA = [
  {
    id: 'M571-payment-status-pushed-back-to-credentials',
    why: '把 `getPaymentStatus` 从白名单里摘掉（它 2026-10-14 才从 A 类凭据里改判出来）：手机上聊天里的转账/红包卡片读不出权威状态，而它读的就是 `getRecords` 同一份本地库 —— 分类错了不只是难看，它会让一个纯读接口在手机上变成缺陷。判据：http-remote-policy.spec.ts 的 mustAllow + 完整二分。',
    file: 'src/backend/http-remote-policy.js',
    from: "    'getCalls', 'resolveChatHistory', 'getSelfUsername', 'getRevoked', 'getPaymentStatus',",
    to: "    'getCalls', 'resolveChatHistory', 'getSelfUsername', 'getRevoked',",
    spec: 'src/backend/tests/http-remote-policy.spec.ts',
  },
  {
    id: 'M572-phone-auto-builds-search-index',
    why: '删掉「手机上不自动建索引」那半个条件 ⇒ 手机上一发搜索就顺带打一次 `buildSearchIndex`（十分钟档重活、刻意不入白名单），既被拒又和桌面端抢同一个 worker。判据：remote-action-gating.wiring.spec.ts 的 ②（降级写法必须是真写法，只剩一个 import 不算）。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-msg-search.tsx',
    from: '  if (!msgIndexed && !indexBuilding && !desktopAction()) void buildIndex(true)',
    to: '  if (!msgIndexed && !indexBuilding) void buildIndex(true)',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/remote-action-gating.wiring.spec.ts',
  },
  {
    id: 'M573-kb-add-files-button-ungated',
    why: '知识库「添加文件」按钮去掉降级属性组 ⇒ 手机上出现一个只能吃到「不开放远程访问」的按钮（入参是本机文件路径，远程端根本给不出）。判据：remote-action-gating.wiring.spec.ts 的 ②。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/kb-files-panel.tsx',
    from: 'onClick={() => { void addFiles() }} disabled={adding} {...desktopActionProps()}',
    to: 'onClick={() => { void addFiles() }} disabled={adding}',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/remote-action-gating.wiring.spec.ts',
  },
  {
    id: 'M574-ledger-covering-needle-rotted',
    why: '台账里写的覆盖点（聊天页「导出消息」菜单项的禁用写法）被改掉 ⇒ 台账还在、覆盖却已经不存在，被它免检的 `chats-export.tsx` 于是没人挡了。判据：remote-action-gating.wiring.spec.ts 的 ①（needle 必须真的搜得到）。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-head-actions.tsx',
    from: 'className={csscards.msgHeaderMoreItem} disabled={exporting || desktopAction()}',
    to: 'className={csscards.msgHeaderMoreItem} disabled={exporting}',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/remote-action-gating.wiring.spec.ts',
  },
  {
    id: 'M575-ledger-key-renamed-away',
    why: '把台账的键名改一个字母（等于悄悄删掉那条免检牌，同时留下一条指向不存在的文件的记录）⇒ `settings-state.tsx` 那 19 个仅桌面调用立刻没人认领。判据：remote-action-gating.wiring.spec.ts 的 ① + 哨兵。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/remote-action-gating.wiring.spec.ts',
    from: "  'settings-state.tsx': {",
    to: "  'settings-stateX.tsx': {",
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/remote-action-gating.wiring.spec.ts',
  },
  {
    id: 'M576-server-error-conflated-with-unauthorized',
    why: '把「服务在但回了 5xx」也判成会话失效 ⇒ 电脑上后端崩一次，手机上就被踢回令牌门并被告知「请重新扫码」，而令牌其实还好好的（真机反例：杀掉应用后弹的就是这句说错原因的话）。判据：http-remote.spec.ts 的 probeSession 三态 + 那条「连不上 ≠ 会话没了」的行为用例。',
    file: 'src/client/ui-app/http-remote.ts',
    from: "    return res.status === 401 || res.status === 403 ? 'gone' : 'unreachable'",
    to: "    return 'gone'",
    spec: 'src/client/ui-app/http-remote.spec.ts',
  },
  {
    id: 'M577-has-session-strict-ok',
    why: '首屏探测改回「只有 ok 才放行」⇒ 服务暂时没在跑时手机上是一个走不通的令牌门，而不是一句「连不上电脑上的 Super Time，正在重试」的横幅。判据：http-remote.spec.ts 的 hasSession（抛错必须为 true）。',
    file: 'src/client/ui-app/http-remote.ts',
    from: "  return (await probeSession()) !== 'gone'",
    to: "  return (await probeSession()) === 'ok'",
    spec: 'src/client/ui-app/http-remote.spec.ts',
  },
  {
    id: 'M578-banner-cleared-only-by-probe',
    why: '把重连成功时的「撤横幅」那一行删掉 ⇒ 电脑上的应用回来之后，手机上仍挂着「连不上电脑上的 Super Time，正在重试」：服务端回来后 EventSource 自己就连上了、不再 onerror，那条退避探测路径根本不会再走一遍（真机实测：横幅挂了一分多钟）。判据：http-remote.spec.ts 的 es.open() 那一步。',
    file: 'src/client/ui-app/http-remote.ts',
    from: "  es.onopen = () => {\n    probeGap = 1_000\n    setUnreachable(false)",
    to: "  es.onopen = () => {\n    probeGap = 1_000",
    spec: 'src/client/ui-app/http-remote.spec.ts',
  },
]

