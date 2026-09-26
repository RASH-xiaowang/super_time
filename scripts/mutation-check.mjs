#!/usr/bin/env node
/**
 * 变异反证**跑手**：把「注入缺陷 → 守卫必须变红 → 逐字节还原」这套动作从手写脚本变成可回归的步骤。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * 本仓库的守卫纪律要求「新增/恢复的守卫必须有反证，不接受只看绿色」。在此之前，每一轮都是
 * 现写一个 `working/mutation-*.py`：读文件、字符串替换、跑 vitest、还原 —— 而那批脚本是**一次性的**，
 * 下一轮没人会再跑。于是「这条守卫到底会不会咬」这个事实，随着临时脚本一起消失了。
 * 更危险的是它没有第二道闸：脚本自己写错（锚点命中 0 次、替换后语法坏掉、忘记还原）时，
 * 看起来仍然「变异全咬」。
 *
 * 这个跑手把三件事变成强制：
 *   ① **锚点必须恰好命中一次** —— 命中 0 次或多处重复，直接判为「锚点失效」，不算通过
 *      （否则「替换没生效」会被误报成「守卫没咬住」）；
 *   ② **必须变红** —— vitest 退出码为 0 即判「没咬住」，顺便把那次运行的输出摘出来；
 *   ③ **还原必须逐字节一致** —— 比对还原后的字节与原始字节，不一致立刻非零退出。
 *      运行前还会把原文备份到 `working/mutation-backup/`，硬崩也能人工恢复。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────────
 *   node scripts/mutation-check.mjs            # 跑全部
 *   node scripts/mutation-check.mjs --list     # 只列清单
 *   node scripts/mutation-check.mjs --only M5  # 只跑一条（可按前缀匹配多条）
 *   node scripts/mutation-check.mjs --self-test # 自检工具本身（三条判定路径 + 逐字节还原）
 *
 * 结果同时打印到 stdout 与写入 `working/mutation-check.txt`（本机 node 的 stdout 重定向不可靠，
 * 需要留档时读那个文件）。
 *
 * ── 加新条目 ──────────────────────────────────────────────────────────────
 * 在下面的 `MUTATIONS` 里追加一条：`file` 是**相对仓库根**的路径，`from`/`to` 是逐字文本。
 * `from` 必须在该文件里**唯一**。写完先跑一次 `--only <id>` 自证。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(import.meta.dirname, '..')
const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')
const REPORT = join(ROOT, 'working', 'mutation-check.txt')
const BACKUP_DIR = join(ROOT, 'working', 'mutation-backup')

/**
 * 变异清单。
 * @type {ReadonlyArray<{ id: string, why: string, file: string, from: string, to: string, spec: string }>}
 */
