/**
 * M6：文件日志（大小轮转 + 绝不抛）。
 *
 * 背景：GUI 态下 stdout 是无人接管的管道，`console-safe` 一发现管道坏了就彻底静默 ——
 * 崩溃后什么都没留下。这里断言的是「错误真的落了盘」「有上界」「写不进去也不抛」。
 * @vitest-environment node
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error —— 宿主层是 CommonJS，无类型声明
import { buildDiagnosticReport, createDiagLog, installConsoleCapture } from '../diag-log.js'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'diag-log-'))
  scratch.push(dir)
  return dir
}

const fixedNow = () => new Date('2026-09-13T10:00:00Z')

describe('文件日志', () => {
  it('写入带时间戳与级别的行，目录不存在会自动创建', () => {
    const dir = join(tempDir(), 'logs', 'nested')
    const log = createDiagLog({ dir, now: fixedNow })
    log.write('error', ['后端启动失败', new Error('连接被拒绝')])
    const text = readFileSync(log.path, 'utf8')
    expect(text).toContain('[2026-09-13T10:00:00.000Z] [error] 后端启动失败')
    expect(text).toContain('连接被拒绝')
    expect(text).toContain('Error') // Error 带栈
  })

  it('循环引用/超长内容不会炸，也不会写出一整条巨型 JSON', () => {
    const log = createDiagLog({ dir: tempDir(), now: fixedNow })
    const cyclic = { a: 1 }
    cyclic.self = cyclic
    expect(() => log.write('warn', [cyclic])).not.toThrow()
    expect(() => log.write('warn', ['x'.repeat(20000)])).not.toThrow()
    const lines = readFileSync(log.path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(4000 + 40)
  })

  it('超过单文件上限时轮转，且总份数有上界', () => {
    const dir = tempDir()
    // 上限设得极小：每行必然触发一次轮转
    const log = createDiagLog({ dir, maxBytes: 80, maxFiles: 3, now: fixedNow })
    for (let i = 1; i <= 10; i += 1) log.write('info', ['line-' + i])

    const files = readdirSync(dir).filter((f) => f.endsWith('.log'))
    expect(files.length).toBeLessThanOrEqual(3)
    // 最新的那份里是最后写入的内容
    expect(readFileSync(log.path, 'utf8')).toContain('line-10')
    // 总量有上界（3 × 80 字节 + 行首开销的量级）
    const total = files.reduce((n, f) => n + statSync(join(dir, f)).size, 0)
    expect(total).toBeLessThan(1000)
  })

  it('目录不可写时只禁用自己，不抛异常（写日志不能拖垮业务）', () => {
    // 用一个「把日志目录指向一个已存在的文件」的方式制造失败：mkdir 必然失败
    const dir = tempDir()
    const bogus = join(dir, 'a-file')
    writeFileSync(bogus, 'x')
    const log = createDiagLog({ dir: join(bogus, 'logs'), now: fixedNow })
    expect(() => log.write('error', ['不存在的目录'])).not.toThrow()
    expect(() => log.write('error', ['第二次'])).not.toThrow()
    expect(log.disabled()).toBe(true)
  })

  it('installConsoleCapture 会把 console 输出也写进文件，并可还原', () => {
    const log = createDiagLog({ dir: tempDir(), now: fixedNow })
    const restore = installConsoleCapture(log, ['error'])
    try {
      console.error('捕获到的错误行')
    } finally {
      restore()
    }
    expect(readFileSync(log.path, 'utf8')).toContain('捕获到的错误行')
    const before = readFileSync(log.path, 'utf8')
    console.error('还原之后不该再进文件')
    expect(readFileSync(log.path, 'utf8')).toBe(before)
    expect(existsSync(log.path)).toBe(true)
  })
})

describe('诊断报告拼装', () => {
  it('按「旧 → 新」顺序拼接，并附上环境信息', () => {
    const dir = tempDir()
    // 上限设得小，正好写三行 → 三份文件各一行（写更多会把最早的挤掉，那正是上界）
    const log = createDiagLog({ dir, maxBytes: 60, maxFiles: 3, now: fixedNow })
    for (let i = 1; i <= 3; i += 1) log.write('info', ['line-' + i])

    const report = buildDiagnosticReport(log, { app: '1.0.0', platform: 'win32' })
    // 旧的在前面：最早写的那批（.2.log）应出现在最新内容之前
    const firstIdx = report.indexOf('line-1')
    const lastIdx = report.indexOf('line-3')
    expect(firstIdx).toBeGreaterThanOrEqual(0)
    expect(lastIdx).toBeGreaterThan(firstIdx)
    // 环境段在末尾
    expect(report).toContain('===== 环境 =====')
    expect(report.trimEnd().endsWith('}')).toBe(true)
    expect(report).toContain('"app": "1.0.0"')
  })

  it('缺少某些轮转文件时也能出报告（不让导出整体失败）', () => {
    const log = createDiagLog({ dir: tempDir(), now: fixedNow })
    log.write('error', ['只有当前这一份'])
    const report = buildDiagnosticReport(log, { app: 'x' })
    expect(report).toContain('只有当前这一份')
    expect(report).toContain('===== 环境 =====')
  })
})