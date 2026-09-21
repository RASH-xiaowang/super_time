/**
 * 绘制层纯函数的行为锁定（`graph-canvas.ts`）—— **视觉细节与文案**这一半。
 *
 * 为什么这些值得锁：标签筛选规则错了会让大图糊成一片字；节点形状与描边环、
 * 文档层三类节点的取色与气泡、边的线型、淡出规则都属「画错了也能出图、只是不对」。
 * 这些都不会让页面报错，只会在使用中慢慢显形。
 *
 * M21：从 `graph-canvas.spec.ts`（1096 行）拆出，与几何那一半共用
 * `graph-spec-fixtures.ts` 的夹具；断言一条没改。
 *
 * 环境用 node：本模块只 import 类型与纯函数，`document` 仅出现在 circleSprite/decodeAvatar
 * 里（绘制与解码路径），本文件不调它们。
 * @vitest-environment node
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { communityColor } from './graph-model.ts'
import type { GNode } from './graph-model.ts'
import {
  MAX_LABELS, avatarCandidates, bubbleText, dimOpacity, docColors, edgeBudget, edgeStroke, estimateTextWidth,
  graphTheme, hasAvatar, labelCandidates, nodeOpacity, sceneToSvg
} from './graph-canvas.ts'
import { S, node, edge, VIEW } from './graph-spec-fixtures.ts'

describe('淡出规则', () => {
  it('社区聚焦：圈内保持，圈外几乎隐形；仅悬停预览时只轻度淡出', () => {
    expect(dimOpacity(1, null, null)).toBe(1)
    expect(dimOpacity(1, 1, null)).toBe(1)
    expect(dimOpacity(2, 1, null)).toBe(0.12)
    expect(dimOpacity(2, null, 1)).toBe(0.35)
    // 聚焦优先于悬停
    expect(dimOpacity(2, 1, 2)).toBe(0.12)
  })

  it('有悬停节点时只留它与其一阶邻居', () => {
    const view = { hoverNodeId: 'a', hoverNeighbours: new Set(['b']), focusCommunity: null, hoverCommunity: null }
    expect(nodeOpacity(node('a'), view)).toBe(1)
    expect(nodeOpacity(node('b'), view)).toBe(1)
    expect(nodeOpacity(node('c'), view)).toBe(0.15)
    // 「我」是 self 节点、community -1：悬停模式下也一样按邻居规则处理（不享受特例）
    expect(nodeOpacity(node('self', { kind: 'self' }), view)).toBe(0.15)
  })

  it('没有悬停时回落到社区规则', () => {
    const view = { hoverNodeId: null, hoverNeighbours: null, focusCommunity: 0, hoverCommunity: null }
    expect(nodeOpacity(node('a', { community: 0 }), view)).toBe(1)
    expect(nodeOpacity(node('b', { community: 3 }), view)).toBe(0.12)
  })
})

describe('边的线型', () => {
  const theme = graphTheme(true)
  const stubIds = new Set(['kb:x'])

  it('五种边各有自己的颜色，与图例一致', () => {
    expect(edgeStroke(edge('a', 'b', 'common'), theme, S, stubIds).color).toBe(theme.edgeCommon)
    expect(edgeStroke(edge('a', 'b', 'intimacy'), theme, S, stubIds).color).toBe(theme.edgeIntimacy)
    expect(edgeStroke(edge('a', 'b', 'wiki'), theme, S, stubIds).color).toBe(theme.edgeWiki)
    expect(edgeStroke(edge('a', 'b', 'source'), theme, S, stubIds).color).toBe(theme.edgeSource)
    expect(edgeStroke(edge('a', 'b', 'class'), theme, S, stubIds).color).toBe(theme.edgeClass)
  })

  it('粗细：亲密度 > 共同群 > 沉淀来源 > 同备注编号，wiki 单独一档', () => {
    const intimacy = edgeStroke(edge('a', 'b', 'intimacy'), theme, S, stubIds).width
    const common = edgeStroke(edge('a', 'b', 'common'), theme, S, stubIds).width
    const source = edgeStroke(edge('a', 'b', 'source'), theme, S, stubIds).width
    const cls = edgeStroke(edge('a', 'b', 'class'), theme, S, stubIds).width
    expect(intimacy).toBeGreaterThan(common)
    expect(common).toBeGreaterThan(source)
    // 同班级是「从备注结构推断」出来的关系，画得比任何观测到的边都细
    expect(source).toBeGreaterThan(cls)
    expect(cls).toBeGreaterThan(0)
    expect(intimacy).toBeGreaterThan(0)
  })

  it('虚线给「还不存在的笔记」与全部推断层（class / initial / mention / suggest）', () => {
    expect(edgeStroke(edge('note:1', 'kb:x', 'wiki'), theme, S, stubIds).dashed).toBe(true)
    expect(edgeStroke(edge('note:1', 'note:2', 'wiki'), theme, S, stubIds).dashed).toBe(false)
    expect(edgeStroke(edge('note:1', 'kb:x', 'source'), theme, S, stubIds).dashed).toBe(false)
    // 同班级边是推断出来的，虚线让它自解释（不必只靠颜色区分）
    expect(edgeStroke(edge('a', 'b', 'class'), theme, S, stubIds).dashed).toBe(true)
    expect(edgeStroke(edge('a', 'b', 'initial'), theme, S, stubIds).dashed).toBe(true)
    expect(edgeStroke(edge('a', 'b', 'common'), theme, S, stubIds).dashed).toBe(false)
    // 知识侧同理：mention（笔记标题出现在正文里）与 suggest（模型抽出的实体）都是猜的，
    // 而 contain（这一节确实在这份文件里）是结构事实 —— 虚实这条线不能画错，
    // 否则用户会把一次模型幻觉当成文档里写着的引用关系去转述。
    expect(edgeStroke(edge('note:1', 'file:37', 'mention'), theme, S, stubIds).dashed).toBe(true)
    expect(edgeStroke(edge('file:37', 'ent:张三', 'suggest'), theme, S, stubIds).dashed).toBe(true)
    expect(edgeStroke(edge('file:37', 'doc:里程碑', 'contain'), theme, S, stubIds).dashed).toBe(false)
    expect(edgeStroke(edge('file:37', 'doc:里程碑', 'contain'), theme, S, stubIds).width)
      .toBe(edgeStroke(edge('note:1', 'note:2', 'wiki'), theme, S, stubIds).width)
    expect(edgeStroke(edge('file:37', 'ent:张三', 'suggest'), theme, S, stubIds).width)
      .toBe(edgeStroke(edge('a', 'b', 'mention'), theme, S, stubIds).width)
  })

  it('edgeWidth 拉大时线跟着变粗（滑杆生效）', () => {
    const thin = edgeStroke(edge('a', 'b', 'intimacy'), theme, { ...S, edgeWidth: 0.5 }, stubIds).width
    const thick = edgeStroke(edge('a', 'b', 'intimacy'), theme, { ...S, edgeWidth: 4 }, stubIds).width
    expect(thick).toBeGreaterThan(thin)
  })

  it('edgeBudget：下限 300、按节点数给额度、且不超过实际边数', () => {
    expect(edgeBudget(10, 5)).toBe(5)
    // 下限 300（不是 180）：见 graph-budget 里 MIN_EDGE_BUDGET 的推导 ——
    // 180 会把「19 人同处一个群」（亲密度 19 + 同群 171 = 190 条）切掉 10 条。
    expect(edgeBudget(10, 5000)).toBe(300)
    // 下限之上必须仍由「节点数 × 5」接管：60 节点 → 300，61 节点 → 305（不是被 300 顶住）
    expect(edgeBudget(60, 5000)).toBe(300)
    expect(edgeBudget(61, 5000)).toBe(305)
    // 1000 节点 × 5 = 5000 ≥ 实际 5000 ⇒ 全画
    expect(edgeBudget(1000, 5000)).toBe(5000)
    expect(edgeBudget(10000, 5000)).toBe(5000)
  })

  it('edgeBudget：额度是「节点数 × 5」，真机默认规模下够画全同群关系', () => {
    // 真机实测：默认好友视图 998 边 / 251 节点 = 3.98 条/节点 ⇒ 额度 1255 > 998
    expect(edgeBudget(251, 998, 250)).toBe(998)
    // 群组网络 691 边 / 65 节点 = 10.63 条/节点 ⇒ 额度 325 < 691，仍按权重截断
    expect(edgeBudget(65, 691, 64)).toBe(325)
  })

  it('edgeBudget：超大图由绝对上限兜住（比例额度会随节点数线性膨胀）', () => {
    // 10000 节点 × 5 = 50000，但绝对上限 24000
    expect(edgeBudget(10000, 100000)).toBe(24000)
    expect(edgeBudget(10000, 100000, 9000)).toBe(24000)
  })

  it('edgeBudget：骨架是一条**下限**，不是额外额度（不会被重复计一次）', () => {
    // 骨架 600 > 节点数×5=500 ⇒ 以骨架为准；不是 500+600
    expect(edgeBudget(100, 100000, 600)).toBe(600)
    // 骨架小于额度时以额度为准
    expect(edgeBudget(100, 100000, 30)).toBe(500)
  })
})

describe('标签筛选：开关即权威', () => {
  const view = { hoverNodeId: null as string | null, selectedId: null as string | null, pinnedIds: new Set<string>() }

  /**
   * 这条是用户报回来的：「没开「全部标签」，为什么有些节点还有标签」。
   * 曾经有一条「枢纽常显」规则（权重 ≥ 最大值 15% 无条件带标签，继承自改前 ECharts 版的
   * 「权重前 12 名 + 我」），在 251 节点的图上会让四十来个节点常显 —— 与开关的字面语义冲突。
   */
  it('关闭时**一个自动标签都不画**（不再有「枢纽常显」）', () => {
    const nodes = [node('hub', { weight: 1000 }), node('mid', { weight: 200 }), node('leaf', { weight: 100 })]
    expect(labelCandidates(nodes, S, view)).toEqual([])
  })

  it('关闭时只保留交互必需的三类：悬停 / 选中 / 固定', () => {
    const nodes = [node('a', { weight: 1000 }), node('b', { weight: 1 }), node('c', { weight: 1 })]
    const ids = labelCandidates(nodes, S, { hoverNodeId: 'a', selectedId: 'b', pinnedIds: new Set(['c']) }).map(n => n.id)
    expect(ids.sort()).toEqual(['a', 'b', 'c'])
  })

  it('打开时所有节点参与，超过 MAX_LABELS 才截断', () => {
    const nodes = Array.from({ length: 200 }, (_, i) => node(`n${i}`, { weight: 1000 - i }))
    expect(labelCandidates(nodes, { ...S, showLabels: true }, view).length).toBe(200)
    const many = Array.from({ length: MAX_LABELS + 50 }, (_, i) => node(`m${i}`, { weight: 1000 - i }))
    expect(labelCandidates(many, { ...S, showLabels: true }, view).length).toBe(MAX_LABELS)
  })

  it('悬停/选中/固定的标签一定在里面，且排在最前（用户当下在看的东西不该被挤掉）', () => {
    const nodes = [node('hub', { weight: 1000 }), node('leaf', { weight: 1 }), node('sel', { weight: 1 })]
    const ids = labelCandidates(nodes, S, { hoverNodeId: 'leaf', selectedId: 'sel', pinnedIds: new Set() }).map(n => n.id)
    expect(ids.slice(0, 2)).toEqual(expect.arrayContaining(['leaf', 'sel']))
  })

  it('强制项不被上限截掉（即使它在权重排序里排在很后面）', () => {
    const nodes = Array.from({ length: MAX_LABELS + 50 }, (_, i) => node(`n${i}`, { weight: 1000 - i }))
    const picked = labelCandidates(nodes, { ...S, showLabels: true }, view)
    expect(picked.length).toBe(MAX_LABELS)
    const forced = labelCandidates(nodes, { ...S, showLabels: true }, { ...view, selectedId: `n${MAX_LABELS + 40}` })
    expect(forced.some(n => n.id === `n${MAX_LABELS + 40}`)).toBe(true)
  })
})

