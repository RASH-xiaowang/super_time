/**
 * 设置 → 远程访问（手机）：开关、局域网地址、二维码、凭据轮换。
 *
 * ## 这一节为什么必须存在
 *
 * 局域网远程访问是本项目**唯一的入站暴露面**（`docs/PRIVACY.md` 第四节 H）。
 * 它的开关如果只存在于 `config.json` 里，就等于「要改隐私姿态得手工编辑 JSON」——
 * 而 N24 那条教训正好相反：界面上有开关但代码没有消费者会误导用户，
 * 代码有行为但界面没有开关同样糟糕（用户不知道自己开着什么）。
 *
 * ## 明文凭据只显示一次，这是刻意的
 *
 * 二维码与可复制的链接**只在「启用 / 轮换」刚成功的那一刻**出现，之后界面上只剩掩码
 * （`abcd…wxyz`）。理由：如果随时能调出明文凭据，那么任何能看到这块屏幕的场合
 * （投屏、截图、远程协助、肩窥）都等于交出完整凭据 —— 而凭据换来的是**全部聊天记录**。
 * 想再看一次二维码，就轮换一次（旧令牌与旧配对码立即失效，已连上的手机要重新扫）。
 * 这不是缺陷，是把「泄漏窗口」压到最小。
 *
 * ## 文件名口径
 *
 * 必须叫 `settings-*.tsx`：`src/backend/tests/settings-switch-wiring.spec.ts` 的扫描范围是
 * `/^settings-[a-z-]+\.tsx?$/` + `Settings.tsx`，它守着「界面上可见的控件必须有代码消费者」。
 * 换个名字能让那条守卫保持绿色，但那是**绕过**而不是满足它的意图 —— 它要防的正是
 * 「界面上有个开关，代码里没人读」（`api_enabled` 曾经就是这样躺了两个月）。
 *
 * @module panels/settings-remote-access
 */
import React, { useCallback, useEffect, useState } from 'react'
import { encodeQr, qrSvgPath } from './clawbot-qr.ts'
import { copyTextToClipboard } from '../utils/misc.ts'
import css from './settings-remote-access.module.css'
import { desktopOnlyGate } from '../ui/desktop-only.tsx'
import type { RemoteAccessRotation, RemoteAccessState } from '../../../contracts.ts'

/** 宿主桥（只有桌面端有；浏览器态这一节整块不渲染）。 */
function bridge(): {
  state: () => Promise<{ ok: boolean, value?: RemoteAccessState }>
  rotate: () => Promise<{ ok: boolean, value?: RemoteAccessRotation, error?: { message?: string } }>
  toggle: (enabled: boolean) => Promise<{ ok: boolean, value?: RemoteAccessState, error?: { message?: string } }>
} | null {
  if (typeof window === 'undefined') return null
  const api = window.electronAPI?.remoteAccess
  return (api as never) ?? null
}

/** 二维码只在「刚生成配对码」时出现，用完即弃（不落任何状态存储）。 */
interface OneTimeQr {
  url: string
  pairingCode: string
  path: { viewBox: string, d: string } | null
  error: string
}

/**
 * 把地址 + 端口 + 配对码拼成手机要打开的链接，并顺手把二维码画出来。
 *
 * 二维码画不出来不是致命错误（还可以手输链接），所以失败只记一句原因。
 * @param address - 绑定到的局域网 IPv4。
 * @param port - 实际端口（可能被顺移过，所以用状态里的实际值而不是配置值）。
 * @param pairingCode - 刚生成的短命配对码。
 */
