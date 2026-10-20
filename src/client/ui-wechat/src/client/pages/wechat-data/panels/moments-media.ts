/**
 * 朋友圈媒体层：本地缓存优先、懒解密、公众号封面兜底、灯箱按需解析。
 *
 * ## 为什么单独成模块（第三批 #18 第二步）
 *
 * 这一族原先散在 `moments-panel.tsx` 的五个位置（state 一处、观察器一处、封面兜底一处、
 * 重挂载观察一处、IDB 恢复一处、灯箱一处），加起来约 140 行，是那个 900 多行组件里最大的一块。
 * 它们共享同一份状态（`snsImgs` / `snsFetched` / `mediaKeySpec`），拆开后互相能看见 ——
 * 于是收成一个钩子：状态、去重集合、队列与观察器都由本模块持有，外面只拿返回值。
 *
 * ## 一条不能被「顺手优化」掉的约定
 *
 * 「哪一格该去本机解码」是 IntersectionObserver 按 DOM 上的 `data-sns-key` 认的，
 * 而那张 `mediaKeySpec` 表**由卡片在 render 里登记**（`moments-card.tsx` 的三处 `.set`）。
 * 面板只读它。所以这个 ref 必须在 render 期间就能被卡片写到 —— 把它挪进 `useEffect`
 * 会让观察器永远查不到 spec，表现是「滚动到图片也不解密」。
 *
 * ## 取图口径：**本地优先、CDN 兜底**（2026-10-19 用户口径变更）
 *
 * 进面板先批量从 IndexedDB 恢复**原图**（`wantOriginal` 把缩略图当未命中），本地有就
 * 直接显示、不再出网；单格同样先查 IndexedDB 原图，命中就跳过 RPC。只有本地没有原图时
 * 才走 `getSnsImageDataUrl`，而后端也按「长期归档 → 解码缓存 → 本机目录 → CDN」的顺序。
 *
 * 这与旧口径（有网先 CDN、只有无网才看 IndexedDB）相反 —— 旧口径下每次进入都会重新
 * 出网，本地已经落盘的高清图被跳过；用户明确要求「先用本地显示，然后再使用 CDN」。
 * md5 是内容寻址，本地那份只要是原图就与 CDN 同一张，先看本地不会看到旧图。
 *
 * 网络状态取自 `navigator.onLine`（与 `remote-img.tsx` 的离线短路同一个信号），由
 * {@link isOffline} 在**取图那一刻**读一次并随 RPC 传给后端。不做成 state：它变了不必
 * 重排已显示的图，而做成 state 会在断网瞬间把整屏图片重置成「正在取」。
 *
 * @module moments-media
 */
import { useEffect, useRef, useState } from 'react'
import type { MomentItem } from '@deepseek-ai/dsh-wechat-data/types'
import {
  apiGetArticleCovers,
  apiGetSnsImageDataUrl,
  apiGetSnsVideoCoverDataUrl,
  snsMediaCacheGet,
  snsMediaCacheGetMany,
  snsMediaCacheSet,
} from '../api.ts'
import { capRecord } from '../utils/misc.ts'
import { ARTICLE_COVER_CACHE_MAX, SNS_IMG_CACHE_MAX, imgKey } from './moments-support.tsx'

/**
 * 取图失败的重试状态（2026-09-29 修「有的图片加载不出来」）。
 *
 * 依据（真机自检）：**解码缓存 154 张 / 43.5MB**，而媒体资源 **175,963 项 / 16.8GB**
 * ⇒ 绝大多数朋友圈图不在缓存里，必须走"按需 `.dat` 解密 + hardlink 定位"这条慢路径
 * （`backend-rpc.spec.ts` 记录：缓存未命中时实测 12–21s）。缓存与解密的**首次失败往往是暂时性的**
 * （文件正在被写、hardlink 还没建好、这一次超时），而原实现把 catch 分支留成空注释
 * 、直接吞掉：不重试、不记录、不告诉用户。
 *
 * 这里做两件事：① 失败的键**自动重试**（最多 2 次，间隔 1.5s，不忙等）；
 * ② 超过重试上限才 `console.warn` 出**具体原因**（后端 `resolveSnsImageDataUrl` 会给出
 * 「缺少图片标识」「未配置微信原始目录，无法离线解码」这类文本，原实现直接丢掉了）。
 */
