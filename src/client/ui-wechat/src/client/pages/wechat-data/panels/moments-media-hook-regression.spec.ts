// @vitest-environment jsdom
import { act, createElement, useRef, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
const api=vi.hoisted(()=>({apiGetSnsImageDataUrl:vi.fn(),apiGetSnsVideoCoverDataUrl:vi.fn(),apiGetArticleCovers:vi.fn(),snsMediaCacheGet:vi.fn(),snsMediaCacheGetMany:vi.fn(),snsMediaCacheSet:vi.fn()}))
vi.mock('../api.ts',()=>api)
const {useMomentsMedia}=await import('./moments-media.ts')
const {setDataDirIdentity}=await import('../cache.ts')
type Media=ReturnType<typeof useMomentsMedia>
let media:Media, root:Root|undefined, host:HTMLDivElement, io:IntersectionObserverCallback
const empty:never[]=[];const disk=new Map<string,string>()
const fixture='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGmQAAAAASUVORK5CYII='
function Harness({count=201}:{count?:number}){const scrollRef=useRef<HTMLDivElement>(null);media=useMomentsMedia({moments:empty,viewer:null,scrollRef,groups:empty,renderKey:'fixture',detailKey:'',rows:[],windowEnd:-1});for(let i=0;i<count;i++)media.mediaKeySpec.current.set('fixture-'+i,{md5:'fixture-'+i,kind:'img'});return createElement('div',{ref:scrollRef})}
async function flush(){await act(async()=>{for(let i=0;i<20;i++)await Promise.resolve()})}
async function intersect(index:number){const el=document.createElement('div');el.dataset.snsKey='fixture-'+index;await act(async()=>{io([{target:el,isIntersecting:true} as unknown as IntersectionObserverEntry],{} as IntersectionObserver);for(let i=0;i<20;i++)await Promise.resolve()})}
beforeEach(()=>{
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true
  setDataDirIdentity('offline-hook-fixture');Object.values(api).forEach(m=>m.mockReset());disk.clear()
  Object.defineProperty(navigator,'onLine',{configurable:true,value:true})
  vi.stubGlobal('IntersectionObserver',class{constructor(cb:IntersectionObserverCallback){io=cb}observe(){}disconnect(){}unobserve(){}takeRecords(){return []}})
  api.snsMediaCacheGet.mockImplementation(async(key:string)=>disk.get(key)??null);api.snsMediaCacheGetMany.mockResolvedValue({});api.snsMediaCacheSet.mockImplementation(async(key:string,url:string)=>{disk.set(key,url)});api.apiGetSnsImageDataUrl.mockResolvedValue({url:fixture});api.apiGetArticleCovers.mockResolvedValue({items:[]})
  host=document.createElement('div');document.body.append(host);root=createRoot(host)
})
afterEach(async()=>{await act(async()=>{root?.unmount()});root=undefined;host.remove();vi.unstubAllGlobals()})
describe('SNS hook integration: synthetic IO + private in-memory IDB adapter',()=>{
  it('201 images then return to first: actual hook restores IDB with no additional RPC',async()=>{
    await act(async()=>root?.render(createElement(Harness)));await flush()
    for(let i=0;i<201;i++)await intersect(i)
    expect(Object.keys(media.snsImgs)).toHaveLength(200);expect(media.snsImgs['fixture-0']).toBeUndefined();expect(api.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(201)
    await intersect(0);expect(media.snsImgs['fixture-0']).toBe(fixture);expect(api.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(201)
    expect(disk.size).toBe(201)
  })
  it('201 roundtrip with missing IDB makes only one replacement RPC while active',async()=>{
    await act(async()=>root?.render(createElement(Harness)));for(let i=0;i<201;i++)await intersect(i)
    disk.clear();let release!:(r:{url:string})=>void;api.apiGetSnsImageDataUrl.mockImplementation(()=>new Promise(r=>{release=r}))
    await intersect(0);await intersect(0);expect(api.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(202);release({url:fixture});await flush()
    expect(media.snsImgs['fixture-0']).toBe(fixture)
  })
  it('grid and lightbox equivalent live requests share a single underlying RPC',async()=>{
    let release!:(r:{url:string})=>void;api.apiGetSnsImageDataUrl.mockImplementation(()=>new Promise(r=>{release=r}))
    await act(async()=>root?.render(createElement(Harness,{count:1})));await intersect(0)
    expect(api.apiGetSnsImageDataUrl.mock.calls[0]?.[0]).not.toHaveProperty('seed')
    const viewer=media.resolveSnsOriginal({md5:'fixture-0'});await flush();expect(api.apiGetSnsImageDataUrl, JSON.stringify(api.apiGetSnsImageDataUrl.mock.calls)).toHaveBeenCalledTimes(1)
    await act(async()=>{release({url:fixture});await viewer});expect(media.snsImgs['fixture-0']).toBe(fixture)
  })
  it('offline work remains serial even when four slots and the viewer request work',async()=>{
    Object.defineProperty(navigator,'onLine',{configurable:true,value:false});const releases:Array<(r:{url:string})=>void>=[]
    api.apiGetSnsImageDataUrl.mockImplementation(()=>new Promise(r=>{releases.push(r)}))
    await act(async()=>root?.render(createElement(Harness,{count:4})));for(let i=0;i<4;i++)await intersect(i)
    expect(api.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(1)
    for(let i=0;i<4;i++){releases[i]!({url:fixture});await flush()}
    expect(api.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(4)
  })
  it('StrictMode setup/cleanup does not strand active slots',async()=>{
    await act(async()=>root?.render(createElement(StrictMode,null,createElement(Harness,{count:1}))));await intersect(0);expect(media.snsImgs['fixture-0']).toBe(fixture)
  })
})
