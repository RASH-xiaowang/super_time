/**
 * 词云的**布局算法**（纯函数，2026-09-30 重做「全部热词」时从卡片里拆出来）。
 *
 * ## 为什么要自己写撒点，而不是继续 flex-wrap
 *
 * 旧实现是 `flex-wrap` 排成一行行：字号虽有六档，但**权重曲线是线性的**，而真实词频是
 * 长尾 —— `t = (count − min) / span` 在 60 个词里只有前几个大于 0.5，其余全部落到第一档
 * 12px。眼睛看到的就是「一个大词 + 一坨一样大的小词」，像列表而不像词云（用户 2026-09-30
 * 的截图反馈正是这个）。参照稿（科技风词云）要的是：**大小悬殊、颜色交错、密排成团**。
 *
 * 三件事各自独立：
 *   ① **字号**：按名次分位 + 权重比混合，再走一条 1.35 次幂的曲线 —— 头部缓慢下降、
 *      尾部快速变小，长尾数据也能拉开 3 倍以上的对比；
 *   ② **颜色**：六阶霓虹（灰 / 蓝 / 青 / 紫 / 洋红 / 琥珀），并且**同尺寸的相邻词换色**，
 *      避免密集区糊成一块同色；
 *   ③ **落点**：中心向外的阿基米德螺线 + 轴对齐矩形碰撞检测，放不下就试竖排，再放不下
 *      才丢词 —— 绝不重叠。
 *
 * ## 三条纪律
 *
 *   · **不测量 DOM、不用 canvas**：文字宽度按码元推进量估算（CJK 1.0em、ASCII 0.55~0.68em），
 *     所以本模块在 Node / SSR 下也能跑，测试不必起浏览器；估计值刻意**偏大 4%**
 *     （重叠比多留一点白糟糕得多）。
 *   · **确定性**：没有 `Math.random` —— 同一份输入永远得到同一份布局，
 *     否则「同一次统计刷新后词云跳一下」和「测试偶发红」都会来。
 *   · **命中区 = 视觉位置**：每个词带完整 `width/height`，渲染侧按同一组数字绝对定位，
 *     点击区因此与看到的字严丝合缝（这也回应了 CSS 里原来那条「不做绝对定位撒点」的顾虑：
 *     顾虑成立的前提是随机撒点、不设盒；这里是带盒的确定性布局）。
 *
 * @module wordcloud-layout
 */

/**
 * 字号阶梯（px）：最大 / 最小 = 4 倍。
 *
 * 为什么是 12→48 而不是更保守的 12→28：参照稿（科技风词云）的视觉冲击就来自**首词压倒性地大**，
 * 而词云的填充率 ∝ 最大字号的平方 —— 12~28 时整团只占画布约四成宽，看着像浮在空框里。
 * 48 起步后首词成为真正的视觉焦点，四周的小词才有「围着它铺开」的感觉。
 */
export const CLOUD_FONT_STEPS = [12, 15, 18, 22, 27, 33, 40, 48] as const

/**
 * 小舞台等比缩放后的**字号下限**（9px）。
 *
 * 中文 9px 偏小，但这是用户明确选择的取舍："宁小也要有层次" ——
 * 120px 高的扁舞台里，字号范围是 9–14px 五档，比"全挤在 12–14"能看出词频差。
 */
export const CLOUD_FONT_MIN = 9

/**
 * 字号上限：**跟着舞台高度走**（2026-09-30 用户："词云字体整体过大，需要调整为协调合适的字号"）。
 *
 * 阶梯顶档 48px 是给 200–420px 高的主词云舞台定的；年度报告里那块小词云只有 120px 高，
 * 一个 48px 的词就占了舞台的 40%，视觉上"糊成一片"。
 *
 * 分两段（**大舞台必须逐像素不变**，所以不能只调一个系数）：
 *   · `h ≥ 200`：按 24% 封顶 ⇒ 200 → 48、420 → 100 ⇒ 取 48（与改动前完全一致）
 *   · `h < 200`：按 **12%** 封顶 ⇒ 120 → **14**、160 → 19；配合阶梯低端的 9/10/11 三档，
 *     历程：24% 时 120→29 用户说大 → 16% 时 120→19 仍说大 → 12% 时 120→**14**（阶梯下限 12px，再低就没有字号层次了）
 * @param stageHeight - 舞台高度（px）。
 * @returns 允许的最大字号（px）。
 */
