import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const root = process.cwd()
const gwDir = join(root, 'src', 'backend', 'wechat-data', 'src')
const manifest = JSON.parse(readFileSync(join(root, 'tools', 'remote-files.json'), 'utf8'))
const classFiles = manifest.gatewayClassFiles
const apiFile = join(root, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'api-core.ts')
function parse(file){ const text=readFileSync(file,'utf8'); return ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS) }
const backend = new Map()
for (const f of classFiles) {
  const sf=parse(join(gwDir,f))
  for (const st of sf.statements) {
    if (ts.isClassDeclaration(st) && st.members) {
      for (const m of st.members) {
        if (!ts.isMethodDeclaration(m) || !m.name) continue
        const decs = m.modifiers?.map(x=>x.getText()).join('\n') ?? ''
        const match = decs.match(/@Remote\(\s*'([^']+)'\s*\)/)
        if (!match) continue
        const name=match[1]
        backend.set(name, m.parameters.map(p=>({name: p.name.getText(), optional: !!p.questionToken, type: p.type?.getText() ?? ''})))
      }
    }
  }
}
const sfi=parse(apiFile)
const client=new Map()
for (const st of sfi.statements) {
  if (ts.isInterfaceDeclaration(st) && st.name.text==='WechatRemote') {
    for (const m of st.members) {
      if (ts.isMethodSignature(m) && m.name) client.set(m.name.getText(), m.parameters.map(p=>({name: p.name.getText(), optional: !!p.questionToken, type: p.type?.getText() ?? ''})))
    }
  }
}
function bus(p){ return p.filter(x=>!(x.name==='signal' && x.type==='AbortSignal')) }
const diffs=[]
for (const [name,bp] of [...backend].sort((a,b)=>a[0].localeCompare(b[0]))) {
  const cp=client.get(name)
  if (!cp) { diffs.push({name,kind:'missing'}); continue }
  const b=bus(bp), c=bus(cp)
  if (b.length!==c.length || b.some((x,i)=>x.optional!==c[i].optional)) diffs.push({name, b, c})
}
for (const name of [...client.keys()]) if (!backend.has(name)) diffs.push({name,kind:'extra'})
console.log('backend', backend.size, 'client', client.size, 'diffs', diffs.length)
for (const d of diffs) console.log(JSON.stringify(d))
