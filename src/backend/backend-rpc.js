'use strict';

const { LONG_CALL_METHODS } = require('./remote-policy');

/**
 * 后端 worker 的 RPC 通道：请求/响应配平、调用超时、进程死亡时收敛在途请求。
 *
 * 为什么要抽成独立模块：这段逻辑（超时摘除、响应与超时的竞态、进程死亡时清理
 * 定时器）原先住在 Electron 主进程里，只有手工 taskkill 才能观察，
 * 无法在 CI 里回归 —— 而它恰恰是「界面无限转圈」这类故障的唯一防线。
 * 把 child 做成注入参数后，可以用假 child 精确构造「永不回包」「回包晚于超时」
 * 「进程中途退出」等场景，确定性验证。
 *
 * 协议（与 src/backend/wechat-worker.js 对应）：
 *   主 → worker：{ id, type: 'init' | 'call' | 'cancel' | 'dispose', payload }
 *   worker → 主：{ id, value } / { id, error: { message } } /
 *     { id, type: 'canceled', value } / { type: 'event', name, args }
 */

/** 普通调用的默认窗口。 */
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
/** 已知分钟级任务的窗口（导出、全量解密、批量转写、建索引、备份恢复）。 */
const DEFAULT_LONG_CALL_TIMEOUT_MS = 10 * 60_000;
/**
 * dispose 握手窗口：等 worker 回 `{ id, value: { ok: true } }` 才 kill 的**上限**。
 *
 * 为什么不是「发了 dispose 就立刻 kill」：实测（真实 Electron `utilityProcess`）里
 * `postMessage({type:'dispose'})` 之后紧跟 `child.kill()`，worker 的 `case 'dispose'`
 * 分支与 `process.once('exit')` 兜底**都不会执行**，进程以 code=0 静默消失 ——
 * IPC 消息还排在系统调用队列里，信号已经到了。于是「退出前还原微信进程注入」这类
 * 必须做完的收尾被整体跳过，只留下一个事后才能发现的残留 marker。
 *
 * 设成 5 秒而不是「一直等」：worker 的 dispose 是同步的（还原注入 + 关句柄），
 * 正常毫秒级完成；只有 worker 已经卡死时才需要这个上限兜底 —— 那时 kill 本来就是
 * 唯一出路，等下去只会让窗口关不掉。
 */
const DEFAULT_DISPOSE_TIMEOUT_MS = 5_000;
/**
 * 保留多少条「已超时但尚未看到迟回包/取消回执」的幽灵调用。
 *
 * 幽灵调用没有回包上限：永不回包的调试注入就是故意不回来。用有界 Map 防长跑诊断
 * 把内存吃满，太老的条目仍会计入累计 `orphanCompletions` 之外的超时统计。
 */
const ORPHAN_TRACK_MAX = 256;

/**
 * 某个方法的超时窗口。
 * @param method - Remote 方法名。
 * @param options - 覆盖默认窗口与长任务集合（便于测试与现场调参）。
 */
function callTimeoutFor(method, options = {}) {
  const longMs = options.longTimeoutMs ?? DEFAULT_LONG_CALL_TIMEOUT_MS;
  const callMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const longMethods = options.longMethods ?? LONG_CALL_METHODS;
  return longMethods.has(method) ? longMs : callMs;
}

