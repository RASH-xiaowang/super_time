/**
 * ClawBot 实例设置视图（C3 重排，2026-10-13）。
 *
 * 三张卡通栏：**当前实例卡**（绑定详情 + 环境自检 + 危险区）/ **行为卡**（AI 自动回复升格）/
 * **常见问题**。单列而非上一稿的双列：实例轨已吃掉左栏宽度，且绑定卡与自检已合并 ——
 * 双列的动机（两张矮卡并排填空）不存在了（R3 反转，见 clawbot-layout.spec.ts）。
 *
 * ## 与上一稿的差异（都是实测驱动的）
 *
 * - **当前实例的信息只在这里显示一遍**：实例卡（clawbot-instances.tsx）整卡拆解 —— 导航进实例轨、
 *   配置进本视图的行为卡、删除进本卡危险区；「状态 / wxid / 今日 / 累计 / 通道显示两遍」（P3）消失；
 * - **kvGrid 去掉两个无信息项**：「微信昵称」恒为「未提供」（iLink 不下发）、「实例编号」在卡标题里；
 * - **N 档键值行改键上值下**：单列时 space-between 会把键值对横跨 750px 拉散（P5）；
 * - **自动回复有重量**：switch 形态 + 两行说明（走哪条管道 / 在哪审计）；审计入口是**文案指引**
 *   而不是跳转按钮 —— 路由 hash 只在挂载时读（WechatDataPanel.tsx:482），按钮会是死控件；
 * - **读失败不冒充配置**：实例列表 readError 时开关保持原状并明说，不清成「关」。
 *
 * @module panels/clawbot-settings
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClawbotBindQr, ClawbotBindingSnapshot, ClawbotEnvSnapshot, ClawbotInstance, ClawbotInstanceConfig } from '@deepseek-ai/dsh-wechat-data/types'
import {
  apiCheckClawbotEnv,
  apiCreateClawbotBindQr,
  apiDeleteClawbotInstance,
  apiGetKbs,
  apiListClawbotInstances,
  apiSetClawbotInstanceConfig,
  apiUnbindClawbot,
} from '../api.ts'
import { Card } from '../ui/kit.tsx'
import { desktopActionProps } from '../ui/desktop-only.tsx'
import { useConfirm } from '../ui/confirm.tsx'
import { useTransientNotice } from './hooks.tsx'
import { ClawbotBindModal } from './clawbot-bind-modal.tsx'
import { CLAWBOT_STATUS_LABEL, statusClass, statusDot } from './clawbot-status.ts'
import css from './clawbot.module.css'

/** 官方 FAQ 三条（腾讯云《微信 ClawBot 接入指南》原文口径）。 */
const FAQ: ReadonlyArray<{ q: string, a: string }> = [
  {
    q: '页面一直停留「绑定中」怎么办？',
    a: '① 确认 Super Time 正在运行且网络正常；② 关闭当前页面后重新进入；③ 如仍不行，重启 Super Time 后重新绑定。',
  },
  {
    q: '扫码后没有显示已绑定？',
    a: '① 确认扫描的是你希望绑定的微信账号；② 等待几秒让状态同步；③ 若二维码已失效，点「重新生成」后再扫一次。',
  },
  {
    q: '微信里发消息没有响应？',
    a: '① 确认 Super Time 仍在运行；② 回到本页检查集成状态是否仍为「已绑定」；③ 必要时先解绑再重新扫码绑定。',
  },
]

/** 知识库下拉的选项（只取展示需要的两列）。 */
interface KbOption { id: number, name: string }

function stamp(ms: number | null): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

/**
 * 行为卡（P4）：会替你给微信联系人发消息的开关，视觉重量与说明要配得上它的后果。
 * switch 形态（非裸 checkbox）+ 两行说明（走哪条管道 / 在哪审计）；读失败不冒充配置。
 * 模块级组件：让 `ClawbotSettingsView` 留在 function-size-ratchet 的 250 行线内。
 * @param props.cfg - 当前实例的行为配置（null = 读不到 / 读失败）。
 * @param props.kbs - 知识库下拉选项。
 * @param props.cfgBusy - 配置保存中（逐个禁用，避免并发写）。
 * @param props.readError - 实例列表读失败原因（非空时明说，开关保持原状）。
 * @param props.onPatch - 部分更新配置（只覆盖传进来的字段）。
 */
