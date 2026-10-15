// @vitest-environment node
/**
 * W2-8.2 的接线判据 —— **补行为判据的盲区**。
 *
 * ## 为什么还需要这一层
 *
 * `export-cancel-82.spec.ts` 是行为判据（真造 2600 行、真并发取消、真验没有半成品）。
 * 它能钉住「取消会发生」，但**钉不住检查点的位置**，实测三个变异对着它全绿：
 *
 *   ① 去掉「写盘前」那次取消检查 ⇒ 仍绿 —— 因为取消是从**第一条进度事件**触发的，
 *      而那条事件在拼行之前就已经发了，逐行检查照样拦得住；
 *   ② 去掉年报**扫描里**的取消检查点 ⇒ 仍绿 —— 因为 `exportAnnualReport` 在调
 *      `queryAnnualReport` **之前**与**之后**各查了一次，扫描里那次去掉不影响结果；
 *   ③ 把 `throwIfCancelled` 换成 `throw new Error('操作已取消')` ⇒ 仍绿 ——
 *      因为被换掉的是**第一处**，后面几处还在抛 `CancelledError`。
 *
 * 三条都是「别的地方还兜着」，所以行为判据看不出来。这类只能按**接线**钉。
 * @module export-cancel-82-wiring
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const FLOWS = fileURLToPath(new URL('../src/query/export-flows.ts', import.meta.url))
const ANNUAL = fileURLToPath(new URL('../src/query/annual-report.ts', import.meta.url))
const REMOTES = fileURLToPath(new URL('../src/remotes/export.ts', import.meta.url))
const OPS = fileURLToPath(new URL('../src/gateway-export-ops.ts', import.meta.url))
const flows = readFileSync(FLOWS, 'utf8')
const annual = readFileSync(ANNUAL, 'utf8')
const remotes = readFileSync(REMOTES, 'utf8')
const ops = readFileSync(OPS, 'utf8')

/** 取某个函数体（从它的定义行到下一个顶格 `}`）。 */
function bodyOf(src: string, sig: string): string {
  const at = src.indexOf(sig)
  expect(at, '找不到：' + sig).toBeGreaterThan(-1)
  // 按行切，不能按 `\n}` 找边界 —— 这些源文件是 CRLF，
  // 那样会把整个文件后半段都算进来（第一版就这么把 finishStreamJob 数成了 8 次）。
  const startLine = src.slice(0, at).split(/\r?\n/).length
  const all = src.split(/\r?\n/)
  const indent = /^[ \t]*/.exec(all[startLine - 1] ?? '')?.[0] ?? ''
  const out = [all[startLine - 1]]
  for (let i = startLine; i < all.length; i += 1) {
    // 对象字面量里的方法收尾是 `},` 而不是 `}` —— 两种都要认，
    // 否则会一路扫到文件末尾（第一版就这么把 finishStreamJob 数成了 8 次）。
    if (all[i] === indent + '}' || all[i] === indent + '},') { out.push(all[i]); break }
    out.push(all[i])
  }
  return out.join('\n')
}

describe('W2-8.2 exportCsv 的检查点位置', () => {
  const body = bodyOf(flows, 'export async function exportCsv(')
  const checks = body.match(/throwIfCancelled\(ctrl\?\.signal\)/g) ?? []

  it('每个拼行分支都有一处取消检查（六种导出类型一个都不能少）', () => {
    // contacts / favorites / records / moments / privacy 五个 for 循环 + 函数开头 + 写盘前 = 7。
    expect(checks.length, '取消检查点比预期少 ⇒ 有某条导出路径停不下来').toBe(7)
    const loops = ['for (const c of env.contacts) {', 'for (const f of env.favorites) {', 'for (const it of env.items) {', 'for (const m of env.moments) {', 'for (const c of env.categories) {']
    for (const l of loops) {
      const i = body.indexOf(l)
      expect(i, '导出分支不见了：' + l).toBeGreaterThan(-1)
      const seg = body.slice(i, i + 260)
      expect(seg, '这个分支里没有取消检查 ⇒ 几万行的那几种 CSV 停不下来：' + l).toContain('throwIfCancelled(ctrl?.signal)')
    }
  })

  it('写盘前那一道必须在（取消 ⇒ 一个字节都不落盘）', () => {
    const i = body.indexOf('const csvDenial = writeDenialReason(')
    expect(i).toBeGreaterThan(-1)
    const before = body.slice(Math.max(0, i - 400), i)
    expect(before, '写盘前没有取消检查').toContain('throwIfCancelled(ctrl?.signal)')
  })

  it('进度两段都有：collect 的收尾是「行数 = 总行数」，write 是 0/1 → 1/1', () => {
    expect(body).toContain("ctrl?.onProgress?.({ phase: 'collect', done: 0, total: 0 })")
    expect(body).toMatch(/phase: 'collect', done: rows\.length, total: rows\.length/)
    expect(body).toContain("ctrl?.onProgress?.({ phase: 'write', done: 0, total: 1 })")
    expect(body).toContain("ctrl?.onProgress?.({ phase: 'write', done: 1, total: 1 })")
  })
})

