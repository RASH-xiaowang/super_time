/**
 * 应用托管（SuperLanguage）的薄桥接层。
 *
 * 组件不直接摸 `window.electronAPI`：浏览器交接态没有这个对象，统一在这里降级成
 * 「仅桌面端可用」，避免每个卡片都写一遍可选链。所有返回值都带 `ok`，
 * 失败文案原样来自主进程（含授权失效的具体原因），不做二次翻译。
 */
import type { AppsActionResult, AppsSummary, AppsWebhookTargets } from '../../electron-api.ts'

/** 非桌面环境（浏览器交接 / SSR）下的空快照。 */
export function emptyAppsSummary(): AppsSummary {
  return {
    ok: false,
    licensed: false,
    error: '仅桌面端可管理本机应用',
    code: 'DESKTOP_ONLY',
    license: null,
    entitlement: null,
    seats: { used: 0, max: 0 },
    broker: {
      running: false,
      pipePath: '',
      connections: 0,
      tickets: 0,
      denied: 0,
      lastDeniedCode: '',
      lastTicketAt: 0,
      graceMs: 0,
    },
    sourceExe: '',
    instances: [],
  }
}

function bridge() {
  return typeof window === 'undefined' ? undefined : window.electronAPI?.apps
}

function failure(error: unknown): AppsActionResult {
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, error: '调用失败：' + message }
}

function flatten(result: unknown): AppsActionResult {
  if (result === null || typeof result !== 'object') return { ok: false, error: '主进程无返回' }
  return result as AppsActionResult
}

export async function apiAppsSummary(): Promise<AppsSummary> {
  const api = bridge()
  if (!api) return emptyAppsSummary()
  try {
    const summary = await api.summary()
    return summary && typeof summary === 'object' ? summary : emptyAppsSummary()
  } catch (e) {
    return { ...emptyAppsSummary(), error: '读取应用托管状态失败：' + (e instanceof Error ? e.message : String(e)) }
  }
}

async function call(fn: keyof NonNullable<ReturnType<typeof bridge>>, input: unknown): Promise<AppsActionResult> {
  const api = bridge()
  if (!api) return { ok: false, error: '仅桌面端可管理本机应用', code: 'DESKTOP_ONLY' }
  try {
    const method = api[fn]
    if (typeof method !== 'function') return { ok: false, error: '当前版本不支持该操作' }
    return flatten(await (method as (arg: unknown) => Promise<unknown>)(input))
  } catch (e) {
    return failure(e)
  }
}

export function apiAppsCreate(input: {
  name: string
  mode?: 'local' | 'lan'
  host?: string
  dir?: string
}): Promise<AppsActionResult> {
  return call('create', input)
}

/** 局域网实例：立即补推一次票据（改配额/改 IP 后不必等续期周期）。 */
export function apiAppsPushTicket(id: string): Promise<AppsActionResult> {
  return call('pushTicket', { id })
}

export function apiAppsUpdate(
  input: { id: string, patch: Record<string, unknown> },
): Promise<AppsActionResult> {
  return call('update', input)
}

export function apiAppsRemove(id: string, purge = false): Promise<AppsActionResult> {
  return call('remove', { id, purge })
}

export function apiAppsDeploy(id: string): Promise<AppsActionResult> {
  return call('deploy', { id })
}

export function apiAppsStart(id: string): Promise<AppsActionResult> {
  return call('start', { id })
}

export function apiAppsStop(id: string): Promise<AppsActionResult> {
  return call('stop', { id })
}

export function apiAppsRestart(id: string): Promise<AppsActionResult> {
  return call('restart', { id })
}

export function apiAppsStatus(id: string): Promise<AppsActionResult> {
  return call('status', { id })
}

export function apiAppsLogs(id: string): Promise<AppsActionResult> {
  return call('logs', { id })
}

export function apiAppsOpenDir(id: string): Promise<AppsActionResult> {
  return call('openDir', { id })
}

export function apiAppsSeedCaps(id: string): Promise<AppsActionResult> {
  return call('seedCaps', { id })
}

/** 订阅主进程的租约/退出事件；返回取消订阅函数。 */
export function onAppsEvent(listener: (payload: { type: string, instanceId?: string, code?: string }) => void): () => void {
  const api = bridge()
  if (!api || typeof api.onEvent !== 'function') return () => undefined
  try {
    return api.onEvent(listener)
  } catch {
    return () => undefined
  }
}

/**
 * 「下游 Webhook」候选实例。
 *
 * 地址一律脱敏（令牌是 `***`）：真实 `/webhook/<token>` 只在主进程保存时解析，
 * 渲染层拿到令牌就能绕过授权闸门直连实例，那是必须避免的降级。
 */
export async function apiAppsWebhookTargets(): Promise<AppsWebhookTargets> {
  const api = bridge()
  if (!api || typeof api.webhookTargets !== 'function') return { ok: false, licensed: false, targets: [] }
  try {
    const result = await api.webhookTargets()
    if (!result || typeof result !== 'object') return { ok: false, licensed: false, targets: [] }
    return result
  } catch {
    return { ok: false, licensed: false, targets: [] }
  }
}

/** 用托管实例的地址保存规则（真实地址由主进程解析并写入）。 */
export function apiAppsSaveRule(
  instanceId: string,
  rule: Record<string, unknown>,
): Promise<AppsActionResult> {
  return call('saveRule', { instanceId, rule })
}

/** 用托管实例的地址保存「当前会话默认 Webhook」。 */
export function apiAppsSaveAiReplyWebhook(input: {
  instanceId: string
  chatUsername: string
  chatName?: string
}): Promise<AppsActionResult> {
  return call('saveAiReplyWebhook', input)
}
