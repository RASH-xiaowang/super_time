/**
 * 图谱画布的**接线**守卫（源码级）：布局合并、坐标落盘合并、只按结构重排。
 *
 * 为什么这类断言必须看源码而不是跑行为：本仓库没有 DOM / React 测试环境（vitest 只跑纯逻辑
 * 模块），画布里的 `ResizeObserver` / rAF / 指针事件都跑不起来。而这三点恰恰是「性能与
 * 手感」的全部内容，且**退化了界面照样能出图**，人工点几下发现不了：
 *   ① 坐标落盘从「静默期合并」退回「逐帧写」—— 拖一个节点就往 localStorage 写 60 次/秒，
 *      大图上拖拽直接掉帧（这正是改前 ECharts 版 L8 修过的问题，重写时最容易再犯）；
 *   ② 重排的依赖里混进外观参数 —— 拖「文本透明度」滑杆会触发整图重排，滑杆手感变成卡顿；
 *   ③ 布局不走静默期 —— 拖力度滑杆时连发的几十次 change 各算一次 FA2。
 *
 * 这是 `echarts-settle.wiring.spec.ts` 的接任者：那个文件守的是 ECharts `finished` 事件，
 * 而 ECharts 画布已整体删除，同一个「别在逐帧路径上写盘 / 重算」的约束搬到了本文件。
 *
 * 匹配花括号一律用 `[^}]` 限制在同一层：`[\s\S]*?` 会跨过内层 `}`，对**正确**的代码也误报红。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(HERE, 'GraphCanvas.tsx'), 'utf8')
// 去掉注释：注释里会提到旧写法与原因说明，别让它影响断言
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n')

/** 取一个具名函数/常量的源码片段（从声明处到同层的闭合花括号），用于「某段代码里没有 X」这类断言。 */
function bodyOf(declaration: string): string {
  const start = code.indexOf(declaration)
  expect(start, `找不到声明：${declaration}`).toBeGreaterThan(-1)
  const braceAt = code.indexOf('{', start)
  expect(braceAt, `${declaration} 后面没有函数体`).toBeGreaterThan(-1)
  let depth = 0
  for (let i = braceAt; i < code.length; i++) {
    const ch = code[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return code.slice(braceAt, i + 1)
    }
  }
  throw new Error(`花括号不配对：${declaration}`)
}

/** 取一个 `useCallback(...)` 的**依赖数组**（函数体之后那个方括号）。 */
function depsOf(declaration: string): string {
  const start = code.indexOf(declaration)
  expect(start, `找不到声明：${declaration}`).toBeGreaterThan(-1)
  const body = bodyOf(declaration)
  const bodyEnd = code.indexOf(body, start) + body.length
  const open = code.indexOf('[', bodyEnd)
  expect(open, `${declaration} 后面找不到依赖数组`).toBeGreaterThan(-1)
  const close = code.indexOf(']', open)
  expect(close).toBeGreaterThan(-1)
  return code.slice(open, close + 1)
}

