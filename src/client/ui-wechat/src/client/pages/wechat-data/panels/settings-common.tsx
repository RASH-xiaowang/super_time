
/**
 * 设置面板的两块**共用件**（M21 第二十八刀自 Settings.tsx 拆出）：
 *
 *   · `AccountAvatar`（+ 它自己的 wxid→头像缓存）：面板与「检测账号」卡片都要画账号头像；
 *   · `MsgSlot` / `StatusSlot`：固定高度状态槽 —— 五张流程卡片共用，槽位不能各有各的写法；
 *   · `fmtActive`（活跃时间的人话格式）、`WHISPER_MODEL_FALLBACK`（模型清单兜底）。
 *
 * 这些都不是状态，只是渲染/格式化工具 ⇒ 搬出来给「面板 + 各卡片模块」共用，避免下一步拆卡片时
 * 把它们变成一堆道具。
*/
import { useEffect, useState } from 'react'
import type { WechatConfigFull } from '@deepseek-ai/dsh-wechat-data/types'
import { apiGetAvatar } from '../api.ts'
import { avatarColors } from '../utils/format.ts'
import { css, acctCss } from './settings-css.ts'

/** 模型目录探测器尚未就绪时的本地目录兜底(安装状态以 getWhisperStatus 为准)。 */
export const WHISPER_MODEL_FALLBACK: ReadonlyArray<{ id: string; name: string; sizeLabel: string; installed: boolean }> = [
  { id: 'tiny', name: 'Tiny', sizeLabel: '约 75 MB · 最快', installed: false },
  { id: 'base', name: 'Base', sizeLabel: '约 145 MB · 很快', installed: false },
  { id: 'small', name: 'Small', sizeLabel: '约 466 MB · 较快', installed: false },
  { id: 'medium', name: 'Medium', sizeLabel: '约 1.5 GB · 中等', installed: false },
  { id: 'large-v3', name: 'Large v3', sizeLabel: '约 3.1 GB · 较慢', installed: false },
  { id: 'turbo', name: 'Turbo', sizeLabel: '约 1.6 GB · 快', installed: false },
]

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
export function AccountAvatar({ wxid }: { wxid: string }): React.JSX.Element {
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
    ? <img src={src} alt={letter} className={acctCss.acctAvatarImg} width={34} height={34} referrerPolicy="no-referrer" loading="lazy" />
    : <div className={acctCss.acctAvatar} style={{ background: av.background, color: av.color }}>{letter}</div>
}

/** 相对时间标签（最近活动）。 */
export function fmtActive(ts?: number): string {
  if (!ts) return '—'
  const diff = Date.now() / 1000 - ts
  if (diff < 3600) return `${Math.max(1, Math.floor(diff / 60))} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export interface StatusProps {
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
export function MsgSlot({ placeholder, msg }: { placeholder: string; msg: { kind: 'ok' | 'err'; text: string } | null }): React.JSX.Element {
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
export function StatusSlot({ placeholder, active, pct, text, item, doneText, doneKind, detail }: StatusProps): React.JSX.Element {
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
          {detail ? <span className={acctCss.slotDetail}>{detail}</span> : null}
        </>
      )}
    </div>
  )
}

/* ── 面板与钩子共用的「模型件」（M21 第三十刀自 Settings.tsx 搬出） ── */

/** localStorage 渲染缓存键：上次成功加载的**非密钥**微信配置，用于首帧即时渲染。 */
export const SETTINGS_CONFIG_CACHE_KEY = 'settings-config'

/**
 * 密钥字段：**一律不写进渲染缓存**。
 *
 * 为什么：渲染缓存落在 `<userData>/Local Storage`（Chromium 管理的 leveldb），而 M1 的权限
 * 收紧只覆盖 `<userData>/wechat` 与数据根 —— 缓存里放一份密钥等于凭空多一份**不受保护**的
 * 明文副本（复审实测本机 dev profile 的 leveldb 里确实躺着真 `db_enc_key`）。密钥的真源只有
 * `<数据根>/secrets.json`，界面上要显示时通过 RPC 现取。
 */
export const SETTINGS_SECRET_FIELDS = ['db_enc_key', 'image_aes_key', 'image_xor_key', 'api_token'] as const
/** 可缓存的配置形状：明确地把密钥字段排除在外（类型上也不给漏的机会）。 */
export type SettingsSecretKey = (typeof SETTINGS_SECRET_FIELDS)[number]

export type CachedSettingsConfig = Omit<WechatConfigFull, SettingsSecretKey>

/** 去掉密钥字段后的可缓存副本。 */
export function cacheableConfig(c: WechatConfigFull): CachedSettingsConfig {
  const { db_enc_key: _db, image_aes_key: _aes, image_xor_key: _xor, api_token: _tok, ...rest } = c
  return rest
}


/** 性能：账号检测 / Whisper 状态缓存 TTL（60 秒），避免每次进入页签重复扫描。 */
export const SETTINGS_SCAN_TTL_MS = 60_000
/** 空闲时执行（首次进入不阻塞首帧渲染）。 */
export function runWhenIdle(fn: () => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => { fn() }, { timeout: 800 })
  } else {
    setTimeout(() => { fn() }, 150)
  }
}





/** 步骤定义（与 ST_Wechat_V2 向导一致的流程）。 */
export const STEPS = [
  { key: 'detect', n: 1, label: '检测账号' },
  { key: 'dbkey', n: 2, label: '数据库密钥' },
  { key: 'imgkey', n: 3, label: '图片密钥' },
  { key: 'img', n: 4, label: '图片解码' },
  { key: 'voice', n: 5, label: '语音转文字' },
] as const

/** 步骤图标（统一 14px 描边风格）。 */
export const STEP_ICONS: Record<string, React.JSX.Element> = {
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
}

export type StepState = 'done' | 'todo' | 'note'

/** 通知内容(可带明细列表,渲染为悬浮层不挤占布局)。 */
export interface Notice {
  kind: 'ok' | 'err'
  text: string
  details?: readonly string[]
}