export function cloudFontCap(stageHeight: number): number {
  const top = CLOUD_FONT_STEPS[CLOUD_FONT_STEPS.length - 1]!
  const bottom = CLOUD_FONT_STEPS[0]!
  if (!Number.isFinite(stageHeight) || stageHeight <= 0) return top
  const ratio = stageHeight >= 200 ? 0.24 : 0.12
  return Math.max(bottom, Math.min(top, Math.round(stageHeight * ratio)))
}

/** 默认词数（前端卡片用它作为"宽度还没量到"时的取值）。 */
export const DEFAULT_CLOUD_LIMIT = 120
/**
 * 每个词在画布上大约占多宽（px）：把「画布宽度」换算成「要多少个词」。
 *
 * 为什么词数必须跟着宽度走（2026-09-30 实测）：固定 120 个词在 700px 宽的面板上**丢 56 个**
 * （尾部整片消失），而在 1600px 上又只覆盖 42%（四周照样留白）。`宽度 / 9.7` 给出的
 * 是「这块画布装得下的词数」：700→72、900→93、1160→120、1600→165。
 */
export const PX_PER_WORD = 9.7
/** 词数的硬上下界：下限 60（词太少看不出是一团云）、上限 400（`queryWordCloud` 的硬上界）。 */
export const CLOUD_LIMIT_MIN = 60
export const CLOUD_LIMIT_MAX = 400

/**
 * 画布宽度 → 要多少个词。
 * @param width - 画布宽度（px）；`<= 0` 表示还没量到（SSR / 首帧），这时用 `fallback`。
 * @param fallback - 量不到宽度时的词数（默认 {@link DEFAULT_CLOUD_LIMIT}）。
 * @returns 夹在 [60, 200] 内的词数。
 */
export function cloudLimitForWidth(width: number, fallback?: number): number {
  const base = Math.min(Math.max(1, fallback ?? DEFAULT_CLOUD_LIMIT), CLOUD_LIMIT_MAX)
  if (!(width > 0)) return base
  return Math.min(Math.max(CLOUD_LIMIT_MIN, Math.round(width / PX_PER_WORD)), CLOUD_LIMIT_MAX)
}

/** 六阶霓虹配色（类名对应 `wordcloud-card.module.css`）。 */
export const CLOUD_TONES = ['low', 'mid', 'high', 'top', 'peak', 'hot'] as const

/** 颜色类名。 */
export type CloudTone = (typeof CLOUD_TONES)[number]

/** 一个词的入参（`count` 用于 title 与曲线，`text` 用于宽度估算）。 */
export interface CloudWordInput {
  text: string
  count: number
  size: number
}

/** 布局结果里的一个词：入参 + 落点与盒尺寸。 */
export interface PlacedCloudWord extends CloudWordInput {
  tone: CloudTone
  x: number
  y: number
  width: number
  height: number
  /** 竖排（横着放不下时试出来的方向）。 */
  vertical: boolean
}

/** 整幅布局。 */
export interface CloudLayoutResult {
  width: number
  height: number
  placed: PlacedCloudWord[]
  /** 放不下而被丢掉的词数（宁可少画几个，也不重叠）。 */
  dropped: number
}

/**
 * 容器高度：比 16:9 更扁（词云本身横向铺开），上下夹住。
 *
 * 上限 2026-09-30 由 360 放宽到 420：宽屏（≥1600px）下按 0.36 算会被 360 提前夹住，
 * 画布越来越扁 ⇒ 同样多的词只能缩在中间（实测 1600px 下覆盖率掉到 48%）。
 * 0.34 的斜率 + 420 的上限让宽屏也有一块够高的画布。
 * @param width - 画布宽度（由 `ResizeObserver` 量到）。
 */
export function cloudStageHeight(width: number): number {
  return Math.max(200, Math.min(420, Math.round(width * 0.34)))
}

