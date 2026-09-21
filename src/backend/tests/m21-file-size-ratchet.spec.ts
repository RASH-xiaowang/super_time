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
 */
const ALLOWLIST: Record<string, number> = {
  'main.js': 1423,
  'scripts/ui-acceptance.mjs': 1159,
  'src/backend/wechat-data/src/gateway.ts': 4837,
  'src/backend/wechat-data/src/query/kb-files.ts': 1113,
  'src/client/ui-app/onboarding/onboarding.module.css': 1618,
  'src/client/ui-wechat/src/client/pages/wechat-data/api.ts': 2434,
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/Chats.tsx': 3957,
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/GraphCanvas.tsx': 1031,
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/KbFiles.tsx': 1277,
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/Moments.tsx': 1696,
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/Overview.tsx': 1010,
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/Settings.tsx': 1978,
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats.module.css': 2904,
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/graph-canvas.spec.ts': 1096,
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/graph-canvas.ts': 1550,
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/overview.module.css': 1030,
  'src/client/ui-wechat/src/client/pages/wechat-data/panels/settings.module.css': 1007,
  'src/client/ui-wechat/src/client/pages/wechat-data/ui/kit.module.css': 1073,
  'src/client/ui-wechat/src/client/pages/wechat-data/ui/kit.tsx': 1036,
}

/** 生成物 / 随包资产：不计入行数口径（每条给出理由）。 */
const EXCLUDED = [
  ['src/backend/wechat-data/lib/', 'esbuild/tsc 生成物（CI 有「重建后 git diff 为空」门禁）'],
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
