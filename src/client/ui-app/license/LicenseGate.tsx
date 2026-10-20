/**
 * License 门禁：仅 licensed 放行主界面；
 * unlicensed / expired / invalid / device_mismatch 等显示解锁页。
 * 本应用**没有试用期** —— 未导入许可证就没法进入。
 *
 * 2026-10-19 微信化改版（表现层）：
 *   · 去掉渐变标题、玻璃卡、发光主按钮与底部那句「导出 → 签发 → 导入」重复流程
 *     （导语已说清两次出口，常见问题在启动页的授权面板里）；
 *   · 品牌名只留自绘标题栏一处，这里不再渲染 `SUPER TIME`；
 *   · 按钮层级：主「导入许可证」/ 次「导出激活请求」/ 文字链「重新校验」。
 * 业务逻辑（状态查询、导入、导出、刷新）一字未改。
 */
import React, { useCallback, useEffect, useState } from 'react'
import css from './license-gate.module.css'
// 授权解锁页也要能看到「有新版本可装」：更新是主进程的事，与有没有进主界面无关。
// 这一屏没有设置弹窗，所以不传 onOpenLicense（「去软件授权」会自动摘掉）。
import { NoticeBanner } from '@deepseek-ai/dsh-client-ui-wechat/notice'
import type { LicenseStatus } from '@deepseek-ai/dsh-client-ui-wechat/contracts'

export type { LicenseStatus }

const STATE_TITLE: Record<string, string> = {
  licensed: '已授权',
  unlicensed: '未授权',
  expired: '许可证已过期',
  device_mismatch: '设备不匹配',
  invalid: '许可证无效',
  error: '授权状态异常',
}

function isAllowed(st: LicenseStatus | null): boolean {
  if (!st) return false
  return st.state === 'licensed'
}

export interface LicenseGateProps {
  children: React.ReactNode
}

export function LicenseGate({ children }: LicenseGateProps): React.JSX.Element {
  const [status, setStatus] = useState<LicenseStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const api = window.electronAPI?.license
    if (!api?.status) {
      setStatus({ state: 'error', licensed: false, reason: 'license_api_missing' })
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const s = await api.status()
      setStatus(s)
    } catch (err) {
      setStatus({ state: 'error', licensed: false, reason: (err as Error).message })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  if (loading) {
    return (
      <div className={css.lock}>
        <div className={css.card}>
          <p className={css.lead}>正在校验授权…</p>
        </div>
      </div>
    )
  }

  if (isAllowed(status)) {
    return <>{children}</>
  }

  const onImport = async (): Promise<void> => {
    const api = window.electronAPI?.license
    if (!api?.importFile) return
    setBusy('import')
    setMsg(null)
    try {
      const r = await api.importFile()
      if (r?.ok) {
        setMsg('许可证导入成功，正在进入系统…')
        setStatus(r.status)
      } else if (r?.canceled) setMsg(null)
      else setMsg(r?.error || '导入失败')
    } catch (err) {
      setMsg((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const onExportReq = async (): Promise<void> => {
    const api = window.electronAPI?.license
    if (!api?.exportRequest) return
    setBusy('export')
    setMsg(null)
    try {
      const r = await api.exportRequest()
      if (r?.ok) setMsg(`已导出激活请求：${r.path}`)
      else if (!r?.canceled) setMsg(r?.error || '导出失败')
    } catch (err) {
      setMsg((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const title = STATE_TITLE[status?.state ?? 'error'] || '需要授权'
  const detail = status?.reason || status?.code || ''

  return (
    <div className={css.lock}>
      <NoticeBanner />
      <div className={css.card}>
        <h1 className={css.title}>{title}</h1>
        <p className={css.lead}>
          本机数据分析功能需要有效许可证。请导入厂商签发的 license.json，
          或导出激活请求交给厂商换发。
        </p>

        <dl className={css.meta}>
          <div><dt>状态</dt><dd>{status?.state ?? '—'}</dd></div>
          <div><dt>原因</dt><dd>{detail || '—'}</dd></div>
          {status?.device?.fingerprintShort ? (
            <div><dt>设备</dt><dd className={css.mono}>{status.device.fingerprintShort}… {status.device.hostname ?? ''}</dd></div>
          ) : null}
        </dl>

        <div className={css.actions}>
          <button type="button" className={css.primary} disabled={busy !== null} onClick={() => { void onImport() }}>
            {busy === 'import' ? '导入中…' : '导入许可证'}
          </button>
          <button type="button" className={css.ghost} disabled={busy !== null} onClick={() => { void onExportReq() }}>
            {busy === 'export' ? '导出中…' : '导出激活请求'}
          </button>
          <button type="button" className={css.ghost} disabled={busy !== null} onClick={() => { void refresh() }}>
            重新校验
          </button>
        </div>

        {msg ? <p className={css.msg}>{msg}</p> : null}
      </div>
    </div>
  )
}
