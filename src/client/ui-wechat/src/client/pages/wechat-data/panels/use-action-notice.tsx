/**
 * 一次性动作反馈（W3-11.1）：「刚才那次操作成没成」的一行小字 + 自动消失。
 *
 * ## 为什么抽成共享模块
 *
 * 2026-10-09 之前，这类反馈有三种坏归处：`window.alert`（阻塞式原生弹窗，钉住整个窗口）、
 * 各面板自己的 `setExportMsg`/`setEditNotice`（同一件事写五六份）、或者干脆没有
 * （用户点了没反应）。本模块把它收成一份：状态与定时器在 hook 里，渲染在 {@link ActionNoticeLine}。
 *
 * 三个 deliberate 取舍：
 *   · **自动消失**（默认 4.5s）：它是「操作回执」，不是常驻状态；失败了要留在屏幕上的是
 *     `.error` 那一类，那由各面板自己的 `error` 位负责，不归这里管；
 *   · **不分红绿 tone**：`flash(text)` 只拿文本。要不要标红由 {@link ActionNoticeLine} 按文案判
 *     （「失败/错误/无法/不能」开头走 `.error`）—— 调用点 therefore 不必传第二个参数，
 *     也不会出现「把成功消息标成红色」这种最常见的不一致；
 *   · **timers 在卸载时清**：与 `poll-registry.ts`（M15）同一条纪律 —— 组件走了还在 setState
 *     是渲染进程里一条未处理拒绝的来源。
 *
 * ⚠ 与 `notice.ts`（更新/授权到期横幅）不是一件事：那个是**常驻提醒**，这个是**操作回执**。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import kitCss from '../ui/kit.module.css'

/** 默认存活时长：足够读完一句话，又不至于压到下一步操作上。 */
const DEFAULT_NOTICE_MS = 4500

/** 失败语貌：命中这些词的回执走 `.error`（红色），其余走 `.hint`（中性）。 */
const FAIL_TONE = /失败|错误|无法|不能|拒绝/

/**
 * 一次性反馈的状态与写入。
 * @param durationMs - 存活时长（毫秒）；只在挂载时取一次，逐次微调请另加参数。
 * @returns `notice` 当前回执（null = 无）；`flash` 写入并重新计时。
 */
export function useActionNotice(durationMs: number = DEFAULT_NOTICE_MS): {
  notice: string | null
  flash: (text: string) => void
} {
  const [notice, setNotice] = useState<string | null>(null)
  const timerRef = useRef<number | null>(null)
  const flash = useCallback((text: string): void => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    setNotice(text)
    timerRef.current = window.setTimeout(() => { setNotice(null); timerRef.current = null }, durationMs)
  }, [durationMs])
  useEffect(() => () => { if (timerRef.current !== null) window.clearTimeout(timerRef.current) }, [])
  return { notice, flash }
}

/**
 * 回执的渲染位：一行小字，失败语貌转红。
 *
 * `role="status"` 而不是 `role="alert"`：它是成功/失败的**结果**，不是需要立刻处理的告警 ——
 * 读屏软件按 alert 播报会把「已复制」也打断用户，那是噪声。
 * @param notice - 当前回执；null 时什么都不渲染。
 */
export function ActionNoticeLine({ notice }: { notice: string | null }): React.JSX.Element | null {
  if (!notice) return null
  const fail = FAIL_TONE.test(notice)
  return (
    <div className={fail ? kitCss.error : kitCss.hint} role="status">{notice}</div>
  )
}
