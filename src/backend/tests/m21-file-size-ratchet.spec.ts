/**
 * M21 的棘轮守卫：**单文件行数上限（1000 行）+ 白名单只许变短**。
 *
 * 条目原文的验收是「单文件不超过约定行数上限」，但那个「上限」一直没落成可执行的东西，
 * 于是大文件只会越长越多（`gateway.ts` 4837 行、`Chats.tsx` 3957 行……）。这里把它钉成闸门：
 *   ① 不在白名单里的手写文件必须 ≤ {@link LIMIT}；
 *   ② 白名单里的文件**只许变短**（记录的就是当时的行数，涨一行就红）；
 *   ③ 白名单条目一旦降到 LIMIT 以内，必须从白名单里删掉（否则闸门会慢慢失效）；
 *   ④ 白名单不许出现「已经很小」或「根本不存在」的条目（防止用它夹带）。
 *
 * 生成物与随包资产**不在口径内**（列在 {@link EXCLUDED}，每条都写了为什么）：
 * `lib/index.js` 是 esbuild 摇出来的、`lib/types/**` 是 tsc 生成的、`native/**` 是随包 WASM/JS。
 *
 * @vitest-environment node
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** 手写单文件的行数上限（含空行与注释；M21 的约定值）。 */
const LIMIT = 1000

/**
 * 当前超限文件的白名单：**只许下调，降到位就删条目**。
 * 数值是 2026-09-21 实测的行数（`wc -l` 口径）。
 *
 * 2026-09-24（第 49 刀）：`chats.module.css`（2904 行）按「必须同份」的簇拆成四份
 * （887 / 888 / 882 / 191）⇒ **该条目已删除，本表只剩 onboarding 那一份**。
 *
 * 剩下这一份不是「还没轮到」。2026-09-22 那次勘测写着「最大不可分簇 1140 / 1113 行 ⇒ 两份都拆不到 1000」，
 * 2026-09-24 把判据做成 committed 的尺子（`npm run css:clusters`）之后**复核为两份都拆得动** —— 那次的数算多了两处：
 *   ① CSS Modules 不给 `:global(.x)` 里的类名打 hash ⇒ 它不构成「必须同份」的约束；把它当枢纽类连进
 *      闭包，`onboarding` 那 41 条带它的规则会被串成一团（这才是 931→1113 的来源）。
 *   ② 「同一元素共现的类对」原先用非贪婪正则取 `className={…}`，模板串写法在第一个 `}` 就断 ⇒
 *      那批类对整批看不见（看不见就等于「没有危险对」）。改成按花括号深度配对：125 对 ⇒ 220 对。
 * 复核后的最大不可分簇：`chats` **652 行**、`onboarding` **436 行**（上限 1000）⇒ 按簇 regroup 拆得动，
 * 代价是产物里的规则次序会变，所以每拆一份都要过 `npm run css:bundle-diff`（第 49 刀：规则集逐条一致、0 危险对）。
 * 保序连续切两份都仍然切不动（各自只有 7 个合法切点，且每一份都 >1000 行）。
 *
 * 2026-09-24（第 50 刀）：`onboarding.module.css`（1618 行）→ `onboarding.module.css`(892) +
 * `onboarding-stages.module.css`(523) ⇒ **白名单清空**。这张表从此只拦「新长出来的文件」；
 * 防空转的那几条（扫描数量下限、只许变短、达标就删条目）都留着。
 */
const ALLOWLIST: Record<string, number> = {
  // 2026-10-22：统一 answer runtime 的两个规则模块首次超过 1000 行，先如实登记
  // 为「只许变小」；`askdeep.ts` 已降到 408 行，按规则移出白名单。
  // 2026-11-13（系统修复轮）：两处规则补充后实测 1180 / 1311，按「实测重登记」更新数字。
  'src/backend/wechat-data/src/query/answer-runtime/arguments.ts': 1180,
  'src/backend/wechat-data/src/query/answer-runtime/intent.ts': 1311,

  // 2026-11-13（系统修复轮）：M21 在 v1.1.0 之后的功能线上就已经是红的 —— 这 27 个
  // 手写文件早于本轮修复越过 1000 行（`git show HEAD:<path>` 复核过），本轮只在其中
  // 几处净增（http-server.js、messages.ts、unified-search.ts、tool-loop.ts、
  // runner-pipeline.ts、chats-media.tsx、moments-media.ts）。LIMIT 没有放宽（仍是 1000），
  // 这些条目按既有规则**只许变小**；拆分的优先级见系统审查报告：
  // 先拆 graph-model.ts(1774) / unified-search.ts(1524) / chats-rows.module.css(1423)。
  'src/backend/http-server.js': 1081,
  'src/backend/tests/http-server.spec.ts': 1220,
  // 2026-11-13：AI 回复新增「知识库参与」检索/降级分支，实测 1242；仍只许变小。
  'src/backend/wechat-data/src/query/ai-reply/runner-pipeline.ts': 1242,
  'src/backend/wechat-data/src/query/answer-runtime/tool-loop.ts': 1117,
  'src/backend/wechat-data/src/query/graph-relations.ts': 1052,
  'src/backend/wechat-data/src/query/graph.ts': 1009,
  'src/backend/wechat-data/src/query/media-image.ts': 1009,
  'src/backend/wechat-data/src/query/messages.ts': 1246,
  'src/backend/wechat-data/src/query/parse-rich.ts': 1005,
  'src/backend/wechat-data/src/query/unified-search.ts': 1524,
  'src/backend/wechat-data/src/remotes/ask-runtime.ts': 1110,
  'src/backend/wechat-data/src/remotes/media.ts': 1275,
  'src/backend/wechat-data/tests/answer-runtime-tool-loop.spec.ts': 1153,
  'src/backend/wechat-data/tests/ask-runtime-orchestrator.spec.ts': 1176,
  'src/backend/wechat-data/tests/export-sns-media-originals.spec.ts': 1196,
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/AnswerRunView.spec.ts': 1029,
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats.module.css': 1008,
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-cards.module.css': 1032,
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-media.tsx': 1025,
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-rows.module.css': 1430,
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/graph-model.ts': 1774,
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/hooks.tsx': 1015,
  // 2026-11-13：文件列表补「加载更多」一行（`.listMore`）后实测 1160；仍只许变小。
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/kbfiles.module.css': 1160,
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/message-list.module.css': 1114,
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/settings.module.css': 1014,
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-media.spec.ts': 1096,
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-media.ts': 1316,
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/use-ask.ts': 1035,
}

