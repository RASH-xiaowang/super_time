/**
 * 收藏详情里的资源渲染。
 *
 * 收藏 XML 的 `datatype` 会持续增加，详情不能只为图片/语音/视频写死分支。
 * 本组件把「取数」和「展示」收在一处：媒体存本机时按需取回，远程封面统一交给
 * `RemoteImg` 走后端代理；未知类型也至少把标题、描述、链接和元信息如实展示。
 */
import type { FavItemPart } from '@deepseek-ai/dsh-wechat-data/types'
import { useEffect, useState } from 'react'
import {
  apiGetFavoriteMediaDataUrl,
  apiGetMessageFile,
  apiGetSnsImageDataUrl,
  apiGetSnsVideoCoverDataUrl,
  apiGetSnsVideoDataUrl,
  apiGetVoiceDataUrl,
} from '../api.ts'
import kitCss from '../ui/kit.module.css'
import { fmtBytes } from '../utils/format.ts'
import { openLink } from './chats-support.tsx'
import { RemoteImg } from './remote-img.tsx'
import css from './list-panel.module.css'

export interface FavoritePartProps {
  part: FavItemPart
  /** 收藏更新时间（`msg/file` 的月份归属线索）。 */
  updateTime: number
  /** 列表已解码的图片（md5 → data URL），作为详情首帧兜底。 */
  thumbs: Readonly<Record<string, string>>
}

interface LoadedUrl {
  key: string
  url: string
}

interface LoadedText {
  key: string
  text: string
}

/** 收藏更新时间是秒；文件查找接口要的也是秒。 */
function fileCreateTime(updateTime: number): number | undefined {
  return Number.isFinite(updateTime) && updateTime > 0 ? updateTime : undefined
}

/** 32 位十六进制 MD5；未知资源只给 `md5` 时也用它走本机解码。 */
const FAVORITE_MD5 = /^[0-9a-f]{32}$/i

/** 语音时长：XML 原始值是毫秒。 */
function voiceDuration(part: FavItemPart): string {
  const ms = part.durationMs ?? (part.duration ? part.duration * 1000 : 0)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const sec = Math.round(ms / 1000)
  return sec > 0 ? `${sec} 秒` : ''
}

/**
 * 一张收藏图片：优先完整图，失败后换缩略图 MD5。
 * @param props - 条目、缓存与尺寸类。
 * @returns 图片或可读的失败/加载状态。
 */
