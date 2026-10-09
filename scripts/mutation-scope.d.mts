/**
 * `scripts/mutation-scope.mjs` 的类型声明（只在编译期有意义，跑起来还是那份 .mjs）。
 *
 * 为什么需要：`tsconfig.tests.json` 没开 `allowJs`，而 spec 是 TypeScript，
 * 直接 import 一个 `.mjs` 会报 TS7016「找不到声明文件」。`mutations-registry.d.mts`
 * 是同一个原因下的既有做法，这里照它办理。
 *
 * ⚠️ 只声明**签名**，不声明字段：`Mutation` 只用到了 `id`/`file`/`spec` 三个，
 * 多写字段反而会在登记表长字段时逼着这里跟着改。
 */

export type ScopedMutation = { id: string; file: string; spec: string }

export type DiffSelection = {
  /** 本次要跑的变异；`all` 为 true 时是全表。 */
  picked: ReadonlyArray<ScopedMutation>
  /** 为 true 表示「不要筛，全跑」——登记表被动、或筛选失败。 */
  all: boolean
  /** 人读的判据说明，会打进报告与 Actions 输出。 */
  reason: string
  byTarget: number
  bySpec: number
}

export type ChangedFiles = {
  files: string[]
  /** 为 false 时调用方**必须**退化成全量，不能静默跳过。 */
  ok: boolean
  detail: string
}

/** 按改动文件挑变异；口径见模块文件头。 */
export function selectForDiff(
  mutations: ReadonlyArray<ScopedMutation>,
  changedFiles: ReadonlyArray<string>,
): DiffSelection

/** 取 `ref...HEAD` 之间改动的文件。 */
export function changedFilesSince(ref: string, cwd: string): ChangedFiles

/** 登记表本体的路径匹配（改动它 ⇒ 全量）。 */
export const REGISTRY_PATH_RE: RegExp
