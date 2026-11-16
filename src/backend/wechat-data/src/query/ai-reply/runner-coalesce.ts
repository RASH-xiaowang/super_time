/**
 * AI 回复的「连发合并」与「被取代预约的收口」。
 *
 * 真机事故（2026-11-16）：同一位单聊对象 4 分钟内发来 49 条消息，消息列表里
 * 出现 49 条 AI 回复记录，绝大多数是状态=失败、备注「会话已有更新的消息…」。
 * 根因有两层：
 *  · 预约（写 pending 记录）发生在「会话是否已被新消息越过」判断之前，
 *    所以每次扫描都先建一条记录、再把它标失败；
 *  · 对方连发时每来一条新消息就开跑一次模型，上一条结果作废，既烧 token
 *    又留下失败记录。
 *
 * 本模块只做三件事，且都发生在**预约之前**（恢复中的旧任务不走这里）：
 *  ① 静默期合并：等对方这一轮说完，锚点跟到最新一条；
 *  ② 预约前复核：会话已推进就直接收口，不建记录；
 *  ③ 已被取代的空白预约直接删除（从未生成过正文才允许删）。
 */
import { readChatAiReplyGenerationStrict } from './config-store.ts'
import type {
  ChatAiReplyAnchor,
  ChatAiReplyScanDeps,
  ChatAiReplyScanMessage,
  ChatAiReplySegmentSnapshot,
  ChatAiReplyState,
} from './types.ts'
import {
  conversationProgressedAfter,
  cursorOf,
  delay,
  errorText,
  inspectReply,
  latestInboundAfterCursor,
  latestVisibleMessage,
  sourceRefOf,
} from './runner-recovery.ts'
import {
  type ChatAiReplyRunRef,
  deferChatAiReplyRun,
  failChatAiReplyReservation,
  guardedUpdate,
  notifyChatAiReplyRecordUpdated,
  settleChatAiReplyRun,
} from './runner-state.ts'

/**
 * 同一轮连发的合并静默期：这么久没有新消息才认定对方这一轮说完了。
 */
export const CHAT_AI_REPLY_COALESCE_QUIET_MS = 900
/** 被同轮更新消息取代时的统一说明（消息列表 error 列展示）。 */
export const STALE_REPLY_REASON =
  '会话已有更新的消息，本次 AI 回复已过期取消；不会自动补发旧问题'
/** 合并等待上限：对方持续刷屏时也不能一直占着会话租约。 */
const CHAT_AI_REPLY_COALESCE_MAX_MS = 3_500
/**
 * 到达总等待上限时，若刚刚（≤ 600ms）还有新消息把锚点往后挪，说明这一轮
 * 连发仍未结束；允许再延长一次 1500ms，避免在刷屏中途抢先回复旧消息。
 * 只延长一次，所以持续刷屏的最长等待是 3.5s + 1.5s = 5.0s。
 */
export const COALESCE_BURST_WINDOW_MS = 600
export const COALESCE_GRACE_MS = 1_500
/** 合并期间的轮询间隔：只读最新一页，代价是几次 SQL。 */
const CHAT_AI_REPLY_COALESCE_POLL_MS = 200
/** 允许的时钟偏差：消息时间比本地时间晚超过这个值就不参与合并计时。 */
const CHAT_AI_REPLY_CLOCK_SKEW_TOLERANCE_MS = 60_000
/** 合并期扫描的窗口大小，与 runner-recovery 的扫描窗口一致。 */
const CHAT_AI_REPLY_COALESCE_WINDOW = 80

function anchorAfter(anchor: ChatAiReplyAnchor, candidate: ChatAiReplyAnchor): boolean {
  return candidate.sortSeq > anchor.sortSeq
    || (candidate.sortSeq === anchor.sortSeq && candidate.localId > anchor.localId)
}

/** 自己发出的消息是否排在锚点之后；`anchorOf` 不覆盖 isSender=1，只能自己判位。 */
function messageAfterAnchor(
  anchor: ChatAiReplyAnchor,
  message: ChatAiReplyScanMessage,
): boolean {
  const localId = Number(message.localId)
  const sortSeq = Number(message.sortSeq ?? message.localId)
  if (!Number.isSafeInteger(localId) || localId <= 0
    || !Number.isSafeInteger(sortSeq) || sortSeq < 0) return false
  return sortSeq > anchor.sortSeq || (sortSeq === anchor.sortSeq && localId > anchor.localId)
}

