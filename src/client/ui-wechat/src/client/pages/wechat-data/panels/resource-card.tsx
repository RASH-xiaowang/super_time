/**
 * 问答资源卡的安全打开动作。
 *
 * 资源定位字段里既有可用于取回本机媒体的键，也有只适合内部传递的凭据。
 * 这里按资源种类显式白名单动作：只有存在可验证的定位信息时才渲染按钮，
 * 且 URL 只接受 http/https；其余资源明确显示“仅摘要”，绝不把内部键拼成
 * 看似可点击的路径。
 */
import { useState } from 'react'
import {
  apiGetFavoriteMediaDataUrl,
  apiGetFileImageDataUrl,
  apiGetMessageFile,
  apiGetSnsImageDataUrl,
} from '../api.ts'
import { preferMediaUrl } from '../wechat-media.ts'
import { fmtBytes } from '../utils/format.ts'
import type { AnswerRuntimeResourceCitation, EvidenceLocator } from './use-ask.ts'
import { openLink } from './chats-support.tsx'
import css from './ask-runtime.module.css'

type ResourceLocator = Extract<EvidenceLocator, { type: 'resource' }>

export type ResourceActionKind =
  | 'moment-image'
  | 'favorite-image'
  | 'favorite-video'
  | 'favorite-file'
  | 'file-image'
  | 'file-download'
  | 'external-link'
  | 'none'

function locatorOf(resource: AnswerRuntimeResourceCitation): ResourceLocator | null {
  return resource.locator?.type === 'resource' ? resource.locator : null
}

function safeHttpUrl(value: string | undefined): string {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim()) ? value.trim() : ''
}

function hasFavoriteMedia(locator: ResourceLocator): boolean {
  return typeof locator.md5 === 'string' && locator.md5.trim() !== ''
}

/**
 * 判断资源能安全执行哪一种动作。
 *
 * 纯函数导出给测试使用，避免未来新增资源字段时把任意 `url` 都当成可打开链接。
 */
export function resourceActionKind(resource: AnswerRuntimeResourceCitation): ResourceActionKind {
  const locator = locatorOf(resource)
  if (!locator) return 'none'
  const url = safeHttpUrl(locator.url)
  if (locator.resourceKind === 'moment') {
    const imageLocator = hasFavoriteMedia(locator)
      || (typeof locator.timelineId === 'string' && locator.timelineId !== ''
        && typeof locator.mediaId === 'string' && locator.mediaId !== '')
    return imageLocator ? 'moment-image' : url ? 'external-link' : 'none'
  }
  if (locator.resourceKind === 'favorite') {
    if (locator.mediaKind === 'image' && hasFavoriteMedia(locator)) return 'favorite-image'
    if (locator.mediaKind === 'video' && hasFavoriteMedia(locator)) return 'favorite-video'
    if (locator.mediaKind === 'file' && (hasFavoriteMedia(locator) || Boolean(locator.fileName))) {
      return 'favorite-file'
    }
    return url ? 'external-link' : 'none'
  }
  if (locator.resourceKind === 'file') {
    if (locator.category === 'image' && hasFavoriteMedia(locator)) return 'file-image'
    if (locator.fileName || hasFavoriteMedia(locator)) return 'file-download'
    return url ? 'external-link' : 'none'
  }
  // 转账/红包目前没有安全的本地打开协议，不能用记录 id 伪造深链。
  return url ? 'external-link' : 'none'
}

function useHttpMedia(): boolean {
  return typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol)
}

