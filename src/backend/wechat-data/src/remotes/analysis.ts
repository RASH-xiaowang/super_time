/**
 * 「消息分析」处理器。
 *
 * 只读本机会话库，把上下文与提问交给用户配置的对话模型，返回结构化 JSON 分析。
 * 出网前统一过 `analyze_message` 隐私闸（由网关注入），与「推荐回复」同级。
 *
 * @module remotes/analysis
 */
import { analyzeMessage, type AnalysisDeps } from '../query/analysis/analyze.ts'
import { createDefaultAnalysisGenerator } from '../query/analysis/generator.ts'
import { getConfig } from '../query/config.ts'
import { WHISPER_DEFAULT_MODEL, resolveWhisperModelsDir, whisperEnginePath } from '../query/whisper.ts'
import { transcribeOneVoiceAsync } from '../query/voice-transcribe.ts'
import { cachedTranscript } from '../query/voice-transcribe.ts'
import { svrIdByChatLocal } from '../query/voice.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {
  MessageAnalysisInput,
  MessageAnalysisResult,
} from '../types-analysis.ts'
import type { OperationCategory, OperationStatus } from '../types.ts'

export interface CreateAnalysisRemotesInputs {
  dirs: () => { decrypted: string; decoded: string }
  selfUsername: () => string
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  gate: (feature: string, stats: { sessions: number; messages: number }, texts: string[]) => string[]
  /**
   * 取宿主 `Context`。**默认生成器靠它读「设置里的当前对话模型」**，
   * 网关注入时必须是 `() => this._ctx`；漏注入会得到「模型环境未就绪」而不是崩溃。
   * 测试注入自己的 `generate` 时可以省略。
   */
  ctx?: () => Context
  /** 测试注入：替换模型生成器。 */
  generate?: AnalysisDeps['generate']
  /** 测试注入：替换语音转写。 */
  transcribeVoice?: AnalysisDeps['transcribeVoice']
}

/** 读当前对话模型标识（`provider/model`）；读不到时返回空串。 */
function modelLabelOf(ctx: Context | undefined): string {
  if (ctx === undefined) return ''
  const selection = (ctx as unknown as {
    agentDefaultModel?: { currentSelection(): { provider: string; model: string } }
  }).agentDefaultModel?.currentSelection()
  if (selection === undefined || selection.provider === '' || selection.model === '') return ''
  return selection.provider + '/' + selection.model
}

/**
 * 组装分析能力。
 * @param rc - 网关注入的目录、日志、隐私闸与 `Context`（默认生成器读当前对话模型用）。
 * @returns 只暴露 `analyzeMessage` 的处理器。
 */
export function createAnalysisRemotes(rc: CreateAnalysisRemotesInputs) {
  const dir = (): string => rc.dirs().decrypted
  const generate = rc.generate ?? createDefaultAnalysisGenerator({ ctx: () => rc.ctx?.() })

  /**
   * 语音先转文字：分析「对方说了什么」而不是一个 `[语音]` 占位。
   * 引擎/模型没装好时返回空串（调用方据此报「没有可分析的文本」）。
   */
  const transcribeVoice: AnalysisDeps['transcribeVoice'] = rc.transcribeVoice ?? (async (input) => {
    const cfg = getConfig(dir())
    const modelsDir = resolveWhisperModelsDir(
      typeof cfg['whisper_models_dir'] === 'string' ? cfg['whisper_models_dir'] : undefined,
      dir(),
    )
    const configBin = typeof cfg['whisper_bin'] === 'string' ? cfg['whisper_bin'] : ''
    const engine = whisperEnginePath(configBin, modelsDir)
    if (engine === null) return ''
    // 同一台机器上同一条语音只转一次：缓存命中直接返回。
    const svrId = svrIdByChatLocal(dir(), input.talker, input.localId, '')
    if (svrId !== '') {
      const cached = cachedTranscript(rc.dirs().decoded, svrId)
      if (cached !== '') return cached
    }
    const modelId = typeof cfg['whisper_model'] === 'string' && cfg['whisper_model']
      ? cfg['whisper_model']
      : WHISPER_DEFAULT_MODEL
    const result = await transcribeOneVoiceAsync(
      dir(),
      rc.dirs().decoded,
      modelsDir,
      modelId,
      engine,
      input.talker,
      input.localId,
      '',
    )
    return result.ok ? (result.text ?? '') : ''
  })

  return {
    analyzeMessage(input: MessageAnalysisInput): Promise<MessageAnalysisResult> {
      return analyzeMessage({
        decryptedDir: dir,
        selfUsername: () => rc.selfUsername(),
        modelLabel: () => modelLabelOf(rc.ctx?.()),
        generate,
        gate: (feature, stats, texts) => rc.gate(feature, stats, texts),
        transcribeVoice,
        op: (action, ok, detail) => {
          rc.op('task', action, ok ? 'ok' : 'fail', '', detail)
        },
      }, input)
    },
  }
}
