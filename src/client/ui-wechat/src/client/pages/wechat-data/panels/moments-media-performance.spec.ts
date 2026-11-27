// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSnsRequestJoiner, drainSnsWorkPool } from './moments-media-scheduler.ts'
import { getDataIdentitySnapshot, setDataDirIdentity } from '../cache.ts'
const mocks = vi.hoisted(() => ({ apiGetSnsImageDataUrl: vi.fn(), apiGetSnsVideoCoverDataUrl: vi.fn(), apiGetArticleCovers: vi.fn(), snsMediaCacheGet: vi.fn(), snsMediaCacheGetMany: vi.fn(), snsMediaCacheSet: vi.fn() }))
vi.mock('../api.ts', () => mocks)
const { BoundedMediaSet, enqueueIntersecting, mergeSnsImageEntries, createSnsOriginalResolver, snsImageQuality, SNS_RESIDENT_ESTIMATED_BYTES } = await import('./moments-media.ts')
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }
beforeEach(() => { Object.values(mocks).forEach((m) => m.mockReset()); mocks.snsMediaCacheGet.mockResolvedValue(null); mocks.snsMediaCacheSet.mockResolvedValue(undefined); setDataDirIdentity('fixture-A') })
function entry(key: string): IntersectionObserverEntry {
  const el = document.createElement('div'); el.dataset.snsKey = key
  el.getBoundingClientRect = () => ({ top: 1, bottom: 2 } as DOMRect)
  return { isIntersecting: true, target: el, time: 0, intersectionRatio: 1, rootBounds: null, boundingClientRect: el.getBoundingClientRect(), intersectionRect: el.getBoundingClientRect() }
}
describe('SNS residency and scheduling performance contracts', () => {
  it('201-entry roundtrip restores an evicted success even while fetched remembers it', () => {
    let resident = {}; const fetched = new Set<string>(); const specs = new Map()
    for (let i = 0; i < 201; i++) { const key = `k${i}`; fetched.add(key); specs.set(key, { md5: key, kind: 'img' }); resident = mergeSnsImageEntries(resident, { [key]: { url: `data:${i}`, original: true } }) }
    expect(Object.keys(resident)).toHaveLength(200); expect(resident).not.toHaveProperty('k0')
    const queue = { current: [] }; const active = new Set<string>()
    const canRestore = (key: string) => !(key in resident)
    expect(enqueueIntersecting([entry('k0')], specs, fetched, active, queue, null, canRestore)).toBe(true)
    expect(enqueueIntersecting([entry('k0')], specs, fetched, active, queue, null, canRestore)).toBe(false)
    expect(queue.current).toHaveLength(1)
  })
  it('>4000 fetched history remains bounded, terminal failures can still block retries', () => {
    const fetched = new BoundedMediaSet<string>(4000)
    for (let i = 0; i < 4100; i++) fetched.add(`k${i}`)
    expect(fetched.size).toBe(4000)
    const q = { current: [] }, specs = new Map([['k4099', { md5: 'x', kind: 'img' as const }]])
    expect(enqueueIntersecting([entry('k4099')], specs, fetched, new Set(), q, null, () => false)).toBe(false)
  })
  it('refills a freed slot while the first image remains slow, peak <=4', async () => {
    const jobs = Array.from({ length: 8 }, () => deferred<void>()); const started: number[] = []; let active = 0, peak = 0
    const run = drainSnsWorkPool([0,1,2,3,4,5,6,7],4,()=>false,async i=> { started.push(i); peak=Math.max(peak,++active); await jobs[i]!.promise; active-- })
    expect(started).toEqual([0,1,2,3]); jobs[1]!.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(started).toContain(4); expect(started).not.toContain(5)
    jobs.forEach(j=>j.resolve()); await run; expect(peak).toBe(4)
  })
  it('joins identical live requests but not quality, offline or generation changes', async () => {
    const pending=deferred<string>(); let scope='A'; const raw=vi.fn(()=>pending.promise)
    const get=createSnsRequestJoiner(raw,()=>scope)
    const a=get({md5:'x', quality:1, offline:false}); const b=get({md5:'x', quality:1, offline:false})
    expect(a).toBe(b); get({md5:'x',quality:2,offline:false}); get({md5:'x',quality:1,offline:true}); scope='B'; get({md5:'x',quality:1,offline:false})
    await Promise.resolve(); expect(raw).toHaveBeenCalledTimes(4); pending.resolve('data:x'); await a
    await get({md5:'x',quality:1,offline:false}); expect(raw).toHaveBeenCalledTimes(5)
  })
  it('stops taking queued work on cancellation without cancelling another consumer', async () => {
    let cancelled=false; const d=deferred<void>(); const ran:number[]=[]
    const run=drainSnsWorkPool([1,2,3],1,()=>cancelled,async i=>{ran.push(i); await d.promise})
    cancelled=true; d.resolve(); await run; expect(ran).toEqual([1])
  })
  it('enforces URL-byte estimate and prefers visible resident images; never downgrades originals', () => {
    const url='x'.repeat(SNS_RESIDENT_ESTIMATED_BYTES/6)
    const r=mergeSnsImageEntries({visible:{url,original:true},offscreen:{url,original:true},other:{url,original:true}}, {new:{url,original:true}},new Set(['visible']))
    expect(r).toHaveProperty('visible'); expect(r).not.toHaveProperty('offscreen'); expect(Object.values(r).reduce((n,e)=>n+e.url.length*2,0)).toBeLessThanOrEqual(SNS_RESIDENT_ESTIMATED_BYTES)
    expect(mergeSnsImageEntries(r,{visible:{url:'thumb',original:false}}).visible?.url).toBe(url)
  })
})
describe('SNS explicit retry and generation contracts', () => {
  function setup() { const entries:Record<string,{url:string;original:boolean;quality?:string}>={}; let epoch=1
    const commit=vi.fn((key:string,url:string,original:boolean,quality?:string)=>{ entries[key]={url,original,...(quality===undefined?{}:{quality})} })
    const resolve=createSnsOriginalResolver({ current:key=>entries[key], commit, alive:()=>true, epoch:()=>epoch, runHeavy:task=>task() })
    return { entries,resolve,commit, next:()=>epoch++ }
  }
  it('automatic rerenders stay suppressed, explicit retry performs exactly one extra request and joins clicks', async()=>{
    const s=setup(); mocks.apiGetSnsImageDataUrl.mockRejectedValueOnce(new Error('fixture fail'))
    await expect(s.resolve({md5:'x'})).rejects.toThrow('fixture fail'); await expect(s.resolve({md5:'x'})).rejects.toThrow('不再自动重试')
    const d=deferred<{url:string}>(); mocks.apiGetSnsImageDataUrl.mockReturnValue(d.promise)
    const a=s.resolve({md5:'x'},{retry:true}), b=s.resolve({md5:'x'},{retry:true}); d.resolve({url:'data:ok'}); await Promise.all([a,b])
    expect(mocks.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(2)
  })
  it('successful original evicted from the viewer can restore IDB, no second RPC', async()=>{
    const s=setup(); mocks.apiGetSnsImageDataUrl.mockResolvedValue({url:'data:ok'}); await s.resolve({md5:'x'}); delete s.entries.x
    mocks.snsMediaCacheGet.mockResolvedValue('data:ok'); expect(await s.resolve({md5:'x'})).toBe('data:ok'); expect(mocks.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(1)
  })
  it('rejects late prior generation results and permits a new generation request', async()=>{
    const s=setup(), d=deferred<{url:string}>(); mocks.apiGetSnsImageDataUrl.mockReturnValueOnce(d.promise).mockResolvedValue({url:'data:new'})
    const old=s.resolve({md5:'x'}); await Promise.resolve(); s.next(); expect(await s.resolve({md5:'x'})).toBe('data:new')
    d.resolve({url:'data:old'}); await expect(old).rejects.toThrow('已取消'); expect(s.entries.x?.url).toBe('data:new')
  })
  it('rejects late prior account results and persists only namespaced quality keys', async()=>{
    const s=setup(), d=deferred<{url:string}>(); mocks.apiGetSnsImageDataUrl.mockReturnValue(d.promise)
    const a=s.resolve({md5:'x',originalWidth:900}); await Promise.resolve(); const scope=getDataIdentitySnapshot(); setDataDirIdentity('fixture-B'); d.resolve({url:'data:old'})
    await expect(a).rejects.toThrow('已取消'); expect(s.commit).not.toHaveBeenCalled(); expect(mocks.snsMediaCacheSet).not.toHaveBeenCalled()
    expect(mocks.snsMediaCacheGet.mock.calls[0]?.[0]).toContain(scope+':x:q')
  })
  it('unknown original can satisfy default quality but not newly supplied UHD requirements', async()=>{
    const s=setup(); s.entries.x={url:'data:old',original:true}; mocks.apiGetSnsImageDataUrl.mockResolvedValue({url:'data:uhd'})
    expect(await s.resolve({md5:'x'})).toBe('data:old'); expect(await s.resolve({md5:'x',uhdUrl:'synthetic://uhd',originalWidth:2048})).toBe('data:uhd')
    expect(s.entries.x?.quality).toBe(snsImageQuality({uhdUrl:'synthetic://uhd',originalWidth:2048}))
  })
})

// No wall-time threshold: behavior tests above deliberately use deferred promises, not fabricated latency.

describe.skipIf(process.env.MOMENTS_PERF !== '1')('paired SNS state-path measurements (not renderer/pixel decode)', () => {
  it('records cold/warm, 201-roundtrip, eviction, retry, quality and dual-consumer outcomes', async () => {
    const fs = await import('node:fs'), path = await import('node:path'), crypto = await import('node:crypto')
    const ts = (await import('typescript')).default, react = await import('react'), misc = await import('../utils/misc.ts'), support = await import('./moments-support.tsx')
    const candidate = await import('./moments-media.ts')
    const dir = path.resolve('.tmp/moments-perf-t155u')
    const source = fs.readFileSync(path.join(dir,'moments-media.ts.baseline'),'utf8') + '\nexport { mergeSnsImageEntries }\n'
    const imports:Record<string, unknown> = {react,'../api.ts':mocks,'../utils/misc.ts':misc,'./moments-support.tsx':support}
    const exports = {}
    new Function('require','exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)((name:string)=>{if(!(name in imports))throw Error('Unexpected baseline import '+name);return imports[name]},exports)
    const baseline = exports as typeof candidate
    const data='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGmQAAAAASUVORK5CYII='
    const rows:object[]=[]
    for(let pair=0;pair<12;pair++)for(const variant of (pair%2===0?['baseline','candidate']:['candidate','baseline']))for(const scenario of ['201-warm-roundtrip','success-evicted-IDB','failure-explicit-retry','quality-upgrade','cold-dual-consumer','stale-generation']) {
      Object.values(mocks).forEach(m=>m.mockReset());mocks.snsMediaCacheGet.mockResolvedValue(null);mocks.snsMediaCacheSet.mockResolvedValue(undefined)
      const mod=variant==='baseline'?baseline:candidate
      let resident:Record<string,{url:string;original:boolean;quality?:string}>={},epoch=1
      const resolve=mod.createSnsOriginalResolver({current:key=>resident[key],commit:(key,url,original,quality)=>{resident[key]={url,original,...(quality===undefined?{}:{quality})}},alive:()=>true,epoch:()=>epoch,runHeavy:task=>task()})
      const start=performance.now(),memoryStart=process.memoryUsage();let success=0,errors=0,C=0,J=0,M=0,A=0
      const call=async (image:{md5:string;uhdUrl?:string},opts?:{retry?:boolean})=>{A++;try{const r=await resolve(image,opts);if(r)success++;return r}catch{errors++;return ''}}
      if(scenario==='201-warm-roundtrip') {
        const fetched=new Set<string>(),specs=new Map<string,import('./moments-media.ts').MediaKeySpec>()
        for(let i=0;i<201;i++){const k='synthetic-'+i;resident=mod.mergeSnsImageEntries(resident,{[k]:{url:data,original:true}});fetched.add(k);specs.set(k,{md5:k,kind:'img'})}
        const q:{current:Array<{key:string}&import('./moments-media.ts').MediaKeySpec>}={current:[]}
        mod.enqueueIntersecting([entry('synthetic-0')],specs,fetched,new Set(),q,null,key=>!(key in resident))
        mocks.snsMediaCacheGet.mockResolvedValue(data);if(q.current.length){await call({md5:'synthetic-0'});C++}
      }else if(scenario==='success-evicted-IDB') {
        mocks.apiGetSnsImageDataUrl.mockResolvedValue({url:data});await call({md5:'x'});M++;delete resident.x;mocks.snsMediaCacheGet.mockResolvedValue(data);const r=await call({md5:'x'});if(r)C++
      }else if(scenario==='failure-explicit-retry') {
        mocks.apiGetSnsImageDataUrl.mockRejectedValueOnce(Error('fixture failure')).mockResolvedValue({url:data});await call({md5:'x'});M++;await call({md5:'x'});await call({md5:'x'},{retry:true});if(mocks.apiGetSnsImageDataUrl.mock.calls.length===2)M++
      }else if(scenario==='quality-upgrade') {
        resident.x={url:'data:old-preview',original:true};mocks.apiGetSnsImageDataUrl.mockResolvedValue({url:data});const r=await call({md5:'x',uhdUrl:'synthetic://uhd'});success=r===data?1:0;M=mocks.apiGetSnsImageDataUrl.mock.calls.length;C=M===0?1:0
      }else if(scenario==='cold-dual-consumer') {
        const d=deferred<{url:string}>();mocks.apiGetSnsImageDataUrl.mockReturnValue(d.promise);const a=call({md5:'x'}),b=call({md5:'x'});d.resolve({url:data});await Promise.all([a,b]);M=mocks.apiGetSnsImageDataUrl.mock.calls.length;J=2-M
      }else {
        const d=deferred<{url:string}>();mocks.apiGetSnsImageDataUrl.mockReturnValueOnce(d.promise).mockResolvedValue({url:data});const old=call({md5:'x'});await Promise.resolve();epoch++;const fresh=call({md5:'x'});d.resolve({url:'data:stale'});await Promise.all([old,fresh]);success=resident.x?.url===data?1:0;M=mocks.apiGetSnsImageDataUrl.mock.calls.length
      }
      const eligible=C+J+M
      rows.push({pair,variant,scenario,wallMs:performance.now()-start,memoryStart,memoryEnd:process.memoryUsage(),success,errors,counts:{A,C,J,M,X:A-eligible,cacheHitDenominator:eligible,cacheHitRate:eligible?C/eligible:0,joinDenominator:J+M,joinRate:J+M?J/(J+M):0,RPC:mocks.apiGetSnsImageDataUrl.mock.calls.length,IDBStubReads:mocks.snsMediaCacheGet.mock.calls.length,realDecode:0,download:0}})
    }
    fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'state-path-results.json'),JSON.stringify({timestamp:new Date().toISOString(),repetitions:12,order:'interleaved pairs, no dropped samples',fixture:{kind:'fixed complete 1x1 PNG dataURL, state path only',sha256:crypto.createHash('sha256').update(data).digest('hex')},limitations:['Real performance.now wall time but mocked IDB/RPC, no real image decode/network/Electron renderer','Memory start/end only, not peaks, includes test process and GC','Baseline failures are expected diagnostic outcomes; not speed wins','X includes suppressed/ineligible entries; C only actual eligible cache returns, J only joined in-flight'],rows},null,2))
    expect(rows).toHaveLength(144)
  })
})


describe('SNS persistent pool wake ownership', () => {
  it('later enqueues refill free slots without exceeding four active tasks', async () => {
    const jobs = Array.from({ length: 5 }, () => deferred<void>())
    const queue = [0], started: number[] = []; let active = 0, peak = 0, wake: (() => void) | undefined
    const run = drainSnsWorkPool(queue, 4, () => false, async i => { started.push(i); peak = Math.max(peak, ++active); await jobs[i]!.promise; active-- }, next => { wake = next })
    expect(started).toEqual([0]); queue.push(1, 2, 3, 4); wake?.(); expect(started).toEqual([0, 1, 2, 3])
    jobs[1]!.resolve(); for (let i = 0; i < 8; i++) await Promise.resolve(); expect(started).toEqual([0, 1, 2, 3, 4])
    jobs.forEach(j => j.resolve()); await run; expect(peak).toBe(4); expect(wake).toBeUndefined()
  })
  it('cancellation releases the wake handle after running work settles and never starts waiting items', async () => {
    const d = deferred<void>(); let cancelled = false, wake: (() => void) | undefined; const started: number[] = [], queue = [1]
    const run = drainSnsWorkPool(queue, 4, () => cancelled, async i => { started.push(i); await d.promise }, next => { wake = next })
    cancelled = true; queue.push(2); wake?.(); d.resolve(); await run; expect(started).toEqual([1]); expect(wake).toBeUndefined()
  })
  it('even an undefined rejection rejects the pool and releases wake ownership', async () => {
    let wake: (() => void) | undefined
    const p = drainSnsWorkPool([1], 4, () => false, async () => { throw undefined }, next => { wake = next })
    await expect(p).rejects.toBeUndefined(); expect(wake).toBeUndefined()
  })
})