function AutoReplyCard({ cfg, kbs, cfgBusy, readError, onPatch }: {
  cfg: ClawbotInstanceConfig | null
  kbs: readonly KbOption[]
  cfgBusy: boolean
  readError: string
  onPatch: (p: { autoReply?: boolean, kbEnabled?: boolean, kbId?: number | null }) => Promise<void>
}): React.JSX.Element {
  return (
    <Card title="自动回复（会替你发消息，请确认）">
      {readError !== '' && (
        <div className={css.instReadError} role="alert">
          实例配置读取失败：{readError}
          <div className={css.muted}>开关保持原状 —— 读不到不等于「关」。</div>
        </div>
      )}
      <label className={css.autoRow}>
        <input
          type="checkbox"
          role="switch"
          checked={cfg?.autoReply ?? false}
          disabled={cfgBusy || cfg === null} {...desktopActionProps()}
          onChange={(e) => { void onPatch({ autoReply: e.target.checked }) }}
        />
        <span className={css.autoText}>
          <span className={css.autoTitle}>AI 自动回复</span>
          <span className={css.autoDesc}>
            开启后：收到微信消息时，Super Time 用设置里的「对话模型」自动生成回复并发送；
            每次回复写一行操作日志（category=clawbot），可在「行动与维护 → 操作日志」里逐条审计。
          </span>
        </span>
      </label>
      <label className={css.autoRow}>
        <input
          type="checkbox"
          role="switch"
          checked={cfg?.kbEnabled ?? false}
          disabled={cfgBusy || cfg === null} {...desktopActionProps()}
          onChange={(e) => { void onPatch({ kbEnabled: e.target.checked }) }}
        />
        <span className={css.autoText}>
          <span className={css.autoTitle}>知识库增强</span>
          <span className={css.autoDesc}>回复前先检索你为该实例选的知识库；没选库则不检索（不会静默降级成无库回复）。</span>
        </span>
      </label>
      {cfg?.kbEnabled === true && (
        <select
          className={css.instSelect}
          value={cfg.kbId === null ? '' : String(cfg.kbId)}
          disabled={cfgBusy} {...desktopActionProps()}
          onChange={(e) => { void onPatch({ kbId: e.target.value === '' ? null : Number(e.target.value) }) }}
          aria-label="自动回复检索的知识库"
        >
          <option value="">选择知识库…</option>
          {kbs.map((k) => <option key={k.id} value={String(k.id)}>{k.name}</option>)}
        </select>
      )}
      {cfg?.autoReply === true && cfg?.kbEnabled === true && cfg?.kbId === null && (
        <span className={css.instWarn}>开了知识库增强但没选库 —— 不会检索任何内容</span>
      )}
    </Card>
  )
}

