/** 纯逻辑的类型声明（脚本本体是 .mjs；单测直接 import 这个模块）。 */
export interface LauncherArgs {
  noLaunch: boolean
  skipBuild: boolean
  forceBuild: boolean
  noKill: boolean
  verbose: boolean
}
export interface BuildInput {
  sourceNewestMs?: number
  productOldestMs?: number
  force?: boolean
  skip?: boolean
}
export type BuildReason = 'skip-build' | 'force' | 'missing-product' | 'source-newer' | 'up-to-date'
export interface BuildPlan {
  build: boolean
  reason: BuildReason
}
export declare function parseLauncherArgs(argv: readonly string[]): LauncherArgs
export declare function needsBuild(input: BuildInput): BuildPlan
export declare function buildReasonText(plan: BuildPlan): string
export declare function launchBanner(info: { branch?: string, sha?: string, dirty?: number, build?: string }): string