const MUTATIONS = [
  {
    id: 'M1-grid-gap',
    why: '宽档栅格间距被改小 1px —— layout-tokens.spec 必须发现基准与真源已漂移',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/overview.module.css',
    from: 'grid-template-columns: repeat(12, minmax(0, 1fr));\n  gap: 12px;',
    to: 'grid-template-columns: repeat(12, minmax(0, 1fr));\n  gap: 11px;',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/layout-tokens.spec.ts',
  },
  {
    id: 'M2-files-header-zero',
    why: '把「正在统计」的加载分支去掉 —— 首屏就会把计数谎报成 0（R2 修掉的那个缺陷）',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/Files.tsx',
    from: 'desc={loading && total === 0',
    to: 'desc={false && total === 0',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/files-loading.wiring.spec.ts',
  },
  {
    id: 'M3-upgrade-forget-cache',
    why: '升级成功后不清图片内存 LRU —— 用户切回会话首帧仍是旧图，「升级成功」看起来像没发生',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/settings-state.tsx',
    from: 'if (r.upgraded > 0) forgetAllImages()',
    to: 'if (false) forgetAllImages()',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/image-upgrade.wiring.spec.ts',
  },
  {
    id: 'M4-kit-anchor-loose',
    why: '把 wiring-kit 的「终点锚点找不到就红」放宽 —— 切片会静默返回怪片段，后续 not.toContain 全绿',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/wiring-kit.ts',
    from: '  expect(b, `${label}：找不到终点锚点「${to}」`).toBeGreaterThan(a)',
    to: '  expect(b, `${label}：找不到终点锚点「${to}」`).toBeGreaterThanOrEqual(-1)',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/wiring-kit.spec.ts',
  },
  {
    id: 'M5-upgrade-not-strict',
    why: '升级判据从「严格更大」放宽成「不小于」 —— 幂等性没了：再跑一遍会拿同尺寸覆盖自己',
    file: 'src/backend/wechat-data/src/query/image-upgrade.ts',
    from: '} else if (best.bytes.length <= entry.bestBytes) {',
    to: '} else if (best.bytes.length < entry.bestBytes) {',
    spec: 'src/backend/wechat-data/tests/image-upgrade.spec.ts',
  },
  {
    id: 'M6-audit-measure-before-settle',
    why: '把审计改回「先量再等落定」—— 量到的就是加载帧（群聊分析 624px/84% 那次误读的来源）',
    file: 'scripts/panel-audit.mjs',
    from: '      const stillLoading = await settle()\n      m = await win.evaluate(MEASURE)',
    to: '      m = await win.evaluate(MEASURE)\n      const stillLoading = await settle()',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/audit-instrument.wiring.spec.ts',
  },
  {
    id: 'M7-skel-display-regress',
    why: '把 `display: block` 放回全局 `.nm-skel` —— 配色类又去决定布局，与 `.skelRow` 打文件顺序战',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/scifi-theme.css',
    from: '.nm-skel {\n  position: relative;',
    to: '.nm-skel {\n  display: block;\n  position: relative;',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/panel-clip.wiring.spec.ts',
  },
  {
    id: 'M8-skelrow-not-flex',
    why: '去掉 `.skelRow` 的 `display: flex` —— 三个占位块竖着堆成 56px，塞进 46px 行被裁 10px',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/ui/kit.module.css',
    from: '.skelRow { height: 46px; display: flex; align-items: center; gap: 10px; padding: 0 10px; }',
    to: '.skelRow { height: 46px; align-items: center; gap: 10px; padding: 0 10px; }',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/panel-clip.wiring.spec.ts',
  },
  {
    id: 'M9-skelrow-too-short',
    why: '把行高从 46px 压到 30px —— 装不下 34px 的占位头像（几何不等式那条抓它）',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/ui/kit.module.css',
    from: '.skelRow { height: 46px; display: flex;',
    to: '.skelRow { height: 30px; display: flex;',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/panel-clip.wiring.spec.ts',
  },
  {
    id: 'M10-records-card-shrinkable',
    why: '去掉 `.recordsCard` 的 `flex-shrink: 0` —— 卡片又被压缩、再被 overflow 切掉 85px 表格',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/records.module.css',
    from: '.recordsCard { flex-shrink: 0; }',
    to: '.recordsCard { }',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/panel-clip.wiring.spec.ts',
  },
  {
    id: 'M11-header-desc-removed',
    why: '删掉某个面板页头的 desc —— U12 的"有 PanelHeader 就要有 desc"必须发现（强化切片后仍要咬）',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/Records.tsx',
    from: '        desc={meta.desc}',
    to: '        title={meta.desc}',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/consistency-r7.wiring.spec.ts',
  },
  {
    id: 'M12-clip-contentvisibility',
    why: '去掉审计里对 `content-visibility: auto` 的排除 —— 四个弹窗节又会各报「裁切 ×4」（全是未渲染占位）',
    file: 'scripts/panel-audit.mjs',
    from: "      if (cs.contentVisibility === 'auto') return false\n",
    to: '',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/audit-instrument.wiring.spec.ts',
  },
  {
    id: 'M13-skeleton-grid-regress',
    why: '把通讯录的骨架退回单列行模式 —— 真实是多列网格，数据到了会"跳一下"（U3）',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/Contacts.tsx',
    from: '{loading && <ListSkeleton rows={12} grid minCol={240} />}',
    to: '{loading && <ListSkeleton rows={12} />}',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/consistency-r7.wiring.spec.ts',
  },
  {
    id: 'M14-empty-state-regress',
    why: '把年度报告的空态退回裸元素（不再用 EmptyState）—— U14 的"整屏空态要有信息"必须发现',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/Annual.tsx',
    from: '            <EmptyState\n              icon="📅"',
    to: '            <span\n              data-fake="📅"',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/u14-empty-state.wiring.spec.ts',
  },
  {
    id: 'M15-css-dangling-class',
    why: '删掉 export-history 的 `.tdKind` 定义 —— css.tdKind 又变 undefined，「类型」列宽规则静默失效',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/export-history.module.css',
    from: '.tdKind { white-space: nowrap; }\n',
    to: '',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/u14-empty-state.wiring.spec.ts',
  },
  {
    id: 'M16-slow-query-elapsed-removed',
    why: '群聊分析的加载态退回一行「统计中…」—— U2 的"慢查询必须给出已用秒数"要发现',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/GroupInsights.tsx',
    from: '正在统计群聊洞察…已用 ${elapsed}s · 首次统计要逐条扫这个群的消息与公告，请稍候',
    to: '统计中…',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/u2-slow-query.wiring.spec.ts',
  },
  {
    id: 'M17-handwritten-timer-returns',
    why: '媒体资产又自己写计时器 —— "走秒只有一份实现"的反例断言必须咬住',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/MediaAssets.tsx',
    from: '  const elapsed = useElapsedSeconds(loading && data === null)',
    to: '  setInterval(() => { setElapsed(0) }, 1000)\n  const elapsed = 0',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/u2-slow-query.wiring.spec.ts',
  },
  {
    id: 'M18-readme-remote-count-drift',
    why: '把前端 README 的 Remote 计数改回旧的 158 —— docs-consistency 必须发现它和 docs/API.md 不一致',
    file: 'src/client/README.md',
    from: '172 个 Remote 方法）',
    to: '158 个 Remote 方法）',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/docs-consistency.wiring.spec.ts',
  },
  {
    id: 'M19-wdp-tab-count-drift',
    why: '把主容器头注的页签数改回旧的 32 —— 「导航计数以 nav-config 为真源」必须发现',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/WechatDataPanel.tsx',
    from: '可路由页签共 **37**（其余 20 项',
    to: '可路由页签共 **32**（其余 20 项',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/docs-consistency.wiring.spec.ts',
  },
  {
    id: 'M20-merged-section-key-typo',
    why: '把某个合并组的分段 key 拼错（ledger → ledgr）—— 深链 #ledger 会静默落回第一段，必须发现',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/WechatDataPanel.tsx',
    from: "{ key: 'ledger', label: '月度汇总'",
    to: "{ key: 'ledgr', label: '月度汇总'",
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/merged-sections.wiring.spec.ts',
  },
  {
    id: 'M21-merged-group-count-drift',
    why: '把合并组的组数注释改回旧的「共 6 组」—— 组数注释与代码必须一致',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/WechatDataPanel.tsx',
    from: '共 8 组**合并视图',
    to: '共 6 组**合并视图',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/merged-sections.wiring.spec.ts',
  },
  {
    id: 'M22-group-announcement-coverage-removed',
    why: '删掉群公告空态里的覆盖率说明 —— 只写「暂无群公告」会让人以为数据丢了',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/GroupInsights.tsx',
    from: '本机实测约六分之一的群有公告',
    to: '多数群没有公告',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/consistency-r7.wiring.spec.ts',
  },
  {
    id: 'M23-emoticon-attribution-removed',
    why: '把表情包空态的归因换回一句「暂无数据」—— 空态必须说明数据来自哪里',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/Emoticons.tsx',
    from: '表情包来自微信「表情商店」的本地缓存',
    to: '暂无数据',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/consistency-r7.wiring.spec.ts',
  },
  {
    id: 'M24-map-tiles-gate-removed',
    why: '删掉地图 GeoJSON 拉取点的出网闸 —— 「禁止地图底图出网」会变成一个没接线的摆设',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/world-map-data.ts',
    from: '  if (await mapTilesBlocked()) {\n',
    to: '',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/s07-outbound-switches.wiring.spec.ts',
  },
  {
    id: 'M25-map-tiles-setting-not-read',
    why: 'readPrivacySettings 不再读 blockMapTiles —— 开关点了写进去却读不出来',
    file: 'src/backend/wechat-data/src/query/privacy-audit.ts',
    from: "    blockMapTiles: getSetting(db, 'blockMapTiles', false),\n  }\n  db.close()\n  return out\n}",
    to: '  }\n  db.close()\n  return out\n}',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/s07-outbound-switches.wiring.spec.ts',
  },
  {
    id: 'M26-voice-download-gate-removed',
    why: '语音模型下载不再过 blockOutbound 总闸 —— 文档里那句「开关真的管到它了」会变成假话',
    file: 'src/backend/wechat-data/src/remotes/voicellm.ts',
    from: "      const blocked = rc.privacyBlocked('voice_model_download', '下载语音识别模型文件')\n",
    to: '',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/s07-outbound-switches.wiring.spec.ts',
  },
  {
    id: 'M27-analysis-toggle-not-wired',
    why: '「分析」按钮的 onClick 变成空操作 —— 按钮在、点了没反应，必须发现',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-head-actions.tsx',
    from: 'onClick={() => { setAnalysisPaneOpen(v => !v) }}',
    to: 'onClick={() => { setAnalysisPaneOpen(false) }}',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chat-analysis-panel.wiring.spec.ts',
  },
  {
    id: 'M28-analysis-block-always-rendered',
    why: '组合层去掉分析块的条件渲染 —— 折叠按钮点了分析区还在，等于按钮是摆设',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/ChatRightPanel.tsx',
    from: '      {showAnalysis && (\n        <ChatAnalysisPanel',
    to: '      {(true) && (\n        <ChatAnalysisPanel',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chat-analysis-panel.wiring.spec.ts',
  },
  {
    id: 'M29-right-panel-private-only',
    why: '右栏挂载条件退回「只有单聊才挂」—— 群聊将无法单独打开分析（2026-09-26 刚修掉的那个副作用）',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-view.tsx',
    from: '{curSession !== null && (suggestVisible || analysisPaneOpen) && !(aiOpen && aiEligible && aiTarget) && (',
    to: "{suggestOpen && curSession !== null && curSession.type === 'private' && !(aiOpen && aiEligible && aiTarget) && (",
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chat-analysis-panel.wiring.spec.ts',
  },
  {
    id: 'M30-wordcloud-cache-removed',
    why: 'queryWordCloud 去掉进程内缓存 —— 「全部热词」每次切回总览都要重算一遍全库（实测 3 秒）',
    file: 'src/backend/wechat-data/src/query/wordcloud.ts',
    from: "  const full = cachedBySig(\n    `wordcloud:${scope}:${username}:${year ?? 'all'}:${decryptedDir}`,\n    sig,\n    () => computeWordCloud(decryptedDir, scope, username, year),\n    30_000,\n  )",
    to: '  const full = computeWordCloud(decryptedDir, scope, username, year)',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/wordcloud-perf.wiring.spec.ts',
  },
  {
    id: 'M31-wordcloud-back-to-scan-all-names',
    why: '退回「逐条正文 × 全部名字做 includes」的老写法 —— 那正是 91% 耗时的来源',
    file: 'src/backend/wechat-data/src/query/word-match.ts',
    from: '  const touched = m.touched',
    to: '  for (const e of m.words) { if (text.includes(e)) counts.set(e, 1) }\n  const touched = m.touched',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/wordcloud-perf.wiring.spec.ts',
  },
  {
    id: 'M32-ac-fail-chain-not-inherited',
    why: 'AC 的 out 不继承 fail 链 —— 「名字是另一个名字的后缀」会漏检（如「明明」之于「小明明」）',
    file: 'src/backend/wechat-data/src/query/word-match.ts',
    from: '    if (f !== 0) for (const w of out[f]!) out[node]!.push(w)',
    to: '    if (f !== 0) { /* 不继承 */ }',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/wordcloud-perf.wiring.spec.ts',
  },
  {
    id: 'M33-wordcloud-no-length-order',
    why: '命中不再按长度降序处理 —— 短名会先遮罩掉长名的前半段，人名被切碎',
    file: 'src/backend/wechat-data/src/query/word-match.ts',
    from: '    if (touched.length > 1) touched.sort((a, b) => m.words[b]!.length - m.words[a]!.length)',
    to: '    if (touched.length > 1) { /* 不排序 */ }',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/wordcloud-perf.wiring.spec.ts',
  },
  {
    id: 'M34-name-counted-per-occurrence',
    why: '人名改成按「出现次数」累加 —— 口径从「几条正文提到他」变成「提了几次」，榜单会被刷子名字顶掉',
    file: 'src/backend/wechat-data/src/query/word-match.ts',
    from: '        counts.set(word, (counts.get(word) ?? 0) + 1)',
    to: '        counts.set(word, (counts.get(word) ?? 0) + ps.length)',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/wordcloud-perf.wiring.spec.ts',
  },
  {
    id: 'M35-wordcloud-request-not-deferred',
    why: '热词请求不再延后一拍 —— 它会把同屏的「世界板块」等块堵在身后（实测 13ms 的块等到 17 秒）',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/WordCloudCard.tsx',
    from: '    const timer = setTimeout(() => {',
    to: '    const timer = (() => {',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/wordcloud-perf.wiring.spec.ts',
  },
  {
    id: 'M36-wordcloud-loading-hides-cache',
    why: '用「统计中…」盖住首屏缓存 —— 切回总览时明明有旧词表可看，却只剩一行加载提示',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/WordCloudCard.tsx',
    from: '      {loading && words.length === 0 && <div className={kitCss.emptyInline}>统计中…</div>}',
    to: '      {loading && <div className={kitCss.emptyInline}>统计中…</div>}',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/wordcloud-perf.wiring.spec.ts',
  },
  {
    id: 'M37-suggest-not-private-only',
    why: '推荐回复的可见性去掉单聊限定 —— 群聊里会冒出「回一句」，语义不成立',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-view.tsx',
    from: "const suggestVisible = suggestOpen && curSession !== null && curSession.type === 'private'",
    to: 'const suggestVisible = suggestOpen && curSession !== null',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/reply-suggest.wiring.spec.ts',
  },
  {
    id: 'M46-worldmap-waits-for-data',
    why: '世界层退回「等数据才画地图」—— GeoJSON 与数据都到齐才肯画，先到的那份白等',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/WorldMap.tsx',
    from: '  const showWorldEcharts = worldEchartsReady\n',
    to: '  const showWorldEcharts = worldEchartsReady && map !== null\n',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/world-map-first-paint.wiring.spec.ts',
  },
  {
    id: 'M47-worldmap-no-empty-node',
    why: 'ECharts 的 node 去掉空值兜底 —— 地区数据没到时世界层会直接崩（而不是只画底图）',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/WorldMap.tsx',
    from: '            node={map?.world ?? EMPTY_WORLD}',
    to: '            node={map?.world as RegionNode}',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/world-map-first-paint.wiring.spec.ts',
  },
  {
    id: 'M48-worldmap-blocked-no-notice',
    why: '底图拉不到（未联网 / 开了 blockMapTiles）时不再给说明 —— 用户看到的是一片空白，会以为数据丢了',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/WorldMap.tsx',
    from: '  const geoTilesBlocked = onWorldMap && worldGeo?.ok === false',
    to: '  const geoTilesBlocked = false',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/world-map-first-paint.wiring.spec.ts',
  },
  {
    id: 'M49-china-fallback-lost',
    why: '中国层 ECharts 起不来时不再降级到 treemap —— SVG 已删，这块会变成什么都不显示',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/WorldMap.tsx',
    from: 'const showTreemap = !onWorldMap && (!chinaMode || chinaFallback) && !showProvinceMap && !showCityMap',
    to: 'const showTreemap = !onWorldMap && !chinaMode && !showProvinceMap && !showCityMap',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/world-map-first-paint.wiring.spec.ts',
  },
  {
    id: 'M50-geo-svg-resurrected',
    why: '被删掉的地理 SVG 又长回来了（哪怕只是一个开关名）—— 「已移除」必须是可验证的，不是一次性的手工动作',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/WorldMap.tsx',
    from: '  const showWorldEcharts = worldEchartsReady\n',
    to: '  const showWorldSvg = onWorldMap && !worldEchartsReady\n  const showWorldEcharts = worldEchartsReady\n',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/world-map-first-paint.wiring.spec.ts',
  },
  {
    id: 'M51-privacy-promise-drift',
    why: '隐私文档又写回「功能不减」—— 那张离线视图已随地理 SVG 删除，这句会让用户以为关掉开关没有代价',
    file: 'docs/PRIVACY.md',
    from: '不再画底图',
    to: '回退到内置的简化边界视图（功能不减）',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/world-map-first-paint.wiring.spec.ts',
  },
  {
    id: 'M52-mapflag-asks-queue-every-time',
    why: '底图开关退回「每次都问后端」—— 后端同步串行，排在 54 秒的长任务后面时底图连"开始拉"都还没轮到（用户报的"一直在加载中"）',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/world-map-data.ts',
    from: '  const mirrored = readMapTilesFlag()\n  if (mirrored !== null) return mirrored\n',
    to: '',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/world-map-first-paint.wiring.spec.ts',
  },
  {
    id: 'M53-mapflag-unbounded-wait',
    why: '开关读取去掉超时上限 —— 队列被长任务堵住时首帧会无限等下去（有界等待是这条修复的"界"）',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/world-map-data.ts',
    from: 'const FLAG_WAIT_MS = 2000',
    to: 'const FLAG_WAIT_MS = Number.POSITIVE_INFINITY',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/world-map-first-paint.wiring.spec.ts',
  },
  {
    id: 'M54-mapflag-not-refreshed-on-save',
    why: '保存「禁止地图底图出网」后不刷新镜像 —— 关掉再打开地图仍按旧值走，等于开关时灵时不灵',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/api-read.ts',
    from: "  invalidateWechatCache('privacy')\n  const s = unwrap(r)\n  writeMapTilesFlag(s.blockMapTiles === true)\n  return s\n",
    to: "  invalidateWechatCache('privacy')\n  return unwrap(r)\n",
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/world-map-first-paint.wiring.spec.ts',
  },
  {
    id: 'M55-region-loading-no-elapsed',
    why: '地区解析的加载态去掉已用秒数 —— 静止的一句"正在解析…"在后端排队时会被当成卡死（用户实测反馈）',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/WorldMap.tsx',
    from: 'useElapsedSeconds(regionLoading)',
    to: 'useElapsedSeconds(false)',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/world-map-first-paint.wiring.spec.ts',
  },
  {
    id: 'M41-calls-rank-unbounded',
    why: '排行列表去掉限高 —— 长列表会重新把同一行的矮卡片顶出一大片空白（用户报的留白）',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/calls.module.css',
    from: '.rankList { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; max-height: 330px; overflow-y: auto; }',
    to: '.rankList { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; overflow-y: auto; }',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/calls-layout.wiring.spec.ts',
  },
  {
    id: 'M42-calls-recent-fixed-height',
    why: '最近通话把 max-height 写成固定 height —— 条目少时会拖出一条空滚动区（「内容不足时不影响布局」被破坏）',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/calls.module.css',
    from: '.recentList { display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; max-height: 400px; overflow-y: auto; }',
    to: '.recentList { display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; height: 400px; overflow-y: auto; }',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/calls-layout.wiring.spec.ts',
  },
  {
    id: 'M43-calls-scrollbar-not-declared',
    why: '滚动条宽度改回 0 —— 依赖全局规则（它只在主题 CSS 加载时才生效），列表看起来无法滚动',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/calls.module.css',
    from: '.rankList::-webkit-scrollbar, .monthList::-webkit-scrollbar, .recentList::-webkit-scrollbar { width: 6px; height: 6px; }',
    to: '.rankList::-webkit-scrollbar, .monthList::-webkit-scrollbar, .recentList::-webkit-scrollbar { width: 0px; height: 0px; }',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/calls-layout.wiring.spec.ts',
  },
  {
    id: 'M44-calls-recent-limit-restored',
    why: '最近通话取数上限改回 60 —— 页面又被 60 条撑长（「精简显示条目数量」被撤销）',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/Calls.tsx',
    from: 'apiGetCalls({ topPeers: 12, recentLimit: 30 })',
    to: 'apiGetCalls({ topPeers: 12, recentLimit: 60 })',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/calls-layout.wiring.spec.ts',
  },
  {
    id: 'M45-calls-recent-back-into-grid',
    why: '「最近通话」缩回两列网格内 —— 长列表与矮卡片配对，行剩余空间又变成空白',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/Calls.tsx',
    from: '</div>\n\n          <Card title="最近通话"',
    to: '</div>\n            <Card title="最近通话"',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/calls-layout.wiring.spec.ts',
  },
  {
    id: 'M56-withdb-close-success-only',
    why: '把 withDb 的 close 从 finally 挪回「只在成功路径」—— 就是 P0-1 修掉的那个形状：抛错时泄漏一个 SQLite 句柄（Windows 下该文件从此删不掉）。query-db-lifetime 的抛错用例必须变红',
    file: 'src/backend/wechat-data/src/query/db-open.ts',
    from: '  try {\n    return fn(db)\n  } finally {',
    to: '  if (true === true) {\n    const done = fn(db)\n    try { if (db.isOpen) db.close() } catch { /* 变异：只有成功路径 close */ }\n    return done\n  } else try {\n    return fn(db)\n  } finally {',
    spec: 'src/backend/wechat-data/tests/query-db-lifetime.spec.ts',
  },
  {
    id: 'M57-whisper-engine-gate-removed',
    why: '把 installWhisperEngine 的 blockOutbound 判闸删掉（P0-2 补的那道）—— 开关打开也能动 GitHub',
    file: 'src/backend/wechat-data/src/remotes/voicellm.ts',
    from: "      const blocked = rc.privacyBlocked('whisper_engine_install', '从 GitHub 下载 whisper.cpp 引擎文件')\n",
    to: '',
    spec: 'src/backend/wechat-data/tests/outbound-gates.spec.ts',
  },
  {
    id: 'M58-laya-model-gate-removed',
    why: '把 downloadLayaModel 的 blockOutbound 判闸删掉（P0-2 补的那道）—— 1.26 GB 的下载又能绕过「禁止 AI 出网」',
    file: 'src/backend/wechat-data/src/remotes/laya.ts',
    from: "      const blocked = rc.privacyBlocked('laya_model_download', '从 HuggingFace 下载本地决策分析模型文件')\n",
    to: '',
    spec: 'src/backend/wechat-data/tests/outbound-gates.spec.ts',
  },
  {
    id: 'M59-llm-models-host-gate-removed',
    why: '让主进程的 wechat:llm-models 不再读隐私开关（把判定写死成「未拦截」）—— 带着 API Key 的请求又能发给任意主机',
    file: 'src/backend/ipc-wechat.js',
    from: "if (st && st.ok !== false && st.value) outboundBlocked = st.value.blockOutbound === true;",
    to: 'if (st && st.ok !== false && st.value) outboundBlocked = false;',
    spec: 'src/backend/tests/ipc-wechat.spec.ts',
  },
  {
    id: 'M60-cachedfetch-await-on-hit',
    why: '把 cachedFetch 的后台刷新改回「命中也先 await 完整请求」（P0-3 修掉的形状）—— 二次打开面板又要转圈，SWR 变成带兜底的 fetch-through',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/cache.ts',
    from: '      void timedFetch(key, fetcher).then(',
    to: '      await timedFetch(key, fetcher).then(',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/cache-swr.spec.ts',
  },
  {
    id: 'M61-context-isolation-off',
    why: '把 contextIsolation 翻成 false（渲染进程重新拿到 Node 原语）—— 审查 §五 那条「✅ 安全基线全为安全值」此前只被人眼看过一次，没有用例守着',
    file: 'src/backend/main-window.js',
    from: '      contextIsolation: true,',
    to: '      contextIsolation: false,',
    spec: 'src/backend/tests/electron-security-baseline.spec.ts',
  },
  {
    id: "M62-privacy-regex-per-row",
    why: "把类别正则改回「每行 × 每个不敏感类别都 new RegExp」（P1-4 修掉的那半）—— 隐私体检又要热跑 1 秒",
    file: "src/backend/wechat-data/src/query/privacy.ts",
    from: "                const re = SCAN_RES[ci]",
    to: "                const re = spec.insensitive ? new RegExp(spec.re.source, 'gi') : spec.re",
    spec: "src/backend/wechat-data/tests/graph-privacy-fanout.spec.ts",
  },
  {
    id: "M63-graph-cache-removed",
    why: "拿掉 queryGraph 的后端签名缓存（P1-3 的第②半）—— 审查基线里那句「热跑 795ms」就回来了",
    file: "src/backend/wechat-data/src/query/graph.ts",
    from: "  return cachedBySig('graph:' + decryptedDir + '|' + (selfUsername ?? ''), sig, () => computeGraph(decryptedDir, selfUsername))",
    to: "  void sig\n  return computeGraph(decryptedDir, selfUsername)",
    spec: "src/backend/wechat-data/tests/graph-privacy-fanout.spec.ts",
  },
  {
    id: "M64-graph-open-per-table",
    why: "把「每个分片只开一次库」改回「每张表把所在分片再开一遍」（P1-3 的第①半）—— 开合数重新随会话数增长",
    file: "src/backend/wechat-data/src/query/graph.ts",
    from: "  for (const sh of shardCatalog(decryptedDir)) {\n    // 先把这个分片里要的表挑出来，然后**一个分片只开一次库**。\n    // 原先是「每张表开合一次」：本机 290 会话 / 304 张 Msg_* 表 ⇒ 对同一批文件开合数百次，\n    // 而 Windows 的 SQLite 打开是带文件锁的进程级操作 —— 这就是 queryGraph 冷跑 866ms 的大头。\n    const wanted = [...sh.tables.keys()].filter((t) => tableToUser.has(t) && !counts.has(tableToUser.get(t) ?? ''))\n    if (wanted.length === 0) continue\n    try {\n      withDb(sh.file, (db) => {\n        for (const t of wanted) {\n          const u = tableToUser.get(t)\n          if (!u || counts.has(u)) continue\n          try {\n            counts.set(u, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n)\n          } catch { /* 这张表读不到就算 0，下一张 */ }\n        }\n      })\n    } catch { /* 整个分片开不了：跳过 */ }\n  }\n",
    to: "  for (const sh of shardCatalog(decryptedDir)) {\n    for (const t of sh.tables.keys()) {\n      const u = tableToUser.get(t)\n      if (!u || counts.has(u)) continue\n      let db: DatabaseSync | null = null\n      try { db = new DatabaseSync(sh.file, { readOnly: true }) } catch { continue }\n      try {\n        counts.set(u, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n)\n      } catch { /* next table */ } finally {\n        db.close()\n      }\n    }\n  }\n",
    spec: "src/backend/wechat-data/tests/graph-privacy-fanout.spec.ts",
  },
  {
    id: "M65-exec-ext-check-removed",
    why: "去掉「可执行/脚本扩展名一律不打开」这一条（P2-6）—— 根内的 .exe 又能被 Invoke-Item 直接执行",
    file: "src/backend/wechat-data/src/query/path-policy.ts",
    from: "  if (ext !== '' && EXECUTABLE_EXTS.has(ext)) {\n    return `出于安全不打开可执行文件（${ext}）：请只在资源管理器里定位数据文件`\n  }",
    to: "  // 变异：去掉可执行扩展名的拦截",
    spec: "src/backend/wechat-data/tests/path-policy.spec.ts",
  },
  {
    id: "M66-openpath-policy-not-applied",
    why: "让网关的 openPath 不再走路径政策（政策函数还在、没人调用）—— 就是审查那条「限根只写在文档里」的形状",
    file: "src/backend/wechat-data/src/gateway-read.ts",
    from: "    const denial = openDenialReason(p, dataRoot)",
    to: "    const denial: string | null = null\n    void openDenialReason\n    void dataRoot",
    spec: "src/backend/wechat-data/tests/path-policy.spec.ts",
  },
  {
    id: "M67-unified-search-readerror-dropped",
    why: "全局搜索不再上报域读失败（P1-1 修的那半）—— 库损坏时下拉又变成「未找到相关结果」",
    file: "src/backend/wechat-data/src/query/unified-search.ts",
    from: "  if (failures.length > 0) {",
    to: "  if (false) {",
    spec: "src/backend/wechat-data/tests/read-error-contract.spec.ts",
  },
  {
    id: "M68-sync-dir-error-silenced",
    why: "实时同步的目录读取失败不再上报（回到 catch { return [] }）—— 「新消息永远不出现」且无任何线索",
    file: "src/backend/wechat-data/src/query/sync.ts",
    from: "    return { files: [], error: `目录不可读 ${dir}：${e instanceof Error ? e.message : String(e)}` }",
    to: "    return { files: [] }",
    spec: "src/backend/wechat-data/tests/read-error-contract.spec.ts",
  },
  {
    id: "M69-stale-read-not-revalidated",
    why: "陈旧命中只回旧值、不再后台复验（P2-4 的另一半被删）—— 界面会永久停在旧数据上，比转圈更糟",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/cache.ts",
    from: "      revalidateSnapshot(key, fetcher)\n      return Promise.resolve(hit.value as T)",
    to: "      return Promise.resolve(hit.value as T)",
    spec: "src/client/ui-wechat/src/client/pages/wechat-data/cache-invalidate-stale.spec.ts",
  },
  {
    id: "M70-stale-serve-ceiling-off",
    why: "去掉「旧到超过上限就当没有」那道闸 —— 陈旧可读会退化成长期画旧数（宁可冷启动也不画五小时前的数据）",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/cache.ts",
    from: "    if (ageMs > STALE_SERVE_CEILING_MS) {",
    to: "    if (false) {",
    spec: "src/client/ui-wechat/src/client/pages/wechat-data/cache-invalidate-stale.spec.ts",
  },
  {
    id: "M71-refresh-throttle-off",
    why: "后台刷新的节流判定改成「永远放行」（P2-8）—— 同步活跃期又回到每 10 秒一整轮重读压进单队列",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/panels/paged-list.ts",
    from: "  if (elapsed < 0 || elapsed >= min) return { go: true, waitMs: 0 }",
    to: "  return { go: true, waitMs: 0 }",
    spec: "src/client/ui-wechat/src/client/pages/wechat-data/panels/paged-list-refresh-gate.spec.ts",
  },
  {
    id: "M72-refresh-cap-truncates-list",
    why: "一轮装不下时改判「可行」⇒ 只发前 N 页并把已加载列表截短（refresh 的「非破坏性」被推翻：高度塌陷、用户被弹回顶部）",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/panels/paged-list.ts",
    from: "  if (pages > maxPages) return { pages: maxPages, feasible: false }",
    to: "  if (pages > maxPages) return { pages: maxPages, feasible: true }",
    spec: "src/client/ui-wechat/src/client/pages/wechat-data/panels/paged-list-refresh-gate.spec.ts",
  },
  {
    id: "M73-render-cache-ttl-off",
    why: "去掉渲染缓存的 24 小时保质期（P2-5）—— 首屏秒出图会一直画昨天的数据，且过期条目永久占配额",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/cache.ts",
    from: "    if (Date.now() - env.at > RENDER_CACHE_TTL_MS) {",
    to: "    if (false) {",
    spec: "src/client/ui-wechat/src/client/pages/wechat-data/render-cache-ttl.spec.ts",
  },
  {
    id: "M74-render-cache-size-cap-off",
    why: "去掉单条大小上限（P2-5）—— 一份几 MB 的快照挤爆配额后，「某些面板首屏加速莫名消失」又变成查不到原因",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/cache.ts",
    from: "  if (payload.length > RENDER_CACHE_MAX_BYTES) {",
    to: "  if (false) {",
    spec: "src/client/ui-wechat/src/client/pages/wechat-data/render-cache-ttl.spec.ts",
  },
  {
    id: "M75-locale-sec-unit-drop",
    why: "让 fmtLocaleSec 不再把秒换算成毫秒（P3-1）—— 界面会安静地画成 1970 年，而类型检查完全放行",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/utils/format.ts",
    from: "  return fmtLocaleMs(n * 1000, placeholder)",
    to: "  return fmtLocaleMs(n, placeholder)",
    spec: "src/client/ui-wechat/src/client/pages/wechat-data/utils/format.spec.ts",
  },
  {
    id: "M76-bytes-ladder-precision",
    why: "把 GB 的小数位从 2 改成 1（P3-2）—— 前后端两份「唯一出处」的口径就是这样重新漂移开的",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/utils/format.ts",
    from: "  if (v < 1024 ** 4) return `${(v / 1024 ** 3).toFixed(2)} GB`",
    to: "  if (v < 1024 ** 4) return `${(v / 1024 ** 3).toFixed(1)} GB`",
    spec: "src/client/ui-wechat/src/client/pages/wechat-data/utils/format.spec.ts",
  },
  {
    id: "M77-second-impl-reintroduced",
    why: "把某面板的 fmtSize 从「转调共享实现」改回本地换算（P3-2 消灭的那五份之一）—— 唯一实现守卫必须响",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/panels/ExportHistoryDialog.tsx",
    from: "const fmtSize = (n: number | null): string => (n === null ? '—' : fmtBytes(n))",
    to: "const fmtSize = (n: number | null): string => (n === null ? '—' : n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB')",
    spec: "src/backend/tests/format-single-source.spec.ts",
  },
  {
    id: "M78-fake-link-href-dropped",
    why: "把气泡里的链接降级成 role=button 的假链接（可点性约定的反面）—— 读屏不再播报「链接」、右键也复制不了地址",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/utils/message-text.tsx",
    from: "              href={seg.url}",
    to: "              role=\"button\"",
    spec: "src/client/ui-wechat/src/client/pages/wechat-data/utils/message-text-clickable.spec.ts",
  },
  {
    id: "M79-mention-gets-dead-focus",
    why: "给展示性的 @提及加上 tabIndex（可点性约定的另一面）—— 每条群消息都往 Tab 序列里塞一个按了没反应的死焦点",
    file: "src/client/ui-wechat/src/client/pages/wechat-data/utils/message-text.tsx",
    from: "            <span key={idx} className={cssshell.msgMention} title={seg.user?.username}>",
    to: "            <span key={idx} role=\"button\" tabIndex={0} className={cssshell.msgMention} title={seg.user?.username}>",
    spec: "src/client/ui-wechat/src/client/pages/wechat-data/utils/message-text-clickable.spec.ts",
  },
  {
    id: "M80-blind-spec-extension-unchecked",
    why: "把 include 名单读成「所有 glob 都只认 .spec.tsx」的反面 —— 用例存在却永远不被收集，是最坏的一种假绿",
    file: "src/backend/tests/spec-file-discoverability.spec.ts",
    from: "    if (/\\.spec\\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e.name)) out.push(rel)",
    to: "    if (/\\.spec\\.tsx$/.test(e.name)) out.push(rel)",
    spec: "src/backend/tests/spec-file-discoverability.spec.ts",
  },
  {
    id: "M81-base-leaf-imports-upward",
    why: "让新登记的 base 叶子（format.ts）反向 import 上层 —— 「白名单只放真正的叶子」这句话必须有牙齿",
    file: "src/backend/wechat-data/src/format.ts",
    from: "export function fmtBytes(n: number | null | undefined): string {",
    to: "import { getConfig } from './query/config.ts'\nvoid getConfig\nexport function fmtBytes(n: number | null | undefined): string {",
    spec: "src/backend/wechat-data/tests/layer-direction.spec.ts",
  },
  {
    id: "M82-args-guard-not-enforced",
    why: "把 ① 档闸门接到执行之后/直接放行（P2-7 原本的样子）—— 越界参数会一路走到 gateway",
    file: "src/backend/wechat-host.js",
    from: "      if (!guard.ok) {",
    to: "      if (false) {",
    spec: "src/backend/tests/wechat-args-guard.spec.ts",
  },
  {
    id: "M83-args-nan-allowed",
    why: "放行 NaN/Infinity —— 结果缓存的 JSON.stringify 会把它静默写成 null，等于闸门替调用方改了数据",
    file: "src/backend/wechat-args-guard.js",
    from: "    if (!Number.isFinite(value)) {",
    to: "    if (false) {",
    spec: "src/backend/tests/wechat-args-guard.spec.ts",
  },
  {
    id: "M84-args-cycle-allowed",
    why: "放行循环引用 —— 深查会自己转不完，而下游每次序列化都炸",
    file: "src/backend/wechat-args-guard.js",
    from: "  if (seen.has(value)) return { code: 'ARGS_CYCLE', message: '参数里有循环引用' };",
    to: "  if (false) return { code: 'ARGS_CYCLE', message: '参数里有循环引用' };",
    spec: "src/backend/tests/wechat-args-guard.spec.ts",
  },
  {
    id: "M85-schema-enforcement-dead",
    why: "让 ② 档即使进了名单也只记账（影子永远升级不成硬拒）—— 那条「升级路径」就成了装饰",
    file: "src/backend/wechat-args-guard.js",
    from: "    return enforced.has(implName)",
    to: "    return false && enforced.has(implName)",
    spec: "src/backend/tests/wechat-args-guard.spec.ts",
  },
  {
    id: "M86-header-check-only-magic",
    why: "把「解密结果有效」的判据退回只比魔数 —— decryptPage 无条件合成魔数，于是错密钥也一律放行，乱码被发布成快照",
    file: "src/backend/wechat-data/src/query/sync.ts",
    from: "  const pageSize = head.readUInt16BE(16)",
    to: "  const pageSize = 4096",
    spec: "src/backend/wechat-data/tests/decrypt-all-tree.spec.ts",
  },
  {
    id: "M87-drafts-double-close",
    why: "在 finally 之外再 close 一次（旧写法）—— node:sqlite 抛 ERR_INVALID_STATE，把人话错误顶替成「database is not open」",
    file: "src/backend/wechat-data/src/query/drafts.ts",
    from: "    if (!has) return { ok: false, updated: 0, error: 'SessionTable 不存在' }",
    to: "    if (!has) { db.close(); return { ok: false, updated: 0, error: 'SessionTable 不存在' } }",
    spec: "src/backend/wechat-data/tests/drafts-clear.spec.ts",
  },
  {
    id: "M88-payments-missing-table-swallows-all",
    why: "把「表不存在」与「真的读失败」混成同一条宽容路径 —— 坏库会被显示成「查无此单」（P1-1 禁的就是这个）",
    file: "src/backend/wechat-data/src/query/payments.ts",
    from: "    if (/no such table/i.test(msg)) {",
    to: "    if (true) {",
    spec: "src/backend/wechat-data/tests/payments-status.spec.ts",
  },
  {
    id: "M89-text-integrity-blind",
    why: "把「会触发 binary file 的字节」清单清空 —— 判据于是恒真，而本仓一半守卫靠 grep/行扫描读源码",
    file: "src/backend/tests/source-text-integrity.spec.ts",
    from: "const CONTROL_BYTES: ReadonlyArray<number> = [0x00, 0x08, 0x0b, 0x0c, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f]",
    to: "const CONTROL_BYTES: ReadonlyArray<number> = []",
    spec: "src/backend/tests/source-text-integrity.spec.ts",
  },
  {
    id: "M90-calendar-shard-throw-escapes",
    why: "让坏分片的异常重新逃出去（旧形状的另一种）—— 一个半写文件毁掉整个月的日历，还漏一条句柄",
    file: "src/backend/wechat-data/src/query/calendar.ts",
    from: "    } catch {\n      // skip unreadable shard",
    to: "    } catch (e) {\n      throw e\n      // skip unreadable shard",
    spec: "src/backend/wechat-data/tests/calendar-daily-counts.spec.ts",
  },
  {
    id: "M91-media-negative-cache-permanent",
    why: "去掉负缓存保质期（P1-7 补测撞出来的那条）—— 用户去微信里下载好了，回来仍永远「本地未找到」",
    file: "src/backend/wechat-data/src/query/media-file.ts",
    from: "  if (hit !== undefined && (hit.url !== '' || Date.now() - hit.at < NEGATIVE_TTL_MS)) {",
    to: "  if (hit !== undefined) {",
    spec: "src/backend/wechat-data/tests/media-file-resolve.spec.ts",
  },
  {
    id: "M92-media-cache-key-loses-root",
    why: "缓存键退回不含 wechatBaseDir —— 换账号/换目录后同名同体积的文件会读到上一个目录的字节",
    file: "src/backend/wechat-data/src/query/media-file.ts",
    from: "  const cacheKey = `${wechatBaseDir.toLowerCase()}|${name.toLowerCase()}|${String(size)}|${month}`",
    to: "  const cacheKey = `${name.toLowerCase()}|${String(size)}|${month}`",
    spec: "src/backend/wechat-data/tests/media-file-resolve.spec.ts",
  },
  {
    id: "M93-records-where-loses-its-space",
    why: "combineWhere 在「只有关键词」分支把前导空格 trim 掉 —— SQL 拼成 tableWHERE，记录页一搜就空",
    file: "src/backend/wechat-data/src/query/records.ts",
    from: "      if (!t) return ' WHERE ' + inner",
    to: "      if (!t) return b",
    spec: "src/backend/wechat-data/tests/gateway-read-shell.spec.ts",
  },
  {
    id: "M94-group-info-missing-table-throws",
    why: "公告表缺失重新抛出（旧形状）—— 群名/成员这些本来拿得到的东西一起变成异常",
    file: "src/backend/wechat-data/src/query/group-info.ts",
    from: "    } catch { info = undefined }",
    to: "    } catch { throw new Error('no such table: chat_room_info_detail') }",
    spec: "src/backend/wechat-data/tests/gateway-read-shell.spec.ts",
  },
]

