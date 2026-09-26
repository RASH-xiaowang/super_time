/**
 * 全站栅格与卡片几何的**唯一基准**。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * `docs/UI-PANELS-PLAN.md` 的 U13（「卡片栅格与间距统一」）当时**没有做成代码改动**，
 * 理由是「无法用源码断言机械校验」，只落到一句文档口径上。那句口径随后就引起了两轮误判：
 * 它写「12 栅格 + 10px 间距」，而真源里 12px 与 10px **分别属于两个媒体查询档**
 * （宽档 `gap: 12px`、`@media (max-width: 1100px)` 紧档 `gap: 10px`），
 * 文档只引了紧档却没说是紧档 —— 照着它改宽屏面板就会得到错的间距。
 * 一份没人能校验的口径，等于没有口径。
 *
 * 所以这里把基准变成**代码 + 两档并列**：常量写在这里，由 `layout-tokens.spec.ts`
 * 对着 `overview.module.css` 逐条核对（基准与真源漂移即红），
 * `scripts/panel-audit.mjs` 再**从本文件解析**这些数字去校验真实渲染的
 * `grid-template-columns` / `gap` / `padding`（产物级复核）。
 * 于是 U13 从"文档口号"变成"两端夹住"。
 *
 * ── ⚠️ 改这里的常量之前先读 ──────────────────────────────────────────────
 * 本文件描述的是**数据总览（T01）已经落地的版式**，它是全站栅格基准（R0 起）。
 * 改这些数字**不是**"调整基准"，而是"声明全站版式要改" —— 必须同时改
 * `overview.module.css`，否则 `layout-tokens.spec.ts` 会红。
 *
 * ── 解析契约（给 panel-audit 用）──────────────────────────────────────────
 * 每条常量都写成 `export const NAME = <数字>;` 的**单行**形式，便于正则抽取：
 * `scripts/panel-audit.mjs` 读本文件后按 `GRID_GAP_PX = (\d+)` 这类模式取值。
 * 别把数字拆到多行或改成表达式 —— 解析会静默取不到值（审计脚本查不到即失败）。
 *
 * @module
 */

/** 栅格总列数（`.ovGrid` 的 `repeat(N, minmax(0, 1fr))`）—— 两档相同。 */
export const GRID_COLUMNS = 12;

/** 紧档的媒体查询阈值 px（`@media (max-width: N)`）。 */
export const COMPACT_MEDIA_MAX_PX = 1100;

/** 卡片圆角令牌（`.ovCard` 的 `border-radius`）—— 两档相同。 */
export const CARD_RADIUS_TOKEN = 'var(--nm-r-lg)';

/* ────────────── 宽档（viewport > COMPACT_MEDIA_MAX_PX）────────────── */
/* 界面审计的视口是 1440×900，生效的是这一档 —— 文档口径里最容易引错的一半。 */

/** 栅格间距 px（`.ovGrid` 的 `gap`）。 */
export const GRID_GAP_PX = 12;

/** 面板根容器的块间距 px（`.root` 的 `gap`）。 */
export const PANEL_GAP_PX = 14;

/** 卡片头部内边距（`.ovCardHd`），上下 px。 */
export const CARD_HEAD_PAD_Y = 12;

/** 卡片头部内边距，左右 px。 */
export const CARD_HEAD_PAD_X = 16;

/** 卡片头部内元素间距 px（`.ovCardHd` 的 `gap`）。 */
export const CARD_HEAD_GAP_PX = 10;

/** 卡片正文内边距（`.ovCardBd`），上下 px。 */
export const CARD_BODY_PAD_Y = 14;

/** 卡片正文内边距，左右 px。 */
export const CARD_BODY_PAD_X = 16;

/** 卡片正文内元素间距 px（`.ovCardBd` 的 `gap`）。 */
export const CARD_BODY_GAP_PX = 10;

/** 指标格的最小列宽 px（`.metricGrid` 用 auto-fit 时的 minmax 下限）。 */
export const METRIC_MIN_COL_PX = 118;

/** 指标格的间距 px。 */
export const METRIC_GAP_PX = 10;

/* ────────────── 紧档（viewport ≤ COMPACT_MEDIA_MAX_PX）────────────── */

