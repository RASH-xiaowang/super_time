/**
 * 「打开网页」交接会话的原生能力代理：按域分派、返回形状与既有 IPC 一致。
 * @vitest-environment node
 */
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

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

  it('交接态禁止生成/查看访问凭据：rotate 明确拒绝，且不会调用控制面', async () => {
    const rotate = vi.fn(async () => ({ ok: true, token: 'SECRET', pairingCode: 'PAIR' }))
    const h = harness({ control: { rotate, setEnabled: async () => ({ ok: true }) } })
    await expect(h.call('remote-access-rotate'))
      .rejects.toThrow(/桌面端/)
    expect(rotate, '浏览器请求仍然触发了凭据生成').not.toHaveBeenCalled()
  })

  it('原生响应递归脱敏：即使某个处理器误带凭据，也不会从 /api/native/* 回到浏览器', async () => {
    const h = harness({
      remoteAccess: {
        getState: () => ({
          running: true,
          port: 5032,
          token: 'SECRET-TOKEN',
          pairingCode: 'SECRET-PAIR',
          nested: { token: 'SECRET-NESTED', list: [{ pairingCode: 'SECRET-LIST', port: 1 }] },
        }),
        syncWithConfig: async () => ({ running: true }),
      },
    })
    const out = await h.call('remote-access-state') as Record<string, unknown>
    const text = JSON.stringify(out)
    expect(text, '原生响应里出现了明文凭据').not.toContain('SECRET')
    expect(out.token).toBeUndefined()
    expect(out.pairingCode).toBeUndefined()
    expect((out.nested as Record<string, unknown>).token).toBeUndefined()
    expect((out.nested as { list: Array<Record<string, unknown>> }).list[0]!.pairingCode).toBeUndefined()
    expect(out.port).toBe(5032)
  })

  it('模型列表复用桌面的 llmModelListUrl（OpenCode 的列表路径不是 ${base}/models）', async () => {
    const calls: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ data: [{ id: 'opencode-go' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    try {
      const h = harness()
      const out = await h.call('llm-models', {
        opts: { baseUrl: 'https://opencode.ai/inference/go/openai/v1', apiKey: 'k' },
      }) as { models: string[], source: string }
      expect(out.models).toEqual(['opencode-go'])
      expect(out.source).toBe('live')
      expect(calls).toHaveLength(1)
      expect(calls[0], '模型列表没有复用桌面端的 URL 推导').toBe('https://opencode.ai/inference/go/v1/models')
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
