/**
 * ClawBot 实例轨（C2，2026-10-13）：「切哪个号」的唯一入口。
 *
 * 一个微信号一行：状态点 + 名称 + 今日计数；当前实例高亮边 + 「当前」标。
 * 头部 = 当前实例的绑定态 pill（四态 / 检测中… / 状态未知）—— 上一稿 B2 把 pill 放在指挥条
 * 修 P7（绑定态在会话视图隐身），本稿把它移到离实例更近的轨头部：多实例下「哪个号是什么态」
 * 逐行可见，pill 只负责**当前**那个号。
 *
 * ## 三条纪律
 *
 * - **当前实例必须看得见**：轨列的是全部实例，而面板其余部分只作用于当前实例 —— 当前行不打标，
 *   用户会以为改的是列表第一条（继承自实例卡的诚实纪律）；
 * - **读失败不许显示成空轨**：`readError` 非空时只显示失败原因（`loadError` 是调用失败，分开说）；
 * - **破坏性操作不在轨上**：移除实例收在「实例设置」的危险区（C3）；轨上只有导航、新增与绑定入口。
 *
 * 形态（容器查询按面板自身宽度）：N ≤800 横向实例条 / W 168px 左栏 / XW 208px 左栏。
 *
 * @module panels/clawbot-rail
 */
import { useState } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClawbotBindQr, ClawbotBindingSnapshot, ClawbotInstance } from '@deepseek-ai/dsh-wechat-data/types'
import { apiCreateClawbotBindQr, apiCreateClawbotInstance } from '../api.ts'
import { desktopActionProps } from '../ui/desktop-only.tsx'
import { useTransientNotice } from './hooks.tsx'
import { CLAWBOT_STATUS_LABEL, statusClass, statusDot } from './clawbot-status.ts'
import { ClawbotBindModal } from './clawbot-bind-modal.tsx'
import css from './clawbot.module.css'

/**
 * 当前实例绑定态 pill 的诚实级排序（从 ClawBotPanel 下沉到本模块，2026-10-13 C2）。
 *
 * 快照没拿到（调用失败 →「状态未知」；首屏未回 →「检测中…」）、快照自带 readError
 * （库打不开 ≠ 未绑定 →「状态未知」）时，都不许拿 binding 的四态冒充事实；
 * 只有快照可信才显示四态。四态映射与配色复用 `clawbot-status.ts`（单一事实源）。
 * @param snapshot - 当前实例的绑定卡片快照（null = 没拿到）。
 * @param readError - 快照自带的读失败原因。
 * @param loadError - 调用本身的失败原因。
 * @returns pill 的文案 / StateDot 态 / 配色类。
 */
export function clawbotPillOf(snapshot: ClawbotBindingSnapshot | null, readError: string, loadError: string): {
  text: string
  dot: Parameters<typeof StateDot>[0]['state']
  tone: string | undefined
} {
  const status = snapshot?.binding.status ?? 'unbound'
  const unreadable = snapshot === null || readError !== ''
  const firstPaint = snapshot === null && loadError === ''
  return {
    text: unreadable ? (firstPaint ? '检测中…' : '状态未知') : CLAWBOT_STATUS_LABEL[status],
    dot: unreadable ? (firstPaint ? 'ongoing' : 'warning') : statusDot(status),
    tone: unreadable ? css.stUnknown : statusClass(status),
  }
}

/** 行标签：昵称优先，其次「实例 N」；wxid 只进 title（原始 wxid 当标签是 P8 的症状）。 */
function railLabel(it: ClawbotInstance): string {
  return it.userName ?? `实例 ${it.slot}`
}

export function ClawbotRail({ instances, slot, snapshot, readError, loadError, onPick, onChanged }: {
  /** 全部实例（按 slot 升序）。 */
  instances: readonly ClawbotInstance[]
  /** 当前正在操作的实例编号（null = 一个都没有）。 */
  slot: number | null
  /** 当前实例的绑定卡片快照（pill 用）。 */
  snapshot: ClawbotBindingSnapshot | null
  readError: string
  loadError: string
  /** 点行切换当前实例（外层按 slot 重取快照与会话）。 */
  onPick: (slot: number) => void
  /** 实例增删/绑定会改变绑定卡与自检 ⇒ 通知外层刷新。 */
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const notice = useTransientNotice()
  const [busy, setBusy] = useState(0)
  const [bindQr, setBindQr] = useState<{ qr: ClawbotBindQr, slot: number } | null>(null)
  const pill = clawbotPillOf(snapshot, readError, loadError)

  const addInstance = async (): Promise<void> => {
    try {
      const r = await apiCreateClawbotInstance()
      notice.flash(`✓ 已新增实例 ${r.slot}（接着点它的「绑定此号」扫码）`)
      await onChanged()
    } catch (e) {
      notice.flash('✗ 新增失败：' + (e as Error).message)
    }
  }

  const startBind = async (target: number): Promise<void> => {
    setBusy(target)
    try {
      const qr = await apiCreateClawbotBindQr({ slot: target })
      setBindQr({ qr, slot: target })
    } catch (e) {
      notice.flash('✗ ' + (e as Error).message)
    } finally {
      setBusy(0)
    }
  }

  return (
    <nav className={css.rail} aria-label="微信实例">
      <span className={css.statusPill} title={readError !== '' ? readError : undefined}>
        <StateDot state={pill.dot} />
        <span className={pill.tone}>{pill.text}</span>
      </span>

      {loadError !== '' && <div className={css.instReadError} role="alert">实例列表读取失败：{loadError}</div>}
      {loadError === '' && readError !== '' && (
        <div className={css.instReadError} role="alert">
          实例列表读取失败：{readError}
          <div className={css.muted}>这与「一个实例都没有」不是一回事 —— 库打不开时这里不会显示空轨。</div>
        </div>
      )}

      {loadError === '' && readError === '' && (
        <div className={css.railList}>
          {instances.map((it) => {
            const unbound = it.status === 'unbound' || it.status === 'unbound-by-user'
            return (
              <div
                key={it.slot}
                className={css.railRow}
                data-current={it.slot === slot ? '' : undefined}
                title={it.wxid ?? undefined}
              >
                <div
                  role="button"
                  tabIndex={0}
                  className={css.railRowHead}
                  onClick={() => { onPick(it.slot) }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(it.slot) }
                  }}
                >
                  <StateDot state={statusDot(it.status)} />
                  <span className={css.railName}>{railLabel(it)}</span>
                  {it.slot === slot && <span className={css.instCurrent}>当前</span>}
                </div>
                <div className={css.railRowHead}>
                  <span className={css.railMeta}>今日 {it.todayMessages} · {CLAWBOT_STATUS_LABEL[it.status]}</span>
                  {unbound && (
                    <Button
                      size="sm"
                      variant="outline"
                      className={css.railBind}
                      disabled={busy === it.slot} {...desktopActionProps()}
                      onClick={() => { void startBind(it.slot) }}
                    >
                      {it.status === 'unbound' ? '绑定此号' : '重新绑定'}
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <button type="button" className={css.railAdd} onClick={() => { void addInstance() }} {...desktopActionProps()}>+ 新增实例</button>

      {bindQr !== null && (
        <ClawbotBindModal
          qr={bindQr.qr}
          slot={bindQr.slot}
          onConfirmed={(b) => {
            const bound = bindQr.slot
            setBindQr(null)
            notice.flash(`✓ 实例 ${bound} 已绑定 ${b.binding.wxid ?? ''}（在微信里给它发条消息试试）`)
            void onChanged()
          }}
          onClose={() => { setBindQr(null) }}
        />
      )}
    </nav>
  )
}
