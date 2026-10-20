/**
 * 「任务中心已变」事件（任务信息 / 触发记录的写操作或新触发后广播）。
 *
 * 为什么要有独立事件、而不是复用宿主的 `dsh-wechat-data-updated`：
 *  - 宿主事件是**微信解密数据**同步落地后派发的（约每 10 秒一次），而任务的增删改
 *    与触发记录写入发生在用户动作或后端定时扫描里，与解密同步不同频；
 *  - 触发记录里携带的是**快照内容**（触发文本/图片引用），不随微信库再变。
 *
 * 三个订阅者必须同时刷新，否则会出现「左列表已出现任务、右栏记录还是旧的」：
 *  · `panels/TaskCenter.tsx`（左任务列表 + 右触发记录）；
 *  · `panels/task-create-dialog.tsx`（聊天侧新建任务后的「最近任务」）；
 *  · 任务详情弹窗（手动重投回调后的状态徽标）。
 *
 * 接线由 `panels/task-center.wiring.spec.ts` 钉住（三处都要监听这个事件）。
 */

/** 事件名。派发到 window，与宿主事件同一订阅面（`hooks.tsx` 的 `useWechatDataUpdated`）。 */
export const TASK_CENTER_UPDATED_EVENT = 'dsh-wechat-task-center-updated'

/**
 * 广播「任务中心已变」。
 *
 * 只广播、不带 payload：订阅方各自按自己的查询条件回源，避免两套数据形状
 * （事件里塞快照 = 第二个真源，一旦漏传字段面板就会画出半张脸）。
 */
export function notifyTaskCenterUpdated(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(TASK_CENTER_UPDATED_EVENT))
}
