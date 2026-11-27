/** Offline SNS-only paired benchmark. Explicit opt-in; never opens application/user data. */
import { createHash, createCipheriv } from 'node:crypto'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { deflateSync } from 'node:zlib'
import ts from 'typescript'
import { describe, it, expect, vi } from 'vitest'
import * as cacheBudget from '../src/query/cache-budget.ts'
import * as mediaAsync from '../src/query/media-image-async.ts'
import * as md5Module from '../src/md5.ts'
import * as scan from '../src/query/sns-scan.ts'
import { drainSnsWorkPool } from '../../../client/ui-wechat/src/client/pages/wechat-data/panels/moments-media-scheduler.ts'
const meters=vi.hoisted(()=>({decode:0,read:0,outbound:0}))
vi.mock('../src/query/media-image-async.ts',async original=>{const m=await original<typeof import('../src/query/media-image-async.ts')>();return {...m,decodeDatBytesAsync:async (...args:Parameters<typeof m.decodeDatBytesAsync>)=>{meters.decode++;return m.decodeDatBytesAsync(...args)}}})
vi.mock('node:fs/promises',async original=>{const m=await original<typeof import('node:fs/promises')>();return {...m,readFile:(...args:unknown[])=>{meters.read++;return (m.readFile as (...a:unknown[])=>unknown)(...args)}}})
const candidate=await import('../src/query/sns-image.ts')
const OUT=path.resolve('.tmp/moments-perf-t155u')
const KEY='0123456789abcdef' // Public, generated fixture key, never any real user's key.
const sha=(b:string|Uint8Array)=>createHash('sha256').update(b).digest('hex')
function baselineModule():typeof candidate {
  const source=fs.readFileSync(path.join(OUT,'sns-image.ts.baseline'),'utf8')
  const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
  const imports:Record<string,unknown>={'node:crypto':crypto,'node:fs':fs,'node:fs/promises':fsp,'node:path':path,'./cache-budget.ts':cacheBudget,'./media-image-async.ts':mediaAsync,'../md5.ts':md5Module,'./sns-scan.ts':scan}
  const exports={}; new Function('require','exports',js)((name:string)=>{if(!(name in imports))throw Error('Unexpected baseline dependency '+name);return imports[name]},exports)
  return exports as typeof candidate
}
function crc(b:Buffer):number {let c=0xffffffff;for(const v of b){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0)}return(c^0xffffffff)>>>0}
function chunk(type:string,data:Buffer):Buffer {const name=Buffer.from(type),len=Buffer.alloc(4),sum=Buffer.alloc(4);len.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([len,name,data,sum])}
function png(seed:number):Buffer {
  const w=128,h=128,raw=Buffer.alloc(h*(w*3+1));let n=seed
  for(let y=0;y<h;y++)for(let x=1;x<=w*3;x++){n^=n<<13;n^=n>>>17;n^=n<<5;raw[y*(w*3+1)+x]=n&255}
  const ih=Buffer.alloc(13);ih.writeUInt32BE(w,0);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=2
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ih),chunk('IDAT',deflateSync(raw,{level:6})),chunk('IEND',Buffer.alloc(0))])
}
function encrypted(b:Buffer):Buffer {const c=createCipheriv('aes-128-ecb',KEY,null);const enc=Buffer.concat([c.update(b),c.final()]);const head=Buffer.alloc(15);head.set([7,8,86,50,8,7]);head.writeUInt32LE(b.length,6);return Buffer.concat([head,enc])}
function memory(){const m=process.memoryUsage();return {rss:m.rss,heapUsed:m.heapUsed,external:m.external,arrayBuffers:m.arrayBuffers}}
function maxMemory(a:ReturnType<typeof memory>,b:ReturnType<typeof memory>){return Object.fromEntries(Object.keys(a).map(k=>[k,Math.max(a[k as keyof typeof a],b[k as keyof typeof b])])) as ReturnType<typeof memory>}
const quantile=(a:number[],q:number)=>{const sorted=[...a].sort((x,y)=>x-y);return sorted[Math.max(0,Math.ceil(q*sorted.length)-1)]??0}
async function measured(label:string,fn:(sample:()=>void)=>Promise<object>){const start=memory();let peak=start;const sample=()=>{peak=maxMemory(peak,memory())};const timer=setInterval(sample,2);const t=performance.now();try{return {label,...await fn(sample),wallMs:performance.now()-t,memoryStart:start,memoryEnd:memory(),sampledPeak:peak}}finally{clearInterval(timer)}}
describe.skipIf(process.env.MOMENTS_PERF!=='1')('offline paired SNS synthetic benchmark',()=>{
  it('records every interleaved sample, output equivalence, counts and Node memory',async()=>{
    const old=baselineModule();const scratch=fs.mkdtempSync(path.join(tmpdir(),'sns-synthetic-t155u-'));const previousFetch=globalThis.fetch
    globalThis.fetch=(()=>{meters.outbound++;throw Error('NETWORK FORBIDDEN: offline SNS fixture')}) as typeof fetch
    const fixtures=Array.from({length:24},(_,i)=>png(155000+i));const rows:Record<string,unknown>[]=[]
    const identity=fixtures.map((b,i)=>({index:i,width:128,height:128,format:'png',seed:155000+i,bytes:b.length,sha256:sha(b),encryptedBytes:encrypted(b).length,encryptedSha256:sha(encrypted(b))}))
    const repetitions=12
    try {
      for(let pair=0;pair<repetitions;pair++)for(const variant of (pair%2===0?['baseline','candidate']:['candidate','baseline'])){
        const mod=variant==='baseline'?old:candidate
        mod.snsImageUrlCacheHandles().clear()
        const base=path.join(scratch,`pair-${pair}-${variant}`);fs.mkdirSync(base,{recursive:true})
        for(let i=0;i<fixtures.length;i++){const h=createHash('md5').update(`synthetic-${i}_media-${i}_2`).digest('hex');const dir=path.join(base,'cache','2026-11','Sns','Img',h.slice(0,2));fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,h.slice(2)),encrypted(fixtures[i]!))}
        for(const temperature of ['application-cold','application-warm']){
          meters.decode=0;meters.read=0
          rows.push({pair,variant,scenario:'24-local-V2-PNG',temperature,...await measured('resolve/read/decrypt/base64 (not browser pixel decode)',async sample=>{
            const times:number[]=[];const t=performance.now();let C=0,M=0,success=0,peakActive=0,active=0
            await drainSnsWorkPool(Array.from({length:24},(_,i)=>i),4,()=>false,async i=>{
              peakActive=Math.max(peakActive,++active);const d=meters.decode
              const r=await mod.resolveSnsImageDataUrl(base,KEY,0x60,createHash('md5').update(fixtures[i]!).digest('hex'),`synthetic-${i}`,`media-${i}`,false)
              if(r.url){const decoded=Buffer.from(r.url.split(',')[1]!,'base64');expect(sha(decoded)).toBe(identity[i]!.sha256);success++}
              if(r.url&&meters.decode===d)C++;else M++
              times.push(performance.now()-t);sample();active--
            })
            return {success,expected:24,firstImageMs:times[0],first12ImagesMs:times[11],allImagesMs:times.at(-1),peakActive,counts:{A:24,C,J:0,M,X:0,cacheHitDenominator:24,cacheHitRate:C/24,joinedRate:0,read:meters.read,decode:meters.decode,download:0},completionP50Ms:quantile(times,.5),completionP95Ms:quantile(times,.95)}
          })})
        }
        rows.push({pair,variant,scenario:'slow-first-refill',...await measured('timer-backed scheduler only; no download/decode',async sample=>{
          const times:number[]=[];const t=performance.now();let active=0,peakActive=0
          const work=async(i:number)=>{peakActive=Math.max(peakActive,++active);await new Promise(r=>setTimeout(r,i===0?24:2));times.push(performance.now()-t);sample();active--}
          const q=Array.from({length:24},(_,i)=>i)
          if(variant==='baseline'){while(q.length)await Promise.all(q.splice(0,4).map(work))}else await drainSnsWorkPool(q,4,()=>false,work)
          expect(peakActive).toBeLessThanOrEqual(4)
          return {success:times.length,firstImageMs:times[0],first12ImagesMs:times[11],allImagesMs:times.at(-1),peakActive}
        })})
      }
      const report={timestamp:new Date().toISOString(),timezone:'Asia/Shanghai (raw timestamp ISO UTC)',node:process.version,platform:process.platform,arch:process.arch,repetitions,order:'paired alternate baseline/candidate; no samples dropped',fixture:{seed:155000,count:24,encoding:'PNG RGB8 128x128 zlib level6; AES-128-ECB V2 PKCS7; public fixed synthetic key',images:identity},limitations:['No Electron renderer/GPU/pixel decode/real network/user files','Application cold: URL cache explicitly cleared plus unique fixture root; warm repeats same root and module. OS filesystem cache not controlled','Node process memory sampled every 2ms plus task completion; short peaks may be missed; process background allocations and GC are not isolated','RSS/heapUsed/external/arrayBuffers are bytes, external and arrayBuffers overlap; never sum them','Front-end scheduler baseline is a restricted replay of old splice(0,4)/Promise.all algorithm, not complete old UI','Cache rates count eligible returned requests; in-flight joins are not counted as cache hits; backend has no new joiner here'],sourceHashes:Object.fromEntries(['src/backend/wechat-data/src/query/sns-image.ts','.tmp/moments-perf-t155u/sns-image.ts.baseline','package-lock.json'].map(f=>[f,fs.existsSync(f)?sha(fs.readFileSync(f)):'absent'])),outboundCalls:meters.outbound,rows,summary:[] as object[]}
      for(const scenario of ['24-local-V2-PNG','slow-first-refill'])for(const variant of ['baseline','candidate'])for(const temperature of (scenario==='24-local-V2-PNG'?['application-cold','application-warm']:[undefined])){
        const selected=rows.filter(r=>r.scenario===scenario&&r.variant===variant&&r.temperature===temperature)
        report.summary.push({scenario,variant,temperature,n:selected.length,wallP50Ms:quantile(selected.map(r=>Number(r.wallMs)),.5),wallP95Ms:quantile(selected.map(r=>Number(r.wallMs)),.95),first12P50Ms:quantile(selected.map(r=>Number(r.first12ImagesMs)),.5),heapUsedSampledPeakMax:Math.max(...selected.map(r=>(r.sampledPeak as ReturnType<typeof memory>).heapUsed)),rssSampledPeakMax:Math.max(...selected.map(r=>(r.sampledPeak as ReturnType<typeof memory>).rss))})
      }
      fs.mkdirSync(OUT,{recursive:true});fs.writeFileSync(path.join(OUT,'raw-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report.summary,null,2));expect(meters.outbound).toBe(0)
    }finally{globalThis.fetch=previousFetch;fs.rmSync(scratch,{recursive:true,force:true})}
  },120000)
})
