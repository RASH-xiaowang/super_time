/**
 * laya 本地决策分析（分析会话消息、模型状态/下载/接管/卸载） 的 @Remote 处理器。
 *
 * 机制照 `remotes/voicellm.ts`：类里保留 @Remote 装饰器与签名（协议层按名字枚举），
 * 方法体一行转发；处理器体在这里，依赖由 `rc` 显式给出。
 *
 * **下载进度为什么不挂在 gateway 字段上**：与 whisper 不同，laya 的进度用不着跨方法共享
 * 生命周期（`getLayaStatus` 与 `downloadLayaModel` 都在本模块里），所以放在模块级。
 * 代价是多实例场景会共享——测试需要隔离时用 `__setLayaDownloadForTest()` 注入。
 */
import { analyzeSession, analyzeVisibleMessages as runVisibleAnalysis, type LayaVisibleAnalysisResult } from '../laya/analysis.ts'
import {
  formatBytes, layaAdoptModelDir, layaDownloadModel, layaModelStatus, layaModelsDir, layaTokenizerDir,
} from '../laya/model-file.ts'
import { resolveWhisperModelsDir, whisperEnginePath } from '../query/whisper.ts'
import { transcribeOneVoiceAsync } from '../query/voice-transcribe.ts'
import { layaRuntimeState, layaUnload } from '../laya/runtime.ts'
import type { LayaAnalysisView, LayaDownloadOutcome, LayaDownloadProgress, LayaStatus } from '../types-laya.ts'
import type { OperationCategory, OperationStatus } from '../types.ts'
import { getConfig } from '../query/config.ts'

/** 模型目录的配置键（与 `whisper_models_dir` 同款，可被用户在设置里钉住）。 */
const LAYA_DIR_CONFIG_KEY = 'laya_models_dir'

/** 当前下载任务（无则 null）。 */
let layaDownload: LayaDownloadProgress | null = null

/** 测试注入点：替换下载进度槽（生产路径不调用）。 */
export function __setLayaDownloadForTest(v: LayaDownloadProgress | null): void {
  layaDownload = v
}

export interface createLayaRemotesInputs {
  dirs: () => { decrypted: string; decoded: string }
  selfUsername: () => string
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  /** W3-11.5：进度事件的出口（ Cordis Context 的 emit）。 */
  ctx: () => { emit: (name: string, ...args: unknown[]) => void }
  /**
   * W3-11.5：逐条分析的取消槽（由 gateway 的 `_layaJobs` 提供）。
   *
   * 槽位为什么归 gateway：与问答取消（`remotes/ask-cancel.ts`）同一条纪律 ——
   * 「谁持有取消令牌」不允许出现第二个出处。本模块只消费。
   */
  layaSignal: (jobId?: string) => { signal: AbortSignal; done: () => void } | undefined
  cancelLayaJob: (jobId?: string) => boolean
}

/**
 * 组装内联分析的语音转写器（2026-10-13 提成模块级：`createLayaRemotes` 有 250 行
 * 只许变小棘轮，这段配置层知识放函数体会把它顶过登记值）。
 * 异步实现：whisper 在子进程跑，worker 照常服务消息查询/会话列表（见 voice-transcribe.ts）。
 * `talker` 即 `WechatSession.username`（会话微信 ID 的正名见 P3-6）。
 */
function makeLayaTranscriber(
  rc: createLayaRemotesInputs,
  decryptedDir: string,
  decodedDir: string,
  modelsDir: string,
  whisperModel: string,
  engine: string,
  /** `talker` 即 `WechatSession.username`（会话微信 ID 的正名，P3-6）。 */
  talker: string,
): ((localId: number, serverId: string) => Promise<{ ok: boolean; text?: string; error?: string }>) | undefined {
  if (engine === '') return undefined
  return async (localId: number, _serverId: string) => {
    const t = await transcribeOneVoiceAsync(decryptedDir, decodedDir, modelsDir,
      whisperModel, engine, talker, localId)
    return { ok: t.ok, text: t.text, error: t.error }
  }
}

