/**
 * 变异登记表：**数据**，跑手在 `scripts/mutation-check.mjs`。
 *
 * 为什么单独成文件：本仓有「单文件不超过 1000 行」的硬棘轮（`m21-file-size-ratchet.spec.ts`，
 * 白名单只许变短），而这张表每加一条就长 7 行 —— 表和执行器放在一起时，**登记变异这件事本身**
 * 会撞闸门（实测：第 96 条把 `mutation-check.mjs` 顶到 1012 行）。搬开之后跑手稳定在
 * 二百多行，只有表会涨；表再涨到上限时按批次切成 `mutations-registry.<批次>.mjs` 由这里聚合，
 * 不要靠放宽闸门解决。
 *
 * **已经照此切过三次**：`mutations-registry.batch3.mjs` 装 M118 起的条目（主表停在 M117，至 M221）；
 * 2026-09-26 #19 第四刀之后 `batch3` 自己涨到 1073 行又撞闸门，于是 M222 起再切一份
 * `mutations-registry.batch3b.mjs`；2026-09-27 #22（四处长列表虚拟化）与 #20（GatewayCore 连着五刀）
 * 把它顶到 **1015 行** —— 同一把尺子第三次拦下「登记变异这件事本身」，于是 M310 起再切一份
 * `mutations-registry.batch3c.mjs`（现至 M416）。**分界点是闸门容量决定的、不是批次决定的** ——
 * M222 / M310 之后仍属报告里的第三批与第四批，批次语义在每条 id 与 `why` 里。加新条目：看哪份文件还有余量。
 *
 * 第四份起改按**主题**切：`mutations-registry.batch3d.mjs`（M417 起）是 2026-10-09 那批
 * 「评论图 / 视频封面 / CDN 密文」的十四条，自成一族、头注要能说清「这一批守的是什么」；
 * 2026-10-12 的微信 ClawBot 集成（M444 起）沿用同一做法，新开 `mutations-registry.batch3e.mjs`；
 * 2026-10-13 的 ClawBot **AI 自动回复**（M478 起）再开 `mutations-registry.batch3g.mjs`
 * （主题=无人值守的模型调用）；同日 M5（来源区分 + 当前实例标记）开 `batch3h.mjs`；
 * 同日 iLink 绑定通道接入再开 `mutations-registry.batch3f.mjs`（M458 起，主题=出网与生命周期）。
 * 2026-10-13 的聊天信息抽屉**实时刷新**（M496 起）开 `mutations-registry.batch3j.mjs`
 * （主题=抽屉开着时的静默重取与落地归属闸）。
 * 同日的同步 **WAL 实时推送**（M500 起）开 `mutations-registry.batch3k.mjs`
 * （主题=WAL 写入 → 立刻拍同步节拍：触发接线 / 防抖 / 限频）。
 * 同日的会话/消息列表实时更新收口（M503 起）开 `mutations-registry.batch3l.mjs`
 * （主题=会话列表节流降级 + staging 拷贝 EBUSY 重试）。
 * 同日的微信数据面 **WAL 实时刷新全覆盖**（M508 起）开 `mutations-registry.batch3m.mjs`
 * （主题=前端消费面全覆盖：直订 / 静默失败保护 / useFreshData opts 稳定性）。
 * 同日的同步主库**尾部增量解密**（M511 起）开 `mutations-registry.batch3n.mjs`
 * （主题=检查点只解新增页：quick_check 安全网 / 计划参与判定 / 尾页上限）。
 * 同日的内联分析**异步转写**（M514 起）开 `mutations-registry.batch3o.mjs`
 * （主题=whisper 转写不独占 worker：await 接线 / 异步入口形状）。
 * 同日的主库**页级差分**增量（M518 起）开 `mutations-registry.batch3p.mjs`
 * （主题=原地重写检查点只解变化页：指纹与签名绑定 / 差分参与判定 / 占比上限）。
 * 同日的 wxgf 高清原图 **ffmpeg 兜底**（M521 起）开 `mutations-registry.batch3q.mjs`
 * （主题=DLL 不可用时解全分辨率 JPEG：兜底接线 / 分区长度校验 / NAL 上限）。
 * 次日的**入站监听面隐私口径**（M524 起）开 `mutations-registry.batch3r.mjs`
 * （主题=局域网远程访问默认关闭：配置默认值 / 读回缺省值 / 同意屏渲染）。
 * 同日的局域网远程访问 **HTTP 服务**（M527 起）开 `mutations-registry.batch3s.mjs`
 * （主题=入站面的静默失效：定长比对 / 空令牌 / 异常即拒 / 白名单 / 并发闸 / SSE 转发与形状）。
 * 同日的**浏览器态 Remote 与事件中继**（M535 起）开 `mutations-registry.batch3t.mjs`
 * （主题=手机与桌面必须表现一致：映射表 / 前台补刷新 / 会话失效通知 / 令牌门 / 缺省派发器）。
 * 同日的远程访问**控制面与设置卡片**（M540 起）开 `mutations-registry.batch3u.mjs`
 * （主题=用户改这个暴露面的唯一入口：轮换要作废旧会话 / 启用要真开 / 死控件与残留二维码）。
 * 同日的**手机端外壳**（M544 起）开 `mutations-registry.batch3v.mjs`
 * （主题=只在窄视口出现的失效：桌面多出底栏 / sheet 不关 / 侧栏搜索条被拆）。
 * 同日的**手机端聊天页**（M547 起）开 `mutations-registry.batch3w.mjs`
 * （主题=窄视口 + 触摸才出现的失效：跨份选择器是死 CSS / 栈式开关丢信号 / 滚动误弹长按菜单 /
 *   菜单被内联 top 顶出屏幕 / 选择器转义吃掉整条规则 / 返回按钮跑到桌面端）。
 * 同日的**手机端触摸目标下限**（M559 起）开 `mutations-registry.batch3x.mjs`
 * （主题=手指点得中：元素级 44px 下限与段条手机档覆盖，实测 498 个可点元素无一低于 40px）。
 * 同日的**表格手机档 + hover 可达性**（M561 起）开 `mutations-registry.batch3y.mjs`
 * （主题=窄视口 × 触摸才成立的失效：粘住的首列底色透明 / hover-only reveal 没有出口 / 假出口）。
 * 2026-10-15 的 **@Remote 入参 schema 硬拒试点**（M588 起）开 `mutations-registry.batch3zc.mjs`
 * （主题=① 档之外的形状校验开始对方法生效：试点名单被摘掉必须能被判据咬出来）。
 *
 * ⚠️ 切文件带来的新失败模式：**忘了把新一份聚合进 MUTATIONS，一条错都不报**
 * （2026-09-27 就漏接过一次：表从 344 悄悄掉到 306，全绿）。兜它的是
 * `src/backend/tests/mutation-registry-anchors.spec.ts` 里的 `REGISTRY_MIN`（只许涨的条数下限）——
 * 每登记一条就把那个数抬上去；掉下来说明有整份表没接进来。
 *
 * ── 加新条目 ──────────────────────────────────────────────────────────────
 * `file` 是**相对仓库根**的路径，`from`/`to` 是逐字文本，`spec` 是必须变红的用例文件。
 * `from` 必须在该文件里**唯一**（命中 0 次或多处都判「锚点失效」，不算通过）。
 * 锚点别照 Read 的输出手敲（前导空格是内容的一部分），从文件里现取。
 * 写完先跑 `node scripts/mutation-check.mjs --only <id>` 自证。
 */
