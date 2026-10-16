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
import {
  RENDERER_LEVELS,
  buildDiagnosticReport,
  createDiagLog,
  installConsoleCapture,
  installRendererConsoleCapture,
  redact,
  rendererConsoleLevels,
  // @ts-expect-error —— 宿主层是 CommonJS，无类型声明（必须紧贴 from 那一行，多行 import 时报错在那里）
} from '../diag-log.js'

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

/**
 * 读日志内容；**文件不存在时返回空串**。
 *
 * 为什么需要它：「某级别不该被转发」这类断言的正确表现就是**一个字都没写**，
 * 而 `createDiagLog` 只在真有内容时才 `mkdirSync` + `appendFileSync` ——
 * 于是无条件 `readFileSync` 会 ENOENT，把「行为正确」报成「用例失败」。
 */
const readLog = (log: { path: string }): string =>
  existsSync(log.path) ? readFileSync(log.path, 'utf8') : ''

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
    const cyclic: Record<string, unknown> = { a: 1 }
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

/* ───────────────── 渲染层 console 转发（2026-10-08 补） ───────────────── */

/**
 * 假 `webContents`：只实现转发用到的 `on`/`off`，并留一个手动触发器。
 *
 * 为什么要假对象：真 `webContents` 只有在 Electron 进程里才有，而这里要能在
 * 普通 vitest（node 环境）里确定性地断言「某一级被转发了、某一级没有」。
 */
function fakeContents(): { contents: { on: (e: string, f: (...a: unknown[]) => void) => void; off: (e: string, f: (...a: unknown[]) => void) => void }; emit: (level: number, message: string, line?: number, sourceId?: string) => void; count: () => number } {
  const handlers = new Map<string, (...a: unknown[]) => void>()
  return {
    contents: {
      on(e, f) { handlers.set(e, f) },
      off(e) { handlers.delete(e) },
    },
    emit(level, message, line = 1, sourceId = 'app.js') {
      handlers.get('console-message')?.({}, level, message, line, sourceId)
    },
    count: () => handlers.size,
  }
}

