// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readableProfileSignature } from '../src/query/profile-signature.ts'

describe('readableProfileSignature', () => {
  it('never returns the enterprise custom_info envelope as a signature', () => {
    const raw = JSON.stringify({
      custom_info: [
        {
          title: '来自',
          detail: [{ desc: '企业微信', icon: 'https://wwcdn.weixin.qq.com/icon.png' }],
        },
        {
          title: '企业',
          detail: [{ desc: '70A3D9653CDCA60AFE1ABE600E8F52FR01@im.wxwork' }],
        },
      ],
      title: '王国宁',
      detail: [{ desc: 'https://work.weixin.qq.com/profile' }],
    })

    expect(readableProfileSignature('\u0000\u0008' + raw + '\u0000tail')).toBe('')
  })

  it('extracts a signature that is explicitly labelled in structured data', () => {
    const raw = JSON.stringify({
      custom_info: [
        {
          title: '个性签名',
          detail: [{ desc: '把复杂的事情做简单。' }],
        },
      ],
      title: '王国宁',
    })

    expect(readableProfileSignature(raw)).toBe('把复杂的事情做简单。')
  })

  it('accepts an explicit signature key in the profile envelope', () => {
    expect(readableProfileSignature('\u0008\u0001\u0012{"signature":"在路上，也在做事。","title":"客户"}\u0000'))
      .toBe('在路上，也在做事。')
  })

  it('keeps ordinary signatures and strips control characters', () => {
    expect(readableProfileSignature('\u0000  保持热爱，\n认真生活。  '))
      .toBe('保持热爱，认真生活。')
  })

  it('drops malformed or technical profile payloads instead of leaking them', () => {
    expect(readableProfileSignature('{"custom_info":[')).toBe('')
    expect(readableProfileSignature('https://work.weixin.qq.com/profile')).toBe('')
    expect(readableProfileSignature('70A3D9653CDCA60AFE1ABE600E8F52FR01@im.wxwork')).toBe('')
  })
})
