/**
 * 桌面 IPC 与浏览器 HTTP/SSE 共用的客户端契约。
 *
 * 这些形状的两端事实来源都是主进程/后端，但 ui-wechat 与 ui-app 是两个独立的
 * typecheck program。此前 `RemoteEnvelope`、`LicenseStatus`、`UpdateState` 等被
 * 分别在多个文件里手抄，字段一改就只会有一侧先漂移。这里作为单一类型来源，
 * 传输层和设置面板都从本文件取类型。
 */

/**
 * `wechat:call` / HTTP 两条传输共用的后端信封。
 *
 * 用判别联合而不是“所有字段都可选”：`ok: true` 时 `value` 一定存在，
 * 这让调用方在检查 `ok` 之后可以直接返回 `res.value`。
 */
export type RemoteEnvelope<T = unknown> =
  | {
      ok: true
      value: T
      error?: never
    }
  | {
      ok: false
      value?: never
      error?: {
        code?: string
        message?: string
        details?: unknown
      }
    }

/** `wechat:event` / SSE 共用的后端事件载荷。 */
export interface BackendEvent {
  name: string
  args?: unknown[]
}

/** 主进程 `license:status` 返回的授权状态。 */
export interface LicenseStatus {
  state: string
  licensed: boolean
  code?: string
  reason?: string
  payload?: {
    licenseId?: string
    edition?: string
    issuedTo?: { name?: string, company?: string, email?: string }
    expiresAt?: string | null
    features?: string[]
    seats?: number
  } | null
  device?: {
    fingerprintShort?: string
    hostname?: string
  }
  daysToExpiry?: number | null
  licensePath?: string
}

/** 主进程 `remote-access:state` / `rotate` / `toggle` 返回的远程访问状态。 */
export interface RemoteAccessState {
  running: boolean
  /** 当前监听端口；未运行时为 0。 */
  port: number
  /** 配置中的端口；未运行时用于防火墙指引。 */
  configuredPort: number
  address: string
  addresses: string[]
  enabled: boolean
  hasToken: boolean
  tokenMasked: string
  sessions?: number
  pairingCodes?: number
}

/** 主进程 `remote-access:rotate` 的一次性轮换结果：长期令牌与短命配对码都只在这里出现。 */
export interface RemoteAccessRotation {
  token: string
  pairingCode: string
  state: RemoteAccessState
}

/** 主进程 `update:state` / `update:event` 的状态阶段。 */
export type UpdatePhase =
  | 'idle'
  | 'unsupported'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error'
  | 'retrying'
  | 'skipped'

export interface UpdateProgress {
  percent: number
  transferred: number | null
  total: number | null
  bytesPerSecond: number | null
}

export interface UpdateState {
  phase: UpdatePhase
  currentVersion: string | null
  version: string | null
  releaseName: string | null
  releaseNotes: string | null
  releaseDate: string | null
  progress: UpdateProgress | null
  error: string | null
  reason: 'dev' | 'disabled' | 'unavailable' | 'unknown' | null
  checkedAt: string | null
  manual: boolean
  skippedVersion?: string | null
  attempt?: number
  willRetry?: boolean
  nextRetryAt?: string | null
}
