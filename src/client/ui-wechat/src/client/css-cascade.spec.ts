/**
 * 「这两个超限 CSS 拆得动吗」的尺子本身要有单测 —— 判据一错，结论就反了。
 *
 * 为什么值得单独钉：`docs/RELEASE-PLAN.md` 里 2026-09-22 那条勘测写着「最大不可分簇 1140 / 1113 行
 * ⇒ 拆不到 1000」，而这份实现算出来的是 674 / 385。两边不可能都对，而**差在哪一处口径**决定了
 * 要不要去做一次层叠语义改写（那是有 UI 风险的活）。差异就一条：
 * `:global(.theme-light)` 里的类名 **CSS Modules 不给它打 hash**，因此它不构成「必须同份」的约束；
 * 把它当枢纽类连进闭包，会把整份文件的规则串成一团（onboarding 有 41 条规则带它）。
 * 下面 `:global 不参与「必须同份」闭包（口径分歧就钉在这里）` 那一条就是把这条分歧写成可执行的口径，
 * 谁改这个口径都会被红拦住，而不是再靠两份一次性脚本各算各的数。
 *
 * 另防空转：真文件的解析结果只断言结构（叶子数、关键帧数、`:global` 名字不许出现在簇符号里），
 * **不冻结**那几个簇行数 —— 它们正是这一轮要动的量。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  clustersOf, coOccurrencesFromSources, contiguousCuts, dangerPairs, hasCombinator,
  normDecl, normSel, orderSplits, pack, parseSource, propsOf, sourceClasses,
  specificity, summarize, weakLinks, animatedNames,
} from './css-cascade.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 把 `clustersOf` 的常走调用顺序压成一个函数，测试里好写。 */
function clusterOf (css: string, extraLinks: Array<[string, string]> = []): ReturnType<typeof clustersOf> {
  const parsed = parseSource(css)
  const weak = weakLinks(parsed)
  return clustersOf([...weak.links, ...extraLinks], weak.owner, parsed.frames, parsed.leaves)
}

describe('parseSource：行号与选择器都要算准（算错就是「拆不动」与「能拆」的区别）', () => {
  const CSS = [
    '/* 头注释',
    '   第二行 */',
    '.shell { color: red }',
    '@media (min-width: 600px) {',
    '  .panel .msgRow {',
    '    padding: 1px;',
    '  }',
    '}',
    ':global(.theme-light) .shell { color: blue }',
    '@keyframes drift { from { opacity: 0 } to { opacity: 1 } }',
    '.card { animation: drift 9s linear infinite }',
    '.lonely {',
    '  margin: 0;',
    '}',
  ].join('\n')
  const P = parseSource(CSS)

  it('叶子规则按行给区间，@media 只作为前缀、内部规则才是叶子', () => {
    const sels = P.leaves.map((l) => l.at + '||' + l.sel + '||' + String(l.a) + '-' + String(l.b))
    expect(sels.join('\n'), '这一份小样子里应该正好 5 条叶子规则（行号 0 基；紧贴规则的整行注释算进它下面那条规则，所以 .shell 从第 0 行起）').toBe([
      '||.shell||0-3',
      '@media (min-width: 600px)||.panel .msgRow||4-7',
      '||:global(.theme-light) .shell||8-9',
      '||.card||10-11',
      '||.lonely||11-14',
    ].join('\n'))
  })

  it('注释与空行：紧贴规则的整行注释跟着规则走，空行不跟', () => {
    const p2 = parseSource('/* a\nb */\n.x { color: red }')
    expect(p2.leaves[0]?.a, '注释紧贴 ⇒ 从注释那行起算（拆文件时那几行跟着搬，占的就是那几行）').toBe(0)
    expect(p2.leaves[0]?.b, '规则自己那一行结束 ⇒ 左闭右开到第 3 行').toBe(3)
    const p4 = parseSource('/* c */\n\n.x { color: red }')
    expect(p4.leaves[0]?.a, '注释与规则之间隔了空行 ⇒ 不吸进来（否则整份文件的开头都会被算进第一条规则）').toBe(2)
  })

  it('@keyframes 单独收，不当叶子规则混进规则数里', () => {
    expect(P.frames.map((f) => f.name).join(',')).toBe('drift')
    expect(P.leaves.some((l) => l.sel.includes('from')), '关键帧里的 `from` 不该被当成一条规则').toBe(false)
  })

  it('多行选择器列表合成一条（两条都算进同一簇，正是要的效果）', () => {
    const p = parseSource('.a,\n.b {\n  color: red;\n}')
    expect(p.leaves.length, '`.a,\\n.b` 是一个规则头 ⇒ 一条叶子').toBe(1)
    expect((p.leaves[0]?.classes ?? []).join(',')).toBe('a,b')
  })
})

