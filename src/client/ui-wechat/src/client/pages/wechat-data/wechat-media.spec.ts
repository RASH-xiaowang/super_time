/**
 * `wechat-media.ts` 的 URL 构造与回退语义（纯函数）。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { preferMediaUrl, WECHAT_MEDIA_SCHEME, wechatMediaHttpUrl, wechatMediaUrl, withThumbWidth } from './wechat-media.ts'

describe('wechatMediaUrl：相对路径 → 自定义协议 URL', () => {
  it('逐段编码，保留子目录；反斜杠统一成正斜杠', () => {
    expect(WECHAT_MEDIA_SCHEME).toBe('wechat-media')
    expect(wechatMediaUrl('ab12.jpg')).toBe('wechat-media://decoded/ab12.jpg')
    expect(wechatMediaUrl('wxid_a/ab12.jpg')).toBe('wechat-media://decoded/wxid_a/ab12.jpg')
    expect(wechatMediaUrl('wxid_a\\ab12.jpg')).toBe('wechat-media://decoded/wxid_a/ab12.jpg')
    expect(wechatMediaUrl('a b/图.jpg')).toBe('wechat-media://decoded/a%20b/%E5%9B%BE.jpg')
    // 浏览器（交接态）没有自定义协议：同一份编码换成同源 HTTP 出口。
    expect(wechatMediaHttpUrl('ab12.jpg')).toBe('/api/media/decoded/ab12.jpg')
    expect(wechatMediaHttpUrl('wxid_a/图.jpg')).toBe('/api/media/decoded/wxid_a/%E5%9B%BE.jpg')
    expect(wechatMediaHttpUrl('')).toBe('')
  })

  it('空值/越界段得到空串（调用方回退到 data URL），不会构造出根外路径', () => {
    expect(wechatMediaUrl('')).toBe('')
    expect(wechatMediaUrl('/')).toBe('')
    expect(wechatMediaUrl('..')).toBe('')
    expect(wechatMediaUrl('../secret.jpg')).toBe('wechat-media://decoded/secret.jpg')
    expect(wechatMediaUrl('./a.jpg')).toBe('wechat-media://decoded/a.jpg')
  })
})

describe('preferMediaUrl：有 file 用协议，没有就原样返回', () => {
  it('file 存在时覆盖 url（保留其它字段）', () => {
    const row = { file: 'wxid_a/ab12.jpg', url: 'data:image/jpeg;base64,xxx', thumb: true }
    expect(preferMediaUrl(row)).toEqual({
      file: 'wxid_a/ab12.jpg',
      url: 'wechat-media://decoded/wxid_a/ab12.jpg',
      thumb: true,
    })
    // 浏览器（http/https 页面）改走同源 HTTP 出口。
    expect(preferMediaUrl(row, true)).toEqual({
      file: 'wxid_a/ab12.jpg',
      url: '/api/media/decoded/wxid_a/ab12.jpg',
      thumb: true,
    })
    expect(row.url, '不修改入参').toBe('data:image/jpeg;base64,xxx')
  })

  it('无 file / 空 file / 远端 data URL 保持原样', () => {
    const data = { url: 'data:image/jpeg;base64,xxx' }
    expect(preferMediaUrl(data)).toBe(data)
    expect(preferMediaUrl({ file: '', url: 'data:image/jpeg;base64,xxx' })).toEqual({ file: '', url: 'data:image/jpeg;base64,xxx' })
    expect(preferMediaUrl({ file: '..', url: 'data:image/jpeg;base64,xxx' })).toEqual({ file: '..', url: 'data:image/jpeg;base64,xxx' })
  })
})

describe('withThumbWidth：thumb/full 两档（借鉴 Alpha）', () => {
  it('协议/HTTP URL 追加 w 参数；已有查询串用 &', () => {
    expect(withThumbWidth('wechat-media://decoded/a.jpg', 320)).toBe('wechat-media://decoded/a.jpg?w=320')
    expect(withThumbWidth('/api/media/decoded/a.jpg', 320)).toBe('/api/media/decoded/a.jpg?w=320')
    expect(withThumbWidth('wechat-media://decoded/a.jpg?x=1', 320)).toBe('wechat-media://decoded/a.jpg?x=1&w=320')
  })

  it('data URL / 空串 / 非正宽度原样返回（手机端没有缩略协议层）', () => {
    const data = 'data:image/jpeg;base64,xxx'
    expect(withThumbWidth(data, 320)).toBe(data)
    expect(withThumbWidth('', 320)).toBe('')
    expect(withThumbWidth('wechat-media://decoded/a.jpg', 0)).toBe('wechat-media://decoded/a.jpg')
    expect(withThumbWidth('wechat-media://decoded/a.jpg', Number.NaN)).toBe('wechat-media://decoded/a.jpg')
  })
})
