/**
 * `preload.js` 暴露给渲染进程的桥的类型面。
 *
 * 原先每个调用点各自写 `(window as any).electronAPI`，字段改名或桥被裁剪时
 * 编译完全看不见。这份声明把桥的**形状**收在一处，并把主进程 handler 的
 * 返回载荷做成可以收窄的类型，避免返回面继续靠 `any` 漂移。
 */

import type {
  LlmBalance,
  LlmConnectionProbe,
  LlmModelsResult,
  LlmProbeKind,
  LlmProfilesSnapshot,
  WechatLlmConfig,
} from './pages/wechat-data/llm-config.ts'
import type {
  BackendEvent,
  LicenseStatus,
  RemoteAccessState,
  RemoteAccessRotation,
  RemoteEnvelope,
  UpdateState,
} from './contracts.ts'

export type {
  BackendEvent,
  LicenseStatus,
  RemoteAccessState,
  RemoteAccessRotation,
  RemoteEnvelope,
  UpdateState,
}

/** 主进程 `app:versions` 下发的运行时版本。 */
export interface RuntimeVersions {
  electron: string
  chrome: string
  node: string
  app: string
  platform: string
  arch: string
}

/** `wechat:info` 里的入参守卫影子账本。 */
export interface ArgGuardSnapshot {
  covered: number
  total: number
  uncovered: number
  enforced: string[]
  mismatched: string[]
  largest: Array<{ method: string, maxBytes: number }>
}

/** `wechat:info` 的返回载荷（字段见 `src/backend/wechat-host.js`）。 */
export interface WechatInfo {
  root: string
  decrypted: string
  decoded: string
  selfUsername: string
  pathConfig: string
  methods: string[]
  llmConfigured: boolean
  argGuard: ArgGuardSnapshot
}

export interface CallQueueSnapshot {
  active: number
  queued: number
}

/** `wechat:backend-state` 里的 RPC 统计。 */
export interface RpcStats {
  timedOut: number
}

/** 后端 worker 状态快照（可随实现再补字段）。 */
export interface BackendStatus {
  state: string
  restarts: number
  lastError: string | null
  callQueue?: CallQueueSnapshot
  rpc?: RpcStats
}

export interface LlmModelsOptions {
  baseUrl: string
  apiKey: string
}

export interface LlmProbeOptions {
  baseUrl: string
  apiKey: string
  kind?: LlmProbeKind
  path?: string
  model?: string
}

export interface LlmBalanceOptions {
  baseUrl: string
  apiKey: string
}

export interface LlmProfileOptions {
  id?: string
  label?: string
  config?: WechatLlmConfig
  activate?: boolean
}

export interface FileFilter {
  name: string
  extensions: string[]
}

export interface OpenFileOptions {
  title?: string
  filters?: FileFilter[]
}

export interface OpenFileResult {
  canceled: boolean
  files: string[]
  error?: string
}

export interface PickDirectoryResult {
  path?: string | null
  canceled?: boolean
}

export interface SaveFileOptions {
  title?: string
  defaultName?: string
  filters?: FileFilter[]
}

export interface SaveFileResult {
  canceled: boolean
  path: string | null
}

export interface CaptureRect {
  x: number
  y: number
  width: number
  height: number
  filename?: string
}

export interface CaptureResult {
  ok: boolean
  canceled?: boolean
  path?: string
  bytes?: number
  width?: number
  height?: number
  message?: string
}

export interface ActivationRequest {
  product: string
  appVersion: string
  fingerprint: string
  platform: string
  hostname: string
  generatedAt: string
  hint: string
}

export type LicenseExportResult =
  | { ok: true, path: string, request: ActivationRequest }
  | { ok: false, canceled?: boolean, error?: string }

export type LicenseImportResult =
  | { ok: true, status: LicenseStatus }
  | { ok: false, canceled?: boolean, error?: string }

export type LicenseRemoveResult =
  | { ok: true, status: LicenseStatus }
  | { ok: false, error?: string }

export interface DiagLogFile {
  path?: string
  name: string
  size: number
}

export interface DiagLogInfo {
  ok: boolean
  dir?: string
  current?: string
  files?: DiagLogFile[]
  error?: string
}

export interface DiagExportResult {
  ok: boolean
  path?: string
  bytes?: number
  canceled?: boolean
  error?: string
}

