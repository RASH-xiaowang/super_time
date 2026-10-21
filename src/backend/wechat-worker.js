'use strict';

/**
 * 「Super Time」后端独立进程（Electron utilityProcess）。
 *
 * ## 为什么要把后端挪出主进程
 *
 * 全部 Remote 方法都建立在**同步**的 node:sqlite 之上，而个别方法实测
 * 单次耗时 12–21 秒：`getSnsImageDataUrl` 在哈希路径压不中时会退化成对整个
 * `cache/<月>/Sns/Img` 乃至 `msg/attach` 做全量「读取 + AES 解密 + MD5」扫描，
 * 并且没有负缓存，于是每调用一次就重扫一次。
 *
 * 这些调用原本跑在主进程里，直接卡住窗口消息泵 —— 实测单次事件循环阻塞
 * **45.6 秒**，Windows 在 5 秒无响应时就标记「应用未响应」。渲染进程自身
 * 只停顿了 ≤901ms，所以瓶颈确凿在主进程。
 *
 * 移到独立进程后，主进程只做 IPC 转发，重的查询再慢也只是那一个页签的数据
 * 晚到，窗口始终可以正常响应、切换、关闭。
 *
 * ## 协议
 *
 * 主进程 → 本进程：{ id, type: 'init' | 'call' | 'cancel' | 'dispose', payload }
 * 本进程 → 主进程：{ id, value } / { id, error } /
 *   { id, type: 'canceled', value } / { type: 'event', name, args }
 */

// 本进程的 stdout 继承自主进程（同一根管道）：父进程/终端先退出时日志会 EPIPE，
// 未处理就会让整个后端进程直接退出（表现为「Super Time 后端进程已退出」）。
require('./console-safe').install();

const { createWechatBackend } = require('./wechat-host');
const { createMemSentinel } = require('./worker-mem-sentinel');

// 后端进程启动留痕（主进程会把这一行转进 <STATE_DIR>/logs/app.log）。
// 为什么值得常驻一条：后端是独立进程 —— 它静默没起来、或起来又立刻死了，
// 界面上只表现成「功能不可用」；有一条带 pid 的启动行才好判断。
console.log('[wechat-worker] 后端进程已启动 pid=' + process.pid + ' node=' + process.versions.node);

// W3-1.2：内存哨兵。每 60 秒一行 rss/heap/external 进诊断日志，连续 3 次超过
// 1.2GB 才 mem-warn —— **只告警，不重启**（重启会打断用户正在等的导出/解密，
// 而涨的原因可能只是一次性的全量年报）。逻辑与判据见 worker-mem-sentinel.js
// 与 tests/worker-mem-sentinel.spec.ts。起不来就算了：观测设施不该拖垮后端。
try {
  // 2026-10-21（性能专项）：**必须把真实定时器传进去**。`createMemSentinel` 的缺省
  // `setIntervalFn` 是空函数（为了让单测不必真等 60 秒），此前这里只传了 `log`，
  // 于是生产环境只在 start() 时采一次、之后再也不会采 —— 诊断日志里的 `[mem]`
  // 永远只有启动那一行（基线实测 80s 运行仅 1 条，见 docs/perf/02-BASELINE.md §9-2），
  // 「worker 内存时间序列」因此一直读不到。
  createMemSentinel({
    log: (level, args) => console.log(String(args[0])),
    setIntervalFn: setInterval,
    clearIntervalFn: clearInterval,
  }).start();
} catch { /* 哨兵起不来不影响后端本身 */ }

let backend = null;
/** RPC id -> 正在执行的方法与参数；取消消息只有认领到这里才算真正打向当前那次调用。 */
const activeCalls = new Map();

/**
 * H7 验收的「永不回包」注入名单（`SUPERTIME_DEBUG_HANG_METHODS`）。
 *
 * 名单由主进程决定并在 fork 时显式传给本进程（打包态下主进程会删掉该变量，见 `debug-gates.js`）。
 * 命中的调用**不回应答**，由主进程的超时预算收敛成一条可读错误 —— 这正是「后端卡死」的形状。
 */
const HANG_METHODS = String(process.env.SUPERTIME_DEBUG_HANG_METHODS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s !== '');

/** 向父进程回传；父进程已退出时静默忽略。 */
function post(message) {
  try {
    process.parentPort?.postMessage(message);
  } catch {
    /* 父进程已退出 */
  }
}

