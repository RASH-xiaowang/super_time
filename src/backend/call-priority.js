'use strict';

/**
 * 后端调用闸的优先级口径。
 *
 * 后端 worker 仍是单事件循环，但队列可以避免「两个长任务把并发名额全占满」以及
 * 「毫秒级读请求排在一串重活后面」。这里的分类刻意只分三档，且重活复用
 * `remote-policy.js` 里已有的长任务台账：
 *
 * - INTERACTIVE：会话/消息/总览等界面首屏读与取消动作，先于普通任务；
 * - NORMAL：没有证据证明重或轻的默认档；
 * - HEAVY：与 RPC 长窗口共用同一份 `LONG_CALL_METHODS`，并且最多只占一个并发名额。
 *
 * 只做调度优先级，不做授权或超时：那两件事仍分别归 `http-remote-policy.js` 与
 * `backend-rpc.js`，本模块新增方法只需保证名字是真实 `@Remote` 名。
 */

const { LONG_CALL_METHODS } = require('./remote-policy');
const { CALL_CANCEL_METHODS } = require('./wechat-cancel');

const INTERACTIVE_PRIORITY = 0;
const NORMAL_PRIORITY = 1;
const HEAVY_PRIORITY = 2;

/**
 * 首屏/导航/状态读取。名单短一点：错放进交互档只会让它插队，不会造成越权。
 */
const INTERACTIVE_METHODS = Object.freeze(new Set([
  'getSessions',
  'getMessages',
  'getNewMessages',
  'getContacts',
  'getOverview',
  'getOverviewInsights',
  'getDailyCounts',
  'getCalls',
  'getRecords',
  'getLedger',
  'getGraph',
  'getStorageStats',
  'getDbHealth',
  'getDbStatus',
  'getDecryptStatus',
  'getPrivacyState',
  'getSearchIndexStatus',
  'listClawbotMessages',
  'getClawbotBinding',
  'getClawbotBindState',
  'checkClawbotEnv',
]));

const CANCEL_METHODS = Object.freeze(new Set(Object.values(CALL_CANCEL_METHODS)));

/**
 * 把方法名映射成调度优先级。
 * @param {unknown} method - `@Remote` 方法名。
 * @returns {number} 0（交互）/ 1（普通）/ 2（重活）。
 */
function callPriorityFor(method) {
  if (typeof method !== 'string') return NORMAL_PRIORITY;
  if (CANCEL_METHODS.has(method)) {
    return INTERACTIVE_PRIORITY;
  }
  if (LONG_CALL_METHODS.has(method)) return HEAVY_PRIORITY;
  if (INTERACTIVE_METHODS.has(method)) return INTERACTIVE_PRIORITY;
  return NORMAL_PRIORITY;
}

module.exports = {
  INTERACTIVE_PRIORITY,
  NORMAL_PRIORITY,
  HEAVY_PRIORITY,
  INTERACTIVE_METHODS,
  callPriorityFor,
};
