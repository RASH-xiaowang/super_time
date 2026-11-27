/**
 * Local UI glue shared by the asset panels in this folder.
 * This is panel-local layout, not an addition to the shared `ui/kit`.
 */
import * as React from 'react'
import { type ReactNode } from 'react'
import { SearchInput, Segmented, Toolbar, clickableKey } from '../ui/kit.tsx'
import { withThumbWidth, wechatMediaUrl } from '../wechat-media.ts'
import type { EmoticonItem } from '@deepseek-ai/dsh-wechat-data/types'
import css from './list-panel.module.css'

export interface ListFilterProps {
  searchValue: string
  onSearch: (value: string) => void
  searchPlaceholder: string
  searchAriaLabel: string
  segments: ReadonlyArray<{ value: string; label: ReactNode }>
  value: string
  onChange: (value: string) => void
  ariaLabel: string
}

/**
 * Shared search + segmented filter row. Toolbar still comes from ui/kit, so the
 * data and aria contracts stay in one place.
 */
export function ListFilter({ searchValue, onSearch, searchPlaceholder, searchAriaLabel, segments, value, onChange, ariaLabel }: ListFilterProps): React.JSX.Element {
  return (
    <Toolbar
      left={(
        <SearchInput
          className={css.searchGrow}
          value={searchValue}
          onChange={onSearch}
          placeholder={searchPlaceholder}
          ariaLabel={searchAriaLabel}
        />
      )}
      right={(
        <Segmented
          options={segments}
          value={value}
          onChange={onChange}
          ariaLabel={ariaLabel}
        />
      )}
    />
  )
}

export interface PanelActionProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean
}

/** Compact action chip used by the list-panel headers. */
export function PanelAction({ active = false, children, ...rest }: PanelActionProps): React.JSX.Element {
  return (
    <button type="button" className={css.catBtn} data-active={active ? 'true' : undefined} {...rest}>
      {children}
    </button>
  )
}

function emoTypeLabel(t: number | undefined): string {
  if (t === 1) return '图片'
  if (t === 2) return 'GIF'
  if (t === 3) return '动图'
  return ''
}

export function EmoticonCell({ e, onCopy, itemIndex }: {
  e: EmoticonItem
  onCopy: (md5: string) => void
  /**
   * 取图失败时回调（可选）。
   *
   * 为什么需要：消息库里扫出的「其他表情」只有 md5，本地 `.dat` 缓存可能早已被微信清掉
   * （本机实测 500 个里 478 个取不到）。这些格子显示成 😀 占位符会让用户以为在加载，
   * 父组件收到回调后把它们从列表里摘掉，只留真正能看的表情。
  */
  onUnavailable?: (md5: string) => void
  /** 渐进窗口的原始索引，用于回收头部时测量真实高度。 */
  itemIndex?: number
}): React.JSX.Element {
  const src = e.file ? withThumbWidth(wechatMediaUrl(e.file), 160) : null

  const title = `${e.caption || '自定义表情'}\nMD5：${e.md5}${emoTypeLabel(e.item_type) ? `\n类型：${emoTypeLabel(e.item_type)}` : ''}\n点击复制 MD5`

  /*
   * 2026-10-17 重做：改前每格固定三行文字 —— 「自定义表情」/「MD5 · 2b272f27」/
   * 「点击复制 MD5」，30 个格子就是 90 行重复文案，把图片挤到只占格子 1/3
   * （真机截图）。现在只留图片 + 一行名称（有 caption 时才显示），
   * MD5 与「点击复制」提示收进 `title`（hover 可见），格子高度从 150px 降到 96px。
   */
  return (
    <div
      className={css.emoCell}
      data-emo-md5={e.md5}
      data-progressive-item={itemIndex}
      title={title}
      {...clickableKey(() => { onCopy(e.md5) })}
    >
      {src ? (
        <img className={css.emoImg} src={src} alt={e.caption || '表情'} loading="lazy" decoding="async" />
      ) : (
        <span className={css.emoPh} title="表情还在保存">…</span>
      )}
      {e.caption !== undefined && e.caption !== '' && (
        <span className={css.emoName}>{e.caption}</span>
      )}
    </div>
  )
}

export function PackageCell({ name, count, itemIndex }: { name: string; count: number; itemIndex?: number }): React.JSX.Element {
  return (
    <div className={css.fileCell} data-progressive-item={itemIndex} title={name}>
      <span className={css.fileIcon}>📦</span>
      <span className={css.fileName}>{name}</span>
      <span className={css.fileMeta}>{count} 个表情</span>
    </div>
  )
}