export function ClawbotSettingsView({ snapshot, slot, onRefresh }: {
  snapshot: ClawbotBindingSnapshot | null
  /** 当前实例编号（多实例）：绑定卡片、自检、配置与删除全部作用于它。 */
  slot: number | null
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const confirm = useConfirm()
  const notice = useTransientNotice()
  const [env, setEnv] = useState<ClawbotEnvSnapshot | null>(null)
  /** 当前实例行（行为配置 + 会话计数）；null = 读不到或读失败（不冒充配置）。 */
  const [inst, setInst] = useState<ClawbotInstance | null>(null)
  const [instReadError, setInstReadError] = useState('')
  const [kbs, setKbs] = useState<KbOption[]>([])
  const [busy, setBusy] = useState(false)
  const [cfgBusy, setCfgBusy] = useState(false)
  /** 进行中的扫码弹窗（取码成功后打开；确认/取消后置空）。 */
  const [bindQr, setBindQr] = useState<ClawbotBindQr | null>(null)

  const refreshEnv = useCallback(async (): Promise<void> => {
    try {
      setEnv(await apiCheckClawbotEnv(slot === null ? undefined : { slot }))
    } catch {
      // 自检拿不到不是致命错误：卡片本身就是「排障指引」，缺一行不拦人。
      setEnv(null)
    }
  }, [slot])

  const loadInst = useCallback(async (): Promise<void> => {
    try {
      const s = await apiListClawbotInstances()
      if (s.readError !== undefined) {
        // 读失败 ≠ 没有配置：开关保持原状（这里即清空展示并明说），不冒充「全关」。
        setInst(null)
        setInstReadError(s.readError)
        return
      }
      setInstReadError('')
      setInst(slot === null ? null : (s.instances.find((i) => i.slot === slot) ?? null))
      try {
        const r = await apiGetKbs()
        if (r.readError === undefined) setKbs(r.items.map((k) => ({ id: k.id, name: k.name })))
      } catch { /* 库列表拿不到不影响开关本身，只是选择项空着 */ }
    } catch (e) {
      setInst(null)
      setInstReadError((e as Error).message)
    }
  }, [slot])

  // 卡片上的「接收通道」行与行为配置要跟着绑定/解绑/切换变化 —— 快照刷新时重取。
  useEffect(() => { void refreshEnv() }, [refreshEnv, snapshot])
  useEffect(() => { void loadInst() }, [loadInst, snapshot])

  const binding = snapshot?.binding ?? null
  const status = binding?.status ?? 'unbound'

  const startBind = async (): Promise<void> => {
    setBusy(true)
    try {
      const qr = await apiCreateClawbotBindQr(slot === null ? undefined : { slot })
      setBindQr(qr)
      await onRefresh()
    } catch (e) {
      notice.flash('✗ ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const doUnbind = async (): Promise<void> => {
    const ok = await confirm({
      title: '确认解绑？',
      message: binding?.userName || binding?.wxid
        ? `将解除与「${binding.userName ?? ''}${binding.wxid ? `（${binding.wxid}）` : ''}」的绑定。接入会话不会被删除：解绑只是断开微信通道，历史消息仍保留在本机，重新绑定后可继续查看。`
        : '将解除当前绑定。接入会话不会被删除，重新绑定后可继续查看。',
      tone: 'danger',
      confirmText: '确认解绑',
    })
    if (!ok) return
    setBusy(true)
    try {
      const after = await apiUnbindClawbot(slot === null ? undefined : { slot })
      // 解绑成功但库读回失败（罕见）：如实说，不把「读不到」说成「已解绑」。
      notice.flash(after.readError ? '⚠️ 已执行解绑，但状态回读失败：' + after.readError : '✓ 已解绑（接入会话保留）')
      await onRefresh()
    } catch (e) {
      notice.flash('✗ 解绑失败：' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const patch = async (p: { autoReply?: boolean, kbEnabled?: boolean, kbId?: number | null }): Promise<void> => {
    if (slot === null) return
    setCfgBusy(true)
    try {
      await apiSetClawbotInstanceConfig({ slot, ...p })
      await loadInst()
    } catch (e) {
      notice.flash('✗ 保存失败：' + (e as Error).message)
    } finally {
      setCfgBusy(false)
    }
  }

  const doRemove = async (): Promise<void> => {
    if (slot === null || inst === null) return
    const total = inst.totalMessages
    const label = inst.userName ?? inst.wxid ?? '未绑定'
    const ok = await confirm({
      title: `确认移除实例 ${slot}？`,
      message: total > 0
        ? `将删除该实例（${label}）的绑定信息与行为配置，以及它的 ${String(total)} 条接入会话 —— 会话不可恢复。其余实例不受影响。`
        : `将删除该实例（${label}）的绑定信息与行为配置。它还没有接入会话。其余实例不受影响。`,
      tone: 'danger',
      confirmText: '确认移除',
    })
    if (!ok) return
    setBusy(true)
    try {
      const r = await apiDeleteClawbotInstance({ slot })
      notice.flash(`✓ 已移除实例 ${slot}（连带删除 ${String(r.removedMessages)} 条接入会话）`)
      await onRefresh()
    } catch (e) {
      notice.flash('✗ 移除失败：' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const cfg = inst?.config ?? null

  return (
    <>
      <div className={css.settingsCol}>
        <Card>
          <div className={css.bindRow}>
            <div className={css.bindAvatar} aria-hidden="true">{'🦞'}</div>
            <div className={css.bindGrow}>
              <div className={css.bindTitle}>当前实例 · 实例 {slot ?? '—'}</div>
              <div className={css.bindDesc}>扫码即可绑定，无需 App ID / App Secret</div>
            </div>
            <div className={css.bindStatus}>
              <StateDot state={statusDot(status)} />
              <span className={statusClass(status)}>{CLAWBOT_STATUS_LABEL[status]}</span>
              {binding?.wxid && <span className={css.mono} title={binding.wxid}>{binding.wxid}</span>}
            </div>
            {(status === 'unbound' || status === 'unbound-by-user') && (
              <Button size="sm" variant="primary" disabled={busy} onClick={() => { void startBind() }} {...desktopActionProps()}>
                {status === 'unbound' ? '绑定微信' : '重新绑定'}
              </Button>
            )}
            {status === 'binding' && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => { void startBind() }} {...desktopActionProps()}>重新生成</Button>
            )}
            {status === 'bound' && (
              <Button size="sm" variant="danger" disabled={busy} onClick={() => { void doUnbind() }} {...desktopActionProps()}>解绑</Button>
            )}
          </div>

          <div className={css.kvGrid}>
            {status === 'bound' && (
              <>
                <div className={css.kvItem}><span className={css.kvKey}>绑定时间</span><span className={css.kvVal}>{stamp(binding?.boundAt ?? null)}</span></div>
                <div className={css.kvItem}>
                  <span className={css.kvKey}>接收通道</span>
                  <span className={css.kvVal} title={snapshot?.channel.error ?? undefined}>
                    {(snapshot?.channel.running ?? false) ? '运行中（长轮询）' : (snapshot?.channel.error ?? '') !== '' ? '异常（见下方自检）' : '未运行'}
                  </span>
                </div>
                <div className={css.kvItem}><span className={css.kvKey}>今日消息</span><span className={css.kvVal}>{snapshot?.todayMessages ?? 0}</span></div>
                <div className={css.kvItem}><span className={css.kvKey}>累计消息</span><span className={css.kvVal}>{snapshot?.totalMessages ?? 0}</span></div>
              </>
            )}
            {status === 'unbound-by-user' && (
              <>
                <div className={css.kvItem}><span className={css.kvKey}>上次绑定</span><span className={css.kvVal}>{binding?.userName ?? binding?.wxid ?? '—'}</span></div>
                <div className={css.kvItem}><span className={css.kvKey}>解绑时间</span><span className={css.kvVal}>{stamp(binding?.unboundAt ?? null)}</span></div>
              </>
            )}
          </div>

          <div className={css.envHead}>环境自检</div>
          {env === null
            ? <div className={css.muted}>自检信息暂不可用。</div>
            : (
              <div>
                {env.items.map((it) => (
                  <div key={it.key} className={css.chk}>
                    <span className={it.state === 'ok' ? css.tickOk : css.tickBad} aria-hidden="true">{it.state === 'ok' ? '✓' : '!'}</span>
                    <span className={css.chkLabel}>{it.label}</span>
                    <span className={css.chkDetail} title={it.detail}>{it.detail}</span>
                  </div>
                ))}
              </div>
              )}

          <div className={css.dangerZone}>
            <Button size="sm" variant="danger" disabled={busy || inst === null} onClick={() => { void doRemove() }} {...desktopActionProps()}>移除该实例</Button>
            <span className={css.muted}>连带删除它的绑定、行为配置与全部接入会话（不可恢复）。其余实例不受影响。</span>
          </div>
          {notice.notice && <div className={css.noticeOk}>{notice.notice}</div>}
        </Card>

        <AutoReplyCard cfg={cfg} kbs={kbs} cfgBusy={cfgBusy} readError={instReadError} onPatch={patch} />

        <Card title="常见问题">
          {FAQ.map((f) => (
            <details key={f.q} className={css.faq}>
              <summary className={css.faqQ}>{f.q}</summary>
              <div className={css.faqA}>{f.a}</div>
            </details>
          ))}
        </Card>
      </div>

      {bindQr !== null && (
        <ClawbotBindModal
          qr={bindQr}
          {...(slot === null ? {} : { slot })}
          onConfirmed={(b) => {
            setBindQr(null)
            notice.flash(`✓ 已绑定 ${b.binding.wxid ?? ''}（在微信里给它发条消息试试）`)
            void onRefresh()
          }}
          onClose={() => { setBindQr(null) }}
        />
      )}
    </>
  )
}
