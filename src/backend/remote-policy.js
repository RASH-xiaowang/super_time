'use strict';

/**
 * 跨进程 Remote 调用的**运行策略真源**。
 *
 * 这份名单不能散在 `backend-rpc.js`、测试台账或网关注释里各自演化：
 * 长任务窗口是主进程在发出请求前做的决定，而 worker 里的 `@Remote` 声明只有编译期意义。
 * 这里把「哪些方法需要宽窗口」和「为什么」收在一处，`backend-rpc.js` 与一致性测试都从
 * 这里取值；网关代码只引用本模块名称，不再引用实现里的集合。
 */

/**
 * 需要宽窗口的重方法台账。`why` 是唯一允许写在这里的说明，
 * 新增条目必须同时保证 `methods` 里的名字都是网关真实注册的 `@Remote`。
 */
const HEAVY_CALL_LEDGER = Object.freeze([
  { why: '导出：大量写盘 + 压缩', methods: Object.freeze(['exportSessionMessages', 'exportCsv', 'exportAnnualReport', 'exportAllSessions', 'exportMoments', 'exportSnsVideo']) },
  { why: '备份与恢复：整库拷贝', methods: Object.freeze(['createBackup', 'createEncryptedBackup', 'restoreBackup', 'previewBackup', 'deleteBackup']) },
  { why: '解密：全量读 + 写', methods: Object.freeze(['decryptAllDatabases', 'decryptAllImages', 'autoGetDbKey', 'autoGetImageKey']) },
  { why: '升级解码缓存：扫 msg/attach（数万文件）+ 逐条重解', methods: Object.freeze(['upgradeDecodedImages']) },
  {
    why: '媒体取数：命中不了缓存时退化成全量「读文件 + 解密 + 哈希」（实测 12–21s）；语音首解最坏 120s',
    methods: Object.freeze(['getSnsImageDataUrl', 'getSnsVideoCoverDataUrl', 'getSnsVideoDataUrl', 'getArticleCover', 'getImageDataUrl', 'getFileImageDataUrl', 'getEmoticonDataUrl', 'getImageOriginal', 'getVoiceDataUrl']),
  },
  { why: '批量封面：N 张 × 两次 20s 超时串在一个窗口里', methods: Object.freeze(['getArticleCovers']) },
  { why: '批量取图：一次 200 张，每张都可能退化成读+解密+哈希', methods: Object.freeze(['getImageDataUrlsBatch']) },
  { why: '批量取原图：几千张 × 15s 超时 + 4 并发，远超 60s', methods: Object.freeze(['fetchOriginalImagesBatch']) },
  {
    why: 'whisper：模型/引擎下载解压与本地转写都可能超过普通窗口',
    methods: Object.freeze(['transcribeVoiceBatch', 'transcribeVoiceMessage', 'downloadWhisperModel', 'installWhisperEngine']),
  },
  {
    why: 'laya 本地决策推理：实测单次 54,103ms / 峰值 110s',
    methods: Object.freeze(['analyzeMessages', 'analyzeVisibleMessages']),
  },
  {
    why: 'laya 模型分发：1.26 GB 流式下载 / 1.23 GB 跨盘接管',
    methods: Object.freeze(['downloadLayaModel', 'adoptLayaModel']),
  },
  { why: '索引与离线评估', methods: Object.freeze(['buildSearchIndex', 'buildRagVectorIndex', 'buildKbVectorIndex', 'evaluateRetrieval']) },
  {
    why: 'LLM 长任务：仓库自身 LLM 超时 120s，RPC 窗口必须明显宽于它',
    methods: Object.freeze(['askWechat', 'optimizeAskQuestion', 'runSummaryTask', 'generateDailySummary', 'generatePeriodSummary', 'summarizeKbFile']),
  },
  { why: '实体抽取/链接建议：最多 20 个文件串行 LLM / 80 条 embedding', methods: Object.freeze(['extractKbEntities', 'suggestKbLinks']) },
  { why: '年度报告/回顾：跨全年聚合，且可能触发 LLM', methods: Object.freeze(['getAnnual', 'getAnnualReport', 'getAnnualReview', 'generateAnnualNarrative']) },
  { why: '任务同步与抽取', methods: Object.freeze(['syncHandoffTasks', 'extractTasks']) },
  { why: '大库全文检索：可取消，但扫描窗口可能超过 60 秒', methods: Object.freeze(['searchMessages']) },
  {
    why: 'ClawBot 绑定状态中继：单次 = 约 40s 的上游长轮询，默认 60s 窗口余量太薄',
    methods: Object.freeze(['getClawbotBindState']),
  },
]);

/** `HEAVY_CALL_LEDGER` 的扁平方法集合；运行时超时决策只读这个对象。 */
const LONG_CALL_METHODS = Object.freeze(new Set(
  HEAVY_CALL_LEDGER.flatMap((group) => [...group.methods]),
));

/** 判断某个方法是否使用分钟级超时窗口。 */
function isLongCall(method) {
  return LONG_CALL_METHODS.has(method);
}

module.exports = {
  HEAVY_CALL_LEDGER,
  LONG_CALL_METHODS,
  isLongCall,
};
