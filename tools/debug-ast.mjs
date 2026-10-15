import ts from 'typescript'; import {readFileSync} from 'node:fs'; import {join} from 'node:path';
const f=join(process.cwd(),'src','backend','wechat-data','src','gateway-read.ts'); const sf=ts.createSourceFile(f,readFileSync(f,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
let n=0; for(const st of sf.statements){ if(ts.isClassDeclaration(st)){ for(const m of st.members||[]){ console.log('member',ts.SyntaxKind[m.kind], m.name&&m.name.getText(), 'decorators', m.decorators?.length, 'mods', m.modifiers?.map(x=>x.getText())); if(++n>10) process.exit() } } }