function FavoriteImage({ part, thumbs }: {
  part: FavItemPart
  thumbs: Readonly<Record<string, string>>
}): React.JSX.Element {
  const direct = [part.fullMd5, part.thumbMd5, part.md5]
    .filter((value): value is string => typeof value === 'string' && value !== '')
  const candidates = [...new Set(direct)]
  const initial = candidates.map((md5) => thumbs[md5]).find((url) => typeof url === 'string' && url !== '') ?? ''
  const cacheKey = candidates.join('|')
  const [loaded, setLoaded] = useState<LoadedUrl | null>(null)
  const [failed, setFailed] = useState<LoadedText | null>(null)
  const src = loaded?.key === cacheKey ? loaded.url : initial
  useEffect(() => {
    setLoaded(null)
    setFailed(null)
    if (initial !== '') return
    if (candidates.length === 0) {
      setFailed({ key: cacheKey, text: '图片暂不可用' })
      return
    }
    let alive = true
    void (async () => {
      // 先走微信收藏专用缓存：它的文件名与 XML md5 无关，旧的 SNS 图片接口
      // 即使本机文件就在 business/favorite 下也找不到。
      try {
        const result = await apiGetFavoriteMediaDataUrl({
          ...(part.fullMd5 ? { fullMd5: part.fullMd5 } : {}),
          ...(part.thumbMd5 ? { thumbMd5: part.thumbMd5 } : {}),
          ...(part.md5 ? { md5: part.md5 } : {}),
          kind: 'image',
        })
        if (!alive) return
        if (typeof result.url === 'string' && result.url !== '') {
          setLoaded({ key: cacheKey, url: result.url })
          return
        }
      } catch {
        // 本地收藏缓存未命中时继续走旧链路。
      }
      for (const md5 of candidates) {
        try {
          const result = await apiGetSnsImageDataUrl({ md5 })
          if (!alive) return
          if (typeof result.url === 'string' && result.url !== '') {
            setLoaded({ key: cacheKey, url: result.url })
            return
          }
        } catch {
          // 换下一个 MD5；全部失败时统一给可读说明。
        }
      }
      if (alive) setFailed({ key: cacheKey, text: '图片暂不可用' })
    })()
    return () => { alive = false }
    // candidates 由 part 的 md5 字段派生；依赖 cacheKey 即可避免每个渲染周期重取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, initial])
  if (src !== '') {
    return <img className={css.favPartImg} src={src} alt="" loading="lazy" referrerPolicy="no-referrer" />
  }
  return <div className={kitCss.textMeta}>{failed?.key === cacheKey ? failed.text : '正在加载图片…'}</div>
}

/**
 * 收藏语音：收藏没有会话 localId，必须用 XML 的 `svrId` 找 VoiceInfo。
 * @param props - 语音条目。
 * @returns 音频播放器或失败说明。
 */
function FavoriteVoice({ part }: { part: FavItemPart }): React.JSX.Element {
  const svrId = part.svrId ?? ''
  const key = svrId || part.fullMd5 || part.md5 || ''
  const [loaded, setLoaded] = useState<LoadedUrl | null>(null)
  const [failed, setFailed] = useState<LoadedText | null>(null)
  useEffect(() => {
    setLoaded(null)
    setFailed(null)
    if (key === '') {
      setFailed({ key, text: '语音暂不可用' })
      return
    }
    let alive = true
    void (async () => {
      if (svrId !== '') {
        try {
          const result = await apiGetVoiceDataUrl({ svrId })
          if (!alive) return
          if (typeof result.url === 'string' && result.url !== '') {
            setLoaded({ key, url: result.url })
            return
          }
        } catch {
          // 收藏缓存仍可能命中，继续往下试。
        }
      }
      try {
        const result = await apiGetFavoriteMediaDataUrl({
          ...(part.fullMd5 ? { fullMd5: part.fullMd5 } : {}),
          ...(part.md5 ? { md5: part.md5 } : {}),
          kind: 'audio',
          ...(part.format ? { ext: part.format } : {}),
        })
        if (!alive) return
        if (typeof result.url === 'string' && result.url !== '') setLoaded({ key, url: result.url })
        else setFailed({ key, text: result.error ?? '语音暂不可用' })
      } catch (error: unknown) {
        if (alive) setFailed({ key, text: error instanceof Error ? error.message : '语音加载失败' })
      }
    })()
    return () => { alive = false }
  }, [key, svrId])
  const src = loaded?.key === key ? loaded.url : ''
  const duration = voiceDuration(part)
  return (
    <div className={css.favMediaCard}>
      <div className={css.favMediaHeader}>
        <span className={css.favMediaIcon} aria-hidden="true">◉</span>
        <div className={css.favMediaBody}>
          <div className={css.favMediaTitle}>{duration ? `语音 · ${duration}` : '语音'}</div>
          {part.format && <div className={css.favMediaMeta}>格式 {part.format.toUpperCase()}</div>}
        </div>
      </div>
      {src !== '' && <audio className={css.favAudio} controls preload="metadata" src={src} />}
      {src === '' && <div className={css.favMediaMeta}>{failed?.key === key ? failed.text : '正在解码语音…'}</div>}
    </div>
  )
}

/**
 * 收藏视频：先显示封面，用户点击后才取视频本体，避免打开抽屉就搬大 base64。
 * @param props - 视频条目。
 * @returns 视频卡片、封面与播放器。
 */
function FavoriteVideo({ part }: { part: FavItemPart }): React.JSX.Element {
  const [cover, setCover] = useState<LoadedUrl | null>(null)
  const [video, setVideo] = useState<LoadedUrl | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const videoKey = part.fullMd5 ?? part.md5 ?? ''
  const coverKey = part.thumbMd5 ?? part.fullMd5 ?? part.md5 ?? ''
  useEffect(() => {
    setCover(null)
    setVideo(null)
    setError('')
    if (coverKey === '') return
    let alive = true
    void (async () => {
      // 微信 4.x 的收藏封面在 business/favorite 下，和视频本体一样只能按
      // 明文 MD5 找到；朋友圈封面接口既不知道这份缓存，也会先白跑一次。
      try {
        const favorite = await apiGetFavoriteMediaDataUrl({
          ...(part.thumbMd5 ? { thumbMd5: part.thumbMd5 } : {}),
          ...(part.fullMd5 ? { fullMd5: part.fullMd5 } : {}),
          ...(part.md5 ? { md5: part.md5 } : {}),
          kind: 'image',
        })
        if (!alive) return
        if (typeof favorite.url === 'string' && favorite.url !== '') {
          setCover({ key: coverKey, url: favorite.url })
          return
        }
      } catch {
        // 老版本收藏可能不在本地缓存；再走朋友圈视频封面兜底。
      }
      try {
        const result = await apiGetSnsVideoCoverDataUrl({ md5: coverKey })
        if (alive && typeof result.url === 'string' && result.url !== '') {
          setCover({ key: coverKey, url: result.url })
        }
      } catch {
        // 两条链路都没有封面时保留播放按钮，详情其余字段仍可读。
      }
    })()
    return () => { alive = false }
  }, [coverKey])
  const src = video?.key === videoKey ? video.url : ''
  const poster = cover?.key === coverKey ? cover.url : ''
  const play = async (): Promise<void> => {
    if (videoKey === '' || loading) return
    setLoading(true)
    setError('')
    try {
      const favorite = await apiGetFavoriteMediaDataUrl({
        ...(part.fullMd5 ? { fullMd5: part.fullMd5 } : {}),
        ...(part.md5 ? { md5: part.md5 } : {}),
        kind: 'video',
      })
      if (typeof favorite.url === 'string' && favorite.url !== '') {
        setVideo({ key: videoKey, url: favorite.url })
        return
      }
      const result = await apiGetSnsVideoDataUrl({ md5: videoKey })
      if (typeof result.url === 'string' && result.url !== '') setVideo({ key: videoKey, url: result.url })
      else setError(favorite.error ?? result.error ?? '视频暂不可用')
    } catch (e) {
      setError(e instanceof Error ? e.message : '视频加载失败')
    } finally {
      setLoading(false)
    }
  }
  const duration = part.duration && part.duration > 0 ? ` · ${String(Math.round(part.duration))} 秒` : ''
  return (
    <div className={css.favMediaCard}>
      <div className={css.favMediaHeader}>
        <span className={css.favMediaIcon} aria-hidden="true">▷</span>
        <div className={css.favMediaBody}>
          <div className={css.favMediaTitle}>{part.text || part.title || '视频'}{duration}</div>
          {part.desc && <div className={css.favMediaDesc}>{part.desc}</div>}
        </div>
      </div>
      {src !== '' ? (
        <video className={css.favVideo} controls src={src} poster={poster || undefined} />
      ) : (
        <button type="button" className={css.favVideoStage} onClick={() => { void play() }} disabled={loading || videoKey === ''}>
          {poster !== '' && <img src={poster} alt="" loading="lazy" referrerPolicy="no-referrer" />}
          <span className={css.favVideoPlay}>{loading ? '加载中…' : videoKey === '' ? '无视频文件' : '播放视频'}</span>
        </button>
      )}
      {error !== '' && <div className={kitCss.textMeta}>{error}</div>}
    </div>
  )
}

/**
 * 收藏文件：点击时走与聊天附件相同的 `msg/file` 查找与浏览器下载。
 * @param props - 文件条目与收藏更新时间。
 * @returns 文件资源卡。
 */
function FavoriteFile({ part, updateTime }: { part: FavItemPart; updateTime: number }): React.JSX.Element {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const name = part.name || part.title || '未命名文件'
  const createTime = fileCreateTime(updateTime)
  const download = async (): Promise<void> => {
    if (loading) return
    setLoading(true)
    setError('')
    try {
      const favorite = await apiGetFavoriteMediaDataUrl({
        ...(part.fullMd5 ? { fullMd5: part.fullMd5 } : {}),
        ...(part.md5 ? { md5: part.md5 } : {}),
        kind: 'file',
        ...(part.ext ? { ext: part.ext } : {}),
        ...(name ? { fileName: name } : {}),
        ...(part.size !== undefined ? { size: part.size } : {}),
      }).catch(() => ({ error: '收藏缓存未命中' }))
      if ('url' in favorite && typeof favorite.url === 'string' && favorite.url !== '') {
        const anchor = document.createElement('a')
        anchor.href = favorite.url
        anchor.download = name
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        return
      }
      const result = await apiGetMessageFile({
        fileName: name,
        ...(part.size !== undefined ? { size: part.size } : {}),
        ...(createTime !== undefined ? { createTime } : {}),
      })
      if (!result.url) {
        setError(result.error ?? '本地未找到该文件')
        return
      }
      const anchor = document.createElement('a')
      anchor.href = result.url
      anchor.download = name
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    } catch (e) {
      setError(e instanceof Error ? e.message : '文件下载失败')
    } finally {
      setLoading(false)
    }
  }
  const meta = [part.ext?.toUpperCase(), part.size ? fmtBytes(part.size) : ''].filter(Boolean).join(' · ')
  return (
    <div className={css.favMediaCard}>
      <button type="button" className={css.favFileCard} onClick={() => { void download() }} disabled={loading}>
        <span className={css.favFileIcon} aria-hidden="true">{part.ext?.toLowerCase() === 'pdf' ? 'PDF' : '▤'}</span>
        <span className={css.favMediaBody}>
          <span className={css.favMediaTitle}>{name}</span>
          <span className={css.favMediaMeta}>{loading ? '正在查找…' : meta || '点击下载'}</span>
        </span>
        <span className={css.favFileAction} aria-hidden="true">{loading ? '…' : '↓'}</span>
      </button>
      {error !== '' && <div className={kitCss.textMeta}>{error}</div>}
    </div>
  )
}

/** 链接统一经 `openLink`，只放行 http(s)。 */
function FavoriteLink({ part }: { part: FavItemPart }): React.JSX.Element {
  const title = part.text || part.title || part.url || '链接'
  const url = part.url ?? ''
  return (
    <div className={css.favMediaCard}>
      <div className={css.favMediaHeader}>
        <span className={css.favMediaIcon} aria-hidden="true">↗</span>
        <div className={css.favMediaBody}>
          <div className={css.favMediaTitle}>{title}</div>
          {part.desc && <div className={css.favMediaDesc}>{part.desc}</div>}
        </div>
      </div>
      {url !== '' && (
        <a className={css.favMediaLink} href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => { e.preventDefault(); openLink(url) }}>
          {url}
        </a>
      )}
    </div>
  )
}

/** 远程/本机封面都可能出现，统一交给 `RemoteImg`。 */
function FavoriteCover({ src }: { src: string }): React.JSX.Element | null {
  if (src === '') return null
  const failed = <span className={kitCss.textMeta}>封面暂不可用</span>
  return (
    <div className={css.favMediaCover}>
      <RemoteImg src={src} alt="" loading="lazy" pending={null} failed={failed} empty={null} />
    </div>
  )
}

/**
 * 非图片/视频资源的封面：远程 URL 交给 `RemoteImg`；只有 MD5 时走收藏图片解码链。
 */
function FavoriteResourceCover({ part, src }: { part: FavItemPart; src: string }): React.JSX.Element | null {
  const md5 = part.thumbMd5 ?? part.fullMd5 ?? part.md5 ?? ''
  if (FAVORITE_MD5.test(md5)) return <FavoriteImage part={{ ...part, kind: 'image' }} thumbs={{}} />
  return <FavoriteCover src={src} />
}

/**
 * 渲染单个收藏资源。
 * @param props - 资源条目、收藏更新时间与图片缓存。
 * @returns 对应类型的详情内容。
 */
export function FavoritePart({ part, updateTime, thumbs }: FavoritePartProps): React.JSX.Element {
  if (part.kind === 'text') {
    return <div className={css.favPartText}>{part.text || part.desc || part.title || ''}</div>
  }
  if (part.kind === 'image') return <FavoriteImage part={part} thumbs={thumbs} />
  if (part.kind === 'voice') return <FavoriteVoice part={part} />
  if (part.kind === 'video') return <FavoriteVideo part={part} />
  if (part.kind === 'file') return <FavoriteFile part={part} updateTime={updateTime} />
  if (part.kind === 'link') return <FavoriteLink part={part} />
  if (part.kind === 'location') {
    const meta = [
      part.category,
      part.businessHours ? `营业时间 ${part.businessHours}` : '',
      part.phone ? `电话 ${part.phone}` : '',
      part.lat !== undefined && part.lng !== undefined ? `${part.lng.toFixed(6)}, ${part.lat.toFixed(6)}` : '',
    ].filter(Boolean)
    return (
      <div className={css.favMediaCard}>
        <div className={css.favMediaHeader}>
          <span className={css.favMediaIcon} aria-hidden="true">⌖</span>
          <div className={css.favMediaBody}>
            <div className={css.favMediaTitle}>{part.poiName || part.title || '位置'}</div>
            {part.address && <div className={css.favMediaDesc}>{part.address}</div>}
          </div>
        </div>
        {meta.length > 0 && <div className={css.favMediaMeta}>{meta.join(' · ')}</div>}
        {part.url && <a className={css.favMediaLink} href={part.url} target="_blank" rel="noopener noreferrer">在高德地图中查看</a>}
      </div>
    )
  }
  const appCard = part.kind === 'miniapp'
  const labels: Record<string, string> = {
    miniapp: '小程序',
    music: '音乐',
    product: '商品',
    note: '笔记',
    channels: '视频号',
    unknown: '其他资源',
  }
  const fallbackTitle = part.kind === 'unknown'
    ? `未识别收藏${part.dataType !== undefined ? ` · 类型 ${String(part.dataType)}` : ''}`
    : appCard
      ? '小程序'
      : labels[part.kind] ?? '资源'
  const title = part.title || part.text || part.name || fallbackTitle
  const details = [
    part.appId ? `AppID ${part.appId}` : '',
    part.appUsername ? `账号 ${part.appUsername}` : '',
    part.pagePath ? `页面 ${part.pagePath}` : '',
    part.desc ?? '',
  ].filter(Boolean)
  return (
    <div className={css.favMediaCard}>
      <div className={css.favMediaHeader}>
        <span className={css.favMediaIcon} aria-hidden="true">{appCard ? '⌘' : '◈'}</span>
        <div className={css.favMediaBody}>
          <div className={css.favMediaMeta}>
            {labels[part.kind] ?? '资源'}
            {part.kind === 'unknown' && part.dataType !== undefined ? ` · 类型 ${String(part.dataType)}` : ''}
          </div>
          <div className={css.favMediaTitle}>{title}</div>
        </div>
      </div>
      <FavoriteResourceCover
        part={part}
        src={part.iconUrl || part.coverUrl || (part.md5 ? thumbs[part.md5] ?? '' : '')}
      />
      {details.map((line, i) => <div key={i} className={css.favMediaDesc}>{line}</div>)}
      {part.meta?.map((row, i) => <div key={`meta-${String(i)}`} className={css.favMediaMeta}>{row.label}：{row.value}</div>)}
      {part.url && (
        <a
          className={css.favMediaLink}
          href={part.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => { e.preventDefault(); openLink(part.url ?? '') }}
        >{part.url}</a>
      )}
    </div>
  )
}
