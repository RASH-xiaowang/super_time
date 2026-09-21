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
import { buildDiagnosticReport, createDiagLog, installConsoleCapture, redact } from '../diag-log.js'

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

  it('轮转真的发生：.1/.2 就位且各自装着对应年代的那行', () => {
    // 评审指出：原断言只查「文件数 ≤3、总量 <1000」，把 rotate() 整个禁用仍然全绿。
    // 要锁住机制必须断言**中间态**：哪一份里是哪一行。
    const dir = tempDir()
    const log = createDiagLog({ dir, maxBytes: 60, maxFiles: 3, now: fixedNow })
    for (let i = 1; i <= 3; i += 1) log.write('info', ['line-' + i])

    expect(existsSync(join(dir, 'app.1.log'))).toBe(true)
    expect(existsSync(join(dir, 'app.2.log'))).toBe(true)
    expect(readFileSync(join(dir, 'app.2.log'), 'utf8')).toContain('line-1')
    expect(readFileSync(join(dir, 'app.1.log'), 'utf8')).toContain('line-2')
    expect(readFileSync(log.path, 'utf8')).toContain('line-3')
    // 写第 4 行后，最旧的 line-1 应当被挤掉（丢最旧）
    log.write('info', ['line-4'])
    expect(readFileSync(join(dir, 'app.2.log'), 'utf8')).toContain('line-2')
    expect(readFileSync(join(dir, 'app.2.log'), 'utf8')).not.toContain('line-1')
  })

  it('maxFiles=1 时文件仍有上界（截断，而不是无界增长）', () => {
    // 评审实测：maxFiles=1 时原来的 rotate() 一次都不执行，maxBytes=500 写到 27KB。
    const dir = tempDir()
    const log = createDiagLog({ dir, maxBytes: 200, maxFiles: 1, now: fixedNow })
    for (let i = 0; i < 50; i += 1) log.write('info', ['x'.repeat(60)])
    expect(statSync(log.path).size).toBeLessThanOrEqual(400)
    expect(readdirSync(dir).filter((f) => f.endsWith('.log'))).toHaveLength(1)
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

describe('脱敏：日志里不得出现密钥', () => {
  it('JSON.parse 报错自带的源码片段会被脱敏（评审实测的泄漏路径）', () => {
    // V8 在「非法 token」类错误里会带出错位置附近的原文
    let msg = ''
    try { JSON.parse('{"apiKey":sk-live-ABCDEF123456}') } catch (e) { msg = (e as Error).message }
    expect(msg).toContain('sk-live') // 先确认这个场景真的会带片段，否则后面的断言是空转

    const log = createDiagLog({ dir: tempDir(), now: fixedNow })
    log.write('warn', ['llm.json 解析失败', msg])
    const text = readFileSync(log.path, 'utf8')
    expect(text).not.toContain('sk-live-ABCDEF')
    expect(text).toContain('***')
  })

  it('对象里的密钥字段与长 16 进制串都会被脱敏', () => {
    const log = createDiagLog({ dir: tempDir(), now: fixedNow })
    log.write('info', [{ db_enc_key: 'a'.repeat(64), image_aes_key: '0123456789abcdef', nested: { token: 'abc123456' } }])
    const text = readFileSync(log.path, 'utf8')
    expect(text).not.toContain('a'.repeat(64))
    expect(text).not.toContain('0123456789abcdef')
    expect(text).not.toContain('abc123456')
    expect(text).toContain('***')
  })

  it('redact 直接可用的形态：Bearer / sk- / key=value', () => {
    expect(redact('Authorization: Bearer abcdef123456')).not.toContain('abcdef123456')
    expect(redact('key=sk-abcdefghijkl')).not.toContain('sk-abcdefghijkl')
    expect(redact('api_key: "deadbeefdeadbeefdeadbeef"')).not.toContain('deadbeefdeadbeefdeadbeef')
    // 无关内容不该被误伤
    expect(redact('普通日志：后端已就绪 132 个方法')).toContain('后端已就绪')
  })
})