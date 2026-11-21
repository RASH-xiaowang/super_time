/**
 * 年度报告的自由画布布局引擎（2026-11-19，第二版：等宽瀑布流）。
 *
 * ## 为什么从「多档宽度」改成「等宽瀑布流」
 *
 * 第一版按内容把卡片分成 窄/中/宽/满 四档。实测问题：
 *   · 宽度不一致时，行与行之间会出现**参差的横向断点**，扫视时眼睛要不断重新找左边界；
 *   · 宽卡旁边必然跟一张窄卡，窄卡下方留白（又回到"空白太多"）；
 *   · 用户给的参考图是**等宽瀑布流**：所有卡同宽、按最短列依次落下、纵向紧密。
 *
 * 所以现在：**卡片一律单列宽**，列数由容器宽决定，每张卡落到当前最矮的列。
 * 这正是 Pinterest / 小红书式瀑布流 —— 视觉上形成连续的多列纵向节奏，
 * 横向对齐只有一条基线（列边界），比多档宽度干净得多。
 *
 * ⚠️ 「一律单列宽」不等于「一律 300px」：列宽由容器**拉伸**得出，见 `metrics`。
 * 例外只有个别横长内容（世界地图）跨 2 列。
 *
 * ## 与网格（`display: grid`）的关键区别
 *
 * 网格里同一行必须等高（`align-items: stretch`）或参差留白（`start`）；
 * 瀑布流里**每一列的 y 互相独立**，矮卡下方立刻被后续卡填上，没有整行空白。
 *
 * ## 拖动仍然保留
 *
 * 等宽不等于不能摆放：x 吸附到列边界、y 自由 —— 用户可以把某张卡拎到别的列、
 * 或在自己的列里上下移动。
 *
 * @module panels/card-canvas-layout
 */

/**
 * 一列的**最小**宽度（px）。
 *
 * 实际列宽不是这个值 —— 它是"能排几列"的下限。排定列数后，列宽会被**拉伸**
 * 到正好铺满容器（见 {@link packCanvas} 的说明），否则右侧永远留一截空白：
 * 容器 1000px、列宽固定 300 时只能排 3 列（924px），右边空 76px；
 * 容器再宽一点空白更大。用户 2026-11-19 报的就是这个。
 */
export const CANVAS_MIN_COLUMN_WIDTH = 300
/** @deprecated 用 {@link CANVAS_MIN_COLUMN_WIDTH}；保留别名只为不破坏既有 import。 */
export const CANVAS_COLUMN_WIDTH = CANVAS_MIN_COLUMN_WIDTH
/** 列与列之间、行与行之间的间隙（px）。参考图的间距偏紧，取 12。 */
export const CANVAS_GAP = 12

/** 参与布局的一格：id + 实测高度 + 可选的跨列数。 */
export interface CanvasCardInput {
  id: string
  /** 实测高度（未测到时不传，用 fallbackHeight 占位）。 */
  height?: number
  /**
   * 跨几列（默认 1）。
   *
   * 为什么保留这一个例外：绝大多数卡等宽是对的（扫视基线统一），
   * 但**世界地图**这种内容天然是横长的 —— 塞进一列只会得到一个又高又空的地图框。
   * 允许个别卡跨 2 列，既保住瀑布流的整体节奏，又不用把地图压扁。
   * 超过容器列数时自动收敛到容器列数（窄屏不会溢出）。
   */
  cols?: number
}

