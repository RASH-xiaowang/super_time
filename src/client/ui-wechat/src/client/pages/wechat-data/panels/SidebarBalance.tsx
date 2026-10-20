/**
 * 侧栏左下角的模型余额（2026-09-30，用户要求「余额实时显示在主界面的左下角，放在设置按钮的下方」）。
 *
 * ## 三条口径（都要写清楚，否则下一个人会以为它是白来的）
 *
 *  ① **数据来源**：主进程 `wechat:llm-balance` 按用户自己配置的地址与 Key 查一次。
 *     这是一条**新的出网点**（无人值守、按 5 分钟定时发生）—— 已写进 `docs/PRIVACY.md`
 *     与同意屏的「AI 问答与总结」那一条；只发 Key，不发任何聊天内容。
 *  ② **"实时"到底是多少**：挂载后查一次，之后每 {@link BALANCE_POLL_MS}（5 分钟）一次；
 *     点一下**立刻**刷新。余额是**分钟级**变化的数字，比这更密只是白烧请求。
 *     这里**不做**"按每次提问后刷新"——那会把出网点从定时变成跟使用频率挂钩。
 *  ③ **失败不吵**：查不到就把这一行降级成「余额 —」，原因只写在 `title` 里。
 *     余额是附加信息，不该在左下角常驻一条红色错误去挤掉「数据就绪」那条状态。
 *
 * 每次刷新都**重新读一次配置**（本地 IPC，毫秒级）：这样在设置里换了厂商 / 填了新 Key 之后，
 * 最迟下一次刷新就会跟着走，不必让两个组件共享状态。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGetLlmBalance, apiGetLlmConfig, formatBalance, type LlmBalance } from '../api.ts'
import css from './sidebar-balance.module.css'

/** 定时刷新的间隔（5 分钟）。 */
export const BALANCE_POLL_MS = 5 * 60 * 1000

/** 这一行的状态。 */
type BalanceState =
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | { kind: 'ok'; balance: LlmBalance }
  | { kind: 'error'; message: string }

export interface SidebarBalanceProps {
  /** 侧栏是否收起：收起时只留图标（与导航标签同款行为）。 */
  collapsed: boolean
  /**
   * 呈现变体（2026-10-17）：
   * · `sidebar`（缺省）—— 侧栏底部固定区里的整行按钮（左对齐、占满宽度）；
   * · `titlebar` —— 标题栏右上角的胶囊（与「数据就绪」同款视觉，图标 + 数字）。
   * 两者共用同一套取数与轮询逻辑，只是外观不同。
   */
  variant?: 'sidebar' | 'titlebar'
}

/**
 * 渲染余额行。
 * @param props - 侧栏收起态与呈现变体。
 * @returns 余额按钮；未配置模型时不渲染（返回 null）。
 */
export function SidebarBalance({ collapsed, variant = 'sidebar' }: SidebarBalanceProps): React.JSX.Element | null {
  const [state, setState] = useState<BalanceState>({ kind: 'loading' })
  /** 单飞：定时与点击叠在一起时只跑一次（两个并发请求对余额没有任何好处）。 */
  const busy = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (busy.current) return
    busy.current = true
    try {
      const cfg = await apiGetLlmConfig()
      const apiUrl = String(cfg?.apiUrl ?? '')
      const apiKey = String(cfg?.apiKey ?? '')
      if (!apiUrl || !apiKey) {
        setState({ kind: 'hidden' })
        return
      }
      setState((prev) => (prev.kind === 'ok' ? prev : { kind: 'loading' }))
      const balance = await apiGetLlmBalance({ apiUrl, apiKey })
      setState({ kind: 'ok', balance })
    } catch (e) {
      setState({ kind: 'error', message: (e as Error).message })
    } finally {
      busy.current = false
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, BALANCE_POLL_MS)
    return () => { clearInterval(timer) }
  }, [refresh])

  if (state.kind === 'hidden') return null

  const text = state.kind === 'loading' ? '余额 …'
    : state.kind === 'ok' ? formatBalance(state.balance)
      : '余额 —'
  const title = state.kind === 'ok'
    ? `模型余额 ${formatBalance(state.balance)}（${state.balance.currency || 'CNY'}）\n取回：${new Date(state.balance.fetchedAt).toLocaleString('zh-CN')}\n每 5 分钟自动刷新，点一下立即刷新`
    : state.kind === 'error'
      ? `余额查询失败：${state.message}\n每 5 分钟自动重试，点一下立即刷新`
      : '正在查询模型余额…\n每 5 分钟自动刷新，点一下立即刷新'

  return (
    <button
      type="button"
      className={css.row}
      data-status={state.kind}
      data-variant={variant}
      data-collapsed={collapsed || undefined}
      onClick={() => { void refresh() }}
      title={title}
      aria-label={`模型余额 ${text}`}
    >
      <svg className={css.icon} viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2.5" y="6" width="19" height="13" rx="2.5" />
        <path d="M2.5 10.5h19" />
        <circle cx="17" cy="14.5" r="1.2" fill="currentColor" stroke="none" />
      </svg>
      <span className={css.label}>{text}</span>
    </button>
  )
}
