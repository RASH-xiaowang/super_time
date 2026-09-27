
/**
 * 「全部热词」加载慢的修复必须被钉住（2026-09-26）。
 *
 * 背景（`working/probe-wc-out.txt` / `probe-queue-out.txt` 实测）：
 *  · `getWordCloud(global)` 一次 **15,312ms**，且**没有进程内缓存** —— 每次切回总览都重算；
 *  · 它是**同步**返回 ⇒ 跑的这十几秒里，后端 RPC 队列被整条堵住。同屏的「世界板块」
 *    自身只要 13ms，却实测被推迟到 **17,008ms** 才拿到数据 ——「世界板块和全部热词都卡住」
 *    是**同一个原因**；
 *  · 15 秒里 **91%** 花在「每条正文 × 全部实体名做 `includes`」（163,650 × 1,979）。
 *
 * 修法与对应断言：
 *  ① 实体遮罩换 Aho-Corasick（`query/word-match.ts`）—— 15.3s → 3.0s；
 *  ② 加 `cachedBySig` 缓存 —— 切回 0ms；
 *  ③ 前端首屏渲染缓存 —— 有旧快照就立刻画，不用等；
 *  ④ 前端请求**延后一拍**入队 —— 别把同屏其它块堵在身后。
 *
 * 等价性由 `tests/word-match.spec.ts` 的行为对拍负责；本文件只守「接线与实现形态」。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atLeast, findRoot, readStripped, sliceBetween } from '../../../test-helpers/wiring-kit.ts'

/** panels → 仓库根 → 后端的 query 目录。 */
const HERE = import.meta.dirname
const BACKEND = join(findRoot(HERE), 'src', 'backend', 'wechat-data', 'src', 'query')

const WC = readStripped(join(BACKEND, 'wordcloud.ts'))
const MATCH = readStripped(join(BACKEND, 'word-match.ts'))
const CARD = readStripped(join(HERE, 'WordCloudCard.tsx'))

describe('① 实体遮罩必须是 Aho-Corasick，不能退回逐条全遍历', () => {
  it('匹配器有 goto / fail / out 三件套（AC 的标志）', () => {
    expect(MATCH).toMatch(/children: Array<Map<number, number>>/)
    expect(MATCH).toMatch(/fail: number\[\]/)
    expect(MATCH).toMatch(/out: number\[\]\[\]/)
  })

  it('**没有**「遍历全部名字做 includes」的老写法（那正是 91% 的耗时来源）', () => {
    // 反例断言：一旦有人改回去，这句就红。
    // `e` 是「实体名」这个角色的变量名 —— 现有代码里没有以它为循环变量的循环，
    // 所以这一条同时覆盖 `words` / `names` / `list` 各种写法的回归。
    expect(MATCH.includes('for (const e of '), '不许按名字全遍历').toBe(false)
    expect(MATCH.includes('.includes(e)'), '不许回到逐名 includes').toBe(false)
  })

  it('out 必须沿 fail 链继承（否则「名字是另一个名字的后缀」会漏检）', () => {
    const build = sliceBetween(MATCH, 'export function buildEntityMatcher', 'export function countText', '匹配器构建')
    expect(build, '缺少 fail 链继承').toMatch(/for \(const w of out\[f\]!\) out\[node\]!\.push\(w\)/)
    expect(build, '缺少 BFS 建失配指针').toMatch(/while \(f2 !== 0 && !children\[f2\]!\.has\(c\)\)/)
  })

  it('命中按长度降序处理（遮罩顺序是语义的一部分）', () => {
    const body = sliceBetween(MATCH, 'export function countText', 'const bigram = m.bigram', 'countText 主体')
    expect(body).toMatch(/touched\.sort\(\(a, b\) => m\.words\[b\]!\.length - m\.words\[a\]!\.length\)/)
  })

  it('一个名字无论出现几次都只 +1（口径是「几条正文」不是词频）', () => {
    const body = sliceBetween(MATCH, 'export function countText', 'const bigram = m.bigram', 'countText 主体')
    expect(body, '+1 而不是 +ps.length').toMatch(/counts\.set\(word, \(counts\.get\(word\) \?\? 0\) \+ 1\)/)
    expect(body.includes('+ ps.length'), '不许按出现次数累加').toBe(false)
  })

  it('bigram 热循环用码元范围判断，不许退回 slice + 正则（每 16 万条 × 上百字符）', () => {
    const body = sliceBetween(MATCH, 'const bigram = m.bigram', 'for (const [key, v] of bigram)', 'bigram 热循环')
    expect(body, '缺少码元范围判断').toMatch(/if \(c0 < 0x4e00 \|\| c0 > 0x9fff\) continue/)
    expect(body.includes('rest.slice(i, i + 2)'), '不许在热循环里分配子串').toBe(false)
    expect(body.includes('/[\\u4e00-\\u9fff]{2}/.test'), '不许在热循环里跑正则').toBe(false)
  })
})

