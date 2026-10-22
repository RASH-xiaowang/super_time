/**
 * 撤回记录的正文与媒体卡片。
 *
 * 原文在归档里已经解析好，这里只负责「直接看见」：文本始终落在消息体里，
 * 图片/视频/语音/文件等按类型取实体；资源按钮必须阻止冒泡，否则会顺带折叠整行。
 */
import { useEffect, useState } from 'react'
import {
  apiGetEmoticonDataUrl,
  apiGetFileImageDataUrl,
  apiGetImageDataUrl,
  apiGetVideoInfo,
  apiGetVoiceDataUrl,
  apiOpenPath,
} from '../api.ts'
import { downloadMessageFile, openLink } from './chats-support.tsx'
import { preferMediaUrl } from '../wechat-media.ts'
import { fmtBytes } from '../utils/format.ts'
import { desktopActionProps } from '../ui/desktop-only.tsx'
import { LazyMount } from './hooks.tsx'
import type { RevokedItem } from '@deepseek-ai/dsh-wechat-data/types'
import kitCss from '../ui/kit.module.css'
import css from './list-panel.module.css'

type RevokedMedia = NonNullable<RevokedItem['media']>

/** 浏览器页面没有 wechat-media:// 协议，落盘媒体必须改走同源 HTTP。 */
function useHttpMedia(): boolean {
  return typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol)
}

function stopClick(e: React.MouseEvent): void {
  e.stopPropagation()
}

function MediaImage({ item, media }: { item: RevokedItem; media: RevokedMedia }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState('')
  const sessionUsername = item.session_username ?? ''
  const localId = Number(item.local_id ?? 0)
  const md5 = media.md5 ?? media.fileMd5 ?? ''

  useEffect(() => {
    let cancelled = false
    setSrc(null)
    setError('')
    const load = async (): Promise<{ url?: string; file?: string; error?: string }> => {
      let primaryError = ''
      if (sessionUsername !== '' && localId > 0) {
        try {
          const primary = preferMediaUrl(
            await apiGetImageDataUrl({ username: sessionUsername, localId }),
            useHttpMedia(),
          )
          if (primary.url) return primary
          primaryError = primary.error ?? '图片不可用'
        } catch (e) {
          primaryError = (e as Error).message
        }
      }
      if (md5 !== '') {
        try {
          const fallback = preferMediaUrl(
            await apiGetFileImageDataUrl({ md5, thumbFirst: true }),
            useHttpMedia(),
          )
          if (fallback.url) return fallback
          return { error: fallback.error || primaryError || '图片不可用' }
        } catch (e) {
          return { error: (e as Error).message || primaryError || '图片不可用' }
        }
      }
      return { error: primaryError || '缺少图片定位信息' }
    }
    void load()
      .then((r) => {
        if (cancelled) return
        if (r.url) setSrc(r.url)
        else setError(r.error ?? '图片不可用')
      })
      .catch((e: unknown) => { if (!cancelled) setError((e as Error).message) })
    return () => { cancelled = true }
  }, [sessionUsername, localId, md5])

  return (
    <div className={css.rvMediaCard} data-kind="image">
      {src
        ? <img className={css.rvMediaImage} src={src} alt="撤回的图片" loading="lazy" decoding="async" />
        : <div className={css.rvMediaMeta} role={error ? 'alert' : 'status'}>{error || '图片加载中…'}</div>}
      {media.md5 !== undefined && <div className={css.rvMediaMeta}>MD5 {media.md5}</div>}
      {error !== '' && src !== null && <div className={css.rvMediaError} role="alert">{error}</div>}
    </div>
  )
}

