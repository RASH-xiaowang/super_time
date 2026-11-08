// @vitest-environment jsdom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { MessageRich, WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import { MessageBody, RichCard } from './chats-cards.tsx'
import { MessageContact, MessageLocation, MessageSystem } from './chats-media.tsx'
import { imageOriginalFailureText } from './chats-support.tsx'

function visibleText(markup: string): string {
  const host = document.createElement('div')
  host.innerHTML = markup
  return host.textContent ?? ''
}

function card(rich: MessageRich): string {
  return renderToStaticMarkup(createElement(RichCard, { rich, fallback: '' }))
}

const SYSTEM_EMOJI = /[\u{1F000}-\u{1FAFF}]/u

describe('WeChat card visible content', () => {
  it('shows only the verified transfer amount and native footer', () => {
    const text = visibleText(card({ type: 'transfer', title: '￥290.00', paysubtype: '3' }))

    expect(text).toContain('¥290.00')
    expect(text).toContain('微信转账')
    for (const internal of ['本机转账记录', '状态值', '状态待核实', '原始状态', '类型值']) {
      expect(text, internal).not.toContain(internal)
    }
  })

  it('keeps the exact transfer contract through the real MessageBody dispatcher', () => {
    const text = visibleText(renderToStaticMarkup(createElement(MessageBody, {
      m: {
        type: 49,
        renderType: 'transfer',
        displayText: '本机转账记录，状态值 3，状态待核实',
        rich: { type: 'transfer', title: '￥290.00', paysubtype: '3' },
      } as WechatMessage,
      selfName: 'wxid_self',
    })))

    expect(text).toBe('¥290.00微信转账')
  })

  it('does not invent an amount when the transfer payload is malformed', () => {
    const text = visibleText(card({ type: 'transfer', title: '收到一笔转账', paysubtype: '1' }))

    expect(text).not.toContain('金额未知')
    expect(text).not.toContain('收到一笔转账')
    expect(text).toContain('微信转账')
  })

  it('normalizes a bare transfer amount to the native currency format', () => {
    const text = visibleText(card({ type: 'transfer', title: '290.00' }))

    expect(text).toContain('¥290.00')
  })

  it('shows the real red-packet greeting without amount or internal payment fields', () => {
    const text = visibleText(card({ type: 'redpacket', title: '微信红包', desc: '中秋快乐', amount: '8.88' }))

    expect(text).toContain('中秋快乐')
    expect(text).toContain('微信红包')
    expect(text).not.toContain('8.88')
    for (const internal of ['本机系统消息', '原始状态', '类型值', '待核实']) {
      expect(text, internal).not.toContain(internal)
    }
  })

  it('does not repeat the generic red-packet label when no greeting exists', () => {
    const text = visibleText(card({ type: 'redpacket', title: '微信红包', desc: '微信红包' }))

    expect(text.match(/微信红包/g)).toHaveLength(1)
  })

  it('renders file type and size once, without a permanent action hint', () => {
    const text = visibleText(card({ type: 'file', title: '合同.pdf', fileSize: '2048', fileExt: 'pdf' }))

    expect(text.match(/PDF/g)).toHaveLength(1)
    expect(text).toContain('2.0 KB')
    expect(text).toContain('微信电脑版')
    expect(text).not.toContain('点击打开')
    expect(text).not.toContain('下载')
  })

  it('uses the declared extension for both the file icon and metadata', () => {
    const markup = card({ type: 'file', title: '合同', fileSize: '2048', fileExt: 'pdf' })
    const text = visibleText(markup)

    expect(markup).toContain('data-kind="pdf"')
    expect(markup).toContain('<svg')
    expect(markup).not.toMatch(SYSTEM_EMOJI)
    expect(text.match(/PDF/g)).toHaveLength(1)
  })

  it('uses local SVG glyphs for resource cards instead of system emoji', () => {
    const cases: MessageRich[] = [
      { type: 'redpacket', desc: '中秋快乐' },
      { type: 'announcement', title: '假期安排' },
      { type: 'note', title: '会议记录' },
      { type: 'card', title: '团购' },
      { type: 'product', title: '耳机' },
      { type: 'music', title: '晴天' },
      { type: 'appmsg', title: '应用消息' },
    ]

    for (const rich of cases) {
      const markup = card(rich)
      expect(markup, rich.type).toContain('<svg')
      expect(markup, rich.type).not.toMatch(SYSTEM_EMOJI)
    }
  })

  it('does not fabricate a file size or extension when the payload has neither', () => {
    const text = visibleText(card({ type: 'file', title: 'README', fileSize: 'not-a-number' }))

    expect(text).toContain('README')
    expect(text).not.toContain('0 B')
    expect(text).not.toContain('NaN')
  })

  it('does not expose location coordinates as message content', () => {
    const markup = renderToStaticMarkup(createElement(MessageLocation, {
      m: {
        type: 48,
        rich: { type: 'location', title: '腾讯大厦', desc: '南山区', lat: 22.54001, lng: 113.93401 },
      } as WechatMessage,
    }))
    const text = visibleText(markup)

    expect(text).toContain('腾讯大厦')
    expect(text).toContain('南山区')
    expect(text).not.toContain('22.54001')
    expect(text).not.toContain('113.93401')
    expect(text).not.toContain('📍')
  })

  it('keeps the real contact alias but never renders the raw username', () => {
    const text = visibleText(renderToStaticMarkup(createElement(MessageContact, {
      m: {
        type: 42,
        rich: { type: 'contact', nickname: '张三', username: 'wxid_private', alias: 'zhangsan' },
      } as WechatMessage,
    })))

    expect(text).toContain('张三')
    expect(text).toContain('zhangsan')
    expect(text).not.toContain('wxid_private')
  })

  it('does not promote a contact wxid into the nickname or alias', () => {
    const text = visibleText(renderToStaticMarkup(createElement(MessageContact, {
      m: {
        type: 42,
        rich: {
          type: 'contact',
          title: 'wxid_private',
          username: 'wxid_private',
          alias: 'wxid_alias_private',
        },
      } as WechatMessage,
    })))

    expect(text).toContain('微信用户')
    expect(text).not.toContain('wxid_private')
    expect(text).not.toContain('wxid_alias_private')
  })

  it('uses the native chat-log footer without a dynamic record count', () => {
    const text = visibleText(card({
      type: 'chatlog',
      title: '项目群聊的聊天记录',
      records: [
        { name: '甲', time: '10:00', text: '一' },
        { name: '乙', time: '10:01', text: '二' },
      ] as MessageRich['records'],
    }))

    expect(text).toContain('聊天记录')
    expect(text).not.toContain('共 2 条')
  })

  it('removes inferred solitaire explanations and internal usernames', () => {
    const text = visibleText(card({
      type: 'solitaire',
      title: '#接龙\n周五跑步',
      declared: 3,
      members: [{ idx: 1, username: 'wxid_private', content: '仅成员名单', ts: 0 }],
    }))

    expect(text).toContain('#接龙')
    expect(text).toContain('周五跑步')
    expect(text).not.toContain('仅成员名单')
    expect(text).not.toContain('1 人')
    expect(text).not.toContain('群接龙')
    expect(text).not.toContain('还有')
    expect(text).not.toContain('未同步')
    expect(text).not.toContain('wxid_private')
  })

  it('does not expose a referrer wxid when the quoted nickname is missing', () => {
    const markup = card({
      type: 'quote',
      title: '收到',
      desc: '原始消息',
      referUsername: 'wxid_private',
    })
    const text = visibleText(markup)

    expect(text).toContain('收到')
    expect(text).toContain('原始消息')
    expect(markup).not.toContain('wxid_private')
  })

  it('never uses a sticker MD5 as visible text or a tooltip', () => {
    const md5 = '0123456789abcdef0123456789abcdef'
    const markup = card({ type: 'sticker', title: md5, md5 })

    expect(visibleText(markup)).not.toContain(md5)
    expect(markup).not.toContain(md5)
  })

  it('does not repeat a card type above its native footer', () => {
    const text = visibleText(card({ type: 'announcement', title: '假期安排', desc: '周五提前下班' }))

    expect(text.match(/群公告/g)).toHaveLength(1)
  })

  it('renders unsupported content as one centered system notice instead of a fake card', () => {
    const markup = card({ type: 'unsupported', title: '版本不支持' })
    const text = visibleText(markup)

    expect(text).toBe('当前微信版本不支持展示该内容，请升级至最新版本。')
    expect(markup).not.toContain('<svg')
    expect(text).not.toContain('暂不支持')
  })

  it('does not repeat the footer when a resource has only its type placeholder', () => {
    const cases: ReadonlyArray<readonly [MessageRich, string]> = [
      [{ type: 'miniapp', title: '[小程序]' }, '小程序'],
      [{ type: 'channels', title: '[视频号]' }, '视频号'],
      [{ type: 'live', title: '[直播]' }, '视频号直播'],
    ]

    for (const [rich, label] of cases) {
      expect(visibleText(card(rich)).match(new RegExp(label, 'g')), rich.type).toHaveLength(1)
    }
  })

  it('does not repeat a product source when desc and source are the same', () => {
    const text = visibleText(card({
      type: 'product',
      title: '耳机',
      desc: '拼多多',
      source: '拼多多',
    }))

    expect(text.match(/拼多多/g)).toHaveLength(1)
  })

  it('does not repeat a quote type word when its icon is already visible', () => {
    const image = visibleText(card({ type: 'quote', title: '收到', desc: '[图片]', referType: 3 }))
    const redpacket = visibleText(card({
      type: 'quote',
      title: '谢谢',
      desc: '[红包] 恭喜发财',
      referType: 49,
      referAppType: 2001,
    }))

    expect(image).not.toContain('[图片]')
    expect(redpacket).not.toContain('[红包]')
    expect(redpacket).toContain('恭喜发财')
  })

  it('keeps image-original diagnostics out of the chat bubble', () => {
    expect(imageOriginalFailureText('HTTP 403: CDN denied')).toBe('原图暂不可用，请稍后重试')
    expect(imageOriginalFailureText('本机只有缩略图')).toBe('请先在微信中查看原图，再回来重试')
  })

  it('deduplicates the type word for every labeled card', () => {
    const cases: ReadonlyArray<readonly [MessageRich, string]> = [
      [{ type: 'announcement', title: '群公告' }, '群公告'],
      [{ type: 'note', title: '笔记' }, '笔记'],
      [{ type: 'card', title: '卡片' }, '卡片'],
      [{ type: 'product', title: '商品' }, '商品'],
    ]

    for (const [rich, label] of cases) {
      const text = visibleText(card(rich))
      expect(text.match(new RegExp(label, 'g')), rich.type).toHaveLength(1)
    }
  })

  it('does not expose a raw URL when the link card already has a source', () => {
    const text = visibleText(card({
      type: 'link',
      title: '文章标题',
      desc: '文章摘要',
      source: 'example.com',
      url: 'https://example.com/private/path?token=secret',
    }))

    expect(text).toContain('example.com')
    expect(text).not.toContain('https://example.com/private/path')
    expect(text).not.toContain('secret')
  })

  it('uses the footer alone when optional card titles are absent', () => {
    const cases: MessageRich[] = [
      { type: 'announcement' },
      { type: 'miniapp' },
      { type: 'music' },
    ]
    const expected = ['群公告', '小程序', '音乐']

    cases.forEach((rich, index) => {
      const text = visibleText(card(rich))
      const label = expected[index] ?? ''
      expect(text.match(new RegExp(label, 'g')), label).toHaveLength(1)
    })
  })

  it('uses plain centered system rows without project-only glyphs', () => {
    const revoke = visibleText(renderToStaticMarkup(createElement(MessageSystem, {
      m: { renderType: 'revoke', displayText: '张三撤回了一条消息' } as WechatMessage,
    })))
    const top = visibleText(renderToStaticMarkup(createElement(MessageSystem, {
      m: { renderType: 'system', sysKind: 'top', displayText: '群公告已置顶' } as WechatMessage,
    })))

    expect(revoke).not.toContain('↩')
    expect(top).not.toContain('📌')
  })

  it('keeps unknown XML fallbacks readable without exposing type numbers or parser state', () => {
    const text = visibleText(renderToStaticMarkup(createElement(MessageBody, {
      m: { type: 99999, displayText: '<msg><future /></msg>' } as WechatMessage,
      selfName: 'wxid_self',
    })))

    expect(text).toContain('暂不支持的消息')
    expect(text).not.toContain('99999')
    expect(text).not.toContain('XML')
  })

  it('keeps internal payloads out of every resource type through the real dispatcher', () => {
    const cases: Array<Omit<WechatMessage, 'localId' | 'isSender' | 'createTime'>> = [
      { type: 49, renderType: 'transfer', displayText: '本机转账记录，状态值 3', rich: { type: 'transfer', title: '￥12.00', paysubtype: '3' } },
      { type: 49, renderType: 'redpacket', displayText: '原始状态：待核实', rich: { type: 'redpacket', desc: '恭喜发财', amount: '8.88' } },
      { type: 49, renderType: 'file', displayText: '<msg><appmsg /></msg>', rich: { type: 'file', title: '合同.pdf', fileSize: '2048', fileExt: 'pdf' } },
      { type: 49, renderType: 'link', displayText: 'https://example.com/?token=secret', rich: { type: 'link', title: '文章', source: 'example.com', url: 'https://example.com/?token=secret' } },
      { type: 49, renderType: 'quote', displayText: 'wxid_private', rich: { type: 'quote', title: '收到', desc: '[链接] 原文', referType: 49, referUsername: 'wxid_private' } },
      { type: 49, renderType: 'miniapp', displayText: '<appmsg>', rich: { type: 'miniapp', title: '小程序页面', source: '示例应用' } },
      { type: 49, renderType: 'channels', displayText: '<finderFeed>', rich: { type: 'channels', title: '视频标题', source: '视频号作者' } },
      { type: 49, renderType: 'live', displayText: '<liveinfo>', rich: { type: 'live', title: '直播标题', source: '视频号作者' } },
      { type: 49, renderType: 'music', displayText: '<appmsg>', rich: { type: 'music', title: '歌名', desc: '歌手' } },
      { type: 49, renderType: 'product', displayText: '<appmsg>', rich: { type: 'product', title: '商品', desc: '来源', source: '来源' } },
      { type: 49, renderType: 'card', displayText: '<appmsg>', rich: { type: 'card', title: '卡片标题' } },
      { type: 49, renderType: 'note', displayText: '<appmsg>', rich: { type: 'note', title: '笔记正文' } },
      { type: 49, renderType: 'sticker', displayText: '0123456789abcdef0123456789abcdef', rich: { type: 'sticker', title: '0123456789abcdef0123456789abcdef', md5: '0123456789abcdef0123456789abcdef' } },
      { type: 49, renderType: 'announcement', displayText: '<appmsg>', rich: { type: 'announcement', title: '群公告正文' } },
      { type: 49, renderType: 'solitaire', displayText: '<appmsg>', rich: { type: 'solitaire', title: '#接龙\n周五跑步', members: [{ idx: 1, username: 'wxid_private', content: '成员', ts: 0 }] } },
      { type: 49, renderType: 'chatlog', displayText: '<recorditem>', rich: { type: 'chatlog', title: '聊天记录', records: [{ name: '甲', sourceUsername: 'wxid_private', time: '10:00', text: '正文' }] } },
      { type: 49, renderType: 'unsupported', displayText: '<appmsg type="50">', rich: { type: 'unsupported', title: '版本不支持' } },
      { type: 99999, renderType: 'unknown', displayText: '<msg><future /></msg>', rich: { type: 'appmsg', title: '正常标题' } },
    ]

    for (const candidate of cases) {
      const m: WechatMessage = { localId: 1, isSender: 0, createTime: 0, ...candidate }
      const markup = renderToStaticMarkup(createElement(MessageBody, { m, selfName: 'wxid_self' }))
      const text = visibleText(markup)
      expect(text, m.renderType).not.toContain('<msg>')
      expect(text, m.renderType).not.toContain('<appmsg')
      expect(text, m.renderType).not.toContain('paysubtype')
      expect(text, m.renderType).not.toContain('wxid_private')
      expect(text, m.renderType).not.toContain('0123456789abcdef0123456789abcdef')
      expect(text, m.renderType).not.toContain('本机转账记录')
      expect(text, m.renderType).not.toContain('原始状态')
    }
  })
})