async function handle(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, type, payload } = msg;
  try {
    switch (type) {
      case 'init': {
        backend = await createWechatBackend({
          userDataPath: payload?.userDataPath,
          onEvent: (name, args) => post({ type: 'event', name, args }),
        });
        post({ id, value: { info: backend.info(), methods: backend.methodNames() } });
        return;
      }
      case 'call': {
        if (!backend) throw new Error('Super Time 后端未初始化');
        // H7 验收注入：只记一条日志、不回任何应答 —— 主进程按超时预算收敛（见 HANG_METHODS 注释）。
        if (HANG_METHODS.includes(String(payload?.method ?? ''))) {
          console.warn('[wechat-worker] 注入「永不回包」: ' + String(payload?.method));
          return;
        }
        const entry = { method: payload?.method, args: payload?.args };
        activeCalls.set(id, entry);
        try {
          post({ id, value: await backend.call(entry.method, entry.args, String(id)) });
        } finally {
          // 无论正常、抛错还是被取消，都不能让旧 id 的取消消息再打到之后的同 jobId 新调用。
          activeCalls.delete(id);
        }
        return;
      }
      case 'cancel': {
        const entry = activeCalls.get(id);
        if (!entry) {
          post({ id, type: 'canceled', value: { ok: false, reason: 'call-completed' } });
          return;
        }
        if (!backend || typeof backend.cancelCall !== 'function') {
          post({ id, type: 'canceled', value: { ok: false, reason: 'cancel-unavailable' } });
          return;
        }
        try {
          const value = await backend.cancelCall(entry.method, entry.args, String(id));
          post({ id, type: 'canceled', value: value || { ok: false, reason: 'cancel-unavailable' } });
        } catch (e) {
          post({
            id,
            type: 'canceled',
            value: { ok: false, reason: e?.message ?? String(e) },
          });
        }
        return;
      }
      case 'dispose': {
        backend?.dispose();
        backend = null;
        activeCalls.clear();
        post({ id, value: { ok: true } });
        return;
      }      default:
        throw new Error(`未知消息类型: ${type}`);
    }
  } catch (e) {
    post({ id, error: { message: e?.message ?? String(e) } });
  }
}

process.parentPort?.on('message', (event) => {
  void handle(event?.data);
});

// ── 全局兜底 ─────────────────────────────────────────────────────────
// handle() 之外的同步异常原先会直接杀进程且不给父进程任何解释（本进程此前
// 没有任何 process 级 handler）。策略是「记下来 → 告诉父进程 → 主动退出」，
// 而不是吞掉继续服务：抛到这里的异常已经跳过了正常的请求/响应配平，
// 进程内部状态未必可信，带伤继续跑可能返回错数据。
// 主动退出会让主进程的重启监管器拉一个干净进程 —— 用户看到的是「短暂卡顿后恢复」，
// 而不是功能整体失效。
function reportFatal(kind, err) {
  const detail = err instanceof Error ? (err.stack || err.message) : String(err);
  const message = `${kind}: ${detail}`;
  console.error('[wechat-worker]', message);
  post({ type: 'event', name: 'wechat-worker-fatal', args: [{ kind, message }] });
  // 留一点时间把事件与日志发出去，再退出交给父进程重建。
  setTimeout(() => process.exit(1), 50);
}

process.on('uncaughtException', (err) => reportFatal('uncaughtException', err));
process.on('unhandledRejection', (reason) => reportFatal('unhandledRejection', reason));

// ── 退出兜底：尽力还原「原图自动下载」的进程注入 ────────────────────────
// 正常路径是主进程发 dispose → `case 'dispose'` 里 backend.dispose() → 宿主调
// `imageAutoDownload.stop()` → `UninstallImgHelper()`（见 wechat-host.js 与
// query/wechat-image-autodownload.ts）。
//
// 但那条路**只保证消息被收到**：`backend-rpc.js` 的 dispose 握手超时、或 worker
// 被 SIGTERM/SIGKILL 直接打掉时，`case 'dispose'` 不会被执行，注入就留在微信进程里。
// 微信会一直按原图下载新图片，而用户以为已经关掉了 —— 这正是界面里
// 「上次退出未确认清理：请先重启微信」那条警告的由来。
//
// 这里在进程级 exit 上再兜一层：`createWechatBackend` 里装的 `process.once('exit')`
// 钩子会调 uninstall + 清 marker。`exit` 阶段只能做同步操作，而 uninstall 是 koffi
// 同步调用，正好够用；SIGKILL 救不回来（内核不给机会），那种情况由 marker 如实回报。
process.once('exit', () => {
  if (backend === null) return; // 已 dispose 过，别重复还原
  try {
    backend.dispose();
    console.log('[wechat-worker] 退出兜底：已还原后端（含原图自动下载注入）');
  } catch (e) {
    console.error('[wechat-worker] 退出兜底失败:', e?.message ?? e);
  }
});
