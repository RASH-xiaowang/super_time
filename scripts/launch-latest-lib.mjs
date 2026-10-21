/**
 * 「启动最新版」的纯逻辑（不碰进程/文件系统之外的东西，供单测直接喂数据）。
 *
 * 与 `launch-latest.mjs` 分开的原因：启动器本体要 spawn npm/electron、杀旧进程，
 * 在单测里跑不动；而「要不要构建」「参数怎么解析」是纯函数，坏了会表现为
 * 「明明改了代码却是旧界面」——这类坏法必须能被用例钉住。
 */

/**
 * 解析启动器自己的开关（其余参数忽略）。
 * @param {string[]} argv - process.argv.slice(2)。
 * @returns {{ noLaunch: boolean, skipBuild: boolean, forceBuild: boolean, noKill: boolean, verbose: boolean }}
 */
export function parseLauncherArgs(argv) {
  const has = (flag) => (argv ?? []).includes(flag)
  return {
    noLaunch: has('--no-launch'),
    skipBuild: has('--skip-build'),
    forceBuild: has('--force-build'),
    noKill: has('--no-kill'),
    verbose: has('--verbose'),
  }
}

/**
 * 是否需要重新构建。
 *
 * 判据：产物缺失 / 强制 / 源码最新 mtime 比产物最旧 mtime 新。**默认不要跳过构建**——
 * 「源码比产物新却跳过」正是"启动的不是最新代码"的根因。
 * @param {{ sourceNewestMs?: number, productOldestMs?: number, force?: boolean, skip?: boolean }} input
 * @returns {{ build: boolean, reason: 'skip-build' | 'force' | 'missing-product' | 'source-newer' | 'up-to-date' }}
 */
export function needsBuild(input) {
  const sourceNewestMs = Number(input?.sourceNewestMs ?? 0)
  const productOldestMs = Number(input?.productOldestMs ?? 0)
  if (input?.skip) return { build: false, reason: 'skip-build' }
  if (input?.force) return { build: true, reason: 'force' }
  if (!(productOldestMs > 0)) return { build: true, reason: 'missing-product' }
  if (sourceNewestMs > productOldestMs) return { build: true, reason: 'source-newer' }
  return { build: false, reason: 'up-to-date' }
}

/**
 * 把构建原因翻成给人看的说明。
 * @param {{ build: boolean, reason: string }} plan - {@link needsBuild} 的返回值。
 * @returns {string}
 */
export function buildReasonText(plan) {
  switch (plan?.reason) {
    case 'skip-build': return '按参数跳过构建（--skip-build）'
    case 'force': return '按参数强制构建（--force-build）'
    case 'missing-product': return '构建产物缺失，先完整构建'
    case 'source-newer': return '源码比产物新，先完整构建'
    default: return '产物已是最新，跳过构建'
  }
}

/**
 * 启动横幅（让用户一眼看出这次跑的是哪个分支/提交，以及工作树是否有未提交改动）。
 * @param {{ branch?: string, sha?: string, dirty?: number, build?: string }} info
 * @returns {string}
 */
export function launchBanner(info) {
  const branch = String(info?.branch ?? '').trim() || '(detached)'
  const sha = String(info?.sha ?? '').trim() || 'unknown'
  const dirty = Number(info?.dirty ?? 0)
  const dirtyText = dirty > 0 ? `，未提交改动 ${dirty} 个（也会被构建进去）` : '，工作树干净'
  return `[Super Time] 最新版启动器：${branch} @ ${sha}${dirtyText}\n[Super Time] ${String(info?.build ?? '')}`
}
