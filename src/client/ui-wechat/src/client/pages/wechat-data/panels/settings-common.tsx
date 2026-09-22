
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
