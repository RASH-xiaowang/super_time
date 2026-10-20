'use strict';

const { LONG_CALL_METHODS } = require('./remote-policy');

/**
 * RPC 超时后的「尽力取消」策略表。
 *
 * 主进程的 `backend-rpc.js` 超时只代表调用方不再等，不代表 worker 里那份活已经停了。
 * 对带 jobId 的方法，worker 可以按原参数找到对应的取消 Remote，并捅它自己那份
 * AbortController；对没有 jobId 的方法（同步媒体扫描、LLM 摘要等）只能把迟到回包
 * 记为「幽灵完成」，不能假装它被停掉了。
 *
 * 这张表必须是真实 @Remote 方法名的子集，且只映射到真实存在的取消方法。
 */

/** 方法名 -> 对应取消 Remote。jobId 一律取第一个对象参数的 `jobId` 字段。 */
const CALL_CANCEL_METHODS = Object.freeze({
  exportSessionMessages: 'cancelExportJob',
  exportCsv: 'cancelExportJob',
  exportAnnualReport: 'cancelExportJob',
  exportAllSessions: 'cancelExportJob',
  exportMoments: 'cancelExportJob',
  createEncryptedBackup: 'cancelExportJob',
  generateAnnualNarrative: 'cancelExportJob',
  searchMessages: 'cancelSearch',
  askWechat: 'cancelAsk',
  analyzeVisibleMessages: 'cancelLayaAnalysis',
  downloadLayaModel: 'cancelLayaDownload',
  buildSearchIndex: 'cancelSearchIndexBuild',
  buildKbVectorIndex: 'cancelKbIndexBuild',
  downloadWhisperModel: 'cancelWhisperDownload',
  installWhisperEngine: 'cancelWhisperDownload',
});

/**
 * 有长窗口但没有取消 Remote 的方法。
 *
 * 不是每项长任务都能安全打断：没有 jobId/AbortController 槽位的方法只能跑完，
 * 超时后主进程如实记录「幽灵调用」，不能伪装取消成功。这份集合与
 * `CALL_CANCEL_METHODS` 一起构成完整台账：`LONG_CALL_METHODS` 里的每个方法
 * 必须明确属于「可取消」或「明示不可取消」，否则一致性测试会立即失败。
 */
const NON_CANCELLABLE_LONG_CALLS = Object.freeze(new Set([
  'adoptLayaModel',
  'analyzeMessages',
  'autoGetDbKey',
  'autoGetImageKey',
  'buildRagVectorIndex',
  'createBackup',
  'decryptAllDatabases',
  'decryptAllImages',
  'deleteBackup',
  'evaluateRetrieval',
  'exportSnsVideo',
  'extractKbEntities',
  'extractTasks',
  'fetchOriginalImagesBatch',
  'originalHarvest',
  'getOriginalHarvestStatus',
  'getWxcdnQuota',
  'generateDailySummary',
  'generatePeriodSummary',
  'getAnnual',
  'getAnnualReport',
  'getAnnualReview',
  'getArticleCover',
  'getArticleCovers',
  'getClawbotBindState',
  'getEmoticonDataUrl',
  'getFileImageDataUrl',
  'getImageDataUrl',
  'getImageDataUrlsBatch',
  'getImageOriginal',
  'getSnsImageDataUrl',
  'getSnsVideoCoverDataUrl',
  'getSnsVideoDataUrl',
  'getVoiceDataUrl',
  'optimizeAskQuestion',
  'previewBackup',
  'restoreBackup',
  'runSummaryTask',
  'suggestKbLinks',
  'summarizeKbFile',
  'syncHandoffTasks',
  'transcribeVoiceBatch',
  'transcribeVoiceMessage',
  'upgradeDecodedImages',
]));

/**
 * 长任务台账里既没有取消映射、也没有登记为「明示不可取消」的漂移项。
 * 运行时不应使用它；它只作为模块加载后的一致性判据导出。
 * @returns {string[]}
 */
function longCallsWithoutCancelPolicy() {
  return [...LONG_CALL_METHODS]
    .filter((method) => !CALL_CANCEL_METHODS[method] && !NON_CANCELLABLE_LONG_CALLS.has(method))
    .sort();
}

/** 宿主为“调用方没传 jobId”的可取消方法补发的内部任务标识前缀。 */
const RPC_JOB_PREFIX = 'rpc:';

/**
 * 从调用参数里取出可用的 jobId。
 *
 * 与后端 `normalizeJobId` 同一个纪律：只当不透明标识用，因此只接受字符串、去空白并限长。
 * 空串表示调用方没有订阅取消，超时后无法中止。
 * @param {unknown[]} [args]
 * @returns {string}
 */
function jobIdFromCall(args) {
  const first = Array.isArray(args) && args.length > 0 ? args[0] : undefined;
  const raw = first && typeof first === 'object' && first !== null ? first.jobId : undefined;
  return typeof raw === 'string' ? raw.trim().slice(0, 64) : '';
}

/**
 * 为一个超时调用制定取消计划。
 *
 * @param {string} method - 超时的 Remote 方法名。
 * @param {unknown[]} [args] - 原调用参数。
 * @returns {{ ok: true, method: string, jobId: string } |
 *   { ok: false, reason: string, method?: string, jobId?: string }}
 */
function cancelPlanFor(method, args) {
  const cancelMethod = CALL_CANCEL_METHODS[method];
  if (!cancelMethod) {
    return { ok: false, reason: 'method-not-cancellable' };
  }
  const jobId = jobIdFromCall(args);
  if (!jobId) {
    return { ok: false, reason: 'no-job-id', method: cancelMethod, jobId: '' };
  }
  return { ok: true, method: cancelMethod, jobId };
}

/**
 * 在调用方没有 jobId 时，用 RPC 调用序号造一个稳定的内部 jobId。
 *
 * 网关只按 jobId 找取消槽，因此“用户没传 jobId”原本就等于不可取消。宿主既然
 * 有每次调用唯一、且超时消息里也带着的 id，就可以在执行前把它作为 jobId 注入
 * 可取消方法，取消阶段再用同一个 id 找回那一把控制器。显式 jobId 永远优先：
 * 它要与界面上的进度事件保持一致，不能被内部 id 覆盖。
 */
function jobIdForCall(method, args, callHandle) {
  const plan = cancelPlanFor(method, args);
  if (plan.ok) return plan.jobId;
  if (plan.reason !== 'no-job-id' || typeof callHandle !== 'string' || callHandle === '') return '';
  return RPC_JOB_PREFIX + callHandle.slice(0, 48);
}

/**
 * 为可取消方法补一个宿主生成的 jobId（不改变已有显式 jobId）。
 * @returns 归一化后的调用参数数组；不能/无需注入时原数组引用不变。
 */
function injectFallbackJobId(method, args, callHandle) {
  const fallback = jobIdForCall(method, args, callHandle);
  if (!fallback) return args;
  const cancelMethod = CALL_CANCEL_METHODS[method];
  if (!cancelMethod) return args;
  const first = args[0];
  if (first === undefined || first === null) {
    const next = args.slice();
    next[0] = { jobId: fallback };
    return next;
  }
  if (typeof first !== 'object' || Array.isArray(first)) return args;
  if (jobIdFromCall(args) !== '') return args;
  const next = args.slice();
  next[0] = { ...first, jobId: fallback };
  return next;
}

module.exports = {
  CALL_CANCEL_METHODS,
  NON_CANCELLABLE_LONG_CALLS,
  longCallsWithoutCancelPolicy,
  cancelPlanFor,
  jobIdFromCall,
  jobIdForCall,
  injectFallbackJobId,
};