/** 连发期间把锚点挪到最新一条对方消息，避免为旧消息生成。 */
async function reanchorChatAiReplyRun(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  run: ChatAiReplyRunRef,
  anchor: ChatAiReplyAnchor,
): Promise<boolean> {
  const previous = run.sourceRef
  run.anchor = anchor
  run.sourceRef = sourceRefOf(state, anchor)
  const updated = await guardedUpdate(deps, state, run, {
    stage: 'generating',
    pendingCursor: cursorOf(anchor),
    pendingSourceRef: run.sourceRef,
    lastRunAt: Date.now(),
    error: '',
  })
  if (updated === 'guard-mismatch') {
    run.leaseLost = true
    return false
  }
  if (updated === 'transient') return false
  if (previous !== run.sourceRef) {
    deps.op('chat_ai_reply', true,
      'coalesce: anchor moved ' + previous + ' -> ' + run.sourceRef + '; no record created yet')
  }
  return true
}

/**
 * 生成前合并同一轮连发。
 *
 * 只在**全新锚点**上生效：恢复中的旧任务必须按原锚点收口，不能在这里改道。
 * 返回 'handled' 表示本次运行已经收口（不建记录、不调模型）；返回 'generate'
 * 表示可以继续预约与生成。
 */
export async function coalesceChatAiReplyRun(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  run: ChatAiReplyRunRef,
  isCancelled: () => boolean,
  quietMs: number = CHAT_AI_REPLY_COALESCE_QUIET_MS,
): Promise<'generate' | 'handled'> {
  if (run.resumed) return 'generate'
  if (!Number.isFinite(quietMs) || quietMs <= 0) return 'generate'
  /**
   * 锚点是否「刚刚才到」。
   *
   * 用注入时钟判断消息年龄：历史积压（锚点早就是几分钟前的消息）不需要等待；
   * 消息时间比本地时钟还晚一分钟以上说明时钟不同步（或测试用了假时钟），
   * 拿它计时只会白等甚至死循环。
   */
  const isFresh = (anchor: ChatAiReplyAnchor): boolean => {
    if (anchor.createTime <= 0) return false
    const at = anchor.createTime * 1000
    if (at - run.now() > CHAT_AI_REPLY_CLOCK_SKEW_TOLERANCE_MS) return false
    return run.now() - at < quietMs
  }
  if (!isFresh(run.anchor)) return 'generate'
  // 等待时长按真实时钟计：注入时钟可能被测试冻结，拿它算超时会死循环。
  let deadline = Date.now() + Math.max(quietMs, CHAT_AI_REPLY_COALESCE_MAX_MS)
  let quietUntil = Date.now() + quietMs
  let lastReanchorAt = 0
  let extended = false
  while (true) {
    const now = Date.now()
    if (now >= deadline) {
      // 连发仍在继续（最近一次重锚不超过 600ms）时只延长一次静默预算。
      if (!extended && lastReanchorAt > 0 && now - lastReanchorAt <= COALESCE_BURST_WINDOW_MS) {
        extended = true
        deadline += COALESCE_GRACE_MS
        quietUntil = Math.min(now + quietMs, deadline)
        continue
      }
      break
    }
    if (now >= quietUntil) break
    if (isCancelled()) return 'handled'
    await delay(Math.max(1, Math.min(
      CHAT_AI_REPLY_COALESCE_POLL_MS,
      Math.min(quietUntil, deadline) - Date.now() + 1,
    )))
    if (isCancelled()) return 'handled'
    let messages: Awaited<ReturnType<ChatAiReplyScanDeps['listMessages']>> | undefined
    let readError: unknown
    // 原地重试一次：一次数据库抖动不应把整轮合并变成直接生成。
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        messages = await deps.listMessages(state.chatUsername, CHAT_AI_REPLY_COALESCE_WINDOW)
        readError = undefined
        break
      } catch (e) {
        readError = e
      }
    }
    if (messages === undefined) {
      // 读不到新消息时不能假定「没有更新」，更不能直接调模型；有租约就暂缓本轮，
      // 下一拍仍从同一锚点恢复。无租约的调用方保留原降级行为。
      if (run.lease === undefined || run.revision <= 0) return 'generate'
      await deferChatAiReplyRun(
        deps,
        state,
        run,
        '无法确认连发是否结束，本次 AI 回复已暂缓：' + errorText(readError),
        'coalesce: listMessages failed; retained for retry',
      )
      return 'handled'
    }
    const latest = latestVisibleMessage(messages)
    if (latest !== undefined
      && latest.isSender === 1
      && messageAfterAnchor(run.anchor, latest)) {
      // 这一轮已经有人答过（人工回复或上一条 AI 回复），再生成就是抢话。
      run.recordOpen = false
      await settleChatAiReplyRun(deps, state, run, 'success', '',
        'coalesce: conversation already answered; no reply generated')
      return 'handled'
    }
    const newest = latestInboundAfterCursor(messages, state.cursor)
    const newestAnchor = newest ?? null
    if (newestAnchor !== null && anchorAfter(run.anchor, newestAnchor)) {
      if (!(await reanchorChatAiReplyRun(deps, state, run, newestAnchor))) return 'handled'
      lastReanchorAt = Date.now()
      // 又来了新消息：静默期从头计，但总等待时间仍受 deadline 限制。
      quietUntil = Math.min(Date.now() + quietMs, deadline)
      if (!isFresh(run.anchor)) break
    }
  }
  return 'generate'
}

