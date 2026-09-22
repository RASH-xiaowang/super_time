/**
 * 全局搜索框（导航栏版）。
 *
 * ── 为什么单独成组件 + 用 Portal ───────────────────────────────
 * 它原先在顶栏里，结果面板（`.searchDropdown`）用 `position: absolute` 挂在搜索框下方。
 * 迁进导航栏后这条路走不通：`.sidebar` 带 `overflow: hidden`（收起态要把标签裁掉），
 * 绝对定位的下拉会被**直接裁掉** —— 这正是 `FoldableBar` 当初要处理的那个坑。
 *
 * 所以结果面板改为 `createPortal` 到 `document.body`，用触发器的实测位置定位：
 *   · 左边缘贴着导航栏右缘（`trigger.right + 8`），向右展开，不受 176px 栏宽限制；
 *   · 宽度取 `min(420, 视口宽 - left - 16)`，窄屏不溢出屏幕；
 *   · 高度夹在视口内；窗口 resize / 任意祖先滚动时跟随。
 *
 * **结果内容由调用方以 children 传入**：7 个结果分组各有不同的跳转目标
 * （会话→聊天、联系人→通讯录、记录→资金…），把这套领域逻辑搬进本组件只会把它变成
 * 一个「什么都知道」的大组件。本组件只负责**框与定位**。
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import css from './global-search.module.css'

/** 结果面板的定位几何。 */
interface PanelBox {
  left: number
  top: number
  width: number
  maxHeight: number
}

/**
 * 全局搜索框。
 * @param props.value - 当前关键词（受控）。
 * @param props.onChange - 关键词变化回调。
 * @param props.open - 结果面板是否展开。
 * @param props.onOpenChange - 展开状态变化回调。
 * @param props.inputRef - 外部（Ctrl+K）要能聚焦输入框。
 * @param props.children - 结果面板内容（由调用方渲染其领域相关的分组）。
 * @returns 搜索框 + （Portal 出去的）结果面板。
 */
export function GlobalSearch({ value, onChange, open, onOpenChange, inputRef, children }: {
  value: string
  onChange: (v: string) => void
  open: boolean
  onOpenChange: (v: boolean) => void
  // 与调用方 / `confirm.tsx` 同形：`useRef<HTMLInputElement | null>(null)` 给的是 MutableRefObject，
  // 声明成 RefObject 反而在 `<input ref=…>` 处不匹配（strictNullChecks 之后才暴露）。
  inputRef: React.MutableRefObject<HTMLInputElement | null>
  children: React.ReactNode
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [panel, setPanel] = useState<PanelBox | null>(null)
  const visible = open && value.trim() !== ''

  /** 按触发器的实测位置算出面板几何。 */
  const measure = useCallback((): void => {
    const el = boxRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    // 至少 240px，最多 440px，且不越过视口右缘
    const left = Math.round(r.right + 8)
    const width = Math.max(240, Math.min(440, vw - left - 16))
    const top = Math.round(r.top)
    setPanel({ left, top, width, maxHeight: Math.max(160, vh - top - 16) })
  }, [])

  // useLayoutEffect：在绘制前算好，避免面板先落在错位置再跳一下
  useLayoutEffect(() => {
    if (!visible) { setPanel(null); return }
    measure()
  }, [visible, measure])

  useEffect(() => {
    if (!visible) return
    const onMove = (): void => { measure() }
    window.addEventListener('resize', onMove)
    // capture：导航栏或任意祖先滚动时也要跟随
    window.addEventListener('scroll', onMove, true)
    return () => {
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [visible, measure])

  /**
   * 点外部关闭。
   *
   * 早先这里是一个 `position: fixed; inset: 0` 的全屏透明遮罩 —— 在真实浏览器里发现它
   * 会**吃掉整个界面的第一次点击**：结果面板开着时点导航栏的「收起导航」，那一下被遮罩
   * 收走（只关掉面板），导航纹丝不动，用户必须点第二次。同一时刻侧栏、内容区全都点不动。
   * 改为在 document 上监听 mousedown（capture）：命中框或面板内部就放过，
   * 其余一律关闭 —— 没有任何覆盖层，被点到的那个元素照常收到自己的点击。
   */
  useEffect(() => {
    if (!visible) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node | null
      if (!t) return
      if (boxRef.current?.contains(t) || panelRef.current?.contains(t)) return
      onOpenChange(false)
    }
    document.addEventListener('mousedown', onDown, true)
    return () => { document.removeEventListener('mousedown', onDown, true) }
  }, [visible, onOpenChange])

  return (
    <>
      <div className={css.box} ref={boxRef}>
        <span className={css.icon} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
        </span>
        <input
          ref={inputRef}
          className={css.input}
          placeholder="搜索…"
          value={value}
          onChange={(e) => { onChange(e.target.value); onOpenChange(true) }}
          onFocus={() => { onOpenChange(true) }}
          aria-label="全局搜索微信数据（Ctrl+K）"
          title="全局搜索：会话 / 消息 / 联系人 / 朋友圈 / 收藏 / 文件 / 记录（Ctrl+K）"
        />
        {value !== '' && (
          <button
            type="button"
            className={css.clear}
            onClick={() => { onChange(''); onOpenChange(false) }}
            aria-label="清空搜索"
            title="清空"
          >×</button>
        )}
      </div>

      {visible && panel && createPortal(
        <div
          ref={panelRef}
          className={css.dropdown}
          style={{ left: panel.left, top: panel.top, width: panel.width, maxHeight: panel.maxHeight }}
          role="listbox"
          aria-label="搜索结果"
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  )
}
