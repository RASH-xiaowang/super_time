/**
 * 性能基准登记表守卫：`scripts/run-measures.mjs` 的 `MEASURES` 与磁盘上的 `*.measure.spec.ts`
 * 必须一一对应，且每个基准都要有「真实产出的数字」可查。
 *
 * ## 为什么需要它
 *
 * `run-measures.mjs` 的文件头自己写着：这份登记表存在的理由是「让『有哪些基准』有一个能 grep、
 * 能加断言的地方 —— 否则新增一个基准的人不会想到要去改这里，基准就会悄悄退回到『没人跑』的状态」。
 * 但在本守卫出现之前，这句话**没有任何判据兑现**：登记表与磁盘可以任意漂移——
 * 新增 spec 不进表（`npm run measure:quick` 永远不跑它）、表里留着已删文件（spawn 直接失败）、
 * 两个基准共用一个门控变量（一个跑一个不跑，而表面看不出来）。
 *
 * 三条判据（都是机械可查的事实，不猜）：
 *   ① 磁盘上的每个 `*.measure.spec.ts` 都在登记表里（新增必须在册）；
 *   ② 登记表里的每个文件都真实存在（删了必须同步删表，否则 runner 直接崩）；
 *   ③ 门控变量互不重复（重复时 spawn 的 env 会让两个基准同时开或同时关）。
 * 另加一条防空转：两侧数量都不能为 0（否则「相等」恒真）。
 *
 * 变异自证：从表里删一行 → ①红；往表里加一个不存在的文件 → ②红；
 * 把一个 gate 改成与另一行相同 → ③红。
 * @vitest-environment node
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const RUNNER = join(ROOT, 'scripts', 'run-measures.mjs')
const TEST_TREES = [
  join(ROOT, 'src', 'backend', 'wechat-data', 'tests'),
  join(ROOT, 'src', 'backend', 'tests'),
]

/** 磁盘上的基准文件（仓库相对路径、正斜杠）。 */
function onDisk(): string[] {
  const out: string[] = []
  for (const tree of TEST_TREES) {
    if (!existsSync(tree)) continue
    for (const e of readdirSync(tree, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.measure.spec.ts')) out.push(relative(ROOT, join(tree, e.name)).replace(/\\/g, '/'))
    }
  }
  return out.sort()
}

/** 登记表里的行（runner 是 ESM，这里按文本抽 `{ gate, file }` 形状，不 import 它有副作用）。 */
function inRunner(): Array<{ gate: string; file: string; tier: string }> {
  const src = readFileSync(RUNNER, 'utf8')
  const rows = [...src.matchAll(/\{\s*gate:\s*'([A-Z0-9_]+)',\s*file:\s*'([^']+)',\s*tier:\s*'(\w+)'/g)]
  return rows.map((m) => ({ gate: m[1] ?? '', file: m[2] ?? '', tier: m[3] ?? '' }))
}

describe('性能基准登记表（run-measures）与磁盘一致', () => {
  const disk = onDisk()
  const listed = inRunner()

  it('防空转：两侧都真的读到了东西', () => {
    expect(disk.length, '磁盘上一个 *.measure.spec.ts 都没读到 ⇒ 扫描目标错了').toBeGreaterThanOrEqual(8)
    expect(listed.length, '登记表一行都没解析出来 ⇒ 解析口径错了').toBeGreaterThanOrEqual(8)
  })

  it('磁盘上的每个基准都在登记表里（新增必须在册，否则没人跑它）', () => {
    const listedFiles = new Set(listed.map((r) => r.file))
    const missing = disk.filter((f) => !listedFiles.has(f))
    expect(missing, `这些基准没进 run-measures 的登记表（npm run measure:* 永远不会跑它们）：${missing.join(', ')}`).toEqual([])
  })

  it('登记表里的每个文件都真实存在（删了文件必须同步删表）', () => {
    const gone = listed.filter((r) => !disk.includes(r.file)).map((r) => r.file)
    expect(gone, `登记表指着不存在的基准文件（runner 会直接失败）：${gone.join(', ')}`).toEqual([])
  })

  it('门控变量互不重复（重复时两个基准会被同一个 env 同时开关）', () => {
    const seen = new Map<string, string>()
    const dup: string[] = []
    for (const r of listed) {
      const prev = seen.get(r.gate)
      if (prev !== undefined) dup.push(`${r.gate}（${prev} 与 ${r.file}）`)
      else seen.set(r.gate, r.file)
    }
    expect(dup, `这些门控变量被多个基准共用：${dup.join('；')}`).toEqual([])
  })

  /**
   * 档位必须在**基准自己的文件头**里也写一遍（W2-13.4）。
   *
   * 为什么要这一条：档位是**成本承诺**。只写在 `run-measures.mjs` 里的话，写新基准的人
   * 根本不会去看那一行 —— 于是「秒级基准被塞进 nightly 档」就会静静发生，而那正是这份
   * 登记表当初要防的失败方式（只是从「没人跑」换成了「PR 门禁里不跑」）。
   *
   * 本轮真的发生了：七个秒级基准（最慢 1.02s）被统一塞进 `slow` 档，而 `slow` 档
   * 唯一的真慢基准是 `export-memory`（801.5 秒）。
   */
  it('每个基准的文件头都写了自己的档位，且与登记表一致', () => {
    const bad: string[] = []
    for (const r of listed) {
      const src = readFileSync(join(ROOT, r.file), 'utf8')
      const m = /档位：\s*(quick|slow)/.exec(src)
      if (m === null) { bad.push(r.gate + ' 文件头没写档位：' + r.file); continue }
      if (m[1] !== r.tier) bad.push(r.gate + ' 文件头写的是 ' + m[1] + '，登记表是 ' + r.tier + '：' + r.file)
    }
    expect(bad, '这些基准的档位没在文件头里声明，或与登记表不一致：' + bad.join(' / ')).toEqual([])
  })

  it('slow 档只留真慢的（实测 801.5 秒那一条），其余进 quick 才有意义', () => {
    const slow = listed.filter((r) => r.tier === 'slow')
    expect(slow.length, '一个慢基准都没有 ⇒ 分档这件事被绕过去了').toBeGreaterThan(0)
    expect(slow.length, 'slow 档里塞了 ' + String(slow.length) + ' 条 —— 分档按**实测耗时**分，nightly 档每多一条就少一条会被 CI 真跑的基准').toBeLessThanOrEqual(2)
  })
})