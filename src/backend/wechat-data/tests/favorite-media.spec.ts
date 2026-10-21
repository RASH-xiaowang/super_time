/**
 * @vitest-environment node
 */
import { createCipheriv, createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearFavoriteMediaIndex, resolveFavoriteMediaDataUrl } from '../src/query/favorite-media.ts'

const AES_KEY = '0123456789abcdef'
const XOR_KEY = 0x3c
const scratch: string[] = []

afterEach(() => {
  clearFavoriteMediaIndex()
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function mkRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `wx-favorite-${tag}-`))
  scratch.push(root)
  return root
}

function md5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex')
}

function encryptedV2(plain: Uint8Array): Buffer {
  const aesSize = Math.min(32, plain.length)
  const aesPlain = Buffer.from(plain.subarray(0, aesSize))
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(AES_KEY, 'ascii'), null)
  cipher.setAutoPadding(true)
  const aesCipher = Buffer.concat([cipher.update(aesPlain), cipher.final()])
  const xorPart = Buffer.from(plain.subarray(aesSize)).map((b) => b ^ XOR_KEY)
  const header = Buffer.alloc(15)
  Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]).copy(header, 0)
  header.writeUInt32LE(aesSize, 6)
  header.writeUInt32LE(xorPart.length, 10)
  return Buffer.concat([header, aesCipher, Buffer.from(plain.subarray(aesSize)), xorPart])
}

function putFavorite(root: string, bucket: string, name: string, body: Uint8Array, encrypted: boolean): string {
  const dir = join(root, 'business', 'favorite', bucket, name.slice(0, 2))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, encrypted ? encryptedV2(body) : body)
  return path
}

function payloadOf(result: { url?: string; error?: string }): Buffer {
  const url = result.url ?? ''
  const at = url.indexOf(';base64,')
  expect(at, result.error ?? '缺少 data URL').toBeGreaterThan(0)
  return Buffer.from(url.slice(at + 8), 'base64')
}

describe('resolveFavoriteMediaDataUrl：收藏缓存按明文 MD5 匹配', () => {
  it('不透明文件名的 V2 加密图片能按 fullMd5 解出，且返回 image MIME', () => {
    const root = mkRoot('image')
    const body = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex')
    const digest = md5(body)
    putFavorite(root, 'data', 'dda8b02a53cc8eeff4c308f80e95ed47', body, true)

    const result = resolveFavoriteMediaDataUrl(root, { fullMd5: digest, kind: 'image' }, AES_KEY, XOR_KEY)

    expect(result.url, result.error).toMatch(/^data:image\/jpeg;base64,/)
    expect(payloadOf(result).equals(body), '解出的字节必须与 XML 里的 fullMd5 对应').toBe(true)
  })

  it('完整图未命中时按 thumbMd5 回退，并识别 PNG', () => {
    const root = mkRoot('thumb')
    const thumb = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000049454e44ae426082', 'hex')
    const thumbMd5 = md5(thumb)
    putFavorite(root, 'thumb', '3839e7c88fc60e74a08c2f8afe1c5086', thumb, false)

    const result = resolveFavoriteMediaDataUrl(
      root,
      { fullMd5: 'a'.repeat(32), thumbMd5, kind: 'image' },
      AES_KEY,
      XOR_KEY,
    )

    expect(result.url, result.error).toMatch(/^data:image\/png;base64,/)
    expect(payloadOf(result).equals(thumb)).toBe(true)
  })

  it('视频、文件和未知资源都能命中同一套索引', () => {
    const root = mkRoot('mixed')
    const video = Buffer.from('00000018667479706d703432000000006d7034316d703432', 'hex')
    const file = Buffer.from('%PDF-1.7\nfavorite attachment\n')
    const unknown = Buffer.from('opaque-resource-body')
    putFavorite(root, 'data', '11111111111111111111111111111111', video, true)
    putFavorite(root, 'data', '22222222222222222222222222222222', file, false)
    putFavorite(root, 'mid', '33333333333333333333333333333333', unknown, false)

    const videoResult = resolveFavoriteMediaDataUrl(root, { fullMd5: md5(video), kind: 'video' }, AES_KEY, XOR_KEY)
    const fileResult = resolveFavoriteMediaDataUrl(root, { fullMd5: md5(file), kind: 'file', ext: 'pdf' }, AES_KEY, XOR_KEY)
    const unknownResult = resolveFavoriteMediaDataUrl(root, { md5: md5(unknown), kind: 'unknown' }, AES_KEY, XOR_KEY)

    expect(videoResult.url, videoResult.error).toMatch(/^data:video\/mp4;base64,/)
    expect(fileResult.url, fileResult.error).toMatch(/^data:application\/pdf;base64,/)
    expect(unknownResult.url, unknownResult.error).toMatch(/^data:application\/octet-stream;base64,/)
    expect(payloadOf(fileResult).equals(file)).toBe(true)
  })

  it('temp 下的同名文件即使没有内容 MD5 也能按文件名与体积命中', () => {
    const root = mkRoot('name-size')
    const file = Buffer.from('%PDF-1.7\nlocal favorite temp file\n')
    putFavorite(root, 'temp', '三角恒等变换.pdf', file, false)

    const result = resolveFavoriteMediaDataUrl(
      root,
      { fileName: '三角恒等变换.pdf', size: file.length, kind: 'file', ext: 'pdf' },
      AES_KEY,
      XOR_KEY,
    )

    expect(result.url, result.error).toMatch(/^data:application\/pdf;base64,/)
    expect(payloadOf(result).equals(file)).toBe(true)
  })

  it('XML 里残留错误 MD5 时，仍按文件名与体积回退到 temp 原件', () => {
    const root = mkRoot('stale-md5')
    const file = Buffer.from('%PDF-1.7\nstale md5 fallback\n')
    putFavorite(root, 'temp', '历史作业.pdf', file, false)

    const result = resolveFavoriteMediaDataUrl(
      root,
      {
        fullMd5: 'f'.repeat(32),
        fileName: '历史作业.pdf',
        size: file.length,
        kind: 'file',
        ext: 'pdf',
      },
      AES_KEY,
      XOR_KEY,
    )

    expect(result.url, result.error).toMatch(/^data:application\/pdf;base64,/)
    expect(payloadOf(result).equals(file)).toBe(true)
  })

  it('视频请求命中图片封面时拒绝返回，避免把 JPG 塞进 video', () => {
    const root = mkRoot('wrong-kind')
    const cover = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex')
    putFavorite(root, 'data', 'wrong-kind.jpg', cover, false)

    const result = resolveFavoriteMediaDataUrl(
      root,
      { fullMd5: md5(cover), kind: 'video' },
      AES_KEY,
      XOR_KEY,
    )

    expect(result.url).toBeUndefined()
    expect(result.error).toBeTruthy()
  })
})
