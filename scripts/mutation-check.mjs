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
