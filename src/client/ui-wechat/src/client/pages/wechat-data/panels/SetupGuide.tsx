/**
 * 首次进入系统的配置向导卡。
 *
 * 为什么需要它：通过启动引导 / 隐私同意 / 授权三道闸门之后，用户直接落在主界面 ——
 * 但此时「检测账号 / 数据库密钥 / 图片密钥 / 图片解码」这四步通常还没配，界面看上去是空的。
 * 设置弹窗里本来就有这套配置向导，可它藏在「设置」按钮后面，第一次进来的人不会知道。
 * 这张卡把「还差哪几步、点一下去哪配」摆到眼前，配完自动收起。
 *
 * 与设置弹窗的关系：**不重写任何配置动作**，只做「指路」—— 点某一步就打开设置并落到那一节
 * （复用 WechatDataPanel 的 openSettings + 设置里的滚到某节）。配置本身仍在原处完成。
 *
 * 状态口径在 `setup-guide.ts`（纯函数 + 单测），保证与设置里左导航的状态一致。
 * 收尾状态只写一次 localStorage：`done`（配完了）/`dismissed`（用户点了稍后）—— 之后不再弹，
 * 也不在配完后因为后来清空配置又冒出来。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { apiDetectWechatAccounts, apiGetWechatConfigFull, apiGetWechatKeysInfo, apiGetWhisperStatus } from '../api.ts'
import {
  SETUP_OPTIONAL_STEP,
  SETUP_STEPS,
  emptyFacts,
  setupProgress,
  stepDone,
  type SetupFacts,
} from './setup-guide.ts'
import css from './setup-guide.module.css'

/** 收尾状态：写过就不再自动弹。 */
const GUIDE_STATE_KEY = 'super-time-setup-guide'
type GuideState = 'done' | 'dismissed' | null

function readGuideState(): GuideState {
  try {
    const v = localStorage.getItem(GUIDE_STATE_KEY)
    return v === 'done' || v === 'dismissed' ? v : null
  } catch {
    return null
  }
}

function writeGuideState(v: 'done' | 'dismissed'): void {
  try {
    localStorage.setItem(GUIDE_STATE_KEY, v)
  } catch {
    /* 落盘失败不影响本次会话（只是下次还会弹） */
  }
}

/**
 * 纯展示层：给定事实渲染清单，不碰 IPC。SSR 冒烟直接喂夹具就能断言。
 * @param props.facts - 配置事实。
 * @param props.onOpenStep - 点某一步的「去配置」（宿主负责打开设置并落到该节）。
 * @param props.onLater - 「稍后再说」。
 */
export function SetupGuideCard({
  facts,
  onOpenStep,
  onLater,
}: {
  facts: SetupFacts
  onOpenStep: (key: string) => void
  onLater: () => void
}): React.JSX.Element {
  const { done, total } = setupProgress(facts)
  const voiceOk = facts.voiceReady
  return (
    <section className={css.card} aria-label="首次配置向导">
      <div className={css.hd}>
        <span className={css.title}>首次配置向导</span>
        <span className={css.count}>已完成 {done}/{total}</span>
      </div>
      <div className={css.bar} role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <div className={css.barFill} style={{ width: `${(done / total) * 100}%` }} />
      </div>

      <div className={css.steps}>
        {SETUP_STEPS.map((s) => {
          const ok = stepDone(s.key, facts)
          return (
            <div key={s.key} className={css.step} data-done={ok || undefined} data-step={s.key}>
              <span className={css.dot} aria-hidden="true" />
              <span className={css.body}>
                <span className={css.label}>{s.label}</span>
                <span className={css.hint}>{ok ? s.done : s.todo}</span>
              </span>
              {!ok && (
                <button type="button" className={css.go} onClick={() => { onOpenStep(s.key) }}>去配置</button>
              )}
            </div>
          )
        })}

        {/* 可选项：不阻塞「完成」，所以单独一行且不参与进度 */}
        <div className={css.step} data-optional="true" data-done={voiceOk || undefined} data-step={SETUP_OPTIONAL_STEP.key}>
          <span className={css.dot} aria-hidden="true" />
          <span className={css.body}>
            <span className={css.label}>{SETUP_OPTIONAL_STEP.label}</span>
            <span className={css.hint}>{voiceOk ? SETUP_OPTIONAL_STEP.done : SETUP_OPTIONAL_STEP.todo}</span>
          </span>
          {!voiceOk && (
            <button type="button" className={css.go} onClick={() => { onOpenStep(SETUP_OPTIONAL_STEP.key) }}>去配置</button>
          )}
        </div>
      </div>

      <div className={css.ft}>
        <span className={css.ftHint}>也可以随时在「设置 → 配置向导」里继续</span>
        <button type="button" className={css.later} onClick={onLater}>稍后再说</button>
      </div>
    </section>
  )
}

/**
 * 接线层：取事实 → 判定 → 交给 `SetupGuideCard`。
 * @param props.open - 宿主是否允许显示（设置弹窗打开时传 false，避免压在弹窗上）。
 * @param props.onOpenStep - 打开设置并落到该节。
 */
export function SetupGuide({
  open,
  onOpenStep,
}: {
  open: boolean
  onOpenStep: (key: string) => void
}): React.JSX.Element | null {
  const [facts, setFacts] = useState<SetupFacts>(() => emptyFacts())
  const [state, setState] = useState<GuideState>(() => readGuideState())
  /** 取过一次数才敢判定「已完成」，否则首帧的空事实会把已配好的机器误判成未配置。 */
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [c, k, w, acc] = await Promise.all([
          apiGetWechatConfigFull(),
          apiGetWechatKeysInfo(),
          apiGetWhisperStatus(),
          apiDetectWechatAccounts(),
        ])
        if (!alive) return
        setFacts({
          accounts: (acc.accounts ?? []).length,
          dbDir: c.db_dir ?? '',
          keysLoaded: k.loaded === true,
          keyCount: k.keyCount ?? 0,
          dbKey: c.db_enc_key ?? '',
          imgAes: c.image_aes_key ?? '',
          cdnEnabled: c.cdn_enabled === true,
          voiceReady: Boolean(w?.engine),
        })
      } catch {
        /* 取不到就保持未完成态：向导宁可多显示一次，也不编造状态 */
      } finally {
        if (alive) setReady(true)
      }
    })()
    return () => { alive = false }
  }, [])

  const progress = useMemo(() => setupProgress(facts), [facts])

  // 配完就永久收尾：以后即使清空配置也不再弹（配置是用户自己改的，不该被向导反复打扰）
  useEffect(() => {
    if (!ready || !progress.complete) return
    setState((prev) => {
      if (prev === null) writeGuideState('done')
      return prev === null ? 'done' : prev
    })
  }, [ready, progress.complete])

  const onLater = useCallback((): void => {
    writeGuideState('dismissed')
    setState('dismissed')
  }, [])

  if (!ready || state !== null || !open) return null
  return <SetupGuideCard facts={facts} onOpenStep={onOpenStep} onLater={onLater} />
}
