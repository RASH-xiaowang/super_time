// @vitest-environment node
/**
 * 拼给 `powershell.exe -Command` 的那段文本必须走 `powershellLiteral`（审计 P3-11 的防回归）。
 *
 * 为什么这条值得全仓扫而不是只测 `whisper.ts`：`-Command` 收到的是**脚本文本**，不是 argv ——
 * 字面量里一个没转义的 `'` 就会把后面的内容变成要执行的代码。这类写法有个讨厌的特点：
 * **在本机永远是对的**（`C:\Users\me\…` 里没有撇号），换台机器（`O'Brien`）才炸，
 * 而炸法可能是执行、不只是报错。所以规矩要写成"以后谁再拼这种串也得过这道闸"。
 *
 * 扫描先剥注释（口径照 `model-name-single-source.spec.ts` 一字不差）：注释里的代码字样
 * 本仓已经三次被当成代码。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', 'wechat-data')
const SRC = join(PKG, 'src')
const OWNER = join('query', 'whisper.ts')
const HELPER = 'powershellLiteral'
/** `-Command` 之后看这么长：足够覆盖一条 `Expand-Archive …` 的完整拼接。 */
const WINDOW = 300

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...tsFiles(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

/** 找出「往 -Command 串里插了值、却没经过 `powershellLiteral`」的调用点。 */
function unquotedCommandSites(files: readonly string[], sourceOf: (p: string) => string = (p) => strip(readFileSync(p, 'utf8'))): string[] {
  const hits: string[] = []
  for (const p of files) {
    const text = sourceOf(p)
    for (const marker of ["'-Command'", '"-Command"']) {
      for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + 1)) {
        const win = text.slice(at, at + WINDOW)
        if (win.includes('${') && !win.includes(`${HELPER}(`)) {
          hits.push(`${p.replace(SRC + '\\', '').replace(SRC + '/', '')}:${String(at)}`)
        }
      }
    }
  }
  return hits
}

describe('powershell -Command 的拼接纪律', () => {
  const files = tsFiles(SRC)

  it('扫描真的覆盖到了整棵树，且确实有一个 PowerShell 调用点（不然下面几条是恒真）', () => {
    expect(files.length, '没扫到源码文件 —— 路径判错').toBeGreaterThan(80)
    const withPs = files.filter((p) => strip(readFileSync(p, 'utf8')).includes('powershell.exe'))
    expect(withPs.length, '全仓已经没有 `powershell.exe` 调用点 ⇒ 这条守卫空转，改口径或删掉').toBeGreaterThan(0)
    expect(withPs.some((p) => p.endsWith(OWNER)), 'whisper 的那个兜底调用点不在扫描里').toBe(true)
  })

  it('每个 `-Command` 拼接都经过 `powershellLiteral`（插值绕过转义就当场红）', () => {
    expect(unquotedCommandSites(files), '这些 -Command 串把值直接插进了脚本文本').toEqual([])
  })

  it(`powershellLiteral 只有一个定义处（口径分叉 = 有的调用点悄悄不转义）`, () => {
    const rel = (p: string): string => p.replace(SRC + '\\', '').replace(SRC + '/', '').replace(/\\/g, '/')
    const defs = files.filter((p) => new RegExp(`export function ${HELPER}\\(`).test(strip(readFileSync(p, 'utf8'))))
      .map(rel)
    expect(defs, '出现第二份 `powershellLiteral` ⇒ 两条转义口径会分叉').toEqual([`${OWNER.replace(/\\/g, '/')}`])
  })

  it('反例自证：旧写法（裸插值进单引号字面量）会被同一条判据抓住', () => {
    const bad = "spawnSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${'${zipPath}'}' -Force`], {})"
    const good = "spawnSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath ${'${powershellLiteral(zipPath)}'} -Force`], {})"
    const fake = (src: string): string[] => unquotedCommandSites([join(SRC, 'fake.ts')], () => `'-Command'${src}`)
    expect(fake(bad).length, '旧写法没被判据抓住 ⇒ 判据是恒真的').toBeGreaterThan(0)
    expect(fake(good), '经过 helper 的写法被误判 ⇒ 判据太宽').toEqual([])
    // 现网那份真文件仍是干净的（反例字符串没漏进源码）
    expect(readFileSync(join(SRC, OWNER), 'utf8')).not.toContain('-LiteralPath \'${')
  })
})
