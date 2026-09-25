/**
 * 几何守卫：`docs/UI-GEOMETRY-SPEC.md` 的机检。
 *
 * 三条棘轮 + 三条哨兵，全部只读源码（与 theme-tokens.spec.ts 同款 walk）：
 * ① 圆角字面量白名单门禁（per-file per-value 基线棘轮，只许减不许增）；
 * ② 奇数间距（5/7/9/18px）per-file 计数棘轮；
 * ③ 999px / 50% 全局棘轮（防胶囊逃逸令牌、防矩形滥用 50% 圆形）；
 * 哨兵：扫描文件数 / border-radius 声明总数 / 间距声明总数——防「解析坏了 → 扫不到 → 恒绿」。
 *
 * 合法圆角 = 令牌（--nm-r-* / --nm-dense-r / --wx-*，含带兜底）、0、50%、999px（③另有棘轮）、
 * inherit、复合角白名单（聊天气泡尾巴等已交付形态）、以及「分量全是令牌或 0」的令牌组合
 * （如 `var(--wx-radius) var(--wx-radius) 0 0`）。聊天消息区的 --wx-* 单值同样合法
 * （那套体系由 check:wx-tokens 单独管辖，本守卫不重复也不冲突）。
 *
 * 基线维护（与 M21 白名单同一套纪律）：
 * · 收敛一批字面量后，**同步下调**对应条目；某值清零后**必须删掉该条目**（反向检查会红）；
 * · 基线里登记的文件被删除/改名 ⇒ 反向检查红（防留尸）；
 * · 新文件 / 新值零容忍（不在基线里出现即红）。
 *
 * 变异自证（2026-09-25，三处全咬、逐字节还原）：
 * · 临时加 `border-radius: 11px` ⇒ ① 红「新增非法圆角」；
 * · 临时加 `margin: 7px` ⇒ ② 红「超基线」；
 * · 手工把某基线值调小 1 ⇒ ① 红「超基线」（证明计数真咬得住，不是恒真）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = fileURLToPath(new URL('.', import.meta.url))
/** 扫描根：整个前端源码（与 theme-tokens.spec.ts 同款）。 */
const CLIENT_ROOT = join(HERE, '..', '..', '..', '..', '..')

/** 令牌定义处（定义本身不算使用）与不可扫目录。 */
const SKIP_FILES = new Set(['scifi-theme.css', 'light-theme.css'])
const SKIP_DIRS = new Set(['node_modules', 'ui-dist', 'public', '.git'])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...walk(p))
    } else if (e.name.endsWith('.css') && !SKIP_FILES.has(e.name)) {
      out.push(p)
    }
  }
  return out
}

/** ── 解析（与 working/geometry-baseline2.py 逐条同口径，改一处必改另一处）────────── */
const BR_RE = /border-radius\s*:\s*([^;{}]+)/g
const SP_RE = /(?<![a-z-])(?:padding|margin|row-gap|column-gap|gap)\s*:\s*([^;{}]+)/g
const ODD_RE = /^(?:5|7|9|18)px$/
/** 单值令牌：--nm-r-* / --nm-dense-r / --wx-*，允许带兜底。 */
const TOKEN_RE = /^var\(--(?:nm-(?:r-[a-z]+|dense-r)|wx-[a-z-]+)(?:\s*,\s*[^)]+)?\)$/
const LEGAL_SIMPLE = new Set(['0', '0px', '50%', '999px', 'inherit'])
/** 已交付的复合角形态（聊天气泡尾巴、上圆下直的分段容器等）；新代码禁用字面量复合角。 */
const COMPOUND_WHITELIST = new Set([
  '4px 4px 0 0', '0 3px 3px 0', '12px 12px 3px 12px', '4px 14px 14px 14px',
  '4px 3px 0 0', '6px 6px 0 0', '0 6px 6px 0', '4px 4px 2px 2px', '14px 14px 4px 14px',
])

function classifyRadius(v: string): 'ok' | 'illegal' {
  v = v.trim()
  if (TOKEN_RE.test(v) || LEGAL_SIMPLE.has(v) || COMPOUND_WHITELIST.has(v)) return 'ok'
  if (v.includes(' ')) {
    // 令牌组合：每个分量都是令牌或 0（如 `var(--wx-radius) var(--wx-radius) 0 0`）。
    if (v.split(/\s+/).every((p) => TOKEN_RE.test(p) || p === '0' || p === '0px')) return 'ok'
  }
  return 'illegal'
}

