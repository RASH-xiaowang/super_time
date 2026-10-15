/**
 * Remote 契约的第二层：名字对齐之外，**业务参数形状**也必须对齐。
 *
 * `WechatRemote` 是前端手写的镜像；名字不漏只是第一道防线。这里用 TypeScript AST
 * 把后端 `@Remote` 方法签名与前端接口签名做结构比较：
 *   - 参数数量 / 参数名 / 可选性（排除 Typert 的传输取消参数 `signal: AbortSignal`）；
 *   - 双方都直接写出 object literal 的参数/返回值时，顶层属性名与可选性必须一致。
 *
 * 为什么不直接要求两边类型文本逐字相等：返回包一层 `Promise<RemoteResult<T>>` 是
 * 前端传输封装，命名类型（如 `WordCloudOptions` / `WordCloudResult`）在两边本来就有
 * 合法的书写差异。直接 object literal 是最容易被手抄漏的形态，因此先钉住这部分。
 *
 * 这里的解析与 `remote-contract.spec.ts` 的文本比对互补：一个防「少了方法」，
 * 一个防「方法还在但入参悄悄漏了 jobId / offline / emojiUrl 这类字段」。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { GATEWAY_CLASS_FILES, GW_DIR } from '../../tests/gateway-source.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..', '..')
const API_CORE = join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'api-core.ts')

interface ParameterShape {
  name: string
  optional: boolean
  hasDefault: boolean
  type: ts.TypeNode | undefined
}

interface MethodShape {
  parameters: ParameterShape[]
  returnType: ts.TypeNode | undefined
}

function sourceFile(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function parameterShape(node: ts.ParameterDeclaration): ParameterShape {
  const name = node.name.getText()
  return {
    name,
    optional: Boolean(node.questionToken),
    hasDefault: Boolean(node.initializer),
    type: node.type,
  }
}

function backendShapes(): Map<string, MethodShape> {
  const out = new Map<string, MethodShape>()
  for (const file of GATEWAY_CLASS_FILES) {
    const sf = sourceFile(join(GW_DIR, file))
    for (const statement of sf.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.members) continue
      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member) || !member.name) continue
        const modifiers = (member.modifiers ?? []).map((m) => m.getText()).join('\n')
        const match = modifiers.match(/@Remote\(\s*'([^']+)'\s*\)/)
        if (!match || match[1] === undefined) continue
        const method = match[1]
        out.set(method, {
          parameters: member.parameters.map(parameterShape),
          returnType: member.type,
        })
      }
    }
  }
  return out
}

function clientShapes(): Map<string, MethodShape> {
  const out = new Map<string, MethodShape>()
  const sf = sourceFile(API_CORE)
  for (const statement of sf.statements) {
    if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== 'WechatRemote') continue
    for (const member of statement.members) {
      if (!ts.isMethodSignature(member) || !member.name) continue
      const name = member.name.getText()
      out.set(name, {
        parameters: member.parameters.map(parameterShape),
        returnType: member.type,
      })
    }
  }
  return out
}

/** Typert 会把取消信号从 wire 参数里单独拎出来，前端镜像也保留了这个参数占位。 */
function businessParameters(method: MethodShape): ParameterShape[] {
  return method.parameters.filter((p) => !(p.name === 'signal' && p.type?.getText() === 'AbortSignal'))
}

function unwrapArray(node: ts.TypeNode | undefined): ts.TypeNode | undefined {
  let current = node
  for (;;) {
    if (!current) return undefined
    if (ts.isArrayTypeNode(current)) {
      current = current.elementType
      continue
    }
    if (
      ts.isTypeReferenceNode(current)
      && ts.isIdentifier(current.typeName)
      && current.typeName.text === 'Array'
      && current.typeArguments?.length === 1
    ) {
      current = current.typeArguments[0]
      continue
    }
    return current
  }
}

function unwrapPromise(node: ts.TypeNode | undefined): ts.TypeNode | undefined {
  if (
    node
    && ts.isTypeReferenceNode(node)
    && ts.isIdentifier(node.typeName)
    && node.typeName.text === 'Promise'
    && node.typeArguments?.length === 1
  ) {
    return node.typeArguments[0]
  }
  return node
}

function unwrapRemoteResult(node: ts.TypeNode | undefined): ts.TypeNode | undefined {
  if (
    node
    && ts.isTypeReferenceNode(node)
    && ts.isIdentifier(node.typeName)
    && node.typeName.text === 'RemoteResult'
    && node.typeArguments?.length === 1
  ) {
    return node.typeArguments[0]
  }
  return node
}

