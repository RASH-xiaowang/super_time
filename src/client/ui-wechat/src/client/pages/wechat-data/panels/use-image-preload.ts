/**
 * 图片**预取**：把可见窗口上下各若干行里的图片消息提前取回来，写进内存缓存
 * （`image-cache.ts`）——于是用户滚到那里时，`MessageImage` 首帧就能命中缓存、
 * 不闪任何加载占位。
 *
 * ## 为什么用「空闲调度」而不是立刻发
 * 视口内那几张图是**用户此刻正看着的**，必须优先。预取是「可能会看」的，不能与它们
 * 抢同一个后端解码进程和 IPC 通道。所以预取排在 `requestIdleCallback`（无则退化为
 * 一个短延时）：主线程不忙、视口内请求也发出去之后再走。
 *
 * ## 为什么复用 `apiGetImageDataUrlsBatch` 而不是逐张
 * 后端单张入口每图都要开合一次库（`WHERE lower(md5) = ?` 在 `image_hardlink_info_v4`
 * 上是全表扫，实测 20 万行 17.27ms/次），批量入口一次 `IN (...)` 就把整批 md5 的路径
 * 查完并预热解码缓存。预取天然是「一批」场景，正该用它。
 *
 * ## 与「逐张请求」的分工
 * 本 hook **只负责预取**（低优先、批量）。组件自己那条路径（`apiGetImageDataUrl`
 * → `imageLoadQueue`）保持不变：它管「这一张现在必须出来」。两条路径写的是同一个缓存，
 * 谁先回来都算数 —— 所以既不会有重复请求长期并存，也不会因为预取失败而让图片出不来。
 */
import { useEffect, useRef } from 'react'
import { apiGetImageDataUrlsBatch } from '../api.ts'
import { renderKindOf, type MessageRenderItem } from '../utils/message-items.ts'
import { recallImage, rememberImage } from '../image-cache.ts'

export interface ImagePreloadOption {
  /** 会话 username；换会话作废在途预取。 */
  talker: string
  /** 虚拟行（与列表渲染用的是同一份）。 */
  items: readonly MessageRenderItem[]
  /** 虚拟化器：只用它判断当前可见区间。 */
  virtualizer: { getVirtualItems(): ReadonlyArray<{ index: number }> }
  /** 可见窗口上下各多看几行。默认 {@link LOOKAHEAD}。 */
  lookahead?: number
}

/**
 * 预取余量（行）。8 行 ≈ 一屏多一点：滚一屏基本都能命中，又不至于把整个会话都拉下来。
 * 这个数字是「命中率 / 无谓请求」的折中，不是性能上限。
 */
export const LOOKAHEAD = 8
/** 滚动停止多久后才开始预取（滚动中反复重置，避免打出一串半途作废的请求）。 */
export const PREFETCH_DEBOUNCE_MS = 150
/** 一次批量请求最多几项（与后端批量入口的量级一致；超出的分多批串行发）。 */
const BATCH_LIMIT = 200

/** 空闲调度：优先真空闲回调，退化为短延时（jsdom / 老内核没有 requestIdleCallback）。 */
function onIdle(run: () => void): () => void {
  const w = window as unknown as { requestIdleCallback?: (cb: () => void, opt?: { timeout: number }) => number }
  if (typeof w.requestIdleCallback === 'function') {
    const id = w.requestIdleCallback(run, { timeout: 800 })
    return () => {
      const c = window as unknown as { cancelIdleCallback?: (h: number) => void }
      c.cancelIdleCallback?.(id)
    }
  }
  const t = window.setTimeout(run, 250)
  return () => { window.clearTimeout(t) }
}

/**
 * 预取可见窗口附近的消息图片。
 * @param option - 会话、虚拟行、虚拟化器与余量。
 */
export function useImagePreload(option: ImagePreloadOption): void {
  const lookahead = option.lookahead ?? LOOKAHEAD
  /** 已经在飞的 key：跨 effect 重跑去重（滚动会不停重跑本 effect）。 */
  const inflight = useRef<Set<string>>(new Set())
  /** 换会话作废旧结果（与 use-inline-analysis 同一手法）。 */
  const epoch = useRef(0)
  const { talker, items, virtualizer } = option

  useEffect(() => {
    epoch.current += 1
    inflight.current.clear()
  }, [talker])

  useEffect(() => {
    if (talker === '') return
    let cancelled = false
    const myEpoch = epoch.current

    const timer = window.setTimeout(() => {
      // 1) 收集：可见窗口 ± lookahead 内的图片消息，且还没进缓存、也不在飞
      const virtual = virtualizer.getVirtualItems()
      if (virtual.length === 0) return
      const targets: Array<{ username: string; localId: number }> = []
      const seen = new Set<number>()
      const push = (index: number): void => {
        const item = items[index]
        if (item === undefined || item.kind !== 'msg') return
        const m = item.m
        if (renderKindOf(m) !== 'image') return
        if (seen.has(m.localId)) return
        if (recallImage(talker, m.localId) !== undefined) return
        if (inflight.current.has(`${talker}:${String(m.localId)}`)) return
        seen.add(m.localId)
        targets.push({ username: talker, localId: m.localId })
      }
      for (const vi of virtual) {
        for (let d = -lookahead; d <= lookahead; d += 1) push(vi.index + d)
      }
      if (targets.length === 0) return

      // 2) 空闲时发（不与视口内的请求抢后端）
      for (const t of targets) inflight.current.add(`${t.username}:${String(t.localId)}`)
      onIdle(() => {
        if (cancelled || myEpoch !== epoch.current) return
        void (async () => {
          for (let i = 0; i < targets.length; i += BATCH_LIMIT) {
            if (cancelled || myEpoch !== epoch.current) break
            const chunk = targets.slice(i, i + BATCH_LIMIT)
            try {
              const rows = await apiGetImageDataUrlsBatch(chunk)
              for (const row of rows) {
                if (row.url) rememberImage(talker, row.localId, { url: row.url, thumb: row.thumb === true })
              }
            } catch {
              // 预取失败就当没预取：**不写缓存**（下次滚到还会再试一次），也不打扰用户。
              // 这与「组件自己那条路径」的错误呈现分工不同 —— 那里是用户正看着的图，必须说话。
            }
          }
          // 收尾：整批从 inflight 摘掉（无论成功、失败还是中途取消）。
          // 注意**失败的条目不写缓存**，所以下次滚到还会再试一次 —— 预取失败不该被记成「已知没图」。
          for (const t of targets) inflight.current.delete(`${t.username}:${String(t.localId)}`)
        })()
      })
    }, PREFETCH_DEBOUNCE_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [talker, items, virtualizer, lookahead])
}
