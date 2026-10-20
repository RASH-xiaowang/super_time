/**
 * 后端事件 → DOM CustomEvent 的**唯一映射表**。
 *
 * ## 为什么要抽出来
 *
 * 这段映射原先内联在 `ui-entry.tsx` 里（一串 `if (ev.name === …)`），只服务 IPC 一条路。
 * 加入局域网远程访问（手机端）之后，同一批事件改从 **SSE** 过来，如果两边各写一份 if-else，
 * 必然出现「桌面端某个面板会实时刷新、手机端不会」这种**只在一端复现**的偏差 ——
 * 而这正是本项目最难排查的一类问题（上一轮 WAL 实时性事故的同款症状：界面完全正常，
 * 只是数据不动）。
 *
 * 所以映射收成一张表，两个传输层都调 {@link dispatchWechatEvent}。
 * `wechat-events.spec.ts` 直接对着这张表断言事件名与 detail 形状。
 *
 * ## 为什么是 DOM 事件而不是 React 状态
 *
 * 面板分布在 `ui-wechat` 这个**库包**里，它们通过 `window.addEventListener('dsh-…')` 订阅
 * （见 `panels/hooks.tsx` 的 `useWechatDataUpdated`）。宿主（本文件）只负责把后端事件
 * 翻译成那些名字 —— 库包不需要知道宿主是 Electron 还是浏览器。这也是「手机与桌面
 * 共用同一份渲染层」能成立的前提。
 *
 * 本模块是**纯逻辑**：不 import react、不碰后端，只碰 `window.dispatchEvent`
 * （通过可注入的 target 传入，便于在 node 环境的 vitest 里覆盖）。
 *
 * @module ui-app/wechat-events
 */

import type { BackendEvent } from '@deepseek-ai/dsh-client-ui-wechat/contracts'

/** 后端推来的事件形状（IPC 的 `wechat:event` 与 SSE 的 data 帧**完全同形**）。 */
export type { BackendEvent }

/**
 * 映射表：后端事件名 → DOM 事件名。
 *
 * `detail: true` 表示要把 `args[0]` 作为 `detail` 带上（缺省则不带 detail）。
 * 表里**没有**的事件一律忽略 —— 后端会推一些只给主进程/桌面用的事件
 * （如 `wechat-backend/status`、`remote-access/heartbeat`），渲染层不认识也不该乱转发。
 */
export const EVENT_MAP: ReadonlyArray<{ from: string, to: string, detail?: boolean }> = [
  // 解密数据有更新：WAL 实时刷新链的源头（会话列表、消息列表、群信息抽屉都订它）
  { from: 'wechat-data/updated', to: 'dsh-wechat-data-updated' },
  // 微信问答的**流式回答增量**：payload 是 { id, text }，text 是「已生成的全文」
  // （不是片段），渲染端整体替换即可。
  { from: 'wechat-ask/delta', to: 'dsh-wechat-ask-delta', detail: true },
  // 微信问答的**思考过程增量**（2026-10-16）：payload 是 { id, text }，text 是
  // 「已生成的思考全文」。与 delta 分开两条流 —— 模型可能先吐一大段 reasoning
  // 再吐正文，混在一条里前端就没法把「思考过程」单独折叠展示。
  { from: 'wechat-ask/reasoning', to: 'dsh-wechat-ask-reasoning', detail: true },
  // 微信问答的**阶段事件**（2026-10-16）：payload 是
  // { id, key, label, status: 'running'|'done'|'skipped', detail? }。
  // 界面据此显示「🔍 检索本机记录 · 召回 128 条」这样的过程行 ——
  // 没有它就只能等全部跑完再一次性平铺，没有「过程感」。
  { from: 'wechat-ask/stage', to: 'dsh-wechat-ask-stage', detail: true },
  // 长任务（导出 / 加密备份）进度：{ jobId, phase, done, total }。
  // 回调与 AbortSignal 都过不了传输层，所以进度只能这样推 —— 少中继这一条，
  // 界面上就只有一个「导出中…」的按钮在空转。
  { from: 'wechat-export/progress', to: 'dsh-wechat-export-progress', detail: true },
  // 逐条本地分析的进度（jobId 由 hook 生成，后端按它认领本批）
  { from: 'laya-analysis/progress', to: 'dsh-laya-analysis-progress', detail: true },
  // 搜索索引构建的进度（同样是回调过不了传输层，只能推事件再认领）
  { from: 'search-index/progress', to: 'dsh-search-index-progress', detail: true },
  // ClawBot 接入会话有新消息（幂等提示：detail 是 { lastId, delta }，不含正文）
  { from: 'clawbot/message', to: 'dsh-clawbot-message', detail: true },
  // ClawBot 绑定状态迁移（申请二维码 / 绑定成功 / 解绑）
  { from: 'clawbot/binding-changed', to: 'dsh-clawbot-binding-changed', detail: true },
  // 任务触发扫描新建了记录 / 投递了回调（2026-10-19 提速）：payload { created, dispatched }。
  // 面板靠它回源；没有这一条就只能等下一次微信同步事件（约 10s）才看到新记录。
  { from: 'task-center/updated', to: 'dsh-wechat-task-center-updated', detail: true },
]

/** 按名字查表（表很小，线性查即可；不做 Map 是为了让它保持可读的字面量）。 */
function entryFor(name: string): { from: string, to: string, detail?: boolean } | undefined {
  for (const e of EVENT_MAP) {
    if (e.from === name) return e
  }
  return undefined
}

/**
 * 把一个后端事件转发成 DOM CustomEvent。
 *
 * @param ev - 后端事件（形状不可信：`args` 可能缺失或不是数组）。
 * @param target - 派发目标，缺省 `window`（测试可注入假的）。
 * @returns 转发出去的 DOM 事件名；表里没有则返回 null（调用方据此判断「忽略了」）。
 */
export function dispatchWechatEvent(
  ev: BackendEvent | null | undefined,
  target: { dispatchEvent: (e: CustomEvent<unknown>) => boolean } = window,
): string | null {
  const name = typeof ev?.name === 'string' ? ev.name : ''
  const entry = entryFor(name)
  if (!entry) return null
  const args = Array.isArray(ev?.args) ? (ev as BackendEvent).args : undefined
  // detail 口径与抽出之前逐字一致：带 detail 的那几条取 args[0]，取不到给 null
  // （给 undefined 会让 `new CustomEvent(name, { detail: undefined })` 与「没有 detail」
  //  在监听侧无法区分，而既有面板是按 `?? null` 写的）。
  const detail = entry.detail ? (args?.[0] ?? null) : undefined
  target.dispatchEvent(
    entry.detail
      ? new CustomEvent(entry.to, { detail })
      : new CustomEvent(entry.to),
  )
  return entry.to
}
