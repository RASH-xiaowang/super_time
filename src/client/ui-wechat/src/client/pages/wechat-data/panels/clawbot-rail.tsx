/**
 * ClawBot 实例轨（C2，2026-10-13；行内重命名 2026-10-16）：「切哪个号」的唯一入口。
 *
 * 一个微信号一行：状态点 + 名称 + 今日计数；当前实例高亮边 + 「当前」标。
 * 头部 = 当前实例的绑定态 pill（四态 / 检测中… / 状态未知）—— 上一稿 B2 把 pill 放在指挥条
 * 修 P7（绑定态在会话视图隐身），本稿把它移到离实例更近的轨头部：多实例下「哪个号是什么态」
 * 逐行可见，pill 只负责**当前**那个号。
 *
 * ## 四条纪律
 *
 * - **当前实例必须看得见**：轨列的是全部实例，而面板其余部分只作用于当前实例 —— 当前行不打标，
 *   用户会以为改的是列表第一条（继承自实例卡的诚实纪律）；
 * - **读失败不许显示成空轨**：`readError` 非空时只显示失败原因（`loadError` 是调用失败，分开说）；
 * - **破坏性操作不在轨上**：移除实例收在「实例设置」的危险区（C3）；轨上只有导航、新增、绑定与重命名；
 * - **重命名是就地编辑，不是弹窗**（2026-10-16）：改名是高频轻操作，弹窗要「打开 → 输入 → 确认」
 *   三步；行内编辑只要「双击 → 输入 → 回车」。Esc 取消、失焦保存（与文件管理器同款肌肉记忆）。
 *
 * 形态（容器查询按面板自身宽度）：N ≤800 横向实例条 / W 168px 左栏 / XW 208px 左栏。
 *
 * @module panels/clawbot-rail
 */
import { useEffect, useRef, useState } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClawbotBindQr, ClawbotBindingSnapshot, ClawbotInstance } from '@deepseek-ai/dsh-wechat-data/types'
import { apiCreateClawbotBindQr, apiCreateClawbotInstance, apiRenameClawbotInstance } from '../api.ts'
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

/**
 * 行标签：**别名优先**，其次昵称，最后「实例 N」；wxid 只进 title。
 *
 * 别名排最前是刻意的（2026-10-16）：用户起别名就是为了「一眼认出哪个号」，
 * 若昵称还压在上面，改名这件事在界面上等于没发生。
 * @param it - 实例行。
 * @returns 展示用标签。
 */
function railLabel(it: ClawbotInstance): string {
  return it.label ?? it.userName ?? `实例 ${it.slot}`
}

/**
 * token 数量的紧凑显示（1.2k / 3.4M）：左栏只有 168~208px，完整数字会把状态行挤爆。
 * @param n - token 数。
 * @returns 展示文本（0 原样显示 0）。
 */
function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(Math.round(n))
}

/**
 * 行内重命名输入框（模块级：让 `ClawbotRail` 留在 function-size-ratchet 的 250 行线内）。
 *
 * 三个交互细节都是刻意的：
 * - **挂载即全选**：改名多半是「整个换掉」，全选后直接打字即可（不用先按 Ctrl+A）；
 * - **Esc 取消**：`onKeyDown` 里先 `stopPropagation` —— 否则 Esc 会冒泡到面板的关闭逻辑；
 * - **失焦保存**：与文件管理器同款。但**保存中不许重复提交**（`saving` 位），
 *   否则「回车保存 → 失焦」会打两次 RPC。
 * @param props.value - 初始值（当前别名，空串 = 没起过）。
 * @param props.placeholder - 占位（提示会回落到什么名字）。
 * @param props.onCommit - 提交新别名（空串 = 清除）。
 * @param props.onCancel - 取消编辑。
 */
