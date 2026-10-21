/**
 * 文件面板取图队列（2026-10-21，借鉴 Alpha 的批量 token）。
 *
 * 判据：一屏 N 格只发 ceil(N/24) 次 RPC、key 小写去重、非法 key 丢弃、
 * 每条命中转成带 `?w=320` 的协议 URL、单批失败不拖垮其它批。
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const batch = vi.fn()
const single = vi.fn()

vi.mock('../api.ts', () => ({
  apiGetFileImageDataUrls: (opts: unknown) => batch(opts),
  apiGetFileImageDataUrl: (opts: unknown) => single(opts),
}))

import { fetchFileFullUrl, fetchFileThumbUrls, FILE_THUMB_BATCH, FILE_THUMB_WIDTH } from './files-thumbs.ts'

const K1 = '0123456789abcdef0123456789abcdef'
const K2 = 'fedcba9876543210fedcba9876543210'

beforeEach(() => {
  batch.mockReset()
  single.mockReset()
})

describe('fetchFileThumbUrls：一屏一次批量 + thumb 协议 URL', () => {
  it('去重/小写/丢弃非法 key，结果按 key 回贴并带 ?w=320', async () => {
    batch.mockResolvedValueOnce({
      items: [
        { key: K1, file: K1 + '.t.jpg', thumb: true },
        { key: K2, error: '未找到附件原图' },
      ],
    })
    const out = await fetchFileThumbUrls([K1, K1.toUpperCase(), '不是md5', K2, ''])
    expect(batch).toHaveBeenCalledTimes(1)
    expect(batch.mock.calls[0]![0]).toEqual({ keys: [K1, K2], thumbFirst: true })
    expect(out[K1]).toBe('wechat-media://decoded/' + K1 + '.t.jpg?w=' + String(FILE_THUMB_WIDTH))
    expect(out[K2]).toBeUndefined()
  })

  it('超过单批上限时按 24 分块串行（不一次压 30+ 张给 worker）', async () => {
    const keys = Array.from({ length: FILE_THUMB_BATCH + 5 }, (_, i) => i.toString(16).padStart(32, '0'))
    batch.mockResolvedValue({ items: [] })
    await fetchFileThumbUrls(keys)
    expect(batch).toHaveBeenCalledTimes(2)
    expect((batch.mock.calls[0]![0] as { keys: string[] }).keys.length).toBe(FILE_THUMB_BATCH)
    expect((batch.mock.calls[1]![0] as { keys: string[] }).keys.length).toBe(5)
  })

  it('单批失败不影响后续批（原图/解密失败只留图标兜底）', async () => {
    const keys = Array.from({ length: FILE_THUMB_BATCH + 1 }, (_, i) => i.toString(16).padStart(32, '0'))
    batch.mockRejectedValueOnce(new Error('worker busy')).mockResolvedValueOnce({ items: [{ key: keys[FILE_THUMB_BATCH], file: 'x.jpg' }] })
    const out = await fetchFileThumbUrls(keys)
    expect(batch).toHaveBeenCalledTimes(2)
    expect(Object.keys(out)).toEqual([keys[FILE_THUMB_BATCH] as string])
  })

  it('data URL（手机/浏览器端回退）不追加 w 参数', async () => {
    batch.mockResolvedValueOnce({ items: [{ key: K1, url: 'data:image/jpeg;base64,xx' }] })
    const out = await fetchFileThumbUrls([K1])
    expect(out[K1]).toBe('data:image/jpeg;base64,xx')
  })
})

describe('fetchFileFullUrl：灯箱原图档', () => {
  it('合法 key ⇒ 调单张 API（不带 thumbFirst）并返回协议 URL（无 w 参数）', async () => {
    single.mockResolvedValueOnce({ file: K1 + '.jpg' })
    const url = await fetchFileFullUrl(K1)
    expect(single).toHaveBeenCalledWith({ md5: K1 })
    expect(url).toBe('wechat-media://decoded/' + K1 + '.jpg')
  })

  it('非法 key ⇒ 空串且不发 RPC；失败也不抛', async () => {
    expect(await fetchFileFullUrl('xx')).toBe('')
    expect(single).not.toHaveBeenCalled()
    single.mockRejectedValueOnce(new Error('boom'))
    expect(await fetchFileFullUrl(K2)).toBe('')
  })
})