/** 紧档：栅格间距 px。 */
export const COMPACT_GRID_GAP_PX = 10;

/** 紧档：面板根容器块间距 px。 */
export const COMPACT_PANEL_GAP_PX = 12;

/** 紧档：卡片头部上下内边距 px。 */
export const COMPACT_CARD_HEAD_PAD_Y = 8;

/** 紧档：卡片头部左右内边距 px。 */
export const COMPACT_CARD_HEAD_PAD_X = 12;

/** 紧档：卡片头部内元素间距 px。 */
export const COMPACT_CARD_HEAD_GAP_PX = 8;

/** 紧档：卡片正文上下内边距 px。 */
export const COMPACT_CARD_BODY_PAD_Y = 10;

/** 紧档：卡片正文左右内边距 px。 */
export const COMPACT_CARD_BODY_PAD_X = 12;

/** 紧档：卡片正文内元素间距 px。 */
export const COMPACT_CARD_BODY_GAP_PX = 8;

/** 紧档：指标格最小列宽 px。 */
export const COMPACT_METRIC_MIN_COL_PX = 150;

/** 紧档：指标格间距 px。 */
export const COMPACT_METRIC_GAP_PX = 8;

/* ────────────── 派生与守卫 ────────────── */

/** 全站允许的卡片跨列档位（`grid-column: span N`）—— 只许这些值，避免出现 11 这种孤儿档。 */
export const GRID_SPAN_STEPS: readonly number[] = [4, 5, 6, 7, 8, 12];

/**
 * 取某一档的栅格间距。
 * @param compact - 是否取紧档。
 * @returns 间距 px。
 */
export function gridGap(compact: boolean): number {
  return compact ? COMPACT_GRID_GAP_PX : GRID_GAP_PX;
}

/**
 * 取某一档的面板块间距。
 * @param compact - 是否取紧档。
 * @returns 间距 px。
 */
export function panelGap(compact: boolean): number {
  return compact ? COMPACT_PANEL_GAP_PX : PANEL_GAP_PX;
}

/**
 * 把卡片头部内边距拼成 CSS 简写（与 `.ovCardHd` 的字面量逐字一致）。
 * @param compact - 是否取紧档，默认 false。
 * @returns 形如 `12px 16px` 的简写。
 */
export function cardHeadPadding(compact = false): string {
  return compact
    ? `${COMPACT_CARD_HEAD_PAD_Y}px ${COMPACT_CARD_HEAD_PAD_X}px`
    : `${CARD_HEAD_PAD_Y}px ${CARD_HEAD_PAD_X}px`
}

/**
 * 把卡片正文内边距拼成 CSS 简写（与 `.ovCardBd` 的字面量逐字一致）。
 * @param compact - 是否取紧档，默认 false。
 * @returns 形如 `14px 16px` 的简写。
 */
export function cardBodyPadding(compact = false): string {
  return compact
    ? `${COMPACT_CARD_BODY_PAD_Y}px ${COMPACT_CARD_BODY_PAD_X}px`
    : `${CARD_BODY_PAD_Y}px ${CARD_BODY_PAD_X}px`
}

/**
 * 栅格列模板的期望**源码**字面量（用于与 CSS 源码逐字比对）。
 * @returns 形如 `repeat(12, minmax(0, 1fr))`。
 */
export function gridTemplateLiteral(): string {
  return `repeat(${GRID_COLUMNS}, minmax(0, 1fr))`
}

/**
 * 数一段**已计算**的 `gridTemplateColumns` 值里有几条轨道。
 *
 * 浏览器会把 `repeat(12, minmax(0, 1fr))` 展开成 12 个具体像素值，
 * 所以产物级复核**不能**拿源码字面量比对，只能数轨道条数。
 * `none`（非 grid）返回 0；未展开的 `repeat(n, …)` 按 n 计。
 * @param computed - `getComputedStyle(el).gridTemplateColumns` 的返回值。
 * @returns 轨道条数；无法解析时返回 0。
 */
export function countGridTracks(computed: string): number {
  const value = String(computed ?? '').trim()
  if (value === '' || value === 'none') return 0
  const repeated = /repeat\(\s*(\d+)\s*,/.exec(value)
  if (repeated) return Number(repeated[1])
  return value.split(/\s+/).filter((s) => s !== '').length
}
