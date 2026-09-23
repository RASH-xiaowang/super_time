/**
 * 内容入场动效包装：无背景框，仅透明度/位移/缩放。
 *
 * 样式（data-anim）：
 *  slide-l  从左向右渐变滑出   520ms  cubic-bezier(0.22,1,0.36,1)
 *  slide-r  从右向左渐变滑出   520ms  同上
 *  slide-u  从下向上渐显       480ms  cubic-bezier(0.16,1,0.3,1)
 *  fade     淡入              600ms  ease
 *  scale    缩放渐显          500ms  cubic-bezier(0.34,1.4,0.64,1)
 *
 * 触发：首次进入视口（IntersectionObserver rootMargin -8%）；
 * 已在视口内的元素在挂载后下一帧触发（页面切换后的首屏）。
 * delayMs 用于错落 stagger。
 */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ElementType,
  type ReactNode,
} from 'react'
import css from './onboarding.module.css'

export type RevealAnim = 'slide-l' | 'slide-r' | 'slide-u' | 'fade' | 'scale'

/**
 * 动画类名查表。值刻意留 `string | undefined`：`css` 是 CSS Modules 的按键查表，
 * 收紧之后取不到就是 `undefined`（改名/漏写都会这样），而唯一的使用点
 * `[...].filter(Boolean).join(' ')` 正好容得下它 —— 在这里把类型写成 `string` 才是说谎。
 */
const ANIM_CLASS: Record<RevealAnim, string | undefined> = {
  'slide-l': css.animSlideL,
  'slide-r': css.animSlideR,
  'slide-u': css.animSlideU,
  fade: css.animFade,
  scale: css.animScale,
}

export interface RevealProps {
  children: ReactNode
  /** 入场动画类型，默认 fade */
  anim?: RevealAnim
  /** 错落延迟（ms），默认 0 */
  delayMs?: number
  /** 渲染的元素标签，默认 div */
  as?: ElementType
  className?: string
  /** 额外 style（用于非对称偏移等） */
  style?: CSSProperties
  /** 语义标签透传 */
  id?: string
}

export function Reveal({
  children,
  anim = 'fade',
  delayMs = 0,
  as: Tag = 'div',
  className,
  style,
  id,
}: RevealProps): React.JSX.Element {
  const ref = useRef<HTMLElement | null>(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    // 首屏已在视口：下一帧触发（保证 CSS 初始态已应用）
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShown(true)
            io.disconnect()
            break
          }
        }
      },
      { root: null, rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    )
    io.observe(el)
    // 若已完全在视口内，observer 会立刻回调；兜底 rAF 再查一次
    const raf = requestAnimationFrame(() => {
      const r = el.getBoundingClientRect()
      const vh = window.innerHeight || 1
      if (r.top < vh * 0.92 && r.bottom > 0) setShown(true)
    })

    return () => {
      cancelAnimationFrame(raf)
      io.disconnect()
    }
  }, [])

  return (
    <Tag
      id={id}
      ref={ref as never}
      className={[css.reveal, ANIM_CLASS[anim], shown ? css.revealIn : '', className]
        .filter(Boolean)
        .join(' ')}
      style={{ ...style, ['--reveal-delay' as string]: `${delayMs}ms` }}
    >
      {children}
    </Tag>
  )
}

/** 伪随机但稳定的动画分配（按 index 轮换，避免每次刷新跳变）。 */
export function pickAnim(index: number, pool?: RevealAnim[]): RevealAnim {
  const list = pool ?? (['slide-l', 'slide-r', 'slide-u', 'fade', 'scale'] as RevealAnim[])
  // 空池子时 `index % 0` 是 NaN ⇒ 取不到，回落成本组件文档里写明的默认动画
  return list[index % list.length] ?? 'fade'
}

/** 稳定的纵向错落（仅正值，避免与上一项重叠）。 */
export function pickOffset(index: number, span = 20): number {
  const seq = [0, 20, 8, 28, 12, 24, 4, 18, 10, 26, 6, 16]
  return (seq[index % seq.length] ?? 0) * (span / 20)
}

/** 稳定的水平错落（仅正值/0，配合 gap 避免压字）。 */
export function pickShiftX(index: number, span = 16): number {
  const seq = [0, 12, 4, 18, 8, 14, 2, 16, 6, 20, 10, 8]
  return (seq[index % seq.length] ?? 0) * (span / 16)
}
