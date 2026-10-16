/**
 * 内容分组的语义容器。
 *
 * 这里**没有**入场动画，而且以前也没有：组件原先挂 `cssstages.reveal` + 五个 `animXxx` 类、
 * 用 `IntersectionObserver` 加一个 `shown` 状态去切 `css.revealIn`，但那六个类在本仓库所有 CSS 里
 * **只出现在 `@media (prefers-reduced-motion: reduce)` 那一段**（没有任何基线规则把元素设成
 * `opacity:0` 或带位移），`revealIn` 与 `--reveal-delay` 则是从来没被定义/读取过。
 * 于是每个 `<Reveal>` 都白挂一个 observer + 一次 rAF，而画面从首帧起就是最终样子。
 * 2026-09-25 把这些死代码连同那六个只在 reduce 段里出现的类一起删掉（行为逐字不变）；
 * 真要加动效就照上面那段注释重新实现一遍，别再留一套"看起来有"的机制。
 */
import type { CSSProperties, ElementType, ReactNode } from 'react'

export interface RevealProps {
  children: ReactNode
  /** 渲染的元素标签，默认 div */
  as?: ElementType
  className?: string
  style?: CSSProperties
  /** 语义标签透传 */
  id?: string
}

export function Reveal({
  children,
  as: Tag = 'div',
  className,
  style,
  id,
}: RevealProps): React.JSX.Element {
  return (
    <Tag id={id} className={className} style={style}>
      {children}
    </Tag>
  )
}
