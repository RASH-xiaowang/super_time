/**
 * 微信 ClawBot 集成面板（多实例，2026-10-13）。
 *
 * 一个侧栏入口（「行动与维护」分组），面板内两个视图：
 * - **集成设置**：实例卡（每个微信号一条：绑定/解绑/移除 + 自动回复与知识库开关）、
 *   当前实例的绑定卡片、环境自检、官方 FAQ 三条；
 * - **接入会话**：按**当前实例**检索/导出/发送它的会话（多实例下会话是分家的）。
 *
 * ## 当前实例（多实例的核心）
 *
 * 面板持有一个 `slot`：默认取「第一个已绑定实例，其次第一个实例」（与后端
 * `resolveClawbotSlot` 同一条规则），用户可以随时切换。所有读写都带上它 ——
 * 绑定卡片、自检、会话查询、发送、扫码弹窗，一个都不许落到「别的号」上。
 *
 * ## 事件的两条纪律
 *
 * - `clawbot/message` 的载荷**带 slot**（多实例判别位）：只刷新当前实例；别的号来消息
 *   不动当前会话（否则 A 号来一条，B 号的列表与分页位置就会被无谓地搅一遍）；
 * - `clawbot/binding-changed` 不带 slot（它是绑定态迁移），一律重读。
 *
 * @module panels/ClawBotPanel
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClawbotBindingSnapshot, ClawbotInstance } from '@deepseek-ai/dsh-wechat-data/types'
import { apiGetClawbotBinding, apiListClawbotInstances } from '../api.ts'
import { PanelHeader, Segmented } from '../ui/kit.tsx'
import { ClawbotSettingsView } from './clawbot-settings.tsx'
import { ClawbotChatView } from './clawbot-chat.tsx'
import { ClawbotRail } from './clawbot-rail.tsx'
import { pickDefaultSlot } from './clawbot-instances.tsx'
import { desktopAction } from '../ui/desktop-only.tsx'
import css from './clawbot.module.css'

export function ClawBotPanel(): React.JSX.Element {
  const [instances, setInstances] = useState<ClawbotInstance[]>([])
  const [slot, setSlot] = useState<number | null>(null)
  const [snap, setSnap] = useState<ClawbotBindingSnapshot | null>(null)
  const [loadError, setLoadError] = useState('')
  /** 快照自带的读失败原因（库打不开 ≠ 未绑定）：与调用失败分开显示。 */
  const [readError, setReadError] = useState('')
  const [view, setView] = useState<'settings' | 'chat' | null>(null)

  /** 事件回调要读「当前实例」，但订阅不该因切实例而重建 ⇒ 用 ref 镜像一份。 */
  const slotRef = useRef<number | null>(null)
  useEffect(() => { slotRef.current = slot }, [slot])

  const refresh = useCallback(async (target?: number): Promise<void> => {
    try {
      const list = await apiListClawbotInstances()
      setInstances(list.instances)
      const want = target ?? slotRef.current
      // 目标实例已被移除（或在首屏）⇒ 回到缺省规则：第一个已绑定，其次第一个实例。
      const resolved = want !== null && want !== undefined && list.instances.some(i => i.slot === want)
        ? want
        : pickDefaultSlot(list.instances)
      setSlot(resolved)
      if (resolved === null) {
        setSnap(null)
        setReadError(list.readError ?? '')
        setLoadError('')
        return
      }
      const next = await apiGetClawbotBinding({ slot: resolved })
      setSnap(next)
      setReadError(next.readError ?? '')
      setLoadError('')
    } catch (e) {
      // 调用本身失败（后端未就绪等）：与「读失败」分开说 —— 这里连快照都没拿到。
      setLoadError('ClawBot 状态读取失败：' + (e as Error).message)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    const onMsg = (e: Event): void => {
      const d = (e as CustomEvent<{ slot?: number } | null>).detail
      // 别的实例的消息：不动当前会话（只把它当「计数可能变了」，交给列表刷新）。
      if (d !== null && typeof d.slot === 'number' && d.slot !== slotRef.current) return
      void refresh(slotRef.current ?? undefined)
    }
    // 绑定态迁移（申请二维码 / 绑定成功 / 解绑）：一律重读当前实例。
    const onBind = (): void => { void refresh(slotRef.current ?? undefined) }
    window.addEventListener('dsh-clawbot-message', onMsg)
    window.addEventListener('dsh-clawbot-binding-changed', onBind)
    return () => {
      window.removeEventListener('dsh-clawbot-message', onMsg)
      window.removeEventListener('dsh-clawbot-binding-changed', onBind)
    }
  }, [refresh])

  // 默认视图：用户没手动切过时，已绑定→会话、否则→设置（绑定的唯一目的是收发消息）。
  const active = view ?? (snap?.binding.status === 'bound' ? 'chat' : 'settings')

  return (
    <section className={css.root}>
      <PanelHeader
        title={(
          <>
            <span className={css.hdIcon}>{'🦞'}</span>
            ClawBot
          </>
        )}
        desc="把 Super Time 接入微信，之后可在微信里直接指挥它执行任务"
        actions={(
          <Segmented
            options={[{ value: 'settings', label: '集成设置' }, { value: 'chat', label: '接入会话' }]}
            value={active}
            onChange={(v) => { setView(v === 'chat' ? 'chat' : 'settings') }}
            ariaLabel="ClawBot 视图切换"
          />
        )}
      />

      {/* 手机上这一节只剩「看」：写侧接口（建实例 / 绑定 / 改配置 / 以用户身份发消息）被远程白名单
          挡在门外，是**安全决策**而不是漏配 —— 令牌泄漏不该等于「别人能用你的微信发消息」。
          说明只写在这一处，下面那几个禁用按钮不必各带一句（手机上 tooltip 看不见，禁用态又点不出声）。 */}
      {desktopAction() && (
        <div className={css.muted} role="note">手机上这里只能查看：新增 / 删除实例、扫码绑定、改实例配置、给机器人发消息都要在电脑上完成。</div>
      )}

      {/*
        C2 两栏定式：实例轨 | 工作区。「切哪个号」只有轨这一个入口（指挥条的 select 退役）；
        绑定态 pill 也下沉到轨头部（离实例更近，逐行状态可见）。读失败只在轨上显示一处 ——
        会话/设置视图各自有针对自己那一份数据的具体呈现（chat 的 readError 横幅、设置的 pill）。
      */}
      <div className={css.shell}>
        <ClawbotRail
          instances={instances}
          slot={slot}
          snapshot={snap}
          readError={readError}
          loadError={loadError}
          onPick={(target) => { void refresh(target) }}
          onChanged={refresh}
        />
        <div className={active === 'settings' ? css.workSettings : css.workChat}>
          {active === 'settings'
            ? <ClawbotSettingsView snapshot={snap} slot={slot} onRefresh={refresh} />
            : <ClawbotChatView snapshot={snap} slot={slot} onGoSettings={() => { setView('settings') }} />}
        </div>
      </div>
    </section>
  )
}