import { MUTATIONS_BATCH3 } from './mutations-registry.batch3.mjs'
import { MUTATIONS_BATCH3B } from './mutations-registry.batch3b.mjs'
import { MUTATIONS_BATCH3C } from './mutations-registry.batch3c.mjs'
import { MUTATIONS_BATCH3D } from './mutations-registry.batch3d.mjs'
import { MUTATIONS_BATCH3E } from './mutations-registry.batch3e.mjs'
import { MUTATIONS_BATCH3F } from './mutations-registry.batch3f.mjs'
import { MUTATIONS_BATCH3G } from './mutations-registry.batch3g.mjs'
import { MUTATIONS_BATCH3H } from './mutations-registry.batch3h.mjs'
import { MUTATIONS_BATCH3I } from './mutations-registry.batch3i.mjs'
import { MUTATIONS_BATCH3J } from './mutations-registry.batch3j.mjs'
import { MUTATIONS_BATCH3K } from './mutations-registry.batch3k.mjs'
import { MUTATIONS_BATCH3L } from './mutations-registry.batch3l.mjs'
import { MUTATIONS_BATCH3M } from './mutations-registry.batch3m.mjs'
import { MUTATIONS_BATCH3N } from './mutations-registry.batch3n.mjs'
import { MUTATIONS_BATCH3O } from './mutations-registry.batch3o.mjs'
import { MUTATIONS_BATCH3P } from './mutations-registry.batch3p.mjs'
import { MUTATIONS_BATCH3Q } from './mutations-registry.batch3q.mjs'
import { MUTATIONS_BATCH3R } from './mutations-registry.batch3r.mjs'
import { MUTATIONS_BATCH3S } from './mutations-registry.batch3s.mjs'
import { MUTATIONS_BATCH3T } from './mutations-registry.batch3t.mjs'
import { MUTATIONS_BATCH3U } from './mutations-registry.batch3u.mjs'
import { MUTATIONS_BATCH3V } from './mutations-registry.batch3v.mjs'
import { MUTATIONS_BATCH3W } from './mutations-registry.batch3w.mjs'
import { MUTATIONS_BATCH3X } from './mutations-registry.batch3x.mjs'
import { MUTATIONS_BATCH3Y } from './mutations-registry.batch3y.mjs'
import { MUTATIONS_BATCH3Z } from './mutations-registry.batch3z.mjs'
import { MUTATIONS_BATCH3ZA } from './mutations-registry.batch3za.mjs'
import { MUTATIONS_BATCH3ZB } from './mutations-registry.batch3zb.mjs'
import { MUTATIONS_BATCH3ZC } from './mutations-registry.batch3zc.mjs'

