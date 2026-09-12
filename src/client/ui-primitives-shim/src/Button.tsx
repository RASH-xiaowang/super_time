// Button: token-styled button atom. Variants map to the --dsw-alias-button-*
// fill families; no framework imports, all behavior via props.

import React from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import clsx from 'clsx'
import css from './Button.module.css'

/** Visual variant, each backed by its --dsw-alias-button-* token family. */
export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar' | 'danger' | 'pill'

/**
 * Render a button.
 *
 * 这是全项目**唯一**的按钮实现（面板里 271 个裸 `<button>` 应逐步迁移到这里）。
 * 统一约定：
 *  - 禁用态固定为 opacity .5 + cursor: not-allowed（此前各面板有 .4/.45/.5/.55/.6 五种）；
 *  - 提供 :focus-visible 焦点环（此前全套按钮都没有焦点样式，键盘用户看不到焦点）；
 *  - 颜色全部走 --dsw-alias-* / --nm-* 令牌，深浅主题自动跟随。
 *
 * @param props.variant - visual family (default 'ghost').
 * @param props.size - 'md' 36px capsule (figma Button) or 'sm' 28px compact.
 * @param props.icon - optional leading 16px icon node.
 * @param props.iconOnly - square icon-only form (no horizontal padding).
 * @returns the button element; native button attributes pass through.
 */
export function Button({ variant = 'ghost', size = 'md', icon, iconOnly = false, className, children, ...rest }: {
  variant?: ButtonVariant
  size?: 'md' | 'sm'
  icon?: ReactNode
  iconOnly?: boolean
  className?: string | undefined
  children?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={clsx(css.button, css[variant], css[size], iconOnly && css.iconOnly, className)}
      {...rest}
    >
      {icon != null && <span className={css.icon}>{icon}</span>}
      {children}
    </button>
  )
}
