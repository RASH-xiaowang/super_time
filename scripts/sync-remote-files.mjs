import ts from 'typescript'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const gwDir = join(root, 'src', 'backend', 'wechat-data', 'src')
const apiDir = join(root, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data')
const manifestPath = join(root, 'tools', 'remote-files.json')

function parse(file) {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
}

function gatewayClassChain() {
  const files = readdirSync(gwDir)
    .filter((file) => /^gateway(?:-[a-z0-9-]+)?\.ts$/.test(file))
    .sort()
  const classes = new Map()
  for (const file of files) {
    const sf = parse(join(gwDir, file))
    for (const statement of sf.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) continue
      const heritage = statement.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
      const base = heritage?.types[0]?.expression
      const baseName = base && ts.isIdentifier(base) ? base.text : null
      classes.set(statement.name.text, { file, base: baseName })
    }
  }

  const leaf = classes.get('WechatDataGateway')
  if (!leaf) throw new Error('找不到 WechatDataGateway 类，无法推导网关继承链')
  const chain = []
  const seen = new Set()
  let current = leaf
  while (current) {
    if (seen.has(current.file)) throw new Error(`网关继承链出现循环：${current.file}`)
    seen.add(current.file)
    chain.push(current.file)
    current = current.base ? classes.get(current.base) ?? null : null
  }
  chain.reverse()
  if (chain.length < 5 || chain.at(-1) !== 'gateway.ts') {
    throw new Error(`推导出的网关继承链不完整：${chain.join(', ')}`)
  }
  return chain
}

function apiFiles() {
  const bucket = 'api.ts'
  const sf = parse(join(apiDir, bucket))
  const reexports = []
  for (const statement of sf.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
    const target = statement.moduleSpecifier.text.replace(/^\.\//, '')
    if (!/^api(?:-[a-z0-9-]+)?\.ts$/.test(target)) continue
    if (!existsSync(join(apiDir, target))) throw new Error(`api.ts 转发的模块不存在：${target}`)
    reexports.push(target)
  }
  if (!reexports.includes('api-core.ts')) {
    throw new Error('api.ts 没有转发 api-core.ts，前端镜像清单推导失败')
  }
  return [bucket, ...reexports]
}

function buildManifest() {
  return {
    generatedBy: 'scripts/sync-remote-files.mjs',
    gatewayClassFiles: gatewayClassChain(),
    gatewayApiFiles: apiFiles(),
  }
}

const canonical = `${JSON.stringify(buildManifest(), null, 2)}\n`
const check = process.argv.includes('--check')

if (check) {
  if (!existsSync(manifestPath)) {
    console.error('❌ tools/remote-files.json 不存在：请运行 npm run sync:remote-files')
    process.exit(1)
  }
  const current = readFileSync(manifestPath, 'utf8').replace(/\r\n/g, '\n')
  if (current !== canonical) {
    console.error('❌ tools/remote-files.json 已过期：请运行 npm run sync:remote-files 后提交')
    process.exit(1)
  }
  const manifest = JSON.parse(current)
  console.log(
    `ok: 网关类文件 ${manifest.gatewayClassFiles.length} 个，前端镜像 ${manifest.gatewayApiFiles.length} 个`,
  )
  process.exit(0)
}

writeFileSync(manifestPath, canonical, 'utf8')
const manifest = JSON.parse(canonical)
console.log(
  `已生成 tools/remote-files.json：网关类文件 ${manifest.gatewayClassFiles.length} 个，前端镜像 ${manifest.gatewayApiFiles.length} 个`,
)