describe('sourceClasses：哪些类名构成「必须同份」，哪些不构成', () => {
  it(':global 里的名字单独一组（它不哈希 ⇒ 分家之后仍然对得上）', () => {
    expect(JSON.stringify(sourceClasses(':global(.theme-light) .shell'))).toBe('{"locals":["shell"],"globals":["theme-light"]}')
    expect(sourceClasses('.a .b > span').locals).toEqual(['a', 'b'])
    expect(sourceClasses('.x[data-y="z"]:hover').locals).toEqual(['x'])
    expect(sourceClasses('div').locals).toEqual([])
  })
})

describe('weakLinks + clustersOf：「同名类必须同份」这条闭包怎么算', () => {
  it('一条规则里的两个类连成一簇，且那一行只算一次（第一版按符号累加会数两遍）', () => {
    const css = '.a .b { color: red }\n.c { color: blue }'
    const cs = clusterOf(css)
    expect(cs.length, '两簇：{a,b} 与 {c}').toBe(2)
    expect(cs.map((c) => c.lines).sort((x, y) => y - x).join(',')).toBe('1,1')
    const ab = cs.find((c) => c.symbols.has('c:a'))
    expect(ab?.symbols.has('c:b'), 'a 与 b 必须在同一簇').toBe(true)
    expect(ab?.rules, '`.a .b` 是一条规则，不是两条').toBe(1)
  })

  it('没有局部类名的规则不受约束 ⇒ 每条各自一簇（不许串成一个大全簇）', () => {
    const cs = clusterOf('p { color: red }\ndiv > span { color: blue }\n:root { --x: 1 }')
    expect(cs.length, '三条互不相关的元素级规则 = 三簇').toBe(3)
    for (const c of cs) expect(c.lines, '每条一行').toBe(1)
  })

  it('animation 引用的 @keyframes 跟着引用者走；没人引用的自己占一簇', () => {
    const cs = clusterOf('.x { animation: drift 1s }\n@keyframes drift { from { opacity: 0 } }\n@keyframes unused { from { opacity: 0 } }')
    const x = cs.find((c) => c.symbols.has('c:x'))
    expect(x?.symbols.has('k:drift'), 'drift 必须和引用它的规则同份（名字也按文件打 hash）').toBe(true)
    expect(x?.lines, '规则 1 行 + 关键帧块 1 行').toBe(2)
    expect(cs.some((c) => c.symbols.has('k:unused')), '没人引用的关键帧也是「必须同份」的一团（它就是自己）').toBe(true)
  })

  it('没有局部类名的规则引用了关键帧 ⇒ 也必须与那块 @keyframes 同份（变异 m3 就是这条逼出来的）', () => {
    const cs = clusterOf('div { animation: drift 1s }\n@keyframes drift { from { opacity: 0 } }')
    expect(cs.length, '规则与关键帧是一簇（名字的 hash 也按文件算，分家就接不上）').toBe(1)
    expect(cs[0]?.symbols.has('k:drift')).toBe(true)
    expect(cs[0]?.lines, '规则 1 行 + 关键帧 1 行').toBe(2)
  })

  it('同一类名出现在多条规则里 ⇒ 全部串成一簇，哪怕中间隔着别的类', () => {
    const cs = clusterOf('.a { color: red }\n.b { color: blue }\n.a .b { padding: 0 }')
    expect(cs.length, 'a 与 b 被第三条规则连起来 ⇒ 一簇').toBe(1)
    expect(cs[0]?.lines).toBe(3)
  })

  it('animatedNames 只认 animation 相关的声明，且不被同名前缀骗到', () => {
    const p = parseSource('.x { transition: drift 1s; animation-name: flow }\n@keyframes drift { from { opacity: 0 } }\n@keyframes flow { from { opacity: 0 } }')
    const leaf = p.leaves[0]
    if (leaf === undefined) throw new Error('没解析出规则')
    expect(animatedNames(leaf, p.frames).join(','), 'transition 里的 drift 不算动画名').toBe('flow')
  })
})