describe('坐标落盘：合并到静默期，绝不逐帧写', () => {
  it('用可重启定时器把落盘合并到静默期之后执行', () => {
    expect(code).toContain("import { createRestartableTimer, type RestartableTimer } from './timers.ts'")
    expect(code).toContain('const PERSIST_SETTLE_MS = 300')
    expect(code).toMatch(/createRestartableTimer\(\{\s*delayMs: PERSIST_SETTLE_MS,\s*run: \(\) => \{ savePositions\(positionsForPersist\(\)\) \},?\s*\}\)/)
  })

  it('拖拽节点的路径里没有 savePositions（逐帧写 localStorage 就是 L8）', () => {
    const move = bodyOf('const onPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>): void =>')
    // 防空转：这段确实就是拖拽路径（坐标现在由物理积分写，pointermove 只更新指针目标）
    expect(move).toContain('sim.target = { x: world.x - drag.grabDx')
    expect(move).not.toContain('savePositions')
    expect(move).not.toContain('persistTimerRef')
  })

  it('卸载前兜住待落定的一笔，再销毁定时器', () => {
    const start = code.indexOf('const persist = createRestartableTimer({')
    expect(start).toBeGreaterThan(-1)
    const cleanup = code.slice(code.indexOf('return () => {', start))
    expect(cleanup).toMatch(/if \(persist\.pending\(\)\) \{\s*persist\.cancel\(\)\s*savePositions\(positionsForPersist\(\)\)/)
    expect(cleanup.indexOf('persist.cancel()')).toBeLessThan(cleanup.indexOf('persist.dispose()'))
  })

  it('防空转：被断言引用的两个名字真的还在文件里', () => {
    expect(code).toContain('const positionsForPersist = useCallback')
    expect(code).toContain('const persistTimerRef = useRef<RestartableTimer | null>(null)')
  })
})

describe('布局重排：只随结构与力度参数发生，且合并连续变化', () => {
  it('重排走静默期定时器', () => {
    expect(code).toContain('const RELAYOUT_SETTLE_MS = 120')
    expect(code).toMatch(/createRestartableTimer\(\{\s*delayMs: RELAYOUT_SETTLE_MS,\s*run: \(\) => \{ void relayoutNow\(false\) \},?\s*\}\)/)
    expect(code).toContain('layoutTimerRef.current.restart()')
  })

  it('布局 effect 的依赖只有图与力度指纹 —— 外观参数不该触发整图重排', () => {
    expect(code).toContain('const forceKey = forceKeyOf(settings)')
    expect(code).toMatch(/\}, \[graph, forceKey, relayoutNow\]\)/)
    // 外观与状态那条 effect 只重画（scheduleFrame），不得出现 relayoutNow
    const redraw = bodyOf('useEffect(() => { scheduleFrame() }, [settings, graph, dark, selectedId')
    expect(redraw).not.toContain('relayoutNow')
  })

  it('力度指纹只含六个力度参数（混进外观参数 = 拖滑杆就重排）', () => {
    const fn = bodyOf('function forceKeyOf(s: GraphSettings): string')
    for (const key of ['forceCentripetal', 'forceRepulsion', 'forceAttraction', 'forceEdgeLength', 'nodeGap', 'communitySeparation']) {
      expect(fn, `力度指纹缺少 ${key}`).toContain(key)
    }
    for (const cosmetic of ['nodeScale', 'labelOpacity', 'edgeWidth', 'showArrows', 'showLabels', 'showGrid', 'blurNodes', 'lockLayout']) {
      expect(fn, `力度指纹混进了外观参数 ${cosmetic}`).not.toContain(cosmetic)
    }
  })

  it('陈旧的布局结果会被丢弃（连发请求时后到的旧结果不许盖回新形状）', () => {
    const fn = bodyOf('const relayoutNow = useCallback(async (fresh: boolean): Promise<void> =>')
    expect(fn).toContain('const seq = ++layoutSeqRef.current')
    expect(fn).toMatch(/if \(seq !== layoutSeqRef\.current\) return/)
  })

  it('固定节点在布局后按原位置还原（布局模块没有「固定」这个概念）', () => {
    const fn = bodyOf('const relayoutNow = useCallback(async (fresh: boolean): Promise<void> =>')
    expect(fn).toMatch(/const pinnedSnapshot = new Map<string, Point>\(\)/)
    expect(fn).toMatch(/for \(const \[id, pos\] of pinnedSnapshot\) positionsRef\.current\.set\(id, pos\)/)
  })

  it('坐标尺度归一发生在「还原固定节点」之前（否则固定节点会与其余节点失去相对一致性）', () => {
    const fn = bodyOf('const relayoutNow = useCallback(async (fresh: boolean): Promise<void> =>')
    const scaleAt = fn.indexOf('spacingScale(')
    const restoreAt = fn.indexOf('pinnedSnapshot) positionsRef.current.set')
    expect(scaleAt).toBeGreaterThan(-1)
    expect(restoreAt).toBeGreaterThan(-1)
    expect(scaleAt).toBeLessThan(restoreAt)
    expect(fn).toMatch(/const scale = spacingScale\(p\.graph\.nodes, radiiRef\.current, positionsRef\.current, p\.settings\.nodeGap\)/)
  })
})

