import { describe, expect, it, vi } from 'vitest'
import { createCipheriv } from 'node:crypto'
import { decodeDatPayload } from '../src/query/media-image.ts'
import { decodeDatBytesAsync } from '../src/query/media-image-async.ts'
const key = '0123456789abcdef', xor = 0x60
const png = (n: number): Buffer => { const b = Buffer.alloc(n); b.set([137,80,78,71,13,10,26,10]); for(let i=8;i<n;i++) b[i]=(i*37+11)&255; return b }
function dat(plain: Buffer, aesSize: number, rawSize: number, v1 = false): Uint8Array {
 const aesKey=v1?'cfcd208495d565ef':key, cipher=createCipheriv('aes-128-ecb',aesKey,null)
 const encrypted=Buffer.concat([cipher.update(plain.subarray(0,aesSize)),cipher.final()]), header=Buffer.alloc(15)
 header.set([7,8,86,v1?49:50,8,7]);header.writeUInt32LE(aesSize,6);header.writeUInt32LE(plain.length-aesSize-rawSize,10)
 const bytes=Buffer.concat([header,encrypted,plain.subarray(aesSize,aesSize+rawSize),plain.subarray(aesSize+rawSize).map(x=>x^xor)])
 const padded=Buffer.concat([Buffer.alloc(17,255),bytes,Buffer.alloc(29,254)])
 return new Uint8Array(padded.buffer,padded.byteOffset+17,bytes.length)
}
describe('SNS opt-in owned crypto output and readonly views',()=>{
 for(const v1 of [false,true])for(const [aesSize,rawSize]of [[4096,0],[4093,0],[2048,1024],[16,0],[0,1024]] as const){
 it(`byte-equivalent V${v1?1:2} AES=${aesSize} raw=${rawSize}`,()=>{
 const plain=png(4096),data=dat(plain,aesSize,rawSize,v1),original=Buffer.from(data)
 const normal=decodeDatPayload(data,key,xor),sns=decodeDatPayload(data,key,xor,{snsMemory:true})
 expect(sns).toEqual(normal);expect('bytes'in sns&&Buffer.from(sns.bytes)).toEqual(plain);expect(Buffer.from(data)).toEqual(original)
 data.fill(0);expect('bytes'in sns&&Buffer.from(sns.bytes)).toEqual(plain)
 })}
 it('SNS whole-AES path performs no full ciphertext/plaintext Uint8Array.slice copies',()=>{
 const plain=png(1024*1024),data=dat(plain,plain.length,0),spy=vi.spyOn(Uint8Array.prototype,'slice')
 try{const result=decodeDatPayload(data,key,xor,{snsMemory:true});expect('bytes'in result&&result.bytes.length).toBe(plain.length)
 expect(spy.mock.calls.filter(([a,b])=>Math.abs((b??data.length)-(a??0))>1024)).toHaveLength(0)
 }finally{spy.mockRestore()}
 })
 it('default path still owns its outputs and keeps legacy copy policy',()=>{
 const plain=png(4096),data=dat(plain,4096,0),spy=vi.spyOn(Uint8Array.prototype,'slice')
 try{const result=decodeDatPayload(data,key,xor);expect('bytes'in result&&Buffer.from(result.bytes)).toEqual(plain);expect(spy.mock.calls.some(([a,b])=>Math.abs((b??data.length)-(a??0))>1024)).toBe(true)}finally{spy.mockRestore()}
 })
 it('XOR and malformed/error paths stay equivalent',()=>{
 const plain=png(512),inputs=[plain.map(b=>b^0x35),Buffer.alloc(2),Buffer.alloc(20),dat(plain,512,0).subarray(0,20)]
 for(const data of inputs)expect(decodeDatPayload(data,key,xor,{snsMemory:true})).toEqual(decodeDatPayload(data,key,xor))
 })
 it('actual async wrapper forwards opt-in and preserves wxgf conversion',async()=>{
 const plain=png(1024);plain.set(Buffer.from('wxgf'));const data=dat(plain,1024,0),converted=png(64),wxgf=vi.fn(async (_bytes: Uint8Array)=>({bytes:new Uint8Array(converted),jpegWidth:1,jpegHeight:1,ms:0}))
 const result=await decodeDatBytesAsync(data,key,xor,{snsMemory:true,wxgf});expect(result).toEqual({bytes:new Uint8Array(converted),format:'png'});expect(wxgf).toHaveBeenCalledOnce();expect(Buffer.from(wxgf.mock.calls[0]?.[0]??[])).toEqual(plain)
 })
})
