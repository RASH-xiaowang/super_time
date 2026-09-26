/**
 * xlsx 解析的加固守卫（CODE-AUDIT-2026-09-26 P1-6）。
 *
 * 依赖是 `xlsx@0.18.5`：受 CVE-2023-30533（**原型污染**，<0.19.3）与 CVE-2024-22363
 * （ReDoS，<0.20.2）影响，而 SheetJS 已停止向 npm 发布修复版（只在自有 CDN 发）。
 * 换源是**依赖面变更**（要联网、要重装、要重验整条知识库链），不在本次范围里 ——
 * 这里先把「这个项目到底会不会被这条路径打到」变成**可执行的判据**，而不是留着一条
 * 谁都没验证过的「已知漏洞」。
 *
 * 判一：解析出来的**用户单元格永远不许当对象键**。
 * `sheet_to_json(ws)` 的默认形态就是「首行做键、每行一个对象」⇒ 表头写 `__proto__.x`
 * 这类键名正是那条污染路径的入口。本仓只用 `header: 1`（返回**数组的数组**，
 * 单元格永远是值），所以这条路径是关着的。AST 判据保证「以后有人图省事改成对象模式」会当场红。
 *
 * 判二：真跑一份 xlsx，前后对比 `Object.prototype` 的自有属性 ⇒ 污染真的发生时用例变红。
 * @vitest-environment node
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { parseXlsx } from '../src/query/kb/parse-xlsx.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'deps' || e.name === 'lib' || e.name === 'node_modules') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) tsFiles(p, out)
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

describe('xlsx：用户单元格永远不许成为对象键', () => {
  const calls: Array<{ where: string; header: string | null }> = []
  for (const f of tsFiles(SRC)) {
    const src = readFileSync(f, 'utf8').replace(/\r\n/g, '\n')
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const seen = new Set<ts.Node>()
    const walk = (n: ts.Node): void => {
      if (seen.has(n)) return
      seen.add(n)
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
        && n.expression.name.text === 'sheet_to_json') {
        const opts = n.arguments[1]
        let header: string | null = null
        if (opts && ts.isObjectLiteralExpression(opts)) {
          for (const prop of opts.properties) {
            if (ts.isPropertyAssignment(prop) && prop.name.getText(sf) === 'header') {
              header = prop.initializer.getText(sf)
            }
          }
        }
        calls.push({
          where: `${relative(SRC, f).split(sep).join('/')}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`,
          header,
        })
      }
      ts.forEachChild(n, walk)
    }
    walk(sf)
  }

  it('扫到了 sheet_to_json 调用（防空转）', () => {
    expect(calls.length, '一个 sheet_to_json 都没扫到 ⇒ 判据恒真').toBeGreaterThanOrEqual(1)
  })

  it('每一处都是 header: 1（数组模式，键名永远不来自文件）', () => {
    const bad = calls.filter((c) => c.header !== '1')
    expect(bad, '这些调用会把用户单元格里写的键名变成真对象键（CVE-2023-30533 的入口）：\n  '
      + bad.map((c) => `${c.where} → header=${String(c.header)}`).join('\n  ')).toEqual([])
  })
})

describe('xlsx：解析真文件不会污染原型链', () => {
  const FIXTURES = [
    join(HERE, 'fixtures', 'kb-b', '设备台账.xlsx'),
    join(HERE, 'fixtures', 'kb-b', '空台账.xlsx'),
  ]

  it('夹具存在且非空（防空转：拿不到文件时下面几条都是假的）', () => {
    for (const f of FIXTURES) {
      expect(readFileSync(f).byteLength, `夹具太小，不像真的 xlsx：${f}`).toBeGreaterThan(1000)
    }
  })

  it('解析前后 Object.prototype 的自有属性一个不多', async () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort()
    for (const f of FIXTURES) {
      const out = await parseXlsx(new Uint8Array(readFileSync(f)))
      expect(out, `夹具解析失败（判据就失效了）：${f}`).toBeTruthy()
    }
    const after = Object.getOwnPropertyNames(Object.prototype).sort()
    expect(after, '原型链上多出了属性 ⇒ 撞到原型污染了（这就是那条 CVE 的可观测形状）').toEqual(before)
    // `polluted` / `x` 这类是污染 PoC 常用的键名；显式盯一眼，红了能一眼看出是谁
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('解析产物上不许有 __proto__ / constructor / prototype 这类自有键', async () => {
    const DANGER = new Set(['__proto__', 'constructor', 'prototype'])
    const offenders: string[] = []
    const walk = (v: unknown, path: string): void => {
      if (v === null || typeof v !== 'object') return
      if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${String(i)}]`)); return }
      for (const k of Object.keys(v)) {
        if (DANGER.has(k)) offenders.push(`${path}.${k}`)
        walk((v as Record<string, unknown>)[k], `${path}.${k}`)
      }
    }
    for (const f of FIXTURES) walk(await parseXlsx(new Uint8Array(readFileSync(f))), 'out')
    expect(offenders.join(', ')).toBe('')
  })
})
