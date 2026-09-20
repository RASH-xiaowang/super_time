/**
 * 「笔记内容已变」事件（`wechat_notes.db` 的 notes 表被写入后广播）。
 *
 * 为什么要有独立事件、而不是复用宿主的 `dsh-wechat-data-updated`：
 * 后者是宿主在**解密数据**同步落地后派发的（同步期约每 10 秒一次），
 * 而笔记是用户自己写的、与解密同步无关 —— 写入笔记时它**根本不会触发**。
 * 这正是「改完笔记、图谱还是旧的」的成因：`api.ts` 里那次 `invalidate*` 只让
 * **下一次**取数拿到新数据，不会叫醒**已经挂载**的面板。
 *
 * 订阅侧：`Graph.tsx`（知识视图重载快照 ⇒ buildKnowledgeNetwork 重建节点）与
 * `KnowledgeBase.tsx`（列表重载）。接线由 `knowledge-base.wiring.spec.ts` 钉住。
 */

/** 事件名。派发到 window，与宿主事件同一订阅面（`hooks.tsx` 的 `useWechatDataUpdated`）。 */
export const NOTES_UPDATED_EVENT = 'dsh-wechat-notes-updated'

/** 广播「笔记已变」。写入路径唯一，见 `api.ts` 的 `invalidateKnowledgeCaches()`。 */
export function notifyNotesUpdated(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(NOTES_UPDATED_EVENT))
}

/**
 * 「库表已变」事件（`wechat_notes.db` 的 kbs 表被增 / 改名 / 删后广播）。
 *
 * 与 `NOTES_UPDATED_EVENT` 分开的原因：改一条笔记**不该**让库列表重拉，
 * 建一个库也**不该**让所有面板以为笔记变了。两者的订阅者不同 ——
 * 前者是列表与图谱，后者是 `kb-scope.ts` 的 `useKbScope`。
 * 合并成一个事件会让每次记笔记都白跑一次库列表 RPC。
 */
export const KBS_UPDATED_EVENT = 'dsh-wechat-kbs-updated'

/** 广播「库表已变」。写入路径唯一，见 `api.ts` 的 `invalidateKnowledgeCaches()`。 */
export function notifyKbsUpdated(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(KBS_UPDATED_EVENT))
}
