/**
 * 远程访问（手机端）的**方法白名单**与能力清单。
 *
 * ## 为什么是「两份显式清单」而不是一份黑名单
 *
 * 后端有 212 个 `@Remote` 方法，且这个数字只会涨。黑名单的问题不是今天漏了哪一条，
 * 而是**第 212 条出现时会静默获得远程访问权** —— 没人会记得回来改一份「禁止清单」，
 * 而症状是「手机上某个新功能突然能改了桌面端的配置」，这类问题不会被任何测试发现。
 *
 * 所以这里把 212 条**全部显式二分**：`REMOTE_SAFE_METHODS`（允许）与 `LOCAL_ONLY_METHODS`
 * （拒绝，按族给出理由）。两份清单由 `http-remote-policy.spec.ts` 对着 gateway 源码里
 * 真实解析出的 `@Remote` 注册表校验三件事：
 *   ① 两者**不相交**（同一条方法不能既允许又拒绝）；
 *   ② 两者**并集 == 注册表全集**（新增方法必须先分类，否则用例当场红）；
 *   ③ 白名单里的每个名字都**真的存在于注册表**（防止改名后留下一条永不命中的死条目，
 *      那会让「白名单 ⊆ 注册表」变成假的安全感）。
 *
 * ② 是这份文件的**全部价值所在**：它把「默认拒绝」从一句口号变成一个会红的判据。
 *
 * ## 例外：「打开网页」桌面交接会话（2026-10-19）
 *
 * 用户在桌面端亲手点「打开网页」时，发出的配对码带 `fullAccess` 标记；它换来的会话
 * **不查这份白名单**，并与桌面端一样走 `/api/native/*` 原生能力代理。原因：浏览器就在
 * 同一台电脑上，是用户把桌面操作面临时交给默认浏览器，权限必须与桌面端一致。
 * 这条例外**只认服务端内存里的会话标记**：普通手机配对码、伪造 URL 的 `mode=desktop`、
 * 旧 Cookie 都拿不到 fullAccess；停服/轮换/点卡片返回都会清空会话表。
 *
 * ## 分类口径（判「拒」的四条理由，满足任一条即拒）
 *
 *   A. **会给出或改写凭据/配置** —— 模型 API Key、数据库密钥、图片密钥、隐私脱敏开关、
 *      本机账号探测。手机丢了不等于桌面端的密钥也跟着丢。
 *   B. **会在本机磁盘上落文件 / 读本机任意路径** —— 导出、备份与还原、知识库加文件。
 *      手机没有「本机磁盘」这个概念，这类调用要么无意义、要么等于让远程端指定路径。
 *   C. **是重活或长任务** —— 整库解密/修复、索引重建、批量取原图、批量转写、引擎与模型
 *      下载。worker 是**单线程**且与桌面端共用，本机已经踩过一次独占事故（同步 whisper
 *      把 `getSessions` 顶到 2202ms）；远程再叠几个 10 分钟档的长调用，桌面界面会被饿死。
 *      **例外**：单条/面板必需的长任务（年度聚合、单图、单条转写、AI 分析）仍可远程调用，
 *      但由 `REMOTE_HEAVY_METHODS` 单独记账，并在共享队列里受重活并发/排队预算约束。
 *   D. **会以用户身份对外产生后果，或销毁问责留痕** —— ClawBot 发消息/改绑定（收到令牌的人
 *      就能给用户的联系人发消息）、清空操作日志与隐私审计（那两份是「谁在什么时候把什么
 *      发出去了」的唯一记录）。
 *
 * 拿不准时**一律归入拒绝**：白名单漏一条的后果是「手机上某个按钮报错」，用户看得见、
 * 一句话就能修；黑名单漏一条的后果是静默越权，没人会发现。
 *
 * @module backend/http-remote-policy
 */

const { LONG_CALL_METHODS } = require('./remote-policy');

/**
 * 允许远程调用的方法，**按面板族分组**（分组本身就是「tab → 所需方法」的审计矩阵）。
 *
 * 注意这里全是**读**与「用户自己那份应用内数据的小写」（笔记、任务、收藏、草稿、
 * 单条转写、编辑标记）。凡是落到 A–D 四条理由里的都不在这份表里。
 */
