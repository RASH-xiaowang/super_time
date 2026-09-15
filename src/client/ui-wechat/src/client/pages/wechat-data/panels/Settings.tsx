/**
 * 微信设置面板 — 按 ST_Wechat_V2「本地检测 → 数据库解密 → 图片密钥 →
 * 图片解密 → 表情/语音」流程重新设计为步骤导航。数据源 / 解密密钥 /
 * 图片密钥 / 图片解码 / 语音转写 五步卡片 + 高级设置（输出目录 · 诊断日志 · 启动引导）。
 * 自动获取密钥（V4 内存扫描 + Weixin.dll 内部键 + V2 图片验证）已支持；
 * SQLCipher 全库解密仍为说明态（本地解密能力独立立项）；语音转写已本地化（whisper.cpp）。
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Button, Input, Pill, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { createPollRegistry, type PollRegistry } from './poll-registry.ts'
import { useTransientNotice } from './hooks.tsx'
import {
  IconGlobeOutline14, IconPersonalizationOutline16, IconRefreshOutline14, IconSettingsOutline14, IconSparkle16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { apiAutoGetDbKey, apiAutoGetImageKey, apiDecryptAllDatabases, apiDecryptAllImages, apiDetectWechatAccounts, apiDownloadWhisperModel, apiGenerateKeysFile, apiGetAvatar, apiDiagLogInfo, apiExportDiagLog, apiGetWechatPathConfig, apiOpenPath, apiRevealDiagLog, apiGetDecryptStatus, apiGetWechatConfigFull, apiGetWechatKeysInfo, apiGetWhisperStatus, apiInstallWhisperEngine, apiSaveWechatConfig, apiSetCdnImageEnabled, apiSetCdnImageLocalDecrypt, apiTranscribeVoiceBatch, apiVerifyDatabaseKey, apiVerifyImageKey, pickDirectory, readRenderCache, writeRenderCache } from '../api.ts'
import type { WechatAccount, WechatConfigFull, WhisperStatus } from '@deepseek-ai/dsh-wechat-data/types'
import { clickableKey, Dialog, PanelHeader, ProgressBar } from '../ui/kit.tsx'
import { AiModelConfig } from './AiModelConfig.tsx'
import { PrivacyPanel } from './Privacy.tsx'
import { PrivacyTrustPanel } from './PrivacyTrust.tsx'
import { BackupPanel } from './Backup.tsx'
import { HealthPanel } from './Health.tsx'
import { HookPanel } from './Hook.tsx'
import { OperationLogPanel } from './OperationLogPanel.tsx'
import css from './settings.module.css'
import kitCss from '../ui/kit.module.css'
import { avatarColors, fmtBytes } from '../utils/format.ts'

/** localStorage 渲染缓存键：上次成功加载的**非密钥**微信配置，用于首帧即时渲染。 */
const SETTINGS_CONFIG_CACHE_KEY = 'settings-config'

/**
 * 密钥字段：**一律不写进渲染缓存**。
 *
 * 为什么：渲染缓存落在 `<userData>/Local Storage`（Chromium 管理的 leveldb），而 M1 的权限
 * 收紧只覆盖 `<userData>/wechat` 与数据根 —— 缓存里放一份密钥等于凭空多一份**不受保护**的
 * 明文副本（复审实测本机 dev profile 的 leveldb 里确实躺着真 `db_enc_key`）。密钥的真源只有
 * `<数据根>/secrets.json`，界面上要显示时通过 RPC 现取。
 */
const SETTINGS_SECRET_FIELDS = ['db_enc_key', 'image_aes_key', 'image_xor_key', 'api_token'] as const
type SettingsSecretKey = (typeof SETTINGS_SECRET_FIELDS)[number]
/** 可缓存的配置形状：明确地把密钥字段排除在外（类型上也不给漏的机会）。 */
type CachedSettingsConfig = Omit<WechatConfigFull, SettingsSecretKey>

/** 去掉密钥字段后的可缓存副本。 */
function cacheableConfig(c: WechatConfigFull): CachedSettingsConfig {
  const { db_enc_key: _db, image_aes_key: _aes, image_xor_key: _xor, api_token: _tok, ...rest } = c
  return rest
}

/** 模型目录探测器尚未就绪时的本地目录兜底(安装状态以 getWhisperStatus 为准)。 */
const WHISPER_MODEL_FALLBACK: ReadonlyArray<{ id: string; name: string; sizeLabel: string; installed: boolean }> = [
  { id: 'tiny', name: 'Tiny', sizeLabel: '约 75 MB · 最快', installed: false },
  { id: 'base', name: 'Base', sizeLabel: '约 145 MB · 很快', installed: false },
  { id: 'small', name: 'Small', sizeLabel: '约 466 MB · 较快', installed: false },
  { id: 'medium', name: 'Medium', sizeLabel: '约 1.5 GB · 中等', installed: false },
  { id: 'large-v3', name: 'Large v3', sizeLabel: '约 3.1 GB · 较慢', installed: false },
  { id: 'turbo', name: 'Turbo', sizeLabel: '约 1.6 GB · 快', installed: false },
]

/** 性能：账号检测 / Whisper 状态缓存 TTL（60 秒），避免每次进入页签重复扫描。 */
const SETTINGS_SCAN_TTL_MS = 60_000
let detectCache: { at: number; accounts: readonly WechatAccount[]; info: { version?: string; install_dir?: string }; total: number } | null = null
let whisperStatusCache: { at: number; status: WhisperStatus } | null = null

/** 空闲时执行（首次进入不阻塞首帧渲染）。 */
function runWhenIdle(fn: () => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => { fn() }, { timeout: 800 })
  } else {
    setTimeout(() => { fn() }, 150)
  }
}

/** Module-level avatar cache (wxid -> data/remote URL, null when none). */
const accountAvatarCache = new Map<string, string | null>()
const AVATAR_CACHE_LIMIT = 100

function cacheAccountAvatar(wxid: string, value: string | null): void {
  if (accountAvatarCache.size >= AVATAR_CACHE_LIMIT) {
    const first = accountAvatarCache.keys().next()
    if (!first.done && first.value !== undefined) accountAvatarCache.delete(first.value)
  }
  accountAvatarCache.set(wxid, value)
}

/** Account avatar: lazy-loads the real WeChat avatar via Remote, falls back to a letter tile. */
function AccountAvatar({ wxid }: { wxid: string }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const cached = accountAvatarCache.get(wxid)
    if (cached !== undefined) { setSrc(cached); return }
    apiGetAvatar({ username: wxid })
      .then((r) => {
        const value = r.kind === 'data' ? (r.data ?? null) : r.kind === 'url' ? (r.url ?? null) : null
        cacheAccountAvatar(wxid, value)
        if (!cancelled) setSrc(value)
      })
      .catch(() => { cacheAccountAvatar(wxid, null); if (!cancelled) setSrc(null) })
    return () => { cancelled = true }
  }, [wxid])
  const letter = (wxid.replace(/^wxid_/, '') || '?').slice(0, 1).toUpperCase()
  const av = avatarColors(wxid)
  return src
    ? <img src={src} alt={letter} className={css.acctAvatarImg} width={34} height={34} referrerPolicy="no-referrer" loading="lazy" />
    : <div className={css.acctAvatar} style={{ background: av.background, color: av.color }}>{letter}</div>
}

/** 相对时间标签（最近活动）。 */
function fmtActive(ts?: number): string {
  if (!ts) return '—'
  const diff = Date.now() / 1000 - ts
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 步骤定义（与 ST_Wechat_V2 向导一致的流程）。 */
const STEPS = [
  { key: 'detect', n: 1, label: '检测账号' },
  { key: 'dbkey', n: 2, label: '数据库密钥' },
  { key: 'imgkey', n: 3, label: '图片密钥' },
  { key: 'img', n: 4, label: '图片解码' },
  { key: 'voice', n: 5, label: '语音转文字' },
] as const

/** 步骤图标（统一 14px 描边风格）。 */
const STEP_ICONS: Record<string, React.JSX.Element> = {
  detect: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
    </svg>
  ),
  dbkey: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7.5" cy="15.5" r="4.5" /><path d="M10.7 12.3 21 2M15 7l3 3" />
    </svg>
  ),
  imgkey: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" />
    </svg>
  ),
  img: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3h5v5H3zM16 16h5v5h-5z" /><path d="M8 8 16 16M8 16 16 8" />
    </svg>
  ),
  voice: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
    </svg>
  ),
  // 从外层侧栏迁进来的两节（不属于 5 步配置向导，只用于左导航图标）。
  boundary: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M12 8v4M12 16h.01" />
    </svg>
  ),
  privacy: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" />
    </svg>
  ),
  backup: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-9-9" /><polyline points="21 3 21 9 15 9" />
    </svg>
  ),
  health: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  ),
  hook: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><path d="M8 13h3M12 17H8M16 13h1M17 17h1" />
    </svg>
  ),
  oplog: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
    </svg>
  ),
}

type StepState = 'done' | 'todo' | 'note'

/** 通知内容(可带明细列表,渲染为悬浮层不挤占布局)。 */
interface Notice {
  kind: 'ok' | 'err'
  text: string
  details?: readonly string[]
}

/* 固定高度状态槽:空闲占位 / 实时进度 / 完成结果,始终占位、永不跳动。 */
interface StatusProps {
  placeholder: string
  active: boolean
  pct: number
  text: string
  item: string
  /** 完成后显示的总结行(为空则显示 placeholder)。 */
  doneText: string
  /** 完成行配色('ok' 绿 / 'err' 红 / '' 主题色)。 */
  doneKind: 'ok' | 'err' | ''
  /** 完成后追加的右侧元素（如“详情”链接）。 */
  detail?: React.ReactNode
}

