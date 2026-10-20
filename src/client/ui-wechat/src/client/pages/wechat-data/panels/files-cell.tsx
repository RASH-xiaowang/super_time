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
 *
 * 另外，本文件还承载**本组（文件/媒体/存储/公众号）共用的小件**：内联 KPI 条与
 * 页头「更多」菜单。写在这里而不是各自复制一份：四个面板要在同一套视觉语言下，
 * 而 task-7 的写权限只覆盖这几个文件，asset-ui.tsx 不归本组改。
 */
import { useEffect, useState } from 'react'
import { clickableKey } from '../ui/kit.tsx'
import css from './list-panel.module.css'
import { CAT_LABEL, fileDisplayName, fileKey, fileTitle } from './files-naming.ts'
import { fileIcon, fmtBytes, fmtMonthDaySec } from '../utils/format.ts'
import type { FileItem } from '@deepseek-ai/dsh-wechat-data/types'

/** KPI 条里的一格：标签在上、数值在下。语义色只用在小面积数值上。 */
export interface AssetKpiItem {
  label: React.ReactNode
  value: React.ReactNode
  tone?: 'success' | 'danger'
}

/**
 * 资产类页面统一的内联 KPI 条（高约 44px）。
 * @param props.items - 按顺序排列的指标。
 * @returns KPI 条元素。
 */
export function AssetKpiBar({ items }: { items: ReadonlyArray<AssetKpiItem> }): React.JSX.Element {
  return (
    <div className={css.kpiBar} role="group">
      {items.map((it, i) => (
        <div key={i} className={css.kpiItem} data-tone={it.tone}>
          <span className={css.kpiLabel}>{it.label}</span>
          <span className={css.kpiValue}>{it.value}</span>
        </div>
      ))}
    </div>
  )
}

/** 「更多 ▾」菜单里的一项。 */
export interface AssetMenuItem {
  key: string
  label: React.ReactNode
  /** 点击动作；菜单在调用前先收起。 */
  onSelect: () => void
  disabled?: boolean
  title?: string
}

/**
 * 页头「更多 ▾」动作菜单。页头只留「主操作 + 更多」，低频动作收进来。
 * 用条件渲染而不是 `<details>`：关闭的详情内容仍留在 DOM 里会被响应式审计判成隐藏文本。
 * @param props.items - 菜单项。
 * @returns 菜单元素。
 */
export function AssetMoreMenu({ items }: { items: ReadonlyArray<AssetMenuItem> }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className={css.moreMenu}>
      <button
        type="button"
        className={css.catBtn}
        aria-label="更多操作"
        aria-expanded={open}
        onClick={() => { setOpen(v => !v) }}
      >
        更多 ▾
      </button>
      {open && (
        <div className={css.morePanel} role="menu" aria-label="更多操作" onMouseLeave={() => { setOpen(false) }}>
          {items.map(it => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              className={css.moreItem}
              disabled={it.disabled}
              title={it.title}
              onClick={() => { setOpen(false); it.onSelect() }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

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
  const icon = (f.fileName || '').split('.').pop() ?? ''
  return (
    <div
      className={css.fileCell}
      data-file-key={key}
      title={fileTitle(f)}
      data-media-key={canPreview ? key : undefined}
      {...clickableKey(() => { onOpen(f) })}
    >
      {imgSrc ? (
        <div className={css.fileThumbWrap}>
          <img className={css.fileThumb} src={imgSrc} alt="" loading="lazy" referrerPolicy="no-referrer" />
        </div>
      ) : (
        <div className={css.fileIconWrap} aria-hidden="true">
          <span className={css.fileIcon} dangerouslySetInnerHTML={{ __html: iconHtml }} />
          {icon && <span className={css.fileExt}>{icon.slice(0, 6)}</span>}
        </div>
      )}
      {/* 不在这里 slice：让 CSS 省略号负责视觉截断，title 里始终有全文 */}
      <span className={css.fileName}>{fileDisplayName(f)}</span>
      <span className={css.fileMeta}>
        {CAT_LABEL[f.category] || f.category} · {fmtBytes(f.fileSize || 0)} · {fmtMonthDaySec(f.modifyTime)}
      </span>
    </div>
  )
}