/** 把毫秒窗口写成可读文字（小于 1 秒时用毫秒，否则用秒）。 */
function describeBudget(timeoutMs) {
  return timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} 秒` : `${timeoutMs} 毫秒`;
}

/**
 * 为一个 worker 进程建立 RPC 通道。
 * @param child - 需具备 postMessage(msg) 与 kill()，并能派发 'message' / 'exit' 事件。
 * @param options - onEvent(name,args)、onExit(code,reason)、超时窗口、logger。
 * @returns init/call/dispose 与若干只读诊断字段。
 */
function createWorkerChannel(child, options = {}) {
  const {
    onEvent,
    onExit,
    callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
    longTimeoutMs = DEFAULT_LONG_CALL_TIMEOUT_MS,
    longMethods = LONG_CALL_METHODS,
    disposeTimeoutMs = DEFAULT_DISPOSE_TIMEOUT_MS,
    logger = console,
  } = options;

  /** @type {Map<number, {resolve: Function, reject: Function, timer: any}>} */
  const pending = new Map();
  /** @type {Map<number, {method: string, timedOutAt: number}>} */
  const orphaned = new Map();
  let seq = 0;
  let deadReason = null;
  let exited = false;
  let timedOut = 0;
  let orphanCompletions = 0;
  let cancelsSent = 0;
  let cancelsAcknowledged = 0;

  /** 把一条超时调用登记成「主进程已放弃、worker 可能仍在跑」的幽灵。 */
  const rememberOrphan = (id, method) => {
    if (orphaned.has(id)) orphaned.delete(id);
    orphaned.set(id, { method: String(method ?? ''), timedOutAt: Date.now() });
    timedOut += 1;
    if (orphaned.size > ORPHAN_TRACK_MAX) {
      const oldest = orphaned.keys().next();
      if (!oldest.done) orphaned.delete(oldest.value);
    }
  };

  /** 尽力把取消消息发进 worker；worker 拒绝/回包失败都不影响主进程已经放弃的事实。 */
  const sendCancel = (id, payload) => {
    try {
      child.postMessage({ id, type: 'cancel', payload });
      cancelsSent += 1;
    } catch (e) {
      logger.warn('[backend-rpc] 发送取消消息失败（worker 可能已退出）:', e?.message ?? e);
    }
  };

  /** 进程死亡：在途请求全部 reject，并清掉各自的定时器（否则会留下悬空回调）。 */
  const failAll = (reason) => {
    deadReason = reason;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    pending.clear();
    orphaned.clear();
  };

  child.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'event') {
      try {
        onEvent?.(msg.name, msg.args);
      } catch (e) {
        logger.warn('[backend-rpc] 事件回调异常:', e?.message ?? e);
      }
      return;
    }
    if (msg.type === 'canceled') {
      // 取消回执只在「真正被打断」时才算收敛；`ok:false`（没有 jobId / 已经跑完）仍要
      // 保留幽灵记录，等迟到的正常回包把 `orphanCompletions` 加上去。
      if (orphaned.has(msg.id) && msg.value?.ok === true) {
        orphaned.delete(msg.id);
        cancelsAcknowledged += 1;
      }
      return;
    }
    const p = pending.get(msg.id);
    // 认领不到就丢弃：超时后我们已经把这条摘掉了，迟到的回包不能再 settle 一次。
    if (p) {
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.value);
      return;
    }
    if (orphaned.has(msg.id)) {
      const ghost = orphaned.get(msg.id);
      orphaned.delete(msg.id);
      orphanCompletions += 1;
      logger.warn(`[backend-rpc] 超时调用已返回（主进程已放弃）：${ghost?.method || msg.id}`);
    }
  });

  child.on('exit', (code) => {
    if (exited) return;
    exited = true;
    const reason = `Super Time 后端进程已退出 (code=${code})`;
    failAll(reason);
    try {
      onExit?.(code, reason);
    } catch (e) {
      logger.error('[backend-rpc] 退出回调异常:', e?.message ?? e);
    }
  });

  const request = (type, payload, timeoutMs) => new Promise((resolve, reject) => {
    if (deadReason) {
      reject(new Error(deadReason));
      return;
    }
    seq += 1;
    const id = seq;
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      const what = type === 'call' ? payload?.method : type;
      const budget = describeBudget(timeoutMs);
      logger.warn(`[wechat] 调用超时（${budget}未返回）：${what}`);
      rememberOrphan(id, type === 'call' ? payload?.method : type);
      if (type === 'call') sendCancel(id, payload);
      reject(new Error(`调用超时（${budget}未返回）：${what}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      child.postMessage({ id, type, payload });
    } catch (e) {
      // 进程刚好在这时死掉：postMessage 会抛，同样要摘掉并清定时器。
      clearTimeout(timer);
      pending.delete(id);
      reject(e);
    }
  });

  return {
    /** 初始化。会加载 bundle、解析数据根，首次还可能触发 bootstrap，故按长任务给窗口。 */
    init: () => request('init', { userDataPath: options.userDataPath }, longTimeoutMs),
    call: (method, args) => request('call', { method, args }, callTimeoutFor(method, { callTimeoutMs, longTimeoutMs, longMethods })),
    dispose: (onDisposeDone) => {
      if (typeof onDisposeDone !== 'function') {
        throw new TypeError('createWorkerChannel: dispose 需要回调（用于等 worker 收尾完成）');
      }
      let settled = false;
      const id = ++seq;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(id);
        try { child.kill(); } catch { /* 已退出 */ }
        onDisposeDone();
      };
      // 超时兜底：worker 卡死时不能把退出路径无限挂住。此时 worker 自己没做完收尾，
      // marker 会在下次启动时如实报 cleanupUnconfirmed（见 query/wechat-image-autodownload.ts）。
      const timer = setTimeout(() => {
        logger.warn('[backend-rpc] dispose 等待超时，直接结束 worker（收尾可能未完成）');
        finish();
      }, disposeTimeoutMs);
      // 回包 = worker 侧收尾（还原注入、清 marker）已做完。
      pending.set(id, { resolve: finish, reject: finish, timer });
      try {
        child.postMessage({ id, type: 'dispose', payload: {} });
      } catch (e) {
        // 进程刚好死了：没有收尾可等，直接收摊。
        logger.warn('[backend-rpc] 发送 dispose 失败（worker 可能已退出）：', e?.message ?? e);
        finish();
      }
    },
    /** 是否已判定死亡（含被动收到 exit）。 */
    get isDead() { return deadReason !== null; },
    /** 死亡原因（未死为 null）。 */
    get deadReason() { return deadReason; },
    /** 在途请求数（诊断用；超时后应回落）。 */
    get pendingCount() { return pending.size; },
    /**
     * RPC 超时与幽灵工作账本。
     *
     * `timedOut` 是「主进程不再等」的次数；`orphanCompletions` 是其中确实晚到回包的次数；
     * `cancelsAcknowledged` 是 worker 成功认领取消的次数。三者分开看才能回答「超时到底是
     * 被停掉了、跑完了、还是仍挂着」。
     */
    stats() {
      return {
        pending: pending.size,
        timedOut,
        orphanCompletions,
        cancelsSent,
        cancelsAcknowledged,
        dead: deadReason !== null,
        orphanedCalls: [...orphaned.values()].map((value) => ({
          method: value.method,
          timedOutAt: value.timedOutAt,
        })),
      };
    },
  };
}

module.exports = {
  createWorkerChannel,
  callTimeoutFor,
  describeBudget,
  LONG_CALL_METHODS,
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_LONG_CALL_TIMEOUT_MS,
  DEFAULT_DISPOSE_TIMEOUT_MS,
  ORPHAN_TRACK_MAX,
};
