/**
 * 年度报告**加载骨架屏**的接线守卫（2026-10-19 微信化改版）。
 *
 * 演进：2026-10-17 把 `ListSkeleton rows={6}` 换成与真实布局同构的 `AnnualSkeleton`；
 * 2026-10-19 年度报告默认从 27 卡收敛为 **8 张核心卡 + 页脚**（其余 17 项进折叠区），
 * 骨架同步只画默认可见的这一屏。
 *
 * 这条守卫守的仍是「形状不匹配」：骨架与真实布局的 span/tone 必须逐项一致，
 * 否则加载完会整体跳版，且这种问题不会报错、不会崩，只能靠守卫钉住。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = import.meta.dirname

/** 读同目录下的文件。 */
function read(name: string): string {
  return readFileSync(join(HERE, name), 'utf8')
}

/**
 * 剥掉注释 —— 注释里故意写了历史写法（`ListSkeleton rows={6}`），
 * 不剥就是假阳性。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 真实默认网格的 span 序列：8 张卡 + 页脚（12 列基准）。 */
function realGrid(): { spans: number[]; tones: string[] } {
  const annual = stripComments(read('Annual.tsx'))
  const more = stripComments(read('annual-more-cards.tsx'))

  // 先建「组件名 → span / tone」表（`<Card span={N} tone="x">` / `<MoreCard …>`，缺省 span 3 / tone cyan）。
  const spanOf = new Map<string, number>()
  const toneOf = new Map<string, string>()
  for (const src of [annual, more]) {
    const lines = src.split('\n')
    const starts: Array<{ name: string; at: number }> = []
    lines.forEach((ln, i) => {
      const m = /^(?:export )?function (\w+)\(/.exec(ln)
      if (m?.[1]) starts.push({ name: m[1], at: i })
    })
    starts.forEach((s, k) => {
      const end = k + 1 < starts.length ? (starts[k + 1]?.at ?? lines.length) - 1 : lines.length - 1
      const body = lines.slice(s.at, end + 1).join('\n')
      // ⚠️ `YearPortrait` 没有 `span={N}` 字面量 —— 它的跨度来自 CSS 的
      // `.portrait { grid-column: span 6 }`。不认这个类就会把它算成缺省 3。
      if (/\bcss\.portrait\b/.test(body)) spanOf.set(s.name, 6)
      else {
        const m = /span=\{(\d+)\}/.exec(body)
        spanOf.set(s.name, m?.[1] ? Number(m[1]) : 3)
      }
      const t = /tone="(\w+)"/.exec(body)
      toneOf.set(s.name, t?.[1] ?? 'cyan')
    })
  }

  // 默认渲染顺序：`<MasonryGrid>` 里的子元素（组件名 / `.footer`）。
  const grid = /<MasonryGrid>([\s\S]*?)<\/MasonryGrid>/.exec(annual)?.[1] ?? ''
  expect(grid, 'Annual.tsx 里应有 <MasonryGrid> 块').not.toBe('')

  const spans: number[] = []
  const tones: string[] = []
  for (const ln of grid.split('\n')) {
    const t = ln.trim()
    // `<HeroCard r={data} />` 这类自闭合组件（**只认大写开头** —— footer 里还有 `<span>`）。
    const comp = /^<([A-Z]\w*)\s/.exec(t)
    if (comp?.[1]) {
      const span = spanOf.get(comp[1])
      expect(span, `找不到 ${comp[1]} 的 span`).toBeDefined()
      spans.push(span ?? 3)
      tones.push(toneOf.get(comp[1]) ?? 'cyan')
      continue
    }
    // `<div className={css.footer}>`（页脚整行，无 tone → 骨架给 cyan 占位）
    if (t.startsWith('<div className={css.footer}')) {
      spans.push(12)
      tones.push('cyan')
    }
  }
  return { spans, tones }
}

describe('年度报告加载骨架屏', () => {
  it('Annual.tsx 的加载态用 AnnualSkeleton，不再用列表骨架', () => {
    const src = stripComments(read('Annual.tsx'))
    expect(src, '年度报告的加载态应使用专用骨架屏').toContain('<AnnualSkeleton />')
    expect(src, '年度报告不应再用列表骨架（形状与 12 列卡片墙不匹配）').not.toContain('<ListSkeleton')
  })

  it('AnnualSkeleton 与真实卡片共用同一个 12 列网格', () => {
    const skel = stripComments(read('annual-skeleton.tsx'))
    expect(skel, '骨架屏必须复用 .board 网格').toContain('className={css.board}')
    expect(skel, '占位卡必须按 span 跨列').toContain('gridColumn: `span ${String(c.span)}`')
  })

  it('占位格子的 span 分布与默认可见的 8 卡 + 页脚逐项一致', () => {
    const skel = stripComments(read('annual-skeleton.tsx'))
    const skelSpans = [...skel.matchAll(/\{\s*span:\s*(\d+),/g)].map((m) => Number(m[1]))
    const real = realGrid()
    expect(real.spans, '默认网格不是 8 卡 + 页脚').toHaveLength(9)
    expect(skelSpans.length, '骨架格子数量应与真实布局一致').toBe(real.spans.length)
    expect(skelSpans, '骨架的 span 分布应与真实布局逐项一致').toEqual(real.spans)
    // 逐行整除 12：骨架与真实都是 8 卡 + 页脚 = 60 列（不需要 dense 也能填满）
    expect(skelSpans.reduce((a, b) => a + b, 0) % 12, '骨架总列数不是 12 的倍数').toBe(0)
  })

  it('骨架屏对读屏软件隐藏（占位内容没有语义）', () => {
    const skel = stripComments(read('annual-skeleton.tsx'))
    expect(skel, '骨架屏应 aria-hidden').toContain('aria-hidden="true"')
  })

  it('骨架样式存在，且**不再有呼吸动画**（2026-10-17 用户要求）', () => {
    const css = read('annual.module.css')
    for (const cls of ['.skelCard', '.skelTitle', '.skelBlock']) {
      expect(css, `缺少骨架样式 ${cls}`).toContain(`${cls} {`)
    }
    expect(css, '骨架不许再有呼吸动画').not.toContain('@keyframes annualSkeletonPulse')
    expect(css, '骨架不许再挂 animation').not.toMatch(/\.skelCard\s*\{[^}]*animation:/)
  })

  it('骨架的 tone 与真实卡片逐项一致（加载态与加载完不许"闪一下换色"）', () => {
    const skel = stripComments(read('annual-skeleton.tsx'))
    // 骨架：`{ span: N, blocks: [...], tone: 'xxx' }` —— 只扫 CELLS 数组。
    const cellsBlock = /const CELLS[\s\S]*?\n\]/.exec(skel)?.[0] ?? ''
    expect(cellsBlock, '找不到 CELLS 数组').not.toBe('')
    const skelTones = [...cellsBlock.matchAll(/tone: '(\w+)'/g)].map((m) => m[1])
    const real = realGrid()
    expect(skelTones.length, '骨架 tone 数量应与真实布局一致').toBe(real.tones.length)
    expect(skelTones, '骨架的 tone 应与真实卡片逐项一致').toEqual(real.tones)
  })

  it('每张卡片都有 tone，且只用 7 个语义色之一', () => {
    const annual = stripComments(read('Annual.tsx'))
    const more = stripComments(read('annual-more-cards.tsx'))
    const ALLOWED = new Set(['cyan', 'purple', 'pink', 'green', 'amber', 'blue', 'red'])

    const cardTags = [...annual.matchAll(/<Card\b([^>]*)>/g), ...more.matchAll(/<MoreCard\b([^>]*)>/g)]
    expect(cardTags.length, '一张卡都没扫到 ⇒ 判据写错了').toBeGreaterThan(15)
    for (const m of cardTags) {
      const tone = /tone="(\w+)"/.exec(m[1] ?? '')?.[1]
      if (tone !== undefined) {
        expect(ALLOWED.has(tone), `未知 tone：${tone}`).toBe(true)
      }
    }

    // 7 个 tone 都要被数据用上（视觉上已收敛为中性 + 1 强调，但语义标签不退化）。
    const used = new Set([...annual.matchAll(/tone="(\w+)"/g), ...more.matchAll(/tone="(\w+)"/g)].map((m) => m[1]))
    for (const t of ALLOWED) {
      expect(used.has(t), `tone「${t}」没有任何卡片在用 —— 配色体系退化了`).toBe(true)
    }
  })

  it('tone 视觉收敛：中性默认 + 唯一 green 强调，不写死 hex', () => {
    const css = read('annual.module.css')
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const at = code.indexOf(".card[data-tone],")
    const end = code.indexOf('.cardHead')
    expect(at, '找不到语义色调规则块').toBeGreaterThan(-1)
    const toneBlock = code.slice(at, end === -1 ? code.length : end)
    // 默认中性：所有 tone 共用分隔线色
    expect(toneBlock).toMatch(/--tone-line: var\(--nm-border-hover\)/)
    // 唯一强调：green 用主色令牌（不写死 hex）
    expect(toneBlock).toMatch(/\.card\[data-tone='green'\][\s\S]{0,160}--tone-line: var\(--nm-cyan\)/)
    expect(toneBlock, 'tone 规则里写死了 hex').not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    for (const c of ['purple', 'pink', 'amber', 'blue', 'red']) {
      expect(toneBlock, `tone 规则里还留着 ${c} 语义色`).not.toContain(`--nm-${c}`)
    }
  })

  it('卡片背景是「白底 + 顶部色线」，不再铺径向渐变', () => {
    const css = read('annual.module.css')
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code, '缺少顶部色线').toMatch(/\.card::before \{[\s\S]{0,200}height: 2px/)
    expect(code, '.card::after 的径向渐变又回来了').not.toMatch(/\.card::after \{[\s\S]{0,300}radial-gradient/)
    expect(code, '.skelCard::after 的径向渐变又回来了').not.toMatch(/\.skelCard::after \{[\s\S]{0,300}radial-gradient/)
    expect(code, '.card 的 background 应只有 --nm-bg-card').toMatch(/\.card \{[\s\S]{0,400}background: var\(--nm-bg-card\);/)
    // 全文件不许再出现装饰性渐变
    expect(code, '还有渐变').not.toMatch(/(linear|radial)-gradient/)
  })

  it('网格**高度随内容**（用户 2026-10-17 参考图：各卡高度不同）', () => {
    const css = read('annual.module.css')
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code, '行高必须是 auto（高度随内容）').toMatch(/\.board \{[\s\S]{0,400}grid-auto-rows: auto/)
    expect(code, '--annual-row 又回来了 ⇒ 固定行高会重新制造留白/滚动条').not.toMatch(/--annual-row/)
    expect(code, 'align-items 必须是 start（stretch 会把同行卡拉成等高）')
      .toMatch(/\.board \{[\s\S]{0,400}align-items: start/)
    expect(code, 'dense 丢了 ⇒ 空位置补不上').toMatch(/\.board \{[\s\S]{0,900}grid-auto-flow: dense/)
  })

  it('卡片不再声明行数（高度随内容），骨架逐项同步', () => {
    const annual = stripComments(read('Annual.tsx'))
    const more = stripComments(read('annual-more-cards.tsx'))
    const skel = stripComments(read('annual-skeleton.tsx'))

    expect(annual, 'Annual.tsx 里还有 rows={N} ⇒ 高度又被写死了').not.toMatch(/rows=\{\d+\}/)
    expect(more, 'annual-more-cards.tsx 里还有 rows={N}').not.toMatch(/rows=\{\d+\}/)
    expect(read('annual-more-cards.tsx'), '还有 data-rows ⇒ 高度又被写死了').not.toMatch(/data-rows=/)

    const cellsBlock = /const CELLS[\s\S]*?\n\]/.exec(skel)?.[0] ?? ''
    expect(cellsBlock, '找不到 CELLS 数组').not.toBe('')
    expect(cellsBlock, '骨架还有 rows 字段 ⇒ 与真实布局不同步').not.toMatch(/rows:/)
    const spans = [...cellsBlock.matchAll(/span: (\d+)/g)].map((m) => Number(m[1]))
    expect(spans.length, '骨架格子数量应与默认可见布局一致（8 卡 + 页脚 = 9 格）').toBe(9)
    expect(skel, '骨架渲染还有 gridRow').not.toMatch(/gridRow/)
  })

  it('卡片内容**不滚动也不裁切**（高度随内容，内容撑开卡片）', () => {
    const css = read('annual.module.css')
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code, '.cardBody 必须是 overflow: visible（高度随内容）')
      .toMatch(/\.cardBody \{[\s\S]{0,300}overflow: visible/)
    expect(code, '.cardBody 又退回 overflow-y: auto 了 ⇒ 滚动条回来了')
      .not.toMatch(/\.cardBody \{[\s\S]{0,300}overflow-y: auto/)
    expect(code, '.moreCard 必须是 overflow: visible').toMatch(/\.moreCard \{[\s\S]{0,300}overflow: visible/)
    expect(code, '.moreCard 又退回 overflow-y: auto 了').not.toMatch(/\.moreCard \{[\s\S]{0,300}overflow-y: auto/)
    expect(code, '.moreCard 内容区的滚动规则还在').not.toMatch(/\.moreCard > :not\(\.moreCardHead\) \{[\s\S]{0,200}overflow-y: auto/)
  })

  it('卡片内容不许"空洞"：正文顶部对齐 + 每张卡都有多块内容', () => {
    const css = read('annual.module.css')
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const annual = stripComments(read('Annual.tsx'))
    const more = stripComments(read('annual-more-cards.tsx'))

    expect(code, '.cardBody 又用 space-between 了 ⇒ 内容会被拉散、中间留大片空白')
      .not.toMatch(/\.cardBody \{[\s\S]{0,300}justify-content: space-between/)
    expect(code, '.cardBody 应顶部对齐').toMatch(/\.cardBody \{[\s\S]{0,300}justify-content: flex-start/)

    const SHELLS = new Set(['MoreCard', 'Card'])
    const cardFns = [...annual.matchAll(/function (\w+Card)\([\s\S]*?\n\}/g), ...more.matchAll(/export function (\w+Card)\([\s\S]*?\n\}/g)]
      .filter((m) => !SHELLS.has(m[1] ?? ''))
    expect(cardFns.length, '一张卡都没扫到 ⇒ 判据写错了').toBeGreaterThan(15)
    const thin: string[] = []
    for (const m of cardFns) {
      const body = m[0]
      const classes = new Set([...body.matchAll(/css\.(\w+)/g)].map((x) => x[1]))
      if (classes.size < 2) thin.push(`${m[1]}（只有 ${String(classes.size)} 个样式类）`)
    }
    expect(thin, `这些卡内容太单薄（只有 1 块），会显得空洞：\n  ${thin.join('\n  ')}`).toEqual([])

    for (const [name, marker] of [
      ['HeroCard', 'heroRate'],          // 活跃率条
      ['NightCard', 'heroRate'],         // 深夜占比条
      ['ReplyCard', 'heroRate'],         // 中位数→九成 跨度条
      ['WordsCard', 'ratio'],            // 收发字数对比条
      ['OpenerCard', 'ratio'],           // 你先/TA 先 对比条
      ['CatchphraseCard', 'chipBar'],    // 口头禅占比条
      ['EmojiCard', 'emojiBar'],         // 表情占比条
    ] as const) {
      const fn = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`).exec(annual)?.[0] ?? ''
      expect(fn, `${name} 缺少填充元素 css.${marker}（原先这张卡填充率很低）`)
        .toMatch(new RegExp(`css\\.${marker}(?![A-Za-z0-9_])`))
    }
  })

  it('卡片**不许出现滚动条**（用户 2026-10-17："不要出现滚动条"）', () => {
    const css = read('annual.module.css')
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code, '行高必须是 auto').toMatch(/\.board \{[\s\S]{0,400}grid-auto-rows: auto/)
    expect(code, 'align-items 必须是 start').toMatch(/\.board \{[\s\S]{0,400}align-items: start/)
    const scrollRules = [...code.matchAll(/\.(card|cardBody|moreCard|skelCard)[^{]*\{[^}]*overflow-y: (auto|scroll)/g)]
      .map((m) => m[0].slice(0, 60))
    expect(scrollRules, `这些规则会产生滚动条：\n  ${scrollRules.join('\n  ')}`).toEqual([])
    const cardPad = /\.card \{[\s\S]{0,400}padding: ([^;]+);/.exec(code)?.[1]
    const skelPad = /\.skelCard \{[\s\S]{0,400}padding: ([^;]+);/.exec(code)?.[1]
    expect(cardPad, '找不到 .card 的 padding').toBeDefined()
    expect(skelPad, '骨架内边距与真实卡片不一致 ⇒ 加载完会跳一下').toBe(cardPad)
  })
})
