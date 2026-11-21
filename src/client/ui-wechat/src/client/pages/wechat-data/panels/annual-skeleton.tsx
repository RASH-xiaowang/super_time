/**
 * 年度报告的**加载骨架屏**（2026-11-19 随画布重做）。
 *
 * ## 为什么跟着改成画布
 *
 * 2026-11-19 起首屏 8 张卡改成**自由画布**（等宽瀑布流、高度随内容、可拖动）。
 * 骨架如果还画 12 列网格，加载完会「从网格跳成画布」—— 那正是 2026-10-17 这版骨架
 * 想解决的「布局跳变」，只是换了个方向。
 *
 * 所以骨架与真实布局**同一套机制**：同一个 `CardCanvas`、同一组 `canvasId`。
 * 等宽之后连宽度档都不用对 —— 两边都是容器统一定的列宽。
 * 区别只剩高度（占位块用固定高度，真实内容要等字体与图片）。
 *
 * ## 为什么只画前 8 张
 *
 * 2026-11-19 起整页是**一块**画布（8 张核心卡 + 17 项明细，共 25 格）。骨架只画前 8 张：
 * 瀑布流里**前面卡片的位置只由前面的高度决定**，所以这 8 格的坐标与真实布局完全一致 ——
 * 加载完成时首屏不跳，17 项只是接在后面把页面变长（那部分本来就在屏幕外）。
 * 给全部 25 格画占位反而让人以为「内容这么多」，而它们的高度全是猜的。
 *
 * ## 为什么不做逐卡微光动画
 *
 * 8 张卡各自跑微光会让整屏持续闪烁，比静止的占位更吵。只在格子整体上给一层很淡的呼吸，
 * 且尊重 `prefers-reduced-motion`（见 CSS）。
 *
 * @module panels/annual-skeleton
 */
import { CardCanvas } from './card-canvas.tsx'
import { CanvasCard } from './card-canvas-card.tsx'
import css from './card-canvas.module.css'

/** 一个占位卡的形状：内容块高度（px）+ 语义色调。 */
interface SkeletonCell {
  id: string
  /** 内容块高度（px）。空数组 = 只有标题条。 */
  blocks: readonly number[]
  tone: 'cyan' | 'purple' | 'pink' | 'green' | 'amber' | 'blue' | 'red'
}

/**
 * 占位卡 —— **与 `Annual.tsx` 首屏 8 张卡同序、同 id**。
 *
 * id 必须和真实卡一致：`CardCanvas` 的位置存储按 id 记；用了别的 id，
 * 加载完成时会出现「骨架位置残留 / 卡片重新排一遍」的顿挫。
 *
 * ⚠️ 改首屏卡片顺序时**必须同步这里** —— `annual-skeleton.wiring.spec.ts` 会比。
 */
const CELLS: readonly SkeletonCell[] = [
  { id: 'hero', blocks: [34, 18, 18], tone: 'cyan' },
  { id: 'rhythm', blocks: [56, 40], tone: 'purple' },
  { id: 'ranking', blocks: [44, 44], tone: 'pink' },
  { id: 'groups', blocks: [32, 32, 26], tone: 'pink' },
  { id: 'money', blocks: [26, 18, 18], tone: 'green' },
  { id: 'moments', blocks: [26, 18, 18], tone: 'pink' },
  { id: 'media', blocks: [26, 18, 18], tone: 'blue' },
  { id: 'extremes', blocks: [48], tone: 'amber' },
]

/**
 * 年度报告的加载骨架屏。
 * @param props.year - 年份（画布按年隔离位置，骨架也用同一年，避免多余重排）。
 * @returns 与真实布局同构的占位画布。
 */
export function CardCanvasSkeleton({ year = 0 }: { year?: number }): React.JSX.Element {
  return (
    <div className={css.skelHost} data-skeleton="1" aria-hidden="true">
      <CardCanvas year={year}>
        {CELLS.map(cell => (
          <CanvasCard key={cell.id} id={cell.id} title="" tone={cell.tone}>
            {cell.blocks.map((h, i) => (
              <span key={i} className={css.skelBlock} style={{ height: h, flex: '0 0 auto' }} />
            ))}
          </CanvasCard>
        ))}
      </CardCanvas>
    </div>
  )
}
