/**
 * 出网主机白名单：**表情远端取图**与**朋友圈视频导出**这两条新补的闸门。
 *
 * 为什么单独一份：这两条链此前是「只判协议、不判主机」，也就是「消息 XML 里的地址写哪儿
 * 就去哪儿取」—— 而 XML 是可被离线改写的文件（`query/cdn-hosts.ts` 的注释里写着这条理由）。
 * 2026-09-30 补上同一把尺子后，判据要同时钉三件事：
 *   ① 站外主机 ⇒ **一次请求都不发**，且错误文案里带得出**是哪个主机**（否则没法排查
 *      「是清单少了一条」还是「这条地址真有问题」）；
 *   ② 白名单内的正常主机**没有被误伤**（真的取回来、解析出图片/视频）；
 *   ③ 闸门判在**本机缓存之后** —— 本机已有的照常导出，不受主机限制。
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchEmoticonRemote } from '../src/query/media-image.ts'
import { loadSnsVideoBytes } from '../src/query/sns-video.ts'

const scratch: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52])
/** 明文 MP4（`ftyp` 从第 4 字节起），代表 CDN 直接给了明文的那一份。 */
const MP4 = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(24, 0x11)])

/** 打桩全局 fetch 并计数；只回 200 + 给定字节。 */
function scriptedFetch(payload: Buffer): { calls: string[] } {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(String(url))
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
      text: async () => payload.toString('utf8'),
      body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(payload)); c.close() } }),
    }
  })
  return { calls }
}

describe('表情远端取图：主机白名单（2026-09-30 补）', () => {
  it('站外主机 ⇒ 一次请求都不发，且文案里写出是哪个主机', async () => {
    const { calls } = scriptedFetch(PNG)
    const r = await fetchEmoticonRemote('https://evil.example/sticker.gif', tmp('gate-emo-'), 'a'.repeat(32))
    expect(calls, '主机不在清单内却发了请求').toEqual([])
    expect(r.url).toBeUndefined()
    expect(r.error, '文案没带主机名 ⇒ 排查时分不清是清单少了一条还是地址有问题').toContain('evil.example')
    expect(r.error).toContain('不在微信 CDN 清单内')
  })

  it('腾讯系主机照常取回并落盘（白名单没有误伤正常路径）', async () => {
    const dir = tmp('gate-emo-ok-')
    const { calls } = scriptedFetch(PNG)
    const r = await fetchEmoticonRemote('https://mmbiz.qpic.cn/mmemoticon/ok.gif', dir, 'b'.repeat(32))
    expect(calls.length).toBe(1)
    expect(r.url?.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('非 http(s) 的地址仍在白名单之前被挡住（`file://x/qpic.cn/…` 这种形状不许进白名单）', async () => {
    const { calls } = scriptedFetch(PNG)
    const r = await fetchEmoticonRemote('ftp://mmbiz.qpic.cn/x.gif', tmp('gate-emo-ftp-'), 'c'.repeat(32))
    expect(calls).toEqual([])
    expect(r.error).toContain('http(s)')
  })
})

describe('朋友圈视频导出：主机白名单（2026-09-30 补）', () => {
  // 取回后会拿 XML 里的 md5 校验字节，所以这里用 MP4 的真实 md5（否则失败原因是「字节不符」，
  // 会把「白名单放行了」这件事测成红的）。
  const MD5 = createHash('md5').update(MP4).digest('hex')

  it('站外主机且本机没有缓存 ⇒ 一次请求都不发', async () => {
    const { calls } = scriptedFetch(MP4)
    const r = await loadSnsVideoBytes({ base: tmp('gate-vid-'), md5: MD5, url: 'https://evil.example/v.mp4' })
    expect(calls, '导出路径没判白名单：消息里写哪个主机就去取哪个').toEqual([])
    expect(r.bytes).toBeUndefined()
    expect(r.error).toContain('不在微信 CDN 清单内')
  })

  it('闸门判在**本机缓存之后**：本机已有的照常导出，不受主机限制', async () => {
    const base = tmp('gate-vid-local-')
    mkdirSync(join(base, 'msg', 'video'), { recursive: true })
    writeFileSync(join(base, 'msg', 'video', MD5 + '.mp4'), MP4)
    const { calls } = scriptedFetch(MP4)
    const r = await loadSnsVideoBytes({ base, md5: MD5, url: 'https://evil.example/v.mp4' })
    expect(calls, '本机有缓存却去联网了').toEqual([])
    expect(r.source).toBe('local')
    expect(Buffer.compare(r.bytes ?? Buffer.alloc(0), MP4)).toBe(0)
  })

  it('白名单内的主机照常取回（导出路径没有被一刀切）', async () => {
    const { calls } = scriptedFetch(MP4)
    const r = await loadSnsVideoBytes({ base: tmp('gate-vid-ok-'), md5: MD5, url: 'https://mmbiz.qpic.cn/snsvideo/ok.mp4' })
    expect(calls.length).toBe(1)
    expect(r.source).toBe('remote')
    expect(r.bytes?.length).toBe(MP4.length)
  })
})
