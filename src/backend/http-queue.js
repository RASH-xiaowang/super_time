/**
 * 后端调用的**并发闸与排队**（桌面 IPC 与手机 HTTP 共用）。
 *
 * ## 为什么必须有它
 *
 * 后端 worker 是**单线程**的（Electron 的 `utilityProcess`，一个进程一份事件循环），
 * 而手机端与桌面端**共用同一个 worker**。本机已经踩过一次独占事故：内联分析对每条语音
 * 消息跑**同步** whisper 转写，2–4 秒零让出，把毫秒级的 `getSessions` 顶到 2202ms ——
 * 用户报的是「消息很慢、会话列表更慢」，真凶却是排队排在重活后面。
 *
 * 远程访问把这件事放大：手机上点一个「重建索引」或「批量取原图」，那是**10 分钟档**的
 * 长任务（见 `remote-policy.js` 的 `LONG_CALL_METHODS`）。若不限并发，一台手机连点几下
 * 就能把 worker 占满，桌面端界面整体卡死 —— 而桌面端用户完全看不出是谁干的。
 * 反过来，只限制手机却让桌面 IPC 无限插队，等于把积压源头换了个入口。因此 `main.js`
 * 创建同一把闸同时喂给两条通道，状态端点再按 `channel` 区分 `remote` / `desktop`。
 *
 * 所以：**并发上限 2 + 按优先级排队 + 队列长度上限**。上限之外立刻回一句可读的错误，
 * 而不是让请求无声地堆着（堆着的请求在手机上表现为「一直转圈」，最难排查）。
 * 队列已满时交互档（首屏读与取消）可以挤出最后一个低优先级等待项：取消请求若因为
 * 低优先级任务先占满队列而拿不到 `REMOTE_BUSY`，就失去了把长任务停下来的最后机会。
 * 优先级来自 `call-priority.js`：首屏读与取消动作先跑；重活最多只占一个并发名额，
 * 另一个名额留给普通/交互请求 —— 单事件循环下这不能制造真并行，但能避免「两个长任务
 * 同时霸住两个名额，轻读只能干等」这一种最明显的饥饿。
 *
 * ## 为什么是 2 而不是 1 或 4
 *
 * 1 等于串行：手机上一张图没加载完，下一条消息就出不来，体感是「卡」。
 * 4 以上就开始与桌面端抢单线程 worker（桌面端自己也要发请求）。
 * 2 是本机在「手机不卡」与「桌面不被拖慢」之间的取值，与语音批量转写的
 * `TRANSCRIBE_CONCURRENCY = 2` 同一个理由、同一个数。
 *
 * @module backend/http-queue
 */

/** 同时在跑的远程调用上限。 */
const REMOTE_CALL_CONCURRENCY = 2;

/** 排队上限：超过就直接回错，而不是无限堆。 */
const REMOTE_QUEUE_MAX = 32;

/**
 * 重活的排队上限。
 *
 * 普通请求可以堆到 32 条（它们通常毫秒到秒级）；重活一条可能跑 10 分钟，
 * 允许远程或桌面端无界堆积重活会把 worker 的分钟级车道占满几个小时。
 * 这里单独给一个 4 条的上限：正在跑 1 条 + 排队 4 条，再多立刻 `REMOTE_BUSY`。
 */
const HEAVY_QUEUE_MAX = 4;

/**
 * 排队**等待**上限（不是执行上限）。
 *
 * 只限队列长度不够：队列一直不排空时，第 33 个之后会被拒，但已经在队里的请求可以
 * 无限等待，手机/桌面都只表现为「一直转圈」。这里给等待设一个硬上限，超时明确回
 * `QUEUE_WAIT_TIMEOUT`（与 Alpha 的 queue wait timeout 同一语义）。
 * 默认 240s，测试可注入短值；传 0 可禁用（只给确实需要无上限的调用方）。
 */
const QUEUE_WAIT_TIMEOUT_MS = 240_000;

const { HEAVY_PRIORITY, INTERACTIVE_PRIORITY, callPriorityFor } = require('./call-priority');

/** 时延样本的保留上限：足够算 p50/p95，又不让状态端点把整段历史都留着。 */
const RECENT_SAMPLE_MAX = 256;

/**
 * 算一组非负样本的摘要。样本为空时全部为 0，调用方不需要为「还没跑过」写分支。
 * @param {number[]} samples
 * @param {number} max - 历史最大值（保留它是因为样本列表可能已经滚出最大值）。
 */
