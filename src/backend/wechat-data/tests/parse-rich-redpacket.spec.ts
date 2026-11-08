// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseAppmsg } from '../src/query/parse-rich.ts'

function redpacketXml(fields: string, type = '2001'): string {
  return `<msg><appmsg><title>微信红包</title><type>${type}</type>`
    + `<wcpayinfo><feedesc>￥8.88</feedesc>${fields}</wcpayinfo></appmsg></msg>`
}

describe('parseAppmsg red packet greeting', () => {
  it('prefers the real greeting over the generic card title', () => {
    expect(parseAppmsg(redpacketXml(
      '<sendertitle>中秋快乐</sendertitle><receivertitle>中秋快乐</receivertitle>',
    ))).toMatchObject({
      type: 'redpacket',
      desc: '中秋快乐',
      amount: '8.88',
    })
  })

  it('falls back to the receiver-facing greeting when the sender copy is absent', () => {
    expect(parseAppmsg(redpacketXml(
      '<receivertitle>开工大吉</receivertitle>',
    ))?.desc).toBe('开工大吉')
  })

  it('does not invent a greeting when the source has none', () => {
    expect(parseAppmsg(redpacketXml(''))?.desc).toBeUndefined()
  })

  it('does not expose the generic label as a greeting', () => {
    expect(parseAppmsg(redpacketXml('<sendertitle>微信红包</sendertitle>'))?.desc).toBeUndefined()
  })

  it('handles both group and direct red-packet appmsg types', () => {
    for (const type of ['2001', '2003']) {
      expect(parseAppmsg(redpacketXml('<sendertitle>新年快乐</sendertitle>', type))).toMatchObject({
        type: 'redpacket',
        desc: '新年快乐',
      })
    }
  })
})
