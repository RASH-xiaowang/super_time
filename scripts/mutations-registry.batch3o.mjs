/**
 * 变异登记 · 会话列表推送即刷。
 *
 * 2026-10-13 起的 M514–M516（内联分析异步转写）已在 2026-11-18 随本地 ONNX 模型一并移除：
 * 那些判据的锚点是 `laya/analysis.ts` / `remotes/laya.ts`，文件已不存在。
 * 「转写必须走异步 spawn」这条纪律仍由 `voice-transcribe.ts` 与 whisper 相关 spec 守着。
 *
 * @module mutations-registry/batch3o
 */
export const MUTATIONS_BATCH3O = [
  {
    id: 'M517-sessions-push-immediate-refresh-lost',
    why: '会话列表的「推送即刷」接线被拆（合并窗参数不再透传）⇒ 又回到 300ms 合并窗 + 节流闸排队：updated 事件出来到侧栏重排多出几百毫秒（用户要求「updated 一出来就立刻刷」的口径回退）。判据：paged-list.spec.ts 的「刷新节流间隔可被面板覆盖」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/hooks.tsx',
    from: "'dsh-wechat-data-updated', refreshDebounceMs ?? 300,",
    to: "'dsh-wechat-data-updated', 300,",
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/paged-list.spec.ts',
  },
]
