/**
 * L11：`parse.ts` 里动态构造的正则改为预编译（cachedRe）之后的行为等价性 + 源码守卫。
 *
 * 改动的模式**逐字不变**（`'<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>'` 这类），
 * 只是把「每次调用构造一次」变成「按构造式缓存一次」。所以这里锁两件事：
 *  ① 输出不变（含**重复调用**的输出不变 —— 缓存的是带 `g` 的实例，lastIndex 一旦被挪走
 *     就会出现「第二次调用少扫到东西」这种最难查的回归）；
 *  ② 源码里不得再出现绕过缓存的即时构造（性能改动行为等价 ⇒ 退回旧实现用例会全绿，
 *     必须靠形状守卫抓住，这是 M13/N19 反复栽过的那个坑）。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseMessageContent, parseSystemMessage } from '../src/query/parse.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
/**
 * M21 之后 `parse.ts` 拆成了 5 个模块（`parse-xml/parse-call/parse-rich/parse-system` + 本体的主入口），
 * 所以源码守卫从「读 parse.ts」改成「读这 5 个模块的**联合**」——**语义一条没放宽**：
 * 该守的缓存结构、命中/写入路径、四处热路径、噪声标签去重都还在，而且「不许出现绕过缓存的
 * 即时 new RegExp」这条现在覆盖到了新拆出来的模块（比原来更严）。
 */
const MODULES = ['parse.ts', 'parse-xml.ts', 'parse-call.ts', 'parse-rich.ts', 'parse-system.ts']
const sources: Record<string, string> = {}
for (const m of MODULES) sources[m] = readFileSync(join(HERE, '..', 'src', 'query', m), 'utf8')
/** 去掉注释后的源码（注释里提到旧写法 `new RegExp(` 不算接线）。 */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n')
const codeByModule: Record<string, string> = {}
for (const m of MODULES) codeByModule[m] = stripComments(sources[m] ?? '')
/** 五个模块的联合源码：跨模块的形状断言在这上面做。 */
const code = MODULES.map(m => codeByModule[m]).join('\n')

/**
 * 在（联合的）源码里取某个顶层函数的函数体。
 * @param header - 函数头（如 `function xmlTagBlocks(`）。
 * @param module - 该函数现在所在的模块（拆分后必须显式指明，免得断言在别的模块上碰巧命中）。
 * @returns 函数体源码。
 */
function bodyOfIn(header: string, module: string): string {
  const src = codeByModule[module] ?? ''
  const start = src.indexOf(header)
  expect(start, `${header} 必须仍在 ${module} 里`).toBeGreaterThan(-1)
  const end = src.indexOf('\n}', start)
  expect(end, `${header} 的函数体必须仍以顶层 '}' 结束`).toBeGreaterThan(start)
  return src.slice(start, end)
}

/** 撤回消息：只有 id/时间噪声（replacemsg 缺失），必须走 stripSystemNoise 那条路。 */
const REVOKE_NOISE_ONLY = '<sysmsg type="revokemsg"><revokemsg>'
  + '<revoketime>0</revoketime><session>50345516636@chatroom</session>'
  + '<newmsgid>987654321</newmsgid><oldmsgid>5</oldmsgid><customtip>对方撤回了</customtip>'
  + '</revokemsg></sysmsg>'

/** 撤回消息：带 replacemsg 文案（实测第二种形态）。 */
const REVOKE_WITH_MSG = '<sysmsg type="revokemsg"><revokemsg>'
  + '<replacemsg><![CDATA["Wave" 撤回了一条消息]]></replacemsg>'
  + '<session>50345516636@chatroom</session><newmsgid>123456789</newmsgid>'
  + '</revokemsg></sysmsg>'

/** 公众号推送：3 个 `<item>`（头条与 appmsg 自身重复，次条 2 篇）。 */
const MP_NEWS = '<appmsg appid="wx123" sdkver="0"><item>'
  + '<title>头条标题</title><url>https://mp.weixin.qq.com/s/top</url><type>5</type>'
  + '<thumburl>https://cdn/fallback.jpg</thumburl>'
  + '<mmreader><category type="20" count="3"><name>公众号名</name>'
  + '<topnew><cover>https://cdn/topcover.jpg</cover></topnew>'
  + '<item><title>头条标题</title><url>https://mp.weixin.qq.com/s/top</url></item>'
  + '<item><title_v2>次条一</title_v2><url>https://mp.weixin.qq.com/s/second</url>'
  + '<cover>https://cdn/c1.jpg</cover><summary>摘要一</summary></item>'
  + '<item><title>次条二</title><url>https://mp.weixin.qq.com/s/third</url><cover>https://cdn/c2.jpg</cover></item>'
  + '</category></mmreader></item></appmsg>'

