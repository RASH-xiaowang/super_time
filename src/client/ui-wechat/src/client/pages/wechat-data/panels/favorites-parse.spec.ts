/**
 * 收藏解析族的行为判据（#22 把它从 `Favorites.tsx` 搬进 `favorites-parse.ts` 之后，
 * 这 165 行「后端字段优先、缺失时客户端兜底解析 XML」第一次有测试）。
 *
 * 为什么值得测：这一族的坏法全是**界面上看不出来出错**的那种 —— 摘要空一行、来源串了个人、
 * 图片取成缩略版还是原图、时间显示成破折号还是空。而且它是"兜底"：后端解析正常时它根本不跑，
 * 于是老版本的真实覆盖只有人手动碰到一条没解析的收藏时才看得见。
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import type { FavorItem } from '@deepseek-ai/dsh-wechat-data/types'
import { favTypeLabel, parseFavItem, parseFavParts, parseFavXml } from './favorites-parse.ts'

/** 一条最小可用的收藏（后端字段全给，逐条用例只覆盖它关心的那一格）。 */
function fav(over: Partial<FavorItem> = {}): FavorItem {
  return {
    localId: 1, type: 1, typeLabel: '', title: '', desc: '', url: '',
    updateTime: 0, time: '', content: '', fromUsr: '', chatName: '', source: '',
    ...over,
  }
}

describe('parseFavItem：后端字段优先', () => {
  it('后端给了 title/desc/source/time 就不去碰 XML', () => {
    const info = parseFavItem(fav({
      title: '后端标题', desc: '后端描述', source: '后端来源', time: '2026-09-01 10:00',
      content: '<fav><title>XML 标题</title><desc>XML 描述</desc></fav>',
    }))
    expect(info.title).toBe('后端标题')
    expect(info.desc).toBe('后端描述')
    expect(info.source).toBe('后端来源')
    expect(info.time).toBe('2026-09-01 10:00')
  })

  it('后端没给 title ⇒ 回退顺序是 XML 标题 → 类型中文名（不是空串，界面不留白）', () => {
    expect(parseFavItem(fav({ type: 5, content: '<fav><title>链接标题</title></fav>' })).title).toBe('链接标题')
    expect(parseFavItem(fav({ type: 5, content: '<fav></fav>' })).title).toBe('链接')
  })

  it('时间为空时由 updateTime 现算，但 updateTime=0 必须还是空串（占位符是空串，不是破折号）', () => {
    expect(parseFavItem(fav({ time: '', updateTime: 1_700_000_000 })).time).toMatch(/^\d{4}-\d{2}-\d{2}/)
    // 这条钉的是「`f.time ||` 与 fmtDateTimeSec(…, '') 的配合」：换成默认占位就会显示成 '—'，
    // 而收藏卡片的落款那一行是按「空 ⇒ 不显示」设计的。
    expect(parseFavItem(fav({ time: '', updateTime: 0 })).time).toBe('')
  })

  it('来源回退：source → chatName → XML datasrcname → XML fromusr → fromUsr 字段', () => {
    const xml = '<fav><datasrcname>群里的名字</datasrcname><fromusr>wxid_from</fromusr></fav>'
    expect(parseFavItem(fav({ content: xml })).source).toBe('群里的名字')
    expect(parseFavItem(fav({ content: '<fav><fromusr>wxid_from</fromusr></fav>' })).source).toBe('wxid_from')
    expect(parseFavItem(fav({ content: '<fav></fav>', fromUsr: 'wxid_field' })).source).toBe('wxid_field')
    expect(parseFavItem(fav({ content: '<fav></fav>', chatName: 'chat 名' })).source).toBe('chat 名')
  })
})

