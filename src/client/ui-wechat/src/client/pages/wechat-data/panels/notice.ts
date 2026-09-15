/**
 * 「主动提醒」的判定逻辑（纯函数，不碰 DOM / IPC，可确定性测试）。
 *
 * 为什么要有这一层：更新与授权到期的信息此前**只存在于「设置」弹窗里** —— 软件更新卡上
 * 的 phase、软件授权卡上的 daysToExpiry。用户不主动点进设置就完全感知不到：新版本是后台
 * 静默下载、退出应用时顺手装好；许可证则是**到期当天由解锁页硬拦**，此前一句提示都没有。
 * 这里把「什么时候该主动说一句、说到什么程度」抽成纯函数，渲染与 IPC 接线在 NoticeBanner.tsx。
 *
 * 阈值口径（定在本模块，别再散落到组件里）：
 *   · 更新：只在**已下载**（可立刻重启装）与**正在下载**时提醒。`available` 不单列一档 ——
 *     `autoDownload` 恒为 true，它到 `downloading` 几乎不隔时间，单列只会让横幅闪一下。
 *     静默装好是既定行为，但「已经下好了」值得说出来，否则用户永远不知道重启能升级。
 *   · 授权：永久证（`daysToExpiry` 为 null）不提醒；≤30 天浅提醒，≤7 天或已过期转强提醒。
 *     到期后仍继续运行时不静默 —— 那一轮只有重启才会被拦，提前说一声才有意义。
 */

export type NoticeTone = 'info' | 'warn' | 'danger'

/** 可执行的动作；文案在组件层（`ACTION_LABEL`），这里只给语义。 */
export type NoticeAction = 'install' | 'export-request' | 'open-license'

export interface Notice {
  /** 稳定键：React key + 「本次会话不再提示」的去重依据。 */
  id: string
  tone: NoticeTone
  title: string
  detail: string
  actions: readonly NoticeAction[]
}

/** 主进程 `update:state` 里本模块用得到的字段（全量形状见 src/backend/update.js）。 */
export interface UpdateFacts {
  phase: string
  version?: string | null
  progress?: { percent: number } | null
}

/** `license:status` 里本模块用得到的字段（全量形状见 src/license/service.js）。 */
export interface LicenseFacts {
  licensed?: boolean
  state?: string
  daysToExpiry?: number | null
}

/** 提前多少天开始提醒续期。 */
export const LICENSE_WARN_DAYS = 30
/** 提前多少天把提醒升级为强提醒。 */
export const LICENSE_URGENT_DAYS = 7

/**
 * 新版本提示。
 * @param st 更新状态（拿不到时传 null）。
 * @returns 该显示的提醒；不该显示时 null。
 */
export function noticeForUpdate(st: UpdateFacts | null): Notice | null {
  if (!st) return null
  const v = st.version ? `v${st.version}` : '新版本'
  if (st.phase === 'downloaded') {
    return {
      id: `update:downloaded:${st.version ?? '?'}`,
      tone: 'warn',
      title: `${v} 已下载，重启即可生效`,
      detail: '退出应用时会自动安装；也可以现在就重启完成升级。',
      actions: ['install'],
    }
  }
  if (st.phase === 'downloading') {
    const pct = Math.round(st.progress?.percent ?? 0)
    return {
      id: `update:downloading:${st.version ?? '?'}`,
      tone: 'info',
      title: `正在后台下载${st.version ? ` ${v}` : '新版本'}`,
      detail: `已下载 ${pct}% · 完成后退出应用会自动安装，不必等在这里。`,
      actions: [],
    }
  }
  return null
}

/**
 * 许可证临期提示。
 * @param st 授权状态（拿不到时传 null）。
 * @returns 该显示的提醒；不该显示时 null。
 */
export function noticeForLicense(st: LicenseFacts | null): Notice | null {
  // 未授权根本进不了主界面（LicenseGate 会拦），这里只处理已授权后的临期与过期
  if (!st || st.licensed === false) return null
  const d = st.daysToExpiry
  if (typeof d !== 'number') return null
  if (d < 0 || st.state === 'expired') {
    return {
      id: 'license:expired',
      tone: 'danger',
      title: '许可证已到期',
      detail: '当前会话仍可用，但重启后将无法进入主界面。请尽快导出激活请求交给签发方换发。',
      actions: ['export-request', 'open-license'],
    }
  }
  if (d <= LICENSE_URGENT_DAYS) {
    return {
      id: `license:urgent:${d}`,
      tone: 'danger',
      title: `许可证只剩 ${d} 天`,
      detail: '到期后重启将无法进入主界面（本应用没有宽限期）。请立即导出激活请求交给签发方。',
      actions: ['export-request', 'open-license'],
    }
  }
  if (d <= LICENSE_WARN_DAYS) {
    return {
      id: `license:warn:${d}`,
      tone: 'warn',
      title: `许可证将在 ${d} 天后到期`,
      detail: '可以现在导出激活请求交给签发方，避免到期时中断使用。',
      actions: ['export-request', 'open-license'],
    }
  }
  return null
}

/**
 * 汇总当前该显示的提醒：更新在前、授权在后（更新的动作更即时）。
 * @param facts 两份状态。
 * @param dismissed 本次会话已关闭的提醒 id。
 * @returns 过滤后的提醒列表（可能为空）。
 */
export function buildNotices(
  facts: { update?: UpdateFacts | null; license?: LicenseFacts | null },
  dismissed: ReadonlySet<string> = new Set<string>(),
): Notice[] {
  const all = [noticeForUpdate(facts.update ?? null), noticeForLicense(facts.license ?? null)]
  return all.filter((n): n is Notice => n !== null && !dismissed.has(n.id))
}
