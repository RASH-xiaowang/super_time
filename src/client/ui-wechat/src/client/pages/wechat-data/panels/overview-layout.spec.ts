/**
 * 总览布局守卫（源码级）。
 *
 * 为什么需要它：本轮把「微信数据总览」的留白清掉时，发现三类**看代码看不出来**的坑，
 * 它们在浏览器里才现形，而仓库里的用例当时全绿：
 *
 *  ① **类名没接到 JSX 上**：`overview.module.css` 里写了 `.ovTrend .trendGrid { auto-fit }`
 *     等三条规则，但 JSX 从未渲染过 `ovTrend`，三条全是死的 —— 5 个指标因此排成 3 行，
 *     一张卡凭空高 110px。`ovWorld` 同理。
 *     注意：`.ovCard :global(.avatarRailLeft)` 也**没用** —— `:global()` 只会发出裸类名
 *     `.avatarRailLeft`，而实际元素带的是另一个模块的哈希类名 `_avatarRailLeft_xxxx`，
 *     永远匹配不到。跨模块覆盖只能用属性子串选择器 `[class*='avatarRail']`。
 *
 *  ② **栅格空洞**：6 栅格卡片数量为奇数时，总会有一张独占一行、旁边空 6 栅格（实测
 *     那块空洞是 770×814px，全面板最大的一处留白）。所以 6 栅格卡片的数量必须是偶数。
 *
 *  ③ **图省事的固定高**：`.ovTall { min-height: 420px }`、地图画布 520px 这类"整页尺寸"
 *     放进一屏纵览，内容撑不满就变成空白。这些已经交给内容决定。
 *
 * 布局的**真实**效果（空白占比、是否有空洞）由 `scripts/overview-layout-audit.mjs`
 * 在真实 Electron + 真实解密数据下量出来，这里只锁住源码层面的形状。
 * @vitest-environment node
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
// M21 把 Overview.tsx 拆成 overview-export/parts/panel + 转发桶；源码类断言的读取面改成
// **全部 overview* 源码的联合**（断言本身不变，文件再搬家也不会误报）。
const tsx = readdirSync(HERE).filter((f) => /^overview(-[a-z]+)?\.(ts|tsx)$/.test(f)).sort().map((f) => readFileSync(join(HERE, f), 'utf8')).join('\n')
const css = readFileSync(join(HERE, 'overview.module.css'), 'utf8')
const board = readFileSync(join(HERE, 'RegionBoard.tsx'), 'utf8')

/** 去掉注释：注释里提到旧做法不该影响断言（本文件自己也提到 `:global`）。 */
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const tsxCode = strip(tsx)
const cssCode = strip(css)

/** 出现次数。 */
const count = (hay: string, needle: string): number => hay.split(needle).length - 1

describe('总览布局：卡片分组不留空洞', () => {
  it('12 栅格体系里，6 栅格卡片必须成对（奇数就会出现独占一行的空洞）', () => {
    const six = count(tsxCode, 'css.ovSpan6')
    const twelve = count(tsxCode, 'css.ovSpan12')
    const four = count(tsxCode, 'css.ovSpan4')
    const eight = count(tsxCode, 'css.ovSpan8')
    expect(six, `6 栅格卡片 ${six} 张，必须是偶数`).toBeGreaterThanOrEqual(6)
    expect(six % 2, `6 栅格卡片 ${six} 张为奇数 → 会有一行只放一张卡`).toBe(0)
    // 4+8 必须成对，否则同样会空出 4 或 8 栅格
    expect(four, '4 栅格与 8 栅格卡片数必须相等（它们同行配对）').toBe(eight)
    expect(twelve).toBeGreaterThanOrEqual(2)
  })

  it('世界板块卡片内含地图与地区榜单（地图单独占 12 栅格时右侧全是空白）', () => {
    expect(tsxCode).toContain('<RegionBoard />')
    expect(tsxCode).toContain('css.worldBoard')
    expect(tsxCode).toContain('css.worldMapBox')
    expect(board).toContain('apiGetRegionMap')
    // 榜单渲染省份与城市两栏
    expect(board).toContain('省份 Top 10')
    expect(board).toContain('城市 Top 12')
  })
})

describe('总览样式：跨模块覆盖必须能命中', () => {
  it('不得再用 `:global(.局部类名)` 覆盖别的 CSS Module（只会发出裸类名，永远匹配不到哈希类）', () => {
    expect(cssCode).not.toMatch(/:global\(/)
  })

  it('跨模块覆盖走属性子串选择器，且覆盖到地图的高度链与两侧头像栏', () => {
    for (const k of ['stage', 'mapFrame', 'china3d', 'avatarRail']) {
      expect(cssCode, `缺少 [class*='${k}'] 覆盖`).toContain(`[class*='${k}']`)
    }
    // 高度链断了任何一环，520px 的画布都会重新顶出来
    expect(cssCode).toMatch(/\.worldMapBox canvas/)
  })

  it('JSX 上写了的布局类，样式里必须有对应规则；反之亦然（防止规则变死）', () => {
    for (const cls of ['ovTrend', 'ovHeat', 'worldBoard', 'worldMapBox']) {
      expect(tsxCode, `JSX 未使用 css.${cls}，对应样式规则会是死的`).toContain(`css.${cls}`)
      expect(cssCode, `样式缺少 .${cls} 规则`).toContain(`.${cls}`)
    }
    // 反向：JSX 用到的每个 ovXxx 类都要在样式里有定义，否则 className 会渲染成字符串 "undefined"
    const used = [...new Set([...tsxCode.matchAll(/css\.(ov[A-Za-z0-9]+)/g)].map(m => m[1]))]
    expect(used.length).toBeGreaterThan(6)
    for (const cls of used) {
      expect(cssCode, `JSX 用了 css.${cls}，但 overview.module.css 没有定义它`).toContain(`.${cls}`)
    }
  })

  it('不再有把卡片顶高的固定 min-height（内容撑不满就是空白）', () => {
    expect(cssCode).not.toMatch(/\.ovTall\s*\{[^}]*min-height:\s*4\d\dpx/)
    expect(cssCode).toMatch(/\.ovTall\s*\{\s*min-height:\s*0/)
  })

  it('同行卡片高度差由卡内元素吸收（指标格/健康格/资产格要竖直居中，列表要均分）', () => {
    expect(cssCode).toMatch(/\.metric,\s*\.healthItem,\s*\.assetItem\s*\{[^}]*justify-content:\s*center/)
    expect(cssCode).toMatch(/\.ovCardBd > \.metricGrid[^{]*\{[^}]*flex:\s*1 1 auto/)
    expect(cssCode).toMatch(/\.ovCardBd:has\(> \.revoke\)/)
  })
})

describe('总览内容：标题与实际条目一致', () => {
  it('「存储构成 Top N」要把 N 条都渲染出来（此前标题写 Top 7、只渲染 4 条）', () => {
    expect(tsxCode).toMatch(/存储构成 Top \$\{data\.storage\.categories\.length\}/)
    expect(tsxCode, '不应再对分类做 slice(0, 4)').not.toMatch(/storage\.categories\.slice\(/)
    // 条形按体积画，所以顺序也按体积排，否则第一行不是最长的条
    expect(tsxCode).toMatch(/sort\(\(a, b\) => b\.size - a\.size\)/)
  })

  it('资金快照标题在缺月份时不留一个孤零零的分隔点', () => {
    expect(tsxCode).toContain("资金快照${ledger?.month ? ` · ${ledger.month}` : ''}")
  })
})