function summarizeSamples(samples, max) {
  if (samples.length === 0) return { count: 0, totalMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.5) - 1))] ?? 0;
  const p95 = sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1))] ?? 0;
  return {
    count: samples.length,
    totalMs: samples.reduce((sum, value) => sum + value, 0),
    maxMs: Math.max(max, 0),
    p50Ms: p50,
    p95Ms: p95,
  };
}

/** 请求已经出队/被清空，等待超时 timer 必须撤销。 */
function clearItemTimer(item) {
  if (!item || item.timer === undefined) return;
  clearTimeout(item.timer);
  delete item.timer;
}

/** 给排队项挂等待超时 timer；`ms <= 0` 表示禁用。 */
function armWaitTimer(item, ms, onTimeout) {
  if (!(ms > 0)) return;
  const timer = setTimeout(() => { onTimeout(item) }, ms);
  // 不让一个纯排队 timer 把进程钉住（Electron 主进程退出时尤其重要）。
  if (typeof timer.unref === 'function') timer.unref();
  item.timer = timer;
}

/** 排队项等待超时：从队列摘除、计数并明确拒绝（绝不留下永远 pending 的 Promise）。 */
function expireWaitingItem(item, ctx) {
  const index = ctx.waiting.indexOf(item);
  // 已经出队/被 drain 掉：timer 是迟到的，忽略（出队路径会 clear）。
  if (index < 0) return;
  ctx.waiting.splice(index, 1);
  ctx.onExpire(item);
  const err = new Error(
    `排队等待超时（${item.method !== '' ? `方法 ${item.method}，` : ''}已等待 ${ctx.waitTimeoutMs}ms），请稍后再试`,
  );
  err.code = 'QUEUE_WAIT_TIMEOUT';
  item.reject(err);
  // 释放一个排队位后，若还有并发空位，让后面的请求有机会启动。
  ctx.pump();
}

/**
 * 建一个 FIFO 并发闸。
 *
 * @param {object} [opts]
 * @param {number} [opts.concurrency] - 并发上限（默认 {@link REMOTE_CALL_CONCURRENCY}）。
 * @param {number} [opts.maxQueued] - 排队上限（默认 {@link REMOTE_QUEUE_MAX}）。
 * @param {number} [opts.maxQueuedHeavy] - 重活排队上限（默认 {@link HEAVY_QUEUE_MAX}）。
 * @param {number} [opts.waitTimeoutMs] - 排队等待上限（默认 {@link QUEUE_WAIT_TIMEOUT_MS}；0 禁用）。
 * @param {() => number} [opts.now] - 时钟（测试注入；默认 Date.now）。
 * @returns 队列句柄。
 */
/** 从队列状态源生成一次不可变统计快照（保持既有字段形状）。 */
function queueStats(source) {
  const currentMs = source.now();
  const channels = {};
  for (const [name, value] of source.byChannel) {
    channels[name] = {
      ...value,
      active: 0,
      queued: 0,
    };
  }
  for (const item of source.waiting) {
    if (!channels[item.channel]) {
      channels[item.channel] = { rejected: 0, completed: 0, failed: 0, active: 0, queued: 0 };
    }
    channels[item.channel].queued += 1;
  }
  for (const record of source.running.values()) {
    if (!channels[record.channel]) {
      channels[record.channel] = { rejected: 0, completed: 0, failed: 0, active: 0, queued: 0 };
    }
    channels[record.channel].active += 1;
  }
  return {
    active: source.active,
    queued: source.waiting.length,
    rejected: source.rejected,
    concurrency: source.concurrency,
    heavyLimit: source.heavyLimit,
    activeHeavy: source.activeHeavy,
    maxQueued: source.maxQueued,
    maxQueuedHeavy: source.maxQueuedHeavy,
    waitTimeoutMs: source.waitTimeoutMs,
    waitTimedOut: source.waitTimedOut,
    queuedHeavy: source.waiting.reduce((count, item) => count + (source.isHeavy(item.priority) ? 1 : 0), 0),
    completed: source.completed,
    failed: source.failed,
    wait: summarizeSamples(source.waitSamples, source.maxWaitMs),
    execution: summarizeSamples(source.runSamples, source.maxRunMs),
    channels,
    activeCalls: [...source.running.values()].map((record) => ({
      channel: record.channel,
      method: record.method,
      enqueuedAt: record.enqueuedAt,
      startedAt: record.startedAt,
      priority: record.priority,
      waitMs: Math.max(0, record.startedAt - record.enqueuedAt),
      elapsedMs: Math.max(0, currentMs - record.startedAt),
    })),
    queuedCalls: source.waiting.map((item) => ({
      channel: item.channel,
      method: item.method,
      enqueuedAt: item.enqueuedAt,
      priority: item.priority,
      waitMs: Math.max(0, currentMs - item.enqueuedAt),
    })),
  };
}