/**
 * 单个码元的推进量（em）。表是**估宽**用的，不是字体度量 —— 取整偏大一点更安全。
 * @param code - `codePointAt(0)`。
 * @returns 该字符占多少 em。
 */
function advanceOf(code: number): number {
  if (code >= 0x2e80 && code <= 0x9fff) return 1 // CJK 统一表意 / 部首扩展
  if (code >= 0xff00 && code <= 0xff60) return 1 // 全角
  if (code >= 0x3000 && code <= 0x303f) return 1 // CJK 标点
  if (code === 0x20) return 0.32
  if (code >= 0x30 && code <= 0x39) return 0.58 // 0-9
  if (code >= 0x41 && code <= 0x5a) return 0.68 // A-Z
  if (code >= 0x61 && code <= 0x7a) return 0.56 // a-z
  return 0.5
}

/**
 * 估算一段文字在给定字号下的宽度（px）。
 *
 * 为什么不测量 DOM：本模块要能在 SSR / Node 下跑（`ui:smoke` 会渲染面板），
 * 而且 60 个词各做一次 `getBoundingClientRect` 会触发 60 次强制布局。
 * @param text - 词。
 * @param size - 字号（px）。
 * @returns 估算宽度（向上取整，含 4% 余量）。
 */
export function estimateTextWidth(text: string, size: number): number {
  let units = 0
  for (const ch of text) units += advanceOf(ch.codePointAt(0) ?? 0)
  return Math.ceil(units * size * 1.04)
}

/**
 * 名次 + 权重 → 字号档（0 = 最小）。
 *
 * 两个分量缺一不可：
 *   · **名次分量** `(1 − i/(n−1))^1.35` 保证**任何**分布都能拉开对比（长尾数据里
 *     纯按次数归一化会让 90% 的词挤在最低档 —— 这正是重做前的问题）；
 *   · **权重分量** `(count − min)/span` 保证「同名次但次数差得多」时大词仍然更大。
 * @param index - 名次（0 起，已按次数降序）。
 * @param total - 词数。
 * @param count - 该词次数。
 * @param min - 最小次数。
 * @param span - 最大 − 最小（至少 1）。
 * @returns `CLOUD_FONT_STEPS` 的下标。
 */
export function cloudFontStep(index: number, total: number, count: number, min: number, span: number): number {
  const rank = total <= 1 ? 0 : index / (total - 1)
  const rankScore = Math.pow(1 - rank, 1.35)
  const weightScore = (count - min) / span
  const score = 0.65 * rankScore + 0.35 * weightScore
  const step = Math.round(score * (CLOUD_FONT_STEPS.length - 1))
  return Math.max(0, Math.min(CLOUD_FONT_STEPS.length - 1, step))
}

/** 字号档 → 基础色阶（大词走暖色重音，小词退到中性）。 */
const TONE_BY_STEP: readonly CloudTone[] = ['low', 'mid', 'high', 'high', 'top', 'peak', 'hot', 'hot']

/**
 * 字号档 + 序号 → 色阶。
 *
 * 为什么要「同档换色」：参照稿的密集区是**多色交错**的；若同档同色，中间那一大片
 * 16~21px 的词会连成一条同色的带子，反而更像列表。这里每第 4 个词沿色环挪一格
 * （用常量表而不是随机数：布局必须确定性可测）。
 * @param step - 字号档下标。
 * @param index - 名次。
 * @returns 色阶类名。
 */
export function cloudTone(step: number, index: number): CloudTone {
  const base: CloudTone = TONE_BY_STEP[Math.max(0, Math.min(TONE_BY_STEP.length - 1, step))] ?? 'low'
  if (index % 4 !== 3) return base
  const at = CLOUD_TONES.indexOf(base)
  return CLOUD_TONES[(at + 1) % CLOUD_TONES.length] ?? base
}

/** 两个盒子是否相交（含间距）。 */
function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
  gap: number,
): boolean {
  return a.x < b.x + b.width + gap
    && b.x < a.x + a.width + gap
    && a.y < b.y + b.height + gap
    && b.y < a.y + a.height + gap
}

