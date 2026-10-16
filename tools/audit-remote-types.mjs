import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const gwDir = join(root, 'src', 'backend', 'wechat-data', 'src')
// 与 docs:api 的取数口径一致：读自动推导的网关继承链，而不是维护手写清单。
const manifest = JSON.parse(readFileSync(join(root, 'tools', 'remote-files.json'), 'utf8'))
const classFiles = manifest.gatewayClassFiles
const apiFile = join(root, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'api-core.ts')

const rootNames = [...classFiles.map((file) => join(gwDir, file)), apiFile]
const program = ts.createProgram(rootNames, {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  baseUrl: join(root, 'src', 'client', 'ui-wechat'),
  paths: {
    '@deepseek-ai/dsh-wechat-data/types': [
      join(root, 'src', 'backend', 'wechat-data', 'lib', 'types', 'types.d.ts'),
    ],
    '@deepseek-ai/dsh-client-ui-primitives': [
      join(root, 'src', 'client', 'ui-primitives-shim', 'src', 'index.ts'),
    ],
  },
  allowImportingTsExtensions: true,
  skipLibCheck: true,
  strict: true,
  noEmit: true,
})
const checker = program.getTypeChecker()

function methodEntries(file) {
  const sf = program.getSourceFile(file)
  if (!sf) return []
  const methods = new Map()
  for (const st of sf.statements) {
    if (!ts.isClassDeclaration(st) || !st.members) continue
    for (const member of st.members) {
      if (!ts.isMethodDeclaration(member) || !member.name) continue
      const decorators = member.modifiers?.filter((modifier) => ts.isDecorator(modifier)) ?? []
      const text = decorators.map((decorator) => decorator.getText()).join('\n')
      const match = text.match(/@Remote\(\s*'([^']+)'\s*\)/)
      if (match) methods.set(match[1], member)
    }
  }
  return methods
}

function clientMethods(file) {
  const sf = program.getSourceFile(file)
  const methods = new Map()
  if (!sf) return methods
  for (const st of sf.statements) {
    if (!ts.isInterfaceDeclaration(st) || st.name.text !== 'WechatRemote') continue
    for (const member of st.members) {
      if (ts.isMethodSignature(member) && member.name) methods.set(member.name.getText(), member)
    }
  }
  return methods
}

const backend = new Map()
for (const file of classFiles) {
  for (const [name, method] of methodEntries(join(gwDir, file))) backend.set(name, method)
}
const client = clientMethods(apiFile)
if (backend.size === 0 || client.size === 0) {
  console.error(`audit-remote-types 空转：backend=${backend.size} client=${client.size}`)
  process.exitCode = 1
}

function nodeType(node) {
  return node ? checker.getTypeFromTypeNode(node) : checker.getAnyType()
}

function isAny(type) {
  return Boolean(type.flags & ts.TypeFlags.Any)
}

function sameType(left, right) {
  if (isAny(left) !== isAny(right)) return false
  return checker.isTypeAssignableTo(left, right) && checker.isTypeAssignableTo(right, left)
}

function typeArgOf(type, name) {
  if (!(type.flags & ts.TypeFlags.Object)) return null
  const target = type.target?.symbol?.escapedName ?? type.aliasSymbol?.escapedName
  if (target !== name) return null
  const args = type.aliasTypeArguments ?? type.typeArguments
  return args?.[0] ?? null
}

function unwrapNamed(type, name) {
  let current = type
  for (let i = 0; i < 4; i += 1) {
    const inner = typeArgOf(current, name)
    if (!inner) return current
    current = inner
  }
  return current
}

function businessType(method) {
  const raw = nodeType(method.type)
  const awaited = checker.getAwaitedType(raw) ?? raw
  return unwrapNamed(awaited, 'RemoteResult')
}

function isSignalParameter(parameter) {
  return parameter.name.getText() === 'signal' && parameter.type?.getText() === 'AbortSignal'
}

function typeLabel(type, node) {
  return checker.typeToString(type, node, ts.TypeFormatFlags.NoTruncation)
}

const diffs = []
for (const [name, backendMethod] of [...backend].sort(([a], [b]) => a.localeCompare(b))) {
  const clientMethod = client.get(name)
  if (!clientMethod) {
    diffs.push({ name, kind: 'missing' })
    continue
  }
  const bp = backendMethod.parameters.filter((parameter) => !isSignalParameter(parameter))
  const cp = clientMethod.parameters.filter((parameter) => !isSignalParameter(parameter))
  const paramDiffs = []
  if (bp.length !== cp.length) {
    paramDiffs.push(`count ${bp.length} != ${cp.length}`)
  } else {
    for (let i = 0; i < bp.length; i += 1) {
      const b = bp[i]
      const c = cp[i]
      if (!b || !c) continue
      if (Boolean(b.questionToken) !== Boolean(c.questionToken)) {
        paramDiffs.push(`${b.name.getText()} optional ${Boolean(b.questionToken)} != ${Boolean(c.questionToken)}`)
      }
      const bType = nodeType(b.type)
      const cType = nodeType(c.type)
      if (!sameType(bType, cType)) {
        paramDiffs.push(`${b.name.getText()}: ${typeLabel(bType, b.type)} != ${typeLabel(cType, c.type)}`)
      }
    }
  }
  const bRet = businessType(backendMethod)
  const cRet = businessType(clientMethod)
  const returnDiff = sameType(bRet, cRet)
    ? ''
    : `${typeLabel(bRet, backendMethod.type)} != ${typeLabel(cRet, clientMethod.type)}`
  if (paramDiffs.length > 0 || returnDiff) {
    diffs.push({ name, params: paramDiffs, return: returnDiff || 'ok' })
  }
}

for (const name of client.keys()) {
  if (!backend.has(name)) diffs.push({ name, kind: 'extra' })
}

console.log('backend', backend.size, 'client', client.size, 'diffs', diffs.length)
for (const diff of diffs) console.log(JSON.stringify(diff))
if (diffs.length > 0) process.exitCode = 1