export function createLayaRemotes(rc: createLayaRemotesInputs) {
  /** 配置里钉的目录（空串 = 走默认数据目录）。 */
  const configuredDir = (): string => {
    try {
      const v = getConfig(rc.dirs().decrypted)[LAYA_DIR_CONFIG_KEY]
      return typeof v === 'string' ? v : ''
    } catch {
      return ''
    }
  }

  return {
    /**
     * 分析一个会话：取上下文 → 本地推理 → 返回逐命题的判断。
     *
     * 纯本地、不出网（走的是 onnxruntime，不经过 `privacyGate` 的出网闸门）。
     */
    async analyzeMessages(options: { talker?: string; contextLimit?: number }): Promise<LayaAnalysisView> {
      const talker = String(options.talker ?? '').trim()
      const dir = configuredDir()
      const r = await analyzeSession({
        decryptedDir: rc.dirs().decrypted,
        talker,
        selfUsername: rc.selfUsername(),
        contextLimit: options.contextLimit,
        modelDir: dir || undefined,
      })
      rc.op('task', 'analyze_messages', r.ok ? 'ok' : 'fail', talker,
        r.ok ? `${r.answers.length} 项判断 / ${r.inferenceMs}ms / ${r.contextLines} 条上下文` : (r.error ?? r.note))
      return r
    },

    /**
     * 逐条分析一批消息（消息流**可见窗口**驱动）：每条 → 取该消息及之前的上下文 →
     * （语音先转写成文本）→ 本地推理。
     *
     * 结果落 `<数据根>/laya_analysis.db` 缓存，同一条消息（同一模型）只算一次；
     * 语音转写优先命中 whisper 自己的磁盘缓存，只有没转写过的才真调引擎。
     */
    async analyzeVisibleMessages(options: {
      /** 会话微信 ID —— 同一个概念的正名见 `WechatSession.username`（P3-6：问答链沿用库里更早的列名）。 */
      talker?: string
      targets?: Array<{ localId: number; sortSeq: number }>
      /** 本批的进度标识（W3-11.5）：带上它才会推送 laya-analysis/progress 事件。 */
      jobId?: string
    }): Promise<LayaVisibleAnalysisResult> {
      const talker = String(options.talker ?? '').trim()
      const rawTargets = Array.isArray(options.targets) ? options.targets : []
      const targets = rawTargets
        .filter((t) => t !== null && t !== undefined && Number.isFinite(t.localId) && Number.isFinite(t.sortSeq))
        .map((t) => ({ localId: Math.trunc(t.localId), sortSeq: Math.trunc(t.sortSeq) }))
      const dir = configuredDir()

      // 语音转写器：whisper 的引擎/模型/目录都是**配置层知识**，在这里读好再注入
      // （laya 层不该去碰 getConfig 与 whisper 的路径解析）。
      const cfg = getConfig(rc.dirs().decrypted)
      const modelsDir = resolveWhisperModelsDir(
        cfg['whisper_models_dir'] as string | undefined, rc.dirs().decrypted)
      const configBin = typeof cfg['whisper_bin'] === 'string' ? cfg['whisper_bin'] : ''
      const engine = whisperEnginePath(configBin, modelsDir)
      const whisperModel = typeof cfg['whisper_model'] === 'string' && cfg['whisper_model']
        ? cfg['whisper_model'] : 'medium'
            // 异步转写（2026-10-13）：见 voice-transcribe.ts#transcribeOneVoiceAsync 的头注。
      const transcribe = makeLayaTranscriber(rc, rc.dirs().decrypted, rc.dirs().decoded, modelsDir,
        whisperModel, engine, talker)

      // W3-11.5：进度事件（与 wechat-export/progress 同一套路：回调过不了 IPC，只能推）。
      // 80ms 节流与问答增量同口径：一批最多 12 条，节流后最多十来个事件。
      const jobId = typeof options.jobId === 'string' ? options.jobId.trim().slice(0, 64) : ''
      let lastProgressAt = 0
      const emitProgress = jobId === ''
        ? undefined
        : (done: number, total: number, currentLocalId: number): void => {
            const now = Date.now()
            if (done < total && now - lastProgressAt < 80) return
            lastProgressAt = now
            try {
              rc.ctx().emit('laya-analysis/progress', { jobId, done, total, currentLocalId })
            } catch { /* 事件 best-effort，绝不影响推理 */ }
          }

      // W3-11.5：取消。`finally` 里必须归还槽位 —— 否则同一个 jobId 会被永久占着，
      // 之后点「停止」只会打到一枚没人等的控制器上（这条是照 `beginAskCancel` 的教训来的）。
      const ctl = rc.layaSignal(jobId)
      let r: LayaVisibleAnalysisResult
      try {
        r = await runVisibleAnalysis({
          decryptedDir: rc.dirs().decrypted,
          decodedDir: rc.dirs().decoded,
          talker,
          selfUsername: rc.selfUsername(),
          targets,
          modelDir: dir || undefined,
          transcribe,
          ...(emitProgress ? { onProgress: emitProgress } : {}),
          ...(ctl ? { signal: ctl.signal } : {}),
        })
      } finally {
        ctl?.done()
      }
      const fresh = r.items.filter((i) => i.ok && !i.cached).length
      const voice = r.items.filter((i) => i.ok && i.fromVoice).length
      // 顺带记一笔「这一批推理一共花了多久」：每条的 `inferenceMs` 不含取上下文的时间，
      // 求和正好还原纯推理的墙钟（命中缓存的条目是 0）。性能排查时这条比条数有用。
      const inferMs = r.items.reduce((a, i) => a + (i.inferenceMs || 0), 0)
      // 被取消记 `skip` 而不是 `fail`：用户主动停止不是失败（`OperationStatus` 里有这一档）。
      rc.op('task', 'analyze_visible_messages', r.canceled === true ? 'skip' : (r.ok ? 'ok' : 'fail'), talker,
        r.canceled === true
          ? `已停止：算出 ${r.items.length}/${targets.length} 条（已落缓存）`
          : (r.ok ? `${r.items.length} 条（新算 ${fresh}，语音 ${voice}，推理合计 ${inferMs}ms）` : (r.error ?? '')))
      return r
    },

    /**
     * 停止一批正在跑的逐条分析（W3-11.5）。
     *
     * 找不到在跑的那批时返回 `{ok:false, message}` 而不是静默 true ——
     * 用户点「停止分析」后必须知道停没停上；停不上的常见原因是那一批已经算完了（点晚了）。
     */
    cancelAnalysis(options: { jobId?: string }): { ok: boolean; message?: string } {
      const id = typeof options?.jobId === 'string' ? options.jobId.trim() : ''
      if (id === '') return { ok: false, message: '缺少任务标识' }
      return rc.cancelLayaJob(id)
        ? { ok: true }
        : { ok: false, message: '这一批已经算完了（或标识不认识），无需停止' }
    },

    /** 模型与运行时状态（前端轮询）。 */
    getLayaStatus(): LayaStatus {
      const dir = configuredDir()
      const st = layaModelStatus(dir || undefined, rc.dirs().decrypted)
      const rt = layaRuntimeState()
      return {
        installed: st.installed,
        dir: st.dir,
        path: st.path,
        bytes: st.bytes,
        source: st.source,
        missing: st.missing,
        downloading: layaDownload,
        runtime: { loaded: rt.loaded, lastInferenceMs: rt.lastInferenceMs, lastError: rt.lastError },
      }
    },

    /**
     * 下载模型（幂等；已有任务时拒绝并发，与 whisper 同款）。
     *
     * 下载源由宿主方托管（`DSH_WECHAT_LAYA_MIRROR` / `DSH_WECHAT_LAYA_REPO` 可覆盖）。
     */
    async downloadLayaModel(options?: { jobId?: string }): Promise<LayaDownloadOutcome> {
      if (layaDownload !== null) {
        rc.op('settings', 'download_laya_model', 'fail', '', '已有模型下载任务进行中')
        return { ok: false, error: '已有模型下载任务进行中' }
      }
      const existing = layaModelStatus(configuredDir() || undefined, rc.dirs().decrypted)
      if (existing.installed) {
        rc.op('settings', 'download_laya_model', 'skip', '', '模型已就绪')
        return { ok: true, files: [], bytes: 0 }
      }
      const dir = existing.dir
      const prog: LayaDownloadProgress = { file: '', received: 0, total: 0 }
      layaDownload = prog
      /**
       * W2-11.5：取消令牌与逐条分析共用同一套槽（`gateway-core` 的 `_layaJobs`）。
       *
       * 复用而不是另开一个槽：这个下载最长的是 1.2 GB 那块，「点了停止却还要等下完」
       * 是这条链路上唯一会真的让人等的事。**取不到槽时照常下载** —— 不带 jobId 的老调用方
       * 行为必须完全不变（与导出那条纪律一致）。
       */
      const ctl = rc.layaSignal(options?.jobId)
      try {
        const r = await layaDownloadModel(dir, (received, total, file) => {
          prog.file = file
          prog.received = received
          prog.total = total
        }, ctl?.signal)
        rc.op('settings', 'download_laya_model',
          r.canceled === true ? 'skip' : (r.ok ? 'ok' : 'fail'), dir,
          r.canceled === true ? '用户取消' : (r.error ?? `已下载 ${formatBytes(r.bytes ?? 0)}`))
        return r
      } finally {
        ctl?.done()
        layaDownload = null
      }
    },

    /**
     * W2-11.5：取消正在进行的模型下载。
     *
     * 与 `cancelAnalysis` 共用同一个槽（`cancelLayaJob`）—— 「谁持有取消令牌」不允许
     * 出现第二个出处。**不删 `.part`**：下次点击从断点续接。
     * @param options - jobId。
     * @returns 是否真的取消到一个在飞的任务。
     */
    cancelLayaDownload(options: { jobId?: string }): { ok: boolean; message?: string } {
      const id = String(options?.jobId ?? '').trim()
      if (id === '') return { ok: false, message: '缺少任务标识' }
      const hit = rc.cancelLayaJob(id)
      rc.op('settings', 'cancel_laya_download', hit ? 'ok' : 'fail', id, hit ? '已请求取消' : '没有该任务')
      return hit ? { ok: true } : { ok: false, message: '没有该下载任务（可能已结束）' }
    },

    /** 接管一份用户已下好的模型目录（避免重复下载 1.26 GB）。 */
    adoptLayaModel(options: { sourceDir: string }): LayaStatus {
      const src = String(options.sourceDir ?? '').trim()
      const dir = configuredDir()
      if (src === '') {
        rc.op('settings', 'adopt_laya_model', 'fail', '', '未给出源目录')
        const st = layaModelStatus(dir || undefined, rc.dirs().decrypted)
        return {
          installed: st.installed, dir: st.dir, path: st.path, bytes: st.bytes, source: st.source,
          missing: st.missing, downloading: layaDownload,
          runtime: (() => { const rt = layaRuntimeState(); return { loaded: rt.loaded, lastInferenceMs: rt.lastInferenceMs, lastError: rt.lastError } })(),
        }
      }
      const st = layaAdoptModelDir(src, rc.dirs().decrypted)
      rc.op('settings', 'adopt_laya_model', st.installed ? 'ok' : 'fail', src,
        st.installed ? `已接管到 ${st.dir}` : st.missing.join('；'))
      const rt = layaRuntimeState()
      return {
        installed: st.installed, dir: st.dir, path: st.path, bytes: st.bytes, source: st.source,
        missing: st.missing, downloading: layaDownload,
        runtime: { loaded: rt.loaded, lastInferenceMs: rt.lastInferenceMs, lastError: rt.lastError },
      }
    },

    /** 卸载模型，释放约 1.2 GB 常驻内存（下次分析会自动重新加载）。 */
    unloadLaya(): { ok: boolean } {
      layaUnload()
      rc.op('settings', 'unload_laya', 'ok', '', '已卸载本地决策模型')
      return { ok: true }
    },

    /** 期望的模型目录（UI 提示用户「把文件放这里」用）。 */
    getLayaModelDir(): string {
      const dir = configuredDir()
      return dir || layaModelsDir(rc.dirs().decrypted)
    },

    /** 期望的 tokenizer 目录（排查用）。 */
    getLayaTokenizerDir(): string {
      const dir = configuredDir()
      return layaTokenizerDir(dir || layaModelsDir(rc.dirs().decrypted))
    },
  }
}