/**
 * 螺线参数：角度步长、起始半径、半径增长、纵向压扁（画面是宽屏）。
 *
 * ── 为什么要「三段采样」（2026-09-30 实测调出来的）───────────────────────────
 * 固定角步长 0.19 rad 时，相邻采样点在半径 300px 处相距 57px：大词照旧能落，小词却会在
 * 「两个采样点之间明明有缝」的地方被判成放不下（200 词时丢掉 30%）。
 * 试过「按弧长自适应步长」——更糟：小词的步长太细，`MAX_TRIES` 在半径 281px 处就烧光了，
 * 画布外圈根本没搜到（丢词反而涨到 40%）。原因是**采样点数必须随半径平方增长**才能均摊
 * 覆盖面积，这个预算在交互帧里给不起。
 *
 * 所以改成两族采样，各自都便宜且覆盖全局：
 *   ① **螺线四相位**（0 / ¼ / ½ / ¾ 步）：同一条螺线上错开采样，把沿臂的 57px 空档切成 1/4；
 *   ② **黄金角散点两相位**（`θ = 相移 + i × 2.39996`，半径按 √t 铺满）：专门找螺线扫不到的
 *      零星缝隙。
 * 两族都没位置才缩字号，缩到底还不行才丢词。实测（`wordcloud-layout.spec.ts` 的诊断输出，
 * 画布 1160×360）：**60 词丢 0（2.2ms）、120 词丢 0（6.9ms）、200 词丢 11（42ms）**。
 */
const THETA_STEP = 0.19
const RADIUS_BASE = 6
const RADIUS_GROWTH = 2.35
const VERTICAL_SQUASH = 0.58
/** 单段采样上限。 */
const MAX_TRIES = 1400
/** 第三段（黄金角）的点数。 */
const SCATTER_POINTS = 900
/** 黄金角（弧度）：散点的角度增量，保证不重复走同一条辐射线。 */
const GOLDEN_ANGLE = 2.399963229728653
/** 螺线扫到画布对角线的这个比例就停 —— 再往外都在框外，纯属空转。 */
const RADIUS_REACH = 0.62
/**
 * 空间网格边长（px）：碰撞检测只跟**附近格子**里的盒子比。
 * 没有它，200 个词 × 每次几千个采样点 × 逐个比 200 个盒子 = 上亿次比较。
 */
const CELL = 56
/** 实在放不下时的**缩字**下限（px）：词云的尾部本来就该小，缩小比丢掉好。 */
const SHRINK_FLOOR = 11
/** 缩字步长（px）。 */
const SHRINK_STEP = 3
/**
 * 「铺满」第一步的上限：把整团**等比**放大到贴住内边距（字号跟着变大）。
 * 为什么需要它：螺线撒点是「中心向外找到位置就停」，词放完时整团往往只占画布中间一小块
 * （2026-09-30 用户截图：整团只占约 40% 宽，四周全是空白）。等比放大直接增加墨量。
 */
const GROW_CAP = 1.45
/**
 * 「铺满」第二步的上限：把词的位置**非等比**拉开，让最外圈顶到内边距上。
 *
 * ⚠️ 上限刻意压得很小（1.2）。2026-09-30 第一版给到 2.4，结果整团被拉成一根根**竖条** ——
 * 位置拉开的比例同样作用在间隙上，词少的时候间隙会比词还宽，看起来比原来更空。
 * 真正决定"铺得满不满"的是**有多少词**（见 `WordCloudCard` 的 limit），这一步只负责把
 * 边缘那点余量抹掉。只挪位置、不改盒子尺寸，所以**不可能**因此产生重叠。
 */
const SPREAD_CAP = 1.2

/**
 * 在一个 `width × height` 的画布里，把词从中心向外铺开。
 *
 * 词表必须**已按权重降序**（大词先落，中心自然是最大的那几个 —— 这是词云的视觉核心）。
 * @param words - 已算好字号与色阶的词（`tone` 由调用方给 `cloudTone` 得到）。
 * @param opts - 画布尺寸与词间距。
 * @returns 布局结果（含被丢掉的词数）。
 */
