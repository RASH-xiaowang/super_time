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
  ImageAiJsonBridgeResult,
  ImageOcrBridgeResult,
  LicenseStatus,
  RemoteAccessState,
  RemoteAccessRotation,
  RemoteEnvelope,
  UpdateState,
} from './contracts.ts'

export type {
  BackendEvent,
  ImageAiJsonBridgeResult,
  ImageOcrBridgeResult,
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
  /** 用微信 4.x 自带的 OCR 插件识别一张 data URL / wechat-media URL。 */
  ocrImage(source: string): Promise<ImageOcrBridgeResult>
  /** 用当前配置的多模态模型识别图片文字，并返回结构化 JSON。 */
  imageAiJson(source: string): Promise<ImageAiJsonBridgeResult>
  backendState(): Promise<RemoteEnvelope<BackendStatus>>
  onEvent(listener: (payload: BackendEvent) => void): () => void
}

export interface RemoteAccessBridge {
  state(): Promise<RemoteEnvelope<RemoteAccessState>>
  apply(): Promise<RemoteEnvelope<RemoteAccessState>>
  rotate(options?: { fullAccess?: boolean }): Promise<RemoteEnvelope<RemoteAccessRotation>>
  toggle(enabled: boolean): Promise<RemoteEnvelope<RemoteAccessState>>
}

/** 浏览器交接：把操作权交给默认浏览器，桌面端缩成右下角卡片。 */
export interface WebHandoffBridge {
  /** 打开默认浏览器并隐藏主窗口；失败时主窗口保持原样。 */
  open(): Promise<{ ok: boolean, error?: string }>
  /** 返回桌面：停掉 HTTP 服务（浏览器会话作废）并显示主窗口。 */
  restore(): Promise<{ ok: boolean }>
  state(): Promise<{ active: boolean }>
}

export interface LicenseBridge {
  status(): Promise<LicenseStatus>
  exportRequest(): Promise<LicenseExportResult>
  importFile(): Promise<LicenseImportResult>
  importText(text: string): Promise<LicenseImportResult>
  remove(): Promise<LicenseRemoveResult>
}

/** 应用托管里一个 SuperLanguage 实例的公开字段（不含令牌与票据密钥）。 */
export interface AppInstanceView {
  id: string
  appId: string
  name: string
  seat: number
  enabled: boolean
  /** `local` = 本机管道自取票据；`lan` = 实例在局域网另一台电脑，票据由本机推送。 */
  mode: 'local' | 'lan'
  /** 局域网实例所在电脑的 IPv4；`local` 时为空串。 */
  host: string
  caps: string[]
  maxJobsPerHour: number
  dir: string
  exeVersion: string
  exeSha256: string
  createdAt: number
  updatedAt: number
  lastLeaseAt: number
  lastSeenAt: number
  lastError: string
  live: {
    ok: boolean
    running: boolean
    deployed: boolean
    tokenMasked?: string
    error?: string
    health?: unknown
    details?: unknown
  }
}

/** `apps:summary`：面板的唯一数据入口。 */
export interface AppsSummary {
  ok: boolean
  licensed: boolean
  error: string
  code: string
  license: {
    state: string
    licensed: boolean
    code: string
    reason: string
    daysToExpiry: number | null
    licenseId: string
    expiresAt: string | null
  } | null
  entitlement: {
    maxInstances: number
    caps: string[]
    maxJobsPerHour: number
    standalone: boolean
  } | null
  seats: { used: number, max: number }
  broker: {
    running: boolean
    pipePath: string
    connections: number
    tickets: number
    denied: number
    lastDeniedCode: string
    lastTicketAt: number
    graceMs: number
  }
  sourceExe: string
  instances: AppInstanceView[]
}

export interface AppsActionResult {
  ok: boolean
  error?: string
  code?: string
  instance?: AppInstanceView
  /** 部署时是否把局域网启动器一并复制过去（`apps:deploy` 的返回值）。 */
  launcher?: boolean
  /** 启动器复制失败的原因（`launcher === false` 时才有）。 */
  launcherError?: string
  [key: string]: unknown
}

export interface AppsBridge {
  summary(): Promise<AppsSummary>
  /** `mode: 'lan'` 时要同时给 `host`（目标电脑 IPv4）与 `dir`（共享目录 \\PC\共享\…）。 */
  create(input: {
    name: string
    mode?: 'local' | 'lan'
    host?: string
    dir?: string
  }): Promise<AppsActionResult>
  update(input: { id: string, patch: Partial<Pick<AppInstanceView, 'name' | 'enabled' | 'caps' | 'maxJobsPerHour'>> }): Promise<AppsActionResult>
  remove(input: { id: string, purge?: boolean }): Promise<AppsActionResult>
  deploy(input: { id: string }): Promise<AppsActionResult>
  start(input: { id: string }): Promise<AppsActionResult>
  stop(input: { id: string }): Promise<AppsActionResult>
  restart(input: { id: string }): Promise<AppsActionResult>
  status(input: { id: string }): Promise<AppsActionResult>
  logs(input: { id: string }): Promise<AppsActionResult>
  proxy(input: { id: string, action: string, payload?: Record<string, unknown> }): Promise<AppsActionResult>
  openDir(input: { id: string }): Promise<AppsActionResult>
  seedCaps(input: { id: string }): Promise<AppsActionResult>
  /** 局域网实例：立即补推一次票据。 */
  pushTicket(input: { id: string }): Promise<AppsActionResult>
  /** 「下游 Webhook」候选实例；地址已脱敏。 */
  webhookTargets(): Promise<AppsWebhookTargets>
  /** 用实例地址保存一条消息列表规则（真实地址由主进程解析）。 */
  saveRule(input: { instanceId: string, rule: Record<string, unknown> }): Promise<AppsActionResult>
  /** 用实例地址保存当前会话默认 Webhook。 */
  saveAiReplyWebhook(input: {
    instanceId: string
    chatUsername: string
    chatName?: string
  }): Promise<AppsActionResult>
  onEvent(listener: (payload: { type: string, instanceId?: string, code?: string }) => void): () => void
}

/** 可作为下游 Webhook 的托管实例（地址脱敏，令牌 `***`）。 */
export interface AppsWebhookTarget {
  id: string
  name: string
  seat: number
  enabled: boolean
  running: boolean
  ready: boolean
  usable: boolean
  maskedUrl: string
}

export interface AppsWebhookTargets {
  ok: boolean
  licensed: boolean
  targets: AppsWebhookTarget[]
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
  /** Desktop-only knowledge-file drag/drop; absent in browser handoff. */
  kbFiles?: { getPathForFile(file: File): string }
  openFile(opts?: OpenFileOptions): Promise<OpenFileResult>
  pickDirectory(): Promise<PickDirectoryResult>
  saveFileDialog(opts?: SaveFileOptions): Promise<SaveFileResult>
  showInFolder(filePath: string): Promise<boolean>
  capturePanel(rect: CaptureRect): Promise<CaptureResult>
  windowControls: WindowControlsBridge
  wechat: WechatBridge
  remoteAccess: RemoteAccessBridge
  webHandoff: WebHandoffBridge
  license: LicenseBridge
  apps: AppsBridge
  diag: DiagBridge
  update: UpdateBridge
}

declare global {
  interface Window {
    electronAPI?: ElectronApi
  }
}

export {}
