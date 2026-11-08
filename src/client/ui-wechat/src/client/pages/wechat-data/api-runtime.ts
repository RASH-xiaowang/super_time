/**
 * Remote/runtime seams for the Wechat data API.
 *
 * Hosts inject the Remote client and directory picker here. `api-core.ts`
 * re-exports this module so existing consumers keep their import paths.
 *
 * @module api-runtime
 */

import type { RemoteResult, WechatRemote } from './api-core.ts'

let _remote: (() => WechatRemote) | null = null

/**
 * Rewrite a session-authentication failure (HTTP 401 from the API channel,
 * which is the browser cookie gate) into an actionable message. The raw
 * transport text ("transport failure for ...: HTTP 401") leaves the user with
 * no idea that reopening the app re-authenticates.
 * @param e - the thrown error from a remote call.
 * @returns an Error with a user-facing message when the failure is HTTP 401.
 */
export function actionableRemoteError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e)
  if (/HTTP 401\b/.test(msg)) {
    return new Error('本地会话认证已失效（HTTP 401）：请关闭并重新打开本页面；若仍失败，请用「dsh web」启动时打印的带 token 的地址重新打开应用以完成重新认证')
  }
  return e instanceof Error ? e : new Error(msg)
}

/**
 * Install the Remote client (called from ui-pages apply).
 * @param remote - The Remote client to install.
 */
export function setWechatRemote(remote: WechatRemote | (() => WechatRemote)): void {
  const base = typeof remote === 'function' ? remote : () => remote
  // Wrap every method so transport failures (HTTP 401 session expiry) surface an
  // actionable message across all panels, not only explicit catch sites.
  _remote = () => new Proxy(base(), {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver)
      if (typeof v !== 'function') return v
      return (...args: unknown[]) => {
        try {
          const r = (v as (...a: unknown[]) => unknown).apply(target, args)
          return r instanceof Promise
            ? r.catch((e: unknown) => { throw actionableRemoteError(e) })
            : r
        } catch (e) {
          throw actionableRemoteError(e)
        }
      }
    },
  }) as WechatRemote
}

export function remote(): WechatRemote {
  if (_remote === null) throw new Error('wechat-data remote not installed')
  return _remote()
}

let _pickDirectory: (() => Promise<string | null>) | null = null

/** Install the host directory chooser (ui-pages apply injects ctx.workspaces). */
export function setDirectoryPicker(pick: () => Promise<string | null>): void {
  _pickDirectory = pick
}

/** 打开原生目录选择框；取消返回 null。 */
export async function pickDirectory(): Promise<string | null> {
  if (_pickDirectory === null) return null
  return _pickDirectory()
}

/** 面板截图导出的结果。 */
export interface CaptureResult {
  ok: boolean
  /** 用户在保存对话框里取消了。 */
  canceled?: boolean
  /** 落盘路径（成功时）。 */
  path?: string
  bytes?: number
  width?: number
  height?: number
  message?: string
}

export function unwrap<T>(r: RemoteResult<T>): T {
  if (!r.ok) {
    // 错误码必须跟着一起抛：调用方要靠它区分「用户主动停止」与「真失败」——
    // 两者对用户是两回事（ask 的取消、导出的取消都是这个形态）。只带 message 的话，
    // 面板只能把一次正常的取消显示成红色错误。
    const err = new Error(r.error?.message ?? r.error?.code ?? 'remote call failed') as Error & { code?: string }
    if (typeof r.error?.code === 'string') err.code = r.error.code
    throw err
  }
  return r.value as T
}
