/**
 * 文件面板的**一格**（#22 虚拟化：虚拟化数的是"行"，一行是横向排开的若干格）。
 *
 * 为什么拆出来：① 面板函数在单函数行数棘轮里记着 372 行（只许变小），虚拟化要在里面加
 * 测列数、按行渲染那几行；② 更要紧的是虚拟化之后每一格会反复挂载/卸载，
 * "接近视口才解码缩略图"这件事得有个能单独渲染一格来测的地方（原来是给整段格子墙挂
 * IntersectionObserver 观察 `data-media-key`）。
 *
 * 格子的可观察形状与搬出前逐条一致：有缩略图才出 `<img>`（否则是扩展名图标）、
 * 文件名不在这里 slice（CSS 省略号负责截断，`title` 里始终有全文）、
 * 图片点开是灯箱、视频与文件点开是详情抽屉（第 84 轮定的口径：可点且必须有真实动作）。
 */
import { useEffect } from 'react'
import { clickableKey } from '../ui/kit.tsx'
import css from './list-panel.module.css'
import { CAT_LABEL, fileDisplayName, fileKey, fileTitle } from './files-naming.ts'
import { fileIcon, fmtBytes, fmtMonthDaySec } from '../utils/format.ts'
import type { FileItem } from '@deepseek-ai/dsh-wechat-data/types'

export interface FileCellProps {
  /** 这一格对应的文件条目。 */
  f: FileItem
  /** 已解码的缩略图 data URL（图片类目才有；没有就是空串，画图标占位）。 */
  imgSrc: string
  /** 点这一格：图片走灯箱，视频/文件走详情抽屉（由面板决定具体开哪个）。 */
  onOpen: (f: FileItem) => void
  /**
   * 这一格挂载了 ⇒ 请求它的缩略图（只在图片类目上会被调用）。
   * 回调必须稳定，否则每次重渲染都会重新发起一轮解码。
   */
  onMounted: (key: string) => void
}

/**
 * 渲染一格文件。
 * @returns 该格元素。
 */
export function FileCell({ f, imgSrc, onOpen, onMounted }: FileCellProps): React.JSX.Element {
  const canPreview = f.category === 'image'
  const key = fileKey(f)
  // 「这一格挂上来了」就是原来观察器想表达的"接近视口"：解码要 setState，所以放 effect 里，
  // 不在渲染期直接调用。回调由面板 `useCallback(…, [])` 保持稳定，故只在 key 变化时再请求。
  useEffect(() => {
    if (canPreview) onMounted(key)
  }, [canPreview, key, onMounted])
  const iconHtml = fileIcon(((f.fileName || '').split('.').pop() ?? '').slice(0, 8))
  return (
    <div
      className={css.fileCell}
      data-file-key={key}
      title={fileTitle(f)}
      data-media-key={canPreview ? key : undefined}
      {...clickableKey(() => { onOpen(f) })}
    >
      {imgSrc ? (
        <img className={css.fileThumb} src={imgSrc} alt="" loading="lazy" referrerPolicy="no-referrer" />
      ) : (
        <span className={css.fileIcon} dangerouslySetInnerHTML={{ __html: iconHtml }} />
      )}
      {/* 不在这里 slice：让 CSS 省略号负责视觉截断，title 里始终有全文 */}
      <span className={css.fileName}>{fileDisplayName(f)}</span>
      <span className={css.fileMeta}>
        {CAT_LABEL[f.category] || f.category} · {fmtBytes(f.fileSize || 0)} · {fmtMonthDaySec(f.modifyTime)}
      </span>
    </div>
  )
}