const MEDIA_RETRY_MAX = 2
const MEDIA_RETRY_DELAY_MS = 1500
const mediaRetryCount = new Map<string, number>()
import type { ViewerState } from './moments-portals.tsx'

/**
 * 图片/视频的离线解码请求描述。
 * 定义在这里（而不是卡片里）：面板的钩子与卡片的 props 共用同一个形状，只有一份出处。
 */
export interface MediaKeySpec {
  /** 库里存的 CDN 地址（`http://…/0`）：给了就走 CDN 通路（见后端 `sns-cdn-image.ts`）。 */
  url?: string
  /** 媒体标签上的 `token`：CDN 必需（实测 `token+idx=1` 才 200）。 */
  token?: string
  md5: string
  timelineId?: string
  mediaId?: string
  kind: 'img' | 'video' | 'comment'
  seed?: string
  thumb?: string
}

/** 灯箱按需解析时用的最小图结构（与 `MomentsImageViewer` 传进来的形状兼容）。 */
type ViewerImage = { thumb?: string; url?: string; md5?: string; timelineId?: string; id?: string }

/**
 * 一批出队解码的条数。
 *
 * ⚠️ **必须 ≤ 后端重活队列容量**（`src/backend/http-queue.js` 的 `HEAVY_QUEUE_MAX = 4`）。
 * `getSnsImageDataUrl` / `getSnsVideoCoverDataUrl` 都在 `remote-policy.js` 的
 * `HEAVY_CALL_LEDGER` 里（缓存未命中时退化成 12–21s 的读+解密+哈希），因此每个请求都占
 * 一个**重活**名额；后端重活车道是「1 个在跑 + 4 个排队」，超出的立刻回 `REMOTE_BUSY`。
 *
 * 2026-10-16 真机实测：原值 8 时，朋友圈首屏一批 8 个请求里有 3–4 个被拒
 * （日志刷屏 `重任务排队已满（已有 1 个在跑、4 个在排队）`），重试机制虽救回大部分，
 * 但仍有零星图片永久失败（`[moments-media] 取图失败（已重试 2 次，放弃）`）。
 * 降到 4 后每批都能进队列，不再触发 `REMOTE_BUSY`。
 *
 * 别再往上调：批越大越容易撞队列上限，而**吞吐并不由这里决定** —— 后端重活并发恒为 1，
 * 前端发再多也只是排队或被拒。
 */
const MEDIA_BATCH = 4

/**
 * 进面板时一次从 IndexedDB 批量恢复的上限。
 *
 * 不能把 `moments` 里的全部键（真实数据 1000+）一次恢复：`snsImgs` 只有 200 条上限，
 * `capRecord` 超限会淘汰**最早插入**的键。真机实测一次 `getMany` 返回 555 条，结果
 * 首屏最先入表的几张被挤出内存，界面一直显示「正在取原图」——而滚动到后面的图正常。
 * 只恢复开头 80 个够覆盖首屏；后面的图懒加载时按单张 `snsMediaCacheGet` 命中。
 */
const SNS_IMG_RESTORE_MAX = 80

/**
 * 一批发出的封面请求条数（A2，2026-09-28 性能修复）。
 *
 * 改前是「`todo` 里有多少就一次全发」—— 一屏 30 篇 = 30 个并发 RPC 打向后端
 * （日志里 `getArticleCover` 1221 次 / 均 1.9s 就是这么来的）。分批是为了不形成尖峰。
 *
 * ⚠️ 别再"把这里提到后端并发上限（16）"当成优化：2026-09-29 试过，真机逐接口时间线里
 * `getArticleCovers` 的**调用次数没有变化**（仍是 3 次）—— 说明**约束在"每趟待办有多少条"**
 * （`pendingCovers` 的返回），不是这里的批大小。要再动它，先量出每趟到底带了几条
 * （后端日志不记入参，得先补一条带着条数的打点）。
 */
const COVER_BATCH = 8

/**
 * 视频（及其封面）的缓存键。
 * **这是 DOM 契约的一部分**：卡片把它挂到 `data-sns-key`，观察器再按同一个键反查 spec，
 * 灯箱与详情也用它取 `videoSrcs` —— 三处必须一字不差，所以只允许这一份实现。
 * @param v - 视频项（`md5` 优先，其次 `timelineId`+`id`）。
 * @returns `v:<md5>` / `v:<timelineId>:<id>` / 空串（两者都没有）。
 */