/** 只有两边都是直接写出的 object literal 才比较；命名类型留给更轻量的名字/typecheck 契约。 */
function objectPropertyMap(node: ts.TypeNode | undefined): Map<string, boolean> | null {
  const literal = unwrapArray(node)
  if (!literal || !ts.isTypeLiteralNode(literal)) return null
  const out = new Map<string, boolean>()
  for (const member of literal.members) {
    if (!ts.isPropertySignature(member) || !member.name) continue
    const name = member.name.getText()
    out.set(name, Boolean(member.questionToken))
  }
  return out
}

function comparableObjectShape(node: ts.TypeNode | undefined, side: 'backend' | 'client'): Map<string, boolean> | null {
  if (side === 'client') return objectPropertyMap(unwrapRemoteResult(unwrapPromise(node)))
  return objectPropertyMap(unwrapPromise(node))
}

function shapeEntries(shape: Map<string, boolean>): Array<[string, boolean]> {
  return [...shape].map(([name, optional]) => [name, optional])
}

describe('Remote 契约：后端 @Remote 与前端 WechatRemote 的参数形状对齐', () => {
  const backend = backendShapes()
  const client = clientShapes()

  it('AST 读取没有空转（两侧方法数与名字契约一致）', () => {
    expect(backend.size).toBeGreaterThan(100)
    expect(client.size).toBe(backend.size)
    expect([...client.keys()].sort()).toEqual([...backend.keys()].sort())
  })

  it('openConfig/openPath 的 Typert 取消参数由后端默认创建，前端镜像保持可选', () => {
    for (const name of ['openConfig', 'openPath']) {
      const backendSignal = backend.get(name)!.parameters.find((p) => p.name === 'signal')
      const clientSignal = client.get(name)!.parameters.find((p) => p.name === 'signal')
      expect(backendSignal?.type?.getText(), `${name} 后端必须有 signal`).toBe('AbortSignal')
      expect(backendSignal?.hasDefault, `${name} 后端必须提供默认 signal`).toBe(true)
      expect(clientSignal?.optional, `${name} 前端 signal 必须可选`).toBe(true)
    }
  })

  it('每个业务参数的个数、名字与可选性都一致（取消信号除外）', () => {
    const mismatches: string[] = []
    for (const name of [...backend.keys()].sort()) {
      const expected = businessParameters(backend.get(name)!)
      const actual = businessParameters(client.get(name)!)
      if (expected.length !== actual.length) {
        mismatches.push(`${name}: 参数个数 ${expected.length} != ${actual.length}`)
        continue
      }
      for (let i = 0; i < expected.length; i += 1) {
        const expectedParam = expected[i]!
        const actualParam = actual[i]!
        if (expectedParam.name !== actualParam.name || expectedParam.optional !== actualParam.optional) {
          mismatches.push(
            `${name}[${i}]: ${expectedParam.name}${expectedParam.optional ? '?' : ''} != ${actualParam.name}${actualParam.optional ? '?' : ''}`,
          )
        }
      }
    }
    expect(mismatches).toEqual([])
  })

  it('双方直接写出的 object 参数/返回值，顶层字段与可选性一致', () => {
    const mismatches: string[] = []
    for (const name of [...backend.keys()].sort()) {
      const backendMethod = backend.get(name)!
      const clientMethod = client.get(name)!
      const backendParams = businessParameters(backendMethod)
      const clientParams = businessParameters(clientMethod)
      for (let i = 0; i < backendParams.length; i += 1) {
        const backendParam = backendParams[i]!
        const clientParam = clientParams[i]!
        const backendShape = objectPropertyMap(backendParam.type)
        const clientShape = objectPropertyMap(clientParam.type)
        if (backendShape && clientShape) {
          if (JSON.stringify(shapeEntries(backendShape)) !== JSON.stringify(shapeEntries(clientShape))) {
            mismatches.push(`${name} 参数 ${i}`)
          }
        }
      }
      const backendReturn = comparableObjectShape(backendMethod.returnType, 'backend')
      const clientReturn = comparableObjectShape(clientMethod.returnType, 'client')
      if (
        backendReturn
        && clientReturn
        && JSON.stringify(shapeEntries(backendReturn)) !== JSON.stringify(shapeEntries(clientReturn))
      ) {
        mismatches.push(`${name} 返回值`)
      }
    }
    expect(mismatches).toEqual([])
  })
})