describe('contiguousCuts + orderSplits：保序连续切到底有没有刀口', () => {
  it('类名跨度盖住的行边界都不许切', () => {
    const p = parseSource('.a { color: red }\n.b { color: blue }\n.a { padding: 0 }')
    expect(contiguousCuts(p, 10).join(','), '`.a` 从第 1 行跨到第 3 行 ⇒ 中间一个合法切点都没有（行尾那根按定义不算切点）').toBe('')
    expect(orderSplits(contiguousCuts(p, 10), p.lines, 1), '上限 1 行而唯一的边界在文件末尾 ⇒ 无解').toBe(null)
    const p2 = parseSource('.a { color: red }\n.a { padding: 0 }\n.b { color: blue }')
    expect(contiguousCuts(p2, 10).join(','), 'a 的两条规则连着，它结束之后的那个边界可以切').toBe('2')
  })

  it('切点够用时给出行数；同名类从头跨到尾时一个切点都没有（两份超限 CSS 的真实情形）', () => {
    const ok = parseSource('.a { color: red }\n.a { padding: 0 }\n\n.b { color: blue }\n.b { margin: 0 }')
    const okCuts = contiguousCuts(ok, 10)
    expect(okCuts.join(','), '第 3 行（空行）与它之后各有一个合法边界').toContain('2')
    const whole = parseSource('.x { color: red }\n.y { color: blue }\n.x { margin: 0 }')
    expect(contiguousCuts(whole, 100).length, '`x` 从头跨到尾 ⇒ 中间没有合法切点（末尾边界不算切点）').toBe(0)
  })
})

describe('dangerPairs：分了家会因产物次序而变样式的类对', () => {
  const CO = new Set(['btn + btnPrimary'])
  it('同特异性 + 抢同一条属性 ⇒ 危险', () => {
    const p = parseSource('.btn { color: red }\n.btnPrimary { color: blue }')
    const d = dangerPairs(p, CO)
    expect(d.length).toBe(1)
    expect(d[0]?.pair).toBe('btn + btnPrimary')
    expect(d[0]?.why).toContain('color')
  })

  it('特异性不同 ⇒ 谁赢与次序无关，不算危险', () => {
    const p = parseSource('.btn { color: red }\n.btnPrimary.x { color: blue }')
    expect(dangerPairs(p, CO).length, '第二条特异性更高').toBe(0)
  })

  it('属性不重叠 ⇒ 各写各的，不算危险', () => {
    const p = parseSource('.btn { color: red }\n.btnPrimary { margin: 0 }')
    expect(dangerPairs(p, CO).length).toBe(0)
  })

  it('带后代/组合选择器一律保守算危险（祖先信息在源文件里判不出来）', () => {
    const p = parseSource('.btn > i { color: red }\n.btnPrimary { margin: 0 }')
    const d = dangerPairs(p, CO)
    expect(d.length).toBe(1)
    expect(d[0]?.why).toContain('保守判危险')
  })

  it('@media 里的规则同样参与（两份文件里都有媒体查询变体）', () => {
    const p = parseSource('@media (min-width: 600px) {\n  .btn { color: red }\n}\n.btnPrimary { color: blue }')
    expect(dangerPairs(p, CO).length).toBe(1)
    expect(p.leaves[0]?.at).toBe('@media (min-width: 600px)')
  })
})

describe('coOccurrencesFromSources：从消费者源码里看「同一元素带哪两个类」', () => {
  it('模板串与 cx() 拼接都算共现；单个类不算', () => {
    const s = coOccurrencesFromSources([
      'const A = <div className={`${css.a} ${css.b}`} />',
      'const B = <div className={cx(css.c, css.d)} />',
      'const C = <div className={css.e} />',
    ])
    expect([...s].sort().join(' | ')).toBe('a + b | c + d')
  })

  it('同一表达式里出现三次 ⇒ 两两都配对（3 对），且不自配对', () => {
    const s = coOccurrencesFromSources(['<div className={`${css.a} ${css.b} ${css.c}`} />'])
    expect([...s].sort().join(' | ')).toBe('a + b | a + c | b + c')
  })
})

