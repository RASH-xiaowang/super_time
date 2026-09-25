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
import { analyzeSession } from '../query/laya-analysis.ts'
import {
  formatBytes, layaAdoptModelDir, layaDownloadModel, layaModelStatus, layaModelsDir, layaTokenizerDir,
} from '../laya/model-file.ts'
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
    async downloadLayaModel(): Promise<LayaDownloadOutcome> {
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
      try {
        const r = await layaDownloadModel(dir, (received, total, file) => {
          prog.file = file
          prog.received = received
          prog.total = total
        })
        rc.op('settings', 'download_laya_model', r.ok ? 'ok' : 'fail', dir,
          r.error ?? `已下载 ${formatBytes(r.bytes ?? 0)}`)
        return r
      } finally {
        layaDownload = null
      }
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
