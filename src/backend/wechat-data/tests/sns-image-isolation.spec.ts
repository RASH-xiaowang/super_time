// @vitest-environment node
import { createCipheriv, createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
const calls=vi.hoisted(()=>({decode:0}))
vi.mock('../src/query/media-image-async.ts',async original=>{const m=await original<typeof import('../src/query/media-image-async.ts')>();return {...m,decodeDatBytesAsync:async(...args:Parameters<typeof m.decodeDatBytesAsync>)=>{calls.decode++;return m.decodeDatBytesAsync(...args)}}})
const { resolveSnsImageDataUrl, pumpSnsDecodeCache, snsAttachProgressForTest }=await import('../src/query/sns-image.ts')
const KEY='0123456789abcdef', roots:string[]=[]
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGmQAAAAASUVORK5CYII=','base64')
const md5=createHash('md5').update(png).digest('hex')
function root(){const d=mkdtempSync(join(tmpdir(),'sns-synthetic-isolation-'));roots.push(d);return d}
function put(file:string,b=png){const c=createCipheriv('aes-128-ecb',KEY,null);const enc=Buffer.concat([c.update(b),c.final()]);const h=Buffer.alloc(15);h.set([7,8,86,50,8,7]);h.writeUInt32LE(b.length,6);writeFileSync(file,Buffer.concat([h,enc]))}
afterEach(()=>{roots.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true}));calls.decode=0})
describe('SNS attach shared owner and account/decode generation isolation',()=>{
  it('pump account root then resolve db_storage reuses files and pending, not a second index',async()=>{
    const a=root();mkdirSync(join(a,'db_storage'));mkdirSync(join(a,'msg','attach'),{recursive:true});put(join(a,'msg','attach','1000_1700000000.dat'))
    await pumpSnsDecodeCache(a,KEY,0x60);expect(snsAttachProgressForTest(a,KEY,0x60)).toEqual({decoded:1,pending:0,paths:1})
    calls.decode=0;const r=await resolveSnsImageDataUrl(join(a,'db_storage'),KEY,0x60,md5,undefined,undefined,false)
    expect(r.url).toBe('data:image/png;base64,'+png.toString('base64'));expect(calls.decode).toBe(1)
    expect(snsAttachProgressForTest(join(a,'db_storage'),KEY,0x60)).toEqual(snsAttachProgressForTest(a,KEY,0x60))
  })
  it('same identity in another account cannot hit the first account URL cache',async()=>{
    const a=root(),b=root();const h=createHash('md5').update('synthetic_media_2').digest('hex');const d=join(a,'cache','2026-11','Sns','Img',h.slice(0,2));mkdirSync(d,{recursive:true});put(join(d,h.slice(2)))
    expect((await resolveSnsImageDataUrl(a,KEY,0x60,md5,'synthetic','media',false)).url).toBeTruthy()
    expect((await resolveSnsImageDataUrl(b,KEY,0x60,md5,'synthetic','media',false)).url).toBeUndefined()
  })
  it('decode-key generation changes cannot reuse plaintext data URL or attach index',async()=>{
    const a=root();mkdirSync(join(a,'msg','attach'),{recursive:true});put(join(a,'msg','attach','1000_1700000000.dat'));await pumpSnsDecodeCache(a,KEY,0x60)
    expect(snsAttachProgressForTest(a,'fedcba9876543210',0x60)).toBeUndefined()
    expect((await resolveSnsImageDataUrl(a,KEY,0x60,md5,undefined,undefined,false)).url).toBeTruthy()
    expect((await resolveSnsImageDataUrl(a,'fedcba9876543210',0x60,md5,undefined,undefined,false)).url).toBeUndefined()
  })
  it('original-only skips matching hash-named thumbnail before any read/decrypt',async()=>{
    const a=root();mkdirSync(join(a,'msg','attach'),{recursive:true});put(join(a,'msg','attach',md5+'_t.dat'))
    expect((await resolveSnsImageDataUrl(a,KEY,0x60,md5,undefined,undefined,false)).url).toBeUndefined();expect(calls.decode).toBe(0)
    expect((await resolveSnsImageDataUrl(a,KEY,0x60,md5)).url).toBeTruthy();expect(calls.decode).toBe(1)
  })
  it('concurrent warm and foreground do not duplicate pending decodes',async()=>{
    const a=root();mkdirSync(join(a,'msg','attach'),{recursive:true});put(join(a,'msg','attach','1000_1700000000.dat'))
    const warm=pumpSnsDecodeCache(a,KEY,0x60);const r=resolveSnsImageDataUrl(a,KEY,0x60,md5,undefined,undefined,false)
    await warm;expect((await r).url).toBeTruthy();expect(snsAttachProgressForTest(a,KEY,0x60)?.pending).toBe(0)
    expect(calls.decode).toBe(2) // one index decode plus one selected image decode, not two index drains
  })
})
