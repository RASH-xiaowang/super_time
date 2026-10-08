
/**
 * 语音转写与模型清单（whisper 安装/下载/状态、可用模型与提供方） 的 @Remote 处理器（M21 自 `gateway.ts` 搬出）。
 *
 * 机制：类里保留 @Remote 装饰器与签名（协议层按名字枚举），方法体一行转发；
 * 处理器体在这里，依赖由 `rc` 显式给出。
 */
import { getConfig, saveConfig } from '../query/config.ts'
import { transcribeVoiceBatch } from '../query/voice-transcribe.ts'
import { WHISPER_DOWNLOAD_FILES, installWhisperEngine, resolveWhisperModelsDir, whisperDownloadModel, whisperEnginePath, whisperHasCuda, whisperModelsStatus } from '../query/whisper.ts'
import { OperationCategory, OperationStatus, VoiceTranscribeResult, WhisperDownloadProgress, WhisperDownloadResult, WhisperStatus, WhisperTranscribing } from '../types.ts'
import type { Context } from '@deepseek-ai/cordis'

export interface createVoiceLlmRemotesInputs {
  dirs: () => { decrypted: string; decoded: string }
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  ctx: () => Context
  getWhisperDownload: () => WhisperDownloadProgress | null
  setWhisperDownload: (v: WhisperDownloadProgress | null) => void
  getWhisperTranscribing: () => WhisperTranscribing
  setWhisperTranscribing: (v: WhisperTranscribing) => void
}

