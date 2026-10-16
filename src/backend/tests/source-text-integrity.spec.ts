/**
 * 源码必须是「文本」：不许混进 NUL 之类会让工具把它当二进制的字节。
 *
 * ## 为什么这条值得单独守（2026-09-26 本轮真实踩到）
 *
 * 本仓的守卫有一大半是**读源码文本**做判据的（`grep`、AST、`endsWith`、台账正则）。
 * 一旦某个 `.ts` 里混进一个 0x00 字节，`grep` 就把它当二进制文件：
 * 打印 `Binary file matches` 并**跳过逐行输出**，于是所有基于行的扫描对那个文件
 * **静默失效** —— 不是报错，是「查无此类」。本轮就是我自己写注释时把 `3\0` 落成真字节，
 * 靠 `git show HEAD:<path> > <path>` 逐字节复原才发现。
 *
 * 这类失效特别值钱的地方在于：**它只会让守卫变绿，不会让守卫变红**。
 * 所以这里守的是「文件仍然是文本」，而不是「某个具体判据对不对」。
 * @vitest-environment node
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SCAN_DIRS = ['src', 'scripts']
const SKIP = new Set(['node_modules', 'deps', 'lib', 'ui-dist', 'dist', 'fixtures', 'native', 'resources'])
const EXTENSIONS = ['.ts', '.tsx', '.js', '.cjs', '.mjs', '.css', '.html', '.json']

/**
 * 会让工具把文件当二进制的字节。
 * `\t`(09) `\n`(0a) `\r`(0d) 是正常排版，不在其列；0x1b(ESC) 也一并禁 ——
 * 它是 ANSI 色码的开头，构建产物里残留的色码会把「一行一条」的判据糊成一团。
 */
const CONTROL_BYTES: ReadonlyArray<number> = [0x00, 0x08, 0x0b, 0x0c, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f]

/** 逐个文件读出字节，返回越界字节的描述（合法则空数组）。 */
function controlBytesIn(text: string): string[] {
  const buf = Buffer.from(text, 'utf8')
  const out: string[] = []
  for (const byte of CONTROL_BYTES) {
    let at = buf.indexOf(byte)
    while (at >= 0) {
      out.push(`0x${byte.toString(16).padStart(2, '0')} @ ${String(at)}`)
      at = buf.indexOf(byte, at + 1)
    }
  }
  return out
}

function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) { walk(rel); continue }
      if (!EXTENSIONS.some((x) => e.name.endsWith(x))) continue
      if (!statSync(join(ROOT, rel)).isFile()) continue
      out.push(rel)
    }
  }
  for (const d of SCAN_DIRS) walk(d)
  // 根目录的宿主层入口不在 `src/` 下，但恰恰是被最多判据读的那几个文件
  for (const f of ['main.js', 'preload.js', 'vitest.config.ts']) if (existsSync(join(ROOT, f))) out.push(f)
  return out.sort()
}

const files = sourceFiles()

describe('源码保持纯文本（否则文本类守卫会对那个文件静默失效）', () => {
  it('扫描集合非空，且真的覆盖到后端与宿主层（防空转）', () => {
    expect(files.length, '一个文件都没扫到 ⇒ 判据恒真').toBeGreaterThan(400)
    expect(files.some((f) => f.startsWith('src/backend/wechat-data/src/'))).toBe(true)
    expect(files.some((f) => f.startsWith('src/client/ui-wechat/'))).toBe(true)
    expect(files.some((f) => f === 'main.js'), '宿主入口没在扫描集合里 ⇒ 这一层没人看着').toBe(true)
  })

  it('判据自证：喂它一段带 NUL / ESC 的内容，它必须逐处报出位置', () => {
    const dirty = Buffer.concat([Buffer.from('ok\n', 'utf8'), Buffer.from([0x00]), Buffer.from('x'), Buffer.from([0x1b])]).toString('utf8')
    const found = controlBytesIn(dirty)
    expect(found.length, '判据认不出 NUL/ESC ⇒ 整条用例是恒真').toBe(2)
    expect(found.join(',')).toMatch(/0x00/)
    expect(controlBytesIn('正常的\t制表与\n换行\r\n 和中文、emoji 🎯 都不算')).toEqual([])
  })

  it('每个源码文件里都没有会触发「binary file」的字节', () => {
    const offenders: string[] = []
    for (const rel of files) {
      const found = controlBytesIn(readFileSync(join(ROOT, rel), 'utf8'))
      if (found.length > 0) offenders.push(`${rel}: ${found.join(', ')}`)
    }
    expect(offenders, '这些文件会让 grep/行级判据把它们当二进制跳过：\n  ' + offenders.join('\n  ')).toEqual([])
  })

  it('每个文件都是合法 UTF-8 且没有 BOM（BOM 会让第一行的判据对不上）', () => {
    const odd: string[] = []
    for (const rel of files) {
      const raw = readFileSync(join(ROOT, rel))
      if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) odd.push(`${rel}: 开头有 BOM`)
      // 判据是**往返一致**：非法字节序列会被解码成 U+FFFD，再编回去就和原字节不同。
      // 注释里本来就写着 U+FFFD 的历史乱码（`light-theme.css`）能往返一致 ⇒ 不在这里判红，
      // 那是内容问题，已单独记进  的「本轮新发现」。
      if (!Buffer.from(raw.toString('utf8'), 'utf8').equals(raw)) odd.push(`${rel}: 不是合法 UTF-8 字节序列`)
    }
    expect(odd, '这些文件的字节不是合法 UTF-8 / 带 BOM：\n  ' + odd.join('\n  ')).toEqual([])
  })
})
