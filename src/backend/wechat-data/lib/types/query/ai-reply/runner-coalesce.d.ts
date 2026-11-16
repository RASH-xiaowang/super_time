import type { ChatAiReplyScanDeps, ChatAiReplySegmentSnapshot, ChatAiReplyState } from './types.ts';
import { type ChatAiReplyRunRef } from './runner-state.ts';
/**
 * 同一轮连发的合并静默期：这么久没有新消息才认定对方这一轮说完了。
 */
export declare const CHAT_AI_REPLY_COALESCE_QUIET_MS = 900;
/** 被同轮更新消息取代时的统一说明（消息列表 error 列展示）。 */
export declare const STALE_REPLY_REASON = "\u4F1A\u8BDD\u5DF2\u6709\u66F4\u65B0\u7684\u6D88\u606F\uFF0C\u672C\u6B21 AI \u56DE\u590D\u5DF2\u8FC7\u671F\u53D6\u6D88\uFF1B\u4E0D\u4F1A\u81EA\u52A8\u8865\u53D1\u65E7\u95EE\u9898";
/**
 * 到达总等待上限时，若刚刚（≤ 600ms）还有新消息把锚点往后挪，说明这一轮
 * 连发仍未结束；允许再延长一次 1500ms，避免在刷屏中途抢先回复旧消息。
 * 只延长一次，所以持续刷屏的最长等待是 3.5s + 1.5s = 5.0s。
 */
export declare const COALESCE_BURST_WINDOW_MS = 600;
export declare const COALESCE_GRACE_MS = 1500;
/**
 * 生成前合并同一轮连发。
 *
 * 只在**全新锚点**上生效：恢复中的旧任务必须按原锚点收口，不能在这里改道。
 * 返回 'handled' 表示本次运行已经收口（不建记录、不调模型）；返回 'generate'
 * 表示可以继续预约与生成。
 */
export declare function coalesceChatAiReplyRun(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef, isCancelled: () => boolean, quietMs?: number): Promise<'generate' | 'handled'>;
/**
 * 预约**之前**的最后一次会话推进复核。
 *
 * 走到这里说明连发合并期已经结束；若这期间又来了新消息（或人工已经回了一句），
 * 就不该再建预约 —— 直接推进水位收口，下一拍按新的锚点处理。这样消息列表里
 * 不会出现一条先建出来、又立刻被标失败的记录。
 *
 * 返回 true 表示本轮已收口；读取失败时返回 false，交给预约后的复核兜底。
 */
export declare function cancelSupersededBeforeReservation(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef): Promise<boolean>;
/**
 * 收口被更新消息取代的预约。
 *
 * 能删就删（从未生成过正文），删不了才标失败并保留事实。返回 true 表示已经
 * 删除并 settle 成功，调用方应直接结束本轮；返回 false 表示已退回标失败路径。
 */
export declare function dropOrFailStaleReservation(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef, pendingSegments: readonly ChatAiReplySegmentSnapshot[], reason?: string): Promise<boolean>;