export function createVoiceLlmRemotes(rc: createVoiceLlmRemotesInputs) {
  return {
    async transcribeVoiceBatch(options: { limit?: number }): Promise<VoiceTranscribeResult> {
      if (rc.getWhisperTranscribing().active) { rc.op('task', 'transcribe_voice_batch', 'fail', '', '已有转写任务进行中'); return { ok: false, total: 0, done: 0, failed: 0, skipped: 0, errors: [], engine: '', error: '已有转写任务进行中' } }
      const cfg = getConfig(rc.dirs().decrypted)
      const modelsDir = resolveWhisperModelsDir(cfg['whisper_models_dir'] as string | undefined, rc.dirs().decrypted)
      const configBin = typeof cfg['whisper_bin'] === 'string' ? cfg['whisper_bin'] : ''
      const engine = whisperEnginePath(configBin, modelsDir)
      if (!engine) { rc.op('task', 'transcribe_voice_batch', 'fail', '', '未检测到 whisper.cpp 引擎'); return { ok: false, total: 0, done: 0, failed: 0, skipped: 0, errors: [], engine, error: '未检测到 whisper.cpp 引擎（可在第 5 步点击「下载引擎」，或设 DSH_WECHAT_WHISPER_BIN）' } }
      const modelId = typeof cfg['whisper_model'] === 'string' && cfg['whisper_model'] ? cfg['whisper_model'] : 'medium'
      const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 50), 200))
      const tr: WhisperTranscribing = { active: true, done: 0, total: 0, failed: 0, skipped: 0, current: '' }
      rc.setWhisperTranscribing(tr)
      try {
        const result = await transcribeVoiceBatch(
          rc.dirs().decrypted,
          rc.dirs().decoded,
          modelsDir,
          modelId,
          engine,
          limit,
          (done, total, failed, current) => {
            tr.done = done
            tr.total = total
            tr.failed = failed
            tr.current = current
          },
        )
        tr.skipped = result.skipped
        rc.op('task', 'transcribe_voice_batch', result.ok ? 'ok' : 'fail', '', result.error ?? `成功 ${result.done}/${result.total}，失败 ${result.failed}`)
        return result
      } finally {
        tr.active = false
        tr.current = ''
      }
    },

    async installWhisperEngine(): Promise<WhisperDownloadResult> {
      if (rc.getWhisperDownload() !== null) { rc.op('settings', 'install_whisper_engine', 'fail', '', '已有下载任务进行中'); return { ok: false, error: '已有下载任务进行中' } }
      const cfg = getConfig(rc.dirs().decrypted)
      const modelsDir = resolveWhisperModelsDir(cfg['whisper_models_dir'] as string | undefined, rc.dirs().decrypted)
      const configBin = typeof cfg['whisper_bin'] === 'string' ? cfg['whisper_bin'] : ''
      const existing = whisperEnginePath(configBin, modelsDir)
      if (existing) { rc.op('settings', 'install_whisper_engine', 'skip', '', '引擎已存在'); return { ok: true, file: 'whisper-cli.exe', bytes: 0 } }
      const prog: WhisperDownloadProgress = { model: 'engine', file: 'whisper-bin-x64.zip', received: 0, total: 0 }
      rc.setWhisperDownload(prog)
      try {
        const result = await installWhisperEngine(modelsDir, (received, total) => { prog.received = received; prog.total = total })
        if (result.ok && result.path) {
          saveConfig(rc.dirs().decrypted, { whisper_bin: result.path })
        }
        const out: WhisperDownloadResult = { ok: result.ok, file: 'whisper-cli.exe' }
        if (result.error) out.error = result.error
        rc.op('settings', 'install_whisper_engine', out.ok ? 'ok' : 'fail', '', out.error ?? '引擎已安装')
        return out
      } finally {
        rc.setWhisperDownload(null)
      }
    },

    async downloadWhisperModel(options: { model: string }): Promise<WhisperDownloadResult> {
      if (rc.getWhisperDownload() !== null) { rc.op('settings', 'download_whisper_model', 'fail', options.model, '已有模型下载任务进行中'); return { ok: false, error: '已有模型下载任务进行中' } }
      const cfg = getConfig(rc.dirs().decrypted)
      const modelsDir = resolveWhisperModelsDir(cfg['whisper_models_dir'] as string | undefined, rc.dirs().decrypted)
      const prog: WhisperDownloadProgress = { model: options.model, file: '', received: 0, total: 0 }
      rc.setWhisperDownload(prog)
      try {
        const result = await whisperDownloadModel(options.model, modelsDir, (received, total) => { prog.received = received; prog.total = total })
        prog.file = WHISPER_DOWNLOAD_FILES.find(([id]) => id === options.model)?.[1] ?? options.model
        rc.op('settings', 'download_whisper_model', result.ok ? 'ok' : 'fail', options.model, result.error ?? `bytes=${result.bytes ?? 0}`)
        return result
      } finally {
        rc.setWhisperDownload(null)
      }
    },

    getWhisperStatus(): WhisperStatus {
      const cfg = getConfig(rc.dirs().decrypted)
      const configured = resolveWhisperModelsDir(cfg['whisper_models_dir'] as string | undefined, rc.dirs().decrypted)
      const configBin = typeof cfg['whisper_bin'] === 'string' ? cfg['whisper_bin'] : ''
      const engine = whisperEnginePath(configBin, configured)
      const result: WhisperStatus = {
        engine,
        hasCuda: whisperHasCuda(),
        modelsDir: configured,
        models: whisperModelsStatus(configured),
        downloading: rc.getWhisperDownload(),
        transcribing: rc.getWhisperTranscribing(),
      }
      if (engine) result.enginePath = engine
      return result
    },

    async listLlmModels(options: { provider: string }): Promise<{ models: Array<{ id: string; name: string }> }> {
      const ctx = rc.ctx() as unknown as {
        llm?: {
          listConfigurableProviders(): Array<{ provider: string; settingsNs: string; settingsPath: string[] }>
          listModels(provider: string): Promise<Array<{ id: string; name: string }>>
        }
        settings?: { get(ns: string): unknown }
      }
      // 1) read the configured models from the provider's settings section.
      let ns = ''
      let settingsPath: string[] = []
      try {
        const conf = (ctx.llm?.listConfigurableProviders() ?? []).find(p => p.provider === options.provider)
        if (conf) { ns = conf.settingsNs; settingsPath = conf.settingsPath }
      } catch { /* ignore */ }
      if (ns) {
        try {
          const doc = (ctx.settings?.get(ns) ?? {}) as Record<string, unknown>
          let profile: Record<string, unknown> = doc
          if (settingsPath.length > 0) {
            profile = settingsPath.reduce<Record<string, unknown>>((acc, k) => {
              const v = acc[k] as Record<string, unknown> | undefined
              return v ?? {}
            }, doc)
          }
          const ms = (profile.models ?? []) as Array<{ id?: string; name?: string } | string>
          if (Array.isArray(ms) && ms.length > 0) {
            return { models: ms.map(m => ({ id: typeof m === 'string' ? m : (m.id ?? ''), name: typeof m === 'string' ? m : (m.name ?? m.id ?? '') })).filter(m => m.id) }
          }
        } catch { /* ignore */ }
      }
      // 2) fallback: provider catalog.
      try {
        const ms = (await ctx.llm?.listModels(options.provider)) ?? []
        return { models: ms.map(m => ({ id: m.id, name: m.name })).filter(m => m.id) }
      } catch {
        return { models: [] }
      }
    },

    listLlmProviders(): { providers: Array<{ id: string; name: string }> } {
      const ctx = rc.ctx() as unknown as {
        settings?: { get(ns: string): unknown }
        llm?: { listConfigurableProviders(): Array<{ provider: string; displayName: string }> }
      }
      let provider = ''
      try {
        const am = (ctx.settings?.get('agent-default-model') ?? {}) as { provider?: string }
        provider = am.provider ?? ''
      } catch { /* ignore */ }
      if (!provider) {
        try {
          const adm = (rc.ctx() as unknown as {
            agentDefaultModel?: { currentSelection?: () => { provider: string } | undefined }
          }).agentDefaultModel
          const sel = adm && adm.currentSelection ? adm.currentSelection() : undefined
          provider = sel?.provider ?? ''
        } catch { /* ignore */ }
      }
      if (!provider) return { providers: [] }
      const name = (() => {
        try {
          const found = ctx.llm?.listConfigurableProviders().find(p => p.provider === provider)
          return found?.displayName ?? provider
        } catch {
          return provider
        }
      })()
      return { providers: [{ id: provider, name }] }
    },

  }
}
