// @vitest-environment node
/**
 * `extractZip` 那条 PowerShell 兜底命令的守卫（审计 P3-11）。
 *
 * 为什么值得单独钉：`powershell.exe -Command <一串文本>` 拿到的是**脚本**，不是 argv ——
 * 路径里一个撇号（`C:\Users\O'Brien\…` 是真实存在的产品名/用户名形状）就提前终结那个单引号
 * 字面量，剩下的部分变成"要执行的代码"。`tar.exe` 那一路走参数数组、不过 shell，所以
 * 全仓只有这一处需要转义；而它恰好是"下载来的包解压时执行"的那条路径。
 * 这里不只看字符串等不等，而是**按 PowerShell 的引号规则扫一遍命令**，证明注入的那段
 * 落在字面量内部（`codePoints` 那一段）—— 只断字符串相等的话，改天有人"顺手优化"成
 * 另一种拼接法，用例还可能绿着。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractZip, powershellLiteral } from '../src/query/whisper.ts'

const child = vi.hoisted(() => ({ spawn: vi.fn(), execFileSync: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: child.spawn, execFileSync: child.execFileSync }))

let dir = ''
beforeEach(() => {
  child.spawn.mockReset()
  child.execFileSync.mockReset()
  dir = mkdtempSync(join(tmpdir(), 'whisper-ps-'))
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** 异步 spawn 的假进程：stdout/stderr 可消费，close 在微任务里回报给定状态。 */
function childProcess(status: number): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  queueMicrotask(() => proc.emit('close', status))
  return proc
}

/** 取出那次 PowerShell 调用的 `-Command` 参数。 */
function psCommand(): string {
  const call = child.spawn.mock.calls.find((c) => c[0] === 'powershell.exe')
  expect(call, 'tar 失败后没有走 PowerShell 兜底').toBeTruthy()
  const args = call?.[1] as string[]
  expect(args.slice(0, 2), '兜底命令少了 -NoProfile 之类的固定前缀').toEqual(['-NoProfile', '-Command'])
  const command = args[2]
  // 先让形状成立再往下走：`expect` 不带类型收窄，缺这一步 `command` 仍是 `string | undefined`。
  if (typeof command !== 'string') throw new Error('-Command 之后没有脚本串，用例没法读')
  return command
}

/**
 * 按 PowerShell 的单引号规则扫一遍脚本文本：`'` 开字面量、`''` 是字面量里的一个撇号。
 * 返回"代码区"（字面量之外）的下标集合 —— 注入的命令名只要出现在这里就是被执行的那一份。
 */
function codePositions(script: string): Set<number> {
  const code = new Set<number>()
  let inLiteral = false
  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i]
    if (!inLiteral) {
      if (ch === "'") { inLiteral = true; continue }
      code.add(i)
      continue
    }
    if (ch === "'") {
      if (script[i + 1] === "'") { i += 1; continue }
      inLiteral = false
    }
  }
  return code
}
/** 注入串整体是否落在字面量里（true = 安全）。 */
function quotedOnly(script: string, payload: string): boolean {
  const code = codePositions(script)
  let at = script.indexOf(payload)
  expect(at, `注入串根本没出现在命令里（说明没按预期拼进去）`).toBeGreaterThan(-1)
  while (at >= 0) {
    for (let i = at; i < at + payload.length; i += 1) if (code.has(i)) return false
    at = script.indexOf(payload, at + 1)
  }
  return true
}

describe('powershellLiteral', () => {
  it('撇号翻倍，其余原样（PowerShell 单引号字面量唯一的转义规则）', () => {
    expect(powershellLiteral('C:\\a\\b.zip')).toBe("'C:\\a\\b.zip'")
    expect(powershellLiteral("O'Brien")).toBe("'O''Brien'")
    expect(powershellLiteral("a'; Stop-Process; b'")).toBe("'a''; Stop-Process; b'''")
    expect(powershellLiteral('')).toBe("''")
  })

  it('反引号与 `$` 在单引号字面量里不展开 ⇒ 变量插值注入也被关着', () => {
    const cmd = `Expand-Archive -LiteralPath ${powershellLiteral('x$env:SECRET`y')}`
    expect(cmd).toContain('$env:SECRET')
    expect(quotedOnly(cmd, '$env:SECRET')).toBe(true)
  })
})

describe('extractZip 的 PowerShell 兜底', () => {
  it('tar 成功时根本不叫 PowerShell（只在兜底路径上拼字符串）', async () => {
    child.spawn.mockImplementation((cmd: string) => childProcess(cmd === 'tar.exe' ? 0 : 1))
    const staging = await extractZip(join(dir, 'a.zip'), dir)
    expect(staging).toBe(join(dir, '.engine-staging'))
    expect(child.spawn).toHaveBeenCalledTimes(1)
    expect(child.spawn.mock.calls[0]?.[0]).toBe('tar.exe')
  })

  it('两个路径都走字面量：拼法与 `powershellLiteral` 的结果逐字相同', async () => {
    const zip = join(dir, "O'Brien", 'a.zip')
    child.spawn.mockImplementation((cmd: string) => childProcess(cmd === 'tar.exe' ? 1 : 0))
    await extractZip(zip, dir)
    const staging = join(dir, '.engine-staging')
    expect(psCommand()).toBe(
      `Expand-Archive -LiteralPath ${powershellLiteral(zip)} -DestinationPath ${powershellLiteral(staging)} -Force`)
  })

  it('用户名里有撇号也不会把命令断开（路径本身不是注入，但它会让原写法崩掉）', async () => {
    const zip = "C:\\Users\\O'Brien\\.dsh\\whisper\\engine.zip"
    child.spawn.mockImplementation((cmd: string) => childProcess(cmd === 'tar.exe' ? 1 : 0))
    await extractZip(zip, dir)
    const cmd = psCommand()
    expect(cmd).toContain("'C:\\Users\\O''Brien\\.dsh\\whisper\\engine.zip'")
    expect(quotedOnly(cmd, 'Brien')).toBe(true)
  })

  it('路径里塞一整条 PowerShell 语句也只当字符串用（P3-11 的正身）', async () => {
    const evil = "C:\\a\\x'; Format-Volume -Confirm:$false; y.zip"
    child.spawn.mockImplementation((cmd: string) => childProcess(cmd === 'tar.exe' ? 1 : 0))
    await extractZip(evil, dir)
    const cmd = psCommand()
    expect(quotedOnly(cmd, 'Format-Volume -Confirm:$false'),
      '注入的 cmdlet 落在了字面量外面 ⇒ 路径内容变成要执行的代码').toBe(true)
    // 代码区里唯一的 cmdlet 是我们自己写的那一个
    expect(cmd.slice(0, 17)).toBe('Expand-Archive -L')
  })

  it('tar 与 PowerShell 都不行时退到 unzipper，全失败就说清是哪三条路都断了', async () => {
    child.spawn.mockImplementation(() => childProcess(1))
    await expect(extractZip(join(dir, 'does-not-exist.zip'), dir)).rejects.toThrow('tar/PowerShell/unzipper 均不可用')
  })
})
