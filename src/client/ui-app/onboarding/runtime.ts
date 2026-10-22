/**
 * 启动页共用的运行时事实与兜底常量。
 *
 * 为什么要单独一个文件：四个内容页与壳都要用这两个类型/常量，而它们在拆分之前
 * 住在 `OnboardingShell.tsx` 里 —— 页一旦拆成自己的模块，就会变成
 * 「壳 → 页 → 壳」的循环导入。这类循环在 ESM 里不一定炸，只会让某个常量在某个
 * 时刻取到 `undefined`（症状是「关于页的版本偶尔是空的」），所以先把公共面提出来。
 *
 * 2026-10-19 微信化改版：删掉了**固定舞台尺寸**（`STAGE_W/STAGE_H` 与等比缩放）
 * 与四张全屏背景图（`STAGE_BGS`）。舞台改成自适应单列（内容列 max-width 760、
 * 上下滚动），所以这两个常量不再有消费者 —— 留着它们只会让人以为还有另一套缩放。
 */

/**
 * 主进程 `app:versions` 下发的事实（形状见 `src/backend/ipc-misc.js`）。
 *
 * `app` 是 2026-10-12 补的：`version-consistency.spec.ts` 的头注释里一直记着
 * 「根治做法是让渲染层从主进程拿版本，但要改启动页渲染逻辑，而 `ui-app/**`
 * 不在类型检查内 —— 留到能验证时再动」。那一节现在不成立：启动页有
 * `scripts/onboarding-ssr.tsx` 这个渲染级冒烟可以验证，于是把欠账结掉。
 */
export interface RuntimeVersions {
  electron?: string
  chrome?: string
  node?: string
  app?: string
  platform?: string
  arch?: string
}

/**
 * 「应用版本」的**兜底**字面量。
 *
 * 唯一版本来源是 `package.json` 的 `version`；正常路径下界面显示的是主进程下发的
 * `versions.app`，这个常量只用于主进程还没回话 / SSR 时。守卫
 * （`src/backend/tests/version-consistency.spec.ts`）要求它**始终等于** package.json
 * 的版本 —— 那层保证兜底值不会静默漂移。
 */
export const APP_VERSION = '1.1.0'

/** 启动页阶段 = 4 个介绍页 + 两道闸门（隐私同意 → 授权验证）。 */
export const CONSENT_STAGE = 'consent' as const
/** 授权是最后一道闸门（商业闸门）。 */
export const LICENSE_STAGE = 'license' as const
/** 启动页的全部阶段：内容页 id + 两个闸门。 */
export type OnboardingStage = 'home' | 'features' | 'help' | 'about' | typeof CONSENT_STAGE | typeof LICENSE_STAGE
