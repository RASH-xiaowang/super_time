'use strict';

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
 *   主 → worker：{ id, type: 'init' | 'call' | 'dispose', payload }
 *   worker → 主：{ id, value } / { id, error: { message } } / { type: 'event', name, args }
 */

/** 普通调用的默认窗口。 */
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
/** 已知分钟级任务的窗口（导出、全量解密、批量转写、建索引、备份恢复）。 */
const DEFAULT_LONG_CALL_TIMEOUT_MS = 10 * 60_000;

/**
 * 需要更宽窗口的 Remote 方法。
 *
 * **这份名单必须始终是 gateway 里真实存在的 @Remote 方法名子集**，
 * 由 src/backend/tests/backend-rpc.spec.ts 直接从 gateway.ts 抽 @Remote 名单来校验。
 * 初版这里写了 `decryptImages` / `generateAnnualReport` 两个**不存在**的名字
 * （真名是 `decryptAllImages` / `getAnnualReport`），于是那些方法拿不到宽窗口；
 * 而写错方法名不会报任何错，只会静默退化 —— 那个测试就是为此加的。
 */
const LONG_CALL_METHODS = new Set([
  // 导出：大量写盘 + 压缩
  'exportSessionMessages', 'exportCsv', 'exportAnnualReport', 'exportAllSessions', 'exportMoments', 'exportSnsVideo',
  // 备份与恢复：整库拷贝
  'createBackup', 'createEncryptedBackup', 'restoreBackup', 'previewBackup', 'deleteBackup',
  // 解密：全量读 + 写
  'decryptAllDatabases', 'decryptAllImages', 'autoGetDbKey', 'autoGetImageKey',
  // 媒体取数：命中不了缓存时会退化成对整个 cache/<月>/Sns 乃至 msg/attach 做
  // 全量「读文件 + 解密 + 哈希」，实测单次 12–21 秒（getSnsImageDataUrl 那句注释
  // 就是它）。60 秒只有约 3 倍余量，冷启动/大库上不够稳；这类方法本身有负缓存，
  // 放宽代价是「真卡住时晚一点报错」，比误杀划算。
  'getSnsImageDataUrl', 'getSnsVideoCoverDataUrl', 'getSnsVideoDataUrl',
  'getArticleCover', 'getImageDataUrl', 'getFileImageDataUrl', 'getEmoticonDataUrl', 'getImageOriginal',
  // 语音转写：whisper 本地推理
  'transcribeVoiceBatch', 'transcribeVoiceMessage',
  // 索引与离线评估
  'buildSearchIndex', 'buildRagVectorIndex', 'buildKbVectorIndex', 'evaluateRetrieval',
  // LLM 长任务。仓库自身 LLM 超时默认 120 秒（wechat-host.js 的 timeoutMs），
  // RPC 窗口必须明显宽于它，否则「模型还在流式输出」就先被判成调用超时。
  'askWechat', 'optimizeAskQuestion', 'runSummaryTask', 'generateDailySummary', 'generatePeriodSummary',
  'summarizeKbFile',
  // 实体抽取是一轮**最多 20 个文件**的串行 LLM 调用（每个文件一次），20 × 十几秒就能
  // 越过默认窗口；链接建议是一次 embedding 批量（最多 80 条短标题），慢的时候同样会超。
  'extractKbEntities', 'suggestKbLinks',
  // 年度报告/回顾：跨全年聚合，且可能触发 LLM
  'getAnnual', 'getAnnualReport', 'getAnnualReview',
  'syncHandoffTasks', 'extractTasks',
]);

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
    logger = console,
  } = options;

  /** @type {Map<number, {resolve: Function, reject: Function, timer: any}>} */
  const pending = new Map();
  let seq = 0;
  let deadReason = null;
  let exited = false;

  /** 进程死亡：在途请求全部 reject，并清掉各自的定时器（否则会留下悬空回调）。 */
  const failAll = (reason) => {
    deadReason = reason;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    pending.clear();
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
    const p = pending.get(msg.id);
    // 认领不到就丢弃：超时后我们已经把这条摘掉了，迟到的回包不能再 settle 一次。
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.value);
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
    dispose: () => {
      try { child.postMessage({ id: ++seq, type: 'dispose', payload: {} }); } catch { /* 可能已退出 */ }
      try { child.kill(); } catch { /* 尽力而为 */ }
    },
    /** 是否已判定死亡（含被动收到 exit）。 */
    get isDead() { return deadReason !== null; },
    /** 死亡原因（未死为 null）。 */
    get deadReason() { return deadReason; },
    /** 在途请求数（诊断用；超时后应回落）。 */
    get pendingCount() { return pending.size; },
  };
}

module.exports = {
  createWorkerChannel,
  callTimeoutFor,
  describeBudget,
  LONG_CALL_METHODS,
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_LONG_CALL_TIMEOUT_MS,
};
