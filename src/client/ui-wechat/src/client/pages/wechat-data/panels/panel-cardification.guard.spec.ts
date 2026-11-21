/**
 * 「统计/体检类面板也走等宽瀑布流画布」（2026-11-19）。
 *
 * ## 为什么改这三个
 *
 * 用户要求「检查所有功能界面，评估哪些还能这样卡片化，如果可以直接改造」。
 * 全仓 35 个页签逐个评估后（见 CHANGELOG 的判定表），只有这三个满足
 * **「多块独立内容 + 高度差异大」** 这两个前提 —— 也正好是画布唯一能带来收益的场景：
 *
 * | 面板 | 旧布局的问题 |
 * |---|---|
 * | 数据健康 | 「损坏的库」可能装三组列表 + 三段说明（上千像素），旁边「DB 状态摘要」只有两行；两列栅格把它们拉成等高，矮卡下方大片空白 |
 * | 收藏表情统计 | 两张分布卡靠 `fill` 撑满面板高、列表在卡内滚 —— 两行数据也占满整屏 |
 * | 数据边界与出网 | 六张卡高度差极大（三段长文 vs 一行摘要），栅格同样拉平等高 |
 * | 朋友圈洞察 | 两行栅格把卡拉到等高：两个互动榜各 5 行却占满一整行高度、热词卡下方一片空白 |
 *
 * ## 为什么不改其余面板（判定依据写在这里，免得下次重新评估）
 *
 * · **列表/表格是本体**：操作日志（6 列可排序表 + 表头拖列宽 + 每页 100 的上限）、
 *   媒体资产、公众号文章、文件与存储、聊天会话、通讯录 —— 卡片化会同时丢掉列对齐、
 *   排序与虚拟滚动。
 * · **定高分栏是刻意的对照**：群聊监控是「340px 热力日历 vs 消息流」的宏观/明细对照。
 * · **已经是等宽瓷砖**：原图链路自检是固定 4 列瓷砖，本身就是对齐的视觉基线。
 * · **单卡页面**：媒体资产/公众号只有「KPI 条 + 一张表」，瀑布流无收益。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { packCanvas } from './card-canvas-layout.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (f: string): string => readFileSync(join(HERE, f), 'utf8')
/** 剥注释（说明里会引用旧写法）。 */
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** 三个已卡片化的面板：文件 → 必须存在的 canvasId 前缀。 */
const CARDIFIED: ReadonlyArray<{ file: string; scope: string; ids: readonly string[] }> = [
  {
    file: 'Health.tsx',
    scope: 'health',
    ids: ['health-stores', 'health-failures', 'health-status'],
  },
  {
    file: 'health-integrity.tsx',
    scope: '',
    ids: ['health-integrity-error', 'health-integrity-pending', 'health-integrity-ok',
      'health-corrupted', 'health-unreadable', 'health-uncheckable'],
  },
  {
    file: 'AssetInsights.tsx',
    scope: 'asset-insights',
    ids: ['asset-types', 'asset-years'],
  },
  {
    file: 'PrivacyTrust.tsx',
    scope: 'privacy-trust',
    ids: ['trust-boundary', 'trust-guard', 'trust-local', 'trust-ai', 'trust-audit', 'trust-scan'],
  },
  {
    file: 'MomentsInsights.tsx',
    scope: 'moments-insights',
    // 2026-11-19 二次调整：互动榜拆成「点赞最多 / 评论最多」两张卡，
    // 足迹拆成「地图 / 打卡最多的地方」两张卡。
    ids: ['moments-liked', 'moments-commented', 'moments-monthly', 'moments-map', 'moments-places'],
  },
]