describe('渲染层 console 转发进诊断日志', () => {
  it('warn 与 error 会落盘，并带上级别、来源文件与行号', () => {
    const log = createDiagLog({ dir: tempDir(), now: fixedNow })
    const fake = fakeContents()
    installRendererConsoleCapture(fake.contents, log)
    fake.emit(2, '取图失败（已重试 2 次，放弃）', 42, 'moments-media.ts')
    fake.emit(3, '渲染层炸了', 7, 'moments-card.tsx')
    const text = readFileSync(log.path, 'utf8')
    expect(text, '默认档位必须收 warn').toContain('取图失败')
    expect(text, '默认档位必须收 error').toContain('渲染层炸了')
    // 没有栈可依，来源是唯一线索 —— 缺了它就不知道该去哪个文件看
    expect(text).toContain('[moments-media.ts:42]')
    expect(text).toContain('[moments-card.tsx:7]')
    // 级别标签用 renderer 收口，便于与后端的 [backend!] 区分开
    expect(text).toContain('[renderer]')
    expect(text).toContain('[warn]')
    expect(text).toContain('[error]')
  })

  it('默认**不收** info 与 verbose（量太大，会把 2 MB × 3 份轮转冲掉）', () => {
    const log = createDiagLog({ dir: tempDir(), now: fixedNow })
    const fake = fakeContents()
    installRendererConsoleCapture(fake.contents, log)
    fake.emit(0, 'verbose 行')
    fake.emit(1, 'info 行')
    const text = readLog(log)
    expect(text).not.toContain('verbose 行')
    expect(text).not.toContain('info 行')
  })

  it('可用 levels 显式放宽档位（现场排查要全量时）', () => {
    const log = createDiagLog({ dir: tempDir(), now: fixedNow })
    const fake = fakeContents()
    installRendererConsoleCapture(fake.contents, log, ['verbose', 'info', 'warn', 'error'])
    fake.emit(1, 'info 行')
    expect(readFileSync(log.path, 'utf8')).toContain('info 行')
  })

  it('级别映射覆盖 Electron 的四档，且未知数字不炸', () => {
    expect(RENDERER_LEVELS).toEqual({ 0: 'verbose', 1: 'info', 2: 'warn', 3: 'error' })
    const log = createDiagLog({ dir: tempDir(), now: fixedNow })
    const fake = fakeContents()
    installRendererConsoleCapture(fake.contents, log, ['verbose', 'info', 'warn', 'error'])
    // Electron 未来给新档位时不能抛 —— 转发是旁路，绝不能把渲染层带崩
    fake.emit(99, '将来才有的级别')
    expect(readFileSync(log.path, 'utf8')).toContain('将来才有的级别')
  })

  it('日志器抛异常时不能影响渲染层（转发是旁路）', () => {
    const fake = fakeContents()
    const bad = { write() { throw new Error('磁盘满了') } }
    expect(() => {
      installRendererConsoleCapture(fake.contents, bad)
      fake.emit(2, '这条不该把调用方带崩')
    }).not.toThrow()
  })

  it('contents 不成形时安静返回空还原函数（不能因为少个 on 就崩）', () => {
    const log = createDiagLog({ dir: tempDir(), now: fixedNow })
    for (const bad of [undefined, null, {}, 42]) {
      const restore = installRendererConsoleCapture(bad, log)
      expect(typeof restore).toBe('function')
      expect(() => { restore() }).not.toThrow()
    }
  })

  it('空消息不写（日志量已经很宝贵，空行只会挤掉有用的）', () => {
    const log = createDiagLog({ dir: tempDir(), now: fixedNow })
    const fake = fakeContents()
    installRendererConsoleCapture(fake.contents, log)
    fake.emit(2, '')
    expect(readLog(log)).not.toContain('[renderer]')
  })

  it('还原函数真的摘掉监听（热重载 / 测试之间不许互相污染）', () => {
    const log = createDiagLog({ dir: tempDir(), now: fixedNow })
    const fake = fakeContents()
    const restore = installRendererConsoleCapture(fake.contents, log)
    expect(fake.count()).toBe(1)
    restore()
    expect(fake.count()).toBe(0)
    fake.emit(2, '还原之后不该被记')
    expect(readLog(log)).not.toContain('还原之后不该被记')
  })

  it('转发出去的文本仍走脱敏（不在这里另拼字符串绕过 redact）', () => {
    const log = createDiagLog({ dir: tempDir(), now: fixedNow })
    const fake = fakeContents()
    installRendererConsoleCapture(fake.contents, log)
    fake.emit(2, 'Authorization: Bearer abcdef123456')
    const text = readFileSync(log.path, 'utf8')
    expect(text).not.toContain('abcdef123456')
    expect(text).toContain('***')
  })
})

describe('rendererConsoleLevels：档位从环境变量读', () => {
  it('未设置时是 warn + error', () => {
    expect(rendererConsoleLevels({})).toEqual(['warn', 'error'])
  })

  it('可显式放宽，空值/全空白/空列表都回落默认值', () => {
    expect(rendererConsoleLevels({ SUPERTIME_RENDERER_LOG_LEVELS: 'verbose,info,warn,error' }))
      .toEqual(['verbose', 'info', 'warn', 'error'])
    expect(rendererConsoleLevels({ SUPERTIME_RENDERER_LOG_LEVELS: '  ' })).toEqual(['warn', 'error'])
    expect(rendererConsoleLevels({ SUPERTIME_RENDERER_LOG_LEVELS: ',,,' })).toEqual(['warn', 'error'])
  })

  it('返回的是副本：调用方改它不该影响后续调用', () => {
    const a = rendererConsoleLevels({})
    a.push('info')
    expect(rendererConsoleLevels({})).toEqual(['warn', 'error'])
  })
})