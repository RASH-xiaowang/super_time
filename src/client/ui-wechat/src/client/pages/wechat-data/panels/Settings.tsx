/**
 * 微信设置面板 — 按 ST_Wechat_V2「本地检测 → 数据库解密 → 图片密钥 →
 * 图片解密 → 表情/语音」流程重新设计为步骤导航。数据源 / 解密密钥 /
 * 图片密钥 / 图片解码 / 语音转写 五步卡片 + 高级设置（HTTP API 遗留能力）。
 * 自动获取密钥（V4 内存扫描 + Weixin.dll 内部键 + V2 图片验证）已支持；
 * SQLCipher 全库解密仍为说明态（本地解密能力独立立项）；语音转写已本地化（whisper.cpp）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Button, Input, Pill, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  IconGlobeOutline14, IconPersonalizationOutline16, IconSettingsOutline14, IconSparkle16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { apiAutoGetDbKey, apiAutoGetImageKey, apiDecryptAllDatabases, apiDecryptAllImages, apiDetectWechatAccounts, apiDownloadWhisperModel, apiGenerateKeysFile, apiGetAvatar, apiGetWechatPathConfig, apiOpenPath, apiGetDecryptStatus, apiGetWechatConfigFull, apiGetWechatKeysInfo, apiGetWhisperStatus, apiInstallWhisperEngine, apiSaveWechatConfig, apiSetCdnImageEnabled, apiSetCdnImageLocalDecrypt, apiTranscribeVoiceBatch, apiVerifyDatabaseKey, apiVerifyImageKey, pickDirectory, readRenderCache, writeRenderCache } from '../api.ts'
import type { WechatAccount, WechatConfigFull, WhisperStatus } from '@deepseek-ai/dsh-wechat-data/types'
import { clickableKey, Dialog, PanelHeader } from '../ui/kit.tsx'
import css from './settings.module.css'
import kitCss from '../ui/kit.module.css'
import { avatarColors, fmtBytes } from '../utils/format.ts'

/** localStorage 渲染缓存键：上次成功加载的完整微信配置，用于首帧即时渲染。 */
const SETTINGS_CONFIG_CACHE_KEY = 'settings-config'

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

/**
 * Render the wechat-settings panel.
 * @returns the settings element tree.
 */