export function videoCoverKey(v: { md5?: string; timelineId?: string; id?: string }): string {
  return v.md5 ? 'v:' + v.md5 : (v.timelineId && v.id ? 'v:' + v.timelineId + ':' + v.id : '')
}

/**
 * 收集列表里所有「可能已经在本机解出过」的媒体键，用于进面板时先从 IndexedDB 捞一遍。
 * @param moments - 已加载的动态。
 * @returns 去重后的键列表（顺序稳定，便于测试对照）。
 */
export function collectMediaKeys(moments: readonly MomentItem[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (k: string): void => {
    if (k && !seen.has(k)) { seen.add(k); out.push(k) }
  }
  for (const m of moments) {
    for (const im of m.images) push(imgKey(im))
    for (const v of m.videos) push(videoCoverKey(v))
    for (const c of m.comments) push(c.image?.md5 || '')
  }
  return out
}

/**
 * 找出「本地 SNS 缓存没有、又还没试过（或试不满 3 次）」的公众号文章链接。
 * @param moments - 已加载的动态。
 * @param snsImgs - 已解出的本地媒体。
 * @param articleCovers - 已抓到的封面。
 * @param attempts - 各链接已试次数（会被本函数**就地累加**，与改前的行为一致）。
 * @returns 本轮要抓的链接列表。
 */
export function pendingCovers(
  moments: readonly MomentItem[],
  snsImgs: Record<string, string>,
  articleCovers: Record<string, string>,
  attempts: Map<string, number>,
): string[] {
  const todo: string[] = []
  for (const m of moments) {
    if (m.contentType !== 3 || !m.link_url) continue
    const cover = m.images[0]
    const localKey = cover ? imgKey(cover) : ''
    // 本机能解出就别去打网络（隐私闸门关着时这条尤其重要）。
    if (localKey && snsImgs[localKey]) continue
    if (articleCovers[m.link_url]) continue
    const attempt = attempts.get(m.link_url) ?? 0
    if (attempt >= 3) continue
    attempts.set(m.link_url, attempt + 1)
    todo.push(m.link_url)
  }
  return todo
}

/**
 * 补观察所有还没取过的 `[data-sns-key]` 格子（已取过的跳过，不重复观察）。
 *
 * 现象（2026-10-08 修）：往下滚动时**新出现的朋友圈图片一直不出来**（旧的一屏正常）。
 * 原因：建 IO 的那个 effect 从未 `.observe()` 任何元素 —— 只有挂载那一刻已在 DOM 里的占位格
 * 会被观察，滚动进来（列表变长 / 虚拟化重建）的格子永远不入队、也就永远不解码。
 *
 * ⚠️ 查询范围是 `document` 而不是滚动容器（2026-10-09 改）：**详情浮层与灯箱都 portal 到
 * `document.body`**（见 `moments-portals.tsx` 的两处 `createPortal`），只扫容器就永远扫不到
 * 浮层里的评论图格子，于是没人触发取图、恒显示 [图]。交集判定仍然交给 IO（它的 `root` 仍是
 * 滚动容器），所以扩大查询范围不会把屏外的格子拉去取图；而 `data-sns-key` 只有朋友圈在用
 * （全仓仅 `moments-card.tsx` / `moments-portals.tsx`），不会误伤别的面板。
 *
 * 调用点还要带 `detailKey` 依赖：浮层里的格子只在**打开浮层那一刻**才进 DOM，而列表本身
 * （`moments`）并没有变 ⇒ 只依赖 `moments` 的那次补观察扫不到它们。
 *
 * 独立成函数而不是内联在 hook 里：hook 紧贴 `function-size-ratchet` 的 250 行线，
 * 而这段的说明比代码本身长得多。
 */
function sweepSnsKeys(ob: IntersectionObserver, fetched: Set<string>): void {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-sns-key]'))) {
    const key = el.dataset.snsKey || ''
    if (key !== '' && !fetched.has(key)) ob.observe(el)
  }
}

