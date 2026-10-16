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

export interface GroupInfoLiveInputs {
  /** 抽屉是否开着（开着才刷；关着时事件一律不取数）。 */
  open: boolean
  /** 当前会话 talker（= 抽屉的取数范围），读当前值用 ref；未开会话时是 null。 */
  talkerRef: React.MutableRefObject<string | null>
  sessionAlive: (epoch: number, talker: string) => boolean
  sessionEpochRef: React.MutableRefObject<number>
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
  const { open, talkerRef, sessionAlive, sessionEpochRef, setGroupInfo, setGroupInfoErr } = inputs
  const openRef = useRef(open)
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
    void apiGetGroupInfo(talker)
      .then((r) => {
        // 触发到落地之间：抽屉被关掉 / 会话切走（含 A→B→A 的往返，epoch 会变）都丢弃。
        if (!infoRefreshApplies(openRef.current, talker, talkerRef.current) || !aliveRef.current(epoch, talker)) return
        setGroupInfo(r.group)
        setGroupInfoErr(null)
      })
      .catch(() => { /* 静默：保留旧快照，下一次事件再试 */ })
  }, [])
  useWechatDataUpdated(refresh)
  useWechatDataUpdated(refresh, `${SNAPSHOT_REFRESHED_EVENT}:group`)
}
