
/**
 * 设置面板里的两块独立区块：**软件授权**与**软件更新**（M21 第二十七刀自 Settings.tsx 拆出）。
 *
 * 这两块与设置项本身无关：授权读的是主进程 license:*，更新读的是 update:state/update:event 推送，
 * 各自带完整的状态机，之前却和设置项挤在一个文件里。整段原样搬出（含类型与文案常量），
 * 面板侧只多了 `import { LicenseSection, UpdateSection }`（JSX 一字未改）。
 * 依赖靠脚本从「区域里真实用到的面板 import」生成 —— 少一个就是编译错误，不是运行期惊喜。
*/
import { useConfirm } from '../ui/confirm.tsx'
import { ProgressBar } from '../ui/kit.tsx'
import { fmtBytes } from '../utils/format.ts'
import { css } from './settings-css.ts'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useRef, useState } from 'react'

/** 许可证状态（主进程 license:status 返回）。 */
type LicenseStatus = {
  state: string
  licensed: boolean
  reason?: string
  code?: string
  payload?: {
    licenseId?: string
    edition?: string
    issuedTo?: { name?: string; company?: string; email?: string }
    expiresAt?: string | null
    features?: string[]
    seats?: number
  } | null
  device?: { fingerprintShort?: string; hostname?: string }
  daysToExpiry?: number | null
  licensePath?: string
}

const LICENSE_STATE_LABEL: Record<string, string> = {
  licensed: '已授权',
  unlicensed: '未授权',
  expired: '已过期',
  device_mismatch: '设备不匹配',
  invalid: '许可证无效',
  error: '状态异常',
}

/**
 * 软件授权区块：状态 / 导出激活请求 / 导入许可证 / 解除绑定。
 */