describe('统计/体检类面板走画布', () => {
  it('每张卡都带 canvasId（不带就退回文档流 ⇒ 会被绝对定位的卡压住）', () => {
    for (const panel of CARDIFIED) {
      const code = strip(read(panel.file))
      for (const id of panel.ids) {
        expect(code, `${panel.file} 缺少 canvasId="${id}"`).toContain(`id="${id}"`)
      }
    }
  })

  it('承载卡片的容器是 CardCanvas，且带独立 scope（位置与其它面板隔离）', () => {
    for (const panel of CARDIFIED) {
      if (panel.scope === '') continue
      const code = strip(read(panel.file))
      expect(code, `${panel.file} 没走画布`).toContain('<CardCanvas')
      expect(code, `${panel.file} 的画布缺 scope="${panel.scope}"`)
        .toMatch(new RegExp(`<CardCanvas[^>]*scope="${panel.scope}"`))
    }
  })

  it('已卡片化的面板里不许再出现 Bootstrap 栅格或 kit 两列卡片网格', () => {
    for (const panel of CARDIFIED) {
      const code = strip(read(panel.file))
      expect(code, `${panel.file} 还在用 .row g-2`).not.toMatch(/className="row g-2"/)
      expect(code, `${panel.file} 还在用 kitCss.cardGrid`).not.toContain('kitCss.cardGrid')
    }
  })

  it('KPI 横条留在画布外（它是"一眼看的几个数"，不该被当成可拖拽的卡）', () => {
    // 数据健康用 StatGrid、收藏统计用 insightBar —— 两者都必须在 <CardCanvas> 之前。
    for (const [file, marker] of [
      ['Health.tsx', '<StatGrid>'],
      ['AssetInsights.tsx', 'css.insightBar'],
    ] as const) {
      const code = strip(read(file))
      const kpiAt = code.indexOf(marker)
      const canvasAt = code.indexOf('<CardCanvas')
      expect(kpiAt, `${file} 找不到 KPI 条`).toBeGreaterThan(-1)
      expect(canvasAt, `${file} 找不到画布`).toBeGreaterThan(-1)
      expect(kpiAt, `${file} 的 KPI 条被塞进画布里了`).toBeLessThan(canvasAt)
    }
  })

  it('朋友圈词云进画布：带 canvasId 且**不用 fill**（避免与卡片高度循环依赖）', () => {
    const code = strip(read('MomentsInsights.tsx'))
    const at = code.indexOf('<WordCloudCard')
    expect(at, '找不到朋友圈词云').toBeGreaterThan(-1)
    const tag = code.slice(at, code.indexOf('/>', at))
    expect(tag, '词云卡必须带 canvasId').toContain('canvasId="moments-words"')
    // `fill` 是「量卡片根高度」反推舞台高度；画布卡的高度又是量 offsetHeight 得来的，
    // 两者互为因果，舞台会塌成 0（词云整块空白）。
    expect(tag, '画布里的词云不能用 fill').not.toContain('fill')
    expect(tag, '画布里的词云必须给显式高度').toMatch(/height=\{\d+\}/)
  })

  it('朋友圈的两张横长卡占 2 列（词云 / 地图）', () => {
    const code = strip(read('MomentsInsights.tsx'))
    // 地图卡：`cols={2}` 必须与 id 落在同一个标签里。
    const mapAt = code.indexOf('id="moments-map"')
    expect(mapAt, '找不到地图卡').toBeGreaterThan(-1)
    const mapTag = code.slice(Math.max(0, mapAt - 300), mapAt + 40)
    expect(mapTag, '地图卡必须是 2 列（一列宽时地理图形只剩一条窄缝）').toContain('cols={2}')
    // 词云：跨列走 `canvasCols`（它自己渲染 CanvasCard，不直接暴露 cols）。
    const cloudAt = code.indexOf('<WordCloudCard scope="moments"')
    const cloudTag = code.slice(cloudAt, code.indexOf('/>', cloudAt))
    expect(cloudTag, '词云卡必须是 2 列（越宽字号越大、排布越接近圆形）').toContain('canvasCols={2}')
  })

  it('画布卡真的把跨列数写进 DOM（否则布局只认 1 列）', () => {
    // 布局是从 `data-canvas-cols` 读的，不是从 props 读的 —— 属性没写就等于没跨列。
    const card = strip(read('card-canvas-card.tsx'))
    expect(card).toContain("'data-canvas-cols'")
    // 词云自己的 CanvasCard 外壳必须把 canvasCols 透传下去，不能吞掉。
    const cloud = strip(read('WordCloudCard.tsx'))
    expect(cloud, '词云没把 canvasCols 透传给 CanvasCard').toContain('cols={canvasCols')
  })

  it('朋友圈足迹地图给足高度（ECharts 按容器短边算尺寸，220px 会缩成一小块）', () => {
    const code = strip(read('MomentsInsights.tsx'))
    const at = code.indexOf('<FootprintMap')
    expect(at, '找不到足迹地图').toBeGreaterThan(-1)
    const tag = code.slice(at, code.indexOf('/>', at))
    const m = /height=\{(\d+)\}/.exec(tag)
    expect(m, '地图必须显式给 height（缺省 220 太小）').not.toBeNull()
    // `GeoEchartsMap` 用 `layoutSize: '100%'`，地图尺寸 = 容器**短边**。
    // 卡片两列宽约 600px，所以高度必须 > 300 才轮到高度作短边、地图才铺得开。
    expect(Number(m?.[1]), '地图高度太小，短边仍是宽度、地图缩成一小块').toBeGreaterThan(300)
  })

  it('防空转：画布组件本身确实还在（否则上面的判据恒真）', () => {
    const canvas = strip(read('card-canvas.tsx'))
    expect(canvas, '找不到 CardCanvas 容器').toContain('export function CardCanvas')
    const card = strip(read('card-canvas-card.tsx'))
    expect(card, '找不到 CanvasCard 外壳').toContain('export function CanvasCard')
  })
})

