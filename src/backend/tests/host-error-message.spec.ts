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

  /**
   * W3-11.6：翻译表从 1 条扩到 8 条后的三条判据。
   *
   * ① 每条新形态都要有「去哪做什么」的中文 + 保留原始错误（截图可定位）；
   * ② 表**不许缩水**（有人删条目换绿时必须红）—— 这一点靠读源码里的表行数；
   * ③ 窄正则的自证：表外的真实错误仍原样透传，包括**长得像**表内形态的句子
   *    （「磁盘 I/O 错误」不许被 EPERM 与 EBUSY 那条吃掉）。
   */
  it('W3-11.6：八类已知形态都译成可执行中文，且保留原始错误', () => {
    const table: Array<[string, string]> = [
      ['unable to open database file', '数据配置'],
      ['SQLITE_CORRUPT: database disk image is malformed', '数据库健康'],
      ['database is locked', '等它跑完'],
      ['SQLITE_READONLY: attempt to write a readonly database', '可写目录'],
      ['EBUSY: resource busy or locked, rename', '占用'],
      ['ENOSPC: no space left on device, write', '磁盘空间'],
      ['EACCES: permission denied, open', '权限'],
      ['EMFILE: too many open files, open', '重启应用'],
    ];
    for (const [raw, mustSay] of table) {
      const msg = readableCallError('m', new Error(raw));
      expect(msg, raw).toMatch(/[\u4e00-\u9fa5]/);
      expect(msg, raw).toContain(mustSay);
      expect(msg, `${raw} 必须保留原始错误`).toContain(raw);
    }
  })

  it('W3-11.6：翻译表不许缩水（删条目换绿必须红）', () => {
    // 表行数 = 表体里 `say:` 的个数（读文本而不是 import 表本身：表是宿主层 CJS 的模块内常量，
    // 不导出；而「不许缩水」这条要能用源码级判据钉住）。加形态时把这里的期望值一起改。
    const from = hostSrc.indexOf('const READABLE_ERRORS = [');
    expect(from, 'wechat-host.js 里找不到 READABLE_ERRORS 表').toBeGreaterThan(-1);
    const body = hostSrc.slice(from, hostSrc.indexOf('];', from));
    const rows = (body.match(/say: '/g) ?? []).length;
    expect(rows, 'READABLE_ERRORS 表行数对不上（加形态要连这条判据一起改）').toBe(8);
  })

  it('W3-11.6：表外的错误仍原样透传，包括长得像表内形态的句子', () => {
    for (const raw of [
      'findImagePaths 失败：磁盘 I/O 错误',
      'hevc-unsupported',
      '无法找到图片 MD5',
      'random other failure（这句话里不该被翻译）',
    ]) {
      expect(readableCallError('getImageDataUrl', new Error(raw)), raw).toBe(raw)
    }
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