describe('主题与文案', () => {
  it('深浅两套主题字段齐全且互不相同', () => {
    const dark = graphTheme(true)
    const light = graphTheme(false)
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort())
    for (const [key, value] of Object.entries(dark)) {
      expect(typeof value, `主题字段 ${key} 必须是颜色字符串`).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    }
    expect(dark.bg).not.toBe(light.bg)
    expect(dark.label).not.toBe(light.label)
  })

  it('悬停气泡按物种给不同副标题', () => {
    expect(bubbleText(node('n', { kind: 'note', outLinks: 2, backLinks: 5 })).sub).toContain('出链 2')
    expect(bubbleText(node('s', { kind: 'stub', stub: true, backLinks: 3 })).sub).toContain('尚未创建')
    expect(bubbleText(node('g', { kind: 'group', intimacy: 42 })).sub).toContain('群聊')
    expect(bubbleText(node('f', { isFriend: true, intimacy: 42 })).sub).toContain('好友')
    expect(bubbleText(node('o', { isOfficial: true, intimacy: 1 })).sub).toContain('公众号')
    expect(bubbleText(node('self', { kind: 'self' })).sub).toContain('我')
  })

  it('estimateTextWidth：中日韩比同长度拉丁更宽', () => {
    expect(estimateTextWidth('中文四个', 11)).toBeGreaterThan(estimateTextWidth('abcd', 11))
    expect(estimateTextWidth('', 11)).toBe(0)
  })

  it('占位：社区色盘对未分组节点回落到中性灰（画布与面板侧取色一致）', () => {
    expect(communityColor(-1)).toBe('#9aa0a6')
    expect(communityColor(0)).toBe(communityColor(0))
  })
})

