/**
 * 扫码绑定弹窗（M-A 的核心交互；iLink 接入后版本，2026-10-12）。
 *
 * ## 交互与数据流
 *
 * 打开即画二维码（`clawbot-qr.ts` 自绘，逐位对齐独立实现的黄金向量）；弹窗打开期间
 * 按 ~1.2s 间隔反复调 `apiGetClawbotBindState` —— **一次调用 = 后端中继一次上游长轮询**
 * （最长约 40 秒，服务端没等到变化就挂起），因此节奏是「长请求 + 短间隔」而不是高频打点。
 * 关掉弹窗 = 停止调用：后端不留无人消费的轮询循环。
 *
 * 四态展示与设计稿一致：待扫码 → 已扫待确认 → 已绑定（自动收尾）；过期 / 会话失效
 * （`idle`，如 worker 重启）都落到「已过期，可重新生成」。倒计时只是**名义显示**
 * （5 分钟），真实过期以服务端状态为准 —— 到 0 时提示「建议重新生成」，但继续轮询，
 * 万一用户刚好扫上仍会被确认。
 *
 * ## 收尾
 *
 * `confirmed` ⇒ 调 `onConfirmed(最新快照)`（外层刷新卡片 + 提示 + 关弹窗）；
 * 其余关闭（取消 / 点遮罩 / Esc）⇒ `onClose()`，不写任何状态（后端的 `binding` 态
 * 由「重新生成 / 再取码覆盖」处理，不在这里造「取消绑定」的假语义）。
 *
 * @module panels/clawbot-bind-modal
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClawbotBindQr, ClawbotBindingSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { apiCreateClawbotBindQr, apiGetClawbotBindState } from '../api.ts'
import { Dialog } from '../ui/kit.tsx'
import { encodeQr, qrSvgPath } from './clawbot-qr.ts'
import css from './clawbot.module.css'

/** 两次状态中继之间的短间隔（长轮询已在途，这里只是给界面留一拍）。 */
const POLL_GAP_MS = 1_200

/** 四态 → 步骤条高亮序号（-1 = 无高亮，如已过期）。 */
function stepOf(state: ClawbotBindQr['state']): number {
  if (state === 'wait') return 0
  if (state === 'scaned') return 1
  if (state === 'confirmed') return 2
  return -1
}

