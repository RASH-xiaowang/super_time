/**
 * 启动页 / 门禁共用的授权面板：状态展示 + 导入许可证 / 粘贴 JSON / 导出激活请求。
 *
 * 2026-10-19 微信化改版：
 *   · 两栏保留（用户 2026-10-17 要求「分为两列」），但去掉渐变标题/发光按钮/玻璃卡；
 *   · 合并重复文案：底栏那句「授权成功前无法进入主界面」删掉（左栏导语与常见问题
 *     已经把同一件事说清楚），右栏只留「导入许可证 + 常见问题」；
 *   · 粘贴框默认折叠（高级路径），主路径是「选择 license.json 导入」；
 *   · 按钮文案一字未动（用户与真机 e2e 都按这些名字找它）。
 */
import React, { useCallback, useState } from 'react'
import gateCss from './license-gate.module.css'
import type { LicenseStatus } from './LicenseGate.tsx'
import { licenseExpiryWarning } from './license-expiry.ts'

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

/** 授权三步（面板顶部逐条说明；文字只解释动作，不改任何行为）。 */
const FLOW: ReadonlyArray<string> = [
  '手里有厂商签发的 license.json：直接在第 3 步导入。',
  '只有本机的激活请求：先点「导出激活请求」拿到文件，交给签发方换回许可证。',
  '导入：点「选择 license.json 导入」，或把许可证 JSON 粘进下面的框里校验导入；成功后点「进入系统」。',
]

/** 常见问题：三种最可能卡住的授权问题，答案都指向面板上已有的按钮。 */
const FAQ: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: '提示「设备不匹配」？',
    a: '许可证与本机指纹绑定：换机器、重装系统或大改硬件后需要重新签发 —— 导出激活请求交给签发方即可。',
  },
  {
    q: '提示「已过期」？',
    a: '找签发方续签；拿到新许可证后在这里重新导入即可，旧文件不用手动删。',
  },
  {
    q: '导入时报无效 / 选错文件？',
    a: '直接重新选择或粘贴正确的许可证就行；校验失败不会改动本机已有授权。',
  },
]

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
    const api = window.electronAPI?.license
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
    const api = window.electronAPI?.license
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
    const api = window.electronAPI?.license
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

  // W3-11.7：快到期的那句提醒（纯函数判据见 license-expiry.guard.spec.ts）。
  // 注意**只**看 payload.expiresAt、不把过期那一档算进来（已过期由标题说）。
  const expiry = licenseExpiryWarning(status?.payload?.expiresAt ?? null)

  const wrap = compact ? gateCss.embed : gateCss.card

  return (
    <div className={wrap} data-usable={usable ? '1' : '0'}>
      <div className={gateCss.cols}>
        <div className={gateCss.col}>
          {/* 嵌入启动页时页头已由壳的 `StageHead` 给（「License 授权验证」），
              这里不再重复一行 brand —— 两行同名标题叠在一起只是噪音。 */}
          {compact ? null : <div className={gateCss.brand}>LICENSE · 授权验证</div>}
          <h2 className={compact ? gateCss.embedTitle : gateCss.title}>{title}</h2>
          <p className={gateCss.lead}>
            {usable
              ? '授权有效，可以直接进入系统主界面。'
              : status?.state === 'unlicensed'
                ? '还没有导入许可证。按下面三步拿到并导入厂商签发的许可证；授权成功前无法进入主界面。'
                : '当前的授权无效或已过期。按下面三步重新签发并导入；授权成功前无法进入主界面。'}
          </p>

          <ol className={gateCss.flow}>
            {FLOW.map((text, i) => (
              <li key={text} className={gateCss.flowItem}>
                <span className={gateCss.flowNo} aria-hidden="true">{String(i + 1)}</span>
                <span>{text}</span>
              </li>
            ))}
          </ol>

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

          {/* W3-11.7：快到期时**在面板里出声**。
              只挂在这一处是有意的：它是「授权」这件事回执的一部分，用户此刻正在看授权；
              过期那一档由上面标题（「许可证已过期」）说，这里不再重复报一遍。 */}
          {expiry !== null && (
            <div className={gateCss.expiry} role="status">
              {expiry.text}
            </div>
          )}
        </div>

        <div className={gateCss.col}>
          <div className={gateCss.actHd}>导入许可证</div>

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

          {/* 粘贴框是高级路径：默认折叠，主路径是上面的「选择 license.json 导入」。 */}
          <details className={gateCss.pasteBox}>
            <summary className={gateCss.pasteLabel}>或粘贴许可证 JSON（高级）</summary>
            <textarea
              id="lic-paste"
              className={gateCss.paste}
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder={'{"payload":{...},"signature":"..."}'}
              spellCheck={false}
              aria-label="粘贴许可证 JSON"
            />
            <button
              type="button"
              className={gateCss.ghost}
              disabled={busy !== null || !paste.trim()}
              onClick={() => { void onImportPaste() }}
            >
              {busy === 'paste' ? '校验中…' : '校验并导入'}
            </button>
          </details>

          {msg ? (
            <p className={msg.kind === 'ok' ? gateCss.msgOk : gateCss.msgErr} role="status">
              {msg.text}
            </p>
          ) : null}

          <div className={gateCss.faqHd}>常见问题</div>
          <div className={gateCss.faqList}>
            {FAQ.map((f) => (
              <div key={f.q}>
                <div className={gateCss.faqTitle}>{f.q}</div>
                <div className={gateCss.faqBody}>{f.a}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
