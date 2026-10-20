/**
 * 「打开网页」交接会话的原生能力代理：按域分派、返回形状与既有 IPC 一致。
 * @vitest-environment node
 */
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..', '..')
const require = createRequire(import.meta.url)
const { createHandoffNative } = require(join(ROOT, 'src', 'backend', 'handoff-native.js')) as {
  createHandoffNative: (deps: Record<string, unknown>) => (action: string, payload?: Record<string, unknown>) => Promise<unknown>
}

function harness(overrides: Record<string, unknown> = {}) {
  const calls: string[] = []
  const deps = {
    app: { getPath: () => 'C:/userData', isPackaged: false },
    dialog: {
      showOpenDialog: async (_parent: unknown, opts: { properties?: string[] }) => {
        calls.push('open:' + (opts.properties ?? []).join(','))
        return { canceled: false, filePaths: ['C:/picked/a.txt'] }
      },
      showSaveDialog: async () => ({ canceled: false, filePath: 'C:/picked/out.bin' }),
    },
    shell: { showItemInFolder: (p: string) => { calls.push('reveal:' + p) } },
    clipboard: { writeText: (t: string) => { calls.push('copy:' + t) } },
    getMainWindow: () => null,
    licenseService: {
      getLicenseStatus: () => ({ state: 'licensed', licensed: true }),
      removeLicense: () => ({ state: 'none', licensed: false }),
      getActivationRequest: () => ({ fingerprint: 'abcdef123456', payload: {} }),
      importLicense: (_u: string, _v: string, text: string) => ({ ok: true, text }),
    },
    diagLog: { path: 'C:/logs/main.log', files: () => ['C:/logs/main.log'], write: () => undefined },
    APP_VERSION: 'spec',
    buildDiagnosticPreview: () => ({ text: 'preview', chars: 7, truncated: false, files: [] }),
    buildDiagnosticReport: () => 'report',
    updateService: {
      getState: () => ({ status: 'idle' }),
      check: async () => ({ status: 'checking' }),
      install: () => ({ ok: true }),
      skipVersion: (v: string) => ({ skipped: v }),
      retryDownload: async () => ({ status: 'downloading' }),
    },
    remoteAccess: {
      getState: () => ({ running: true, port: 5032 }),
      syncWithConfig: async () => ({ running: true, port: 5032 }),
    },
    control: {
      rotate: async () => ({ ok: true, pairingCode: 'PAIR' }),
      setEnabled: async (v: boolean) => ({ enabled: v }),
    },
    getWechatBoot: () => ({ info: { root: 'C:/data' } }),
    loadLlmConfig: () => ({ model: 'deepseek-flash' }),
    saveLlmConfig: (cfg: object) => cfg,
    loadLlmStore: () => ({ activeProfileId: 'p1', profiles: [] }),
    activateLlmProfile: (id: string) => ({ activeProfileId: id, profiles: [] }),
    upsertLlmProfile: (p: object) => ({ activeProfileId: 'p1', profiles: [p] }),
    deleteLlmProfile: () => ({ activeProfileId: '', profiles: [] }),
    findModelCatalog: () => null,
    ...overrides,
  }
  return { call: createHandoffNative(deps), calls }
}

describe('交接会话原生能力代理', () => {
  it('对话框：目录/文件/保存都走主进程，返回形状与 preload 一致', async () => {
    const h = harness()
    expect(await h.call('pick-directory')).toEqual({ canceled: false, path: 'C:/picked/a.txt' })
    expect(await h.call('open-file', { opts: { title: '选' } }))
      .toEqual({ canceled: false, files: ['C:/picked/a.txt'] })
    expect(await h.call('save-file', { opts: { defaultName: 'x.bin' } }))
      .toEqual({ canceled: false, path: 'C:/picked/out.bin' })
    expect(h.calls).toEqual(['open:openDirectory,createDirectory', 'open:openFile,multiSelections'])
  })

  it('在资源管理器中显示、许可证、诊断、更新、远程访问都有明确返回', async () => {
    const h = harness()
    expect(await h.call('show-in-folder', { path: 'C:/x/y.txt' })).toBe(true)
    expect(h.calls).toContain('reveal:C:/x/y.txt')
    expect(await h.call('license-status')).toMatchObject({ licensed: true })
    expect(await h.call('diag-log-info')).toMatchObject({ ok: true, current: 'C:/logs/main.log' })
    expect(await h.call('update-state')).toEqual({ status: 'idle' })
    expect(await h.call('remote-access-state')).toEqual({ running: true, port: 5032 })
    expect(await h.call('remote-access-toggle', { enabled: false })).toEqual({ enabled: false })
  })

  it('模型配置与模型列表代理到主进程函数', async () => {
    const h = harness()
    expect(await h.call('llm-get')).toEqual({ model: 'deepseek-flash' })
    expect(await h.call('llm-profiles', { op: 'activate', id: 'p2' })).toMatchObject({ activeProfileId: 'p2' })
    expect(await h.call('wechat-info')).toEqual({ root: 'C:/data' })
  })

  it('未知动作明确报错（不静默成功）', async () => {
    const h = harness()
    await expect(h.call('not-a-real-action')).rejects.toThrow(/未知的原生动作/)
  })
})
