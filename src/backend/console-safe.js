'use strict';

/**
 * 让日志写不出去时不再拖垮进程。
 *
 * 背景（实测）：Windows 上 Electron 是 GUI 子系统程序，从终端/CI 拉起时 stdout 是
 * **管道**；终端或父进程退出后管道关闭，此后任何 `console.log` 都会在流上触发
 * `EPIPE: broken pipe, write`。Node 默认把流上的 `error` 事件当**未捕获异常**抛出，
 * 于是主进程弹出致命框：
 *
 *   A JavaScript error occurred in the main process
 *   Uncaught Exception: Error: EPIPE: broken pipe, write
 *
 * 后果比"少几行日志"严重得多：那个框会**卡住窗口**，用户只能点确定；后端进程
 * （utilityProcess，stdio 继承自父进程，走同一条管道）同样会因 EPIPE 直接退出，
 * 表现为「微信+后端进程已退出」，一堆功能同时失效。
 *
 * 两道保险：
 *   1. 给 stdout/stderr 挂 `error` 监听 —— 挂上之后 Node 不再把它当未捕获异常；
 *   2. 包一层 console，一旦发现管道坏了就彻底静默，连同步抛出也一并吞掉。
 *
 * 只影响日志，不影响任何业务输出。
 */

/** 安装保险。幂等，可重复调用。 */
function install() {
  let broken = false;
  const onError = () => { broken = true; };
  for (const stream of [process.stdout, process.stderr]) {
    if (stream && typeof stream.on === 'function') stream.on('error', onError);
  }
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    const original = console[level];
    if (typeof original !== 'function') continue;
    console[level] = (...args) => {
      if (broken) return;
      try {
        original.apply(console, args);
      } catch {
        broken = true;
      }
    };
  }
}

module.exports = { install };