function RailRenameInput({ value, placeholder, onCommit, onCancel }: {
  value: string
  placeholder: string
  onCommit: (next: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [text, setText] = useState(value)
  const ref = useRef<HTMLInputElement | null>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const commit = (): void => {
    if (done.current) return
    done.current = true
    onCommit(text)
  }
  return (
    <input
      ref={ref}
      className={css.railRename}
      value={text}
      placeholder={placeholder}
      maxLength={40}
      aria-label="实例别名"
      onChange={(e) => { setText(e.target.value) }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit() }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done.current = true; onCancel() }
      }}
      onClick={(e) => { e.stopPropagation() }}
      onDoubleClick={(e) => { e.stopPropagation() }}
    />
  )
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
  /** 实例增删/绑定/改名会改变绑定卡与自检 ⇒ 通知外层刷新。 */
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const notice = useTransientNotice()
  const [busy, setBusy] = useState(0)
  const [bindQr, setBindQr] = useState<{ qr: ClawbotBindQr, slot: number } | null>(null)
  /** 正在改名的实例编号（null = 没有在编辑）。 */
  const [editing, setEditing] = useState<number | null>(null)
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

  const rename = async (target: number, next: string): Promise<void> => {
    setEditing(null)
    try {
      await apiRenameClawbotInstance({ slot: target, label: next })
      notice.flash(next.trim() === '' ? '✓ 已清除别名' : `✓ 已改名为「${next.trim()}」`)
      await onChanged()
    } catch (e) {
      notice.flash('✗ 改名失败：' + (e as Error).message)
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
            const current = it.slot === slot
            const isEditing = editing === it.slot
            return (
              <div
                key={it.slot}
                className={css.railRow}
                data-current={current ? '' : undefined}
                title={it.wxid ?? undefined}
                /*
                 * **整行可点**（2026-10-17 修「有时候点击没反应」）。
                 *
                 * 原先 `onClick` 只挂在第一行（`.railRowHead`：状态点 + 名字 + 当前标），
                 * 而第二行（`今日 N · 已绑定`）与行内空白**不可点** —— 但整行有
                 * `cursor: pointer` 与 hover 底色，用户看到的就是「这一整块都能点」。
                 * 于是点第二行或行内空白时**毫无反应**，表现为「有时候点了没反应」。
                 *
                 * 现在把点击挂到行本身：行内任何位置（除按钮与输入框）都算「切到这个实例」。
                 * 行内的按钮各自 `stopPropagation`（改名 ✎ / 绑定此号），输入框也拦掉。
                 */
                role="button"
                tabIndex={0}
                aria-current={current ? 'true' : undefined}
                onClick={() => { if (!isEditing) onPick(it.slot) }}
                onKeyDown={(e) => {
                  if (isEditing) return
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(it.slot) }
                }}
              >
                <div className={css.railRowHead}>
                  <StateDot state={statusDot(it.status)} />
                  {isEditing
                    ? (
                      <RailRenameInput
                        value={it.label ?? ''}
                        placeholder={it.userName ?? `实例 ${it.slot}`}
                        onCommit={(next) => { void rename(it.slot, next) }}
                        onCancel={() => { setEditing(null) }}
                      />
                    )
                    : (
                      <span
                        className={css.railName}
                        title="双击改名"
                        onDoubleClick={(e) => { e.stopPropagation(); setEditing(it.slot) }}
                      >
                        {railLabel(it)}
                      </span>
                    )}
                  {current && <span className={css.instCurrent}>当前</span>}
                  {!isEditing && (
                    <button
                      type="button"
                      className={css.railRenameBtn}
                      title="重命名"
                      aria-label={`重命名实例 ${it.slot}`}
                      onClick={(e) => { e.stopPropagation(); setEditing(it.slot) }}
                      {...desktopActionProps()}
                    >
                      ✎
                    </button>
                  )}
                </div>
                <div className={css.railRowHead}>
                  <span className={css.railMeta}>今日 {it.todayMessages} · {CLAWBOT_STATUS_LABEL[it.status]}</span>
                  {unbound && (
                    <Button
                      size="sm"
                      variant="outline"
                      className={css.railBind}
                      disabled={busy === it.slot} {...desktopActionProps()}
                      onClick={(e) => { e.stopPropagation(); void startBind(it.slot) }}
                    >
                      {it.status === 'unbound' ? '绑定此号' : '重新绑定'}
                    </Button>
                  )}
                </div>
                {/* 自动回复的 token 消耗（2026-10-19）：按实例显示今日 / 累计；供应商不报 usage 时保持 0。 */}
                <div className={css.railTokens} title={`今日 ${it.todayTokens} tokens · 累计 ${it.totalTokens} tokens`}>
                  Token 今日 <b>{fmtTokens(it.todayTokens)}</b> · 累计 <b>{fmtTokens(it.totalTokens)}</b>
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