describe('parseFavXml：兜底解析与实体解码', () => {
  it('CDATA 外壳必须剥掉（微信收藏 content 里 title/desc 都是 CDATA 包的）', () => {
    expect(parseFavXml('<fav><title><![CDATA[链接 &amp; 标题]]></title><desc><![CDATA[一段 描述]]></desc></fav>').title).toBe('链接 & 标题')
    expect(parseFavXml('<fav><desc><![CDATA[纯内容]]></desc></fav>').desc).toBe('纯内容')
    expect(parseFavXml('<fav><datasrcname><![CDATA[群名]]></datasrcname></fav>').srcName).toBe('群名')
  })

  it('非 XML 的纯文本 content 直接当描述（不吞字、也不返回空）', () => {
    expect(parseFavXml('就是一段普通文本')).toEqual({ title: '', desc: '就是一段普通文本', fromUsr: '', srcName: '' })
    expect(parseFavXml('')).toMatchObject({ desc: '' })
  })

  it('&amp; 与换行实体会还原（收藏摘要里这两类最常见）', () => {
    const r = parseFavXml('<fav><title>A &amp; B</title><desc>第一行&#10;第二行</desc></fav>')
    expect(r.title).toBe('A & B')
    expect(r.desc).toBe('第一行\n第二行')
    // 标题与来源名也要解（原先只解 desc，卡片上会露出 `A&amp;B` 这种字面量）
    expect(parseFavXml('<fav><datasrcname>群 &amp; 名</datasrcname></fav>').srcName).toBe('群 & 名')
    expect(parseFavParts('<fav><datalist><dataitem datatype="1"><datadesc>x</datadesc><datasrcname>源 &amp; 名</datasrcname></dataitem></datalist></fav>')[0]?.sourceName).toBe('源 & 名')
  })
})

