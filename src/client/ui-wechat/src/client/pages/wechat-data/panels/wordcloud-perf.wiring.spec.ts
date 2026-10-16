
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
   *
   * ⚠️ **2026-10-12 改锚点（这次是判据自己被证明不够）**：上一版只要求卡片里出现
   * `CLOUD_FONT_STEPS` 与 `cloudFontStep(` 两个**字符串** —— 而 `CLOUD_FONT_STEPS` 出现在
   * `import` 里就够了，于是真实映射
   * `Math.min(cloudFontCap(...), cloudFontStep(...))`（把**档位下标**当像素取 min）
   * 一路全绿，直到用户截图「这个板块的内容太少了」。
   * 现在映射搬成纯函数 `toCloudWords`，本组钉两件更强的：卡片**只许**走共享映射，
   * 且共享映射**必须**把档位下标换成像素。
   */
  it('字号阶梯与曲线都在（长尾数据不许退回「一坨一样大的小词」）', () => {
    expect(LAYOUT, '字号阶梯不见了').toContain('export const CLOUD_FONT_STEPS = [12, 15, 18, 22, 27, 33, 40, 48]')
    expect(CARD, '卡片必须用布局模块的共享映射（别再自己写一份字号逻辑）').toContain('toCloudWords(')
    expect(CARD, '卡片不许自己拼字号 —— 下标与像素两种量纲混用就是 2026-10-12 那个 bug').not.toContain('cloudFontStep(')
    expect(LAYOUT, '字号必须走 cloudFontStep 曲线，不许退回 (count-min)/span 的线性映射').toContain('cloudFontStep(')
    expect(LAYOUT, '共享映射必须把档位下标换成像素（`CLOUD_FONT_STEPS[step]`），否则整片词云会一样大')
      .toMatch(/size:\s*CLOUD_FONT_STEPS\[/)
  })

  /**
   * **撒点态的渲染契约**（这一组是 SSR 冒烟看不到的那一半）。
   *
   * 为什么必须单独钉：`scripts/wordcloud-ssr.tsx` 在 SSR 下量不到宽度 ⇒ 走的是 flex 回落分支；
   * 而真实界面量到宽度后走的是**绝对定位撒点**（`data-laid`）。后者有三条只有真渲染才暴露的事实，
   * 三条都在 2026-10-12 一起出过事（用户截图「内容太少了」= 394px 高的布局里只看见顶上 48px 的
   * 8 个词，且全是 12px）：
   *   ① 舞台必须**显式拿到布局用的高度** —— 词全是绝对定位 ⇒ 舞台没有在流内子元素、高度会塌成 0，
   *      而舞台带 `overflow:hidden`，矮容器会把词裁掉；
   *   ② 词必须是**带 `data-laid` 那层的直接子元素** —— CSS 里定位词用的是子选择器
   *      `.cloud[data-laid] > button`，多包一层 div 就全部失效；
   *   ③ 竖排词必须输出 `data-vertical` —— 盒子已在布局里按竖排对调，CSS 靠它切 `writing-mode`；
   *      不输出就是「文字横排、溢出盒子、压到邻居」。
   */
  it('撒点态：舞台拿到布局的高度（矮容器 + overflow:hidden 会把词裁掉）', () => {
    expect(CARD, '舞台高度必须来自布局（`layout.height`），否则坐标与盒子两个高度对不上')
      .toContain('layout.height')
    expect(CARD, '高度必须落到舞台的内联样式上').toMatch(/style=\{laidHeight === null \? undefined : \{ height:/)
  })

  it('撒点态：词必须是 data-laid 那层的直接子元素（子选择器不能被中间层挡住）', () => {
    const stageAt = CARD.indexOf("data-laid={placed ? '1' : undefined}")
    expect(stageAt, '找不到舞台上的 data-laid').toBeGreaterThan(-1)
    const btnAt = CARD.indexOf('<button', stageAt)
    expect(btnAt, '舞台里没有词按钮').toBeGreaterThan(stageAt)
    const between = CARD.slice(stageAt, btnAt)
    expect(
      between.includes('className={css.cloud}>'),
      '舞台与词之间又出现了一层 `className={css.cloud}` —— `.cloud[data-laid] > button` 的'
      + '定位/居中/竖排样式会对这个词全部失效（2026-10-12 之前就是这样）',
    ).toBe(false)
    expect(CARD, '空词表时不该渲染那层容器').toMatch(/\{words\.length > 0 && \(/)
  })

  /**
   * **六阶霓虹必须真的挂到词上**（2026-10-12 补）。
   *
   * 为什么单独钉：`wordcloud-card.module.css` 里定义了 `.low/.mid/.high/.top/.peak/.hot`
   * 六个色阶、`wordcloud-layout.ts` 的 `cloudTone()` 也算出了 tone —— 但卡片在 2026-10-03
   * 那次「按判据重建」里把 tone **丢了**（按钮只写成 `className={css.cloud}`），于是
   * 六个色阶一个都没生效：整片词云一个颜色，那六个类是死代码。
   * 是 `npm run wordcloud:smoke` 的「六个色阶类名都在」一直在红着（而它没进 `npm test`，
   * 所以只有 CI 那一步会碰到）。这里把它钉在单测里，顺手补上实现。
   */
  it('六阶霓虹要真的挂到词上（CSS 里那六个色阶类不是装饰）', () => {
    expect(CARD, '词按钮必须带 tone 色阶类（否则整片词云一个颜色）')
      .toMatch(/className=\{`\$\{css\.cloud\} \$\{css\[w\.tone/)
    const css = readStripped(join(HERE, 'wordcloud-card.module.css'))
    for (const tone of ['low', 'mid', 'high', 'top', 'peak', 'hot']) {
      expect(css, `色阶 .${tone} 的样式不见了`).toContain(`.${tone} {`)
    }
  })

  it('撒点态：竖排词必须输出 data-vertical（否则文字横排压到邻居）', () => {    // ⚠️ 只查「属性名出现过」是不够的：第一版写的就是 `toContain('data-vertical=')`，
    // 而变异把它改成 `data-vertical={undefined}` 时**照样通过**（属性名还在）。
    // 所以这里钉的是「值必须由 `w.vertical` 决定」。
    expect(CARD, 'data-vertical 必须由 w.vertical 决定（写成 undefined / 常量等于没输出）')
      .toMatch(/data-vertical=\{w\.vertical[^}]*\?[^}]*: undefined\}/)
    const css = readStripped(join(HERE, 'wordcloud-card.module.css'))
    expect(css, 'CSS 里那条竖排规则不见了').toContain('.cloud[data-laid] > button[data-vertical]')
    expect(css, '竖排规则要切 writing-mode').toContain('writing-mode: vertical-rl')
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
    // 2026-09-30：默认 60 → 120，并改成按画布尺寸换算 —— 固定 120 在窄面板上丢 56 个词
    // （实测 700px 画布），在 1600px 上只覆盖 42%。换算规则住在布局模块（纯函数、可测），
    // 卡片只负责把量到的宽度喂进去。2026-10-12 补了**面积**那一道（见下一条）。
    expect(LAYOUT, '按宽度换算词数的函数不见了').toContain('export function cloudLimitForWidth(')
    expect(LAYOUT, '按画布尺寸换算词数的函数不见了（面积那一道住在这里）').toContain('export function cloudLimitForStage(')
    expect(LAYOUT, '换算式的夹取范围要写清楚').toContain('CLOUD_LIMIT_MIN')
    expect(CARD, '卡片必须调布局模块的尺寸换算函数（高度要和布局同一个来源）')
      .toContain('cloudLimitForStage(stageW, height ?? cloudStageHeight(stageW), limit)')
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
    // 依赖里只许有「取数范围 + 缓存键 + liveTick（WAL 推送信号）」；词数/宽度一律不许进。
    expect(CARD, '取数 effect 的依赖里不许出现词数/宽度')
      .toContain('}, [scope, username, year, cacheKey, liveTick])')
    expect(CARD, '缓存 key 不许含词数/宽度')
      .toMatch(/const cacheKey = `wordcloud:\$\{scope\}:\$\{username \?\? ''\}:\$\{year \?\? 'all'\}`/)
    expect(CARD, '显示几个词要本地切（不重新取数）').toContain('cloudLimitForStage(stageW, height ?? cloudStageHeight(stageW), limit)')
    // 反例：把宽度塞回依赖（那正是"全屏后又统计一次"的接线）
    expect(CARD.includes('[scope, username, year, requestLimit'), '宽度又回到请求依赖里了').toBe(false)
  })
})
