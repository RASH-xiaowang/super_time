/**
 * `scripts/ci-tiers.mjs` 的类型声明（只在编译期有意义，跑起来还是那份 .mjs）。
 *
 * 为什么需要：同 `mutation-scope.d.mts` —— `tsconfig.tests.json` 没开 `allowJs`，
 * spec 用 TypeScript 直接 import 一个 `.mjs` 会报 TS7016。
 */

export type TierRow = {
  /** `package.json` 里的 script 名。 */
  script: string
  /** 本机实测耗时（或「需打包产物」这类前置条件）。 */
  cost: string
  /** 为什么是这一档 —— 这条比「跑不跑」更值得记，半年后能看懂的是它。 */
  why: string
}

export type KnownRotRow = {
  script: string
  /** 症状（原样，不是「失败」两个字）。 */
  symptom: string
  /** 根因。下一个人不该重新查一遍。 */
  rootCause: string
}

export type LocalOnlyRow = {
  script: string
  why: string
}

/** 第一档：每次 push/PR。 */
export const TIER1: ReadonlyArray<TierRow>
/** 第二档：夜间。 */
export const TIER2: ReadonlyArray<TierRow>
/** 第三档：发版前，需先 `npm run pack`。 */
export const TIER3: ReadonlyArray<TierRow>
/** 明知道坏、故意不接进任何一档的。 */
export const KNOWN_ROT: ReadonlyArray<KnownRotRow>
/** 只在本机跑、故意不接进 workflow 的（`ci-script-isolation` 判据）。 */
export const LOCAL_ONLY: ReadonlyArray<LocalOnlyRow>
/** 成本数字的实测日期（别让它悄悄过期）。 */
export const MEASURED_ON: string