/**
 * 节点形状守卫：笔记与「人/群」统一为圆盘。
 *
 * 病根：笔记本体曾画成**内切于外接圆的圆角方块**，而描边环与选中光环无条件按
 * `ctx.arc(sr + …)` 画圆 —— 圆内切于方块、四角戳出环外，观感是「方块里套了个圈」。
 * 改回方块会让这个错位立刻复发，且**不报错、不崩溃、其余测试全绿**，只有人眼看得见。
 */
describe('节点形状：笔记也是圆盘，描边环才贴得住', () => {
  /** 造一个最小场景；导出路径（sceneToSvg）只碰纯函数，node 环境可直接调用。 */
  function sceneOf(nodes: GNode[]): Parameters<typeof sceneToSvg>[0] {
    const radius = 30
    return {
      nodes,
      edges: [],
      positions: new Map(nodes.map(n => [n.id, { x: 0, y: 0 }])),
      radii: new Map(nodes.map(n => [n.id, radius])),
      sprites: new Map(),
      avatarIdOf: () => '',
      camera: { x: 0, y: 0, k: 1 },
      size: VIEW,
      dark: true,
      settings: S,
      selectedId: null,
      hoverNodeId: null,
      hoverNeighbours: null,
      pinnedIds: new Set<string>(),
      focusCommunity: null,
      hoverCommunity: null,
    }
  }

  const note = (): GNode => node('note:1', { kind: 'note', community: -1, radius: 30 })

  it('导出 SVG 里笔记节点本体是 <circle>，不是圆角方块', () => {
    const svg = sceneToSvg(sceneOf([note()]), () => '')
    // 世界 (0,0) 在 800×600 视口正中 → 屏幕 (400,300)；k=1、radius=30 → sr=30
    expect(svg).toContain('<circle cx="400.00" cy="300.00" r="30.00" fill="#6d5bd0"')
    // 方块形态必须消失：只允许背景那一块 <rect width=...>
    expect(svg).not.toContain('<rect x=')
  })

  it('描边环仍在（笔记不是 stub，必须继续走 !isStub 那一支）', () => {
    const svg = sceneToSvg(sceneOf([note()]), () => '')
    expect(svg).toContain('cx="400.00" cy="300.00" r="30.75"')
  })

  it('浅色主题换浅紫，形状不变', () => {
    const sc = sceneOf([note()])
    const svg = sceneToSvg({ ...sc, dark: false }, () => '')
    expect(svg).toContain('fill="#8b7ff0"')
    expect(svg).not.toContain('<rect x=')
  })

  it('对照：人节点仍走社区色圆盘（改动没有波及其他物种）', () => {
    const person = node('u1', { kind: 'person', community: 0, isFriend: true, radius: 30 })
    const svg = sceneToSvg(sceneOf([person]), () => '')
    expect(svg).toContain(`fill="${communityColor(0)}"`)
    expect(svg).not.toContain('<rect x=')
  })

  it('源码层：两个 isNote 分支都不许出现 rect，圆角半径系数必须绝迹', () => {
    // drawScene 要真跑需要 2D context，node 环境没有 —— 按仓库既有做法用源码断言补位
    const raw = readdirSync(dirname(fileURLToPath(import.meta.url))).filter((f) => /^graph-canvas(-[a-z]+)?\.ts$/.test(f)).sort().map((f) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), f), 'utf8')).join('\n')
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n')

    expect(code, 'sr * 0.32 是当初的圆角方块系数，笔记改圆后不该再有').not.toContain('sr * 0.32')

    // 逐个摘出 `} else if (isNote) {` 到同层闭合花括号的分支
    const branches: string[] = []
    let from = 0
    for (;;) {
      const at = code.indexOf('} else if (isNote) {', from)
      if (at < 0) break
      const braceAt = code.indexOf('{', at)
      let depth = 0
      let end = -1
      for (let i = braceAt; i < code.length; i++) {
        if (code[i] === '{') depth++
        else if (code[i] === '}') {
          depth--
          if (depth === 0) { end = i + 1; break }
        }
      }
      expect(end, 'isNote 分支花括号不配对').toBeGreaterThan(-1)
      branches.push(code.slice(at, end))
      from = end
    }
    // 画布一支 + SVG 一支，缺一个说明有人把分支删了/改名了
    expect(branches.length, '应恰好有两个 isNote 分支（drawScene 与 sceneToSvg）').toBe(2)
    for (const b of branches) {
      expect(b, '笔记节点本体不许用矩形（会与外圈描边错位）').not.toMatch(/rect/i)
    }
    // 画布那一支必须真的画圆
    expect(branches.some(b => b.includes('ctx.arc('))).toBe(true)
  })
})