describe('parseFavParts：资源条目', () => {
  /** 拼一条 `<datalist>` 里的 `<dataitem>`。 */
  const item = (attrs: string, body: string): string => `<fav><datalist><dataitem ${attrs}>${body}</dataitem></datalist></fav>`

  it('图片取 md5 的顺序是 thumbfullmd5 → fullmd5 → dataid（决定拿缩略还是原图，不能反）', () => {
    const withBoth = parseFavParts(item('datatype="2" dataid="aaa"', '<fullmd5>bbb</fullmd5><thumbfullmd5>ccc</thumbfullmd5>'))
    expect(withBoth[0]?.md5).toBe('ccc')
    expect(withBoth[0]).toMatchObject({ fullMd5: 'bbb', thumbMd5: 'ccc' })
    expect(parseFavParts(item('datatype="2" dataid="aaa"', '<fullmd5>bbb</fullmd5>'))[0]?.md5).toBe('bbb')
    expect(parseFavParts(item('datatype="2" dataid="AAA"', ''))[0]?.md5).toBe('aaa')
  })

  it('md5 一律小写（后端按 md5 取图，大写会查不到）', () => {
    expect(parseFavParts(item('datatype="2" dataid="AABBCC"', ''))[0]?.md5).toBe('aabbcc')
  })

  it('dataitem 文本字段的 CDATA 外壳也要剥掉（与 parseFavXml 同一条口径）', () => {
    const [part] = parseFavParts(item('datatype="2"', '<fullmd5><![CDATA[AABB]]></fullmd5>'))
    expect(part?.md5).toBe('aabb')
  })

  it('链接优先 stream_weburl，其次 url，并把 &amp; 还原', () => {
    const a = parseFavParts(item('datatype="5"', '<stream_weburl>https://x/a?u=1&amp;v=2</stream_weburl><url>https://ignored</url>'))
    expect(a[0]).toMatchObject({ kind: 'link', url: 'https://x/a?u=1&v=2' })
    expect(parseFavParts(item('datatype="5"', '<url>https://only</url>'))[0]?.url).toBe('https://only')
  })

  it('文件条目给 name/ext/size，fullsize 不是数字就当没有（不显示 0 B）', () => {
    const f = parseFavParts(item('datatype="8"', '<datatitle>报告.pdf</datatitle><datafmt>pdf</datafmt><fullsize>20480</fullsize>'))
    expect(f[0]).toMatchObject({ kind: 'file', name: '报告.pdf', ext: 'pdf', size: 20480 })
    expect(parseFavParts(item('datatype="8"', '<datatitle>x</datatitle><fullsize>abc</fullsize>'))[0]).not.toHaveProperty('size')
  })

  it('视频时长只收正数（0 与负数都会显示成"0 秒"那种假信息）', () => {
    expect(parseFavParts(item('datatype="4"', '<fullmd5>m</fullmd5><duration>12.5</duration>'))[0]?.duration).toBe(12.5)
    expect(parseFavParts(item('datatype="4"', '<fullmd5>m</fullmd5><duration>0</duration>'))[0]).not.toHaveProperty('duration')
    expect(parseFavParts(item('datatype="4"', '<fullmd5>m</fullmd5><duration>-3</duration>'))[0]).not.toHaveProperty('duration')
  })

  it('不认识的 datatype 仍产出可读条目（保留原始类型与标题，不静默丢资源）', () => {
    const [part] = parseFavParts(item('datatype="6"', '<datatitle>位置</datatitle>'))
    expect(part).toMatchObject({ kind: 'unknown', dataType: 6, title: '位置' })
    expect(parseFavParts('<fav>没有 dataitem</fav>')).toEqual([])
  })

  it('未知资源也保留可点击 URL/封面，而不是只把链接塞进不可点的元信息', () => {
    const [part] = parseFavParts(item('datatype="77"', '<datatitle>新资源</datatitle><url>https://example.com/new</url><cdn_thumburl>https://wx.qlogo.cn/cover</cdn_thumburl>'))
    expect(part).toMatchObject({
      kind: 'unknown',
      url: 'https://example.com/new',
      coverUrl: 'https://wx.qlogo.cn/cover',
    })
  })

  it('顶层 locitem 解析成位置，坐标与地址不丢', () => {
    const [part] = parseFavParts('<fav><locitem><poiname>南宁市鑫硕机动车登记服务站</poiname><label>江南区星光大道</label><lat>22.786</lat><lng>108.31</lng><poiCategoryTips>汽车服务</poiCategoryTips><poiBusinessHour>09:00-18:00</poiBusinessHour><poiPhone>0771-1234567</poiPhone></locitem></fav>')
    expect(part).toMatchObject({
      kind: 'location',
      poiName: '南宁市鑫硕机动车登记服务站',
      address: '江南区星光大道',
      lat: 22.786,
      lng: 108.31,
      category: '汽车服务',
      businessHours: '09:00-18:00',
      phone: '0771-1234567',
    })
    expect(part?.url).toContain('uri.amap.com/marker')
  })

  it('小程序从 appbranditem 取 AppID/页面/图标，并保留封面 md5', () => {
    const [part] = parseFavParts('<fav><datalist><dataitem datatype="19" dataid="mini-cover"><datatitle>小程序标题</datatitle><datadesc>小程序描述</datadesc></dataitem></datalist><appbranditem><appid>wx123</appid><username>gh_demo</username><pagepath>pages/index</pagepath><iconurl>https://wx.qlogo.cn/icon</iconurl></appbranditem></fav>')
    expect(part).toMatchObject({
      kind: 'miniapp',
      appId: 'wx123',
      appUsername: 'gh_demo',
      pagePath: 'pages/index',
      iconUrl: 'https://wx.qlogo.cn/icon',
      md5: 'mini-cover',
    })
  })

  it('语音保留 svrId 与毫秒时长，供无会话上下文的收藏直接取音频', () => {
    const [part] = parseFavParts(item('datatype="3"', '<fullmd5>voice-md5</fullmd5><datafmt>silk</datafmt><duration>2686</duration><fromnewmsgid>2538601227098830648</fromnewmsgid>'))
    expect(part).toMatchObject({
      kind: 'voice',
      md5: 'voice-md5',
      format: 'silk',
      durationMs: 2686,
      svrId: '2538601227098830648',
    })
  })

  it('文本条目优先 datadesc、其次 datatitle；两个都空就不产出（避免空行）', () => {
    expect(parseFavParts(item('datatype="1"', '<datadesc>正文</datadesc><datatitle>标题</datatitle>'))[0]?.text).toBe('正文')
    expect(parseFavParts(item('datatype="1"', '<datatitle>只有标题</datatitle>'))[0]?.text).toBe('只有标题')
    expect(parseFavParts(item('datatype="1"', ''))).toEqual([])
  })

  it('多条 dataitem 全部收到，顺序保持', () => {
    const parts = parseFavParts('<fav><datalist>'
      + '<dataitem datatype="1"><datadesc>一</datadesc></dataitem>'
      + '<dataitem datatype="2" dataid="m1"></dataitem>'
      + '<dataitem datatype="5"><url>https://x</url></dataitem>'
      + '</datalist></fav>')
    expect(parts.map((p) => p.kind)).toEqual(['text', 'image', 'link'])
  })

  it('聊天记录的发送者头像 URL 也要从 dataitem 里收到（交给 RemoteImg，不在渲染层直连）', () => {
    const [part] = parseFavParts(item('datatype="1"', '<datadesc>x</datadesc><sourceheadurl>https://wx.qlogo.cn/a/96</sourceheadurl>'))
    expect(part?.sourceHead).toBe('https://wx.qlogo.cn/a/96')
  })
})

describe('favTypeLabel', () => {
  it('微信 fav type 的已知值给中文，未知值给「其他」而不是 undefined', () => {
    expect(favTypeLabel(1)).toBe('文本')
    expect(favTypeLabel(2)).toBe('图片')
    expect(favTypeLabel(18)).toBe('笔记')
    expect(favTypeLabel(9999)).toBe('其他')
  })
})
