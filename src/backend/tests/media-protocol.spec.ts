/**
 * `wechat-media://` 协议的路径解析/白名单校验（纯函数 + 一个真实文件夹具）。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MIME_BY_EXT, mediaResponse, parseDecodedUrl, parseThumbWidth, resolveDecodedFile } from '../media-protocol.js'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-media-protocol-'))
  scratch.push(dir)
  return dir
}

describe('parseDecodedUrl：只认 decoded host 的图片相对路径', () => {
  it('正常路径解码并规范化前导斜杠', () => {
    expect(parseDecodedUrl('wechat-media://decoded/wxid_abc/ab12.jpg')).toBe('wxid_abc/ab12.jpg')
    expect(parseDecodedUrl('wechat-media://decoded//a.png')).toBe('a.png')
    // 百分号编码空格 / 中文（路径段整体解码）
    expect(parseDecodedUrl('wechat-media://decoded/a%20b/%E5%9B%BE.jpg')).toBe('a b/图.jpg')
  })

  it('拒绝其它 scheme / host / 空路径', () => {
    expect(parseDecodedUrl('file:///C:/secret.jpg')).toBeNull()
    expect(parseDecodedUrl('https://decoded/a.jpg')).toBeNull()
    expect(parseDecodedUrl('wechat-media://other/a.jpg')).toBeNull()
    expect(parseDecodedUrl('wechat-media://decoded/')).toBeNull()
  })

  it('拒绝穿越、反斜杠、空段、NUL 与坏编码', () => {
    // 标准 scheme 的 URL 解析器会先把 `..` 归一化掉，落地路径仍被根目录沙箱限制（不是逃逸）；
    // 编码后的 `%2e%2e` 不会被 URL 归一化，必须由我们拒绝。
    expect(parseDecodedUrl('wechat-media://decoded/../secret.jpg')).toBe('secret.jpg')
    expect(parseDecodedUrl('wechat-media://decoded/a/../../secret.jpg')).toBe('secret.jpg')
    expect(parseDecodedUrl('wechat-media://decoded/%2e%2e/secret.jpg')).toBe('secret.jpg')
    expect(parseDecodedUrl('wechat-media://decoded/a//b.jpg')).toBeNull()
    expect(parseDecodedUrl('wechat-media://decoded/a%5Cb.jpg')).toBeNull()
    expect(parseDecodedUrl('wechat-media://decoded/%00.jpg')).toBeNull()
    expect(parseDecodedUrl('wechat-media://decoded/%E0%A4%A')).toBeNull()
    expect(parseDecodedUrl('not a url')).toBeNull()
  })
})

describe('resolveDecodedFile：根目录沙箱 + 图片扩展名白名单', () => {
  it('命中的文件返回绝对路径；越界/非图片/不存在都拒绝', () => {
    const root = tempRoot()
    const sub = join(root, 'wxid_abc')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'ab12.jpg'), 'jpg-bytes')
    writeFileSync(join(root, 'note.txt'), 'text')
    writeFileSync(join(root, 'outside.txt'), 'text')

    expect(resolveDecodedFile(root, 'wxid_abc/ab12.jpg')).toBe(join(sub, 'ab12.jpg'))
    expect(resolveDecodedFile(root, 'note.txt'), '非图片扩展名一律拒绝').toBeNull()
    expect(resolveDecodedFile(root, '../outside.txt'), '穿越拒绝').toBeNull()
    expect(resolveDecodedFile(root, 'wxid_abc/missing.jpg')).toBeNull()
    expect(resolveDecodedFile('', 'wxid_abc/ab12.jpg'), '根为空（后端还没 init）拒绝').toBeNull()
  })
})

describe('mediaResponse：流式返回图片，404 不泄露路径', () => {
  it('200 + Content-Type，body 是原文件字节', async () => {
    const root = tempRoot()
    writeFileSync(join(root, 'a.png'), 'png-bytes')
    const res = mediaResponse(root, 'wechat-media://decoded/a.png')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe(MIME_BY_EXT['.png'])
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('png-bytes')
  })

  it('非法 URL / 越界 / 根未就绪都是 404，且不回显请求路径', async () => {
    const root = tempRoot()
    const bad = mediaResponse(root, 'wechat-media://decoded/../../etc/passwd')
    expect(bad.status).toBe(404)
    expect(await bad.text()).toBe('not found')
    const noRoot = mediaResponse('', 'wechat-media://decoded/a.png')
    expect(noRoot.status).toBe(404)
    const missing = mediaResponse(root, 'wechat-media://decoded/missing.jpg')
    expect(missing.status).toBe(404)
  })
})

describe('parseThumbWidth：thumb 档宽度（Alpha 的 thumb/full 两档）', () => {
  it('只接受 64–1024 的整数；缺失/非法/越界一律 null（回原图）', () => {
    expect(parseThumbWidth('wechat-media://decoded/a.jpg?w=320')).toBe(320)
    expect(parseThumbWidth('wechat-media://decoded/a.jpg?w=64')).toBe(64)
    expect(parseThumbWidth('wechat-media://decoded/a.jpg?w=1024')).toBe(1024)
    expect(parseThumbWidth('wechat-media://decoded/a.jpg')).toBeNull()
    expect(parseThumbWidth('wechat-media://decoded/a.jpg?w=63')).toBeNull()
    expect(parseThumbWidth('wechat-media://decoded/a.jpg?w=1025')).toBeNull()
    expect(parseThumbWidth('wechat-media://decoded/a.jpg?w=abc')).toBeNull()
    expect(parseThumbWidth('wechat-media://decoded/a.jpg?w=-320')).toBeNull()
  })

  it('node 环境没有 nativeImage ⇒ 回退原图仍 200（不炸、不 404）', async () => {
    const root = tempRoot()
    writeFileSync(join(root, 'a.png'), 'png-bytes')
    const res = mediaResponse(root, 'wechat-media://decoded/a.png?w=320')
    expect(res.status).toBe(200)
    // 单测里 require('electron') 不可用：走原图 fallback（content-type 保持 png）
    expect(res.headers.get('Content-Type')).toBe(MIME_BY_EXT['.png'])
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('png-bytes')
  })
})
