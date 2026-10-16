/**
 * 朋友圈**灯箱**的状态层：看图开关、缩放/平移/旋转/原图、索引钳位、以及三个派生规则。
 *
 * ## 为什么单独成模块（第三批 #18 第四步）
 *
 * 这一块原先是面板里 8 个 state/ref + 4 个 effect，约 60 行。搬的时候把**三条容易写错的规则**
 * 收成纯函数（`zoomFor` / `clampIndex` / `imageExtOf`），因为它们各自的失败都是
 * 「界面不报错、用户只觉得怪」那一类：滚轮越界把图缩成 0.3 倍、点最后一张跳到 undefined、
 * 保存下来文件名是 `.jpg` 而内容是 webp。
 *
 * ## 为什么"存图/复制链接"这两个动作还留在面板
 *
 * 灯箱状态必须**先于**媒体层建立（媒体层要按 `viewer` 决定给哪一张做离线解码），
 * 而这两个动作要读媒体层的 `snsImgs`。所以这一层只搬到「不依赖 snsImgs」的那一半，
 * 动作留在面板里薄薄地粘一遍，规则本身已经在这里被验过了。
 *
 * @module moments-viewer
 */
import { useEffect, useRef, useState } from 'react'

/** 灯箱里可被点开的那张图的形状（与 `MomentsImageViewer` 传进来的兼容）。 */
export interface ViewerImageLike { thumb?: string; url?: string; md5?: string; timelineId?: string; id?: string }

/** 灯箱整体状态。 */
export interface MomentsViewerState { images: ViewerImageLike[]; index: number; author: string }

/** 缩放上限：再大就没有意义（画布先糊）。 */
const ZOOM_MAX = 5

/**
 * 滚轮一格该把倍率推到哪。**下限恒为 1**：灯箱不允许缩到比原始更小，
 * 回到 1 时面板会把平移清零（见 `useMomentsViewer` 里那条 wheel 效果）。
 * @param deltaY - 原生 `WheelEvent.deltaY`（向上滚为负 = 放大）。
 * @param current - 当前倍率。
 * @returns 钳在 `[1, 5]` 的新倍率。
 */
export function zoomFor(deltaY: number, current: number): number {
  return Math.min(ZOOM_MAX, Math.max(1, current * (deltaY < 0 ? 1.1 : 0.9)))
}

/**
 * 把索引钳进 `[0, len-1]`；`len === 0` 时回 0（空灯箱不该出现，但钳位不许算出 -1）。
 * @param len - 图片总数。
 * @param index - 期望的索引。
 * @returns 钳过的索引。
 */
export function clampIndex(len: number, index: number): number {
  return Math.max(0, Math.min(len - 1, index))
}

/**
 * 从「data URL 或 CDN 地址」猜保存时该用的扩展名。
 *
 * 三条路径都要留：① `data:image/webp;base64,…` 认 MIME（并把 `jpeg` 归一成 `jpg`）；
 * ② 普通 URL 取末段扩展名，且只认 2–5 位小写字母数字（微信的图 URL 尾巴常带签名参数，
 *    不校验就会写出 `.1688486141` 这种文件名）；③ 都不成立时退回 `jpg`。
 * @param src - 要保存的地址。
 * @returns 不带点的扩展名。
 */
export function imageExtOf(src: string): string {
  const dataMatch = src.match(/^data:image\/(\w+)[;,]/)
  if (dataMatch) return dataMatch[1] === 'jpeg' ? 'jpg' : (dataMatch[1] ?? 'jpg')
  try {
    const path = new URL(src, 'https://local.invalid').pathname
    const seg = path.split('.').pop()?.toLowerCase() ?? ''
    return /^[a-z0-9]{2,5}$/.test(seg) ? seg : 'jpg'
  } catch {
    return 'jpg'
  }
}

/**
 * 灯箱状态：开关、四个变换量、三个 ref 与索引钳位。
 * @returns 面板与 `MomentsImageViewer` 要的那一组值。
 */
export function useMomentsViewer(): {
  viewer: MomentsViewerState | null
  setViewer: React.Dispatch<React.SetStateAction<MomentsViewerState | null>>
  viewZoom: number
  setViewZoom: React.Dispatch<React.SetStateAction<number>>
  viewPan: { x: number; y: number }
  setViewPan: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>
  viewRotate: number
  setViewRotate: React.Dispatch<React.SetStateAction<number>>
  dragRef: React.MutableRefObject<{ sx: number; sy: number; ox: number; oy: number } | null>
  pinchRef: React.MutableRefObject<{ dist: number; zoom: number } | null>
  lightboxWrapRef: React.MutableRefObject<HTMLDivElement | null>
  viewZoomRef: React.MutableRefObject<number>
  curImg: ViewerImageLike | undefined
  setViewerIndex: (index: number) => void
} {
  const [viewer, setViewer] = useState<MomentsViewerState | null>(null)
  const [viewZoom, setViewZoom] = useState(1)
  const [viewPan, setViewPan] = useState({ x: 0, y: 0 })
  const [viewRotate, setViewRotate] = useState(0)
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const pinchRef = useRef<{ dist: number; zoom: number } | null>(null)
  const lightboxWrapRef = useRef<HTMLDivElement | null>(null)
  const viewZoomRef = useRef(1)
  const curImg = viewer ? (viewer.images[viewer.index] as ViewerImageLike | undefined) : undefined

  // Reset lightbox transform whenever a viewer opens or its index moves.
  // （「加载失败」不在这里复位：灯箱现在画的是 RemoteImg 的 failed 占位，状态跟着地址走。）
  useEffect(() => {
    setViewZoom(1)
    setViewPan({ x: 0, y: 0 })
    setViewRotate(0)
  }, [viewer])

  // Keep a ref mirror of the zoom for the native wheel listener (attached once per open).
  useEffect(() => { viewZoomRef.current = viewZoom }, [viewZoom])

  // Native non-passive wheel listener: React's onWheel is passive, so preventDefault
  // would be ignored letting the page scroll behind the lightbox; this suppresses it.
  useEffect(() => {
    const el = lightboxWrapRef.current
    if (!el || !viewer) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const n = zoomFor(e.deltaY, viewZoomRef.current)
      setViewZoom(n)
      if (n === 1) setViewPan({ x: 0, y: 0 })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => { el.removeEventListener('wheel', onWheel) }
  }, [viewer])

  // Keyboard control while the lightbox is open: arrows switch image（Esc 交给共享 hook）。
  useEffect(() => {
    if (!viewer) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowLeft') setViewer(v => (v ? { ...v, index: clampIndex(v.images.length, v.index - 1) } : v))
      if (e.key === 'ArrowRight') setViewer(v => (v ? { ...v, index: clampIndex(v.images.length, v.index + 1) } : v))
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [viewer])

  const setViewerIndex = (index: number): void => {
    setViewer(v => (v ? { ...v, index: clampIndex(v.images.length, index) } : v))
  }

  return {
    viewer, setViewer, viewZoom, setViewZoom, viewPan, setViewPan, viewRotate, setViewRotate,
    dragRef, pinchRef, lightboxWrapRef, viewZoomRef, curImg, setViewerIndex,
  }
}
