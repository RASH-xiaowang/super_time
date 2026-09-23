/**
 * 启动页动态粒子场：Canvas 绘制，无外部依赖。
 *
 * - 缓慢漂浮的青/紫光点 + 近距连线
 * - 周期性「汇聚 → 消散」脉冲（强化数据聚合隐喻）
 * - 尊重 prefers-reduced-motion
 */
import { useEffect, useRef } from 'react'

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  hue: 0 | 1
  pulse: number
}

const CYAN = '0, 240, 255'
const PURPLE = '168, 85, 247'
const BLUE = '59, 130, 246'
const TEAL = '45, 212, 191'

/** 每个启动页阶段的主色/辅色，随滚轮切页切换 */
const STAGE_RGB: Array<[string, string]> = [
  [CYAN, PURPLE],   // 0 首页
  [PURPLE, CYAN],   // 1 功能
  [TEAL, BLUE],     // 2 说明
  [BLUE, PURPLE],   // 3 关于
]

/**
 * 取某一阶段的主/辅色。
 *
 * 原来这三处是就地写的 `STAGE_RGB[Math.min(3, Math.max(0, stage | 0))] ?? STAGE_RGB[0]`：
 * 上界写死成 3，而 `STAGE_RGB` 恰好四条 —— 将来加第五个阶段时粒子会静默用错颜色，
 * 而且 `?? STAGE_RGB[0]` 在收紧之后自己又是 `undefined`（下标取表必然如此）。
 * 这里改成按表长夹住 + 明确回落到首页那一对，三处共用一份。
 */
function stageRgb(stage: number): [string, string] {
  const i = Number.isFinite(stage) ? Math.max(0, Math.min(STAGE_RGB.length - 1, stage | 0)) : 0
  return STAGE_RGB[i] ?? [CYAN, PURPLE]
}

export function ParticleField({
  className,
  stage = 0,
}: {
  className?: string
  /** 0–3 启动页阶段，驱动粒子主色偏移 */
  stage?: number
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stageRef = useRef(stage)

  useEffect(() => {
    stageRef.current = stage
  }, [stage])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0
    let w = 0
    let h = 0
    let dpr = 1
    const particles: Particle[] = []
    /** 0 = 漂浮，→1 汇聚，回到 0 消散 */
    let converge = 0
    let convergeDir = 1
    let last = performance.now()

    const resize = (): void => {
      const parent = canvas.parentElement
      if (!parent) return
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = parent.clientWidth
      h = parent.clientHeight
      canvas.width = Math.max(1, Math.floor(w * dpr))
      canvas.height = Math.max(1, Math.floor(h * dpr))
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const spawn = (count: number): void => {
      particles.length = 0
      for (let i = 0; i < count; i++) {
        particles.push({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.22,
          vy: (Math.random() - 0.5) * 0.22,
          r: 0.8 + Math.random() * 1.8,
          hue: Math.random() > 0.55 ? 1 : 0,
          pulse: Math.random() * Math.PI * 2,
        })
      }
    }

    const frame = (now: number): void => {
      const dt = Math.min(48, now - last) / 16.67
      last = now
      ctx.clearRect(0, 0, w, h)

      if (!reduce) {
        converge += 0.0045 * convergeDir * dt
        if (converge >= 1) { converge = 1; convergeDir = -1 }
        if (converge <= 0) { converge = 0; convergeDir = 1 }
      }

      const cx = w * 0.5
      const cy = h * 0.42
      const ease = converge * converge * (3 - 2 * converge)

      for (const p of particles) {
        if (!reduce) {
          p.x += p.vx * dt
          p.y += p.vy * dt
          p.pulse += 0.03 * dt
          // 轻微向中心的汇聚力
          p.x += (cx - p.x) * 0.0018 * ease * dt
          p.y += (cy - p.y) * 0.0018 * ease * dt
        }

        if (p.x < -8) p.x = w + 8
        if (p.x > w + 8) p.x = -8
        if (p.y < -8) p.y = h + 8
        if (p.y > h + 8) p.y = -8

        const [c0, c1] = stageRgb(stageRef.current)
        const rgb = p.hue ? c1 : c0
        const alpha = 0.25 + 0.35 * Math.abs(Math.sin(p.pulse)) + 0.2 * ease
        const radius = p.r * (1 + ease * 0.55)

        // 光晕
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius * 7)
        g.addColorStop(0, `rgba(${rgb},${alpha * 0.55})`)
        g.addColorStop(1, `rgba(${rgb},0)`)
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(p.x, p.y, radius * 7, 0, Math.PI * 2)
        ctx.fill()

        // 核心
        ctx.fillStyle = `rgba(${rgb},${Math.min(0.95, alpha + 0.25)})`
        ctx.beginPath()
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2)
        ctx.fill()
      }

      // 近距连线
      const linkDist = 110 + ease * 40
      ctx.lineWidth = 0.6
      for (let i = 0; i < particles.length; i++) {
        const a = particles[i]
        // 下标全部由 `particles.length` 界定，这两道判断在运行期永不命中；写出来是因为
        // `noUncheckedIndexedAccess` 下 `particles[i]` 的类型确实含 `undefined`，
        // 而这里没有比「跳过」更诚实又更便宜的写法。
        if (!a) continue
        for (let j = i + 1; j < particles.length; j++) {
          const b = particles[j]
          if (!b) continue
          const dx = a.x - b.x
          const dy = a.y - b.y
          const d2 = dx * dx + dy * dy
          if (d2 > linkDist * linkDist) continue
          const t = 1 - Math.sqrt(d2) / linkDist
          const [c0, c1] = stageRgb(stageRef.current)
          const rgb = a.hue === b.hue ? (a.hue ? c1 : c0) : '120, 160, 255'
          ctx.strokeStyle = `rgba(${rgb},${(0.08 + t * 0.22) * (0.55 + ease * 0.45)})`
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
        }
      }

      // 汇聚核心光斑
      if (ease > 0.15) {
        const [c0, c1] = stageRgb(stageRef.current)
        const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, 90 + ease * 40)
        core.addColorStop(0, `rgba(${c0},${0.08 * ease})`)
        core.addColorStop(0.4, `rgba(${c1},${0.05 * ease})`)
        core.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = core
        ctx.beginPath()
        ctx.arc(cx, cy, 90 + ease * 40, 0, Math.PI * 2)
        ctx.fill()
      }

      raf = requestAnimationFrame(frame)
    }

    const count = w * h < 400000 ? 36 : 56
    resize()
    spawn(reduce ? 24 : count)
    raf = requestAnimationFrame(frame)

    const ro = new ResizeObserver(() => {
      resize()
      spawn(reduce ? 24 : count)
    })
    if (canvas.parentElement) ro.observe(canvas.parentElement)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />
}
