/**
 * 引用详情面板的开关状态（2026-10-16 新增）。
 *
 * ## 为什么抽成 hook
 *
 * `AskPanel` 受 `function-size-ratchet.spec.ts` 的棘轮管着（登记 441 行，只许变小）。
 * 本轮加「点角标 → 右侧滑出详情」时，光状态与派生值就占了 28 行 —— 直接顶穿棘轮。
 * 而这块是**语义独立**的：它只回答「现在在看哪一条引用」，与提问、检索、生成无关。
 *
 * ## 为什么存「轮次下标 + 编号」而不是引用对象
 *
 * turns 会被 `patchTurn` 就地更新（反馈、接地核对都会改），存对象会拿到**过期的那一份**。
 * 存下标 + 编号，每次渲染现取，永远是最新的。
 *
 * ## 为什么再点同一条要关掉
 *
 * 角标是**开关**而不是「打开」：用户点开看完，再点一次自然期望收起
 * （否则只能去点右上角的关闭按钮，多一步）。
 *
 * @module panels/use-cite-detail
 */
import { useCallback, useState } from 'react'
import type { AskTurn } from './use-ask.ts'
import type { CiteItem } from './cite-target.ts'

/** 当前查看的引用：轮次下标 + 编号（编号 = 引用数组下标 + 1，与正文角标一致）。 */
export interface CiteDetailRef {
  turn: number
  n: number
}

/**
 * 引用详情的开关状态。
 *
 * @param turns - 当前线程的轮次（用于现取引用对象）。
 * @returns `ref`（当前查看的引用）、`item`（引用对象，现取）、`toggle`（点角标）、`close`（关闭）。
 */
export function useCiteDetail(turns: AskTurn[]): {
  ref: CiteDetailRef | null
  item: CiteItem | null
  toggle: (turn: number, n: number) => void
  close: () => void
} {
  const [ref, setRef] = useState<CiteDetailRef | null>(null)
  const toggle = useCallback((turn: number, n: number): void => {
    setRef(prev => (prev && prev.turn === turn && prev.n === n ? null : { turn, n }))
  }, [])
  const close = useCallback((): void => { setRef(null) }, [])
  // 现取：turns 会被 patchTurn 就地更新，缓存下来的那份会过期。
  const item = ref ? (turns[ref.turn]?.citations?.[ref.n - 1] ?? null) : null
  return { ref, item, toggle, close }
}
