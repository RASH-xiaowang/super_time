'use strict';

/**
 * 「微信+」后端独立进程（Electron utilityProcess）。
 *
 * ## 为什么要把后端挪出主进程
 *
 * 全部 115 个 Remote 方法都建立在**同步**的 node:sqlite 之上，而个别方法实测
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
 * 主进程 → 本进程：{ id, type: 'init' | 'call' | 'dispose', payload }
 * 本进程 → 主进程：{ id, value } / { id, error } / { type: 'event', name, args }
 */

// 本进程的 stdout 继承自主进程（同一根管道）：父进程/终端先退出时日志会 EPIPE，
// 未处理就会让整个后端进程直接退出（表现为「微信+后端进程已退出」）。
require('./console-safe').install();

const { createWechatBackend } = require('./wechat-host');

// 后端进程启动留痕（主进程会把这一行转进 <STATE_DIR>/logs/app.log）。
// 为什么值得常驻一条：后端是独立进程 —— 它静默没起来、或起来又立刻死了，
// 界面上只表现成「功能不可用」；有一条带 pid 的启动行才好判断。
console.log('[wechat-worker] 后端进程已启动 pid=' + process.pid + ' node=' + process.versions.node);

let backend = null;

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
        if (!backend) throw new Error('微信+后端未初始化');
        post({ id, value: await backend.call(payload?.method, payload?.args) });
        return;
      }
      case 'dispose': {
        backend?.dispose();
        backend = null;
        post({ id, value: { ok: true } });
        return;
      }
      default:
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