const REMOTE_SAFE_BY_FAMILY = {
  '会话与消息（聊天会话 / 通话记录）': [
    'getSessions', 'getMessages', 'getNewMessages', 'getContact360', 'getGroupInfo',
    // `getPaymentStatus` 名字像凭据，其实是「按 server_id 查这条转账/红包消息的权威状态」
    // （`gateway-read.ts` 里它就在 `resolveChatHistory` 旁边，同一份解密库的纯读）。
    // 2026-10-14 的 M10 审计矩阵把它从 A 类挪出来：留在 A 类的症状是手机上转账/红包卡片
    // 显示不出状态，而它读的数据 `getRecords` / `getMessages` 早就允许远程读了 —— 挡不住什么。
    'getCalls', 'resolveChatHistory', 'getSelfUsername', 'getRevoked', 'getPaymentStatus',
    'editChatMessage', 'listEditedMessages', 'resetEditedMessage',
  ],
  '总览与洞察': [
    'getOverview', 'getOverviewInsights', 'getDailyCounts', 'getWordCloud', 'getRegionMap',
    'getMapGeoJson',
    'getAnnual', 'getAnnualReport', 'getAnnualReview', 'getGroupInsights',
    'getAssetInsights', 'getStorageStats',
  ],
  '通讯录': ['getContacts', 'searchMembers'],
  '朋友圈': ['getMoments', 'getMomentsAuthors', 'getMomentsMonthly', 'getMomentsInsights'],
  '搜索': ['searchUnified', 'searchMessages', 'cancelSearch', 'getSearchIndexStatus'],
  '微信问答': [
    'askWechat', 'cancelAsk', 'optimizeAskQuestion', 'suggestReplies',
    'getAskHistory', 'deleteAskHistory', 'clearAskHistory',
    'clearSessionDraft', 'clearAllSessionDrafts',
    'submitAskFeedback', 'listRetrievalFeedback', 'getRetrievalStatus',
  ],
  '总结与任务': [
    'generateDailySummary', 'generatePeriodSummary', 'generateAnnualNarrative',
    'listSummaryTasks', 'saveSummaryTask', 'toggleSummaryTask', 'deleteSummaryTask',
    'runSummaryTask', 'listSummaryRecords', 'deleteSummaryRecord',
    'listTasks', 'addTask', 'setTaskStatus', 'deleteTask', 'extractTasks',
    // 2026-10-19：收集任务列表是纯读本机库；创建任务会落文件，见 B 族。
    'listChatCollectTasks',
    // 2026-10-19：任务信息 / 触发记录的**只读**视图。列表本身是纯读自建库，
    // 与「手机上看看有哪些任务、触发过什么」的语义一致；写侧（建/改/删/扫描/投递）
    // 全部落在下面的 B / D 两族（扫描会写库、投递会按用户配置的地址把内容发出去）。
    'listTaskInfos', 'listTaskTriggers',
  ],
  '知识库': [
    'getKbs', 'getKbFiles', 'getKbFileChunks', 'getNotes', 'saveNote', 'deleteNote',
    'createKb', 'renameKb', 'deleteKb', 'deleteKbFile', 'setKbFileRag',
    'searchKb', 'getKnowledgeGraph', 'getKbVectorIndex',
    'extractKbEntities', 'suggestKbLinks', 'summarizeKbFile',
  ],
  '媒体（图片 / 语音 / 视频 / 表情 / 文件 / 收藏）': [
    'getImageDataUrl', 'getImageDataUrlsBatch', 'getImageOriginal', 'getRemoteImages',
    'getAvatar', 'getAvatarsLocal', 'getArticleCover', 'getArticleCovers',
    'getEmoticons', 'getEmoticonDataUrl', 'getEmoticonDataUrls',
    'getSnsImageDataUrl', 'getSnsVideoDataUrl', 'getSnsVideoCoverDataUrl', 'getSnsVideoCoversBatch',
    'getVoiceDataUrl', 'getVoiceInfo', 'getVoiceTranscript', 'transcribeVoiceMessage',
    'getVideoInfo', 'getFileImageDataUrl', 'getMessageFile',
    'getFiles', 'getFavorites', 'deleteFavoriteItems', 'getMediaAssets', 'getOfficialAssets',
  ],
  '账本与记录': ['getLedger', 'getRecords'],
  '关系图谱': ['getGraph'],
  '健康与状态（只读）': ['getDbHealth', 'getDbStatus', 'getDecryptStatus', 'getDataRevision'],
  '隐私体检（只读）': ['getPrivacyState', 'getPrivacyScan', 'getPrivacyAuditRows'],
  '操作日志（只读）': ['getOperationLog'],
  '本地决策分析': ['analyzeMessages', 'analyzeVisibleMessages', 'cancelLayaAnalysis'],
  'ClawBot（只读）': [
    'listClawbotInstances', 'listClawbotMessages', 'getClawbotBinding',
    'getClawbotBindState', 'checkClawbotEnv', 'getClawbotMedia',
    // 2026-10-17：内置的拟人化默认提示词是**常量**（不读库、不碰微信数据、无副作用）。
    // 手机上要能看得到默认值长什么样 —— 否则设置面板的输入框永远是空的。
    'getClawbotDefaultPrompt',
  ],
}