function createCallQueue(opts = {}) {
  const concurrency = Number.isFinite(opts.concurrency) && opts.concurrency > 0
    ? Math.floor(opts.concurrency)
    : REMOTE_CALL_CONCURRENCY;
  const maxQueued = Number.isFinite(opts.maxQueued) && opts.maxQueued >= 0
    ? Math.floor(opts.maxQueued)
    : REMOTE_QUEUE_MAX;
  const maxQueuedHeavy = Number.isFinite(opts.maxQueuedHeavy) && opts.maxQueuedHeavy >= 0
    ? Math.floor(opts.maxQueuedHeavy)
    : HEAVY_QUEUE_MAX;
  const waitTimeoutMs = Number.isFinite(opts.waitTimeoutMs) && opts.waitTimeoutMs >= 0
    ? Math.floor(opts.waitTimeoutMs)
    : QUEUE_WAIT_TIMEOUT_MS;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;

  let active = 0;
  let seq = 0;
  let completed = 0;
  let failed = 0;
  let waitTimedOut = 0;
  let maxWaitMs = 0;
  let maxRunMs = 0;
  /** @type {Array<{ id: number, task: () => unknown, resolve: Function, reject: Function, channel: string, method: string, enqueuedAt: number, priority: number, timer?: ReturnType<typeof setTimeout> }>} */
  const waiting = [];
  /** @type {Map<number, { channel: string, method: string, enqueuedAt: number, startedAt: number, priority: number }>} */
  const running = new Map();
  const waitSamples = [];
  const runSamples = [];
  /** 累计拒绝数（队列满）：给状态端点用，也是「上限设小了」的唯一证据。 */
  let rejected = 0;
  let activeHeavy = 0;
  /** @type {Map<string, { rejected: number, completed: number, failed: number }>} */
  const byChannel = new Map();

  function channelOf(meta) {
    return typeof meta?.channel === 'string' && meta.channel !== '' ? meta.channel : 'local';
  }

  function methodOf(meta) {
    return typeof meta?.method === 'string' ? meta.method : '';
  }

  // 显式 priority 优先；没有时按方法名走统一分类（含按入参降级，见 call-priority.js）。
  function priorityOf(meta) {
    const explicit = Number(meta?.priority);
    if (Number.isInteger(explicit) && explicit >= 0 && explicit <= 9) return explicit;
    return callPriorityFor(methodOf(meta), meta?.args);
  }

  function isHeavy(priority) {
    return priority >= HEAVY_PRIORITY;
  }

  function counters(channel) {
    let value = byChannel.get(channel);
    if (!value) {
      value = { rejected: 0, completed: 0, failed: 0 };
      byChannel.set(channel, value);
    }
    return value;
  }

  /** 请求已经出队/被清空，等待超时 timer 必须撤销。 */
  const clearWaitTimer = clearItemTimer;

  function pushSample(samples, value) {
    samples.push(value);
    if (samples.length > RECENT_SAMPLE_MAX) samples.splice(0, samples.length - RECENT_SAMPLE_MAX);
  }

  function settle(item, ok) {
    const record = running.get(item.id);
    active -= 1;
    running.delete(item.id);
    if (!record) return;
    if (isHeavy(record.priority)) activeHeavy -= 1;
    const finishedAt = now();
    const waitMs = Math.max(0, record.startedAt - item.enqueuedAt);
    const runMs = Math.max(0, finishedAt - record.startedAt);
    maxWaitMs = Math.max(maxWaitMs, waitMs);
    maxRunMs = Math.max(maxRunMs, runMs);
    pushSample(waitSamples, waitMs);
    pushSample(runSamples, runMs);
    const channel = counters(record.channel);
    if (ok) {
      completed += 1;
      channel.completed += 1;
    } else {
      failed += 1;
      channel.failed += 1;
    }
  }

  // 从队首找到下一个「当前有资格运行」的任务；重活车道满时跳过它看后面。
  function takeNext() {
    for (let i = 0; i < waiting.length; i += 1) {
      if (active >= concurrency) return null;
      const item = waiting[i];
      if (!item) continue;
      if (isHeavy(item.priority) && activeHeavy >= heavyLimit) continue;
      clearWaitTimer(item);
      waiting.splice(i, 1);
      return item;
    }
    return null;
  }

  function pump() {
    while (active < concurrency) {
      const item = takeNext();
      if (!item) return;
      active += 1;
      if (isHeavy(item.priority)) activeHeavy += 1;
      const startedAt = now();
      running.set(item.id, {
        channel: item.channel,
        method: item.method,
        enqueuedAt: item.enqueuedAt,
        startedAt,
        priority: item.priority,
      });
      // task 同步抛错时也要走到结算路径，否则 active 永远不会减回来。
      Promise.resolve()
        .then(item.task)
        .then(
          (value) => { settle(item, true); item.resolve(value); pump(); },
          (err) => { settle(item, false); item.reject(err); pump(); },
        );
    }
  }

  const heavyLimit = concurrency > 1 ? concurrency - 1 : 1;

  const statsSource = {
    now,
    waiting,
    running,
    byChannel,
    isHeavy,
    concurrency,
    heavyLimit,
    maxQueued,
    maxQueuedHeavy,
    waitTimeoutMs,
    waitSamples,
    runSamples,
    get active() { return active; },
    get rejected() { return rejected; },
    get waitTimedOut() { return waitTimedOut; },
    get activeHeavy() { return activeHeavy; },
    get completed() { return completed; },
    get failed() { return failed; },
    get maxWaitMs() { return maxWaitMs; },
    get maxRunMs() { return maxRunMs; },
  };

  return {
    // 排队执行一个任务；队列满/等待超时时 reject（带 code）。
    run(task, meta = {}) {
      return new Promise((resolve, reject) => {
        const priority = priorityOf(meta);
        if (waiting.length >= maxQueued) {
          const last = waiting[waiting.length - 1];
          if (priority === INTERACTIVE_PRIORITY && last && last.priority > priority) {
            rejected += 1;
            counters(channelOf(last)).rejected += 1;
            waiting.pop();
            clearWaitTimer(last);
            const evicted = new Error('排队已满：该请求已被更高优先级请求挤出，请稍后再试');
            evicted.code = 'REMOTE_BUSY';
            last.reject(evicted);
          } else {
            rejected += 1;
            counters(channelOf(meta)).rejected += 1;
            const err = new Error(
              `远程调用太密集（已有 ${active} 个在跑、${waiting.length} 个在排队），请稍后再试`,
            );
            err.code = 'REMOTE_BUSY';
            reject(err);
            return;
          }
        }
        if (isHeavy(priority)) {
          const queuedHeavy = waiting.reduce((count, item) => count + (isHeavy(item.priority) ? 1 : 0), 0);
          if (queuedHeavy >= maxQueuedHeavy) {
            rejected += 1;
            counters(channelOf(meta)).rejected += 1;
            const who = methodOf(meta);
            const err = new Error(
              `重任务排队已满（${who !== '' ? `方法 ${who}，` : ''}已有 ${activeHeavy} 个在跑、${queuedHeavy} 个在排队），请稍后再试`,
            );
            err.code = 'REMOTE_BUSY';
            reject(err);
            return;
          }
        }
        const item = {
          id: ++seq,
          task,
          resolve,
          reject,
          channel: channelOf(meta),
          method: methodOf(meta),
          enqueuedAt: now(),
          priority,
        };
        waiting.push(item);
        if (waitTimeoutMs > 0) {
          armWaitTimer(item, waitTimeoutMs, (expired) => expireWaitingItem(expired, {
            waiting,
            waitTimeoutMs,
            pump,
            onExpire: (it) => {
              rejected += 1;
              waitTimedOut += 1;
              counters(it.channel).rejected += 1;
            },
          }));
        }
        // 稳定排序：同优先级仍 FIFO。
        waiting.sort((a, b) => (a.priority - b.priority) || (a.id - b.id));
        pump();
      });
    },
    // 清空排队中的请求（关停服务时调用；已在跑的那几个让它们自己跑完）。
    drain(reason, channel) {
      const keep = [];
      let drained = 0;
      for (const item of waiting) {
        if (channel === undefined || item.channel === channel) {
          clearWaitTimer(item);
          const err = new Error(reason || '远程访问服务已停止');
          err.code = 'REMOTE_GONE';
          item.reject(err);
          drained += 1;
        } else {
          keep.push(item);
        }
      }
      waiting.length = 0;
      waiting.push(...keep);
      return drained;
    },
    // 状态快照：保持原来的 `active/queued/rejected/concurrency/maxQueued`，另加时延/积压。
    stats() {
      return queueStats(statsSource);
    },
  };
}


module.exports = {
  REMOTE_CALL_CONCURRENCY,
  REMOTE_QUEUE_MAX,
  HEAVY_QUEUE_MAX,
  QUEUE_WAIT_TIMEOUT_MS,
  RECENT_SAMPLE_MAX,
  HEAVY_PRIORITY,
  callPriorityFor,
  createCallQueue,
};
