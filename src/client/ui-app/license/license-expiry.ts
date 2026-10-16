/**
 * 许可证到期前的**剩余天数**口径（W3-11.7）。
 *
 * 为什么单独一个模块而不是写在面板里：这件事的判据全在「天数怎么算、什么时候该出声」上 ——
 * 写进 JSX 里就得靠渲染组件才能测，而本轮要的四条判据（含两条反向哨兵）都是纯数值判断。
 *
 * 三条边界是有意的：
 *   ① **只在快到期时出声**（0 < 剩余 < 30）。永久证（`expiresAt` 为空）永不提示 ——
 *      本应用允许永久证，给永久证弹「将到期」是纯噪音。
 *   ② **过期不计入「即将到期」**：那由 `state==='expired'` 那一档说（标题已经写了
 *      「许可证已过期」）。这里若也报一遍，用户会看到两处互相矛盾的过期提示。
 *   ③ 解析不了的日期按「未知」处理而不是当成 0 天 —— 把坏日期说成「今天到期」比不说更糟。
 */
export interface LicenseExpiry {
  /** 剩余整天数（向下取整；≥0）。 */
  daysLeft: number
  /** 给人看的一句话。 */
  text: string
}

/** 快到期前多少天开始出声。 */
export const LICENSE_EXPIRY_WARN_DAYS = 30

/**
 * @param expiresAt - 许可证到期时刻（ISO 串或时间戳；空 = 永久）。
 * @param now - 当前时刻（毫秒 epoch），由调用方给，便于测试不打瞌睡。
 * @returns 需要出声时的提示；不需要时为 null。
 */
export function licenseExpiryWarning(
  expiresAt: string | number | null | undefined,
  now: number = Date.now(),
): LicenseExpiry | null {
  if (expiresAt === null || expiresAt === undefined || expiresAt === '') return null
  const at = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt)
  if (!Number.isFinite(at)) return null
  const ms = at - now
  // 已过期：这一档归 `state==='expired'`，这里不出声（见上面 ②）。
  if (ms <= 0) return null
  const daysLeft = Math.floor(ms / 86_400_000)
  if (daysLeft >= LICENSE_EXPIRY_WARN_DAYS) return null
  const when = new Date(at).toLocaleDateString('zh-CN')
  return {
    daysLeft,
    text: daysLeft === 0
      ? `许可证今天到期（${when}）：到期后将无法进入主界面，请在这之前找签发方续签。`
      : `许可证还有 ${daysLeft} 天到期（${when}）：建议尽早续签，到期后需要重新导入新证。`,
  }
}

/**
 * 「被拒绝时说明缺哪个特性」的那一半（W3-11.7）。
 *
 * **当前实现只做一半，这里是诚实的说明而不是占位**：`LicenseStatus.payload.features`
 * 确实带厂商声明的特性清单，但本应用**没有任何按特性放行/拒绝的代码**
 * （全仓没有一处读 `payload.features` 做门禁）。所以「缺哪个特性」这个问题现在
 * 无处发生 —— 造一个不会发生的提示，比不造更糟。
 *
 * 厂商真要开始按特性授权时，这个函数就是它的落点：把「被拒的能力」与
 * `payload.features` 做差集，把结果给界面。
 * @param needed - 这次动作需要的能力（没有门禁时调用方传空数组）。
 * @param granted - 许可证已授予的能力。
 * @returns 缺失的能力；没有缺失时为空数组。
 */
export function missingLicenseFeatures(
  needed: readonly string[],
  granted: readonly string[] | undefined,
): string[] {
  const have = new Set(granted ?? [])
  return needed.filter((f) => !have.has(f))
}