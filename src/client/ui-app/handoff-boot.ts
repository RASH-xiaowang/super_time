/**
 * 「打开网页」交接态的前端引导（2026-10-19）。
 *
 * ## 为什么要在 `ui-entry` 的 import 列表最前面执行
 *
 * 能力表 `capabilities.ts` 在**模块加载时**读 `window.electronAPI` 决定每个原生能力
 * 是否可用；浏览器里没有 preload，所以默认全是 false。交接态要让浏览器里的界面
 * 表现得和桌面端一样，就必须在 capabilities 求值之前把桥装好。
 * ES 模块按 import 顺序求值，本文件排第一即满足（不需要内联脚本，也就绕开了 CSP）。
 *
 * ## 这条桥是什么、不是什么
 *
 * 它**不是** Electron preload：没有 Node、没有 IPC，只有 `fetch('/api/native/<action>')`。
 * 服务端只对「交接会话」放行这些动作；普通手机配对码的会话调同一批端点会得到 403。
 * `wechat` 字段刻意缺席 —— 后端调用仍走 HTTP remote（`createHttpRemote`），
 * 这样桌面端与浏览器端只有一条业务数据通道，不会出现两套。
 *
 * @module ui-app/handoff-boot
 */
import type { ElectronApi } from '@deepseek-ai/dsh-client-ui-wechat/host'

/** 交接态标记：URL `mode=desktop` 或本次标签页已确认过。 */
const FULL_KEY = 'dsh-handoff-full'

/** 判断当前页面是不是「打开网页」交接态。 */
function isHandoff(): boolean {
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.get('mode') === 'desktop') {
      // 刷新后 URL 被清掉也保持同一标签页的交接态；关掉标签页即失忆。
      sessionStorage.setItem(FULL_KEY, '1')
      return true
    }
    return sessionStorage.getItem(FULL_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * 调一个原生能力端点。
 * @param action - `/api/native/<action>` 的动作名。
 * @param payload - 传给主进程的载荷。
 * @returns 端点返回的 `value`。
 */
async function native(action: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch('/api/native/' + action, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(payload),
  })
  if (res.status === 401) throw new Error('会话已失效，请重新从桌面端打开网页')
  if (res.status === 403) throw new Error('该操作只对桌面交接会话开放')
  const body = (await res.json().catch(() => null)) as
    { ok?: boolean, value?: unknown, error?: { message?: string } } | null
  if (!body) throw new Error(`原生操作无返回（HTTP ${String(res.status)}）`)
  if (body.ok === false) throw new Error(body.error?.message ?? '原生操作失败')
  return body.value
}

/** 调一个原生能力端点并包成 preload 同形的 `{ok, value}` 信封。 */
async function envelope(action: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  try {
    return { ok: true, value: await native(action, payload) }
  } catch (e) {
    return { ok: false, error: { message: e instanceof Error ? e.message : String(e) } }
  }
}

/** 造一个与 preload 同形的桥（缺少 `wechat.call`：业务调用走 HTTP remote）。 */
function buildHandoffBridge(): Partial<ElectronApi> {
  const profiles = (op: string, extra: Record<string, unknown> = {}): Promise<unknown> =>
    envelope('llm-profiles', { op, ...extra })
  return {
    getVersions: async () => ({
      electron: 'browser', chrome: navigator.userAgent, node: '', app: '',
    }) as never,
    isTestMode: async () => false,
    runMode: async () => ({ test: false, llmMock: false, dataRoot: '（电脑）' }),
    debugGates: async () => ({ packaged: true, skipGates: true }),
    ping: async () => true,
    openFile: (opts) => native('open-file', { opts }) as never,
    pickDirectory: () => native('pick-directory') as never,
    saveFileDialog: (opts) => native('save-file', { opts }) as never,
    showInFolder: (filePath) => native('show-in-folder', { path: filePath }) as never,
    capturePanel: (rect) => native('capture-panel', { rect }) as never,
    /**
     * `wechat` 只保留主进程侧的配置/模型方法，**没有 `call`**。
     * `capabilities.isDesktop` 判的是 `wechat.call` 是否存在 —— 没有它，业务调用仍走
     * HTTP remote（一条传输），而配置类能力又能与桌面端同权。
     */
    wechat: {
      info: () => envelope('wechat-info') as never,
      getLlmConfig: () => envelope('llm-get') as never,
      saveLlmConfig: (config: unknown) => envelope('llm-save', { config }) as never,
      getLlmProfiles: () => profiles('list') as never,
      activateLlmProfile: (id: string) => profiles('activate', { id }) as never,
      saveLlmProfile: (options: unknown) => profiles('save', { profile: options }) as never,
      deleteLlmProfile: (id: string) => profiles('delete', { id }) as never,
      listLlmModels: (options: unknown) => envelope('llm-models', { opts: options }) as never,
      testLlmConnection: (options: unknown) => envelope('llm-test', { opts: options }) as never,
      getLlmBalance: (options: unknown) => envelope('llm-balance', { opts: options }) as never,
    } as never,
    license: {
      status: () => native('license-status') as never,
      exportRequest: () => native('license-export-request') as never,
      importFile: () => native('license-import-file') as never,
      importText: (text: string) => native('license-import-text', { text }) as never,
      remove: () => native('license-remove') as never,
    },
    diag: {
      logInfo: () => native('diag-log-info') as never,
      exportLog: () => native('diag-export-log') as never,
      previewLog: () => native('diag-preview-log') as never,
      copyLogPath: () => native('diag-copy-log-path') as never,
      revealLog: () => native('diag-reveal-log') as never,
    },
    update: {
      state: () => envelope('update-state') as never,
      check: (opts) => envelope('update-check', { opts }) as never,
      install: () => native('update-install') as never,
      skip: (version: string) => envelope('update-skip', { version }) as never,
      retry: () => envelope('update-retry') as never,
      // 交接态的更新事件没有主进程广播通道：用 2s 状态轮询喂给与桌面端同一个订阅者。
      // 这样更新进度/下载完成/错误在浏览器里也会刷新，而不是只有手动检查那一次。
      onEvent: ((listener: (next: unknown) => void) => {
        let stopped = false
        const tick = async (): Promise<void> => {
          const r = await envelope('update-state') as { ok?: boolean, value?: unknown }
          if (!stopped && r.ok === true) listener(r.value)
        }
        const timer = setInterval(() => { void tick() }, 2000)
        void tick()
        return () => { stopped = true; clearInterval(timer) }
      }) as never,
    },
    remoteAccess: {
      state: () => envelope('remote-access-state') as never,
      apply: () => envelope('remote-access-apply') as never,
      rotate: () => envelope('remote-access-rotate') as never,
      toggle: (enabled: boolean) => envelope('remote-access-toggle', { enabled }) as never,
    },
  }
}

if (isHandoff() && typeof window.electronAPI === 'undefined') {
  // 先立标记再装桥：capabilities.ts 在下一个 import 求值时读的正是这两个事实。
  window.__SUPERTIME_FULL__ = true
  window.electronAPI = buildHandoffBridge() as ElectronApi
}