export function SettingsPanel(): React.JSX.Element {
  const cachedCfg = readRenderCache<WechatConfigFull>(SETTINGS_CONFIG_CACHE_KEY)
  const [cfg, setCfg] = useState<WechatConfigFull | null>(cachedCfg)
  const [cfgLoading, setCfgLoading] = useState(false)
  const [keysInfo, setKeysInfo] = useState<{ keyFormat?: string; keyCount: number; loaded: boolean }>({ keyCount: 0, loaded: false })
  const [accounts, setAccounts] = useState<readonly WechatAccount[]>([])
  const [detectInfo, setDetectInfo] = useState<{ version?: string; install_dir?: string }>({})
  const [detecting, setDetecting] = useState(false)
  const [detectMsg, setDetectMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [dbDir, setDbDir] = useState(cachedCfg?.db_dir ?? '')
  const [dbKey, setDbKey] = useState(cachedCfg?.db_enc_key ?? '')
  const [imgAes, setImgAes] = useState(cachedCfg?.image_aes_key ?? '')
  const [imgXor, setImgXor] = useState(cachedCfg ? String(cachedCfg.image_xor_key) : '136')
  const [apiEnabled, setApiEnabled] = useState(cachedCfg?.api_enabled ?? true)
  const [apiToken, setApiToken] = useState(cachedCfg?.api_token ?? '')
  const [apiPort, setApiPort] = useState(cachedCfg?.api_port ?? 5032)
  const [cdnEnabled, setCdnEnabled] = useState(cachedCfg?.cdn_enabled ?? true)
  const [cdnLocal, setCdnLocal] = useState(cachedCfg?.cdn_local_decrypt ?? true)
  const [message, setMessage] = useState<Notice | null>(null)
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
  const stepRefs = useRef(new Map<string, HTMLElement>())
  const notify = (kind: 'ok' | 'err', text: string, details?: readonly string[]): void => {
    setMessage({ kind, text, ...(details && details.length > 0 ? { details } : {}) })
    setTimeout(() =>{ setMessage(null) }, details && details.length > 0 ? 12000 : 5000)
  }

  const load = useCallback(async (): Promise<void> => {
    setCfgLoading(true)
    try {
      const c = await apiGetWechatConfigFull()
      setCfg(c)
      writeRenderCache(SETTINGS_CONFIG_CACHE_KEY, c)
      setDbDir(c.db_dir)
      setDbKey(c.db_enc_key)
      setImgAes(c.image_aes_key)
      setImgXor(String(c.image_xor_key))
      setApiEnabled(c.api_enabled)
      setApiToken(c.api_token)
      setApiPort(c.api_port)
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
    const timer = setInterval(() => {
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
      clearInterval(timer)
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

  const pollTranscribe = (): (() => void) => {
    const timer = setInterval(() => {
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
    return () => { clearInterval(timer) }
  }

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
    const timer = setInterval(() => {
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
      clearInterval(timer)
      setWhisperDownloading(null)
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const port = Number.isFinite(apiPort) && apiPort >= 1024 && apiPort <= 65535 ? apiPort : 5032
      const r = await apiSaveWechatConfig({
        patch: {
          db_dir: dbDir,
          db_enc_key: dbKey,
          image_aes_key: imgAes,
          image_xor_key: Number(imgXor) || 136,
          api_enabled: apiEnabled,
          api_token: apiToken,
          api_port: port,
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
  }) => void): (() => void) => {
    const timer = setInterval(() => {
      void apiGetDecryptStatus()
        .then((s) => {
          if (s.active || s.done > 0) apply(s)
        })
        .catch(() => { /* 忽略单次轮询失败 */ })
    }, 400)
    return () => { clearInterval(timer) }
  }

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

  const scrollToStep = (key: (typeof STEPS)[number]['key']): void => {
    stepRefs.current.get(key)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const stepLabel = (state: StepState): string => state === 'done' ? '已完成' : state === 'note' ? '说明' : '待配置'

  return (
    <div className={css.root}>
      <PanelHeader
        title={(
          <>
            <IconSettingsOutline14 size={16} />
            微信数据配置
          </>
        )}
        desc="本地检测 · 数据库密钥 · 图片密钥 · 图片解码 · 语音转写"
      />

      {/* 状态速览 */}
      <div className={css.statusStrip}>
        {STEPS.map((s) => {
          const state = stepStates[s.key]
          const value = s.key === 'detect'
            ? `${accounts.length} 个账号`
            : s.key === 'dbkey'
              ? (keyOk ? `${keysInfo.keyCount} 个密钥` : '未配置')
              : s.key === 'imgkey'
                ? (imgAes.trim() ? '已就绪' : '未配置')
                : s.key === 'img'
                  ? (cdnEnabled ? '已启用' : '未启用')
                  : (whisperStatus?.engine ? '引擎就绪' : '待配置')
          return (
            <button
              key={s.key}
              type="button"
              className={clsx(css.statusCard, state === 'done' && css.statusDone, state === 'note' && css.statusNote)}
              onClick={() => { scrollToStep(s.key) }}
              title={`查看「${s.label}」`}
            >
              <span className={css.statusIcon}>{STEP_ICONS[s.key]}</span>
              <span className={css.statusBody}>
                <span className={css.statusLabel}>{s.label}</span>
                <span className={css.statusValue}>{value}</span>
              </span>
              <StateDot state={state === 'done' ? 'done' : state === 'note' ? 'warning' : 'ongoing'} />
            </button>
          )
        })}
      </div>

        <div className={css.mainScroll}>

      {message && (
        <div className={clsx(css.notice, message.kind === 'ok' ? css.toastOk : css.toastErr)}>
          <div className={css.noticeHead}>
            <span className={css.noticeText}>{message.text}</span>
            <button type="button" className={css.noticeClose} onClick={() => { setMessage(null) }} aria-label="关闭提示">✕</button>
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
          ref={(el) => { if (el) stepRefs.current.set('detect', el) }}
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
          ref={(el) => { if (el) stepRefs.current.set('dbkey', el) }}
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
          ref={(el) => { if (el) stepRefs.current.set('imgkey', el) }}
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
          ref={(el) => { if (el) stepRefs.current.set('img', el) }}
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
          ref={(el) => { if (el) stepRefs.current.set('voice', el) }}
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

        {/* ── 高级设置（HTTP API 遗留能力 + 输出路径） ── */}
        <details className={css.advanced}>
          <summary className={css.advancedSummary}>高级设置 · HTTP API 服务 & 输出目录</summary>
          <div className={css.advancedBody}>
            <div className={css.row}>
              <span className={css.rowName}>启用</span>
              <input type="checkbox" checked={apiEnabled} onChange={(e) => { setApiEnabled(e.target.checked) }} />
              <Pill active={apiEnabled}>{apiEnabled ? '已启用' : '未启用'}</Pill>
            </div>
            <div className={css.row}>
              <span className={css.rowName}>访问令牌</span>
              <Input className={css.input} value={apiToken} onChange={(e) => { setApiToken(e.target.value) }} placeholder="留空 = 免鉴权" />
            </div>
            <div className={css.row}>
              <span className={css.rowName}>监听端口</span>
              <Input className={css.inputNarrow} value={String(apiPort)} onChange={(e) => { setApiPort(Number(e.target.value) || 5032) }} />
              <span className={css.rowMeta}>http://127.0.0.1:{apiPort}</span>
            </div>
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
              <span className={css.rowNote}>本面板已通过 Remote 直读，无外部 HTTP 依赖。</span>
            </div>
          </div>
        </details>

        {/* ── 操作日志（元数据监控/导出，绝不保存会话内容） ── */}

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
        <Button variant="primary" className={clsx(css.btnFx, css.btnFixed)} icon={saving ? <span className={css.spin} /> : undefined} onClick={() => { void save() }} disabled={saving}>
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