describe('W2-8.2 exportAnnualReport 的检查点位置', () => {
  const body = bodyOf(flows, 'export async function exportAnnualReport(')

  it('扫描**之前**与**之后**各查一次取消', () => {
    expect(body.indexOf("phase: 'collect', done: 0, total: 0")).toBeGreaterThan(-1)
    const i = body.indexOf('queryAnnualReport(')
    const after = body.slice(i, i + 400)
    expect(after, '扫描刚回来那一道取消检查没了 ⇒ 用户在这几毫秒里点停止仍会落盘').toContain('throwIfCancelled(ctrl?.signal)')
  })

  it('写盘前再查一次，且 write 进度 0/1 → 1/1', () => {
    const i = body.indexOf('writeFileAtomicSync(path, content)')
    expect(i).toBeGreaterThan(-1)
    const seg = body.slice(Math.max(0, i - 300), i + 200)
    expect(seg).toContain('throwIfCancelled(ctrl?.signal)')
    expect(seg).toContain("phase: 'write', done: 0, total: 1")
    expect(seg).toContain("phase: 'write', done: 1, total: 1")
  })

  it('ctrl 透传进 queryAnnualReport（否则扫描里那份根本收不到）', () => {
    expect(body).toContain('queryAnnualReport(decryptedDir, year, ctrl)')
  })
})

describe('W2-8.2 年报扫描内部', () => {
  it('取消与进度挂在**让出点**上（那一大坨 CPU 重活的天然边界）', () => {
    const i = annual.indexOf('await yieldToLoop()')
    expect(i).toBeGreaterThan(-1)
    const seg = annual.slice(i, i + 400)
    expect(seg, '让出点之后没有取消检查').toContain('throwIfCancelled(ctrl?.signal)')
    expect(seg, '让出点之后没有进度上报').toMatch(/onProgress\?\.\(\{ phase: 'collect'/)
  })

  it('ctrl 从 queryAnnualReport 一路透到 computeAnnualReport', () => {
    expect(annual).toContain('computeAnnualReport(decryptedDir, year, ctrl)')
    expect(annual).toMatch(/async function computeAnnualReport\(decryptedDir: string, year: number, ctrl\?: StreamControl\)/)
  })

  it('取消在 loader **内部**抛 ⇒ 缓存不会写（半张年报进缓存 = 接下来 60 秒都拿到残缺的）', () => {
    const i = annual.indexOf('cachedBySigAsync(')
    expect(i).toBeGreaterThan(-1)
    const seg = annual.slice(i, i + 300)
    expect(seg).toContain('computeAnnualReport(decryptedDir, year, ctrl)')
  })
})

describe('W2-8.2 gateway 接线', () => {
  it('两条入口都经 withStreamJob 传 streamControl，并在成功/失败两条路径上清在飞槽', () => {
    // withStreamJob 是模块级助手：它在 finally 里清在飞槽 —— 少这一步，
    // 同一个 jobId 的下一次调用会撞上「上一个还在跑」。
    expect(remotes).toContain('rc.streamControl(jobId)')
    expect(remotes).toMatch(/finally \{[\s\S]{0,80}rc\.finishStreamJob\(jobId\)/)
    const ar = bodyOf(remotes, 'async exportAnnualReport(')
    expect(ar).toContain('withStreamJob(rc, normalizeJobId(options?.jobId)')
    expect(ar, '年报的失败路径没清在飞槽').toContain("failStreamJob(rc, normalizeJobId(options?.jobId), 'export_annual_report'")
    const csv = bodyOf(remotes, 'async exportCsv(')
    expect(csv).toContain('withStreamJob(rc, normalizeJobId(options?.jobId)')
    expect(csv, 'CSV 的失败路径没清在飞槽').toContain("failStreamJob(rc, normalizeJobId(options?.jobId), 'export_csv'")
  })

  it('@Remote 契约上确实有 jobId（没有它前端连取消都发不出来）', () => {
    expect(ops).toMatch(/async exportAnnualReport\(options: \{[^}]*jobId\?: string/)
    expect(ops).toMatch(/async exportCsv\(options: \{[^}]*jobId\?: string/)
    expect(remotes).toMatch(/async exportAnnualReport\(options: \{[^}]*jobId\?: string/)
    expect(remotes).toMatch(/async exportCsv\(options: \{[^}]*jobId\?: string/)
  })
})
