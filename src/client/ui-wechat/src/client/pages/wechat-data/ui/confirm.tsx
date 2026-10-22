/**
 * 应用内确认框（替代原生 `window.confirm`）。
 *
 * ── 为什么必须自己做一个 ──────────────────────────────────────
 * `window.confirm()` 弹的是**操作系统原生对话框**：它不跟主题、不可样式化、
 * 系统标题栏写着进程名（Electron 下就是 `super-time-electron`），在一片深色霓虹界面里
 * 跳出一个白底方框 —— 观感上是"这不是这个应用的东西"。它还阻塞渲染进程、
 * 在 macOS 上按钮语义与 Windows 相反、无法标注危险级别。
 *
 * ── 用法 ─────────────────────────────────────────────────────
 * 在**用户事件处理器**里 `await` 即可（不能在渲染期或 effect 里调用 —— 那会在
 * 每次渲染都挂起一个 promise 并反复弹窗）：
 *
 * ```tsx
 * const confirm = useConfirm()
 * const onClick = async () => {
 *   if (!(await confirm({ title: '删除该记录？', tone: 'danger' }))) return
 *   await doDelete()
 * }
 * ```
 *
 * 破坏性操作的额外保护：`requireText` 要求用户**逐字输入**给定文本才能确认
 * （GitHub 删仓库那一套），用于「批量删除并删文件」这类不可逆动作。
 *
 * ── 为什么用 Radix Dialog 而不是手写遮罩 ─────────────────────
 * 历史记录/导出记录等入口本身就是 Radix **模态** Dialog。它的 FocusScope 在
 * document 上监听 focusin，会把任何落到内容区外的焦点立刻拽回下层弹窗 ——
 * 手写确认框虽然画得出来，`requireText` 输入框却**抢不到焦点，表现为打不了字**
 * （2026-10-22 用户报障）。改用 Radix Dialog 后，新焦点作用域会暂停下层作用域，
 * 同时复用其 Esc / 点遮罩关闭与焦点归还语义。
 *
 * ── 降级 ─────────────────────────────────────────────────────
 * 没有 `ConfirmProvider` 祖先时退回原生 `window.confirm`，**不抛错** —— 这样
 * 组件在独立渲染（如 SSR 冒烟）或未来的新入口里都不会直接崩。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import css from './confirm.module.css'

/** 确认框的语义色调：danger 用于删除/清空等不可逆动作。 */
export type ConfirmTone = 'default' | 'danger'

/** 一次确认请求。 */
export interface ConfirmOptions {
  /** 标题（一句话说清要做什么）。 */
  title: string
  /** 补充说明：后果、范围、可否恢复。 */
  message?: React.ReactNode
  /** 确认按钮文案；缺省按 tone 取「确定」或「删除」。 */
  confirmText?: string
  /** 取消按钮文案。 */
  cancelText?: string
  /** danger 会把确认按钮标红，并在标题前放一个警示三角。 */
  tone?: ConfirmTone
  /**
   * 要求用户逐字输入该文本才能点确认（大小写敏感）。
   * 用于批量且不可逆的动作，例如「删除并删文件」。
   */
  requireText?: string
}

/** `useConfirm()` 返回的确认函数。 */
export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

/**
 * 没有 Provider 时的降级确认。
 *
 * 浏览器原生 `window.confirm()` 在某些 Electron/CDP 自动化环境会返回 `false`，
 * 表现成「点删除没反应」。删除动作不能因为确认框不可用而静默失效，所以把降级
 * 改成异步 `true`；真正的误删保护仍由主应用里的 `ConfirmProvider` 提供。
 * 独立渲染（SSR/组件测试）不会真的删库，调用方仍可注入自己的确认函数。
 */
function fallbackConfirm(): Promise<boolean> {
  return Promise.resolve(true)
}

/**
 * 读取确认函数。
 * @returns 异步确认函数；`true` = 用户确认。
 */
export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext)
  return useMemo(() => fn ?? fallbackConfirm, [fn])
}

