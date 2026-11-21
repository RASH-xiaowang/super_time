/**
 * 「一张卡只回答一个问题」的守卫（2026-11-19）。
 *
 * ## 为什么需要它
 *
 * 用户要求「能把内容拆出来成为独立卡片就拆，但意义要一样」。审计时发现两类真问题：
 *
 *   · **同一字段在两张卡里各画一遍**：「你说的话」的 5 个格子（语音发出/语音收到/
 *     通话/接通未接/视频语音）与「媒体与通话」逐字重复；「媒体与通话」的"表情"行
 *     又与「表情宇宙」重复；「年度画像」的 4 个指标格与「全年发出」完全一样。
 *   · **一张卡塞两件事**：总览的「关系与地区」= 规模统计 + 对话排行（+ 地图）；
 *     「内容构成与资产」= 消息构成 + 资产盘点。
 *
 * 这两类都不报错、不崩，只是让人读到第二遍时觉得"这不是废话吗"。
 * 所以这里钉两条：**字段级不重复**、**卡片标题与内容对得上**。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (f: string): string => readFileSync(join(HERE, f), 'utf8')

/**
 * 剥注释（说明里会引用"旧写法"做解释，裸词匹配会被自己骗到 —— 本仓库踩过多次）。
 */
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const annual = strip(read('Annual.tsx'))
const moreCards = strip(read('annual-more-cards.tsx'))
const sections = strip(read('overview-sections.tsx'))
const panel = strip(read('overview-panel.tsx'))

/**
 * 取一个函数体（按花括号配平）。
 *
 * ⚠️ 必须**跳过参数列表**再找函数体的 `{`：卡片签名都是 `function X({ r })`，
 * 从函数名后第一个 `{` 开始数会在参数解构处就配平（返回 `function X({ r }`），
 * 后面所有断言都在一个空壳上跑 —— 第一版就这么写的，5 条全误报。
 */
function bodyOf(src: string, name: string): string {
  const start = src.search(new RegExp(`(?:export )?function ${name}\\(`))
  if (start < 0) return ''
  // 先找参数列表的收尾 `)`（按圆括号配平，跳过解构里的括号）。
  const parenOpen = src.indexOf('(', start)
  let pd = 0
  let parenClose = -1
  for (let i = parenOpen; i < src.length; i += 1) {
    if (src[i] === '(') pd += 1
    else if (src[i] === ')') {
      pd -= 1
      if (pd === 0) { parenClose = i; break }
    }
  }
  if (parenClose < 0) return ''
  const open = src.indexOf('{', parenClose)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return ''
}

/** 一张卡里出现的「数据字段」集合（`w.voiceSentCount` → `voiceSentCount`）。 */
function fieldsIn(body: string): Set<string> {
  return new Set([...body.matchAll(/\b(?:w|r|ins|data|extras|ledger|stor|revoked)\.([a-zA-Z]+)/g)].map(m => m[1] ?? ''))
}

