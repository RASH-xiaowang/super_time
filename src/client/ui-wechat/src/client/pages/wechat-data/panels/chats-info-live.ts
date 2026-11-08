/**
 * 聊天信息抽屉的「实时刷新」共享件（2026-10-13）。
 *
 * 起因：两个信息抽屉（单聊 360 / 群聊信息）都只在**打开时**取一次数 ——
 * 抽屉开着时新消息解密落地（宿主约每 10 秒派发一次 `dsh-wechat-data-updated`），
 * 「消息总数 / 最近联系 / 群成员数 / 群公告」却永远停在打开那一刻。
 * 消息流那侧早有双通道（`chats-polling.ts`：宿主推送 + 定时轮询），抽屉这侧整族缺位。
 *
 * 本模块给群聊抽屉补上同一套订阅（单聊抽屉自带，见 `chats-contact-info-view.tsx`）：
 *   · 宿主数据事件 → 静默重取；
 *   · `dsh-snapshot-refreshed:group`（`apiGetGroupInfo` 的缓存后台复验落地广播）→ 再取一次，
 *     否则第一次重取命中的是 60s TTL 内的旧缓存值，界面仍停在旧数上。
 *
 * 两个抽屉共用的落地闸是 `infoRefreshApplies`：**抽屉还开着 + 响应仍属于当前会话**
 * 才写回 —— 事件触发后用户关了抽屉或切了会话，旧响应必须丢弃（否则 A 群的数据
 * 会盖到 B 群的抽屉头上，与消息流「归属不符只给骨架」同一条规矩）。
 */
import { useCallback, useRef } from 'react'
import { apiGetGroupInfo, SNAPSHOT_REFRESHED_EVENT } from '../api.ts'
import type { GroupInfo } from '@deepseek-ai/dsh-wechat-data/types'
import { useWechatDataUpdated } from './hooks.tsx'

/**
 * 一次信息抽屉的静默刷新响应是否仍应落地。
 * @param open - 抽屉此刻是否还开着。
 * @param fetchedFor - 触发取数时请求的会话 username。
 * @param currentTalker - 响应到达时的当前会话 username。
 * @returns 开着且没有切走才为 true。
 */
export function infoRefreshApplies(open: boolean, fetchedFor: string | null, currentTalker: string | null): boolean {
  return open && fetchedFor !== null && fetchedFor === currentTalker
}

/**
 * 判断一次「打开群资料」请求是否仍可提交结果。
 *
 * 除了会话归属，还必须比较请求序号：用户可能关闭后马上重开同一个群，
 * 此时 talker/epoch 都没变，只有新请求序号能让旧响应失效。
 */
export function groupInfoRequestApplies(
  requestSeq: number,
  currentSeq: number,
  sessionStillAlive: boolean,
): boolean {
  return requestSeq === currentSeq && sessionStillAlive
}

/**
 * 群资料所有请求共用的版本闸。
 *
 * 打开抽屉与实时刷新分处两个 hook，但必须竞争同一个序号；否则后发的刷新
 * 无法让更早、更慢的打开响应失效。闸按 `sessionEpochRef` 复用，避免改
 * `Chats.tsx` 的跨 hook 接线面。
 */
export interface GroupInfoRequestGate {
  current: number
}

const groupInfoRequestGates = new WeakMap<object, GroupInfoRequestGate>()

export function groupInfoRequestGateFor(owner: object): GroupInfoRequestGate {
  const existing = groupInfoRequestGates.get(owner)
  if (existing) return existing
  const gate = { current: 0 }
  groupInfoRequestGates.set(owner, gate)
  return gate
}

export function beginGroupInfoRequest(gate: GroupInfoRequestGate): number {
  gate.current += 1
  return gate.current
}

export function invalidateGroupInfoRequests(gate: GroupInfoRequestGate): void {
  gate.current += 1
}

export interface GroupInfoLiveInputs {
  /** 抽屉是否开着（开着才刷；关着时事件一律不取数）。 */
  open: boolean
  /** 当前会话 talker（= 抽屉的取数范围），读当前值用 ref；未开会话时是 null。 */
  talkerRef: React.MutableRefObject<string | null>
  sessionAlive: (epoch: number, talker: string) => boolean
  sessionEpochRef: React.MutableRefObject<number>
  requestGate: GroupInfoRequestGate
  setGroupInfo: React.Dispatch<React.SetStateAction<GroupInfo | null>>
  setGroupInfoErr: React.Dispatch<React.SetStateAction<string | null>>
}

/**
 * 群聊信息抽屉的实时刷新：宿主数据事件与群信息缓存刷新广播都会**静默**重取当前群。
 *
 * 静默 = 不置 loading、不清旧快照（清掉会让抽屉闪骨架屏）；失败保留旧值、
 * 下一次事件再试（与缓存后台复验失败同一降级口径）。成功顺带清掉上一次的错误 ——
 * 「打开时读失败、后台又好了」的抽屉会自愈，而不是等用户重开。
 * 抽屉**关着**时一个请求都不发（重开抽屉会自己重取），开着才发、落地前再过归属闸。
 */
export function useGroupInfoLive(inputs: GroupInfoLiveInputs): void {
  const { open, talkerRef, sessionAlive, sessionEpochRef, requestGate, setGroupInfo, setGroupInfoErr } = inputs
  const openRef = useRef(open)
  const previousOpenRef = useRef(open)
  // 关闭时立即作废所有在途请求。打开不再自增：打开请求本身会取得更高的新序号，
  // 若这里也在 false→true 时自增，会把刚发出的打开请求误杀。
  if (previousOpenRef.current && !open) {
    invalidateGroupInfoRequests(requestGate)
  }
  previousOpenRef.current = open
  openRef.current = open
  // sessionAlive 每次渲染都是新闭包；它只读 ref，存进 ref 让 refresh 的依赖保持为空。
  const aliveRef = useRef(sessionAlive)
  aliveRef.current = sessionAlive
  const refresh = useCallback((): void => {
    // 关着就不取（重开抽屉会自己重取）；开着才发请求，落地前再过归属闸。
    if (!openRef.current) return
    const talker = talkerRef.current
    if (!talker) return
    const epoch = sessionEpochRef.current
    const requestSeq = beginGroupInfoRequest(requestGate)
    void apiGetGroupInfo(talker)
      .then((r) => {
        // 触发到落地之间：抽屉被关掉 / 会话切走（含 A→B→A 的往返，epoch 会变）都丢弃。
        if (
          !groupInfoRequestApplies(requestSeq, requestGate.current, aliveRef.current(epoch, talker))
          || !infoRefreshApplies(openRef.current, talker, talkerRef.current)
        ) return
        setGroupInfo(r.group)
        setGroupInfoErr(null)
      })
      .catch(() => { /* 静默：保留旧快照，下一次事件再试 */ })
  }, [requestGate])
  useWechatDataUpdated(refresh)
  useWechatDataUpdated(refresh, `${SNAPSHOT_REFRESHED_EVENT}:group`)
}