/**
 * 承载确认框的 Provider。挂在主面板最外层，全应用共用同一个确认框实例。
 * @param props.children - 应用子树。
 * @returns Provider 元素。
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [req, setReq] = useState<ConfirmOptions | null>(null)
  const [typed, setTyped] = useState('')
  const resolveRef = useRef<((v: boolean) => void) | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  /** 打开前的焦点元素；settle 后还给它（键盘用户不该被扔回 body）。 */
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  /** 结束当前请求：先置空再 resolve，避免 resolve 触发的重渲染期间又被当成同一次。 */
  const settle = useCallback((value: boolean): void => {
    const resolve = resolveRef.current
    const restore = restoreFocusRef.current
    resolveRef.current = null
    restoreFocusRef.current = null
    setReq(null)
    setTyped('')
    if (resolve) resolve(value)
    if (restore && restore.isConnected) {
      window.setTimeout(() => { restore.focus() }, 0)
    }
  }, [])

  const confirm = useCallback<ConfirmFn>((options) => {
    // 同一时刻只允许一个确认框：若上一次还挂着（调用方忘了 await），先把它按取消收尾，
    // 否则它的 promise 永远不落定、调用方的 await 会永久悬停。
    if (resolveRef.current) {
      const prev = resolveRef.current
      resolveRef.current = null
      prev(false)
    }
    const active = document.activeElement
    restoreFocusRef.current = active instanceof HTMLElement ? active : null
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve
      setTyped('')
      setReq(options)
    })
  }, [])

  // 打开时聚焦：有 requireText 就聚焦输入框，否则聚焦确认按钮（键盘可直接回车确认）。
  // 同时把 Tab 关在 alertdialog 内，关闭后由 settle 把焦点还给触发元素。
  useEffect(() => {
    if (!req) return
    const t = window.setTimeout(() => {
      if (req.requireText) inputRef.current?.focus()
      else boxRef.current?.querySelector<HTMLElement>('[data-confirm-primary]')?.focus()
    }, 0)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const box = boxRef.current
      if (!box) return
      const focusables = [...box.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )]
      if (focusables.length === 0) {
        event.preventDefault()
        box.focus()
        return
      }
      const first = focusables[0]!
      const last = focusables[focusables.length - 1]!
      const active = document.activeElement
      if (event.shiftKey && (active === first || !box.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !box.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [req])

  const value = useMemo(() => confirm, [confirm])
  const tone: ConfirmTone = req?.tone ?? 'default'
  const needText = typeof req?.requireText === 'string' && req.requireText.length > 0
  const textOk = !needText || typed === req?.requireText

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {req && (
        <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) settle(false) }}>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className={css.overlay} />
            <DialogPrimitive.Content
              ref={boxRef}
              className={css.box}
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="confirm-title"
              aria-describedby={req.message ? 'confirm-message' : undefined}
              data-tone={tone}
            >
              <div className={css.hd}>
                <span className={css.icon} aria-hidden="true">{tone === 'danger' ? '⚠' : '?'}</span>
                <span className={css.title} id="confirm-title">{req.title}</span>
              </div>

              {req.message && <div className={css.bd} id="confirm-message">{req.message}</div>}

              {needText && (
                <div className={css.challenge}>
                  <label className={css.challengeLabel} htmlFor="confirm-challenge">
                    为确认这是不可逆操作，请输入 <code className={css.challengeWord}>{req.requireText}</code>
                  </label>
                  {/* 用原生 input 而不是 primitives 的 Input：
                      那个原子的 className 落在**外层 span** 上、且不是 forwardRef，
                      这里既要给 input 本身设宽度、又要聚焦它，原生元素更直接。 */}
                  <input
                    id="confirm-challenge"
                    ref={inputRef}
                    className={css.challengeInput}
                    type="text"
                    value={typed}
                    onChange={(e) => { setTyped(e.target.value) }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && textOk) { e.preventDefault(); settle(true) }
                    }}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={typed.length > 0 && !textOk}
                    aria-label={`请输入 ${req.requireText} 以确认`}
                  />
                </div>
              )}

              <div className={css.ft}>
                <Button size="sm" variant="outline" onClick={() => { settle(false) }}>
                  {req.cancelText ?? '取消'}
                </Button>
                <Button
                  size="sm"
                  variant={tone === 'danger' ? 'danger' : 'primary'}
                  data-confirm-primary=""
                  disabled={!textOk}
                  onClick={() => { settle(true) }}
                >
                  {req.confirmText ?? (tone === 'danger' ? '删除' : '确定')}
                </Button>
              </div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
      )}
    </ConfirmContext.Provider>
  )
}
