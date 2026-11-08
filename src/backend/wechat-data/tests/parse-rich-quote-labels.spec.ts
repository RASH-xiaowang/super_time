// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { summarizeQuotedXml } from '../src/query/parse-rich.ts'

function appmsg(type: number, body: string): string {
  return `<msg><appmsg><title>引用标题</title><type>${String(type)}</type>${body}</appmsg></msg>`
}

describe('quoted appmsg labels', () => {
  it('maps ordinary type-4 shares to links', () => {
    expect(summarizeQuotedXml(appmsg(4, '<url>https://example.com/a</url>'))).toBe('[链接] 引用标题')
  })

  it('keeps a real finder feed as channels content', () => {
    expect(summarizeQuotedXml(appmsg(4, '<finderFeed><desc>视频内容</desc></finderFeed>'))).toBe('[视频号] 引用标题')
  })

  it('maps type-36 H5 cards to cards instead of mini programs', () => {
    expect(summarizeQuotedXml(appmsg(36, '<url>https://example.com/card</url>'))).toBe('[卡片] 引用标题')
  })
})