export function layoutWordCloud(
  words: ReadonlyArray<CloudWordInput & { tone: CloudTone }>,
  opts: { width: number; height: number; gap?: number },
): CloudLayoutResult {
  const width = Math.max(120, Math.round(opts.width))
  const height = Math.max(120, Math.round(opts.height))
  /** 字号上限：跟着舞台高度走（小舞台配大字会糊成一片）。 */
  const maxFont = cloudFontCap(height)
  /**
   * 小舞台的**等比缩放**：`scale < 1` 时把每个词的字号按比例缩下来，下限 {@link CLOUD_FONT_MIN}。
   *
   * 为什么不是"把超过上限的档位一刀切平"（min(size, cap)）：那样所有靠前的词都撞到同一个上限，
   * 字号只差几像素，**词频层次就没了**。等比缩放保住了层次，同时允许缩到 12px 以下（用户明确选择的取舍）。
   * 大舞台（cap = 阶梯顶档）⇒ scale = 1 ⇒ 逐像素不变，主词云面板不受影响。
   */
  const fontScale = Math.min(1, maxFont / (CLOUD_FONT_STEPS[CLOUD_FONT_STEPS.length - 1] ?? 48))
  const scaledSize = (n: number): number => Math.max(CLOUD_FONT_MIN, Math.round(n * fontScale))
  const gap = opts.gap ?? 4
  const pad = 6
  const placed: PlacedCloudWord[] = []
  let dropped = 0

  /** 格子 key。 */
  const keyOf = (cx: number, cy: number): string => `${String(cx)}:${String(cy)}`
  /** 空间索引：格子 → `placed` 下标。盒子按「外扩 gap」的覆盖范围登记。 */
  const grid = new Map<string, number[]>()
  const insert = (index: number): void => {
    const p = placed[index]!
    const x0 = Math.floor((p.x - gap) / CELL)
    const x1 = Math.floor((p.x + p.width + gap) / CELL)
    const y0 = Math.floor((p.y - gap) / CELL)
    const y1 = Math.floor((p.y + p.height + gap) / CELL)
    for (let cy = y0; cy <= y1; cy += 1) {
      for (let cx = x0; cx <= x1; cx += 1) {
        const k = keyOf(cx, cy)
        const arr = grid.get(k)
        if (arr) arr.push(index)
        else grid.set(k, [index])
      }
    }
  }
  /** 候选盒是否跟已落位的任一个相撞（只查它覆盖的格子）。 */
  const collides = (box: { x: number; y: number; width: number; height: number }): boolean => {
    const x0 = Math.floor(box.x / CELL)
    const x1 = Math.floor((box.x + box.width) / CELL)
    const y0 = Math.floor(box.y / CELL)
    const y1 = Math.floor((box.y + box.height) / CELL)
    for (let cy = y0; cy <= y1; cy += 1) {
      for (let cx = x0; cx <= x1; cx += 1) {
        const arr = grid.get(keyOf(cx, cy))
        if (!arr) continue
        for (const i of arr) if (overlaps(box, placed[i]!, gap)) return true
      }
    }
    return false
  }

  for (const word of words) {
    // 先按自己的字号试；塞不下就**逐档缩小**再试（词云尾部本来就该小，缩小比丢词好），
    // 一路缩到 SHRINK_FLOOR 还放不下才记 dropped。
    let hit: { x: number; y: number; width: number; height: number; vertical: boolean } | null = null
    // 先按"上限与自身字号取小"来试：上限由舞台高度决定（120px 高的舞台里 48px 的字会糊成一片）
    const start = scaledSize(word.size)
    let usedSize = start
    // ⚠️ 下限取 min(SHRINK_FLOOR, start)：小舞台等比缩放后 start 可能小于 SHRINK_FLOOR（9 < 11），
    // 写成 `size >= SHRINK_FLOOR` 会让循环**一次都不执行** ⇒ 这些词全被判"放不下"丢掉，
    // 词云里就只剩几个大词（2026-09-30 用户："词云个数才有这几个"）。
    const shrinkFloor = Math.min(SHRINK_FLOOR, start)
    for (let size = start; size >= shrinkFloor; size -= SHRINK_STEP) {
      const horizontal = { width: estimateTextWidth(word.text, size), height: Math.ceil(size * 1.2) }
      // 竖向：盒子把宽高对调（竖排文字的高度 = 横排时的宽度）
      const vertical = { width: horizontal.height, height: horizontal.width }
      hit = placeOne(horizontal, false) ?? placeOne(vertical, true)
      usedSize = size
      if (hit !== null) break
    }
    if (hit === null) {
      dropped += 1
      continue
    }
    placed.push({
      text: word.text,
      count: word.count,
      size: usedSize,
      tone: word.tone,
      x: hit.x,
      y: hit.y,
      width: hit.width,
      height: hit.height,
      vertical: hit.vertical,
    })
    insert(placed.length - 1)
  }

  return fillStage({ width, height, placed, dropped }, pad)

  /**
   * 铺满画布：① 等比放大 ② 位置非等比拉开。两步都**不可能**引入重叠。
   *
   * 为什么不是"一开始就用更大的字号"：字号得先由**有多少词、词有多长**决定（那是螺线
   * 能不能塞下的前提），铺满只能在**已经放好之后**按实际外接框去补 —— 否则词数一变化
   * 就得重标一遍尺寸。
   * @param layout - 撒点结果。
   * @param pad - 内边距（复用撒点那一份，别写两个数）。
   */
  function fillStage(layout: CloudLayoutResult, pad: number): CloudLayoutResult {
    const list = layout.placed
    if (list.length === 0) return layout
    const usableW = Math.max(1, layout.width - pad * 2)
    const usableH = Math.max(1, layout.height - pad * 2)

    // ① 等比放大：字号与间距一起长大，整团贴住较紧的那条边（上限 GROW_CAP）。
    const b1 = boundsOf(list)
    const grow = Math.min(GROW_CAP, usableW / Math.max(1, b1.maxX - b1.minX), usableH / Math.max(1, b1.maxY - b1.minY))
    if (grow > 1.001) {
      const cx = (b1.minX + b1.maxX) / 2
      const cy = (b1.minY + b1.maxY) / 2
      for (const p of list) {
        p.width = Math.round(p.width * grow)
        p.height = Math.round(p.height * grow)
        p.size = Math.round(p.size * grow)
        p.x = Math.round(cx + (p.x - cx) * grow)
        p.y = Math.round(cy + (p.y - cy) * grow)
      }
    }

    // ② 位置非等比拉开（**按外接框中心缩放**，不是锚左边缘）+ ③ 按最终外接框居中。
    //    只改坐标、不改盒子尺寸 ⇒ 任意两盒的距离只增不减 ⇒ 不会重叠。
    //
    //    ⚠️ 两条都是 2026-09-30 用户报「全屏状态下没有整体水平居中」之后改对的：
    //    · 第一版把外接框左边缘钉在 `pad` 上 ⇒ 宽画布下 sx 被 SPREAD_CAP 截住，整团贴左；
    //    · 第二版改成按 bbox 两端对半分，仍差约 10px —— 因为缩的是**左边缘**、而盒子宽度不变，
    //      右边缘比左边缘少缩 `w*(sx-1)`。所以先按中心缩放，最后再用**最终外接框**
    //      算一次平移把余量精确平分（这一平移对"没被拉开"的情形同样适用）。
    const b2 = boundsOf(list)
    const spanX = Math.max(1, b2.maxX - b2.minX)
    const spanY = Math.max(1, b2.maxY - b2.minY)
    const sx = Math.min(SPREAD_CAP, usableW / spanX)
    const sy = Math.min(SPREAD_CAP, usableH / spanY)
    if (sx > 1.001 || sy > 1.001) {
      const cx2 = (b2.minX + b2.maxX) / 2
      const cy2 = (b2.minY + b2.maxY) / 2
      for (const p of list) {
        p.x = Math.round(cx2 + (p.x - cx2) * sx)
        p.y = Math.round(cy2 + (p.y - cy2) * sy)
      }
    }
    // 居中：按最终外接框把左右（上下）余量平分；再夹一次保证不越界 —— 极端输入下
    // 宁可退化成贴边，也不能把词推出画布。
    const b3 = boundsOf(list)
    const centeredX = pad + (usableW - (b3.maxX - b3.minX)) / 2 - b3.minX
    const centeredY = pad + (usableH - (b3.maxY - b3.minY)) / 2 - b3.minY
    const dx = Math.round(Math.min(Math.max(pad - b3.minX, centeredX), layout.width - pad - b3.maxX))
    const dy = Math.round(Math.min(Math.max(pad - b3.minY, centeredY), layout.height - pad - b3.maxY))
    for (const p of list) {
      p.x += dx
      p.y += dy
    }
    return layout
  }

  /**
   * 把**一个**盒子找位置：先两段错相螺线，再一段黄金角散点。
   * @param box - 盒尺寸（横向或竖向）。
   * @param isVertical - 这一轮试的是不是竖排。
   * @returns 找到的落点，或 null（三段都没放下）。
   */
  function placeOne(
    box: { width: number; height: number },
    isVertical: boolean,
  ): { x: number; y: number; width: number; height: number; vertical: boolean } | null {
    /** 试一个候选点；在框内且不撞就返回它的落点。 */
    const attempt = (x: number, y: number): { x: number; y: number; width: number; height: number; vertical: boolean } | null => {
      const px = Math.round(x - box.width / 2)
      const py = Math.round(y - box.height / 2)
      if (px < pad || py < pad || px + box.width > width - pad || py + box.height > height - pad) return null
      const candidate = { x: px, y: py, width: box.width, height: box.height }
      return collides(candidate) ? null : { ...candidate, vertical: isVertical }
    }

    const cx = width / 2
    const cy = height / 2
    const thetaMax = ((Math.hypot(width, height) * RADIUS_REACH) - RADIUS_BASE) / RADIUS_GROWTH
    // ①② 螺线四相位（0 / ¼ / ½ / ¾ 步）：把沿臂的空档切成 1/4
    for (const phase of [0, THETA_STEP / 2, THETA_STEP / 4, (THETA_STEP * 3) / 4]) {
      for (let k = 0; k < MAX_TRIES; k += 1) {
        const theta = phase + k * THETA_STEP
        if (theta > thetaMax) break
        const radius = RADIUS_BASE + RADIUS_GROWTH * theta
        const hit = attempt(cx + radius * Math.cos(theta), cy + radius * Math.sin(theta) * VERTICAL_SQUASH)
        if (hit) return hit
      }
    }
    // ③ 黄金角散点两套（相位错开）：螺线扫不到的零星缝隙（半径按 √t 铺满整幅画布）
    const reach = Math.hypot(width, height) * RADIUS_REACH
    for (const phase of [0, GOLDEN_ANGLE / 2]) {
      for (let i = 0; i < SCATTER_POINTS; i += 1) {
        const t = (i + 0.5) / SCATTER_POINTS
        const radius = Math.sqrt(t) * reach
        const theta = phase + i * GOLDEN_ANGLE
        const hit = attempt(cx + radius * Math.cos(theta), cy + radius * Math.sin(theta) * VERTICAL_SQUASH)
        if (hit) return hit
      }
    }
    return null
  }
}

/** 一组盒子的外接框（`fillStage` 用它算"整团现在占多大"）。 */
function boundsOf(boxes: ReadonlyArray<{ x: number; y: number; width: number; height: number }>): {
  minX: number
  minY: number
  maxX: number
  maxY: number
} {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const b of boxes) {
    if (b.x < minX) minX = b.x
    if (b.y < minY) minY = b.y
    if (b.x + b.width > maxX) maxX = b.x + b.width
    if (b.y + b.height > maxY) maxY = b.y + b.height
  }
  return { minX, minY, maxX, maxY }
}

/** 为了断言方便：一个词在画布上的盒子是否与已有盒子全部不相交。 */
export function boxesDisjoint(
  box: { x: number; y: number; width: number; height: number },
  others: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
  gap = 0,
): boolean {
  return others.every((o) => !overlaps(box, o, gap))
}
