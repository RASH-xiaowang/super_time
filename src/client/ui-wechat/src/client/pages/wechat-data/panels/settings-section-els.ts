/**
 * 设置内容区「各节元素」的缓存（滚动侦测用）。
 *
 * 为什么单独一份：`settings-state.tsx` 已经在 M21 的单文件行数棘轮上（上限 1000 行），
 * 而这段是**与状态无关的纯工具**（输入一个容器、输出一组元素），没有理由占它的行数。
 *
 * ── 为什么需要缓存 ────────────────────────────────────────────────
 * `onPaneScroll` 每帧都要知道「16 节各自的顶端在哪」，原先每帧都跑一次
 * `box.querySelectorAll('[data-settings-section]')` —— 那是**每帧一次全子树选择器匹配**，
 * 而设置页有 16 节、上千个节点。缓存之后只在节数变化时重建。
 *
 * ── 为什么用「节数」当失效判据而不是 MutationObserver ──────────────
 * 节是**静态结构**（15 个 `<section data-settings-section>` 由 JSX 直接写死，
 * 不随筛选/加载增删），唯一会变的是「异步内容把某一节撑高」—— 那不影响元素身份，
 * 只影响位置，而位置是每帧现读 `getBoundingClientRect` 的。所以节数一致即可复用。
 * 用 MutationObserver 反而要在每次内容沉降时重建，得不偿失。
 */

/** 容器 → 各节元素。WeakMap 让容器被卸载后缓存自然回收。 */
const cache = new WeakMap<HTMLElement, HTMLElement[]>()

/**
 * 取内容区里各节元素（按文档顺序），带缓存。
 * @param box - 内容区滚动容器。
 * @returns 各节元素；节数变化时重建缓存。
 */
export function sectionEls(box: HTMLElement): HTMLElement[] {
  const cached = cache.get(box)
  if (cached && cached.length === box.querySelectorAll('[data-settings-section]').length) return cached
  const fresh = Array.from(box.querySelectorAll<HTMLElement>('[data-settings-section]'))
  cache.set(box, fresh)
  return fresh
}
