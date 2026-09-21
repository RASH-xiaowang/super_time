/**
 * 面板错误的可读性守卫（N30）。
 *
 * 起因是一次真实的验收复跑：空 userData 下点开「通讯录」，界面 `role="alert"` 里显示的是
 * **原始英文** `unable to open database file` —— 而这道状态（「还没配置数据目录/没解密」）
 * 恰恰是每个查询面板都会撞到的首启状态：用户不知道发生了什么，也不知道下一步做什么。
 *
 * 两条硬要求：
 *   ① 已知形态必须翻译成「去哪做什么」的中文句子，并保留原始错误（可诊断）；
 *   ② **其余错误原样透传** —— 这一条同样重要：猜错形态会把真实故障说成「未配置」，
 *      那比英文原文更有害（本仓的诚实性口径：读失败 ≠ 没有数据）。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
// @ts-expect-error —— 宿主层是 CommonJS，无类型声明
import { readableCallError } from '../wechat-host.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const hostSrc = readFileSync(join(ROOT, 'src', 'backend', 'wechat-host.js'), 'utf8')
const e2eSrc = readFileSync(join(ROOT, 'scripts', 'loading-recovery-e2e.mjs'), 'utf8')

/** 收集源码里真实的 `CallExpression`（只认真实调用点，注释掉不算）。 */
function callExpressions(file: string, src: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) out.push(node.getText(sf))
    node.forEachChild(visit)
  }
  visit(sf)
  return out
}

describe('N30：面板错误文案（已知首启形态翻译，其余原样）', () => {
  it('node:sqlite 的「打不开库」翻译成可执行中文，并保留原始错误', () => {
    const msg = readableCallError('getContacts', new Error('unable to open database file'))
    expect(msg).toContain('数据配置')
    expect(msg).toContain('unable to open database file')
    expect(/[\u4e00-\u9fa5]/.test(msg), '翻译结果必须是中文句子').toBe(true)
  })

  it('SQLITE_CANTOPEN 等价形态同样命中', () => {
    expect(readableCallError('getSessions', new Error('SQLITE_CANTOPEN: cantopen'))).toContain('数据配置')
  })

  it('**其余错误原样透传**（不猜、不美化）', () => {
    for (const raw of [
      'hevc-unsupported',
      '无法找到图片 MD5',
      'findImagePaths 失败：磁盘 I/O 错误',
      'random other failure（这句话里不该被翻译）',
    ]) {
      expect(readableCallError('getImageDataUrl', new Error(raw)), raw).toBe(raw)
    }
  })

  it('非 Error 输入不炸，且保持原样', () => {
    expect(readableCallError('m', 'plain string failure')).toBe('plain string failure')
    expect(readableCallError('m', undefined)).toContain('undefined')
  })

  it('接线守卫：call 的错误路径必须走翻译函数（而不是直接拼 e.message）', () => {
    const calls = callExpressions('wechat-host.js', hostSrc).filter((c) => c.includes('readableCallError('))
    expect(calls.length, 'wechat-host.js 里找不到 readableCallError(...) 的真实调用点').toBeGreaterThan(0)
    // 反例：错误结果里的 message 不能再是裸露的 e.message || String(e)
    expect(hostSrc).not.toContain('message: e.message || String(e)')
  })

  it('验收脚本把这条文案也钉住（无数据源时不得是原始英文）', () => {
    expect(e2eSrc).toContain('unable to open database file')
    expect(e2eSrc).toContain('数据配置')
  })
})