function buildQr(address: string, port: number, pairingCode: string): OneTimeQr {
  const url = `http://${address}:${String(port)}/?t=${pairingCode}`
  try {
    return { url, pairingCode, path: qrSvgPath(encodeQr(url)), error: '' }
  } catch (e) {
    // clawbot-qr 的容量上限是 230 字节（版本 9 / EC-L）；这个 URL 约 60–70 字节，
    // 正常不会超。真超了说明地址或端口出了怪值，此时仍给出手输链接。
    return { url, pairingCode, path: null, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 设置 → 远程访问（手机）。 */
export function SettingsRemoteAccess(): React.JSX.Element {
  const blocked = desktopOnlyGate('remote'); if (blocked !== null) return blocked
  const api = bridge()
  const [state, setState] = useState<RemoteAccessState | null>(null)
  const [qr, setQr] = useState<OneTimeQr | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    if (!api) return
    try {
      const r = await api.state()
      if (r.ok && r.value) setState(r.value)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [api])

  useEffect(() => { void refresh() }, [refresh])

  /** 启用并生成凭据（第一次用时走这条：没有长期令牌，服务端是不会开始监听的）。 */
  const rotate = useCallback(async (): Promise<void> => {
    if (!api || busy) return
    setBusy(true)
    setError('')
    try {
      const r = await api.rotate()
      if (!r.ok || !r.value) {
        setError(r.error?.message ?? '生成访问凭据失败')
        return
      }
      const st = r.value.state
      setState(st)
      setQr(st.running ? buildQr(st.address, st.port, r.value.pairingCode) : null)
      if (!st.running) setError('访问凭据已生成，但服务没有起来（端口被占？看看下面的地址列表）')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [api, busy])

  /** 开关：关掉立刻断开所有在连的手机；打开时若还没有长期令牌则必须先生成。 */
  const toggle = useCallback(async (next: boolean): Promise<void> => {
    if (!api || busy) return
    if (next && !(state?.hasToken ?? false)) { await rotate(); return }
    setBusy(true)
    setError('')
    try {
      const r = await api.toggle(next)
      if (!r.ok || !r.value) { setError(r.error?.message ?? '操作失败'); return }
      setState(r.value)
      // 关掉就作废二维码：配对码已被 stop() 清掉，服务也不再听端口，
      // 留着一个「看起来还能扫」的码只会让人以为还开着。
      if (!next) setQr(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [api, busy, rotate, state?.hasToken])

  const copy = useCallback(async (text: string, what: string): Promise<void> => {
    // 必须走共享助手：它带 execCommand 退路（`navigator.clipboard` 在非安全上下文
    // 与老内核里根本不存在，而局域网 HTTP 恰好**不是**安全上下文 —— 直接调它
    // 就等于「被拒 = 没复制」，用户点了按钮什么也没发生）。
    const ok = await copyTextToClipboard(text)
    if (ok) {
      setCopied(what)
      window.setTimeout(() => setCopied(''), 1800)
      return
    }
    setError('复制失败，请手动选择文本复制')
  }, [])

  // 浏览器态没有这一节（它本身就是「配置桌面端怎么被手机访问」，在手机上没有意义）
  if (!api) return <React.Fragment />

  const running = state?.running ?? false
  const url = running && state ? `http://${state.address}:${String(state.port)}/` : ''
  const firewallPort = state?.running && state.port > 0 ? state.port : (state?.configuredPort ?? 5032)

  return (
    <section className={css.card} data-settings-section="remote">
      <header className={css.hd}>
        <h3 className={css.title}>远程访问（手机）</h3>
        <label className={css.switch} data-on={running || undefined}>
          <input
            type="checkbox"
            checked={state?.enabled ?? false}
            disabled={busy}
            onChange={(e) => { void toggle(e.target.checked) }}
          />
          <span className={css.track} aria-hidden="true"><span className={css.knob} /></span>
          <span className={css.switchText}>{(state?.enabled ?? false) ? '已打开' : '已关闭'}</span>
        </label>
      </header>

      <p className={css.lede}>
        打开后本机在局域网里起一个 HTTP 服务，<b>你自己的手机</b>可以用浏览器访问同一套界面。
        <b>默认关闭</b>；打开后同一 Wi-Fi 下的设备<b>持配对码</b>即可读到微信数据，
        且只开放一份方法白名单（模型 API Key、许可证、诊断、备份还原、配置写入一律不开放）。
      </p>

      <div className={css.status} data-on={running || undefined}>
        <span className={css.dot} aria-hidden="true" />
        {running
          ? `正在监听 http://${state?.address ?? ''}:${String(state?.port ?? '')}`
          : (state?.enabled ? '已打开但没有监听（缺长期令牌，或端口不可用）' : '未监听（任何设备都连不进来）')}
      </div>

      {error !== '' && <p className={css.err} role="alert">{error}</p>}

      {qr && (
        <div className={css.qrBox}>
          <div className={css.qrPaper}>
            {qr.path
              ? (
                <svg viewBox={qr.path.viewBox} className={css.qrSvg} role="img" aria-label="手机访问二维码">
                  <path d={qr.path.d} />
                </svg>
                )
              : <div className={css.err}>二维码生成失败：{qr.error}</div>}
          </div>
          <div className={css.qrSide}>
            <p className={css.qrHint}>用手机相机扫这个码即可打开（配对码已附在链接里，不用手输）。</p>
            <code className={css.url}>{qr.url}</code>
            <div className={css.btnRow}>
              <button type="button" className={css.btn} onClick={() => { void copy(qr.url, 'link') }}>
                {copied === 'link' ? '✓ 已复制' : '复制链接'}
              </button>
              <button type="button" className={css.btn} onClick={() => { void copy(qr.pairingCode, 'token') }}>
                {copied === 'token' ? '✓ 已复制' : '复制配对码'}
              </button>
            </div>
            <p className={css.once}>
              配对码与二维码<b>只在这次生成后显示</b>；关掉这一节就只剩掩码。
              想再看一次请点「轮换令牌」（旧令牌、旧配对码与已连上的手机会立即失效）。
            </p>
          </div>
        </div>
      )}

      <dl className={css.facts}>
        <div className={css.fact}>
          <dt>长期令牌</dt>
          <dd>{state?.hasToken ? (state.tokenMasked || '（已生成）') : '尚未生成'}</dd>
        </div>
        <div className={css.fact}>
          <dt>局域网地址</dt>
          <dd>
            {(state?.addresses?.length ?? 0) > 0
              ? (state?.addresses ?? []).map((a) => <code key={a} className={css.addr}>{a}</code>)
              : '未检测到（电脑没连网？）'}
          </dd>
        </div>
        {running && url !== '' && (
          <div className={css.fact}>
            <dt>当前地址</dt>
            <dd>
              <code className={css.addr}>{url}</code>
              <button type="button" className={css.btnMini} onClick={() => { void copy(url, 'cur') }}>
                {copied === 'cur' ? '✓' : '复制'}
              </button>
            </dd>
          </div>
        )}
        <div className={css.fact}>
          <dt>在连设备</dt>
          <dd>{String(state?.sessions ?? 0)} 个会话</dd>
        </div>
      </dl>

      <div className={css.btnRow}>
        <button type="button" className={css.btn} disabled={busy} onClick={() => { void rotate() }}>
          {busy ? '处理中…' : (state?.hasToken ? '轮换令牌' : '启用并生成访问凭据')}
        </button>
        <button type="button" className={css.btnGhost} disabled={busy} onClick={() => { void refresh() }}>
          刷新状态
        </button>
      </div>

      <div className={css.warn}>
        <p className={css.warnT}>连不上？按这个顺序查</p>
        <ol className={css.warnList}>
          <li>手机与电脑在<b>同一个 Wi-Fi</b>（手机用流量、或连了访客网络都不行）；</li>
          <li>Windows 防火墙：首次监听时会弹「是否允许访问」，<b>当时点了「取消」就连不上</b>。
              手动放行（管理员身份运行；正在监听时用实际端口，未监听时用配置端口）：
              <code className={css.code}>netsh advfirewall firewall add rule name=&quot;Super Time 远程访问&quot; dir=in action=allow protocol=TCP localport={String(firewallPort)}</code>
          </li>
          <li>上面「局域网地址」列了多个时，服务绑的是<b>第一个</b>；如果那个地址是虚拟网卡
              （VMware / Hyper-V / WSL），手机会连不上 —— 断开虚拟网卡后点「刷新状态」重绑。</li>
        </ol>
        <p className={css.warnNote}>
          ⚠ 这条链路是<b>明文 HTTP、没有 TLS</b>：在公共 Wi-Fi 或被入侵的路由器下，同网段的人
          能嗅探到配对码与你查阅的内容。<b>只在你信任的局域网里打开，用完就关。</b>
          逐条口径见 <code className={css.code}>docs/PRIVACY.md</code> 第四节 H。
        </p>
      </div>
    </section>
  )
}
