/**
 * 图谱「导出」下拉菜单（2026-10-17）。
 *
 * 为什么单独一个文件：`GraphPanel` 受函数体棘轮管着（250 行上限），
 * 而导出菜单的 JSX 有 50 多行，留在面板里会超。
 *
 * 为什么收进菜单：改前「海报风格 Select + 海报比例 Select + 发朋友圈 + SVG + PNG」
 * 五个控件平铺在页头，加上搜索框、刷新、主题、适应视图、选中节点共 **9 个**，
 * 在 1230px 宽下换行成两排（页头 51px → 需要 90px）。导出是低频操作，
 * 收进菜单后页头只剩 5 个控件，一行放得下。
 */
import { useEffect, useRef, useState } from 'react'
import css from './graph.module.css'

/** 海报风格。 */
export type PosterStyle = 'light' | 'dark' | 'neon'
/** 海报比例。 */
export type PosterRatio = '1:1' | '3:4' | '16:9'

const STYLES: ReadonlyArray<readonly [PosterStyle, string]> = [
  ['dark', '深色'],
  ['light', '浅色'],
  ['neon', '高对比'],
]

const RATIOS: ReadonlyArray<readonly [PosterRatio, string]> = [
  ['1:1', '1:1 方图'],
  ['3:4', '3:4 竖版'],
  ['16:9', '16:9 横版'],
]

export interface GraphExportMenuProps {
  /** 知识网络下隐藏海报入口（海报版式是社交侧的，知识网络没有意义）。 */
  isKnowledgeMode: boolean
  posterStyle: PosterStyle
  posterRatio: PosterRatio
  exporting: boolean
  onStyle: (v: PosterStyle) => void
  onRatio: (v: PosterRatio) => void
  onPoster: () => void
  onSvg: () => void
  onPng: () => void
}

/**
 * 渲染「导出」下拉。
 * @param props - 当前风格/比例与三个导出动作。
 * @returns 下拉按钮 + 菜单。
 */
export function GraphExportMenu({
  isKnowledgeMode, posterStyle, posterRatio, exporting,
  onStyle, onRatio, onPoster, onSvg, onPng,
}: GraphExportMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  // 点外面 / 按 Esc 关闭（菜单是浮层，不关会一直挡着画布）。
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current !== null && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  /** 执行一个导出动作并收起菜单。 */
  const run = (fn: () => void): void => { setOpen(false); fn() }

  return (
    <div className={css.menuWrap} ref={wrapRef}>
      <button
        type="button"
        className={css.chip}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => { setOpen(v => !v) }}
      >
        {exporting ? '导出中…' : '导出'}
      </button>
      {open && (
        <div className={css.menu} role="menu">
          {!isKnowledgeMode && (
            <>
              <div className={css.menuLabel}>海报风格</div>
              <div className={css.menuRow}>
                {STYLES.map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    className={css.menuChip}
                    data-on={posterStyle === v || undefined}
                    onClick={() => { onStyle(v) }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className={css.menuLabel}>海报比例</div>
              <div className={css.menuRow}>
                {RATIOS.map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    className={css.menuChip}
                    data-on={posterRatio === v || undefined}
                    onClick={() => { onRatio(v) }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button type="button" className={css.menuItem} role="menuitem" disabled={exporting} onClick={() => { run(onPoster) }}>
                海报（发朋友圈）
              </button>
            </>
          )}
          <button type="button" className={css.menuItem} role="menuitem" onClick={() => { run(onSvg) }}>SVG 矢量图</button>
          <button type="button" className={css.menuItem} role="menuitem" onClick={() => { run(onPng) }}>PNG 位图</button>
        </div>
      )}
    </div>
  )
}
