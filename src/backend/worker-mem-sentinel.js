'use strict';
/**
 * worker 的**内存哨兵**（W3-1.2）。
 *
 * ## 它解决什么
 *
 * 后端 worker 是独立进程（`utilityProcess.fork`，见 main.js 的 `spawnBackendProcess`），
 * 一旦内存悄悄涨上去，主进程没有任何信号：面板转圈、日志里全是超时，而原因
 * 「RSS 1.4GB」要等用户截图任务管理器才发现。哨兵每 60 秒往诊断日志打一行
 * `rss/heap/external`，把「进程还活着吗、内存多少」变成可回看的事实。
 *
 * ## 三条设计约束（都是被真实场景逼出来的）
 *
 *   ① **只告警，不重启**。RSS 高了先让人看见：涨的原因可能是这一次性的全量年报，
 *   也可能是一个缓存泄漏，两者处置完全不同。自动重启会打断在跑的导出/解密 ——
 *   那是用户点了按钮正在等的事。所以本模块**不做任何进程操作**，只打印。
 *   ② **连续 3 次超限才告警**。单次超限很可能就是上面那种一次性峰值；
 *   连续三次（≈3 分钟）都在高位，才值得一句 `mem-warn`。
 *   ③ 三件事都**可注入**：时钟、`process.memoryUsage()`、`setInterval`。
 *   否则这条逻辑一天都测不了（单测里既不能等 60 秒，也不能真把自己吃到 1.2GB）。
 *
 * 本文件是 CommonJS：它被 `wechat-worker.js` 直接 require，而那是 CJS。
 */

/** 默认轮询间隔：60 秒。 */
const DEFAULT_INTERVAL_MS = 60_000;
/** 默认 RSS 上限：1.2GB。 */
const DEFAULT_RSS_LIMIT_BYTES = 1.2 * 1024 * 1024 * 1024;
/** 连续超限多少次才告警。 */
const DEFAULT_STRIKES = 3;

/**
 * 把字节数格式成 MB/GB（诊断日志里人眼能读）。
 * @param {number} b - 字节数。
 * @returns {string} 例：`1.34GB` / `812MB`。
 */
function fmtBytes(b) {
  const n = Number(b) || 0;
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + 'GB';
  return Math.round(n / 1024 / 1024) + 'MB';
}

/**
 * 建一个内存哨兵。
 *
 * @param {{
 *   log?: (level: string, args: unknown[]) => void,
 *   now?: () => number,
 *   memoryUsage?: () => { rss: number, heapUsed: number, heapTotal: number, external: number },
 *   setIntervalFn?: (fn: () => void, ms: number) => unknown,
 *   clearIntervalFn?: (h: unknown) => void,
 *   extra?: () => string,
 *   gc?: () => void,
 *   intervalMs?: number,
 *   rssLimitBytes?: number,
 *   strikes?: number,
 * }} [deps] 全部可注入；缺省用真实全局（生产）或无操作（测试不传就不会有真定时器）。
 *   `extra` 是拼在 `[mem]` 行尾的附加信息（当前用于受控缓存占用 `caches=…`）；
 *   `gc` 非空时**每次采样前先强制 GC**（诊断用，配合 `--expose-gc` 区分「未回收垃圾」与「真保留」）。
 * @returns {{ start: () => void, stop: () => void, sample: () => unknown, ticks: () => number }} 哨兵。
 */
function createMemSentinel(deps = {}) {
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const extra = typeof deps.extra === 'function' ? deps.extra : () => '';
  const gc = typeof deps.gc === 'function' ? deps.gc : null;
  const memoryUsage = typeof deps.memoryUsage === 'function'
    ? deps.memoryUsage
    : () => process.memoryUsage();
  const intervalMs = Number(deps.intervalMs) > 0 ? Number(deps.intervalMs) : DEFAULT_INTERVAL_MS;
  const rssLimit = Number(deps.rssLimitBytes) > 0 ? Number(deps.rssLimitBytes) : DEFAULT_RSS_LIMIT_BYTES;
  const strikes = Number(deps.strikes) > 0 ? Math.floor(Number(deps.strikes)) : DEFAULT_STRIKES;
  const setIntervalFn = typeof deps.setIntervalFn === 'function' ? deps.setIntervalFn : () => 0;
  const clearIntervalFn = typeof deps.clearIntervalFn === 'function' ? deps.clearIntervalFn : () => {};

  /** 连续超限次数（掉到限以下就归零）。 */
  let over = 0;
  /** 已经采过几次（用于「哨兵是否真的在跑」的自证）。 */
  let count = 0;
  /** 是否已经为**这一轮**连续超限告警过（避免每 60 秒重复一句）。 */
  let warned = false;
  let handle = null;

  /** 采一次并记账。返回本次读数（测试与日志都用它）。 */
  const sample = () => {
    // 诊断模式：先强制 GC 再读数，读到的才是「真实保留」而不是「还没来得及回收」。
    if (gc !== null) {
      try { gc(); } catch { /* GC 失败不影响采样 */ }
    }
    const m = memoryUsage();
    const rss = Number(m && m.rss) || 0;
    const arrayBuffers = Number(m && m.arrayBuffers) || 0;
    const isOver = rss > rssLimit;
    if (isOver) over += 1;
    else { over = 0; warned = false; }
    count += 1;
    const at = now();
    // 附加信息（缓存占用等）自己失败不能影响内存采样本身。
    let extraText = '';
    try {
      extraText = String(extra() ?? '').trim();
    } catch { /* 附加信息不可用就不打 */ }
    log('mem', [
      `[mem] rss=${fmtBytes(rss)} heapUsed=${fmtBytes(m && m.heapUsed)}`
      + ` heapTotal=${fmtBytes(m && m.heapTotal)} external=${fmtBytes(m && m.external)}`
      + ` arrayBuffers=${fmtBytes(arrayBuffers)}`
      + ` over=${isOver ? 'yes' : 'no'} (limit=${fmtBytes(rssLimit)}, ${isOver ? over : 0}/${strikes})`
      + ` t=${new Date(at).toISOString()}`
      + (extraText === '' ? '' : ' ' + extraText),
    ]);
    // 连续 ${strikes} 次超限才告警；单次峰值往往就是一次性的全量年报，不值得叫。
    if (over >= strikes && !warned) { warned = true; log('mem-warn', [`[mem-warn] rss=${fmtBytes(rss)} 超限 ${over} 次连续（限 ${fmtBytes(rssLimit)}）—— 只告警，不重启`]); }
    return { rss, heapUsed: Number(m && m.heapUsed) || 0, external: Number(m && m.external) || 0, arrayBuffers, over: isOver, at, extra: extraText };
  };

  return {
    start() {
      if (handle !== null) return;
      // 立刻采一次：重启后第一行日志就是当时的内存，而不是干等 60 秒。
      sample();
      handle = setIntervalFn(sample, intervalMs);
    },
    stop() {
      if (handle === null) return;
      clearIntervalFn(handle);
      handle = null;
    },
    sample,
    ticks: () => count,
  };
}

module.exports = { createMemSentinel, fmtBytes, DEFAULT_INTERVAL_MS, DEFAULT_RSS_LIMIT_BYTES, DEFAULT_STRIKES };
