/**
 * ClawBot 接收通道 —— 绑定后的消息长轮询**循环**（生命周期与退避）。
 *
 * ## 职责边界
 *
 * - 协议层（`clawbot-ilink.ts`）：单次请求的形状与错误；
 * - **本模块**：把单次请求串成常驻循环（退避、会话过期恢复、游标推进、批后回调）；
 * - 装配层（`remotes/clawbot.ts`）：把本模块的依赖接到真实库 / 事件 / 审计上。
 *
 * 工厂化（`createClawbotChannel`）而不是模块级单例：状态与循环归**装配方**持有 ——
 * 测试里多个用例互不串扰，生产里一个网关一个通道。
 *
 * ## 循环语义（照 WeClaw monitor.go，改动处都写了理由）
 *
 * 1. **网络失败**：指数退避 3s → 60s；到第 5 次记一条「若持续请重新绑定」的警告；
 * 2. **服务端 `errcode=-14`（会话过期）**：游标非空 ⇒ 清空游标并保存、5s 后重连
 *    （游标坏了可以靠重拉恢复）；游标**已经是空**还 -14 ⇒ 凭证本身过期，
 *    **停循环**并把错误交给 `onError`（原版每 5s 无限重试一个已死的凭证，
 *    只会刷日志；恢复动作是重新绑定，停下来的状态界面看得见）；
 * 3. **其他服务端错误**（ret≠0 且 errcode≠0）：记日志 + 1s 间隔继续
 *    （原版这里不回退直接 continue，服务器半开时会变成热循环）；
 * 4. **成功**：清失败计数；游标非空则保存（**每一拍都持久化** —— 进程崩了重来时
 *    少拉一次历史，代价是一分钟不到两次的库写）；消息批交 `insertMessages`
 *    落库（去重由它兜底），真有新增才回调 `onMessages` 发事件。
 *
 * @module query/clawbot/clawbot-channel
 */
import type { IlinkUpdates, WeixinMessage } from './clawbot-ilink.ts'

/** 连续失败多少次时写一条「可能需要重新绑定」的警告（照 WeClaw 的 5）。 */
export const MAX_CONSECUTIVE_FAILURES = 5
/** 首次退避（毫秒），之后翻倍到 {@link MAX_BACKOFF_MS}。 */
export const INITIAL_BACKOFF_MS = 3_000
/** 退避上限。 */
export const MAX_BACKOFF_MS = 60_000
/** 会话过期（-14）后重连前的等待。 */
export const SESSION_EXPIRED_BACKOFF_MS = 5_000
/** 其他服务端错误后的间隔（防热循环，见模块头注 ③）。 */
export const SERVER_ERROR_BACKOFF_MS = 1_000
/** 服务端表示「会话过期」的错误码。 */
export const ERR_CODE_SESSION_EXPIRED = -14

/** 通道对外状态（`checkClawbotEnv` 的第二项直接用）。 */
export interface ClawbotChannelState {
  running: boolean
  /** 最近一次错误的中文说明（`null` = 正常）；会话过期等终态错误会一直留着直到重新绑定。 */
  lastError: string | null
  /** 最近一次成功轮询的本地时间（没成功过为 `null`）。 */
  lastPollAt: number | null
}

/** 装配方提供的依赖（全是直调 / 注入，本模块不 import 库与事件）。 */
export interface ClawbotChannelDeps {
  /**
   * 一次消息长轮询（真实实现 = `clawbot-ilink.ts#getUpdates` 绑定凭证后的偏函数）。
   * 第二参数是通道生命周期发出的 AbortSignal：实现应把它透传给网络请求，使
   * `stop()` 能真正中断在飞请求，而不是等超时/响应回来后再被丢弃。
   */
  getUpdates: (buf: string, signal?: AbortSignal) => Promise<IlinkUpdates>
  /** 读同步游标（绑定行的 `sync_buf` 列）。 */
  readBuf: () => string
  /** 存同步游标。 */
  saveBuf: (buf: string) => void
  /** 一批消息落库（自动跳过重复 `message_id`）；没有新增时返回 null。 */
  insertMessages: (msgs: readonly WeixinMessage[]) => { lastId: number, delta: number } | null
  /** 有新增消息时回调（装配方发 `clawbot/message` 事件；本模块不碰事件系统）。 */
  onMessages: (info: { lastId: number, delta: number }) => void
  /** 错误状态变化回调（装配方写入 `checkClawbotEnv` 的通道项）。 */
  onError: (error: string | null) => void
  /** 退避休眠（测试注入即时实现）；实现可接收 AbortSignal，在停止时立刻拒绝。 */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  /** 日志出口（缺省 `console.log`；测试可静音）。 */
  log?: (message: string) => void
}