/**
 * 拒绝远程调用的方法，**按理由族分组**（每族对应文件头 A–D 里的一条）。
 *
 * 这一份不是「黑名单」—— 它与上面那份一起构成注册表的**完整二分**，
 * 完整性由 spec 校验。列在这里的意义是：① 让「为什么这个方法手机上不能用」
 * 有一个写在代码里的答案；② 新增方法时强迫作者做一次显式选择。
 */
const LOCAL_ONLY_BY_FAMILY = {
  'A 凭据 / 密钥 / 配置（含模型 API Key 与本机账号探测）': [
    'getWechatConfig', 'getWechatConfigFull', 'saveWechatConfig', 'openConfig',
    'getWechatKeysInfo', 'generateKeysFile', 'autoGetDbKey', 'autoGetImageKey',
    'verifyDatabaseKey', 'verifyImageKey', 'detectWechatAccounts',
    'listLlmModels', 'listLlmProviders', 'getKbModelConfig', 'setKbModelConfig',
    'setPrivacyState',
    // 原图自动下载（实验）会向本机微信进程注入组件并改变其内存行为 —— 只允许桌面端触发，
    // 手机/浏览器态没有「本机微信进程」这个概念，不该有这个入口。
    'wechatImageAutoDownload',
  ],
  'B 导出：在本机磁盘上落文件': [
    'exportCsv', 'exportAllSessions', 'exportSessionMessages', 'exportMoments',
    'exportSnsVideo', 'exportAnnualReport',
    'getExportHistory', 'getExportProgress', 'cancelExportJob',
    'deleteExportHistory', 'pruneExportHistory',
    // 2026-10-19：新建聊天素材收集任务会在数据根写 texts.json / images/ / task.json ——
    // 与导出一族同属「本机落文件」，手机端没有对应的文件概念。
    'createChatCollectTask',
  ],
  'B 备份与还原：读本机任意路径、还原会覆盖数据': [
    'listBackups', 'previewBackup', 'createBackup', 'createEncryptedBackup',
    'restoreBackup', 'deleteBackup',
  ],
  'B 知识库加文件：入参是本机文件路径，远程端给不出': ['addKbFiles'],
  'C 引擎与模型下载 / 安装（长任务 + 落盘）': [
    'installWhisperEngine', 'downloadWhisperModel', 'cancelWhisperDownload', 'getWhisperStatus',
    'adoptLayaModel', 'downloadLayaModel', 'cancelLayaDownload', 'unloadLaya', 'getLayaStatus',
  ],
  'C 重活：整库解密 / 修复 / 索引重建 / 批量取图 / 批量转写': [
    'decryptAllDatabases', 'decryptAllImages', 'upgradeDecodedImages', 'repairCorruptDbs',
    'checkDbIntegrity',
    'buildSearchIndex', 'cancelSearchIndexBuild', 'buildKbVectorIndex', 'buildRagVectorIndex',
    'cancelKbIndexBuild', 'evaluateRetrieval', 'resetRetrievalWeights', 'saveRetrievalConfig',
    'fetchOriginalImagesBatch', 'planOriginalFetch', 'transcribeVoiceBatch',
    'originalHarvest', 'getOriginalHarvestStatus', 'getWxcdnQuota',
  ],
  'B 本机 shell / 窗口（远程端没有桌面可开）': ['openPath'],
  'B 任务信息写侧：写本机任务库 / 扫描会生成触发记录': [
    // 2026-10-19：任务信息是「用户显式创建 + 本机落库」的配置，与待办/摘要任务同族；
    // 扫描会把命中记录写进本机库（并且可能触发下一族的回调投递），远程端不该驱动它。
    'saveTaskInfo', 'deleteTaskInfo', 'setTaskInfoStatus', 'scanTaskTriggers',
  ],
  'D 任务回调投递：按用户配置的地址把触发内容发到外部平台': [
    // 与 ClawBot 发消息同属「以用户身份对外产生后果」：一条调用就会把触发文本与图片
    // POST 到用户填的回调地址。远程端（手机/普通浏览器会话）不该有能力触发这次出网；
    // 桌面「打开网页」交接会话走 fullAccess，与桌面端同权（见文件头例外）。
    'dispatchTaskCallback',
  ],
  'D ClawBot 写侧：能以用户身份发消息、能改绑定与实例配置': [
    'createClawbotBindQr', 'unbindClawbot', 'createClawbotInstance',
    'deleteClawbotInstance', 'setClawbotInstanceConfig', 'renameClawbotInstance', 'sendClawbotMessage',
  ],
  'D 审计留痕的破坏性清理（问责记录不许被远程端抹掉）': [
    'clearOperationLog', 'clearPrivacyAudit',
    // 2026-10-17：清除对话历史也是**不可恢复的破坏性清理**（删掉接入会话正文），
    // 与上面两条同族 —— 远程端（手机浏览器）不该能抹掉本机的对话记录。
    'clearClawbotMessages',
  ],
  'A 跨设备交接：语义未定，先拒（拿不准一律拒）': ['getHandoffReminds', 'syncHandoffTasks'],
}