/**
 * 用**真实卡片集合 + 代表性高度**跑一遍排版引擎，验证这几个面板不会重叠。
 *
 * 为什么值得单独测：它们与「数据总览」共用 `packCanvas`，但那边的卡片集合是
 * 固定 25 张；这几个面板的卡片数是**动态的**（体检结论有四态、解密失败卡可能不出现），
 * 且高度差异极大（损坏库上千像素 vs 状态摘要两行）。这里取最坏的组合验证「不重叠」。
 */
describe('这些面板的实际卡片集合排版不重叠', () => {
  const CASES: ReadonlyArray<{ name: string; heights: Record<string, number>; spans?: Record<string, number> }> = [
    {
      name: '数据健康（损坏库极高 + 状态摘要有两行）',
      heights: {
        'health-stores': 140,
        'health-corrupted': 1080,
        'health-failures': 260,
        'health-status': 96,
      },
    },
    {
      name: '收藏表情统计（两张分布卡高度接近）',
      heights: { 'asset-types': 320, 'asset-years': 280 },
    },
    {
      name: '数据边界与出网（三段长文 vs 一行摘要）',
      heights: {
        'trust-boundary': 340,
        'trust-guard': 120,
        'trust-local': 210,
        'trust-ai': 180,
        'trust-audit': 300,
        'trust-scan': 90,
      },
    },
    {
      name: '朋友圈洞察（词云与地图各占 2 列）',
      heights: {
        'moments-liked': 200,
        'moments-commented': 200,
        'moments-words': 400,
        'moments-monthly': 320,
        'moments-map': 300,
        'moments-places': 200,
      },
      spans: { 'moments-words': 2, 'moments-map': 2 },
    },
  ]

  /** 两个矩形是否真的压在一起（共边不算）。 */
  const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a): boolean =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

  for (const containerWidth of [960, 1280, 1920]) {
    for (const c of CASES) {
      it(`${c.name} @ ${String(containerWidth)}px：任意两张卡都不重叠`, () => {
        const slots = packCanvas(
          Object.entries(c.heights).map(([id, height]) => ({
            id,
            height,
            ...(c.spans?.[id] === undefined ? {} : { cols: c.spans[id] }),
          })),
          { containerWidth },
        )
        // 每张卡都要有位置（漏排的卡会留在 0,0 压住别卡）。
        expect(slots.map(s => s.id).sort()).toEqual(Object.keys(c.heights).sort())
        for (let i = 0; i < slots.length; i += 1) {
          for (let j = i + 1; j < slots.length; j += 1) {
            const a = slots[i]!
            const b = slots[j]!
            expect(overlaps(a, b), `${a.id} 与 ${b.id} 重叠`).toBe(false)
          }
        }
      })
    }
  }

  it('跨列卡的宽度真的接近单列的两倍（用户要的"大两倍"）', () => {
    const slots = packCanvas([
      { id: 'one', height: 100 },
      { id: 'two', height: 100, cols: 2 },
    ], { containerWidth: 1280 })
    const one = slots.find(s => s.id === 'one')!
    const two = slots.find(s => s.id === 'two')!
    // 跨两列 = 两列宽 + 中间那一个间隙（卡片之间本来就有 gap，所以略大于 2 倍）。
    expect(two.w).toBe(2 * one.w + 12)
    expect(two.w).toBeGreaterThan(one.w * 1.9)
  })

  it('窄容器里跨列自动收敛，不会溢出画布', () => {
    // 容器只放得下一列时，cols=2 必须降级成 1 列，否则卡片会伸出右边界。
    const slots = packCanvas([
      { id: 'wide', height: 100, cols: 2 },
    ], { containerWidth: 320 })
    const wide = slots.find(s => s.id === 'wide')!
    expect(wide.x).toBe(0)
    expect(wide.w).toBeLessThanOrEqual(320)
  })

  it('高卡不会把整行撑到与它等高的空位：矮卡仍在最矮列落位', () => {
    // 「损坏库」1080 高、其余三张都很矮 ⇒ 后三张应挤在另外两列的上方，
    // 而不是全部被推到 1080 以下（那就是旧两列栅格的问题）。
    const slots = packCanvas([
      { id: 'health-corrupted', height: 1080 },
      { id: 'health-stores', height: 140 },
      { id: 'health-failures', height: 260 },
      { id: 'health-status', height: 96 },
    ], { containerWidth: 1280 })
    const below = slots.filter(s => s.y >= 1080).map(s => s.id)
    expect(below, `这些卡被高卡推到了底部：${below.join(', ')}`).toEqual([])
  })
})