/** 拆声明值（保护 var()/calc() 整体）。 */
function splitVals(decl: string): string[] {
  const prot: string[] = []
  const s = decl.replace(/(?:var|calc)\([^()]*(?:\([^()]*\)[^()]*)*\)/g, (m) => {
    prot.push(m)
    return `\x00${prot.length - 1}\x00`
  })
  return s.split(/\s+/).map((tok) => {
    const m = /^\x00(\d+)\x00$/.exec(tok)
    return m ? prot[Number(m[1])]! : tok
  })
}

interface ScanResult {
  files: string[]
  brDeclTotal: number
  spDeclTotal: number
  illegalRadius: Map<string, Map<string, number>>
  oddSpacing: Map<string, number>
  pill: number
  circle: number
}

function scan(): ScanResult {
  const files = walk(CLIENT_ROOT)
  const illegalRadius = new Map<string, Map<string, number>>()
  const oddSpacing = new Map<string, number>()
  let brDeclTotal = 0
  let spDeclTotal = 0
  let pill = 0
  let circle = 0
  for (const f of files) {
    const rel = relative(CLIENT_ROOT, f).replaceAll('\\', '/')
    const text = readFileSync(f, 'utf8')
    for (const m of text.matchAll(BR_RE)) {
      brDeclTotal++
      const v = m[1]!.trim()
      if (classifyRadius(v) === 'illegal') {
        const per = illegalRadius.get(rel) ?? new Map<string, number>()
        per.set(v, (per.get(v) ?? 0) + 1)
        illegalRadius.set(rel, per)
      } else if (v === '999px') pill++
      else if (v === '50%') circle++
    }
    for (const m of text.matchAll(SP_RE)) {
      spDeclTotal++
      const nOdd = splitVals(m[1]!).filter((t) => ODD_RE.test(t)).length
      if (nOdd > 0) oddSpacing.set(rel, (oddSpacing.get(rel) ?? 0) + nOdd)
    }
  }
  return { files, brDeclTotal, spDeclTotal, illegalRadius, oddSpacing, pill, circle }
}

/** ── 基线（2026-09-25 实测：62 文件 / br 583 / sp 1466 / illegal 325 / pill 81 / circle 66 / odd 122）── */
const RADIUS_BASELINE: Record<string, Record<string, number>> = {
  'ui-wechat/src/client/pages/wechat-data/panels/chats-cards.module.css': { '8px': 11, '6px': 7, '10px': 4, '4px': 3, '12px': 2, '14px': 1, '16px': 1 },
  'ui-wechat/src/client/pages/wechat-data/panels/chats-rows.module.css': { '8px': 3, '6px': 3, '2px': 3, '4px': 2, '14px': 1, '3px': 1 },
  'ui-wechat/src/client/pages/wechat-data/panels/chats-shell.module.css': { '3px': 1 },
  'ui-wechat/src/client/pages/wechat-data/panels/chats.module.css': { '2px': 6, '4px': 3, '9px': 2, '10px': 1 },
}

const ODD_SPACING_BASELINE: Record<string, number> = {
  'ui-primitives-shim/src/Button.module.css': 1,
  'ui-wechat/src/client/pages/wechat-data/panels/chats-cards.module.css': 8,
  'ui-wechat/src/client/pages/wechat-data/panels/chats-rows.module.css': 2,
  'ui-wechat/src/client/pages/wechat-data/panels/chats-shell.module.css': 1,
  'ui-wechat/src/client/pages/wechat-data/panels/chats.module.css': 4,
}

const PILL_MAX = 8
const CIRCLE_MAX = 66
const ILLEGAL_RADIUS_TOTAL_MAX = 55
const ODD_SPACING_TOTAL_MAX = 16
const FILES_MIN = 61
const BR_DECL_MIN = 500
const SP_DECL_MIN = 1200

