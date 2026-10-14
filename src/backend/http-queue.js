/**
 * 远程调用的**并发闸与排队**。
 *
 * ## 为什么必须有它
 *
 * 后端 worker 是**单线程**的（Electron 的 `utilityProcess`，一个进程一份事件循环），
 * 而手机端与桌面端**共用同一个 worker**。本机已经踩过一次独占事故：内联分析对每条语音
 * 消息跑**同步** whisper 转写，2–4 秒零让出，把毫秒级的 `getSessions` 顶到 2202ms ——
 * 用户报的是「消息很慢、会话列表更慢」，真凶却是排队排在重活后面。
 *
 * 远程访问把这件事放大：手机上点一个「重建索引」或「批量取原图」，那是**10 分钟档**的
 * 长任务（见 `backend-rpc.js` 的 `LONG_CALL_METHODS`）。若不限并发，一台手机连点几下
 * 就能把 worker 占满，桌面端界面整体卡死 —— 而桌面端用户完全看不出是谁干的。
 *
 * 所以：**并发上限 2 + FIFO 排队 + 队列长度上限**。上限之外立刻回一句可读的错误，
 * 而不是让请求无声地堆着（堆着的请求在手机上表现为「一直转圈」，最难排查）。
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
 * 建一个 FIFO 并发闸。
 *
 * @param {object} [opts]
 * @param {number} [opts.concurrency] - 并发上限（默认 {@link REMOTE_CALL_CONCURRENCY}）。
 * @param {number} [opts.maxQueued] - 排队上限（默认 {@link REMOTE_QUEUE_MAX}）。
 * @returns 队列句柄。
 */
function createCallQueue(opts = {}) {
  const concurrency = Number.isFinite(opts.concurrency) && opts.concurrency > 0
    ? Math.floor(opts.concurrency)
    : REMOTE_CALL_CONCURRENCY;
  const maxQueued = Number.isFinite(opts.maxQueued) && opts.maxQueued >= 0
    ? Math.floor(opts.maxQueued)
    : REMOTE_QUEUE_MAX;

  let active = 0;
  /** @type {Array<{ task: () => unknown, resolve: Function, reject: Function }>} */
  const waiting = [];
  /** 累计拒绝数（队列满）：给状态端点用，也是「上限设小了」的唯一证据。 */
  let rejected = 0;

  function pump() {
    while (active < concurrency && waiting.length > 0) {
      const item = waiting.shift();
      active += 1;
      // 用 Promise.resolve().then 包一层：task 同步抛错时也要走到 finally，
      // 否则 active 永远不会减回来 —— 那是「队列卡死、之后所有请求都排队」的经典形状。
      Promise.resolve()
        .then(item.task)
        .then(
          (value) => { active -= 1; item.resolve(value); pump(); },
          (err) => { active -= 1; item.reject(err); pump(); },
        );
    }
  }

  return {
    /**
     * 排队执行一个任务。
     * @param {() => unknown} task - 要跑的活（通常是 `() => gatedWechatCall(...)`）。
     * @returns 任务的结果；**队列满时 reject**，错误带 `code: 'REMOTE_BUSY'`。
     */
    run(task) {
      return new Promise((resolve, reject) => {
        if (waiting.length >= maxQueued) {
          rejected += 1;
          const err = new Error(
            `远程调用太密集（已有 ${active} 个在跑、${waiting.length} 个在排队），请稍后再试`,
          );
          err.code = 'REMOTE_BUSY';
          reject(err);
          return;
        }
        waiting.push({ task, resolve, reject });
        pump();
      });
    },
    /** 清空排队中的请求（关停服务时调用；已在跑的那几个让它们自己跑完）。 */
    drain(reason) {
      const queued = waiting.splice(0, waiting.length);
      for (const item of queued) {
        const err = new Error(reason || '远程访问服务已停止');
        err.code = 'REMOTE_GONE';
        item.reject(err);
      }
      return queued.length;
    },
    stats() {
      return { active, queued: waiting.length, rejected, concurrency, maxQueued };
    },
  };
}

module.exports = { REMOTE_CALL_CONCURRENCY, REMOTE_QUEUE_MAX, createCallQueue };
