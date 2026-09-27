/**
 * 「微信数据总览」的霓虹皮肤零件（2026-09-27）：**背景层**与**等距指标牌**。
 *
 * ## 为什么单独成文件
 *
 * ① 面板本体（`overview-panel.tsx#OverviewPanel`）在 `function-size-ratchet.spec.ts` 里是
 *    登记过的（442 行，只许变小）—— 把这两块塞回去当场撞闸门。搬出来之后本体反而更短。
 * ② 这两个零件都是**纯展示**：不吃 hooks 之外的任何东西，也不发起查询（背景层的粒子是本地画的，
 *    地图数据仍由 `WorldMapPanel` 那条既有链路负责）。视觉层与数据层分家，改皮肤不会碰到取数。
 *
 * ## 降级（三处，都是"宁可少动"）
 *
 * · `prefers-reduced-motion: reduce` ⇒ 粒子只画一帧、极光的漂移由 CSS 关掉；
 * · 拿不到 2d 上下文（jsdom 之类）⇒ 直接跳过，不抛错、不刷控制台
 *   （留白审计会把渲染层 console error 当失败，这条必须干净）；
 * · 面板不可见（切页签 / 窗口最小化）⇒ 停帧，不让一个背景把 CPU 一直烧着。
 *
 * @module overview-neonx
 */

import { useEffect, useRef } from 'react'
import type { OverviewInsights, OverviewSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { CARDS } from './overview-parts.tsx'
import { fmtBytes } from '../utils/format.ts'
import neon from './overview-neon.module.css'

/** 粒子数：够密到看得出"流"，又不至于让背景抢内容。 */
const PARTICLES = 96
/** 相邻粒子的连线距离（视口像素）。 */
const LINK_DIST = 132
/** 目标帧率：背景层不需要 60fps，省下来的算力留给面板本身。 */
const FRAME_MS = 32

interface Dot { x: number; y: number; vx: number; vy: number; r: number; warm: boolean }

/**
 * 背景层：极光（CSS 动画）+ 等距网格（CSS 渐变）+ 粒子流（画布）。
 *
 * 粒子落点偏上（设计稿里"数据流动"贴着地图那一段），连线用 `lighter` 混合叠出光感。
 * @returns 背景元素（绝对定位、`z-index: -1`、不吃事件）。
 */
export function NeonBackdrop(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const ctx = typeof el.getContext === 'function' ? el.getContext('2d') : null
    if (!ctx) return
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

    let w = 0
    let h = 0
    let dots: Dot[] = []
    /** 与设计稿对应的几个"热点"（发光团），位置是画面比例，不绑真实数据。 */
    const hotspots: ReadonlyArray<[number, number, number]> = [
      [0.3, 0.2, 26], [0.42, 0.27, 18], [0.55, 0.2, 22], [0.68, 0.33, 16], [0.22, 0.36, 14], [0.78, 0.18, 12],
    ]

    const measure = (): void => {
      const box = el.parentElement?.getBoundingClientRect()
      const dpr = Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)
      w = Math.max(1, Math.round(box?.width ?? el.clientWidth))
      h = Math.max(1, Math.round(box?.height ?? el.clientHeight))
      el.width = Math.round(w * dpr)
      el.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const seed = (): void => {
      dots = Array.from({ length: PARTICLES }, () => {
        const warm = Math.random() < 0.34
        return {
          x: Math.random() * w,
          // 纵向压在偏上 70%：那一带是"地图 + 指标牌"，粒子在那儿才像数据流动
          y: Math.random() * h * 0.7,
          // 横向为主：设计稿里的粒子是数据流，斜着漂会读成雪
          vx: (Math.random() - 0.5) * 0.34,
          vy: (Math.random() - 0.5) * 0.09,
          r: warm ? 1.6 + Math.random() * 1.1 : 0.9 + Math.random() * 0.9,
          warm,
        }
      })
    }

    const paint = (t: number): void => {
      ctx.clearRect(0, 0, w, h)
      ctx.globalCompositeOperation = 'lighter'
      // 热点：缓慢呼吸的发光团
      for (const [fx, fy, r] of hotspots) {
        const pulse = 1 + 0.18 * Math.sin(t / 1400 + fx * 9)
        const g = ctx.createRadialGradient(fx * w, fy * h, 0, fx * w, fy * h, r * pulse * 3.2)
        g.addColorStop(0, 'rgba(150,225,255,0.26)')
        g.addColorStop(0.45, 'rgba(140,120,255,0.12)')
        g.addColorStop(1, 'rgba(120,90,255,0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(fx * w, fy * h, r * pulse * 3.2, 0, Math.PI * 2)
        ctx.fill()
      }
      // 连线：近邻之间一层极淡的网
      for (let i = 0; i < dots.length; i += 1) {
        const a = dots[i]
        if (!a) continue
        for (let j = i + 1; j < dots.length; j += 1) {
          const b = dots[j]
          if (!b) continue
          const dx = a.x - b.x
          const dy = a.y - b.y
          const d2 = dx * dx + dy * dy
          if (d2 > LINK_DIST * LINK_DIST) continue
          const alpha = (1 - Math.sqrt(d2) / LINK_DIST) * 0.16
          ctx.strokeStyle = `rgba(120,200,255,${alpha.toFixed(3)})`
          ctx.lineWidth = 0.6
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
        }
      }
      // 粒子本体
      for (const p of dots) {
        ctx.fillStyle = p.warm ? 'rgba(226,160,255,0.72)' : 'rgba(150,226,255,0.66)'
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
    }

    const step = (): void => {
      for (const p of dots) {
        p.x += p.vx
        p.y += p.vy
        if (p.x < -8) p.x = w + 8
        if (p.x > w + 8) p.x = -8
        if (p.y < -8) p.y = h * 0.7 + 8
        if (p.y > h * 0.7 + 8) p.y = -8
      }
    }

    measure()
    seed()
    paint(0)
    if (reduce) return

    let raf = 0
    let last = 0
    let running = true
    const loop = (t: number): void => {
      raf = requestAnimationFrame(loop)
      if (t - last < FRAME_MS) return
      last = t
      step()
      paint(t)
    }

    const start = (): void => { if (!running) { running = true; raf = requestAnimationFrame(loop) } }
    const stop = (): void => { if (running) { running = false; cancelAnimationFrame(raf) } }

    const onResize = (): void => { measure(); seed(); paint(0) }
    const onVisibility = (): void => { if (document.hidden) stop(); else start() }
    window.addEventListener('resize', onResize)
    document.addEventListener('visibilitychange', onVisibility)
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null
    if (ro && el.parentElement) ro.observe(el.parentElement)
    if (!document.hidden) raf = requestAnimationFrame(loop)

    return () => {
      stop()
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisibility)
      ro?.disconnect()
    }
  }, [])

  return (
    <div className={neon.backdrop} aria-hidden="true">
      <div className={neon.auroraCyan} />
      <div className={neon.auroraMagenta} />
      <div className={neon.isoGrid} />
      <canvas ref={canvasRef} className={neon.particles} />
    </div>
  )
}

