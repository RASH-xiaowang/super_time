'use strict';

/**
 * 首启闸门的调试豁免（N2）。
 *
 * ## 为什么需要它
 *
 * 首启有三道闸门：启动引导（`ui-app/onboarding/OnboardingShell.tsx` 的「跳过」按钮要求
 * `licenseOk`）→ 授权（`LicenseGate` / `wechat:call` 的 `authorizeCall`）→ **隐私同意**
 * （`ui-app/privacy/PrivacyConsentGate.tsx`）。UI 自动化因此必须先签发一张真许可证，
 * 再往 localStorage 里伪造一份「已同意隐私声明」的记录才能进主界面 —— 前者要动签发私钥，
 * 后者等于绕过同意闸门本身。这里把「自动化要进主界面」收口成一个**显式、可审计**的开关，
 * 而不是散落在脚本里的伪造手段。
 *
 * ## 为什么判定必须留在主进程
 *
 * 环境变量**不是**信任边界：任何能改快捷方式、能写脚本、能 `set` 环境变量的人都能设它。
 * 唯一可靠的事实是 `app.isPackaged`（由 Electron 从「可执行文件是不是真的被打包」得出，
 * 环变量伪造不了）。因此：
 *   · 主进程读 `app.isPackaged`，把 `packaged` 与算好的 `skipGates` **一起**当事实回给渲染层；
 *   · 渲染层（`src/client/ui-app/debug-gates.ts`）再要求 `packaged === false` 才放行。
 * 两层要求同一件事：**打包态 + 环变量 ≠ 放行**。
 *
 * 豁免范围是「首启三道闸门」+「Remote 调用的许可证校验」—— 后者必须一起豁免，
 * 否则脚本进了主界面也会在每个业务调用上被拒（`wechat:call` 里 `authorizeCall` 挡着），
 * 也就是「无需真实许可证」这条验收落不了地。
 *
 * @module debug-gates
 */

/** 显式开关的环境变量名；值必须是 `'1'`（与 `SUPERTIME_TEST_MODE` 同一口径，不做真值宽松解析）。 */
const SKIP_GATES_ENV = 'SUPERTIME_SKIP_ONBOARDING';

/**
 * 解析调试闸门状态。
 *
 * @param {{ isPackaged?: unknown, env?: Record<string, string | undefined> }} [opts]
 *   `isPackaged` 必须是 Electron 的 `app.isPackaged`（唯一事实来源）；`env` 默认 `process.env`。
 * @returns {{ packaged: boolean, requested: boolean, skipGates: boolean }}
 *   · `packaged` —— `isPackaged === true` 的规范化结果（渲染层要看它，所以要显式给）；
 *   · `requested` —— 环变量是否显式要求（写日志用，不参与放行判定）；
 *   · `skipGates` —— 仅在「显式要求」**且**「明确处于非打包态」时为真。
 *     `isPackaged` 缺失或不是布尔（调用方写错）时**一律不放行** —— 失败方向必须是
 *     「照常走闸门」，不是「默认豁免」。
 */
function resolveDebugGates(opts) {
  const isPackaged = opts && opts.isPackaged;
  const env = (opts && opts.env) || {};
  const packaged = isPackaged === true;
  const requested = String(env[SKIP_GATES_ENV] ?? '') === '1';
  return { packaged, requested, skipGates: requested && isPackaged === false };
}

/**
 * 「永不回包」故障注入的环境变量名（H7 验收专用）。
 *
 * 值：逗号分隔的 Remote 方法名；命中的调用**只被 worker 记一条日志、不回任何应答**，
 * 于是主进程的超时预算把它收敛成一条可读错误 —— 用来端到端验证「后端卡死时
 * UI 会解除 loading 并提示」，而不是只能靠单测覆盖主进程那一半。
 */
const HANG_ENV = 'SUPERTIME_DEBUG_HANG_METHODS';

/**
 * 解析需要注入「永不回包」的方法名。
 *
 * 与 `resolveDebugGates` 同一套信任模型：**打包态一律忽略**（`isPackaged` 不是 `false` 就返回空表）。
 * 主进程在 fork worker 时按这里的结果显式改写子进程环境 —— 打包态下连环境变量都不会传给 worker，
 * 所以「打包版被 env 卡死」不成立。
 *
 * @param {{ isPackaged?: unknown, env?: Record<string, string | undefined> }} [opts]
 * @returns {string[]} 规范化后的方法名列表（去空白、去空项）；空数组 = 不注入。
 */
function resolveHangMethods(opts) {
  const isPackaged = opts && opts.isPackaged;
  const env = (opts && opts.env) || {};
  if (isPackaged !== false) return [];
  return String(env[HANG_ENV] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

module.exports = { SKIP_GATES_ENV, HANG_ENV, resolveDebugGates, resolveHangMethods };
