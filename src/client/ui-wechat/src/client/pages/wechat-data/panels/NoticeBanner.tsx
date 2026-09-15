/**
 * 右下角悬浮的主动提醒卡片：新版本可装 / 许可证临期。
 *
 * 与「设置」里的那两张卡是什么关系：那两张卡是**全量事实**（当前/最新版本、进度、更新说明、
 * 到期日、席位、指纹……），用户主动去看。这里是**只在需要动作时冒出来的那一句** —— 判定口径
 * 全在 `notice.ts`（纯函数，有单测），本文件只负责接线与呈现。
 *
 * 为什么是右下角悬浮而不是顶栏下方的一条横条：这两件事与「当前在看哪一页」无关，是跨页面的；
 * 横条会随内容区一起被推走、还白占一条横向空间。悬浮卡片则始终待在同一处，且不占版面。
 *
 * 结构上刻意拆成两层：
 *   · `NoticeList` —— 纯展示，给一组提醒就渲染，不碰 IPC。SSR 冒烟直接喂夹具就能断言。
 *   · `NoticeBanner` —— 取状态（update 事件 + license 快照）、执行动作、记住「本次会话不再提示」。
 *
 * 关闭只在**本次会话**生效：把提醒记进 state 而不落盘。用户点掉「许可证剩 7 天」之后再开应用
 * 仍然该被提醒 —— 落盘会让这条提醒永久失效，那等于把预警功能关掉了。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { buildNotices } from './notice.ts'
import type { LicenseFacts, Notice, NoticeAction, UpdateFacts } from './notice.ts'
import css from './notice.module.css'

/** 动作文案。列表里第一个动作会拿到主按钮样式（判定层已把推荐动作排在前面）。 */
const ACTION_LABEL: Readonly<Record<NoticeAction, string>> = {
  install: '重启并安装',
  'export-request': '导出激活请求',
  'open-license': '去软件授权',
}

/** 纯展示层：给定提醒列表渲染，不碰 IPC。 */
export function NoticeList({
  notices,
  onAction,
  onDismiss,
  busy = null,
}: {
  notices: readonly Notice[]
  onAction: (action: NoticeAction) => void
  onDismiss: (id: string) => void
  /** 正在执行的动作（期间禁用全部动作按钮）。 */
  busy?: NoticeAction | null
}): React.JSX.Element | null {
  if (notices.length === 0) return null
  return (
    <div className={css.stack} role="region" aria-label="提醒">
      {notices.map((n) => (
        <div key={n.id} className={css.card} data-tone={n.tone} data-notice={n.id} role="status">
          <div className={css.cardHd}>
            <span className={css.dot} aria-hidden="true" />
            <span className={css.title}>{n.title}</span>
            <button
              type="button"
              className={css.close}
              onClick={() => { onDismiss(n.id) }}
              title="本次会话不再提示"
              aria-label={`关闭提醒：${n.title}`}
            >
              ✕
            </button>
          </div>
          <p className={css.detail}>{n.detail}</p>
          {n.actions.length > 0 && (
            <div className={css.actions}>
              {n.actions.map((a, i) => (
                <button
                  key={a}
                  type="button"
                  // 主按钮给**列表里第一个动作**：判定层已把推荐动作排在前面
                  // （许可证那两条的推荐动作是「导出激活请求」而不是「去软件授权」）。
                  className={i === 0 ? css.btnPrimary : css.btn}
                  disabled={busy !== null}
                  onClick={() => { onAction(a) }}
                >
                  {busy === a ? '处理中…' : ACTION_LABEL[a]}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * 接线层：取状态 → 判定 → 交给 `NoticeList`。
 * @param props.onOpenLicense - 点「去软件授权」时打开设置弹窗的授权节（由宿主提供）。
 */
export function NoticeBanner({ onOpenLicense }: { onOpenLicense?: () => void }): React.JSX.Element | null {
  const [update, setUpdate] = useState<UpdateFacts | null>(null)
  const [license, setLicense] = useState<LicenseFacts | null>(null)
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [busy, setBusy] = useState<NoticeAction | null>(null)
  /** 动作回执（导出路径 / 失败原因）；以 `Notice` 的形态并入同一摞卡片。 */
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  // 更新：**先订阅再取快照**。反过来的话，两步之间发生的那次状态变化会被永久丢掉
  // （界面就停在旧状态直到下一次变化）—— 与「设置 → 软件更新」卡里同一个坑。
  useEffect(() => {
    const api = (window as any).electronAPI?.update
    if (!api?.state) return
    let pushed = false
    const off = api.onEvent?.((next: UpdateFacts) => { pushed = true; setUpdate(next) })
    void (async () => {
      try {
        const r = await api.state()
        if (r?.ok && !pushed) setUpdate(r.value as UpdateFacts)
      } catch {
        /* 拿不到就等推送；提醒条宁可少说一句，也不编造状态 */
      }
    })()
    return () => { off?.() }
  }, [])

  // 授权：启动时取一次（与门禁同源）。失败就当作「没有该提醒」，不弹错。
  useEffect(() => {
    const api = (window as any).electronAPI?.license
    if (!api?.status) return
    let alive = true
    void (async () => {
      try {
        const s = await api.status()
        if (alive) setLicense(s as LicenseFacts)
      } catch {
        /* 静默 */
      }
    })()
    return () => { alive = false }
  }, [])

  const notices = useMemo(() => buildNotices({ update, license }, dismissed), [update, license, dismissed])

  /**
   * 动作回执也做成同一摞里的一张卡片，而不是另起一块浮层 —— 那样会跑出 `.stack` 的定位与层级，
   * 变成第二个「右下角浮层」。8 秒后自动收走，不长驻。
   */
  const shown = useMemo<readonly Notice[]>(() => {
    if (!note) return notices
    return [
      ...notices,
      {
        id: 'notice:receipt',
        tone: note.kind === 'ok' ? 'info' : 'danger',
        title: note.kind === 'ok' ? '已导出激活请求' : '操作失败',
        detail: note.text,
        actions: [],
      },
    ]
  }, [notices, note])

  useEffect(() => {
    if (!note) return
    const t = window.setTimeout(() => { setNote(null) }, 8000)
    return () => { window.clearTimeout(t) }
  }, [note])

  const onAction = useCallback(async (a: NoticeAction): Promise<void> => {
    if (a === 'open-license') { onOpenLicense?.(); return }
    const el = (window as any).electronAPI
    setNote(null)
    setBusy(a)
    try {
      if (a === 'install') {
        const r = await el?.update?.install()
        // 成功的话应用马上退出并重装，这里不必再改状态（改了也来不及看见）
        if (!r?.ok) setNote({ kind: 'err', text: r?.error?.message || r?.error || '安装失败' })
      } else {
        const r = await el?.license?.exportRequest()
        if (r?.ok) setNote({ kind: 'ok', text: `${r.path}（交给签发方换发新证）` })
        else if (!r?.canceled) setNote({ kind: 'err', text: r?.error || '导出失败' })
      }
    } catch (err) {
      setNote({ kind: 'err', text: (err as Error).message })
    } finally {
      setBusy(null)
    }
  }, [onOpenLicense])

  const onDismiss = useCallback((id: string): void => {
    setDismissed((prev) => {
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])

  return <NoticeList notices={shown} onAction={(a) => { void onAction(a) }} onDismiss={onDismiss} busy={busy} />
}