describe('② 后端必须有进程内缓存（否则每次切回都重算）', () => {
  it('queryWordCloud 走 cachedBySig', () => {
    const body = sliceBetween(WC, 'export function queryWordCloud', '\n}', 'queryWordCloud')
    expect(body, '没有缓存 —— 15 秒会每次重来').toContain('cachedBySig(')
    expect(body, '缓存 key 要含 scope/username/year').toMatch(/wordcloud:\$\{scope\}:\$\{username\}:\$\{year \?\? 'all'\}/)
  })

  it('缓存签名绑到数据指纹（消息分片 mtime+size / 朋友圈 db）', () => {
    const body = sliceBetween(WC, 'export function queryWordCloud', '\n}', 'queryWordCloud')
    expect(body).toContain("shardCatalogSig(decryptedDir, ['message'])")
    expect(body).toContain('fileSigOf(')
  })

  it('limit 不进缓存 key（缓存全量词表，按 limit 切片）', () => {
    const body = sliceBetween(WC, 'export function queryWordCloud', '\n}', 'queryWordCloud')
    expect(body, 'limit 不该进 key').not.toMatch(/wordcloud:.*\$\{limit\}/)
    expect(body, '返回时要按 limit 切').toMatch(/full\.words\.slice\(0, limit\)/)
  })
})

describe('③④ 前端：首屏瞬时渲染 + 不堵同屏其它块', () => {
  it('用首屏渲染缓存（有旧快照立刻画）', () => {
    expect(CARD).toContain('readRenderCache<WordCloudSnapshot>')
    expect(CARD).toContain('writeRenderCache(cacheKey')
    expect(CARD, '初值必须来自缓存').toMatch(/useState<WordCloudSnapshot>\(\(\) => readRenderCache/)
  })

  it('请求延后一拍入队（后端同步，先入队者先跑）', () => {
    expect(CARD, '必须在 setTimeout 里发请求').toMatch(/const timer = setTimeout\(\(\) => \{/)
    expect(CARD, '要能取消').toMatch(/clearTimeout\(timer\)/)
    // 反例：请求必须出现在定时器**之后**（即在回调里）。直接发 = 把同屏其它块堵在身后。
    const atTimer = CARD.indexOf('const timer = setTimeout(')
    const atCall = CARD.indexOf('void apiGetWordCloud(')
    expect(atTimer, '找不到定时器').toBeGreaterThan(-1)
    expect(atCall, '找不到请求').toBeGreaterThan(-1)
    expect(atCall, '请求必须在定时器回调里，不能直接发').toBeGreaterThan(atTimer)
  })

  it('有旧快照时不许用「统计中」盖住它（否则首屏缓存白做）', () => {
    expect(CARD, '加载态只在没有内容时显示').toMatch(/\{loading && words\.length === 0 && /)
    expect(CARD, '词云只按有没有内容决定渲染').toMatch(/\{words\.length > 0 && \(/)
  })

  it('防空转：三个文件都真的读到了', () => {
    atLeast(MATCH.length, 3000, 'word-match.ts 源码')
    atLeast(WC.length, 3000, 'wordcloud.ts 源码')
    atLeast(CARD.length, 2000, 'WordCloudCard.tsx 源码')
  })
})

describe('词云卡片本身仍然完整（别为了性能把功能弄丢）', () => {
  it('点击词 → 全局搜索、键盘可达、六档字号都还在', () => {
    expect(CARD).toContain('openGlobalSearch(w.text)')
    expect(CARD).toMatch(/<button[\s\S]{0,400}onClick=\{\(\) => \{ openGlobalSearch/)
    expect(CARD).toContain('const FONT_STEPS = [12, 14, 16, 18, 22, 28]')
  })

  it('三个 scope 的标题仍在（global / chat / moments）', () => {
    expect(CARD).toContain("scope === 'chat' ? '群聊热词'")
    expect(CARD).toContain("scope === 'moments' ? '朋友圈热词'")
    expect(CARD).toContain("'全部热词'")
  })

  it('既有的可配置项没被弄丢（title / limit）', () => {
    expect(CARD).toContain('title ??')
    expect(CARD).toContain('Math.min(Math.max(1, limit ?? 60), 200)')
  })
})