function MediaVideo({ item, media }: { item: RevokedItem; media: RevokedMedia }): React.JSX.Element {
  const [cover, setCover] = useState<string | null>(null)
  const [videoPath, setVideoPath] = useState('')
  const [error, setError] = useState('')
  const sessionUsername = item.session_username ?? ''
  const localId = Number(item.local_id ?? 0)
  const md5 = (media.md5 ?? media.fileMd5 ?? '').trim()
  const duration = media.durationSec !== undefined && media.durationSec > 0
    ? `${Math.floor(media.durationSec / 60)}:${String(Math.round(media.durationSec % 60)).padStart(2, '0')}`
    : ''

  useEffect(() => {
    let cancelled = false
    setCover(null)
    setVideoPath('')
    setError('')
    const hasLocator = sessionUsername !== '' && localId > 0
    if (!hasLocator && md5 === '') {
      setError('缺少视频定位信息')
      return undefined
    }
    const query = hasLocator
      ? { username: sessionUsername, localId, ...(md5 !== '' ? { md5 } : {}) }
      : { md5 }
    void apiGetVideoInfo(query)
      .then((r) => {
        if (cancelled) return
        if (r.videoPath) setVideoPath(r.videoPath)
        if (r.coverUrl) setCover(r.coverUrl)
        if (!r.videoPath && !r.coverUrl) setError(r.error ?? '视频不可用')
      })
      .catch((e: unknown) => { if (!cancelled) setError((e as Error).message) })
    return () => { cancelled = true }
  }, [sessionUsername, localId, md5])

  const openVideo = (): void => {
    if (videoPath === '') return
    void apiOpenPath(videoPath).then((r) => {
      if (!r.ok) setError(r.error ?? '无法用系统播放器打开')
    }).catch((e: unknown) => { setError((e as Error).message) })
  }

  return (
    <div className={css.rvMediaCard} data-kind="video">
      {cover && <img className={css.rvMediaImage} src={cover} alt="撤回的视频封面" loading="lazy" />}
      <div className={css.rvMediaRow}>
        <span className={css.rvMediaTitle}>视频{duration ? ` · ${duration}` : ''}</span>
        {videoPath !== '' && (
          <button
            type="button"
            className={css.rvMediaBtn}
            onClick={(e) => { stopClick(e); openVideo() }}
            {...desktopActionProps()}
          >
            用系统播放器打开
          </button>
        )}
      </div>
      {error !== '' && <div className={css.rvMediaError} role="alert">{error}</div>}
      {media.md5 !== undefined && <div className={css.rvMediaMeta}>MD5 {media.md5}</div>}
    </div>
  )
}

function MediaVoice({ item, media }: { item: RevokedItem; media: RevokedMedia }): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const sessionUsername = item.session_username ?? ''
  const localId = Number(item.local_id ?? 0)
  const sec = media.durationMs !== undefined && media.durationMs > 0
    ? Math.max(1, Math.round(media.durationMs / 1000))
    : 0

  useEffect(() => {
    let cancelled = false
    setUrl('')
    setError('')
    const query = sessionUsername !== '' && localId > 0
      ? { username: sessionUsername, localId }
      : item.server_id ? { svrId: item.server_id } : null
    if (query === null) {
      setError('缺少语音定位信息')
      return undefined
    }
    void apiGetVoiceDataUrl(query)
      .then((r) => {
        if (cancelled) return
        if (r.url) setUrl(r.url)
        else setError(r.error ?? '语音不可播放')
      })
      .catch((e: unknown) => { if (!cancelled) setError((e as Error).message) })
    return () => { cancelled = true }
  }, [sessionUsername, localId, item.server_id])

  return (
    <div className={css.rvMediaCard} data-kind="voice">
      <div className={css.rvMediaRow}>
        <span className={css.rvMediaTitle}>语音{sec > 0 ? ` · ${sec}″` : ''}</span>
      </div>
      {url && (
        <audio
          className={css.rvMediaAudio}
          controls
          preload="metadata"
          src={url}
          onClick={stopClick}
        />
      )}
      {error !== '' && <div className={css.rvMediaError} role="alert">{error}</div>}
    </div>
  )
}

function MediaFile({ item, media }: { item: RevokedItem; media: RevokedMedia }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const name = media.name ?? media.title ?? '未命名文件'
  const size = media.size !== undefined && Number.isFinite(media.size) && media.size > 0
    ? fmtBytes(media.size)
    : ''
  const detail = [media.ext ? media.ext.toUpperCase() : '', size].filter(Boolean).join(' · ')

  const save = async (): Promise<void> => {
    setBusy(true)
    setError('')
    const message = await downloadMessageFile(name, {
      ...(media.size !== undefined ? { size: media.size } : {}),
      createTime: item.create_time,
      ...((media.fileMd5 ?? '').trim() !== '' ? { fileMd5: media.fileMd5 } : {}),
    })
    if (message !== '') setError(message)
    setBusy(false)
  }

  return (
    <div className={css.rvMediaCard} data-kind="file">
      <div className={css.rvMediaRow}>
        <span className={css.rvMediaTitle} title={name}>📎 {name}</span>
        <button type="button" className={css.rvMediaBtn} disabled={busy} onClick={(e) => { stopClick(e); void save() }}>
          {busy ? '读取中…' : '下载文件'}
        </button>
      </div>
      {detail !== '' && <div className={css.rvMediaMeta}>{detail}</div>}
      {error !== '' && <div className={css.rvMediaError} role="alert">{error}</div>}
    </div>
  )
}

