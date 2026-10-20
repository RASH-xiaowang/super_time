/**
 * 手机浏览器的**令牌门**：进门之前先证明「是桌面端主人让你来的」。
 *
 * ## 为什么需要这一屏
 *
 * 服务端的会话是 Cookie 态的：第一次访问时手机身上什么都没有，所有 `/api/*` 都回 401。
 * 这一屏做三件事 —— ① 扫码进来时从地址栏取一次性配对码直接换会话（用户什么都不用输）；
 * ② 手工输入配对码的路径（没扫码、或配对码是口头告知的）；③ **会话中途失效时重新出现**
 * （12 小时 TTL 到期、桌面端轮换了令牌、桌面端关了开关）。
 *
 * 第 ③ 条最容易被漏掉：如果只在首次挂载时判一次，那么手机放着过夜再打开，
 * 用户看到的会是一屏「加载失败」，而真实原因是「该重新扫码了」。
 *
 * ## 配对码只在地址栏出现一次
 *
 * 扫码得到的 `?t=<配对码>` 换到会话之后立刻用 `history.replaceState` 抹掉 ——
 * 留在地址栏意味着它会进浏览器历史、进截图、进可能的 `Referer`。
 *
 * ## 版式
 *
 * 这一屏**只会在手机（或桌面浏览器）上出现**，所以直接按手机排：满高、单列、
 * 大点击目标、`dvh` + 安全区内边距（刘海与手势条）。桌面端的 Electron 窗口
 * 永远不会渲染它（`capabilities.isDesktop` 时整棵子树被跳过）。
 *
 * @module ui-app/browser-gate
 */
import React, { useCallback, useEffect, useState } from 'react'
import {
  REMOTE_UNREACHABLE_EVENT,
  SESSION_LOST_EVENT,
  authenticate,
  hasSession,
  startHttpEventRelay,
  stripTokenFromUrl,
  tokenFromUrl,
} from './http-remote.ts'
import css from './browser-gate.module.css'

/** 门的状态：探测中 / 要令牌 / 已放行。 */
type Phase = 'checking' | 'gate' | 'ready'

/**
 * 包住整棵应用：授权通过后才渲染 children，并在此时接上 SSE 事件流。
 *
 * SSE 刻意在**放行之后**才起：未授权时它只会不停收到 401，既没用也会在日志里刷噪声。
 * @param props.children - 授权后要渲染的应用（`WechatApp`）。
 */
export function BrowserSession({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('checking')
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  /** 「连不上电脑上的服务」——与「会话没了」是两件事，处理方式也不同（见 http-remote 的 probeSession）。 */
  const [down, setDown] = useState(false)

  // 首次进入：地址栏有一次性配对码就直接换会话，否则探测是否已有有效会话。
  useEffect(() => {
    let cancelled = false
    void (async (): Promise<void> => {
      const oneTime = tokenFromUrl()
      if (oneTime !== '') {
        setBusy(true)
        const r = await authenticate(oneTime)
        // 无论成败都抹掉：配对码不该留在地址栏（失败时留着只会让人以为还能再试一次同一个）
        stripTokenFromUrl()
        if (cancelled) return
        setBusy(false)
        if (r.ok) { setPhase('ready'); return }
        setError(r.error ?? '配对码不正确')
        setPhase('gate')
        return
      }
      const ok = await hasSession()
      if (!cancelled) setPhase(ok ? 'ready' : 'gate')
    })()
    return () => { cancelled = true }
  }, [])

  // 会话中途失效（TTL 到期 / 桌面端轮换令牌 / 桌面端关掉开关）→ 回到令牌门。
  useEffect(() => {
    const onLost = (): void => {
      setError('会话已失效，请重新扫码或输入配对码')
      setPhase('gate')
    }
    window.addEventListener(SESSION_LOST_EVENT, onLost)
    return () => window.removeEventListener(SESSION_LOST_EVENT, onLost)
  }, [])

  // 连不上 / 恢复了：应用继续显示，只加一条横幅。把用户踢回令牌门是错的 ——
  // 服务没在跑的时候，令牌门本身也走不通，剩下的只有一个说错原因的循环。
  useEffect(() => {
    const onDown = (e: Event): void => { setDown(Boolean((e as CustomEvent<{ down: boolean }>).detail?.down)) }
    window.addEventListener(REMOTE_UNREACHABLE_EVENT, onDown)
    return () => window.removeEventListener(REMOTE_UNREACHABLE_EVENT, onDown)
  }, [])

  // 放行之后接上事件流（后端事件 → DOM CustomEvent），卸载时关掉。
  useEffect(() => {
    if (phase !== 'ready') return undefined
    return startHttpEventRelay()
  }, [phase])

  const submit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    const t = token.trim()
    if (t === '' || busy) return
    setBusy(true)
    setError('')
    const r = await authenticate(t)
    setBusy(false)
    if (r.ok) {
      setToken('')
      setPhase('ready')
      return
    }
    setError(r.error ?? '配对码不正确')
  }, [token, busy])

  if (phase === 'checking') {
    return (
      <div className={css.shell} role="status" aria-live="polite">
        <div className={css.card}>
          <div className={css.spin} aria-hidden="true" />
          <p className={css.hint}>正在连接电脑上的 Super Time…</p>
        </div>
      </div>
    )
  }

  if (phase === 'gate') {
    return (
      <div className={css.shell}>
        <form className={css.card} onSubmit={(e) => { void submit(e) }}>
          <h1 className={css.title}>打开浏览器会话</h1>
          <p className={css.sub}>
            请回到桌面端，点击标题栏<b>「打开网页」</b>重新打开同一套界面。
          </p>
          <label className={css.label} htmlFor="ra-token">
            访问配对码
            <input
              id="ra-token"
              className={css.input}
              type="password"
              inputMode="text"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="粘贴或输入配对码"
              value={token}
              disabled={busy}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          {error !== '' && <p className={css.error} role="alert">{error}</p>}
          <button type="submit" className={css.btn} disabled={busy || token.trim() === ''}>
            {busy ? '正在验证…' : '进入'}
          </button>
          <details className={css.help}>
            <summary className={css.helpSummary}>连不上怎么办</summary>
            <p className={css.helpBody}>
              配对码由桌面端生成、只在这台电脑上显示。请确认手机与电脑在同一 Wi-Fi、
              电脑上的开关是打开的，且 Windows 防火墙弹窗当时点了「允许」。
            </p>
          </details>
        </form>
      </div>
    )
  }

  return (
    <>
      {down && (
        <div className={css.offline} role="alert">
          连不上电脑上的 Super Time —— 电脑上的应用没在跑，或这台设备不在同一个网络里。
          正在自动重试，恢复后界面会自己重新取数。
        </div>
      )}
      {children}
    </>
  )
}