/**
 * 预约**之前**的最后一次会话推进复核。
 *
 * 走到这里说明连发合并期已经结束；若这期间又来了新消息（或人工已经回了一句），
 * 就不该再建预约 —— 直接推进水位收口，下一拍按新的锚点处理。这样消息列表里
 * 不会出现一条先建出来、又立刻被标失败的记录。
 *
 * 返回 true 表示本轮已收口；读取失败时返回 false，交给预约后的复核兜底。
 */
export async function cancelSupersededBeforeReservation(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  run: ChatAiReplyRunRef,
): Promise<boolean> {
  // 只对全新锚点生效：已有预约/恢复中的任务必须按原锚点收口，不能在这里改道，
  // 否则会留下一条永远不会收口的「生成中」记录。
  if (run.resumed || run.recordId !== undefined || run.reservationMade) return false
  let progressed: boolean
  try {
    progressed = await conversationProgressedAfter(deps, state, run.anchor)
  } catch {
    return false
  }
  if (!progressed) return false
  run.recordOpen = false
  await settleChatAiReplyRun(
    deps,
    state,
    run,
    'success',
    '',
    'superseded before reservation; no record created',
  )
  return true
}

/**
 * 删除一条**从未生成过正文**的预约。
 *
 * 三重守卫：整组记录/分段都还是 pending、正文全空、没有同锚点的生成快照。
 * 生成快照存在（intent/result）说明模型可能已经调用过，结果不能随记录一起删。
 */
async function dropUnsentReservation(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  run: ChatAiReplyRunRef,
): Promise<boolean> {
  if (run.recordId === undefined || deps.dropReply === undefined) return false
  const record = await inspectReply(deps, run.recordId)
  if (!record.found || record.status !== 'pending') return false
  if ((record.text ?? '').trim() !== '') return false
  const generation = readChatAiReplyGenerationStrict(
    deps.decryptedDir(),
    state.accountKey,
    state.chatUsername,
  )
  if (!generation.ok) return false
  const snapshot = generation.generation
  if (snapshot !== undefined
    && snapshot.sourceRef === run.sourceRef
    && (snapshot.state === 'intent' || snapshot.state === 'result')) return false
  if (deps.listReplySegments !== undefined) {
    let segments: ChatAiReplySegmentSnapshot[]
    try {
      segments = await deps.listReplySegments(run.sourceRef)
    } catch {
      return false
    }
    if (!segments.every((segment) => segment.status === 'pending'
      && (segment.text ?? '').trim() === '')) return false
  }
  try {
    const dropped = await deps.dropReply({ id: run.recordId, sourceRef: run.sourceRef })
    if (!dropped.ok) return false
    notifyChatAiReplyRecordUpdated(deps, state, run.recordId)
    return true
  } catch {
    // 删除失败退回标记失败：宁可多一条记录，也不能让预约悬空。
    return false
  }
}

/**
 * 收口被更新消息取代的预约。
 *
 * 能删就删（从未生成过正文），删不了才标失败并保留事实。返回 true 表示已经
 * 删除并 settle 成功，调用方应直接结束本轮；返回 false 表示已退回标失败路径。
 */
export async function dropOrFailStaleReservation(
  deps: ChatAiReplyScanDeps,
  state: ChatAiReplyState,
  run: ChatAiReplyRunRef,
  pendingSegments: readonly ChatAiReplySegmentSnapshot[],
  reason: string = STALE_REPLY_REASON,
): Promise<boolean> {
  if (await dropUnsentReservation(deps, state, run)) {
    const droppedId = run.recordId
    // 记录已经不存在了，状态里不能再留一个指向它的 recordId。
    run.recordId = undefined
    run.recordOpen = false
    await settleChatAiReplyRun(
      deps,
      state,
      run,
      'success',
      '',
      'record=' + String(droppedId) + ' superseded; unsent reservation dropped',
    )
    return true
  }
  await failChatAiReplyReservation(deps, state, run, reason, 'superseded')
  for (const segment of pendingSegments) {
    notifyChatAiReplyRecordUpdated(deps, state, segment.id)
  }
  return false
}