/**
 * 这个格子此刻是否**真的在视口里**（而不是只在 IO 的预取边距内）。
 *
 * 为什么要区分：IO 的 `rootMargin` 是**预取**边距（提前解码，滚到时已经好了），
 * 但后端重活车道只有「1 个在跑 + 4 个排队」（见 {@link MEDIA_BATCH}），
 * 所以**队列顺序就是用户等待顺序**。若把预取区的格子与视口内的格子一视同仁地 FIFO 排队，
 * 用户正看着的那几张会排在「下一屏还没滚到的」后面 —— 表现为「滚到哪儿哪儿都在转圈」。
 *
 * 判据用 `getBoundingClientRect()` 与滚动容器的矩形相交，而不是 `entry.intersectionRatio`：
 * IO 的 ratio 是相对**加了 rootMargin 的扩展矩形**算的，在预取区里也是 1，区分不出来。
 * @param el - 媒体占位格。
 * @param root - 滚动容器（`null` 时退回视口）。
 * @returns 与容器矩形相交则为 true。
 */
function isInViewport(el: HTMLElement, root: HTMLElement | null): boolean {
  const r = el.getBoundingClientRect()
  const box = root ? root.getBoundingClientRect() : { top: 0, bottom: window.innerHeight }
  return r.bottom > box.top && r.top < box.bottom
}

/**
 * 把一批刚相交的媒体格子按「视口内 / 预取区」分派进队列。
 *
 * 视口内的**插队到队首**，预取区的追加到队尾。理由见 {@link isInViewport}。
 *
 * 同一批 entries 里先收集再入队：IO 一次回调可能带多个格子，逐个 `unshift` 会把
 * 顺序**倒过来**（后 unshift 的排更前），而 DOM 顺序才是用户从上往下看的顺序。
 *
 * 独立成函数而不是内联在 hook 里：hook 紧贴 `function-size-ratchet` 的 250 行线。
 * @param entries - IO 回调给的相交项。
 * @param specOf - 按 key 查媒体请求描述。
 * @param fetched - 已入过队的键（本函数会就地累加）。
 * @param queue - 待办队列（本函数会就地插入）。
 * @param root - 滚动容器。
 * @returns 是否真的入队了（调用方据此决定要不要触发 drain）。
 */
function enqueueIntersecting(
  entries: readonly IntersectionObserverEntry[],
  specOf: Map<string, MediaKeySpec>,
  fetched: Set<string>,
  queue: React.MutableRefObject<Array<{ key: string } & MediaKeySpec>>,
  root: HTMLElement | null,
): boolean {
  const urgent: Array<{ key: string } & MediaKeySpec> = []
  const lazy: Array<{ key: string } & MediaKeySpec> = []
  for (const e of entries) {
    if (!e.isIntersecting) continue
    const el = e.target as HTMLElement
    const key = el.dataset.snsKey || ''
    if (!key || fetched.has(key)) continue
    const spec = specOf.get(key)
    if (!spec) continue
    fetched.add(key)
    ;(isInViewport(el, root) ? urgent : lazy).push({ key, ...spec })
  }
  if (urgent.length === 0 && lazy.length === 0) return false
  // `unshift(...urgent)` 保持 urgent 内部顺序（DOM 顺序 = 用户从上往下看的顺序）。
  if (urgent.length > 0) queue.current.unshift(...urgent)
  if (lazy.length > 0) queue.current.push(...lazy)
  return true
}

/**
 * 取图失败后**延迟**放回队列，而不是立即 `push`。
 *
 * ## 为什么必须延迟（2026-10-16 真机实测）
 *
 * 立即放回是忙等：`drainMedia` 的 `while` 循环会马上把这一条连同下一批一起再发，
 * 而后端重活车道只有「1 个在跑 + 4 个排队」（`src/backend/http-queue.js` 的
 * `HEAVY_QUEUE_MAX = 4`；`getSnsImageDataUrl` 在 `remote-policy.js` 的 `HEAVY_CALL_LEDGER` 里）。
 * 于是失败 → 立即重发 → 再失败，形成 `REMOTE_BUSY` 风暴：日志被
 * `重任务排队已满（已有 1 个在跑、4 个在排队）` 刷屏，严重时渲染进程崩溃
 * （`[render-process-gone] {"reason":"crashed"}`）。
 *
 * `MEDIA_RETRY_DELAY_MS` 这个常量此前**定义了却从未使用**（注释写着"间隔 1.5s，不忙等"，
 * 实现却是立即放回）—— 这里把它接上：等 1.5s 让后端队列排空，再放回并重新触发 drain。
 *
 * 独立成函数而不是内联在 hook 里：hook 紧贴 `function-size-ratchet` 的 250 行线。
 *
 * @param it - 失败的那条媒体请求。
 * @param queue - 待办队列（放回它）。
 * @param unmounted - 组件是否已卸载（卸载后早退，避免后台自激）。
 * @param drain - 重新触发排空的回调。
 */
