// @vitest-environment jsdom
/**
 * 语音模型库的可见契约：
 * · 产品清单里的每个 ggml 文件必须同时以卡片呈现，不能再藏进原生下拉；
 * · 已安装、当前选择、下载中三种状态必须能区分；
 * · 下载和停止按钮必须接到真实回调；
 * · 「推荐」徽标与设置页迁移时的预选模型必须同一口径（否则换机会把用户推到不同的模型）。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WHISPER_MODEL_FALLBACK } from './settings-common.tsx'
import { recommendedWhisperModel } from './use-retired-whisper-model.ts'
import { modelCss } from './settings-css.ts'
import { WhisperModelLibrary, type WhisperModelLibraryProps } from './whisper-model-library.tsx'

let host: HTMLDivElement
let root: Root

function model(id: string, installed = false): (typeof WHISPER_MODEL_FALLBACK)[number] {
  const found = WHISPER_MODEL_FALLBACK.find(item => item.id === id)
  if (found === undefined) throw new Error('missing model fixture: ' + id)
  return { ...found, installed }
}

function props(overrides: Partial<WhisperModelLibraryProps> = {}): WhisperModelLibraryProps {
  return {
    device: 'cpu',
    download: vi.fn(),
    downloading: null,
    models: [
      model('small', true),
      model('turbo-q5', true),
      model('turbo'),
      model('large-v3-q5'),
      model('large-v3'),
    ],
    onCancel: vi.fn(),
    onSelect: vi.fn(),
    selected: 'turbo-q5',
    ...overrides,
  }
}

function render(value = props()): WhisperModelLibraryProps {
  act(() => { root.render(createElement(WhisperModelLibrary, value)) })
  return value
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('WhisperModelLibrary', () => {
  it('同时渲染五张真实文件卡片，而不是原生下拉框', () => {
    render()

    expect(host.querySelector('select')).toBeNull()
    expect(host.querySelectorAll('[role="radio"]')).toHaveLength(5)
    expect([...host.querySelectorAll('[data-model-id]')].map(card => card.getAttribute('data-model-id')))
      .toEqual(['small', 'turbo-q5', 'turbo', 'large-v3-q5', 'large-v3'])

    for (const item of WHISPER_MODEL_FALLBACK) {
      expect(host.textContent).toContain(item.file)
    }
    expect(host.textContent).toContain('2/5 已下载')
    expect(host.querySelector('[data-model-id="turbo-q5"]')?.getAttribute('class')).toContain('Selected')
    expect(host.querySelector('[data-model-id="small"]')?.getAttribute('data-installed')).toBe('true')
    expect(host.querySelector('[data-model-id="turbo"]')?.getAttribute('data-installed')).toBe('false')
    // 低准确率模型已经下线，不该再出现任何卡片。
    for (const retired of ['tiny', 'base', 'medium']) {
      expect(host.querySelector(`[data-model-id="${retired}"]`)).toBeNull()
    }
  })

  it('未安装模型可直接下载，点击卡片可切换当前模型', () => {
    const controls = render()

    const turboCard = host.querySelector('[data-model-id="turbo"]')
    const download = [...(turboCard?.querySelectorAll('button') ?? [])]
      .find(button => button.textContent?.includes('下载'))
    expect(download).not.toBeUndefined()
    act(() => { download?.click() })
    expect(controls.download).toHaveBeenCalledWith({ id: 'turbo', name: 'Turbo' })

    const largeV3q5 = host.querySelector('[data-model-id="large-v3-q5"] [role="radio"]') as HTMLButtonElement | null
    expect(largeV3q5).not.toBeNull()
    act(() => { largeV3q5?.click() })
    expect(controls.onSelect).toHaveBeenCalledWith('large-v3-q5')
  })

  it('下载中显示实时百分比和停止按钮，同排其它下载按钮禁用', () => {
    const controls = render(props({
      downloading: { model: 'turbo', file: 'ggml-large-v3-turbo.bin', received: 50, total: 100 },
    }))

    const turboCard = host.querySelector('[data-model-id="turbo"]')
    expect(turboCard?.textContent).toContain('50%')
    const stop = [...(turboCard?.querySelectorAll('button') ?? [])]
      .find(button => button.textContent === '停止')
    expect(stop).not.toBeUndefined()
    act(() => { stop?.click() })
    expect(controls.onCancel).toHaveBeenCalledTimes(1)

    const otherDownload = [...(host.querySelector('[data-model-id="large-v3"]')?.querySelectorAll('button') ?? [])]
      .find(button => button.textContent?.includes('请稍候'))
    expect(otherDownload).not.toBeUndefined()
    expect(otherDownload?.disabled).toBe(true)
  })

  it('「推荐」徽标与设置页迁移的预选模型是同一个（cpu / gpu 各自对齐）', () => {
    for (const device of ['cpu', 'gpu'] as const) {
      render(props({
        device,
        models: WHISPER_MODEL_FALLBACK.map(item => ({ ...item, installed: true })),
      }))
      // 按徽标的真实 class 找，而不是按文字 —— 卡片正文里也可能出现「推荐」二字。
      const badgeCard = [...host.querySelectorAll('[data-model-id]')]
        .find(card => card.querySelector(`.${modelCss.voiceModelRecommended}`) !== null)
      expect(badgeCard?.getAttribute('data-model-id'), `${device} 上的推荐徽标`).toBe(recommendedWhisperModel(device))
      act(() => { root.unmount() })
      root = createRoot(host)
    }
  })
})
