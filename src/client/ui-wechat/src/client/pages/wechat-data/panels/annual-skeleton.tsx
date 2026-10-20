/**
 * 年度报告的**加载骨架屏**（2026-10-17 重做）。
 *
 * ## 为什么不用通用的 `ListSkeleton`
 *
 * 原先这里写的是 `<ListSkeleton rows={6} />` —— 那是**列表**骨架（头像 + 一行文字 + 右侧元信息），
 * 而年度报告的实际布局是 **12 列网格 + 27 个格子**（海报卡 + 热力图 + 画像 + 各种数据卡 + 页脚）。
 * 两者形状完全不同：加载时看到 6 条横条，加载完突然变成一片卡片墙 —— 布局跳变很大，
 * 用户会觉得「刚才那是什么」。
 *
 * ## 现在的口径：**按真实布局画占位**
 *
 * 骨架屏的网格、格子宽度（`span`）、格子高度（`rows`）、格子内部结构（标题条 + 内容块）
 * 都与真实布局一致：
 *   · 网格：`repeat(12, minmax(0, 1fr))` + 固定行高 + `dense`（与 `.board` 同款）；
 *   · 格子：`span` / `rows` **逐项照抄** `Annual.tsx` 的 `<MasonryGrid>` 渲染顺序；
 *   · 格子内部：一条标题占位 + 若干内容块占位（按 `flex` 比例分配剩余高度）。
 *
 * 这样加载完成时**只有内容替换，没有布局跳变**。
 *
 * ## 为什么不做「逐卡微光动画」
 *
 * 格子有 27 个，每个都跑 `nm-skel` 的微光动画会让整屏持续闪烁 —— 比静止的占位更吵。
 * 这里只在**格子整体**上给一层很淡的呼吸（`annualSkeletonPulse`），且尊重
 * `prefers-reduced-motion`（直接静止）。
 */
import css from './annual.module.css'

/** 一个占位格子的形状：跨几列 + 内容块比例 + 语义色调。 */
interface SkeletonCell {
  /** 跨列数（与真实卡片的 `span` 一致）。 */
  span: number
  /** 内容块高度比例（`flex` 权重）；空数组 = 只有标题条。 */
  blocks: readonly number[]
  /** 语义色调（与真实卡片一致）—— 加载态与加载完的配色必须连续，否则会"闪一下换色"。 */
  tone: 'cyan' | 'purple' | 'pink' | 'green' | 'amber' | 'blue' | 'red'
}

/**
 * 占位格子的分布 —— **逐项照抄** `Annual.tsx` 里 `<MasonryGrid>` 的渲染顺序与 span。
 *
 * 2026-10-19 微信化：年度报告默认从 27 张卡收敛为 **8 张核心卡 + 页脚**
 * （其余 17 项进「更多年度数据」折叠区，首屏不再加载它们）。
 * 骨架只画默认可见的这一屏，加载完成的跳变最小。
 *
 * 顺序（12 列基准，每行整除 12）：
 *   HeroCard(6) → RhythmCard(6) → GroupsCard(6) → ExtremesCard(6)
 *   → RankingCard(3) → MoneyCard(3) → MomentsCard(3) → MediaCallCard(3) → footer(12)
 *
 * ⚠️ 改真实卡片的 span 时**必须同步这里** —— `annual-skeleton.wiring.spec.ts` 会比对。
 */
const CELLS: readonly SkeletonCell[] = [
  { span: 6, blocks: [34, 18, 18], tone: 'cyan' },    // ① HeroCard 年度概览（全年发出）
  { span: 6, blocks: [56, 40], tone: 'purple' },      // ② RhythmCard 作息切片
  { span: 6, blocks: [44, 44], tone: 'pink' },        // ③ GroupsCard 群聊年度
  { span: 6, blocks: [40, 40], tone: 'amber' },       // ④ ExtremesCard 年度之最
  { span: 3, blocks: [26, 18, 18], tone: 'pink' },    // ⑤ RankingCard 年度聊天排行
  { span: 3, blocks: [26, 18, 18], tone: 'green' },   // ⑥ MoneyCard 年度资金
  { span: 3, blocks: [26, 18, 18], tone: 'pink' },    // ⑦ MomentsCard 朋友圈年度
  { span: 3, blocks: [26, 18, 18], tone: 'blue' },    // ⑧ MediaCallCard 媒体与通话
  { span: 12, blocks: [], tone: 'cyan' },             // ⑨ footer（只有一行文字）
]

/**
 * 年度报告的加载骨架屏。
 * @returns 与真实布局同构的占位网格。
 */
export function AnnualSkeleton(): React.JSX.Element {
  return (
    <div className={css.board} data-skeleton="1" aria-hidden="true">
      {CELLS.map((c, i) => (
        <div
          key={i}
          className={css.skelCard}
          data-tone={c.tone}
          style={{ gridColumn: `span ${String(c.span)}` }}
        >
          {/* 标题条：与 `.cardHead` 同高（真实卡片是 12px 字 + 6px 下边距）。 */}
          <span className={css.skelTitle} />
          {/* 内容块：行高固定后，块高度按 `flex` 比例分配剩余空间 ——
              写死 px 会在不同档位（200/220/240px）下留白或溢出。 */}
          {c.blocks.map((h, j) => (
            <span key={j} className={css.skelBlock} style={{ flex: `${String(h)} 1 0` }} />
          ))}
        </div>
      ))}
    </div>
  )
}