function requeueAfterDelay(
  it: { key: string } & MediaKeySpec,
  queue: React.MutableRefObject<Array<{ key: string } & MediaKeySpec>>,
  unmounted: React.MutableRefObject<boolean>,
  drain: () => void,
): void {
  window.setTimeout(() => {
    if (unmounted.current) return
    queue.current.push(it)
    drain()
  }, MEDIA_RETRY_DELAY_MS)
}

/** `useMomentsMedia` 的输入。 */
export interface MomentsMediaInput {
  moments: readonly MomentItem[]
  viewer: ViewerState | null
  /**
   * 滚动容器。由面板持有并注入：虚拟化要在**建虚拟器之前**拿到它（`getScrollElement`），
   * 而媒体层的窗口补查又依赖虚拟窗口 —— 让 hook 自己造这个 ref 就会绕成环。
   */
  scrollRef: React.MutableRefObject<HTMLDivElement | null>
  /**
   * 当前渲染的分组（虚拟化之后是"视口附近那几组"）。
   */
  groups: readonly unknown[]
  /**
   * 详情浮层当前那条动态的 tid（浮层关闭时为空串）。
   *
   * 为什么要单独一个信号：详情浮层与灯箱都 portal 到 `document.body`，浮层里的评论图格子
   * 只在**打开浮层那一刻**才出现在 DOM 里，而列表本身（`moments`）并没有变 ⇒ 只依赖
   * `moments` 的那次补观察永远扫不到它们，评论图就一直不取图（恒显示 [图]）。
   */
  detailKey: string
  /**
   * 渲染窗口的指纹（虚拟化：窗口一动就重新观察一遍新挂载的占位块）。
   * 原先这里传的是"渐进窗口已渲染到第几组"，虚拟化之后渲染的是一个**区间**，
   * 所以改成一个只要变化就能代表"DOM 换了一批元素"的键（面板传 `首下标-尾下标`）。
   */
  renderKey: string
}

/**
 * 重活 RPC 的串行车道（2026-10-19 修 REMOTE_BUSY）。
 *
 * 后端 `http-queue.js` 的重活车道只有 1 个运行位 + 4 个排队位；朋友圈一屏多张图同时
 * 请求时，缺 CDN 三件套的那些会落进重活车道，排队一满就 `REMOTE_BUSY`（真机日志
 * 「重任务排队已满（已有 1 个在跑、4 个在排队）」）。这里把可能走重活车道的请求串成
 * 一条链：一次只有 1 个在飞，其余在本地排队，不再把后端队列塞满。
 *
 * 注意：串行的是 RPC，不是渲染 —— 已经命中的 IndexedDB 原图不会进这条链。
 * @returns `run(task)`：把 task 排进串行链，返回它的结果 Promise。
 */
function createHeavyRpcLane(): <T>(task: () => Promise<T>) => Promise<T> {
  let chain: Promise<void> = Promise.resolve()
  return <T,>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task)
    chain = run.then(() => undefined, () => undefined)
    return run
  }
}

/**
 * 这条媒体 RPC 会不会进后端重活车道（决定是否要串行）。
 *
 * 判据与 `call-priority.js` 的 `downgradeHeavyByArgs` 对齐：视频封面恒重；图片只有
 * 「在线 + CDN 三件套齐」才会被降到普通车道，其余都按重活处理。
 * @param item - 媒体请求。
 * @param offline - 当前是否无网。
 * @returns true = 需要走串行车道。
 */
function needsHeavyRpcLane(item: MediaKeySpec, offline: boolean): boolean {
  if (item.kind === 'video' || offline) return true
  return !(typeof item.url === 'string' && item.url !== ''
    && typeof item.token === 'string' && item.token !== ''
    && typeof item.seed === 'string' && item.seed !== '')
}

/**
 * 朋友圈媒体层钩子：滚动懒解密 + 封面兜底 + IDB 恢复 + 灯箱按需解析。
 * @param input - 见 {@link MomentsMediaInput}。
 * @returns 面板与卡片要用的两份状态与一个引用。
 */
