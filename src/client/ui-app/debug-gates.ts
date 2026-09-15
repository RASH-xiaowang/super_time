/**
 * 首启闸门豁免的**渲染层判定**（N2）。
 *
 * 为什么判定要单独成模块而不是写在 `ui-entry.tsx` 里：打包态不得豁免是本项唯一的安全要求，
 * 它必须是**可被单测直接钉住**的纯逻辑。渲染层拿到的 `packaged` 是主进程给的**事实**
 * （`src/backend/debug-gates.js` 从 `app.isPackaged` 派生），这里做第二层要求：
 * 只有明确 `packaged === false` 才认豁免 —— 事实缺失、字段名拼错、主进程以后改了返回值形状，
 * 全部退回「照常走闸门」。失败方向必须是拦住，不是放行（与 `privacy/consent.ts` 同一口径）。
 */

/** 主进程 `app:debug-gates` 的返回形状（全部字段都可能是 undefined：新老主进程混跑时也不放行）。 */
export interface DebugGatesFact {
  /** 主进程给的 `app.isPackaged` —— 事实，不是渲染层的猜测。 */
  packaged?: boolean
  /** 主进程算好的「本次是否豁免首启闸门（引导 / 授权 / 隐私同意）」。 */
  skipGates?: boolean
}

/**
 * 是否豁免首启闸门。
 * @param fact - 主进程返回的闸门事实（IPC 返回值，形状不可信）。
 * @returns 仅当 `packaged === false` 且 `skipGates === true` 时为 true。
 */
export function shouldSkipGates(fact: unknown): boolean {
  const f = (fact ?? {}) as DebugGatesFact
  return f.packaged === false && f.skipGates === true
}
