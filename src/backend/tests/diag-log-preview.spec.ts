/**
 * W2-12.4：诊断日志「导出 + 脱敏预览 + 一键复制路径」。
 *
 * ## 查下来的现状
 *
 * 「导出」和「脱敏」**早就有了**（`buildDiagnosticReport` 拼全量轮转 + 环境信息；
 * `redact` 是所有落盘内容的单一收口）。缺的是另外两件：
 *   · **脱敏预览** —— 诊断日志是要**发给别人**的文件，用户有权在发出去之前先看一眼。
 *     `redact` 只保证密钥一类被换掉，而「有没有别的敏感内容」（聊天内容、路径、用户名）
 *     是用户自己才有资格判断的事。
 *   · **一键复制路径** —— 原先路径只能悬停看 `title`，报障时贴给支持人员只能手抄。
 *
 * ## 这条判据最要紧的一条
 *
 * 预览必须与导出走**同一个** `buildDiagnosticReport`。两套拼装的话，
 * 「预览里没有的那行」会被用户误当成「导出里也没有」—— 而那正是最不能出错的地方。
 * 所以这里断言的是「预览文本是导出文本的前缀」，不是「预览里有某句话」。
 * @vitest-environment node
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

// `diag-log.js` 是无类型的 CJS，按本仓既有做法走 createRequire（与 llm-balance.spec /
// ipc-misc.spec 同款）—— 直接 import 会撞 TS7016「找不到声明文件」。
const require = createRequire(import.meta.url)
const {
  PREVIEW_MAX_CHARS, buildDiagnosticPreview, buildDiagnosticReport, createDiagLog, redact,
} = require('../diag-log.js')

/** `createDiagLog` 的返回形状（本仓的 `diag-log.js` 是无类型的 CJS，TS 看不到导出类型）。 */
type DiagLog = {
  path: string
  write: (level: string, args: unknown[]) => void
  files: () => string[]
  disabled: () => boolean
}

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

/** 建一个装了若干行的日志器（含一行带密钥的，验脱敏）。 */
function makeLog(lines: readonly string[]): DiagLog {
  const dir = mkdtempSync(join(tmpdir(), 'wx-diagprev-'))
  scratch.push(dir)
  const log = createDiagLog({ dir })
  for (const l of lines) log.write('info', [l])
  return log
}

describe('W2-12.4 预览与导出必须是同一份东西', () => {
  it('预览文本就是导出文本的前缀（不是另拼一份）', () => {
    const log = makeLog(['第一行 alpha', '第二行 beta'])
    const env = { app: '1.2.3', platform: 'win32' }
    const report = buildDiagnosticReport(log, env)
    const pv = buildDiagnosticPreview(log, env)
    expect(pv.text.startsWith(report.slice(0, pv.text.length))).toBe(true)
    expect(report.startsWith(pv.text), '预览不能是导出之外的另一套内容').toBe(true)
  })

  it('同样的 env ⇒ 同样的字符数（环境信息也进预览，不是只给日志正文）', () => {
    const log = makeLog(['只有一行'])
    const env = { app: '9.9.9', node: 'v24' }
    expect(buildDiagnosticPreview(log, env).chars).toBe(buildDiagnosticReport(log, env).length)
  })

  it('files 列出包含哪几份轮转日志（用户要知道自己交出去的是什么）', () => {
    const log = makeLog(['x'])
    const pv = buildDiagnosticPreview(log)
    expect(pv.files.length).toBeGreaterThan(0)
    expect(pv.files.every((f: string) => f.endsWith('.log'))).toBe(true)
  })
})

describe('W2-12.4 截断必须说出来', () => {
  it('没超上限：truncated=false 且 chars 等于全文长度', () => {
    const log = makeLog(['短'])
    const pv = buildDiagnosticPreview(log, {})
    expect(pv.truncated).toBe(false)
    expect(pv.chars).toBe(pv.text.length)
  })

  it('超上限：text 是前 maxChars 个字符，chars 说的是**全文**长度', () => {
    const log = makeLog([new Array(5000).join('x')])
    const pv = buildDiagnosticPreview(log, {}, { maxChars: 100 })
    expect(pv.truncated).toBe(true)
    expect(pv.text.length).toBe(100)
    expect(pv.chars, 'chars 必须是全文长度，否则用户以为看全了').toBeGreaterThan(100)
  })

  it('默认上限是个具体数字（预览要过 IPC，不能把 6MB 全拉进渲染进程）', () => {
    expect(PREVIEW_MAX_CHARS).toBeGreaterThan(1000)
    expect(PREVIEW_MAX_CHARS).toBeLessThan(200_000)
  })
})

describe('W2-12.4 预览里也不能有密钥', () => {
  it('日志里的 sk- / Bearer / 长 hex / api_key= 都已脱敏', () => {
    const log = makeLog([
      '配置读取失败 api_key=sk-live-ABCDEFGH12345678',
      '请求头 Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload',
      '解析出错 a1b2c3d4e5f60718a1b2c3d4e5f60718',
    ])
    const pv = buildDiagnosticPreview(log, {})
    expect(pv.text).not.toMatch(/sk-live-ABCDEFGH12345678/)
    expect(pv.text).not.toMatch(/eyJhbGciOiJIUzI1NiJ9\.payload/)
    expect(pv.text).not.toMatch(/a1b2c3d4e5f60718/)
    // 与 redact 单一收口同源（导出那份也一样脱敏）
    expect(redact('api_key=sk-live-ABCDEFGH12345678')).toBe('api_key=***')
  })
})

describe('W2-12.4 坏环境不能把预览整体带崩', () => {
  it('日志目录里一份都没有：预览仍然返回（空文本），不抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wx-diagempty-'))
    scratch.push(dir)
    const log = createDiagLog({ dir })
    // ⚠ `files()` 只认它自己那三份轮转名，不是目录里的任意文件 —— 往目录里塞别的
    //   文件名不会让 preview 的 files 变化（那是刻意的：只交出自己写的日志）。
    writeFileSync(join(dir, 'app.log'), '', 'utf8')
    const pv = buildDiagnosticPreview(log, {})
    expect(typeof pv.text).toBe('string')
    expect(pv.files).toEqual(['app.log', 'app.1.log', 'app.2.log'])
    // 空文件不进报告正文（导出也是这么拼的：size<=0 跳过）
    expect(buildDiagnosticReport(log, {})).not.toContain('app.log')
  })

  it('预览是纯读：调两次不产生新文件', () => {
    const log = makeLog(['一次'])
    const before = readFileSync(log.path, 'utf8')
    buildDiagnosticPreview(log, {})
    buildDiagnosticPreview(log, {})
    expect(readFileSync(log.path, 'utf8')).toBe(before)
  })
})