describe('小工具：归一、特异性、装箱', () => {
  it('normSel / normDecl 把空白与逗号周围的空格压掉', () => {
    expect(normSel('.a   >   .b ,  .c')).toBe('.a>.b,.c')
    expect(normDecl(' color :   red ;  margin:0 ;  ')).toBe('color:red;margin:0')
  })

  it('specificity：id×100 + 类/属性/伪类×10 + 类型/伪元素', () => {
    expect(specificity('.a')).toBe(10)
    expect(specificity('.a .b')).toBe(20)
    expect(specificity('.a[data-x]')).toBe(20)
    expect(specificity('#i .a p')).toBe(111)
    expect(specificity('.a:hover')).toBe(20)
    // `::before` 被既有的正则数成「类级」（`:(?!:)` 只挡得住第一个冒号）—— 与 css-bundle-diff 同一支。
    // 这里保持原样而不是顺手修对：这个数**只用来判两边等不等**，等不等才是判据、绝对值不是。
    expect(specificity('.a::before'), '伪元素按既有实现算作类级（与 css-bundle-diff 一致）').toBe(20)
  })

  it('hasCombinator 不把属性选择器里的空格当组合符', () => {
    expect(hasCombinator('.a[data-x = "y z"]')).toBe(false)
    expect(hasCombinator('.a .b')).toBe(true)
  })

  it('propsOf 取声明的属性名（含 @media 内层）', () => {
    expect([...propsOf('color:red;margin:0')].join(',')).toBe('color,margin')
    expect([...propsOf('')]).toEqual([])
  })

  it('pack：超上限的那件自己占一份（不是塞爆某一份），恰好等于上限能装下', () => {
    expect(pack([1200, 300, 300, 400], 1000).join(','), '1200 那件塞不进任何一份 ⇒ 自己占一份；剩下三件恰好装进另一份').toBe('1200,1000')
    expect(pack([500, 500], 1000).join(',')).toBe('1000')
    expect(pack([], 1000).join(',')).toBe('')
  })
})

describe('summarize 的输出形状（脚本直接印这几行，判据与呈现不许两套口径）', () => {
  const parsed = parseSource('.a { color: red }\n.b { color: blue }')
  const weak = clusterOf('.a { color: red }\n.b { color: blue }')
  it('拆得动的时候把代价说清楚', () => {
    const out = summarize('x.module.css', parsed, weak, weak, 1000, 1, 1, [1])
    expect(out.length).toBe(4)
    expect(out[3]).toContain('代价是规则次序会变')
    expect(out[3]).toContain('css:bundle-diff')
  })

  it('拆不动的时候点名是哪个簇挡的路', () => {
    const two = clusterOf('.a { color: red }\n.a { color: blue }\n.b { color: blue }')
    expect(two[0]?.lines, '样例里 a 那一簇是 2 行（上限设成 1 才叫装不下）').toBe(2)
    const out = summarize('x.module.css', parsed, two, two, 1, 1, 1, [])
    expect(out[3]).toContain('不改层叠语义拆不动')
    expect(out[2]).toContain('切不出')
  })

  it('一对共现都没匹配上时必须自己喊「不算数」（新判据最坏的一种失效是看着像安全）', () => {
    const out = summarize('x.module.css', parsed, weak, weak, 1000, 0, 0, [1])
    expect(out[1]).toContain('不算数')
  })
})

