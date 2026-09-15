/**
 * N3：构建日志里的体积统计必须报**真实字节数**（曾经恒报 `(0 KB)`）。
 *
 * 为什么值得一条用例：这条日志是「产物到底写了多少」的唯一读数，而它长期同时打印
 * 「esbuild 自己的 `794.1kb`」与「本脚本的 `0 KB`」—— 一个报错值的统计比没有统计更糟，
 * 它看起来像「产物是空的」。根因（本机实测，esbuild 0.28.2）是 `result.metafile.outputs`
 * 的键与脚本手里的 `outfile` 不是同一个字符串：
 *   · 产物在 cwd 内时，键是**相对 cwd 的正斜杠路径**（`src/backend/wechat-data/lib/index.js`），
 *     而 `outfile` 是绝对反斜杠路径 ⇒ 键匹配不上；
 *   · 产物在 cwd 外（或跨盘）时，键是**绝对正斜杠路径**（`C:/...`）⇒ 同样匹配不上。
 *
 * 用例断言的是「取值函数返回的字节数 == 磁盘上的字节数」这个性质，而不是某一种键格式：
 * 真跑一次 esbuild（临时目录，不碰仓库产物）拿到真实 metafile，再逐条比对。
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'

const requireCjs = createRequire(import.meta.url)
const { outputBytes } = requireCjs('../../../scripts/build-wechat-bundle.js') as {
  outputBytes: (metafile: unknown, outfile: string) => number
}

const scratch = mkdtempSync(join(tmpdir(), 'st-bundle-size-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

/** 与真实构建同形的产物路径：绝对反斜杠。 */
function outIn(tag: string): string {
  const dir = join(scratch, tag, 'lib')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'index.js')
}

describe('outputBytes（构建日志的体积统计）', () => {
  it('对真实 esbuild 产物返回磁盘上的真实字节数（N3 的回归点）', async () => {
    const entry = join(scratch, 'entry.ts')
    writeFileSync(entry, 'export const answer = 40 + 2\n', 'utf8')
    const outfile = outIn('real')
    const result = await build({
      entryPoints: [entry], bundle: true, format: 'esm', platform: 'node',
      target: 'node22', outfile, metafile: true, logLevel: 'silent',
    })
    const outputs = result.metafile!.outputs
    expect(Object.keys(outputs).length, 'metafile 里必须有产物条目，否则本用例是空转').toBeGreaterThan(0)
    const real = statSync(outfile).size
    expect(real).toBeGreaterThan(0)
    expect(outputBytes(result.metafile, outfile)).toBe(real)
    // 复现缺陷成因：原样键（绝对反斜杠路径）取不到值 —— 这正是恒报 0 KB 的那一步。
    // 若哪天 esbuild 换了键格式导致这里能取到值，说明缺陷不复现，可据此收掉本用例。
    expect(outputs[outfile], '原写法取不到值（0 KB 的成因）').toBeUndefined()
  })

  it('键是相对 cwd 的正斜杠路径时也能命中（仓库里的真实形态）', () => {
    const outfile = outIn('rel')
    writeFileSync(outfile, 'x'.repeat(64), 'utf8')
    const posixRel = relative(process.cwd(), outfile).split(sep).join('/')
    expect(outputBytes({ outputs: { [posixRel]: { bytes: 1111 } } }, outfile)).toBe(1111)
    expect(outputBytes({ outputs: { [posixRel.replace(/\//g, '\\')]: { bytes: 2222 } } }, outfile)).toBe(2222)
  })

  it('metafile 里没有该键时退回磁盘真实大小，而不是报 0', () => {
    const outfile = outIn('fallback')
    writeFileSync(outfile, 'x'.repeat(2048), 'utf8')
    const bytes = outputBytes({ outputs: {} }, outfile)
    expect(bytes).toBe(2048)
    expect(bytes, '绝不返回 0（0 正是被修掉的假读数）').toBeGreaterThan(0)
  })
})
