
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
/** 布局算法模块（纯函数）：词数换算与字号阶梯住在这里。 */
const LAYOUT = readStripped(join(HERE, 'wordcloud-layout.ts'))

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
  it('queryWordCloud 走 cachedBySigAsync', () => {
    const body = sliceBetween(WC, 'export async function queryWordCloud', '\n}', 'queryWordCloud')
    // 2026-09-28：由 `cachedBySig` 换成 async 版 —— 为的是能在分片/行级 `await yieldToLoop()`，
    // 不再把后端 worker 独占整段冷算（见 `query-yield-discipline.spec.ts` 的 P1-2 清单）。
    // 断言的是**缓存仍在**这件事，不是某个具体函数名：两条都认。
    expect(body, '没有缓存 —— 15 秒会每次重来').toMatch(/cachedBySig(Async)?\(/)
    expect(body, '缓存 key 要含 scope/username/year').toMatch(/wordcloud:\$\{scope\}:\$\{username\}:\$\{year \?\? 'all'\}/)
  })

  it('缓存签名绑到数据指纹（消息分片 mtime+size / 朋友圈 db）', () => {
    const body = sliceBetween(WC, 'export async function queryWordCloud', '\n}', 'queryWordCloud')
    expect(body).toContain("shardCatalogSig(decryptedDir, ['message'])")
    expect(body).toContain('fileSigOf(')
  })

  it('limit 不进缓存 key（缓存全量词表，按 limit 切片）', () => {
    const body = sliceBetween(WC, 'export async function queryWordCloud', '\n}', 'queryWordCloud')
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
  it('点击词 → 全局搜索、键盘可达（词元素必须是真实 button）', () => {
    expect(CARD).toContain('openGlobalSearch(w.text)')
    expect(CARD).toMatch(/<button[\s\S]{0,400}onClick=\{\(\) => \{ openGlobalSearch/)
  })

  /**
   * 2026-09-30 重做：字号阶梯从卡片搬进了 `wordcloud-layout.ts`，而且**不再是线性权重**。
   * 旧断言钉的是卡片里那句 `const FONT_STEPS = [12, 14, 16, 18, 22, 28]`；现在钉的是
   * 「阶梯还在 + 卡片确实走了曲线的那个函数」—— 后者才是「词云别退回成一行行小字」的关键
   * （曲线本身的数值行为由 `wordcloud-layout.spec.ts` 的注入用例覆盖）。
   */
  it('字号阶梯与曲线都在（长尾数据不许退回「一坨一样大的小词」）', () => {
    expect(LAYOUT, '字号阶梯不见了').toContain('export const CLOUD_FONT_STEPS = [12, 15, 18, 22, 27, 33, 40, 48]')
    expect(CARD, '卡片必须用 CLOUD_FONT_STEPS（别再手写一份阶梯）').toContain('CLOUD_FONT_STEPS')
    expect(CARD, '字号必须走 cloudFontStep 曲线，不许退回 (count-min)/span 的线性映射').toContain('cloudFontStep(')
  })

  it('撒点算法在纯函数模块里，且卡片在没量到宽度时退回 flex（SSR 不炸）', () => {
    expect(CARD).toContain('layoutWordCloud(')
    expect(CARD, '宽度用 ResizeObserver 量').toMatch(/new ResizeObserver\(/)
    expect(CARD, '没有几何信息时必须有回落分支（SSR / 首帧）').toMatch(/placed \?\? cloudWords/)
    expect(CARD, '回落态与撒点态靠 data-laid 区分').toContain("data-laid={placed ? '1' : undefined}")
    // 反例：不许用 canvas / DOM 测量（那是 60 次强制布局，且 SSR 下直接崩）
    expect(CARD.includes('measureText'), '不许用 canvas 量文字').toBe(false)
    expect(CARD.includes('getBoundingClientRect'), '不许逐个 getBoundingClientRect 量文字').toBe(false)
  })

  it('三个 scope 的标题仍在（global / chat / moments）', () => {
    expect(CARD).toContain("scope === 'chat' ? '群聊热词'")
    expect(CARD).toContain("scope === 'moments' ? '朋友圈热词'")
    expect(CARD).toContain("'全部热词'")
  })

  it('词数上限仍在，且**跟着画布宽度自适应**（固定词数会一边丢词、一边留白）', () => {
    expect(CARD).toContain('title ??')
    // 2026-09-30：默认 60 → 120，并改成按宽度换算 —— 固定 120 在窄面板上丢 56 个词
    // （实测 700px 画布），在 1600px 上只覆盖 42%。换算规则住在布局模块（纯函数、可测），
    // 卡片只负责把量到的宽度喂进去。
    expect(LAYOUT, '默认词数常量不见了').toContain('export const DEFAULT_CLOUD_LIMIT = 120')
    expect(LAYOUT, '按宽度换算词数的函数不见了').toContain('export function cloudLimitForWidth(')
    expect(LAYOUT, '换算式的夹取范围要写清楚').toContain('CLOUD_LIMIT_MIN')
    expect(CARD, '卡片必须调布局模块的换算函数').toContain('cloudLimitForWidth(stageW, limit)')
  })

  /**
   * **改窗口尺寸 / 进全屏不许重新统计**（2026-09-30 用户问「为什么全屏后还需要再评估统计一次，
   * 而且统计很慢」）。上一版把「宽度 → 词数」接在请求上：全屏动画期间 `ResizeObserver` 会一路
   * 报宽度，跨过每个词数档位就换一次 cacheKey、发一次请求，还会把 localStorage 快照一起换掉
   * （先闪一次「统计中…」）。词表与宽度无关 —— 宽度只决定**显示几个**。
   * 判据：请求词数是常量上限；取数 effect 的依赖里没有宽度/词数；缓存 key 不含词数；显示数量本地切。
   */
  it('改窗口尺寸 / 进全屏不许重新统计（词数与宽度都不进请求、不进缓存 key）', () => {
    expect(CARD, '请求词数必须是固定上限（不随宽度变）').toContain('limit: FETCH_LIMIT')
    expect(CARD, '取数 effect 的依赖里不许出现词数/宽度')
      .toContain('}, [scope, username, year, cacheKey])')
    expect(CARD, '缓存 key 不许含词数/宽度')
      .toMatch(/const cacheKey = `wordcloud:\$\{scope\}:\$\{username \?\? ''\}:\$\{year \?\? 'all'\}`/)
    expect(CARD, '显示几个词要本地切（不重新取数）').toContain('cloudLimitForWidth(stageW, limit)')
    // 反例：把宽度塞回依赖（那正是"全屏后又统计一次"的接线）
    expect(CARD.includes('[scope, username, year, requestLimit'), '宽度又回到请求依赖里了').toBe(false)
  })
})
