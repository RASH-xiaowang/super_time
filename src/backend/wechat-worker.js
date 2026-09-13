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
