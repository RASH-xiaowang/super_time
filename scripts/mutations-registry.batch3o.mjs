/**
 * 变异登记 · 内联分析的**异步转写**（2026-10-13，M514 起）。
 *
 * 用户报「消息同步慢、会话列表更慢」。根因（用户终端日志实锤）：`analyzeVisibleMessages`
 * 对每条语音消息做转写，而旧链路用 `spawnSync` 等 whisper —— 2–4 秒里 worker 被完全独占，
 * 所有查询排队（实测 `getSessions` 2202ms、`analyzeVisibleMessages` 连续 1.8–4.4s）。
 * 修法：分析路径换异步 spawn，whisper 在子进程跑时事件循环照常服务。
 * 这一批钉三处**最容易静默回退**的形状（回退后功能全好、只有「又变慢了」）：
 *   · 分析循环不再 await 转写器 ⇒ 同步调用回来了，whisper 期间 worker 又被独占；
 *   · remote 接回同步转写 ⇒ 同上（上层 await 一个同步结果照样是阻塞）；
 *   · whisper 入口退回同步 ⇒ 异步版的形状没了，事件循环自由失去出处。
 *
 * 每条都把「坏形状」注回去，要求指定 spec 的用例**当场变红**。
 *
 * @module mutations-registry/batch3o
 */
export const MUTATIONS_BATCH3O = [
  {
    id: 'M514-laya-transcribe-await-removed',
    why: '分析循环不再 await 转写器 ⇒ 同步阻塞回到 whisper 上：每条语音消息独占 worker 2–4 秒，消息查询/会话列表再次排队（用户报「新消息同步慢」的正主回退）。判据：laya-voice-transcribe-async.spec.ts 的「分析循环必须 await 转写器」。',
    file: 'src/backend/wechat-data/src/laya/analysis.ts',
    from: 'await input.transcribe(target.localId, svrId)',
    to: 'input.transcribe(target.localId, svrId) as never',
    spec: 'src/backend/wechat-data/tests/laya-voice-transcribe-async.spec.ts',
  },
  {
    id: 'M515-laya-remote-sync-transcriber-back',
    why: 'remote 接回同步转写（transcribeOneVoice）⇒ 上层再 await 也救不了：spawnSync 把 2–4s 的独占带回 worker。判据：laya-voice-transcribe-async.spec.ts 的「remote 必须接异步转写实现」。',
    file: 'src/backend/wechat-data/src/remotes/laya.ts',
    from: 'await transcribeOneVoiceAsync(',
    to: 'transcribeOneVoiceAsync(',
    spec: 'src/backend/wechat-data/tests/laya-voice-transcribe-async.spec.ts',
  },
  {
    id: 'M516-laya-whisper-async-shape-lost',
    why: 'whisper 的异步入口被改成同步（删掉 async/close 监听）⇒ 事件循环自由失去出处，转写期间的计时器/查询全部冻结。判据：laya-voice-transcribe-async.spec.ts 的「whisper 必须走异步 spawn」。',
    file: 'src/backend/wechat-data/src/query/voice-transcribe.ts',
    from: "child.on('close', (code) => resolve(code))",
    to: "child.on('exit', (code) => resolve(code))",
    spec: 'src/backend/wechat-data/tests/laya-voice-transcribe-async.spec.ts',
  },
  {
    id: 'M517-sessions-push-immediate-refresh-lost',
    why: '会话列表的「推送即刷」接线被拆（合并窗参数不再透传）⇒ 又回到 300ms 合并窗 + 节流闸排队：updated 事件出来到侧栏重排多出几百毫秒（用户要求「updated 一出来就立刻刷」的口径回退）。判据：paged-list.spec.ts 的「刷新节流间隔可被面板覆盖」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/hooks.tsx',
    from: "'dsh-wechat-data-updated', refreshDebounceMs ?? 300)",
    to: "'dsh-wechat-data-updated', 300)",
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/paged-list.spec.ts',
  },
]