describe('两个面板共用一份持久化坐标，互不清场', () => {
  /**
   * 真机实测到的问题：社交图谱与知识图谱是两个并列面板、共用 `dsh-graph-layout-v1`。
   * 落盘时若按「当前图里有谁」裁剪，进一次知识图谱就会把 251 个好友的坐标删光
   * （实测 socialCount 从 251 掉到 0），回到社交图谱时布局从零重算、手动拖过的位置全丢。
   */
  it('落盘快照不再按当前图裁剪', () => {
    const fn = bodyOf('const positionsForPersist = useCallback((): Map<string, GridPos> =>')
    expect(fn).not.toMatch(/positionsRef\.current\.delete/)
    expect(fn).not.toContain('alive')
    // 防空转：这段确实是在遍历坐标表（坐标形态由下面「取整」那条单独锁定）
    expect(fn).toMatch(/for \(const \[id, p\] of keep\) out\.set\(id, \{/)
  })

  it('改为按条数封顶，避免长期使用后无限增长', () => {
    expect(code).toContain('const POSITION_CACHE_MAX = 6000')
    const fn = bodyOf('const positionsForPersist = useCallback((): Map<string, GridPos> =>')
    expect(fn).toMatch(/all\.length > POSITION_CACHE_MAX \? all\.slice\(all\.length - POSITION_CACHE_MAX\) : all/)
  })

  /**
   * 坐标取整不是「顺手优化」，而是决定落盘能不能成功的体积压缩：
   * 真机实测渲染进程的 localStorage 被消息缓存占满后，`setItem` 会抛 `QuotaExceededError`
   * （新建 200KB 的键必失败），而坐标表的体积随「节点上限」直接增长 ——
   * 不取整时一条记录约 50 字符（`{"x":-1234.5678901234567,...}`），取整后约 20 字符。
   * 实测：不取整时把节点上限拉到「全部」之后，布局就再也存不进去了（画布照常变，落盘静默失效）。
   */
  it('落盘前把坐标取整（决定体积，进而决定写不写得进去）', () => {
    const fn = bodyOf('const positionsForPersist = useCallback((): Map<string, GridPos> =>')
    expect(fn).toMatch(/out\.set\(id, \{ x: Math\.round\(p\.x\), y: Math\.round\(p\.y\) \}\)/)
    expect(fn).not.toMatch(/out\.set\(id, \{ x: p\.x, y: p\.y \}\)/)
  })
})

describe('回调依赖链必须稳定：悬停/选中不许连锁触发整图重排', () => {
  /**
   * 这条守卫来自真机实测到的一个 bug：
   * `paint → scheduleFrame → fitView → relayoutNow` 是一条 useCallback 依赖链，而 relayoutNow
   * 挂在「布局重排」的 effect 上。当时 `buildScene` 依赖了 `hoverNeighbours`（随 `hoverNodeId` 变），
   * 于是**鼠标扫过节点就触发一次整图重排**（走 120ms 静默期），把刚拖到一半的节点冲回原位 ——
   * 探针观测到的现象是「拖拽后 localStorage 里 0 个坐标变化」，看起来像拖拽坏了。
   *
   * 这类缺陷在源码里看不出来，跑单测也测不到（没有 DOM 环境），只有真机才能观测；
   * 因此把「链上每一环的依赖数组只含稳定量」钉在这里。
   */
  it('整条链的依赖数组逐项锁定', () => {
    // 依赖数组必须取函数体**之后**的那个方括号：函数体内部本来就会读到 `propsRef.current.hoverNodeId`
    // 之类的值（那是运行期读取，不是依赖），对着函数体断言会把正确代码误判成错误。
    expect(depsOf('const paint = useCallback((): void =>')).toBe('[buildScene, drawMinimap, hoverHit, spriteMap]')
    expect(depsOf('const scheduleFrame = useCallback')).toBe('[paint]')
    expect(depsOf('const fitView = useCallback')).toBe('[scheduleFrame]')
    expect(depsOf('const relayoutNow = useCallback')).toBe('[fitView, scheduleFrame]')
    expect(depsOf('const buildScene = useCallback')).toBe('[avatarIdOf]')
  })

  it('悬停邻居走 ref 而不是 useCallback 依赖', () => {
    expect(code).toContain('const hoverNeighboursRef = useRef<ReadonlySet<string> | null>(null)')
    expect(code).toContain('hoverNeighboursRef.current = hoverNeighbours')
    expect(code).toContain('hoverNeighbours: opts.interactive ? hoverNeighboursRef.current : null')
    // 防空转：被解开的那个依赖真的还在（否则上面的断言只是因为变量被删了才通过）
    expect(code).toContain('const hoverNeighbours = useMemo(')
  })

  it('那条依赖链的每一环都不含悬停/选中/主题这类高频 state', () => {
    const chain = [
      'const paint = useCallback((): void =>',
      'const scheduleFrame = useCallback',
      'const fitView = useCallback',
      'const relayoutNow = useCallback',
      'const buildScene = useCallback',
    ]
    for (const decl of chain) {
      const deps = depsOf(decl)
      for (const volatile of ['hoverNodeId', 'hoverNeighbours', 'selectedId', 'focusCommunity', 'hoverCommunity', 'settings', 'dark', 'pinnedIds']) {
        expect(deps, `${decl} 的依赖里混进了 ${volatile}`).not.toContain(volatile)
      }
    }
  })
})

describe('拖拽联动与碰撞：邻居跟着走，且移动/静止都不重叠', () => {
  /**
   * 这条守卫针对的是「看起来拖动了、但联动与防重叠没接上」的退化：
   * 拖动只 set 被拖节点的坐标、不推进跟随，画面上是「一个点被拖走、与它相连的线被拉长」
   * 而不是「相关节点跟着走」；不 call `relaxCollisions`，则可以把节点拖到另一个节点头上叠住 ——
   * 两者都不会让任何测试变红。
   *
   * 另有一条同样静默的退化：**把跟随推进放进 pointermove**。功能看起来也对，但动画速度会被
   * 绑到鼠标轮询率上（145Hz 鼠标比 60Hz 快一倍多），手感随硬件变；所以推进必须只在 rAF 帧里。
   */
  it('pointerdown 建立物理世界：自然长度取按下瞬间 + 固定节点锚定', () => {
    const down = bodyOf('const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>): void =>')
    expect(down).toMatch(/createPhysicsWorld\(p\.graph, positionsRef\.current, radiiRef\.current\)/)
    expect(down).toMatch(/anchorNodes\(simWorld, p\.pinnedIds \?\? \[\]\)/)
    expect(down).toMatch(/simRef\.current = \{ world: simWorld, id: hit, target: \{ x: pos\?\.x \?\? 0, y: pos\?\.y \?\? 0 \}, releasedAt: 0 \}/)
  })

  it('pointermove 只更新指针目标，不推进物理（推进在 rAF 帧里）', () => {
    const move = bodyOf('const onPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>): void =>')
    expect(move).toContain("if (drag.kind === 'node' && drag.id)")
    expect(move).toMatch(/sim\.target = \{ x: world\.x - drag\.grabDx, y: world\.y - drag\.grabDy \}/)
    // 反例守卫：把物理步进放进 pointermove 会让模拟速度绑上鼠标轮询率（145Hz 比 60Hz 快两倍多）
    expect(move).not.toContain('stepPhysics')
    expect(move).not.toContain('relaxCollisions')
  })

  it('paint 里逐帧：钉住被拖节点 → 积分子步 → 写回坐标 → 碰撞 → 再把碰撞结果写回世界', () => {
    const paint = bodyOf('const paint = useCallback((): void =>')
    expect(paint).toMatch(/pinAt\(sim\.world, sim\.id, sim\.target\.x, sim\.target\.y\)/)
    expect(paint).toMatch(/for \(let i = 0; i < DEFAULT_PHYSICS\.substeps; i\+\+\) stepPhysics\(sim\.world, \{ damping \}\)/)
    expect(paint).toMatch(/syncPhysicsToPositions\(sim\.world, positionsRef\.current\)/)
    expect(paint).toMatch(/relaxCollisions\(p\.graph\.nodes, positionsRef\.current, radiiRef\.current, \{ iterations: 2, skip: p\.pinnedIds \}\)/)
    // 这一条最容易漏：碰撞改的是坐标表，不写回世界的话下一步积分会把结果覆盖掉，
    // 表现为「怎么都推不开」——功能看着还在，只是永远重叠。
    const relaxAt = paint.indexOf('relaxCollisions(p.graph.nodes')
    const backAt = paint.indexOf('syncPositionsToPhysics(sim.world')
    expect(relaxAt).toBeGreaterThan(-1)
    expect(backAt).toBeGreaterThan(relaxAt)
  })

  it('松手不是停住而是开始收敛：记下松手时刻，阻尼随时间加重', () => {
    const up = bodyOf('const onPointerUp = (ev: React.PointerEvent<HTMLCanvasElement>): void =>')
    expect(up).toMatch(/if \(sim && sim\.id === drag\.id\) sim\.releasedAt = performance\.now\(\)/)
    const paint = bodyOf('const paint = useCallback((): void =>')
    expect(paint).toMatch(/if \(sim\.releasedAt > 0\) \{/)
    expect(paint).toMatch(/const progress = Math\.min\(1, \(now - sim\.releasedAt\) \/ SETTLE_MS\)/)
    expect(paint).toMatch(/damping = DEFAULT_PHYSICS\.damping \* \(1 - 0\.7 \* progress\)/)
  })

  it('收敛判定与收尾：静止或超时 → 补几轮碰撞 → 清状态 → 落盘', () => {
    const paint = bodyOf('const paint = useCallback((): void =>')
    expect(paint).toMatch(/if \(physicsMaxStep\(sim\.world\) < REST_STEP \|\| elapsed > SETTLE_MS\) \{/)
    const settleBlock = paint.slice(paint.indexOf('if (physicsMaxStep(sim.world)'))
    const relaxAt = settleBlock.indexOf('relaxCollisions(')
    const clearAt = settleBlock.indexOf('simRef.current = null')
    const persistAt = settleBlock.indexOf('persistTimerRef.current?.restart()')
    expect(relaxAt).toBeGreaterThan(-1)
    expect(clearAt).toBeGreaterThan(-1)
    expect(persistAt).toBeGreaterThan(-1)
    // 顺序：松弛 → 清状态 → 落盘（存下来的必须是不重叠的最终态）
    expect(relaxAt).toBeLessThan(clearAt)
    expect(clearAt).toBeLessThan(persistAt)
  })

  it('只是点击没拖动时把世界丢掉（否则它会一直挂在 ref 上被反复积分）', () => {
    const up = bodyOf('const onPointerUp = (ev: React.PointerEvent<HTMLCanvasElement>): void =>')
    // 注意：bodyOf 取的是**剥掉注释**的代码（与生产代码一致），所以要匹配代码本身
    expect(up).toMatch(/\} else \{\s*simRef\.current = null\s*\}/)
  })

  it('布局落定后也做碰撞松弛，且在还原固定节点之后（固定节点要当障碍）', () => {
    const fn = bodyOf('const relayoutNow = useCallback(async (fresh: boolean): Promise<void> =>')
    const restoreAt = fn.indexOf('pinnedSnapshot) positionsRef.current.set')
    const relaxAt = fn.indexOf('relaxCollisions(')
    expect(restoreAt).toBeGreaterThan(-1)
    expect(relaxAt).toBeGreaterThan(-1)
    expect(restoreAt).toBeLessThan(relaxAt)
    expect(fn).toMatch(/relaxCollisions\(p\.graph\.nodes, positionsRef\.current, radiiRef\.current, \{ iterations: \d+, skip: p\.pinnedIds \}\)/)
  })
})

describe('悬停命中测试在 rAF 帧里做一次，不在指针事件里扫节点', () => {
  it('paint 里调用 hoverHit，且结果变化时才回调', () => {
    const paint = bodyOf('const paint = useCallback((): void =>')
    expect(paint).toContain('const nextHover = hoverHit()')
    expect(paint).toMatch(/if \(nextHover !== \(p\.hoverNodeId \?\? null\)\) p\.onHoverNode\?\.\(nextHover\)/)
  })

  it('针移动回调里不做命中测试（只记指针位置，然后排一帧）', () => {
    const move = bodyOf('const onPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>): void =>')
    expect(move).toContain('pointerRef.current = lp')
    expect(move).not.toContain('pickNode')
  })

  it('拖拽过程中不做悬停命中（否则高亮会跟着手抖乱跳）', () => {
    const hit = bodyOf('const hoverHit = useCallback((): string | null =>')
    expect(hit).toMatch(/if \(!lp \|\| dragRef\.current\) return null/)
  })
})

describe('头像：候选、解码与「解码完成后必须重画」', () => {
  it('候选走 avatarCandidates（自身优先），不再就地 filter+sort', () => {
    expect(code).toContain('avatarCandidates(graph.nodes, avatarBudget(nodeCount))')
    expect(code).not.toMatch(/const candidates = \[\.\.\.graph\.nodes\]/)
  })

  it('重画守卫用 mountedRef —— effect 作用域的 alive 会被 graph 变化的重跑清掉', () => {
    // 病因：effect 依赖 graph（每次 buildGraph 重建引用），重跑时 cleanup 把上一轮的 alive 置 false，
    // 而那一轮的头像解码还在进行 —— 「解码完成 → 重画」永远等不到，画布停在先解码完的那一批上
    // （真机实测 240 个头像只画出 131 个，等 20 秒、改窗口尺寸都不动）。
    expect(code).not.toContain('let alive = true')
    expect(code).not.toMatch(/if \(alive\) scheduleFrame\(\)/)
    expect(code).toContain('const mountedRef = useRef(true)')
    expect(code).toContain('if (mountedRef.current) scheduleFrame()')
  })

  it('挂载标志在 effect 里置回 true（StrictMode 的「挂载→卸载→再挂载」不能让它卡在 false）', () => {
    expect(code).toMatch(/mountedRef\.current = true\s*\n\s*return \(\) => \{ mountedRef\.current = false \}/)
  })

  it('远端头像必须带 crossOrigin 请求 —— 不带就会污染 canvas，PNG 导出直接抛 SecurityError', () => {
    const canvasSrc = readFileSync(join(HERE, 'graph-canvas.ts'), 'utf8')
    const decode = canvasSrc.slice(canvasSrc.indexOf('export function decodeAvatar'))
    expect(decode).toContain("if (!url.startsWith('data:')) image.crossOrigin = 'anonymous'")
    // data URL 是本地字节，加 crossOrigin 反而多一次无谓的 CORS 判定
    expect(decode).toMatch(/startsWith\('data:'\)/)
  })

  it('画布仍暴露 data-avatars（「头像没拉到」与「本地就没有」只能靠它区分）', () => {
    expect(code).toContain('canvas.dataset.avatars = String(drawn.avatars)')
  })
})

describe('出现动画：「播放动画」从一个节点衍生出全图', () => {
  it('runAnimation 排时间表并推动画帧，起点是「我」', () => {
    // 锚点带 `{`：`GraphCanvasHandle` 接口里也有 `runAnimation: () => void`，不带的话会命中那行
    const run = bodyOf('runAnimation: () => {')
    expect(run).toContain('buildRevealPlan(p.graph.nodes, p.graph.edges, SELF_ID, positionsRef.current)')
    expect(run).toContain('revealRef.current = { plan, t0 }')
    // 相机同时适应全图：不推的话刚衍生出来的节点可能在视野外
    expect(run).toContain('fitCamera(')
    // 放完要清进度并补一帧，否则会停在最后一帧的半亮状态
    expect(run).toMatch(/revealRef\.current = null[\s\S]{0,200}?paint\(\)/)
  })

  it('paint 每帧把进度算出来交给场景', () => {
    const paint = bodyOf('const paint = useCallback((): void =>')
    expect(paint).toContain('revealProgressMap(rev.plan, performance.now() - rev.t0)')
    expect(paint).toMatch(/reveal: rev \? revealProgressMap\(/)
  })

  it('导出路径不传进度 —— 成品图里不能有「还没长出来」的节点', () => {
    const paintAt = code.indexOf('const paint = useCallback')
    const offscreenAt = code.indexOf('const renderOffscreen = useCallback')
    expect(paintAt).toBeGreaterThan(-1)
    expect(offscreenAt).toBeGreaterThan(paintAt)
    // 屏幕绘制这一段带着出现进度
    expect(code.slice(paintAt, offscreenAt)).toContain('reveal: rev ? revealProgressMap(')
    // 它之后的导出路径（renderOffscreen / exportSvg / 海报）一处都不能带
    expect(code.slice(offscreenAt)).not.toContain('reveal:')
  })

  it('图变化时作废旧时间表（旧 id 可能已经不在图里）', () => {
    expect(code).toMatch(/useEffect\(\(\) => \{ revealRef\.current = null \}, \[graph\]\)/)
  })
})