describe('同一字段不许在两张卡里各画一遍', () => {
  it('「你说的话」不再重复「媒体与通话」的语音/通话格子', () => {
    /**
     * 事故现场：`WordsCard` 有 6 格，其中 5 格（语音发出 / 语音收到 / 通话 /
     * 接通未接 / 视频语音）与 `MediaCallCard` 逐字相同。
     */
    const words = bodyOf(annual, 'WordsCard')
    const media = bodyOf(moreCards, 'MediaCallCard')
    expect(words, '找不到 WordsCard').not.toBe('')
    expect(media, '找不到 MediaCallCard').not.toBe('')
    // 通话/语音相关的字段只允许出现在「媒体与通话」里。
    for (const field of ['voiceSentCount', 'voiceSentSec', 'voiceRecvCount', 'voiceRecvSec',
      'callCount', 'callSec', 'callConnected', 'callMissed']) {
      expect(words, `「你说的话」又画了 ${field}（属于「媒体与通话」）`).not.toContain(`.${field}`)
      expect(media, `「媒体与通话」缺 ${field}`).toContain(`.${field}`)
    }
    // 「你说的话」保留自己的主题字段。
    for (const field of ['mineChars', 'receivedChars', 'keystrokes']) {
      expect(words, `「你说的话」缺 ${field}`).toContain(`.${field}`)
    }
  })

  it('「媒体与通话」不再重复「表情宇宙」的表情数据', () => {
    const media = bodyOf(moreCards, 'MediaCallCard')
    const emoji = bodyOf(annual, 'EmojiCard')
    expect(emoji, '找不到 EmojiCard').not.toBe('')
    expect(media, '「媒体与通话」又画了表情（属于「表情宇宙」）').not.toContain('.emoji')
    expect(emoji, '「表情宇宙」缺表情数据').toContain('.emoji')
  })

  it('「年度画像」的指标格不再与「全年发出」重复', () => {
    /**
     * 事故现场：画像卡右侧 6 格里 4 格（全年发出 / 日均 / 活跃天数 / 最长连续）
     * 与 `HeroCard` 一模一样。现在画像只留文字里真正提到的数字。
     */
    const portrait = bodyOf(moreCards, 'YearPortrait')
    expect(portrait, '找不到 YearPortrait').not.toBe('')
    for (const field of ['sent', 'sentDailyAvg', 'activeDaysMine', 'longestStreak']) {
      // 允许出现在**文字**里（`bits.push` 依据），但不允许出现在指标格数组里。
      const statsBlock = /const stats[\s\S]*?\n  \]/.exec(portrait)?.[0] ?? ''
      expect(statsBlock, `画像指标格又列了 ${field}（属于「全年发出」）`).not.toContain(`r.${field}`)
    }
    // 画像特有的数字仍在。
    expect(portrait, '画像缺深夜占比').toContain('nightShare')
    expect(portrait, '画像缺最常聊').toContain('buddy')
  })
})

describe('一张卡只回答一个问题（拆分后语义清晰）', () => {
  it('总览：「关系规模」只讲规模，「对话 Top」只讲排行', () => {
    const relation = bodyOf(sections, 'RelationSection')
    const top = bodyOf(sections, 'TopChatsSection')
    expect(relation, '找不到 RelationSection').not.toBe('')
    expect(top, '找不到 TopChatsSection').not.toBe('')
    // 规模卡里不该再出现排行列表；排行卡里不该再出现规模指标。
    expect(relation, '「关系规模」里还有排行（topList）').not.toContain('topList')
    expect(top, '「对话 Top」里还有规模指标（metricGrid）').not.toContain('metricGrid')
    expect(relation, '「关系规模」缺规模指标').toContain('metricGrid')
    expect(top, '「对话 Top」缺排行列表').toContain('topList')
  })

  it('总览：「消息构成」只讲消息，「内容资产」只讲沉淀', () => {
    const content = bodyOf(sections, 'ContentSection')
    const assets = bodyOf(sections, 'AssetsOverviewSection')
    expect(content, '找不到 ContentSection').not.toBe('')
    expect(assets, '找不到 AssetsOverviewSection').not.toBe('')
    expect(content, '「消息构成」里还有资产盘点（assetGrid）').not.toContain('assetGrid')
    expect(assets, '「内容资产」里还有消息类型分布（catList）').not.toContain('catList')
    expect(content, '「消息构成」缺类型分布').toContain('catList')
    expect(assets, '「内容资产」缺资产格').toContain('assetGrid')
  })

  it('拆出来的卡名与内容对得上（「关系与地区」已不准确，因为地图与地区榜都搬走了）', () => {
    expect(sections, '关系卡还叫「关系与地区」').not.toContain('title="关系与地区"')
    expect(sections, '关系卡应改名为「关系规模」').toContain('title="关系规模"')
    expect(sections, '不该再有「内容构成与资产」这个混合标题').not.toContain('title="内容构成与资产"')
    for (const title of ['title="对话 Top 8"', 'title="消息构成"', 'title="内容资产"']) {
      expect(sections, `缺少拆分出来的卡：${title}`).toContain(title)
    }
  })

  it('拆分出来的卡都挂进了面板（拆了却没接上去等于丢功能）', () => {
    for (const comp of ['<TopChatsSection', '<ContentSection', '<AssetsOverviewSection', '<WorldMapSection']) {
      expect(panel, `面板里没挂 ${comp}`).toContain(comp)
    }
  })
})