/**
 * 变异清单（第一、二批）。全表在文件末尾的 `MUTATIONS`。
 * @type {ReadonlyArray<{ id: string, why: string, file: string, from: string, to: string, spec: string }>}
 */
const MUTATIONS_BATCH12 = [
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
    file: 'src/client/ui-wechat/src/client/test-helpers/wiring-kit.ts',
    from: '  expect(b, `${label}：找不到终点锚点「${to}」`).toBeGreaterThan(a)',
    to: '  expect(b, `${label}：找不到终点锚点「${to}」`).toBeGreaterThanOrEqual(-1)',
    spec: 'src/client/ui-wechat/src/client/test-helpers/wiring-kit.spec.ts',
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
    // 2026-10-09（W3-11.5，`cancelLayaAnalysis` 是第 174 个 Remote）：锚点跟计数一起走。
    // 2026-10-11（W2-8.6，`generateAnnualNarrative` 是第 179 个）：再跟一次。
    // 2026-10-12（ClawBot 集成 +6 → 186；同日「可发可收」+1；同日「媒体可见」+1 → 188）：第五次跟。
    // 2026-10-13（ClawBot 多实例 +4 → 192）：第六次跟。
    // 2026-10-13（W3-11.7 损坏库修复链路 +2 → 194）：第七次跟。
    // 2026-10-14（地图 GeoJSON 后端代理 +1 → 195）：第八次跟。
    from: '195 个 Remote 方法）',
    to: '158 个 Remote 方法）',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/docs-consistency.wiring.spec.ts',
  },
  {
    id: 'M19-wdp-tab-count-drift',
    why: '把主容器头注的页签数改回旧的 32 —— 「导航计数以 nav-config 为真源」必须发现',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/WechatDataPanel.tsx',
    from: '可路由页签共 **38**（其余 20 项',
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
    from: "  const full = await cachedBySigAsync(\r\n    `wordcloud:${scope}:${username}:${year ?? 'all'}:${decryptedDir}`,",
    to: '  const full = await computeWordCloud(decryptedDir, scope, username, year)',
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
    // R4：加载态载体由 `kitCss.emptyInline` 换成 `<LoadingState variant="compact">`，
    // 锚点随之更新（变异语义不变：去掉 `words.length === 0` 那道「有缓存就不盖」的门）。
    from: '      {loading && words.length === 0 && <LoadingState variant="compact" label="统计中…" />}',
    to: '      {loading && <LoadingState variant="compact" label="统计中…" />}',
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
    why: '底图拉不到（未联网 / 镜像源不可达）时不再给说明 —— 用户看到的是一片空白，会以为数据丢了',
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
    why: '把 withDb 的 close 从 finally 挪回「只在成功路径」—— 就是 P0-1 修掉的那个形状：抛错时泄漏一个 SQLite 句柄（Windows 下该文件从此删不掉）。query-db-lifetime 的抛错用例必须变红（2026-09-26 第四批 #11 之后，头像 / 360° / 总览新加的 4 条行为用例也在同一份 spec 里被它覆盖 —— 那三条读函数已经没有自己的裸 open，只能在 helper 这一层反证）',
    file: 'src/backend/wechat-data/src/query/db-open.ts',
    from: '  const db = new DatabaseSync(file, { readOnly: true })\n  try {\n    return fn(db)\n  } finally {',
    to: '  const db = new DatabaseSync(file, { readOnly: true })\n  if (true === true) {\n    const done = fn(db)\n    try { if (db.isOpen) db.close() } catch { /* 变异：只有成功路径 close */ }\n    return done\n  } else try {\n    return fn(db)\n  } finally {',
    spec: 'src/backend/wechat-data/tests/query-db-lifetime.spec.ts',
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
    from: "  return cachedBySigAsync('graph:' + decryptedDir + '|' + (selfUsername ?? ''), sig, () => computeGraph(decryptedDir, selfUsername))",
    to: "  void sig\n  return computeGraph(decryptedDir, selfUsername)",
    spec: "src/backend/wechat-data/tests/graph-privacy-fanout.spec.ts",
  },
  {
    id: "M64-graph-open-per-table",
    why: "把「每个分片只开一次库」改回「每张表把所在分片再开一遍」（P1-3 的第①半）—— 开合数重新随会话数增长",
    file: "src/backend/wechat-data/src/query/graph.ts",
    from: "  for (const sh of shardCatalog(decryptedDir)) {\n    // 先把这个分片里要的表挑出来，然后**一个分片只开一次库**。\n    // 原先是「每张表开合一次」：本机 290 会话 / 304 张 Msg_* 表 ⇒ 对同一批文件开合数百次，\n    // 而 Windows 的 SQLite 打开是带文件锁的进程级操作 —— 这就是 queryGraph 冷跑 866ms 的大头。\n    const wanted = [...sh.tables.keys()].filter((t) => tableToUser.has(t) && !counts.has(tableToUser.get(t) ?? ''))\n    if (wanted.length === 0) continue\n    // P1-2：真正要开库的分片之间各让一次（放在 wanted 判空之后，\n    // 这样「让出次数 == 实际开库次数」，判据的下界才算得出来）。\n    await yieldToLoop()\n    try {\n      withDb(sh.file, (db) => {\n        for (const t of wanted) {\n          const u = tableToUser.get(t)\n          if (!u || counts.has(u)) continue\n          try {\n            counts.set(u, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n)\n          } catch { /* 这张表读不到就算 0，下一张 */ }\n        }\n      })\n    } catch { /* 整个分片开不了：跳过 */ }\n  }\n",
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
    from: "      revalidateSnapshot(key, fetcher)\n      return timedFetch(key + ':hit', () => Promise.resolve(hit.value as T))",
    to: "      return timedFetch(key + ':hit', () => Promise.resolve(hit.value as T))",
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
    from: "    if (!guard.ok) {",
    to: "    if (false) {",
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
  {
    id: "M95-md5-case-loosened",
    why: "给严格档 isMd5 偷偷加上 i（P3-3 收口的正是「十处口径不完全同义」）—— 大写的串会被当成合法缓存文件名",
    file: "src/backend/wechat-data/src/md5.ts",
    from: "  return MD5_RE.test(v)",
    to: "  return MD5_RE_LOOSE.test(v)",
    spec: "src/backend/wechat-data/tests/md5-image-key.spec.ts",
  },
  {
    id: "M96-aes-key-empty-becomes-zero-length",
    why: "退回「空串也 Buffer.from」—— 得到长度为 0 的 key，解密层抛 Invalid key length，界面变成「这张图取不出来」",
    file: "src/backend/wechat-data/src/keys/image-key.ts",
    from: "    if (aesKey.trim().length === 0) return null",
    to: "    if (false) return null",
    spec: "src/backend/wechat-data/tests/md5-image-key.spec.ts",
  },
  {
    id: "M97-provenance-fingerprint-compare-off",
    why: "溯源表只比版本号不比内容指纹（P1-5 的整张表就退化成「我自己说没抄过」—— 拷进来又手工改过的包永远看不出差异）",
    file: "scripts/deps-provenance.mjs",
    from: "if (p.treeSha256 !== c.treeSha256)",
    to: "if (false)",
    spec: "src/backend/tests/deps-provenance.spec.ts",
  },
  {
    id: "M98-provenance-check-exit-code-swallowed",
    why: "漂移照样打印出来、但退出码永远是 0 ⇒ CI 抓手形同虚设（打印给人看 ≠ 能阻断合并）",
    file: "scripts/deps-provenance.mjs",
    from: "process.exit(bad === 0 ? 0 : 1)",
    to: "process.exit(0)",
    spec: "src/backend/tests/deps-provenance.spec.ts",
  },
  {
    id: "M99-provenance-corrupt-table-overwritten",
    why: "去掉「坏表不许覆盖」这道闸门：JSON 一抖，--write 就把 16 条人手写的来源说明冲成 0 条 —— 而这正是这张表唯一不可再生的部分",
    file: "scripts/deps-provenance.mjs",
    from: "if (existsSync(tablePath) && previous === null) {",
    to: "if (false) {",
    spec: "src/backend/tests/deps-provenance.spec.ts",
  },
  {
    id: "M100-moments-monthly-hides-read-failure",
    why: "退回「读失败也回空数组」（P1-1/#9 的原始缺陷形状）：快照损坏会被画成「这个月没发过朋友圈」，病因永远查不到",
    file: "src/backend/wechat-data/src/query/moments-monthly.ts",
    from: "    return { months: [], readError: '朋友圈月度分布读取失败：' + msg }",
    to: "    return { months: [] }",
    spec: "src/backend/wechat-data/tests/read-failure-contract.spec.ts",
  },
  {
    id: "M101-moments-monthly-claims-failure-when-empty",
    why: "反向：把「压根没有 sns.db」也报成读失败 —— 判据若只查「坏库要报错」，一律报错也能全绿",
    file: "src/backend/wechat-data/src/query/moments-monthly.ts",
    from: "  if (dbPath === null) return { months: [] }",
    to: "  if (dbPath === null) return { months: [], readError: '谎报' }",
    spec: "src/backend/wechat-data/tests/read-failure-contract.spec.ts",
  },
  {
    id: "M102-export-history-hides-read-failure",
    why: "隐私库读不动时退回 `return empty` ⇒ 导出历史窗口显示「还没有导出记录」，用户以为记录丢了",
    file: "src/backend/wechat-data/src/query/export-history.ts",
    from: "    return { ...empty, readError: '导出历史读取失败：' + msg }",
    to: "    return empty",
    spec: "src/backend/wechat-data/tests/read-failure-contract.spec.ts",
  },
  {
    id: "M103-sns-video-caches-miss-on-unreadable-dir",
    why: "把「扫不全也记 miss」放回去：一次临时的目录读不动被永久记成「本机没有这条视频」，重启才恢复",
    file: "src/backend/wechat-data/src/query/sns-video.ts",
    from: "    idx.misses.clear() // 树变了，之前的「没有」结论失效\n    harvest(byMd5, open, found)\n  }\n  // P1-1/#9：只有「每个月都扫全了」才配把「没有」缓存下来。\n  // 目录读不动时记进 misses，等于把一次临时的 EACCES 变成「这条视频永远找不到」。\n  if (notes.length === 0) for (const h of open) idx.misses.add(h)",
    to: "    idx.misses.clear() // 树变了，之前的「没有」结论失效\n    harvest(byMd5, open, found)\n  }\n  // P1-1/#9：只有「每个月都扫全了」才配把「没有」缓存下来。\n  // 目录读不动时记进 misses，等于把一次临时的 EACCES 变成「这条视频永远找不到」。\n  if (true) for (const h of open) idx.misses.add(h)",
    spec: "src/backend/wechat-data/tests/read-failure-contract.spec.ts",
  },
  {
    id: "M104-miss-message-drops-scan-notes",
    why: "「没扫全」的原因不再并进文案 ⇒ 三处用例（扫描口 / 图片 / 视频）同时失去线索，谎话回到「本机没有」",
    file: "src/backend/wechat-data/src/query/sns-scan.ts",
    from: "  if (notes.length === 0) return msg",
    to: "  return msg",
    spec: "src/backend/wechat-data/tests/read-failure-contract.spec.ts",
  },
  {
    id: "M105-sqlite-header-drops-payload-fractions",
    why: "把「解对了没有」的判据退回只看页大小：随机明文撞中率 0.02%，而全量解密一次要判几百个库、每轮同步都在判 —— 跑得够久就一定有一次错密钥的乱码被发布成快照（实测：这条红过一次，就是同一个 flake）",
    file: "src/backend/wechat-data/src/query/sync.ts",
    from: "  return head[21] === 64 && head[22] === 32 && head[23] === 32",
    to: "  return true",
    spec: "src/backend/wechat-data/tests/decrypt-all-tree.spec.ts",
  },
  {
    id: "M106-sqlite-header-drops-format-version",
    why: "去掉读/写版本这一维（同一族里另一条独立判据；留着它，撞中率再乘一次 2⁻¹⁴）",
    file: "src/backend/wechat-data/src/query/sync.ts",
    from: "  if (head[18] !== 1 && head[18] !== 2) return false",
    to: "  if (false) return false",
    spec: "src/backend/wechat-data/tests/decrypt-all-tree.spec.ts",
  },
  {
    id: "M107-overview-insights-stops-yielding-per-shard",
    why: "把分片边界的让出删掉：总览又是「从头钉到尾」的那一种查询 —— 世界板块自己 13ms 却排在它后面等 17 秒（P1-2 的原始账）",
    file: "src/backend/wechat-data/src/query/overview-insights.ts",
    from: "    await yieldToLoop()",
    to: "    // 不让出",
    spec: "src/backend/wechat-data/tests/query-yield-discipline.spec.ts",
  },
  {
    id: "M108-overview-insights-stops-yielding-per-row",
    why: "只在分片边界让出、整表扫一口气跑完：大账号的朋友圈（几万条）仍然把循环钉死",
    file: "src/backend/wechat-data/src/query/overview-insights.ts",
    from: "          if (++scanned % SNS_YIELD_EVERY_ROWS === 0) await yieldToLoop()",
    to: "          if (false) await yieldToLoop()",
    spec: "src/backend/wechat-data/tests/query-yield-discipline.spec.ts",
  },
  {
    id: "M109-cached-by-sig-async-no-coalescing",
    why: "去掉同键合流：让出之后并发冷算真的会撞在一起，54 秒的查询被跑两遍，事件循环堵得更久",
    file: "src/backend/wechat-data/src/query/meta.ts",
    from: "  if (running) return running.value as Promise<T>",
    to: "  if (false) return running.value as Promise<T>",
    spec: "src/backend/wechat-data/tests/query-yield-discipline.spec.ts",
  },
  {
    id: "M110-with-db-async-leaks-on-await",
    why: "withDbAsync 不再关连接：跨 await 持有的连接漏在进程里，Windows 上那个目录从此换不掉（P0-1 那一族的异步版）",
    file: "src/backend/wechat-data/src/query/db-open.ts",
    from: "      if (db.isOpen) db.close()\n    } catch { /* 同上：不掩盖原始错误 */ }",
    to: "      if (false) db.close()\n    } catch { /* 同上：不掩盖原始错误 */ }",
    spec: "src/backend/wechat-data/tests/query-yield-discipline.spec.ts",
  },
  {
    id: "M111-privacy-stops-yielding-between-shards",
    why: "隐私体检的探测阶段（每分片开一次库）不再让出：80+ 个分片连开就是几十秒的独占",
    file: "src/backend/wechat-data/src/query/privacy.ts",
    from: "      await yieldToLoop()\n      try {\n        withDb(join(msgDir, file)",
    to: "      try {\n        withDb(join(msgDir, file)",
    spec: "src/backend/wechat-data/tests/query-yield-discipline.spec.ts",
  },
  {
    id: "M112-privacy-stops-yielding-between-tables",
    why: "扫描阶段每表一次的让出被删：一个分片里几百张 Msg_ 表又变回一口气扫完",
    file: "src/backend/wechat-data/src/query/privacy.ts",
    from: "          await yieldToLoop()",
    to: "          // 不让出",
    spec: "src/backend/wechat-data/tests/query-yield-discipline.spec.ts",
  },
  {
    id: "M113-privacy-stops-yielding-per-rows",
    why: "行级让出关掉：单张几十万行的表仍然把循环钉死（分片/表边界救不了它）",
    file: "src/backend/wechat-data/src/query/privacy.ts",
    from: "              if (scanned % PRIVACY_YIELD_EVERY_ROWS === 0) await yieldToLoop()",
    to: "              if (false) await yieldToLoop()",
    spec: "src/backend/wechat-data/tests/query-yield-discipline.spec.ts",
  },
  {
    id: "M114-storage-stops-yielding-per-month-dir",
    why: "存储统计的 msg/file 整树 stat 不再按月份让出：上百个文件一次性 stat 完（这一页最重的一段）",
    file: "src/backend/wechat-data/src/query/storage.ts",
    from: "        await yieldToLoop()",
    to: "        // 不让出",
    spec: "src/backend/wechat-data/tests/query-yield-discipline.spec.ts",
  },
  {
    id: "M115-storage-stops-yielding-per-large-file",
    why: "每条大文件的让出关掉：resolveFileTitle 会逐个消息分片开库找消息，100 条 × 全部分片就是几百次同步开库",
    file: "src/backend/wechat-data/src/query/storage.ts",
    from: "      await yieldToLoop()\n      const packedName = parsePackedName(r.p ?? null)",
    to: "      const packedName = parsePackedName(r.p ?? null)",
    spec: "src/backend/wechat-data/tests/query-yield-discipline.spec.ts",
  },
  {
    id: "M116-ledger-stops-yielding-per-shard",
    why: "账本的消息回查不再按分片让出：两趟扫描（整型等值 + CAST 兜底）每趟都要把所有分片各开一遍，这正是「打开账本页卡住别的面板」的正主",
    file: "src/backend/wechat-data/src/query/ledger.ts",
    from: "      await yieldToLoop()",
    to: "      // 不让出",
    spec: "src/backend/wechat-data/tests/ledger.spec.ts",
  },
  {
    id: "M117-graph-stops-yielding-per-shard",
    why: "图谱的消息计数不再按分片让出：P1-3 把开合数压到「每片一次」之后，剩下的钉循环风险就是这一串同步开库",
    file: "src/backend/wechat-data/src/query/graph.ts",
    from: "    await yieldToLoop()",
    to: "    // 不让出",
    spec: "src/backend/wechat-data/tests/graph-privacy-fanout.spec.ts",
  },
]