function MediaEmoji({ media }: { media: RevokedMedia }): React.JSX.Element {
  const [src, setSrc] = useState('')
  const [error, setError] = useState('')
  const md5 = media.md5 ?? ''

  useEffect(() => {
    let cancelled = false
    setSrc('')
    setError('')
    if (md5 === '') {
      setError('缺少表情 MD5')
      return undefined
    }
    void apiGetEmoticonDataUrl({ md5, ...(media.emojiUrl ? { emojiUrl: media.emojiUrl } : {}) })
      .then((r) => {
        const row = preferMediaUrl(r, useHttpMedia())
        if (cancelled) return
        if (row.url) setSrc(row.url)
        else setError(row.error ?? '表情不可用')
      })
      .catch((e: unknown) => { if (!cancelled) setError((e as Error).message) })
    return () => { cancelled = true }
  }, [md5, media.emojiUrl])

  return (
    <div className={css.rvMediaCard} data-kind="emoji">
      {src
        ? <img className={css.rvMediaEmoji} src={src} alt="撤回的表情" />
        : <div className={css.rvMediaMeta} role={error ? 'alert' : 'status'}>{error || '表情加载中…'}</div>}
      {media.md5 !== undefined && <div className={css.rvMediaMeta}>MD5 {media.md5}</div>}
    </div>
  )
}

function MediaCard({ media }: { media: RevokedMedia }): React.JSX.Element | null {
  const url = media.url ?? ''
  const title = media.title || media.name || ''
  const desc = media.desc || (media.referName ? `引用 ${media.referName}` : '')
  if (title === '' && desc === '' && url === '') return null
  return (
    <div className={css.rvMediaCard} data-kind={media.kind}>
      {title !== '' && <div className={css.rvMediaTitle}>{title}</div>}
      {desc !== '' && <div className={css.rvMediaMeta}>{desc}</div>}
      {media.recordCount !== undefined && <div className={css.rvMediaMeta}>{media.recordCount} 条聊天记录</div>}
      {/^https?:\/\//i.test(url) && (
        <div className={css.rvMediaRow}>
          <button type="button" className={css.rvMediaBtn} onClick={(e) => { stopClick(e); openLink(url) }}>
            打开链接
          </button>
          <span className={css.rvMediaMeta} title={url}>{url}</span>
        </div>
      )}
    </div>
  )
}

/**
 * 渲染一条撤回记录的正文。正文不再等展开：图片/视频等资源也会直接出现在行内。
 * @param props.item - 撤回记录。
 * @param props.open - 是否展开长文本。
 * @returns 正文与资源卡片。
 */
export function RevokedContent({ item, open }: { item: RevokedItem; open: boolean }): React.JSX.Element {
  const media = item.media
  const retained = item.retained !== false
  const bodyVisible = media === undefined
    || !['image', 'video', 'voice', 'file', 'emoji'].includes(media.kind)
    || item.content.trim() !== ''

  return (
    <div className={css.rvBodyPad}>
      {bodyVisible && item.content !== '' && (
        <div className={css.rvBody}>
          <div className={css.rvBodyText} data-collapsed={open ? 'false' : 'true'}>{item.content}</div>
        </div>
      )}
      {retained && media !== undefined && (
        <LazyMount rootMargin="480px 0px" placeholder={<div className={css.rvMediaPending}>媒体将进入视野后加载</div>}>
          {media.kind === 'image' && <MediaImage item={item} media={media} />}
          {media.kind === 'video' && <MediaVideo item={item} media={media} />}
          {media.kind === 'voice' && <MediaVoice item={item} media={media} />}
          {media.kind === 'file' && <MediaFile item={item} media={media} />}
          {media.kind === 'emoji' && <MediaEmoji media={media} />}
          {!['image', 'video', 'voice', 'file', 'emoji', 'system', 'unknown'].includes(media.kind) && (
            <MediaCard media={media} />
          )}
        </LazyMount>
      )}
      {!retained && (
        <div className={css.rvMediaError} role="alert">{item.status_label ?? '原文未保留，无法读取资源'}</div>
      )}
      <div className={`${kitCss.textMeta} ${css.rvFootNote}`}>
        {item.status_label ?? '该内容在微信客户端被撤回，此处为本地缓存副本'}
        {item.session_name ? ` · 会话：${item.session_name}` : ''}
      </div>
    </div>
  )
}