describe('差分：与「反复合并」的暴力算法比簇（随机小样，独立实现）', () => {
  /** 线性同余：固定种子的随机数 —— 语料要能复现，否则红的时候无法复盘。 */
  function lcg (seed: number): () => number {
    let s = seed
    return () => {
      s = (s * 1103515245 + 12345) % 2147483648
      return s / 2147483648
    }
  }

  const cases: Array<{ css: string, want: number }> = []
  const rnd = lcg(20260924)
  for (let c = 0; c < 60; c += 1) {
    const rules = 3 + Math.floor(rnd() * 12)
    const lines: string[] = []
    for (let r = 0; r < rules; r += 1) {
      const n = 1 + Math.floor(rnd() * 2)
      const cs = Array.from({ length: n }, () => 'c' + String(Math.floor(rnd() * 5))).join(' .')
      lines.push('.' + cs + ' { color: red; padding: 0 }')
    }
    cases.push({ css: lines.join('\n'), want: 0 })
  }
  void rnd

  it('语料不空转：里面确实有多类名规则与跨规则的同类名', () => {
    const multi = cases.filter((x) => x.css.includes(' .c')).length
    expect(multi, '没有「一条规则两个类」的样本，差分就是在比一个没被走到的分支').toBeGreaterThan(5)
    const reused = cases.filter((x) => parseSource(x.css).leaves.length > 4).length
    expect(reused, '规则太少等于在比一个空集合').toBeGreaterThan(20)
  })

  it('每份的「最大簇行数」与暴力算法一致', () => {
    const bad: string[] = []
    for (const [k, item] of cases.entries()) {
      const p = parseSource(item.css)
      const got = clusterOf(item.css)[0]?.lines ?? 0
      // 暴力实现：给「共享类名的规则」建图，取连通块，块内行数求和 —— 不看并查集、不看符号，
      // 与实现走的是两条路（实现按符号并，这里按规则下标并）。
      const n = p.leaves.length
      const linked = new Set<string>()
      for (let a = 0; a < n; a += 1) {
        for (let b = a + 1; b < n; b += 1) {
          const sa = p.leaves[a]?.classes ?? []
          const sb = p.leaves[b]?.classes ?? []
          if (sa.some((c) => sb.includes(c))) linked.add(`${String(a)}-${String(b)}`)
        }
      }
      const edge = (a: number, b: number): boolean => linked.has(`${String(Math.min(a, b))}-${String(Math.max(a, b))}`)
      const seen = new Set<number>()
      let max = 0
      for (let s = 0; s < n; s += 1) {
        if (seen.has(s)) continue
        const stack = [s]
        seen.add(s)
        let lines = 0
        for (; stack.length > 0;) {
          const cur = stack.pop()
          if (cur === undefined) continue
          lines += (p.leaves[cur]?.b ?? 0) - (p.leaves[cur]?.a ?? 0)
          for (let t = 0; t < n; t += 1) {
            if (edge(cur, t) && !seen.has(t)) {
              seen.add(t)
              stack.push(t)
            }
          }
        }
        if (lines > max) max = lines
      }
      if (max !== got) bad.push(`样例 ${String(k)}：暴力 ${String(max)} vs 实现 ${String(got)}\n${item.css}`)
    }
    expect(bad.slice(0, 2).join('\n---\n'), '两种算法给出的最大簇不一致 ⇒ 至少一处算错').toBe('')
  })
})

describe('两份超限 CSS：只做结构性防空转（簇的行数这一轮要动，不冻结）', () => {
  const FILES = [
    'pages/wechat-data/panels/chats.module.css',
  ]

  it('真文件解析出来的规模与勘测一致（解析口径坏了这里就红）', () => {
    for (const rel of FILES) {
      const p = parseSource(readFileSync(join(HERE, rel), 'utf8'))
      expect(p.leaves.length, `${rel} 只解析出 ${String(p.leaves.length)} 条叶子规则 —— 解析口径坏了`).toBeGreaterThan(400)
      expect(p.frames.length, `${rel} 的关键帧要收进来（它们也按文件打 hash）`).toBeGreaterThanOrEqual(1)
    }
  })

  it(':global 里的类名一律不许进「必须同份」的符号表（口径分歧钉死在这一条）', () => {
    const p = parseSource(readFileSync(join(HERE, 'pages/wechat-data/panels/chats.module.css'), 'utf8'))
    const globals = new Set(p.leaves.flatMap((l) => l.globals))
    expect(globals.size, '这份文件里本来就该有 :global 的类名，没有的话这条判据就是空的').toBeGreaterThan(0)
    const weak = weakLinks(p)
    for (const g of globals) {
      expect(weak.owner.has('c:' + g), `:global(.${g}) 被当成局部类连进了闭包 —— 它不哈希，不构成约束`).toBe(false)
    }
  })
})