const argv = process.argv.slice(2)
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : undefined
const listOnly = argv.includes('--list')

const chosen = only === undefined ? MUTATIONS : MUTATIONS.filter((m) => m.id.startsWith(only))
if (chosen.length === 0) {
  process.stdout.write(`没有匹配 --only ${String(only)} 的变异\n`)
  process.exit(2)
}

if (listOnly) {
  process.stdout.write(chosen.map((m) => `${m.id}  ${m.file}\n      ${m.why}\n`).join(''))
  process.exit(0)
}

/** 与文件原始字节比对是否一致。 */
function sameBytes(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** 在文本里定位唯一锚点，返回实际用于匹配的写法（兼容 CRLF 文件）。 */
function locate(text, from) {
  const hitsLf = text.split(from).length - 1
  if (hitsLf === 1) return { needle: from, hits: 1 }
  const crlf = from.replace(/\n/g, '\r\n')
  if (crlf !== from) {
    const hitsCrlf = text.split(crlf).length - 1
    if (hitsCrlf === 1) return { needle: crlf, hits: 1 }
    if (hitsCrlf > 1) return { needle: crlf, hits: hitsCrlf }
  }
  return { needle: from, hits: hitsLf }
}

/**
 * 判定一段 vitest 输出是否属于**编译/语法错误**，而不是断言失败。
 *
 * 为什么要单独判这一条：本项目记录过一次「变异靠语法错误假咬」——
 * 注入的缺陷让文件根本编不过，vitest 照样退出非零，看起来"守卫咬住了"，
 * 其实守卫一行都没执行。这类"假咬"会把一条完全失效的守卫伪装成有效。
 * @param text - vitest 的完整输出（已去 ANSI）。
 * @returns 命中语法/转换错误标记时为 true。
 */
function looksLikeParseError(text) {
  return /SyntaxError|Transform failed|PARSE_ERROR|Unexpected token|Expected "\)"|Expected ";"|error TS\d+|\[plugin:/i.test(text)
}

/** 跑一次 vitest，返回 `{ rc, tail, parseError }`。 */
function runSpec(specPath) {
  const env = { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  const r = spawnSync(process.execPath, [VITEST, 'run', specPath, '--maxWorkers=1', '--no-file-parallelism'], {
    cwd: ROOT, env, encoding: 'buffer', timeout: 900_000,
  })
  const raw = Buffer.concat([r.stdout ?? Buffer.alloc(0), r.stderr ?? Buffer.alloc(0)])
  const text = raw.toString('utf8').replace(/\x1b\[[0-9;]*m/g, '')
  const keep = text.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('FAIL') || /Tests\s|Test Files\s|AssertionError|Error:/.test(l))
  return { rc: r.status ?? -1, tail: keep.slice(0, 4).join(' | ').slice(0, 300), parseError: looksLikeParseError(text) }
}

mkdirSync(BACKUP_DIR, { recursive: true })

/**
 * 施加一条变异、跑目标 spec、无论成败都还原，返回结论行。
 * 抽成函数是为了让 `--self-test` 能复用同一条路径（自检必须走真代码，不能另写一份）。
 * @param {{ id: string, file: string, from: string, to: string, spec: string }} m - 变异定义。
 * @returns {{ id: string, verdict: string, detail?: string, identical?: boolean }} 结论。
 */
function execute(m) {
  const abs = join(ROOT, m.file)
  if (!existsSync(abs)) return { id: m.id, verdict: '锚点失效', detail: `文件不存在：${m.file}` }
  const backup = readFileSync(abs)
  copyFileSync(abs, join(BACKUP_DIR, `${m.id}${m.file.slice(m.file.lastIndexOf('.'))}.bak`))
  const text = backup.toString('utf8')
  const { needle, hits } = locate(text, m.from)
  if (hits !== 1) {
    return { id: m.id, verdict: '锚点失效', detail: `锚点命中 ${hits} 次（必须恰好 1 次）：${m.from.slice(0, 60)}` }
  }

  let verdict = ''
  let detail = ''
  try {
    writeFileSync(abs, text.replace(needle, m.to), 'utf8')
    const r = runSpec(m.spec)
    if (r.rc === 0) {
      verdict = '没咬住'
      detail = `注入后 ${m.spec} 仍然通过（rc=0）`
    } else if (r.parseError) {
      verdict = '语法假咬'
      detail = `注入让文件编不过，守卫可能一行都没跑：${r.tail}`
    } else {
      verdict = '咬红'
      detail = r.tail
    }
  } catch (e) {
    verdict = '运行异常'
    detail = String(e?.message ?? e)
  } finally {
    writeFileSync(abs, backup)
  }

  const identical = sameBytes(backup, readFileSync(abs))
  if (!identical) {
    return {
      id: m.id, verdict: '还原不一致',
      detail: '还原后的字节与原始不同 —— 请用 working/mutation-backup/ 里的备份手工恢复', identical: false,
    }
  }
  return { id: m.id, verdict, detail, identical: true }
}

const SELF_FILE = 'src/client/ui-wechat/src/client/pages/wechat-data/panels/wiring-kit.ts'
const SELF_SPEC = 'src/client/ui-wechat/src/client/pages/wechat-data/panels/wiring-kit.spec.ts'
/** 自检用的锚点：`atLeast` 的声明行开头，改成 `@@@` 后必然编不过。 */
const SELF_ANCHOR = 'export function atLeast('

/**
 * 工具自检：三条判定路径必须各自成立 —— 只跑一次全绿说明不了工具是对的。
 * @returns {Array<{ id: string, verdict: string, detail: string }>} 结论行。
 */
function selfTest() {
  const out = []

  const miss = locate('abc', 'zzz')
  out.push({ id: 'S1 锚点缺失要数成 0 次', verdict: miss.hits === 0 ? '通过' : '失败', detail: `hits=${miss.hits}` })

  const dup = locate('aXa', 'a')
  out.push({ id: 'S2 重复锚点要数成 2 次', verdict: dup.hits === 2 ? '通过' : '失败', detail: `hits=${dup.hits}` })

  // 空变异（from === to）什么都没改，spec 必然通过 ⇒ 必须被判「没咬住」。
  // 这条最重要：它挡住的是「守卫已经失效，却被当成咬住了」。
  const noop = execute({ id: 'S3-noop', file: SELF_FILE, from: SELF_ANCHOR, to: SELF_ANCHOR, spec: SELF_SPEC })
  out.push({
    id: 'S3 空变异必须判「没咬住」',
    verdict: noop.verdict === '没咬住' ? '通过' : '失败',
    detail: `verdict=${noop.verdict}`,
  })

  // 破坏语法：spec 也会非零退出，但这**不是**守卫咬住了 ⇒ 必须被判「语法假咬」。
  const broken = execute({ id: 'S4-syntax', file: SELF_FILE, from: SELF_ANCHOR, to: 'export function atLeast(@@@ ', spec: SELF_SPEC })
  out.push({
    id: 'S4 语法错误必须判「语法假咬」',
    verdict: broken.verdict === '语法假咬' ? '通过' : '失败',
    detail: `verdict=${broken.verdict}`,
  })

  out.push({
    id: 'S5 两条自检变异都要逐字节还原',
    verdict: noop.identical === true && broken.identical === true ? '通过' : '失败',
    detail: `noop=${String(noop.identical)} syntax=${String(broken.identical)}`,
  })

  return out
}

if (argv.includes('--self-test')) {
  const out = selfTest()
  const failed = out.filter((r) => r.verdict !== '通过').length
  const text = ['变异工具自检', '='.repeat(70), ...out.map((r) => `[${r.verdict}] ${r.id}  ${r.detail}`), '',
    failed === 0 ? '结论：工具的三条判定路径都成立。' : `结论：${failed} 条自检未通过。`].join('\n')
  writeFileSync(REPORT, text + '\n', 'utf8')
  process.stdout.write(text + '\n')
  process.exit(failed === 0 ? 0 : 1)
}

const rows = []
let bad = 0

for (const m of chosen) {
  const r = execute(m)
  if (r.verdict !== '咬红') bad++
  rows.push(r)
}

const lines = []
lines.push(`变异反证：共 ${rows.length} 条，异常 ${bad} 条`)
lines.push('='.repeat(70))
for (const r of rows) {
  lines.push(`[${r.verdict}] ${r.id}  逐字节还原=${r.identical === false ? '否' : r.identical === true ? '是' : '未执行'}`)
  if (r.detail) lines.push(`         ${r.detail}`)
}
lines.push('')
lines.push(bad === 0 ? '结论：全部变异都咬住了，且全部逐字节还原。' : `结论：有 ${bad} 条异常，见上。`)
const report = lines.join('\n')
writeFileSync(REPORT, report + '\n', 'utf8')
process.stdout.write(report + '\n')
process.exit(bad === 0 ? 0 : 1)
