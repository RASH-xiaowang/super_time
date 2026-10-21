/**
 * 收藏来源头像。
 *
 * 后端可能返回本机 `data:`、远程 https 地址，或 32 位头像 MD5。三种形态在
 * 普通详情、收藏卡片和聊天记录里必须走同一条解析链，否则同一个发送者会在
 * 不同位置显示成头像、破图或空白。
 */
import { useEffect, useState } from 'react'
import { apiGetSnsImageDataUrl } from '../api.ts'
import { RemoteImg } from './remote-img.tsx'
import css from './list-panel.module.css'

/** 32 位十六进制头像 MD5（收藏 XML 的兜底线索）。 */
export const FAVORITE_AVATAR_MD5 = /^[0-9a-f]{32}$/i

export interface FavoriteAvatarRef {
  /** 可直接交给 `RemoteImg` 的引用；MD5 在解码完成前为空串。 */
  src: string
  /** 需要本机解码的头像 MD5；不是 MD5 时为空串。 */
  md5: string
}

/**
 * 判断头像引用是否需要走 MD5 解码。
 * @param raw - 后端返回的 `avatar` 字段。
 * @returns 归一化后可直接画或需解码的头像引用。
 */
export function parseFavoriteAvatar(raw: string | undefined): FavoriteAvatarRef {
  const value = String(raw ?? '').trim()
  if (value === '') return { src: '', md5: '' }
  if (FAVORITE_AVATAR_MD5.test(value)) return { src: '', md5: value.toLowerCase() }
  return { src: value, md5: '' }
}

/** 来源名首字；空来源用问号，避免头像位出现空框。 */
function avatarInitial(name: string | undefined): string {
  const chars = Array.from(String(name ?? '').trim())
  return chars[0]?.toUpperCase() ?? '?'
}

export interface FavoriteAvatarProps {
  /** 本机 data URL、远程地址或 32 位 MD5。 */
  avatar?: string
  /** 来源显示名，用于取首字兜底。 */
  name?: string
  /** 外层头像框类名，默认使用收藏详情的方形头像框。 */
  className?: string
  /** 首字占位类名。 */
  fallbackClassName?: string
  /** 图片加载策略。 */
  loading?: 'eager' | 'lazy'
}

/**
 * 统一渲染收藏来源头像。
 *
 * MD5 必须先经本机 SNS 图片链解码成 data URL；远程地址交给 `RemoteImg`
 * 走后端代理；加载中、失败和空值都显示来源首字。
 * @param props - 头像引用、来源名与样式。
 * @returns 头像框。
 */
export function FavoriteAvatar({
  avatar,
  name,
  className,
  fallbackClassName,
  loading = 'lazy',
}: FavoriteAvatarProps): React.JSX.Element {
  const parsed = parseFavoriteAvatar(avatar)
  const [decoded, setDecoded] = useState<{ md5: string; url: string } | null>(null)

  useEffect(() => {
    setDecoded(null)
    if (parsed.md5 === '') return
    let alive = true
    void apiGetSnsImageDataUrl({ md5: parsed.md5 })
      .then((result) => {
        if (!alive || typeof result.url !== 'string' || result.url === '') return
        setDecoded({ md5: parsed.md5, url: result.url })
      })
      .catch(() => {
        // 解码失败时保留首字占位，不让头像位变成破图。
      })
    return () => { alive = false }
  }, [parsed.md5])

  const src = parsed.md5 === ''
    ? parsed.src
    : (decoded?.md5 === parsed.md5 ? decoded.url : '')
  const fallback = (
    <span className={fallbackClassName ?? css.favSourceAvatarFallback}>
      {avatarInitial(name)}
    </span>
  )
  return (
    <div className={className ?? css.favSourceAvatar} aria-hidden="true">
      <RemoteImg
        src={src}
        alt=""
        loading={loading}
        pending={fallback}
        failed={fallback}
        empty={fallback}
      />
    </div>
  )
}