/** 布局结果：像素级的左上角坐标与实际宽度。 */
export interface CanvasSlot {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface CanvasPackOptions {
  /** 画布可用宽度（px）。 */
  containerWidth: number
  /** **最小**列宽（默认 {@link CANVAS_MIN_COLUMN_WIDTH}）。实际列宽会被拉伸铺满容器。 */
  columnWidth?: number
  /** 间隙（默认 {@link CANVAS_GAP}）。 */
  gap?: number
  /** 高度还没测出来时的占位高度（默认 200）。 */
  fallbackHeight?: number
}

/**
 * 由容器宽算列数与列宽。
 *
 * ## 列宽为什么是**拉伸**出来的（2026-11-19 用户报「留太多空白」）
 *
 * 原来列宽是固定 300：容器 1000px 时只能排 3 列（`3*300 + 2*12 = 924`），
 * 右侧空 76px；容器再宽一点空白更大。截图里第三列右边那一大片就是这个。
 *
 * 现在分两步：
 *   ① 用**最小列宽**算能排几列（保证卡片不会被压得太窄）；
 *   ② 把这 N 列**拉伸**到正好等于容器宽（`(W - (N-1)*gap) / N`）。
 *
 * 于是卡片宽度在「最小列宽 ~ 最小列宽 + 一个步长」之间浮动，
 * 既不会窄到读不了，也不会在右侧留白。需要响应式变窄时，
 * 列数掉一档即可（N 变了，每列就重新分配）。
 *
 * @param options - 容器宽、最小列宽、间隙。
 * @returns 列数、列步长（列宽 + 间隙）、间隙、实际列宽。
 */
function metrics(options: CanvasPackOptions): { total: number; step: number; gap: number; columnWidth: number } {
  const gap = Math.max(0, options.gap ?? CANVAS_GAP)
  const minColumn = Math.max(1, options.columnWidth ?? CANVAS_MIN_COLUMN_WIDTH)
  const width = Math.max(1, options.containerWidth)
  // ① 能塞下几个「最小列宽 + 间隙」（最后一列不需要尾随间隙）。
  const total = Math.max(1, Math.floor((width + gap) / (minColumn + gap)))
  // ② 拉伸到正好铺满：N 列 + (N-1) 个间隙 == 容器宽。
  const columnWidth = Math.max(1, (width - (total - 1) * gap) / total)
  return { total, step: columnWidth + gap, gap, columnWidth }
}

/**
 * 计算整块画布的布局（等宽瀑布流，允许个别卡跨列）。
 *
 * 单列卡落到**当前最矮的列**（平手时取最左）；跨列卡（`cols: 2`）落到
 * 「这几列里最靠上的位置」—— 即取这几列 bottom 的**最大值**作为它的 y。
 * @param cards - 按阅读顺序给出的卡片（顺序即「先落谁」）。
 * @param options - 容器宽度、列宽、间隙、占位高度。
 * @returns 每张卡的坐标与尺寸（与入参同序）。
 */
export function packCanvas(cards: readonly CanvasCardInput[], options: CanvasPackOptions): CanvasSlot[] {
  const { total, step, columnWidth } = metrics(options)
  const gap = options.gap ?? CANVAS_GAP
  const fallback = Math.max(1, options.fallbackHeight ?? 200)
  /** 每一列当前的最低点（y）。瀑布流的核心状态。 */
  const columnBottoms = new Array<number>(total).fill(0)

  const out: CanvasSlot[] = []
  for (const card of cards) {
    const h = Math.max(1, card.height ?? fallback)
    // 跨列数收敛到容器列数：窄屏（1 列）时所有卡都是单列，不会溢出。
    const span = Math.max(1, Math.min(Math.floor(card.cols ?? 1), total))

    // 在「起点 + span ≤ 总列数」的所有位置里，取该段 bottom 最大值最小的那个。
    let target = 0
    let top = Number.POSITIVE_INFINITY
    for (let start = 0; start + span <= total; start += 1) {
      let candidate = 0
      for (let c = start; c < start + span; c += 1) candidate = Math.max(candidate, columnBottoms[c] ?? 0)
      // 严格更小才换 —— 平手保留最左，阅读顺序更符合直觉。
      if (candidate < top) { top = candidate; target = start }
    }
    if (!Number.isFinite(top)) { top = 0; target = 0 }

    const w = columnWidth * span + gap * (span - 1)
    out.push({ id: card.id, x: target * step, y: top, w, h })
    const nextBottom = top + h + gap
    for (let c = target; c < target + span; c += 1) columnBottoms[c] = nextBottom
  }
  return out
}

/** 整块画布的内容高度（供外层撑开滚动区）。 */
export function canvasHeight(slots: readonly CanvasSlot[], gap = CANVAS_GAP): number {
  let max = 0
  for (const s of slots) max = Math.max(max, s.y + s.h)
  return max === 0 ? 0 : max + gap
}

/**
 * 把一次拖拽的落点吸附到**列边界**。
 *
 * ⚠️ 这个函数只看坐标，**不知道其它卡在哪** —— 所以它**不保证**落点不与别的卡重叠。
 * 真正的防重叠在 {@link settleCanvas}：画布每次排版都会对全体跑一遍压实。
 * 两者分工是刻意的：
 *   · 这里只做「对齐到列」这一件纯几何的事（可单测、无副作用）；
 *   · 避让是**全局**问题（一张卡落下去可能要挤动下面一串），放在排版阶段统一处理，
 *     拖动过程中就不用反复重排整块画布。
 *
 * @param position - 用户放下的原始坐标。
 * @param options - 吸附用的列宽/间隙/容器宽度。
 * @returns 吸附后的坐标。
 */
export function snapCanvasPosition(
  position: { x: number; y: number },
  options: CanvasPackOptions,
): { x: number; y: number } {
  const { total, step } = metrics(options)
  const column = Math.round(Math.max(0, position.x) / step)
  const clamped = Math.min(Math.max(0, column), total - 1)
  return { x: clamped * step, y: Math.max(0, Math.round(position.y)) }
}

/**
 * 把 x 收进**当前**容器的合法列范围，并考虑这张卡的跨列数。
 *
 * ## 为什么需要它（2026-11-19）
 *
 * 位置表里存的是**像素 x**，而它表达的是「第几列」。列数会变：
 * 窗口从 5 列缩到 2 列时，旧的 `x=644` 既可能落在容器外、也可能与新列宽错位，
 * 于是卡片横向重叠或直接溢出右边界（用户报「卡片相互遮挡」）。
 *
 * 另外 `cols=2` 的卡如果被吸到最后一列，右边缘会溢出恰好一个 `step`
 * —— `snapCanvasPosition` 的 clamp 是 `total - 1`，没有减去自身跨列数。
 *
 * @param x - 期望的 x（可能是旧版面的像素值）。
 * @param span - 这张卡跨几列。
 * @param options - 容器宽/列宽/间隙。
 * @returns 收进合法列后的 x。
 */
export function clampCanvasX(x: number, span: number, options: CanvasPackOptions): number {
  const { total, step } = metrics(options)
  const effectiveSpan = Math.max(1, Math.min(Math.floor(span), total))
  // 起点最右只能到 `total - span`，否则右边缘会溢出。
  const maxColumn = Math.max(0, total - effectiveSpan)
  const column = Math.round(Math.max(0, x) / step)
  return Math.min(Math.max(0, column), maxColumn) * step
}

/** 两个矩形是否**近到需要让位**（间距小于 `gap` 就算冲突；正好等于 `gap` 不算）。 */
function conflicts(a: CanvasSlot, b: CanvasSlot, gap: number): boolean {
  return a.x < b.x + b.w + gap
    && b.x < a.x + a.w + gap
    && a.y < b.y + b.h + gap
    && b.y < a.y + a.h + gap
}

/**
 * **压实**：把一组「期望位置」整理成互不重叠的最终位置（2026-11-19）。
 *
 * ## 为什么必须有这一步
 *
 * 这条不变式现在由它统一保证：**画布上的卡片永不相互遮挡**。
 * 在它之前，遮挡有四个独立入口，逐个堵漏很难穷尽：
 *   ① 拖拽落点只吸附列、y 自由（旧 `snapCanvasPosition` 的注释写着"刻意不避让"）；
 *   ② 手动版式一旦建立，自动排版就退出，此后**内容变高**（数据刷新/图片解码/字体加载）
 *      就会压住下方那张；
 *   ③ 新出现的卡（条件渲染）拿的是「无视手动位置」的自动槽位，可能直接落到别人身上；
 *   ④ 窗口变窄导致列数变少，旧的像素 `x` 与新列宽错位。
 *
 * 与其在四处分别判重，不如让**每次排版都过一遍压实**：不管期望位置从哪来，
 * 输出一定无重叠。这也是它设计成纯函数的原因 —— 与拖动、与 React 状态无关，可单测。
 *
 * ## 算法
 *
 * 按 `y` 升序（平手按 `x`，再按入参顺序）依次落位；每张卡只**向下**让位，
 * 让到与所有已落位的卡都隔开 `gap` 为止。因为只向下、且已落位的不再移动，
 * 所以必然终止、且结果对同一输入稳定（幂等）。
 *
 * 只向下不向上是刻意的：向上会让「内容变高」引发整列反弹，用户会看到卡片往上跳。
 *
 * @param slots - 期望位置（x 应已对齐到列）。
 * @param gap - 卡片间距（默认 {@link CANVAS_GAP}）。
 * @returns 与入参同序、但 y 已压实的新数组。
 */
export function settleCanvas(slots: readonly CanvasSlot[], gap = CANVAS_GAP): CanvasSlot[] {
  if (slots.length <= 1) return slots.map(s => ({ ...s }))

  // 落位顺序：越靠上的越先占位，于是"上面的卡不动、下面的让位"。
  const order = slots
    .map((slot, index) => ({ slot, index }))
    .sort((a, b) => a.slot.y - b.slot.y || a.slot.x - b.slot.x || a.index - b.index)

  const settled: CanvasSlot[] = []
  /** 每张卡的最终 y（按「入参下标 + id」回填，保证输出顺序与入参一致）。 */
  const finalY = new Map<string, number>()

  for (const { slot, index } of order) {
    let y = slot.y
    // 让位可能连锁（挤下去的卡又碰到更下面的卡），所以循环到不再冲突为止。
    // 每轮 y 严格增大，且已落位的卡数是有限的 ⇒ 必然收敛。
    for (let guard = 0; guard <= settled.length; guard += 1) {
      const hit = settled.find(p => conflicts({ ...slot, y }, p, gap))
      if (hit === undefined) break
      y = hit.y + hit.h + gap
    }
    settled.push({ ...slot, y })
    finalY.set(`${String(index)}:${slot.id}`, y)
  }

  return slots.map((slot, index) => ({ ...slot, y: finalY.get(`${String(index)}:${slot.id}`) ?? slot.y }))
}
