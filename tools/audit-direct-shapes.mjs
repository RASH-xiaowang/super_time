import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const gwDir = join(root, 'src', 'backend', 'wechat-data', 'src')
const manifest = JSON.parse(readFileSync(join(root, 'tools', 'remote-files.json'), 'utf8'))
const classFiles = manifest.gatewayClassFiles
const apiFile = join(root, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'api-core.ts')

function parse(file) {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function unwrapArray(node) {
  while (node && ts.isArrayTypeNode(node)) node = node.elementType
  while (
    node
    && ts.isTypeReferenceNode(node)
    && ts.isIdentifier(node.typeName)
    && node.typeName.text === 'Array'
    && node.typeArguments?.length
  ) {
    node = node.typeArguments[0]
  }
  return node
}

function objectShape(node) {
  if (!node) return null
  node = unwrapArray(node)
  if (!ts.isTypeLiteralNode(node)) return null
  const out = new Map()
  for (const member of node.members) {
    if (!ts.isPropertySignature(member) || !member.name) continue
    let name = member.name.getText()
    if (member.name.kind === ts.SyntaxKind.StringLiteral) name = member.name.text
    out.set(name, Boolean(member.questionToken))
  }
  return out
}

function unwrapPromise(node) {
  if (
    ts.isTypeReferenceNode(node)
    && ts.isIdentifier(node.typeName)
    && node.typeName.text === 'Promise'
    && node.typeArguments?.length
  ) {
    return node.typeArguments[0]
  }
  return node
}

function unwrapRemote(node) {
  if (
    ts.isTypeReferenceNode(node)
    && ts.isIdentifier(node.typeName)
    && node.typeName.text === 'RemoteResult'
    && node.typeArguments?.length
  ) {
    return node.typeArguments[0]
  }
  return node
}

const backend = new Map()
for (const file of classFiles) {
  const sf = parse(join(gwDir, file))
  for (const statement of sf.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.members) continue
    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member) || !member.name) continue
      const decorators = (member.modifiers ?? []).map((modifier) => modifier.getText()).join('\n')
      const match = decorators.match(/@Remote\(\s*'([^']+)'\s*\)/)
      if (!match) continue
      backend.set(match[1], member)
    }
  }
}

const client = new Map()
const clientSource = parse(apiFile)
for (const statement of clientSource.statements) {
  if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== 'WechatRemote') continue
  for (const member of statement.members) {
    if (ts.isMethodSignature(member) && member.name) client.set(member.name.getText(), member)
  }
}

function businessParameters(method) {
  return method.parameters.filter((parameter) => {
    return !(parameter.name.getText() === 'signal' && parameter.type?.getText() === 'AbortSignal')
  })
}

const diffs = []
for (const name of [...backend.keys()].sort()) {
  const backendMethod = backend.get(name)
  const clientMethod = client.get(name)
  if (!backendMethod || !clientMethod) continue
  const bp = businessParameters(backendMethod)
  const cp = businessParameters(clientMethod)
  for (let i = 0; i < bp.length; i += 1) {
    const a = objectShape(bp[i].type)
    const d = objectShape(cp[i].type)
    if (a && d && JSON.stringify([...a]) !== JSON.stringify([...d])) {
      diffs.push({ name, param: i, backend: [...a], client: [...d] })
    }
  }
  const backendReturn = objectShape(unwrapPromise(backendMethod.type))
  const clientReturn = objectShape(unwrapRemote(unwrapPromise(clientMethod.type)))
  if (
    backendReturn
    && clientReturn
    && JSON.stringify([...backendReturn]) !== JSON.stringify([...clientReturn])
  ) {
    diffs.push({ name, return: true, backend: [...backendReturn], client: [...clientReturn] })
  }
}

console.log('diffs', diffs.length)
for (const diff of diffs) console.log(JSON.stringify(diff))