/* ── 文档层三类节点（file / section / entity）────────────────────────────
 *
 * 这一层是「把用户登记的资料画进图里」，2026-09-19 加文件与章节、2026-09-20 加模型实体。
 * 三处容易静默画错、且**只有人眼看得见**的地方：
 *   ① 屏幕与导出 SVG 必须共用一份取色（`docColors`）。各写一份的话，分享到外的图
 *      与本人在画布上看到的是两张图 —— 颜色正是这一层唯一的身份信息（青=资料、
 *      灰蓝=结构、琥珀=模型说的）。
 *   ② 三类都不许去要头像。`avatarCandidates` 会按 username 去 `head_image.db` 找，
 *      拿文件名当 username 请求是纯浪费，而且哪天真撞上一个同名 wxid 就会画出
 *      「一个叫《项目计划书.docx》的人脸」。
 *   ③ entity 是**推断**，气泡必须自己说出来。只写「实体 · 3 份文件」会被读成
 *      「文档里明确写了三处」—— 这正是模型幻觉变成用户引用的那条路。
 */
describe('文档层三类节点的取色、头像与气泡', () => {
  /** 最小场景：导出路径只碰纯函数，node 环境可直接调用。 */
  function sceneOf(nodes: GNode[]): Parameters<typeof sceneToSvg>[0] {
    return {
      nodes,
      edges: [],
      positions: new Map(nodes.map(n => [n.id, { x: 0, y: 0 }])),
      radii: new Map(nodes.map(n => [n.id, 30])),
      sprites: new Map(),
      avatarIdOf: () => '',
      camera: { x: 0, y: 0, k: 1 },
      size: VIEW,
      dark: true,
      settings: S,
      selectedId: null,
      hoverNodeId: null,
      hoverNeighbours: null,
      pinnedIds: new Set<string>(),
      focusCommunity: null,
      hoverCommunity: null,
    }
  }

  it('三类各有自己的颜色，且深浅两套都齐（缺一个就会 fallback 成无色）', () => {
    for (const dark of [true, false]) {
      const f = docColors('file', dark)
      const s = docColors('section', dark)
      const e = docColors('entity', dark)
      const fills = [f.fill, s.fill, e.fill]
      expect(new Set(fills).size, '三类同色就等于三类不可区分').toBe(3)
      for (const c of [...fills, f.stroke, s.stroke, e.stroke]) {
        expect(c).toMatch(/^#[0-9a-f]{6}$/i)
      }
      expect(f.fill).not.toBe(s.fill)
    }
    // 未知 kind 落到章节那一档（中性灰蓝），不是 undefined / 抛错
    expect(docColors('whatever', true)).toEqual(docColors('section', true))
  })

  it('导出 SVG 与屏幕同源：节点本体的 fill 就是 docColors 给的那个', () => {
    for (const kind of ['file', 'section', 'entity'] as const) {
      for (const dark of [true, false]) {
        const svg = sceneToSvg({ ...sceneOf([node(`x:${kind}`, { kind, radius: 30 })]), dark }, () => '')
        const { fill, stroke } = docColors(kind, dark)
        expect(svg, `${kind}/${dark ? 'dark' : 'light'} 的填充`).toContain(`fill="${fill}" stroke="${stroke}"`)
      }
    }
  })

  it('三类都不去要头像（人/群/self 照旧要 —— 防空转）', () => {
    for (const kind of ['file', 'section', 'entity'] as const) {
      expect(hasAvatar(node('d', { kind })), kind).toBe(false)
    }
    expect(hasAvatar(node('u1', { kind: 'person' }))).toBe(true)
    expect(hasAvatar(node('note:1', { kind: 'note' }))).toBe(false)
  })

  it('entity 的气泡自报是模型推断，而不是「文档里写着的」', () => {
    const b = bubbleText(node('ent:张三', { kind: 'entity', label: '张三', sectionFileIds: [37, 38] }))
    expect(b.title).toBe('张三')
    expect(b.sub).toContain('模型推断')
    expect(b.sub).toContain('虚线')
    expect(b.sub).toContain('2 份文件')
    // 章节是观测层，措辞不能与实体混成一种
    const s = bubbleText(node('doc:里程碑', { kind: 'section', label: '里程碑', sectionFileIds: [37, 38], backLinks: 3 }))
    expect(s.sub).not.toContain('模型')
  })

  it('源码层：docColors 只有一处定义，且 drawScene 与 sceneToSvg 两支都调用它', () => {
    const raw = readdirSync(dirname(fileURLToPath(import.meta.url))).filter((f) => /^graph-canvas(-[a-z]+)?\.ts$/.test(f)).sort().map((f) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), f), 'utf8')).join('\n')
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n')
    expect([...code.matchAll(/function docColors\(/g)]).toHaveLength(1)
    // 两处调用 = 屏幕一支 + 导出支；谁把某一支改回硬编码色值，这条就红
    expect([...code.matchAll(/docColors\(/g)]).toHaveLength(3)
  })
})