function saveUrl(url: string, name: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

function displayName(resource: AnswerRuntimeResourceCitation): string {
  const locator = locatorOf(resource)
  return resource.name || locator?.fileName || '未命名资源'
}

async function loadImage(resource: AnswerRuntimeResourceCitation): Promise<string> {
  const locator = locatorOf(resource)
  if (!locator) return ''
  const useHttp = useHttpMedia()
  const kind = resourceActionKind(resource)
  if (kind === 'moment-image') {
    const row = await apiGetSnsImageDataUrl({
      md5: locator.md5 ?? '',
      ...(locator.timelineId ? { timelineId: locator.timelineId } : {}),
      ...(locator.mediaId ? { mediaId: locator.mediaId } : {}),
      ...(locator.url ? { url: locator.url } : {}),
      ...(locator.token ? { token: locator.token } : {}),
      ...(locator.seed ? { seed: locator.seed } : {}),
    })
    return preferMediaUrl(row, useHttp).url ?? ''
  }
  if (kind === 'favorite-image') {
    const row = await apiGetFavoriteMediaDataUrl({
      md5: locator.md5,
      kind: 'image',
      ...(locator.fileName ? { fileName: locator.fileName } : {}),
      ...(locator.size ? { size: locator.size } : {}),
    })
    return preferMediaUrl(row, useHttp).url ?? ''
  }
  if (kind === 'file-image' && locator.md5) {
    const row = await apiGetFileImageDataUrl({ md5: locator.md5 })
    return preferMediaUrl(row, useHttp).url ?? ''
  }
  return ''
}

async function loadVideo(resource: AnswerRuntimeResourceCitation): Promise<string> {
  const locator = locatorOf(resource)
  if (!locator?.md5 || resourceActionKind(resource) !== 'favorite-video') return ''
  const row = await apiGetFavoriteMediaDataUrl({ md5: locator.md5, kind: 'video' })
  return preferMediaUrl(row, useHttpMedia()).url ?? ''
}

async function downloadFavorite(resource: AnswerRuntimeResourceCitation): Promise<void> {
  const locator = locatorOf(resource)
  if (!locator) return
  const name = displayName(resource)
  if (locator.md5) {
    const row = await apiGetFavoriteMediaDataUrl({
      md5: locator.md5,
      kind: 'file',
      fileName: name,
      ...(locator.size ? { size: locator.size } : {}),
    })
    if (row.url) {
      saveUrl(row.url, name)
      return
    }
  }
  const row = await apiGetMessageFile({
    fileName: name,
    ...(locator.size ? { size: locator.size } : {}),
  })
  if (row.url) saveUrl(row.url, name)
  else throw new Error(row.error ?? '本地未找到该文件')
}

async function downloadFile(resource: AnswerRuntimeResourceCitation): Promise<void> {
  const locator = locatorOf(resource)
  if (!locator) return
  const name = displayName(resource)
  const row = await apiGetMessageFile({
    fileName: name,
    ...(locator.size ? { size: locator.size } : {}),
  })
  if (row.url) saveUrl(row.url, name)
  else throw new Error(row.error ?? '本地未找到该文件')
}

/**
 * 一张资源卡。动作按需触发，默认不自动拉取大文件或远程媒体。
 */
export function ResourceCard({ resource }: { resource: AnswerRuntimeResourceCitation }): React.JSX.Element {
  const locator = locatorOf(resource)
  const action = resourceActionKind(resource)
  const name = displayName(resource)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [image, setImage] = useState('')
  const [video, setVideo] = useState('')

  const run = async (task: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await task()
    } catch (e) {
      setError(e instanceof Error ? e.message : '资源打开失败')
    } finally {
      setBusy(false)
    }
  }

  const previewImage = (): void => {
    void run(async () => {
      const url = await loadImage(resource)
      if (!url) throw new Error('图片暂不可用')
      setImage(url)
    })
  }
  const playVideo = (): void => {
    void run(async () => {
      const url = await loadVideo(resource)
      if (!url) throw new Error('视频暂不可用')
      setVideo(url)
    })
  }

  const label = action === 'favorite-video'
    ? '播放视频'
    : action === 'favorite-file' || action === 'file-download'
      ? '下载文件'
      : action === 'external-link'
        ? '打开链接'
        : action === 'none'
          ? ''
          : '查看图片'

  return (
    <li className={css.resourceCard}>
      <div className={css.resourceHead}>
        <span className={css.resourceName} title={name}>{name}</span>
        {resource.time && <span className={css.resourceTime}>{resource.time}</span>}
      </div>
      {resource.snippet && (
        <div className={css.resourceSnippet} title={resource.snippet}>{resource.snippet}</div>
      )}
      <div className={css.resourceMeta}>
        {resourceMetaText(resource)}
        {action === 'none' && <span className={css.resourceOnly}>仅摘要</span>}
      </div>
      {image && <img className={css.resourceImage} src={image} alt={name} loading="lazy" decoding="async" />}
      {video && <video className={css.resourceVideo} src={video} controls preload="metadata" />}
      {label !== '' && (
        <div className={css.resourceActions}>
          <button
            type="button"
            className={css.resourceAction}
            disabled={busy}
            onClick={() => {
              if (action === 'external-link') {
                const url = safeHttpUrl(locator?.url)
                if (url) openLink(url)
                return
              }
              if (action === 'favorite-video') playVideo()
              else if (action === 'favorite-image' || action === 'file-image' || action === 'moment-image') previewImage()
              else if (action === 'favorite-file') void run(() => downloadFavorite(resource))
              else if (action === 'file-download') void run(() => downloadFile(resource))
            }}
          >
            {busy ? '读取中…' : image || video ? '重新加载' : label}
          </button>
        </div>
      )}
      {error && <div className={css.resourceError} role="alert">{error}</div>}
    </li>
  )
}

function resourceMetaText(resource: AnswerRuntimeResourceCitation): string {
  const locator = locatorOf(resource)
  if (!locator) return '资源'
  const kind = {
    file: '文件',
    favorite: '收藏',
    moment: '朋友圈',
    record: '转账/红包',
  }[locator.resourceKind ?? 'file'] ?? '资源'
  const category = locator.category || locator.mediaKind || ''
  return [
    kind,
    category && category !== kind ? category : '',
    locator.fileName && locator.fileName !== resource.name ? locator.fileName : '',
    typeof locator.size === 'number' && locator.size > 0 ? fmtBytes(locator.size) : '',
    locator.session ? `会话 ${locator.session}` : '',
  ].filter(Boolean).join(' · ')
}