describe('几何规范守卫（docs/UI-GEOMETRY-SPEC.md）', () => {
  it('哨兵：扫描面没有塌（文件数 / 圆角声明数 / 间距声明数）', () => {
    const r = scan()
    // 三个数掉到线下一律视为「解析坏了在空转」——比放行后再被上线的假绿便宜得多。
    expect(r.files.length, `扫描文件数 ${r.files.length} < ${FILES_MIN}：walk 根或过滤规则被改坏`).toBeGreaterThanOrEqual(FILES_MIN)
    expect(r.brDeclTotal, `border-radius 声明总数 ${r.brDeclTotal} < ${BR_DECL_MIN}：正则或扫描范围被改坏`).toBeGreaterThanOrEqual(BR_DECL_MIN)
    expect(r.spDeclTotal, `间距声明总数 ${r.spDeclTotal} < ${SP_DECL_MIN}：同上`).toBeGreaterThanOrEqual(SP_DECL_MIN)
  })

  it('① 圆角字面量只许减（per-file per-value 棘轮），基线不许留尸，新值零容忍', () => {
    const r = scan()
    const problems: string[] = []
    // 反向：基线条目必须仍然成立（文件存在、值仍有存量；清零必须删条目）。
    for (const [file, values] of Object.entries(RADIUS_BASELINE)) {
      if (!existsSync(join(CLIENT_ROOT, file))) {
        problems.push(`基线文件已不存在（改名/删除后请清基线）: ${file}`)
        continue
      }
      const actual = r.illegalRadius.get(file)
      for (const [v, max] of Object.entries(values)) {
        const n = actual?.get(v) ?? 0
        if (n > max) problems.push(`${file}: '${v}' 出现 ${n} 次 > 基线 ${max}`)
        else if (n === 0) problems.push(`${file}: '${v}' 已清零 —— 删掉这条基线（防空转）`)
      }
    }
    // 正向：实际出现的非法值必须全部在基线内（新文件 / 新值零容忍）。
    for (const [file, values] of r.illegalRadius) {
      const base = RADIUS_BASELINE[file]
      if (!base) {
        problems.push(`${file}: 出现非法圆角（新文件必须全令牌）：${[...values.keys()].join(', ')}`)
        continue
      }
      for (const [v, n] of values) {
        if (!(v in base)) problems.push(`${file}: 新增非法圆角 '${v}' ×${n}（映射归宿见 UI-GEOMETRY-SPEC.md §2）`)
      }
    }
    const total = [...r.illegalRadius.values()].reduce((s, m) => s + [...m.values()].reduce((a, b) => a + b, 0), 0)
    if (total > ILLEGAL_RADIUS_TOTAL_MAX) problems.push(`非法圆角总数 ${total} > ${ILLEGAL_RADIUS_TOTAL_MAX}（全局双保险）`)
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('② 奇数间距（5/7/9/18px）只许减（per-file 棘轮），新文件零容忍', () => {
    const r = scan()
    const problems: string[] = []
    for (const [file, max] of Object.entries(ODD_SPACING_BASELINE)) {
      if (!existsSync(join(CLIENT_ROOT, file))) {
        problems.push(`基线文件已不存在（改名/删除后请清基线）: ${file}`)
        continue
      }
      const n = r.oddSpacing.get(file) ?? 0
      if (n > max) problems.push(`${file}: 奇数间距 ${n} 处 > 基线 ${max}`)
      else if (n === 0) problems.push(`${file}: 奇数间距已清零 —— 删掉这条基线`)
    }
    for (const [file, n] of r.oddSpacing) {
      if (!(file in ODD_SPACING_BASELINE)) problems.push(`${file}: 新文件出现奇数间距 ${n} 处（归宿表见 UI-GEOMETRY-SPEC.md §3）`)
    }
    const total = [...r.oddSpacing.values()].reduce((a, b) => a + b, 0)
    if (total > ODD_SPACING_TOTAL_MAX) problems.push(`奇数间距总数 ${total} > ${ODD_SPACING_TOTAL_MAX}（全局双保险）`)
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('③ 999px 与 50% 只许减（防胶囊逃逸令牌 / 防矩形滥用圆形）', () => {
    const r = scan()
    expect(r.pill, `999px 字面量 ${r.pill} 处 > ${PILL_MAX}：一律 var(--nm-r-pill, 999px)`).toBeLessThanOrEqual(PILL_MAX)
    expect(r.circle, `50% 字面量 ${r.circle} 处 > ${CIRCLE_MAX}：仅限确属正方形圆形（UI-GEOMETRY-SPEC.md §2）`).toBeLessThanOrEqual(CIRCLE_MAX)
  })
})