export function useMomentsMedia(input: MomentsMediaInput): {
  snsImgs: Record<string, string>
  articleCovers: Record<string, string>
  mediaKeySpec: React.MutableRefObject<Map<string, MediaKeySpec>>
  /** 取图**失败**的原因（key → 后端给的原因）。空对象 = 没有失败。 */
  snsErrs: Record<string, string>
} {
  const { moments, viewer, scrollRef, groups, renderKey, detailKey } = input
  const [snsImgs, setSnsImgs] = useState<Record<string, string>>({})
  /** 已经取过（或已经决定不再取）的键 —— 去重靠它，别改成 state（每次 render 都换身份会让效果重跑）。 */
  const snsFetched = useRef(new Set<string>())
  const [articleCovers, setArticleCovers] = useState<Record<string, string>>({})
  const coverAttempts = useRef<Map<string, number>>(new Map())
  const [coverTick, setCoverTick] = useState(0)

  const mediaKeySpec = useRef(new Map<string, MediaKeySpec>())
  const mediaQueue = useRef<Array<{ key: string } & MediaKeySpec>>([])
  const mediaFetching = useRef(false)
  const mediaObserved = useRef<IntersectionObserver | null>(null)
  /** 重活 RPC 串行链（见 createHeavyRpcLane）：一次只发一个，防后端重活队列 REMOTE_BUSY。 */
  const runHeavyRpc = useRef(createHeavyRpcLane()).current
  /** 组件是否已卸载：延迟重试的 `setTimeout` 回调据此早退，避免卸载后自激（见 catch 分支）。 */
  const mediaUnmounted = useRef(false)

  /** 当前是否无网。读法与「为什么不做成 state」见文件头「先网后本」。 */
  const isOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false

  const drainMedia = async (): Promise<void> => {
    if (mediaFetching.current) return
    mediaFetching.current = true
    try {
      while (mediaQueue.current.length > 0) {
        const batch = mediaQueue.current.splice(0, MEDIA_BATCH)
        const offline = isOffline()
        await Promise.all(batch.map(async (it) => {
          const opts: { md5: string; timelineId?: string; mediaId?: string; key?: string; thumb?: string; url?: string; token?: string; seed?: string; offline?: boolean } = {
    md5: it.md5,
    // 只给图片带 CDN 三件套（视频走另一个 RPC）；有才传 ⇒ 缺省时调用形状逐字不变
    // ⚠️ 下面三行原来都写的是 `kind === 'img'`，把评论图（`kind === 'comment'`）关在门外：
// 就算卡片把 url/token/seed 填齐了也传不到后端，评论图于是永远取不到（实测裸地址
// 5/5 返 HTTP 400，而评论图本机没有对应文件 ⇒ 只能显示 [图]）。
// 判据因此改成「**不是视频**」而不是「是 img」：以后再加图片种类不会被静默漏掉。
...(it.kind !== 'video' && it.url ? { url: it.url } : {}),
    ...(it.kind !== 'video' && it.token ? { token: it.token } : {}),
    ...(it.kind !== 'video' && it.seed ? { seed: it.seed } : {}),
  }
          if (it.timelineId) opts.timelineId = it.timelineId
          if (it.mediaId) opts.mediaId = it.mediaId
          if (it.seed) opts.key = it.seed
          if (it.thumb) opts.thumb = it.thumb
          // 本地优先（2026-10-19 用户口径）：先查 IndexedDB 里的**原图**（`wantOriginal`
          // 会把缩略图当未命中）。命中就直接显示、不再出网；只有本地确实没有原图才走
          // 后端（后端同样先查长期归档/本机，最后才 CDN）。
          opts.offline = offline
          try {
            const cached = await snsMediaCacheGet(it.key, true)
            if (cached) {
              // 逐条上屏，不能等 `Promise.all` 全部结束：同一批里只要有一张 RPC 卡住，
              // 其余几张**已经命中的本地原图**也会一起被压住（真机实测：IDB 里明明有
              // 3 张，界面却一直显示「正在取原图」）。
              setSnsImgs(prev => capRecord({ ...prev, [it.key]: cached }, SNS_IMG_CACHE_MAX))
              setSnsErrs(prev => { const next = { ...prev }; delete next[it.key]; return next })
              return
            }
            // 重活车道判定：视频恒重；图片只有「在线 + CDN 三件套齐」才走普通车道，其余串行。
            const needsHeavyLane = needsHeavyRpcLane(it, offline)
            const rpc = () => (it.kind === 'video'
              ? apiGetSnsVideoCoverDataUrl(opts)
              : apiGetSnsImageDataUrl(opts))
            const r = needsHeavyLane ? await runHeavyRpc(rpc) : await rpc()
            if (r.url) {
              setSnsImgs(prev => capRecord({ ...prev, [it.key]: r.url as string }, SNS_IMG_CACHE_MAX))
              setSnsErrs(prev => { const next = { ...prev }; delete next[it.key]; return next })
              // 把「这次是不是缩略图」一起存下去：后端降级给缩略图时标上，
              // 下一轮就能跳过它去换原图（而不是把缩略图当成最终结果永久缓存）。
              void snsMediaCacheSet(it.key, r.url, r.thumb === true)
              mediaRetryCount.delete(it.key)
            } else {
              // 后端**给了原因**（`{ url?, error? }`），原实现把它丢掉了 ⇒ 这里带上原因再抛
              throw new Error(r.error ?? '后端未返回图片地址')
            }
          } catch (e) {
            /**
             * 不再静默：暂时性失败（文件正在写 / 刚建 hardlink / 这一次超时）**放回队列再试**，
             * 最多 `MEDIA_RETRY_MAX` 次；超限才记录**具体原因**。
             * 用户看到的不该是"无解释的空白"。
             */
            const n = (mediaRetryCount.get(it.key) ?? 0) + 1
            mediaRetryCount.set(it.key, n)
            if (n <= MEDIA_RETRY_MAX) {
              // 延迟放回（理由见 `requeueAfterDelay` 的文件头）：立即放回会形成 REMOTE_BUSY 风暴。
              requeueAfterDelay(it, mediaQueue, mediaUnmounted, () => { void drainMedia() })
            } else {
              const reason = (e as Error).message
              console.warn('[moments-media] 取图失败（已重试 ' + String(MEDIA_RETRY_MAX) + ' 次，放弃）:', it.key, reason)
              setSnsErrs(prev => ({ ...prev, [it.key]: reason }))
            }
          }
        }))
      }
    } finally {
      mediaFetching.current = false
    }
  }

  // 懒加载媒体：只有图片/视频封面的占位块接近视口时才解密（IntersectionObserver），
  // 避免一次性解密数百张离线图片造成卡顿；已取到的 data URL 通过 snsImgs 合入。
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      // 兜底：不支持 IO 时退回整页解密已挂载的媒体。
      const all = Array.from(mediaKeySpec.current.entries())
      for (const [key, spec] of all) {
        if (snsFetched.current.has(key)) continue
        snsFetched.current.add(key)
        mediaQueue.current.push({ key, ...spec })
      }
      void drainMedia()
      return
    }
    const ob = new IntersectionObserver((entries) => {
      // 视口内的插队到队首、预取区的排到队尾（理由见 `enqueueIntersecting`）。
      if (enqueueIntersecting(entries, mediaKeySpec.current, snsFetched.current, mediaQueue, scrollRef.current)) {
        void drainMedia()
      }
    }, { root: scrollRef.current, rootMargin: '480px 0px' })
    mediaObserved.current = ob
    return () => {
      ob.disconnect()
      mediaObserved.current = null
      // 卸载后不再让延迟重试的 setTimeout 触发 drain（否则会在后台自激）。
      mediaUnmounted.current = true
    }
  }, [])

  /** 观察新出现的格子；为什么必须扫 `document`、为什么还要一个 `detailKey`，见 {@link sweepSnsKeys}。 */
  useEffect(() => {
    const ob = mediaObserved.current
    if (!ob || !scrollRef.current) return
    sweepSnsKeys(ob, snsFetched.current)
  }, [moments, detailKey])

  /**
   * 公众号文章封面兜底：本地 SNS 缓存没有时，抓取文章页 og:image 转 data URL；
   * 失败后自动重试（最多 3 次），避免首次加载失败只能靠刷新才能显示。
   *
   * ## A1+A2（2026-09-28 性能修复）
   *
   * 改前是 `for (const url of todo) { void apiGetArticleCover({ contentUrl: url }) }`
   * —— **每个链接一个 RPC、且全部立刻发出**。现场日志据此得到「`getArticleCover` 1221 次
   * （占全部慢调用 73.6%）、均 1920ms」：一屏 30 篇就是 30 个并发 RPC，每个还要 2 次网络往返。
   *
   * 现在：① 走批量接口 `apiGetArticleCovers`（一次一屏）；② 分批发出，每批
   * {@link COVER_BATCH} 条，与前一条的 `drainMedia`/`MEDIA_BATCH` 同一范式 ——
   * 这样即使一次 refresh 命中很多链接，也不会形成瞬时并发尖峰。
   */
  useEffect(() => {
    const todo = pendingCovers(moments, snsImgs, articleCovers, coverAttempts.current)
    if (todo.length === 0) return
    let cancelled = false
    const retry = (): void => {
      // 组件已卸载（或 effect 已换轮）就别再排重试，否则会在后台无限自激。
      if (cancelled) return
      setTimeout(() => { if (!cancelled) setCoverTick(t => t + 1) }, 2500)
    }
    const run = async (): Promise<void> => {
      for (let i = 0; i < todo.length; i += COVER_BATCH) {
        if (cancelled) return
        const batch = todo.slice(i, i + COVER_BATCH)
        try {
          const r = await apiGetArticleCovers({ urls: batch })
          if (cancelled) return
          const found: Record<string, string> = {}
          let missed = false
          for (const it of r.items ?? []) {
            if (it.dataUrl) found[it.url] = it.dataUrl
            else missed = true
          }
          if (Object.keys(found).length > 0) {
            setArticleCovers(prev => capRecord({ ...prev, ...found }, ARTICLE_COVER_CACHE_MAX))
          }
          if (missed) retry()
        } catch {
          retry()
        }
      }
    }
    void run()
    return () => { cancelled = true }
  }, [moments, snsImgs, articleCovers, coverTick])

  /**
   * 渲染窗口换了一批元素 ⇒ 重新观察一遍当前 DOM 里的媒体占位块。
   * 虚拟化之后每一行会反复挂载/卸载，所以这里**先 disconnect 再整批 observe**：
   * 观察器留着已卸载元素没有意义（它们永远不会再相交），而 `observe()` 对当前相交的
   * 元素会立刻补一次回调 —— 正好把"新挂载的这一批该解码"这条路走通。
   * 重复请求由 `snsFetched` 挡住，所以整批重观察不会把后端敲第二遍。
   */
  useEffect(() => {
    const root = scrollRef.current
    const ob = mediaObserved.current
    if (!root || !ob) return
    const cells = Array.from(root.querySelectorAll<HTMLElement>('[data-sns-key]'))
    ob.disconnect()
    for (const el of cells) ob.observe(el)
  }, [groups, renderKey])

  // 进面板时先从 IndexedDB 恢复**已解密原图**（2026-10-19 起不再区分有网/无网）。
  // 本地有原图就立刻画出来，本地没有的才会在视口内各自去后端要；只恢复开头一段。
  useEffect(() => {
    const keys = collectMediaKeys(moments)
      .filter((k) => !snsFetched.current.has(k))
      .slice(0, SNS_IMG_RESTORE_MAX)
    if (keys.length === 0) return
    void snsMediaCacheGetMany(keys, true).then((cached) => {
      const found = Object.keys(cached)
      if (found.length === 0) return
      for (const k of found) snsFetched.current.add(k)
      setSnsImgs(prev => capRecord({ ...prev, ...cached }, SNS_IMG_CACHE_MAX))
    })
  }, [moments])

  // 灯箱当前图：先查本地原图，没有才按需解析（与卡片共用 key）。
  useEffect(() => {
    const im = viewer ? viewer.images[viewer.index] as ViewerImage | undefined : undefined
    if (!im) return
    const key = imgKey(im)
    if (!key || snsImgs[key] || snsFetched.current.has(key)) return
    snsFetched.current.add(key)
    void snsMediaCacheGet(key, true).then(async (cached) => {
      if (cached) {
        setSnsImgs(prev => capRecord({ ...prev, [key]: cached }, SNS_IMG_CACHE_MAX))
        return
      }
      try {
        const r = await apiGetSnsImageDataUrl({ md5: im.md5 || '', timelineId: im.timelineId, mediaId: im.id })
        if (r.url) {
          setSnsImgs(prev => capRecord({ ...prev, [key]: r.url as string }, SNS_IMG_CACHE_MAX))
        }
      } catch { /* 保留后端兜底 */ }
    })
  }, [viewer, snsImgs])

  /* 取图失败的原因（key → 后端给的原因）。**可加性**输出：调用方暂时可以不理会，
     下一条改动会在占位上把它显示出来（用户："朋友圈图片加载不出来" —— 不该只看到空白）。 */
  const [snsErrs, setSnsErrs] = useState<Record<string, string>>({})

  return { snsImgs, articleCovers, mediaKeySpec, snsErrs }
}