describe('L11 行为等价：parseSystemMessage', () => {
  it('噪声节点（id/时间）被剥掉，保留可读文本', () => {
    expect(parseSystemMessage(REVOKE_NOISE_ONLY)).toEqual({ text: '对方撤回了', kind: 'revoke' })
  })

  it('replacemsg 文案优先，id 不进正文', () => {
    const r = parseSystemMessage(REVOKE_WITH_MSG)
    expect(r.kind).toBe('revoke')
    expect(r.text).toBe('"Wave" 撤回了一条消息')
    expect(r.text).not.toContain('50345516636')
  })

  it('重复调用结果完全一致（缓存的是带 g 的实例，lastIndex 不能被挪走）', () => {
    const first = parseSystemMessage(REVOKE_NOISE_ONLY)
    const second = parseSystemMessage(REVOKE_NOISE_ONLY)
    const third = parseSystemMessage(REVOKE_NOISE_ONLY)
    expect(second).toEqual(first)
    expect(third).toEqual(first)
  })

  it('非撤回的系统消息（模板/纯文本）输出不变', () => {
    const xml = '<sysmsg type="revokemsg"><revokemsg><revoketime>0</revoketime></revokemsg></sysmsg>'
    expect(parseSystemMessage(xml).text).toBe('撤回了一条消息')
    expect(parseSystemMessage('<sysmsg type="sysmsgtemplate"><plain><![CDATA[你邀请"甲"加入了群聊]]></plain></sysmsg>'))
      .toEqual({ text: '你邀请"甲"加入了群聊', kind: 'sysmsgtemplate' })
  })
})

describe('L11 行为等价：xmlTagBlocks（多图文次条）', () => {
  it('次条列表按文档顺序解析，头条被跳过（连续两次调用结果一致）', () => {
    const first = parseMessageContent(49, MP_NEWS)
    expect(first.rich?.type).toBe('link')
    expect(first.rich?.mpArticles?.map(a => a.title)).toEqual(['次条一', '次条二'])
    expect(first.rich?.mpArticles?.[0]?.summary).toBe('摘要一')
    expect(first.rich?.thumb).toBe('https://cdn/topcover.jpg')

    const second = parseMessageContent(49, MP_NEWS)
    expect(second.rich?.mpArticles?.map(a => a.title)).toEqual(['次条一', '次条二'])
  })
})

describe('L11 源码守卫：正则必须走 cachedRe 预编译', () => {
  it('cachedRe 存在且带上限兜底（M21 后住在 parse-xml.ts）', () => {
    const xml = codeByModule['parse-xml.ts'] ?? ''
    expect(xml).toContain('const RE_CACHE = new Map<string, RegExp>()')
    expect(xml).toContain('const RE_CACHE_MAX = 128')
    expect(xml).toMatch(/RE_CACHE\.size >= RE_CACHE_MAX/)
    // 「有缓存结构」不等于「真的命中缓存」：这两条守住命中/写入路径，
    // 否则把 cachedRe 改成每次都 build 一份，上面的断言照样绿。
    expect(xml).toContain('const hit = RE_CACHE.get(key)')
    expect(xml).toMatch(/if \(hit\) return hit/)
    expect(xml).toContain('RE_CACHE.set(key, re)')
  })

  it('四处热路径都经 cachedRe 取正则（不得在调用路径上即时构造）', () => {
    // 拆分后各就各位：三个 XML 原语在 parse-xml.ts、系统消息噪声剥离在 parse-system.ts
    const spots: Array<[string, string]> = [
      ['function xmlTagBlocks(', 'parse-xml.ts'],
      ['function xmlAttr(', 'parse-xml.ts'],
      ['function xmlTagOrAttr(', 'parse-xml.ts'],
      ['function stripSystemNoise(', 'parse-system.ts'],
    ]
    for (const [header, module] of spots) {
      const body = bodyOfIn(header, module)
      expect(body, `${header} 必须用 cachedRe`).toContain('cachedRe(')
    }
    // 全模块口径（比拆分前更严）：每个 `new RegExp(` 都必须出现在 cachedRe 的构造闭包里（同一行）。
    const lines = code.split(/\r?\n/)
    const builders = lines.filter(l => l.includes('new RegExp('))
    expect(builders.filter(l => !l.includes('cachedRe(')), '存在绕过缓存的即时 new RegExp').toEqual([])
    expect(builders.length, '构造点数量下限（防空转断言）').toBeGreaterThanOrEqual(3)
  })

  it('噪声标签去重后才进循环（原列表里 revoketime 写了两遍；M21 后住在 parse-system.ts）', () => {
    const sys = codeByModule['parse-system.ts'] ?? ''
    expect(sys).toContain('const SYS_NOISE_TAGS_UNIQUE = [...new Set(SYS_NOISE_TAGS)]')
    const body = bodyOfIn('function stripSystemNoise(', 'parse-system.ts')
    expect(body).toContain('for (const tag of SYS_NOISE_TAGS_UNIQUE)')
  })
})
