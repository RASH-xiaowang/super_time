/**
 * 布局 Worker 入口：只做「收任务 → 算 → 回传」三件事。
 *
 * 为什么本体这么薄：布局参数与 FA2 调用全部从 graph-layout.ts 借（assignLayout / fa2Settings），
 * Worker 里不放任何自己的刻度 —— 主线程小图与 Worker 大图走的是同一个函数，
 * 两条路径不可能慢慢跑出两种手感。
 *
 * 为什么回包必须带 key：滑块连发时会有多个任务在飞，先发后到的回包属于旧指纹，
 * 主线程要靠这个 key 认出并丢掉它（见 graph-layout.ts 的 workerWaiters 与 onmessage）。
 */
import { assignLayout, type LayoutTask, type LayoutTaskResult } from './graph-layout.ts'

/** Worker 作用域。收窄成最小接口，免得把 Window 的类型（以及 DOM 的 postMessage 重载）混进来。 */
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<LayoutTask>) => void) | null
  postMessage: (message: LayoutTaskResult) => void
}

ctx.onmessage = (event) => {
  const task = event.data
  try {
    // assignLayout 是同步阻塞的：Worker 存在的意义就是让这份阻塞发生在主线程之外
    ctx.postMessage({ key: task.key, points: assignLayout(task) })
  } catch (error) {
    // 单次失败只作废这一条请求：主线程收到 error 后会回退主线程，Worker 本身没必要陪葬
    ctx.postMessage({ key: task.key, error: error instanceof Error ? error.message : String(error) })
  }
}