/** 把「按族分组」压平成一个 Set；顺手查出族内重复（重复意味着分类时手滑了）。 */
function flatten(byFamily) {
  const out = new Set()
  for (const [family, methods] of Object.entries(byFamily)) {
    for (const m of methods) {
      if (out.has(m)) throw new Error(`方法 ${m} 在同一份清单里出现了两次（族：${family}）`)
      out.add(m)
    }
  }
  return out
}

/** 允许远程调用的方法集合（默认拒绝：不在这里的一律拒）。 */
const REMOTE_SAFE_METHODS = flatten(REMOTE_SAFE_BY_FAMILY)

/** 明确拒绝远程调用的方法集合（与上面那份构成注册表的完整二分）。 */
const LOCAL_ONLY_METHODS = flatten(LOCAL_ONLY_BY_FAMILY)

/** 远程调用被拒时回给界面的错误码（界面据此显示「该功能仅桌面端可用」而不是一个空面板）。 */
const REMOTE_DENIED_CODE = 'METHOD_NOT_ALLOWED_REMOTE'

/**
 * 允许远程调用、但被 `remote-policy.js` 判为长任务的方法。
 *
 * 这些方法**不**因为“重”就直接从白名单拿掉——手机端的面板（年度报告、单图/单条
 * 转写、AI 分析）确实要用它们；它们被限制的是**并发与排队预算**：`http-queue.js`
 * 只让一个远程重活运行、少量重活排队，再多的调用立刻回 `REMOTE_BUSY`，而不是让
 * 一台手机把单线程 worker 的整条队列填满。此集合不是第二份白名单，它只用于
 * `http-server.js` 的调度入口与一致性判据，`isRemoteSafe` 仍以白名单为准。
 */
const REMOTE_HEAVY_METHODS = Object.freeze(new Set(
  [...REMOTE_SAFE_METHODS].filter((method) => LONG_CALL_METHODS.has(method)),
));

/**
 * 这个方法能不能从远程通道调。
 *
 * 刻意写成「查白名单」而不是「查黑名单」：未知方法一律 false。
 * @param method - `@Remote` 注册的方法名。
 * @returns 允许远程调用为 true。
 */
function isRemoteSafe(method) {
  return typeof method === 'string' && REMOTE_SAFE_METHODS.has(method)
}

/**
 * 这个方法是不是「远程允许但需要按重活预算调度」。
 * 未知方法一律 false；远程拒绝清单里的方法也不会在这里出现。
 */
function isRemoteHeavy(method) {
  return typeof method === 'string' && REMOTE_HEAVY_METHODS.has(method)
}

/**
 * 浏览器态拿不到的原生能力清单。
 *
 * 为什么要有这一份：渲染层原本靠 `window.electronAPI` 直接调原生能力（选目录、窗口控制、
 * 面板截图、在资源管理器中显示、许可证与诊断面板、检查更新）。手机浏览器里这些**一个都没有**，
 * 而散落在各处的 `if (isBrowser)` 判断必然漏 —— 所以能力口径收成这一份对象，
 * 由 `capabilities.wiring.spec.ts` 断言「渲染层没有绕过它自己判环境」。
 *
 * 值是**桌面端 = true / 浏览器端 = false**，界面据此隐藏或禁用对应控件（而不是点了没反应）。
 */
const NATIVE_CAPABILITIES = Object.freeze({
  /** 自绘标题栏（拖拽 + 最小化 / 全屏 / 关闭）。浏览器里无意义。 */
  titlebar: false,
  /** 窗口控制（最小化 / 全屏切换 / 关闭）。 */
  windowControls: false,
  /** 原生目录选择对话框。手机上没有「本机目录」可选。 */
  dirPicker: false,
  /** 面板截图（`window:capture-panel`）。 */
  capturePanel: false,
  /** 在资源管理器中显示（`shell:show-item`）。 */
  shellOpen: false,
  /** 许可证界面。远程会话的授权在服务端逐调用校验，界面不再重复把关。 */
  license: false,
  /** 诊断面板（`diag:*`）。 */
  diag: false,
  /** 检查更新（`update:*`）。 */
  update: false,
})

module.exports = {
  REMOTE_SAFE_BY_FAMILY,
  LOCAL_ONLY_BY_FAMILY,
  REMOTE_SAFE_METHODS,
  LOCAL_ONLY_METHODS,
  REMOTE_HEAVY_METHODS,
  REMOTE_DENIED_CODE,
  NATIVE_CAPABILITIES,
  isRemoteSafe,
  isRemoteHeavy,
}