/**
 * 8 格核心指标：等距霓虹牌（设计稿第一行）。
 *
 * 版式与文案与旧版一致（图标 / 数值 / 标签 / 「项」副标），只换皮：
 * 旧版是「一行八格、格间一条分隔线」，现在是「八张浮起来的等距牌」。
 * @param props - 快照、洞察（收发构成）与卡片跳转回调。
 * @returns 指标条元素。
 */
export function NeonHero({ data, ins, onGo }: {
  data: OverviewSnapshot
  ins: OverviewInsights | null
  onGo: (tab: string) => void
}): React.JSX.Element {
  return (
    <div className={neon.hero} data-st-ov-hero="1">
      <div className={neon.heroStats}>
        {CARDS.map((card) => {
          const value = card.key === 'storage'
            ? fmtBytes(data.storage.total_size)
            : (data[card.key as keyof OverviewSnapshot] as number).toLocaleString()
          const sub = card.key === 'storage' ? `${data.storage.total_count.toLocaleString()} 项` : undefined
          const tone = card.key === 'moments' ? 'purple'
            : card.key === 'official' ? 'blue'
              : card.key === 'storage' ? 'green' : 'cyan'
          return (
            <button key={card.key} type="button" className={neon.plate} data-tone={tone} onClick={() => { onGo(card.tab) }} title={`查看${card.label}`}>
              <span className={neon.plateGlow} />
              <span className={neon.plateDepth} />
              <span className={neon.plateFace} />
              <span className={neon.plateBody}>
                <span className={neon.plateIcon}>{card.icon}</span>
                <span className={neon.plateValue}>{value}</span>
                <span className={neon.plateLabel}>{card.label}{sub && <em className={neon.plateSub}> · {sub}</em>}</span>
                <span className={neon.plateEn}>{card.en}</span>
              </span>
            </button>
          )
        })}
      </div>
      {ins && (
        <div className={neon.mixBar}>
          <span className={neon.mixIcon}>✉️</span>
          <span className={neon.mixTitle}>
            消息 {ins.messages.total.toLocaleString()} 条 · 发出 <b>{ins.messages.sent.toLocaleString()}</b> / 收到 <b>{ins.messages.received.toLocaleString()}</b>
          </span>
          <span className={neon.mixSub}>
            文本 {ins.messages.text.toLocaleString()} · 图片 {ins.messages.image.toLocaleString()} · 视频 {ins.messages.video.toLocaleString()} · 链接卡片 {ins.messages.rich.toLocaleString()} · 系统 {ins.messages.system.toLocaleString()}
          </span>
        </div>
      )}
    </div>
  )
}
