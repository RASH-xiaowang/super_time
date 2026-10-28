/**
 * Voice-model catalog UI.
 *
 * The old panel hid six real model files behind one native dropdown. This
 * component exposes every downloadable artifact as a card so selection,
 * installation state, progress and cancellation are all visible at once.
 */
import type { WhisperStatus } from '@deepseek-ai/dsh-wechat-data/types'
import { IconCheckOutline16, IconDownloadOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { clsx } from 'clsx'
import { modelCss } from './settings-css.ts'

type WhisperModel = WhisperStatus['models'][number]

interface ModelPresentation {
  summary: string
  detail: string
  speed: string
}

const MODEL_COPY: Record<string, ModelPresentation> = {
  tiny: {
    summary: '极速预览',
    detail: '资源占用最低，适合快速确认语音内容。',
    speed: '最快',
  },
  base: {
    summary: '轻量日常',
    detail: '适合清晰录音和较短语音，低配机器更从容。',
    speed: '很快',
  },
  small: {
    summary: '均衡首选',
    detail: '准确率与速度平衡，适合大多数中文对话。',
    speed: '较快',
  },
  medium: {
    summary: '高精度',
    detail: '复杂环境更稳，但 CPU 转写耗时明显增加。',
    speed: '中等',
  },
  'large-v3': {
    summary: '最高精度',
    detail: '适合离线精转，需要更多内存和磁盘空间。',
    speed: '较慢',
  },
  turbo: {
    summary: '大模型加速',
    detail: 'Large v3 的加速版本，适合 NVIDIA GPU。',
    speed: '快',
  },
}

export interface WhisperModelLibraryProps {
  device: 'cpu' | 'gpu'
  download: (model: { id: string; name: string }) => void
  downloading: { model: string; file: string; received: number; total: number } | null
  models: readonly WhisperModel[]
  onCancel: () => void
  onSelect: (id: string) => void
  selected: string
}

/** Six-card model picker with an explicit download path per artifact. */
export function WhisperModelLibrary({
  device, download, downloading, models, onCancel, onSelect, selected,
}: WhisperModelLibraryProps): React.JSX.Element {
  const installed = models.filter(model => model.installed).length
  const recommended = device === 'gpu' ? 'turbo' : 'small'

  return (
    <div className={modelCss.voiceLibrary}>
      <div className={modelCss.voiceLibraryHead}>
        <div className={modelCss.voiceLibraryHeading}>
          <span className={modelCss.voiceLibraryTitle}>识别模型</span>
          <span className={modelCss.voiceLibraryHint}>点击卡片切换，右侧按钮可直接下载</span>
        </div>
        <span className={modelCss.voiceLibraryCount}>{installed}/{models.length} 已下载</span>
      </div>

      <div className={modelCss.voiceModelGrid} role="radiogroup" aria-label="Whisper 识别模型">
        {models.map((model) => {
          const copy = MODEL_COPY[model.id] ?? {
            summary: '本地模型',
            detail: '下载后在本机完成语音识别。',
            speed: '本机推理',
          }
          const activeDownload = downloading?.model === model.id
          const progress = activeDownload ? downloading : null
          const otherDownloadActive = downloading !== null && !activeDownload
          const pct = progress !== null && progress.total > 0
            ? Math.round((progress.received / progress.total) * 100)
            : 0
          const size = model.sizeLabel.split(' · ')[0] ?? model.sizeLabel
          return (
            <div
              key={model.id}
              className={clsx(
                modelCss.voiceModelCard,
                selected === model.id && modelCss.voiceModelCardSelected,
                model.installed && modelCss.voiceModelCardInstalled,
                activeDownload && modelCss.voiceModelCardDownloading,
              )}
              data-model-id={model.id}
              data-installed={model.installed ? 'true' : 'false'}
            >
              <button
                type="button"
                role="radio"
                aria-checked={selected === model.id}
                className={modelCss.voiceModelSelect}
                onClick={() => { onSelect(model.id) }}
              >
                <span className={modelCss.voiceModelTop}>
                  <span className={modelCss.voiceModelName}>{model.name}</span>
                  <span className={modelCss.voiceModelTags}>
                    {recommended === model.id && <span className={modelCss.voiceModelRecommended}>推荐</span>}
                    {model.installed && (
                      <span className={modelCss.voiceModelInstalled}>
                        <IconCheckOutline16 size={11} />
                        已安装
                      </span>
                    )}
                  </span>
                </span>
                <span className={modelCss.voiceModelSummary}>{copy.summary}</span>
                <span className={modelCss.voiceModelDetail}>{copy.detail}</span>
                <span className={modelCss.voiceModelMeta}>
                  <span>{size}</span>
                  <span>{copy.speed}</span>
                </span>
                <span className={modelCss.voiceModelFile} title={model.file}>{model.file}</span>
              </button>

              <div className={modelCss.voiceModelFoot}>
                {progress !== null ? (
                  <>
                    <span className={modelCss.voiceModelProgressTrack} aria-hidden="true">
                      <span
                        className={modelCss.voiceModelProgressFill}
                        style={{ width: `${downloadProgressWidth(progress, pct)}%` }}
                      />
                    </span>
                    <span className={modelCss.voiceModelProgressPct}>
                      {progress.total > 0 ? `${pct}%` : formatDownloaded(progress.received)}
                    </span>
                    <button type="button" className={modelCss.voiceModelStop} onClick={onCancel}>停止</button>
                  </>
                ) : model.installed ? (
                  <span className={modelCss.voiceModelReady}>
                    {selected === model.id ? '当前使用' : '本地可用'}
                  </span>
                ) : (
                  <button
                    type="button"
                    className={modelCss.voiceModelDownload}
                    disabled={otherDownloadActive}
                    onClick={() => { download({ id: model.id, name: model.name }) }}
                  >
                    <IconDownloadOutline16 size={12} />
                    {otherDownloadActive ? '请稍候' : `下载 ${size}`}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className={modelCss.voiceModelSource}>
        <span>官方 ggml 文件 · 支持断点续传 · 仅在本机推理</span>
        <span>优先 hf-mirror，失败自动切换 Hugging Face</span>
      </div>
    </div>
  )
}

function downloadProgressWidth(
  downloading: { received: number; total: number },
  pct: number,
): number {
  return downloading.total > 0 ? Math.max(2, pct) : 2
}

function formatDownloaded(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