/** 剩余毫秒 → mm:ss（超过 99 分钟按 99:59 封顶，展示用）。 */
function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.min(99, Math.floor(total / 60))
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function ClawbotBindModal({ qr, slot, onConfirmed, onClose }: {
  /** 打开时的二维码（取码由外层完成；「重新生成」在本弹窗内换新）。 */
  qr: ClawbotBindQr
  /**
   * 为哪个实例取码 / 轮询（多实例，2026-10-13）。
   * 缺省（不传）= 后端按「第一个已绑定实例，其次第一个实例」解析 —— 单实例时代的行为。
   */
  slot?: number
  /** 扫码确认后：外层刷新 + 提示 + 关弹窗。 */
  onConfirmed: (binding: ClawbotBindingSnapshot) => void
  /** 取消 / Esc / 点遮罩关闭。 */
  onClose: () => void
}): React.JSX.Element {
  const [local, setLocal] = useState<ClawbotBindQr>(qr)
  const [state, setState] = useState<ClawbotBindQr['state']>(qr.state)
  const [remaining, setRemaining] = useState(() => Math.max(0, qr.expiresAt - Date.now()))
  const [regenBusy, setRegenBusy] = useState(false)
  const [regenError, setRegenError] = useState('')

  // 回调走 ref：身份每次渲染都变（外层内联箭头），进依赖会让轮询反复重启。
  const confirmedRef = useRef(onConfirmed)
  useEffect(() => { confirmedRef.current = onConfirmed })

  // 二维码自绘（失败不抛——展示成因并让用户「重新生成」）。
  const encoded = useMemo(() => {
    try {
      return { ok: true as const, path: qrSvgPath(encodeQr(local.payload)) }
    } catch (e) {
      return { ok: false as const, message: e instanceof Error ? e.message : String(e) }
    }
  }, [local.payload])

  // 倒计时（名义 5 分钟；真实过期以轮询结果为准）。
  useEffect(() => {
    if (state === 'confirmed' || state === 'expired') return
    const t = window.setInterval(() => { setRemaining(Math.max(0, local.expiresAt - Date.now())) }, 1000)
    return () => { window.clearInterval(t) }
  }, [local.expiresAt, state])

  // 状态轮询：终态即停；单次调用失败（worker 忙 / 重启）下一拍重试，不打扰用户。
  useEffect(() => {
    if (state === 'confirmed' || state === 'expired') return
    let alive = true
    let timer: number | undefined
    const tick = async (): Promise<void> => {
      let next: Awaited<ReturnType<typeof apiGetClawbotBindState>> | null = null
      try { next = await apiGetClawbotBindState(slot === undefined ? undefined : { slot }) } catch { /* 下一拍重试 */ }
      if (!alive) return
      const st = next?.state
      if (st === 'confirmed' && next) {
        setState('confirmed')
        confirmedRef.current(next.binding)
        return
      }
      if (st === 'expired' || st === 'idle') {
        // idle = 后端已没有进行中的会话（重启丢会话等）：按过期展示，可一键重生成。
        setState('expired')
        return
      }
      if (st === 'scaned' || st === 'wait') setState(st)
      timer = window.setTimeout(() => { void tick() }, POLL_GAP_MS)
    }
    void tick()
    return () => { alive = false; if (timer !== undefined) window.clearTimeout(timer) }
  }, [local.token, state])

  const regen = async (): Promise<void> => {
    setRegenBusy(true)
    setRegenError('')
    try {
      const next = await apiCreateClawbotBindQr(slot === undefined ? undefined : { slot })
      setLocal(next)
      setState('wait')
    } catch (e) {
      setRegenError('重新生成失败：' + (e as Error).message)
    } finally {
      setRegenBusy(false)
    }
  }

  const step = stepOf(state)
  const shownState = state === 'expired'
    ? '已过期，点「重新生成」再扫一次'
    : remaining === 0
      ? '显示已超过 5 分钟，建议重新生成'
      : `二维码有效期剩余 ${mmss(remaining)}`

  return (
    <Dialog open onClose={onClose} title="扫码绑定微信" className={css.qrDialog}>
      <p className={css.qrSub}>请用手机微信扫描二维码并确认；绑定后即可在微信里指挥 Super Time。</p>

      {state === 'confirmed'
        ? <div className={css.qrDone} role="status">✓ 已绑定</div>
        : (
          <>
            {encoded.ok
              ? (
                <div className={css.qrPaper}>
                  <svg viewBox={encoded.path.viewBox} className={css.qrSvg} role="img" aria-label="微信绑定二维码">
                    <path d={encoded.path.d} />
                  </svg>
                </div>
              )
              : <div className={css.noticeErr} role="alert">二维码生成失败：{encoded.message}</div>}

            <div className={css.qrTimer} data-state={state}>{shownState}</div>

            <div className={css.qrSteps} aria-label="绑定进度">
              {['待扫码', '已扫，待确认', '已绑定'].map((label, i) => (
                <span key={label} className={i === step ? `${css.qrStep} ${css.qrStepOn}` : css.qrStep}>{label}</span>
              ))}
            </div>

            {regenError !== '' && <div className={css.noticeErr} role="alert">✗ {regenError}</div>}

            <div className={css.qrActions}>
              <Button size="sm" variant="outline" onClick={onClose}>取消</Button>
              <Button size="sm" variant="primary" disabled={regenBusy} onClick={() => { void regen() }}>重新生成</Button>
            </div>

            <div className={css.qrHint}>
              绑定由腾讯服务完成：Super Time 会请求一次二维码并轮询扫码状态；绑定后消息双向中转 ——
              收消息自动进行，发送只在你于「接入会话」里点「发送」时发生（只发你写的那条正文）。
            </div>
          </>
        )}
    </Dialog>
  )
}