export interface DiagPreviewResult {
  ok: boolean
  text?: string
  chars?: number
  truncated?: boolean
  files?: string[]
  error?: string
}

export interface DiagPathResult {
  ok: boolean
  path?: string
  error?: string
}


export interface UpdateActionResult {
  ok: boolean
  error?: { message: string }
}

export interface WindowControlsBridge {
  minimize(): void
  toggleFullscreen(): void
  close(): void
  isFullscreen(): Promise<boolean>
  onFullscreenChange(listener: (fullscreen: boolean) => void): () => void
}

export interface WechatBridge {
  listMethods(): Promise<RemoteEnvelope<string[]>>
  info(): Promise<RemoteEnvelope<WechatInfo>>
  call(method: string, args?: unknown[]): Promise<RemoteEnvelope>
  getLlmConfig(): Promise<RemoteEnvelope<WechatLlmConfig>>
  saveLlmConfig(config: WechatLlmConfig): Promise<RemoteEnvelope<WechatLlmConfig>>
  listLlmModels(options: LlmModelsOptions): Promise<RemoteEnvelope<LlmModelsResult>>
  testLlmConnection(options: LlmProbeOptions): Promise<RemoteEnvelope<LlmConnectionProbe>>
  getLlmBalance(options: LlmBalanceOptions): Promise<RemoteEnvelope<LlmBalance>>
  getLlmProfiles(): Promise<RemoteEnvelope<LlmProfilesSnapshot>>
  activateLlmProfile(id: string): Promise<RemoteEnvelope<LlmProfilesSnapshot>>
  saveLlmProfile(options: LlmProfileOptions): Promise<RemoteEnvelope<LlmProfilesSnapshot>>
  deleteLlmProfile(id: string): Promise<RemoteEnvelope<LlmProfilesSnapshot>>
  backendState(): Promise<RemoteEnvelope<BackendStatus>>
  onEvent(listener: (payload: BackendEvent) => void): () => void
}

export interface RemoteAccessBridge {
  state(): Promise<RemoteEnvelope<RemoteAccessState>>
  apply(): Promise<RemoteEnvelope<RemoteAccessState>>
  rotate(): Promise<RemoteEnvelope<RemoteAccessRotation>>
  toggle(enabled: boolean): Promise<RemoteEnvelope<RemoteAccessState>>
}

export interface LicenseBridge {
  status(): Promise<LicenseStatus>
  exportRequest(): Promise<LicenseExportResult>
  importFile(): Promise<LicenseImportResult>
  importText(text: string): Promise<LicenseImportResult>
  remove(): Promise<LicenseRemoveResult>
}

export interface DiagBridge {
  logInfo(): Promise<DiagLogInfo>
  exportLog(): Promise<DiagExportResult>
  previewLog(): Promise<DiagPreviewResult>
  copyLogPath(): Promise<DiagPathResult>
  revealLog(): Promise<DiagPathResult>
}

export interface UpdateBridge {
  state(): Promise<RemoteEnvelope<UpdateState>>
  check(opts?: { manual?: boolean }): Promise<RemoteEnvelope<UpdateState>>
  install(): Promise<UpdateActionResult>
  skip(version: string): Promise<RemoteEnvelope<UpdateState>>
  retry(): Promise<RemoteEnvelope<UpdateState>>
  onEvent(listener: (payload: UpdateState) => void): () => void
}

export interface ElectronApi {
  getVersions(): Promise<RuntimeVersions>
  isTestMode(): Promise<boolean>
  runMode(): Promise<{ test: boolean, llmMock: boolean, dataRoot: string }>
  debugGates(): Promise<{ packaged: boolean, skipGates: boolean }>
  ping(): Promise<unknown>
  openFile(opts?: OpenFileOptions): Promise<OpenFileResult>
  pickDirectory(): Promise<PickDirectoryResult>
  saveFileDialog(opts?: SaveFileOptions): Promise<SaveFileResult>
  showInFolder(filePath: string): Promise<boolean>
  capturePanel(rect: CaptureRect): Promise<CaptureResult>
  windowControls: WindowControlsBridge
  wechat: WechatBridge
  remoteAccess: RemoteAccessBridge
  license: LicenseBridge
  diag: DiagBridge
  update: UpdateBridge
}

declare global {
  interface Window {
    electronAPI?: ElectronApi
  }
}

export {}