/**
 * Render one fixed-height message slot (idle placeholder / ok / err).
 * Always reserves its line so action feedback never shifts layout.
 * @param props - placeholder text + result message.
 * @returns the slot element.
 */
function MsgSlot({ placeholder, msg }: { placeholder: string; msg: { kind: 'ok' | 'err'; text: string } | null }): React.JSX.Element {
  return (
    <div className={css.slot}>
      {msg
        ? <span className={msg.kind === 'ok' ? css.slotOk : css.slotErr}>{msg.text}</span>
        : <span className={css.slotIdle}>{placeholder}</span>}
    </div>
  )
}

/**
 * Render one fixed-height status slot (idle placeholder / live progress /
 * last result). Always reserves its line so later operations never shift
 * the surrounding layout.
 * @param props - placeholder + live progress data.
 * @returns the slot element.
 */
function StatusSlot({ placeholder, active, pct, text, item, doneText, doneKind, detail }: StatusProps): React.JSX.Element {
  return (
    <div className={css.slot}>
      {active ? (
        <>
          <div className={css.progressTrack}><div className={css.progressFill} style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} /></div>
          <span className={css.progressText}>{text}</span>
          <span className={css.progressItem} title={item}>{item || '准备中…'}</span>
        </>
      ) : (
        <>
          <span className={doneText ? doneKind === 'ok' ? css.slotOk : doneKind === 'err' ? css.slotErr : css.slotDone : css.slotIdle}>
            {doneText || placeholder}
          </span>
          {detail ? <span className={css.slotDetail}>{detail}</span> : null}
        </>
      )}
    </div>
  )
}

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
function LicenseSection(): React.JSX.Element {
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
    if (!window.confirm('确定解除本机许可证绑定？需要重新导入才能继续正式授权。')) return
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
function UpdateSection(): React.JSX.Element {
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

export interface SettingsPanelProps {
  /** 嵌在弹窗里时：标题栏与关闭按钮由弹窗提供，面板自身不再重复画 PanelHeader。 */
  inDialog?: boolean
  /**
   * 打开时直接落在哪一节。
   *
   * 「数据边界与出网 / 隐私体检」已从外层侧栏迁进本弹窗，但深链（#privacytrust / #privacy）
   * 与跨页跳转（数据总览的风险提示、数据健康的「隐私与信任」按钮）仍要落到正确的一节。
   * 弹窗关闭会卸载内容，所以每次重开这个初值都会生效。
   */
  initialSection?: string
  /** 跨面板跳转：迁移进来的「隐私体检」要把命中样本跳回它所在的会话。 */
  onOpenChat?: (username: string, localId?: number) => void
  /**
   * 弹窗里装不下的跳转（如「文件资产」「存储分析」）交回宿主：由它关掉弹窗再切主内容区。
   * 装得下的那些（设置 / 数据边界与出网 / 数据健康 …）在弹窗内部切节，不出去。
   */
  onNavigateOut?: (tab: string) => void
}

/**
 * Render the wechat-settings panel.
 * @returns the settings element tree.
 */
export function SettingsPanel({ inDialog = false, initialSection, onOpenChat, onNavigateOut }: SettingsPanelProps = {}): React.JSX.Element {
  const cachedCfg = readRenderCache<CachedSettingsConfig>(SETTINGS_CONFIG_CACHE_KEY)
  const [cfg, setCfg] = useState<CachedSettingsConfig | WechatConfigFull | null>(cachedCfg)
  // M15：面板内所有轮询都登记在这里，**卸载时统一清掉**。
  // 原实现把 interval 建在 async 处置函数里、只在 finally 清 —— 下载/转写要跑几分钟，
  // 用户中途切走面板时它会一直每 400~500ms 打 IPC，并在已卸载的组件上 setState。
  const pollsRef = useRef<PollRegistry | null>(null)
  const polls = (): PollRegistry => pollsRef.current ?? (pollsRef.current = createPollRegistry())
  useEffect(() => () => { pollsRef.current?.stopAll() }, [])
  const [cfgLoading, setCfgLoading] = useState(false)
  const [keysInfo, setKeysInfo] = useState<{ keyFormat?: string; keyCount: number; loaded: boolean }>({ keyCount: 0, loaded: false })
  const [accounts, setAccounts] = useState<readonly WechatAccount[]>([])
  const [detectInfo, setDetectInfo] = useState<{ version?: string; install_dir?: string }>({})
  const [detecting, setDetecting] = useState(false)
  const [detectMsg, setDetectMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [dbDir, setDbDir] = useState(cachedCfg?.db_dir ?? '')
  // 密钥字段不从渲染缓存预填（缓存里不该有它们，见 SETTINGS_SECRET_FIELDS）：
  // 未加载完时保持空值，而后端会把「空串/默认值」当成「没给」而不是「要清空」。
  const [dbKey, setDbKey] = useState('')
  const [imgAes, setImgAes] = useState('')
  const [imgXor, setImgXor] = useState('136')
  const [cdnEnabled, setCdnEnabled] = useState(cachedCfg?.cdn_enabled ?? true)
  const [cdnLocal, setCdnLocal] = useState(cachedCfg?.cdn_local_decrypt ?? true)
  // 富提示（kind/details + 关闭按钮）也迁到公共控制器（L20 的最后一处手写版）。
  // 改前是 `setMessage(x); setTimeout(() => setMessage(null), N)` —— 句柄丢了，
  // 「连出两条提示时第一条的定时器把第二条提前清掉」与「卸载后仍写 state」两个已知缺陷都在。
  const { notice: message, flash, clear } = useTransientNotice<Notice>(5000)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [pathConfigPath, setPathConfigPath] = useState('')
  const [dbGetting, setDbGetting] = useState(false)
  const [imgGetting, setImgGetting] = useState(false)
  const [dbOpMsg, setDbOpMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [imgOpMsg, setImgOpMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [decrypting, setDecrypting] = useState(false)
  const [dbProgress, setDbProgress] = useState<{ active: boolean; done: number; total: number; failed: number; message: string }>({ active: false, done: 0, total: 0, failed: 0, message: '' })
  const [imgDecrypting, setImgDecrypting] = useState(false)
  const [imgProgress, setImgProgress] = useState<{ active: boolean; done: number; total: number; failed: number; skipped: number; message: string }>({ active: false, done: 0, total: 0, failed: 0, skipped: 0, message: '' })
  const [imgDetailOpen, setImgDetailOpen] = useState(false)
  const [imgDecryptDetail, setImgDecryptDetail] = useState<{ errors: Array<{ file: string; error: string }>; skippedDetails: Array<{ file: string; reason: string }> }>({ errors: [], skippedDetails: [] })
  const [imgConcurrency, setImgConcurrency] = useState(8)
  const [cdnMsg, setCdnMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [dbDirMsg, setDbDirMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [voiceOpMsg, setVoiceOpMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [whisperDirMsg, setWhisperDirMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [whisperDevice, setWhisperDevice] = useState<'cpu' | 'gpu'>(cachedCfg?.whisper_device ?? 'cpu')
  const [whisperModel, setWhisperModel] = useState(cachedCfg?.whisper_model ?? 'medium')
  const [whisperThreads, setWhisperThreads] = useState(cachedCfg?.whisper_threads ?? 0)
  const [whisperModelsDir, setWhisperModelsDir] = useState(cachedCfg?.whisper_models_dir ?? '')
  const [whisperStatus, setWhisperStatus] = useState<WhisperStatus | null>(null)
  const [whisperStatusLoading, setWhisperStatusLoading] = useState(false)
  const [whisperDownloading, setWhisperDownloading] = useState<{
    model: string
    file: string
    received: number
    total: number
  } | null>(null)
  const [whisperTranscribing, setWhisperTranscribing] = useState<{ active: boolean; done: number; total: number; failed: number; skipped: number; current: string }>({ active: false, done: 0, total: 0, failed: 0, skipped: 0, current: '' })
  /** 左侧导航当前选中项（右侧只渲染这一节）。 */
  const [activeKey, setActiveKey] = useState<string>(() => initialSection ?? 'detect')
  /** 右侧内容区：切节后回到顶部，否则从上一节的滚动位置接着看会莫名其妙。 */
  const paneRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => { paneRef.current?.scrollTo({ top: 0 }) }, [activeKey])
  /**
   * 富提示写入（本面板唯一的 notify 入口）。
   *
   * 时长按改前原样保留两档：带 details（失败明细清单）12s、其余 5s。
   * 为什么用 `flash(value, ms)` 而不是给 hook 加一个新形态：控制器已经有「写入 + 各自计时 +
   * 重启用新时长」的语义，富提示只是 value 变成了对象（`useTransientNotice<T>` 本来就是泛型）。
   */
  const notify = (kind: 'ok' | 'err', text: string, details?: readonly string[]): void => {
    const rich = Boolean(details && details.length > 0)
    flash({ kind, text, ...(rich ? { details } : {}) }, rich ? 12000 : 5000)
  }

  /** 诊断日志（M6）：GUI 态 stdout 会被丢弃，用户报障时靠这份落盘日志。 */
  const [diagInfo, setDiagInfo] = useState<{ dir: string; bytes: number } | null>(null)
  const refreshDiag = useCallback(async (): Promise<void> => {
    const r = await apiDiagLogInfo()
    if (r.ok && r.dir) {
      setDiagInfo({ dir: r.dir, bytes: (r.files ?? []).reduce((n, f) => n + (f.size || 0), 0) })
    }
  }, [])
  useEffect(() => { void refreshDiag() }, [refreshDiag])
  const exportDiagLog = useCallback(async (): Promise<void> => {
    const r = await apiExportDiagLog()
    if (r.canceled) return
    if (!r.ok) { notify('err', '导出诊断日志失败：' + (r.error ?? '未知原因')); return }
    await refreshDiag()
    notify('ok', `诊断日志已导出（${Math.max(1, Math.round((r.bytes ?? 0) / 1024))} KB）`)
  }, [notify, refreshDiag])
  const revealDiagLog = useCallback(async (): Promise<void> => {
    const r = await apiRevealDiagLog()
    if (!r.ok) notify('err', '打开日志目录失败：' + (r.error ?? '未知原因'))
  }, [notify])

  const load = useCallback(async (): Promise<void> => {
    setCfgLoading(true)
    try {
      const c = await apiGetWechatConfigFull()
      setCfg(c)
      writeRenderCache(SETTINGS_CONFIG_CACHE_KEY, cacheableConfig(c))
      setDbDir(c.db_dir)
      setDbKey(c.db_enc_key)
      setImgAes(c.image_aes_key)
      setImgXor(String(c.image_xor_key))
      setCdnEnabled(c.cdn_enabled)
      setCdnLocal(c.cdn_local_decrypt)
      setWhisperDevice(c.whisper_device)
      setWhisperModel(c.whisper_model)
      setWhisperThreads(c.whisper_threads)
      setWhisperModelsDir(c.whisper_models_dir)
      const k = await apiGetWechatKeysInfo()
      setKeysInfo(k)
    } catch (e) {
      notify('err', (e as Error).message)
    } finally {
      setCfgLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // 老版本写下的渲染缓存里带着密钥：读到就立刻用去掉密钥的版本覆盖（自愈）。
  // 必须独立于 load()：加载失败时那条路径不会回写，残留的明文副本就会一直留在磁盘上。
  useEffect(() => {
    const raw = readRenderCache<Record<string, unknown>>(SETTINGS_CONFIG_CACHE_KEY)
    if (raw && SETTINGS_SECRET_FIELDS.some((k) => k in raw)) {
      writeRenderCache(SETTINGS_CONFIG_CACHE_KEY, cacheableConfig(raw as unknown as WechatConfigFull))
    }
  }, [])

  // 获取「路径配置中心」wechat/config.json 的绝对路径，用于点击打开。
  useEffect(() => {
    void apiGetWechatPathConfig().then(setPathConfigPath)
  }, [])

  const refreshWhisper = async (): Promise<void> => {
    const cached = whisperStatusCache
    if (cached && Date.now() - cached.at < SETTINGS_SCAN_TTL_MS) {
      setWhisperStatus(cached.status)
      return
    }
    setWhisperStatusLoading(true)
    try {
      const s = await apiGetWhisperStatus()
      whisperStatusCache = { at: Date.now(), status: s }
      setWhisperStatus(s)
    } catch (e) {
      notify('err', (e as Error).message)
    } finally {
      setWhisperStatusLoading(false)
    }
  }

  useEffect(() => { runWhenIdle(() => { void refreshWhisper() }) }, [])

  const detect = async (force = false): Promise<void> => {
    const cached = detectCache
    if (!force && cached && Date.now() - cached.at < SETTINGS_SCAN_TTL_MS) {
      setAccounts(cached.accounts)
      setDetectInfo(cached.info)
      setDetectMsg({ kind: 'ok', text: `✓ 检测完成（缓存），发现 ${cached.total} 个微信账号` })
      return
    }
    setDetecting(true)
    try {
      const r = await apiDetectWechatAccounts()
      setAccounts(r.accounts)
      const info: { version?: string; install_dir?: string } = {}
      if (r.version) info.version = r.version
      if (r.install_dir) info.install_dir = r.install_dir
      setDetectInfo(info)
      detectCache = { at: Date.now(), accounts: r.accounts, info, total: r.total }
      setDetectMsg({ kind: 'ok', text: `✓ 检测完成，发现 ${r.total} 个微信账号` })
    } catch (e) {
      setDetectMsg({ kind: 'err', text: '✗ ' + (e as Error).message })
    } finally {
      setDetecting(false)
    }
  }

  // 进入【数据配置】页自动执行一次微信账号检测（空闲时执行 + 60s 缓存）。
  useEffect(() => { runWhenIdle(() => { void detect() }) }, [])

  // 账号检测可能需要扫描安装目录/内存：进入页签已自动执行一次，
  // 之后仍可在步骤 1「检测账号」按钮上手动刷新。
  const useAccount = (a: WechatAccount): void => {
    setDbDir(a.db_dir)
    setDbDirMsg({ kind: 'ok', text: `✓ 已填入账号 ${a.wxid} 的数据库目录，请继续校验密钥` })
    setDbOpMsg(null)
  }

  const pickDbDir = async (): Promise<void> => {
    try {
      const dir = await pickDirectory()
      if (dir) {
        setDbDir(dir)
        setDbDirMsg({ kind: 'ok', text: '✓ 已选择数据库目录，请继续校验密钥' })
      }
    } catch (e) {
      setDbDirMsg({ kind: 'err', text: '✗ ' + (e as Error).message })
    }
  }

  const pickWhisperDir = async (): Promise<void> => {
    try {
      const dir = await pickDirectory()
      if (dir) {
        setWhisperModelsDir(dir)
        setWhisperDirMsg({ kind: 'ok', text: '✓ 已选择模型目录，保存后生效（刷新状态识别模型）' })
      }
    } catch (e) {
      setWhisperDirMsg({ kind: 'err', text: '✗ ' + (e as Error).message })
    }
  }

  const whisperDownload = async (m: { id: string; name: string }): Promise<void> => {
    if (whisperDownloading) { setWhisperDirMsg({ kind: 'err', text: '✗ 已有模型下载任务进行中' }); return }
    setWhisperDirMsg(null)
    setWhisperDownloading({ model: m.id, file: '', received: 0, total: 0 })
    const stopPoll = polls().start(() => {
      void apiGetWhisperStatus()
        .then((s) => {
          if (s.downloading) {
            setWhisperDownloading({
              model: s.downloading.model,
              file: s.downloading.file,
              received: s.downloading.received,
              total: s.downloading.total,
            })
          }
        })
        .catch(() => { /* 忽略单次轮询失败 */ })
    }, 500)
    try {
      const r = await apiDownloadWhisperModel({ model: m.id })
      if (r.ok) {
        setWhisperDirMsg({ kind: 'ok', text: `✓ 模型 ${m.name} 下载完成${r.bytes ? `（${fmtBytes(r.bytes)}）` : ''}，已就绪` })
        await refreshWhisper()
      } else {
        setWhisperDirMsg({ kind: 'err', text: '✗ 模型下载失败：' + (r.error ?? '未知错误') })
      }
    } catch (e) {
      setWhisperDirMsg({ kind: 'err', text: '✗ 模型下载失败：' + (e as Error).message })
    } finally {
      stopPoll()
      setWhisperDownloading(null)
    }
  }

  const batchTranscribe = async (): Promise<void> => {
    if (whisperTranscribing.active) { setVoiceOpMsg({ kind: 'err', text: '✗ 已有转写任务进行中' }); return }
    setVoiceOpMsg(null)
    setWhisperTranscribing({ active: true, done: 0, total: 0, failed: 0, skipped: 0, current: '' })
    const stop = pollTranscribe()
    try {
      const r = await apiTranscribeVoiceBatch({})
      const errs = r.errors.slice(0, 20).map(e => `[${e.svrId}] ${e.error}`)
      if (r.error) {
        setVoiceOpMsg({ kind: 'err', text: '✗ ' + r.error })
      } else if (!r.ok && r.failed > 0) {
        setVoiceOpMsg({ kind: 'err', text: `✗ 转写完成，${r.failed} 条失败（详见列表）` })
        notify('err', `批量转写完成：成功 ${r.done}，失败 ${r.failed}`, errs)
      } else {
        setVoiceOpMsg({ kind: 'ok', text: `✓ 批量转写完成：成功 ${r.done}/${r.total}（跳过 ${r.skipped}，失败 ${r.failed}）` })
        if (errs.length > 0) notify('err', `批量转写完成，${r.failed} 条失败`, errs)
      }
      setWhisperTranscribing({ active: false, done: r.done, total: r.total, failed: r.failed, skipped: r.skipped, current: '' })
    } catch (e) {
      setVoiceOpMsg({ kind: 'err', text: '✗ ' + (e as Error).message })
    } finally {
      stop()
      setWhisperTranscribing(prev => ({ ...prev, active: false }))
    }
  }

  const pollTranscribe = (): (() => void) => polls().start(() => {
      void apiGetWhisperStatus()
        .then((s) => {
          if (s.transcribing.active || s.transcribing.done > 0) {
            setWhisperTranscribing({
              active: s.transcribing.active,
              done: s.transcribing.done,
              total: s.transcribing.total,
              failed: s.transcribing.failed,
              skipped: s.transcribing.skipped,
              current: s.transcribing.current,
            })
          }
        })
        .catch(() => { /* 忽略单次轮询失败 */ })
  }, 500)

  const nativeTranscribe = (): void => {
    setVoiceOpMsg({ kind: 'ok', text: '✓ 微信原生转写文本会在浏览聊天消息时自动复用数据库文字，无需额外批量任务' })
  }

  const skipTranscribe = (): void => {
    setVoiceOpMsg({ kind: 'ok', text: '✓ 已跳过批量转写；聊天页可继续为单条语音转写' })
  }

  const installEngine = async (): Promise<void> => {
    if (whisperDownloading) { setWhisperDirMsg({ kind: 'err', text: '✗ 已有下载任务进行中' }); return }
    if (whisperStatus?.engine) return
    setWhisperDirMsg(null)
    setWhisperDownloading({ model: 'engine', file: '', received: 0, total: 0 })
    const stopPoll = polls().start(() => {
      void apiGetWhisperStatus()
        .then((s) => {
          if (s.downloading) {
            setWhisperDownloading({
              model: s.downloading.model,
              file: s.downloading.file,
              received: s.downloading.received,
              total: s.downloading.total,
            })
          }
        })
        .catch(() => { /* 忽略单次轮询失败 */ })
    }, 500)
    try {
      const r = await apiInstallWhisperEngine()
      if (r.ok) {
        await refreshWhisper()
        setWhisperDirMsg({ kind: 'ok', text: '✓ whisper.cpp 引擎已就绪，可开始批量转写' })
      } else {
        setWhisperDirMsg({ kind: 'err', text: '✗ 引擎下载失败：' + (r.error ?? '未知错误') })
      }
    } catch (e) {
      setWhisperDirMsg({ kind: 'err', text: '✗ 引擎下载失败：' + (e as Error).message })
    } finally {
      stopPoll()
      setWhisperDownloading(null)
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const r = await apiSaveWechatConfig({
        patch: {
          db_dir: dbDir,
          db_enc_key: dbKey,
          image_aes_key: imgAes,
          image_xor_key: Number(imgXor) || 136,
          // cdn_enabled / cdn_local_decrypt 是**真实生效**的开关（N24）：
          // 前者拦下发往 CDN 的取图/取视频请求，后者决定远端字节是否本地解密（见 query/cdn-policy.ts）
          cdn_enabled: cdnEnabled,
          cdn_local_decrypt: cdnLocal,
          whisper_device: whisperDevice,
          whisper_model: whisperModel,
          whisper_threads: Math.max(0, Math.min(whisperThreads, 64)),
          whisper_models_dir: whisperModelsDir,
        },
      })
      if (r.ok) {
        setSaveMsg({ kind: 'ok', text: '✓ 配置已保存' })
        await load()
        await refreshWhisper()
      }
      else setSaveMsg({ kind: 'err', text: '✗ ' + (r.error ?? '保存失败') })
    } catch (e) {
      setSaveMsg({ kind: 'err', text: '✗ ' + (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  const autoGetDb = async (): Promise<void> => {
    setDbGetting(true)
    setDbOpMsg(null)
    try {
      const opts: { dbPath?: string; wechatInstallDir?: string } = {}
      if (dbDir) opts.dbPath = dbDir.replace(/\\+$/, '') + '/session/session.db'
      if (detectInfo.install_dir) opts.wechatInstallDir = detectInfo.install_dir
      const r = await apiAutoGetDbKey(opts)
      if (r.ok && r.key) {
        setDbKey(r.key)
        setDbOpMsg({ kind: 'ok', text: '✓ 已自动获取数据库密钥（' + (r.source ?? 'key_v4_memory') + '），请保存配置' })
        const keysFile = (cfg?.resolved?.keys_file) ?? ''
        if (keysFile && dbDir) {
          const g = await apiGenerateKeysFile({ dbDir, keysFile, encKeyHex: r.key, keyFormat: 'wx_key_v4.1' })
          setDbOpMsg({ kind: 'ok', text: `✓ 已获取数据库密钥 · 已生成密钥映射 ${g.verified}/${g.total} 个数据库` })
          const k = await apiGetWechatKeysInfo()
          setKeysInfo(k)
        }
      } else {
        setDbOpMsg({ kind: 'err', text: '✗ ' + (r.error ?? '自动获取失败') })
      }
    } catch (e) {
      setDbOpMsg({ kind: 'err', text: '✗ ' + (e as Error).message })
    } finally {
      setDbGetting(false)
    }
  }

  const autoGetImg = async (): Promise<void> => {
    setImgGetting(true)
    setImgOpMsg(null)
    try {
      const imgOpts: { accountDir?: string } = {}
      if (dbDir) {
        // db_dir 指向 db_storage,而 V2 模板缓存位于账号根目录的 msg/attach 下。
        const dir = dbDir.replace(/[\\/]+$/, '')
        imgOpts.accountDir = (dir.split(/[\\/]/).pop() ?? '').toLowerCase() === 'db_storage' ? dir.replace(/[\\/][^\\/]+$/, '') : dir
      }
      const r = await apiAutoGetImageKey(imgOpts)
      if (r.ok && r.aesKey !== undefined && r.xorKey !== undefined) {
        setImgAes(r.aesKey)
        setImgXor(String(r.xorKey))
        setImgOpMsg({ kind: 'ok', text: '✓ 已自动获取图片密钥（V2 验证）' })
      } else {
        setImgOpMsg({ kind: 'err', text: '✗ ' + (r.error ?? '自动获取图片密钥失败') })
      }
    } catch (e) {
      setImgOpMsg({ kind: 'err', text: '✗ ' + (e as Error).message })
    } finally {
      setImgGetting(false)
    }
  }

  const verifyDb = async (): Promise<void> => {
    if (!dbDir) { setDbOpMsg({ kind: 'err', text: '✗ 请先选择数据库目录' }); return }
    if (!dbKey.trim()) { setDbOpMsg({ kind: 'err', text: '✗ 请输入 PBKDF2 口令' }); return }
    try {
      const dbPath = dbDir.replace(/\\+$/, '') + '/session/session.db'
      const v = await apiVerifyDatabaseKey({ dbPath, encKeyHex: dbKey.trim() })
      if (v.valid) {
        const keysFile = (cfg?.resolved?.keys_file) ?? ''
        if (keysFile) {
          const g = await apiGenerateKeysFile({ dbDir, keysFile, encKeyHex: dbKey.trim(), keyFormat: 'wx_key_v4.1' })
          setDbOpMsg({ kind: 'ok', text: `✓ 校验通过 (wx_key_v4.1) · 已生成密钥映射 ${g.verified}/${g.total} 个数据库` })
          const k = await apiGetWechatKeysInfo()
          setKeysInfo(k)
        } else {
          setDbOpMsg({ kind: 'ok', text: '✓ 校验通过 (wx_key_v4.1)' })
        }
      } else {
        setDbOpMsg({ kind: 'err', text: '✗ 密钥不正确' })
      }
    } catch (e) {
      setDbOpMsg({ kind: 'err', text: '✗ ' + (e as Error).message })
    }
  }

  const verifyImg = async (): Promise<void> => {
    if (!imgAes.trim()) { setImgOpMsg({ kind: 'err', text: '✗ 请先填写图片 AES 密钥' }); return }
    try {
      const r = await apiVerifyImageKey()
      if (r.verified) {
        setImgOpMsg({ kind: 'ok', text: `✓ 图片密钥验证通过（XOR 0x${(r.xorKey ?? 0).toString(16).toUpperCase()}）` })
      } else {
        setImgOpMsg({ kind: 'err', text: '✗ ' + (r.error ?? '图片密钥不正确') })
      }
    } catch (e) {
      setImgOpMsg({ kind: 'err', text: '✗ ' + (e as Error).message })
    }
  }

  /** 轮询解密进度(op 匹配或仍在进行中才应用),返回停止函数。 */
  const pollDecrypt = (apply: (s: {
    active: boolean
    done: number
    total: number
    failed: number
    skipped: number
    message: string
  }) => void): (() => void) => polls().start(() => {
    void apiGetDecryptStatus()
      .then((s) => {
        if (s.active || s.done > 0) apply(s)
      })
      .catch(() => { /* 忽略单次轮询失败 */ })
  }, 400)

  const decryptAll = async (): Promise<void> => {
    setDecrypting(true)
    setDbProgress({ active: true, done: 0, total: 0, failed: 0, message: '准备中…' })
    const stop = pollDecrypt((s) => {
      setDbProgress({ active: s.active, done: s.done, total: s.total, failed: s.failed, message: s.message })
    })
    try {
      const r = await apiDecryptAllDatabases()
      const failedItems = r.failed.map(f => `${f.db} — ${f.error}`)
      if (r.ok) {
        notify('ok', `解密完成：成功 ${r.okCount}/${r.total} 个数据库`, failedItems)
      } else if (r.error) {
        notify('err', r.error, failedItems)
      } else {
        notify('err', `解密完成，但 ${r.failed.length} 个数据库失败`, failedItems)
      }
      setDbProgress({ active: false, done: r.okCount + r.failed.length, total: r.total, failed: r.failed.length, message: '' })
    } catch (e) {
      notify('err', (e as Error).message)
    } finally {
      stop()
      setDecrypting(false)
    }
  }

  const decryptImgs = async (): Promise<void> => {
    setImgDecrypting(true)
    setImgProgress({ active: true, done: 0, total: 0, failed: 0, skipped: 0, message: '准备中…' })
    const stop = pollDecrypt((s) => {
      setImgProgress({ active: s.active, done: s.done, total: s.total, failed: s.failed, skipped: s.skipped, message: s.message })
    })
    try {
      const concurrency = Number.isFinite(imgConcurrency) && imgConcurrency >= 1 && imgConcurrency <= 32 ? imgConcurrency : 8
      const r = await apiDecryptAllImages({ concurrency })
      setImgDecryptDetail({ errors: r.errors ?? [], skippedDetails: r.skippedDetails ?? [] })
      const failedItems = r.errors.map(f => `${f.file} — ${f.error}`)
      if (r.ok) {
        notify('ok', `图片解密完成：成功 ${r.okCount}/${r.total}（跳过 ${r.skipped}，失败 ${r.failed}）`, failedItems)
      } else {
        notify('err', r.error ?? '图片解密失败', failedItems)
      }
      setImgProgress({ active: false, done: r.okCount + r.failed + r.skipped, total: r.total, failed: r.failed, skipped: r.skipped, message: '' })
    } catch (e) {
      notify('err', (e as Error).message)
    } finally {
      stop()
      setImgDecrypting(false)
    }
  }

  const toggleCdn = async (enabled: boolean): Promise<void> => {
    try { await apiSetCdnImageEnabled({ enabled }); setCdnEnabled(enabled); setCdnMsg({ kind: 'ok', text: `✓ 已${enabled ? '开启' : '关闭'}自动获取原图` }) }
    catch (e) { setCdnMsg({ kind: 'err', text: '✗ ' + (e as Error).message }) }
  }

  const toggleCdnLocal = async (local: boolean): Promise<void> => {
    try { await apiSetCdnImageLocalDecrypt({ localDecrypt: local }); setCdnLocal(local); setCdnMsg({ kind: 'ok', text: local ? '✓ 原图解密方式：本地解密' : '✓ 原图解密方式：服务端解密' }) }
    catch (e) { setCdnMsg({ kind: 'err', text: '✗ ' + (e as Error).message }) }
  }

  const keyOk = keysInfo.loaded && keysInfo.keyCount > 0
  const dbFiles = accounts.reduce((sum, a) => sum + (a.db_files ?? 0), 0)
  const current = (a: WechatAccount): boolean => dbDir !== '' && dbDir.toLowerCase() === a.db_dir.toLowerCase()

  const stepStates: Record<(typeof STEPS)[number]['key'], StepState> = {
    detect: accounts.length > 0 || dbDir.trim() !== '' ? 'done' : 'todo',
    dbkey: keyOk || dbKey.trim() !== '' ? 'done' : 'todo',
    imgkey: imgAes.trim() !== '' ? 'done' : 'todo',
    img: cdnEnabled ? 'done' : 'todo',
    voice: whisperStatus?.engine ? 'done' : 'note',
  }

  const stepLabel = (state: StepState): string => state === 'done' ? '已完成' : state === 'note' ? '说明' : '待配置'

  // ── 左右结构：左侧导航项 + 右侧只渲染当前一节 ──
  // 原来 5 张速览卡横排在顶部、5 个分节在下面一路堆叠，一屏看不全、还要靠滚动找；
  // 改成竖排导航项（状态与摘要就在项上），右侧一次只显示一节。
  const stepValueOf = (key: (typeof STEPS)[number]['key']): string => key === 'detect'
    ? `${accounts.length} 个账号`
    : key === 'dbkey'
      ? (keyOk ? `${keysInfo.keyCount} 个密钥` : '未配置')
      : key === 'imgkey'
        ? (imgAes.trim() ? '已就绪' : '未配置')
        : key === 'img'
          ? (cdnEnabled ? '已启用' : '未启用')
          : (whisperStatus?.engine ? '引擎就绪' : '待配置')

  type NavKey = (typeof STEPS)[number]['key']
    | 'ai' | 'boundary' | 'privacy' | 'license' | 'update' | 'backup' | 'health' | 'hook' | 'oplog' | 'advanced'
  /**
   * 左导航条目（14 节，分四组）。
   *
   * 「智能与隐私」「授权与维护」两组共 8 节都是 2026-09 从外层侧栏迁进来的（AI 大模型、
   * 数据边界与出网、隐私体检、软件授权、备份恢复、数据库健康、原图链路自检、操作日志）：
   * 它们要么是配置，要么是维护与自检，本来就不该和「看数据」的页签挤在一个侧栏里。
   * 侧栏因此从 17 项收到 12 项（含底部固定的「设置」）。
   */
  const navItems: Array<{ key: NavKey; group: string; label: string; icon: React.ReactNode; value: string; dot?: 'done' | 'warning' | 'ongoing' }> = [
    ...STEPS.map((s) => ({
      key: s.key as NavKey,
      group: '配置向导',
      label: s.label,
      icon: STEP_ICONS[s.key],
      value: stepValueOf(s.key),
      dot: (stepStates[s.key] === 'done' ? 'done' : stepStates[s.key] === 'note' ? 'warning' : 'ongoing') as 'done' | 'warning' | 'ongoing',
    })),
    { key: 'ai', group: '智能与隐私', label: 'AI 大模型', icon: <IconSparkle16 size={14} />, value: '问答模型与向量模型' },
    { key: 'boundary', group: '智能与隐私', label: '数据边界与出网', icon: STEP_ICONS.boundary, value: '本地/出网边界 · 审计' },
    { key: 'privacy', group: '智能与隐私', label: '隐私体检', icon: STEP_ICONS.privacy, value: '敏感信息扫描' },
    { key: 'license', group: '授权与维护', label: '软件授权', icon: <IconPersonalizationOutline16 size={14} />, value: '许可证状态' },
    { key: 'update', group: '授权与维护', label: '软件更新', icon: <IconRefreshOutline14 size={14} />, value: '自动更新 · 手动检查' },
    { key: 'backup', group: '授权与维护', label: '备份恢复', icon: STEP_ICONS.backup, value: '本地快照 · 创建/恢复' },
    { key: 'health', group: '授权与维护', label: '数据库健康', icon: STEP_ICONS.health, value: '占用与完整性检查' },
    { key: 'hook', group: '授权与维护', label: '原图链路自检', icon: STEP_ICONS.hook, value: '本地解码自检' },
    { key: 'oplog', group: '授权与维护', label: '操作日志', icon: STEP_ICONS.oplog, value: '仅操作元数据' },
    { key: 'advanced', group: '高级', label: '高级设置', icon: <IconSettingsOutline14 size={14} />, value: '输出目录 · 启动引导' },
  ]

  /**
   * 弹窗内各面板的跳转：能落在本弹窗某节的就切节（不关弹窗），
   * 其余的（文件资产 / 存储分析）交回宿主，由它关弹窗再切主内容区。
   */
  const SECTION_OF_TAB: Readonly<Record<string, string>> = {
    settings: 'detect', privacytrust: 'boundary', privacy: 'privacy',
    backup: 'backup', health: 'health', hook: 'hook', oplog: 'oplog',
  }
  const innerNavigate = useCallback((tab: string): void => {
    const key = SECTION_OF_TAB[tab]
    if (key) { setActiveKey(key); return }
    onNavigateOut?.(tab)
  }, [onNavigateOut])

  return (
    <div className={css.root} data-in-dialog={inDialog || undefined}>
      {!inDialog && (
        <PanelHeader
          title={(
            <>
              <IconSettingsOutline14 size={16} />
              微信数据配置
            </>
          )}
          desc="本地检测 · 数据库密钥 · 图片密钥 · 图片解码 · 语音转写"
        />
      )}
      {/* 左导航 + 右内容：原来 5 张速览卡横排在顶部、下面 5 节一路堆叠，一屏看不全还要滚动找。 */}
      <div className={css.layout}>
        <nav className={css.navRail} aria-label="设置导航">
          {navItems.map((it, i) => {
            const prev = i > 0 ? navItems[i - 1] : undefined
            return (
              <Fragment key={it.key}>
                {prev?.group !== it.group && <div className={css.navGroupLabel}>{it.group}</div>}
                <button
                  type="button"
                  className={clsx(css.navItem, activeKey === it.key && css.navItemActive)}
                  onClick={() => { setActiveKey(it.key) }}
                  aria-current={activeKey === it.key ? 'true' : undefined}
                  title={it.label}
                >
                  <span className={css.navIcon}>{it.icon}</span>
                  <span className={css.navBody}>
                    <span className={css.navLabel}>{it.label}</span>
                    <span className={css.navValue}>{it.value}</span>
                  </span>
                  {it.dot ? <StateDot state={it.dot} /> : null}
                </button>
              </Fragment>
            )
          })}
        </nav>

        <div className={css.mainScroll} ref={paneRef}>

      {message && (
        <div className={clsx(css.notice, message.kind === 'ok' ? css.toastOk : css.toastErr)}>
          <div className={css.noticeHead}>
            <span className={css.noticeText}>{message.text}</span>
            <button type="button" className={css.noticeClose} onClick={() => { clear() }} aria-label="关闭提示">✕</button>
          </div>
          {message.details && message.details.length > 0 && (
            <div className={css.noticeDetails}>
              {message.details.slice(0, 20).map((d, i) => <div key={i} className={css.noticeDetailItem}>{d}</div>)}
              {message.details.length > 20 && <div className={css.noticeDetailMore}>…仅显示前 20 条</div>}
            </div>
          )}
        </div>
      )}

        {/* ── 1. 检测账号 ── */}
        <section
          className={css.card}
          hidden={activeKey !== 'detect'}
        >
          <header className={css.cardHd}>
            <span className={css.cardIconChip}><IconGlobeOutline14 size={14} /></span>
            <div className={css.cardTitleBox}>
              <span className={css.cardTitle}>检测账号</span>
              <span className={kitCss.textCaptionTrunc}>扫描本机微信账号与安装目录</span>
            </div>
            <span className={css.cardBadge}>
              <StateDot state={accounts.length > 0 ? 'done' : 'warning'} />
              {accounts.length > 0 ? `${accounts.length} 个账号` : '未检测到微信'}
            </span>
          </header>
          <div className={css.cardBody}>
            <div className={css.stats}>
              <div className={css.statChip}><span className={css.statNum}>{detectInfo.version ?? '—'}</span><span className={kitCss.textCaption}>微信版本</span></div>
              <div className={css.statChip}>
                <span className={css.statNum}>{String(accounts.length)}</span>
                <span className={kitCss.textCaption}>检测账号</span>
              </div>
              <div className={css.statChip}>
                <span className={css.statNum}>{String(dbFiles)}</span>
                <span className={kitCss.textCaption}>数据库文件</span>
              </div>
            </div>
            <div className={css.row}>
              <span className={css.rowName}>微信账号检测</span>
              <Button size="sm" variant="outline" className={clsx(css.btnFx, css.btnFixedSm)} icon={detecting ? <span className={css.spin} /> : undefined} onClick={() => { void detect(true) }} disabled={detecting}>
                {detecting ? '检测中…' : '检测本机微信账号'}
              </Button>
            </div>
            <MsgSlot
              placeholder="点击「检测本机微信账号」后，结果实时显示在这里"
              msg={detectMsg}
            />
            <div className={css.row}>
              <span className={css.rowName}>微信安装目录</span>
              <span className={css.rowMeta} title={detectInfo.install_dir ?? ''}>{detectInfo.install_dir ?? '检测中…'}</span>
            </div>
            <div className={css.accounts}>
              {accounts.length > 0 ? accounts.map(a => (
                <div key={a.db_dir} className={clsx(css.acct, current(a) && css.acctCurrent)}>
                  <AccountAvatar wxid={a.wxid} />
                  <div className={css.acctMain}>
                    <div className={css.acctTop}>
                      <span className={css.acctName}>{a.wxid}</span>
                      {current(a) && <span className={css.acctBadge}>当前使用</span>}
                    </div>
                    <span className={kitCss.textCaptionTrunc}>
                      {a.db_files !== undefined ? `${a.db_files} 个库文件` : '库文件未知'} · 最近活动 {fmtActive(a.last_active)} · 路径已确认
                    </span>
                    <span className={css.acctPath} title={a.db_dir}>{a.db_dir}</span>
                  </div>
                  <Button size="sm" variant={current(a) ? 'ghost' : 'primary'} className={clsx(css.btnFx, css.btnFixedSm)} onClick={() => { useAccount(a) }} disabled={current(a)}>
                    {current(a) ? '当前使用' : '使用此账号'}
                  </Button>
                </div>
              )) : (
                <div className={css.accountsEmpty}>点击「检测本机微信账号」后，可操作的账号将显示在这里</div>
              )}
            </div>
            <div className={css.row}>
              <span className={css.rowName}>数据库目录</span>
              <Input className={css.input} value={dbDir} onChange={(e) => { setDbDir(e.target.value) }} placeholder="留空自动检测本机微信账号" />
              <Button size="sm" variant="outline" className={clsx(css.btnFx, css.btnFixedSm)} onClick={() => { void pickDbDir() }}>选择…</Button>
            </div>
            <MsgSlot
              placeholder="点击「选择…」或账号卡「使用此账号」后，结果实时显示在这里"
              msg={dbDirMsg}
            />
          </div>
        </section>

        {/* ── 2. 数据库密钥 ── */}
        <section
          className={css.card}
          hidden={activeKey !== 'dbkey'}
        >
          <header className={css.cardHd}>
            <span className={css.cardIconChip}><IconPersonalizationOutline16 size={14} /></span>
            <div className={css.cardTitleBox}>
              <span className={css.cardTitle}>数据库密钥</span>
              <span className={kitCss.textCaptionTrunc}>64 位密钥、密钥映射与全库解密</span>
            </div>
            <span className={css.cardBadge}>
              <StateDot state={keyOk ? 'done' : 'warning'} />
              {keyOk ? `${keysInfo.keyCount} 个密钥` : '尚未加载密钥文件'}
            </span>
          </header>
          <div className={css.cardBody}>
            <div className={css.row}>
              <span className={css.rowName}>数据库密钥</span>
              <Input className={css.input} value={dbKey} onChange={(e) => { setDbKey(e.target.value) }} placeholder="64 位 hex 主密钥 / 口令" />
              <Button size="sm" variant="primary" className={clsx(css.btnFx, css.btnFixed)} icon={dbGetting ? <span className={css.spin} /> : undefined} onClick={() => { void autoGetDb() }} disabled={dbGetting}>
                {dbGetting ? '获取中…' : '一键获取数据库密钥'}
              </Button>
              <Button size="sm" variant="outline" className={clsx(css.btnFx, css.btnFixedSm)} onClick={() => { void verifyDb() }} disabled={dbGetting}>
                校验
              </Button>
            </div>
            <MsgSlot
              placeholder="点击「一键获取数据库密钥」或「校验」后，结果实时显示在这里"
              msg={dbOpMsg}
            />
            <div className={css.row}>
              <span className={css.rowName}>密钥文件概览</span>
              <span className={css.rowMeta}>{keyOk ? `${keysInfo.keyFormat ?? ''} · ${keysInfo.keyCount} 个密钥` : '尚未加载密钥文件'}</span>
            </div>
            <div className={css.row}>
              <span className={css.rowName}>立即解密</span>
              <span className={css.rowMeta}>将 db_storage 下全部 .db 解密写入解密库目录</span>
              <Button size="sm" variant="primary" className={clsx(css.btnFx, css.btnFixed)} icon={decrypting ? <span className={css.spin} /> : undefined} onClick={() => { void decryptAll() }} disabled={decrypting}>
                {decrypting ? '解密中…' : '立即解密'}
              </Button>
            </div>
            <StatusSlot
              placeholder="点击「立即解密」开始，进度与结果实时显示在这里"
              active={dbProgress.active}
              pct={dbProgress.total > 0 ? Math.round((dbProgress.done / dbProgress.total) * 100) : 0}
              text={`解密 ${dbProgress.done}/${dbProgress.total} · 成功 ${dbProgress.done - dbProgress.failed} · 失败 ${dbProgress.failed}`}
              item={dbProgress.message}
              doneText={dbProgress.done > 0 ? `上次解密：成功 ${dbProgress.done - dbProgress.failed}/${dbProgress.total} · 失败 ${dbProgress.failed}` : ''}
              doneKind=""
            />
            <div className={css.row}>
              <span className={css.rowNote}>✅ 自动获取密钥已支持（V4 内存扫描 + Weixin.dll 内部键解掩码，需微信进程运行中）；SQLCipher 全库解密通过「立即解密」完成。</span>
            </div>
          </div>
        </section>

        {/* ── 3. 图片密钥 ── */}
        <section
          className={css.card}
          hidden={activeKey !== 'imgkey'}
        >
          <header className={css.cardHd}>
            <span className={css.cardIconChip}><IconSparkle16 size={14} /></span>
            <div className={css.cardTitleBox}>
              <span className={css.cardTitle}>图片密钥</span>
              <span className={kitCss.textCaptionTrunc}>AES 密钥与 XOR 偏移量管理</span>
            </div>
            <span className={css.cardBadge}>
              <StateDot state={imgAes.trim() !== '' ? 'done' : 'warning'} />
              {imgAes.trim() !== '' ? '已就绪' : '未配置'}
            </span>
          </header>
          <div className={css.cardBody}>
            <div className={css.row}>
              <span className={css.rowName}>图片 AES 密钥</span>
              <Input className={css.input} value={imgAes} onChange={(e) => { setImgAes(e.target.value) }} placeholder="32 位 hex（留空自动）" />
              <Button size="sm" variant="primary" className={clsx(css.btnFx, css.btnFixed)} icon={imgGetting ? <span className={css.spin} /> : undefined} onClick={() => { void autoGetImg() }} disabled={imgGetting}>
                {imgGetting ? '获取中…' : '扫描微信内存'}
              </Button>
              <Button size="sm" variant="outline" className={clsx(css.btnFx, css.btnFixedSm)} onClick={() => { void verifyImg() }} disabled={imgGetting}>
                校验
              </Button>
            </div>
            <div className={css.row}>
              <span className={css.rowName}>XOR key</span>
              <Input className={css.inputNarrow} value={imgXor} onChange={(e) => { setImgXor(e.target.value) }} />
            </div>
            <MsgSlot
              placeholder="点击「扫描微信内存」或「校验」后，结果实时显示在这里"
              msg={imgOpMsg}
            />
            <div className={css.row}>
              <span className={css.rowNote}>✅ 自动获取已支持（V2 模板验证内存扫描，需微信进程运行中）；填写后点击保存即可用于图片离线解码。</span>
            </div>
          </div>
        </section>

        {/* ── 4. 图片解码 ── */}
        <section
          className={css.card}
          hidden={activeKey !== 'img'}
        >
          <header className={css.cardHd}>
            <span className={css.cardIconChip}><IconGlobeOutline14 size={14} /></span>
            <div className={css.cardTitleBox}>
              <span className={css.cardTitle}>图片解码</span>
              <span className={kitCss.textCaptionTrunc}>批量解密 .dat 到本地解码缓存</span>
            </div>
            <span className={css.cardBadge}>
              <StateDot state={cdnEnabled ? 'done' : 'warning'} />
              {cdnEnabled ? '已启用' : '未启用'}
            </span>
          </header>
          <div className={css.cardBody}>
            <div className={css.row}>
              <span className={css.rowName}>自动获取原图（CDN）</span>
              <Pill active={cdnEnabled}>{cdnEnabled ? '已开启' : '已关闭'}</Pill>
              <Button size="sm" variant="outline" className={clsx(css.btnFx, css.btnFixedSm)} onClick={() => { void toggleCdn(!cdnEnabled) }}>{cdnEnabled ? '关闭' : '开启'}</Button>
            </div>
            <div className={css.row}>
              <span className={css.rowName}>原图解密方式</span>
              <Pill active={cdnLocal}>{cdnLocal ? '本地解密' : '服务端解密'}</Pill>
              <Button size="sm" variant="outline" className={clsx(css.btnFx, css.btnFixedSm)} onClick={() => { void toggleCdnLocal(!cdnLocal) }}>{cdnLocal ? '切换服务端' : '切换本地'}</Button>
            </div>
            <MsgSlot
              placeholder="点击「开启/关闭」「切换服务端/本地」后，结果实时显示在这里"
              msg={cdnMsg}
            />
            <div className={css.row}>
              <span className={css.rowName}>批量解密图片</span>
              <span className={css.rowMeta} title="解密 msg/attach 下所有 .dat 图片到解码缓存，聊天/朋友圈图片即时显示">解密 msg/attach 全部 .dat 到解码缓存</span>
              <Input className={css.inputNarrow} value={String(imgConcurrency)} onChange={(e) => { setImgConcurrency(Number(e.target.value) || 8) }} title="并行线程数" />
              <Button size="sm" variant="primary" className={clsx(css.btnFx, css.btnFixed)} icon={imgDecrypting ? <span className={css.spin} /> : undefined} onClick={() => { void decryptImgs() }} disabled={imgDecrypting}>
                {imgDecrypting ? '解密中…' : '立即解密'}
              </Button>
            </div>
            <StatusSlot
              placeholder="点击「立即解密」开始，进度与结果实时显示在这里"
              active={imgProgress.active}
              pct={imgProgress.total > 0 ? Math.round((imgProgress.done / imgProgress.total) * 100) : 0}
              text={`解密 ${imgProgress.done}/${imgProgress.total} · 成功 ${imgProgress.done - imgProgress.failed - imgProgress.skipped} · 跳过 ${imgProgress.skipped} · 失败 ${imgProgress.failed}`}
              item={imgProgress.message}
              doneText={imgProgress.done > 0 ? `上次解密：成功 ${imgProgress.done - imgProgress.failed - imgProgress.skipped}/${imgProgress.total} · 跳过 ${imgProgress.skipped} · 失败 ${imgProgress.failed}` : ''}
              doneKind=""
              detail={imgProgress.done > 0 && (imgDecryptDetail.errors.length > 0 || imgDecryptDetail.skippedDetails.length > 0)
                ? <button type="button" className={css.slotDetailBtn} onClick={() => { setImgDetailOpen(true) }}>详情</button>
                : undefined}
            />
            <div className={css.row}>
              <span className={css.rowNote}>✅ 朋友圈/聊天图片离线解码已支持（本地缓存 .dat 解密）；高清原图与表情批量转码为后续本地能力。HEVC/视频格式自动跳过。</span>
            </div>
          </div>
        </section>

        {/* ── 5. 语音转写 ── */}
        <section
          className={css.card}
          hidden={activeKey !== 'voice'}
        >
          <header className={css.cardHd}>
            <span className={css.cardIconChip}><IconSparkle16 size={14} /></span>
            <div className={css.cardTitleBox}>
              <span className={css.cardTitle}>语音转写（可选）</span>
              <span className={kitCss.textCaptionTrunc}>whisper 引擎与模型管理</span>
            </div>
            <span className={css.cardBadge}>
              <StateDot state={whisperStatus?.engine ? 'done' : 'warning'} />
              {whisperStatus?.engine ? '引擎已就绪' : '待配置引擎'}
            </span>
          </header>
          <div className={css.cardBody}>
            <div className={css.whisperBanner}>
              <div className={css.whisperBannerText}>
                <span className={css.whisperBannerTitle}>本地处理，不上传语音</span>
                <span className={css.whisperBannerDesc}>
                  已由微信转写的语音会直接复用数据库文字；其余语音才会交给本地 Whisper，需 whisper.cpp 引擎。
                </span>
              </div>
              <button type="button" className={css.whisperRefresh} onClick={() => { void refreshWhisper() }} disabled={whisperStatusLoading}>
                {whisperStatusLoading ? '检测中…' : '刷新状态'}
              </button>
            </div>
            <div className={css.row}>
              <span className={css.rowName}>转写引擎</span>
              <span className={css.rowMeta} title={whisperStatus?.enginePath ?? ''}>
                {whisperStatusLoading ? '检测中…' : whisperStatus?.engine
                  ? `已就绪（${whisperStatus.enginePath ?? whisperStatus.engine}）`
                  : '未检测到 whisper.cpp 引擎，可一键下载'}
              </span>
              <Button size="sm" variant="outline" className={clsx(css.btnFx, css.btnFixed)} icon={whisperDownloading?.model === 'engine' ? <span className={css.spin} /> : undefined}
                disabled={whisperDownloading !== null || Boolean(whisperStatus?.engine)} onClick={() => { void installEngine() }}>
                {whisperDownloading?.model === 'engine' ? '下载中…' : whisperStatus?.engine ? '已安装' : '下载引擎'}
              </Button>
            </div>
            <div className={css.row}>
              <span className={css.rowName}>推理设备</span>
              <span className={css.rowMeta}>CPU 兼容所有设备；NVIDIA GPU 使用 CUDA 加速，失败会自动回退 CPU。</span>
            </div>
            <div className={css.row}>
              <span className={css.rowName}>当前设备</span>
              <div className={css.deviceSeg}>
                <button type="button" className={clsx(css.deviceSegBtn, whisperDevice === 'cpu' && css.deviceSegOn)} onClick={() => { setWhisperDevice('cpu') }}>CPU</button>
                <button type="button" className={clsx(css.deviceSegBtn, whisperDevice === 'gpu' && css.deviceSegOn)} disabled={!whisperStatus?.hasCuda} title={whisperStatus?.hasCuda ? 'NVIDIA GPU（CUDA 加速）' : '未检测到可用的 NVIDIA CUDA 设备或驱动'} onClick={() => { setWhisperDevice('gpu') }}>NVIDIA GPU</button>
              </div>
              <span className={clsx(css.rowMeta, !whisperStatus?.hasCuda && css.rowMetaWarn)}>
                {whisperStatus?.hasCuda ? 'CUDA 可用' : '未检测到可用的 NVIDIA CUDA 设备或驱动。'}
              </span>
            </div>
            <div className={css.row}>
              <span className={css.rowName}>模型目录</span>
              <Input className={css.input} value={whisperModelsDir} onChange={(e) => { setWhisperModelsDir(e.target.value) }} placeholder="留空使用默认目录（<项目>/wechat/whisper）" />
              <Button size="sm" variant="outline" className={clsx(css.btnFx, css.btnFixedSm)} onClick={() => { void pickWhisperDir() }}>选择…</Button>
              <Button size="sm" variant="outline" className={clsx(css.btnFx, css.btnFixedSm)} onClick={() => { const d = whisperModelsDir.trim(); if (d) void apiOpenPath(d) }}>打开</Button>
            </div>
            <MsgSlot
              placeholder="点击「选择…/下载」后，结果实时显示在这里"
              msg={whisperDirMsg}
            />
            <div className={css.gridHd}>
              <span className={css.gridHdTitle}>选择模型</span>
              <span className={kitCss.textCaption}>当前设备：{whisperDevice === 'gpu' ? 'NVIDIA GPU' : 'CPU'}</span>
            </div>
            <div className={css.modelGrid}>
              {(whisperStatus?.models ?? WHISPER_MODEL_FALLBACK).map((m) => {
                const selected = whisperModel === m.id
                const downloading = whisperDownloading?.model === m.id
                const pct = downloading && whisperDownloading.total > 0
                  ? Math.round((whisperDownloading.received / whisperDownloading.total) * 100)
                  : 0
                return (
                  // 外层原先是个 <button>，「下载」动作是它内部的一个 <span onClick> ——
                  // 交互元素嵌在按钮里是**无效 HTML**，且键盘无法触发下载。
                  // 改成 div + clickableKey（选模型）与并列的真 <button>（下载），两个动作各自可达。
                  <div
                    key={m.id}
                    className={clsx(css.modelCard, selected && css.modelSelected, downloading && css.modelDownloadingCard)}
                    {...clickableKey(() => { setWhisperModel(m.id) })}
                  >
                    <span className={css.modelName}>{m.name}{selected && <span className={css.modelTag}>已选择</span>}</span>
                    <span className={css.modelBadge}>
                      {downloading
                        ? <span className={css.modelStateDownloading}>下载中</span>
                        : m.installed
                          ? <span className={css.modelStateInstalled}>✓ 已安装</span>
                          : <span className={css.modelState}>需下载</span>}
                    </span>
                    <span className={kitCss.textCaption}>{m.sizeLabel}</span>
                    {downloading ? (
                      <span className={css.modelProgress}>
                        <span className={css.modelProgressTrack}><span className={css.modelProgressFill} style={{ width: `${Math.max(2, pct)}%` }} /></span>
                        <span className={css.modelProgressPct}>{pct}%</span>
                      </span>
                    ) : m.installed ? (
                      <span className={clsx(css.modelDownload, css.modelDownloadDone)}>已就绪</span>
                    ) : (
                      <button
                        type="button"
                        className={css.modelDownload}
                        onClick={() => { void whisperDownload(m) }}
                      >
                        下载
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
            <div className={css.row}>
              <span className={css.rowNote}>
                {whisperStatus?.models.some(m => m.installed)
                  ? `已安装 ${whisperStatus.models.filter(m => m.installed).length} 个模型到本机缓存，点击「下载」可继续获取其他模型。`
                  : '模型从官方仓库下载（huggingface.co，失败自动切换 hf-mirror；可用环境变量 DSH_WECHAT_WHISPER_MIRROR 指定镜像）。'}
              </span>
            </div>
            <div className={css.whisperThreads}>
              <span className={css.whisperThreadsLabel}>并发线程数</span>
              <Input className={css.inputNarrow} value={String(whisperThreads)} onChange={(e) => { setWhisperThreads(Math.max(0, Number(e.target.value) || 0)) }} placeholder="0" />
              <span className={css.rowMeta}>0 自动，输入正整数</span>
            </div>
            <div className={css.row}>
              <span className={css.rowNote}>{'🔒 模型仅本地推理，不上传语音；语音由内置 SILK 解码器本地转 WAV，转写由 whisper-cli 执行（需 ' +
                'DSH_WECHAT_WHISPER_BIN 指向引擎且模型已安装）。'}</span>
            </div>
            <div className={css.whisperFooter}>
              <button type="button" className={css.whisperSkip} onClick={() => { skipTranscribe() }}>跳过，查看聊天记录</button>
              <Button variant="primary" className={clsx(css.btnFx, css.btnFixed)} icon={whisperTranscribing.active ? <span className={css.spin} /> : undefined} disabled={whisperTranscribing.active} onClick={() => { void batchTranscribe() }}>
                {whisperTranscribing.active ? '转写中…' : '本地批量转文字'}
              </Button>
              <Button variant="outline" className={clsx(css.btnFx, css.btnFixed)} onClick={() => { nativeTranscribe() }}>
                微信原生批量转文字
              </Button>
            </div>
            <StatusSlot
              placeholder="点击「本地批量转文字」后，转写进度实时显示在这里"
              active={whisperTranscribing.active}
              pct={whisperTranscribing.total > 0 ? Math.round((whisperTranscribing.done / whisperTranscribing.total) * 100) : 0}
              text={`转写 ${whisperTranscribing.done}/${whisperTranscribing.total} · 成功 ${whisperTranscribing.done} · 跳过 ${whisperTranscribing.skipped} · 失败 ${whisperTranscribing.failed}`}
              item={whisperTranscribing.current}
              doneText={voiceOpMsg?.text ?? (whisperTranscribing.done > 0 ? `上次转写：成功 ${whisperTranscribing.done}/${whisperTranscribing.total} · 跳过 ${whisperTranscribing.skipped} · 失败 ${whisperTranscribing.failed}` : '')}
              doneKind={voiceOpMsg?.kind ?? ''}
            />
          </div>
        </section>

        {/* ── AI 大模型（全应用唯一的模型配置入口） ── */}
        <div hidden={activeKey !== 'ai'}><AiModelConfig /></div>

        {/* ── 数据边界与出网（原外层侧栏的独立页，整页迁入本弹窗） ── */}
        <div className={css.embedPane} hidden={activeKey !== 'boundary'}>
          <PrivacyTrustPanel embedded />
        </div>

        {/* ── 隐私体检（同上；命中样本可跳回对应会话） ── */}
        <div className={css.embedPane} hidden={activeKey !== 'privacy'}>
          <PrivacyPanel embedded onOpenChat={onOpenChat} />
        </div>

        {/* ── 软件授权 License ── */}
        <div hidden={activeKey !== 'license'}><LicenseSection /></div>

        {/* ── 软件更新 ── */}
        <div hidden={activeKey !== 'update'}><UpdateSection /></div>

        {/* ── 备份恢复（原外层侧栏项，整页迁入） ── */}
        <div className={css.embedPane} hidden={activeKey !== 'backup'}>
          <BackupPanel embedded />
        </div>

        {/* ── 数据库健康 / 原图链路自检 / 操作日志（原外层「数据健康」的三个分段） ── */}
        <div className={css.embedPane} hidden={activeKey !== 'health'}>
          <HealthPanel embedded onNavigate={innerNavigate} />
        </div>
        <div className={css.embedPane} hidden={activeKey !== 'hook'}>
          <HookPanel embedded onNavigate={innerNavigate} />
        </div>
        <div className={css.embedPane} hidden={activeKey !== 'oplog'}>
          <OperationLogPanel />
        </div>

        {/* ── 高级设置（输出路径 · 诊断日志 · 启动引导） ── */}
        <section className={css.card} hidden={activeKey !== 'advanced'}>
          <header className={css.cardHd}>
            <span className={css.cardIconChip}><IconSettingsOutline14 size={14} /></span>
            <div className={css.cardTitleBox}>
              <span className={css.cardTitle}>高级设置</span>
              <span className={kitCss.textCaptionTrunc}>输出目录 · 诊断日志 · 启动引导</span>
            </div>
            <span className={css.cardBadge}>
              <StateDot state={cfg?.resolved?.decrypted_dir ? 'done' : 'warning'} />
              {cfg?.resolved?.decrypted_dir ? '路径已解析' : '路径未知'}
            </span>
          </header>
          <div className={css.cardBody}>
            <div className={css.row}>
              <span className={css.rowName}>解密输出</span>
              <span className={css.rowMeta}>{cfg?.resolved?.decrypted_dir ?? '—'}</span>
            </div>
            <div className={css.row}>
              <span className={css.rowName}>图片输出</span>
              <span className={css.rowMeta}>{cfg?.resolved?.decoded_image_dir ?? '—'}</span>
            </div>
            <div className={css.row}>
              <span className={css.rowName}>密钥文件</span>
              <span className={css.rowMeta}>{cfg?.resolved?.keys_file ?? '—'}</span>
            </div>
            <div className={css.row}>
              {/* N24：原先这里还有「启用 / 访问令牌 / 监听端口」三个 HTTP API 开关，
                  而全仓没有任何服务端读它们 —— 界面能存、行为为零。已撤下，
                  避免用户以为「关掉端口就等于关掉了外部访问」。 */}
              <span className={css.rowNote}>本应用不提供本地 HTTP 服务：所有能力都经 Remote 直连进程内后端，无需端口与令牌。</span>
            </div>
            {/* 诊断日志（M6）：GUI 态 stdout 会被管道丢弃，crash/报障时只有这份落盘日志 */}
            <div className={css.row}>
              <span className={css.rowName}>诊断日志</span>
              <button type="button" className={css.whisperSkip} onClick={() => { void exportDiagLog() }}>
                导出…
              </button>
              <button type="button" className={css.whisperSkip} onClick={() => { void revealDiagLog() }}>
                打开所在目录
              </button>
              <span className={css.rowMeta} title={diagInfo?.dir ?? ''}>
                {diagInfo ? `${diagInfo.dir} · ${Math.round(diagInfo.bytes / 1024)} KB` : '读取中…'}
              </span>
            </div>
            <div className={css.row}>
              <span className={css.rowName}>启动引导</span>
              <button
                type="button"
                className={css.whisperSkip}
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('super-time:show-onboarding'))
                }}
              >
                重新查看启动页
              </button>
              <span className={css.rowMeta}>清除本地进度并回到首启流程</span>
            </div>
          </div>
        </section>
      </div>

      </div>

      <div className={css.saveBar}>
        <span
          className={css.saveMeta}
          title={pathConfigPath ? `打开路径配置文件：${pathConfigPath}` : '读取路径配置文件…'}
          {...(pathConfigPath ? clickableKey(() => { void apiOpenPath(pathConfigPath) }, { role: 'link' }) : {})}
          style={{
            cursor: pathConfigPath ? 'pointer' : 'default',
            textDecoration: pathConfigPath ? 'underline' : 'none',
            color: pathConfigPath ? 'var(--nm-cyan)' : undefined,
          }}
        >{cfg ? '配置: wechat/config.json ↗' : cfgLoading ? '读取配置…' : ''}</span>
        <span className={saveMsg ? (saveMsg.kind === 'ok' ? css.saveMsgOk : css.saveMsgErr) : css.saveMsgIdle}>
          {saveMsg ? saveMsg.text : '修改后点击「保存配置」生效'}
        </span>
        <Button variant="primary" className={clsx(css.btnFx, css.btnFixed)} icon={saving ? <span className={css.spin} /> : undefined} onClick={() => { void save() }} disabled={saving || !cfg}>
          {saving ? '保存中…' : '保存配置'}
        </Button>
      </div>

      <Dialog
        open={imgDetailOpen}
        onClose={() => { setImgDetailOpen(false) }}
        title="图片解密详情"
        footer={(
          <Button size="sm" variant="outline" onClick={() => { setImgDetailOpen(false) }}>关闭</Button>
        )}
      >
        <div className={css.imgDetailBody}>
          {imgDecryptDetail.skippedDetails.length > 0 && (
            <div className={css.imgDetailGroup}>
              <div className={css.imgDetailTitle}>跳过原因（{imgDecryptDetail.skippedDetails.length} 条）</div>
              {Array.from(new Map(imgDecryptDetail.skippedDetails.map(s => [s.reason, (imgDecryptDetail.skippedDetails.filter(x => x.reason === s.reason).length)])).entries()).map(([reason, count]) => (
                <div key={reason} className={css.imgDetailRow}>
                  <span className={css.imgDetailReason}>{reason}</span>
                  <span className={css.imgDetailCount}>×{count}</span>
                </div>
              ))}
            </div>
          )}
          {imgDecryptDetail.errors.length > 0 && (
            <div className={css.imgDetailGroup}>
              <div className={css.imgDetailTitle}>失败原因（{imgDecryptDetail.errors.length} 条）</div>
              {imgDecryptDetail.errors.slice(0, 100).map((f) => (
                <div key={f.file} className={css.imgDetailRow}>
                  <span className={css.imgDetailFile} title={f.file}>{f.file}</span>
                  <span className={css.imgDetailError}>{f.error}</span>
                </div>
              ))}
              {imgDecryptDetail.errors.length > 100 && (
                <div className={css.imgDetailMore}>仅显示前 100 条失败，共 {imgDecryptDetail.errors.length} 条</div>
              )}
            </div>
          )}
          {imgDecryptDetail.errors.length === 0 && imgDecryptDetail.skippedDetails.length === 0 && (
            <div className={css.imgDetailEmpty}>暂无失败或跳过记录</div>
          )}
        </div>
      </Dialog>
    </div>
  )
}