/** 全表：一、二批在前，第三批由旁边两份文件拼进来（跑手只看这一个名字）。 */
export const MUTATIONS = [...MUTATIONS_BATCH12, ...MUTATIONS_BATCH3, ...MUTATIONS_BATCH3B, ...MUTATIONS_BATCH3C, ...MUTATIONS_BATCH3D, ...MUTATIONS_BATCH3E, ...MUTATIONS_BATCH3F, ...MUTATIONS_BATCH3G, ...MUTATIONS_BATCH3H, ...MUTATIONS_BATCH3I, ...MUTATIONS_BATCH3J, ...MUTATIONS_BATCH3K, ...MUTATIONS_BATCH3L, ...MUTATIONS_BATCH3M, ...MUTATIONS_BATCH3N, ...MUTATIONS_BATCH3O, ...MUTATIONS_BATCH3P, ...MUTATIONS_BATCH3Q, ...MUTATIONS_BATCH3R, ...MUTATIONS_BATCH3S, ...MUTATIONS_BATCH3T, ...MUTATIONS_BATCH3U, ...MUTATIONS_BATCH3V, ...MUTATIONS_BATCH3W, ...MUTATIONS_BATCH3X, ...MUTATIONS_BATCH3Y, ...MUTATIONS_BATCH3Z, ...MUTATIONS_BATCH3ZA, ...MUTATIONS_BATCH3ZB, ...MUTATIONS_BATCH3ZC]

/** 全量条数唯一来源：门禁文案与预算不要再各自抄一个会腐坏的数字。 */
export const MUTATION_COUNT = MUTATIONS.length
