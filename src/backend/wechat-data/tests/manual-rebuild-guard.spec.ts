/** @vitest-environment node */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'kb-msg-vector-rebuild.manual.spec.ts'), 'utf8')
const source = ts.createSourceFile('maintenance.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const nodes: ts.Node[] = []
function visit(node: ts.Node): void { nodes.push(node); ts.forEachChild(node, visit) }
visit(source)
function within(node: ts.Node, ancestor: ts.Node): boolean {
  for (let p: ts.Node | undefined = node; p; p = p.parent) if (p === ancestor) return true
  return false
}
describe('manual vector maintenance permission boundary (static, never executes maintenance)', () => {
  it('uses a cwd sentinel, never an ambient environment opt-in', () => {
    const vars = nodes.filter(ts.isVariableDeclaration)
    expect(vars.find(n => n.name.getText(source) === 'SENTINEL')?.initializer?.getText(source)).toBe("join(process.cwd(), '.tmp-rebuild-enabled')")
    expect(vars.find(n => n.name.getText(source) === 'ENABLED')?.initializer?.getText(source)).toBe('existsSync(SENTINEL)')
  })
  it('keeps every credential read, runtime import, DB operation and bridge call inside the gated test', () => {
    const calls = nodes.filter(ts.isCallExpression)
    const suite = calls.find(n => n.expression.getText(source) === 'describe.skipIf(!ENABLED)')
    expect(suite).toBeDefined()
    if (!suite) throw new Error('Missing permission gate')
    const test = calls.find(n => n.expression.getText(source) === 'it' && within(n, suite))
    expect(test).toBeDefined()
    const body = test?.arguments[1]
    if (!body || !ts.isArrowFunction(body)) throw new Error('Missing gated async test body')
    const sensitive = calls.filter(n => n.expression.kind === ts.SyntaxKind.ImportKeyword || /^(readFileSync|buildVectorIndex|vectorIndexStatus|mod\.createLlmBridge|log)$/.test(n.expression.getText(source)))
    expect(sensitive.length).toBeGreaterThanOrEqual(7)
    for (const call of sensitive) expect(within(call, body), call.getText(source)).toBe(true)
    expect(nodes.filter(ts.isImportDeclaration).every(n => !n.moduleSpecifier.getText(source).includes('embedding.ts'))).toBe(true)
    const cleanup = nodes.filter(ts.isTryStatement).find(n => within(n, body))?.finallyBlock
    expect(cleanup?.getText(source)).toContain('rmSync(SENTINEL, { force: true })')
  })
})