/** 通道句柄：`start` 幂等、`stop` 后再次 `start` 也能跑（重新绑定路径）。 */
export interface ClawbotChannel {
  start: () => void
  stop: () => void
  state: () => ClawbotChannelState
}

/** 第 failures 次失败后的退避（3s 起、翻倍、封顶 60s）。 */
export function backoffMs(failures: number): number {
  let d = INITIAL_BACKOFF_MS
  for (let i = 1; i < failures; i++) {
    d *= 2
    if (d >= MAX_BACKOFF_MS) return MAX_BACKOFF_MS
  }
  return d
}

/**
 * 创建一个通道句柄。
 *
 * 循环挂在 `start()` 里以 `void` 启动（**不阻塞调用方**：网关启动路径不该等一轮
 * 长轮询）；`stop()` 同时置停止位并 abort 当前通道的 AbortController。只要
 * 装配层把 signal 透传给网络请求与休眠，正在飞的请求/退避都能立刻收尾。
 * @param deps - 依赖（见 {@link ClawbotChannelDeps}）。
 * @returns 通道句柄。
 */
export function createClawbotChannel(deps: ClawbotChannelDeps): ClawbotChannel {
  const log = deps.log ?? ((m: string): void => { console.log('[clawbot] ' + m) })
  let running = false
  let lastError: string | null = null
  let lastPollAt: number | null = null
  let controller: AbortController | null = null

  const isStopAbort = (error: unknown, signal?: AbortSignal): boolean => {
    return !running || signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
  }

  async function loop(signal: AbortSignal): Promise<void> {
    let failures = 0
    let buf = deps.readBuf()
    while (running) {
      let resp: IlinkUpdates
      try {
        resp = await deps.getUpdates(buf, signal)
      } catch (e) {
        if (isStopAbort(e, signal)) break
        failures += 1
        const backoff = backoffMs(failures)
        log(`getupdates 失败（第 ${failures} 次，${backoff} ms 后重试）：${e instanceof Error ? e.message : String(e)}`)
        if (failures === MAX_CONSECUTIVE_FAILURES) {
          log('连续 5 次失败 —— 若持续，请到「ClawBot → 集成设置」重新绑定')
        }
        try {
          await deps.sleep(backoff, signal)
        } catch (e) {
          if (isStopAbort(e, signal)) break
          throw e
        }
        continue
      }
      if (!running) break
      failures = 0
      lastPollAt = Date.now()

      if (resp.errCode === ERR_CODE_SESSION_EXPIRED) {
        if (buf !== '') {
          log('会话过期：清空同步游标后重连')
          buf = ''
          deps.saveBuf('')
        } else {
          lastError = '微信会话已过期：请到「ClawBot → 集成设置」重新扫码绑定'
          deps.onError(lastError)
          log(lastError + '（停止轮询）')
          running = false
          break
        }
        try {
          await deps.sleep(SESSION_EXPIRED_BACKOFF_MS, signal)
        } catch (e) {
          if (isStopAbort(e, signal)) break
          throw e
        }
        continue
      }

      if (resp.ret !== 0 && resp.errCode !== 0) {
        log(`服务端错误：ret=${resp.ret} errcode=${resp.errCode} errmsg=${resp.errMsg}`)
        try {
          await deps.sleep(SERVER_ERROR_BACKOFF_MS, signal)
        } catch (e) {
          if (isStopAbort(e, signal)) break
          throw e
        }
        continue
      }

      if (resp.buf !== '') {
        buf = resp.buf
        deps.saveBuf(buf)
      }
      if (resp.messages.length > 0) {
        const inserted = deps.insertMessages(resp.messages)
        if (inserted) deps.onMessages(inserted)
      }
    }
  }

  return {
    start(): void {
      if (running) return
      controller = new AbortController()
      running = true
      lastError = null
      deps.onError(null)
      log('接收通道启动（长轮询）')
      void loop(controller.signal).catch((e: unknown) => {
        /* v8 ignore next -- loop 内部每一步都有 try/catch；这层只兜底防未处理拒绝。 */
        lastError = '接收通道异常退出：' + (e instanceof Error ? e.message : String(e))
        /* v8 ignore next */
        deps.onError(lastError)
      })
    },

    stop(): void {
      if (!running) return
      running = false
      controller?.abort()
      log('接收通道停止')
    },

    state(): ClawbotChannelState {
      return { running, lastError, lastPollAt }
    },
  }
}
