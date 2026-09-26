/**
 * `mutations-registry.mjs` 的声明（只描述形状，数据仍在那份 JS 里）。
 *
 * 为什么要单独写这份：TS 侧（`tsconfig.tests.json` 没开 `allowJs`）无论是静态还是动态
 * 导入 `.mjs` 都会报 TS7016「找不到声明文件」，而守卫判据（`mutation-registry-anchors.spec.ts`）
 * 需要把这张表当数据读。声明与数据对不上时，那条判据里「六个字段都是非空字符串」的
 * 运行时断言会先报错 —— 所以这份声明写错不会让守卫静默变宽。
 */

/** 一条变异：把 `file` 里的 `from` 换成 `to`，`spec` 必须因此变红。 */
export type Mutation = {
  id: string
  why: string
  file: string
  from: string
  to: string
  spec: string
}

export const MUTATIONS: readonly Mutation[]
