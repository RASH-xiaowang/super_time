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
 *
 * `getMapGeoJson`（2026-10-18）：世界地图底图**本地优先**，正常路径是读
 * `resources/geo/world.zh.json`（毫秒级、不出网）；但它和首屏请求同时发车，
 * 应用启动瞬间队列打满（并发 2 / 排队 32）时会吃到 REMOTE_BUSY，界面就误报
 * 「底图不可用」。底图是「打开就要看到」的静态资源，放交互档先于普通任务；
 * 即使被更早的交互请求堵住，渲染层也另有 400/1200/3000ms 退避重试。
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
  'getMapGeoJson',
  'listClawbotMessages',
  'getClawbotBinding',
  'getClawbotBindState',
  'checkClawbotEnv',
]));

const CANCEL_METHODS = Object.freeze(new Set(Object.values(CALL_CANCEL_METHODS)));

/**
 * 不进调用闸队列的方法 —— **仍要过 `gatedWechatCall` 的许可 / 后端就绪闸**，
 * 只是不占并发名额、不参与排队上限（2026-10-18）。
 *
 * `getMapGeoJson`：世界地图底图本地优先读随包 `resources/geo/world.zh.json`，
 * 毫秒级、不出网；但它和首屏请求同时发车，应用启动瞬间队列打满（并发 2 / 排队 32）
 * 时会拿到 `REMOTE_BUSY`，渲染层就误报「底图不可用」（真机复现：同一时刻直连
 * `getMapGeoJson` 返回 `{ok:true, type:'FeatureCollection', features:239}`）。
 * 底图属于「打开就要看到」的静态数据，且不占 worker 的 CPU / 数据库时间，
 * 因此绕开队列直接过闸；渲染层另有 400/1200/3000ms 退避重试兜底。
 *
 * `getRegionMap`：同一张「世界」卡的地区快照（后端约 11ms；`PERF-AUDIT-172` 冷 11 / 热 8）。
 * 它和底图一起组成这张卡的首屏，启动瞬间同样会被队列拒绝，卡片顶部直接显示
 * 「远程调用太密集」错误。快照是只读、无 CPU 密集中间态，和底图一起走免排队通道。
 */
const QUEUE_BYPASS_METHODS = Object.freeze(new Set([
  'getMapGeoJson',
  'getRegionMap',
]));

/**
 * 该方法是否应绕开调用闸队列。
 * @param {unknown} method - `@Remote` 方法名。
 * @returns true 表示直接过闸执行，不排队。
 */
function shouldBypassCallQueue(method) {
  return typeof method === 'string' && QUEUE_BYPASS_METHODS.has(method);
}

/**
 * 「在线时不再按重活车道排队」的方法 —— 按入参把在线调用降到普通车道。
 *
 * ## 为什么需要（2026-10-16 真机实测，2026-10-19 本地优先后更新）
 *
 * `getSnsImageDataUrl` 在 `HEAVY_CALL_LEDGER` 里，理由是「命中不了缓存时退化成
 * 全量读文件 + 解密 + 哈希（实测 12–21s）」。但重活车道是
 * `heavyLimit = concurrency - 1 = 1`（`http-queue.js`），于是「一屏 30 张朋友圈图」
 * 被串成 30 × 1.2s，且第 6 张起直接 `重任务排队已满`（`HEAVY_QUEUE_MAX = 4`）。
 * 真机实测并发发 10 张：前 5 张串行累加，后 5 张 29ms 全部被拒。
 *
 * ## 2026-10-19 的口径变化
 *
 * 朋友圈取图改成**本地优先**：在线时也会先查 `<数据根>/moments-media` 长期归档、
 * `decoded_images/sns-media`、微信原始目录。归档/缓存命中是毫秒级；即使退到本机解密，
 * 也是**单张、用户可见的等待**，不该再因为「可能慢」就把整屏请求塞进只有 1+4 的
 * 重活车道——那一排满后连已经落盘的图也拿不到，正是用户看到的
 * `重任务排队已满（已有 1 个在跑、4 个在排队）`。
 *
 * 所以现在的判据只分网络状态：
 *   · `offline === true` ⇒ 后端只能走本机慢路，保持 HEAVY；
 *   · 在线（包括缺 CDN 三件套的老数据/被清理动态）⇒ 降为 NORMAL，由普通车道
 *     （并发 2）承接；慢的那一张最多占一个普通名额，不会再把重活队列打满。
 *
 * 为什么只降一档到 NORMAL 而不是 INTERACTIVE：取图是用户可见的等待，但不该插到
 * 「会话列表 / 消息正文」前面；那些是首屏骨架，缺了整页是空的，而图片缺了只是格子空着。
 */
const OFFLINE_HEAVY_METHODS = Object.freeze(new Set([
  'getSnsImageDataUrl',
  'getSnsVideoCoverDataUrl',
]));

/**
 * 按入参决定是否把某个重活方法降级。
 *
 * @param {unknown} method - `@Remote` 方法名。
 * @param {unknown} args - 该次调用的入参（`getSnsImageDataUrl` 收一个对象）。
 * @returns 该降级则为 true（调用方据此改用 {@link NORMAL_PRIORITY}）。
 */
function downgradeHeavyByArgs(method, args) {
  if (typeof method !== 'string' || !OFFLINE_HEAVY_METHODS.has(method)) return false;
  // 入参不是对象（或没给）时**不降级**：宁可保守地当重活，也不要让一次无网解密
  // 混进普通车道把交互请求堵住。
  if (args === null || typeof args !== 'object') return false;
  // 无网 ⇒ 本机解密（慢），不降级。
  if (args.offline === true) return false;
  // 在线 ⇒ 本地优先：归档/缓存通常毫秒级；即使落到本机解密也只是一张，普通车道足够。
  return true;
}

/**
 * 把方法名映射成调度优先级。
 * @param {unknown} method - `@Remote` 方法名。
 * @param {unknown} [args] - 该次调用的入参（可选；给了才能做「按参数降级」）。
 * @returns {number} 0（交互）/ 1（普通）/ 2（重活）。
 */
function callPriorityFor(method, args) {
  if (typeof method !== 'string') return NORMAL_PRIORITY;
  if (CANCEL_METHODS.has(method)) {
    return INTERACTIVE_PRIORITY;
  }
  if (LONG_CALL_METHODS.has(method)) {
    return downgradeHeavyByArgs(method, args) ? NORMAL_PRIORITY : HEAVY_PRIORITY;
  }
  if (INTERACTIVE_METHODS.has(method)) return INTERACTIVE_PRIORITY;
  return NORMAL_PRIORITY;
}

module.exports = {
  INTERACTIVE_PRIORITY,
  NORMAL_PRIORITY,
  HEAVY_PRIORITY,
  INTERACTIVE_METHODS,
  QUEUE_BYPASS_METHODS,
  shouldBypassCallQueue,
  OFFLINE_HEAVY_METHODS,
  downgradeHeavyByArgs,
  callPriorityFor,
};
