import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { useEscapeToClose } from '../ui/kit.tsx'

export interface MenuDismissRefs {
  rootRef: RefObject<HTMLDivElement>
  triggerRef: RefObject<HTMLButtonElement>
}

/**
 * 手写菜单的统一关闭规则。
 *
 * - Esc：关闭并把焦点还给触发按钮；
 * - pointerdown：点到根节点外关闭，不抢当前焦点；
 * - 菜单项动作由调用方先关闭菜单再执行，避免动作打开的新界面被菜单盖住。
 *
 * Esc 复用 kit 的覆盖层栈，嵌套弹窗中只关闭最上层。
 * @param open - 菜单是否打开。
 * @param onClose - 关闭菜单。
 * @returns 根节点与触发按钮的 ref。
 */
export function useMenuDismiss(open: boolean, onClose: () => void): MenuDismissRefs {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const closeFromKeyboard = useCallback((): void => {
    onClose()
    triggerRef.current?.focus()
  }, [onClose])
  useEscapeToClose(open, closeFromKeyboard)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current
      if (root !== null && !root.contains(event.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true) }
  }, [open, onClose])

  return { rootRef, triggerRef }
}