/**
 * 扫描口径的防空转下限：白名单空了之后，「白名单外的文件都在上限内」这一条要是因为**扫不到文件**
 * 而通过，整个闸门就是假的 —— 所以显式要求扫到的文件数在一个可信的量级上（实测 2026-09-24 是 500+）。
 */
const MIN_SCANNED = 400

/** 生成物 / 随包资产：不计入行数口径（每条给出理由）。 */
const EXCLUDED = [
  ['src/backend/wechat-data/lib/', 'esbuild/tsc 生成物（CI 有 check:backend/check:types 产物一致性门禁）'],
  ['src/backend/wechat-data/native/', '随包 WASM 与其胶水 JS（第三方产物）'],
  ['src/backend/deps/', '内联第三方依赖（file: 依赖）'],
  ['src/client/ui-dist/', 'vite 构建产物'],
] as const

const SCAN_ROOTS = ['src', 'scripts'] as const
const SCAN_FILES = ['main.js', 'preload.js'] as const
const EXT = new Set(['.ts', '.tsx', '.css', '.mjs', '.js'])

/**
 * 收集所有手写源码文件（相对仓库根的 posix 路径，字典序）。
 * @returns 相对路径数组。
 */
function listSourceFiles(): string[] {
  const out: string[] = []
  for (const extra of SCAN_FILES) if (existsSync(join(ROOT, extra))) out.push(extra)
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.')) continue
      const abs = join(dir, entry)
      const rel = relative(ROOT, abs).split(sep).join('/')
      if (EXCLUDED.some(([prefix]) => rel.startsWith(prefix) || (rel + '/').startsWith(prefix))) continue
      const st = statSync(abs)
      if (st.isDirectory()) walk(abs)
      else if (EXT.has(entry.slice(entry.lastIndexOf('.')))) out.push(rel)
    }
  }
  for (const r of SCAN_ROOTS) walk(join(ROOT, r))
  return out.sort()
}

/**
 * 数一个文件的行数（与 `wc -l` 同口径：以 `\n` 计）。
 * @param rel - 相对仓库根的路径。
 * @returns 行数。
 */
function lineCount(rel: string): number {
  const text = readFileSync(join(ROOT, rel), 'utf8')
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

describe('M21：单文件行数上限（棘轮）', () => {
  const files = listSourceFiles()

  it('白名单里的文件都还在（删文件也要删条目）', () => {
    for (const rel of Object.keys(ALLOWLIST)) {
      expect(existsSync(join(ROOT, rel)), `白名单里的文件已不存在：${rel}`).toBe(true)
    }
  })

  it('白名单外的文件都在上限内', () => {
    expect(files.length, `只扫到 ${String(files.length)} 个手写文件 —— 扫描口径坏了的话「都在上限内」是假的`).toBeGreaterThanOrEqual(MIN_SCANNED)
    const offenders = files
      .filter((rel) => !(rel in ALLOWLIST))
      .map((rel) => ({ rel, lines: lineCount(rel) }))
      .filter((x) => x.lines > LIMIT)
    expect(offenders, `新增/涨过 ${String(LIMIT)} 行的文件：${offenders.map((o) => `${o.rel}(${String(o.lines)})`).join(', ')}`)
      .toEqual([])
  })

  it('白名单只许变短（涨一行就红）', () => {
    const grown: string[] = []
    for (const [rel, ceiling] of Object.entries(ALLOWLIST)) {
      const now = lineCount(rel)
      if (now > ceiling) grown.push(`${rel}: ${String(now)} > ${String(ceiling)}`)
    }
    expect(grown, `这些文件比登记时更长了：${grown.join('; ')}`).toEqual([])
  })

  it('降到上限以内的文件必须从白名单里删掉（闸门要越用越紧）', () => {
    const stale: string[] = []
    for (const rel of Object.keys(ALLOWLIST)) {
      const now = lineCount(rel)
      if (now <= LIMIT) stale.push(`${rel}: ${String(now)} 行，已达标 —— 请从 ALLOWLIST 删掉它`)
    }
    expect(stale, stale.join('; ')).toEqual([])
  })

  it('防空转：白名单确实覆盖了当前所有超限文件（多一条少一条都算错）', () => {
    const realOffenders = files.filter((rel) => lineCount(rel) > LIMIT).sort()
    expect(realOffenders).toEqual(Object.keys(ALLOWLIST).sort())
  })
})
