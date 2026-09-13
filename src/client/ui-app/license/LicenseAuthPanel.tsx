/**
 * 启动页 / 门禁共用的授权面板：状态展示 + 导入许可证 / 粘贴 JSON / 导出激活请求。
 */
import React, { useCallback, useState } from 'react'
import gateCss from './license-gate.module.css'
import type { LicenseStatus } from './LicenseGate.tsx'

/** 本应用没有试用期：只有有效正式证才可用。 */
export function isLicenseUsable(st: LicenseStatus | null | undefined): boolean {
  return !!st && st.state === 'licensed'
}

const STATE_TITLE: Record<string, string> = {
  licensed: '已授权',
  unlicensed: '未授权',
  expired: '许可证已过期',
  device_mismatch: '设备不匹配',
  invalid: '许可证无效',
  error: '授权状态异常',
}

export interface LicenseAuthPanelProps {
  status: LicenseStatus | null
  onStatusChange: (next: LicenseStatus) => void
  /** 紧凑模式：嵌在启动页内容区，不画整屏遮罩 */
  compact?: boolean
}

export function LicenseAuthPanel({
  status,
  onStatusChange,
  compact = false,
}: LicenseAuthPanelProps): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [paste, setPaste] = useState('')

  const usable = isLicenseUsable(status)
  const title = STATE_TITLE[status?.state ?? 'error'] || '需要授权'

  const onImportFile = useCallback(async () => {
    const api = (window as any).electronAPI?.license
    if (!api?.importFile) {
      setMsg({ kind: 'err', text: '授权 API 不可用' })
      return
    }
    setBusy('file')
    setMsg(null)
    try {
      const r = await api.importFile()
      if (r?.ok) {
        setMsg({ kind: 'ok', text: '许可证导入成功' })
        onStatusChange(r.status)
      } else if (!r?.canceled) {
        setMsg({ kind: 'err', text: r?.error || '导入失败' })
      }
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message })
    } finally {
      setBusy(null)
    }
  }, [onStatusChange])

  const onImportPaste = useCallback(async () => {
    const api = (window as any).electronAPI?.license
    if (!api?.importText) return
    if (!paste.trim()) {
      setMsg({ kind: 'err', text: '请先粘贴许可证 JSON' })
      return
    }
    setBusy('paste')
    setMsg(null)
    try {
      const r = await api.importText(paste.trim())
      if (r?.ok) {
        setMsg({ kind: 'ok', text: '许可证导入成功' })
        onStatusChange(r.status)
        setPaste('')
      } else {
        setMsg({ kind: 'err', text: r?.error || '导入失败' })
      }
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message })
    } finally {
      setBusy(null)
    }
  }, [paste, onStatusChange])

  const onExportReq = useCallback(async () => {
    const api = (window as any).electronAPI?.license
    if (!api?.exportRequest) return
    setBusy('export')
    setMsg(null)
    try {
      const r = await api.exportRequest()
      if (r?.ok) setMsg({ kind: 'ok', text: `已导出激活请求：${r.path}` })
      else if (!r?.canceled) setMsg({ kind: 'err', text: r?.error || '导出失败' })
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message })
    } finally {
      setBusy(null)
    }
  }, [])

  const expires = status?.payload?.expiresAt
    ? new Date(status.payload.expiresAt).toLocaleString('zh-CN')
    : status?.state === 'licensed' ? '永久' : '—'

  const wrap = compact ? gateCss.embed : gateCss.card

  return (
    <div className={wrap} data-usable={usable ? '1' : '0'}>
      <div className={gateCss.brand}>LICENSE · 授权验证</div>
      <h2 className={compact ? gateCss.embedTitle : gateCss.title}>{title}</h2>
      <p className={gateCss.lead}>
        {usable
          ? '授权有效，可进入系统主界面。'
          : status?.state === 'unlicensed'
            ? '尚未导入许可证。请导入厂商签发的许可证，或导出激活请求后由厂商换发。授权成功前无法进入主界面。'
            : '检测到授权无效或已过期。请导入厂商签发的许可证，或导出激活请求后由厂商换发。授权成功前无法进入主界面。'}
      </p>

      <dl className={gateCss.meta}>
        <div><dt>状态</dt><dd>{status?.state ?? '—'}</dd></div>
        <div><dt>错误码</dt><dd>{status?.code || '—'}</dd></div>
        <div><dt>原因</dt><dd>{status?.reason || '—'}</dd></div>
        <div><dt>客户</dt><dd>{status?.payload?.issuedTo?.name || status?.payload?.issuedTo?.company || '—'}</dd></div>
        <div><dt>到期</dt><dd>{expires}</dd></div>
        {status?.device?.fingerprintShort ? (
          <div>
            <dt>设备</dt>
            <dd className={gateCss.mono}>
              {status.device.fingerprintShort}… {status.device.hostname ?? ''}
            </dd>
          </div>
        ) : null}
      </dl>

      <div className={gateCss.actions}>
        <button
          type="button"
          className={gateCss.primary}
          disabled={busy !== null}
          onClick={() => { void onImportFile() }}
        >
          {busy === 'file' ? '导入中…' : '选择 license.json 导入'}
        </button>
        <button
          type="button"
          className={gateCss.ghost}
          disabled={busy !== null}
          onClick={() => { void onExportReq() }}
        >
          {busy === 'export' ? '导出中…' : '导出激活请求'}
        </button>
      </div>

      <div className={gateCss.pasteBox}>
        <label className={gateCss.pasteLabel} htmlFor="lic-paste">或粘贴许可证 JSON</label>
        <textarea
          id="lic-paste"
          className={gateCss.paste}
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder='{"payload":{...},"signature":"..."}'
          spellCheck={false}
        />
        <button
          type="button"
          className={gateCss.ghost}
          disabled={busy !== null || !paste.trim()}
          onClick={() => { void onImportPaste() }}
        >
          {busy === 'paste' ? '校验中…' : '校验并导入'}
        </button>
      </div>

      {msg ? (
        <p className={msg.kind === 'ok' ? gateCss.msgOk : gateCss.msgErr} role="status">
          {msg.text}
        </p>
      ) : null}

      <p className={gateCss.hint}>
        流程：导出激活请求 → 厂商 License Studio 签发 → 导入 → 点击「进入系统」。
      </p>
    </div>
  )
}
