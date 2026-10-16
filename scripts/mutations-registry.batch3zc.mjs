/**
 * 变异登记 · **@Remote 入参 schema 硬拒的试点**（2026-10-15，M588 起）。
 *
 * `wechat-args-guard.js` 的形状校验一直分两档：① 结构与体积总是硬拒；
 * ② 生成的 zod schema 默认只记账，只有 `ENFORCED_SCHEMA_METHODS` 里的方法才硬拒。
 * 这里从最简单的 `deleteTask({ id: number })` 开始试点。它的失效方式是「名单被删掉，
 * 坏参数继续进入 gateway」，没有报错，也不会影响现有面板的正常调用。
 *
 * @module mutations-registry/batch3zc
 */
export const MUTATIONS_BATCH3ZC = [
  {
    id: 'M588-delete-task-schema-enforcement-removed',
    why: '把 deleteTask 从 ENFORCED_SCHEMA_METHODS 摘掉 ⇒ ② 档退回只记账，字符串 id 与缺 id 都会继续进入 gateway，试点闸门静默失效。判据：wechat-args-guard.spec.ts 的真后端白名单用例。',
    file: 'src/backend/wechat-host.js',
    from: "  'deleteTask',\n",
    to: '',
    spec: 'src/backend/tests/wechat-args-guard.spec.ts',
  },
]