export function LicenseSection(): React.JSX.Element {
  /** 应用内确认框（替代原生 window.confirm）。 */
  const confirm = useConfirm()
  const [st, setSt] = useState<LicenseStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const refresh = useCallback(async () => {
    const api = (window as any).electronAPI?.license
    if (!api?.status) {
      setSt({ state: 'error', licensed: false, reason: 'license_api_missing' })
      return
    }
    try {
      const s = await api.status()
      setSt(s)
    } catch (err) {
      setSt({ state: 'error', licensed: false, reason: (err as Error).message })
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const onExportRequest = async (): Promise<void> => {
    const api = (window as any).electronAPI?.license
    if (!api?.exportRequest) return
    setBusy('export')
    setMsg(null)
    try {
      const r = await api.exportRequest()
      if (r?.ok) setMsg({ kind: 'ok', text: `已导出激活请求：${r.path}` })
      else if (r?.canceled) setMsg(null)
      else setMsg({ kind: 'err', text: r?.error || '导出失败' })
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const onImport = async (): Promise<void> => {
    const api = (window as any).electronAPI?.license
    if (!api?.importFile) return
    setBusy('import')
    setMsg(null)
    try {
      const r = await api.importFile()
      if (r?.ok) {
        setMsg({ kind: 'ok', text: '许可证导入成功' })
        setSt(r.status)
      } else if (r?.canceled) setMsg(null)
      else setMsg({ kind: 'err', text: r?.error || '导入失败' })
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const onRemove = async (): Promise<void> => {
    const ok = await confirm({
      title: '解除本机许可证绑定？',
      message: '解除后需要重新导入许可证才能继续正式授权。',
      tone: 'danger',
      confirmText: '解除绑定',
    })
    if (!ok) return
    const api = (window as any).electronAPI?.license
    if (!api?.remove) return
    setBusy('remove')
    setMsg(null)
    try {
      const r = await api.remove()
      if (r?.ok) {
        setMsg({ kind: 'ok', text: '已解除许可证' })
        setSt(r.status)
      } else setMsg({ kind: 'err', text: r?.error || '操作失败' })
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const stateLabel = st ? (LICENSE_STATE_LABEL[st.state] ?? st.state) : '…'
  const customer = st?.payload?.issuedTo?.name || st?.payload?.issuedTo?.company || '—'
  const expires = st?.payload?.expiresAt
    ? new Date(st.payload.expiresAt).toLocaleDateString('zh-CN')
    : st?.state === 'licensed' ? '永久' : '—'

  return (
    <section className={css.card} aria-label="软件授权">
      <div className={css.cardHd}>
        <span className={css.cardIconChip} aria-hidden="true">🔑</span>
        <div className={css.cardTitleBox}>
          <span className={css.cardTitle}>软件授权 License</span>
        </div>
        <span className={css.cardBadge}>
          <StateDot state={st?.licensed ? 'done' : 'error'} />
          {stateLabel}
        </span>
      </div>
      <div className={css.cardBody}>
        <div className={css.row}>
          <span className={css.rowName}>授权状态</span>
          <span className={css.rowMeta}>
            {st?.licensed ? '正式授权有效' : stateLabel}
          </span>
        </div>
        <div className={css.row}>
          <span className={css.rowName}>客户 / 版本 / 席位</span>
          <span className={css.rowMeta}>
            {customer} · {st?.payload?.edition ?? '—'} · {st?.payload?.seats ?? '—'}
          </span>
        </div>
        <div className={css.row}>
          <span className={css.rowName}>到期</span>
          <span className={css.rowMeta}>
            {expires}
            {typeof st?.daysToExpiry === 'number' && st.daysToExpiry <= 30 && st.daysToExpiry >= 0
              ? `（剩 ${st.daysToExpiry} 天）`
              : ''}
          </span>
        </div>
        <div className={css.row}>
          <span className={css.rowName}>设备指纹</span>
          <span className={css.rowMeta}>
            {st?.device?.fingerprintShort ? `${st.device.fingerprintShort}…` : '—'}
            {st?.device?.hostname ? ` · ${st.device.hostname}` : ''}
          </span>
        </div>
        <div className={css.row}>
          <span className={css.rowName}>开放功能</span>
          <span className={css.rowMeta}>
            {st?.licensed ? (st.payload?.features ?? []).join(', ') || '—' : '—'}
          </span>
        </div>
        {st?.reason && !st.licensed ? (
          <div className={css.row}>
            <span className={css.rowNote}>原因：{st.reason}（{st.code}）</span>
          </div>
        ) : null}

        <div className={css.row} style={{ gap: 8, flexWrap: 'wrap', paddingTop: 12 }}>
          <Button variant="outline" disabled={busy !== null} onClick={() => { void onExportRequest() }}>
            {busy === 'export' ? '导出中…' : '导出激活请求'}
          </Button>
          <Button variant="primary" disabled={busy !== null} onClick={() => { void onImport() }}>
            {busy === 'import' ? '导入中…' : '导入许可证'}
          </Button>
          {st?.licensed ? (
            <Button variant="ghost" disabled={busy !== null} onClick={() => { void onRemove() }}>
              {busy === 'remove' ? '处理中…' : '解除绑定'}
            </Button>
          ) : null}
          <Button variant="ghost" disabled={busy !== null} onClick={() => { void refresh() }}>
            刷新状态
          </Button>
        </div>

        {msg ? (
          <div className={css.row}>
            <span className={css.rowNote} style={{ color: msg.kind === 'ok' ? 'var(--nm-green)' : 'var(--nm-danger)' }}>
              {msg.text}
            </span>
          </div>
        ) : null}

        <div className={css.row}>
          <span className={css.rowNote}>
            流程：导出本机激活请求 → 发给厂商 → 厂商签发 license.json → 本机导入。换机需换发；停用由厂商拒发新证。
          </span>
        </div>
      </div>
    </section>
  )
}

/** 主进程 `update:state` / `update:event` 的形状（事实来源见 src/backend/update.js）。 */
type UpdatePhase =
  | 'idle' | 'unsupported' | 'checking' | 'available'
  | 'downloading' | 'downloaded' | 'up-to-date' | 'error'

type UpdateState = {
  phase: UpdatePhase
  currentVersion: string | null
  version: string | null
  releaseName: string | null
  releaseNotes: string | null
  releaseDate: string | null
  progress: { percent: number; transferred: number | null; total: number | null; bytesPerSecond: number | null } | null
  error: string | null
  reason: 'dev' | 'disabled' | 'unavailable' | 'unknown' | null
  checkedAt: string | null
  manual: boolean
}

const UPDATE_PHASE_META: Record<UpdatePhase, { label: string; dot: 'done' | 'warning' | 'ongoing' | 'error' }> = {
  idle: { label: '尚未检查', dot: 'ongoing' },
  unsupported: { label: '当前不支持', dot: 'warning' },
  checking: { label: '正在检查…', dot: 'ongoing' },
  available: { label: '发现新版本', dot: 'warning' },
  downloading: { label: '正在下载…', dot: 'ongoing' },
  downloaded: { label: '已下载，待安装', dot: 'done' },
  'up-to-date': { label: '已是最新版本', dot: 'done' },
  error: { label: '检查失败', dot: 'error' },
}

/** 不支持自动更新的原因文案；键与 update.js 的 unsupportedReason() 一一对应。 */
const UPDATE_UNSUPPORTED_LABEL: Record<string, string> = {
  dev: '开发态不检查更新 —— 自动更新只在安装版生效。',
  disabled: '本次运行已禁用自动检查（环境变量 SUPERTIME_DISABLE_UPDATE_CHECK=1）。',
  unavailable: '更新组件未加载（安装包可能不完整），建议重新安装应用。',
  unknown: '当前环境不支持自动更新。',
}

/**
 * 软件更新区块：当前版本 / 检查更新 / 下载进度 / 重启并安装。
 *
 * 主进程是唯一的事实来源，这里只做投影。两处顺序有讲究：
 *   · 事件订阅必须**先于**取快照挂上 —— 反过来的话，两者之间发生的那次状态变化
 *     会被永久丢掉（界面从此停在旧状态，直到下一次变化）；
 *   · 快照到达时若已经收到过推送，就不能往回覆盖，因为快照可能是更早的。
 * 自动检查由主进程排在启动 30s 后，这里的按钮是手动那一路（`manual: true`）。
 */
export function UpdateSection(): React.JSX.Element {
  const [st, setSt] = useState<UpdateState | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  /** 是否已经收到过推送；收到过之后快照不再覆盖。 */
  const pushedRef = useRef(false)

  useEffect(() => {
    const api = (window as any).electronAPI?.update
    if (!api?.state) return
    const off = api.onEvent?.((next: UpdateState) => {
      pushedRef.current = true
      setSt(next)
    })
    void (async () => {
      try {
        const r = await api.state()
        if (r?.ok && !pushedRef.current) setSt(r.value as UpdateState)
      } catch {
        /* 拿不到快照就等下一次推送；界面停在「尚未检查」，不编造状态 */
      }
    })()
    return () => { off?.() }
  }, [])

  const onCheck = async (): Promise<void> => {
    const api = (window as any).electronAPI?.update
    if (!api?.check) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.check({ manual: true })
      if (r?.ok) setSt(r.value as UpdateState)
      else setMsg({ kind: 'err', text: r?.error?.message || '检查更新失败' })
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const onInstall = async (): Promise<void> => {
    const api = (window as any).electronAPI?.update
    if (!api?.install) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.install()
      // 成功的话应用马上就要退出并重装，这里不必再改状态（改了也来不及看见）。
      if (!r?.ok) setMsg({ kind: 'err', text: r?.error?.message || r?.error || '安装失败' })
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const phase = st?.phase ?? 'idle'
  const meta = UPDATE_PHASE_META[phase]
  const progress = st?.progress ?? null
  const unsupported = phase === 'unsupported'
  const inFlight = phase === 'checking' || phase === 'downloading'
  const targetVersion = st?.version
    ? `v${st.version}`
    : phase === 'up-to-date' ? '已是最新' : '—'

  return (
    <section className={css.card} aria-label="软件更新">
      <div className={css.cardHd}>
        <span className={css.cardIconChip} aria-hidden="true">⬆️</span>
        <div className={css.cardTitleBox}>
          <span className={css.cardTitle}>软件更新 Updates</span>
        </div>
        <span className={css.cardBadge}>
          <StateDot state={meta.dot} />
          {meta.label}
        </span>
      </div>
      <div className={css.cardBody}>
        <div className={css.row}>
          <span className={css.rowName}>当前版本</span>
          <span className={css.rowMeta}>v{st?.currentVersion ?? '—'}</span>
        </div>
        <div className={css.row}>
          <span className={css.rowName}>最新版本</span>
          <span className={css.rowMeta}>{targetVersion}</span>
        </div>

        {progress && (phase === 'downloading' || phase === 'available') ? (
          <div className={css.row} style={{ display: 'block' }}>
            <ProgressBar value={progress.percent} />
            <span className={css.rowNote}>
              {progress.percent.toFixed(1)}%
              {progress.transferred != null && progress.total != null
                ? ` · ${fmtBytes(progress.transferred)} / ${fmtBytes(progress.total)}`
                : ''}
              {progress.bytesPerSecond != null ? ` · ${fmtBytes(progress.bytesPerSecond)}/s` : ''}
            </span>
          </div>
        ) : null}

        {st?.releaseNotes ? (
          <div className={css.row} style={{ display: 'block' }}>
            <span className={css.rowName}>更新说明</span>
            <div className={css.rowNote} style={{ whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto' }}>
              {st.releaseNotes}
            </div>
          </div>
        ) : null}

        {phase === 'error' && st?.error ? (
          <div className={css.row}>
            <span className={css.rowNote} style={{ color: 'var(--nm-danger)' }}>{st.error}</span>
          </div>
        ) : null}

        {unsupported ? (
          <div className={css.row}>
            <span className={css.rowNote}>
              {UPDATE_UNSUPPORTED_LABEL[st?.reason ?? 'unknown'] ?? UPDATE_UNSUPPORTED_LABEL.unknown}
            </span>
          </div>
        ) : null}

        <div className={css.row} style={{ gap: 8, flexWrap: 'wrap', paddingTop: 12 }}>
          <Button
            variant="primary"
            disabled={busy || unsupported || inFlight}
            onClick={() => { void onCheck() }}
          >
            {phase === 'checking' ? '检查中…' : '检查更新'}
          </Button>
          {phase === 'downloaded' ? (
            <Button variant="primary" disabled={busy} onClick={() => { void onInstall() }}>
              重启并安装
            </Button>
          ) : null}
        </div>

        {msg ? (
          <div className={css.row}>
            <span className={css.rowNote} style={{ color: msg.kind === 'ok' ? 'var(--nm-green)' : 'var(--nm-danger)' }}>
              {msg.text}
            </span>
          </div>
        ) : null}

        <div className={css.row}>
          <span className={css.rowNote}>
            安装版会在启动后自动检查，发现新版本即在后台下载，退出应用时自动完成安装；
            下载完成后也可以点「重启并安装」立即生效。
            {st?.checkedAt ? ` 上次检查：${new Date(st.checkedAt).toLocaleString('zh-CN')}` : ''}
          </span>
        </div>
      </div>
    </section>
  )
}
