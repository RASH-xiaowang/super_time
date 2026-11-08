/**
 * 知识库文件面板的轮询副作用。
 *
 * 放在独立 hook 里既让面板正文只负责编排，也保证保活分段隐藏时不会继续查库。
 */

import { useEffect } from 'react'
import { PARSE_POLL_MAX_MS, PARSE_POLL_MS } from './kb-files-support.tsx'

/** 解析队列有 pending 文件时才轮询，并设置总时长上限。 */
export function useKbParsePolling(
  active: boolean,
  pendingKey: string,
  load: (opts?: { silent?: boolean }) => Promise<void>,
): void {
  useEffect(() => {
    if (pendingKey === '') return
    if (!active) return
    let alive = true
    let ticks = 0
    const maxTicks = Math.ceil(PARSE_POLL_MAX_MS / PARSE_POLL_MS)
    const timer = setInterval(() => {
      ticks += 1
      if (ticks > maxTicks) { clearInterval(timer); return }
      if (alive) void load({ silent: true })
    }, PARSE_POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [active, pendingKey, load])
}

/** 后端有建索引任务时轮询索引状态；job 键变化会正确重建定时器。 */
export function useKbIndexPolling(
  active: boolean,
  indexJobKey: string,
  loadIndex: () => Promise<void>,
): void {
  useEffect(() => {
    if (indexJobKey === '') return
    if (!active) return
    const timer = setInterval(() => { void loadIndex() }, PARSE_POLL_MS)
    return () => { clearInterval(timer) }
  }, [active, indexJobKey, loadIndex])
}
